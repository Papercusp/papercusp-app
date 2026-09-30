/**
 * Browser-side workspace identity + localStorage key scoping.
 *
 * Per `workspace-localstorage-isolation-2026-05-27`. The Tauri webview loads
 * the operator at a fixed origin (`http://127.0.0.1:3070`), so localStorage is
 * shared across every workspace. Every workspace-relevant key must be
 * namespaced with the active workspace id.
 *
 * Id source precedence (D-001):
 *   1. `window.__PAPERCUSP_WS__` — injected into index.html by the
 *      workspace-specific operator host (see host-spa). Navigation-independent
 *      and correct on cold start, unlike `?ws=`.
 *   2. `?ws=` query param — back-compat / deep-link fallback.
 *   3. `'default'`.
 *
 * Callers MUST compute keys at call time — read the id per call, never capture
 * `wsLocalKey(...)` in a module-level constant. The injected global / URL may
 * not be set when a module is first evaluated.
 */

declare global {
  interface Window {
    /** Active workspace id, injected by the operator host into index.html. */
    __PAPERCUSP_WS__?: string;
  }
}

/** The active workspace id as seen by the browser. Falls back to 'default'. */
export function getBrowserWorkspaceId(): string {
  if (typeof window === 'undefined') return 'default';
  try {
    const injected = window.__PAPERCUSP_WS__;
    if (injected && injected.trim()) return injected;
  } catch {
    /* ignore */
  }
  try {
    const ws = new URL(window.location.href).searchParams.get('ws');
    if (ws && ws.trim()) return ws;
  } catch {
    /* ignore */
  }
  return 'default';
}

/** Namespace a localStorage key to the active workspace: `pc:ws:<id>:<key>`. */
export function wsLocalKey(key: string): string {
  return `pc:ws:${getBrowserWorkspaceId()}:${key}`;
}

/**
 * The workspace a view is *active* in (per-window-workspace-context-2026-05-31,
 * P-030 / D-005). It is the workspace THIS WINDOW opened — `windowWsId` (from
 * `getBrowserWorkspaceId()`) — never the process-global `reg.current`, which is
 * only the default a *new* window opens into. On a shared dev sidecar a single
 * `reg.current` drives every window, so resolving a window's view against it is
 * the "reload-flip to another workspace" bug this kills.
 *
 * Precedence: the window's workspace if it's a known workspace → else
 * `reg.current` if known → else the first workspace → else the window id
 * unchanged (degenerate empty registry).
 */
export function resolveActiveWorkspaceId(
  reg: { current: string; workspaces: { id: string }[] },
  windowWsId: string,
): string {
  const known = (id: string) => reg.workspaces.some((w) => w.id === id);
  if (windowWsId && known(windowWsId)) return windowWsId;
  if (reg.current && known(reg.current)) return reg.current;
  return reg.workspaces[0]?.id ?? windowWsId;
}
