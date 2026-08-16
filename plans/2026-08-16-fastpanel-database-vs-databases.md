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

### Фаза 1 — Живая диагностика  `[ ]`
- Под root на тестовом сервере: воспроизвести текущий provision БД, снять фактическое
  поведение (`database create` ед. ч. — код возврата; создаётся ли БД mysql-фоллбэком).
- Снять точную форму `databases create` (успех, «уже существует», отсутствие `--server`),
  дописать в `docs/FASTPANEL_CLI.md` §3 с пометкой «сверено вживую».

### Фаза 2 — Починка `create_database`  `[ ]`
- Перевести на `databases create` (мн. ч.) с верными флагами (`--server`/`--name`/
  `--username`), либо решить в пользу mysql-пути с обоснованием.
- Сохранить `opaque_exit`, отсутствие `output` в результате, идемпотентность.
- Файлы: `desktop/src-tauri/src/ssh/fastpanel.rs` (`create_database`), возможно
  `commands/provision.rs`.

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
