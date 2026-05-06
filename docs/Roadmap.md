# ROADMAP

## Phase 1-5 (Done)
- [x] Core backend/frontend modules and integrations
- [x] Domain bulk operations
- [x] Celery worker-based async task processing

## Phase 6 - Reliability & Feedback (Current)
- [x] Add `purchase_date` to domains
- [x] Add notifications subsystem (`notifications` model/API/UI)
- [x] Implement renewal reminder rule (`purchase_date + 9 months`)
- [x] Add deduplication per `(domain_id, purchase_date)`
- [x] Add Celery Beat service and daily scheduled renewal checks
- [x] Add unread badge in topbar and notifications page actions
- [x] Complete task2 plan A UI transition fixes (A1-A10)
- [x] Add A11-style explicit list states (`loading/error/empty`) for Domains, Servers, Cloudflare, Registrars
- [x] Remove unused compose `db` service to eliminate `POSTGRES_*` warnings
- [x] Add migration safety hardening (`backend` entrypoint migration + startup `alembic_version` guard)
- [x] Keep lifespan `EXPECTED_ALEMBIC_HEAD` in `main.py` aligned with latest Alembic revision (currently `010_domain_extras`; was `009_phpversion_widen`, `008_server_metrics`, `004_indexes` in earlier milestones)
- [x] Stage 0 foundation: Tauri 2 `desktop/` shell, pinned auth-related Python deps, `test_lifespan.py`, [`INSTALL.md`](INSTALL.md), `.worktrees/` gitignore (2026-05-06)
- [x] Add baseline settings config API and wire Settings page edit flow
- [x] Fix Cloudflare page parse error (unbalanced ternary parentheses in `Cloudflare.tsx`)
- [x] Align `.env` and `.env.example` with current backend `Settings` contract (`SUPABASE_*`, Redis/Celery, security keys)
- [x] Document Supabase pooler + Docker + MCP troubleshooting in `docs/SUPABASE_DOCKER.md`
- [x] Wire backend to Supabase **transaction pooler** (`6543`): `ASYNCPG_CONNECT_ARGS`, `NullPool` when host contains `pooler.supabase.com`, Alembic async engine aligned (`task9` / commits on 2026-04-23)
- [x] Add **wait-for-db** in `backend/entrypoint.sh` and **lifespan retries** for `alembic_version` reads to tolerate brief pooler/upstream flaps
- [x] Prevent Cloudflare accounts list 500 on legacy empty names by splitting input/output validation in schemas and by keeping strict non-empty `name` validation for create/update
- [x] Replace Cloudflare page hardcoded Alembic/schema error hint with neutral backend error messaging (`error.message` + logs tail hint)
- [x] Change Cloudflare auto-sync policy to **attach existing domains only** (no new domain inserts from CF zones; report `updated/skipped/total_zones`)
- [x] Remove hardcoded `PHP`/`NS` columns from Domains table and move NS visibility/actions into Domain edit modal
- [x] Add per-service `.dockerignore` files for backend/frontend build contexts (exclude `.env*`, caches, `node_modules`, runtime artifacts)
- [x] Implement SSH-based server uptime persistence (`/proc/uptime`) with backend fields (`uptime_seconds`, `last_check_*`)
- [x] Add uptime automation baseline (create-trigger check, manual refresh endpoint, and periodic scheduler), then evolve to full metrics sweep every 5 minutes
- [x] Replace hardcoded server uptime in UI (`0 days`) with real API-driven formatting and failure state hints
- [x] Add FastPanel domain provisioning core (site/FTP/SSL) and persist provisioning fields/errors on domains
- [x] Add SSL email pool CRUD API and capacity notifications (`ssl_pool_exhausted` / low-capacity warnings)
- [x] Add task log SSE streaming endpoint and live task progress modal in frontend
- [x] Add file-based domain bulk import (`csv`/`xlsx`) with downloadable errors CSV
- [x] Add domain status badges, bulk provision action, and status URL filter (`?status=...`) on Domains page
- [x] Add server bulk import (`csv`/`xlsx`) + UI + errors CSV download path
- [x] Add Cloudflare DNS create upsert (same `type` + `name`) and stricter Namecheap `setCustom` response handling
- [x] Add outbound notification channels (webhook + Telegram) and Settings smoke test endpoint
- [x] Add Settings SSL email pool tab (CRUD + usage visualization) and optional auto temp-mail path for empty SSL pool
- [x] Replace uptime-only checks with full SSH server metrics collector (CPU/RAM/disk/network/OS/kernel/FastPanel version)
- [x] Add `POST /api/servers/{id}/refresh-metrics` and keep `refresh-uptime` as compatibility alias
- [x] Change server scheduler from 15-minute uptime to 5-minute metrics sweep (`check_all_servers_metrics`)
- [x] Add server status transitions (`new` / `provisioned` / `active` / `error`) and align Servers/ServerDetail badges
- [x] Add FastPanel domain sync (`POST /api/servers/{id}/sync-domains`) with auto-trigger after install and for pre-installed servers
- [x] Harden sync: SSH list timeouts / no PTY, `php_version` column widen (`009_phpversion_widen`), nested FastPanel `owner` normalization, DB rollback on sync errors, **no silent cross-server relink** (conflict returns `error`), ServerDetail domains list uses API array + sync mutation error banner
- [ ] Complete full E2E runtime verification and attach runbook notes (include server bulk-import, webhook/Telegram test, temp-mail + provision + new task33 domain operations)
- [ ] Add focused tests (notification service + renewal task + server uptime flow + provisioning/import flows + server bulk-import parser + task33 NS/DB/SSL flows)
- [x] Add domain operational APIs/tasks for FastPanel DB/SSL/Nginx/NS management (`task33`)
- [x] Add bulk full setup workflow (assign + CF zone + NS push) with wizard and progress UI (`task33`)
- [x] Add domain schema extensions for DB/SSL/NS/Nginx metadata (`010_domain_extras`)

## Phase 7 - Production Readiness
- [ ] Authentication and authorization hardening for internet-facing deployment
- [ ] CI/CD pipeline (`tsc`, lint, backend checks/tests)
- [ ] Production frontend build and optimized nginx serving
- [ ] Operational monitoring and alerting baseline
