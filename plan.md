# Implementation Plan — SDMP Zero-Knowledge MVP (Phase 1+2)

## Context

The current SDMP is an internal-style panel where the FastAPI backend holds SSH passwords and API tokens for every customer's infrastructure. A pre-mortem identified three fatal-class risks for commercial launch (open API with no auth, server-held secrets with a single shared `ENCRYPTION_KEY`, MITM-prone `paramiko.AutoAddPolicy`). Spec at [docs/superpowers/specs/2026-05-06-zero-knowledge-launch-mvp-design.md](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/docs/superpowers/specs/2026-05-06-zero-knowledge-launch-mvp-design.md) re-architects to a 1Password-style zero-knowledge model: secrets stay client-side, the server stores opaque ciphertext blobs and metadata, and execution (SSH, Cloudflare, registrar APIs) moves into a Tauri 2 desktop app written in Rust. Web becomes read-only. Background agent and billing are explicitly Phase 3 (out of scope here).

**Decisions from clarification:**
- Tauri 2 stack — confirmed
- TOTP secret server-side as metadata — confirmed
- Disposition table in spec § 6 — confirmed (nothing extra removed)
- **Code signing: deferred.** Unsigned `.dmg` and `.exe` for MVP; install instructions document Gatekeeper / SmartScreen warnings. Apple Developer + Windows EV cert tracked as a post-MVP improvement, not a launch blocker.

**Code findings to incorporate:**
- Actual Alembic head is `010_domain_extras`, not `009_phpversion_widen`. The existing `EXPECTED_ALEMBIC_HEAD` constant in [backend/app/main.py:16](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/main.py:16) is stale — fix as part of Stage 0 cleanup. The new zero-knowledge migration becomes `011_zero_knowledge_v1` (spec said `010`, supersede with `011`).
- Frontend already uses `zustand` + `@tanstack/react-query` + `react-router-dom` 6 + `axios` — reuse all.
- No frontend test framework yet — add `vitest` + `@playwright/test` in Stage 5.

**Total estimated effort:** 9-10 weeks solo. Stages run mostly sequentially; Stage 1 and Stage 2 can overlap by ~3 days once auth API contract is frozen.

---

## Stage 0 — Foundation (3-5 days)

**Goal:** Unblock all downstream work. No feature behavior yet.

1. **Fix stale alembic head constant** — update [backend/app/main.py:16](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/main.py:16) to `010_domain_extras` so current code boots; this is independent of zero-knowledge work but blocks any subsequent migration.
2. **Bootstrap Tauri 2 project** in new top-level `desktop/` directory. Use `cargo create-tauri-app` with React + TypeScript + Vite preset; configure to load existing `frontend/` source via Tauri's frontend-dist pointer (during dev) and bundle for production build.
3. **Set up Rust workspace** under `desktop/src-tauri/` with sub-crates for `crypto`, `keychain`, `sync`, `ssh`, `cloudflare`, `registrars`, `provision`. Empty `lib.rs` files; just structure.
4. **Pin dependencies:** `tauri = "2"`, `sodiumoxide` or `dryoc` (libsodium binding for XChaCha20-Poly1305 + Argon2id), `russh = "0.45"`, `keyring = "3"`, `tiny-bip39 = "1"`, `rusqlite = "0.32"` with `bundled-sqlcipher` feature (encrypted local cache), `tokio`, `serde`, `reqwest`.
5. **Add backend deps** to [backend/requirements.txt](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/requirements.txt): `argon2-cffi`, `slowapi`, `itsdangerous` (signed cookies), `bcrypt` (hash auth-key for transit defense-in-depth).
6. **Document unsigned-install UX** in `docs/INSTALL.md` (new file): macOS right-click → Open instructions, Windows SmartScreen "More info" → "Run anyway" instructions, verification of SHA256 from website.

**Verify:** `cargo check` passes in `desktop/src-tauri`; backend starts with corrected alembic head; `npm run dev` in frontend still works.

---

## Stage 1 — Auth + sync server (10-12 days)

**Goal:** Backend supports register/login/sync/blob CRUD. No client yet.

