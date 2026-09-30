# Native console launcher
URL: /internal/docs/desktop/native-console

The "+" button next to the voice button opens an OS-native terminal with the same MCP context spawned agents get. macOS, Linux, Windows-via-WSL.

## What it is

A small terminal-icon button in the chrome header — sibling to the
voice button — that opens a real OS-native terminal window. The
terminal lands in the active harness's directory (or workspace root
when there's no active harness), with env vars set and a `.mcp.json`
written so any agent the user invokes inside it (`claude`, `codex`,
`omp`, …) auto-discovers the operator's MCP server and gets the full
[tool catalog](/internal/docs/endpoint-system/tool-catalog) (581 built-in
tools as of this writing, per `.papercusp/tool-catalog.json`).

This is the visible end of the [superuser-mode](/internal/docs/endpoint-system/superuser-mode)
plumbing — that doc covers the threat model + token mechanics; this
page is about how to test it.

## How it works

There are two launch paths. The **primary** path is a same-origin,
server-side spawn: the operator process spawns the terminal itself, so
no Tauri IPC is involved — this now covers **both Linux and macOS**
(`console-spawn.ts` shared spawner). The **Windows** host (operator
inside the WSL2 sidecar, `isWindowsDesktopHost()`) can't spawn a
Session-1 GUI terminal itself, so it must defer to the desktop shell's
Tauri `console_launch` command — **two ways there**:

* **User "+" path:** the server route returns HTTP **501** and the
  renderer (`native-console.ts`) falls through to invoking
  `console_launch` directly over Tauri IPC.
