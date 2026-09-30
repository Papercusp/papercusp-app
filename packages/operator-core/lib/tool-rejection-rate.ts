/**
 * tool-rejection-rate — the per-verb SCHEMA-REJECTION detector that files against the
 * TOOL, not the caller (coordination-spec-adoption-2026-08-03 P-017).
 *
 * ## Why this module exists
 *
 * `tool-failure-rate.ts` is the sibling of this file and deliberately EXCLUDES
 * `invalid-input` from both its numerator and its denominator, on the stated grounds that
 * it is "a CALLER error (bad args), and must never count against a tool's health, or
 * every strict validator would read as broken." That is exactly right for what that
 * module is: a 15-MINUTE OUTAGE detector, where one agent fumbling args must not read as
 * an outage.
 *
 * It is exactly wrong at the other timescale. Sustained across days and dozens of
 * distinct agents, a rejection rate stops describing the callers and starts describing
 * the schema: if 69 agents get the same field wrong 20% of the time for a week, the
 * field is misnamed, the shape is surprising, or the guidance is lying. So this module
 * measures the population its sibling drops, over a window its sibling cannot see, and
 * attributes the result to the TOOL.
 *
 * ## The number that motivated it (measured 2026-09-02, 24h, live tool_invocations)
 *
 * Fleet aggregate schema-rejection rate: **0.50%** (1,165 / 235,252). Perfectly healthy.
 * Inside that same window:
 *
 * | verb                    | rejected / calls | rate   |
 * |-------------------------|------------------|--------|
 * | operator:converse       | 56 / 56          | 100.0% |
 * | work_items:link         | 14 / 44          |  31.8% |
 * | work_items:set_blocker  | 16 / 56          |  28.6% |
 * | facts:assert            | 105 / 407        |  25.8% |
 * | coord:send              | 317 / 1497       |  21.2% |
 *
 * Fifteen verbs sat at or above 10%. The aggregate hid every one of them, which is the
 * whole thesis of P-017 — and it is the reason the grade below ALWAYS reports the
 * aggregate and the worst verb together. A mean over 463 tools is not a health metric;
 * it is a number that will be quoted as one (plan D-003).
 *
 * ## Why the existing invalid-input consumer could not be extended instead
 *
 * `harness/improvements/invalid-args-miner.ts` already mines these rows, and reuse-first
 * says extend it. It cannot carry this signal, for three reasons measured over 7 days:
 *
 *  1. **No denominator.** It aggregates absolute counts per (tool, offending-key). A
 *     rate is not expressible in its shape, so "100% of calls rejected" and "0.5% of
 *     calls rejected" are the same kind of fact to it.
 *  2. **It ranks by volume and caps at 5 per tick** (`maxPerTick`, sorted by distinct
 *     owners then count). The top pairs by distinct owners are led by activity:report
 *     (1,036 owners) and coord:send (793). `operator:converse` — rejecting 100% of its
 *     calls — is structurally unrankable there, because being completely broken earns a
 *     verb no volume. A rate-based detector inverts exactly that bias.
 *  3. It keys on an EXTRACTED FIELD NAME, so any rejection whose message does not parse
 *     into a field is dropped entirely. This module keys on the verb, so it cannot be
 *     blinded by an unparseable message.
 *
 * ## What this measures, precisely — and why it is a FLOOR
 *
 * Verified by reading the writer (`endpoint-route/route-stack.ts`, `inputStep`):
 * `status='invalid-input'` is stamped ONLY when the route's zod `safeParse` fails, i.e.
 * at the SCHEMA BOUNDARY, before the handler runs. A handler that executes and returns
 * a self-reported refusal (`{ ok: false, error: … }`) completes the invoke step and is
 * recorded as `status='ok'`.
 *
 * Therefore every rate here is a LOWER BOUND on "calls the agent could not get through",
 * and the metric is named `schemaRejectPct`, not `rejectPct`, so no reader can quote it
 * as a total. Handler-level refusals are a real and separate population that this module
 * deliberately does not claim to see.
 *
 * `role-not-allowed` is excluded from numerator AND denominator: a caller lacking the
 * role is a permissions fact, not a schema defect, and leaving it in the denominator
 * would dilute the rate of any verb with a restricted audience.
 *
 * ## Thresholds are measured, not guessed
 *
 * Swept against live `tool_invocations` (2026-09-02) over a 3-day window spanning 4
 * calendar days — 463 distinct tools, 1,276 tool-days. A 7-day sweep exceeds the
 * `dev:pg_query` statement timeout, so the breach-day counts below are a LOWER bound;
 * TOOL_REJECTION_RATE_DAILY_SQL reproduces the sweep exactly.
 *
 * Per-day breach counts (a tool-day breaches at `calls >= dayMin` and `pct >= threshold`):
 *
 * | dayMinCalls | pct | breaching tool-days | distinct tools |
 * |-------------|-----|---------------------|----------------|
 * | 20          | 10  | 89                  | 46             |
 * | 50          | 10  | 38                  | 23             |
 * | 50          | 15  | 19                  | 13             |
 * | 50          | 25  | 11                  |  7             |
 *
 * Adding the SUSTAINED requirement is what turns that into a filable set rather than a
 * firehose — a tool must breach on several SEPARATE days, so a single schema tightening
 * (which is a legitimate, self-correcting event) cannot file:
 *
 * | window pct | min breach days | tools filing |
 * |------------|-----------------|--------------|
 * | 10         | 2               | 16           |
 * | **10**     | **3**           | **13**       |
 * | 15         | 2               | 11           |
 * | 15         | 3               |  5           |
 *
 * P-017 specifies "~10% sustained"; 10% over >= 3 separate breach days yields 13 verbs,
 * which is a real backlog rather than an alarm storm, and it holds the plan's stated
 * threshold rather than quietly retuning it to make the number look better.
 *
 * Pure + injectable, mirroring tool-failure-rate.ts / empty-result-rate.ts:
 * `rollupToolRejections` / `gradeToolRejections` / `describeToolRejection` are pure and
 * unit-tested without PG; `readToolRejectionRate` runs the canonical SQL through an
 * injected runQuery. TOOL_REJECTION_RATE_DAILY_SQL is runnable as-is via dev:pg_query.
 */

