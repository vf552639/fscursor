> ⚠️ **Устарело.** Описывает server-side архитектуру до разворота на zero-knowledge.
> Целевая архитектура (desktop выполняет, web read-only, сервер «слепой») — в `plan.md`
> и `docs/AUDIT_2026-08-02.md`.

# ARCHITECTURE

## Docker Services
Current compose stack:

| Service | Host Port | Purpose |
|---|---:|---|
| `redis` | `6479` | Celery broker/backend |
| `backend` | `8100` | FastAPI API |
| `worker` | - | Celery worker (async tasks) |
| `beat` | - | Celery Beat (periodic scheduler) |
| `frontend` | `3100` | React + Vite |
| `nginx` | `8080` | Reverse proxy |

Notes:
- Local `db` service was removed from compose to avoid misleading `POSTGRES_*` interpolation warnings.
- Runtime DB is currently `SUPABASE_DB_URL` from `.env`.
- **Supabase pooler, asyncpg, Docker verification, health URL, and MCP vs app DB** are documented in [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md).
- Migration ownership is centralized in `backend` startup (`/app/entrypoint.sh` -> wait-for-db loop -> `alembic upgrade head`).
- `worker` and `beat` use `entrypoint: []` in compose to avoid parallel migration execution.

## Backend Architecture
- **App entry:** `backend/app/main.py`
- **Startup guard:** lifespan checks `alembic_version` equals expected head revision (`010_domain_extras`); transient DB connection errors are retried before failing (see `SUPABASE_DOCKER.md` § Startup resilience).
- **Routers:** `servers`, `domains`, `cloudflare`, `registrars`, `tasks`, `notifications`, `settings`, `ssl-emails`
- **DB layer:** SQLAlchemy async sessions + Alembic migrations
- **Background tasks:** Celery + Redis
  - On-demand tasks (e.g., NS/FastPanel-related)
  - Scheduled tasks (renewal checks via Beat + server metrics sweep every 5 minutes)
- **Provisioning flow:**
  1. `POST /api/domains/{id}/provision` creates/uses `task_logs` entry and enqueues Celery provisioning.
  2. Task runs SSH preflight (firewall ports), site/FTP creation, DNS pre-check, SSL issuance.
  3. Domain provisioning fields and `last_provision_error` are persisted for UI/operator export.
- **Domain operations flow (task33):**
  - Domain-level actions now expose dedicated APIs and Celery tasks:
    - create-site (`site_only` supported),
    - create-db + credential retrieval,
    - SSL request/cancel/refresh,
    - nginx override apply/read (presets + raw snippet),
    - NS check (`registrar.get_nameservers` when available, DNS fallback otherwise),
    - manual NS override state (`ns_check_mode` `auto|manual`).
  - A bulk orchestration endpoint (`POST /api/domains/bulk-full-setup`) runs per-domain chain semantics:
    1. assign server/cloudflare/registrar,
    2. create/link Cloudflare zone,
    3. apply nameservers via registrar task.
  - Task logs are created per domain for progress UI and SSE stream consumers.
- **Task streaming:**
  - `GET /api/tasks/{id}/stream` provides SSE updates with incremental `log_text` and task status.
- **Periodic SSL metadata refresh:**
  - Beat task `app.tasks.domain.refresh_ssl_all` runs daily at `03:00 UTC` and updates `ssl_status`, `ssl_expires_at`, `ssl_issuer` for domains bound to servers.
- **Bulk import flow:**
  - `POST /api/domains/bulk-import` supports `csv`/`xlsx` uploads, returns summary and errors CSV URL.
  - `POST /api/servers/bulk-import` supports `csv`/`xlsx` with columns `name,ip,ssh_user,ssh_password,ssh_port,notes` (optional header row); errors CSV via `GET /api/servers/bulk-import-errors/{token}`.
- **Outbound notifications (PR-3):**
  - On successful `create_notification`, the backend may call configured channels: webhook (`Webhook Enabled` + `Webhook URL` + optional `Webhook Secret` in `system_config`) and Telegram (env `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` when `Telegram Enabled` is true).
  - `POST /api/settings/notifications/test` sends a synthetic payload through the same channel logic and returns per-channel status strings for UI smoke tests.
