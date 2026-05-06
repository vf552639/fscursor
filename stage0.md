# Stage 0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unblock all downstream stages: bootstrap the Tauri 2 project, fix the stale Alembic head constant, install backend dependencies, document the unsigned-install UX. No feature behavior yet.

**Architecture:** Add a new top-level `desktop/` directory containing a Tauri 2 project that loads the existing `frontend/` React UI in WebView. Existing `backend/` gets new pinned dependencies (Argon2id, slowapi, signed cookies) and a corrected `EXPECTED_ALEMBIC_HEAD` constant. No code paths change behavior; this is scaffolding only.

**Tech Stack:** Tauri 2, Rust 1.80+, Cargo workspace, Python 3.11, FastAPI, pip-compile, alembic.

---

## Task 1: Fix stale `EXPECTED_ALEMBIC_HEAD`

The actual head migration is `010_domain_extras`, but `backend/app/main.py` still expects `009_phpversion_widen`. The lifespan check rejects boots with the correct head. This is a pre-existing bug that blocks all backend work.

**Files:**
- Modify: `backend/app/main.py:16`
- Test: `backend/tests/test_lifespan.py` (new)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_lifespan.py`:

```python
import pytest
from sqlalchemy import text

from app.core.database import engine
from app.main import EXPECTED_ALEMBIC_HEAD


@pytest.mark.asyncio
async def test_expected_alembic_head_matches_actual_db_head():
    """The constant must match the actual head Alembic upgrades to."""
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT version_num FROM alembic_version"))
        row = result.fetchone()
    assert row is not None, "alembic_version is empty - run alembic upgrade head"
    assert row[0] == EXPECTED_ALEMBIC_HEAD, (
        f"DB at {row[0]!r} but EXPECTED_ALEMBIC_HEAD={EXPECTED_ALEMBIC_HEAD!r}"
    )
```

- [ ] **Step 2: Run test, expect FAIL**

```bash
cd backend && pytest tests/test_lifespan.py -v
```

Expected: FAIL with `AssertionError: DB at '010_domain_extras' but EXPECTED_ALEMBIC_HEAD='009_phpversion_widen'`.

- [ ] **Step 3: Update the constant**

Edit `backend/app/main.py` line 16:

```python
EXPECTED_ALEMBIC_HEAD = "010_domain_extras"
```

- [ ] **Step 4: Run test, expect PASS**

```bash
cd backend && pytest tests/test_lifespan.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/main.py backend/tests/test_lifespan.py
git commit -m "fix(main): align EXPECTED_ALEMBIC_HEAD with actual head 010_domain_extras"
```

---

## Task 2: Add new backend dependencies

Lock pinned versions for everything Stage 1 needs. Doing this in Stage 0 means Stage 1's tasks can `pip install -r requirements.txt` and proceed without dep churn.

**Files:**
- Modify: `backend/requirements.txt`

- [ ] **Step 1: Read current `requirements.txt`**

```bash
cat backend/requirements.txt
```

Note current versions to avoid clobbering.

- [ ] **Step 2: Append new deps with explicit versions**

Append to `backend/requirements.txt`:

```
argon2-cffi==23.1.0
bcrypt==4.2.0
itsdangerous==2.2.0
slowapi==0.1.9
pyotp==2.9.0
email-validator==2.2.0
resend==2.4.0
```

Versions are the latest stable as of 2026-05-06. Pin exactly to prevent surprise upgrades.

- [ ] **Step 3: Install and verify**

```bash
cd backend && pip install -r requirements.txt
python -c "import argon2, bcrypt, itsdangerous, slowapi, pyotp, resend; print('ok')"
```

Expected: prints `ok`.

- [ ] **Step 4: Commit**

```bash
git add backend/requirements.txt
git commit -m "chore(deps): add argon2-cffi, bcrypt, itsdangerous, slowapi, pyotp, resend, email-validator"
```

---

## Task 3: Bootstrap Tauri 2 project skeleton

Create the `desktop/` directory at repo root with a minimal Tauri 2 project that loads the existing `frontend/` source. No feature commands yet — just a working window that displays the existing React app.

**Files:**
- Create: `desktop/src-tauri/Cargo.toml`
- Create: `desktop/src-tauri/tauri.conf.json`
- Create: `desktop/src-tauri/build.rs`
- Create: `desktop/src-tauri/src/main.rs`
- Create: `desktop/src-tauri/src/lib.rs`
- Create: `desktop/src-tauri/icons/` (placeholder PNGs, generated below)
- Create: `desktop/package.json` (for Tauri CLI)
- Modify: `.gitignore` (ignore `target/`, `desktop/dist/`)

- [ ] **Step 1: Verify Rust toolchain**

```bash
rustc --version
```

Expected: `rustc 1.80.0` or newer. If older or missing, install via `rustup toolchain install stable`.

- [ ] **Step 2: Install Tauri CLI**

```bash
cargo install tauri-cli --version "^2.0" --locked
tauri --version
```

Expected: `tauri-cli 2.x.x`.

- [ ] **Step 3: Create `desktop/src-tauri/Cargo.toml`**

```toml
[package]
name = "sdmp-desktop"
version = "0.1.0"
edition = "2021"
rust-version = "1.80"

