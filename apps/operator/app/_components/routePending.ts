export const ROUTE_PROGRESS_FALLBACK_MS = 1500;
const ROUTE_PROGRESS_GENERIC_MIN_VISIBLE_MS = 0;
const ROUTE_PROGRESS_HARNESS_MIN_VISIBLE_MS = 360;

let routePendingHref: string | null = null;
let routePendingStartedAt = 0;
let routePendingClearTimer: number | null = null;
const routePendingListeners = new Set<() => void>();

function emitRoutePending() {
  routePendingListeners.forEach((listener) => listener());
}

function setRoutePendingAttributes(href: string | null) {
  if (!href) {
    document.documentElement.removeAttribute('data-route-pending');
    document.documentElement.removeAttribute('data-route-pending-target');
    return;
  }

  document.documentElement.setAttribute('data-route-pending', 'true');
  document.documentElement.setAttribute('data-route-pending-target', routePendingTargetFromHref(href));
}

function routePendingMinVisibleMs(href: string) {
  return routePendingTargetFromHref(href) === 'harness'
    ? ROUTE_PROGRESS_HARNESS_MIN_VISIBLE_MS
    : ROUTE_PROGRESS_GENERIC_MIN_VISIBLE_MS;
}

export function subscribeRoutePending(listener: () => void) {
  routePendingListeners.add(listener);
  return () => routePendingListeners.delete(listener);
}

export function getRoutePendingHref() {
  return routePendingHref;
}

export function getRoutePendingTarget() {
  return routePendingHref ? routePendingTargetFromHref(routePendingHref) : null;
}

export function normalizeRouteHref(href: string): string {
  try {
    const url = new URL(href, 'http://papercusp.local');
    const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    return `${pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}

export function routePendingTargetFromHref(href: string): 'generic' | 'harness' {
  const normalized = normalizeRouteHref(href);
  return normalized === '/harness' || normalized.startsWith('/harness/') ? 'harness' : 'generic';
}

export function routeHrefFromProp(href: unknown): string | null {
  if (typeof href === 'string') return normalizeRouteHref(href);
  if (
    href
    && typeof href === 'object'
    && 'pathname' in href
    && typeof href.pathname === 'string'
  ) {
    const search = 'search' in href && typeof href.search === 'string' ? href.search : '';
    const hash = 'hash' in href && typeof href.hash === 'string' ? href.hash : '';
    return normalizeRouteHref(`${href.pathname}${search}${hash}`);
  }
  return null;
}

export function beginRoutePending(href: string) {
  if (routePendingClearTimer !== null) {
    window.clearTimeout(routePendingClearTimer);
    routePendingClearTimer = null;
  }

  routePendingHref = normalizeRouteHref(href);
  routePendingStartedAt = performance.now();
  setRoutePendingAttributes(routePendingHref);
  emitRoutePending();
}

export function finishRoutePending() {
  routePendingHref = null;
  if (routePendingClearTimer !== null) {
    window.clearTimeout(routePendingClearTimer);
    routePendingClearTimer = null;
  }
  setRoutePendingAttributes(null);
  emitRoutePending();
}

export function scheduleRoutePendingClear() {
  if (!routePendingHref || routePendingClearTimer !== null) return;

  const remaining = Math.max(
    0,
    routePendingMinVisibleMs(routePendingHref) - (performance.now() - routePendingStartedAt),
  );

  routePendingClearTimer = window.setTimeout(finishRoutePending, remaining);
}
