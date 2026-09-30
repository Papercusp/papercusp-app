# @papercusp/desktop

Tauri desktop shell for Papercusp. Bundles a webview + Node sidecar into a small native app for macOS, Windows, and Linux.

## Install (end users)

Releases land at <https://github.com/Papercusp/papercup/releases?q=desktop> as `desktop-vX.Y.Z` tags. Download the artifact for your platform:

| Platform | Artifact | First-launch friction |
|---|---|---|
| **macOS** | `Papercusp_*_universal.dmg` (Intel + Apple Silicon in one bundle) | App is unsigned. Open it once via right-click → **Open** instead of double-click; macOS asks "are you sure?" — choose **Open**. After that, normal double-click works. |
| **Windows** | `Papercusp_*_x64-setup.exe` or `Papercusp_*_x64_en-US.msi` | App is unsigned. Windows shows a SmartScreen "Windows protected your PC" dialog. Click **More info → Run anyway**. |
| **Linux** | `Papercusp_*_amd64.AppImage` (portable) or `.deb` / `.rpm` for system install | None. AppImage: `chmod +x Papercusp_*.AppImage && ./Papercusp_*.AppImage`. |

**Prerequisites on the user's machine** (today; both being bundled in a future release):

- **Node 20+** — the sidecar runs on Node. Install via [nodejs.org](https://nodejs.org/) or `nvm`/`fnm`.
- **PostgreSQL 14+ on `localhost:5432`** — local data store. Install via [postgresql.org/download](https://postgresql.org/download/), then `brew services start postgresql` (mac) or `sudo systemctl start postgresql` (Linux).
- **`claude` CLI** — orchestrator dependency. Install with `npm install -g @anthropic-ai/claude-code`.

Set your Anthropic + (optional) GitHub PAT keys in **Settings → API Keys** on first launch. Keys are stored at `~/.papercusp/credentials.json` (mode 0600) and never leave your machine.

If any prerequisite is missing, the first-launch screen names it and links to the install instructions — you don't have to read this list ahead of time.

## Architecture

```
┌──────────────── papercusp.app (~80-100 MB) ───────────────┐
│  (size dominated by the bundled Node sidecar; ~30-50 MB    │
│   without the sidecar)                                     │
│                                                            │
│  Tauri (Rust) shell                                        │
│   ├── Native window, menu bar, system integration          │
│   ├── On launch: spawn Node sidecar on a free port         │
│   ├── On window-close / quit: kill sidecar                 │
│   └── Webview points at http://localhost:<sidecarPort>/    │
│                                                            │
│  Node sidecar (bundled inside the app)                     │
│   ├── apps/papercusp Next.js standalone build              │
│   ├── Same Hono routes that papercuspai.com cloud uses     │
│   ├── Owns the local fs (~/.papercusp/)                    │
│   └── Talks to local Postgres (or pglite later)            │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

The same sidecar Hono code that runs here as a child process is what we'd
deploy to the cloud later — see PLAN.md "Tauri shell + Node sidecar with
HTTP API" for the migration story.

## Prerequisites for local dev

| Platform | Install |
|---|---|
| **Ubuntu / Debian** | `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config` |
| **Fedora / RHEL** | `sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |
| **Windows** | WebView2 (preinstalled on Win 11) + Visual Studio Build Tools |

Plus everywhere: Rust stable (`rustup default stable`) and Node 20+.

CI installs the Linux system libs in the workflow, so you don't need them
on a build server — only when developing locally on Linux.

## Develop

Two terminals:

```sh
# Terminal 1 — start the sidecar (Next.js dev server)
npm run dev:papercusp     # serves on :3055 with HMR

# Terminal 2 — start the Tauri shell pointing at :3055
npm run dev:desktop
```

The Tauri window opens, points at `http://localhost:3055`, and you get the
full HMR experience inside a native window.

`npm run dev:desktop` runs `tauri dev`, which on first run downloads Rust
crates (~5 minutes) — subsequent runs are instant.

## Build distributable artifacts

For release builds, the sidecar must be a self-contained bundle Tauri can
ship as a resource. The build chain:

1. `npm --workspace @papercusp/web run build`  
   → produces `apps/papercusp/.next/standalone/` (the runnable Next.js bundle).
2. `bin/build-desktop-sidecar.sh`  
   → copies the standalone bundle + node_modules into `apps/papercusp-desktop/sidecar/`.
3. `npm run build:desktop`  
   → `tauri build` packages the Rust shell + sidecar into platform installers.

Outputs (per platform):

- macOS — `.dmg`, `.app` in `src-tauri/target/release/bundle/`
- Windows — `.msi`, `.exe` in `src-tauri/target/release/bundle/`
- Linux — `.AppImage`, `.deb`, `.rpm` in `src-tauri/target/release/bundle/`

## Cross-platform CI

`.github/workflows/desktop-release.yml` builds all four artifacts on push of
a `vX.Y.Z` tag (matrix: macos-latest, windows-latest, ubuntu-latest, ubuntu-latest-arm64).
Outputs land on a GitHub Release.

Builds are unsigned at the moment — see `HANDOFF-paperclip.md` and `PLAN.md`
for the signing roadmap.

## What's bundled

Everything the harness needs to run on a fresh machine:

- Next.js standalone build of apps/papercusp (the UI + API)
- Node runtime (bundled by the standalone build)
- Harness substrate (`packages/papercusp-harness/` — run.sh + prompts +
  identity + templates) — copied to user data dir on first launch
- The papercusp CLI binary

NOT bundled (yet — Phase 2 of the migration plan):

- Postgres — current builds expect the user to have Docker/Postgres
  available. Replacing with `pglite` is the next big bundling work item.
- `claude` CLI — current builds shell out to it. Replacing with the
  `@anthropic-ai/sdk` direct calls is the second-biggest item.

When both are bundled, the desktop app needs nothing else on the user's
machine. Total install size after that work: ~50-70 MB.

## Configuration

Bundle config lives in `src-tauri/tauri.conf.json`. The frontend dist
(`web/`) is a tiny bootstrap page that's shown for ~1 second while the
sidecar starts up; once ready, the Rust code navigates the webview to
`http://localhost:<sidecarPort>/`.

## Why Tauri (not Electron)

- ~30-50 MB binary instead of ~150 MB (no bundled Chromium — uses OS webview)
- ~80-150 MB RAM at idle instead of ~250 MB
- Cold start <1s instead of 2-3s
- Same HTTP-based architecture as the cloud port (Linear / Cursor / Granola pattern)
- AI-codeable Rust glue (~200-500 lines)

## Known caveats

- macOS WKWebView, Windows WebView2, Linux WebKitGTK — three different
  webview engines. WebKitGTK lags on some CSS/JS features. Test all three.
- First launch on macOS shows Gatekeeper warning (unsigned). Right-click → Open.
- First launch on Windows shows SmartScreen warning (unsigned). More info → Run anyway.
- Linux AppImage works on most distros; .deb/.rpm covered for Debian/Ubuntu and Fedora/RHEL.
