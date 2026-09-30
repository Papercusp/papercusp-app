/**
 * The acceptance-grading stall sweep's ORCHESTRATOR.
 *
 * plan: acceptance-grading-stall-sweep-2026-08-26 (P-002 dispatch, P-003 escalation)
 *
 * Split from the routine adapter on purpose. Every side effect this needs arrives
 * through `AcceptanceGradingSweepDeps`, so the whole control flow — which plans are
 * observed, how many are scanned, what happens on a partial failure, and the
 * guarantee that a second tick mints nothing — is unit-testable against fakes with
 * no database. `harness/routines/acceptance-grading-sweep-action.ts` is the thin
 * adapter that supplies the production implementations.
 *
 * WHAT THIS MAY DO: re-dispatch a grader, and mint one escalation work-item.
 * WHAT THIS MAY NEVER DO (plan requirement R4): grade anything, emit a scorecard,
 * record an acceptance verdict, or alter a refusal code. There is deliberately no
 * dependency in the interface below that could do any of those — the capability is
 * absent, not merely unused, so a future edit cannot quietly acquire it.
 */
import {
  ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK,
  planAcceptanceGradingSweep,
  type AcceptanceGradingCandidate,
  type AcceptanceGradingDecision,
  type AcceptanceGradingThresholds,
} from './acceptance-grading-sweep';

/**
 * How many candidate plans one tick will observe before it stops looking. Distinct
 * from the ACTION cap: observation is cheap but not free (a gate evaluation per
 * plan), and an unbounded scan over a growing plan corpus is how a periodic sweep
 * quietly becomes the most expensive thing on the box.
 */
export const ACCEPTANCE_GRADING_SWEEP_MAX_SCAN_PER_TICK = 100;

/** The condition key that makes escalation idempotent. One key per stuck plan. */
export function acceptanceGradingStallConditionKey(planSlug: string): string {
  return `acceptance-grading-stall:${planSlug}`;
}

/** A plan the SQL prefilter thinks might be stuck, with the timestamps already read. */
export interface ObservedPlanRow {
  planSlug: string;
  harnessSlug: string | null;
  rubricRef: string | null;
  /**
   * When the plan became GRADEABLE — the later of "acceptance rubric exists" and
   * "completion audit recorded", because both are required before a grader has
   * anything to grade. Null when neither could be established.
   */
  gradeableSinceMs: number | null;
}

export interface GraderObservation {
  /** A grader task for this plan is alive right now. */
  live: boolean;
  /** When a grader was last dispatched (including ended ones), or null if never. */
  lastDispatchMs: number | null;
}

export interface AcceptanceGradingSweepDeps {
  /** The SQL prefilter: non-shipped plans that already have a rubric and an audit. */
  listCandidates(limit: number): Promise<ObservedPlanRow[]>;
  /** The ONE definition of stuck-ness (R7) — evaluatePlanAcceptanceGate in production. */
  evaluateGate(planSlug: string): Promise<{ satisfied: boolean; code?: string | null }>;
  /** Liveness + last-dispatch for this plan's grader, from the task ledger. */
  observeGrader(row: ObservedPlanRow): Promise<GraderObservation>;
  /** Whether an escalation work-item already owns this condition. */
  escalationExists(planSlug: string): Promise<boolean>;
  /** Re-dispatch: resolveAcceptanceGrader in production. Idempotent by construction. */
  dispatchGrader(row: ObservedPlanRow): Promise<{ ok: boolean; state?: string; error?: string }>;
  /** Mint exactly one claimable owner. Backed by the condition-key unique index. */
  mintEscalation(
    row: ObservedPlanRow,
    decision: AcceptanceGradingDecision,
  ): Promise<{ id: string; created: boolean }>;
  now(): number;
  onEvent?(event: AcceptanceGradingSweepEvent): void;
}

export type AcceptanceGradingSweepEvent =
  | { kind: 'dispatched'; planSlug: string; state?: string }
  | { kind: 'dispatch-failed'; planSlug: string; error: string }
  | { kind: 'escalated'; planSlug: string; workItemId: string; created: boolean }
  | { kind: 'escalate-failed'; planSlug: string; error: string }
  | { kind: 'observe-failed'; planSlug: string; error: string };

export interface AcceptanceGradingSweepResult {
  scanned: number;
  /** True when the scan cap stopped us before the corpus was exhausted. */
  scanCapped: boolean;
  dispatched: string[];
  escalated: string[];
  /** Escalations that found an incumbent rather than minting — R3 holding. */
  escalationsAlreadyOwned: string[];
  failures: Array<{ planSlug: string; stage: 'observe' | 'dispatch' | 'escalate'; error: string }>;
  deferredByCap: number;
  decisions: AcceptanceGradingDecision[];
}

