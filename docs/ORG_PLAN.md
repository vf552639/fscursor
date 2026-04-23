# SDMP — План организации проекта и подготовки к проду

**Дата:** 2026-04-23
**Контекст:** single-tenant, роли, JWT (email+пароль), VPS + Docker Compose, БД — Supabase.

Цель документа: превратить текущую рабочую локальную сборку в чистый, расширяемый проект, в котором (а) можно безопасно добавить пользователей и авторизацию, (б) перенос на VPS сводится к `docker compose -f docker-compose.prod.yml up -d` без сюрпризов.

---

## 0. Что уже есть (факт)

Хорошая база, не переписываем с нуля:

- Backend: FastAPI + SQLAlchemy async + Alembic, Celery + Beat, Redis.
- Frontend: React 18 + Vite + TS + TanStack Query + Zustand.
- Docker Compose (dev): `redis`, `backend`, `worker`, `beat`, `frontend`, `nginx`.
- Alembic через `entrypoint.sh` (`alembic upgrade head` до старта API) и startup-guard в `main.py`.
- Шифрование секретов в БД (`encryption_service`, `ENCRYPTION_KEY`).
- Домены с модулем renewal-уведомлений.
- Docs: `PROJECT_OVERVIEW`, `ARCHITECTURE`, `TECH_STACK`, `CURRENT_STATUS`, `Roadmap`, `Bugs`, `SUPABASE_DOCKER` (pooler runbook + startup retries as of 2026-04-23).

Слабые места под рефактор:

1. Нет аутентификации/авторизации — API открыт.
2. `config.py` требует обязательных переменных (`SUPABASE_URL`, `SUPABASE_KEY`, и т.п.); `.env.example` в репозитории приведён к контракту `Settings` (в т.ч. pooler + закомментированный direct fallback) — при добавлении полей в `Settings` по-прежнему нужно синхронизировать шаблон.
3. Один `.env` на корень и на frontend — легко смешать dev/prod.
4. Нет prod-варианта compose (сейчас `--reload`, bind-mount исходников, `npm run dev`).
5. Nginx в dev проксирует на Vite; для прода нужен статический build + TLS.
6. Нет CI, тестов, линтеров на автомате.
7. Nginx слушает только `:80` — нет HTTPS, нет rate-limit, нет заголовков безопасности.
8. `celerybeat-schedule` лежит в репозитории — должен быть в volume.

---

## 1. Целевая структура репозитория

Суть: разделить окружения (dev/prod), вынести общее, добавить слой `auth`.

