import { createFileRoute } from '@tanstack/react-router';
import { Suspense } from 'react';
// Retry-wrapped lazy (WI-2902): transient first-boot chunk fetch failures on the
// packaged WebKitGTK desktop must retry, not escalate to the fatal boundary.
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';

/**
 * /pi — PiTerminalsDock view. Translated from `apps/operator/app/pi/page.tsx`
 * + `app/pi/layout.tsx`.
 *
 * Changes from the original Next page:
 *   - `next/dynamic({ ssr: false })` collapsed to `React.lazy` (no SSR in
 *     SPA; the original used dynamic to skip a server pass that doesn't
 *     exist here). The shim would have worked identically — using `lazy`
 *     directly keeps the import surface clean.
 *   - `app/pi/layout.tsx` only added `Tooltip.Provider`, which `__root.tsx`
 *     already mounts globally. Dropping the layout-level wrapper matches
 *     the harness decision (see B-3).
 *   - Query-param read now uses TSR `validateSearch` + `Route.useSearch()`
 *     instead of `window.location.search` post-mount, removing the
 *     two-render `params === null` flash on first paint.
 */

interface PiSearch {
  harness?: string;
  lane?: string;
}

export const Route = createFileRoute('/pi')({
  validateSearch: (search): PiSearch => ({
    harness: typeof search.harness === 'string' ? search.harness : undefined,
    lane: typeof search.lane === 'string' ? search.lane : undefined,
  }),
  component: PiPage,
});

const PiTerminalsDock = lazy(() => import('@/app/harness/PiTerminalsDock'));

function PiPage() {
  const { harness, lane } = Route.useSearch();

  if (!harness) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#aaa' }}>
        Missing <code>?harness=&lt;slug&gt;</code> query parameter.
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', minHeight: 0 }}>
      <Suspense fallback={null}>
        <PiTerminalsDock slug={harness} initialLaneId={lane} />
      </Suspense>
    </div>
  );
}
