# Desktop IPC transport map — what rides IPC, what's dormant, how to turn it on
URL: /internal/docs/agent-insights/desktop-ipc-transport-map

The desktop routes webview /api traffic over Tauri IPC to dodge WebKitGTK's ~6-conn libsoup cap. Three mechanisms, all gated behind PAPERCUSP_DESKTOP_IPC + a release-only sidecar spawn. Here's the whole map + the turn-on recipe + the SSE-over-IPC reconnect/churn contract (D-006) + how to verify with window.__ipcInspector + the gotchas.

## Why IPC exists here

The desktop is Tauri/WebKitGTK. WebKitGTK's libsoup HTTP stack caps **\~6 connections
per host**, so the operator's long-lived SSE streams (sync, log/provision streams,
agent-thinking, UI-intents, …) camp every slot and starve on-demand `fetch()`. The fix:
route the webview's same-origin `/api/*` traffic over **Tauri IPC** (a Unix domain
socket to the Node sidecar) instead of real HTTP sockets, dodging the cap entirely.

## The three IPC mechanisms

1. **`sys:http` blanket bridge** — `installDesktopIpcPolyfills()`
   (`libs/generic/desktop-ipc/src/desktop-bootstrap.ts`, installed at module-eval in
   `apps/operator/app/_components/RootSyncProvider.tsx`) patches:
   * `window.fetch` → `ipcFetch` for **same-origin `/api/*`, string/URL input, string body**.
   * `window.EventSource` → `IpcEventSource` (all EventSources).
     Any component using `fetch('/api/...')` or `new EventSource('/api/...')` rides IPC with
     **zero per-call changes**. Falls back to native when IPC is unavailable. **Gaps it does
     NOT cover:** cross-origin, non-`/api/` paths, `Request`-object input, binary/Blob/FormData
     bodies, and WebSockets.
2. **Typed `endpoint_invoke` dispatch** — `dispatchEndpointStream`
   (`libs/generic/desktop-ipc/src/index.ts`): picks IPC on Tauri for typed event-stream
   tools, gated by a host **allowlist** in `apps/operator/bin/host-bootstrap.ts` (the IPC
   server start logic moved there from the retired `instrumentation-node.ts`; it calls
   `startEndpointIpcServer` from `packages/operator-core/lib/endpoint-ipc/server.ts`).
   Returns the same `EndpointStreamEvent` union on both transports, so a consumer migrated
   to it keeps a working HTTP fallback in the browser.
3. **`expose.ipc: true`** — declarative per-tool flag in `ToolExposure`
   (`libs/generic/tooldef` `tool-projection.ts`). The intended successor to the hardcoded
   allowlist; `defineTool`'s auto-projection must thread `input.expose?.ipc` for it to reach
   the registry.

## It is OFF by default in dev — the dormancy gates

A live probe will usually find `endpoint_invoke` → **"state not managed"**. Three gates
must all be satisfied for IPC to actually run:

* **`PAPERCUSP_DESKTOP_IPC`** (desktop env, `papercusp-desktop/src-tauri/src/main.rs`):
  the desktop only sets `PAPERCUSP_IPC_ENABLE=1` on the sidecar + pipes its stdout to parse
  the handshake when this is on. **As of 2026-05-31 it defaults ON** (disable with `=0`).
* **Release vs dev build** — the sidecar is spawned **only in release** (`cfg!(debug_assertions) == false`). A `tauri dev` / `cargo build` (debug) run prints *"dev mode — skipping sidecar
  spawn"* and the operator runs separately on `:3055`/`:3070` with **no IPC server**. So a
  debug binary can never complete the handshake — you need `cargo build --release`.
* **The handshake** — the sidecar boots its IPC server only when `PAPERCUSP_IPC_ENABLE=1`
  (`apps/operator/bin/host-bootstrap.ts`, which starts `startEndpointIpcServer`), prints
  `PAPERCUSP_IPC_READY socket=<path>`; Rust parses it, `IpcClient::connect` + `app.manage`.
  Until `app.manage` runs, `endpoint_invoke` errors with "state not managed", and
  `ipcFetch` falls back to native HTTP while `IpcEventSource` falls back to a native
  EventSource (commit `7ef90807`).

## Turn-on / verify recipe

