# План: provision БД шлёт `database` (ед. ч.), а сервер знает `databases` (мн. ч.)

**Дата:** 2026-08-16
**Связь с бизнесом:** доверие к панели как к «пульту управления инфраструктурой»
(`.business/audience/` — power-user ведёт десятки доменов). Если создание БД при provision
молча падает, пользователь получает сайт без рабочей базы и снова лезет в веб-панель.

> ⚠️ **Это МУТАЦИЯ на боевом сервере, вне read-only-скоупа
> `plans/2026-08-16-fastpanel-cli-chtenie-domena.md` (task9).** Здесь только чтение
> задокументировано; починка создания БД требует аккуратной живой приёмки и вынесена сюда.

## Контекст (находка discovery, 2026-08-16)

Discovery на живом FastPanel 2 под root показал: команды `database` (ед. ч.) **нет** —
`database --help` / `database list` падают `error: expected command but got "database"`
(exit 1). Реально существует группа `databases` (мн. ч.):
`databases servers list` / `databases list` / `databases sync` /
`databases create --server --name --username [--password]`.

Существующий код `desktop/src-tauri/src/ssh/fastpanel.rs` (`create_database`) шлёт:

```
<fp> database create --name=<db> --user=<user> --password=<pass>
```

То есть **ед. ч. `database` + флаги `--user`/`--name`**, которых у `databases create` нет
(там `--server`, `--name`, `--username`). Значит FastPanel-ветка создания БД на этой
версии, **вероятно, всегда падает**; спасает только mysql-фоллбэк в той же функции (если он
действительно отрабатывает). Подробности формы — `docs/FASTPANEL_CLI.md` §3.

**Почему баг не был пойман раньше:** тесты `create_database` гоняют `FakeServer` с
подстроками `"database create"` — фейк отвечает на ту же (неправильную) строку, что шлёт
код, поэтому разъезд имени команды тест не ловит. Разъезд ловится только живым сервером.

## Acceptance criteria (что значит «готово»)

- [ ] На живом сервере подтверждено, падает ли `database create` (ед. ч.) сегодня и
      спасает ли mysql-фоллбэк (создаётся ли БД по факту).
- [ ] Provision БД создаёт базу через существующую на сервере команду
      (`databases create --server=<srv> --name=<db> --username=<user> [--password=<pass>]`)
      либо осознанно остаётся на mysql-пути, если он надёжнее — с обоснованием в итоге.
- [ ] Идемпотентность сохранена: повторный provision существующей БД не роняет прогон
      (как сегодня — «уже существует» не считается фатальной ошибкой).
- [ ] Пароль БД по-прежнему не утекает: argv с `--password` уходит в `opaque_exit`,
      структура-результат без `output`, в аудит плейнтекст не попадает.
- [ ] Тест ловит разъезд имени команды (сегодня `FakeServer` его не ловит) — напр. фейк
      отвечает `expected command but got "database"` на ед. ч. и успехом на мн. ч.

## Edge cases (продумать заранее)

- `--server` обязателен у `databases create` — откуда берём имя mysql-сервера
  (`databases servers list`)? Что если серверов несколько / ноль?
- БД уже существует → «уже есть» не фатально (сверить поведение реальной команды на
  повторе, форму ошибки задокументировать).
- Разные версии FastPanel: не окажется ли где-то наоборот только `database` (ед. ч.)?
  Проверить перед жёсткой заменой; возможно, нужен каскад (как для `--json`).
- Zero-knowledge: пароль в argv `databases create --password` — та же защита
  `opaque_exit`, что и у старой команды.
- mysql-фоллбэк `CREATE USER ... IDENTIFIED BY` — созданный пользователь остаётся при
  падении на `GRANT`; повторный прогон не должен спотыкаться.

## Фазы

### Фаза 1 — Живая диагностика  `[x]`

Проведена под root 2026-08-17 (пробная БД `sdmp_probe_db` создана и убрана в том же прогоне,
mysql `DROP` + `databases sync`; боевые БД не задеты). Формы — в `docs/FASTPANEL_CLI.md` §3.5
с пометкой «сверено вживую». Что выяснилось:

- **`databases servers list --json`**: mysql-сервер ровно один, `id:1`. `--server` принимает
  **числовой id** (`mysql(localhost)` → `error: parsing ... invalid syntax`); обязателен
  (без него `error: required flag --server not provided`).
- **`databases create` привязывает БД к сайту только через `--site=<domain>`.** Без `--site`
  результат `site:null, owner:"fastuser"` — панели формально известна, но НЕ привязана к сайту,
  не в его бэкапах/`databases_size`. То есть исправить одно имя команды мало: **фикс обязан
  передавать `--site=<domain>`**, иначе исходный вред остаётся.
- **Успех:** `databases create --server=1 --name --username --password --site=<domain>` →
  exit 0, `database '<db>' created successfully / ID: n`.
