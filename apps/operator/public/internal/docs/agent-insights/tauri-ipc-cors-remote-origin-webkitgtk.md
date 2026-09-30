# Tauri IPC \"access control checks\" console flood on Linux — fix it in the SPA, not wry
URL: /internal/docs/agent-insights/tauri-ipc-cors-remote-origin-webkitgtk

The desktop logs 'Fetch API cannot load ipc://localhost/endpoint_invoke due to access control checks' on every navigation. The reliable fix intercepts the ipc:// fetch in the desktop fetch wrapper (force postMessage) — NOT a wry/CORS patch (which couldn't be made to work).

## Symptom

The Tauri desktop console logs, repeatedly (once per `/api` call → a flood):

```
Fetch API cannot load ipc://localhost/endpoint_invoke due to access control checks.
```

The app still works (Tauri carries IPC over its postMessage transport), but the console is unusable.

## Root cause

Papercusp loads the operator UI from a **remote `http://127.0.0.1:<port>` origin** (`frontendDist`/`devUrl`),
not the bundled `tauri://` asset protocol. Tauri's injected IPC script tries the
`ipc://localhost/<cmd>` **custom-protocol fetch first** on non-Android. On Linux/WebKitGTK, wry
registers custom URI schemes secure-only (never CORS-enabled), and the page origin is a remote
`http://` one — so WebKitGTK rejects the cross-origin `ipc://` fetch with "access control checks",
even though Tauri's IPC handler returns `Access-Control-Allow-Origin: *`.

## The fix that works — SPA-level, force postMessage

Intercept the `ipc://` fetch in the desktop's own `window.fetch` wrapper
(`installDesktopIpcPolyfills`, `libs/generic/desktop-ipc/src/desktop-bootstrap.ts`) and **reject it
before any native fetch is issued**. Tauri's init script catches the rejection and transparently
retries the invoke over its **postMessage** transport — the path that already carries every IPC
call on this platform. Because no native `ipc://` fetch is ever made, the WebKit engine never
evaluates it and **cannot log the access-control error**. The matching one-per-load Tauri
`console.warn('IPC custom protocol failed …')` is filtered in the same place.

This is purely a SPA/TypeScript change, so it ships via the operator-vite bundle and takes effect
on the next SPA rebuild + a desktop **reload** — on ANY binary (no Rust rebuild, works on old
desktop builds too). The app's `endpoint_invoke` command (and the channel-data path) fall back to
postMessage cleanly; behavior is identical minus the console noise.

## What did NOT work (don't repeat this)

* **Patching wry to register the scheme CORS-enabled** (`register_uri_scheme_as_cors_enabled` next
  to the `_as_secure` call in `wry/src/webkitgtk/web_context.rs`, via a vendored `[patch.crates-io]
  wry`). It compiled, but could not be verified to silence the error on WebKitGTK, and it pins wry
  to a vendored copy. Reverted. If you revisit a wry-level fix, you MUST prove it before relying on
  it — see verification below.
* A **post-build** `register_uri_scheme_as_cors_enabled` in `tauri-runtime-wry` — too late;
  WebKitGTK reads scheme registrations before the web process spawns.

## Verification — the bridge traps (this cost hours)

`tauri-agent-tools` could NOT reliably confirm/deny the fix; trust these instead:

* **`eval`-based `fetch('ipc://…')` is INVALID.** The bridge's eval runs in a context that does not
  reproduce the page's CORS, so it returns `AbortError`/pending on BOTH a buggy and a fixed binary.
* **`console-monitor` across a reload is unreliable** — it loses the post-reload console (a papercup
  warn emitted after reload was not captured), so a captured warn may be stale buffer.
* **The capture bundle's `console-errors.json` is errors-only** and the WebKit engine error bypasses
  the JS `console.*` hook — so it never appears there.
* **What DID work — count real `ipc://` fetches.** Wrap `window.fetch` via eval to increment a
  counter on `ipc://` URLs, then watch it over a few seconds of live app traffic:
  `window.__a=0; const o=window.fetch; window.fetch=(u,...r)=>{if(String(u).startsWith('ipc://'))window.__a++;return o(u,...r)};`
  Pre-fix it climbs (\~273 over 5s, custom-protocol active); with the interceptor it stays **0**
  (Tauri latched to postMessage → no ipc:// fetch is ever issued → no possible access-control error).

## Gotcha: multiple desktop instances / ports

The dev box runs several desktops at once on different content ports — the `npm run dev` shell
(`:3270`, working-tree dist), the fleet staging operator (`:3170`, the separate `papercup-staging`
checkout), the green release (`:3070`, `papercup-release`). They serve DIFFERENT SPA builds. A fix
in the canonical tree reaches `:3270` immediately (rebuild + reload) but `:3170`/`:3070` only after
their own sync + rebuild/deploy. Confirm WHICH port the affected window is on (its address bar)
before concluding a fix didn't land — you may be looking at a stale build.
