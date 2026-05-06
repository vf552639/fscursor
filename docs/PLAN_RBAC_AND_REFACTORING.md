# Детальный план: RBAC, мультипанели и рефакторинг SDMP

Документ собран после изучения кода `FS_cursor`. Он покрывает:
1. Систему пользователей и ролей (RBAC)
2. Подготовку архитектуры под несколько хостинг-панелей (FastPanel сейчас, cPanel в будущем)
3. Замечания и правки по существующему коду
4. Анализ функций, конкурентов и рекомендации по продукту

> **Синхронизация с кодом (2026-05-06):** Ниже — долгосрочный план; часть замечаний устарела относительно текущего репозитория. Уже сделано: таблица `system_config` и сервис `system_config_service` (конфиг не in-memory), исходящие уведомления (webhook + Telegram через `notification_providers`), `POST /api/settings/notifications/test`, вкладка **SSL Pool** в Settings, bulk-import серверов (`/api/servers/bulk-import`), upsert DNS при создании записи в Cloudflare. **Stage 0 (2026-05-06):** в репозитории появился каркас **Tauri 2** (`desktop/`), в `requirements.txt` закреплены зависимости под будущий auth (`argon2-cffi`, `bcrypt`, `itsdangerous`, `slowapi`, `pyotp`, `email-validator`, `resend`) — без новых защищённых API-роутов. RBAC, абстракция панелей, полноценный browser-fallback для лицензии FastPanel и массовые тесты — всё ещё в зоне этого документа.

---

## 0. Краткое резюме текущего состояния (TL;DR)

**Что есть:**
- FastAPI + async SQLAlchemy + Postgres (Supabase) + Celery/Redis + React/Vite.
- Сущности: `Server`, `ServerSecret`, `Domain`, `RegistrarAccount`, `CloudflareAccount`, `Notification`, `TaskLog`, `ActivityLog`.
- Интеграции: Cloudflare API, Hostiq, Namecheap, FastPanel (через SSH/Paramiko).
- Celery: установка FastPanel, установка NS, ежедневная проверка продлений (9 месяцев).
- AES-GCM шифрование секретов через `ENCRYPTION_KEY` из `.env`.

**Чего нет (критично):**
- Нет аутентификации, нет пользователей, нет ролей — все API открыты.
- На фронтенде уже зашиты артефакты «Logout» и `localStorage.sdmp_token`, но за ними нет реального backend.
- Нет тестов.
- Пользовательские «infra»-поля в UI Settings частично пересекаются с реальным контрактом `.env` — UX ещё можно упростить (read-only vs editable).
- FastPanel-интеграция жёстко зашита в `tasks/fastpanel_task.py` — нет абстракции "панель хостинга".
- В `renewal_task.py` баг: используется `Domain.created_at` вместо `Domain.purchase_date`.

---

## 1. Система пользователей и ролей (RBAC)

### 1.1 Цели

- Поддержка нескольких пользователей с разными правами.
- Минимум две роли на старте: **Admin** (всё) и **Developer** (видит только домены, без секретов).
- Расширяемость: легко добавить новые роли (Viewer, Operator, Billing).
- Audit: кто что сделал — должно отражаться в `activity_logs`.

### 1.2 Модель данных (новая миграция `003_users_and_rbac.py`)

Новые таблицы:

**`users`**
- `id` PK
- `email` (unique, citext) — логин
- `password_hash` (Text) — bcrypt/argon2
- `full_name` (String 255, nullable)
- `role` (String 32) — `admin` / `developer` / `viewer` / `operator`
- `is_active` (Bool, default true)
- `last_login_at` (DateTime nullable)
- `created_at`, `updated_at` (TimestampMixin)

**`refresh_tokens`** (если идём через JWT с refresh)
- `id` PK
- `user_id` FK → users CASCADE
- `token_hash` (String 128, unique)
- `expires_at` (DateTime)
- `revoked_at` (DateTime nullable)
- `user_agent`, `ip_address` — для аудита

