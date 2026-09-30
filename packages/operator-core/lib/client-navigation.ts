import { getBrowserWorkspaceId } from './browser-workspace';
import { isChromelessPath } from './chromeless-routes';
import { commands } from './tauri-bindings';

/**
 * The Quick Panel popup window (papercusp-desktop `src-tauri/src/docs_search.rs`)
 * is chromeless by ROUTE only — nothing else stops it from navigating to a
 * full-app route in place, which turns the small 760×540 palette into the whole
 * operator app (owner report 2026-07-14, WI-4827). The Rust palette window sets
 * this global via an initialization script; the main app window never does.
 */
export function isQuickPanelWindow(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as unknown as { __PAPERCUSP_QUICK_PANEL_WINDOW__?: boolean })
      .__PAPERCUSP_QUICK_PANEL_WINDOW__ === true
  );
}

/**
 * Should a navigation FROM the Quick Panel window be handed off to the main app
 * instead of run in place? Returns the app-relative `path+search+hash` to open
 * in the main window, or null when the navigation should proceed normally —
 * i.e. this is not the panel window, the target is off-origin / an exotic
 * scheme (external links, mailto:, custom schemes go out via the OS, not the
 * panel), or the destination is still inside the chromeless sandbox
 * (panel→panel navigation, which must stay in place).
 *
 * Pure + window-free so it is unit-testable; `navigateClient` and the panel
 * page's capture-phase anchor interceptor both drive it (WI-4827).
 */
export function resolveQuickPanelHandoff(
  target: string,
  currentHref: string,
  opts: { isQuickPanelWindow: boolean },
): string | null {
  if (!opts.isQuickPanelWindow) return null;
  let next: URL;
  let current: URL;
  try {
    next = new URL(target, currentHref);
    current = new URL(currentHref, currentHref);
  } catch {
    return null;
  }
  if (!(next.protocol === 'http:' || next.protocol === 'https:')) return null;
  if (next.origin !== current.origin) return null;
  if (isChromelessPath(next.pathname)) return null;
  return `${next.pathname}${next.search}${next.hash}`;
}

/**
 * Hand `route` to the desktop, which opens it in the main app window
 * (Spotlight-style) and hides the palette.
 *
 * Uses the TYPED specta binding. It previously went through a raw
 * `__TAURI_INTERNALS__.invoke('open_route_in_app')` because the generated bindings
 * this package could see were a stale second copy that predated the command — the
 * duplicate removed in EI-18899708711154370 / D-014. There is now one generated
 * file, in this package, so raw invoke buys nothing and costs the compile-time check
 * on the command name and its arguments.
 *
 * Best-effort: outside a Tauri webview this is a no-op, but the only caller path is
 * gated on `isQuickPanelWindow()`, which only the Rust palette window sets — so we
 * are always in Tauri here.
 */
export function openRouteInApp(route: string): void {
  if (typeof window === 'undefined') return;
  try {
    void commands.openRouteInApp(route).catch(() => {
      /* best-effort — a failed hand-off must never navigate the panel in place */
    });
  } catch {
    /* best-effort — e.g. no Tauri IPC available in this window */
  }
}

/**
 * Does `target` switch the window to a workspace other than `currentWorkspaceId`?
 *
 * A workspace change can NEVER be a soft SPA navigation: the operator host
 * (`host-spa`) injects `window.__PAPERCUSP_WS__` from the request's `?ws=` only
 * on a full document load, and `getBrowserWorkspaceId()` prefers that injected
 * global over `?ws=`. So a soft (pushState) nav to a different `?ws` leaves the
 * window stamping the OLD workspace on every fetch/SSE — the "switch reloads to
 * the same workspace" bug. Such navigations must be hard (full reload).
 */
function targetChangesWorkspace(parsed: URL, currentWorkspaceId: string | undefined): boolean {
  if (!currentWorkspaceId) return false;
  const nextWs = parsed.searchParams.get('ws')?.trim();
  return !!nextWs && nextWs !== currentWorkspaceId;
}

export function shouldSoftNavigate(target: string, currentHref = window.location.href): boolean {
  try {
    const current = new URL(currentHref, currentHref);
    const next = new URL(target, currentHref);
    if (!(next.protocol === 'http:' || next.protocol === 'https:')) return false;
    return next.origin === current.origin;
  } catch {
    return false;
  }
}

