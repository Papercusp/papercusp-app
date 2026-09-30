# tauri-agent-tools probe said 'alive' while the app was unreachable — health now checks the real origin (EI-13218)
URL: /internal/docs/agent-insights/tauri-bridge-health-now-checks-real-origin-reachability

The dev bridge's /health endpoint computed sidecars_alive from PID-liveness only, over a sidecar registry that is ALWAYS EMPTY in production (register_sidecar/spawn_sidecar_monitored are #[cfg(test)]-only, never wired to the real dev-operator spawn path) — a vacuous true regardless of whether the Hono+SPA origin the webview displays was actually reachable. /health now live-probes that origin and folds it into sidecars_alive.

## Symptom

`tauri-agent-tools probe` reports a live PID and a healthy-looking bridge,
but in-webview `fetch('/api/health')` / `fetch('/')` fail with `Load
failed` right around the same time. The rendered DOM stays visible
(stale-capable), so a verification pass that trusts bare `probe` alone can
report success against an app that cannot actually serve a request.

## Root cause

Two compounding gaps in `papercusp-desktop/src-tauri/src/dev_bridge.rs`:

1. **The sidecar registry is always empty in production.** `register_sidecar`
   and `spawn_sidecar_monitored` — the only two ways anything ever gets added
   to `SidecarRegistry` — are both `#[cfg(test)]`-only. Nothing outside this
   file's own unit tests calls them. The real dev operator (`:3270`) is
   spawned by a *shell script* (`bin/dev-operator-ifneeded.sh`), not by this
   Rust process, so it was never registered as a "sidecar" in the first
   place.
2. **`sidecars_alive` was PID-liveness only, and `all()` over an empty
   iterator is vacuously `true`.** `sidecars.iter().all(|s| matches!(s.alive,
   Some(true) | None))` on an empty `sidecars` Vec is always `true` — so
   `/health`'s headline signal reported "sidecars alive: yes" unconditionally,
   regardless of whether the operator origin was actually up. `webview_ready`
   (`!app_handle.webview_windows().is_empty()`) only proves a window object
   exists, not that it can load anything.

Net effect: nothing in the bridge's own health surface ever reflected
real HTTP reachability of the origin the webview is supposed to be
displaying. `tauri-agent-tools probe`'s "Bridge alive: yes" is, by the
external tool's own design, just "the bridge's tiny control-plane HTTP
server answered" — accurate on its own terms, but easy to over-read as "the
app works."

## Fix

`/health` now does a real, bounded (800ms) HTTP GET against
`<current-webview-URL>/api/health` (via `reqwest::blocking`, a client built
once at bridge start) and folds the result into `sidecars_alive`:

```rust
let sidecars_alive = pid_sidecars_alive && operator_reachable.unwrap_or(true);
```

`operator_reachable: Option<bool>` is also exposed as its own field —
`None` when there's no main webview / its URL can't be read (nothing to
check, never a false failure), `Some(false)` only on a confirmed
connect-refused/timeout/transport error. The check itself is a small, pure,
injectable-client function (`origin_reachable`) so it's unit-testable
without a real Tauri `AppHandle` — tests spin up a real `tiny_http`
responder for the true case and a bind-then-drop `TcpListener` for a
deterministic connection-refused (no timeout wait) for the false case.

**No external-tool change needed.** `tauri-agent-tools health` (bridge
v0.7.0+, distinct from `probe`) already reads `sidecars_alive` and exits
non-zero when it's false (`--json` mode) — so this fix makes an
already-shipped, already-CI-gateable command correctly detect the exact
failure class the ticket describes, with zero changes to the (external,
unmodifiable) npm package. `probe` itself is unaffected — its "Bridge alive"
line was never reading this field, and still isn't; the fix is to prefer
`health` over bare `probe` for a real liveness verdict, per the updated
`agent-e2e.mdx` §1.3.

## The tell

If `probe` looks healthy but the app is misbehaving, reach for
`tauri-agent-tools health` (or `--json`) before concluding load/a crash —
its `operator_reachable` / `sidecars_alive` fields now reflect the origin,
not just the bridge's own control-plane process.
