/**
 * plan-drain-sweep.ts — P-005 of deterministic-plan-state-derivation-2026-08-31.
 *
 * The periodic backstop for P-004's reaction rule.
 *
 * # Why a sweep is needed at all
 *
 * `plan-drain:terminality-changed` fires on a `plans:set-status` call, so it can
 * only ever fix the FUTURE. A plan whose last item went terminal BEFORE that rule
 * existed keeps advertising live work forever — nothing will ever re-examine it,
 * because the event that would have re-examined it already happened. Measured at
 * the time of writing (plan D-006 point 1, over all 1,692 `harness_plans` rows):
 * **205 non-archived, non-instance plans** sit at `ready`/`active` with every
 * structured item terminal. That population does not shrink on its own.
 *
 * This mirrors the pairing the codebase already uses for exactly this shape:
 * `plan-items/reconcile-rule.ts` (immediacy) + `plan-item-orphan-reconcile`
 * (backstop). Same split here: P-004's rule for immediacy, this for the residue.
 *
 * # Why a periodic WRITE is admissible, when D-004 point 1 forbade a read-time one
 *
 * D-004 point 1 refused repair on a READ because a read's only warrant is "I
 * derived something", and 200-odd historical plans must not be silently rewritten
 * by someone typing `plans:get`. D-005 point 1 then admitted a WRITE fired by the
 * author's own repairing act. This sweep's warrant is that same authorial act,
 * observed late: every plan it moves had its last item flipped terminal by a real
 * author — the rule simply did not exist yet to see it. Catching up on missed
 * events is what a backstop IS; it introduces no new authority. And because
 * `derivePlanStatusTransition` classifies from scratch and is symmetric (D-005
 * point 5), the sweep cannot strand a plan in a state its own graph refutes.
 *
 * Recorded as plan D-006 point 4.
 *
 * # Why template INSTANCES are excluded — this one is not a preference
 *
 * `reconcile-plan-runs.ts` moves a finished scheduled-plan instance from `active`
 * to `superseded`, and its UPDATE is guarded by a literal `AND status = 'active'`.
 * If this sweep moved such an instance to `awaiting-acceptance` first, that guard
 * would silently miss and the run instance would never be superseded — a stranded
 * row, caused by us. `listPlanIndexRowsForWorkspace` excludes instances by default
 * (`template_slug IS NULL`), so the exclusion costs nothing to keep; it is named
 * here so nobody "fixes" it by passing `includeInstances`. 9 of the 214 drained
 * rows were instances when this was written.
 *
 * # Why the candidate query filters on STORED STATUS ONLY
 *
 * `derivePlanStatusTransition` can only ever move a plan out of `ready`, `active`
 * or `awaiting-acceptance`, so selecting on those three is a strict SUPERSET of
 * its jurisdiction. That keeps the item predicate — which statuses count as
 * terminal, and how `resolveEffectiveStatusForItems` overlays them — in exactly
 * one place. A SQL re-derivation of "all items terminal" would be a second copy
 * of a truth the parser owns, and would drift from it (D-006 point 6).
 *
 * The pre-derivation done here is a CANDIDATE FILTER, never the decision:
 * `applyPlanDrainTransition` re-derives authoritatively inside the plan lock, so
 * a candidate that went stale between the two reads costs one wasted lock and
 * writes nothing.
 *
 * # Why the per-tick cap
 *
 * The first tick faces the whole accumulated backlog. Flipping 205 plans in one
 * pass is a real bulk rewrite of historical records: it bumps 205 plan versions
 * and fires 205 sync invalidations at once, and if the transition were wrong it
 * would be wrong everywhere before anyone could look. A cap drains the backlog
 * over several ticks instead, bounds the blast radius of any mistake, and costs
 * nothing in the steady state where a tick has 0–1 candidates (D-006 point 5).
 */
import {
  derivePlanLifecycle,
  derivePlanStatusTransition,
  type PlanItem,
} from '@papercusp/plan-parser';
import { applyPlanDrainTransition, type PlanDrainTransitionSkip } from './plan-drain-transition';
import { listPlanIndexRowsForWorkspace, planItemsForRow, type PlanIndexRow } from './source';
import { activeWorkspaceId } from '../../workspace-registry';
import { isHarnessInScope, primeWorkScopePolicy } from '../../work-scope-policy';

/**
 * The only stored statuses `derivePlanStatusTransition` can move a plan OFF.
 * Deliberately not `draft` (D-005 point 4: the draft/ready difference encodes
 * authorial intent the item graph cannot see) and not `shipped`/`superseded`
 * (terminal — moving off one would resurrect a closed plan).
 */
export const PLAN_DRAIN_SWEEP_SOURCE_STATUSES = ['ready', 'active', 'awaiting-acceptance'] as const;

/** Plans FLIPPED per tick. See the header for why this is bounded at all. */
export const DEFAULT_PLAN_DRAIN_SWEEP_CAP = 25;

export interface PlanDrainSweepOptions {
  /** Defaults to the active workspace. */
  workspaceId?: string;
  /** Max plans flipped this tick. Defaults to DEFAULT_PLAN_DRAIN_SWEEP_CAP. */
  cap?: number;
}

export interface PlanDrainSweepApplied {
  planSlug: string;
  harnessSlug: string;
  from: string;
  to: string;
  /** The pure decision's evidence sentence, so a log line says WHY. */
  reason: string;
}

