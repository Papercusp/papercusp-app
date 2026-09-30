/**
 * tool-failure-rate — the SYNTHETIC-FREE write-path outage detector (EI-18798264517111160).
 *
 * ## Why this module exists
 *
 * On 2026-07-27, migration 689 dropped an ON CONFLICT arbiter out from under the
 * deployed release. Every `facts:assert` call on :3070 began failing at 08:37:31Z.
 * The outage was first recognised as fleet-wide at 11:37Z — ~3 HOURS of failure on
 * the MANDATED durable-conclusion path, with nothing watching.
 *
 * Nothing existing could have caught it:
 *   - `dev:service_health` probes LIVENESS (is :3070 answering), not the CORRECTNESS
 *     of a write. The operator was perfectly healthy the whole time.
 *   - Unit/integration tests run staging source against staging schema, which were
 *     mutually consistent. No test can see drift between the DEPLOYED BINARY and the
 *     MIGRATED SHARED DB — that pair is never exercised together.
 *   - `lint:migration-forward-compat` (the sibling fix, EI-18797473716313783) catches
 *     this class at AUTHORING time, but not runtime breakage from any other cause.
 *
 * It stayed invisible because each agent saw only its OWN `handler_error` and read it
 * as a local problem — and the carry-note discipline tells agents to route around a
 * failing write, so the correct individual response actively SUPPRESSED the fleet
 * signal. Nothing aggregated "this tool is now failing for everyone."
 *
 * ## Why an error-rate detector rather than a synthetic prober
 *
 * The obvious design is a periodic synthetic smoke — call `facts:assert` against live
 * :3070 and assert the round-trip. It was rejected: a prober only covers the paths
 * somebody thought to enumerate, so it admits by VOCABULARY rather than by relevance
 * and structurally cannot catch the next outage in a tool nobody listed. (Same failure
 * shape as a hand-typed lane fence — see fleet-execution-health#D-002.) A synthetic
 * write also has to write REAL rows into shared tables on every tick.
 *
 * The fleet is already generating the signal continuously. Every MCP call lands in
 * `harness_shared.tool_invocations` with its status; a tool that breaks for everyone
 * shows up as a per-tool failure spike within minutes. This module only READS and
 * GRADES that — no new table, no new scheduler, no synthetic traffic, and it covers
 * EVERY tool including ones added after this was written.
 *
 * ## Thresholds are measured, not guessed
 *
 * Swept against 7 days of live `tool_invocations` (2026-07-27). Firing 15-min windows
 * at each setting, fleet-wide:
 *
 * | minCalls | failPct | windows/7d | distinct tools |
 * |----------|---------|------------|----------------|
 * | 3        | 50      | 18         | 5              |
 * | 5        | 50      | 8          | 5              |
 * | 5        | **60**  | **4**      | **2**          |
 * | 5        | 100     | 3          | 1              |
 * | 8        | 60      | 1          | 1              |
 *
 * At minCalls=5 / 60% exactly FOUR windows fire in a week — and THREE of them are the
 * facts:assert outage itself (04:30, 04:45, 07:30 local). That is ~1 false positive
 * per week for a detector that catches the target incident, so those are the crit
 * cutoffs. minCalls=8 is too tight: it collapses to a single window, losing the early
 * ones and with them the detection latency that is the entire point.
 *
 * ## The subtlety that kills the naive rule
 *
 * The outage was NOT 100% failure. Agents on staging (:3170) ran different code and
 * kept succeeding, so `ok` rows are interleaved with the errors throughout. A
 * "every call is failing" rule MISSES this incident. The threshold must be
 * proportional, and it must be well under 100%.
 *
 * ## What counts as a failure
 *
 * Only `error` and `timeout` — a fault in the tool's own handler. `invalid-input` and
 * `role-not-allowed` are CALLER errors (bad args, insufficient role) and must never
 * count against a tool's health, or every strict validator would read as broken. This
 * matters concretely here: the same facts:assert window carried `invalid-input` rows
 * for over-cap bodies that have nothing to do with the outage.
 *
 * Pure + injectable, mirroring empty-result-rate.ts / limit-failure-rate.ts:
 * `rollupToolFailures` / `gradeToolFailures` are pure and unit-tested without PG;
 * `readToolFailureRate` runs the canonical SQL through an injected runQuery.
 * TOOL_FAILURE_RATE_SQL is runnable as-is via dev:pg_query.
 */

