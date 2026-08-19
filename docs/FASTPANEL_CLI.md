# FastPanel CLI — справочник по реальному выводу

Как SDMP-десктоп разговаривает с FastPanel по SSH: какие команды шлёт, какую форму
вывода получает, какие коды возврата и как ведёт себя на «уже существует». Документ
собран по **живому прогону discovery-скрипта** (`scripts/fastpanel-discovery.sh`) на
реальном сервере с FastPanel 2 под `root`, дата прогона — **2026-08-16**.

> ⚠️ **Данные в примерах обезличены.** Форма вывода (структура JSON, имена полей,
> заголовки таблиц, коды возврата) сохранена точь-в-точь; боевые домены/логины/имена
> БД/IP/e-mail заменены на плейсхолдеры (`example.com`, `example_usr`, `example_ftp`,
> `exampledb`, `203.0.113.10`, `admin@example.com`). Ни одного боевого значения в
> документе быть не должно.

> **Каждая команда помечена:** «сверено вживую (2026-08-16)» — форма подтверждена
> прогоном; «не сверено» — знаем из `--help` или кода, но точный вывод не снимали.

---

## 0. Ключевые факты (прочитай первым)

1. **Полный набор команд доступен только под `root`.** Бинарь —
   `/usr/local/fastpanel2/fastpanel`. Под непривилегированным пользователем панели
   (`fastuser` и т.п.) CLI показывает лишь 3–4 команды (help / `backup:plan` /
   `scan:virtualhost`), а `sites` / `ftp_account` / `databases` / `certificates`
   **не существуют** — попытка их вызвать падает `error: expected command but got
   "sites"` (exit 1). Читать факты домена можно только из root-сессии.
   *(Провенанс: проверено прямым ручным прогоном `fastpanel help` / `fastpanel sites list`
   под непривилегированным пользователем панели 2026-08-16; discovery-скрипт гонялся только
   под root, поэтому этой ветки в сыром выводе нет.)*
2. **Флаг `--json` ставится ПОСЛЕ подкоманды**: `fastpanel sites list --json`, а не
   `fastpanel --json sites list`. (В `--help` `--json` числится глобальным флагом, но
   на практике мы всегда ставим его после `list`.)
3. **PTY не нужен и вреден.** Все вызовы идут `pty: false` — вывод машинный, pty
   подмешал бы управляющие последовательности. См. §7 «Правила».
4. **БД: команда называется `databases` (мн. ч.), НЕ `database` (ед. ч.).** `database
   list` падает `expected command but got "database"`. Это баг существующего provision
   (см. §5 и `plans/2026-08-16-fastpanel-database-vs-databases.md`).
5. **Отдельной команды `php` нет.** Версия PHP и обработчик берутся из `sites list
   --json` (`main_backend.handler` / `main_backend.handler_version`).
6. **Пароли CLI не отдаёт.** Ни FTP, ни БД — их из панели не прочитать в принципе
   (см. §2.2, §5). Смены пароля FTP/БД через FastPanel CLI тоже нет.
7. **Про бэкапы здесь не написано ничего — и это честный ответ, а не пропуск.**
   `backup:plan`, раскладка архивов на диске и непустой `sites[].backups[]` живым прогоном
   не сняты; разведочные секции (`backup-*`) в `scripts/fastpanel-discovery.sh` написаны и
   ждут прогона под root. Предусловие прогона: на сервере должен быть **хотя бы один бэкап,
   сделанный руками через веб-морду** — иначе форму непустого `backups[]` взять неоткуда.
   План — `plans/2026-08-19-bekapy-domena.md`, фаза 0.

Раскладка бинаря на диске (сверено вживую 2026-08-16):

```
#sdmp:cmd which fastpanel
#sdmp:exit 1                     # which не находит — fastpanel не в PATH
#sdmp:cmd test -x /usr/local/fastpanel2/fastpanel
#sdmp:exit 0                     # но лежит по fallback-пути
```

Именно так резолвит путь `get_fastpanel_path` (`desktop/src-tauri/src/ssh/fastpanel.rs`):
сначала `which fastpanel`, при неудаче — `test -x /usr/local/fastpanel2/fastpanel`
(константа `FASTPANEL_FALLBACK_PATH`).

---

## 1. `sites` — сайты (богатый источник фактов домена)

