/**
 * Per-window workspace header on outbound fetch (per-window-workspace-context
 * -2026-05-31, P-013 / D-001 fetch half).
 *
 * Each window knows its workspace (`getBrowserWorkspaceId()` →
 * `__PAPERCUSP_WS__` / `?ws=`) but the operator API never saw it, so the
 * backend resolved against the process-global `reg.current`. This wraps
 * `window.fetch` to stamp `x-papercusp-workspace` on the operator's own API
 * calls, which `workspaceContextMiddleware` reads into the request-scoped ALS.
 *
 * Installed from `RootSyncProvider` *after* `installDesktopIpcPolyfills()`, so
 * on desktop it wraps `ipcFetch` (which forwards headers end-to-end) and in the
 * dev browser it wraps native `fetch`. Only the operator's own API is stamped
 * (same-origin or a loopback/tauri host) — never a genuinely external host, so
 * the workspace id can't leak off-box.
 *
 * Streams (`EventSource`/`IpcEventSource`, WS) can't carry a custom header and
 * are handled separately (D-001/P-015); this is the request/fetch path only.
 */
import { getBrowserWorkspaceId } from '../browser-workspace';
import { isOperatorApiUrl } from './workspace-api-target';

const WORKSPACE_HEADER = 'x-papercusp-workspace';
const WRAPPED_MARK = '__pcWorkspaceHeaderWrapped__';

function rawUrlOf(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input instanceof Request
        ? input.url
        : String(input);
}

/**
 * Idempotently wrap the current `window.fetch` so operator API calls carry the
 * window's workspace. Safe to call repeatedly; a no-op when already wrapped or
 * outside a browser.
 */
export function installWorkspaceHeaderFetch(): void {
  if (typeof window === 'undefined') return;
  const current = window.fetch as (typeof window.fetch & { [WRAPPED_MARK]?: boolean }) | undefined;
  if (!current || current[WRAPPED_MARK]) return;
  const inner = current.bind(window);

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      if (isOperatorApiUrl(rawUrlOf(input))) {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        if (!headers.has(WORKSPACE_HEADER)) {
          headers.set(WORKSPACE_HEADER, getBrowserWorkspaceId());
        }
        return inner(input, { ...init, headers });
      }
    } catch {
      /* fall through to the unmodified call */
    }
    return inner(input as RequestInfo, init);
  }) as typeof window.fetch & { [WRAPPED_MARK]?: boolean };

  wrapped[WRAPPED_MARK] = true;
  window.fetch = wrapped;
}
