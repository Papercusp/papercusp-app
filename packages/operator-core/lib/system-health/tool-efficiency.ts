/**
 * tool-efficiency — the four measuring-code-run-adoption.mdx aggregates, lifted
 * OFF the read path (P-010 + P-011, plan `db-performance-remediation-2026-07-26`,
 * decision D-008).
 *
 * ## Why this module exists
 *
 * `collectToolEfficiency` (compute.ts) used to run these four aggregates inline,
 * in one `Promise.all`, on every `computeSystemHealth`. Measured 2026-07-27 on a
 * live pg_stat_statements delta (two samples 3.6 min apart, ranked by IN-WINDOW
 * delta rather than lifetime totals, per the plan's binding rule D-006/D-007):
 *
 * | statement                                    | calls/window | mean     | lifetime   |
 * |----------------------------------------------|--------------|----------|------------|
 * | limit-failure rollup (14d)                    | +93          | 300.8 ms | 72.8 CPU-h |
 * | coord_owner_id empty_runs/total_runs          | +94          | 216.6 ms | 45.5 CPU-h |
 * | `oriented` CTE (orient-dedup, 24h)            | +94          | 125.8 ms | 30.4 CPU-h |
 *
 * The IDENTICAL call deltas are the whole story: they are not three independent
 * hot queries, they are ONE caller — this collector — amplified across ~49 agent
 * processes with no coordination (`computeSystemHealth` is invoked fire-and-forget
 * from harness/improvements/{decay,capture-core,hygiene,triage-core}, scorecard-
 * emission-pulse and papercup-context). ~26 calls/min fleet-wide, ~0.28 DB-cores
 * burned continuously (~9% of the 2.99 DB-cores this box was measured carrying)
 * and 148.7 CPU-hours of lifetime cost, all to recompute the SAME fleet-wide
 * numbers per process. `code-run-adoption.ts` already documents this exact class
 * ("on their own cadences with NO coordination").
 *
 * ## Why precompute rather than a cache
 *
 * Per-call-site memoization would have to be repeated at every one of those call
 * sites and still would not survive across processes — which is where the
 * amplification actually lives. So the compute moves behind the EXISTING
 * derived-reads substrate (D-004: extend it, never introduce a second precompute
 * mechanism) as the `health.toolEfficiency` producer.
 *
 * ## What is precomputed
 *
 * The whole `ToolEfficiencyHealth` object — i.e. the expensive reads AND the pure
 * grading applied to them. That is deliberate: the panel's `status`, `summary`
 * and `metrics` are all derivable from this object alone, so the collector keeps
 * every bit of its presentation logic and gains no new branch, while the payload
 * stays small (four ratings + four scalars) instead of carrying whole per-tool
 * breakdowns into jsonb.
 */
import type { ToolEfficiencyHealth } from './types';

/** Injectable query runner — mirrors the seam the four rollup modules already use,
 *  so this stays unit-testable without PG. */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/**
 * Run the four aggregates and grade them. EXPENSIVE (~750 ms of DB time across
 * four table scans) — this is the function the producer calls; nothing on a
 * user-facing read path should call it directly.
 *
 * `runQuery` defaults to the org pool, so the producer can call it with no args.
 */
export async function computeToolEfficiencyHealth(runQuery?: RunQuery): Promise<ToolEfficiencyHealth> {
  const [
    { readCodeRunAdoption, rollupAdoption, gradeToolUtilization },
    { readLimitFailureRate, gradeLimitFailureRate },
    { readOrientDedupRate, gradeOrientDedupRate },
    { readEmptyResultRate, gradeEmptyResultRate },
  ] = await Promise.all([
    import('../code-run-adoption'),
    import('../limit-failure-rate'),
    import('../orient-dedup-rate'),
    import('../empty-result-rate'),
  ]);

  let query = runQuery;
  if (!query) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    query = async <T = unknown>(q: string, params: unknown[]): Promise<T[]> =>
      (await sql.unsafe(q, params as never)) as unknown as T[];
  }

  // Windows are 24h/7d/14d — see the producer's ttl rationale in producers.ts.
  const [adoptionSummaries, limitRollup, orientRollup, emptyRollup] = await Promise.all([
    readCodeRunAdoption(query, { sinceDays: 7 }),
    readLimitFailureRate(query, { sinceDays: 14 }),
    readOrientDedupRate(query, { sinceHours: 24 }),
    readEmptyResultRate(query, { sinceDays: 7 }),
  ]);

  const adoptionRollup = rollupAdoption(adoptionSummaries);
  const adoptionGrade = gradeToolUtilization(adoptionRollup);
  const limitGrade = gradeLimitFailureRate(limitRollup);
  const orientGrade = gradeOrientDedupRate(orientRollup);
  const emptyGrade = gradeEmptyResultRate(emptyRollup);
  const adoptionRatePct =
    adoptionRollup.adoptionRate !== null ? Math.round(adoptionRollup.adoptionRate * 100) : null;

  return {
    limitFailure: { rating: limitGrade.rating, evidence: limitGrade.evidence, totalErrs: limitRollup.totalErrs },
    codeRunAdoption: { rating: adoptionGrade.rating, evidence: adoptionGrade.evidence, adoptionRatePct },
    orientDedup: {
      rating: orientGrade.rating,
      evidence: orientGrade.evidence,
      pctRedundant: orientRollup.pctRedundant,
    },
    emptyResult: {
      rating: emptyGrade.rating,
      evidence: emptyGrade.evidence,
      pctEmpty: emptyRollup.pctEmpty,
      totalEmptyRuns: emptyRollup.totalEmptyRuns,
    },
  };
}
