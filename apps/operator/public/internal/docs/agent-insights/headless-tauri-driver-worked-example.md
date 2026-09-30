# The headless Tauri driver, worked end-to-end: probe → navigate → assert → screenshot
URL: /internal/docs/agent-insights/headless-tauri-driver-worked-example

scripts/verify-tauri-headless.sh is the already-built, supported way to drive the Papercusp desktop GUI headlessly for agent verification — a concrete, proven-repeatable invocation, what it isolates vs shares, and the exact commands that produced passing evidence.

# The headless Tauri driver, worked end-to-end: probe → navigate → assert → screenshot

Agents repeatedly ask "can I verify Papercusp desktop UI headlessly?" and then hand-derive an
isolated Xvfb+VirtualGL+bridge instance from scratch (or worse, give up and skip the
UI-verification gate). **The answer is yes, and the recipe is already built and supported:**
`scripts/verify-tauri-headless.sh`. This doc is the worked, PROVEN example — the exact
invocation, its real output, and the gotchas that bit while producing it — so the next agent
copies a working recipe instead of re-deriving one.

## The one command

```bash
cd /path/to/papercusp   # repo root
scripts/verify-tauri-headless.sh -- bash /tmp/my-assertion.sh
```

where `/tmp/my-assertion.sh` uses the environment variables the wrapper exports into the
assertion command's environment: `$VERIFY_TAURI_PID` (the target app PID for every
`tauri-agent-tools` call), `$VERIFY_TAURI_POLL` (a retrying DOM-assertion helper — prefer it
over a fixed sleep), plus `$VERIFY_TAURI_PORT` / `$VERIFY_TAURI_DISPLAY`.

