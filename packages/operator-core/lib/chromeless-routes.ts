/**
 * Chromeless routes — the single source of truth for which routes render with
 * NO global app chrome (no env-switcher bar, no ChromeShell header + operator
 * chat sidebar, no left / dev-admin rails). They are bare embedded surfaces:
 *
 *   - `/pi`, `/el-min`   — iframe targets embedded elsewhere in the app.
 *   - `/project-docs`    — the embedded docs view.
 *   - `/quick-panel`     — the desktop's Quick Panel popup window
 *     (papercusp-desktop `src-tauri/src/docs_search.rs` loads this route into a
 *     small always-on-top window; it must be JUST the tabbed panel, not the
 *     whole operator). `npm run dev:quickpanel` also navigates the main window
 *     here for a standalone preview.
 *
 * `__root.tsx` gates the visible chrome on `isChromelessPath`, and the
 * LeftSidebar / DevAdminRail self-suppress on it. Previously each of those
 * carried its own private `CHROMELESS_PREFIXES` copy AND ChromeShell / the env
 * bar had none — so `/quick-panel` still rendered the full app inside the popup.
 *
 * Home: this lives in `operator-core` (not the operator-vite SPA) because the
 * Quick Panel WINDOW-SANDBOX guard in `client-navigation.ts` — a lower layer the
 * SPA depends on — also needs to know "is this a chromeless route" to decide
 * whether a navigation is LEAVING the panel's sandbox (WI-4827). The SPA imports
 * this same module, so there is exactly one list.
 */
import { isPortalEmbedLocation, PORTAL_PANES_PATH_PREFIX } from './portal-embed';

export const CHROMELESS_PREFIXES = ['/pi', '/project-docs', '/el-min', '/quick-panel', '/tasks-roster', '/plans', '/inbox', PORTAL_PANES_PATH_PREFIX] as const;

/** True when `pathname` is (or is nested under) a chromeless route. */
export function isChromelessPath(pathname: string): boolean {
  return CHROMELESS_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Whether the operator's steering sidebar belongs on this route.
 *
 * Focused extracted surfaces (`/plans`, `/inbox`, task roster, the portal
 * pane documents) are bare because they are members of CHROMELESS_PREFIXES.
 * A portal-EMBEDDED `/adv` is bare too (owner ask 2026-09-01): the hosted
 * cloud shell frames the steering rail and the Papercup chat as its OWN
 * sidebars (`PORTAL_PANE_PATHS`), so the embedded tab body must not grow a
 * second copy of either dock. Pass the location's search so the query
 * contract can be read; `/adv` outside the portal keeps the rail.
 */
export function routeHasSteeringSidebar(pathname: string, search = ''): boolean {
  return !isChromelessPath(pathname) && !isPortalEmbedLocation(pathname, search);
}

// Portal-hosted /adv documents use a query contract rather than a new route.
// Re-export the browser-safe protocol predicate instead of maintaining a
// second spelling here; ChromeShell and the theme bridge must never drift.
export { isPortalEmbedLocation };
