/**
 * Agent-facing projection of an engine leg report (P-020) — shared by every tool
 * that runs `runHybridSearch`, so a degraded semantic leg is visible on the RESULT
 * itself and not only in a hook banner (WI-10005676).
 *
 * WHY SHARED. `search:semantic` projected its legs inline; `sessions:search`
 * destructured `{ results }` out of the same engine call and discarded `legs`, so
 * the tool the compaction contract tells a successor to recover context with could
 * not say whether its semantic half had contributed anything. Two projections of
 * one verdict drift; one function cannot.
 */
import type { LegReport, SearchLegs } from '@papercusp/search';

/**
 * Project one engine leg report into the agent-facing envelope.
 *
 * `candidates` is always stated — it is the number that distinguishes a leg that
 * ran and found nothing from one that never ran — while `floored` and `failures`
 * are emitted only when non-zero, so a healthy search stays compact.
 */
export function describeLeg(leg: LegReport): Record<string, unknown> {
  return {
    status: leg.status,
    candidates: leg.candidates,
    ...(leg.floored > 0 ? { floored: leg.floored } : {}),
    ...(leg.blocked ? { blocked: leg.blocked } : {}),
    ...(leg.failures.length > 0
      ? {
          failures: leg.failures.map((f) => ({
            source: f.source,
            ranker: f.ranker,
            error: f.error,
          })),
        }
      : {}),
  };
}

/**
 * Project the whole two-leg verdict. Reports CANDIDATE COUNTS, not an execution
 * flag: a prose query whose lexical leg AND-collapses to zero rows
 * (EI-19447237774252790) leaves "ran" reporting perfect health while the search is
 * silently semantic-only.
 */
export function describeSearchLegs(legs: SearchLegs): Record<string, unknown> {
  return {
    degraded: legs.degraded,
    warning: legs.warning,
    lexical: describeLeg(legs.lexical),
    semantic: describeLeg(legs.semantic),
  };
}
