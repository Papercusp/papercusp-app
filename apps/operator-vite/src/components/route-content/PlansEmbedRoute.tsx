import PlansPane from '@/app/_components/plans/PlansPane';

/**
 * `/plans` — Direction B's focused portal embed. This is composition only:
 * PlansPane remains the canonical reader/action owner, including its filters,
 * plan dashboard navigation, and PlansCleanupStrip bulk cleanup flow.
 *
 * `layout="split"` (portal-work-two-pane-2026-09-01 D-001): the full page lays
 * the plan list out beside the selected plan's dashboard (`?pdash`, rendered
 * in the pane's own aside — the root PlanDashboardHost takeover is skipped on
 * this route), while the chat sidebar keeps the pane's stack default.
 *
 * WI-5502: this component lives OUTSIDE `src/routes/plans.tsx` on purpose. A
 * route module that also exports its component as a named export defeats the
 * router plugin's `autoCodeSplitting` — the splitter must keep every non-route
 * export (and therefore every import it needs) in the route's CRITICAL half, so
 * `PlansPane` (and, through it, `SessionChatModal`) landed in the eager boot
 * bundle along with their stylesheets. Keeping the component in
 * `route-content/` and referencing it through `lazyRouteComponent` is the same
 * shape `routes/dev.tsx` already uses.
 */
export function PlansEmbedRoute() {
  return (
    <div
      className="portal-focused-work-surface"
      data-testid="plans-portal-embed"
      data-portal-surface="plans"
    >
      <PlansPane layout="split" />
    </div>
  );
}

export default PlansEmbedRoute;