**`user_resource_grants`** (опционально, для тонких прав на конкретные ресурсы)
- `id` PK
- `user_id` FK
- `resource_type` (`server` | `domain` | `registrar_account` | `cloudflare_account`)
- `resource_id` (int)
- `permission` (`read` | `write` | `manage`)

Это позволит, например, выдать конкретному разработчику доступ только к 3 доменам, а не ко всем.

### 1.3 Роли и права (матрица)

| Действие | Admin | Developer | Operator | Viewer |
|---|---|---|---|---|
| Просмотр доменов (имя, NS-статус, привязка) | да | да | да | да |
| Просмотр `purchase_date`/`expiry_date` | да | да | да | да |
| Просмотр серверов: список, IP, ОС | да | нет | да | да |
| Просмотр SSH-секретов / FastPanel паролей | да | нет | нет | нет |
| Просмотр API-ключей регистраторов / Cloudflare | да | нет | нет | нет |
| Создание/редактирование сервера | да | нет | да | нет |
| Установка FastPanel/cPanel | да | нет | да | нет |
| Создание/редактирование доменов, bulk-импорт | да | нет | да | нет |
| Установка NS, привязка к Cloudflare | да | нет | да | нет |
| Управление пользователями | да | нет | нет | нет |
| Управление regular settings | да | нет | нет | нет |
| Просмотр уведомлений | да | да | да | да |

> Под «доступ только к домену» из ТЗ Андрея — это роль **Developer**. Видит список доменов, их статус, NS, привязку к серверу/регистратору **по имени** (без секретов), но не видит ни SSH, ни API-ключей, ни паролей FastPanel.

Реализация прав: модуль `app/core/permissions.py` с константами и функциями `can(user, action, resource=None)`. На уровне ответов API — сериализаторы должны фильтровать поля (см. ниже про схемы).

### 1.4 Аутентификация (выбор подхода)

Рекомендую **JWT (access + refresh)**:
- `access_token` — короткий (15 мин), HS256, в Authorization header.
- `refresh_token` — длинный (7–30 дней), httpOnly cookie, ротация при использовании, хеш в `refresh_tokens`.
- Альтернатива — серверные сессии в Redis (проще ревокать, но сложнее с CORS/SPA).

Зависимости (добавить в `requirements.txt`):
- `passlib[bcrypt]==1.7.4`
- `python-jose[cryptography]==3.3.0`
- `pyotp==2.9.0` — на будущее под TOTP/2FA

### 1.5 Backend изменения

**Новые файлы:**
- `app/models/user.py` — модели User, RefreshToken, UserResourceGrant.
- `app/schemas/auth.py` — LoginRequest, TokenPair, UserCreate, UserResponse.
- `app/services/auth_service.py` — register, login, refresh, revoke, hash/verify.
- `app/core/security.py` — JWT encode/decode, password hashing.
- `app/core/permissions.py` — RBAC-матрица + хелперы.
- `app/api/routes/auth.py` — `/auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/me`.
- `app/api/routes/users.py` — CRUD пользователей (только admin).
- `app/api/deps.py` — `get_current_user`, `require_role(...)`, `require_permission(...)`.

**Правки существующих:**
- `app/main.py` — подключить `auth.router`, `users.router`.
- В каждом роутере (`servers.py`, `domains.py`, `registrars.py`, `cloudflare.py`, `notifications.py`, `tasks.py`, `settings.py`) добавить `Depends(get_current_user)` и проверки прав.
- Сериализация: использовать разные `response_model` для admin vs developer (или метод `to_dict(include_secrets=...)` в сервис-слое). Например, `ServerResponse` для admin содержит `fastpanel_url/user`, а `ServerResponseLite` для developer — нет.
- В `activity_logs` записывать `user_id` действия (нужно расширить модель).