### 1.1 `sites list --json` — **сверено вживую (2026-08-16)**

**argv:** `<fp> sites list --json` **· exit 0**

Возвращает **массив** объектов-сайтов. Это главный источник почти всех фактов домена:
путь, владелец, версия и обработчик PHP, состояние сертификата. Один объект (обезличено,
поля сохранены точь-в-точь):

```json
[{"id":8,"temp_link_flag":true,"domain":"example.com","aliases":[{"id":8,"name":"www.example.com","raw_name":"www.example.com"}],"ips":[{"id":13,"ip":"203.0.113.10"}],"index_page":"index.php index.html","index_dir":"/var/www/example_usr/data/www/example.com","static_sub_directory":"","charset":"UTF-8","admin_email":"admin@example.com","enabled":true,"status":"active","gzip":true,"gzip_comp_level":1,"static_file_handler":true,"static_extension":"jpg,jpeg,gif,png,svg,js,css,mp3,ogg,mpeg,avi,zip,gz,bz2,rar,swf,ico,7z,doc,docx,map,ogg,otf,pdf,ttf,tif,txt,wav,webp,woff,woff2,xls,xlsx,xml","expired":0,"autosubdomains":false,"main_domain":null,"https_redirect":false,"http2":false,"http3":false,"hsts":false,"manual_changes":true,"error_count":1,"size":156930048,"is_scan_failed":false,"status_code":200,"databases_size":16564224,"certificate":{"id":8,"name":"example.com_2026-04-20-11-19_54","type":"letsencrypt","enabled":false,"expires":90,"created_at":"2026-06-19T23:47:43Z","expired_at":"2026-09-17T23:47:42Z"},"update_state_data":"2026-08-16T19:00:01.764986147Z","settings":{"req_limit":false,"req_limit_value":1,"req_limit_rate":"second","burst":1,"burst_flag":false,"no_delay":false},"permissions":null,"parent":null,"main_backend":{"action":null,"app_file":"index.php index.html","app_type":"","environment":[],"exec_start":"","handler":"php_fpm","handler_version":"8.1","id":6,"is_enabled":false,"is_running":false,"is_state_valid":false,"listen_addr":"127.0.0.1","listen_type":0,"port":3178,"process_type":"simple","service_name":"example_com","socket_path":"/var/www/example_usr/data/example_com.sock","type":"php","upstreams":[],"work_dir":"","workers_count":2},"log_rotate":{"access_log":true,"error_log":true,"rotate":10,"log_period":"daily","awstats":false},"owner":{"id":10,"username":"example_usr","home_dir":"/var/www/example_usr/data"},"backups":[],"action":null,"created_at":"2026-04-20T11:12:35.09521427Z"}]
```

Ключевые поля для чтения фактов:

| Путь в JSON | Смысл | Куда идёт в SDMP |
|---|---|---|
| `domain` | имя домена | ключ фильтрации |
| `index_dir` | путь сайта, `/var/www/<owner>/data/www/<domain>` | `site_path` |
| `owner.username` | системный владелец, `<domain-slug>_usr` | `site_user` |
| `owner.home_dir` | `/var/www/<owner>/data` | база для путей логов |
| `main_backend.handler` | **обработчик**: `"php_fpm"` \| `"mpm_itk"` | `php_handler` (см. ниже) |
| `main_backend.handler_version` | **версия PHP**: `"8.1"`, `"8.3"`, `"7.4"` | `php_version` |
| `certificate` | объект серта или **отсутствует** | SSL-факты |
| `databases_size` | суммарный размер БД сайта (байты) | справочно |

**Обработчик → `php_handler`:** `"php_fpm"` → `php-fpm`; `"mpm_itk"` (apache/mod_php) →
`apache`; иначе → `unknown`. Верхнеуровневого поля `php_version` в объекте **нет** —
берём только из `main_backend`.

**Сертификат (`certificate`).** Встречены два `type`:

- `"letsencrypt"` — обычный LE-серт, `expires` ≈ 90, `expired_at` — дата истечения.
- `"exists"` — внешний серт (напр. CloudFlare Origin), `expired_at` может быть далёким
  будущим:

  ```json
  "certificate":{"id":6,"name":"CloudFlare Origin Certificate_2025-01-01-00-00_00","type":"exists","enabled":false,"expires":5474,"created_at":"2025-12-09T17:46:59.147254687Z","expired_at":"2040-12-05T17:42:00Z"}
  ```

