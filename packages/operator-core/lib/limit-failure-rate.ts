/**
 * limit-failure-rate — the "did a validation-limit fix actually land?" metric
 * (WI-839, sibling of code-run-adoption.ts's tool-utilization pattern).
 *
 * Counts tool-invocation failures caused by an advisory-field / string-length
 * cap being hit (a tool arg rejected as "too long" rather than truncated). The
 * measuring-code-run-adoption.mdx doc's metric #1 SQL is the canonical query;
 * this module makes it a first-class, reusable, unit-tested read instead of
 * hand-run SQL — a per-tool breakdown, a fleet total, and a graded rating so a
 * regression (a new tool shipping a tight cap, or a fix regressing) surfaces
 * via `dev:limit_failure_rate` without a manual PG query.
 *
 * Pure + injectable (mirrors code-run-adoption.ts's RunQuery seam):
 * `rollupLimitFailures` / `gradeLimitFailureRate` are pure and unit-tested
 * without PG; `readLimitFailureRate` runs the canonical SQL through an
 * injected runQuery. LIMIT_FAILURE_RATE_SQL is also runnable directly via
 * dev:pg_query.
 */

import { DISPATCH_WRAPPER_EXCLUSION_SQL } from './agent-tools/sessions/automatic-tool-names';

/** Injectable query runner (mirrors code-run-adoption.ts's RunQuery). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** One tool's limit-failure count in the window (the SQL's per-tool_name row). */
export interface LimitFailureRow {
  toolName: string;
  errs: number;
  lastSeen: string | null;
  sample: string | null;
}

/** Fleet-wide rollup over the window (all tools folded). */
export interface LimitFailureRollup {
  /** Total limit-rejection failures across every tool in the window. */
  totalErrs: number;
  /** Per-tool breakdown, worst-offender first (mirrors the SQL's ORDER BY errs DESC). */
  byTool: LimitFailureRow[];
}

/** Fold per-tool rows into the fleet rollup (deterministic; stable errs-desc sort). */
export function rollupLimitFailures(rows: LimitFailureRow[]): LimitFailureRollup {
  const byTool = [...rows].sort((a, b) => b.errs - a.errs || a.toolName.localeCompare(b.toolName));
  const totalErrs = byTool.reduce((sum, r) => sum + r.errs, 0);
  return { totalErrs, byTool };
}

/** The canonical live query (measuring-code-run-adoption.mdx metric #1) — too-long-string
 *  validation failures by tool over the last `$1` days. Runnable as-is via dev:pg_query. */
export const LIMIT_FAILURE_RATE_SQL = `
SELECT tool_name, count(*) AS errs, max(invoked_at) AS last_seen,
       (array_agg(error_message ORDER BY invoked_at DESC))[1] AS sample
FROM harness_shared.tool_invocations
WHERE status <> 'ok' AND invoked_at > now() - (($1)::int || ' days')::interval
  AND (error_message ILIKE '%must contain at most%' OR error_message ILIKE '%Too big%'
       OR error_message ILIKE '%expected string to have <=%' OR error_code ILIKE '%too_big%')
  AND ${DISPATCH_WRAPPER_EXCLUSION_SQL}
GROUP BY tool_name ORDER BY errs DESC
`;

/** Read the limit-failure rollup from PG (last `sinceDays` days, default 14) and fold it. */
export async function readLimitFailureRate(
  runQuery: RunQuery,
  opts: { sinceDays?: number } = {},
): Promise<LimitFailureRollup> {
  const sinceDays = opts.sinceDays ?? 14;
  const rows = await runQuery<{
    tool_name: string;
    errs: number | string;
    last_seen: string | null;
    sample: string | null;
  }>(LIMIT_FAILURE_RATE_SQL, [sinceDays]);
  return rollupLimitFailures(
    rows.map((r) => ({
      toolName: r.tool_name,
      errs: Number(r.errs) || 0,
      lastSeen: r.last_seen,
      sample: r.sample,
    })),
  );
}

/** A pot-coordination-health-style rating ({ rating, evidence}). */
export interface LimitFailureGrade {
  rating: 'healthy' | 'degraded' | 'broken';
  evidence: string;
}

/** Fleet totalErrs cutoffs — the 2026-06-25 baseline was 1,000+/14d; the fix's target is ~0. */
export const LIMIT_FAILURE_HEALTHY_BELOW = 10;
export const LIMIT_FAILURE_DEGRADED_BELOW = 100;

/** Map a fleet limit-failure rollup → a rating. PURE. */
export function gradeLimitFailureRate(roll: LimitFailureRollup): LimitFailureGrade {
  const rating =
    roll.totalErrs < LIMIT_FAILURE_HEALTHY_BELOW
      ? 'healthy'
      : roll.totalErrs < LIMIT_FAILURE_DEGRADED_BELOW
        ? 'degraded'
        : 'broken';
  const worst = roll.byTool[0];
  const worstNote = worst ? ` (worst: ${worst.toolName} ×${worst.errs})` : '';
  return {
    rating,
    evidence: `${roll.totalErrs} tool-arg limit-rejection failures in window across ${roll.byTool.length} tool(s)${worstNote}.`,
  };
}
