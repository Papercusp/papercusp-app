/**
 * crossOriginUrl — build an absolute URL to our own server on the *sibling*
 * loopback host (localhost <-> 127.0.0.1, same scheme + port).
 *
 * Why this exists
 * ---------------
 * The harness page keeps ~6 long-lived SSE streams open (zero-harness sync,
 * flags, ui-intents, operator state-snapshot, harness log…). That is the
 * browser's *entire* HTTP/1.1 connection budget — Chromium allows only 6
 * concurrent sockets per origin. On-demand fetches like the commit diff
 * (`/api/harness/:slug/git/show/:sha`) then get zero free sockets and sit
 * in the queue until they time out — the "loading diff… forever" bug.
 *
 * `localhost` and `127.0.0.1` resolve to the same server but are *different
 * origins* for the browser's per-origin socket pool. Fetching the diff from
 * the sibling host gives it a fresh, empty 6-socket pool that the SSE
 * streams never touch. The target route answers with
 * `Access-Control-Allow-Origin: *` so the cross-origin GET is permitted
 * (it is an unauthenticated, loopback-only read — no credentials sent).
 *
 * HTTP(S) only — the sharding helps exclusively where the browser enforces a
 * per-host socket pool over real HTTP. On the desktop the webview runs under
 * the `papercusp://localhost` custom scheme (custom_protocol.rs, Phase 4),
 * where the SPA's same-origin `/api/*` fetch is intercepted by the desktop-ipc
 * polyfill and routed over IPC (no HTTP socket pool at all). Rewriting the host
 * there would be doubly wrong: it breaks the polyfill's same-origin match so
 * the call escapes IPC, AND it yields a cross-origin custom-scheme URL that the
 * `/api/*` CORS layer (which only allows http/https/tauri/capacitor/ionic)
 * rejects. So under any non-http(s) scheme we no-op and let the same-origin
 * path ride the IPC polyfill.
 *
 * SSR-safe: returns the path unchanged when `window` is absent, the origin is
 * not http(s), or the page is not on a loopback host (nothing to shard).
 */
export function crossOriginUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  // Inside the Tauri desktop webview, same-origin `/api/*` rides the desktop-ipc
  // polyfill (fetch + EventSource over IPC — no HTTP socket pool at all), so there
  // is nothing to shard. This holds for BOTH the production `papercusp://` custom
  // scheme AND the dev shell's `http://localhost:3070` (which the protocol/hostname
  // checks below would otherwise wrongly shard). Sharding in the webview is ALSO
  // broken on WebKitGTK: the cross-origin loopback fetch is rejected outright
  // (`TypeError: Load failed`) — which broke clicking a commit (`git/show`) and
  // saved-prompts on the desktop.
  //
  // ⚠ CORRECTION (2026-08-03, measured): this comment used to call that "doubly
  // broken" and give a second mechanism — "libsoup pools `localhost` and
  // `127.0.0.1` as ONE host (the sibling yields no extra sockets)". THAT MECHANISM
  // IS FALSE. Measured in webkit2gtk-4.1 2.52.3 (the lib Tauri v2 embeds, verified
  // via webkit2gtk-sys 2.0.2 -> pkg-config `webkit2gtk-4.1`), driving a real
  // headless webview: the two hostname strings get SEPARATE ~6-connection pools,
  // and the cap is per ORIGIN (scheme+host+PORT), not per hostname — 20 fetches at
  // `127.0.0.1:A` yielded 6 sockets with 14 queued, while `localhost:A` and
  // `127.0.0.1:B` each independently got their own 6. Plan
  // no-http-anywhere-2026-07-28 D-048 has the full method and numbers.
  //
  // The no-op below is UNCHANGED and still correct: the same-origin `/api/*` IPC
  // path and the outright rejection each justify it on their own. Worth knowing WHY
  // the false claim survived so long, because it generalises — a request rejected
  // before it reaches the wire and a request that shares a saturated pool look
  // IDENTICAL from the caller's side (no response, no extra throughput), so the
  // observation "the sibling yields no extra sockets" was real while the mechanism
  // inferred from it was not. Detect the webview via the injected IPC bridge.
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke?: unknown } };
  if (typeof w.__TAURI_INTERNALS__?.invoke === 'function') return path;
  const { protocol, hostname, port } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return path;
  const sibling =
    hostname === 'localhost' ? '127.0.0.1'
    : hostname === '127.0.0.1' ? 'localhost'
    : null;
  if (!sibling) return path;
  return `${protocol}//${sibling}${port ? `:${port}` : ''}${path}`;
}
