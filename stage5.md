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