import { DISPATCH_WRAPPER_EXCLUSION_SQL } from './agent-tools/sessions/automatic-tool-names';

/** Injectable query runner (mirrors tool-failure-rate.ts's RunQuery). */
export type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

/**
 * One tool's counts for ONE UTC day inside the window — the SQL's row shape.
 *
 * The daily grain is not cosmetic: it is the only grain at which "sustained" is
 * expressible. A window-total rate alone cannot distinguish a verb that is chronically
 * confusing from a verb whose schema was tightened once on Tuesday.
 */
export interface ToolRejectionDayRow {
  toolName: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /**
   * Calls that reached the schema boundary: ok + error + timeout + invalid-input.
   * Excludes `role-not-allowed` (a permissions fact, not a schema defect).
   */
  calls: number;
  /** Calls rejected by the route's zod parse (`status='invalid-input'`). */
  rejects: number;
  /** Distinct agents whose calls were rejected that day. */
  distinctOwners: number;
  /** Most recent rejection message that day, for the filed evidence. */
  lastErrorMessage: string | null;
}

/** One tool's verdict across the whole window. */
export interface ToolRejectionRow {
  toolName: string;
  /** Schema-boundary calls across the window. */
  calls: number;
  /** Schema-rejected calls across the window. */
  rejects: number;
  /**
   * Rejection rate as a percentage, rounded to one decimal. Named `schemaRejectPct`
   * rather than `rejectPct` because handler-level refusals are invisible here (see the
   * FLOOR note in the module docblock) — the name is the guard against it being quoted
   * as a total.
   */
  schemaRejectPct: number;
  /** Days on which this tool independently breached the daily bar. */
  breachDays: number;
  /** Days on which the tool had enough traffic for its daily rate to be meaningful. */
  eligibleDays: number;
  /** Peak distinct rejected callers on any single day — the "is this one agent?" answer. */
  peakDistinctOwners: number;
  /** Most recent rejection message in the window. */
  lastErrorMessage: string | null;
}