/** Injectable query runner (mirrors empty-result-rate.ts's RunQuery). */
import { DISPATCH_WRAPPER_EXCLUSION_SQL } from './agent-tools/sessions/automatic-tool-names';

export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/** One tool's failure counts inside the window (the SQL's per-tool row). */
export interface ToolFailureRow {
  toolName: string;
  /**
   * System-attributable calls: ok + error + timeout. Deliberately EXCLUDES
   * `invalid-input` / `role-not-allowed` from the denominator as well as the
   * numerator — a burst of caller errors must not dilute a real failure rate.
   */
  calls: number;
  /** Calls that failed inside the tool's own handler (error + timeout). */
  fails: number;
  /** Most recent error_code in the window (e.g. 'handler_error'), for the summary. */
  lastErrorCode: string | null;
  /** Most recent error_message in the window, truncated by the caller for display. */
  lastErrorMessage: string | null;
}

/** Fleet-wide reading over the window. */
export interface ToolFailureRollup {
  /** Minutes of lookback this rollup covers. */
  windowMin: number;
  /** Tools breaching at least the WARN threshold, worst failure-rate first. */
  failing: Array<ToolFailureRow & { failPct: number }>;
  /** How many distinct tools were called at all in the window. */
  toolsSeen: number;
  /** Total system-attributable calls in the window, across all tools. */
  totalCalls: number;
}

/**
 * Below this many system-attributable calls in the window a rate is not meaningful:
 * a 1-of-1 failure is noise, not a 100% outage, and alarming on it cries wolf.
 * Measured floor — see the sweep table above.
 */
export const TOOL_FAILURE_MIN_CALLS = 5;

/** At or above this failure percentage the tool is BROKEN (pages). Measured: 4 windows/7d. */
export const TOOL_FAILURE_CRIT_PCT = 60;

/**
 * At or above this the tool is DEGRADED (surfaces on the panel, does NOT page — only
 * `crit` reaches the liveness-alarm escalation path). Set below the crit cutoff so a
 * partial/ramping failure is visible before it becomes an outage.
 */
export const TOOL_FAILURE_WARN_PCT = 30;

/** Default lookback. Short enough to detect in minutes, long enough to accumulate MIN_CALLS. */
export const TOOL_FAILURE_WINDOW_MIN = 15;

/**
 * Fold per-tool rows into the fleet rollup. PURE.
 * Sorted worst-rate-first, then by fails, then by name — fully deterministic so the
 * panel summary does not flap between ties.
 */
export function rollupToolFailures(
  rows: ToolFailureRow[],
  windowMin: number = TOOL_FAILURE_WINDOW_MIN,
): ToolFailureRollup {
  const totalCalls = rows.reduce((sum, r) => sum + r.calls, 0);
  const failing = rows
    .filter((r) => r.calls >= TOOL_FAILURE_MIN_CALLS && r.fails > 0)
    .map((r) => ({ ...r, failPct: Math.round((r.fails / r.calls) * 100) }))
    .filter((r) => r.failPct >= TOOL_FAILURE_WARN_PCT)
    .sort(
      (a, b) => b.failPct - a.failPct || b.fails - a.fails || a.toolName.localeCompare(b.toolName),
    );
  return { windowMin, failing, toolsSeen: rows.length, totalCalls };
}

/**
 * The canonical live query — per-tool failure counts over the last `$2` minutes for
 * workspace `$1`. Runnable as-is via dev:pg_query.
 *
 * Uses `tool_invocations_invoked_at_cov_idx` — btree (invoked_at DESC) INCLUDE
 * (tool_name, duration_ms, status) — for the window range scan. The P-012
 * dispatch-wrapper predicate reads metadata_json (not in the INCLUDE), so rows in
 * the window now cost a heap fetch; the window is minutes-scale, which keeps this
 * cheap enough to run inline on every health tick.
 *
 * `invalid-input` / `role-not-allowed` are excluded from BOTH numerator and
 * denominator: they are caller errors, not tool health.
 */