⚠️ **`certificate.enabled` бывает `false` даже у валидного будущего серта.** Доверять
надо сроку (`expired_at`), а не флагу `enabled`. Если ключа `certificate` в объекте нет
вовсе — сертификата нет.

Точный срок и издатель SDMP всё равно перепроверяет через `openssl` на файле серта
(см. §6, `read_ssl_info`) — CLI-поле грубее.

### 1.2 `sites list` (текст) — **сверено вживую (2026-08-16)**

**argv:** `<fp> sites list` **· exit 0**

TAB-разделённая таблица; каскадный фоллбэк, когда `--json` недоступен. Заголовок и строки
(обезличено):

```
ID	SERVER_NAME  	ALIASES          	OWNER           	MODE   	PHP_VERSION	IPS         	DOCUMENT_ROOT
8 	example.com  	www.example.com  	example_usr     	php_fpm	8.1        	203.0.113.10	/var/www/example_usr/data/www/example.com
9 	example2.com 	www.example2.com 	example2_usr    	mpm_itk	7.4        	203.0.113.10	/var/www/example2_usr/data/www/example2.com
```

`MODE` = обработчик (`php_fpm` / `mpm_itk`), `PHP_VERSION`, `OWNER`, `DOCUMENT_ROOT` —
те же факты, что в JSON. Фильтр домена — по колонке `SERVER_NAME`.

### 1.3 `sites create` — **сверено вживую (2026-08-16, ветка ошибки)** · МУТАЦИЯ

**argv (шлёт SDMP при provision):**
`<fp> sites create --server-name=<domain> --owner=<owner> --create-user --php-version=<ver>`

Провижн-команда, вне read-only. Вывод в SDMP **не сохраняется** (`CreateSiteResult` не
несёт `output`) и на ошибке уходит `opaque_exit`. Живьём сверена ветка неуспеха (сайт уже
есть → ненулевой код). Прочие подкоманды `sites` (`update-frontend`, `update-backend`,
`delete --id`, `regenerate-config` и т.д.) — см. `sites --help`, отдельно не сверялись.

### 1.4 `sites regenerate-config` — **не сверено** · МУТАЦИЯ

**argv:** `<fp> sites regenerate-config --server-name=<domain>` (в коде — с фоллбэком
`|| (nginx -t && systemctl reload nginx)` или `|| systemctl reload nginx`). Используется
при revoke SSL и nginx-override. Форма вывода не снималась.

---

## 2. `ftp_account` — FTP-аккаунты

### 2.1 `ftp_account list --json` — **сверено вживую (2026-08-16)**

**argv:** `<fp> ftp_account list --json` **· exit 0**

⚠️ **Список ГЛОБАЛЬНЫЙ** (все аккаунты сервера) — фильтровать по домену на стороне SDMP.
Массив объектов (обезличено):

```json
[{"id":8,"name":"example_ftp","virtualhost":8,"home_dir":"/var/www/example_usr/data/www/example.com","limit":0,"migrated":false,"enabled":true,"action":null,"owner_id":10,"owner":{"id":10,"username":"example_usr","home_dir":"/var/www/example_usr/data","sshd":true,"profile":null,"roles":"[\"ROLE_USER\"]","php_version":null,"node_version":null,"restore_email":"","status":"active","action":null,"quota":null,"limits":null,"state":null,"created_at":"2026-04-20T11:12:35.134629314Z"},"created_at":"2026-04-20T11:12:35.135249939Z"}]
```

| Поле | Смысл |
|---|---|
| `name` | **логин FTP** (напр. `example_ftp`) |
| `home_dir` | домашний каталог, `/var/www/<owner>/data/www/<domain>` |
| `virtualhost` | id сайта (совпадает с `sites[].id`) |
| `owner.username` | системный владелец |
| `enabled` | активен ли |

**Фильтр домена:** по `home_dir` (содержит `/www/<domain>`) или по `owner.username`.
**Пароля в объекте нет.**

### 2.2 `ftp_account list` (текст) — **сверено вживую (2026-08-16)**

**argv:** `<fp> ftp_account list` **· exit 0** — фоллбэк, когда `--json` недоступен.