```bash
cd papercusp-desktop/src-tauri && cargo build --release      # NOT debug — dev skips the sidecar
PAPERCUSP_DESKTOP_IPC=1 ./target/release/papercusp-desktop   # redundant now it defaults on
```

Release/bundled mode spawns its own sidecar on a **free port** (no `:3070`/systemd
conflict — `find_free_port`), and points the webview at `window.__papercuspBase`. Verify
on the new window via the dev bridge (`tauri-agent-tools eval --port <p> --token <t>`):
`endpoint_invoke('dev:ipc_echo')` returns a result (not "state not managed");
`window.EventSource`/`window.fetch` are the patched polyfills; `~/.papercusp/sockets/<pid>.sock`
exists.

**But connectivity is NOT the real check** — see the churn contract below. A
`dev:ipc_echo` that returns a result proves the wire works; it does **not** prove
the long-lived SSE streams are stable, which is what actually broke (flashing).

## SSE-over-IPC reconnect — the churn contract (D-006, 2026-06-01)

Turning IPC on once surfaced a sharp regression: **the desktop flashed —
constant full reloads.** Root cause was a reconnect-ownership conflict between
the transport and its consumer, now fixed across three layers. The invariant to
preserve when touching any of them:

> **The transport auto-reconnects on a transient drop (readyState CONNECTING);
> a consumer recreates the EventSource only when it is genuinely dead (readyState
> CLOSED).** Recreating on a CONNECTING drop discards a stream that was about to
> resume — and over IPC that means a brand-new channel + a sync-layer
> re-subscribe + a re-render on *every* blip. That is the flashing.

What went wrong + the fix (`@papercusp/desktop-ipc` + `@papercusp/sse`):

1. **`IpcEventSource` was one-shot** — a dropped stream (`done` / transient
   error) called `close()` (terminal). Native `EventSource` instead
   auto-reconnects (CONNECTING, resumes with `Last-Event-ID`). Fixed: it now
   reconnects internally, terminal only on `close()` or a fatal head. (`8f2da9a`)
2. **A fatal error fired BEFORE `close()`** — so readyState still read CONNECTING
   when a consumer's error handler ran, hiding the death. Fixed: a `terminate()`
   helper sets readyState CLOSED *then* dispatches `error` (faithful to native),
   so a recreate-on-CLOSED consumer rebuilds — and on the IPC-unavailable latch,
   the rebuild yields a native EventSource fallback. (`5da236d`)
3. **`createResilientEventSource` force-recreated on EVERY error** — it closed
   the underlying ES and span up a fresh one on every blip. Fixed: it recreates
   only on readyState CLOSED, leaving CONNECTING drops to the underlying ES; the
   zombie watchdog stays the safety net and escalation still counts every error.
   (`c6927b3`)

`DesktopAttentionNotifier` got the same recreate-on-CLOSED alignment (`7b827b2c1`).
All four changes are unit-proven (66 tests) but **not yet live-verified** — the
verification below is the open step.

**Verify it (the real check):** open **/dev → IPC tab → churn**, or in the
desktop devtools console:

```js
window.__ipcInspector.churn()
// PASS → [{ path:'/api/zero-harness/sse', constructions:1, drops:>0,
//           verdict:'OK — one persistent channel (N internal reconnects)' }]
// FAIL → constructions climbing for one URL = a consumer is still recreating it.
```

The inspector (`packages/operator-core/lib/dev/ipc-inspector-client.ts` + the zero-cost
seam in `libs/generic/desktop-ipc/src/ipc-inspector.ts`) is on automatically in
dev. **But IPC only runs in a *release* build** (debug skips the sidecar spawn —
see the dormancy gates), and a release build is `NODE_ENV=production`, where the
inspector is off by default — so to observe the actual fix you must opt in:
**`localStorage['papercusp.ipcInspector'] = '1'` then reload** the release window
(real users never set it). IPC traffic is invisible to the devtools Network panel
(it rides the unix socket, not HTTP), so the inspector is the *only* way to see
the reconnect cadence — `constructions` (new channels) vs `connects`/`drops`
(internal reconnects) is exactly the churn signal. Plan:
`calltool-endpoint-seam-2026-06-01` (Phase C/D, D-006).

