> ⚠️ **Устарело.** Документ описывает раннюю server-side модель. Проект развёрнут на
> **zero-knowledge** архитектуру (секреты шифруются на клиенте, сервер хранит только блобы;
> выполнение — в desktop). Актуально: `CLAUDE.md`, `docs/AUDIT_2026-08-02.md`
> (спека `plan.md` удалена как исполненная — история git).

# PROJECT OVERVIEW

**Project Name:** SDMP (Server & Domain Management Panel)

## Purpose
SDMP is an internal panel for centralized management of servers and domains with background automation (Celery), DNS/registrar integrations, and operational visibility in one UI.

## Implemented Scope (Current)
1. **Servers**
   - CRUD for servers
   - FastPanel connection/install lifecycle
   - SSH-related setup flow and status tracking
   - Persisted server telemetry checks over SSH (CPU/RAM/disk/network/uptime/OS/kernel/FastPanel version) with manual refresh and periodic scheduling. **Superseded 2026-08-06:** the backend no longer runs SSH at all. Metrics are collected by the desktop and posted to `POST /api/servers/{id}/metrics`, while availability is a separate credential-free TCP probe run by Beat every 6 hours — two independent signals, see `docs/ARCHITECTURE.md` § Server signals
   - Server status lifecycle (`new` / `provisioned` / `active` / `error`) driven by health checks
   - File-based bulk import (`csv`/`xlsx`): `POST /api/servers/bulk-import`, row-level errors via `GET /api/servers/bulk-import-errors/{token}`; UI entry on the Servers page (`⇪ Import`)
2. **Domains**
   - CRUD, bulk import (text + structured CSV-like)
   - Bulk actions (assign server, assign Cloudflare, set NS, delete)
   - New `purchase_date` support for renewal lifecycle
   - FastPanel provisioning flow (site + FTP + SSL) via Celery task
   - Provisioning metadata persisted on domain (`site_user`, `ftp_user`, `ssl_status`, `last_provision_error`)
   - Optional SSL pool auto-seed: if the pool is empty and `Auto Temp Mail Enabled` is true in `system_config` with `RAPIDAPI_KEY` set, provisioning may fetch a temporary mailbox (RapidAPI) and add it to `ssl_email_pool` before issuing LE certs
   - File-based bulk import (`csv`/`xlsx`) with row-level error export CSV
   - FastPanel-to-SDMP sync: `POST /api/servers/{id}/sync-domains` links or creates domain rows from detected FastPanel sites; **conflict-safe** (does not re-point a domain already owned by another server); list discovery uses timeouts and no-PTY SSH; nested JSON **`owner`** maps to `site_user` / path
   - Domain operational endpoints:
     - `POST /api/domains/{id}/create-site` (`site_only` option),
     - `POST /api/domains/{id}/create-db`,
     - `GET /api/domains/{id}/db-credentials`,
     - `POST /api/domains/{id}/ssl-request`,
     - `POST /api/domains/{id}/ssl-cancel`,
     - `POST /api/domains/{id}/refresh-ssl`,
     - `GET/POST /api/domains/{id}/nginx-override`,
     - `POST /api/domains/bulk-full-setup`.
     - `mark-ns-set` и `check-ns` здесь были перечислены ошибочно: таких роутов
       в `api/routes/domains.py` нет и не было. Кнопки, которые их звали, удалены
       (спринт 3, фаза 5); смену NS выполняет десктоп командой
       `registrar_set_nameservers`.
   - Added DB/SSL/Nginx metadata fields on `domains`: `db_name`, `db_user`, `ssl_expires_at`, `ssl_issuer`, `ns_check_mode`, `nginx_override`, `nginx_presets`.
