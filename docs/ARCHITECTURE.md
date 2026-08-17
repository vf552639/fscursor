> ⚠️ **Устарело.** Описывает server-side архитектуру до разворота на zero-knowledge.
> Целевая архитектура (desktop выполняет, web read-only, сервер «слепой») — в `CLAUDE.md`
> и `docs/AUDIT_2026-08-02.md` (спека `plan.md` удалена как исполненная — история git).
>
> **Исключение:** § *Server signals*, § *Server reachability monitoring flow*, § *Server metrics
> flow* и «Server status ladder» в разделе Frontend переписаны по коду **2026-08-06** и актуальны.
> Разделы, помеченные *(historical)*, описывают код, которого больше нет.

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
- **Startup guard:** lifespan checks `alembic_version` equals expected head revision (`EXPECTED_ALEMBIC_HEAD` in `main.py`, currently **`016_server_consecutive_failures`**); transient DB connection errors are retried before failing (see `SUPABASE_DOCKER.md` § Startup resilience).
- **Routers** (`app/api/routes/__init__.py`): `auth`, `audit`, `blobs`, `sync`, `servers`, `cloudflare`, `domains`, `registrars`, `tasks`, `notifications`, `settings`. The `ssl-emails` router was dropped together with the `ssl_email_pool` table (migration `013_drop_ssl_email_pool`).
- **DB layer:** SQLAlchemy async sessions + Alembic migrations
  - **Model registry invariant:** `app/models/__init__.py` imports **every** model, including those declared outside `app/models/` (`auth`, `blobs`, `audit`). This is load-bearing, not tidiness: SQLAlchemy resolves `ForeignKey("blob_storage.id")` lazily at flush time, so a process whose `Base.metadata` is missing a referenced table raises `NoReferencedTableError` on every write. Because Python imports a package before its submodule, `from app.models.server import Server` alone yields the complete registry — web, worker, beat and Alembic all get it for free. The worker is the process that proves it: it never imports routes, and before this was fixed the reachability monitor could not write a single check for the whole life of the feature. Guarded by `tests/test_model_registry.py`, which runs in a clean subprocess (inside the normal test session the routes are already imported, so the check would always pass). Note `configure_mappers()` does **not** catch this — nothing declares a `relationship()` to `BlobStorage`, only raw FK columns.
- **Background tasks:** Celery + Redis
  - Scheduled tasks via Beat — `app/core/celery_app.py` holds exactly two entries:
    - `check-domain-renewals-daily` → `app.tasks.renewal.check_domain_renewals`, daily at `09:00 UTC`;
    - `check-server-reachability-6h` → `app.tasks.server_monitor.check_server_reachability`, `crontab(minute=0, hour="*/6")`.
  - The reachability task is also fired **outside the schedule**, by the same two-parameter task (no second task exists): on worker start (`celeryd_after_setup` in `celery_app.py`, whole fleet) and on server creation / bulk import (`server_service`, scoped to that owner via `user_ids`). Both are conveniences — a failed publish is logged as a warning and never propagates to the HTTP response or the worker boot. Because a publish is a convenience it is also **time-boxed**: `PUBLISH_TIMEOUT_SECONDS = 3` (`server_service`) is the upper bound the caller ever waits, `broker_transport_options={"socket_connect_timeout": 1}` keeps an abandoned publish thread short-lived, and `ignore_result=True` keeps `send_task` from also dialling the result backend (`on_task_call`) for a result nobody reads. Without these, a blackholed broker held `POST /api/servers` for over 100 s. The publish sits between `commit()` and `refresh()` so it holds no DB connection while it waits — note `NullPool` is in use behind the Supabase pooler, so an extra commit there would cost a full reconnect per create.
  - There is **no** server metrics sweep on the backend — see § Server signals below.
  - `TaskLogStatus` (`app/core/constants.py`) is `pending / running / success / failed / partial`. **`partial`** is for batch runs that finished but did not process every entity — the normal degraded outcome of server monitoring, which neither `success` nor `failed` describes.
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
    - NS check — *(historical)* задумывалась как `registrar.get_nameservers` с DNS-фолбэком; ни того, ни другого больше нет. NS домена «как есть» читает десктоп из РЕЕСТРА (RDAP, `domain_registry_nameservers`), одинаково для всех провайдеров: у Hostiq чтения NS в API не существует (`docs/HOSTIQ_API.md` §5), а у ручных провайдеров нет и самого API, — то есть путь отвечал у одного провайдера из двух. Регистратору осталась запись.
    - manual NS override state (`ns_check_mode` `auto|manual`).
  - A bulk orchestration endpoint (`POST /api/domains/bulk-full-setup`) runs per-domain chain semantics:
    1. assign server/cloudflare/registrar,
    2. create/link Cloudflare zone,
    3. apply nameservers via registrar task.
    - *(historical — и путь, и семантика.)* Роут `bulk-full-setup` вместе со своей
      Celery-задачей удалён при развороте на zero-knowledge (коммит `5192372`). С
      2026-08-13 есть `POST /api/domains/full-setup`, и он делает ТОЛЬКО шаг 1:
      проставляет `server_id`/`cloudflare_account_id`/`registrar_id` пачке доменов одной
      транзакцией и возвращает `id` + имя каждого домена. Шаги 2–3 (зона Cloudflare, NS у
      регистратора) выполняет десктоп — токенов у сервера нет. Ни задач, ни `task_logs`
      этот роут не создаёт.
  - Task logs are created per domain for progress UI and SSE stream consumers.