export interface AcceptanceGradingSweepOpts extends AcceptanceGradingThresholds {
  maxPerTick?: number;
  maxScanPerTick?: number;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Run one tick.
 *
 * Failure policy: a single plan that throws during observation is SKIPPED and
 * recorded, never fatal. A sweep that dies on the first unreadable plan would stop
 * covering every plan behind it, which is precisely the stranding this exists to
 * prevent — so the loop is per-plan defensive on purpose.
 */
export async function runAcceptanceGradingSweep(
  deps: AcceptanceGradingSweepDeps,
  opts: AcceptanceGradingSweepOpts = {},
): Promise<AcceptanceGradingSweepResult> {
  const maxScan = Math.max(0, opts.maxScanPerTick ?? ACCEPTANCE_GRADING_SWEEP_MAX_SCAN_PER_TICK);
  const maxPerTick = opts.maxPerTick ?? ACCEPTANCE_GRADING_SWEEP_MAX_PER_TICK;
  const now = deps.now();

  const failures: AcceptanceGradingSweepResult['failures'] = [];
  const emit = (e: AcceptanceGradingSweepEvent) => deps.onEvent?.(e);

  // Ask for one MORE than the cap purely to learn whether the corpus overflowed it,
  // so `scanCapped` reports a real overflow rather than the coincidence of an exactly
  // -full page.
  const rows = maxScan === 0 ? [] : await deps.listCandidates(maxScan + 1);
  const scanCapped = rows.length > maxScan;
  const scanned = scanCapped ? rows.slice(0, maxScan) : rows;

  const byPlan = new Map<string, ObservedPlanRow>();
  const candidates: AcceptanceGradingCandidate[] = [];

  for (const row of scanned) {
    try {
      const [gate, grader, escalated] = await Promise.all([
        deps.evaluateGate(row.planSlug),
        deps.observeGrader(row),
        deps.escalationExists(row.planSlug),
      ]);
      byPlan.set(row.planSlug, row);
      candidates.push({
        planSlug: row.planSlug,
        gateSatisfied: gate.satisfied,
        gateCode: (gate.code ?? null) as AcceptanceGradingCandidate['gateCode'],
        stuckSinceMs: row.gradeableSinceMs,
        lastDispatchMs: grader.lastDispatchMs,
        graderLive: grader.live,
        escalationExists: escalated,
      });
    } catch (e) {
      const error = errText(e);
      failures.push({ planSlug: row.planSlug, stage: 'observe', error });
      emit({ kind: 'observe-failed', planSlug: row.planSlug, error });
    }
  }

  const plan = planAcceptanceGradingSweep(candidates, now, { ...opts, maxPerTick });

  const dispatched: string[] = [];
  const escalated: string[] = [];
  const escalationsAlreadyOwned: string[] = [];

  for (const decision of plan.actionable) {
    const row = byPlan.get(decision.planSlug);
    if (!row) continue;

    if (decision.action === 'dispatch') {
      try {
        const res = await deps.dispatchGrader(row);
        if (res.ok) {
          dispatched.push(decision.planSlug);
          emit({ kind: 'dispatched', planSlug: decision.planSlug, ...(res.state ? { state: res.state } : {}) });
        } else {
          const error = res.error ?? 'dispatch reported not-ok without an error';
          failures.push({ planSlug: decision.planSlug, stage: 'dispatch', error });
          emit({ kind: 'dispatch-failed', planSlug: decision.planSlug, error });
        }
      } catch (e) {
        const error = errText(e);
        failures.push({ planSlug: decision.planSlug, stage: 'dispatch', error });
        emit({ kind: 'dispatch-failed', planSlug: decision.planSlug, error });
      }
      continue;
    }

    try {
      const res = await deps.mintEscalation(row, decision);
      // `created:false` means the condition already had an owner — the unique index
      // did its job. Recorded separately so a test can prove the second tick minted
      // nothing rather than merely "did not crash".
      if (res.created) escalated.push(decision.planSlug);
      else escalationsAlreadyOwned.push(decision.planSlug);
      emit({ kind: 'escalated', planSlug: decision.planSlug, workItemId: res.id, created: res.created });
    } catch (e) {
      const error = errText(e);
      failures.push({ planSlug: decision.planSlug, stage: 'escalate', error });
      emit({ kind: 'escalate-failed', planSlug: decision.planSlug, error });
    }
  }

  return {
    scanned: scanned.length,
    scanCapped,
    dispatched,
    escalated,
    escalationsAlreadyOwned,
    failures,
    deferredByCap: plan.deferredByCap,
    decisions: plan.decisions,
  };
}

/** The escalation work-item's body. Exported so a test can assert what an owner is told. */
export function acceptanceGradingEscalationBody(
  row: ObservedPlanRow,
  decision: AcceptanceGradingDecision,
): string {
  const hours = decision.stuckForMs === null ? 'an unknown period' : `${(decision.stuckForMs / 3_600_000).toFixed(1)}h`;
  return [
    `Plan \`${row.planSlug}\` has been implementation-complete and audit-complete but UNGRADED for ${hours}.`,
    '',
    'The acceptance-grading stall sweep re-dispatched a grader for it and the plan still did not reach a',
    'graded verdict, so it is handing the plan to a single owner rather than continuing to retry.',
    '',
    'WHY THIS HAPPENS. A plan ships only after an INDEPENDENT grader emits a scorecard, and that grader is',
    'recruited lazily: the ship attempt refuses, and the refusal itself fires the grader launch. So recovery',
    'is pull-triggered. If the plan\'s CREATOR died after launching a grader, nothing ever retries the ship,',
    'discovery never re-runs, and the plan sits here forever. That is the condition this item represents.',
    '',
    'TO RESOLVE: confirm the plan really is ready to be graded, then get a NON-IMPLEMENTER to grade it',
    '(`scorecards:emit`), have the rubric author record the acceptance verdict, and ship it. If the plan',
    'should NOT ship, say so on the plan and close this item with that as the evidence.',
    '',
    `Gate verdict at escalation time: ${decision.reason}.`,
    row.rubricRef ? `Acceptance rubric: ${row.rubricRef}` : 'Acceptance rubric: (not resolved at escalation time)',
    '',
    'Filed by `system:acceptance-grading-sweep`. This item is condition-keyed, so the sweep will not file a',
    'second one while it stays open.',
  ].join('\n');
}
