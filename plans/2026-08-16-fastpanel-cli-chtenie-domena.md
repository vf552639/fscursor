# План: FastPanel CLI — чтение состояния домена с сервера

**Дата:** 2026-08-16
**Связь с бизнесом:** доверие к панели как к «пульту управления инфраструктурой»
(`.business/audience/` — power-user ведёт десятки доменов). Сегодня overview показывает
снимок момента provision и выдаёт его за текущее состояние; это прямое нарушение
принципа №6 CLAUDE.md («не рисуй незнание здоровьем») и главная причина, по которой
пользователь всё равно лезет в веб-панель FastPanel.

## Контекст

Общение с FastPanel по CLI через SSH уже написано и работает
(`desktop/src-tauri/src/ssh/fastpanel.rs`, ~1900 строк): `sites create/list`,
`ftp_account list/create`, `database create`, `certificates create-le/remove`,
`sites regenerate-config`, чтение сертификата через `openssl`. HTTP API панели не
используется нигде.

Проблема: **общение однонаправленное — умеем создавать, не умеем читать.**

1. `list_sites`, `read_ssl_info`, `read_nginx_override`, `apply_nginx_override`,
   `revoke_ssl_certificate` лежат мёртвым кодом без единого вызывающего — Tauri-команды нет.
2. `ssl_status`, `ssl_expires_at`, `ssl_issuer`, `php_version`, `site_path`, `ftp_user`
   в overview — снимок момента provision, не помеченный как протухший. У домена нет
   ни одного поля «когда проверяли».
3. `domains.ftp_password_blob_id` и `db_password_blob_id` есть в БД, но не пишутся и
   не читаются ни строчкой кода. Пароль FTP показывается один раз и пропадает
   (вернуть его из панели нельзя — CLI отдаёт только логины).
4. Кнопка «Sync Domains» шлёт `POST /servers/{id}/sync-domains` — роут удалён при переезде
   на zero-knowledge. Гарантированный 404 на каждый клик.

**Что делаем.** Учим панель читать состояние существующего домена с сервера по кнопке,
показываем прочитанное с честной свежестью, доводим FTP-доступы до пригодного к
использованию вида (ip + логин + пароль) и документируем CLI по реальному выводу.
**Мутаций на сервере в этом плане нет — только чтение.**

**Решения, принятые при обсуждении:**
- Результаты чтения ложатся в БД через write-back — видны в вебе, переживают перезапуск.
- Читаем: SSL, FTP-аккаунты, PHP (версия + обработчик), сайт (путь, владелец, БД, логи).
- Пароли FTP: к старым доменам пользователь добавляет вручную, новые сохраняются автоматически.
- Есть живой сервер с FastPanel и доступ к нему — парсеры пишем по реальному выводу.
- Сломанную кнопку «Sync Domains» чиним здесь же, `list_sites` мы всё равно поднимаем.

**Отклонение от исходного ТЗ:** миграция названа `017_domain_fastpanel_facts.py`, а не `012`
— номер 012 занят (`012_drop_server_notes.py`), последняя ревизия в репозитории — 016.

## Acceptance criteria (что значит «готово»)

- [ ] `docs/FASTPANEL_CLI.md` описывает каждую команду с пометкой «сверено вживую» / «не сверено»,
      к нему приложен вывод discovery-скрипта с живого сервера.
- [ ] Кнопка «Проверить на сервере» в `DomainDetailModal` за одну SSH-сессию снимает
      SSL / FTP / PHP / сайт / БД / логи и пишет результат в БД.
- [ ] Провалившаяся проверка не стирает и не молодит последний хороший снимок.
- [ ] Ни одно поле overview не выглядит здоровым, если проверки не было или она протухла.
- [ ] FTP-доступ в модалке пригоден к использованию: хост + порт + логин + пароль.
- [ ] Provision больше не теряет пароли FTP и БД — они уходят в блобы сразу в `onResult`.
- [ ] «Sync Domains» не возвращает 404, а показывает сравнение сервер ↔ SDMP.
- [ ] Плейнтекст-секретов нет ни в `DomainFacts`, ни в argv команд чтения, ни в audit.

