/**
 * orient-dedup-rate — the "are agents re-calling what coord:orient already
 * returned?" metric (WI-839, sibling of code-run-adoption.ts's tool-utilization
 * pattern). measuring-code-run-adoption.mdx metric #3: of the spawns that
 * called `coord:orient`, how many ALSO re-called a call orient already subsumes
 * (coord:plan-events / memory:search / coord:inbox / coord:declare-intent)?
 * That redundant-recall rate is the bigger leak the orient-dedup guidance +
 * soft re-call nudge are meant to move — this makes it a first-class,
 * unit-tested read instead of hand-run SQL, so a regression (a new redundant
 * pattern, or the nudge losing effect) surfaces via `dev:orient_dedup_rate`
 * without a manual audit.
 *
 * Pure + injectable (mirrors code-run-adoption.ts's RunQuery seam):
 * `rollupOrientDedup` / `gradeOrientDedupRate` are pure and unit-tested
 * without PG; `readOrientDedupRate` runs the canonical SQL through an
 * injected runQuery. ORIENT_DEDUP_RATE_SQL is also runnable directly via
 * dev:pg_query.
 */

/** Injectable query runner (mirrors code-run-adoption.ts's RunQuery). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** One spawn's orient/redundant-recall flags (the from-raw path: tests + the SQL's per-spawn shape). */
export interface SpawnOrientRow {
  spawnId: string;
  /** The spawn called coord:orient at least once. */
  oriented: boolean;
  /** The spawn ALSO called a tool orient already subsumes (plan-events / memory:search / inbox / declare-intent). */
  redundant: boolean;
}

/** Fleet-wide rollup over the window. */
export interface OrientDedupRollup {
  /** Spawns that called coord:orient at all. */
  orientedSpawns: number;
  /** Of those, how many ALSO re-called a subsumed tool. */
  alsoRedundantSpawns: number;
  /** alsoRedundantSpawns ÷ orientedSpawns × 100; null when no oriented spawns in window. */
  pctRedundant: number | null;
}

/** Fold per-spawn orient/redundant rows into the fleet rollup. */
export function rollupOrientDedup(rows: SpawnOrientRow[]): OrientDedupRollup {
  let orientedSpawns = 0;
  let alsoRedundantSpawns = 0;
  for (const r of rows) {
    if (!r.oriented) continue;
    orientedSpawns += 1;
    if (r.redundant) alsoRedundantSpawns += 1;
  }
  return {
    orientedSpawns,
    alsoRedundantSpawns,
    pctRedundant: orientedSpawns > 0 ? Math.round((alsoRedundantSpawns / orientedSpawns) * 1000) / 10 : null,
  };
}

/** The tools coord:orient's bootstrap already subsumes — re-calling one after orient is redundant. */
export const ORIENT_SUBSUMED_TOOLS = [
  'coord:plan-events',
  'memory:search',
  'coord:inbox',
  'coord:declare-intent',
] as const;

/** The canonical live query (measuring-code-run-adoption.mdx metric #3) — of spawns that called
 *  coord:orient, how many ALSO re-called a tool it already subsumes AFTER orient returned, over
 *  the last `$1` hours. coord:orient internally reads inbox/plan-events/memory and declares intent;
 *  those subcalls are logged under the same spawn just before the orient row, so the timestamp
 *  predicate is load-bearing to avoid grading orient's own implementation as agent re-fetching.
 *  Runnable as-is via dev:pg_query. */
export const ORIENT_DEDUP_RATE_SQL = `
WITH oriented AS (
  SELECT spawn_id, min(invoked_at) AS first_orient_at
  FROM harness_shared.tool_invocations
  WHERE transport='mcp'
    AND tool_name='coord:orient'
    AND invoked_at > now() - (($1)::int || ' hours')::interval
    AND spawn_id IS NOT NULL
  GROUP BY spawn_id
),
s AS (
  SELECT o.spawn_id,
         true AS oriented,
         bool_or(t.tool_name IN ('coord:plan-events','memory:search','coord:inbox','coord:declare-intent')) AS redundant
  FROM oriented o
  LEFT JOIN harness_shared.tool_invocations t
    ON t.spawn_id = o.spawn_id
   AND t.transport = 'mcp'
   AND t.invoked_at > o.first_orient_at
   AND t.invoked_at > now() - (($1)::int || ' hours')::interval
  GROUP BY o.spawn_id
)
SELECT spawn_id, oriented, coalesce(redundant, false) AS redundant FROM s
`;

/** Read the orient-dedup rollup from PG (last `sinceHours` hours, default 24) and fold it. */
export async function readOrientDedupRate(
  runQuery: RunQuery,
  opts: { sinceHours?: number } = {},
): Promise<OrientDedupRollup> {
  const sinceHours = opts.sinceHours ?? 24;
  const rows = await runQuery<{ spawn_id: string; oriented: boolean; redundant: boolean }>(ORIENT_DEDUP_RATE_SQL, [
    sinceHours,
  ]);
  return rollupOrientDedup(
    rows.map((r) => ({ spawnId: r.spawn_id, oriented: r.oriented === true, redundant: r.redundant === true })),
  );
}

/** A pot-coordination-health-style rating ({ rating, evidence }). */
export interface OrientDedupGrade {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/** Below this many oriented spawns the window is too small to grade — honest 'unknown' beats a
 *  noisy rating off a quiet window (mirrors code-run-adoption.ts's ADOPTION_MIN_SAMPLE). */
export const ORIENT_DEDUP_MIN_SAMPLE = 5;

/** pctRedundant cutoffs. The 2026-06-21 baseline was ~100% (near-universal re-call); the
 *  orient-dedup guidance's target is a downward trend. Lower is healthier. */
export const ORIENT_DEDUP_HEALTHY_BELOW = 25;
export const ORIENT_DEDUP_DEGRADED_BELOW = 60;

/** Map a fleet orient-dedup rollup → a rating. PURE. */
export function gradeOrientDedupRate(roll: OrientDedupRollup): OrientDedupGrade {
  if (roll.pctRedundant === null || roll.orientedSpawns < ORIENT_DEDUP_MIN_SAMPLE) {
    return {
      rating: 'unknown',
      evidence: `only ${roll.orientedSpawns} coord:orient spawn(s) in window (< ${ORIENT_DEDUP_MIN_SAMPLE}) — too small a sample to grade orient-dedup.`,
    };
  }
  const rating =
    roll.pctRedundant < ORIENT_DEDUP_HEALTHY_BELOW
      ? 'healthy'
      : roll.pctRedundant < ORIENT_DEDUP_DEGRADED_BELOW
        ? 'degraded'
        : 'broken';
  return {
    rating,
    evidence: `${roll.pctRedundant}% of coord:orient spawns (${roll.alsoRedundantSpawns}/${roll.orientedSpawns}) also re-called a subsumed tool (${ORIENT_SUBSUMED_TOOLS.join(', ')}) this window.`,
  };
}
