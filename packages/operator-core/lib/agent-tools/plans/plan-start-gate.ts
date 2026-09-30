/**
 * plan-start-gate — the ONE place a start door asks "may this plan run?"
 * (plan-structured-inputs-2026-08-01 P-006).
 *
 * There are six ways to set a plan running, and they share nothing else: a status
 * flip, an interactive agent launch, a manual fire, a scheduled fire, arming a
 * schedule, and a fleet launch. Six independent implementations of "is it ready"
 * would become six subtly different answers within a release — so they all call
 * `checkPlanStartable`, which loads the row and defers to the single pure oracle in
 * plan-input-validation.ts. `PLAN_START_DOORS` names them, and P-007's guard test
 * fails the build if a listed door stops consulting this module.
 *
 * WHY ARM IS A DOOR. Arming does not run anything itself — it makes the plan fire
 * later, unattended. Checking there means a plan whose required inputs are unset is
 * refused at 14:00 by the human who armed it, instead of failing at 03:00 in a
 * routine nobody is watching. That is the entire argument for gating a verb that
 * technically starts nothing.
 *
 * WHY A MISSING PLAN IS NOT THIS MODULE'S PROBLEM. Every door already has its own
 * not_found handling with its own error shape; the gate returning "ready" for an
 * absent plan keeps it from inventing a second, competing way to say the same thing.
 */

import { getPlanRow, type PlanRow, type PlanSourceOpts } from './source';
import { evaluatePlanStartReadiness, type PlanStartReadiness } from './plan-input-validation';
import { readAndEvaluateAcceptanceBarLifecycle } from '../../acceptance-bar-lifecycle-evaluator';
import { checkPlanAdmission, type PlanAdmissionRefusal } from './plan-admission-gate';
import type { PlanAdmissionDoor } from './plan-admission-enforcement';

/**
 * Every verb that can set a plan running. The P-007 guard test asserts each of these
 * still reaches this module — add a door here AND wire it, or the build fails. The
 * list is the contract; the test is what keeps it true.
 */
export const PLAN_START_DOORS = [
  { door: 'plans:start', file: 'lib/agent-tools/plans/start.ts' },
  { door: 'plans:launch', file: 'lib/agent-tools/plans/launch.ts' },
  { door: 'plans:run-now', file: 'lib/agent-tools/plans/run-now.ts' },
  { door: 'plans:arm-schedule', file: 'lib/agent-tools/plans/arm-schedule.ts' },
  { door: 'fleet:launch-on-plan', file: 'lib/agent-tools/fleet_registry/launch-on-plan.ts' },
  { door: 'runScheduledPlanFire', file: 'lib/harness/routines/plan-run-action.ts' },
] as const;

export type PlanStartDoor = (typeof PLAN_START_DOORS)[number]['door'];

/**
 * The gate entry points. A door satisfies the P-007 guard by calling one of these:
 * the async loader, the row-level verdict, or (for the fire path, which is not an
 * agent tool and already holds its own row) the pure oracle directly.
 */
export const PLAN_START_GATE_ENTRYPOINTS = [
  'checkPlanStartable',
  'startVerdictForRow',
  'evaluatePlanStartReadiness',
] as const;

/** The refusal payload a door returns verbatim. Shaped so the caller never has to
 *  re-derive anything: what is missing, why, and what to do about it. */
export interface PlanStartRefusal {
  error: 'plan_inputs_not_ready';
  code: Exclude<PlanStartReadiness, { ready: true }>['code'] | 'acceptance_bar_contract_not_ready';
  slug: string;
  /** Declared-required fields that were not supplied. */
  missing: string[];
  /** Schema-violation detail, when the failure is malformed rather than absent. */
  issues: string[];
  /** Which schema source governs this plan. */
  source: string;
  template?: string;
  /** One-line, actionable — surface this to the caller as-is. */
  hint: string;
}

/**
 * A refusal from this gate is one of TWO different things, and the caller must be
 * able to tell them apart: `inputs` means the plan document is not ready to run,
 * `admission` means the pot's governance has not admitted this exact revision. They
 * carry different error tags and different remedies, so they are discriminated by
 * `kind` rather than collapsed into one shape — a governance refusal reported as a
 * missing input sends the reader to fix the wrong thing.
 */
export type PlanStartGateResult =
  | { ok: true; row: PlanRow | null; inputs: unknown }
  | { ok: false; kind: 'inputs'; refusal: PlanStartRefusal; row: PlanRow }
  | { ok: false; kind: 'admission'; refusal: PlanAdmissionRefusal; row: PlanRow };

/**
 * Shallow-merge per-invocation overrides over the plan's stored values (D-008 Q2).
 *
 * Deliberately SHALLOW — a top-level key present in `overrides` replaces the stored
 * one outright. Deep-merging arbitrary JSON Schema shapes has no single obviously
 * correct semantics for arrays (append? replace? merge by index?), and silently
 * picking one would surprise a caller who passed `paths: ['x']` and got the stored
 * three entries plus theirs. An explicit `undefined` in overrides is ignored rather
 * than treated as an unset, so a partially-populated override object cannot
 * accidentally blank a stored value.
 */