## Edge cases (продумать заранее)

- Сервер недоступен / SSH не поднимается → `fp_check_error`, снимок остаётся прежним.
- `HOST_KEY_UNKNOWN` → отдельная обработка, как в `provision_domain`.
- Домена нет на сервере вовсе → `site: None`, а не ошибка всей проверки.
- Сертификата нет → `sslState → "missing"`, отличать от «не проверяли».
- Снимок недельной давности: вывод о сроке переживает протухание, вывод о наличии — нет.
- Двойной клик по «Проверить» → гейт `runGate.ts`, один прогон на домен.
- Закрытие модалки во время прогона → результат обрабатывается в замыкании `mutationFn`,
  не в per-call `onSuccess`.
- Сотни доменов: чтение — только по кнопке, поштучно; массового прогона здесь нет.
- Zero-knowledge: пароль FTP не попадает ни в `useState`, ни в `variables` мутации,
  ни в сырой вывод команды внутри `DomainFacts`.

## Фазы

### Фаза 0 — Discovery на живом сервере → документация CLI  `[ ]`

Блокирует фазу 2. Без реального вывода парсеры пишутся вслепую, а старый долг
(«форма вывода `ftp_account list` не сверена») остаётся открытым.

- `scripts/fastpanel-discovery.sh` — один блок **только читающих** команд:
  `fastpanel --help`, `fastpanel sites --help`, `sites list --json`, `sites list`,
  `ftp_account --help`, `ftp_account list --json`, `ftp_account list`,
  `database --help`, `database list --json`, `certificates --help`, `php --help` (если есть),
  плюс конфиги сайта (`/etc/nginx/fastpanel2-sites/...`, `/etc/apache2/fastpanel2-sites/...`)
  и раскладка логов. Каждый вызов — с маркером секции и кодом возврата, как в
  `COLLECT_METRICS_COMMAND` (`frontend/src/lib/serverMetrics.ts`).
  Скрипт не печатает паролей, но печатает логины и пути — предупредить перед прогоном.
  **Написан** (2026-08-16): маркеры `#sdmp:section` / `#sdmp:cmd` / `#sdmp:exit` / `#sdmp:skip`
  / `#sdmp:note` / `#sdmp:end`, бинарь ищется как в `get_fastpanel_path`, домен — аргументом
  либо первым сайтом с сервера. Сверх списка собраны текстовые формы `database list`
  (у `sites`/`ftp_account` пара json+текст была в списке, у `database` — нет) — каскад
  «json → текстовая таблица» иначе нечем задокументировать.
- Прогнать на живом сервере, собрать вывод.
- `docs/FASTPANEL_CLI.md`: по каждой команде — argv, форма вывода (json и текст), коды возврата,
  поведение на «уже существует», что подтверждено живым прогоном и что нет.
  Раздел «Что мы отправляем сегодня» — инвентарь всех команд из `fastpanel.rs` и
  `fastpanel_install.rs`. Раздел «Правила»: `pty: false`, shell-квотирование через `q()`,
  `opaque_exit` для команд с паролем в argv, каскад json → текстовая таблица → «не знаем».
- Прописать `docs/FASTPANEL_CLI.md` в `CLAUDE.md` (таблица «где что искать») и в `docs/`.

### Фаза 1 — Бэкенд: место под факты с сервера  `[x]`

**Выполнено** (2026-08-16): миграция `017_domain_fastpanel_facts` применена к БД;
модель, схемы (`DomainFactsIn`, поля в `DomainResponse`/`DomainUpdate`), роут
`POST /domains/{id}/facts` (выше `GET /{domain_id}`), `domain_service.apply_facts`,
allow-list `domain.read_facts`. Тесты: `tests/test_domain_facts_endpoint.py` (9),
гард в `test_audit_actions.py`. Регрессия смежных файлов зелёная. Замечание:
колонку `php_handler` роут пока не пишет — сам снимок хранится в `fp_facts`;
отдельная колонка добавлена для будущего запроса/фильтра (фазы 2–3).

