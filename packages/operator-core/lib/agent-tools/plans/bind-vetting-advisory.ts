/**
 * Vet before proof — the `plans:bind-spec-evidence` advisory
 * (review-system-rework-reduction-2026-09-23 P-004).
 *
 * The acceptance flow's cheap order is amend → vet → attest → bind → cards →
 * grade. Binding BAR proof BEFORE the rubric's current revision is vetted spends
 * a proof cycle that a vetting critique routinely invalidates: the critique
 * becomes a `rubrics:amend`, the amendment re-revisions the clauses it touches,
 * and proof bound to the old revision no longer covers them. The audit behind
 * this plan measured it directly — phase 8 of its timeline was labelled
 * "vetting after proof" (docs/evidence/review-system-time-audit-2026-09-23.md,
 * root cause 2: "A vetting critique should cost a text edit; today it costs a
 * proof cycle").
 *
 * ADVISORY, never a refusal: binding early stays legal (a vetted rubric can
 * still be amended later, and some proof is worth recording immediately). The
 * binding is always written; this only tells the caller, at the moment it is
 * about to spend the expensive step, that the cheap step has not happened yet.
 *
 * Scope is deliberately narrow so the warning is not noise:
 *   - only bindings to projected BAR clauses (`AUTO-BAR-<barKey>-<P-NNN>`, the
 *     canonical identity `synchronizeAcceptanceBarRevision` mints) — a vetting
 *     amendment cannot re-revision a hand-authored plan spec;
 *   - only when the plan has exactly ONE live acceptance rubric (an ambiguous
 *     pair is the gate's own refusal, not this advisory's business);
 *   - only when the shared vetting read says the prerequisite is required AND
 *     unsatisfied — the same verdict the ship gate and `scorecards:emit` use,
 *     so this cannot disagree with them about what "vetted" means.
 */
import type { AcceptanceRubricVettingStatus } from '../../acceptance-rubric-vetting';
import type { Rubric } from '../../rubrics';
import { rubricVettingConsultHint } from '../../consult/selection-policies';

/** The canonical spec-id prefix of a clause projected from an acceptance BAR. */
export const BAR_CLAUSE_SPEC_PREFIX = 'AUTO-BAR-';

/** The runbook order this advisory teaches — one rendering, reused in prose. */
export const VET_BEFORE_PROOF_ORDER = 'amend → vet → attest → bind → cards → grade';

export interface UnvettedRubricBindAdvisory {
  code: 'acceptance_rubric_unvetted_before_proof';
  rubricRef: string;
  currentRevision: number | null;
  /** The shared vetting read's reason (missing / rejected / stale attestation). */
  vettingReason: AcceptanceRubricVettingStatus['reason'];
  /** The BAR clauses this call bound proof to, in first-seen order. */
  barSpecIds: string[];
  message: string;
  /** Where to read the full vetting verdict (candidates + diagnosis). */
  nextVerb: { name: 'rubrics:get'; args: { rubricRef: string } };
}

export interface UnvettedRubricBindAdvisoryDeps {
  getAcceptanceRubricsForPlan: (planSlug: string, options: { harnessSlug?: string }) => Promise<Rubric[]>;
  readVettingStatus: (rubric: Rubric) => Promise<AcceptanceRubricVettingStatus>;
}

/** Distinct BAR-clause spec ids among the bindings, in first-seen order. */
export function barClauseSpecIds(specIds: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const id of specIds) {
    if (id && id.startsWith(BAR_CLAUSE_SPEC_PREFIX) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Compute the advisory, or null when it does not apply. Never throws: a read
 * failure here must not turn a successfully written binding into an error, and
 * an unreadable vetting state is not evidence the rubric is unvetted.
 */
export async function unvettedRubricBindAdvisory(
  input: { planSlug?: string | null; harnessSlug?: string; specIds: ReadonlyArray<string | null | undefined> },
  deps: UnvettedRubricBindAdvisoryDeps,
): Promise<UnvettedRubricBindAdvisory | null> {
  if (!input.planSlug) return null;
  const barSpecIds = barClauseSpecIds(input.specIds);
  if (barSpecIds.length === 0) return null;
  try {
    const rubrics = await deps.getAcceptanceRubricsForPlan(input.planSlug, {
      ...(input.harnessSlug ? { harnessSlug: input.harnessSlug } : {}),
    });
    if (rubrics.length !== 1) return null;
    const rubric = rubrics[0]!;
    const status = await deps.readVettingStatus(rubric);
    if (!status.required || status.satisfied) return null;
    const revision = status.currentRevision == null ? 'its current revision' : `revision ${status.currentRevision}`;
    const n = barSpecIds.length;
    const message =
      `Proof was recorded, but acceptance rubric '${rubric.rubricId}' is UNVETTED at ${revision} ` +
      `(${status.reason}). You bound proof to ${n} BAR clause${n === 1 ? '' : 's'} before vetting: a vetting ` +
      'critique usually becomes a rubrics:amend, which re-revisions the clauses it touches, and proof bound to ' +
      `the old revision must then be re-bound. Cheap order: ${VET_BEFORE_PROOF_ORDER}. Vet the current revision ` +
      `first — consult:get_feedback (${rubricVettingConsultHint()}), fold the critique into one amendment, then ` +
      "attest with scorecards:emit against meta-acceptance-rubric — and bind the remaining proof after that. " +
      `rubrics:get { rubricRef:'${rubric.rubricId}' } shows the vetting verdict and which attestation failed.`;
    return {
      code: 'acceptance_rubric_unvetted_before_proof',
      rubricRef: rubric.rubricId,
      currentRevision: status.currentRevision,
      vettingReason: status.reason,
      barSpecIds,
      message,
      nextVerb: { name: 'rubrics:get', args: { rubricRef: rubric.rubricId } },
    };
  } catch {
    return null;
  }
}
