# tauri-agent-tools screenshot: resolve the window by --pid, not by title guessing
URL: /internal/docs/agent-insights/tauri-agent-tools-screenshot-resolves-window-by-pid

screenshot --pid used to fail two ways: (1) title-guessing X11 lookups that never match (\"Papercusp Operator\" vs \"Papercusp\") plus wrong-DISPLAY searches, and (2) an arg-validation rejection of pid-only invocations from the no-selector/full-window branch (\"Either --selector (with bridge), --title, or --window-id is required\"). The local patch resolves the window and DISPLAY directly from --pid (largest-area heuristic for multi-window PIDs) in BOTH branches.

## The traps

`tauri-agent-tools screenshot --pid <pid> ...` — the first screenshot command an agent typically reaches for after booting an isolated headless verify instance — has failed in TWO distinct ways:

### Variant 1: title-guessing failure (EI-18662939265185207, 2026-07-25)

With `--selector`, the window was found by asking the bridge for `document.title` ("Papercusp Operator") and searching X11 for that exact name — but the Tauri **window's** X11 title is just `"Papercusp"`, so the search could never match. Worse, `xdotool` searched whatever `DISPLAY` the *calling* CLI inherited, not the target app's own display.

### Variant 2: pid-only invocation REJECTED (EI-21270933850311524, 2026-08-24)

```
tauri-agent-tools screenshot --pid <pid> --output /tmp/x.png --json
# -> Either --selector (with bridge), --title, or --window-id is required   (exit 1)
```

The first local patch wired pid-based resolution into the **`--selector` branch only** (`dist/commands/screenshot.js`). The **no-selector / full-window fallback** branch handled `--window-id` and `--title` but fell straight to a validation throw when only `--pid` was supplied — even though `adapter.findWindowByPid` sat unused one branch over. Reproduced live against a real desktop PID on tauri-agent-tools **0.9.1** WITH the variant-1 patch present, so this is not "the patch was lost" — it was incomplete coverage.

## The fix — resolve by `--pid` instead of guessing

`screenshot` already requires `--pid` for bridge discovery on every invocation. That is enough to resolve the window directly, with no title guessing:

* `resolveDisplayForPid(pid)` reads `/proc/<pid>/environ` and returns the target's own `DISPLAY`, so name/pid searches hit the right X server.
* `X11Adapter.findWindowByPid(pid)` runs `xdotool search --pid <pid>` and picks the **largest-by-area** candidate (see below).
* The action handler uses this whenever `--pid` is given and neither `--window-id` nor `--title` was passed explicitly — in BOTH branches since EI-21270933850311524: the `--selector` DOM-crop path AND the no-selector full-window path. It falls back to the old behavior (and keeps the guidance error, now annotated with the failed pid) when the PID owns no readable X11 toplevel.

### One PID, multiple X11 windows

A naive `ids[0]` on `xdotool search --pid` output picks helper/tray windows (measured: a 10×10 helper vs the real 2701×1293 main window). When a pid search returns several windows, each one's geometry is fetched and the largest by area wins.

## Verified (2026-08-24, against two concurrent live desktop instances)

```sh
tauri-agent-tools screenshot --pid <pidA> --output /tmp/a.png --json  # exit 0 — 461KB PNG 1632x1408, windowId resolved
tauri-agent-tools screenshot --pid <pidB> --output /tmp/b.png --json  # exit 0 — 970KB PNG 2967x1373 (correct OTHER instance)
tauri-agent-tools screenshot --output /tmp/n.png                      # guidance error preserved (exit 1)
tauri-agent-tools screenshot --title Papercusp --output /tmp/t.png    # pre-existing title path unchanged (exit 0)
```

Two instances running side by side produce DIFFERENT correctly-sized captures from their pids alone — pid-only capture also disambiguates concurrent instances, which title matching cannot.

## This is a LOCAL patch — it does not survive a reinstall

`tauri-agent-tools` is a third-party package (`github.com/cesarandreslopez/tauri-agent-tools`), installed globally via `npm i -g`. This repo does not vendor its source; the fix is patched into the installed `dist/` files:

* `dist/platform/x11.js` (+ `.d.ts`) — `resolveDisplayForPid` + `X11Adapter.findWindowByPid`.
* `dist/commands/screenshot.js` — pid-based resolution wired ahead of legacy paths in BOTH the selector and no-selector branches (EI-18662939265185207 + EI-21270933850311524).

Both patches are annotated in the code with their EI ids. **If pid-based screenshot starts failing again after a reinstall/upgrade**, re-check whether the failure is variant 1 (raw `xdotool search --name` error) or variant 2 (validation rejection); the diffs are small and this doc has the exact rationale. Filing/landing the equivalent fix upstream would make this permanent.
