function normalizeOrigin(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin;
}

export function isStaticDesktopHost(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized === 'http://localhost:3070'
    || normalized === 'http://127.0.0.1:3070'
    || normalized === 'http://localhost:4173'
    || normalized === 'http://127.0.0.1:4173';
}

/**
 * The build-preview host (`vite preview`, :4173) serves the static `dist/`
 * with NO `/api` backend behind it — unlike :3070 (the operator host the
 * desktop ships on, dev + prod) and :3055 (the Vite dev server), which both
 * front a live Hono backend. Surfaces that depend on live `/api/*` must stay
 * off here, since those requests 404 against a bare static preview.
 *
 * This is the narrower cousin of `isStaticDesktopHost`: :4173 only, NOT :3070.
 * Use it for "needs a backend" gates (e.g. the agent → UI control surface);
 * use `isStaticDesktopHost` for "this is the desktop, not the web" gates
 * (support widget, reload suppression).
 */
export function isStaticPreviewHost(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  return normalized === 'http://localhost:4173'
    || normalized === 'http://127.0.0.1:4173';
}

export function shouldEnableSupportWidget(pathname: string, origin: string): boolean {
  return pathname.startsWith('/support') && !isStaticDesktopHost(origin);
}

export function shouldSuppressStaticDesktopReload(origin: string): boolean {
  return isStaticDesktopHost(origin);
}

export function shouldFallbackToSupportRoute(hasOracleDock: boolean): boolean {
  return !hasOracleDock;
}
