# PTY architecture

Pseudo-terminal infrastructure powering `PiPanel` / `PiTerminalsDock` /
the `pi` plugin in the operator. Three transports, one control plane,
one backing pty manager. References the popular projects whose
implementation we follow.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ Renderer (PiPanel.tsx)                                             │
│                                                                    │
│   isTauriNative()? ──yes──▶ Tauri IPC (E)                          │
│       │                       openNativeSession()                  │
│       │                       invoke('pty_*')                      │
│       │                       listen('pty-data') / listen('pty-exit')│
│       no                                                           │
│       ▼                                                            │
│   try WebSocket (B)  ──open──▶ AttachAddon + flow-control acks     │
│       │                                                            │
│       fallback (timeout 1.5s)                                      │
│       ▼                                                            │
│   SSE + per-keystroke POST  (legacy)                               │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Control plane — operator HTTP routes (app/api/_hono/pty.ts)        │
│                                                                    │
│   POST /api/harness/:slug/pty/spawn      — fork + register handle  │
│   POST /api/harness/:slug/pty/prewarm    — reserve a hot handle    │
│   POST /api/harness/:slug/pty/resolve    — return args/cwd/env (E) │
│   POST /api/harness/:slug/pty/:id/kill   — explicit close          │
│                                                                    │
│   B and E share /resolve and /spawn for harness-aware config       │
│   (omp prompt prepend, worktree cwd, MCP server registration).     │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Pty manager (lib/pty-bridge.ts)                                    │
│                                                                    │
│   spawnPty / writePty / resizePty / killPty                        │
│   getHistory()              — raw byte ring (1 MB cap, SSE replay) │
│   getScreenSerialization()  — P4: parsed screen state via          │
│                               @xterm/headless + addon-serialize    │
│                                                                    │
│   handleFlowControl: true   — F3, node-pty XON/XOFF cooperation    │
│   PtyHandle.history         — byte ring, oldest-eviction           │
│   PtyHandle.headless        — server-side xterm parser fed every   │
│                               byte; mirrors resize()               │
│                                                                    │
│   State pinned on globalThis so HMR re-imports / multiple bundles  │
│   share the same handles map.                                      │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ @lydell/node-pty — actual fork(2) + ptmx                           │
└────────────────────────────────────────────────────────────────────┘
```

Tauri E pty-host is its own complete stack in `papercusp-desktop/src-tauri/src/pty.rs`:
`portable-pty` instead of `node-pty`, an in-process registry keyed by uuid,
a 1 MB history ring per pty, Tauri events for output. Used only when
`window.__PAPERCUSP_TAURI__` is present (set by Tauri's webview eval).

## Wire format reference

### B: WebSocket (`lib/pty-ws.ts`)

- Path: `ws://<host>:<PAPERCUSP_PTY_WS_PORT, default 3056>/pty/<id>`
- Server → client: **binary frames** of raw pty bytes (xterm AttachAddon
  decodes via `Uint8Array`).
- Client → server: **binary frames** are user input bytes (forwarded to
  `writePty`). **Text JSON frames** are control:
  ```
  { type: 'resize', cols, rows }
  { type: 'ack',    bytes }   // flow control — see F2
  { type: 'kill' }
  ```
- Server-only text frames: `{ type: 'exit', code }` once.

### E: Tauri IPC (`src-tauri/src/pty.rs` + `lib/pty-tauri.ts`)

- Commands: `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`,
  `pty_history`, `pty_is_alive`.
- Events: `pty-data` `{ id, data: base64 }` and `pty-exit` `{ id, code }`.
- `pty_history` returns base64 of the raw byte ring (parallel to
  `getHistory` on the operator side).

## Real-world precedents

The implementation choices map onto established projects:

