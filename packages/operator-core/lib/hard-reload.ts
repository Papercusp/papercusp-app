/**
 * Force a real browser reload that survives the desktop host's reload
 * suppression.
 *
 * The static desktop host (`apps/operator-vite/index.html`, active on
 * :3070/:4173) overrides `location.reload()` to a no-op so a stray JS reload
 * can't yank the desktop session mid-task while `vite build --watch` rewrites
 * `dist/` underneath the running page. But it stashes the *genuine* reload on
 * `window.__papercuspOriginalReload` precisely so a deliberate "pick up the new
 * build" action can still work.
 *
 * Use this for stale-bundle / chunk-load recovery (the reload toast, the route
 * error boundary). Off-desktop — where no suppression is installed — it falls
 * back to the native `location.reload()`.
 */
export function hardReload(): void {
  if (typeof window === 'undefined') return;
  // 1. Preferred: the host's stashed genuine reload (index.html escape hatch).
  const w = window as unknown as { __papercuspOriginalReload?: () => void };
  if (typeof w.__papercuspOriginalReload === 'function') {
    try {
      w.__papercuspOriginalReload();
      return;
    } catch {
      /* fall through to the navigation fallback */
    }
  }
  // 2. Fallback that works even when the escape hatch is missing: the host
  //    overrides location.reload()/assign()/replace() to no-op/soft-nav, but it
  //    does NOT touch the `href` accessor. Setting href to a cache-busted URL
  //    forces a real document navigation (reload) that picks up the new build.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('_r', String(Date.now()));
    window.location.href = url.toString();
    return;
  } catch {
    /* last resort — the suppressed reload (better than nothing off-desktop) */
  }
  window.location.reload();
}
