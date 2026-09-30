import { Suspense } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { PortalPane } from '../../components/portal-panes/PortalPane';

// Same retry-wrapped lazy __root uses for this chunk: a transient first-boot
// chunk fetch failure must retry, not escalate to the fatal boundary (WI-2902).
const LeftSidebar = lazy(() => import('../../components/left-sidebar/LeftSidebar'));

/**
 * /portal-panes/steering — the Accounts / Papercup / Pulse steering rail as a
 * pane-only document, framed by the cloud portal as its own left sidebar
 * (owner ask 2026-09-01). Composition only: the rail, its tabs, and the
 * `?lst=` tab param stay owned by LeftSidebar.
 */
export const Route = createFileRoute('/portal-panes/steering')({
  component: PortalSteeringPaneRoute,
});

export function PortalSteeringPaneRoute() {
  return (
    <PortalPane pane="steering">
      <Suspense fallback={null}>
        <LeftSidebar docked />
      </Suspense>
    </PortalPane>
  );
}