7. **Schema migration `011_zero_knowledge_v1`** — single Alembic revision in [backend/alembic/versions/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/alembic/versions/):
   - Create tables: `users` (id uuid, email, salt, auth_key_hash, totp_secret nullable, email_confirmed_at, created_at), `sessions` (id, user_id, token_hash, expires_at, device_id, ip, user_agent), `blob_storage` (id uuid, user_id, ciphertext bytea, blob_kind, version bigint, updated_at, device_id, deleted), `audit_log` (id, user_id, action, target_type, target_id, device_id, ip, ts, metadata jsonb), `recovery_blob` (user_id pk, ciphertext, updated_at), `sync_state` (user_id pk, current_version bigint).
   - Add `user_id` UUID FK + index to: `domains`, `servers`, `cloudflare_accounts`, `registrar_accounts`, `notifications`, `task_logs`, `ssl_emails`, `system_config`, `activity_logs`.
   - Drop columns: `servers.ssh_password_encrypted`, `servers.fastpanel_password_encrypted`, entire `server_secrets` table, `domains.ftp_password_encrypted`, `domains.db_password_encrypted`, `cloudflare_accounts.api_token_encrypted`, `registrar_accounts.api_key_encrypted`, `registrar_accounts.api_secret_encrypted`.
   - Add `*_blob_id` UUID FK columns (nullable) referencing `blob_storage.id` ON DELETE SET NULL.
   - Update `EXPECTED_ALEMBIC_HEAD` in [backend/app/main.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/main.py) to `011_zero_knowledge_v1`.
8. **New auth module** at `backend/app/auth/`:
   - `models.py` — User, Session, RecoveryBlob ORM models.
   - `routes.py` — endpoints `/auth/register`, `/auth/login`, `/auth/logout`, `/auth/confirm-email`, `/auth/me`, `/auth/recovery/start`, `/auth/recovery/finish`, `/auth/password/change`, `/auth/totp/enable`, `/auth/totp/verify`. Server bcrypt-checks `auth-key`. Session cookie via `itsdangerous`, `Secure`/`HttpOnly`/`SameSite=Strict`.
   - `dependencies.py` — `get_current_user` Depends, `get_current_user_or_401`. CSRF token middleware.
   - `email.py` — confirmation email sending via Resend HTTP API; in dev fallback to logging the link.
9. **Apply auth to all existing routes.** Add `Depends(get_current_user_or_401)` to every endpoint kept in [backend/app/api/routes/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/api/routes/). Scope every query by `user_id` in services. Files to scope: `domains.py`, `servers.py`, `cloudflare.py`, `registrars.py`, `notifications.py`, `settings.py`, `tasks.py`, `ssl_emails.py`. Update corresponding services in [backend/app/services/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/).
10. **Delete server-side execution endpoints and tasks** (per spec § 6). In `domains.py`: remove `/provision`, `/create-site`, `/bulk-provision`, `/bulk-full-setup`, `/create-db`, `/ssl-request`, `/ssl-cancel`, `/refresh-ssl`, `/nginx-override` (POST), `/check-ns`, `/set-ns`, `/bulk-set-ns`, `/mark-ns-set`. In `servers.py`: remove `/test-ssh`, `/refresh-metrics`, `/refresh-uptime`, `/sync-domains`, `/install-fastpanel`, `/fastpanel-status`. In `cloudflare.py`: remove zone/DNS endpoints. In `registrars.py`: remove test/list/set-ns. Delete files entirely: [backend/app/services/encryption_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/encryption_service.py), [fastpanel_client.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/fastpanel_client.py), [fastpanel_browser.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/fastpanel_browser.py), [cloudflare_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/cloudflare_service.py), [registrars/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/registrars/), [server_metrics_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/server_metrics_service.py), [temp_mail_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/temp_mail_service.py), [ssl_email_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/ssl_email_service.py), and all SSH-touching tasks under [backend/app/tasks/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/tasks/) except [renewal_task.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/tasks/renewal_task.py). Drop `ENCRYPTION_KEY` from [backend/app/core/config.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/core/config.py) (not required anymore).
11. **Sync API** at `backend/app/sync/`:
   - `routes.py` — `GET /sync/snapshot`, `GET /sync/changes?since=<v>`, `POST /sync/upload`. Per-user `current_version` from `sync_state`, monotonic increment in transaction.
   - `service.py` — diff metadata rows + blobs by `version > since`; conflict detection on upload (`version_seen` mismatch returns conflict, no write).
