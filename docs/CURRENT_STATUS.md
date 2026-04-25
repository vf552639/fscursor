# CURRENT STATUS

**Last Updated:** 2026-04-25  
**Current Phase:** Phase 6 - Reliability & Feedback

## Completed
- 2026-04-25 (**task16**): Lifespan migration guard aligned with current Alembic head.
  - `backend/app/main.py`: `EXPECTED_ALEMBIC_HEAD` updated from `002_domain_purchase_and_notifications` to `004_indexes` so a DB already at `004_indexes` no longer fails startup with `Database migration mismatch`.
- 2026-04-25 (**task14**): Cloudflare sync switched to **attach-only** for existing domains.
  - Backend sync no longer inserts new `domains` rows from Cloudflare zones; it now links only existing domain names (`updated/skipped/total_zones` counters).
  - Frontend Cloudflare create feedback now explains partial linking: zones without matching domains are reported as skipped.
  - Domains table cleanup: removed hardcoded `PHP` and `NS` columns from the main grid.
  - Domain edit modal now contains a read-only nameserver block (CF nameservers fetch + status + `Set NS` action) so NS operations stay available without a dedicated table column.
- 2026-04-25 (**task12**): Cloudflare accounts endpoint no longer fails on legacy rows with empty `name`.
  - Backend schemas were split by intent: response model accepts stored data as-is, while input models keep strict validation (`CloudflareAccountCreate.name` and `CloudflareAccountUpdate.name` require min length 1).
  - Result: `GET /api/cloudflare/accounts` returns `200` even if old rows contain `name=''`; `POST/PUT` with empty `name` now return `422`.
  - Frontend Cloudflare error state is now neutral and operational (`error.message` + `docker compose logs backend --tail 100`) instead of always suggesting Alembic/schema drift.
- 2026-04-23: Frontend parse regression on Cloudflare page fixed (`frontend/src/pages/Cloudflare.tsx` ternary branch parenthesis balance `))}` -> `)))}`), Vite Babel parse error removed.
- 2026-04-23: Environment baseline aligned with backend `Settings` requirements:
  - root `.env` now includes `REDIS_URL`, `CELERY_BROKER_URL`, `CELERY_RESULT_BACKEND`, `ENCRYPTION_KEY`, `SECRET_KEY`, `BACKEND_CORS_ORIGINS`, `API_V1_PREFIX`, `VITE_API_URL`
  - `.env.example` replaced to mirror current runtime contract (`SUPABASE_*` + Redis/Celery/security keys), obsolete `POSTGRES_*` / `DATABASE_URL` removed
- 2026-04-23: Incident **“domains disappeared”** — documented root cause: migrations (e.g. `002_domain_purchase_and_notifications`) were not guaranteed on container start; operators had to remember `docker compose run --rm backend alembic upgrade head`. Fix: backend `entrypoint.sh` runs `alembic upgrade head` before uvicorn; startup lifespan asserts `alembic_version` head; see `task2.md` §B1.1. **Workaround before pull:** run `alembic upgrade head` manually after each pull / first boot if not yet on this revision.
- Domain renewal notification system delivered end-to-end:
  - `domains.purchase_date` added
  - `notifications` table/model/API added
  - renewal reminder rule implemented (`purchase_date + 9 months`)
  - deduplication implemented with `dedup_key = domain_renewal:{domain_id}:{purchase_date}`
- Periodic processing delivered:
  - Celery Beat configured
  - daily renewal check task scheduled at `09:00 UTC`
  - manual trigger endpoint added (`POST /api/notifications/check-renewals`)
  - audit log persisted into `task_logs` with `task_type=renewal_check`
- Frontend delivered:
  - `Notifications` page with filters, mark-read, mark-all-read, delete
  - unread counter on topbar bell icon
  - domain create/edit flow supports `purchase_date`
  - domain table shows purchase date