export function resolveClientNavigation(
  target: string,
  currentHref: string,
  opts?: { replace?: boolean; hard?: boolean; currentWorkspaceId?: string },
): { mode: 'soft' | 'hard' | 'none'; href: string | null; replace: boolean } {
  const replace = Boolean(opts?.replace);
  let parsed: URL;
  try {
    parsed = new URL(target, currentHref);
    if (!(parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return { mode: 'none', href: null, replace };
    }
  } catch {
    return { mode: 'none', href: null, replace };
  }

  // A forced-hard nav (a workspace switch) or any nav that changes the
  // workspace must do a full document load so the host re-injects
  // `__PAPERCUSP_WS__` — see targetChangesWorkspace.
  if (opts?.hard || targetChangesWorkspace(parsed, opts?.currentWorkspaceId)) {
    return { mode: 'hard', href: parsed.href, replace };
  }

  if (!shouldSoftNavigate(target, currentHref)) {
    return { mode: 'hard', href: parsed.href, replace };
  }

  const href = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return { mode: 'soft', href, replace };
}

/**
 * Perform a GENUINE hard navigation that survives the static desktop host's
 * `location.assign`/`location.replace` override.
 *
 * The desktop host (`apps/operator-vite/index.html`, active on :3070/:4173 —
 * what the packaged desktop webview loads) redefines `location.assign` and
 * `location.replace` to a SAME-ORIGIN soft `pushState`/`replaceState`, so a
 * stray JS navigation can't reload the desktop session mid-task while
 * `vite build --watch` rewrites `dist/`. That override silently downgrades a
 * forced-hard nav (a workspace switch → `/harness?ws=<id>`) to a soft one: the
 * document never reloads, the host never re-injects `window.__PAPERCUSP_WS__`,
 * and `getBrowserWorkspaceId()` keeps returning the OLD workspace — the
 * "switch does nothing" bug.
 *
 * The host stashes the genuine methods on `window` BEFORE installing the
 * overrides (`__papercuspOriginalAssign`/`__papercuspOriginalReplace`, mirroring
 * `__papercuspOriginalReload` — see lib/hard-reload.ts), precisely so a
 * deliberate hard nav can bypass the suppression. The stash + the override are
 * installed together in one try-block (stash first), so the two consistent
 * states are: (a) stash present AND override present → use the stash to bypass;
 * (b) no stash AND no override (off-desktop, or the block aborted) → the native
 * methods are genuine. Either way this reaches a real document load.
 */
function hardNavigate(href: string, replace: boolean): void {
  const w = window as unknown as {
    __papercuspOriginalAssign?: (target: string) => void;
    __papercuspOriginalReplace?: (target: string) => void;
  };
  const stashed = replace ? w.__papercuspOriginalReplace : w.__papercuspOriginalAssign;
  if (typeof stashed === 'function') {
    try {
      stashed(href);
      return;
    } catch {
      /* fall through to the native methods (genuine off-desktop) */
    }
  }
  if (replace) window.location.replace(href);
  else window.location.assign(href);
}

export function navigateClient(target: string, opts?: { replace?: boolean; hard?: boolean }): void {
  if (typeof window === 'undefined') return;
  // WI-4827: in the Quick Panel window, a navigation that would LEAVE the
  // chromeless sandbox is handed to the main app instead of run in place (which
  // would turn the palette into the whole operator app). The panel page's
  // capture-phase anchor interceptor handles link clicks; this catches the
  // PROGRAMMATIC navigations (router/useNavigate/direct navigateClient calls).
  const handoff = resolveQuickPanelHandoff(target, window.location.href, {
    isQuickPanelWindow: isQuickPanelWindow(),
  });
  if (handoff) {
    openRouteInApp(handoff);
    return;
  }
  const action = resolveClientNavigation(target, window.location.href, {
    ...opts,
    currentWorkspaceId: getBrowserWorkspaceId(),
  });
  if (action.mode === 'hard' && action.href) {
    hardNavigate(action.href, action.replace);
    return;
  }
  if (action.mode === 'none') return;

  if (action.replace) window.history.replaceState({}, '', action.href);
  else window.history.pushState({}, '', action.href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
