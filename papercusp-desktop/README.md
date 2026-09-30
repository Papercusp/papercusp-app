# @papercusp/desktop

Tauri desktop shell for Papercusp. It opens a native webview onto the Papercusp operator and
starts, on launch, what the operator needs: its own embedded PostgreSQL, the schema migrations
and the operator's API host. It builds for macOS, Windows and Linux.

## Install (end users)

Installers for every published version, with release notes and install instructions, are on the
Papercusp releases page linked from the repository README. Install both apps: **Papercusp Server**
runs the operator, its embedded database and your agents on your machine, and **Papercusp GUI** is
the desktop window onto it. The installers are unsigned today, so macOS asks you to confirm the first
launch (right-click → **Open**) and Windows shows SmartScreen (**More info → Run anyway**).

Agents run through the CLIs you already use (for example the `claude` CLI); set provider keys in
**Settings → API Keys** on first launch. Keys are stored at `~/.papercusp/credentials.json`
(mode 0600) and never leave your machine.

## Prerequisites for building from source

| Platform | Install |
|---|---|
| **Ubuntu / Debian** | `sudo apt install build-essential curl wget file pkg-config libssl-dev libxdo-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf` |
| **Fedora / RHEL** | `sudo dnf install webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel` |
| **macOS** | Xcode Command Line Tools (`xcode-select --install`) |
| **Windows** | WebView2 (preinstalled on Windows 11) + Visual Studio Build Tools |

Everywhere: **Rust stable** (1.77 or newer; `rustup default stable`) and **Node.js 25** (the
repository's `.nvmrc`; native addons are built for that Node ABI).

You also need **pgvector for PostgreSQL 18**. The embedded Postgres ships without extensions
beyond the contrib set, and the schema uses the `vector` extension, so the root `npm ci` copies the
host's pgvector into it (`scripts/install-embedded-pgvector.mjs`). On Debian or Ubuntu install
`postgresql-18-pgvector` from the PostgreSQL apt repository (<https://wiki.postgresql.org/wiki/Apt>);
on macOS, `brew install pgvector`. If you install it after `npm ci`, run
`node scripts/install-embedded-pgvector.mjs` from the repository root. Without it a fresh database
stops at the first migration that declares a `vector` column.

## Build and run

From the repository root:

```sh
npm ci                                               # dependencies + pgvector into the embedded Postgres
npm --workspace @papercusp/operator-vite run build   # the UI bundle the window loads
cd papercusp-desktop
npm ci
npm run dev                                          # builds the Rust shell and opens the window
```

The first `npm run dev` compiles the Rust shell, which takes several minutes; later runs reuse the
build. The window then creates its embedded database, applies the migrations and serves the
operator from this working tree, starting at first-run onboarding. `npm run dev:hmr` is the variant
that points the window at the Vite dev server (port 3055) with hot reload.

To check a build without opening a window (CI, a remote box, or an agent), run the same app on its
own virtual display with a throwaway database:

```sh
VERIFY_TAURI_ISOLATED_DB=1 scripts/verify-tauri-headless.sh --boot-only
```

## Architecture

```
┌──────────────────────── Papercusp desktop ────────────────────────┐
│  Tauri (Rust) shell                                                │
│   ├── native window, menus, system integration                     │
│   ├── starts the sidecar on launch, stops it on quit               │
│   └── webview onto the operator (desktop IPC for /api/*)           │
│                                                                    │
│  Node sidecar                                                      │
│   ├── embedded PostgreSQL (+ pgvector), migrations on boot         │
│   ├── operator API host (Hono, apps/operator/bin/hono-host.ts)     │
│   ├── operator UI (apps/operator-vite build)                       │
│   └── owns the local data directory (~/.papercusp/)                │
└────────────────────────────────────────────────────────────────────┘
```

## Release builds

Installers are built locally, not by a hosted CI service. `bin/build-linux-local.sh` builds the
Linux `.deb` and AppImage (`bin/build-mac-cross.sh` and `bin/build-windows-cross.sh` cover the other
platforms). `bin/build-desktop-sidecar.sh` assembles the sidecar the installers carry: the operator
host, the UI bundle, the embedded Postgres with pgvector, Node, and the runnable source tree. A
release cut also needs a signing key (`bin/setup-signing-key.sh`) and the release-identity inputs
the build's audit checks against; `SHIPPING.md` and `RELEASE-RUNBOOK.md` describe the full flow.
Bundle configuration lives in `src-tauri/tauri.conf.json`.

## Known caveats

- macOS WKWebView, Windows WebView2 and Linux WebKitGTK are three different webview engines.
  WebKitGTK lags on some CSS/JS features, so test all three.
- Installers are unsigned: expect the Gatekeeper and SmartScreen prompts described above.
