# PROJECT OVERVIEW

**Project Name:** SDMP (Server & Domain Management Panel)

## Purpose
SDMP is an internal panel for centralized management of servers and domains with background automation (Celery), DNS/registrar integrations, and operational visibility in one UI.

## Implemented Scope (Current)
1. **Servers**
   - CRUD for servers
   - FastPanel connection/install lifecycle
   - SSH-related setup flow and status tracking
2. **Domains**
   - CRUD, bulk import (text + structured CSV-like)
   - Bulk actions (assign server, assign Cloudflare, set NS, delete)
   - New `purchase_date` support for renewal lifecycle
3. **Notifications**
   - Dedicated notifications entity and API
   - Domain renewal reminder generation at `purchase_date + 9 months`
   - Deduplication by `(domain_id, purchase_date)` via `dedup_key`
   - Read/unread and delete flows in UI
4. **Cloudflare / Registrars**
   - Account and zone-level integration primitives
   - DNS and nameserver-related operations
   - Edit/delete flows connected in UI tables
5. **Task Processing**
   - Celery worker for async jobs
   - Celery Beat for periodic jobs (daily renewal check)
   - Task audit logs in database
6. **Navigation & Settings**
   - Cross-page navigation context (`serverId`, `domainId`) between dashboard/details and domains
   - Settings config API (`/settings/config`) with editable system values in UI

## Runtime Profile
- Compose runtime currently uses `redis`, `backend`, `worker`, `beat`, `frontend`, `nginx`.
- Local postgres compose service was intentionally removed; backend DB connection is driven by `SUPABASE_DB_URL`.
- Backend DSN is expected in async form (`postgresql+asyncpg://...`) to match SQLAlchemy async engine setup.
- Backend container startup applies migrations automatically via `backend/entrypoint.sh`: optional `alembic_version` column widen, **wait-for-db** (asyncpg ping, ~60 s max), then `alembic upgrade head` before app start.
- API startup validates `alembic_version` against `EXPECTED_ALEMBIC_HEAD` in `main.py` (must match the latest Alembic head, currently `004_indexes`); **transient** DB read failures are retried in lifespan before failing (revision mismatch still fails immediately).
- `worker` and `beat` containers run with overridden empty entrypoint so migrations are executed only by `backend`.
- Runtime requires env contract parity with backend settings (`SUPABASE_*`, Redis/Celery URLs, encryption/secret keys, CORS/API prefix).
- Operational details for Supabase URLs, pooler ports, Docker checks, and MCP vs app connectivity: [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md).

## UX Reliability
- Resource pages now distinguish three list states:
  - loading,
  - backend/schema error (with diagnostic hint),
  - valid empty dataset.
- This is applied on Domains, Servers, Cloudflare accounts, and Settings -> Registrars.

## Key Entities
- `servers`, `server_secrets`, `task_logs`
- `domains` (including `purchase_date`)
- `notifications`
- `cloudflare_accounts`
- `registrar_accounts`
- `activity_logs`
