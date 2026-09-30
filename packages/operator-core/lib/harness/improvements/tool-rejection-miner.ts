/**
 * tool-rejection-miner.ts — P-017 (coordination-spec-adoption-2026-08-03): the
 * CAPTURE side of the per-verb schema-rejection scorecard.
 *
 * `../../tool-rejection-rate.ts` is the pure measurement layer (rollup / grade /
 * describe, all unit-testable without PG). This module is the tick that runs it on
 * a cadence and turns each breaching verb into a filed improvement — the same split
 * `invalid-args-miner.ts` has between `planInvalidArgsSignals` and
 * `runInvalidArgsMinerTick`, and the reason the measurement module imports nothing
 * from the capture stack.
 *
 * WHY THIS EXISTS (the finding, measured on live `tool_invocations`, 2026-09-02):
 * the fleet aggregate schema-rejection rate read **0.50%** (1,165/235,252 over 24h)
 * while `operator:converse` rejected **56 of 56** calls and 15 verbs sat at or above
 * 10%. An aggregate cannot surface a per-verb design defect — it is arithmetically
 * built to hide one — so nothing filed against those verbs for as long as the
 * problem existed. This tick is P-017's recurrence guard: it files against the
 * **TOOL**, not the caller, the next time a schema tightens and quietly starts
 * refusing the shape agents actually send.
 *
 * WHY A ROUTINE AND NOT A HEALTH TICK (plan D-110, measured): the daily aggregate
 * scans **3.37M rows** over the 7-day window, and `workspace_id` is not in the
 * serving index's INCLUDE list, so correct tenant scoping is itself a heap fetch —
 * enough to exceed `dev:pg_query`'s interactive statement timeout. It belongs on a
 * scheduled routine with a routine's budget, never on the 15-min health tick or a
 * sync resolver. Weekly is also the honest cadence for the signal:
 * `TOOL_REJECTION_MIN_BREACH_DAYS` (3 separate breach days) cannot be satisfied any
 * faster than that.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: escalate. `gradeToolRejections` has no `broken`
 * branch, and nothing here pages. A verb rejecting 40% of calls is a DESIGN defect,
 * not an outage — it still works perfectly for anyone who sends the right shape.
 * Paging on it would re-teach the exact reflex P-017 exists to correct: treating a
 * rejection as an incident the caller must survive rather than a schema to fix.
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  describeToolRejection,
  readToolRejectionRate,
  TOOL_REJECTION_MAX_PER_TICK,
  TOOL_REJECTION_WINDOW_DAYS,
  type RunQuery,
  type ToolRejectionRollup,
  type ToolRejectionThresholds,
} from '../../tool-rejection-rate';
import { captureImprovement, type CaptureImprovementResult, type CaptureDeps } from './capture-core';
import { isImprovementLoopTool } from './watchdog';

export interface ToolRejectionMinerOptions {
  /** Lookback window. Default {@link TOOL_REJECTION_WINDOW_DAYS} (7 days). */
  windowDays?: number;
  /** Cap on verbs filed against in one tick (anti-flood, mirrors the watchdog). */
  maxPerTick?: number;
  /** Threshold overrides, for a deployment that wants a different bar. */
  thresholds?: ToolRejectionThresholds;
}

export interface ToolRejectionMinerResult {
  /** Distinct tools with schema-boundary traffic in the window. */
  toolsSeen: number;
  /** Schema-boundary calls scanned across all tools. */
  totalCalls: number;
  /** The fleet aggregate rate — carried so the log line shows the number that hides the problem. */
  aggregatePct: number;
  /** Verbs clearing every bar this tick (before the per-tick cap). */
  breaching: number;
  /** Ids of newly-created improvement items this tick. */
  captured: string[];
  /** Verbs declined as a likely duplicate of an already-open item. */
  declined: number;
  /** Capture calls that errored (never blocks the rest of the tick). */
  failed: number;
  /** Breaching verbs skipped because they belong to the improvement loop itself. */
  skippedSelf: number;
}

/** Default runner: the org pool, matching how the sibling rate readers are wired. */
function defaultRunQuery(): RunQuery {
  const { sql } = getOrgPg();
  return async <T = unknown>(q: string, params: unknown[]): Promise<T[]> =>
    (await sql.unsafe(q, params as never)) as unknown as T[];
}

/**
 * The scheduled tick: read → threshold → capture one item per breaching verb.
 *
 * Self-measuring (close-loop D-006 pattern, as the invalid-args miner is): the
 * returned counts make this detector's own yield visible in the routine's log line,
 * so a tick that files nothing is distinguishable from a tick that never ran.
 */
export async function runToolRejectionMinerTick(
  workspaceId: string,
  opts: ToolRejectionMinerOptions = {},
  deps: {
    runQuery?: RunQuery;
    capture?: typeof captureImprovement;
    captureDeps?: CaptureDeps;
    rollup?: ToolRejectionRollup;
  } = {},
): Promise<ToolRejectionMinerResult> {
  const capture = deps.capture ?? captureImprovement;
  const maxPerTick = opts.maxPerTick ?? TOOL_REJECTION_MAX_PER_TICK;
  const windowDays = opts.windowDays ?? TOOL_REJECTION_WINDOW_DAYS;
  const roll =
    deps.rollup ??
    (await readToolRejectionRate(deps.runQuery ?? defaultRunQuery(), {
      workspaceId,
      windowDays,
      thresholds: opts.thresholds,
    }));

  // The improvement loop's own verbs are excluded from FILING, not from the
  // measurement: the rollup's aggregate stays the honest fleet reading (that
  // number is half the finding), while capturing against `improvements:capture`
  // would let this detector feed itself. Same exclusion the invalid-args miner
  // applies, applied one layer later for the same reason.
  const fileable = roll.breaching.filter((row) => !isImprovementLoopTool(row.toolName));
  const skippedSelf = roll.breaching.length - fileable.length;
  const selected = fileable.slice(0, maxPerTick);

  const capturedIds: string[] = [];
  let declined = 0;
  let failed = 0;
  for (const row of selected) {
    const finding = describeToolRejection(row, roll);
    try {
      const result: CaptureImprovementResult = await capture(
        {
          kind: 'change',
          title: finding.title,
          body: finding.body,
          severity: 'minor',
          subTopic: 'tool-rejection-rate',
          scope: 'operator',
          sourceRole: 'system',
          dedupScope: 'open',
          watchdogKey: finding.watchdogKey,
          findingClass: finding.watchdogKey,
        },
        deps.captureDeps,
      );
      if (result.created) capturedIds.push(result.issue?.id ?? '(unknown-id)');
      else declined += 1;
    } catch (e) {
      failed += 1;
      console.warn(
        `[improvement-tool-rejection-scorecard] capture failed for ${row.toolName}:`,
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    toolsSeen: roll.toolsSeen,
    totalCalls: roll.totalCalls,
    aggregatePct: roll.aggregatePct,
    breaching: roll.breaching.length,
    captured: capturedIds,
    declined,
    failed,
    skippedSelf,
  };
}
