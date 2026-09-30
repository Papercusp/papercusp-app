# Desktop IPC looks dead? Diagnose the advertisement, not the socket count
URL: /internal/docs/agent-insights/desktop-ipc-dead-diagnose-the-advertisement

Every desktop /api call silently riding native HTTP is almost always ONE cause — endpoint-ipc.<port>.json naming a dead operator after a restart. Here is the 3-command diagnosis, why socket counts mislead, and the latch that turned a transient window into a permanent one.

## The symptom

The desktop feels slow. Streams look stuck. Someone measures **6 sockets pinned to the
operator port** and concludes the libsoup \~6-connection cap is saturated by starved SSE
streams, then reaches for a concurrency constant (`DEFAULT_MAX_IN_FLIGHT`) to tune.

**Do not tune anything yet.** Both halves of that reading are usually wrong.

## Do not diagnose this from socket counts

A socket count cannot tell you which transport your streams are on, for two reasons:

1. **The webview is served FROM the operator port.** The SPA document, its asset bundles,
   and the deliberately-IPC-excluded `/api/desktop/*` polls all legitimately use that pool.
2. **Six is what a healthy full keep-alive pool looks like**, not evidence of starvation.

Measured on a HEALTHY instance where every stream was verified to be riding IPC, the
webview's network process still held \~6 TCP connections. Measured on a BROKEN instance
where 100% of IPC was failing, it also held 6. **The number is identical in both regimes,
so it carries no diagnostic signal at all.** An `ss -tnpi` breakdown of a "saturated" pool
showed one active stream, one finished 630KB bundle download, and four idle keep-alives.

## Diagnose it with the inspector instead

IPC traffic is invisible to the devtools Network panel — it rides a unix socket, not HTTP —
so the inspector is the only instrument that sees it. It is installed at module-eval by
`RootSyncProvider`, *before* any component opens a stream, but it is **off in a production
bundle** (which is what the desktop serves) unless you opt in:

```js
localStorage['papercusp.ipcInspector'] = '1'   // then RELOAD — it must install before the streams open
window.__ipcInspector.summary()                // started vs done vs error, per route
window.__ipcInspector.churn()                  // constructions vs CONNECTS, per stream URL
window.__ipcInspector.events({ kind: 'invoke-error' })   // the actual failure strings
```

Read `summary()` first. `done: 0` with `error: N` across every route — including plain
POSTs, not just SSE — means the whole transport is down, not a streaming bug.

⚠ **`churn()`'s `connects` is the field that matters, and it is the one people skip.**
A stream can be constructed as an `IpcEventSource` and still never connect. Checking only
that `new EventSource(...)` returns a non-native object proves the *constructor* skipped the
fallback branch — it does **not** prove a single byte moved over IPC. Healthy looks like
`constructions: 1, connects: >=1, errors: 0`. Broken looks like `connects: 0, errors: 1`.

## The cause, nearly every time

```
invoke_failed: invoke_failed: endpoint-ipc connect: No such file or directory (os error 2)
```

ENOENT means the Rust client dialed a socket path that does not exist. Check the
advertisement against reality:

```bash
cat ~/.papercusp/endpoint-ipc.<port>.json     # -> { socketPath, pid, port }
ls -la <that socketPath>                      # does the socket exist?
ps -o pid,args -p <that pid>                  # is that operator still alive?
```

The failure mode: **the operator restarted, and the advertisement still names the previous,
dead instance.** Its socket died with it, so every dial gets ENOENT until the new operator
rewrites the file. On a live box this was measured at **160 consecutive failed invokes,
100% failure across every route**, against a `pid` that `ps` showed was dead and a
`socketPath` that did not exist. Minutes later the same file named a live pid with a
present socket, and everything worked.

This is not rare here — operator restarts are constant (`dev:restart`, every deploy, every
green-checkpoint promotion), so this window is entered many times a day.

**The Rust side is not caching.** `IpcClientHandle.socket_source` is a
`Box<dyn Fn() -> Option<PathBuf>>` resolved lazily on every connect
(`src/endpoint_ipc.rs`), so it genuinely re-reads the file each time. It re-reads a file
that is *itself* stale. The missing guard is validation: nothing checks the advertised pid
is alive before dialing.

