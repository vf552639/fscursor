# TECH STACK

## Backend
- Python 3.12
- FastAPI + Uvicorn
- SQLAlchemy Async + asyncpg (Supabase **transaction pooler** when using `*.pooler.supabase.com:6543`; `NullPool` + tuned `connect_args` — see `docs/SUPABASE_DOCKER.md`)
- Alembic (migration-driven schema updates)
- Celery 5 + Redis (worker + beat)
- Paramiko (SSH automation)
- dnspython (`NS` resolver fallback in nameserver verification flow)
- FastPanel CLI over SSH for site lifecycle and discovery/sync (JSON/table/fs discovery; timeouts; nested `owner` normalization — see `docs/ARCHITECTURE.md` § FastPanel domains sync)
- `python-dateutil` (renewal threshold calculation)
- `cryptography` (encrypted secrets at rest)
- **Staged for auth / email (Stage 1+):** `argon2-cffi`, `bcrypt`, `itsdangerous`, `slowapi`, `pyotp`, `email-validator`, `resend` (see `backend/requirements.txt`)

## Frontend
- React 18 + TypeScript
- Vite
- TanStack Query (`@tanstack/react-query`)
- Axios-based API client/hooks

## Desktop (Tauri)
- **Tauri 2** + **Rust** (edition 2021, MSRV 1.80+ in `desktop/src-tauri/Cargo.toml`)
- Embeds the same React UI via dev URL / built `frontend/dist` (see `desktop/src-tauri/tauri.conf.json`)
- `@tauri-apps/cli` (devDependency in `desktop/package.json`) for `npm run tauri dev` / `build`
- Distribution UX for unsigned installers: [`INSTALL.md`](INSTALL.md)

## Infrastructure
- Docker Compose (dev): `redis`, `backend`, `worker`, `beat`, `frontend`, `nginx` — **no** bundled Postgres service; DB is **Supabase** (or any Postgres reachable via `SUPABASE_DB_URL`)
- Redis 7 (Compose)
- Nginx reverse proxy (dev gateway)

## External Integrations
- Cloudflare API
- Registrar APIs (Hostiq, Namecheap)
- FastPanel APIs / SSH-driven setup flows
- Optional: RapidAPI **temporary Gmail** provider (used only when `RAPIDAPI_KEY` is set and `Auto Temp Mail Enabled` is true in `system_config`)
- Optional: **Telegram Bot API** for outbound alerts (env `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` when enabled in `system_config`)
- Optional: operator **webhook** URL for outbound JSON payloads (stored in `system_config`, optional HMAC secret)