```
ID	LOGIN       	HOME_DIR                                       	WEBSITE_ID	WEBSITE_NAME	OWNER      	ENABLED	CREATE_AT
8 	example_ftp 	/var/www/example_usr/data/www/example.com      	8         	example.com 	example_usr	true   	2026-04-20 11:12:35.135249939 +0000 UTC
```

Фильтр домена — по колонке `WEBSITE_NAME`.

### 2.3 ⚠️ Пароль FTP вернуть нельзя

Ни JSON, ни текст пароля не содержат — и не могут. Поэтому:

- **новым** доменам пароль сохраняется в момент provision (фаза 4 плана);
- **старым** доменам пользователь задаёт пароль вручную в SDMP.

**Команды смены пароля FTP через CLI НЕТ.** В `ftp_account` только `list`, `create
--login --password`, `remove --id` (сверено по `ftp_account --help`, 2026-08-16). А
`ftp_account create` существующему логину **пароль не меняет** — это подтверждено кодом
и тестами (`create_ftp_account`: при наличии логина `create` не зовётся). Сменить пароль
FTP можно только пересозданием аккаунта (`remove` + `create`) — это мутация, не в скоупе
чтения.

### 2.4 `ftp_account create` — **сверено вживую (2026-08-16, ветки)** · МУТАЦИЯ

**argv (SDMP при provision):**
`<fp> ftp_account create --login=<login> --password=<pass> --site=<domain>`

Пароль стоит в argv → на ошибке FastPanel эхом печатает его в usage. Поэтому вывод в SDMP
**не сохраняется** и сбой уходит `opaque_exit` (см. §7). Идемпотентность: перед `create`
SDMP делает `list` и, если логин уже есть, `create` **не зовёт** (иначе пароль не сменится,
а ошибка «quota entry already exists» введёт в заблуждение).

---

## 3. `databases` (мн. ч.) — базы данных

### 3.1 ⚠️ Правильное имя команды — `databases`, не `database`

**argv `<fp> database ...` (ед. ч.) — НЕ существует.** Сверено вживую (2026-08-16):

```
#sdmp:cmd <fp> database --help
error: expected command but got "database"
#sdmp:exit 1
#sdmp:cmd <fp> database list --json
{"errors":["expected command but got \"database\""]}
#sdmp:exit 1
#sdmp:cmd <fp> database list
error: expected command but got "database"
#sdmp:exit 1
```

Обрати внимание на форму ошибки: под `--json` она приходит как
`{"errors":["expected command but got \"database\""]}` (exit 1), без `--json` — как
`error: ...` в stderr.

### 3.2 `databases list --json` — **сверено вживую (2026-08-16)**

> **Провенанс.** Форма снята **прямым ручным прогоном `databases list --json` под root
> 2026-08-16** (exit 0). Discovery-скрипт эту форму НЕ снял: он слал ошибочную ед. ч.
> `database` и получал exit 1 — что и вскрыло баг §3.1. То есть метка «сверено вживую»
> верна, просто источник — ручной прогон, а не автоскрипт.

**argv:** `<fp> databases list --json` **· exit 0**

Массив объектов (форма, обезличено):

```json
[{"id":1,"name":"exampledb","site":{"id":8,"domain":"example.com"},"owner":{"username":"example_usr"},"server":{"type":"mysql"},"size":16564224,"charset":"utf8mb4"}]
```

⚠️ **Имя БД НЕ выводится из имени домена** (усечение/хеш: боевые имена не совпадают с
префиксом домена). Поэтому **фильтровать по `site.domain`**, а не по префиксу имени БД.

Прочие подкоманды группы: `databases servers list`, `databases list`, `databases sync`,
`databases create` — их живое поведение сверено в §3.5. Команды удаления БД (`remove`/`delete`)
в группе **нет**.

### 3.3 Смены пароля БД через CLI нет

В группе `databases` только `servers list` / `list` / `sync` / `create`. Команды
обновления/смены пароля БД **нет**. Сменить пароль БД можно только напрямую через `mysql`
(`ALTER USER ... IDENTIFIED BY ...`), это мутация вне скоупа чтения.

### 3.5 `databases servers list` / `databases create` — **сверено вживую (2026-08-17)** · МУТАЦИЯ

> **Провенанс.** Снято ручным прогоном пробы под root 2026-08-17: одноразовая БД
> `sdmp_probe_db` создана и убрана в том же прогоне (mysql `DROP` + `databases sync`). Формы
> ошибок и флаги — фактические.

