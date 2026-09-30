/**
 * Pure title composition for a plan-event progress bullet in the fleet-update
 * digest (WI-5040, owner report 2026-07-16: bullets rendered the contentless
 * literal "plan update").
 *
 * emitPlanEvent (agent-tools/coordination/plan-events.ts) never writes a
 * `summary` field, so a summary-first read ALWAYS fell through to its
 * fallback. The envelope does carry `plan_slug`, `detail` (the plan item id,
 * e.g. "P-003") and `before`/`after` (the status transition) — compose those
 * into a human-readable line, e.g. "my-plan-2026-07-16 P-003: todo → wip".
 */

export interface PlanEventLike {
  summary?: unknown;
  plan_slug?: unknown;
  detail?: unknown;
  before?: unknown;
  after?: unknown;
}

export function planEventProgressTitle(e: PlanEventLike): string {
  if (typeof e.summary === 'string' && e.summary.trim()) return e.summary;
  const planSlug = typeof e.plan_slug === 'string' && e.plan_slug ? e.plan_slug : undefined;
  const item = typeof e.detail === 'string' && e.detail ? e.detail : undefined;
  const before = typeof e.before === 'string' && e.before ? e.before : undefined;
  const after = typeof e.after === 'string' && e.after ? e.after : undefined;
  if (!planSlug && !item && !after) return 'plan update';
  const head = `${planSlug ?? 'plan'}${item ? ` ${item}` : ''}`;
  if (!after) return `${head} updated`;
  const transition = before && before !== after ? `${before} → ${after}` : after;
  return `${head}: ${transition}`;
}