## Why a transient window used to become permanent

`IpcEventSource` carried a module-global one-way latch:

```ts
let ipcStreamingUnavailable = false;   // set on IPC-unavailable, cleared by NOTHING in production
```

The only reset was a test-only helper. So a **single** ENOENT — from one restart window —
flipped it for the life of the webview, and every subsequent `new EventSource(...)` returned
a genuine native `EventSource`. That is how a seconds-long outage became "this window does
all its streaming over HTTP until you close it," and why the symptom read as chronic.

Fixed (WI-6255) by making it a re-probing cooldown that also clears the instant any IPC
stream connects. A companion change (WI-6257) treats "the bridge isn't up **yet**" as a
retryable condition inside a startup grace rather than a fatal one, so a boot race no longer
demotes a stream at all.

Note the asymmetry that made this confusing: **`ipcFetch` never had the latch.** Its
fallback is decided per call, so fetch silently self-healed while streams stayed stranded —
a split-brain transport that presents exactly like a concurrency cap.

## Do not "just force IPC"

Tempting, and wrong. Both transports terminate at the **same operator process** (IPC:
webview → Tauri → Rust handle → unix socket → operator; HTTP: webview → `127.0.0.1:<port>`
→ the same pid). So the HTTP fallback does *not* protect you from an operator outage — if
the operator is down, HTTP is down too. Its only genuine value is the window where the
operator serves HTTP but the IPC bridge has not connected. Two paths can never use IPC and
must keep working: `:3055` in a real browser (no Tauri), and `/api/desktop/*` (deliberately
excluded — it must hit the content origin or the env-switcher self-hides).

## Verify in a clean room, not the owner's window

`scripts/verify-tauri-headless.sh -- <your assertion>` boots an isolated instance (own X
display, own devUrl port, own sidecar, frozen SPA snapshot) and tears it down after. Arm the
inspector, reload, then read `summary()`/`churn()`.

Two traps it will hand you:

* **The SPA snapshot is frozen at boot.** Confirm your edit is actually in it before trusting
  a result — object property names survive minification, so
  `grep -rl "<yourNewConfigKey>" "$WORK/spa"` is a reliable marker. Otherwise you may be
  measuring the previous bundle.
* **Port collisions.** Ports are picked free-at-pick-time; on a loaded box a straggler from
  someone's `--boot-only` run can take it between pick and bind, and you get `EADDRINUSE`
  and a 180s wait for a dev server that never comes. Just re-run; it picks another display.

A settled healthy reading looks like this — every stream connected, no errors:

```
totals: { started: 40, done: 22, error: 3 }    // the 3 are "aborted" — the reload cancelling in-flight calls
churn:  connects >= 1 and errors: 0 on every path
advertisement: socket exists=YES, pidAlive=YES
```

## Two stale docblocks in this area — mistrust prose, verify against code

Both cost real investigation time in one session, so check before trusting:

* `isIpcUnavailable`'s comment claimed dev "never `.manage()`s an IpcClient". **False** —
  `main.rs` has a `#[cfg(debug_assertions)]` block managing a *reconnecting* `IpcClientHandle`
  that re-reads `endpoint-ipc.<port>.json`. Dev skips the **sidecar spawn**, not IPC. Fixed
  in place with a do-not-restore warning.
* `agent-insights/desktop-ipc-transport-map` still says a debug build "can never complete the
  handshake". That predates the dev reconnecting handle; dev connects to a separately-running
  operator's IPC server via the advertisement, no sidecar handshake involved.
* A comment citing "DesktopAttentionNotifier's \~4s grace" as the consumer open-watchdog bound
  names a component that **does not exist anywhere in the tree**. Do not treat 4s as measured.

## Housekeeping leak worth knowing

`~/.papercusp/` accumulates \~90 `endpoint-ipc.*.json` advertisements and
`~/.papercusp/sockets/` \~96 stale socket files, dating back months — mostly one per
`verify-tauri-headless.sh` run (the 33xxx/34xxx port families), never cleaned up. Ephemeral
ports get reused, so a stale advertisement whose port a new instance happens to bind is
another route into the ENOENT failure above. Tracked with the validate-before-dialing fix.
