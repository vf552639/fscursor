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

## Resolved Recently

1. **Compose warnings for missing `POSTGRES_*` variables**
   - *Status*: Resolved
   - *Fix*: Removed unused local `db` service and related dependencies from `docker-compose.yml`.
   - *Result*: `docker compose` no longer emits blank-default interpolation warnings for postgres vars.

2. **Task2 plan A dead-click UI paths**
   - *Status*: Resolved (A1-A10)
   - *Fix*: Added `RowActions`, wired edit/delete handlers, enabled notification-to-domain navigation, and added server/dashboard domain routing paths.
   - *Result*: Core table actions and key navigation transitions are now clickable and functional.