```
FS_cursor/
├── .env.example               ← единый шаблон, все ключи
├── .gitignore
├── README.md                  ← как поднять локально + ссылка на DEPLOY.md
├── Makefile                   ← короткие команды: make up/down/migrate/test/lint
├── docker-compose.yml         ← ТОЛЬКО dev (с --reload, bind-mount, Vite dev-server)
├── docker-compose.prod.yml    ← prod (без reload, собранный фронт, Let's Encrypt)
├── docker-compose.override.yml.example  ← персональные оверрайды dev
├── alembic.ini                ← оставляем как есть (обёртка над backend/alembic)
│
├── backend/
│   ├── Dockerfile             ← multi-stage: builder + runtime
│   ├── entrypoint.sh
│   ├── requirements.txt       ← runtime deps
│   ├── requirements-dev.txt   ← pytest, ruff, mypy, httpx test, factory-boy
│   ├── pyproject.toml         ← ruff/mypy/pytest конфиг, опционально hatch-build
│   ├── alembic/
│   │   ├── env.py
│   │   └── versions/
│   │       ├── 001_initial.py
│   │       ├── 002_domain_purchase_and_notifications.py
│   │       └── 003_users_and_auth.py      ← НОВАЯ миграция (см. §3)
│   ├── app/
│   │   ├── main.py
│   │   ├── core/              ← конфиг, БД, celery, security
│   │   │   ├── config.py
│   │   │   ├── database.py
│   │   │   ├── celery_app.py
│   │   │   ├── security.py       ← НОВОЕ: bcrypt, JWT encode/decode
│   │   │   └── logging.py        ← НОВОЕ: единый structlog/loguru setup
│   │   ├── api/
│   │   │   ├── deps.py           ← НОВОЕ: get_current_user, require_role
│   │   │   └── routes/
│   │   │       ├── auth.py       ← НОВОЕ: /auth/login, /auth/me, /auth/refresh
│   │   │       ├── users.py      ← НОВОЕ: CRUD юзеров (admin only)
│   │   │       ├── servers.py
│   │   │       ├── domains.py
│   │   │       ├── cloudflare.py
│   │   │       ├── registrars.py
│   │   │       ├── notifications.py
│   │   │       ├── settings.py
│   │   │       └── tasks.py
│   │   ├── models/
│   │   │   ├── base.py
│   │   │   ├── user.py           ← НОВОЕ
│   │   │   ├── refresh_token.py  ← НОВОЕ (опц.), или храним в Redis
│   │   │   ├── server.py
│   │   │   ├── domain.py
│   │   │   └── ...
│   │   ├── schemas/
│   │   │   ├── auth.py           ← LoginIn, TokenOut, UserOut
│   │   │   ├── user.py
│   │   │   └── ...
│   │   ├── services/
│   │   │   ├── auth_service.py   ← НОВОЕ
│   │   │   ├── user_service.py   ← НОВОЕ
│   │   │   └── ...
│   │   ├── tasks/
│   │   └── utils/                ← общие хелперы (pagination, datetime)
│   └── tests/
│       ├── conftest.py
│       ├── test_auth.py
│       ├── test_domains.py
│       └── ...
│
├── frontend/
│   ├── Dockerfile             ← multi-stage: node builder + nginx static serve
│   ├── Dockerfile.dev         ← для dev-compose (Vite + HMR)
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── src/
│       ├── api/
│       │   ├── client.ts         ← axios instance + interceptor для access token
│       │   └── ...
│       ├── auth/                 ← НОВОЕ
│       │   ├── AuthContext.tsx
│       │   ├── useAuth.ts
│       │   ├── ProtectedRoute.tsx
│       │   └── tokenStorage.ts
│       ├── pages/
│       │   ├── LoginPage.tsx     ← НОВОЕ
│       │   └── ...
│       ├── store/
│       ├── components/
│       └── App.tsx
│
├── nginx/
│   ├── nginx.dev.conf         ← текущий (проксирует на Vite :5173)
│   └── nginx.prod.conf        ← отдаёт статику + /api → backend, TLS, security headers
│
├── deploy/                    ← всё, что относится к серверу
│   ├── DEPLOY.md              ← пошаговый runbook
│   ├── systemd/
│   │   └── sdmp.service       ← опционально, если compose под systemd
│   ├── letsencrypt/
│   │   └── init-letsencrypt.sh
│   └── backup/
│       └── backup.sh          ← дамп Supabase на S3/локально
│
├── docs/                       ← оставляем как есть, дополняем
│   ├── PROJECT_OVERVIEW.md
│   ├── ARCHITECTURE.md
│   ├── TECH_STACK.md
│   ├── CURRENT_STATUS.md
│   ├── Roadmap.md
│   ├── Bugs.md
│   ├── ORG_PLAN.md            ← этот файл
│   ├── AUTH.md                ← как устроена аутентификация (§3)
│   └── DEPLOY.md              ← prod runbook
│
└── .github/
    └── workflows/
        ├── backend.yml        ← ruff + mypy + pytest
        └── frontend.yml       ← tsc + eslint + vite build
```

---

## 2. Конфигурация и окружения

Главная боль любого проекта — «у меня локально работает». Разведём окружения явно.

### 2.1. Единый `.env.example`