**Bootstrap первого админа:**
- CLI-команда `python -m app.cli create_admin --email ... --password ...` или одноразовый seed через переменные окружения `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` (читаются на старте, если таблица пуста).

### 1.6 Frontend изменения

- Реальная страница `Login.tsx` (сейчас в `App.tsx` есть только бутафорный `handleLogout`).
- Хранение access токена в памяти (Zustand store), refresh — в httpOnly cookie.
- `api/client.ts` — interceptor: 401 → попытка refresh, при провале — редирект на логин.
- Гард `RequireAuth` + `RequireRole` для маршрутов.
- Скрытие пунктов меню в зависимости от роли (Servers/Cloudflare/Settings скрываем для Developer).
- Страница `Users.tsx` (только admin) — список, инвайт, смена роли, деактивация.
- Профиль: смена пароля, имя, опц. 2FA.

### 1.7 Безопасность

- Rate limiting на `/auth/login` (например, через `slowapi`): 5 попыток / 15 мин на IP+email.
- Пароли: argon2 или bcrypt (cost ≥ 12).
- Logout = ревокация refresh-токена в БД.
- Аудит: каждый login/logout/смена роли — в `activity_logs`.
- Опционально 2FA (TOTP) для admin.

### 1.8 Этапы внедрения

1. Миграция + модели + хеширование паролей + bootstrap admin.
2. JWT login/refresh/logout + middleware.
3. RBAC-хелперы и обвязка существующих эндпоинтов (без UI).
4. Сериализаторы lite-версий для Developer.
5. Frontend: Login + auth store + interceptor + guards.
6. UI управления пользователями (admin).
7. UserResourceGrant (тонкие права на конкретные домены/серверы) — опционально, второй итерацией.

---

## 2. Подготовка к мультипанелям (FastPanel сейчас, cPanel в будущем)

### 2.1 Проблема

Сейчас в коде «панель» = FastPanel, и это зашито намертво:
- В `models/server.py`: `fastpanel_status`, `fastpanel_url`, `fastpanel_user`, `fastpanel_password_encrypted`.
- В `tasks/fastpanel_task.py`: процесс установки и парсинг вывода специфичны для FastPanel.
- В API: `POST /servers/{id}/install-fastpanel`, `GET /servers/{id}/fastpanel-status`.
- На фронте кнопки и поля называются `FastPanel`.

cPanel радикально отличается: коммерческий (требует лицензии WHM), другой installer, другой формат админских доступов, другой API (WHM JSON API / cPanel UAPI), другие порты (2087/2083), другая логика создания юзеров.

### 2.2 Целевая архитектура — паттерн Strategy + Registry (как уже сделано для регистраторов)

По образцу `app/services/registrars/`:

**Новая директория `app/services/panels/`:**
- `base.py`:
  ```python
  class PanelError(Exception): ...

  class BasePanelService(ABC):
      provider: str = ""              # "fastpanel" | "cpanel"
      default_port: int                # 8888 для FP, 2087 для cPanel/WHM

      @abstractmethod
      async def install(self, server, ssh_password, log_cb) -> PanelInstallResult: ...
      @abstractmethod
      async def get_status(self, server) -> PanelStatus: ...
      @abstractmethod
      async def add_site(self, server, domain) -> SiteResult: ...
      @abstractmethod
      async def remove_site(self, server, domain) -> None: ...
      @abstractmethod
      async def list_sites(self, server) -> list[SiteResult]: ...
      @abstractmethod
      async def issue_ssl(self, server, domain) -> SSLResult: ...
  ```
- `fastpanel.py` — переезд логики из `tasks/fastpanel_task.py` сюда; парсинг credentials, SSH-команды.
- `cpanel.py` — пока заглушка с `NotImplementedError`, чтобы каркас был готов.
- `factory.py`:
  ```python
  _REGISTRY = {"fastpanel": FastPanelService, "cpanel": CPanelService}
  def get_panel_service(server) -> BasePanelService: ...
  ```

