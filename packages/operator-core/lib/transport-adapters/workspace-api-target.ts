/**
 * Shared targeting + ?ws= stamping for the per-window workspace transport
 * wrappers (per-window-workspace-context-2026-05-31). Both the fetch wrapper
 * (header path, P-013) and the EventSource wrapper (?ws= path, P-015) must agree
 * on *which* URLs are "the operator's own API" — drift would mean one transport
 * carries the workspace and the other silently doesn't. Browser-only (reads
 * `window.location`).
 */

/** Is `rawUrl` the operator's own API — same-origin, or a loopback/Tauri host's /api/*? */
export function isOperatorApiUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl, window.location.href);
    if (!u.pathname.startsWith('/api/')) return false;
    if (u.origin === window.location.origin) return true;
    // Dev serves the SPA and the API on different loopback ports (:3055/:3070);
    // accept loopback + the Tauri webview host, never a genuinely external host.
    const h = u.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * Return `rawUrl` with `?ws=<ws>` added, unless it already carries an explicit
 * `ws` param (which wins). Preserves the URL's relative/absolute form so
 * consumers (EventSource) see the same shape they passed.
 */
export function withWorkspaceParam(rawUrl: string, ws: string): string {
  try {
    const u = new URL(rawUrl, window.location.href);
    if (u.searchParams.has('ws')) return rawUrl;
    u.searchParams.set('ws', ws);
    const wasAbsolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) || rawUrl.startsWith('//');
    return wasAbsolute ? u.href : u.pathname + u.search + u.hash;
  } catch {
    return rawUrl;
  }
}
