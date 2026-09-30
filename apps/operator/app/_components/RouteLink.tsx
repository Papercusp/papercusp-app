'use client';

import { useEffect, useSyncExternalStore, type MouseEvent } from 'react';
import { usePathname } from '@/lib/router-compat/navigation';
import NextLink from '@/lib/router-compat/link';
import { useProgress } from '@bprogress/react';

import {
  ROUTE_PROGRESS_FALLBACK_MS,
  beginRoutePending,
  getRoutePendingHref,
  routeHrefFromProp,
  scheduleRoutePendingClear,
  subscribeRoutePending,
} from './routePending';
import { shouldStartRouteProgressForClick } from './route-link-progress';

export type RouteLinkProps = React.ComponentProps<typeof NextLink>;

// Tuning notes (2026-05-03 perf audit):
//   - FALLBACK_MS was 8000. That meant if Next.js compile / route resolve
//     hung, the progress bar showed for 8 full seconds — the user perceives
//     this as the click being "broken" (the page is in fact done).
//     Dropped to 1500ms; if the real route truly takes longer the bprogress
//     library still cleans up on `pathname` change.
//   - MIN_VISIBLE remains 0 so fast routes do not fake a long wait, but the
//     route-pending state now clears on actual completion/fallback rather than
//     immediately after click. This keeps the shell feedback truthful without
//     letting it disappear before the new route has mounted.
//   See /docs/performance #A16 for the broader pattern.
function shouldStartRouteProgress(event: MouseEvent<HTMLAnchorElement>): boolean {
  const anchor = event.currentTarget;
  const target = event.target;
  return shouldStartRouteProgressForClick({
    defaultPrevented: event.defaultPrevented,
    button: event.button,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    download: anchor.hasAttribute('download'),
    targetBlank: anchor.target === '_blank',
    disableProgress: anchor.getAttribute('data-disable-progress') === 'true',
    targetBlocksProgress:
      target instanceof Element
      && Boolean(target.closest('[data-prevent-progress="true"]') || target.closest('[data-disable-progress="true"]')),
    currentHref: window.location.href,
    targetHref: anchor.href,
  });
}

export default function RouteLink({ className, onClickCapture, ...props }: RouteLinkProps) {
  const progress = useProgress();
  const pathname = usePathname();
  const pendingHref = useSyncExternalStore(
    subscribeRoutePending,
    getRoutePendingHref,
    getRoutePendingHref,
  );
  const ownHref = routeHrefFromProp(props.href);
  const pending = ownHref !== null && pendingHref === ownHref;

  useEffect(() => {
    scheduleRoutePendingClear();
  }, [pathname]);

  function handleClickCapture(event: MouseEvent<HTMLAnchorElement>) {
    onClickCapture?.(event);
    if (!shouldStartRouteProgress(event)) return;

    const targetUrl = new URL(event.currentTarget.href);
    beginRoutePending(`${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`);

    // Start synchronously so app-shell navigation shows feedback immediately,
    // before TanStack Router's navigation can finish a fast route.
    progress.set(0.08);
    progress.start(0.08, 0, true);
    window.setTimeout(() => {
      progress.stop(120);
      scheduleRoutePendingClear();
    }, ROUTE_PROGRESS_FALLBACK_MS);
  }

  const mergedClassName = [className, pending ? 'is-route-pending' : null].filter(Boolean).join(' ');

  return (
    <NextLink
      {...props}
      aria-busy={pending || undefined}
      className={mergedClassName || undefined}
      data-route-pending={pending ? 'true' : undefined}
      onClickCapture={handleClickCapture}
    />
  );
}