- **Task streaming:**
  - `GET /api/tasks/{id}/stream` provides SSE updates with incremental `log_text` and task status.
- **Periodic SSL metadata refresh:** *(historical)*
  - Beat task `app.tasks.domain.refresh_ssl_all` ran daily at `03:00 UTC` and updated `ssl_status`, `ssl_expires_at`, `ssl_issuer` for domains bound to servers. The task module and its Beat entry no longer exist; `beat_schedule` holds only the two entries listed above.
- **Bulk import flow:**
  - `POST /api/domains/bulk-import` supports `csv`/`xlsx` uploads, returns summary and errors CSV URL.
  - `POST /api/servers/bulk-import` supports `csv`/`xlsx` with columns `name,ip,ssh_user,ssh_password,ssh_port,provider` (optional header row; `provider` is the sixth column — it replaced the dropped `notes` column, see `plans/2026-08-05-server-hosting-provider.md` phase 4); errors CSV via `GET /api/servers/bulk-import-errors/{token}`.
- **Outbound notifications (PR-3):**
  - On successful `create_notification`, the backend may call configured channels: webhook (`Webhook Enabled` + `Webhook URL` + optional `Webhook Secret` in `system_config`) and Telegram (env `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` when `Telegram Enabled` is true).
  - `POST /api/settings/notifications/test` sends a synthetic payload through the same channel logic and returns per-channel status strings for UI smoke tests.
- **Cloudflare DNS create idempotency:**
  - `create_dns_record` checks for an existing record with the same `type` + `name` and issues `PATCH` instead of `POST` when found.
- **Renewal flow:**
  1. Periodic task selects domains with `purchase_date <= today - 9 months`.
  2. For each domain, creates notification using `ON CONFLICT DO NOTHING` by `dedup_key`.
  3. Writes audit entry to `task_logs`.
