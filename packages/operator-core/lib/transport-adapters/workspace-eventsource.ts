/**
 * Per-window workspace on outbound SSE connects (per-window-workspace-context
 * -2026-05-31, P-015 / D-001 stream half).
 *
 * `EventSource` (and its desktop twin `IpcEventSource`) cannot set a custom
 * request header, so the fetch-path `x-papercusp-workspace` trick can't carry
 * the workspace on a live stream. The standard EventSource workaround is a query
 * param: this wraps the `window.EventSource` constructor to append
 * `?ws=getBrowserWorkspaceId()` to the operator's own SSE URLs. The middleware
 * reads `?ws=` as a fallback to the header, so live streams (oracle, agent-mcp
 * events, sync, …) resolve against the window, not the global `reg.current`.
 *
 * Installed from `RootSyncProvider` right after `installDesktopIpcPolyfills()`,
 * so it wraps `IpcEventSource` on desktop / native `EventSource` in the dev
 * browser — symmetric to `installWorkspaceHeaderFetch`. Only operator API URLs
 * are stamped (same-origin/loopback); external URLs pass through untouched.
 */
import { getBrowserWorkspaceId } from '../browser-workspace';
import { isOperatorApiUrl, withWorkspaceParam } from './workspace-api-target';

const WRAPPED_MARK = '__pcWorkspaceParamWrapped__';

/**
 * Idempotently wrap `window.EventSource` so operator SSE connects carry the
 * window's workspace as `?ws=`. No-op when already wrapped or outside a browser.
 */
export function installWorkspaceParamEventSource(): void {
  if (typeof window === 'undefined') return;
  const Current = window.EventSource as
    | (typeof EventSource & { [WRAPPED_MARK]?: boolean })
    | undefined;
  if (!Current || Current[WRAPPED_MARK]) return;

  const Wrapped = function (this: unknown, url: string | URL, init?: EventSourceInit) {
    let finalUrl: string | URL = url;
    try {
      const raw = typeof url === 'string' ? url : url.href;
      if (isOperatorApiUrl(raw)) finalUrl = withWorkspaceParam(raw, getBrowserWorkspaceId());
    } catch {
      /* fall through with the original url */
    }
    return new Current(finalUrl, init);
  } as unknown as typeof EventSource & { [WRAPPED_MARK]?: boolean };

  // Preserve prototype (instanceof) + the static readyState constants. The
  // constants are readonly on `typeof EventSource`, so assign via a writable view.
  Wrapped.prototype = Current.prototype;
  const statics = Wrapped as unknown as { CONNECTING: number; OPEN: number; CLOSED: number };
  statics.CONNECTING = Current.CONNECTING;
  statics.OPEN = Current.OPEN;
  statics.CLOSED = Current.CLOSED;
  Wrapped[WRAPPED_MARK] = true;

  window.EventSource = Wrapped;
}
