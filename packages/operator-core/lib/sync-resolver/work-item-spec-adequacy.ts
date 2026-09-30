import { z } from 'zod';
import {
  PLAN_CLASS_RUBRIC_REFS,
  SPEC_TEST_ADEQUACY_RUBRIC_REF,
  type PlanClassRubricRef,
} from '../agent-tools/plans/spec-test-adequacy';

/**
 * P-011 — the RUBRIC/TESTING read surface: which rubric governs a work item's close,
 * what that rubric's gate currently decides, and the EXACT blocker it would emit.
 *
 * THE GAP THIS CLOSES. `specTestAdequacyCompletionGate` is a HARD gate on
 * `work_items:complete` (P-007). Before this query its verdict was reachable only by
 * ATTEMPTING THE CLOSE — a write with side effects — and the refusal named a rubric the
 * caller had no read for. Worse, the gate's first refusal is
 * `attestation required for <clauses>; pass specAdequacy.classRef`, so an agent had to
 * GUESS which of the four plan-class rubrics its item is graded under, and discovered the
 * answer only by being refused again. This query answers all of it without writing.
 *
 * It runs the SAME `specTestAdequacyCompletionGate` the close path calls, so the panel
 * cannot drift from what the gate enforces — the rule every sibling P-011 surface follows.
 *
 * ⚠⚠ THE VERDICT HERE IS A LOWER BOUND, NEVER A FAILURE (D-020). This is the one thing a
 * reader — human or renderer — must not get wrong, because the field that carries it is
 * called `verdict` and looks authoritative.
 *
 * The gate grades `freshness` from evidence CURRENTNESS, and currentness is settled by
 * comparing each stored fingerprint against the fingerprints the CALLER attests at close
 * time (`attestation.current`). Those describe the caller's working tree at the moment of
 * the close. A READ cannot have them and must not invent them. With them absent,
 * `compareFingerprint` returns `unknown` — deliberately NOT `stale` — so `freshness` rates
 * `unknown`, `wouldBlock` gains it, and the clause verdict degrades to `unknown`.
 *
 * So on this surface `unknown` means "a read cannot establish this", NOT "this clause
 * fails". A renderer that flattens it into a blocker shows a human a hard failure for a
 * clause whose evidence may be perfectly current, and an agent that reads it as a refusal
 * abandons a close the gate would have accepted. `verdictIsLowerBound` is set true on
 * exactly the rows where this applies, so the caveat travels WITH the data rather than
 * living only in this comment. This is the D-017 honesty rule one level deeper: D-017
 * says advisory reports must not render as failures; D-020 says an UNESTABLISHED verdict
 * must not either.
 *
 * ⚠ `impactReport` remains advisory under D-017 and is populated independently of `ok`.
 *
 * DELIBERATELY LAZY, like every P-011 sibling: the gate resolves the contract, then reads
 * evidence, then scorecards, so the consumer gates it with `useSyncQuery({ enabled })` and
 * nothing runs until a human opens the section.
 */
export const workItemSpecAdequacyArgsSchema = z.object({
  // `.default('default')` matches every other workspace-scoped entry in this registry.
  workspaceId: z.string().default('default'),
  harnessSlug: z.string().min(1),
  workItemId: z.string().min(1),
  /**
   * The plan-class rubric to grade against. OPTIONAL on purpose: omitting it reproduces
   * exactly what an agent calling `work_items:complete` with no `specAdequacy` argument
   * is told, which is the single most useful thing this read can say to a caller who does
   * not yet know the answer. Supplying it advances to the per-clause verdicts.
   *
   * Enumerated from PLAN_CLASS_RUBRIC_REFS rather than re-listed here — a second copy of
   * the rubric set is exactly the code-describing metadata the repo forbids hand-maintaining.
   */
  classRef: z.enum(PLAN_CLASS_RUBRIC_REFS).optional(),
});

export type WorkItemSpecAdequacyArgs = z.infer<typeof workItemSpecAdequacyArgsSchema>;

/**
 * One enforceable clause with the PROOF FLOOR the chosen class demands of it — the
 * "rubric role" made concrete per clause. `requiredProofFloor` is a pure exported
 * function of (clause, classRef), so calling it is reuse of the gate's own rule, not a
 * second implementation of it. Null when no classRef was supplied: the floor is not a
 * property of the clause alone, and guessing a class to fill the column would be a
 * fabricated answer.
 */
export interface SpecAdequacyClauseView {
  specId: string;
  revision: number;
  behaviorClass: string;
  mutationRequired: boolean;
  requiredTestLayers: string[];
  requiredProofFloor: 'none' | 'l3' | 'l4' | null;
}