- **Cloudflare DNS create idempotency:**
  - `create_dns_record` checks for an existing record with the same `type` + `name` and issues `PATCH` instead of `POST` when found.
- **Renewal flow:**
  1. Periodic task selects domains with `purchase_date <= today - 9 months`.
  2. For each domain, creates notification using `ON CONFLICT DO NOTHING` by `dedup_key`.
  3. Writes audit entry to `task_logs`.
- **Server uptime flow:**
  1. Worker task connects over SSH and reads `/etc/os-release`, `uname`, `top`, `free`, `df`, `/proc/net/dev`, and `/proc/uptime`.
  2. Backend persists telemetry fields (`cpu_*`, `ram_*`, `disk_*`, `net_*`, `os_pretty`, `kernel`, `fastpanel_version`, plus uptime/check metadata) on `servers`.
  3. Triggered automatically on server create (when SSH password is configured), manually via `POST /api/servers/{id}/refresh-metrics` (legacy `/refresh-uptime` kept as alias), and periodically by Beat.
- **FastPanel domains sync flow:**
  1. `POST /api/servers/{id}/sync-domains` opens SSH and resolves FastPanel sites via CLI (`--json`, table fallback) or filesystem fallback; remote list commands use **short timeouts** and **no PTY** to avoid interactive pager hangs.
  2. JSON rows are normalized: nested **`owner`** objects yield `site_user` / path from `home_dir`; string fields are trimmed and capped to DB column limits.
  3. **No row** for `domain_name` → insert `domains` with `status=active`.
  4. **Row exists** with `server_id` null or equal to this server → update link and site metadata (idempotent re-sync).
  5. **Row exists** with `server_id` pointing at **another** server → **abort** with `rollback()`, return `error` in JSON; do not mark the current server SSH check as failed.
  6. Sync can be triggered manually in ServerDetail and automatically after FastPanel install / pre-installed server creation.

## Frontend Architecture
- React + TypeScript + TanStack Query
- API hooks layer in `frontend/src/api/*`
- Page modules in `frontend/src/pages/*`
- Servers UX uses API-driven telemetry/status rendering (no hardcoded CPU/RAM/SSD/uptime placeholders).
- **ServerDetail** domains table reads `GET /api/domains?server_id=` as a **JSON array** (same contract as the Domains page); **Sync Domains** success and error banners cover mutation `data` and `isError`.
- **Domains UI** now includes:
  - `DomainDetailModal` (Overview / DB / SSL / Nginx / NS),
  - expanded bulk actions (`Refresh SSL`, `Check NS`, `Mark NS Set`, `Full Setup`),
  - `BulkSetupWizard` and multi-task progress viewer for full setup runs.
- Notifications UX:
  - Dedicated `Notifications` page
  - Read/unread actions
  - Unread badge on topbar bell with polling
  - Row click navigation to filtered Domains view (`domainId` context)
- Navigation flow:
  - `ServerDetail -> Domains` with `serverId` context
  - `Dashboard -> Domains` from "Total Domains" stat card
- Settings:
  - Registrars edit/delete is active
  - System config now uses `/settings/config` API
  - SSL email pool management UI (`/api/ssl-emails`) under the **SSL Pool** tab; System tab includes quick toggles for webhook/Telegram/auto temp-mail and a **Test delivery** action

## Desktop (Tauri) — scaffolding
- **Location:** `desktop/` (npm shell + `desktop/src-tauri/` Rust project).
- **UI loading:** `tauri.conf.json` runs `npm run dev` from repo-root **`frontend/`** in dev and points `frontendDist` at **`../../frontend/dist`** for release builds.
- **Capabilities:** `desktop/src-tauri/capabilities/default.json` grants `core:default` and `shell:default` for the window labeled `main`.
- **Distribution:** unsigned install flows (Gatekeeper / SmartScreen) are documented in [`INSTALL.md`](INSTALL.md).
- **Developer isolation:** optional `git worktree` checkouts can live under `.worktrees/` (ignored by git); symlink or copy root `.env` into the worktree when running backend tests against a real DB.

## Security Notes
- Sensitive values are encrypted at rest (based on configured encryption key).
- Docker build contexts are constrained with service-level `.dockerignore` files to reduce accidental inclusion of `.env*`, caches, and runtime state files.
- This deployment profile is internal/development-oriented; public exposure still requires full auth hardening and production controls.