3. **Notifications**
   - Dedicated notifications entity and API
   - Domain renewal reminder generation at `purchase_date + 9 months`
   - Deduplication by `(domain_id, purchase_date)` via `dedup_key`
   - Read/unread and delete flows in UI
   - Optional outbound channels when a notification is created: **webhook** (URL + optional HMAC secret from `system_config`) and **Telegram** (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` from env when `Telegram Enabled` is true in `system_config`)
4. **Cloudflare / Registrars**
   - Account and zone-level integration primitives
   - DNS and nameserver-related operations (DNS record create path upserts by `type` + `name` when a matching record already exists)
   - Edit/delete flows connected in UI tables
5. **Task Processing**
   - Celery worker for async jobs
   - Celery Beat for periodic jobs. **Today (`app/core/celery_app.py`) exactly two:** daily renewal check at `09:00 UTC` and `check-server-reachability-6h` every 6 hours. The 5-minute server metrics sweep and the `03:00 UTC` SSL metadata refresh no longer exist
   - Task audit logs in database
   - Task live log streaming endpoint (SSE) for progress UI
6. **Navigation & Settings**
   - Cross-page navigation context (`serverId`, `domainId`) between dashboard/details and domains
   - Settings config API (`/settings/config`) with editable system values in UI
   - Settings UI: **SSL Pool** tab (CRUD for `/api/ssl-emails`, usage progress), notification channel toggles (`Webhook` / `Telegram` / `Auto Temp Mail`), and `POST /api/settings/notifications/test` for smoke-testing delivery without creating a DB notification row

## Desktop (scaffolding)
- **Tauri 2** desktop app under `desktop/` loads the existing **`frontend/`** React/Vite UI in a native window (dev server on port `1420` by default; API still expected at `http://localhost:8100` per CSP).
- Rust crate layout includes placeholder modules for future local crypto, sync, SSH, registrars, and provisioning logic (see `desktop/src-tauri/src/`).
- End-user install notes for unsigned `.dmg` / `.exe` / AppImage builds: [`INSTALL.md`](INSTALL.md).

## Runtime Profile
- Compose runtime currently uses `redis`, `backend`, `worker`, `beat`, `frontend`, `nginx`.
- Local postgres compose service was intentionally removed; backend DB connection is driven by `SUPABASE_DB_URL`.
- Backend DSN is expected in async form (`postgresql+asyncpg://...`) to match SQLAlchemy async engine setup.
- Backend container startup applies migrations automatically via `backend/entrypoint.sh`: optional `alembic_version` column widen, **wait-for-db** (asyncpg ping, ~60 s max), then `alembic upgrade head` before app start.
- API startup validates `alembic_version` against `EXPECTED_ALEMBIC_HEAD` in `main.py` (must match the latest Alembic head, currently `016_server_consecutive_failures`); **transient** DB read failures are retried in lifespan before failing (revision mismatch still fails immediately).
- `worker` and `beat` containers run with overridden empty entrypoint so migrations are executed only by `backend`.
- Runtime requires env contract parity with backend settings (`SUPABASE_*`, Redis/Celery URLs, encryption/secret keys, CORS/API prefix). Optional keys used by newer features: `RAPIDAPI_KEY` (temp-mail API), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, plus tunables such as `LOG_LEVEL`, `SSH_CONNECT_TIMEOUT`, `DNS_PRECHECK_*`, `DEFAULT_PHP_VERSION` (all optional with defaults in `Settings`).
- Operational details for Supabase URLs, pooler ports, Docker checks, and MCP vs app connectivity: [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md).
- Backend/frontend Docker contexts now use local `.dockerignore` files to exclude secrets and dev/runtime artifacts from image layers.

## UX Reliability
- Resource pages now distinguish three list states:
  - loading,
  - backend/schema error (with diagnostic hint),
  - valid empty dataset.
- This is applied on Domains, Servers, Cloudflare accounts, and Settings (Registrars, SSL Pool, System).

## Key Entities
- `servers`, `server_secrets`, `task_logs`
- `domains` (including `purchase_date`, provisioning/SSL fields)
- `notifications`
- `ssl_email_pool`
- `cloudflare_accounts`
- `registrar_accounts`
- `activity_logs`