/** Fleet-wide reading over the window. */
export interface ToolRejectionRollup {
  windowDays: number;
  /** Tools clearing every bar, worst rate first. */
  breaching: ToolRejectionRow[];
  /** Distinct tools with any schema-boundary traffic in the window. */
  toolsSeen: number;
  /** Schema-boundary calls in the window, across all tools. */
  totalCalls: number;
  /** Schema-rejected calls in the window, across all tools. */
  totalRejects: number;
  /**
   * The fleet aggregate rate. Carried deliberately so every consumer is forced to see
   * the number that hides the problem next to the problem it hides (plan D-003).
   */
  aggregatePct: number;
}

/** Default lookback. Long enough for "sustained" to mean something. */
export const TOOL_REJECTION_WINDOW_DAYS = 7;

/**
 * A single day counts toward `breachDays` only above this many schema-boundary calls.
 * Below it a daily rate is noise — 1-of-2 is not a 50% design defect.
 */
export const TOOL_REJECTION_DAY_MIN_CALLS = 20;

/**
 * Window-total floor. A verb the fleet barely calls cannot be diagnosed from its
 * rejection rate, and filing against it spends a reviewer on noise.
 */
export const TOOL_REJECTION_MIN_CALLS = 100;

/** The plan's stated threshold (P-017: "~10% sustained"). Measured: 13 verbs / 7d. */
export const TOOL_REJECTION_PCT = 10;

/**
 * SUSTAINED: how many separate days must independently breach. This is the single
 * knob that separates a chronic schema defect from a one-day tightening, and it is
 * why this detector can afford a threshold as low as 10%.
 */
export const TOOL_REJECTION_MIN_BREACH_DAYS = 3;

/** Anti-flood cap on how many tools one tick will file against. */
export const TOOL_REJECTION_MAX_PER_TICK = 5;

