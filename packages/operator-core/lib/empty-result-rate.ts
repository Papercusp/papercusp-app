/**
 * empty-result-rate — the 4th tool-efficiency axis: how much of the fleet's tool
 * traffic comes back `ok:true` and USELESS (EI-10892).
 *
 * WHY THIS AXIS EXISTS. The other three axes grade things that ANNOUNCE themselves:
 * a limit-rejection is a hard failure, code:run adoption is a ratio, orient-dedup is
 * a redundant call. All three can read `healthy` while the fleet bleeds round-trips,
 * because the dominant waste mode in this system is none of them — it is the call
 * that SUCCEEDS and returns nothing usable, because the caller mapped the response
 * shape wrong.
 *
 * Measured on the 2026-07-13 agent-DX audit session: 178 tool calls, of which the
 * efficiency ledger recorded exactly ONE failure — while roughly 8-9 of ~30 authored
 * round-trips (~30%) were wasted. Every one of them `ok:true`. The panel reported
 * tool efficiency healthy throughout. That gap is what this measures.
 *
 * DATA SOURCE (reuse-first — no migration, no new table). code:run stamps a detected
 * mis-mapping into `tool_invocations.metadata_json->'emptyMapping'` via the same
 * ctx.metadata seam memory:search already uses for its hit `count`. So the signal
 * rides on the invocation row that was being written anyway; this module only reads
 * and grades it, exactly like limit-failure-rate.ts does for limit rejections.
 *
 * Scoped to code:run because that is the one place an AGENT'S OWN field mapping is
 * applied — the detector cannot see (and must not guess at) a mis-mapping inside a
 * tool's own handler.
 *
 * Pure + injectable, mirroring limit-failure-rate.ts / code-run-adoption.ts:
 * `rollupEmptyResults` / `gradeEmptyResultRate` are pure and unit-tested without PG;
 * `readEmptyResultRate` runs the canonical SQL through an injected runQuery.
 * EMPTY_RESULT_RATE_SQL is runnable as-is via dev:pg_query.
 */

import { EMPTY_MAPPING_METADATA_KEY } from './empty-mapping-hint';

/** Injectable query runner (mirrors limit-failure-rate.ts's RunQuery). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** One agent's empty-result count in the window (the SQL's per-owner row). */
export interface EmptyResultRow {
  /** The coord ownerId that ran the script (null for a non-agent caller). */
  ownerId: string | null;
  /** code:run invocations by this owner whose result was a detected mis-mapping. */
  emptyRuns: number;
  /** ALL code:run invocations by this owner in the window (the denominator). */
  totalRuns: number;
  lastSeen: string | null;
}

/** Fleet-wide rollup over the window. */
export interface EmptyResultRollup {
  /** code:run invocations that came back ok-but-blank across the whole fleet. */
  totalEmptyRuns: number;
  /** ALL code:run invocations in the window — the denominator. */
  totalRuns: number;
  /**
   * Percentage of code:run calls that returned a mis-mapped (blank) result, 0-100,
   * rounded. `null` when the window holds too few runs to mean anything — a 1-of-1
   * blank is noise, not a 100% failure rate, and reporting it as one would cry wolf.
   */
  pctEmpty: number | null;
  /** Per-agent breakdown, worst-offender first. */
  byOwner: EmptyResultRow[];
}

/**
 * Below this many code:run calls in the window, the rate is not meaningful and we
 * report `null` (→ an `unknown` rating) rather than a percentage computed from noise.
 */
export const EMPTY_RESULT_MIN_RUNS = 20;

/** Fold per-owner rows into the fleet rollup (deterministic; stable empty-desc sort). */
export function rollupEmptyResults(rows: EmptyResultRow[]): EmptyResultRollup {
  const byOwner = [...rows].sort(
    (a, b) => b.emptyRuns - a.emptyRuns || (a.ownerId ?? '').localeCompare(b.ownerId ?? ''),
  );
  const totalEmptyRuns = byOwner.reduce((sum, r) => sum + r.emptyRuns, 0);
  const totalRuns = byOwner.reduce((sum, r) => sum + r.totalRuns, 0);
  const pctEmpty =
    totalRuns >= EMPTY_RESULT_MIN_RUNS ? Math.round((totalEmptyRuns / totalRuns) * 100) : null;
  return { totalEmptyRuns, totalRuns, pctEmpty, byOwner };
}