Миграция `backend/alembic/versions/017_domain_fastpanel_facts.py` — колонки в `domains`:

| Колонка          | Тип           | Смысл                                                       |
| ---------------- | ------------- | ----------------------------------------------------------- |
| `fp_checked_at`  | `TIMESTAMPTZ` | когда была последняя **попытка** чтения                     |
| `fp_check_error` | `TEXT`        | текст последней неудачи; `NULL` = последняя попытка удалась |
| `fp_facts`       | `JSON`        | сам снимок состояния                                        |
| `fp_facts_at`    | `TIMESTAMPTZ` | когда снят снимок (время последней **удачной** попытки)     |
| `php_handler`    | `VARCHAR(16)` | `apache` / `php-fpm` / `unknown`                            |

Два времени, а не одно, намеренно: провалившаяся попытка не должна ни стирать последний
хороший снимок, ни молодить его.

Новый роут **`POST /domains/{id}/facts`** в `backend/app/api/routes/domains.py` — зеркало
существующего `POST /servers/{id}/metrics`, и по тем же причинам:
- схема `DomainFactsIn` с `extra="forbid"`; тело без единого поля → 422;
- **время ставит сервер**, клиент прислать его не может;
- проверка владения через тот же путь, что и остальные роуты домена (404 на чужой);
- тело либо `{facts: {...}}` (успех: `fp_facts`, `fp_facts_at = now`, `fp_check_error = NULL`),
  либо `{error: "..."}` (неудача: `fp_check_error`, снимок не трогаем).
  В обоих случаях `fp_checked_at = now`.
- Роут объявить **выше** `GET /{domain_id}` — там уже стоит граница со ссылкой на причину.

`DomainResponse` — добавить `fp_checked_at`, `fp_check_error`, `fp_facts`, `fp_facts_at`,
`php_handler` и **`ftp_password_blob_id`**. Отдавать наружу id блоба безопасно и уже принято:
`ServerResponse` так отдаёт `fastpanel_password_blob_id`, и на нём стоит `RevealSecret`.
`DomainUpdate` — добавить `ftp_password_blob_id`.

Аудит: действие `domain.read_facts` в allow-list `backend/app/audit/service.py`.

### Фаза 2 — Rust: одна сессия — весь снимок  `[ ]`

Новый модуль `desktop/src-tauri/src/ssh/fastpanel_facts.rs` (отдельный файл, а не рост
`fastpanel.rs`: тот уже 1900 строк, и чтение — самостоятельная ответственность).

```rust
pub struct DomainFacts {          // Serialize; ни секретов, ни сырого вывода команд —
    pub site: Option<SiteInfo>,   // правило CreateSiteResult действует и здесь
    pub ssl: SslInfo,
    pub ftp_accounts: Vec<FtpAccount>,   // login + home; пароля нет и быть не может
    pub php_version: Option<String>,
    pub php_handler: Option<String>,
    pub databases: Vec<String>,
    pub logs: Vec<LogFile>,       // path + exists + size_bytes
}

pub async fn read_domain_facts(
    s: &mut SshSession, fp_path: &str, domain: &str, site_user: Option<&str>,
) -> Result<DomainFacts, SshError>;
```

**Переиспользуем, а не переписываем:**
- `list_sites` — путь, владелец, версия PHP (мёртвый код оживает);
- `read_ssl_info` — срок, издатель, Let's Encrypt ли (мёртвый код оживает);
- парсинг FTP: вынести `ftp_logins_from_json` / `cells` / `looks_like_a_table` в новую
  `list_ftp_accounts`, а существующую `ftp_exists` **переписать тонкой обёрткой над ней** —
  логика разбора обязана остаться в одном месте;
- `get_fastpanel_path`, `q()`, `opaque_exit` — как есть.

**Новое** (точные команды — после фазы 0): `read_php_handler` из конфига сайта,
`list_site_databases` (`database list --json`, фоллбэк на `mysql -N -B -e "SHOW DATABASES"`
с фильтром по префиксу), `read_log_paths` (`test -f` + `stat -c %s`).