export interface ToolRejectionThresholds {
  dayMinCalls?: number;
  minCalls?: number;
  pct?: number;
  minBreachDays?: number;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Fold per-tool-per-day rows into the fleet rollup. PURE.
 *
 * Sorted worst-rate-first, then by rejects, then by name — fully deterministic, so a
 * panel summary does not flap between ties.
 */
export function rollupToolRejections(
  rows: readonly ToolRejectionDayRow[],
  windowDays: number = TOOL_REJECTION_WINDOW_DAYS,
  thresholds: ToolRejectionThresholds = {},
): ToolRejectionRollup {
  const dayMinCalls = thresholds.dayMinCalls ?? TOOL_REJECTION_DAY_MIN_CALLS;
  const minCalls = thresholds.minCalls ?? TOOL_REJECTION_MIN_CALLS;
  const pct = thresholds.pct ?? TOOL_REJECTION_PCT;
  const minBreachDays = thresholds.minBreachDays ?? TOOL_REJECTION_MIN_BREACH_DAYS;

  interface Acc {
    toolName: string;
    calls: number;
    rejects: number;
    breachDays: number;
    eligibleDays: number;
    peakDistinctOwners: number;
    lastErrorMessage: string | null;
    lastDay: string;
  }
  const byTool = new Map<string, Acc>();

  for (const r of rows) {
    if (!r.toolName) continue;
    const calls = Number(r.calls) || 0;
    const rejects = Number(r.rejects) || 0;
    if (calls <= 0) continue;
    let acc = byTool.get(r.toolName);
    if (!acc) {
      acc = {
        toolName: r.toolName,
        calls: 0,
        rejects: 0,
        breachDays: 0,
        eligibleDays: 0,
        peakDistinctOwners: 0,
        lastErrorMessage: null,
        lastDay: '',
      };
      byTool.set(r.toolName, acc);
    }
    acc.calls += calls;
    acc.rejects += rejects;
    if (calls >= dayMinCalls) {
      acc.eligibleDays += 1;
      if ((100 * rejects) / calls >= pct) acc.breachDays += 1;
    }
    acc.peakDistinctOwners = Math.max(acc.peakDistinctOwners, Number(r.distinctOwners) || 0);
    // Keep the most recent non-null message by day, so filed evidence is current.
    if (r.lastErrorMessage && r.day >= acc.lastDay) {
      acc.lastDay = r.day;
      acc.lastErrorMessage = r.lastErrorMessage;
    }
  }

  let totalCalls = 0;
  let totalRejects = 0;
  for (const acc of byTool.values()) {
    totalCalls += acc.calls;
    totalRejects += acc.rejects;
  }

  const breaching = [...byTool.values()]
    .filter(
      (a) =>
        a.calls >= minCalls &&
        a.breachDays >= minBreachDays &&
        (100 * a.rejects) / a.calls >= pct,
    )
    .map((a) => ({
      toolName: a.toolName,
      calls: a.calls,
      rejects: a.rejects,
      schemaRejectPct: round1((100 * a.rejects) / a.calls),
      breachDays: a.breachDays,
      eligibleDays: a.eligibleDays,
      peakDistinctOwners: a.peakDistinctOwners,
      lastErrorMessage: a.lastErrorMessage,
    }))
    .sort(
      (a, b) =>
        b.schemaRejectPct - a.schemaRejectPct ||
        b.rejects - a.rejects ||
        a.toolName.localeCompare(b.toolName),
    );

  return {
    windowDays,
    breaching,
    toolsSeen: byTool.size,
    totalCalls,
    totalRejects,
    aggregatePct: totalCalls === 0 ? 0 : round1((100 * totalRejects) / totalCalls),
  };
}

/**
 * The canonical live query — per-tool, per-UTC-day schema-rejection COUNTS over the last
 * `$2` days for workspace `$1`. Runnable as-is via dev:pg_query.
 *
 * `role-not-allowed` is excluded from both numerator and denominator; the denominator is
 * every call that actually reached the schema boundary.
 *
 * ## Why this pass carries counts ONLY — and where it may therefore run
 *
 * Measured 2026-09-02: the 7-day window is **3,368,400 rows**. The serving index is
 * `tool_invocations_invoked_at_cov_idx` — btree (invoked_at DESC) INCLUDE (tool_name,
 * duration_ms, status) — so a query touching ONLY those columns is served from the index
 * and this aggregate returns in ~3s. Every additional column is a heap fetch across all
 * 3.4M rows, and the difference is not marginal: adding `coord_owner_id` +
 * `error_message` + `metadata_json` pushed the same query past the statement timeout.
 *
 * `workspace_id` is NOT in that INCLUDE either, so scoping is itself a heap fetch and
 * this query exceeds `dev:pg_query`'s interactive statement timeout even in counts-only
 * form. That is a deliberate, measured trade: dropping the workspace predicate makes it
 * fast and WRONG on any multi-tenant deployment, silently blending another tenant's
 * rejection rate into this one's. Correctness wins; the cost is that this belongs on a
 * scheduled ROUTINE with a routine's budget.
 *
 * **Therefore: never call this from a health tick, a sync resolver, or any interactive
 * read path.** It is a daily/weekly detector, not a live gauge — which is also the
 * correct cadence for the signal, since `TOOL_REJECTION_MIN_BREACH_DAYS` cannot be
 * satisfied faster than that anyway.
 *
 * The expensive per-row columns live in {@link TOOL_REJECTION_EVIDENCE_SQL}, which runs
 * against a handful of already-identified verbs instead of the whole window.
 */
export const TOOL_REJECTION_RATE_DAILY_SQL = `
SELECT tool_name,
       to_char((invoked_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
       count(*) FILTER (WHERE status IN ('ok','error','timeout','invalid-input')) AS calls,
       count(*) FILTER (WHERE status = 'invalid-input')                           AS rejects
FROM harness_shared.tool_invocations
WHERE workspace_id = $1
  AND invoked_at > now() - (($2)::int || ' days')::interval
  AND ${DISPATCH_WRAPPER_EXCLUSION_SQL}
GROUP BY tool_name, (invoked_at AT TIME ZONE 'UTC')::date
HAVING count(*) FILTER (WHERE status IN ('ok','error','timeout','invalid-input')) > 0
`;

/**
 * Second pass: the expensive per-row columns, fetched ONLY for verbs that already cleared
 * every bar (`$3` = the breaching tool names). That set is single digits by construction,
 * so this reads a tiny slice of the window rather than all of it.
 */
export const TOOL_REJECTION_EVIDENCE_SQL = `
SELECT tool_name,
       to_char((invoked_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
       count(DISTINCT coord_owner_id) AS distinct_owners,
       (array_agg(error_message ORDER BY invoked_at DESC)
          FILTER (WHERE error_message IS NOT NULL))[1] AS last_error_message
FROM harness_shared.tool_invocations
WHERE workspace_id = $1
  AND invoked_at > now() - (($2)::int || ' days')::interval
  AND status = 'invalid-input'
  AND tool_name = ANY($3)
GROUP BY tool_name, (invoked_at AT TIME ZONE 'UTC')::date
`;

/** Composite key for joining the evidence pass back onto the count rows. */
function dayKey(toolName: string, day: string): string {
  // `|` is safe as a separator: tool names are `server:verb` and days are `YYYY-MM-DD`,
  // so neither can contain it. Deliberately NOT a control byte — a raw one would make
  // ripgrep treat this file as binary and git render its diffs blind.
  return `${toolName}|${day}`;
}

/**
 * Read the per-tool rejection rollup from PG for one workspace and fold it.
 *
 * Two passes, for the cost reason documented on the SQL above: fold the cheap counts to
 * find the breaching verbs, then re-fold with evidence attached for just those. The
 * second pass is skipped entirely when nothing breaches, which is the common case.
 */
export async function readToolRejectionRate(
  runQuery: RunQuery,
  opts: { workspaceId: string; windowDays?: number; thresholds?: ToolRejectionThresholds },
): Promise<ToolRejectionRollup> {
  const windowDays = opts.windowDays ?? TOOL_REJECTION_WINDOW_DAYS;
  const countRows = await runQuery<{
    tool_name: string;
    day: string;
    calls: number | string;
    rejects: number | string;
  }>(TOOL_REJECTION_RATE_DAILY_SQL, [opts.workspaceId, windowDays]);

  const days: ToolRejectionDayRow[] = countRows.map((r) => ({
    toolName: r.tool_name,
    day: r.day,
    calls: Number(r.calls) || 0,
    rejects: Number(r.rejects) || 0,
    distinctOwners: 0,
    lastErrorMessage: null,
  }));

  const first = rollupToolRejections(days, windowDays, opts.thresholds);
  if (first.breaching.length === 0) return first;

  const names = first.breaching.map((b) => b.toolName);
  const evidence = await runQuery<{
    tool_name: string;
    day: string;
    distinct_owners: number | string;
    last_error_message: string | null;
  }>(TOOL_REJECTION_EVIDENCE_SQL, [opts.workspaceId, windowDays, names]);

  const byKey = new Map(evidence.map((e) => [dayKey(e.tool_name, e.day), e] as const));
  for (const d of days) {
    const e = byKey.get(dayKey(d.toolName, d.day));
    if (!e) continue;
    d.distinctOwners = Number(e.distinct_owners) || 0;
    d.lastErrorMessage = e.last_error_message;
  }
  return rollupToolRejections(days, windowDays, opts.thresholds);
}

/** A rating in the panel's shape ({ rating, evidence }). */
export interface ToolRejectionGrade {
  rating: 'healthy' | 'degraded' | 'unknown';
  evidence: string;
  /** Verbs clearing every bar — what the filed items name. */
  breachingTools: string[];
}

/**
 * Map a rollup → a rating. PURE.
 *
 * Note what this deliberately does NOT have: a `broken` rating. A high schema-rejection
 * rate is a DESIGN defect, not an outage — the verb still works for anyone who sends the
 * right shape — so it must never page. Escalating it would re-teach exactly the reflex
 * P-017 exists to correct: treating a rejection as an incident to be survived rather
 * than a schema to be fixed.
 *
 * The evidence line always carries the aggregate NEXT TO the worst verb, because the
 * entire finding behind this module is that the aggregate looks fine while a verb is
 * rejecting every call.
 */
export function gradeToolRejections(roll: ToolRejectionRollup): ToolRejectionGrade {
  if (roll.totalCalls === 0) {
    return {
      rating: 'unknown',
      evidence: `No tool calls in the last ${roll.windowDays}d — nothing to grade.`,
      breachingTools: [],
    };
  }
  if (roll.breaching.length === 0) {
    return {
      rating: 'healthy',
      evidence:
        `No verb sustained >= ${TOOL_REJECTION_PCT}% schema-rejection across ` +
        `>= ${TOOL_REJECTION_MIN_BREACH_DAYS} days (fleet aggregate ${roll.aggregatePct}%, ` +
        `${roll.totalRejects}/${roll.totalCalls} over ${roll.toolsSeen} tools/${roll.windowDays}d).`,
      breachingTools: [],
    };
  }
  const worst = roll.breaching[0]!;
  const alsoNote =
    roll.breaching.length > 1 ? ` (+${roll.breaching.length - 1} other verb(s) breaching)` : '';
  return {
    rating: 'degraded',
    evidence:
      `${worst.toolName} rejected ${worst.schemaRejectPct}% of calls ` +
      `(${worst.rejects}/${worst.calls}) on ${worst.breachDays}/${worst.eligibleDays} days${alsoNote} — ` +
      `while the fleet aggregate reads ${roll.aggregatePct}%. ` +
      `The aggregate is not the health signal; the per-verb rate is.`,
    breachingTools: roll.breaching.map((b) => b.toolName),
  };
}

/** The improvement item one breaching verb should file. PURE. */
export interface ToolRejectionFinding {
  title: string;
  body: string;
  /** Stable per-tool key, so a verb re-files at most once while an item is open. */
  watchdogKey: string;
}

/**
 * Render one breaching verb into a filed finding. PURE, so the wording is unit-testable
 * without PG or the capture stack.
 *
 * The body is addressed to whoever owns the TOOL, and it says so: P-017's whole point is
 * that this class of item has been landing on callers ("agent passed bad args") when it
 * belongs to the schema. It also carries the aggregate, so the reader cannot dismiss the
 * verb's rate by checking fleet health.
 */
export function describeToolRejection(
  row: ToolRejectionRow,
  roll: ToolRejectionRollup,
): ToolRejectionFinding {
  const sample = row.lastErrorMessage ? row.lastErrorMessage.slice(0, 300) : '(none captured)';
  return {
    watchdogKey: `tool-rejection-rate:${row.toolName}`,
    title:
      `${row.toolName} rejects ${row.schemaRejectPct}% of calls at the schema boundary ` +
      `(sustained ${row.breachDays}d)`,
    body:
      `Per-verb schema-rejection scorecard (P-017).\n\n` +
      `**${row.toolName}** rejected **${row.rejects} of ${row.calls}** calls ` +
      `(**${row.schemaRejectPct}%**) over the last ${roll.windowDays} days, breaching the ` +
      `${TOOL_REJECTION_PCT}% bar on ${row.breachDays} of ${row.eligibleDays} days with enough ` +
      `traffic to measure. Peak distinct rejected callers in a single day: ${row.peakDistinctOwners}.\n\n` +
      `Fleet aggregate over the same window: **${roll.aggregatePct}%** ` +
      `(${roll.totalRejects}/${roll.totalCalls} across ${roll.toolsSeen} tools). ` +
      `That gap is the finding — the aggregate reads healthy while this verb does not.\n\n` +
      `Most recent rejection message:\n\n    ${sample}\n\n` +
      `**This is filed against the TOOL, not its callers.** At ${row.peakDistinctOwners} distinct ` +
      `agents sustained over ${row.breachDays} days, the shape is not a caller mistake: it is a ` +
      `field that is misnamed, a schema that is surprising, or guidance that disagrees with the ` +
      `parser. The fix is usually one of: accept an alias for the shape agents actually send, ` +
      `rename the field, relax a needlessly strict validator, or correct the tool's own guidance.\n\n` +
      `Scope note: \`status='invalid-input'\` is stamped only when the route's zod parse fails ` +
      `(endpoint-route/route-stack.ts \`inputStep\`). A handler returning a self-reported ` +
      `\`{ ok:false }\` refusal is recorded as \`ok\`, so this rate is a FLOOR on calls that ` +
      `could not get through, never a total.`,
  };
}
