# perf-test-wdio

WebdriverIO + `tauri-driver` runner for the **packaged** Papercusp desktop binary.

This is the only path that exercises the real Tauri build — Playwright doesn't speak the WebDriver protocol Tauri exposes. Most perf bugs reproduce identically in the dev webapp (`next dev` at :3055), so this runner is for the smaller set of issues that only show up in the shipped binary: native-bridge IPC latency, window-creation cost, asset-protocol load times.

## One-time setup

1. **tauri-driver** — `cargo install tauri-driver` (already installed).
2. **WebKitGTK WebDriver** (Linux only):
   ```bash
   sudo apt install webkit2gtk-driver
   ```
3. **Install Node deps** — run from this directory:
   ```bash
   cd tools/perf-test/wdio
   npm install
   ```
   (kept out of the pnpm workspace on purpose — wdio's `@wdio/cli` postinstall picks tooling that doesn't play well with pnpm hoisting).

## Running

```bash
# 1. Build the packaged desktop binary (RELEASE — see the note below).
#    The desktop app is the in-repo `papercusp-desktop` submodule:
cd papercusp-desktop && npm run build     # tauri build → src-tauri/target/release/papercusp-desktop

# 2. Run every spec against the binary, capturing a per-run log:
npm run perf:desktop                       # from the repo root

#    …or run wdio directly (typecheck + runner unit guards + every spec):
cd tools/perf-test/wdio && npm run test:all
```

> `npm test` here runs ONLY the headless runner unit guards (`perf-report.node-test.ts`).
> That is deliberate: `tools/perf-test/wdio` is in `STANDALONE_PACKAGE_DIRS`
> (`scripts/affected-tests.mjs`), so the green gate runs its `test` script on every change to
> this package, and the gate cannot boot a packaged desktop binary. The full run is `test:all`.

`wdio.conf.ts` resolves the binary from `TAURI_APP_PATH` (or the real build
locations — release preferred, honoring `CARGO_TARGET_DIR`), preflight-checks
that `WebKitWebDriver` is installed (Linux — fails fast with an install
command instead of an opaque 5-minute timeout if it's missing), spawns
`tauri-driver` on a fresh ephemeral port pair (not a fixed 4445 — this box
runs many concurrent agent/e2e sessions, and a fixed port doubles as
tauri-driver's own default `--native-port`, which is a deterministic bind
collision, not just a multi-agent one — see the doc comment on
`assertNativeWebDriverAvailable` in `wdio.conf.ts`, WI-5662), drives the
binary via WebDriver, and runs `specs/*.spec.ts`:

- `smoke.spec.ts` — boots the app, waits for the operator UI to mount, injects
  `web-vitals`, and reports INP/LCP/CLS after 10s.
- `plan-popup-open.perf.spec.ts` — drives the REAL "open a plan" interaction
  (sidebar Plans face → row → dashboard → Open full plan → body rendered in
  Vditor), requires the truth-gated Vditor/Lute warm-up mark, and asserts the
  page-relative `plan-popup-open` `performance.measure` against its budget
  (mirrors `DESKTOP_PERF_BUDGETS`; the fresh-harness fix for
  EI-18128922194224210).

> ⚠️ **Use a RELEASE binary for budget assertions.** A debug build runs
> several-fold slower, so its interaction timings blow the release-tuned
> budgets. wdio.conf falls back to a debug binary (for wiring/smoke) but prefers
> release. `npm run perf:desktop` writes each run's output (incl. the `[perf]
> <interaction> = Nms` lines) to `results/run-<ts>.log`.

For a packaged run that pairs a frozen shell, copied SPA and live API, set
`PAPERCUSP_PERF_RUN_ID` to a name that identifies that build profile and set
`PAPERCUSP_PERF_WORKSPACE_ID` to the workspace exercised by the spec. The
publisher stores these as `run_id` and `workspace_id`. A named profile leaves
`git_sha` empty because the WDIO checkout HEAD may differ from every component
under test; unnamed runs retain that checkout correlation. Record the shell,
SPA and API hashes alongside the run log for exact reproduction.
On Linux, a named run using a private `PAPERCUSP_HOME` must also set
`PAPERCUSP_DEV_API_TARGET` to the target port (for example, `3170`). The runner
checks the private IPC PID and socket before measuring and again before
publishing; an API restart makes that sample invalid and prevents a receipt.

## Architecture vs the in-process `/tests` page

| | Where it runs | Speed | Catches |
|---|---|---|---|
| `/tests` page (Gremlins + react-scan + web-vitals) | Inside the running app | Live, every iteration | 95% of UI perf bugs |
| `perf-test-wdio` (this) | Outside, drives packaged binary | Slow (minutes), CI-shaped | The 5% that need the real binary — IPC latency, window creation, asset protocol |

Run the in-process tooling daily; run this before each release.
