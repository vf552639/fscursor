# KNOWN BUGS AND FOLLOW-UPS

## Open Issues

1. **Renewal notifications require runtime verification in live compose**
   - *Severity*: Medium
   - *Impact*: Feature implemented, but needs confirmation in running containers (`backend`, `worker`, `beat`) with real task execution traces.
   - *Next*: Run end-to-end checklist and capture expected outputs (`/notifications`, unread badge changes, task log entries).

2. **FastPanel and registrar flows still need deeper hardening**
   - *Severity*: Medium
   - *Impact*: Core flows work but need stronger retries, observability, and edge-case handling for provider/network failures.
   - *Next*: Add retry policies, better surfaced errors, and regression tests.

3. **Notifications UX can be expanded**
   - *Severity*: Medium
   - *Impact*: Page supports list/read/delete, but lacks richer actions (grouping, deep links, optional admin trigger UI, toasts consistency).
   - *Next*: Add reusable toaster integration and optional "check renewals now" UI action.

4. **Local frontend build still depends on host runtime outside Docker**
   - *Severity*: Low
   - *Impact*: `npm run build` can fail outside Docker on outdated host runtimes.
   - *Next*: Document required Node version and prefer containerized build checks.

5. **Migrations not applied automatically; risk of empty or out-of-sync database**
   - *Severity*: High
   - *Impact*: If the backend container did not run `alembic upgrade head` on start, after resetting the environment, adding a new migration, or first deploy, tables may be missing or the schema stale — requests to `/api/domains` can yield an empty list or 500. The symptom “domains disappeared from the DB” often maps to this class of issues.
   - *Next*: See `task2.md` §B1.1 (entrypoint + `alembic_version` guard on startup) and §B1.6 (persistence / backup runbook). **Mitigation in repo (2026-04-23):** `backend/entrypoint.sh`, Dockerfile `ENTRYPOINT`, compose `worker`/`beat` `entrypoint: []`, startup lifespan in `app/main.py`. Close after full Docker E2E verification.
   - *5.1*: `alembic_version.version_num` historically defaults to `VARCHAR(32)`, while revision ids can be longer (e.g. `002_domain_purchase_and_notifications`). This can fail migration finalization on update of version row.
   - *5.1 Fix*: entrypoint runs `ALTER TABLE IF EXISTS alembic_version ALTER COLUMN version_num TYPE VARCHAR(255)` before `alembic upgrade head`; `truncate_slug_length = 40` added in Alembic configs to keep generated revision slugs disciplined.

6. **No audit trail for deletions / bulk changes**
   - *Severity*: Medium
   - *Impact*: `DELETE /domains/{id}` and bulk assign endpoints do not write structured ActivityLog entries (who, when, what). When someone reports “domains disappeared”, intentional deletion cannot be ruled in or out from logs.
   - *Next*: Extend ActivityLog; optional Dashboard “Recent deletions” summary.

7. **Backend startup blocked by invalid Supabase DSN/credentials or prolonged pooler outage**
   - *Severity*: High
   - *Impact*: Wrong DSN still fails after retries; a **long** pooler circuit-breaker (> ~60 s before migrations, or sustained outage after API start) still prevents a healthy backend.
   - *Observed*: `(ENOTFOUND) tenant/user ... not found`; `Circuit breaker open: Unable to establish connection to upstream database`
   - *Mitigation (2026-04-23)*: `entrypoint.sh` **wait-for-db** (~60 s) and lifespan **retries** for reading `alembic_version`; `.env.example` documents **direct** fallback.
   - *Next*: Follow [`SUPABASE_DOCKER.md`](SUPABASE_DOCKER.md): verify `postgresql+asyncpg://...` (pooler region vs `postgres.<ref>`, ports `6543`/`5432`), or use direct `db.<ref>.supabase.co` temporarily; restart `backend/worker/beat` and verify `GET /health` (not `/api/health`).

## Resolved Recently

1. **Compose warnings for missing `POSTGRES_*` variables**
   - *Status*: Resolved
   - *Fix*: Removed unused local `db` service and related dependencies from `docker-compose.yml`.
   - *Result*: `docker compose` no longer emits blank-default interpolation warnings for postgres vars.

2. **Task2 plan A dead-click UI paths**
   - *Status*: Resolved (A1-A10)
   - *Fix*: Added `RowActions`, wired edit/delete handlers, enabled notification-to-domain navigation, and added server/dashboard domain routing paths.
   - *Result*: Core table actions and key navigation transitions are now clickable and functional.

3. **Cloudflare page parse error in ternary render branch**
   - *Status*: Resolved
   - *Fix*: Corrected parenthesis balance in `frontend/src/pages/Cloudflare.tsx` (`))}` -> `)))}`) for accounts list ternary branch.
   - *Result*: Vite/Babel parse error removed; page renders empty/list branches correctly.

4. **Missing required env keys in root `.env` caused Pydantic `Settings` validation failure**
   - *Status*: Resolved
   - *Fix*: Added missing runtime keys (`REDIS_URL`, Celery URLs, `ENCRYPTION_KEY`, `SECRET_KEY`, CORS/API/Vite vars) and updated `.env.example` to current `SUPABASE_*`-based contract.
   - *Result*: Startup no longer fails with the prior "5 validation errors for Settings" class of crash.

5. **Single pooler blip killed backend before migrations / API read of `alembic_version`**
   - *Status*: Mitigated (2026-04-23, task9)
   - *Fix*: `entrypoint.sh` runs asyncpg `SELECT 1` in a retry loop before `alembic upgrade head`; `app/main.py` lifespan retries transient errors when loading `alembic_version`.
   - *Result*: Short upstream/pooler outages are absorbed; wrong DSN or extended outages still require operator action (see `SUPABASE_DOCKER.md`).

6. **`GET /api/cloudflare/accounts` failed with HTTP 500 on legacy rows where `name=''`**
   - *Status*: Resolved (2026-04-25, task12)
   - *Fix*: `CloudflareAccountBase.name` no longer enforces `min_length=1` (response path), while strict validation is enforced on input models (`CloudflareAccountCreate.name` and `CloudflareAccountUpdate.name` use `min_length=1`).
   - *Result*: One invalid stored row no longer breaks the whole list endpoint; create/update still reject empty names with `422`. Cloudflare frontend error banner now shows neutral backend/log guidance instead of a hardcoded Alembic hint.

7. **Cloudflare sync created unintended new domain rows for zones absent in SDMP**
   - *Status*: Resolved (2026-04-25, task14)
   - *Fix*: Sync strategy changed from upsert-with-insert to attach-only: Cloudflare sync now updates CF linkage only for existing `domains.domain_name` matches and skips unmatched zones.
   - *Result*: Recreating a Cloudflare account no longer creates new rows with empty `server_id`/`registrar_id`; response/reporting now uses `updated/skipped/total_zones`.