12. **Blob CRUD** at `backend/app/blobs/`: endpoints `PUT /blobs/{id}`, `GET /blobs/{id}`, `DELETE /blobs/{id}` with strict `user_id` ownership. Ciphertext is opaque bytea. Size limit 64 KiB per blob.
13. **Rate limiting** via `slowapi`: per-IP on `/auth/login` (10/min), per-user on `/sync/upload` (60/min). Backend uses Redis storage (existing).
14. **Lock CORS.** Update [backend/app/main.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/main.py) `BACKEND_CORS_ORIGINS` to require explicit values; remove `allow_methods=["*"]` and `allow_headers=["*"]` in favor of strict allowlists.
15. **Backend tests** at [backend/tests/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/tests/):
   - `test_auth.py` — register, login, password change, recovery, TOTP, email confirm.
   - `test_sync.py` — full snapshot, incremental, conflict, version monotonicity.
   - `test_blobs.py` — CRUD, ownership enforcement (user A cannot read user B's blob), size limit.
   - `test_user_scoping.py` — user A cannot see user B's domains/servers/etc through any kept endpoint.
   - `test_rate_limit.py` — auth and upload rate limits.

**Verify:** `pytest backend/tests` green; `alembic upgrade head` runs cleanly on a fresh DB; `curl /api/auth/register` round-trip works; backend starts with `EXPECTED_ALEMBIC_HEAD = "011_zero_knowledge_v1"`.

---

## Stage 2 — Tauri shell + crypto + sync client (10-12 days)

**Goal:** Desktop app boots, user can register, log in, see metadata-only views synced from server. No SSH execution yet.

16. **Crypto module** in `desktop/src-tauri/src/crypto/`:
   - `kdf.rs` — Argon2id wrapper (`t=3, m=64MiB, p=4`); two contexts (`auth` and `enc`) derived via per-context label appended to password, hashed independently.
   - `aead.rs` — XChaCha20-Poly1305 encrypt/decrypt; per-blob random 24-byte nonce; layout `nonce || ciphertext || tag`.
   - `bip39.rs` — generate 24-word phrase, derive recovery key, wrap/unwrap master key.
   - Unit tests with libsodium known-answer vectors.
17. **Keychain integration** in `desktop/src-tauri/src/keychain/`: store/retrieve master key by user_id; backed by macOS Keychain, Windows Credential Manager, Linux Secret Service via `keyring` crate.
18. **Local cache** in `desktop/src-tauri/src/sync/cache.rs`: SQLite via `rusqlite` with `bundled-sqlcipher`; cache key = derived sub-key from master key. Schema mirrors server metadata tables. Plaintext blobs **never** written to disk; held only in memory after decrypt.
19. **Sync client** in `desktop/src-tauri/src/sync/client.rs`: `pull()`, `push()`, periodic background sync every 60s while app is active. Conflict surfacing via Tauri event to UI.
20. **Tauri commands** in `desktop/src-tauri/src/commands/`:
   - `auth_register`, `auth_login`, `auth_logout`, `auth_change_password`, `auth_recovery`, `totp_enroll`, `totp_verify`.
   - `vault_list_blobs`, `vault_decrypt_blob` (returns plaintext only to in-memory frontend; never persisted), `vault_create_blob`, `vault_update_blob`, `vault_delete_blob`.
   - `sync_now`, `sync_state`.
   - All commands callable from React via `@tauri-apps/api/core::invoke`.
21. **Frontend auth flow** — new pages under [frontend/src/pages/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/): `Register.tsx`, `Login.tsx`, `RecoverySetup.tsx` (BIP39 display + force-typed-back verification of 4 random words), `RecoveryRestore.tsx`, `Lock.tsx` (master password prompt for unlock). zustand store at `frontend/src/store/auth.ts` for session + unlock state. React-router routes guarded by `RequireAuth`.
22. **Refactor existing pages to use sync data, not direct REST.** [frontend/src/api/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/api/) gets a new `vault.ts` layer that calls Tauri commands when running in desktop, falls back to fetch + manual decrypt when running in web. Existing `domains.ts`, `servers.ts`, etc. reuse the same backend GET endpoints (now scoped) but read blob fields as references and resolve via `vault.decrypt(blob_id)`.
23. **Web vs desktop runtime detection** — single helper `frontend/src/lib/runtime.ts`: `isTauri()` boolean used to gate features. Web shows "Open in desktop" CTA via `sdmp://` URL scheme on any mutation/execute action.

**Verify:** desktop app launches; user can register on local backend, see BIP39 phrase, log in, lock and unlock. SQLite cache file is encrypted (verify with sqlite3 cli — should fail without key). Master key only in memory + OS keychain. Web app on localhost shows same metadata after login.

---

## Stage 3 — Desktop SSH + integrations (15 days)

**Goal:** Desktop can perform every operation the current backend does — but locally, with decrypted secrets in memory only.

24. **SSH client** in `desktop/src-tauri/src/ssh/client.rs` using `russh`:
   - Strict host-key checking against per-user `known_hosts` file in `app_data/ssh/known_hosts`.
   - First-connect: emit `ssh:host-key-prompt` Tauri event; UI shows fingerprint + accept/reject; on accept, persist to `known_hosts`.
   - Mid-flight host key change: hard reject, surface error.
   - Auth methods: password (decrypted from blob in memory) and key (path or in-memory PEM, also from blob).
   - Run command, get output + exit code; PTY support for long-running tasks.
25. **Port FastPanel logic** to Rust at `desktop/src-tauri/src/ssh/fastpanel.rs`. Mirror functions from the deleted [backend/app/services/fastpanel_client.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/fastpanel_client.py): `get_fastpanel_path`, `create_site`, `create_ftp_account`, `create_database`, `revoke_ssl_certificate`, `read_ssl_info`, `apply_nginx_override`, `dns_resolves_to`, `ensure_ports_open`, `list_sites`. Use `shlex` equivalent (`shell-escape` crate) for command quoting; same regex parsing.
26. **Cloudflare client** in `desktop/src-tauri/src/cloudflare/client.rs`. Mirror endpoints from deleted [backend/app/services/cloudflare_service.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/cloudflare_service.py) using `reqwest`: account verify, list zones, get zone, list/create/update/delete DNS records, purge cache, get nameservers. API token decrypted from blob right before call, zeroized after.
27. **Registrar clients** in `desktop/src-tauri/src/registrars/`: `hostiq.rs`, `namecheap.rs`, factory in `mod.rs`. Mirror methods from deleted [backend/app/services/registrars/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/registrars/): `test_connection`, `get_domains`, `set_nameservers`, `get_nameservers`. Namecheap XML parsing via `quick-xml`.
28. **Provision flow** in `desktop/src-tauri/src/provision/`:
   - `domain.rs` — port logic from deleted [backend/app/tasks/provision_task.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/tasks/provision_task.py): site → FTP → SSL pipeline, DNS pre-check, SSL email pool (now per-user, stored as blob list), audit log entries pushed to server.
   - `fastpanel_install.rs` — port from deleted [backend/app/tasks/fastpanel_task.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/tasks/fastpanel_task.py): system update + `wget … | bash -` + credentials parse with regex; **add idempotency guard** (refuse install if `fastpanel_status == "installed"`).
   - `bulk.rs` — bulk-full-setup, bulk-set-ns, bulk-provision, with **idempotency keys** (per `(action, domain_id)`) so double-click in UI does not double-execute.
29. **Tauri commands for execution** — `provision_domain`, `provision_bulk`, `install_fastpanel`, `set_nameservers`, `cf_create_zone`, `cf_set_dns`, `nginx_override`, etc. Each command opens an in-memory progress channel that streams to the UI via Tauri events; entries are mirrored to server audit log (sanitized: no plaintext secrets).
30. **Re-enable execute UI on desktop only.** [frontend/src/components/BulkActionToolbar.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/components/BulkActionToolbar.tsx), [BulkSetupWizard.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/components/BulkSetupWizard.tsx), [TaskProgressModal.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/components/TaskProgressModal.tsx), [MultiTaskProgressModal.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/components/MultiTaskProgressModal.tsx) — wire to Tauri commands instead of REST, gate via `isTauri()`.
31. **Rust integration tests** with `linuxserver/openssh-server` Docker container as SSH target: provision happy-path, host-key TOFU + reject-on-change, command execution, error paths.

**Verify:** From the desktop app, run end-to-end on a real Hetzner test VPS: install FastPanel, add domain, link Cloudflare, provision, confirm SSL is issued. Audit log on server shows action entries without secret material. Web app shows same domain in "active" status, but execute buttons are absent.

---

## Stage 4 — Web read-only refactor (5-6 days)

**Goal:** Web is a clean read-only dashboard. No execution, no half-broken buttons.

32. **Strip execute buttons from web pages.** In [frontend/src/pages/Domains.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/Domains.tsx), [Servers.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/Servers.tsx), [ServerDetail.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/ServerDetail.tsx), [Cloudflare.tsx](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/Cloudflare.tsx) — wrap every action button in `{isTauri() ? <Button …/> : <OpenInDesktopHint /> }`. Bulk import + CRUD on metadata are kept on web (no secrets involved).
33. **Web blob unlock UX** — for "show secret" actions (view FTP password, copy SSH password to clipboard), prompt user for master password, derive key in browser, decrypt the specific blob in-memory, auto-clear from memory after 30s. Use `sessionStorage` for an unlock-session token (which is itself a wrapped key derivable only with a fresh prompt). Never persist plaintext.
34. **Deep links** — register `sdmp://` URL scheme in Tauri (`tauri.conf.json`). Web "Open in desktop" CTAs build URLs like `sdmp://provision/domain/123` and the desktop app handles them on launch, navigating to the right view.
35. **Lock down CORS at the proxy** — update [nginx/nginx.conf](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/nginx/nginx.conf) to set explicit `Access-Control-Allow-Origin` for the production web origin only. Add CSP and `X-Frame-Options: DENY` headers.

**Verify:** open web app in private browsing, log in, see all metadata views work, observe execute buttons replaced with "Open in desktop" CTA. Click CTA → desktop opens to correct view.

---

## Stage 5 — Cleanup, tests, install assets, launch prep (5-7 days)

**Goal:** Ship-ready bundle.

36. **Audit log polishing** — every Tauri execution command writes to server audit log via `POST /api/audit/log`; ensure `metadata` jsonb never contains plaintext (no `ssh_password`, no full SQL with passwords, etc.). Rotate `task_logs.log_text` retention to 30 days via daily Celery task.
37. **End-to-end test** with Playwright for web (login + read-only navigation) and a scripted Tauri test for desktop (register → BIP39 → add server → provision against `linuxserver/openssh-server` mock → audit log appears in web).
38. **Vitest** unit tests for frontend stores and runtime helpers. Establish coverage floor of 70% on `frontend/src/store/`, `frontend/src/lib/`.
39. **Build artifacts** — Tauri bundle for macOS Intel + Apple Silicon (`.dmg`, unsigned), Windows x64 (`.exe`, NSIS installer, unsigned), Linux x64 (`.AppImage`). CI workflow at `.github/workflows/release.yml` matrix-builds and uploads to GitHub Releases. SHA256 checksums published on website.
40. **Backend production deploy** — Hetzner CCX13 + Caddy reverse proxy with auto-Let's-Encrypt; backend behind `tunnel.cloudflare.com` for DDoS protection. Postgres self-hosted on same VPS with WAL-G backups to Cloudflare R2 every 15 min. `docker-compose.prod.yml` separate from dev. Env via `doppler` (free tier).
41. **Status page** at `status.<your-domain>` via `betteruptime.com` free tier (5 monitors).
42. **Email** via Resend; SPF/DKIM/DMARC for sending domain.
43. **Documentation** — `docs/INSTALL.md` (unsigned warning bypass, screenshots), `docs/SECURITY.md` (zero-knowledge model explained), `docs/RECOVERY.md` (BIP39 storage recommendations), `security.txt` at well-known path.
44. **Final sweep** — search the codebase for `paramiko`, `encryption_service`, `temp_mail`, `ssl_email`, `AutoAddPolicy` — should return zero hits in `backend/`. Search for `decrypt`, `ENCRYPTION_KEY` — should return zero hits in `backend/`. Confirm `EXPECTED_ALEMBIC_HEAD = "011_zero_knowledge_v1"`. Run `pytest backend/tests` (target green), `cargo test` in `desktop/src-tauri` (target green), `vitest` + `playwright` in frontend (target green).

---

## Verification (acceptance scenarios)

Run all 11 from spec § 13 against a real test environment (Hetzner VPS as SSH target, real Cloudflare account, real domain in test registrar):

1. Download Tauri app from website (unsigned), bypass Gatekeeper / SmartScreen, install.
2. Register account with email + master password; receive BIP39, save, type back 4 random words to confirm.
3. Confirm email via link, log in.
4. Add a server with SSH password; password stored only as ciphertext blob — verify directly in DB that no plaintext column exists.
5. Test SSH connection from desktop; confirm host-key fingerprint prompt; accept; second connection has no prompt.
6. Add a domain, link to server, link to a Cloudflare account, link to a registrar.
7. Run end-to-end provision from desktop: site + FTP + DB + SSL.
8. Watch real-time progress in desktop UI; confirm server audit log records action without secret material (grep server audit table for known password — must not appear).
9. Open web app on a second device, log in with same credentials, see same domain/server list and audit log (read-only). Confirm execute buttons not present.
10. Lose master password; recover with BIP39 phrase; set new password; confirm all blobs still decryptable.
11. Change master password while logged in; confirm all blobs re-encrypted; recovery phrase still works (independent of master password).

Backend infrastructure verification:
- Try unauthenticated `GET /api/domains` → must return 401
- Try authenticated `GET /api/domains` as user A with user B's domain ID → must return 404 (not 403, to avoid existence leakage)
- Tamper one byte of a blob's ciphertext in DB; client must reject decrypt with AEAD error (not silently succeed)
- Search backend logs and `task_logs` table for any of: known SSH password, known API token, known FTP password — must find zero matches

---

## Open items to decide later (not blockers for MVP)

- Code signing (Apple Developer + Windows EV) — defer per user decision; document upgrade path in `docs/SECURITY.md`
- Phase 3 features (background agent, scheduled SSL refresh, Stripe billing, teams) — separate spec after MVP feedback
- Web execution mode (WebSSH / short-lived session key) — only if user demand surfaces
- Hardware-backed key storage (TPM, Secure Enclave) — post-MVP enhancement
- Migration of any pre-existing dev data to new schema — destructive migration assumes empty state; if not empty, write a one-off script per spec

---

## Critical files

**Backend (modify):**
- [backend/app/main.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/main.py) — alembic head constant, CORS lockdown, lifespan
- [backend/app/api/routes/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/api/routes/) — every file (add auth, scope, remove SSH endpoints)
- [backend/app/services/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/services/) — delete encryption/SSH services, scope rest by user
- [backend/app/core/config.py](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/app/core/config.py) — drop ENCRYPTION_KEY, add session/email/argon2 settings
- [backend/alembic/versions/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/backend/alembic/versions/) — new `011_zero_knowledge_v1.py`

**Backend (new):**
- `backend/app/auth/` — auth module
- `backend/app/sync/` — sync module
- `backend/app/blobs/` — blob CRUD
- `backend/tests/test_auth.py`, `test_sync.py`, `test_blobs.py`, `test_user_scoping.py`, `test_rate_limit.py`

**Frontend (modify):**
- [frontend/src/api/client.ts](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/api/client.ts) — session cookie + CSRF
- [frontend/src/pages/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/pages/) — add auth pages, gate execute UI
- [frontend/src/components/](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/frontend/src/components/) — convert bulk/progress modals to Tauri-aware
- `frontend/package.json` — add `vitest`, `@playwright/test`

**Frontend (new):**
- `frontend/src/store/auth.ts` — zustand auth+unlock store
- `frontend/src/lib/runtime.ts`, `vault.ts` — Tauri detection + blob decrypt helper
- `frontend/src/pages/Register.tsx`, `Login.tsx`, `RecoverySetup.tsx`, `RecoveryRestore.tsx`, `Lock.tsx`

**Desktop (entirely new):**
- `desktop/` — full Tauri 2 project
- `desktop/src-tauri/src/{crypto,keychain,sync,ssh,cloudflare,registrars,provision,commands}/`
- `desktop/src-tauri/Cargo.toml`, `tauri.conf.json`

**Docs (new/modify):**
- `docs/INSTALL.md`, `docs/SECURITY.md`, `docs/RECOVERY.md`, `.well-known/security.txt`
- Existing [docs/superpowers/specs/2026-05-06-zero-knowledge-launch-mvp-design.md](/Users/andrey/Documents/Python/FS_cursor/.claude/worktrees/agitated-mclean-2fcfd1/docs/superpowers/specs/2026-05-06-zero-knowledge-launch-mvp-design.md) — note migration number correction (010 → 011) when next edit

**Infra (new):**
- `docker-compose.prod.yml` for Hetzner deploy
- `.github/workflows/release.yml` for matrix Tauri builds
- `nginx/nginx.conf` lockdown updates
