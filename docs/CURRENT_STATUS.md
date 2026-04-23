# CURRENT STATUS

**Last Updated:** 2026-04-23  
**Current Phase:** Phase 6 - Reliability & Feedback

## Completed
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

## In Progress / Next
1. Run and document full E2E verification checklist in Docker runtime.
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
- None at the code level; pending runtime verification in active Docker session.