* **Agent path (WI-3289, `allowDesktopBridge`):** an agent-tool caller
  (`capability:terminal`, and thus `fleet:launch-on-plan`) can't ride
  the renderer fallback (there's no webview in the call), so
  `spawnConsole` **relays the envelope to the desktop webview over the
  sync-bus bridge** (`console-launch-bridge.ts` →
  `requestDesktopConsoleLaunch`) and awaits the Tauri result — so the
  caller gets a real `ok`/`error` verdict and REAL Windows terminals
  open (a bridge failure returns `code:502`). Without this, an
  agent-driven Windows launch just 501'd and opened nothing.

(A non-Linux, non-macOS, non-WSL2 host would also 501, but that isn't a
supported desktop target.)

```
click +   ─►  POST /api/agent-mcp/console/launch { slug?, planSlug?, label?, resumeSessionId? }   (PRIMARY)
              ─►  operator spawns directly via console-spawn.ts:
                  ├─ build ConsoleEnvelope (cwd, env, mcp.json body, …)
                  ├─ .mcp.json write with backup-restore at cwd
                  ├─ interactive safety floor (concurrency ceiling → 429)
                  ├─ record adv_sessions row (surfaced in /adv/sessions)
                  └─ spawn OS terminal in NEW WINDOW, recolored + titled
                          ├─ Linux:  $TERMINAL → gnome-terminal/konsole/…
                          └─ macOS:  open -na <term> /tmp/papercup-console-*.command
                                     (operator runs natively in the user's GUI
                                     session as a child of the desktop .app, so
                                     it can open Terminal/iTerm itself — no IPC)

              ─►  if operator host is the Windows WSL2 sidecar → HTTP 501 → FALLBACK:
                  POST /api/agent-mcp/console/resolve { slug? }
                  ─►  returns ConsoleEnvelope
                  ─►  Tauri invoke('console_launch', { envelope })
                      ─►  Rust:
                          ├─ ensure ~/.papercusp/superuser-token (installer)
                          ├─ atomic .mcp.json write with backup-restore
                          └─ spawn OS terminal in NEW WINDOW
                              └─ Windows: wt.exe -w new wsl.exe -d papercup-runtime
```

Every click opens a **new window**, not a new tab.

The primary route also records an `adv_sessions` tracking row (tagged
with the launch's `planSlug` / `label`, visible in `/adv/sessions`) and
ends it when the terminal exits. The Tauri fallback path skips this
row. Interactive launches waive brain admission but still pass a
concurrency ceiling: over-ceiling returns HTTP 429 and **no terminal
opens**.

`console-spawn.ts` is the ONE shared spawn primitive (terminal
selection, the OSC appearance prelude, the launcher one-liner) reused
by both this route and the `capability:terminal` agent tool (and, in
turn, `fleet:launch-on-plan`'s member terminals) — see
[desktop-fleet-vs-loop-cup](/internal/docs/agent-insights/desktop-fleet-vs-loop-cup).
`capability:terminal` calls it with `writeMcpJson:false` (it runs an
arbitrary command, so it must not displace the project's real
`.mcp.json`); this route calls it with `writeMcpJson:true`.

## What appears inside the new terminal

The launcher runs a single bash one-liner before exec'ing the user's
shell:

```bash
cd <cwd> && export PATH=<scripts-dir>:$PATH \
         && export PAPERCUSP_HARNESS_SLUG=… \
         && export PAPERCUSP_WORKSPACE=default \
         && export PAPERCUSP_API_BASE=http://127.0.0.1:3070 \
         && (papercup status) ; \
         __papercusp_greeting_rc=$?; \
         if [ "$__papercusp_greeting_rc" -ne 0 ]; then \
           printf '\n[papercusp] initial terminal command exited with status %s; terminal left open for inspection.\n' "$__papercusp_greeting_rc"; \
         fi ; \
         exec "${SHELL:-/bin/bash}" -l
```

The greeting prints workspace + harness + pending suggestion count +
escalations. If the greeting exits with a non-zero status, a banner displays
the exit code and leaves the terminal open for inspection (rather than
immediately exec'ing the shell). This helps diagnose environment issues during
launch. When the greeting succeeds, the user is in their normal shell
(zsh/bash/fish/…) with everything inherited from their rc files.

On the server-side path (Linux and macOS both, via `console-spawn.ts`)
the launcher prepends an appearance prelude before the one-liner: OSC
escapes recolor the window (dark, plan-slug-hashed background — or a
bound fleet color scheme, when the launch belongs to one; light
`#f4f4f5` foreground for ANSI brights) and set the title to
`SH[adv:<id>]: <label>` (or just `SH[adv:<id>]` when there's no
label/plan). So the smoke test sees a **colored** window with a tagged
title, not a default-theme terminal.

`.mcp.json` is dropped at cwd (backup-and-restore if one already
existed). Inside that terminal, running `claude` or `codex` connects
to `/api/mcp?superuser=1&workspace=<workspaceId>` (the active
workspace, e.g. `default` — or `workspace=*` when launched
all-workspaces; the harness slug never lands in this param) with the
bearer header from `~/.papercusp/superuser-token`.

## Smoke test — macOS

1. Build the desktop app (`cd papercusp-desktop && npm run tauri build`).
2. Launch it. Open `/harness/sheets`.
3. Click the terminal-icon button next to the voice button.
4. Verify:
   * A new Terminal.app window appears (not a tab in the front window).
   * The first line shows: `papercup — workspace 'default' · harness 'sheets'`.
   * `pwd` prints the sheets project directory.
   * `echo $PAPERCUSP_HARNESS_SLUG` prints `sheets`.
   * `ls .mcp.json` lists a file containing `superuser=1`.
5. Type `claude` (assuming you have claude-code installed). After
   it connects, run `/mcp` inside claude — `papercusp` should appear
   in the server list.
6. Try a tool call: ask claude "what features are in this harness?"
   It should call `features:list` or `harness:status` and respond
   from real data.

If iTerm2 is installed at `/Applications/iTerm.app` the launcher
prefers it; otherwise Terminal.app. This detection now happens
**server-side** for the primary path
(`console-spawn.ts:macConsoleInvocation`, `existsSync('/Applications/iTerm.app')`);
`native_console.rs:detect_macos_default_terminal` is the same logic
kept in Rust for the Tauri IPC fallback (Windows path today — see
"How it works").

## Smoke test — Linux

Same as macOS, with these differences in step 4:

* `$TERMINAL` is honored first. If unset, the launcher cascades through
  `gnome-terminal` → `konsole` → `xfce4-terminal` → `alacritty` →
  `kitty` → `wezterm` → `xterm` in order.
* Each terminal opens with its new-window flag (`--new-window` for
  konsole, `--always-new-process` for wezterm, defaults for
  alacritty/kitty/xterm). On the primary server-side path gnome-terminal
  is invoked with `--wait --window --`; the `--wait` is required so the
  thin gnome-terminal client process doesn't exit immediately and make
  the `adv_sessions` row look ended. (The Tauri fallback's Rust table
  uses `--window --`, without `--wait`.)
* If none of those are installed, the launcher errors with
  `no terminal emulator found. Set $TERMINAL or install one of: …`.

Force a specific terminal for testing:

```bash
TERMINAL=alacritty <run the operator>
```

## Smoke test — Windows (WSL)

Prerequisite: complete the WSL onboarding (`wsl_setup` state machine
must reach `Ready` — the wizard handles this).

1. From the desktop app, click the terminal-icon button.
2. Verify:
   * A new Windows Terminal window appears (not a tab).
   * The tab title contains `wsl.exe -d papercup-runtime`.
   * `pwd` inside is the Linux-side cwd (e.g. `$HOME/papercup`).
   * `echo $PAPERCUSP_HARNESS_SLUG` works the same way as on Linux.

When `wt.exe` isn't present (older Win10 without Windows Terminal),
the launcher falls back to bare `wsl.exe` with `CREATE_NEW_CONSOLE`.
Each click still produces a separate console window.

## Smoke test — endpoint only (no Tauri)

You can exercise the operator-side envelope-builder without launching
a terminal:

```bash
curl -X POST http://127.0.0.1:3070/api/agent-mcp/console/resolve \
  -H 'content-type: application/json' \
  -d '{"slug":"sheets"}' | jq
```

Expected fields:

```jsonc
{
  "cwd": "/home/.../sheets-clone",
  "env": {
    "PAPERCUSP_HARNESS_SLUG": "sheets",
    "PAPERCUSP_WORKSPACE": "default",
    "PAPERCUSP_API_BASE": "http://127.0.0.1:3070",
    "PAPERCUSP_OPERATOR_URL": "http://127.0.0.1:3070",
    "PAPERCUSP_HOME": "/home/.../.papercusp-workspaces/default",
    "PAPERCUSP_SCRIPTS_DIR": "/home/.../apps/operator/scripts",
    "PI_CODING_AGENT_DIR": "/home/.../sheets-clone/.papercusp/pi-sessions"
  },
  "mcpJsonContents": "{ \"mcpServers\": { \"papercusp\": { \"url\": \"http://127.0.0.1:3070/api/mcp?superuser=1&workspace=default\", \"headers\": { \"Authorization\": \"Bearer …\" } } } }",
  "greetingCmd": "papercup status 2>/dev/null || true",
  "needsSuperuserBootstrap": false
}
```

`needsSuperuserBootstrap: true` means `~/.papercusp/superuser-token`
doesn't exist yet — the Tauri side runs `install-standalone-mcp.sh`
before writing the `.mcp.json`. The `mcpJsonContents` won't contain a
real bearer token in that case; one is wired in by the next request
after bootstrap completes.

Pass `{"slug": null}` (or omit the body) for a workspace-only console
— cwd becomes the workspace root, no `PAPERCUSP_HARNESS_SLUG` or
`PI_CODING_AGENT_DIR` are set, the MCP URL still pins `workspace=default`.

The written `.mcp.json` is **ephemeral**: a papercup-file watcher
(polling for `.papercup-console-active.*` files) restores the prior
`.mcp.json` — or removes ours when none existed — once the last
papercup-launched shell exits, bounded by a 24h hard timeout. It does
not persist at cwd after you close the terminals.

The `POST /console/launch` route also accepts `resumeSessionId`. When
set, the greeting becomes `resuming plan-run <id>…` and the console
`exec`s straight into the live agent CLI (`<agent-cli> -r <session-id>`)
instead of opening a fresh shell. The resume also **re-asserts the
frictionless permission mode** per invocation (permission mode is NOT
inherited from the resumed session): `claude` gets
`--dangerously-skip-permissions --permission-mode bypassPermissions`,
`omp` gets `--approval-mode yolo` — else a bare `claude -r` drops the
user into default ask-per-tool mode (owner-hit on the Windows app,
2026-07-07). (The `/console/resolve` route used by the Tauri fallback
does not thread `resumeSessionId` or `allWorkspaces`, so a resolve-based
envelope is always scoped and non-resume.)

## What the agent in the terminal can do

Per the [tool catalog](/internal/docs/endpoint-system/tool-catalog), the full
built-in surface (581 tools as of this writing) plus the plugin tools
are exposed via `?superuser=1`:

* **Read workspace state**: `harness:status`, `tasks:list`,
  `features:get`, `goals:list`, `issues:list`, `work_items:list`.
* **Operator surface**: `operator:audit`, `operator:nudge`.
* **Cross-workspace**: `papercusp:list_workspaces`, then any tool
  with `?workspace=<slug>`.
* **Spawn / supervise other agents** (the full `fleet:*` surface):
  ~~`cup:spawn`~~ (**retired 2026-08-09 — refuses**; it reached that name via
  `fleet:spawn` →\[WI-1764]→ `bee:spawn` →\[pot-rename D-007, migration 519]→ `cup:spawn`, then
  retired with the [Mug · Kettle · Cup tier](/internal/docs/agent-insights/mug-kettle-cup-tier-is-retired);
  launch with `fleet:launch-on-plan`), `fleet:supervise`, `fleet:cancel`,
  `fleet:tree`, `fleet:assignments`, plus `fleet:admit`, `fleet:bee_mail`,
  `fleet:drain`, `fleet:governor`, `fleet:place_batch`,
  `fleet:sandbox_deps`, `fleet:selected_bee`. (The old
  `orchestrator.spawn` plugin was retired 2026-06-06 — superseded by
  the `fleet/` tools.)
* **Plugin tools**: `repomix.pack`, `gitnexus.*`, `firecrawl.*`,
  `code2prompt.*`, `fetch_plus.*`.

Every call is recorded in `harness_shared.tool_invocations` with
`role='operator'` (the default when no `?role=` param is sent). Note
that `run_id` is **not** a `'standalone'` papercup — the shared
papercup was removed (it created a cross-cancellation hazard), and each
superuser/console MCP call now gets a per-request UUID
(`crypto.randomUUID()`). Filter the Intel panel by `role='operator'`,
not by `runId='standalone'` (that returns nothing).

## Common failure modes

| Symptom                                     | Cause                                                         | Fix                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Toast "no terminal emulator found"          | Linux without any of the 7 known terminals                    | `apt install gnome-terminal` or set `$TERMINAL`                                       |
| `unknown harness slug` 400                  | UI sent a slug not in `harness_registry`                      | Refresh the page; harness may have been deleted                                       |
| `429` / over-ceiling, no terminal opens     | Too many concurrent agent sessions (interactive safety floor) | Close some sessions, then retry                                                       |
| Terminal opens but `papercup` isn't on PATH | Dev mode without sidecar bundle                               | Verify `PAPERCUSP_SCRIPTS_DIR` env var inside the terminal points at a real directory |
| `claude` says no MCP server                 | `.mcp.json` not in cwd, or stale bearer                       | `cat .mcp.json`; re-run `install-standalone-mcp.sh` to rotate                         |
| Tab opens instead of new window             | Terminal's args missing new-window flag                       | Bug — file the OS + emulator name                                                     |

## Where the code lives

| File                                                                            | Role                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/operator/app/_components/ConsoleLauncherButton.tsx`                       | The button + terminal icon SVG                                                                                                                                                                                             |
| `packages/operator-core/lib/native-console.ts`                                  | Renderer-side wrapper: tries the server-side `/console/launch` POST first, falls through to `commands.consoleLaunch` (Tauri IPC) only on a 501                                                                             |
| `packages/operator-core/lib/console-launcher.ts`                                | Server-side envelope builder (`buildConsoleEnvelope`)                                                                                                                                                                      |
| `packages/operator-core/lib/console-spawn.ts`                                   | Shared spawn primitive (`spawnConsole`/`buildConsoleOneliner`): Linux terminal-cascade selection, the OSC appearance prelude, and the macOS `open -na` spawner — reused by this route AND `capability:terminal`            |
| `packages/operator-core/lib/endpoint-route/routes/agent-mcp/console-launch.ts`  | The Hono `POST /api/agent-mcp/console/launch` handler (primary path — calls `console-spawn.ts`)                                                                                                                            |
| `packages/operator-core/lib/endpoint-route/routes/agent-mcp/console-resolve.ts` | The Hono `POST /api/agent-mcp/console/resolve` handler (envelope-only, used by the Tauri fallback)                                                                                                                         |
| `apps/operator/scripts/papercup-status.mjs`                                     | The greeting CLI shown on first line                                                                                                                                                                                       |
| `apps/operator/scripts/papercup`                                                | Bash dispatcher shim                                                                                                                                                                                                       |
| `papercusp-desktop/src-tauri/src/native_console.rs`                             | The Tauri `console_launch` command + per-OS spawners (today's live path only for the Windows/WSL2 host; macOS/Linux logic here is superseded by `console-spawn.ts`'s server-side path but kept for the Tauri IPC fallback) |
| `packages/operator-core/lib/spawn-config.ts`                                    | Shared primitives (cwd/env) between Pi pty + native console                                                                                                                                                                |
