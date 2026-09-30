'use client';

/**
 * PlanDashboardHost (plan-visibility-revamp-2026-08-23 P-003) — the ONE mount
 * of the plan-dashboard app-pane takeover (D-002).
 *
 * Driven purely by `?pdash` (nuqs), value = `encodeScopedRef(harness, slug)` —
 * the same `<harness>::<slug>` grammar as `wpop`/`wppop`, and for the same
 * reason: plan lookups are harness-scoped while the surfaces that OPEN them
 * (the cross-harness op-chat sidebar) are not, so the ref carries its own
 * scope. A bare `?pdash=<slug>` still opens — PlanDashboard falls back to the
 * plan row's own harness from the shared plans.list feed.
 *
 * WHERE IT MOUNTS: inside `<main data-route-transition-page>` in the router
 * root (`apps/operator-vite/src/routes/__root.tsx`), as a SIBLING of the
 * routed <Outlet/>. `main` is position:relative (globals.css), so the
 * `.plan-dash-takeover` layer fills exactly the app pane — full width, under
 * no sidebar — while the routed page stays MOUNTED underneath: back (clear
 * `?pdash`) restores it with its state intact, which is what makes this a
 * takeover rather than a navigation.
 *
 * BUNDLE: the dashboard is lazy (it pulls the session-chat modal stack); a
 * route with no `?pdash` pays only for this tiny host. `lazyWithRetry`, not
 * bare `React.lazy` — on the packaged WebKitGTK desktop a transient chunk
 * fetch failure must not escalate to the fatal route boundary (WI-2902).
 */
import { Suspense, useMemo } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { lazyWithRetry as lazy } from '@papercusp/operator-core/lib/lazy-with-retry';
import { decodeScopedRef } from '../chat/chat-ref-popup-params';
import './plan-dashboard.css';

const PlanDashboard = lazy(() => import('./PlanDashboard'));
/** The SAME lazy chunk, for PlansPane's split-mode aside
 *  (portal-work-two-pane-2026-09-01 D-001) — one definition, one chunk, so
 *  the takeover and the aside can never load two copies of the dashboard. */
export const LazyPlanDashboard = PlanDashboard;

/** The app-pane plan-dashboard takeover param. Distinct from `pplan` (the
 *  sidebar's popup) and `wppop` (chat's popup) — one key per renderer. */
export const PLAN_DASHBOARD_PARAM = 'pdash';

export default function PlanDashboardHost() {
  const [raw, setRaw] = useQueryState(PLAN_DASHBOARD_PARAM, parseAsString);
  const { harness, id: planSlug } = useMemo(() => decodeScopedRef(raw), [raw]);

  if (!planSlug) return null;

  return (
    <div className="plan-dash-takeover" data-testid="plan-dashboard-takeover">
      <Suspense fallback={null}>
        <PlanDashboard
          key={planSlug}
          planSlug={planSlug}
          harnessSlug={harness}
          onBack={() => void setRaw(null)}
        />
      </Suspense>
    </div>
  );
}