### 2.3 Изменения в модели данных

Миграция `004_panel_abstraction.py`:

В таблице `servers`:
- Добавить `panel_provider` (String 32, default `'fastpanel'`).
- Переименовать `fastpanel_status` → `panel_status`.
- Переименовать `fastpanel_url` → `panel_url`.
- Переименовать `fastpanel_user` → `panel_user`.
- Переименовать `fastpanel_password_encrypted` → `panel_password_encrypted`.
- Добавить `panel_port` (Int nullable) — у FP 8888, у cPanel 2087.
- Добавить `panel_extra` (JSONB nullable) — вендор-специфичные поля (license key для cPanel, WHM API token и т.д.).

> Миграция должна быть с downgrade (переименование колонок туда-обратно — тривиально через `op.alter_column`).

### 2.4 API — обобщить эндпоинты

В `api/routes/servers.py`:

- `POST /servers/{id}/install-panel` (новый) — body `{provider: "fastpanel" | "cpanel"}`. Старый `install-fastpanel` остаётся как алиас на этап миграции.
- `GET /servers/{id}/panel-status` — единый ответ с `provider`, `status`, `url`, `user`, `log_tail`.
- `POST /servers/{id}/panel/sites` (опционально, на будущее) — добавление сайта/домена в панель.

Celery task переименовать: `app.tasks.fastpanel.install_fastpanel` → `app.tasks.panel.install_panel(server_id, provider)`. Внутри задачи — `service = get_panel_service(server)` и вызов `service.install(...)`.

### 2.5 Frontend

- В `Servers.tsx` / `ServerDetail.tsx` — селектор `Panel: [FastPanel | cPanel]`.
- Кнопки и заголовки: «Install FastPanel» → «Install panel» с подписью текущего провайдера.
- Если `panel_provider == 'cpanel'` — другие поля в UI (порт 2087, ссылка на WHM/cPanel).

### 2.6 Когда дойдёт до cPanel — что нужно

Это уже на будущее, но чтобы не тратить время дважды:
- Установка cPanel требует свежего CentOS/AlmaLinux/RHEL и лицензии. SSH-installer существует (`cd /home && curl -o latest -L https://securedownloads.cpanel.net/latest && sh latest`).
- Управление ведётся через WHM API (root token), а не через `/etc/...` напрямую.
- Хранить нужно `whm_api_token_encrypted`, а не пароль root WHM.
- Отдельная сущность аккаунтов cPanel внутри сервера (может пригодиться `panel_accounts` таблица в будущем).

### 2.7 Этапы внедрения

1. Создать `app/services/panels/{base,fastpanel,factory}.py`, перенести логику из `tasks/fastpanel_task.py`, не меняя БД.
2. Миграция `004_panel_abstraction.py` с переименованием колонок + `panel_provider`.
3. Обновить роуты и фронт под `panel_*` поля; добавить алиасы на старые.
4. Заглушка `cpanel.py` + интеграционные точки в UI.
5. Когда придёт время — реализовать `cpanel.py`.

---

## 3. Замечания и правки по существующему коду

### 3.1 Критичные баги

**3.1.1 `renewal_task.py` использует не то поле**
- Файл: `backend/app/tasks/renewal_task.py:25`
- Сейчас: `func.date(Domain.created_at) <= threshold`
- Должно быть: `func.date(Domain.purchase_date) <= threshold` (с фоллбеком на `created_at`, если `purchase_date` не задано).
- Иначе: задача шлёт уведомления о продлении на основе даты добавления домена в систему, а не реальной даты покупки.