- **Server signals — two of them, independent:**
  A server row carries two different kinds of knowledge. They have different writers, different rhythms and different staleness thresholds, and merging them into one "server health" notion is the mistake this section exists to prevent.

  | Signal | Written by | Cadence | Fields | Stale after |
  |---|---|---|---|---|
  | alive / down | Celery Beat on the backend, TCP connect to `ip_address:ssh_port` | every 6 h unconditionally, **plus** event-driven runs (worker start, server created, bulk import — see § Background tasks) | `last_check_at`, `last_check_ok`, `last_check_error`, `consecutive_failures` | 18 h (three missed runs) |
  | metrics | desktop over SSH, on the user's click | only while the desktop is open | `metrics_collected_at`, `uptime_seconds`, `cpu_usage_pct`, `cpu_count`, `ram_*`, `disk_*`, `net_*`, `os_pretty`, `kernel` | 24 h |

  The split follows from zero-knowledge: the SSH password is stored as an opaque blob and the backend holds no key, so the backend **cannot** collect metrics at all (the server-side collector `server_metrics_service.py` was removed during the migration). A TCP probe needs no credentials, so it runs on the backend around the clock — including while the desktop is closed.

  Both thresholds live in `frontend/src/lib/serverStatus.ts` (`CHECK_STALE_MS`, `METRICS_STALE_MS`).

- **Server reachability monitoring flow** (`app/services/server_monitor.py` + `app/tasks/server_monitor_task.py`):
  1. Beat fires `app.tasks.server_monitor.check_server_reachability`; targets are `(id, ip_address, ssh_port)` of servers that have an owner. A row with `user_id = NULL` is skipped before the probe — there is nobody to notify and no `sync_state` to bump. The optional `user_ids` argument narrows the selection to the listed owners (JSON strings, parsed to `UUID` inside the task, because the broker is `task_serializer="json"`); creating a server passes its owner so one new row does not trigger a sweep of everyone's fleet.
  2. **Probe fan-out.** `probe()` is pure network and never touches the DB; it is run under `asyncio.Semaphore(20)`. One probe is a TCP connect with a 5 s timeout plus a single retry after 2 s, so a silent host costs up to 12 s — a sequential pass over hundreds of servers would not fit `task_soft_time_limit`. The DB session is deliberately closed for the whole probe phase: keeping it open would mean an `idle in transaction` connection held through minutes of network waits, which through the Supabase pooler is an occupied upstream connection.
  3. **Write-back is sequential** — one commit per server, in a single session — and deliberately not fanned out: `touch_entity_sync` takes `SELECT … FOR UPDATE` on the owner's `sync_state` row (parallel sessions of one owner would contend on it), and `apply_check_result` commits inside itself and then makes outbound HTTP calls (webhook / Telegram), so such a commit in a shared session would drag half-written neighbours into the DB.
  4. Each row is re-read before writing, and the probed address is compared with the stored one: an address edited during the probe makes the result stale and it is discarded.
  5. **Failure semantics.** `consecutive_failures` counts misses; `last_check_ok = false` means a **confirmed** outage — `FAILURE_THRESHOLD = 2` misses in a row. A momentary blip never reaches that state: each check is already a TCP attempt plus one retry, so confirming an outage costs four failed attempts. Note the threshold was designed when runs were six hours apart, so "two in a row" implied a six-hour gap; with event-driven runs added, two runs can now fall a minute apart (e.g. two worker restarts), and the two misses are then only seconds apart rather than hours. The protection is weaker than the original wording implied — still four attempts, but no longer spread over a long window.
  6. **Notifications** `server_down` / `server_up` are created on transitions only, once per episode: `dedup_key = server_{down|up}:{server_id}:{episode marker}`, where the marker is the timestamp that opened the episode. Keying on the server alone would let `ON CONFLICT DO NOTHING` swallow the same server going down again a month later.
  7. The run writes one `TaskLog(entity_type="system", task_type="server_monitor")` with counters `checked / down / up / undelivered / failed`; status is `success`, or **`partial`** when anything was undelivered or not checked.
  8. **A run that checked nothing at all fails the task** (`ServerMonitorRunFailed`), rather than reporting success — but only when the target list was non-empty *and* a real error occurred. Per-server fault isolation is correct, yet in the degenerate case where every target fails it turns into a green report about nothing; that is exactly how the broken model registry survived unnoticed. Benign races (row deleted or re-addressed mid-probe) raise nothing and keep the run green, since there the system behaved correctly and simply had nothing to record. The journal row is written before the task fails, so the user still gets an explanation.
  - The probe is TCP only: no ICMP (firewalls drop it, and silence would read as "down" for half the live machines) and no SSH login (no key for the password blob). `last_check_error` therefore only ever holds network error text (`timeout after 5s`, `Connection refused`) — no secret can reach it.
  - `consecutive_failures` is a backend-internal counter and is not part of `ServerResponse`.
