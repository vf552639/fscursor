# Supabase, Postgres, and Docker runbook

This document captures how the SDMP backend talks to Supabase Postgres in Docker, which environment variables are required, how pooler modes differ, what we changed in code for **asyncpg + PgBouncer**, how to verify connectivity, and how that relates to **Supabase MCP**.

## Required environment (`.env`)

Backend `Settings` (`backend/app/core/config.py`) expects at least:

| Variable | Role |
|----------|------|
| `SUPABASE_DB_URL` | Async SQLAlchemy URL; use **`postgresql+asyncpg://`** (not plain `postgresql://`). |
| `SUPABASE_URL` | Supabase project URL (API). |
| `SUPABASE_KEY` | Supabase key (API). |
| `REDIS_URL` | Redis for app/caching usage. |
| `CELERY_BROKER_URL` | Celery broker. |
| `CELERY_RESULT_BACKEND` | Celery result backend. |
| `ENCRYPTION_KEY` | Secrets at rest. |
| `SECRET_KEY` | App secret. |
| `BACKEND_CORS_ORIGINS` | Comma-separated origins (optional but typical in dev). |
| `API_V1_PREFIX` | Default `/api`. |
| `VITE_API_URL` | Frontend API base (used in frontend container). |

Compose loads these via `env_file: .env` (`docker-compose.yml`). After editing `.env`, recreate containers that read it (at minimum `backend`, also `worker` / `beat` / `frontend` as needed):

```bash
docker compose up -d --force-recreate backend worker beat
```

## `SUPABASE_DB_URL` shapes

### Driver prefix

The app uses **SQLAlchemy async** (`create_async_engine`). The URL must include the asyncpg driver:

- Correct: `postgresql+asyncpg://user:pass@host:port/dbname`
- Wrong for this codebase: `postgresql://...` without `+asyncpg` (SQLAlchemy may try a sync driver path and fail in container).

### Supabase pooler host and ports

Supabase commonly exposes:

| Mode | Typical port | Notes |
|------|----------------|-------|
| **Session pooler** | `5432` on `*.pooler.supabase.com` | Behaves closer to a normal session; asyncpg/SQLAlchemy often fewer surprises for **short** admin-style connections. |
| **Transaction pooler** | `6543` on `*.pooler.supabase.com` | PgBouncer **transaction** pooling; asyncpg must avoid assumptions that break when the server backend changes between transactions. |

Username for pooler is usually `postgres.<project_ref>` (as shown in the Supabase connection UI).

### Direct connection (optional)

A **direct** Postgres URL (host like `db.<project_ref>.supabase.co`, port `5432`) connects to Postgres without the pooler. Useful to isolate problems (“pooler vs upstream”). Not required for production traffic if pooler is stable.

## Code: asyncpg + Supabase pooler

When connecting through `*.pooler.supabase.com`, the backend applies:

1. **`connect_args`** (see `ASYNCPG_CONNECT_ARGS` in `backend/app/core/config.py`):
   - `statement_cache_size=0` and `prepared_statement_cache_size=0` — reduce prepared-statement issues with PgBouncer transaction pooling.
   - `prepared_statement_name_func` — generate unique prepared statement names (helps with pooler + SQLAlchemy’s asyncpg integration).
   - `server_settings.statement_timeout` — statement timeout (ms) as before.

2. **`NullPool`** for engine when the URL host is `pooler.supabase.com` (`backend/app/core/database.py`): avoid stacking SQLAlchemy `QueuePool` on top of the external pooler.

The same `connect_args` are used in:

- `backend/app/core/database.py` — runtime API engine.
- `backend/alembic/env.py` — online migrations (`NullPool` already used there).
- `backend/entrypoint.sh` — pre-migration `ALTER TABLE ... alembic_version` guard uses the same connection policy.

## Startup resilience (Docker / pooler flaps)

Cold starts or brief Supavisor **circuit breaker** windows used to fail the container on the first failed connection (before `alembic upgrade head` or on the first `alembic_version` read in FastAPI lifespan).

**Current behavior:**

1. **`backend/entrypoint.sh`** (before `alembic upgrade head`): **wait-for-db** — inline Python uses **asyncpg** with the same DSN rewrite as the smoke test (`postgresql+asyncpg://` → `postgresql://`), `statement_cache_size=0`, up to **12 attempts** with **5 s** sleep (~60 s total), `SELECT 1` each time. Logs: `wait-for-db: attempt N/12 failed: ...` then `wait-for-db: ok on attempt N` or a final `RuntimeError` with a pointer to `.env.example` direct fallback.