export const TOOL_FAILURE_RATE_SQL = `
SELECT tool_name,
       count(*) FILTER (WHERE status IN ('ok','error','timeout')) AS calls,
       count(*) FILTER (WHERE status IN ('error','timeout'))      AS fails,
       (array_agg(error_code ORDER BY invoked_at DESC)
          FILTER (WHERE status IN ('error','timeout') AND error_code IS NOT NULL))[1]    AS last_error_code,
       (array_agg(error_message ORDER BY invoked_at DESC)
          FILTER (WHERE status IN ('error','timeout') AND error_message IS NOT NULL))[1] AS last_error_message
FROM harness_shared.tool_invocations
WHERE workspace_id = $1
  AND invoked_at > now() - (($2)::int || ' minutes')::interval
  AND ${DISPATCH_WRAPPER_EXCLUSION_SQL}
GROUP BY tool_name
HAVING count(*) FILTER (WHERE status IN ('ok','error','timeout')) > 0
`;

/** Read the per-tool failure rollup from PG for one workspace and fold it. */
export async function readToolFailureRate(
  runQuery: RunQuery,
  opts: { workspaceId: string; windowMin?: number },
): Promise<ToolFailureRollup> {
  const windowMin = opts.windowMin ?? TOOL_FAILURE_WINDOW_MIN;
  const rows = await runQuery<{
    tool_name: string;
    calls: number | string;
    fails: number | string;
    last_error_code: string | null;
    last_error_message: string | null;
  }>(TOOL_FAILURE_RATE_SQL, [opts.workspaceId, windowMin]);
  return rollupToolFailures(
    rows.map((r) => ({
      toolName: r.tool_name,
      calls: Number(r.calls) || 0,
      fails: Number(r.fails) || 0,
      lastErrorCode: r.last_error_code,
      lastErrorMessage: r.last_error_message,
    })),
    windowMin,
  );
}

/** A rating in the panel's shape ({ rating, evidence }). */
export interface ToolFailureGrade {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
  /** The tools at or above the crit cutoff — what the escalation summary names. */
  brokenTools: string[];
}

/**
 * Map a fleet failure rollup → a rating. PURE.
 *
 * `unknown` is reserved for a genuinely silent window (no traffic at all). A window
 * WITH traffic and no failures is `healthy` — unlike the efficiency axes, where a
 * quiet window cannot prove health, an absence of failures across real calls is
 * exactly what health means here.
 */
export function gradeToolFailures(roll: ToolFailureRollup): ToolFailureGrade {
  if (roll.totalCalls === 0) {
    return {
      rating: 'unknown',
      evidence: `No tool calls in the last ${roll.windowMin}m — nothing to grade.`,
      brokenTools: [],
    };
  }
  const broken = roll.failing.filter((f) => f.failPct >= TOOL_FAILURE_CRIT_PCT);
  const degraded = roll.failing.filter((f) => f.failPct < TOOL_FAILURE_CRIT_PCT);
  if (broken.length > 0) {
    const worst = broken[0]!;
    const codeNote = worst.lastErrorCode ? ` [${worst.lastErrorCode}]` : '';
    const msgNote = worst.lastErrorMessage ? `: ${worst.lastErrorMessage.slice(0, 120)}` : '';
    const alsoNote =
      broken.length > 1 ? ` (+${broken.length - 1} other tool(s) also failing)` : '';
    return {
      rating: 'broken',
      evidence:
        `${worst.toolName} is failing ${worst.failPct}% of calls ` +
        `(${worst.fails}/${worst.calls}) over ${roll.windowMin}m${alsoNote}${codeNote}${msgNote}`,
      brokenTools: broken.map((b) => b.toolName),
    };
  }
  if (degraded.length > 0) {
    const worst = degraded[0]!;
    return {
      rating: 'degraded',
      evidence:
        `${worst.toolName} failing ${worst.failPct}% of calls (${worst.fails}/${worst.calls}) ` +
        `over ${roll.windowMin}m — below the ${TOOL_FAILURE_CRIT_PCT}% outage cutoff.`,
      brokenTools: [],
    };
  }
  return {
    rating: 'healthy',
    evidence: `No tool failing above ${TOOL_FAILURE_WARN_PCT}% across ${roll.totalCalls} call(s)/${roll.windowMin}m (${roll.toolsSeen} tools).`,
    brokenTools: [],
  };
}
