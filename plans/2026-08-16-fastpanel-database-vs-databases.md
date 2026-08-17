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

### Фаза 2 — Починка `create_database`  `[ ]`

Решения приняты по итогам фазы 1:

- **Целевая команда:** `databases create --server=<id> --name=<db> --username=<user>
  --password=<pass> --site=<domain>`. `--site` обязателен — без него привязки к сайту нет
  (см. фазу 1). Домен в `create_database` уже есть (аргумент `domain`).
- **`--server`:** резолвим числовой id из `databases servers list --json` в той же сессии
  (новая `fastpanel_db_server`). **Ровно один** mysql-сервер → берём его id. Ноль или несколько
  → НЕ угадываем, уходим в mysql-фоллбэк (выбрать наугад = создать базу не на том сервере).
- **Каскад:** `databases` → mysql-фоллбэк, **без** ступени с ед. ч. `database`. Мёртвая ступень
  и породила баг; версии панели с ед. ч. у нас нет. Появится — добавим по факту.
- **Флаг `--user` → `--username`** (у `databases create` только `--username`).
- Сохранить `opaque_exit("create_database", code)`, `CreateDbResult` без `output`,
  идемпотентность (`db_exists` до генерации пароля — как есть), ветку
  `presence.is_none() && db_user_already_taken(&fb_out)`.
- Файл: `desktop/src-tauri/src/ssh/fastpanel.rs` (`create_database` + `fastpanel_db_server`).

### Фаза 3 — Тесты и приёмка  `[ ]`
- Тест на разъезд имени команды (фейк-сервер различает ед./мн. ч.).
- Тест «пароль не в argv-результате» (по образцу `issue_ssl_argv_has_no_secret`).
- Живая приёмка: provision домена с БД на реальном сервере, вход в созданную базу.

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