export interface WorkItemSpecAdequacyRow {
  workItemId: string;
  /** The ROLE: the rubric this item's close is graded under. */
  rubricRef: typeof SPEC_TEST_ADEQUACY_RUBRIC_REF;
  /** The plan-class rubric the floors were computed against; null when not supplied. */
  classRef: PlanClassRubricRef | null;
  /** Whether the reader supplied a class — see `classRef` on the args schema. */
  attestationSupplied: boolean;
  /**
   * The gate's own verdict, passed through rather than re-derived.
   * `applicable:false` means the gate does not judge this item at all.
   */
  verdict: {
    ok: boolean;
    applicable: boolean;
    /** Clause labels (`specId@revision`) the gate accepted. */
    checked: string[];
    /**
     * The EXACT refusal string `work_items:complete` would return, verbatim and unparsed.
     * Null when the gate is satisfied. Not split into a list: the gate owns this string's
     * shape, and re-parsing a producer we control is how a renderer silently rots.
     */
    blockerReason: string | null;
    /** ADVISORY (D-017). Never render as a failure. */
    impactReport: string | null;
  };
  /**
   * TRUE whenever the gate ran without caller-attested evidence fingerprints, which is
   * every read. See the module header (D-020): `unknown` findings under this flag are
   * UNESTABLISHED, not failed.
   */
  verdictIsLowerBound: boolean;
  clauses: SpecAdequacyClauseView[];
  unavailableReason: 'work-item-not-found' | 'resolver-unavailable' | null;
}

export async function resolveWorkItemSpecAdequacy(args: WorkItemSpecAdequacyArgs): Promise<unknown[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  const { workspaceId, harnessSlug, workItemId, classRef } = args;

  const rows = await sql`
    SELECT feature_id, harness_slug, item_kind, payload, source_plan_slug, source_plan_item_ids
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${harnessSlug}
       AND feature_id   = ${workItemId}
     LIMIT 1
  `;

  const empty = (unavailableReason: WorkItemSpecAdequacyRow['unavailableReason']) => [
    {
      workItemId,
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      classRef: classRef ?? null,
      attestationSupplied: Boolean(classRef),
      verdict: { ok: true, applicable: false, checked: [], blockerReason: null, impactReport: null },
      verdictIsLowerBound: true,
      clauses: [],
      unavailableReason,
    } satisfies WorkItemSpecAdequacyRow,
  ];

  // A missing row is a different fact from "the gate does not apply". Say which.
  if (rows.length === 0) return empty('work-item-not-found');

  const r = rows[0] as {
    feature_id: string;
    harness_slug: string | null;
    item_kind: string | null;
    payload: unknown;
    source_plan_slug: string | null;
    source_plan_item_ids: string[] | null;
  };

  const workItem = {
    id: r.feature_id,
    kind: r.item_kind,
    harness: r.harness_slug ?? harnessSlug,
    payload: r.payload,
    sourcePlanSlug: r.source_plan_slug,
    sourcePlanItemIds: r.source_plan_item_ids ?? undefined,
  };

  const [gateMod, contractMod, adequacyMod] = await Promise.all([
    import('../agent-tools/work_items/spec-test-adequacy-gate'),
    import('../agent-tools/plans/behavior-contract-resolver'),
    import('../agent-tools/plans/spec-test-adequacy'),
  ]);

  // The SAME gate the close path calls. `current` is deliberately never supplied — see
  // the module header (D-020); that omission is what makes the verdict a lower bound.
  const gate = await gateMod
    .specTestAdequacyCompletionGate({
      workItem,
      ...(classRef ? { attestation: { classRef } } : {}),
    })
    .catch(() => null);

  // Fail-soft and DISTINGUISHABLE: a gate that simply failed must never render as
  // "this item is on the hook for nothing".
  if (!gate) return empty('resolver-unavailable');

  // The clause list is the ENFORCED set, and it is now DERIVED from the same function the
  // gate uses (`enforcedClausesOf`) rather than re-implemented here.
  //
  // ⚠ Do not re-inline this selection. It used to be a verbatim copy of the gate's
  // `groups.find(g => g.planSlug === stamp.planSlug)`, and a copy of a refusal rule is a
  // defect that no test can catch: this view is what a human reads to learn which clauses
  // will block their completion, so if the two ever disagree the UI confidently shows the
  // wrong set and nothing fails. P-013 widened the gate from the stamped namespace to
  // every ELIGIBLE one; had this stayed a copy, the widening would have silently made the
  // displayed set wrong everywhere it is rendered.
  const contract = await contractMod.resolveWorkItemBehaviorContract(workItem).catch(() => null);

  const clauses: SpecAdequacyClauseView[] = (contract ? contractMod.enforcedClausesOf(contract).clauses : [])
    .map((clause) => ({
      specId: clause.specId,
      revision: clause.revision,
      behaviorClass: clause.behaviorClass,
      mutationRequired: clause.mutationRequired,
      requiredTestLayers: clause.requiredTestLayers ?? [],
      requiredProofFloor: classRef ? adequacyMod.requiredProofFloor(clause, classRef) : null,
    }));

  return [
    {
      workItemId,
      rubricRef: SPEC_TEST_ADEQUACY_RUBRIC_REF,
      classRef: classRef ?? null,
      attestationSupplied: Boolean(classRef),
      verdict: {
        ok: gate.ok,
        applicable: gate.applicable,
        checked: gate.checked,
        blockerReason: gate.ok ? null : gate.reason,
        impactReport: gate.impactReport ?? null,
      },
      verdictIsLowerBound: true,
      clauses,
      unavailableReason: null,
    } satisfies WorkItemSpecAdequacyRow,
  ];
}
