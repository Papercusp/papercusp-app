/**
 * Desktop-UI performance budgets — the thresholds the `desktop-performance`
 * admin suite (admin-test-suites.ts `desktopPerformanceChecks`) and the
 * packaged-binary wdio runner assert against.
 *
 * This is the DESKTOP-UI sibling of system-health/perf-budgets.ts (which budgets
 * HOST/backend perf: worker CPU, event-loop lag, PSI). Kept here beside it so
 * both budget families live in one place and a release gate (P-011) can read
 * either.
 *
 * Extracted from the previously-inline numbers in desktopPerformanceChecks
 * (desktop-performance-suite-2026-07-20 P-004) so every budget is named,
 * reviewable, and referenced from exactly one place.
 */

export interface DesktopPerfBudgets {
  /** Warm client-side route-settle ceiling (ms): a warm nav to a heavy route
   *  must paint its identifying surface within this. */
  warmRouteSettleMs: number;
  /** Max single interaction latency (ms) the passive recorder may report. */
  interactionMaxMs: number;
  /** Chaos-run INP tiers (web.dev/inp): p95 ceiling + absolute max. */
  chaosInpP95Ms: number;
  chaosInpMaxMs: number;
  /** Chaos-run frame budgets: worst single frame (ms) + count of severe drops. */
  chaosMaxFrameMs: number;
  chaosMaxFrameDrops: number;
  /** Largest Tauri/WebKit process RSS ceiling (KB) — 512MB below the 4096MB
   *  kill threshold. */
  maxProcessRssKb: number;
  /** Per-named-interaction settle budgets (ms), keyed by the perf-marks.ts
   *  interaction name (the string emitted as a performance.measure + recorded
   *  by the vitals recorder). The suite drives each interaction, reads its
   *  measure, and asserts it against the budget here. */
  interactions: Readonly<Record<string, number>>;
}

export const DESKTOP_PERF_BUDGETS: DesktopPerfBudgets = {
  warmRouteSettleMs: 1500,
  interactionMaxMs: 200,
  chaosInpP95Ms: 250,
  chaosInpMaxMs: 500,
  chaosMaxFrameMs: 200,
  chaosMaxFrameDrops: 8,
  maxProcessRssKb: 3584 * 1024,
  interactions: {
    // Sidebar Plans face: row click → plan body rendered in Vditor (WI-5547).
    // Matches PERF_INTERACTIONS.planPopupOpen in
    // apps/operator/app/_components/perf/perf-marks.ts.
    'plan-popup-open': 1500,
    // Inbox command-strip Review click → grouped report committed. This is a
    // route-scale data+render transition; 1.5s catches a return of the measured
    // 13.6s full-attention-feed regression without treating normal IPC/render
    // work as an INP-scale 200ms interaction.
    'inbox-bulk-report-open': 1500,
    // The broader real-interaction budgets (P-006). Each key mirrors a
    // PERF_INTERACTIONS entry; the driven interaction reads its named measure
    // and asserts it here. Budgets are user-perceived-latency ceilings — lower
    // is better; a value over budget is a regression to catch, not a hard cap.
    // Command palette: first open pays the lazy cmdk+Radix chunk load, so the
    // ceiling is generous vs. a warm re-open.
    'command-palette-open': 400,
    // Open a conversation → agent_chats detail resolves + transcript renders. A
    // network+render load path, so a route-scale ceiling.
    'conversation-thread-load': 1500,
    // Harness dock hydration: PG layout load + dockview mount + panel creation.
    'harness-dock-open': 1500,
    // Learning tab view switch → the selected panel's read resolves + renders.
    // A network+render load path like conversation-thread-load, so the same
    // route-scale ceiling. Sized to CATCH the reported symptom rather than to
    // describe today's cost: the owner called several seconds unacceptable for
    // something that "should be instant" (EI-19375505819043214), and the server
    // legs behind it are ~25ms, so anything approaching 1.5s is client-side
    // regression worth failing on.
    'learning-view-switch': 1500,
  },
};

/** Verdict for one named interaction measure vs its budget. */
export interface InteractionBudgetVerdict {
  name: string;
  measuredMs: number;
  budgetMs: number | null;
  ok: boolean;
}

/**
 * Evaluate a measured interaction duration against its budget. Pure — shared by
 * the admin suite check, the packaged-binary runner, and the release gate
 * (P-011). An interaction with no declared budget PASSES (ok:true,
 * budgetMs:null): an unbudgeted interaction is recorded, never a failure.
 */
export function evaluateInteractionBudget(
  name: string,
  measuredMs: number,
  budgets: DesktopPerfBudgets = DESKTOP_PERF_BUDGETS,
): InteractionBudgetVerdict {
  const budgetMs = budgets.interactions[name] ?? null;
  return {
    name,
    measuredMs,
    budgetMs,
    ok: budgetMs === null ? true : measuredMs <= budgetMs,
  };
}