**3.1.2 In-memory Settings**
- Файл: `backend/app/api/routes/settings.py`
- `_SYSTEM_CONFIG: dict[str, str]` живёт в процессе и теряется при рестарте; в режиме нескольких воркеров значения могут расходиться.
- Решение: новая таблица `system_config (key PK, value Text, updated_by FK→users, updated_at)` + сервисный слой + кэш в Redis.
- Ещё хуже: текущий `update_config` принимает любой ключ — нужна whitelist допустимых ключей (или явно неизменяемые серверные настройки выводить как `editable=false`).

**3.1.3 Frontend «Logout» без аутентификации**
- `frontend/src/App.tsx:66-72` — кнопка Logout трогает `localStorage`, но никакого реального logout нет. После RBAC переписать на честный flow.

**3.1.4 Cloudflare sync — сохраняет аккаунт даже при ошибке**
- В `routes/cloudflare.py` (по выводу анализа): аккаунт коммитится до sync, и при провале sync аккаунт всё равно остаётся.
- Решение: либо `flush()` без commit + sync в одной транзакции с откатом при ошибке, либо чёткий статус «account created, sync failed» в ответе.

**3.1.5 N+1 в `domain_service.bulk_create()`**
- Файл: `backend/app/services/domain_service.py`
- Цикл вызывает `get_by_name(db, name)` для каждой строки.
- Решение: один `SELECT ... WHERE domain_name IN (:names)`, в Python — set уже занятых, дальше валидация.

### 3.2 Архитектурные правки

**3.2.1 SSH блокирует event loop / Celery worker**
- Paramiko синхронный, вызывается напрямую из async-задач.
- Минимум: оборачивать SSH в `asyncio.to_thread(...)`.
- Лучше: перейти на `asyncssh` для всего, что выполняется на сервере (`fastpanel_task.py`, future panel tasks, `server_service.test_ssh_connection`).

**3.2.2 Два `asyncio.run()` в одной Celery задаче**
- В `install_fastpanel` сейчас два `asyncio.run(...)` подряд — каждый создаёт свой event loop. Лучше один `asyncio.run(_main(...))`, внутри которого создаётся `task_log` и запускается установка.

**3.2.3 Парсинг credentials FastPanel хрупкий**
- Регулярки для URL/login/password ловят пробелы/случайные строки.
- Дополнить:
  - сохранять полный сырой output в TaskLog (уже есть);
  - использовать несколько паттернов и выбирать тот, что даёт валидный URL;
  - валидировать, что URL `https://<ip>:8888`;
  - если не распарсили — статус `installed_no_credentials`, чтобы admin зашёл и забрал руками.

**3.2.4 Шифрование секретов**
- `ENCRYPTION_KEY` в `.env` — единая точка отказа. На production стоит:
  - вынести ключ в KMS/Vault или хотя бы в системный secret-manager хоста;
  - предусмотреть rotation: добавить версию ключа в первый байт зашифрованного payload (`v1:base64(...)`), и сервис расшифровки умеет несколько версий;
  - хранить пароли FastPanel сразу в `ServerSecret`, а не как `fastpanel_password_encrypted` в `Server` — сервер становится «голой» сущностью без секретов.

**3.2.5 `ServerSecret` — расширить модель секретов**
- Сейчас только `ssh_password_encrypted`. Имеет смысл сделать единое хранилище секретов сервера: `ssh_password`, `ssh_private_key`, `panel_password`, `whm_api_token`. Тогда `Server` сам не хранит секретов вообще, а `secret`-таблица — единая точка для шифрования/ротации/аудита доступа.

**3.2.6 Sensitive-данные в логах**
- `task_log.log_text` сейчас может содержать вывод установщика, в т.ч. пароль FastPanel. После того как credentials распарсены — нужно маскировать пароль в логе перед сохранением (заменить на `********`).

**3.2.7 CORS**
- `BACKEND_CORS_ORIGINS` пустой по дефолту — фронт не сможет обращаться. Заложить разумные дефолты на dev (`http://localhost:3100,http://localhost:8080`).