- **Server metrics flow — desktop collects, backend receives:**
  1. The desktop runs one SSH command and parses the output client-side (`frontend/src/lib/serverMetrics.ts`; `runCollectMetrics` in `frontend/src/api/servers.ts`). In the web build the action does not exist — the password blob cannot be decrypted there.
  2. `POST /api/servers/{id}/metrics` accepts the snapshot: schema `ServerMetricsIn` (`app/schemas/server.py`), persisted by `server_service.apply_metrics`. Scoped to the owner (`get_by_id(db, server_id, user.id)` → `404` for someone else's row) and audited as `server.metrics` with no values in metadata.
  3. **Body semantics:** `extra="forbid"` — an unknown key is `422`, not a silent drop; an explicit `null` **clears** the column, an absent key leaves it untouched (`model_dump(exclude_unset=True)`); a body with no fields at all is `422`, because it would do nothing but rejuvenate the previous snapshot's timestamp. `metrics_collected_at` is set by the server, never by the client. Numeric ranges are bounded by the Postgres column widths so a broken remote parser yields a `422`, not a `500` from the driver.
  4. `touch_entity_sync` bumps `sync_version`, otherwise the snapshot would never reach the desktop's local cache through `GET /sync/changes?since=`.
  - `POST /api/servers/{id}/refresh-metrics` and `/refresh-uptime` **do not exist** — they went away with the backend collector. `app/api/routes/servers.py` exposes only list / get / create / update / **metrics** / delete / bulk-import / bulk-import-errors.
- **FastPanel domains sync flow:** *(historical — `POST /api/servers/{id}/sync-domains`, `fastpanel_client.py` and `server_service.fetch_and_persist_domains` were removed with the zero-knowledge migration; FastPanel work now happens in the desktop)*
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
- **Server status ladder — one module for all four screens:** `frontend/src/lib/serverStatus.ts` (`serverUiStatus`, `isCheckStale`, `isMetricsStale`, `statusBadgeVariant`, `UNCHECKED`) is the single source read by `Servers`, `ServerDetail`, `Dashboard` and `Domains`. It exists because the ladder used to be re-derived on each screen and drifted apart: the dashboard counted every server as healthy (`status === "active" ? "healthy"`, ignoring the check result) including confirmed-down ones, and the Domains list drew a green dot next to every domain of a dead server.
  - Rule: **never render ignorance as health.** `servers.status` is a lifecycle column written when the server is created and says nothing about whether the machine answers. Precedence: a confirmed outage (`last_check_ok === false`) wins over everything; then a positive **and** fresh check yields `active`, outranking any value of the `status` column; only when there is no measurement at all does the column speak (`error` / `provisioned` / `new`, unknown values → `new`), and a column saying `active` without a measurement is `unchecked` — a word, not a blank space, because empty space reads as "nothing to show, so all is well".
  - The ladder is deliberately asymmetric: a confirmed outage is never declared stale (`error` on an old timestamp means "there was a problem and there is no newer data"), while a positive answer expires after `CHECK_STALE_MS`. What makes that honest is that the check's age is printed next to the status on every screen.
  - A fresh metrics snapshot deliberately does **not** feed the ladder: `active` means exactly "the background check got an answer" — one signal, one meaning, one rhythm.
- **ServerDetail** domains table reads `GET /api/domains?server_id=` as a **JSON array** (same contract as the Domains page). *(The **Sync Domains** action described here is historical — the endpoint is gone, see § FastPanel domains sync flow.)*
- **Domains UI** (переписан ветвью `feat/domains-cloudflare-match`, 2026-08-13):
  - `DomainDetailModal` — **один экран без вкладок**. Прежние пять (Overview / DB / SSL /
    Nginx / NS) исчезли: DB/SSL/Nginx удалены при развороте на zero-knowledge, NS слита в
    Overview, чтобы аккаунт Cloudflare, зона и делегирование читались вместе. Карточка
    состоит из `DomainCloudflareField` (селект аккаунта + дорезолв `cloudflare_zone_id`) и
    `DomainNsPanel` (nameservers зоны, бейдж делегирования, «Set NS at registrar»).
  - Bulk-действия: `Assign Server`, `Assign CF`, `Синхронизировать выделенные`,
    `Full setup`, `Provision`, `Delete`. **(Gone:** `Refresh SSL`, `Check NS`,
    `Mark NS Set` — роутов под них нет, кнопки удалены в спринте 3.**)**
  - Прогоны отчитываются баннером `RunNoticeBanner` (привязка и full setup) — с гейтом
    «один прогон за раз» в `MutationCache` (`api/runGate.ts`), переживающим уход со страницы.
  - **(Gone:** `BulkSetupWizard` и multi-task progress viewer — в репозитории их нет.**)**
  - Правила вынесены чистыми модулями: `lib/cfZoneMatch.ts` (матч домена с зоной),
    `lib/nsDelegation.ts` (лестница делегирования, семь причин `unknown`),
    `lib/registrarCaps.ts` (какие провайдеры умеют NS-API — зеркалит десктоп),
    `lib/fullSetupPlan.ts` (план прогона и дизейбл тумблеров).
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
  - *(historical)* SSL email pool management UI (`/api/ssl-emails`) under the **SSL Pool** tab — the router and the `ssl_email_pool` table were dropped (migration `013_drop_ssl_email_pool`); System tab includes quick toggles for webhook/Telegram/auto temp-mail and a **Test delivery** action

## Desktop (Tauri)

> ⚠️ Заголовок раздела был «scaffolding», а список ниже — про заготовки. Это давно неверно:
> в десктопе ~30 Tauri-команд, включая исполнение по SSH, работу с Cloudflare, регистраторами
> и write-back в бэкенд. Ветка `feat/domains-cloudflare-match` добавила две:
> `registrar_get_nameservers` (NS домена у регистратора — поимённо, а не листингом аккаунта)
> и `domain_full_setup` (зона Cloudflare + write-back `cloudflare_zone_id` + по флагу NS;
> отчёт по шагам, `Err` означает «работа не начиналась»). Первая из них с тех пор **удалена**:
> «как есть» спрашивают у реестра (`domain_registry_nameservers`, `src/rdap.rs`) — источник
> один на всех провайдеров, а через API регистратора отвечал один из двух. Регистратору
> осталась только запись (`registrar_set_nameservers`).
- **Location:** `desktop/` (npm shell + `desktop/src-tauri/` Rust project).
- **UI loading:** `tauri.conf.json` runs `npm run dev` from repo-root **`frontend/`** in dev and points `frontendDist` at **`../../frontend/dist`** for release builds.
- **Capabilities:** `desktop/src-tauri/capabilities/default.json` grants `core:default` and `shell:default` for the window labeled `main`.
- **Distribution:** unsigned install flows (Gatekeeper / SmartScreen) are documented in [`INSTALL.md`](INSTALL.md).
- **Developer isolation:** optional `git worktree` checkouts can live under `.worktrees/` (ignored by git); symlink or copy root `.env` into the worktree when running backend tests against a real DB.

## Security Notes
- Sensitive values are encrypted at rest (based on configured encryption key).
- Docker build contexts are constrained with service-level `.dockerignore` files to reduce accidental inclusion of `.env*`, caches, and runtime state files.
- This deployment profile is internal/development-oriented; public exposure still requires full auth hardening and production controls.
