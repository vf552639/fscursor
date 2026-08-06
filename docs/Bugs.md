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

4. **Provisioning/import flows require full runtime verification**
   - *Severity*: Medium
   - *Impact*: Provisioning core and file import are implemented, but need end-to-end checks in running compose with real FastPanel/SSH targets and realistic import files.
   - *Next*: Validate task streaming (`/tasks/{id}/stream`), domain provisioning idempotency, DNS pre-check behavior, and errors CSV download path from `/domains/bulk-import-errors/{token}`.

4.1. **Server bulk-import and outbound notification channels need runtime verification**
   - *Severity*: Medium
   - *Impact*: `POST /api/servers/bulk-import`, webhook/Telegram dispatch, `POST /api/settings/notifications/test`, and RapidAPI temp-mail auto-seed are implemented but should be validated against real endpoints and env (`RAPIDAPI_KEY`, `TELEGRAM_*`).
   - *Next*: Import a small CSV with one bad row, confirm errors CSV token URL; enable webhook/Telegram flags in `system_config`, run **Test delivery** from Settings, trigger a real `create_notification` (e.g. provision failure) and confirm external receipt.

5. **Local frontend build still depends on host runtime outside Docker**
   - *Severity*: Low
   - *Impact*: `npm run build` can fail outside Docker on outdated host runtimes.
   - *Next*: Document required Node version and prefer containerized build checks.

6. **Server telemetry + FastPanel domains sync need runtime verification in live compose** — ~~open~~ **obsolete (2026-08-06)**
   - *Was*: Full SSH metrics collection (CPU/RAM/disk/network/uptime), 5-minute scheduler, and `/servers/{id}/sync-domains` should be validated end-to-end with real SSH/FastPanel targets.
   - *Why obsolete*: none of that code is on the backend any more. The SSH collector, `/refresh-metrics`, `/refresh-uptime`, `/sync-domains` and the 5-minute sweep were removed with the zero-knowledge migration; the backend cannot decrypt an SSH password.
   - *What to verify instead*: (a) Beat runs `check-server-reachability-6h` and leaves a `TaskLog(task_type="server_monitor")` per run — `success`, or `partial` with counters when some rows were not processed; (b) two probe misses in a row flip `last_check_ok` to `false` and emit one `server_down` notification per episode, and recovery emits one `server_up`; (c) the desktop **Refresh metrics** button posts to `POST /api/servers/{id}/metrics` and the card stops showing dashes. See `docs/ARCHITECTURE.md` §§ Server signals / Server reachability monitoring flow / Server metrics flow.

10. **Task33 domain operations need full runtime verification against real FastPanel host**
   - *Severity*: Medium
   - *Impact*: APIs/tasks are implemented for create-db, ssl cancel/request/refresh, nginx override apply, NS check fallback, and bulk-full-setup; final confidence still requires E2E on a real panel/registrar/cloudflare set.
   - *Next*: Validate all task33 checklist paths (`create-db`, `db-credentials`, `ssl-cancel`, `refresh-ssl`, nginx apply+rollback, `check-ns`, `bulk-full-setup`) in live compose + real providers.

7. **Migrations not applied automatically; risk of empty or out-of-sync database**
   - *Severity*: High
   - *Impact*: If the backend container did not run `alembic upgrade head` on start, after resetting the environment, adding a new migration, or first deploy, tables may be missing or the schema stale — requests to `/api/domains` can yield an empty list or 500. The symptom “domains disappeared from the DB” often maps to this class of issues.
   - *Next*: See `task2.md` §B1.1 (entrypoint + `alembic_version` guard on startup) and §B1.6 (persistence / backup runbook). **Mitigation in repo (2026-04-23):** `backend/entrypoint.sh`, Dockerfile `ENTRYPOINT`, compose `worker`/`beat` `entrypoint: []`, startup lifespan in `app/main.py`. Close after full Docker E2E verification.
   - *6.1*: `alembic_version.version_num` historically defaults to `VARCHAR(32)`, while revision ids can be longer (e.g. `002_domain_purchase_and_notifications`). This can fail migration finalization on update of version row.
   - *6.1 Fix*: entrypoint runs `ALTER TABLE IF EXISTS alembic_version ALTER COLUMN version_num TYPE VARCHAR(255)` before `alembic upgrade head`; `truncate_slug_length = 40` added in Alembic configs to keep generated revision slugs disciplined.

8. **No audit trail for deletions / bulk changes**
   - *Severity*: Medium
   - *Impact*: `DELETE /domains/{id}` and bulk assign endpoints do not write structured ActivityLog entries (who, when, what). When someone reports “domains disappeared”, intentional deletion cannot be ruled in or out from logs.
   - *Next*: Extend ActivityLog; optional Dashboard “Recent deletions” summary.

9. **Backend startup blocked by invalid Supabase DSN/credentials or prolonged pooler outage**
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

8. **Servers page hardcoded uptime (`0 days`) and no automatic uptime checks**
   - *Status*: Resolved (2026-04-29, task21)
   - *Fix*: Added migration `005_server_uptime` (`uptime_seconds`, `last_check_at`, `last_check_ok`, `last_check_error`), backend SSH uptime service (`/proc/uptime`), manual endpoint `POST /api/servers/{id}/refresh-uptime`, auto-check on create, and Celery Beat schedule every 15 minutes.
   - *Result*: Server cards/details show real uptime values and expose check errors in UI when SSH polling fails.