/**
 * The canonical live query — code:run calls whose result was a detected mis-mapping,
 * per agent, over the last `$1` days. Runnable as-is via dev:pg_query.
 *
 * The numerator keys off `metadata_json ? 'emptyMapping'` (the jsonb key-exists
 * operator), stamped by code:run's handler ONLY when the detector fired. The
 * denominator counts every code:run row in the same window, so the ratio is a real
 * rate rather than a raw count that grows with fleet size.
 */
export const EMPTY_RESULT_RATE_SQL = `
SELECT coord_owner_id AS owner_id,
       count(*) FILTER (WHERE metadata_json ? '${EMPTY_MAPPING_METADATA_KEY}') AS empty_runs,
       count(*) AS total_runs,
       max(invoked_at) FILTER (WHERE metadata_json ? '${EMPTY_MAPPING_METADATA_KEY}') AS last_seen
FROM harness_shared.tool_invocations
WHERE tool_name = 'code:run'
  AND invoked_at > now() - (($1)::int || ' days')::interval
GROUP BY coord_owner_id
HAVING count(*) FILTER (WHERE metadata_json ? '${EMPTY_MAPPING_METADATA_KEY}') > 0
ORDER BY empty_runs DESC
`;

/** Read the empty-result rollup from PG (last `sinceDays` days, default 7) and fold it. */
export async function readEmptyResultRate(
  runQuery: RunQuery,
  opts: { sinceDays?: number } = {},
): Promise<EmptyResultRollup> {
  const sinceDays = opts.sinceDays ?? 7;
  const rows = await runQuery<{
    owner_id: string | null;
    empty_runs: number | string;
    total_runs: number | string;
    last_seen: string | null;
  }>(EMPTY_RESULT_RATE_SQL, [sinceDays]);
  return rollupEmptyResults(
    rows.map((r) => ({
      ownerId: r.owner_id,
      emptyRuns: Number(r.empty_runs) || 0,
      totalRuns: Number(r.total_runs) || 0,
      lastSeen: r.last_seen,
    })),
  );
}

/** A rating in the panel's shape ({ rating, evidence }). */
export interface EmptyResultGrade {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/**
 * Rate cutoffs. The audit session that motivated this ran at roughly 30% wasted
 * round-trips, so `broken` is set well below that: by the time a tenth of the fleet's
 * code:run traffic is coming back blank, agents are systematically guessing at
 * response shapes and the fix is a documentation/`returns` problem, not a per-agent one.
 */
export const EMPTY_RESULT_HEALTHY_AT_OR_BELOW = 2;
export const EMPTY_RESULT_DEGRADED_BELOW = 10;

/** Map a fleet empty-result rollup → a rating. PURE. */
export function gradeEmptyResultRate(roll: EmptyResultRollup): EmptyResultGrade {
  // Too little traffic to judge. Deliberately NOT 'healthy': a quiet window is not
  // evidence of health, and grading it healthy would let a real regression hide behind
  // a slow day. `unknown` is the honest answer (and toolEfficiencyStatus treats an
  // all-unknown panel as 'unknown', not 'ok').
  if (roll.pctEmpty === null) {
    return {
      rating: 'unknown',
      evidence: `Only ${roll.totalRuns} code:run call(s) in window (need ${EMPTY_RESULT_MIN_RUNS}) — too few to grade.`,
    };
  }
  const rating =
    roll.pctEmpty <= EMPTY_RESULT_HEALTHY_AT_OR_BELOW
      ? 'healthy'
      : roll.pctEmpty < EMPTY_RESULT_DEGRADED_BELOW
        ? 'degraded'
        : 'broken';
  const worst = roll.byOwner[0];
  const worstNote = worst?.ownerId ? ` (worst: ${worst.ownerId.slice(0, 13)} ×${worst.emptyRuns})` : '';
  return {
    rating,
    evidence:
      `${roll.pctEmpty}% of code:run calls returned ok-but-blank rows ` +
      `(${roll.totalEmptyRuns}/${roll.totalRuns}) across ${roll.byOwner.length} agent(s)${worstNote}. ` +
      'These are MIS-MAPPED RESPONSE SHAPES, not empty result sets — the caller read keys the payload does not have.',
  };
}