2. **`backend/app/main.py` lifespan**: reading `alembic_version` retries on generic connection errors (**10 attempts**, **2 s** sleep). **No retry** for an empty row or a revision mismatch (`RuntimeError` immediately). The checked head revision must match `EXPECTED_ALEMBIC_HEAD` in code (currently `004_indexes` after migrations `003_system_config` / `004_indexes`).

**`/health` stays non-DB-dependent** so orchestration can mark “process up” even while migrations are still running (port may not answer until uvicorn binds after Alembic).

## Health check URL

FastAPI exposes a simple health endpoint at **`GET /health`** (not under `/api`).

- Check: `curl -sS http://localhost:8100/health`
- API routes live under `API_V1_PREFIX` (default `/api`), e.g. `/api/domains`.

## Verifying Docker backend

1. **Containers up**

   ```bash
   docker compose ps backend
   ```

2. **Logs (migrations then uvicorn)**

   ```bash
   docker logs fs-cursor-backend-1 --tail=120
   ```

   On first boot, `entrypoint.sh` runs **wait-for-db** (if configured), then `alembic upgrade head`, then `uvicorn`; until that sequence finishes, port `8000` may not accept HTTP yet. Log lines `wait-for-db:` explain delays.

3. **HTTP health**

   ```bash
   curl -sS -w "\nHTTP %{http_code}\n" http://127.0.0.1:8100/health
   ```

4. **One-off DB smoke test** (optional; runs inside compose env)

   ```bash
   docker compose run --rm --entrypoint python backend -c "
   import os, asyncio, asyncpg
   dsn = os.environ['SUPABASE_DB_URL'].replace('postgresql+asyncpg://', 'postgresql://', 1)
   async def t():
       conn = await asyncpg.connect(dsn)
       print(await conn.fetchrow('select 1 as ok'))
       await conn.close()
   asyncio.run(t())
   "
   ```

## Supabase MCP vs application connection

- **Supabase MCP** (`execute_sql`, etc.) authenticates through Cursor’s MCP flow and talks to the project’s database **through Supabase’s managed MCP path**. It can succeed while **pooler** URLs from Docker still fail (different route, credentials, or pooler circuit breaker).
- The **app and Alembic** use `SUPABASE_DB_URL` from `.env` inside Docker. If MCP works but Docker does not, compare:
  - host (`pooler` vs `db`),
  - port (`5432` session vs `6543` transaction vs direct),
  - user (`postgres.<ref>` vs `postgres`),
  - password (rotated? URL-encoded if special characters).

## Error catalog (what we saw in practice)

| Symptom / error | Likely cause |
|-----------------|--------------|
| `ValidationError` for `REDIS_URL`, `CELERY_*`, `ENCRYPTION_KEY`, `SECRET_KEY` | Missing keys in `.env` loaded by compose. |
| `(ENOTFOUND) tenant/user postgres.<ref> not found` | Wrong pooler **region** host or wrong **username** for that project. |
| `InvalidPasswordError` | Wrong DB password in URL. |
| `ConnectionDoesNotExistError` / closed mid-operation on pooler | Wrong pooler mode/port for client; asyncpg + transaction pooler without the mitigations above; or unstable pooler/upstream. |
| `Circuit breaker open: Unable to establish connection to upstream database` | Supavisor/pooler **upstream** Postgres unavailable (paused project, incident, overload). Check Supabase Dashboard (project status, database up). Retry after recovery. |

## `.env.example`

See repository root `.env.example` for a template aligned with `Settings` and transaction pooler (`:6543`), user `postgres.<project_ref>`, and a **commented** direct URL (`db.<project_ref>.supabase.co:5432`) for dev when the pooler is unstable.

## Related files

| File | Purpose |
|------|---------|
| `backend/app/core/config.py` | `Settings`, `ASYNCPG_CONNECT_ARGS`. |
| `backend/app/core/database.py` | `create_async_engine`, `NullPool` when using `pooler.supabase.com`. |
| `backend/alembic/env.py` | Async Alembic engine for online migrations. |
| `backend/entrypoint.sh` | `alembic_version` width guard + **wait-for-db** + `alembic upgrade head` + `exec uvicorn`. |
| `backend/app/main.py` | Lifespan `alembic_version` check with retries for transient DB errors. |
| `docker-compose.yml` | `env_file: .env`, ports, services. |

## Frontend note (Cloudflare page)

A Vite parse error on the Cloudflare accounts list was fixed by balancing parentheses in the ternary that wraps `cfAccounts.map(...)` (`frontend/src/pages/Cloudflare.tsx`).