14. **Server telemetry cards and FastPanel domains sync (initial delivery)**
   - *Status*: Resolved (2026-04-29, task26/task27)
   - *Fix*: Added migration `008_server_metrics`, SSH collector for CPU/RAM/disk/network/OS/kernel/FastPanel version, scheduler update to 5-minute metrics tasks, `POST /api/servers/{id}/refresh-metrics`, and `POST /api/servers/{id}/sync-domains` (manual + auto triggers).
   - *Result*: Server pages no longer rely on mock metrics and FastPanel-connected servers can pull existing sites into SDMP domain records. (Follow-up hardening: items **16–17** below, task28–task31.)

9. **No `.dockerignore` for backend/frontend build contexts**
   - *Status*: Resolved (2026-04-29, task20)
   - *Fix*: Added `backend/.dockerignore` and `frontend/.dockerignore` to exclude `.env*`, caches, `node_modules`, logs, and runtime artifacts (`celerybeat-schedule`) from image build contexts.
   - *Result*: Smaller build contexts, better Docker layer cache behavior, and reduced risk of shipping local secrets/artifacts into images.

10. **FastPanel provisioning baseline (site/FTP/SSL + SSL email pool)**
   - *Status*: Resolved (2026-04-29, task24 / PR-1)
   - *Fix*: Added provisioning migrations (`006`, `007`), provisioning task, domain provisioning endpoints, SSL email pool CRUD, DNS pre-check, firewall preflight, and failure export CSV endpoint.
   - *Result*: Domain provisioning is now automated and observable via `task_logs`; failures are persisted in `domains.last_provision_error`.

11. **No live task log stream and no file import UX for domains**
   - *Status*: Resolved (2026-04-29, task25 / PR-2)
   - *Fix*: Added SSE stream endpoint (`/api/tasks/{id}/stream`), frontend realtime task modal, bulk import (`csv`/`xlsx`) endpoint with per-row errors export CSV, and domain status UX improvements.
   - *Result*: Operators can track long-running tasks live and import large domain lists with explicit row-level feedback.

12. **Cloudflare DNS `POST` could fail on duplicate record name/type during retries**
   - *Status*: Resolved (2026-04-29)
   - *Fix*: `create_dns_record` now looks up an existing record with the same `type` + `name` and issues `PATCH` when present.
   - *Result*: Safer re-runs of automation and bulk flows after partial failures.

13. **Namecheap `setCustom` could return non-OK XML without raising a structured registrar error**
   - *Status*: Resolved (2026-04-29)
   - *Fix*: `NamecheapService.set_nameservers` inspects `CommandResponse/@Status` and aggregates `<Error>` nodes into `RegistrarError`.
   - *Result*: NS push failures surface with clearer operator-facing messages.

16. **ServerDetail Domains panel stayed empty after Sync Domains (`Domains (0)`)**
   - *Status*: Resolved (2026-04-30, task31)
   - *Fix*: `ServerDetail.tsx` treats `useDomains({ server_id })` data as a **plain array** (`domainsData ?? []`), matching `GET /api/domains?server_id=` response shape (same as `Domains.tsx`).
   - *Result*: Header count and table populate immediately after a successful sync; reload still reflects DB state.

17. **FastPanel sync: SSH hang, `php_version` / `site_user` truncation, silent cross-server relink**
   - *Status*: Resolved (2026-04-29–30, task28–task31)
   - *Fix*: `list_sites` remote calls use `timeout=15` and `pty=False`; migration `009_phpversion_widen` + PHP string coercion; `_normalize_site_row` reads nested `owner` dict (username / home_dir path) with `_coerce_str` length caps; `fetch_and_persist_domains` rolls back on DB errors, **aborts with rollback** when a site would steal a domain linked to another server (returns `error` without forcing `last_check_ok=false`); sync mutation errors shown via `syncDomains.isError` on ServerDetail.
   - *Result*: Fewer 500s/hangs; operators see explicit conflict and DB-truncation messages instead of silent data moves.

18. **Task33 stage-1/2 domain operations + full setup workflow**
   - *Status*: Resolved in code (2026-04-30, task33)
   - *Fix*: Added migration `010_domain_extras`; new FastPanel SSH ops (`create_database`, `revoke_ssl_certificate`, SSL read, nginx override read/apply); registrar `get_nameservers`; domain endpoints for DB/SSL/Nginx/NS; daily SSL refresh task; bulk-full-setup endpoint/task; Domains UI additions (`DomainDetailModal`, `BulkSetupWizard`, multi-task progress).
   - *Result*: Operators can run domain setup/repair flows from UI without manual server shell work; remaining gap is live E2E verification against real providers.

19. **API startup failed: `EXPECTED_ALEMBIC_HEAD` stale vs real `alembic_version` after migration `010_domain_extras`**
   - *Status*: Resolved (2026-05-06, Stage 0)
   - *Fix*: `backend/app/main.py` constant set to **`010_domain_extras`**; added async regression test `backend/tests/test_lifespan.py` (compares DB head to `EXPECTED_ALEMBIC_HEAD`).
   - *Result*: Lifespan guard matches deployed migrations; CI/local can catch drift when DB is reachable.
