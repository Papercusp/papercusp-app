# Pi (oh-my-pi) integration
URL: /internal/docs/implementation/pi-integration

Two-track integration — pi as worker-role CLI (Option #2) and embedded pi TUI as a peer pane in the desktop app (Option #3).

import { Aside } from '@astrojs/starlight/components';

[`oh-my-pi`](https://github.com/can1357/oh-my-pi) (binary `omp`) is a 3.5k★ open-source AI coding agent for the terminal — strong tool harness (read / bash / edit / write / grep / find / lsp / python / browser / subagents / hooks / plugins), `--mode=rpc/json` structured output, multi-model fuzzy matching, session resume, and a TUI.

It complements Papercusp at a different layer: **pi has strong in-loop autonomy; Papercusp has strong mission orchestration**. Together: pi as the worker, Papercusp as the conductor.

This page covers two integration tracks.

## Track A — Pi as the worker-role CLI

Track B (the embedded pi pane) shipped; **Track A has not**. There is no
per-role `cliBin` field in the harness role config today — the TS
orchestrator's `invoke.ts` resolves a single agent binary globally
(`$AGENT_CMD ?? $CLAUDE`, default `omp -p`), not per-role. The config below is
the proposed schema, not the current one.

The smallest valuable integration. Papercusp's per-role config already supports overrides; add `cliBin` to the schema so individual roles can specify a non-default CLI.

```json
// config.json (in any harness)
{
  "primaryRole": "orchestrator",
  "roles": {
    "worker": { "cliBin": "pi", "model": "opus" },
    "validator": { "cliBin": "claude" },
    "orchestrator": { "cliBin": "claude" }
  }
}
```

**What lands:** pi runs the worker pipeline (where tool breadth matters); claude stays on plan / validate / orchestrate (where structured-decision reliability matters). Each invocation is `pi -p --no-session --append-system-prompt=<file>` so the fresh-context contract holds.

**Effort:** \~½ day. The bash run.sh's `invoke()` and the TS orchestrator's `invoke.ts` both already shell out to a configurable CLI binary; this is wiring per-role config through to that spawn.

**Output parsing.** Pi's `--mode=json` emits a JSONL event stream with the same shape papercusp already parses for claude (session header, then events). Empirically verified: first event is `{"type":"session","version":3,"id":"…","cwd":"…"}` followed by tool/message events. The adapter to map pi's event names to papercusp's audit schema is \~30 lines, not a deal-breaker.

**Auth.** Pi inherits the sidecar's environment, including `ANTHROPIC_OAUTH_TOKEN`. Users logged into Claude Code see no auth prompt when papercusp invokes pi — the same Claude Max subscription that drives `claude -p` drives `pi -p`. Other providers (OpenAI, Gemini, Bedrock, Vertex, OpenRouter, …) flow the same way via their respective env vars.

### Cost-mixing example

The interesting payoff is fine-grained cost control across roles. Pi's four model slots ([see §16.4 in the spec](/spec/cli-pluggability/#two-layer-pluggability-a-worked-example)) let a single config dial each role independently:

```json
// config.json — opinionated mid-budget setup
{
  "roles": {
    "scoper":       { "cliBin": "pi", "extraArgs": ["--plan=opus"] },
    "planner":      { "cliBin": "pi", "extraArgs": ["--plan=opus"] },
    "worker":       { "cliBin": "pi", "extraArgs": ["--model=sonnet", "--smol=haiku"] },
    "validator":    { "cliBin": "pi", "extraArgs": ["--model=gemini-2-flash"] },
    "orchestrator": { "cliBin": "claude" }
  }
}
```

Reasoning: opus on the rare planning calls, sonnet on hot-path worker calls (with haiku for tool-plan subtasks via pi's `--smol`), gemini flash on cheap validator passes, claude on the orchestrator for stable decision-verb output. Pairs naturally with papercusp's [hard-stop budget enforcement](/spec/state/#53-hard-stop-budget-enforcement) — the substrate enforces the hard cap; this config tunes the per-call cost.

See [§16 CLI pluggability](/internal/docs/spec/cli-pluggability) for the substrate concept this builds on.

## Track B — Embedded pi TUI as a peer pane

A new `pi` tab in the harness dashboard that hosts an interactive `omp` process inside the desktop app. The autonomous loop continues in the background; the human can drop into pi mid-mission for surgical override.

### Goal

Surface an interactive pi TUI inside the Papercusp Desktop harness UI alongside the existing `vscode` / `git` / `brainstorm` panels. (Phase 3b adds a "open in pi" button per feature that scopes pi to that feature's worktree.)

### Design decisions

1. **PTY runs in the Node sidecar for the web/cloud path; the desktop build uses a Tauri-native pty.** The original decision was sidecar-only `node-pty` (the same sidecar code runs in desktop and cloud modes, and a Rust-side PTY would fork the codebase). That still holds for the web/cloud case. **For the native desktop build this was revised** (plan `desktop-ipc-transport-completion-2026-05-20`): inside the Tauri webview, `PiPanel` detects `isTauriNative()` and skips HTTP/WS/SSE entirely — it forks the pty in the Tauri Rust process via `openNativeSession()` and streams over Tauri IPC end-to-end, consulting `POST /pty/resolve` only to build harness-aware args/cwd/env without spawning. The Node-sidecar `node-pty` path (HTTP control plane + WS/SSE data channel) remains the transport for the web/cloud case.

2. **I/O transport: WebSocket preferred, SSE + POST fallback.** A full-duplex WebSocket transport shipped: `PiPanel.tsx` connects via `ptyWsUrlForId()` and attaches xterm's `AttachAddon` (binary frames, no base64), backed by the `packages/operator-core/lib/pty-ws.ts` WS server. It falls back to SSE output + POST input only when the WS server is unreachable (proxy doesn't pass upgrades, `PAPERCUSP_PTY_WS=0`, etc.). The HTTP control plane (`POST /spawn`, `/kill`, …) is identical either way — only the data channel differs. SSE was the original v1 transport (Next.js's standalone server didn't natively support raw WS-upgrade on arbitrary routes); WS is now primary and SSE is the compatibility path.

3. **`pi` is a user-installed prerequisite, not bundled.** Matches the existing `claude` pattern. The desktop preflight UI already surfaces missing-prereq state — extend with a `pi` check.

4. **No session persistence in v1.** Pi has `--no-session` for ephemeral runs; persistent resume across pane reopen is v2 polish.

5. **Slot into the existing `MainPanel` union.** `HarnessDashboard.tsx` lists every embedded-tool tab (`brainstorm`, `proposals`, `git`, `dashboard`, `vscode`, `insights`, etc.) — adding `'pi'` follows the established pattern. The `vscode` tab (which embeds `code-server` in an iframe) is the direct precedent: same shape, different embedded tool.

### Rejected alternatives

* **Rust-side PTY (`portable-pty` crate)** — originally rejected (forks desktop/cloud paths, more native build pain on Windows, couples a UI feature to the platform shell). This was **effectively revised for the native desktop transport**: the desktop build now does fork the pty Rust-side (see design decision #1). The web/cloud path keeps the sidecar `node-pty`, so the "forks the codebase" concern is contained to the desktop transport seam rather than the whole stack.
* **SSH/wetty-style HTTP terminal services** — another process, another auth surface, another port. The `node-pty + xterm.js + SSE` stack runs entirely inside the existing sidecar.

### Pi command surface used by Track B

The pane spawns one of:

* `omp` — pi's interactive default mode. Best for general use.
* `omp shell` — pi's "interactive shell console" subcommand. Slightly different surface; useful for shell-flavored workflows.

Useful flags to pass:

* `--no-pty` — disable pi's *internal* PTY-based bash execution. We already have a PTY (the one we bridge to xterm.js); pi nesting another inside it can confuse signal handling and resize semantics. Set this in the embedded pane.
* `--session-dir=$STATE_DIR/.pi-sessions/` (or env `PI_CODING_AGENT_DIR`) — point pi's session store at the harness state dir so sessions are scoped to the harness, not the user's home. Falls back to `~/.omp/agent` if unset.
* `--append-system-prompt=<file>` — for Phase 3b feature-scoped opens, inject the feature's spec/lineage as additional system prompt.
* `--export=<session-file>` — Phase 3d candidate. After a session ends, exporting it to HTML and storing under the harness audit dir makes the in-pane work part of the durable record.

### Phasing

The status table on [/implementation/status/#pi-oh-my-pi-integration--tracks-a--b-phase-3abc-shipped](/internal/docs/implementation/status) tracks landed phases. Live in the harness dashboard (open a harness in the desktop shell) — click the `pi` tab.

**Phase 3a — MVP terminal pane (\~1 day).** ✅ shipped.
A new `pi` tab in the harness dashboard. Click → opens xterm.js connected to a fresh `pi` process in the harness's project directory. Keystrokes in, output out. Close tab → kill pi.

**Phase 3b — peer pane layout + feature-scoped launch (\~1 day).** ✅ shipped (tab-scoped, not split-pane).
Each feature's `FeaturePeekPanel` gets an "open in pi" button → pi spawns in `<stateDir>/worktrees/<fid>` (falls back to project root if no worktree). The pty is deliberately **not** killed when the client disconnects: the SSE stream's `onClose` keeps the handle alive (PiPanel unmounts on every dashboard tab switch), and PiPanel's own unmount cleanup explicitly skips the kill so a remount can resume the same session via `resumePtyId`. Genuinely-abandoned handles are reaped by the 5-minute idle reaper in `pty-bridge`, not by a disconnect kill. The plan called for a split-pane layout; we shipped tab-pattern instead (matches the existing `vscode` tab; no layout-shift, full pane width). True split-pane is a future affordance if needed.

**Phase 3c — desktop polish (\~½ day).** ✅ shipped.
`pi` added to preflight checks (PATH + well-known-paths probe). Install-hint UI surfaces missing-pi with `brew install can1357/oh-my-pi/oh-my-pi`. README documents pi as an optional prereq. Pi missing does NOT block the app from booting — only the pi tab degrades.

**Phase 3d — partially shipped.**

* **Feature-scoped system-prompt injection** ✅ shipped. When the user clicks "open in pi" on a feature, the spawn endpoint reads `harness_features` for that `(slug, featureId)` (columns `feature_id`, `title`, `summary`, `status`), formats them as markdown via the shared kickoff factory, writes the brief to a fresh `mkdtemp` dir under `/dev/shm` (tmpdir fallback) named `<feature-id>.md`, and adds `--append-system-prompt=<path>` to the omp args. The temp dir is scheduled for removal after 30s. Pi launches already aware of the feature it's working on. Falls back silently when the feature lookup fails — no error surface, just no injection.
* **Per-harness session persistence** ✅ shipped via `PI_CODING_AGENT_DIR=<stateDir>/pi-sessions/`. Each harness has its own pi history under its state dir; sessions persist across pane reopens automatically. Future polish: explicit "resume last session" button using `omp -c` / `omp -r <id>`.
* **Audit export** ✅ shipped. `attachAuditExport()` registers an `onExit` hook that runs `exportPiSessions()`, which finds the session jsonls created during the pty's lifetime and shells out to `omp --export <sessionFile>` per session, storing the resulting HTML under `<stateDir>/audit/pi-sessions/`. Two GET endpoints serve the exports — `GET /pi-sessions/audit` (lists them) and `GET /pi-sessions/audit/:filename` (serves one HTML, basename-validated against path traversal) — and PiPanel's "past sessions" chip + popover lists and links them.
* **Pi extension** ✅ shipped and wired into spawns. The spawn endpoint resolves `global-plugins/pi/extension.ts` and, when it exists, pushes `-e <path>` onto the omp args (the `-e <path>` extension flag — not `--plugin-dir`). The extension registers `papercusp_status`, `papercusp_list_features`, `papercusp_lineage`, `papercusp_audit`, `papercusp_proposals`, `papercusp_decisions`, and `papercusp_issues` (underscore-namespaced). `GET /pty/tools` enumerates them (returning `extensionAvailable: false` with an empty list when the extension isn't present). The extension reads papercusp state through the existing API (so no extra trust boundary).
* **Subagent cross-pollination** — deferred. `omp agents unpack` ships curated subagent personas. Wrap each as a papercusp plugin so they appear in the marketplace catalog. Cross-pollinate the ecosystems.
* **Multi-pane** — shipped via the dockview `PiTerminalsDock.tsx` (see the file tables below). Multiple concurrent pi panes scoped to different features, capped per the process-wide, host-scaled pty cap in §Risks.

### File-level changes (Phase 3a + 3b + 3c)

The original plan targeted `apps/papercusp/**`. After the operator rename the
operator app is **`apps/operator/`** and its server routes are Hono routers
under **`packages/operator-core/lib/endpoint-route/routes/**`**; the desktop is
the sibling repo **`papercusp-desktop/`** (not `apps/papercusp-desktop/`). The
harness UI was also restructured — there is no longer a `HarnessDashboard.tsx`
/ `MainPanel` union or a `FeatureList.tsx`; the pi pane now lives in
`PiPanel.tsx` + a multi-pane `PiTerminalsDock.tsx` (dockview-based, so the
multi-pane / split-pane affordances the original phases deferred are present).
The tables below give the current locations.

#### New files

| Path                                                            | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/operator-core/lib/endpoint-route/routes/pty/index.ts` | Router mounted at `/api/harness/:slug/pty/*` (+ `/pi-sessions/audit/*`). Endpoints: `POST /spawn`, `POST /resolve`, `POST /prewarm`, `GET /:id/stream` (SSE), `POST /:id/input`, `POST /:id/resize`, `POST /:id/kill`, `GET /pty/tools`, `GET /pi-sessions/audit[/:filename]`. Mutating routes are `auth: 'loopback'`; the read/stream routes are `auth: 'public'`. Handles live in a module-level `Map` (in `pty-bridge`) plus a prewarm pool. |
| `apps/operator/app/harness/PiPanel.tsx`                         | xterm.js React component (xterm + addon-fit + addon-web-links). SSE on mount, POST keystrokes on input, POST resize on container resize. Cleanup on unmount.                                                                                                                                                                                                                                                                                    |
| `apps/operator/app/harness/PiPanel.css`                         | Pane chrome (header bar, "open new", spinner) + xterm theme matching papercusp dark colors.                                                                                                                                                                                                                                                                                                                                                     |
| `packages/operator-core/lib/pty-bridge.ts`                      | Server-side `@lydell/node-pty` wrapper. `spawnPty({command, args, cwd, env, cols, rows})` → typed handle with `onData` / `write` / `resize` / `kill`, an owner-SID tag, a 1 MB byte ring, and a per-handle `xterm-headless` + `SerializeAddon` mirror for bounded screen-state replay. Centralizes lifecycle, the host-scaled process-wide pty cap, and the 5-min idle reaper.                                                                  |
| `packages/operator-core/lib/pty-ws.ts`                          | WebSocket server for the pty bridge (started from `instrumentation.ts`). Client connects to `ws://…/pty/<id>` after `/spawn`; replaces the SSE-output + POST-input data channels with one full-duplex WS (binary frames, no base64), with VS Code-shape flow control. The HTTP control plane is unchanged.                                                                                                                                      |
| `packages/operator-core/lib/pty-tauri.ts`                       | Native desktop data path — `isTauriNative()` + `openNativeSession()`. Inside the Tauri webview, forks the pty Rust-side and streams over Tauri IPC, bypassing HTTP/WS/SSE.                                                                                                                                                                                                                                                                      |

#### Modified files

| Path                                                                    | Change                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/operator/package.json`                                            | Added `@lydell/node-pty` (the prebuilt-binary fork — chosen over plain `node-pty`), `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-attach` (WS data path), `@xterm/headless` + `@xterm/addon-serialize` (server-side screen-state replay). |
| `packages/operator-core/lib/endpoint-route/routes/index.ts`             | Register the pty router (flattened into the route table) so it mounts under `/api/harness/:slug/pty`.                                                                                                                                                                   |
| `apps/operator/app/harness/PiTerminalsDock.tsx`                         | Multi-pane (dockview) container that hosts the pi/omp terminals as draggable tabs/splits; each panel mounts a `<PiPanel>`. (Replaces the original plan's `HarnessDashboard.tsx` `MainPanel`-union single-tab integration after the harness-UI restructure.)             |
| `apps/operator/app/harness/PiPanel.tsx`                                 | Per-feature "open in pi" wiring: passes the feature id as `laneId` so the pane spawns in that feature's worktree.                                                                                                                                                       |
| `packages/operator-core/lib/endpoint-route/routes/desktop/preflight.ts` | `pi` check (probes `omp`, then well-known paths `/usr/local/bin/omp`, `/opt/homebrew/bin/omp`, … for the GUI no-login-shell PATH gotcha).                                                                                                                               |
| `papercusp-desktop/web/index.html`                                      | Extend `renderHint()` switch with a pi clause: install URL + recommended command.                                                                                                                                                                                       |
| `papercusp-desktop/README.md`                                           | Document pi as optional prereq for the pi tab.                                                                                                                                                                                                                          |

### I/O protocol (HTTP + WS / SSE)

```
POST /api/harness/:slug/pty/spawn
  body: { command?, args?, laneId?, cols?, rows?,
          env?, resumePtyId? }
  → { id, command, args, cwd, pid }   // (+ prewarmed:true if adopted
                                       //  from the pool, resumed:true
                                       //  if resumePtyId matched a live pty)
  cwd is derived from laneId (the lane's worktree if it exists, else the
  project root) — there is no ctxPrompt or cwd field in the body.

POST /api/harness/:slug/pty/resolve
  Same body shape; returns { command, args, cwd, env } WITHOUT spawning.
  Used by the Tauri-native path to build harness-aware args.

POST /api/harness/:slug/pty/prewarm
  Reserves a warm omp (same body shape) so /spawn can adopt it and hide
  omp's ~1.2s startup. → { reserved: true } (or reused:true).

GET /api/harness/:slug/pty/:id/stream    (text/event-stream — SSE fallback)
  ← event: data\ndata: <base64-bytes>\n\n
  ← event: exit\ndata: {"code": 0}\n\n
  On connect, replays the full byte history into the new subscriber.

POST /api/harness/:slug/pty/:id/input    { data: <base64-bytes> }
POST /api/harness/:slug/pty/:id/resize   { cols, rows }
POST /api/harness/:slug/pty/:id/kill

GET /api/harness/:slug/pty/tools          enumerates the pi extension's tools
GET /api/harness/:slug/pi-sessions/audit  lists exported session HTML
GET /api/harness/:slug/pi-sessions/audit/:filename  serves one export
```

On the WS path the data channel is binary frames of raw pty bytes (no base64). On the SSE fallback, bytes are base64-encoded over JSON to keep the stream uniform regardless of encoding (xterm.js handles arbitrary byte streams; pi may emit non-UTF-8 in edge cases like binary file contents). Idle PTYs (no input, no consumer marking activity) auto-kill after 5 minutes.

**Auth split.** Only the read/stream routes are `auth: 'public'` (`/:id/stream`, the two `/pi-sessions/audit` routes, and `/pty/tools`). The mutating routes — `spawn`, `resolve`, `prewarm`, `input`, `resize`, `kill` — are `auth: 'loopback'`.

**Reconnect / replay.** The server keeps two replay sources per handle: an `xterm-headless` mirror fed every byte (bounded screen-state serialization, \~tens of KB, VS Code's approach — used for WS reconnect), and a 1 MB raw-byte ring (full-history replay, used by the SSE path). A dashboard tab switch therefore resumes the same pty with prior output intact rather than starting fresh.

**Cross-agent wake routing.** Each managed pty is tagged with its owner SID (`PAPERCUSP_SID` from the spawn env) so the await-event wake executor can route a wake turn into the correct session. `findPtyByPid` carries a recycled-pid guard (EI-151): a recorded pid recycled by the OS to a *different* owner's live pty is not treated as a match.

### Critical files to read first

| File                                                                    | Why                                                                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/operator/app/harness/PiTerminalsDock.tsx` + `PiPanel.tsx`         | The current pi-pane surface — dockview multi-pane container + the xterm/SSE panel. (Supersedes the original `HarnessDashboard.tsx` `MainPanel`-union integration.) |
| `packages/operator-core/lib/endpoint-route/routes/index.ts`             | Hono route-table assembly. The pty router registers the same way the harness/plugins routers do.                                                                   |
| `papercusp-desktop/src-tauri/src/main.rs`                               | Sidecar spawn — confirms env passes through (`PATH`, etc.) which pi needs.                                                                                         |
| `packages/operator-core/lib/endpoint-route/routes/desktop/preflight.ts` | Pattern for prereq checks. The `pi` check mirrors the `claude` check (plus well-known-path probing).                                                               |
| `papercusp-desktop/web/index.html`                                      | `renderHint()` switch — the pi case.                                                                                                                               |

### Verification

**Phase 3a:**

1. Launch the desktop shell: `cd papercusp-desktop && npm run dev` (the only supported run path; it boots the operator sidecar + webview).
2. In the Tauri window, open a harness (`/harness/<some-slug>`).
3. Click the new pi tab.
4. Pi prompt appears; type `pwd` + Enter; output shows the harness's project directory.
5. Type `exit`; pane shows "(pi exited 0)" and the spawn lifecycle cleans up (verify `pgrep -af omp` returns nothing).
6. Resize the window; xterm-fit addon resizes; pi sees the new width (`tput cols`).

**Phase 3b:**
7\. Two-pane layout works: dashboard left, pi right; resizable divider; both visible.
8\. On a feature row, "Open in pi" puts pi inside that feature's worktree directory (verify with `pwd`).
9\. Pi's first prompt includes the feature spec + lineage (visible when asked "what are you working on?").

**Phase 3c:**
10\. `pi` shows as `missing` in the bootstrap UI when uninstalled; install hint card appears with a brew/install command.
11\. Once installed, `pi` flips to `ok` on next preflight tick; pi tab works.
12\. README quick-start mentions pi as optional.

**Cross-cutting:**

* No native-binary load errors at sidecar boot on macOS, Linux, Windows.
* The desktop bundle still ships within size budget (no inadvertent +100MB from xterm assets).
* No stray pty processes survive sidecar shutdown.

### Risks

| Risk                                                                                                                   | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node-pty` native binding fails under Next.js `output: 'standalone'` (Next traces deps and may miss the `.node` file). | Verify on day 1. If `next.config.js` `outputFileTracingIncludes` doesn't capture `node_modules/node-pty/build/Release/*.node`, add an explicit include. Fallback: ship pty-bridge as a separate child process the Next handler shells out to.                                                                                                                                                                                   |
| `node-pty` Windows ConPTY initialization fails on older Win10.                                                         | Document min Windows version (10 1809+) in README. Surface a clear inline error in the pane.                                                                                                                                                                                                                                                                                                                                    |
| Pi binary not on `PATH` despite being installed (Mac homebrew + Tauri-Cocoa launches without a login shell).           | Probe `/usr/local/bin/omp`, `/opt/homebrew/bin/omp`, `~/.cargo/bin/omp` in addition to `which`. Fall back to user-configurable `pi.binPath` in `config.json`.                                                                                                                                                                                                                                                                   |
| Concurrent pi panes spawn many processes / use lots of memory.                                                         | A **process-wide, host-scaled** cap, not a fixed per-harness number: `livePtyCap()` = `min(host-scaled backstop, fleet maxSimultaneousAgents)`, where the backstop = `min(2× the resource-profile agent budget, ceiling 16)`. Spawning past the cap throws `pty cap reached (n/cap)`; the pane surfaces it inline. On a small box this floors low (a 4-core laptop's backstop is \~2–4); on a typical box it sits well above 4. |
| Pi's nested PTY (its `bash` tool) conflicts with the outer xterm.js PTY — terminal corruption or signal loss.          | Spawn with `--no-pty`. Pi degrades gracefully (loses interactive bash but keeps every other tool).                                                                                                                                                                                                                                                                                                                              |
| Auth state drifts: user logged into Claude Code in their normal shell, but the desktop app launches without that env.  | Surface `ANTHROPIC_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` presence in the preflight UI; document the GUI-app-no-login-shell gotcha in the README.                                                                                                                                                                                                                                                                                   |

## What is explicitly NOT in scope

* Replacing the `vscode` tab — pi sits alongside it, not instead of it.
* Web (non-desktop) deployment of the pi pane — works the same way (sidecar is identical), but rollout is separate.

(The original "not in scope" list also named the pi plugin and session-persistence/resume; both shipped under Phase 3d — see the phasing notes above.)

Track A and Track B are independent — implement either or both. Track A alone is the smaller, less-visible change. Track B alone gives users the interactive override without changing how the autonomous loop runs. Together they make pi a first-class citizen in the desktop runtime.
