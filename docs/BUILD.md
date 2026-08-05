# Building SDMP (macOS)

How to produce a local `.dmg` of the desktop shell. For installing an already-built
`.dmg` (Gatekeeper bypass, checksums), see [`INSTALL.md`](INSTALL.md) instead — this
page is about producing the artifact, not consuming one.

## Prerequisites

- [Rust](https://rustup.rs/) (`cargo`, `rustc`) with the macOS target for your Mac:
  `aarch64-apple-darwin` on Apple Silicon, `x86_64-apple-darwin` on Intel. Install via
  `rustup target add <target>` if missing — the build script's preflight check tells
  you which one.
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

This runs a preflight check (toolchain, disk space, `tauri.conf.json` version), then
`tauri build --bundles dmg` for your host architecture only — no Windows/Linux
bundles, no universal binary. By default it only builds and prints the artifact
paths; it does not open the app.

Other modes:

```
./desktop/scripts/build-dmg.sh --run     # build, then open the resulting .app
./desktop/scripts/build-dmg.sh --check   # preflight only, no build
./desktop/scripts/build-dmg.sh --help    # usage
```

If the build fails during the frontend step, check the `tsc` output — that means
type errors in `frontend/`, not a problem with the build script.

## Artifacts

```
desktop/src-tauri/target/release/bundle/dmg/SDMP_<version>_<arch>.dmg
desktop/src-tauri/target/release/bundle/macos/SDMP.app
```

## Running the build

Either:

```
open desktop/src-tauri/target/release/bundle/macos/SDMP.app
```

or mount the `.dmg` and drag `SDMP.app` into `Applications`.

A locally built `.app` does **not** carry the `com.apple.quarantine` attribute (that's
only added when a file is downloaded through a browser or messenger), so it opens with
a normal double-click — no Gatekeeper right-click dance. That dance is only for a
`.dmg` someone *downloaded*, and it's already covered in [`INSTALL.md`](INSTALL.md).

The app talks to `http://localhost:8100/api` by default (`SDMP_API_URL` env var
overrides it). Without a backend listening there, the app opens but shows an empty
screen or a network error — that's expected, not a build problem.

## Not yet in scope

Apple signing/notarization, a universal (`aarch64`+`x86_64`) binary, Windows/Linux
bundles, a CI workflow producing checksums, and a configurable backend URL/CSP are all
deferred — see `plan.md` / `stage5.md`.