- **Повтор:** `error: 'database-already-exists'` (exit 1) — чистый маркер для идемпотентности.
- **Удаления БД в CLI нет.** FastPanel-запись реконсилится `databases sync` после mysql `DROP`.
  Обратная сторона исходного бага: mysql-фоллбэк создаёт базу вообще без записи FastPanel.

### Фаза 2 — Починка `create_database`  `[x]`

**Реализовано (2026-08-17).** Команда в `create_database` заменена на
`<fp> databases create --server=<id> --name=<db> --username=<user> --password=<pass> --site=<domain>`.
Добавлена `fastpanel_db_server(s, fp_path) -> Option<i64>` (+ чистый парсер `parse_db_server_id`):
читает `databases servers list --json`, отдаёт id ТОЛЬКО при ровно одном mysql-сервере; ноль/несколько/
недоступно → `None` → сразу mysql-фоллбэк без угадывания. Ступень с ед. ч. `database` удалена (каскад
`databases` → mysql). Сохранены: `opaque_exit`, `CreateDbResult` без `output`, `db_exists` до генерации
пароля, ветка `presence.is_none() && db_user_already_taken`, генерация пароля после проверки. Флаг
`--user` → `--username`, добавлен `--site=<domain>`. Файл: `desktop/src-tauri/src/ssh/fastpanel.rs`.

Форма итоговой команды (дословно):
`{fp} databases create --server={id} --name={db} --username={user} --password={pass} --site={domain}`.

### Фаза 3 — Тесты и приёмка  `[~]` (юнит-тесты `[x]`, живая приёмка `[ ]`)

**Юнит-тесты (2026-08-17, зелёные).** Всего в `src-tauri` 261 тест (было 256, +5):
- `create_database_uses_plural_databases_not_singular_database` — страж разъезда ед./мн. ч.;
  FakeServer различает строки через `contains`, откат к `database create` (ед. ч.) роняет тест
  (проверено вживую: временный откат → FAILED exit 127).
- `create_database_binds_server_id_and_site` — `--server=<id>` читается из json (id 7, не хардкод),
  в команде есть `--site`, `--username`, `--name`.
- `create_database_skips_fastpanel_when_server_is_ambiguous` / `..._when_no_server_found` —
  несколько/ноль серверов → FastPanel-команда НЕ шлётся, уход в mysql-фоллбэк.
- `create_database_never_leaks_the_password_the_fastpanel_command_echoes` — argv-без-секрета:
  `--password=` в argv (ОК, opaque_exit), но эхо пароля из FastPanel-usage и `IDENTIFIED BY` из
  mysql наружу не выходят.
- Существующие `create_database_*` переписаны под мн. ч. (заряжают `databases servers list` +
  `databases create`), поведение идемпотентности/opaque_exit сохранено.

`cargo test` — 261 passed. `cargo clippy` — в `fastpanel.rs` чисто (warnings только в чужом
предсуществующем тестовом коде). `cargo build` — ок.

- [ ] Живая приёмка: provision домена с БД на реальном сервере, вход в созданную базу (финальная
  приёмка контроллера, в этой сессии не запускалась).

## Смежная находка (тот же класс — дрейф версии FastPanel)

`read_ssl_info` (`desktop/src-tauri/src/ssh/fastpanel.rs`) читает серт по пути
`/etc/letsencrypt/live/<domain>/fullchain.pem`. На живом FastPanel 2 (2026-08-16) этого
каталога **нет вовсе** — серты лежат в `/var/www/httpd-cert/<domain>_<timestamp>.crt`
(ссылка в `/etc/nginx/fastpanel2-available/<owner>/<domain>.conf`, директива
`ssl_certificate`). Значит openssl-путь `read_ssl_info` на этой версии всегда даёт
`has_certificate=false`.

**Функционально SSL спасён** обогащением из `sites list --json` `certificate{}`
(фаза 2 task9, `ssl_from_certificate`): `has_certificate` и `expires_at` берутся оттуда, и
срок сверен вживую — `certificate.expired_at` совпал с `openssl` на реальном файле
байт-в-байт (`notAfter=Sep 17 23:47:42 2026 GMT`). Теряется только точный `issuer` (в
обогащении он `None`) — косметика.

Кандидат на починку (низкий приоритет): научить `read_ssl_info`/факты брать путь серта из
`ssl_certificate` в конфиге сайта (или из `/var/www/httpd-cert/`), тогда openssl даст точные
издателя и срок для всех FastPanel-доменов, а не только там, где сработал certbot в
`/etc/letsencrypt/live`. Учесть дрейф версий: на других установках путь может быть иным —
нужен каскад, как для команды БД.

## Итог

- Реализован целиком: **нет** — заведён как follow-up находки discovery 2026-08-16.
- Что осталось: все фазы. Блокирующая часть — живой доступ root к тестовому серверу.
  Плюс смежная находка про путь серта `read_ssl_info` (низкий приоритет, SSL уже
  функционально работает через обогащение из `certificate{}`).
