import { useEffect } from 'react';
import { useRouterState } from '@tanstack/react-router';
import { useProgress } from '@bprogress/react';
import { shouldClearStaleBusyClass, shouldHideIdleProgressBar, shouldMaintainIdleProgress, shouldSuppressNavigationProgress } from './navigation-progress-helpers';

/**
 * Phase B6 — the operator-vite navigation progress bar.
 *
 * Replaces the operator's `RouteProgressProvider.tsx` (which hooked
 * `@bprogress/next` into Next's App Router events). Here the bridge is
 * TanStack Router's own `status`: `'pending'` while a route's
 * `beforeLoad`/`loader` is in flight, `'idle'` otherwise.
 *
 * Mounted once inside `<ProgressProvider>` in `__root.tsx`. The
 * `ProgressProvider` renders the bar DOM + supplies the `useProgress`
 * context; this component is the headless driver — it advances/finishes
 * the bar as the router transitions, and renders nothing itself.
 *
 * Leaf components that call `useProgress()` directly (`RouteLink`,
 * `WorkspaceSwitcher`, `MarketplaceList` — via the `@bprogress/next`
 * alias shim) share the same context, so a manual `.start()` from a
 * link click and the router-driven progress here cooperate on one bar.
 */

function cleanupStaleBusyClass(isPending: boolean) {
  if (!shouldClearStaleBusyClass(isPending)) return;
  document.documentElement.classList.remove('bprogress-busy');
  const bar = document.querySelector<HTMLElement>('.bprogress');
  if (bar && shouldHideIdleProgressBar(isPending)) {
    bar.style.opacity = '0';
    bar.style.pointerEvents = 'none';
  }
}
export function NavigationProgress() {
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const { start, stop } = useProgress();
  const suppressProgress = typeof window !== 'undefined' && shouldSuppressNavigationProgress(window.location.origin);

  useEffect(() => {
    if (suppressProgress) {
      const forceIdle = () => cleanupStaleBusyClass(false);
      forceIdle();
      const interval = window.setInterval(forceIdle, 250);
      return () => {
        window.clearInterval(interval);
      };
    }

    if (isPending) {
      start();
      const bar = document.querySelector<HTMLElement>('.bprogress');
      if (bar) {
        bar.style.removeProperty('opacity');
        bar.style.removeProperty('pointer-events');
      }
      return;
    }

    if (!shouldMaintainIdleProgress(isPending)) return;
    let cleanupTimeout: number | null = null;
    const settle = () => {
      stop();
      if (cleanupTimeout !== null) window.clearTimeout(cleanupTimeout);
      cleanupTimeout = window.setTimeout(() => {
        cleanupTimeout = null;
        cleanupStaleBusyClass(isPending);
      }, 200);
    };
    settle();
    const interval = window.setInterval(settle, 1_000);
    return () => {
      window.clearInterval(interval);
      if (cleanupTimeout !== null) window.clearTimeout(cleanupTimeout);
    };
  }, [isPending, start, stop, suppressProgress]);

  return null;
}