- Task2 plan A closure delivered:
  - Row-level actions wired for Domains, ServerDetail, Cloudflare DNS/accounts, Settings registrars
  - Notification row click routes to Domains with focused `domainId`
  - `ServerDetail -> Domains` and `Dashboard -> Domains` navigation paths added
  - Topbar logout and theme toast behavior implemented
- Compose reliability cleanup:
  - removed unused local `db` service from `docker-compose.yml`
  - eliminated `POSTGRES_*` interpolation warnings in `docker compose` parsing
- Migration reliability hardening delivered:
  - added `backend/entrypoint.sh` (`alembic upgrade head` before `uvicorn`)
  - Dockerfile uses explicit `ENTRYPOINT ["/app/entrypoint.sh"]`
  - `worker` and `beat` run with `entrypoint: []` and depend on backend startup
  - startup lifespan guard checks `alembic_version` against expected head
- Settings API baseline delivered:
  - `GET /api/settings/config`
  - `PUT /api/settings/config/{key}`
  - frontend hook integration in Settings page
- UI state clarity delivered:
  - Domains, Servers, Cloudflare, and Registrars now render explicit `loading/error/empty` states
  - schema/backend failures are no longer visually indistinguishable from valid empty datasets
- 2026-04-23: Supabase + Docker runbook and pooler/asyncpg notes captured in [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md); backend uses `ASYNCPG_CONNECT_ARGS` + `NullPool` when `SUPABASE_DB_URL` points at `pooler.supabase.com` (`backend/app/core/config.py`, `database.py`, `alembic/env.py`, `entrypoint.sh`).
- 2026-04-23 (**task9**): **Startup resilience for Supabase pooler**
  - `backend/entrypoint.sh`: **wait-for-db** before `alembic upgrade head` — up to **12 × 5 s** (~60 s) of `asyncpg` + `SELECT 1` against `SUPABASE_DB_URL` (with `statement_cache_size=0`), so short pooler/upstream outages do not instantly kill the container.
  - `backend/app/main.py`: **lifespan** `alembic_version` check retries transient connection errors (**10 × 2 s**); empty table or revision mismatch still fails fast (no retry).
  - `.env.example`: pooler URL shape with `postgres.<project_ref>`, region note, and **commented direct** `db.<project_ref>.supabase.co:5432` fallback for local incidents.
  - Git: `Wire backend to Supabase transaction pooler (asyncpg connect args + NullPool).` (pooler wiring + entrypoint/env) and `Retry alembic_version check during API startup for transient DB errors.` (lifespan).

## In Progress / Next
1. Run and document full E2E verification checklist in Docker runtime (including healthy pooler or **direct** DSN when pooler circuit-breakers).
2. Add tests for renewal task + notifications API.
3. Expand global toast/notification UX consistency across all pages.

## DB Migrations Quick Runbook
- Local host-dev from repo root:
  - `alembic upgrade head`
  - `alembic current`
  - `alembic history`
- Local from `backend/` directory:
  - `alembic upgrade head`
- Inside backend container:
  - `docker compose exec backend alembic upgrade head`

Notes:
- Root workflow uses `/alembic.ini` wrapper (`script_location = backend/alembic`, `prepend_sys_path = backend`).
- Container/backend workflow uses `backend/alembic.ini`.
- If env-based DB settings are missing, export variables from `.env` before running Alembic on host.
- If host Python misses backend dependencies (e.g. `asyncpg`), install backend requirements first: `pip install -r backend/requirements.txt`.

## Blockers
- See [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md) for the full error catalog and verification steps. Typical remaining issues are **wrong DSN** (host/port/user/password) or **pooler upstream** unavailable (`Circuit breaker open: Unable to establish connection to upstream database` — check Supabase project/database status in Dashboard, wait for retries in logs, or temporarily switch to **direct** URL in `.env` per `.env.example`). MCP can still reach the DB while Docker pooler fails; compare hosts and credentials.