Tauri-команда `domain_read_facts(domain_id)` в `desktop/src-tauri/src/commands/domain_facts.rs`,
по форме `provision_domain` (`desktop/src-tauri/src/commands/provision.rs`): резолв домена и
сервера из локального кэша (`cache::get_row_fields`), расшифровка SSH-блоба, `zeroize` пароля
сразу после `connect`, **одна** сессия на весь снимок, обработка `HOST_KEY_UNKNOWN`, write-back
в `POST /domains/{id}/facts`, аудит. Наверх возвращается `DomainFacts` (write-back и возврат —
оба, чтобы UI не ждал ресинка).

Таймауты: exec на команду 30–60 с, inactivity сессии — заведомо больше суммы; соотношение
закрепить тестом, как для `SSL_ISSUE_EXEC_TIMEOUT`. Регистрация команды в
`desktop/src-tauri/src/lib.rs`.

### Фаза 3 — Фронтенд: overview, который не врёт  `[x]`

**Выполнено** (2026-08-16): чистый модуль `frontend/src/lib/domainFacts.ts`
(`DomainFacts`, `FACTS_STALE_MS`=7 дней, `isFactsStale`, лестница `sslState` с
асимметрией «срок переживает протухание, наличие — нет»; порог `expiring`=14
дней тоже в модуле). Хук `useReadDomainFacts` в `api/domains.ts` через
`runExclusive`/`useRunPending` (гейт «один прогон на домен», `networkMode:
always` от runGate), write-back делает Rust, обновление карточки — инвалидация
в `finally` замыкания (переживает закрытие модалки). `BLOB_KIND.domainFtpPassword`
добавлен. Новый компонент `components/domains/DomainServerFacts.tsx` (шапка с
кнопкой «Проверить на сервере» + свежесть от `fp_facts_at` + `fp_check_error`;
FTP хост/порт21/логин/`RevealSecret`/«Задать пароль» через `useSecretSave`;
SSL по лестнице; Site путь/владелец/PHP+обработчик/БД/логи). `DomainDetailModal`
принял проп `servers` (долг «Server: 3» закрыт — имя сервера), прокинут из
`Domains.tsx`. Ручной ввод пароля — только десктоп, плейнтекст живёт лишь в
`useSecretSave`, в `variables` мутации не попадает. Тесты: `domainFacts.test.ts`
(17), `DomainServerFacts.test.tsx` (13), правки трёх тестов модалки и снапшота
BLOB_KIND. `npm test` — 910 зелёных, `tsc`/`npm run build` чисты. Долг: FTP-порт
захардкожен 21 (отдельного поля нет; подтвердится живым прогоном), правый
столбец карточки (снимок provision) оставлен рядом как «наша запись» — секция
фактов показывает живое чтение, как уживаются `ns_status` и сверка делегирования.

`frontend/src/lib/domainFacts.ts` — чистый модуль правил, по образцу
`frontend/src/lib/serverStatus.ts` (порог протухания живёт в модуле, а не в компоненте —
три экрана уже расходились):
- типы `DomainFacts`, `FACTS_STALE_MS`, `isFactsStale(iso, now)`;
- лестница `sslState(...) → "unchecked" | "missing" | "expired" | "expiring" | "valid" | "error"`.
  **Вывод о сроке переживает протухание, вывод о наличии — нет.** Сертификат, который неделю
  назад истекал через три дня, истёк и сейчас; а «сертификат есть» недельной давности — уже
  не знание. Зелёный занят только под свежее подтверждение.

`frontend/src/api/domains.ts` — `useReadDomainFacts()` через `invokeSynced("domain_read_facts")`,
гейт «один прогон на домен» через `frontend/src/api/runGate.ts`, `networkMode: "always"`,
результат через замыкание `mutationFn` (не через per-call `onSuccess` — при закрытии модалки
он не сработает).

