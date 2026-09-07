# Packaging the desktop app

The app runs as a normal desktop program (no terminal, no browser): a small
Electron shell starts the bundled Next.js server and shows it in a window. All
document reading — including image OCR — happens inside that process, offline.

## Why Windows must be built on Windows

The OCR engine (onnxruntime), the image resizer (sharp) and the OCR canvas are
**native code, compiled per operating system**. `npm install` on a Mac fetches
Mac binaries; on Windows it fetches Windows binaries. So a Windows installer has
to be produced on a Windows machine (or a Windows CI runner) — building it on a
Mac would put Mac binaries inside a Windows app and it would fail to start.

## Build the Windows installer (recommended: GitHub Actions, no Windows PC needed)

1. Put this project in a GitHub repository.
2. Open the repo's **Actions** tab → **Build Windows app** → **Run workflow**.
3. When it finishes, download **windows-installer** from the run's Artifacts.
   That `.exe` is the double-click installer to send to the Windows user.

The workflow is `.github/workflows/build-windows.yml`. It runs on
`windows-latest`, so `npm ci` pulls the correct Windows binaries automatically.

### Or build on any Windows machine directly

```bat
npm ci
npm run dist:win
```

The installer lands in `dist-app\SI-BL Checker-Setup-<version>.exe`.

## Build the Mac app (verified on this machine)

```bash
npm run dist:mac      # produces dist-app/SI-BL Checker-<version>.dmg
npm run app:mac       # unpacked .app for quick local testing, no DMG
```

## What the user does

1. Run the installer once (on Windows, SmartScreen warns about an unsigned app —
   "More info" → "Run anyway"; this goes away if you later buy a signing cert).
2. Launch **SI-BL Checker** from the Start menu / Applications like any program.
3. The first time they compare an **image**, the app downloads ~6 MB of OCR
   models from huggingface.co and caches them. That one step needs internet;
   everything else is fully offline. Word, PDF and Excel need no download.

## Signing (optional, later)

Unsigned apps run but show a one-time warning (Windows SmartScreen, macOS
Gatekeeper). To remove it, obtain a code-signing certificate and set
`CSC_LINK` / `CSC_KEY_PASSWORD` (Windows) or an Apple Developer ID (Mac). Not
required for internal use by one or two people.

## How it's wired

- `electron/main.cjs` — starts the standalone server (as Node, via
  `ELECTRON_RUN_AS_NODE`), waits for it, opens the window. Logs to
  `<userData>/launch.log` if anything fails to start.
- `scripts/prepare-standalone.mjs` — after `next build`, copies the static
  assets and the dynamically-loaded native packages (pdfjs worker, OCR stack)
  into the standalone bundle, which Next's tracer alone misses.
- `package.json` → `build` — electron-builder config. `asarUnpack: ["**/*.node"]`
  keeps native binaries loadable; `extraResources` ships the standalone server.