[lib]
name = "sdmp_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }

# Crypto and storage (used in Stage 2; pin now to keep workspace consistent)
dryoc = "0.6"
keyring = "3"
rusqlite = { version = "0.32", features = ["bundled-sqlcipher"] }
tiny-bip39 = "1"
zeroize = { version = "1.8", features = ["derive"] }

# SSH and HTTP (used in Stage 3)
russh = "0.45"
russh-keys = "0.45"
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
quick-xml = { version = "0.36", features = ["serialize"] }
shell-escape = "0.1"

# Logging
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

- [ ] **Step 4: Create `desktop/src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 5: Create `desktop/src-tauri/src/main.rs`**

```rust
// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sdmp_desktop_lib::run()
}
```

- [ ] **Step 6: Create `desktop/src-tauri/src/lib.rs`**

```rust
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 7: Create `desktop/src-tauri/tauri.conf.json`**

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/schema.json",
  "productName": "SDMP",
  "version": "0.1.0",
  "identifier": "com.sdmp.desktop",
  "build": {
    "beforeDevCommand": "cd ../frontend && npm run dev -- --port 1420",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "cd ../frontend && npm run build",
    "frontendDist": "../frontend/dist"
  },
  "app": {
    "windows": [
      {
        "title": "SDMP",
        "width": 1280,
        "height": 800,
        "minWidth": 960,
        "minHeight": 600
      }
    ],
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://localhost:8100 https://*.sdmp.app; img-src 'self' data:"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "nsis", "appimage"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 8: Generate placeholder icons**

```bash
mkdir -p desktop/src-tauri/icons
cd desktop/src-tauri
# Tauri provides a one-time icon scaffolder. Use a black square as placeholder.
python3 -c "
from PIL import Image
img = Image.new('RGB', (1024, 1024), color='black')
img.save('icons/icon.png')
" 2>/dev/null || {
  # Fallback: download a known-good 1024x1024 PNG
  curl -L -o icons/icon.png 'https://placehold.co/1024x1024/000000/FFFFFF/png?text=SDMP'
}
tauri icon icons/icon.png
cd -
```

Expected: produces `32x32.png`, `128x128.png`, `icon.icns`, `icon.ico` in `desktop/src-tauri/icons/`.

- [ ] **Step 9: Create `desktop/package.json` for Tauri CLI helpers**

```json
{
  "name": "sdmp-desktop-shell",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "tauri": "tauri",
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0"
  }
}
```

- [ ] **Step 10: Install Tauri's npm helper**

```bash
cd desktop && npm install
cd -
```

- [ ] **Step 11: Update `.gitignore`**

Append to `.gitignore`:

```
# Tauri / Rust
desktop/src-tauri/target/
desktop/src-tauri/Cargo.lock
desktop/node_modules/
desktop/dist/
```

(Cargo.lock for libraries is ignored by convention; for binaries it's normally checked in. Tauri apps are binaries, so we'll uncheck this exclusion in Stage 5 when we lock release deps. For now leave ignored to avoid noise.)

- [ ] **Step 12: Verify `cargo check`**

```bash
cd desktop/src-tauri && cargo check
```

Expected: compiles successfully with warnings about unused imports (the heavy deps like `russh` and `dryoc` are not yet used). No errors.

- [ ] **Step 13: Verify `tauri dev` boots and loads frontend**

```bash
cd desktop && npm run tauri dev
```

Expected: a window opens displaying the existing SDMP React UI (the same one served at `http://localhost:3100` in dev). The login flow won't work yet because there's no auth — that's Stage 1+2. Just verify the window opens and the dashboard renders.

Press Ctrl+C to stop.

- [ ] **Step 14: Commit**

```bash
git add desktop/ .gitignore
git commit -m "feat(desktop): bootstrap Tauri 2 project loading existing React frontend"
```

---

## Task 4: Add Rust workspace structure for sub-crates

Create empty module files for the security-critical Rust units that will be filled in Stages 2-3. Doing this now keeps each later stage's tasks small and means `cargo check` validates the dependency graph as we go.

**Files:**
- Create: `desktop/src-tauri/src/crypto/mod.rs`
- Create: `desktop/src-tauri/src/crypto/kdf.rs`
- Create: `desktop/src-tauri/src/crypto/aead.rs`
- Create: `desktop/src-tauri/src/crypto/bip39_recovery.rs`
- Create: `desktop/src-tauri/src/keychain/mod.rs`
- Create: `desktop/src-tauri/src/sync/mod.rs`
- Create: `desktop/src-tauri/src/sync/cache.rs`
- Create: `desktop/src-tauri/src/sync/client.rs`
- Create: `desktop/src-tauri/src/ssh/mod.rs`
- Create: `desktop/src-tauri/src/ssh/client.rs`
- Create: `desktop/src-tauri/src/ssh/fastpanel.rs`
- Create: `desktop/src-tauri/src/cloudflare/mod.rs`
- Create: `desktop/src-tauri/src/cloudflare/client.rs`
- Create: `desktop/src-tauri/src/registrars/mod.rs`
- Create: `desktop/src-tauri/src/registrars/hostiq.rs`
- Create: `desktop/src-tauri/src/registrars/namecheap.rs`
- Create: `desktop/src-tauri/src/provision/mod.rs`
- Create: `desktop/src-tauri/src/provision/domain.rs`
- Create: `desktop/src-tauri/src/provision/fastpanel_install.rs`
- Create: `desktop/src-tauri/src/provision/bulk.rs`
- Create: `desktop/src-tauri/src/commands/mod.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (declare modules)

- [ ] **Step 1: Create empty `mod.rs` stubs**

For every directory listed above, create the corresponding `mod.rs` with this content:

```rust
//! Stage <N> module — placeholder. Real implementation follows in Stage <N>'s plan.

// Re-export sub-modules as they're added.
```

For each leaf file (e.g., `kdf.rs`, `aead.rs`, etc.):

```rust
//! TODO(stage-N): Implement per docs/superpowers/plans/2026-05-06-stage-N-*.md
```

(Use this exception to the no-placeholder rule deliberately: these are scaffolding files whose contents are owned by future stage plans — see `desktop/src-tauri/src/crypto/kdf.rs` filled in Stage 2 Task 4.)

- [ ] **Step 2: Wire modules into `lib.rs`**

Replace `desktop/src-tauri/src/lib.rs` with:

```rust
use tracing_subscriber::EnvFilter;

mod cloudflare;
mod commands;
mod crypto;
mod keychain;
mod provision;
mod registrars;
mod ssh;
mod sync;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify `cargo check`**

```bash
cd desktop/src-tauri && cargo check
```

Expected: compiles. Warnings about unused modules are fine.

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/
git commit -m "chore(desktop): scaffold module structure for crypto/ssh/cloudflare/registrars/provision"
```

---

## Task 5: Document unsigned-install UX

Stage 5 will publish `.dmg` and `.exe` artifacts. Without code signing, users will see Gatekeeper / SmartScreen warnings. Write the doc now so Stage 5 has it ready.

**Files:**
- Create: `docs/INSTALL.md`

- [ ] **Step 1: Write `docs/INSTALL.md`**

```markdown
# Installing SDMP

SDMP ships unsigned binaries during the MVP phase. macOS and Windows will warn you because the installer is not yet signed by Apple / Microsoft. This page shows how to bypass the warning safely.

**Always verify the SHA256 checksum before running installers.** Each release publishes checksums on the website at `https://sdmp.app/releases/<version>/checksums.txt`.

## macOS (Apple Silicon and Intel)

1. Download `SDMP-<version>-aarch64.dmg` (Apple Silicon) or `SDMP-<version>-x86_64.dmg` (Intel).
2. Verify checksum:
   ```
   shasum -a 256 ~/Downloads/SDMP-*.dmg
   ```
   Compare with the value on the releases page.
3. Open the `.dmg`. Drag SDMP to Applications.
4. **First launch:** double-clicking will fail with "SDMP cannot be opened because the developer cannot be verified."
5. Right-click (or Ctrl-click) the SDMP icon in Applications → **Open**. Click **Open** again in the prompt. macOS will remember this choice.

## Windows 10/11

1. Download `SDMP-<version>-x64.exe`.
2. Verify checksum (PowerShell):
   ```
   Get-FileHash $env:USERPROFILE\Downloads\SDMP-*.exe -Algorithm SHA256
   ```
3. Double-click the installer. Windows SmartScreen will show "Microsoft Defender SmartScreen prevented an unrecognized app from starting".
4. Click **More info** → **Run anyway**. Windows will remember this choice.

## Linux

The `.AppImage` runs without installation:
```
chmod +x SDMP-<version>-x86_64.AppImage
./SDMP-<version>-x86_64.AppImage
```

## Why the warnings

Code signing certificates are deferred until the MVP has paying customers. Apple Developer Program ($99/year) and a Windows EV Code Signing certificate ($300-500/year) are tracked as a post-MVP improvement. Until then, you bypass the warning manually. **The application binary itself is unchanged from the signed build that will follow** — only the publisher attribution differs.

If you prefer not to bypass OS warnings, the web app at `https://app.sdmp.app` is read-only but lets you view all your data without installing anything.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INSTALL.md
git commit -m "docs: document unsigned-install UX for macOS/Windows/Linux"
```

---

## Stage 0 verification

Run all checks in order. Each should pass before declaring Stage 0 complete.

```bash
# Backend
cd backend
pip install -r requirements.txt
pytest tests/test_lifespan.py -v
# Expected: 1 passed

# Desktop
cd ../desktop/src-tauri
cargo check
# Expected: Finished `dev` profile [unoptimized + debuginfo] target(s)

cd ..
npm run tauri dev &
DEV_PID=$!
sleep 30
kill $DEV_PID 2>/dev/null
# Expected: window opened, frontend rendered

# Docs
test -f ../docs/INSTALL.md && echo "INSTALL.md present"
```

Stage 0 is complete when:
- `pytest backend/tests/test_lifespan.py` passes.
- `cargo check` in `desktop/src-tauri/` succeeds with no errors.
- `npm run tauri dev` opens a window showing the existing frontend.
- `docs/INSTALL.md` exists with macOS, Windows, and Linux instructions.

Move to [Stage 1](./2026-05-06-stage-1-auth-sync-server.md).