`DomainDetailModal` — принимает проп `servers` (на `frontend/src/pages/Domains.tsx` он уже
загружен и раздаётся другим детям; заодно закрывается долг «Server: 3» — вместо сырого id имя):
- шапка секции: кнопка **«Проверить на сервере»** (только десктоп), рядом свежесть через
  `formatAgoStale` / `STALE_SUFFIX` из `frontend/src/components/ui/Primitives.tsx`,
  под ней — текст `fp_check_error`, если последняя попытка провалилась;
- **FTP**: хост (IP сервера), порт, логин, пароль через `RevealSecret` (`ftp_password_blob_id`),
  кнопка «Задать пароль» для ручного ввода, ниже — прочие FTP-аккаунты с сервера;
- **SSL**: состояние по лестнице, срок, издатель, отдельное «сертификата нет»;
- **Site**: путь, владелец, PHP версия + обработчик, список БД, пути логов.

Ручной ввод пароля: `putSecretBlob({ blobKind: BLOB_KIND.domainFtpPassword,
existingBlobId: domain.ftp_password_blob_id })` → `PUT /domains/{id}`.
Добавить `domainFtpPassword: "domain_ftp_password"` в `BLOB_KIND`
(`frontend/src/lib/secretBlob.ts`) — на бэкенде `blob_kind` свободная строка, allow-list
править не нужно. Плейнтекст не кладётся ни в `useState`, ни в `variables` мутации —
ограничение расписано в JSDoc `putSecretBlob`, соблюсти дословно.

### Фаза 4 — Provision перестаёт терять пароль FTP  `[ ]`

В обработчике `onResult` у `useProvisionDomain` и у массового прогона
(`frontend/src/api/domains.ts`) — сразу `putSecretBlob` + `PUT /domains/{id}` с полученным
`ftp_password_blob_id`, ещё до показа модалки. То же для пароля БД (`db_password_blob_id`).

Модалка разового показа остаётся, но перестаёт быть единственным шансом. Плейнтекст живёт
внутри обработчика и дальше не расходится. У массового прогона сохранять по мере прихода
каждого элемента очереди, а не в конце.

### Фаза 5 — Починить «Sync Domains»  `[ ]`

Tauri-команда `server_list_sites(server_id)` поверх ожившей `list_sites`. На карточке сервера —
сравнение «есть на сервере / есть в SDMP / только там / только тут». Удалить
`useSyncServerDomains` из `frontend/src/api/servers.ts` вместе с мёртвым
`POST /servers/{id}/sync-domains`.

## Verification

**Фаза 0:** вывод discovery-скрипта с живого сервера приложен к `docs/FASTPANEL_CLI.md`;
каждая команда помечена «сверено вживую» или «не сверено».

**Rust:** `cargo test` в `desktop/src-tauri`. Новые тесты — парсеры на **реальном выводе из
фазы 0** (по образцу `parse_sites_from_text_table`), тест «в argv команд чтения нет секретов»
(по образцу `issue_ssl_argv_has_no_secret`), тест соотношения таймаутов.

**Backend:** `pytest` в `backend`. Новые тесты — `POST /domains/{id}/facts`: чужой домен → 404,
пустое тело → 422, время ставит сервер (клиентское значение игнорируется), провал не стирает
`fp_facts`. Плюс `domain.read_facts` в `test_audit_actions.py`.

**Frontend:** `npm test`. `domainFacts.test.ts` — лестница SSL, в том числе «проверки не было ≠
здоров» и «протухший вывод о наличии сертификата не зелёный». Тесты модалки — кнопка проверки,
строка свежести, `RevealSecret`, ручной ввод пароля только в десктопе.

**Живой прогон (главная приёмка):** собрать десктоп, открыть домен на реальном сервере,
нажать «Проверить на сервере». Ожидаем: FTP-логин и пути совпадают с веб-панелью FastPanel;
срок SSL совпадает с `openssl` вручную; `fp_checked_at` появился; после ручного ввода пароля
FTP — реальный вход по FTP этими кредами проходит. Затем сломать проверку намеренно (погасить
сервер) и убедиться, что старый снимок не стёрт, ошибка показана, свежесть помечена протухшей.

## Итог

- Реализован целиком: **нет** — работа начата 2026-08-16.
- Что осталось: все фазы.
