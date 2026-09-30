# \"Couldn't find callback id\" console flood = stale IPC Channels, not event listeners
URL: /internal/docs/agent-insights/tauri-callback-id-flood-stale-ipc-channels

A webview reload orphans every in-flight endpoint-IPC Channel (the JS finally that sends CANCEL never runs), so Rust keeps fanning stream frames into dead callbacks. Fixed by an on_page_load flush; this page records the diagnosis path — including why Tauri event listeners CANNOT cause this warning.

## Symptom

The desktop webview console floods with warn-level spam — bursts of the same
handful of callback ids, repeating indefinitely:

```
[TAURI] Couldn't find callback id 1071212001. This might happen when the app
is reloaded while Rust is running an asynchronous operation.
```

It starts after any webview reload (Ctrl+R, a Vite full-reload, navigation)
and never stops. `notifications:recent` and error-level console capture are
both clean — it's pure console noise, but heavy enough to look like the app
is broken.

## The diagnosis shortcut (what costs an hour to re-derive)

The warning is emitted by `window.__TAURI_INTERNALS__.runCallback` when Rust
evals a callback id the *current* page doesn't have. Two Rust→JS delivery
mechanisms could plausibly produce it, and only one actually can:

* **Tauri event listeners (`listen()` / `pty-data` etc.) — CANNOT cause it.**
  In tauri 2.11 the Rust-side `js_event_listeners` map does survive a reload
  (nothing clears it on navigation), but the emit script guards with
  `const listener = listeners[id]; if (listener) runCallback(...)` against the
  *JS-side* listeners object, which a reload wipes. Stale event listeners are
  silently skipped. Don't burn time on `pty-tauri.ts` / `listen()` cleanup.
* **Tauri Channels (`tauri::ipc::Channel`) — the actual cause.** A Channel
  send evals `runCallback(id, …)` directly, with no liveness guard, and
  `Channel::send` cannot detect the callback is gone (the eval is
  fire-and-forget). Every long-lived Channel orphaned by a reload warns on
  every subsequent send.

In this app the only Channel surface is **endpoint-IPC**
(`papercusp-desktop/src-tauri/src/endpoint_ipc.rs`): the webview's `/api`
fetch + EventSource ride `endpoint_invoke` Channels — *including in dev*
(the debug build connects to the externally-run operator's socket via
`~/.papercusp/endpoint-ipc.json`; "IPC is dormant in dev" is only true when
that file is absent). The \~8–10 recurring ids were the page's long-lived
streams (sync SSE, log tails, agent feeds); the JS `finally` that sends
CANCEL never runs on a reload, so the Rust `in_flight` map kept fanning
server frames into dead callbacks forever — and the operator kept doing the
streaming work server-side.

## The fix (2026-06-09)

`main.rs` registers a `Builder::on_page_load` hook: on `PageLoadEvent::Started`
it calls `IpcClientHandle::flush_for_page_load()`, which synchronously
detaches every in-flight call (`IpcClient::detach_all`) and CANCELs them
server-side in the background. Flushing at `Started` means the new page's
first invoke can't be swept up. Unit coverage:
`drain_in_flight_empties_map_and_returns_ids` in `endpoint_ipc.rs`.

## If it comes back

* Check the Rust log for `[endpoint_ipc] webview (re)load — cancelled N stale
  in-flight call(s)` on reload. Absent → the hook isn't firing (binary stale?
  a second webview label?).
* A *new* Channel surface (anything else taking `tauri::ipc::Channel`) needs
  the same page-load flush discipline — Channels never self-clean across
  reloads.
* Capture evidence with `tauri-agent-tools console-monitor --pid <pid> --duration 30000 --json` (duration is **milliseconds**; the agent-e2e doc's
  `--duration 100` examples are too short to catch periodic bursts).
