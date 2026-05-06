# SDMP Zero-Knowledge MVP — Master Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement these plans stage-by-stage.

**Spec:** [2026-05-06-zero-knowledge-launch-mvp-design.md](../specs/2026-05-06-zero-knowledge-launch-mvp-design.md)

**Goal:** Re-architect SDMP into a 1Password-style zero-knowledge product so it can be sold commercially without exposing customer secrets to a server breach.

**Total estimate:** 9-10 weeks solo, sequential stages with limited overlap.

---

## Stage roadmap

| Stage | Plan                                                                                    | Duration   | Goal                                                                              | Status   |
| ----- | --------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- | -------- |
| 0     | [stage-0-foundation.md](./2026-05-06-stage-0-foundation.md)                             | 3-5 days   | Bootstrap Tauri project, fix stale Alembic head, prep deps                        | Detailed |
| 1     | [stage-1-auth-sync-server.md](./2026-05-06-stage-1-auth-sync-server.md)                 | 10-12 days | Backend auth, sync API, blob storage, migration `011`, user-scoping all routes    | Detailed |
| 2     | [stage-2-tauri-crypto-sync-client.md](./2026-05-06-stage-2-tauri-crypto-sync-client.md) | 10-12 days | Crypto module, OS keychain, BIP39, encrypted SQLite cache, sync client, auth UI   | Detailed |
| 3     | [stage-3-desktop-ssh-integrations.md](./2026-05-06-stage-3-desktop-ssh-integrations.md) | 15 days    | Port FastPanel/Cloudflare/registrars Python → Rust, provision flow, host-key TOFU | Detailed |
| 4     | [stage-4-web-readonly-refactor.md](./2026-05-06-stage-4-web-readonly-refactor.md)       | 5-6 days   | Strip execute UI from web, add deep-link CTAs, lock down nginx                    | Detailed |
| 5     | [stage-5-launch-prep.md](./2026-05-06-stage-5-launch-prep.md)                           | 5-7 days   | E2E tests, build artifacts, prod deploy, docs, security.txt                       | Detailed |

---

## Architecture summary

Three logical components:

1. **Sync Server** (refactored existing FastAPI in `backend/`) — auth, metadata storage, opaque blob storage, audit log, non-sensitive scheduled jobs. Cannot decrypt secrets.
2. **Tauri Desktop App** (new, in `desktop/`) — primary client. Holds master key in OS keychain. Performs all SSH/Cloudflare/registrar operations locally with secrets decrypted in memory only.
3. **Web App** (refactored existing React in `frontend/`) — read-only dashboard, syncs same data, surfaces "Open in desktop" CTAs for any execute action.

## Tech stack

- **Backend:** FastAPI, SQLAlchemy async, Alembic, Celery, Postgres (Supabase pooler in dev, Hetzner in prod), Redis, libsodium-via-`argon2-cffi`, `slowapi` rate limiting, `itsdangerous` signed cookies.
- **Desktop:** Tauri 2, Rust 1.80+, `russh` (SSH), `dryoc` (libsodium for Argon2id + XChaCha20-Poly1305), `keyring` (OS keychain), `rusqlite` with `bundled-sqlcipher`, `tiny-bip39`, `tokio`, `reqwest`.
- **Frontend:** React 18, TypeScript, Vite, TanStack Query, zustand, react-router-dom 6, Tailwind. New: `@tauri-apps/api`.
- **Tests:** `pytest` (backend), `cargo test` + Tauri integration harness (desktop), `vitest` + `@playwright/test` (frontend).
- **Crypto choices:** Argon2id `t=3 m=64MiB p=4`, XChaCha20-Poly1305 AEAD, BIP39 24-word recovery phrase, server bcrypt over auth-key for transit defense-in-depth.
- **No Electron, no PHP, no Python on desktop** — Rust required by Tauri and chosen for memory safety with secrets.

## Conventions

- **TDD:** every behavior is a failing test first. Backend uses `pytest`, desktop Rust uses `cargo test` with `#[test]`, frontend uses `vitest`.
- **Commits:** small and frequent. One commit per task or sub-task. Commit message format: `<area>(<scope>): <imperative>`. Examples: `feat(auth): add register endpoint`, `test(sync): cover incremental conflict`, `refactor(domains): scope queries by user_id`.
- **No new branches per task** — work directly on the single feature branch (the worktree already isolates from master).
- **Never skip pre-commit hooks** without explicit user approval.
- **Audit log invariant:** every server-side mutation must write to `audit_log`. Tests must assert audit entries.
- **Plaintext invariant:** no plaintext secret may be persisted on the server. Tests must scan logs and DB for known test passwords/tokens after every flow.

## Cross-stage decisions (locked)

- **Code signing deferred.** Unsigned `.dmg` and `.exe`. Stage 5 documents Gatekeeper / SmartScreen bypass UX.
- **Web is read-only.** All execute actions live in the desktop app only. WebSSH/proxy modes are explicitly out of scope.
- **Recovery key model:** BIP39 24-word phrase. Loss of master password + loss of recovery phrase = irrecoverable data loss. Documented in onboarding.
- **Server uses migration `011_zero_knowledge_v1`** — actual current Alembic head is `010_domain_extras`, not `009_phpversion_widen` as stale `EXPECTED_ALEMBIC_HEAD` suggests. Fix in Stage 0.
- **Single user per account in MVP** — no team/RBAC. Phase 3 (out of scope here) adds teams.

## Acceptance criteria (whole project)

See [spec § 13](../specs/2026-05-06-zero-knowledge-launch-mvp-design.md#13-acceptance-criteria-for-this-mvp) for the 11-step acceptance scenario. Stage 5 verification runs all 11 against a real Hetzner test VPS + real Cloudflare account + real domain.