**`databases servers list --json` · exit 0** — список mysql-серверов (обезличено):

```json
[{"id":1,"name":"mysql(localhost)","type":"mysql","host":"","port":0,"username":"...","local":true,"avail":true,"use_as_default":false}]
```

На живой установке сервер **ровно один**, `id:1`. Это и есть значение для `--server`.

**`databases create --help`** — полный набор флагов (важны `--server`, `--site`):

```
databases create --server=SERVER --name=NAME --username=USERNAME [<flags>]
  --server=SERVER      database server ID          ← ЧИСЛОВОЙ id, не имя; обязателен
  -o, --owner="fastuser"  account owner (ignored if --site is provided)
  -c, --charset="utf8mb4"
  -u, --username=USERNAME  database user username
  -p, --password=PASSWORD
  -s, --site=SITE      website domain to bind database (overrides --owner)
```

**Успех:** `databases create --server=1 --name=<db> --username=<user> --password=<pwd> --site=<domain>`
→ exit 0, `database '<db>' created successfully / ID: <n>`.

⚠️ **`--server` принимает только числовой id.** Имя (`mysql(localhost)`) даёт
`error: parsing "mysql(localhost)": invalid syntax` (exit 1).

⚠️ **`--server` обязателен.** Без него — `error: required flag --server not provided` (exit 1).

⚠️ **Привязка к сайту — только через `--site`.** Без `--site` база создаётся с `site:null` и
`owner:"fastuser"` (дефолт) — то есть панели формально известна, но НЕ привязана к сайту, не
попадёт в его бэкапы и `databases_size`. С `--site=<domain>` объект в `databases list` несёт
`site:{id,domain}` и владельца сайта. **Поэтому фикс обязан передавать `--site=<domain>`**, а
не только исправить имя команды.

**Повтор (идемпотентность):** та же `databases create` на существующую БД →
`error: 'database-already-exists'` (exit 1). Это ровно тот маркер, по которому «уже есть» ≠ отказ.

**Удаления БД в CLI нет** (`databases remove`/`delete` отсутствуют). БД, созданную через
FastPanel, из его учёта убирает `databases sync` после того, как сама база удалена в mysql:
sync снимает записи, чьей mysql-базы больше нет. Проверено: `sync` тронул только висящую
пробную запись, боевые не задел. (Обратная сторона исходного бага: mysql-фоллбэк создаёт базу
БЕЗ записи в FastPanel — её `sync` бы, наоборот, импортировал, но без `site`/`owner`.)

### 3.4 `database create` — **баг существующего provision** · МУТАЦИЯ

`desktop/src-tauri/src/ssh/fastpanel.rs` (провижн БД) шлёт:

```
<fp> database create --name=<db> --user=<user> --password=<pass>
```

то есть **`database` (ед. ч.)**, которой на этой версии FastPanel нет. Значит provision БД
здесь, **вероятно, падает** (есть mysql-фоллбэк, разбор — в отдельном плане). Сервер знает
только `databases create --server --name --username`. **Для ЧТЕНИЯ используем `databases
list --json`.** Починка мутации — `plans/2026-08-16-fastpanel-database-vs-databases.md`.

---

## 4. `certificates` — сертификаты

### 4.1 `certificates --help` — **сверено вживую (2026-08-16)**

**argv:** `<fp> certificates --help` **· exit 0**. Подкоманды:

