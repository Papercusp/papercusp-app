/**
 * RoutedPlanDashboardHost (portal-work-two-pane-2026-09-01 P-003 / D-001).
 *
 * The plan-dashboard app-pane takeover (`?pdash`, PlanDashboardHost) mounts
 * once in the router root as a sibling of the routed Outlet. The `/plans`
 * full-page route the cloud portal embeds lays PlansPane out as list +
 * dashboard ITSELF (`layout="split"`), driven by the same `?pdash` — so
 * mounting the takeover there too would cover the split with a second copy
 * of the dashboard. This wrapper is the one route-aware seam; on every other
 * route the takeover behaves exactly as before.
 */
import { useRouterState } from '@tanstack/react-router';
import PlanDashboardHost from '@/app/_components/plans/PlanDashboardHost';

/** Routes that render the plan dashboard in-page and must not get the takeover. */
const SELF_HOSTING_ROUTES: ReadonlySet<string> = new Set(['/plans']);

/** Pure predicate: does the takeover host mount for this pathname? */
export function planDashboardHostMountsOn(pathname: string): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  return !SELF_HOSTING_ROUTES.has(normalized);
}

export default function RoutedPlanDashboardHost() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  if (!planDashboardHostMountsOn(pathname)) return null;
  return <PlanDashboardHost />;
}
