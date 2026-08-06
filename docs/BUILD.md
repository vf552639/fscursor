# Building SDMP (macOS)

How to produce a local `.dmg` of the desktop shell. For installing an already-built
`.dmg` (Gatekeeper bypass, checksums), see [`INSTALL.md`](INSTALL.md) instead — this
page is about producing the artifact, not consuming one.

## Prerequisites

- [Rust](https://rustup.rs/) (`cargo`, `rustc`) with the macOS target for your Mac:
  `aarch64-apple-darwin` on Apple Silicon, `x86_64-apple-darwin` on Intel. Install via
  `rustup target add <target>` if missing — the build script's preflight check tells
  you which one, *if* `rustup` itself is on your `PATH`; without it, the check is
  skipped and a missing target only surfaces once `tauri build` fails.
- Node.js and npm.
- Backend running on `localhost:8100` — only needed to actually *use* the app after
  building (see below), not to build it.

npm dependencies (`desktop/node_modules`, `frontend/node_modules`) are installed
automatically by the build script if missing.

## Build

From the repo root:

```
./desktop/scripts/build-dmg.sh
```

Equivalently, from `desktop/`: `npm run dmg`.

This runs a preflight check (toolchain, rustup target, disk space), installs npm
dependencies if missing, validates the `version` field in `tauri.conf.json`, then runs
`tauri build --bundles app,dmg` for your host architecture only — no Windows/Linux
bundles, no universal binary. (`app` is not optional: with `--bundles dmg` alone Tauri
wipes `bundle/macos/` after packing the image and no `SDMP.app` is left behind.) By
default it only builds and prints the artifact paths; it does not open the app.

Other modes:

```
./desktop/scripts/build-dmg.sh --run       # build, then open the resulting .app
./desktop/scripts/build-dmg.sh --check     # preflight only, no build
./desktop/scripts/build-dmg.sh -h|--help   # usage
```

If the build fails during the frontend step, check the `tsc` output — that means
type errors in `frontend/`, not a problem with the build script.

## Apple events / Finder permission

The DMG packer (`bundle_dmg.sh`) drives Finder through `osascript` purely to lay out
the icons inside the DMG window. If the process running the build has no Automation →
Finder permission (agent shells, ssh, CI, a freshly installed terminal), that step
fails with `Not authorised to send Apple events to Finder. (-1743)`, and Tauri reports
only a terse `failed to bundle project`.

The build script handles this itself: it detects the failure and retries the build once
with `CI=true`, which makes Tauri skip the cosmetic AppleScript. You get a warning and a
working `.dmg`/`.app` — only the window layout of the mounted DMG is plain. To get the
pretty layout, grant your terminal/IDE access under System Settings → Privacy & Security
→ Automation → Finder and build again. If the retry fails too, the cause was something
else and the script reports an honest error (and keeps the full build log, printing its
path).

Note the flip side: if `CI` is already set to `true` in your environment, the very first
build skips the AppleScript — you get a plain DMG window layout with no warning at all,
because nothing failed.

## Artifacts

```
desktop/src-tauri/target/release/bundle/dmg/SDMP_<version>_<arch>.dmg
desktop/src-tauri/target/release/bundle/macos/SDMP.app
```

## Running the app

Either:

```
open desktop/src-tauri/target/release/bundle/macos/SDMP.app
```

or mount the `.dmg` and drag `SDMP.app` into `Applications`.

A locally built `.app` does **not** carry the `com.apple.quarantine` attribute (that's
only added when a file is downloaded through a browser or messenger), so it opens with
a normal double-click — no Gatekeeper right-click dance. That dance is only for a
`.dmg` someone *downloaded*, and it's already covered in [`INSTALL.md`](INSTALL.md).

The app talks to `http://localhost:8100/api` by default; the `SDMP_API_URL` env var
overrides this and it already works today (all API calls from the desktop shell go
through the Rust `api_request` command, not the webview's own `fetch`, so the CSP
`connect-src` allowlist doesn't gate them). Without a backend listening there, the app
opens but shows an empty screen or a network error — that's expected, not a build
problem.

## Not yet in scope

Apple signing/notarization, a universal (`aarch64`+`x86_64`) binary, Windows/Linux
bundles, and a CI workflow producing checksums are all deferred — see `plan.md` /
`stage5.md`. Making the CSP `connect-src` allowlist itself configurable (it's
currently fixed to `localhost:8100` and `*.sdmp.app`) is tracked separately in
`plans/2026-08-04-local-dmg-build.md`.