Один файл в корне, покрывает все сервисы (backend, frontend, worker, nginx).
Имена переменных — консистентные. Сейчас в `config.py` требуется `SUPABASE_DB_URL`/`SUPABASE_URL`/`SUPABASE_KEY`, а `.env.example` показывает `DATABASE_URL`. Надо привести к одному стандарту.

Предлагаемый минимальный шаблон (ключи, которые реально читает код):

```
# --- DB (Supabase) ---
SUPABASE_DB_URL=postgresql+asyncpg://postgres:password@db.xxxxx.supabase.co:5432/postgres
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_KEY=<service-role-key>

# --- Redis / Celery ---
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/2

# --- Security ---
ENCRYPTION_KEY=<32-байт base64 fernet key>     # для секретов в БД
SECRET_KEY=<≥64 байта, раздельно с ENCRYPTION_KEY>   # для JWT
JWT_ALG=HS256
JWT_ACCESS_TTL_MIN=30
JWT_REFRESH_TTL_DAYS=14

# --- API ---
API_V1_PREFIX=/api
BACKEND_CORS_ORIGINS=http://localhost:3100,http://localhost:8080,https://sdmp.example.com

# --- Frontend (Vite) ---
VITE_API_URL=/api           # prod: относительный, через nginx
# dev-only:
# VITE_API_URL=http://localhost:8100/api

# --- Admin bootstrap (используется ТОЛЬКО при первом запуске) ---
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=<сгенерировать>
```

Правила:

- `.env` — git-ignored (уже так).
- `.env.example` — всегда соответствует тому, что реально читает `config.py`. Любое добавление поля в `Settings` → обновление `.env.example` тем же PR.
- `config.py` падает со внятной ошибкой, если переменная обязательная и отсутствует (pydantic-settings так и делает по умолчанию — просто не давать `Optional`).

### 2.2. Два compose файла

**`docker-compose.yml`** — только dev:
- `backend: command: uvicorn --reload`, bind-mount `./backend:/app`.
- `frontend: command: npm run dev`, bind-mount `./frontend:/app`.
- `celerybeat-schedule` — в именованном volume, **не** в репозитории.
- nginx слушает `:8080`, проксирует на Vite для HMR.

**`docker-compose.prod.yml`** — prod:
- `backend: command: uvicorn --workers 4` (или gunicorn + uvicorn workers), без `--reload`, без bind-mount.
- `frontend`: собранный статический билд внутри nginx-образа. Отдельный контейнер `frontend` в проде не нужен.
- `nginx` слушает `:80` и `:443`, Let's Encrypt через `certbot` sidecar или `nginx-proxy + acme-companion`.
- Ресурсные лимиты (`deploy.resources.limits`).
- `restart: unless-stopped` везде.
- `celerybeat-schedule` — в volume.