export function mergePlanInputs(stored: unknown, overrides: unknown): unknown {
  const base = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return stored;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * Load the plan and decide whether it may start, optionally with per-invocation
 * input overrides merged over its stored values first (P-011).
 *
 * Returns the resolved `inputs` on success so the caller can persist exactly what it
 * validated — never a second, separately-computed merge that could differ from the
 * one the gate approved.
 */
export async function checkPlanStartable(
  slug: string,
  opts: PlanSourceOpts = {},
  overrides?: Record<string, unknown> | null,
  door: PlanAdmissionDoor = 'start',
): Promise<PlanStartGateResult> {
  const row = await getPlanRow(slug, opts);
  // Absent plan: not this gate's error to report (see the module header).
  if (!row) return { ok: true, row: null, inputs: overrides ?? null };
  const verdict = startVerdictForRow(row, slug, overrides);
  if (!verdict.ok) return verdict;

  // P-003: every start/promotion door funnels through this function. A post-epoch
  // BAR contract may be METHOD-empty, but its identity/falsifier/provenance,
  // revision, mapping, and bounded-source invariants must already be complete.
  //
  // P-003/P-029 (review-system-rework-reduction-2026-09-23): the `start` door ALSO
  // demands a complete METHOD/check/layer contract while no proof is bound yet. Only
  // this door: promotion and rubrics:propose share 'pre-start' and deliberately permit
  // METHOD-empty BARs (propose is how a METHOD gets added), and fleet top-ups/run-now/
  // scheduled doors act on plans that are already executing.
  const lifecycle = await readAndEvaluateAcceptanceBarLifecycle(slug, 'pre-start', {
    harnessSlug: row.harnessSlug,
    requireCompleteContractBeforeProof: door === 'start',
  });
  if (!lifecycle.satisfied) {
    return {
      ok: false,
      kind: 'inputs',
      row,
      refusal: {
        error: 'plan_inputs_not_ready',
        code: 'acceptance_bar_contract_not_ready',
        slug,
        missing: lifecycle.codes,
        issues: [
          ...lifecycle.blockingBars.flatMap((bar) => bar.codes.map((code) => `${bar.barKey}: ${code}`)),
          ...(lifecycle.contractGapsBlocking
            ? (lifecycle.contractGaps ?? []).map((gap) => `${gap.barKey}: ${gap.detail}`)
            : []),
        ],
        source: 'acceptance-bar-contract',
        hint: lifecycle.message ?? 'repair the acceptance BAR contract before starting this plan',
      },
    };
  }

  // P-004 admission. LAST, and deliberately so: readiness and the BAR contract are
  // properties of the plan document that the author can fix themselves, while
  // admission is a governance verdict about the exact revision. Checking governance
  // first would answer "not ratified" about a revision that was never runnable, and
  // send the author to a ratification round for a plan they still have to repair.
  //
  // The row loaded above is passed through so the verdict is about the revision this
  // call is acting on — re-reading here could admit a revision the door never saw.
  const admission = await checkPlanAdmission({ slug, door, opts, row });
  if (!admission.admitted) return { ok: false, kind: 'admission', row, refusal: admission.refusal };
  return verdict;
}

/**
 * The same verdict for a row the caller ALREADY loaded — several doors read the plan
 * for their own reasons first (arm-schedule needs the schedule, run-now needs the
 * scope), and making them re-read it just to be gated would double the query for no
 * added safety. Synchronous, so the gate stays a pure decision over a row.
 */
export function startVerdictForRow(
  row: PlanRow,
  slug: string,
  overrides?: Record<string, unknown> | null,
): PlanStartGateResult {
  const inputs = mergePlanInputs(row.templateData, overrides ?? null);
  const verdict = evaluatePlanStartReadiness({ template: row.template, inputSchema: row.inputSchema }, inputs);
  if (verdict.ready) return { ok: true, row, inputs };

  return {
    ok: false,
    kind: 'inputs',
    row,
    refusal: {
      error: 'plan_inputs_not_ready',
      code: verdict.code,
      slug,
      missing: verdict.missing,
      issues: verdict.issues,
      source: verdict.source,
      ...(verdict.template ? { template: verdict.template } : {}),
      hint: verdict.hint,
    },
  };
}

/** The refusal as an MCP tool error result — the shape the plans:* verbs return. */
export function planStartRefusalContent(refusal: PlanStartRefusal) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(refusal) }],
    isError: true as const,
  };
}

/**
 * Render EITHER refusal kind as a tool error result, verbatim.
 *
 * Callers take the whole refused result rather than `.refusal`, so a door cannot
 * accidentally forward an admission refusal through the inputs-shaped renderer and
 * mislabel a governance verdict as a missing input. Each refusal already carries its
 * own `error` tag, so nothing has to be re-derived here.
 */
export function planGateRefusalContent(result: Extract<PlanStartGateResult, { ok: false }>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result.refusal) }],
    isError: true as const,
  };
}
