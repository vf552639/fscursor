# Installing SDMP

## Development (from source)

To run the **desktop shell** against the existing Vite app: install [Rust](https://rustup.rs/) and Node.js, then from `desktop/` run `npm install` and `npm run tauri dev`. The Tauri config starts `frontend/` on port **1420** and expects the API (e.g. Docker backend) on **8100** — see `desktop/src-tauri/tauri.conf.json` (`devUrl`, CSP `connect-src`).

---

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
