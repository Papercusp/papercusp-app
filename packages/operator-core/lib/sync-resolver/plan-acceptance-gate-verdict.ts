import { z } from 'zod';
import type { AcceptanceBarContractSnapshot } from '../acceptance-bar-contract-snapshot';
import { evidenceCurrentInputSchema } from '../agent-tools/plans/spec-evidence-store';
import { getBuildInfo, type BuildInfo } from '../build-info';
import type { PlanAcceptanceGateVerdict } from '../plan-acceptance-gate';

/**
 * P-011 — the READ surface for a plan's ACCEPTANCE GATE verdict.
 *
 * The companion to `plans.specCoverage`, and deliberately a SEPARATE query rather than
 * a widening of it, because the two answer different questions and one cannot be derived
 * from the other:
 *
 *   · `plans.specCoverage` censuses the plan's clauses UNCONDITIONALLY — the full
 *     coverage picture, whatever else is true.
 *   · this query reports WHAT IS BLOCKING THE SHIP RIGHT NOW.
 *
 * `evaluatePlanAcceptanceGate` SHORT-CIRCUITS on the first refusal, so its own
 * `specCoverage` field is absent on any refusal that precedes the census (the item/audit
 * family), when the census flag is off, and when the plan is exempt. A UI that rendered
 * coverage from the gate verdict alone would therefore show a plan with a real coverage
 * problem as having none, simply because an earlier check refused first. That is why the
 * census query exists beside this one.
 *
 * ⚠ WHAT THE UI MUST NOT DO WITH THIS. Unlike the census (whose findings are advisory
 * per D-018), the codes here ARE real refusals — this gate genuinely blocks the ship, so
 * a blocker renders as a blocker. The honesty rule runs the OTHER way instead: a
 * `satisfied:true` from this gate is NOT automatically a clean pass, and three states
 * must never be flattened into a green:
 *
 *   · `skipped` — the gate did not APPLY (flag off, rubric-template plan, template
 *     instance, or the plan is ALREADY shipped). Nothing was checked. Rendering that as
 *     "passed" claims a verification that never happened — except `already-shipped`,
 *     which is the one skip that means "validated and closed": render it as the terminal
 *     state it is, never as a pending gate (EI-22078741539479611).
 *   · `forcedPast` — a human explicitly waived the code-truth family with a reason. The
 *     gate's own comment is that "a force that is easy to hide is worth very little", so
 *     the waiver and its reason ride on the verdict and must be shown.
 *   · `vettedUnderWaiver` — the rubric's vetting attestation was made over a consult
 *     NOBODY critiqued. The ship is allowed (a dead reviewer pool is a real condition),
 *     but per EI-20821478338037350 a reader of the verdict is entitled to know.
 *
 * DELIBERATELY LAZY: the gate runs five independent check families (rubric, vetting,
 * grading, item completion, audit) against several tables, so the consumer gates it with
 * `useSyncQuery({ enabled })` and nothing runs until a human opens the section. The gate
 * is read-only and never throws by contract.
 */
export const planAcceptanceGateArgsSchema = z.object({
  // `.default('default')` matches every other workspace-scoped entry in this registry.
  // The gate resolves its own harness scope from the plan row, so this rides for
  // registry consistency and to key the subscription rather than being threaded in.
  workspaceId: z.string().default('default'),
  planSlug: z.string().min(1),
  harnessSlug: z.string().min(1).optional(),
  current: z
    .array(evidenceCurrentInputSchema)
    .max(2000)
    .optional()
    .describe('Fresh evidence fingerprints for a current-aware read of the exact ship gate.'),
});

export type PlanAcceptanceGateArgs = z.infer<typeof planAcceptanceGateArgsSchema>;