**3.2.8 Структурное логирование**
- Подключить `structlog` или `python-json-logger` + correlation id. Сейчас в сервисах нет `logger` — отлаживать прод будет тяжело.

**3.2.9 Тесты**
- Завести `backend/tests/` с pytest:
  - unit на `encryption_service`, `domain_service.bulk_create*`, `notification_service.upsert_renewal_notification`;
  - API-тесты на CRUD доменов/серверов с `httpx.AsyncClient` и тестовой БД (или SQLite + alembic upgrade);
  - моки для Cloudflare/Hostiq/Namecheap (через `respx`).

**3.2.10 Идемпотентность Celery-задач**
- `install_fastpanel.delay(server_id)` без защиты от двойного клика. Решение: в момент enqueue ставить `server.fastpanel_status = 'pending'` атомарно (`UPDATE ... WHERE fastpanel_status NOT IN ('pending','installing','updating')`), и если 0 строк — отвечать 409 Conflict.

**3.2.11 Индексы БД**
- `domains(domain_name)` — уже unique.
- Нужны индексы:
  - `domains(server_id)`, `domains(registrar_id)`, `domains(cloudflare_account_id)` — все эти поля в фильтрах роутера.
  - `domains(purchase_date)` — для renewal-проверки.
  - `notifications(is_read, created_at desc)` — для списка непрочитанных.

**3.2.12 Versioning API**
- В `config.py` `API_V1_PREFIX` уже есть, но в реальности префикс `/api`, а не `/api/v1`. Имеет смысл переехать на `/api/v1/` сейчас, пока публичных потребителей нет.

**3.2.13 Frontend: убрать инлайн-стили и `localStorage` для UI-настроек**
- `App.tsx` — мегакомпонент с инлайн CSS на ~180 строк. На длинной дистанции:
  - вынести темизацию в CSS-переменные / Tailwind-конфиг;
  - перейти на `react-router-dom` (он уже в зависимостях) вместо ручного state-роутинга.

### 3.3 Маленькие правки/чистка

- `routes/settings.py:36-39` — ветви `if/else` идентичны, можно сократить до одной строки.
- `tasks/fastpanel_task.py:159-163` — два `asyncio.run` (см. 3.2.2).
- `services/registrars/factory.py` — стоит логировать «Unknown provider», чтобы было видно в админке.
- В `Server` сериализаторе — не возвращать `fastpanel_password_encrypted` никогда (сейчас это Text-поле модели; убедиться, что схема `ServerResponse` его не включает).

---

## 4. Анализ функций сервиса и сравнение с конкурентами

### 4.1 Что сервис делает сейчас (ядро)

- Каталог серверов с SSH-доступом и установка FastPanel в один клик.
- Каталог доменов с массовым импортом и привязкой к серверу/CF/регистратору.
- Автоматическая установка NS на регистраторе из NS Cloudflare-зоны.
- Напоминания о продлении доменов (9 месяцев после покупки).
- Логирование задач + activity log.

### 4.2 Сегмент и конкуренты

Это не SaaS-конкурент cPanel/Plesk — это **внутренняя оркестрация**: связать «сервер у хостера» + «домен у регистратора» + «зону на Cloudflare» в один pipeline. Ближайшие аналоги:

- **RunCloud / Ploi / GridPane / SpinupWP / Cleavr / Forge** — managed-панели для VPS. У них вся фишка в красивом деплое сайтов и SSL, но они **не управляют доменами у регистратора** и не делают массовый bulk-сетап NS.
- **Cloudflare Registrar / Porkbun / Namecheap dashboard** — управляют доменами, но не серверами.
- **WHMCS / Blesta** — биллинг + клиенты + домены, но это для хостинг-провайдеров, не для внутреннего использования.
- **Самописные "domain managers"** в SEO-агентствах — обычно Google-таблицы.

Уникальная ниша SDMP: **PBN / SEO-агентство / арбитраж**, где у одного владельца десятки/сотни доменов, размазанных по нескольким регистраторам и серверам. Тут сила — в bulk-операциях и автоматизации NS.