| Concern              | Maps to                                              |
| -------------------- | ---------------------------------------------------- |
| Sidecar WS server    | Wetty, GoTTY, ttyd                                   |
| `AttachAddon` client | xterm.js's own `@xterm/addon-attach`                 |
| WebGL renderer       | xterm.js's `@xterm/addon-webgl`                      |
| Find-in-scrollback   | xterm.js's `@xterm/addon-search` (Ctrl+Shift+F)      |
| OSC 52 clipboard     | xterm.js's `@xterm/addon-clipboard`                  |
| 5 ms output coalesce | VS Code `TerminalDataBufferer`                       |
| 100 KB watermark     | VS Code `FlowControlConstants` (HighWatermarkChars)  |
| `handleFlowControl`  | node-pty's documented XON/XOFF cooperation           |
| Screen-state replay  | VS Code remote terminal restore (`TerminalRecorder`) |
| Reconnect backoff    | GoTTY `--reconnect`                                  |
| WS heartbeat         | gotty / ttyd / `ws` library README's canonical pattern |
| OSC title / bell     | xterm.js's `onTitleChange` / `onBell`                |
| Native pty desktop   | Codespaces split web/native paths; Warp's Rust core  |

See [`docs/pty-ws-nginx.conf`](pty-ws-nginx.conf) for the production
reverse-proxy snippet (Upgrade pass-through).

## Environment opt-outs

| Variable                              | Default | Effect                              |
| ------------------------------------- | ------- | ----------------------------------- |
| `PAPERCUSP_PTY_WS`                    | enabled | `=0` to disable the WS server entirely (forces SSE+POST fallback) |
| `PAPERCUSP_PTY_WS_PORT`               | 3056    | Override the WS server port        |
| `PAPERCUSP_PTY_WS_ORIGINS`            | ∅       | Comma-separated allow-list of WS Origin hosts (production)  |
| `PAPERCUSP_PTY_FLOW_CONTROL`          | enabled | `=0` to disable node-pty XON/XOFF flow control (F3) |
| `NEXT_PUBLIC_PAPERCUSP_PTY_WEBGL`     | enabled | `=0` (build-time) to skip the WebGL renderer addon |

## Dev-mode gotchas

### Next 16 `allowedDevOrigins`

Next 16 dev mode rejects HMR WebSocket upgrades whose `Origin` doesn't
match the configured host — without an explicit allow-list, requests
from `127.0.0.1` while the page was served from `localhost` (or vice
versa) get blocked with:

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/webpack-hmr from "127.0.0.1"
```

The HMR client retries indefinitely, which prevents `next/dynamic`
Suspense boundaries from settling, destabilizes RSC payload fetches,
and looks like the dock / xterm chunks "never load." The fix is the
documented `allowedDevOrigins` list in `next.config.js`:

```js
allowedDevOrigins: ['localhost', '127.0.0.1', '0.0.0.0', '*.local'],
```

This is dev-only — production doesn't run the HMR endpoint.

### Pty cap exhaustion

`MAX_CONCURRENT_PTYS = 16` in `lib/pty-bridge.ts`. Across many page
loads / test runs in dev, prewarmed handles can accumulate against
this cap if the kill / cleanup paths leave them in the `handles` map
with `killed=false`. Two safeguards:

- **Killed handles leave the map** after a 30 s grace (just enough to
  serve a final reconnect-replay), preventing the map from growing
  unbounded.
- **Prewarm reaper uses `killPty(handle.id)`** instead of
  `handle.pty.kill()` directly so the `killed` flag flips synchronously
  rather than waiting for `pty.onExit` to fire. Cap is freed at the
  right time on bursty page loads.

Both already shipped — flagging here as the failure mode that surfaced
in the integration test suite when run against an operator with stale
handles.

## Tests (20 total)

- `lib/pty-bridge.test.ts` (4 cases) — spawn, history, P4 serialize,
  geometry-correct replay after resize, keystroke forwarding.
- `lib/pty-ws.test.ts` (7 cases) — origin reject, unknown-id reject,
  malformed-URL reject, binary round-trip + replay on reconnect, resize
  control frame, exit text frame, ack tolerance.
- `test/pty-stack.integration.test.ts` (4 cases, `RUN_PTY_INTEGRATION=1`) —
  full lifecycle vs live operator: spawn → WS attach → input round-trip
  → reconnect P4 replay → resume by ID → /resolve → kill; origin reject;
  flow-control acks.
- `papercusp-desktop/src-tauri/src/pty.rs` `#[cfg(test)]` (5 cases) —
  spawn/history, write/echo, resize, alive lifecycle, unknown-id errors.