Переезд между ними — одна команда:
```
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

### 2.3. `Makefile`

Даёт одинаковый интерфейс локально и в CI:

```
make up           # dev compose up
make down
make logs
make migrate      # alembic upgrade head внутри backend
make revision m="add users"
make test         # pytest внутри backend
make lint         # ruff + mypy
make fe-build
make shell-be     # docker compose exec backend bash
make prod-up      # compose prod up -d
```

---

## 3. Аутентификация и пользователи

**Выбор**: свой JWT, одна организация, роли. Просто и контролируемо.

### 3.1. Модель данных

Миграция `003_users_and_auth.py`:

```sql
CREATE TABLE users (
    id              BIGSERIAL PRIMARY KEY,
    email           CITEXT UNIQUE NOT NULL,       -- case-insensitive уникальность
    password_hash   VARCHAR(255) NOT NULL,        -- bcrypt
    full_name       VARCHAR(255),
    role            VARCHAR(32) NOT NULL DEFAULT 'viewer',  -- admin | operator | viewer
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- опц.: refresh-токены (либо хранить в Redis)
CREATE TABLE refresh_tokens (
    jti         UUID PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    user_agent  VARCHAR(255),
    ip          INET
);

-- аудит (уже частично есть в activity_logs; ДОБАВИТЬ user_id)
ALTER TABLE activity_logs ADD COLUMN user_id BIGINT REFERENCES users(id);
```

**Роли и права** (простая матрица, без RBAC-таблиц):

| Действие                         | admin | operator | viewer |
|----------------------------------|:-----:|:--------:|:------:|
| Видеть серверы/домены            |   ✓   |    ✓     |   ✓    |
| Создавать/менять домены/серверы  |   ✓   |    ✓     |   ✗    |
| Запускать задачи (renewal, NS)   |   ✓   |    ✓     |   ✗    |
| Управлять пользователями         |   ✓   |    ✗     |   ✗    |
| Менять Settings/config           |   ✓   |    ✗     |   ✗    |

Хранить как enum в Python + `VARCHAR(32)` в БД (не ставлю `ENUM TYPE`, чтобы не усложнять миграции).

### 3.2. Backend: эндпоинты и зависимости

**`app/core/security.py`**
- `hash_password(raw) -> str` (bcrypt через `passlib[bcrypt]`).
- `verify_password(raw, hash) -> bool`.
- `create_access_token(sub, role, ttl)`, `create_refresh_token(...)`.
- `decode_token(token)` с проверкой подписи/exp.

**`app/api/deps.py`**
```python
async def get_current_user(token: str = Depends(oauth2_scheme),
                          db: AsyncSession = Depends(get_db)) -> User: ...

def require_role(*allowed: Role):
    def dep(user: User = Depends(get_current_user)):
        if user.role not in allowed:
            raise HTTPException(403, "Forbidden")
        return user
    return dep
```

**`app/api/routes/auth.py`**
- `POST /auth/login` → `{ access, refresh }`
- `POST /auth/refresh` → новый access
- `POST /auth/logout` → отозвать refresh (удалить из Redis/refresh_tokens)
- `GET  /auth/me` → текущий пользователь

**`app/api/routes/users.py`** (admin only)
- `GET /users`, `POST /users`, `PATCH /users/{id}`, `DELETE /users/{id}`, `POST /users/{id}/reset-password`.

**Защита существующих роутов**
- В `api_router.include_router(...)` добавить `dependencies=[Depends(get_current_user)]` глобально, кроме `/auth/login` и `/health`.
- Мутации оборачивать `Depends(require_role(Role.admin, Role.operator))`.

**Bootstrap первого админа**
- В `entrypoint.sh` после `alembic upgrade head` вызвать маленький скрипт `python -m app.cli.ensure_admin`, который:
  - читает `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` из env,
  - если юзеров нет — создаёт одного с ролью `admin`,
  - если уже есть — ничего не делает.

### 3.3. Frontend

- `auth/AuthContext.tsx`: хранит access-токен **в памяти**, refresh — в `httpOnly` cookie (если серверы на одном домене) либо в `localStorage` (проще для начала, но менее безопасно; ок для internal tool за VPN/basic-auth-шлюзом).
- `api/client.ts`: axios interceptor — добавляет `Authorization: Bearer`, на `401` пытается `/auth/refresh` и повторяет.
- `ProtectedRoute`: если нет юзера — редирект на `/login`.
- Навигация/кнопки скрываются по роли (`useAuth().user.role`).
- Страница `LoginPage` + страница `Users` (admin only) в Settings.

### 3.4. Документация

Новый `docs/AUTH.md`: какие токены, TTL, как их отзывать, как расшифровать ошибки 401/403, как завести пользователя.

---

## 4. Разделение dev ↔ prod в деталях

### 4.1. Backend

- `backend/Dockerfile` → multi-stage:
  - stage `builder`: ставит build-deps, компилирует wheels.
  - stage `runtime`: `python:3.12-slim`, копирует только wheels + исходники, запускает `uvicorn` без `--reload`.
- В dev-compose переопределяем `command` на `uvicorn --reload` + bind-mount.
- Prod `command: gunicorn app.main:app -k uvicorn.workers.UvicornWorker -w 4 -b 0.0.0.0:8000 --access-logfile -`.

### 4.2. Frontend

- `frontend/Dockerfile` (prod, multi-stage):
  ```
  FROM node:20-alpine AS build
  WORKDIR /app
  COPY package*.json ./
  RUN npm ci
  COPY . .
  RUN npm run build

  FROM nginx:alpine
  COPY --from=build /app/dist /usr/share/nginx/html
  COPY nginx/nginx.prod.conf /etc/nginx/nginx.conf
  ```
- `frontend/Dockerfile.dev` — минимальный, просто node, для dev-compose c HMR.
- В проде контейнер `frontend` и `nginx` объединяются в один образ.

### 4.3. Nginx prod

`nginx/nginx.prod.conf` — ключевые вещи:

- `listen 443 ssl http2;` + редирект `80 → 443`.
- Сертификаты через Let's Encrypt (`certbot` раз в сутки в отдельном контейнере, либо `acme.sh`).
- Заголовки: `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy` (подобрать под Vite-билд).
- `gzip on;` / `brotli` для `.js`/`.css`/`.html`.
- `location /api/` → `proxy_pass http://backend:8000/api/;` с корректными таймаутами (`proxy_read_timeout 60s`).
- `location /` → отдача статики из `/usr/share/nginx/html`, `try_files $uri /index.html;` (SPA fallback).
- Rate limit на `/api/auth/login`: `limit_req_zone ... zone=login:10m rate=5r/m;`.

### 4.4. Что **не** деплоится в прод

- `backend/celerybeat-schedule` → в volume `beat_schedule:/app/celerybeat-schedule`.
- `.venv/`, `node_modules/` — в `.dockerignore`.
- Исходники не должны монтироваться (никакого `volumes: - ./backend:/app` в prod-compose).

---

## 5. Миграция на VPS: runbook

Фиксируется в `deploy/DEPLOY.md`. Высокоуровневые шаги:

1. **Сервер**: Ubuntu 22.04/24.04 LTS, 2 vCPU / 4 GB RAM для начала.
2. **Базовая подготовка**:
   - `ufw`: разрешить `22, 80, 443`.
   - `fail2ban` для ssh.
   - создать non-root пользователя, ssh-ключ, `PasswordAuthentication no`.
   - поставить Docker + Docker Compose plugin.
3. **Доменное имя + DNS**: A-запись `sdmp.example.com → IP`. Подождать пропагейта.
4. **Склонировать репозиторий** в `/opt/sdmp`.
5. **`.env`**: скопировать с локальной машины, поменять:
   - `SUPABASE_DB_URL` → prod-проект Supabase (или prod-схема);
   - `BACKEND_CORS_ORIGINS=https://sdmp.example.com`;
   - `VITE_API_URL=/api`;
   - новые `SECRET_KEY`, `ENCRYPTION_KEY` (ротация ключей — отдельная процедура, см. §7).
6. **Сертификат**: прогнать `deploy/letsencrypt/init-letsencrypt.sh` (один раз).
7. **Запуск**:
   ```
   docker compose -f docker-compose.prod.yml --env-file .env pull
   docker compose -f docker-compose.prod.yml --env-file .env up -d --build
   docker compose -f docker-compose.prod.yml logs -f backend
   ```
8. **Проверить**: `https://sdmp.example.com/api/health` → `{"status":"ok"}`.
9. **Создать админа**: должен создаться автоматом из `INITIAL_ADMIN_*` на первом старте. Залогиниться, поменять пароль, очистить `INITIAL_ADMIN_PASSWORD` из `.env`.
10. **Cron/backup** (§6).

---

## 6. Эксплуатация: бэкапы, логи, мониторинг

### 6.1. Бэкапы

Supabase делает ежедневные снапшоты, но полагаться на это одно — плохо.
- `deploy/backup/backup.sh`: `pg_dump` в сжатый файл, выгрузка на S3-совместимое хранилище (Backblaze B2, Cloudflare R2) по `restic`/`rclone`.
- Cron в хосте (не в контейнере): `0 3 * * * /opt/sdmp/deploy/backup/backup.sh`.
- Retention: 7 daily + 4 weekly + 3 monthly.
- Рядом — ротация ключей шифрования: записать в `docs/AUTH.md` процедуру ротации `ENCRYPTION_KEY` (re-encrypt при смене).

### 6.2. Логи

- `backend`/`worker`/`beat` пишут в stdout → собирается `docker compose logs`.
- Для прода подключить `logrotate` на докер-логи (`/etc/docker/daemon.json`, `max-size`, `max-file`).
- Structured logs (`structlog`) — улучшение второго приоритета.

### 6.3. Мониторинг (минимум)

- `/health` эндпоинт (уже есть) + отдельный `/health/db`.
- `uptime-kuma` или простой внешний пинг (healthchecks.io).
- Alertmanager/Grafana — на потом.

---

## 7. Безопасность — чеклист перед публикацией

- Авторизация на всех роутах, кроме `/auth/login`, `/health`.
- `SECRET_KEY`, `ENCRYPTION_KEY` — **разные**, сгенерированы `python -c 'import secrets;print(secrets.token_urlsafe(64))'`.
- Пароли: bcrypt cost ≥ 12.
- Rate-limit на `/auth/login` (на уровне nginx и/или middleware slowapi).
- CORS — только прод-домен, не `*`.
- Заголовки безопасности (nginx, §4.3).
- Выключить FastAPI docs (`/docs`, `/redoc`) в проде либо закрыть базовой auth.
- Все секреты — только в `.env` на сервере (600 права), никогда в репо.
- Supabase: включить Row Level Security на уровне проекта даже если сейчас ходим service-role ключом (на случай утечки anon-ключа).
- SSH в сервер — только по ключу, fail2ban.

---

## 8. Качество кода и CI

### 8.1. Backend

- `pyproject.toml`:
  - `ruff` (линт + format) — заменяет black/isort/flake8.
  - `mypy` — строго для `app/core` и `app/services`, мягко для остального.
  - `pytest` + `pytest-asyncio` + `httpx`-клиент.
- `requirements-dev.txt`: `pytest`, `pytest-asyncio`, `httpx`, `ruff`, `mypy`, `types-*`, `factory-boy`.
- Тесты на auth (login/refresh/expired), на права (viewer не может POST), на renewal-таск (он важный).

### 8.2. Frontend

- `eslint` + `prettier` (базовые конфиги).
- `npm run typecheck` (`tsc --noEmit`) — отдельным скриптом.
- `npm run build` в CI — чтобы не пускать коммит, который ломает прод-билд.

### 8.3. GitHub Actions

Два workflow:

`.github/workflows/backend.yml`:
- Poetry/pip install.
- `ruff check .`
- `mypy app`
- `pytest`

`.github/workflows/frontend.yml`:
- `npm ci`
- `npm run typecheck`
- `npm run build`

Этого достаточно для начала; деплой через `docker compose pull && up -d` на сервере можно пускать вручную или через SSH-action после merge в `main`.

---

## 9. Фазы внедрения (последовательность)

Порядок выбран так, чтобы **каждая фаза оставляла проект рабочим** (ничего не ломается на долгие периоды).

### Фаза A — гигиена (0.5–1 день)

- Привести `.env.example` к реальному набору переменных из `config.py`.
- Убрать `celerybeat-schedule` из репо, добавить в `.gitignore`, сделать volume.
- Добавить `Makefile` с базовыми командами.
- Добавить `requirements-dev.txt`, `pyproject.toml` (ruff + mypy + pytest).
- Прогнать `ruff format` по backend один раз.

### Фаза B — auth-фундамент (1–2 дня)

- Миграция `003_users_and_auth.py`.
- `app/core/security.py`, `app/api/deps.py`.
- `routes/auth.py`, `routes/users.py`, `services/auth_service.py`, `services/user_service.py`.
- `entrypoint.sh`: bootstrap админа из env.
- Тесты: login happy path, wrong password, expired token, role guard.
- **Роуты пока НЕ закрываем** — auth работает, но старые эндпоинты ещё открыты.

### Фаза C — фронтовый auth (1 день)

- `LoginPage`, `AuthContext`, `ProtectedRoute`, axios-interceptor.
- Все существующие страницы оборачиваются `ProtectedRoute`.
- Скрытие action-кнопок для `viewer`.

### Фаза D — закрытие API (0.5 дня)

- В `api_router.include_router(...)` добавить `dependencies=[Depends(get_current_user)]`.
- На мутирующих эндпоинтах — `require_role(admin, operator)`.
- Админские (users, settings) — `require_role(admin)`.
- Повторный прогон e2e: всё ли работает из UI под обычным юзером.

### Фаза E — prod-compose (1 день)

- `docker-compose.prod.yml`.
- Multi-stage `backend/Dockerfile` и `frontend/Dockerfile` (prod).
- `nginx/nginx.prod.conf` + Let's Encrypt скрипт.
- Проверка локально: `docker compose -f docker-compose.prod.yml up --build` на тестовом домене (или на `127.0.0.1` с самоподписанным сертом).

### Фаза F — деплой на VPS (0.5–1 день)

- Подготовка сервера, `DEPLOY.md`.
- Первый деплой, проверка, настройка бэкапов.

### Фаза G — CI и полировка (0.5 дня)

- GitHub Actions (backend + frontend).
- `docs/AUTH.md`, `docs/DEPLOY.md` финализировать.
- Обновить `CURRENT_STATUS.md` и `Roadmap.md`: закрыть Phase 7.

Суммарно — **≈5–7 рабочих дней** при нормальном темпе.

---

## 10. Что отложить (осознанно)

Не делаем сейчас, чтобы не распыляться:

- Multi-tenancy (workspaces) — если появится, добавим `organization_id` в таблицы позже.
- OAuth/SSO — легко прикручивается поверх существующего JWT-слоя.
- RBAC с пермишенами в БД — пока хватает 3 ролей.
- Sentry, Grafana, Prometheus — добавить, когда появятся реальные инциденты.
- Kubernetes — не нужен для одного VPS.

---

## 11. Открытые вопросы, на которые стоит ответить до Фазы B

1. Будут ли пользователи разных ролей делить один набор Supabase-ключей и ключей регистраторов, или каждый юзер привязывает свои? (Сейчас ключи в `settings`/`registrar_accounts` — значит, общие. Если общие — ок, оставляем.)
2. Нужен ли лог действий пользователей (кто сменил NS, кто удалил сервер)? Если да — в `activity_logs` надо гарантированно писать `user_id` на всех мутациях (сделать это в фазе D).
3. Политика паролей: длина, обязательная смена, 2FA в будущем? Для internal tool минимум 10 символов + bcrypt достаточно.
4. Как ротируется `ENCRYPTION_KEY` при компрометации? (Отдельный скрипт re-encrypt, пишем в `docs/AUTH.md` как план, не реализуем сразу.)

---

## TL;DR

1. Развести dev и prod compose; единый `.env.example`, Makefile.
2. Добавить `users` + `auth` (JWT, bcrypt, роли admin/operator/viewer), bootstrap админа из env.
3. Закрыть все API-роуты auth-зависимостью, добавить `LoginPage` и axios-interceptor на фронте.
4. Собрать прод-образы (multi-stage), nginx со статикой + TLS, деплой на VPS одной командой.
5. Бэкапы, CI, документация. Всё остальное (мультитенантность, SSO, k8s) — осознанно на потом.