### 4.3 Что добавить (приоритизировано)

**High priority — закрывает дыры**

1. **SSL-автоматизация (Let's Encrypt через FastPanel/cPanel API)**
   - После добавления домена и установки NS — автоматически выпустить сертификат.
   - Мониторинг истечения SSL, как у доменов.
2. **Health-check серверов**
   - Cron-задача: ping/SSH/HTTP-чек, состояние диска (df -h), uptime, нагрузка.
   - Уведомления при down/превышении thresholds.
3. **Мониторинг WHOIS / реальной даты регистрации**
   - У регистратора `expiry_date` бывает не точным; добавить периодический WHOIS-pull (rdap.org или python-whois) для проверки реальной даты + детект «домен утрачен / refreshed».
4. **Bulk-операции для серверов**
   - Сейчас bulk есть только для доменов. Полезно: bulk «установить FastPanel на 10 серверов», bulk «обновить системные пакеты».
5. **Миграция доменов между серверами**
   - Перенос nginx-конфига + БД + файлов через FastPanel API (когда сделаем); сейчас только привязка-ссылка.
6. **DNS-шаблоны**
   - При линковке домена с CF создавать дефолтный набор записей (A → server IP, www CNAME, MX, SPF, DKIM-плейсхолдер). Сейчас только NS подменяется.

**Medium priority — конкурентные фичи**

7. **Multi-tenant / Workspaces**
   - Если будут клиенты/команды — изоляция данных по workspace, не только по user role.
8. **API-токены для интеграций**
   - Личные токены пользователей с scope (read-only, domains-only) — для CI/скриптов.
9. **Webhooks**
   - События: «домен скоро истекает», «FastPanel установлен», «NS обновлены» — отправлять в Slack/Telegram/Discord/произвольный URL.
10. **Telegram/Slack-бот**
    - Уведомления + быстрые команды (/check_renewals, /install_fp <ip>).
11. **Reporting / Dashboard 2.0**
    - Графики: домены по регистраторам, по статусу NS, истекающие в N дней, серверы по нагрузке.
12. **Поиск + теги/папки**
    - Глобальный search по доменам/серверам/уведомлениям. Теги (`pbn`, `client-X`, `staging`) на сервере и домене.

**Low priority — поверх продукта**

13. **Биллинг-обзор**
    - Учёт стоимости домена/сервера/CF, прогноз затрат на 30/90 дней, экспорт в CSV.
14. **Резервное копирование конфигов**
    - Снапшоты nginx/Apache конфигов FastPanel перед изменениями; rollback.
15. **Public-facing status-page**
    - На случай если у клиента нужен SLA-отчёт.

### 4.4 Что убрать / упростить

- Внутри `Settings` страницы текущие ключи (`API Base URL`, `Backend Port`, `Postgres Port` и т.д.) — это **infra-конфиг**, не пользовательский. Их редактирование через UI ничего не меняет (они читаются из `.env` при старте). Стоит:
  - сделать их read-only (просто отображение текущих),
  - убрать совсем,
  - либо переделать страницу `Settings` под пользовательские настройки (notification thresholds, default panel provider, default Cloudflare account).

### 4.5 Что изменить в существующих фичах

- **Renewal-уведомления:** период 9 месяцев — спорный дефолт. Большинство доменов на 1 год, реальное окно «надо продлевать» — 30/14/7 дней до `expiry_date`. Сейчас система больше похожа на «ты владеешь доменом 9 месяцев, проверь не пора ли отказаться». Предлагаю:
  - порог сделать конфигурируемым (per-user или global): `renewal_warn_days_before_expiry` = [60, 30, 14, 7];
  - база — `expiry_date`, а не `purchase_date + 9 месяцев`;
  - оставить «ранний» 9-месячный сигнал как отдельный тип уведомления (опц.).
- **Активити-лог** — сейчас пишет `entity_*` без `user_id`. После RBAC обязательно расширить: кто, что, откуда (IP/UA), когда.
- **TaskLog** — добавить `started_at`, `finished_at`, `duration_sec` для аналитики; сейчас только `created_at`/`updated_at` от mixin.
- **Notifications** — добавить `severity` (`info`/`warning`/`critical`) и фильтрацию в UI; `channel` (in-app/email/telegram) когда добавим внешние каналы.

---

## 5. Рекомендуемая последовательность работ

Разбивка на спринты ~по неделе (можно склеивать).

**Спринт 1 — Безопасность и фундамент**
- Bug в `renewal_task.py` (purchase_date).
- Settings → БД + whitelist.
- Индексы БД.
- Маскирование секретов в TaskLog.
- Idempotency для install_fastpanel.

**Спринт 2 — RBAC v1**
- Миграция users / refresh_tokens.
- `auth_service`, `core/security`, `core/permissions`.
- Routes `/auth/*`, `/users` (admin only).
- Bootstrap первого админа.
- Защита всех существующих эндпоинтов через `Depends`.

**Спринт 3 — Frontend под RBAC**
- Login + auth store + interceptor + guards.
- Скрытие пунктов меню для Developer.
- Lite-сериализация серверов и регистраторов.
- Страница «Users».

**Спринт 4 — Абстракция панели**
- `app/services/panels/` (base + fastpanel + factory).
- Миграция `panel_*` колонок.
- Переименовать celery task / роуты, оставить алиасы.
- UI: селектор panel provider.

**Спринт 5 — Качество и наблюдаемость**
- Структурное логирование.
- Pytest-набор (auth, services, API).
- Замена Paramiko на `asyncssh` (или `to_thread` как минимум).
- Rate limiting на /auth.

**Спринт 6 — Продуктовые фичи**
- SSL-автоматизация.
- WHOIS-проверка expiry.
- Webhooks / Telegram-бот.
- Dashboard 2.0.

---

## 6. Чек-лист первоочередных правок (быстро и понятно)

- [ ] Поправить `renewal_task.py`: `created_at` → `purchase_date`.
- [ ] Settings перевести на БД (`system_config`).
- [ ] В `bulk_create` доменов сделать batch SELECT (убрать N+1).
- [ ] Маскировать пароль FastPanel в TaskLog после парсинга.
- [ ] Atomically переводить `fastpanel_status` в `pending` через UPDATE с WHERE-условием.
- [ ] Добавить миграцию `users`, `refresh_tokens`, `user_resource_grants`.
- [ ] Реализовать JWT-аутентификацию + RBAC-зависимости.
- [ ] Bootstrap admin через ENV.
- [ ] Логин на фронте + интерцептор + guard + меню по ролям.
- [ ] Lite-сериализация ресурсов для роли Developer.
- [ ] Создать `services/panels/` с FastPanel-стратегией; переименовать колонки на `panel_*`.
- [ ] Завести pytest и базовый набор тестов.

---

## 7. Открытые вопросы для уточнения

1. **Уровень доступа Developer** — только просмотр доменов (имена + статусы)? Или ещё их редактирование? Из ТЗ — «только домены», склоняюсь к read-only по доменам и нулевому доступу к серверам/секретам.
2. **Multi-tenant** нужен сразу (workspaces/команды) или 1 организация = 1 инсталляция?
3. **2FA** — обязательное для admin или опциональное?
4. **Тонкие гранты** (`UserResourceGrant`) — сразу или второй итерацией? Если у разработчика доступ только к 1 проекту с 5 доменами — это уже надо.
5. **cPanel** — есть ли уже сервера для тестов и лицензия, или это полностью «на потом»?
6. **Где хранить** `ENCRYPTION_KEY` — оставить в `.env` или сразу заводить KMS/Vault?