/** Named result for every candidate the sweep deferred or attempted. */
export type PlanDrainSweepOutcome =
  | {
      planSlug: string;
      harnessSlug: string;
      outcome: 'applied';
      from: string;
      to: string;
      reason: string;
    }
  | {
      planSlug: string;
      harnessSlug: string;
      outcome: 'skipped';
      reason: PlanDrainTransitionSkip;
    }
  | {
      planSlug: string;
      harnessSlug: string;
      outcome: 'deferred';
      reason: 'cap_reached';
    }
  | {
      planSlug: string;
      harnessSlug: string;
      outcome: 'scope_denied';
      reason: 'out_of_scope';
    };

export interface PlanDrainSweepResult {
  /** Candidate rows enumerated (the stored-status superset). */
  scanned: number;
  /** Of those, how many the pre-derivation judged warranted. */
  warranted: number;
  applied: PlanDrainSweepApplied[];
  /** Per-plan result for every scope refusal, cap deferral, or candidate attempt. */
  outcomes: PlanDrainSweepOutcome[];
  /**
   * Warranted candidates left unattempted because the cap was reached. NOT a
   * failure — the next tick takes them. Reported so a permanently nonzero value
   * (a cap set below the arrival rate) is visible rather than silently lossy.
   */
  deferredToNextTick: number;
  /**
   * Why an attempted flip did not apply, by reason. `no_transition_warranted`
   * here means the locked re-derivation DISAGREED with the pre-derivation — the
   * staleness this design expects and absorbs, not an error.
   */
  skipped: Partial<Record<PlanDrainTransitionSkip | 'scope_denied', number>>;
}

/**
 * Candidate filter only — never the decision. See the header.
 *
 * Takes the already-adapted items rather than a row so it stays pure and
 * directly testable, and so the row→`PlanItem[]` adaptation keeps going through
 * the ONE canonical adapter (`planItemsForRow`) at the call site.
 */
export function planDrainSweepCandidate(
  storedStatus: string | null | undefined,
  items: readonly PlanItem[],
): { from: string; to: string } | null {
  const transition = derivePlanStatusTransition(storedStatus, derivePlanLifecycle([...items]));
  return transition === null ? null : { from: transition.from, to: transition.to };
}

/**
 * One sweep pass. Non-throwing per plan by contract — `applyPlanDrainTransition`
 * is itself best-effort, and one unreachable plan must never abort the tick for
 * the other 204.
 */
export async function sweepDrainedPlanStatuses(
  opts: PlanDrainSweepOptions = {},
): Promise<PlanDrainSweepResult> {
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const cap =
    typeof opts.cap === 'number' && Number.isFinite(opts.cap) && opts.cap > 0
      ? Math.floor(opts.cap)
      : DEFAULT_PLAN_DRAIN_SWEEP_CAP;

  const result: PlanDrainSweepResult = {
    scanned: 0,
    warranted: 0,
    applied: [],
    outcomes: [],
    deferredToNextTick: 0,
    skipped: {},
  };

  const candidates: PlanIndexRow[] = [];
  // PRIME BEFORE FILTERING (WI-10002448) — never drop this await. The scope filter below
  // reads a cache an async refresh fills; empty reads as "not enforced", so the first sweep
  // after a boot would transition plans the STORED policy puts out of scope. With no stored
  // policy it still never skips.
  await primeWorkScopePolicy();
  for (const status of PLAN_DRAIN_SWEEP_SOURCE_STATUSES) {
    // `includeInstances` deliberately left at its default false — see the header.
    const rows = await listPlanIndexRowsForWorkspace({
      workspaceId,
      status,
      includeArchived: false,
      includeItems: true,
    });
    result.scanned += rows.length;
    for (const row of rows) {
      // workspace-work-scope-policy-2026-09-04 P-007: a plan homed outside the workspace
      // work-scope policy is left exactly where it is — no transition, no filing. Counted
      // under `skipped.scope_denied` so the skip is visible. No policy ⇒ never skips.
      if (!isHarnessInScope(row.harnessSlug)) {
        result.skipped.scope_denied = (result.skipped.scope_denied ?? 0) + 1;
        result.outcomes.push({
          planSlug: row.planSlug,
          harnessSlug: row.harnessSlug,
          outcome: 'scope_denied',
          reason: 'out_of_scope',
        });
        continue;
      }
      // `{ ...row, content: '' }` is exactly a PlanRow — PlanIndexRow is
      // `Omit<PlanRow, 'content'>` — so the canonical adapter takes it with no cast.
      const items = planItemsForRow({ ...row, content: '' });
      if (planDrainSweepCandidate(row.status, items) !== null) candidates.push(row);
    }
  }

  result.warranted = candidates.length;
  if (candidates.length > cap) result.deferredToNextTick = candidates.length - cap;

  for (const row of candidates.slice(cap)) {
    result.outcomes.push({
      planSlug: row.planSlug,
      harnessSlug: row.harnessSlug,
      outcome: 'deferred',
      reason: 'cap_reached',
    });
  }

  for (const row of candidates.slice(0, cap)) {
    const outcome = await applyPlanDrainTransition(row.planSlug, row.harnessSlug);
    if (outcome.applied) {
      const applied = {
        planSlug: row.planSlug,
        harnessSlug: row.harnessSlug,
        from: outcome.from ?? row.status ?? '',
        to: outcome.to ?? '',
        reason: outcome.reason ?? '',
      };
      result.applied.push(applied);
      result.outcomes.push({ ...applied, outcome: 'applied' });
    } else {
      const reason = outcome.skipped ?? 'no_transition_warranted';
      result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
      result.outcomes.push({
        planSlug: row.planSlug,
        harnessSlug: row.harnessSlug,
        outcome: 'skipped',
        reason,
      });
    }
  }

  result.outcomes.sort((a, b) =>
    a.harnessSlug === b.harnessSlug
      ? a.planSlug.localeCompare(b.planSlug)
      : a.harnessSlug.localeCompare(b.harnessSlug),
  );
  return result;
}
