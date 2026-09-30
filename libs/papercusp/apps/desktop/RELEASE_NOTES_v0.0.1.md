# Papercusp Desktop v0.0.1 — first cross-platform release

The first installable build of Papercusp as a desktop app. Bundles the framework, the Papercup demo, and the harness orchestrator into one native installer per platform.

## Downloads

| Platform | Artifact | Size | Notes |
|---|---|---|---|
| **macOS** (Intel + Apple Silicon) | `Papercusp_0.0.1_universal.dmg` | ~24 MB | Universal binary. Right-click → **Open** the first time (unsigned). |
| **macOS** (.app bundle) | `Papercusp_universal.app.tar.gz` | ~24 MB | Same app as the .dmg, in tarball form. |
| **Windows** (NSIS installer) | `Papercusp_0.0.1_x64-setup.exe` | ~8 MB | Click **More info → Run anyway** when SmartScreen warns (unsigned). |
| **Windows** (MSI installer) | `Papercusp_0.0.1_x64_en-US.msi` | ~13 MB | Same as NSIS, installer-format choice. |
| **Linux** (Debian/Ubuntu) | `Papercusp_0.0.1_amd64.deb` | ~28 MB | `sudo dpkg -i Papercusp_*.deb`. |
| **Linux** (Fedora/RHEL) | `Papercusp-0.0.1-1.x86_64.rpm` | ~28 MB | `sudo rpm -i Papercusp_*.rpm`. |

(AppImage will return when the linuxdeploy / ubuntu-24.04 compatibility issue is resolved upstream.)

## What's inside

- **Tauri shell** (~3 MB Rust binary) — spawns + manages the Node sidecar lifecycle
- **Node sidecar** — the same `apps/papercusp` Next.js app that runs at papercuspai.com, running locally as a child process
- **Harness orchestrator** — `run.sh` + role prompts + project templates from `packages/papercusp-harness/`
- **Bootstrap UI** — first-launch screen that checks prerequisites and shows install hints if anything's missing

## Prerequisites on the user's machine

The app's first-launch screen checks these and shows install hints if any are missing:

- **Node 20+** — the sidecar runs on Node
- **PostgreSQL 14+ on `localhost:5432`** — local data store (will be replaced with bundled pglite in a future release)
- **`claude` CLI** — orchestrator calls Claude Code; install via `npm i -g @anthropic-ai/claude-code`
- **`bash`** — orchestrator script. macOS/Linux already have it; Windows users install [Git for Windows](https://git-scm.com/download/win)

## Known limitations

- **Unsigned on all platforms.** macOS Gatekeeper / Windows SmartScreen will warn on first launch — see the per-platform install notes above. Code signing roadmap in [`SHIPPING.md`](apps/papercusp-desktop/SHIPPING.md).
- **Auto-updater not active** — needs signing keys before activation. You'll need to manually download new versions for now.
- **Linux x86_64 only** — arm64 builds will land in a follow-up release (the matrix already supports it).

## Architecture

```
papercusp.app (~25 MB compressed, ~80 MB installed)
├── Tauri (Rust) shell
│   ├── Find free port → spawn Node sidecar → wait reachable → kill on exit
│   └── Webview points at the bundled bootstrap HTML
└── Node sidecar (apps/papercusp Next.js standalone bundle + harness)
    ├── /api/desktop/preflight checks node/postgres/claude/bash/harness
    ├── /api/harness/* — all framework routes
    └── Spawns `harness/run.sh` for orchestrator iterations
```

The same Hono code that runs as a child process here is what would deploy as a cloud container later — dual-mode-ready.

## Development

- `apps/papercusp-desktop/README.md` — full architecture + dev setup
- `apps/papercusp-desktop/SHIPPING.md` — release-cutting cheat sheet
- `.github/workflows/desktop-release.yml` — the CI matrix that built this

## What's next (v0.0.2 / v0.1.0)

- Drop Postgres prereq via bundled pglite
- Drop `claude` CLI prereq via direct `@anthropic-ai/sdk` calls
- TypeScript port of `run.sh` to drop bash prereq (Windows users no longer need Git for Windows)
- macOS code signing + notarization
- Windows code signing
- Auto-updater activation (once signed)
- Linux AppImage + arm64 builds