export interface PlanAcceptanceGateVerdictRow {
  planSlug: string;
  /** The loaded operator build that produced this time-sensitive verdict. */
  buildProvenance: BuildInfo;
  satisfied: boolean;
  /** Set ⇒ the gate did NOT APPLY. Never render as a pass — nothing was checked. */
  skipped: 'flag-off' | 'rubric-template-plan' | 'template-instance' | 'already-shipped' | null;
  /** The EXACT blocker. Unlike the census's reports, this one really does refuse. */
  code: string | null;
  /** The gate's own teaching message for the refusal — rendered verbatim, not summarized. */
  message: string | null;
  /** Rubric ROLE: which acceptance rubric this plan is judged against. */
  rubricId: string | null;
  /** Rubric VERDICT: the INDEPENDENT grader who satisfied the gate, if any. */
  gradedBy: string | null;
  /** Criterion keys rated `unknown` by the authoritative independent grading. */
  unknownRatedCriteria: string[];
  /**
   * HOW that grader was selected — `'minimum'` means the relevance router did
   * NOT match them and they were taken as a below-floor minimum-fill
   * (unified-responder-selection-critique-and-grading-2026-08-30 D-002). Rides
   * here for the same reason `vettedUnderWaiver` does: the ship is allowed and
   * the grading is real, but a reader of a green verdict is entitled to know
   * that nobody above the floor was available to give it. `null` = the grading
   * is not attributable to a cascade selection (owner-filed, hand-dispatched,
   * or predating the cascade) — which is NOT the same claim as `'floor'`.
   */
  gradedVia: 'floor' | 'minimum' | null;
  /** A recorded, reasoned waiver of the code-truth family. Must never be silent. */
  forcedPast: { reason: string; checks: string[] } | null;
  /** Vetted over a consult nobody critiqued. Allowed, but the reader is entitled to it. */
  vettedUnderWaiver: { consultId: string; reason: string | null } | null;
  /** Distinguishes "the gate could not run" from "the gate passed". */
  unavailableReason: 'resolver-unavailable' | null;
  /**
   * requirements-with-teeth-bar-before-method-2026-09-04 P-014: the one
   * versioned BAR contract projection. This is explainability, not a second
   * gate verdict — `satisfied`/`code` above remain the write path's authority.
   */
  acceptanceBarContractSnapshot: AcceptanceBarContractSnapshot | null;
  /** A snapshot module/read failure never erases a real gate verdict. */
  acceptanceBarContractSnapshotUnavailableReason: string | null;
  acceptanceBarLifecycle?: PlanAcceptanceGateVerdict['acceptanceBarLifecycle'];
  gradingRef?: string;
  repairAction?: PlanAcceptanceGateVerdict['repairAction'];
}

export async function resolvePlanAcceptanceGateVerdict(args: PlanAcceptanceGateArgs): Promise<unknown[]> {
  const { planSlug } = args;

  try {
    const [mod, snapshotMod] = await Promise.all([
      import('../plan-acceptance-gate'),
      import('../acceptance-bar-contract-snapshot'),
    ]);
    const scope = {
      ...(args.harnessSlug ? { harnessSlug: args.harnessSlug } : {}),
      ...(args.current ? { current: args.current } : {}),
    };
    const scoped = Object.keys(scope).length > 0;
    const [v, snapshotResult] = await Promise.all([
      scoped
        ? mod.evaluatePlanAcceptanceGate(planSlug, scope)
        : mod.evaluatePlanAcceptanceGate(planSlug),
      (scoped
        ? snapshotMod.readAcceptanceBarContractSnapshot(planSlug, {}, scope)
        : snapshotMod.readAcceptanceBarContractSnapshot(planSlug))
        .then((snapshot) => ({ snapshot, error: null as string | null }))
        .catch((error) => ({
          snapshot: null,
          error: error instanceof Error ? error.message : String(error),
        })),
    ]);

    return [
      {
        planSlug,
        buildProvenance: v.buildProvenance ?? getBuildInfo(),
        satisfied: v.satisfied,
        skipped: v.skipped ?? null,
        code: v.code ?? null,
        message: v.message ?? null,
        rubricId: v.rubricId ?? null,
        gradedBy: v.gradedBy ?? null,
        unknownRatedCriteria: [...(v.unknownRatedCriteria ?? [])],
        gradedVia: v.gradedVia ?? null,
        forcedPast: v.forcedPast ? { reason: v.forcedPast.reason, checks: [...v.forcedPast.checks] } : null,
        vettedUnderWaiver: v.vettedUnderWaiver
          ? {
              consultId: v.vettedUnderWaiver.consultId,
              reason: v.vettedUnderWaiver.reason ?? null,
            }
          : null,
        unavailableReason: null,
        acceptanceBarContractSnapshot: snapshotResult.snapshot,
        acceptanceBarContractSnapshotUnavailableReason: snapshotResult.error,
        ...(v.acceptanceBarLifecycle ? { acceptanceBarLifecycle: v.acceptanceBarLifecycle } : {}),
        ...(v.gradingRef ? { gradingRef: v.gradingRef } : {}),
        ...(v.repairAction ? { repairAction: v.repairAction } : {}),
      } satisfies PlanAcceptanceGateVerdictRow,
    ];
  } catch (error) {
    // The gate never throws by contract, so reaching here means the module itself could
    // not be loaded or run. That is a DIFFERENT fact from "the gate passed", and
    // collapsing the two would render an unverified plan as a green one.
    return [
      {
        planSlug,
        buildProvenance: getBuildInfo(),
        satisfied: false,
        skipped: null,
        code: null,
        message: `Acceptance gate could not be evaluated (${error instanceof Error ? error.message : String(error)}).`,
        rubricId: null,
        gradedBy: null,
        unknownRatedCriteria: [],
        gradedVia: null,
        forcedPast: null,
        vettedUnderWaiver: null,
        unavailableReason: 'resolver-unavailable',
        acceptanceBarContractSnapshot: null,
        acceptanceBarContractSnapshotUnavailableReason: null,
      } satisfies PlanAcceptanceGateVerdictRow,
    ];
  }
}