```
certificates list [<flags>]                                    list certificates
certificates show-order --id=ID                                show certificate order
certificates create-le --server-name=SERVER-NAME --email=EMAIL Create Let`s Encrypt certificate
certificates reissue --id=ID                                   reissue certificate
certificates resume --id=ID                                    resume certificate issue
certificates actualizer-run [<flags>]
```

`certificates list` наружу — форму не снимали (**не сверено**); SSL-факты SDMP берёт из
`sites list --json` (`certificate{}`) и через `openssl` (§6).

### 4.2 `certificates create-le` / `certificates remove` — МУТАЦИИ

- **create-le** (SDMP при выпуске SSL): `<fp> certificates create-le
  --server-name=<domain> --email=<email>`. Самый долгий exec провижининга —
  `SSL_ISSUE_EXEC_TIMEOUT = 300s`. Сверена ветка ошибки (2026-08-16).
- **remove** (при revoke SSL): `<fp> certificates remove --server-name=<domain> || true`.
  **Не сверено.**

---

## 5. `php` — команды нет

**argv `<fp> php --help` · exit 1** (сверено вживую 2026-08-16):

```
error: expected command but got "php"
```

Версия PHP и обработчик — только из `sites list --json` (§1.1), отдельной php-команды не
существует.

---

## 6. Раскладка на файловой системе (сверено вживую 2026-08-16)

Читается напрямую (`ls`/`test -f`/`stat`/`openssl`), не через FastPanel CLI.

| Что | Путь | Примечание |
|---|---|---|
| Каталог сайта | `/var/www/<owner>/data/www/<domain>` | = `index_dir` из sites json |
| Логи сайта | `<home>/data/logs/<domain>-{frontend,backend}.{access,error}.log` | + ротация `.1`, `.N.gz` |
| nginx-конфиг | `/etc/nginx/fastpanel2-sites/<owner>/<domain>.includes` | расширение **`.includes`**, не `.conf` |
| apache-конфиг | `/etc/apache2/fastpanel2-sites/<owner>/` | **только** у apache-сайтов (`mpm_itk`) |
| SSL-файл (LE) | `/etc/letsencrypt/live/<domain>/fullchain.pem` | читает `read_ssl_info` через `openssl` |

Наблюдения с живого сервера:

- **Логи** (обезличено): у одного домена одновременно живут
  `<domain>-frontend.access.log`, `<domain>-frontend.error.log`,
  `<domain>-backend.access.log` + сжатая ротация `.2.gz … .10.gz`. Каталог
  `<home>/data/logs` содержит `.protected`.
- **nginx `.includes` существует, но директив логов в нём нет** — `cat` файла отдал exit 0
  с пустым (для наших целей) содержимым, а `grep -nE 'access_log|error_log|CustomLog|...'`
  по нему вернул **exit 1** (ничего не найдено). Пути логов выводим из раскладки выше, а не
  парсингом конфига.
- **apache-конфиг есть не у всех.** Каталоги в `/etc/apache2/fastpanel2-sites/` заведены
  только под `mpm_itk`-сайты; у `php_fpm`-сайтов файла нет вовсе. ⚠️ **Определять
  обработчик по `main_backend.handler`, а не по наличию apache-конфига.**

**SSL через `openssl`** (`read_ssl_info`, сверено формой команды):
`openssl x509 -in /etc/letsencrypt/live/<domain>/fullchain.pem -noout -enddate -issuer
-subject`. Даёт точный `notAfter=` (срок) и `issuer=` (издатель, Let's Encrypt ли).

---

## 7. Правила общения с CLI (как SDMP шлёт команды)

Живёт в `desktop/src-tauri/src/ssh/fastpanel.rs`.

1. **`pty: false` на каждом вызове.** Вывод должен быть машинным; pty подмешал бы escape-
   последовательности. Реализовано в `impl Exec for SshSession` (`self.exec(cmd, timeout,
   false)`).
2. **Shell-квотирование через `q()`.** Все интерполируемые значения (путь бинаря, домен,
   владелец) экранируются `q()` = `shell_escape::escape`. Прямой интерполяции в строку
   команды без `q()` быть не должно.
3. **`opaque_exit` для команд с паролем в argv.** У `sites create` / `ftp_account create`
   / `database create` пароль стоит прямо в argv, а FastPanel/mysql на ошибке **эхом
   печатают argv** в usage. Поэтому:
   - структуры-результаты (`CreateSiteResult`, `CreateFtpResult`, `CreateDbResult`) **не
     несут поля `output`** — нет поля, нет пути утечки во фронт;
   - на ошибке наружу уходит только `opaque_exit("<step>", code)` — шаг и код возврата,
     без текста вывода (`"<step> exit <code> (output withheld: it echoes the generated
     password)"`).
4. **Каскад чтения: JSON → текстовая таблица → «не знаем».** Сначала `<cmd> list --json`;
   если `--json` недоступен (старый CLI, ненулевой код, пустой вывод) — `<cmd> list`
   (текстовая таблица); если и это не даёт данных — факт помечается неизвестным, а не
   выдумывается. Так устроены `sites list` и `ftp_account list`.