**Prerequisite:** the script refuses to run unless `PAPERCUSP_SID` is set in your shell (it is,
automatically, in any tracked su/agent session — that's the provenance anchor that keeps this
from ever being confused with the owner's live desktop).

## A concrete, verified assertion script

This is the exact script that produced the passing run below — copy it as a starting point:

```bash
#!/usr/bin/env bash
set -uo pipefail
OUT_DIR="/tmp/my-verify-artifacts"; mkdir -p "$OUT_DIR"

echo "=== probe ==="
tauri-agent-tools probe --pid "$VERIFY_TAURI_PID" --json | tee "$OUT_DIR/probe.json"

echo "=== navigate ==="
tauri-agent-tools navigate --pid "$VERIFY_TAURI_PID" "/adv?tab=settings"

echo "=== assert (poll) ==="
"$VERIFY_TAURI_POLL" --selector body --text Settings --no-errors

echo "=== screenshot ==="
tauri-agent-tools screenshot --pid "$VERIFY_TAURI_PID" --output "$OUT_DIR/settings.png"

echo "=== structured check ==="
tauri-agent-tools check --pid "$VERIFY_TAURI_PID" --selector body --no-errors --json | tee "$OUT_DIR/check.json"
```

Run via `scripts/verify-tauri-headless.sh -- bash /tmp/my-assertion.sh` — real output, this run
(2026-08-27, on a box already carrying a live `papercusp-desktop` process on the owner's real
display, plus this run's own isolated instance, at the same time, with zero interference):

```
[verify-tauri-headless] display=:90 devPort=33700 ptyPort=33704 work=/tmp/pcv/verify-tauri-headless.XXXXXX
[verify-tauri-headless] GPU GL confirmed: OpenGL renderer string: NVIDIA GeForce RTX 3090/PCIe/SSE2
[verify-tauri-headless] SPA snapshot frozen at .../spa — IMMUTABLE for this run
[verify-tauri-headless] waiting up to 300s for the desktop binary to start ... desktop binary started after 44s
[verify-tauri-headless] waiting up to 180s for the dev bridge ... bridge is up after 4s
[verify-tauri-headless] bridge provenance verified: owner=agent:su-<sid> pid=<pid> display=:90 port=33700
[verify-tauri-headless] origin health confirmed: apiHealth=200 rootHtml=200
[probe] Bridge alive: yes ... App PID: <pid> ... Page URL: http://127.0.0.1:33700/adv?tab=harnesses...
[PASS] selector: body
[PASS] text: Settings
[PASS] no-errors
{"passed":true,"checks":[{"type":"selector","passed":true,"selector":"body"},{"type":"no-errors","passed":true,"errors":[]}]}
[verify-tauri-headless] tearing down (exit=0)
```

The captured `settings.png` / `learning.png` are genuine rendered screenshots of the live
Papercusp Operator SPA (not blank — the GL check above is what guarantees that; skipping it,
or a box with no real GPU, gets you a blank white PNG instead — see
`wayland-tauri-agent-e2e-display` and the GL trap this script's own header calls out). Running
the SAME script a second time, immediately, while a completely unrelated live desktop instance
was already running on the box, produced its OWN disjoint display/port pair with zero collision
— that's the isolation working as designed, not luck.

## What this proves, concretely

* `probe` — discovers/confirms the bridge (version, endpoints, live windows, current page URL).
* `navigate` — drives the SPA router to an arbitrary in-app route (`/adv?tab=<screen>`).
* assert — `$VERIFY_TAURI_POLL` (retrying) or `tauri-agent-tools check` (one-shot, `--json`,
  nonzero exit on failure) for a real DOM/console assertion, not just "didn't crash".
* `screenshot` — a real, GPU-rendered PNG of the current webview state.
* **Repeatably**: navigate→assert→screenshot again to a second screen in the SAME run proved
  the cycle isn't a one-shot fluke — the second pass (`/adv?tab=learning`) passed identically.

That is the full probe→navigate→assert→screenshot loop the desktop-GUI-e2e-verification effort
needs, and it is already scriptable per-surface: swap the `navigate` target and the `--text`/
`--eval`/`--selector` assertions for whatever the surface under test actually renders.

## What is / is NOT isolated (read before you click/type/invoke anything)

|                                                                                | isolated?                               |
| ------------------------------------------------------------------------------ | --------------------------------------- |
| X display, devUrl port, pty port, sidecar process, SPA module bundle           | ✅ yes                                   |
| Postgres `DATABASE_URL` / `PAPERCUSP_WORKSPACE` / WebView profile+localStorage | ❌ **NO** — shared live state by default |

**Every write you make in this window is a REAL write to live state** (a Mug-steering click here
wakes the real Mug and burns real tokens; a routine toggle here really toggles it, git-sync
included). Reads are safe as-is. For genuine write-path isolation, pass
`VERIFY_TAURI_ISOLATED_DB=1` (boots a disposable, fully-migrated embedded Postgres + a disposable
WebView profile — see the script's own header for the full contract), or intercept
`window.fetch` for `POST /api/agent-mcp/run-tool` in the webview and validate the captured
payload offline instead of letting it reach the real backend.

## Practical notes from this run

* **Cold vs warm boot**: this box already carried warm `src-tauri` build artifacts (a symlinked,
  shared target dir), so "waiting for the desktop binary to start" took 44s and the bridge came
  up 4s after that — well inside the script's defaults (`VERIFY_TAURI_BUILD_TIMEOUT=300`,
  `VERIFY_TAURI_TIMEOUT=180`). A genuinely cold `src-tauri` build (changed Rust source, or a
  fresh target dir) can consume most of the 300s build budget on its own — that is intentional
  headroom, not a hang.
* **`tauri-agent-tools --help` and `<command> --help`** print fine even with zero live bridges;
  they are NOT blocked by the multi-bridge target guard on this install. (Other agents have hit a
  `--help`-blocked build on a box with 3+ live bridges — see `EI-19389052544654400` /
  `EI-19372326935917682` if you hit that; it's a different failure mode from anything in this doc.)
* **`tauri-agent-tools probe` with no target auto-discovers by scanning `/tmp/tauri-dev-bridge-*.token`
  files** — on a box with several stale token files left by dead processes, bare `probe --pid <N>`
  (naming only the PID) can still report "No bridge found" even though the process is alive and its
  own matching token file exists; passing the token file's `--port`/`--token` explicitly alongside
  `--pid` resolved it immediately every time in this session. `verify-tauri-headless.sh` never hits
  this because it hands the assertion command a freshly-booted PID/port/token triple directly via
  `$VERIFY_TAURI_PID` — this note is for anyone probing a pre-existing/peer instance by hand.
* **Never** point a browser (Playwright/`verdict`/raw Chrome) at `:3055`/`:3070` to "verify the
  GUI" — that is the retired standalone webapp, not the shipped product, and gives a
  broken/misleading result. This script is the correct substitute for headless agent work.
* **Never** drive the owner's real live desktop window (visible on `:0`/`:1`, or discoverable via
  `tauri-agent-tools probe` without an explicit target) — `verify-tauri-headless.sh`'s whole
  purpose is to give you a disjoint instance so you never have to.

## `--boot-only` for multi-step interactive sessions

For a verification session that needs several back-and-forth steps (not a single scripted
assertion command), `scripts/verify-tauri-headless.sh --boot-only` boots the same isolated
instance and prints a private, sourceable env file plus a stop script, instead of tearing down
immediately. **Always run the printed stop script when done** — an unattended `--boot-only`
instance leaks a display/port/process trio exactly like the leaked-Xvfb lesson (`WI-2115`) this
script was built to prevent. It refuses to boot at all inside a `capability:bash` managed task
(that task's cgroup teardown would silently kill it) unless you pass the explicit
`--boot-only-i-accept-task-lifetime` escape.

## Related docs

* `wayland-tauri-agent-e2e-display` — why a plain `npm run dev` shell under Wayland needs this
  script's Xvfb+VirtualGL wrapper for real pixel evidence (DOM/eval/check work either way; only
  screenshots need it).
* `/internal/docs/testing/agent-e2e` — the canonical UI-verification runbook this script
  implements §1.3/§15.4 of.