**LIVE-CONFIRMED (2026-06-02).** Drove a release build via the dev bridge:
navigated the window to `papercusp://localhost` → `window.location.origin ===
'papercusp://localhost'`, `isSecureContext`, `window.EventSource`/`window.fetch`
are the minified `IpcEventSource`/`ipcFetch` polyfills, and `GET /api/desktop/
version → 200` round-tripped over IPC with **no `ipc://` access-control block**.
A 4-min run showed every healthy SSE stream rock-stable (`es_drop=0`, 0
reconstructions, no flashing). The off-HTTP-on-IPC goal is met. (The unique
transient-drop → one-channel-reconnect is test-proven, 72 tests; it can't be
*staged* live because the sync SSE is LISTEN-fanout drop-resistant and killing
the sidecar is a *fatal* event — the fix classified that correctly: `drops=0`,
recreate + native fallback.)

## The audit conclusion (2026-05-31)

Because `sys:http` blankets all same-origin `/api/*` fetch + EventSource, **per-call-site
"migrate to IPC" work is tiny** — once IPC is on, \~everything rides it automatically. The
only genuine residual gaps: console-launch's old `Image().src`/absolute-`:3055` hacks (fixed
to a relative same-origin POST), and the Deepgram STT WebSocket (external `wss://`, not
reachable over the local socket). The terminal PTY — the one full-duplex webview channel —
already uses a dedicated native Tauri pty command, not a WS. The IPC framing is
**server-push-only** (Request + Cancel are the only client→server frames), so full-duplex
channels can't map onto it as-is.

## Resumability

`libs/generic/tooldef/src/replay-buffer.ts` (Phase-4 T2.2) already buffers per
`(workspaceId, toolName, runId)` and the HTTP SSE routes already honor
`Last-Event-ID + X-Papercusp-Run-Id` (`parseLastEventId`; `agent-tools/catchall.ts` sets the
run id). The remaining work for the typed dispatch path is wiring that cursor through
`http-stream.ts` / `ipc-stream.ts` so a reconnect resumes from the buffer.

## Gotchas that cost time

* **`cargo build … | tail` masks the exit code** — the pipeline reports `tail`'s status, not
  cargo's. A failed compile looks like "exit 0". Read the actual log tail for `error[E...]`.
* **`open_devtools()` doesn't exist in release** — it's compiled out unless the tauri
  `devtools` feature is on; gate it `#[cfg(debug_assertions)]` (fixed 2026-05-31). This had
  kept the release binary \~3 weeks stale.
* **A debug binary launched directly is still "dev mode"** — the sidecar-spawn gate is the
  compile profile (`debug_assertions`), not how you launch it. Don't expect IPC from
  `target/debug/papercusp-desktop`.
* **Raw `cargo build --release` keeps the DEV frontend.** A bare `cargo build --release`
  produces a release-*profile* binary (so it takes the IPC/sidecar path) but bakes in the
  `tauri.conf.json` **`devUrl` (`:3055`)**, not the production bootstrap — so the window
  loads `http://localhost:3055`, never navigates to `papercusp://localhost`, and the
  polyfill stays *native* (no IPC). Use `tauri build` (or `npm run build`) to bake the
  production frontend; only that path navigates to `papercusp://localhost` (verified 2026-06-02).
* **`build.rs` re-assembles the sidecar on every cargo build — don't run it while a sidecar
  is live.** Each `cargo build` copies sidecar binaries (`code-server/lib/node`,
  `embedded-postgres/bin/postgres`, …); if a prior desktop's sidecar/code-server is still
  running it triggers `Text file busy (ETXTBSY)`, and `kill -9` mid-copy can leave the
  binaries corrupt → `embedded-postgres did not accept TCP` / code-server `Exec format error`.
  Kill ALL release/sidecar processes first, then retry the build (verified 2026-06-02).
* **Embedded-PG boot can crash on a migration `42P01`→`42703` chain.** A migration whose
  one-`BEGIN…COMMIT` file `ALTER`s a table created by *ensure-schema* (not by a migration —
  e.g. `feature_queue`) throws `42P01` at embedded-boot (migrations run BEFORE ensure-schema),
  rolling back the WHOLE file → a later migration that uses the un-added column hard-crashes
  the entire PG boot with `42703` (no database at all). Fix: `ALTER TABLE IF EXISTS` on
  ensure-schema tables (graceful no-op at boot). Found + fixed in 097/098 on 2026-06-02.

See the plan `desktop-ipc-transport-completion-2026-05-20` for the broader effort.