5. **Резолв пути бинаря — `get_fastpanel_path`:** `which fastpanel` → `test -x
   /usr/local/fastpanel2/fastpanel` → `None`. Никогда не хардкодить путь мимо этой функции.

---

## 8. Что мы отправляем сегодня — инвентарь команд

Все команды, которые SDMP-десктоп реально шлёт в FastPanel/на сервер. Источники:
`desktop/src-tauri/src/ssh/fastpanel.rs` (операции по SSH) и
`desktop/src-tauri/src/provision/fastpanel_install.rs` (установка панели).

### Чтение (read-only)

| Команда (argv) | Функция | Сверено |
|---|---|---|
| `<fp> sites list --json` | `list_sites` | ✅ 2026-08-16 |
| `<fp> sites list` | `list_sites` (фоллбэк) | ✅ 2026-08-16 |
| `<fp> ftp_account list --json` | `list_ftp_accounts` / `ftp_exists` | ✅ 2026-08-16 |
| `<fp> ftp_account list` | там же (фоллбэк) | ✅ 2026-08-16 |
| `which fastpanel` / `test -x <fallback>` | `get_fastpanel_path` | ✅ 2026-08-16 |
| `test -d /var/www/<owner>/data/www/<domain>` | `site_dir_exists` | ✅ (форма) |
| `test -f /etc/letsencrypt/live/<domain>/fullchain.pem` | `cert_exists` | ✅ (форма) |
| `openssl x509 -in <fullchain> -noout -enddate -issuer -subject` | `read_ssl_info` | ✅ (форма) |
| `<fp> databases list --json` | (фаза 2, чтение БД) | ✅ 2026-08-16 (ручной прогон под root, не автоскрипт — см. §3.2) |

### Мутации (provision / lifecycle)

| Команда (argv) | Функция | Сверено |
|---|---|---|
| `<fp> sites create --server-name=<d> --owner=<o> --create-user --php-version=<v>` | `create_site` | ✅ ветка ошибки |
| `<fp> ftp_account create --login=<l> --password=<p> --site=<d>` | `create_ftp_account` | ✅ ветки |
| `<fp> database create --name=<db> --user=<u> --password=<p>` | `create_database` | ⚠️ баг §3.4 (см. план) |
| `<fp> certificates create-le --server-name=<d> --email=<e>` | `issue_ssl` | ✅ ветка ошибки |
| `<fp> certificates remove --server-name=<d> \|\| true` | `revoke_ssl_certificate` | не сверено |
| `<fp> sites regenerate-config --server-name=<d> \|\| (nginx -t && systemctl reload nginx)` | `revoke_ssl_certificate` | не сверено |
| `<fp> sites regenerate-config --server-name=<d> \|\| systemctl reload nginx` | `apply_nginx_override` | не сверено |
| `rm -rf /etc/letsencrypt/{live,archive}/<d> /etc/letsencrypt/renewal/<d>.conf` | `revoke_ssl_certificate` | не сверено |

### Установка панели (`fastpanel_install.rs`)

| Команда (argv) | Константа/функция | Сверено |
|---|---|---|
| `wget https://repo.fastpanel.direct/install_fastpanel.sh -O - \| bash -` | `INSTALL_CMD` | не сверено |
| `DEBIAN_FRONTEND=noninteractive apt-get update && ... apt-get -y upgrade` | `update_command` (debian/ubuntu-ветка) | не сверено |
| `yum -y update` | `update_command` (cent/rhel/rocky/alma/fedora) | не сверено |

Учётные данные панели (URL/логин/пароль) парсятся из вывода установщика
(`parse_fastpanel_credentials`); пароль панели — плейнтекст, `Debug` его редактирует
(`***`), из URL вычищается userinfo. Секрет в аудит/`fastpanel_url` не уходит.

---

## Приложение. Сырой вывод discovery

Полный обезличенный сырой вывод в репозиторий **не кладётся** (в нём боевые
домены/логины/пути). Фрагменты выше — курированные и обезличенные. Скрипт сбора —
`scripts/fastpanel-discovery.sh` (маркеры `#sdmp:section` / `#sdmp:cmd` / `#sdmp:exit` /
`#sdmp:skip` / `#sdmp:note` / `#sdmp:end`). Прогнать заново под root:
`bash scripts/fastpanel-discovery.sh <домен>`. Скрипт печатает логины и пути (пароли —
нет) — не коммить его вывод как файл.
