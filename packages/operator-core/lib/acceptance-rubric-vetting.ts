/**
 * Shared read of the acceptance-rubric vetting prerequisite.
 *
 * The completion gate, rubric reads, grading previews, and grading writes must
 * agree on what "vetted" means.  Keep the policy here, but inject the
 * scorecard reader so this module stays below the scorecards/rubrics dependency
 * cycle (scorecards itself reads rubrics).
 */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import {
  classifyRubricEvidenceCurrentness,
  getRubric as defaultGetRubric,
  getRubricPlanRevision as defaultGetRubricPlanRevision,
  META_ACCEPTANCE_RUBRIC_ID,
  type Rubric,
} from './rubrics';
import { settledGradingAuditIsCurrent, type ScorecardRow } from './scorecards';

export type AcceptanceRubricVettingState = 'not-required' | 'disabled' | 'unvetted' | 'vetted';

/**
 * Why one candidate meta-rubric card did not count as a settled attestation.
 *
 * These are the checks the card actually failed, in evaluation order.  The
 * refusal used to be decided from the SURVIVOR COUNT alone, so every one of
 * these landed on the single string `missing-attestation` and named no card —
 * making the four causes indistinguishable to the agent being refused.
 */
export type AcceptanceRubricVettingRejection =
  | 'rubric-unresolved'
  | 'incomplete-ratings'
  | 'synthesized'
  | 'grading-audit-unsettled'
  | 'no-critique-channel'
  | 'stale-revision';

/** One considered meta-rubric card, and the verdict the vetting read reached on it. */
export interface AcceptanceRubricVettingCandidate {
  /** The meta-rubric scorecard's engineer_issue id — the drill-back key. */
  issueId: string;
  createdAt: string;
  /** Which check dropped it; null when this card IS a settled, current attestation. */
  rejectedBy: AcceptanceRubricVettingRejection | null;
  /** What that check actually observed on THIS card, in the reader's own terms. */
  detail: string;
  attestedRevision: number | null;
  attestedCriteriaHash: string | null;
}

export interface AcceptanceRubricVettingStatus {
  /** Whether this rubric must carry a current meta-rubric attestation. */
  required: boolean;
  /** Whether the current rubric may proceed to grading/completion. */
  satisfied: boolean;
  state: AcceptanceRubricVettingState;
  /** Why the prerequisite is or is not active; useful to read surfaces and teaching errors. */
  reason:
    | 'non-acceptance-rubric'
    | 'empty-acceptance-rubric'
    | 'meta-rubric'
    | 'gate-disabled'
    | 'meta-rubric-missing'
    /** No meta-rubric card exists for this rubric at all — nobody has attested it. */
    | 'missing-attestation'
    /** Cards exist but every one failed a check before currentness; see `candidates`. */
    | 'rejected-attestation'
    /** A complete, linked, audited attestation exists but not for the current revision. */
    | 'stale-attestation'
    | 'current';
  gateEnabled: boolean;
  metaRubricRef: string;
  currentRevision: number | null;
  currentCriteriaHash?: string | null;
  attestedRevision: number | null;
  attestedCriteriaHash?: string | null;
  attestedRevisions: number[];
  attestationIssueId: string | null;
  consultId: string | null;
  /** WI-41477: the review work-item channel — set when the attestation's critique
   *  was recorded as work-item comments instead of a consult. */
  workItemId: string | null;
  /**
   * Every meta-rubric card considered, newest first, each with the check that
   * dropped it.  This is what makes an `unvetted` verdict actionable: the
   * top-level `reason` is a class, `candidates` is the evidence.
   */
  candidates: AcceptanceRubricVettingCandidate[];
  /**
   * A bounded one-line rendering of the rejected candidates, ready to splice
   * into a teaching error.  Null when no card was rejected.
   */
  diagnosis: string | null;
  vettedUnderWaiver?: { consultId: string; reason?: string };
  /**
   * Set only on an UNVETTED verdict where some candidate is stranded on a pending
   * grade-the-grader audit AND new audit dispatch is suppressed right now — the
   * machine-readable form of the note appended to that candidate's `detail`.
   */
  gradingAuditDispatchSuppressed?: GradingAuditDispatchSuppression;
  /**
   * Set only on an UNVETTED verdict where some candidate is stranded on a pending
   * grade-the-grader audit that dispatch is NOT known to suppress: the exact call
   * that launches its auditor now (WI-10005150). The rejection carries its own
   * repair, so the reader does not have to find the lever in source.
   */
  pendingGradingAuditRepair?: PendingGradingAuditRepair;
}

/**
 * The manual lever for a pending grade-the-grader audit (WI-10005150).
 *
 * Automatic re-dispatch only happens when a later `scorecards:emit` (or a gated
 * completion) runs the no-target backlog sweep, and that sweep reads only the
 * newest bounded window of scorecards. A pending card that has aged out of that
 * window is reachable ONLY by naming it, which is what this call does.
 */
export interface PendingGradingAuditRepair {
  tool: 'scorecards:repair';
  args: { targetIds: string[] };
}

/** Text appended to a pending-audit rejection whose dispatch is not suppressed. */
export function describePendingGradingAuditRepair(issueId: string): string {
  return (
    `it settles only when an independent auditor is dispatched; dispatch one now with ` +
    `scorecards:repair { targetIds: ['${issueId}'] }. The automatic re-dispatch rides on a later ` +
    `scorecards:emit and sweeps only the most recent scorecards, so an older pending card can wait indefinitely`
  );
}

/**
 * Why NEW grade-the-grader audits are not being dispatched right now (EI-24121421744054354).
 *
 * A meta-rubric card whose audit is `pending` settles only when an auditor is
 * launched and files its verdict. While a workspace-wide loop stand-down is in
 * force, `dispatchPendingGradingAudits` launches nobody, so `pending` cannot move
 * until the stand-down expires or is lifted. Without this, the vetting read said
 * only "audit is 'pending'", which reads as "wait a bit" — the true blocker was
 * visible solely on a `scorecards:repair` receipt.
 */
export interface GradingAuditDispatchSuppression {
  reason: 'workspace-wide-loop-standdown';
  /** Loop owners currently held by an unexpired workspace-wide stand-down. */
  pausedOwnerCount: number;
  /** Present when this particular scorecard owner, rather than the whole workspace, is held. */
  targetOwnerId?: string;
}

export interface AcceptanceRubricVettingDeps {
  /** Required at call sites so this policy module does not import scorecards at runtime. */
  listScorecards: (filter: {
    rubricRef?: string;
    subjectRef?: string;
    limit?: number;
  }) => Promise<ScorecardRow[]>;
  getRubric?: typeof defaultGetRubric;
  getRubricPlanRevision?: typeof defaultGetRubricPlanRevision;
  vettingGateEnabled?: boolean;
  readVettingGateEnabled?: () => Promise<boolean>;
  /**
   * Optional: is grade-the-grader dispatch suppressed right now? Consulted only
   * when a candidate was rejected for a `pending` audit. Omitted ⇒ never
   * consulted, and every pending candidate is treated as repairable. A throw is
   * treated as "not suppressed" — this read only ANNOTATES a refusal, it never
   * decides one.
   */
  readGradingAuditDispatchSuppression?: (targetOwnerId?: string | null) => Promise<GradingAuditDispatchSuppression | null>;
}

/** Text appended to a pending-audit rejection while dispatch is suppressed. */
export function describeGradingAuditDispatchSuppression(s: GradingAuditDispatchSuppression): string {
  if (s.targetOwnerId) {
    return (
      `NO auditor will be launched for scorecard owner '${s.targetOwnerId}' while ` +
      `an active workspace-wide loop stand-down holds ${s.pausedOwnerCount} loop owner(s); this pending audit ` +
      `cannot settle until that owner resumes or the stand-down expires (scorecards:repair returns ` +
      `'skipped: dispatch suppressed'). Waiting or re-emitting will not help.`
    );
  }
  return (
    `NO auditor will be launched while an active workspace-wide loop stand-down holds ` +
    `${s.pausedOwnerCount} loop owner(s) — grade-the-grader dispatch is suppressed, so this pending audit ` +
    `cannot settle until the stand-down expires or its owner lifts it (scorecards:repair returns ` +
    `'skipped: dispatch suppressed'). Waiting or re-emitting will not help; this is an owner-pause blocker.`
  );
}

function notRequired(
  reason: AcceptanceRubricVettingStatus['reason'],
  gateEnabled: boolean,
): AcceptanceRubricVettingStatus {
  return {
    required: false,
    satisfied: true,
    state: reason === 'gate-disabled' ? 'disabled' : 'not-required',
    reason,
    gateEnabled,
    metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
    currentRevision: null,
    attestedRevision: null,
    attestedRevisions: [],
    attestationIssueId: null,
    consultId: null,
    workItemId: null,
    candidates: [],
    diagnosis: null,
  };
}

/** Render a revision/criteria-hash pair the way a reader can compare two of them. */
function describeIdentity(revision: number | null | undefined, criteriaHash: string | null | undefined): string {
  const rev = revision == null ? 'revision (unrecorded)' : `revision ${revision}`;
  return criteriaHash ? `${rev} / criteria ${criteriaHash.slice(0, 12)}` : rev;
}

/**
 * Decide, for ONE meta-rubric card, whether it is a settled current attestation —
 * and when it is not, which check rejected it and what that check saw.
 *
 * The check order here IS the policy order the vetting read applies, and it
 * matters: `missingKeys` is only meaningful once `rubricResolved` is true, so an
 * unresolved rubric must be reported as such rather than as complete ratings.
 */
function classifyVettingCandidate(
  card: ScorecardRow,
  live: { revision: number | null; criteriaHash?: string | null; meaningRevision?: number | null },
): { rejectedBy: AcceptanceRubricVettingRejection | null; detail: string } {
  if (!card.rubricResolved) {
    return {
      rejectedBy: 'rubric-unresolved',
      detail: `rubricRef '${card.rubricRef}' did not resolve, so this card's completeness cannot be judged`,
    };
  }
  if (card.missingKeys.length > 0) {
    const n = card.missingKeys.length;
    return {
      rejectedBy: 'incomplete-ratings',
      detail: `rates no value for ${n} meta criteri${n === 1 ? 'on' : 'a'}: ${card.missingKeys.join(', ')}`,
    };
  }
  if (card.synthesized) {
    return { rejectedBy: 'synthesized', detail: 'synthesized floor card, never an emitted attestation' };
  }
  if (!settledGradingAuditIsCurrent(card)) {
    const audit = card.gradingAudit;
    const currentness = card.gradingAuditCurrentness;
    const detail =
      audit && audit.state !== 'passed'
        ? `grade-the-grader audit is '${audit.state}' — only an audited pass settles an attestation`
        : `grade-the-grader stamp is ${currentness?.state ?? 'unreadable'}` +
          (currentness?.reason ? ` (${currentness.reason})` : '');
    return { rejectedBy: 'grading-audit-unsettled', detail };
  }
  if (!card.vetting?.consultId && !card.vetting?.workItemId) {
    return {
      rejectedBy: 'no-critique-channel',
      detail: 'no vetting linkage recorded — neither a get_feedback consult nor a review work-item',
    };
  }
  const currentness = classifyRubricEvidenceCurrentness(
    {
      revision: card.vetting?.rubricRevision,
      criteriaHash: card.vetting?.criteriaHash,
      meaningRevision: card.vetting?.rubricMeaningRevision,
    },
    { revision: live.revision, criteriaHash: live.criteriaHash, meaningRevision: live.meaningRevision },
  );
  if (currentness.state !== 'current') {
    return {
      rejectedBy: 'stale-revision',
      detail:
        `attested ${describeIdentity(card.vetting?.rubricRevision, card.vetting?.criteriaHash)}, ` +
        `rubric is now at ${describeIdentity(live.revision, live.criteriaHash)} (${currentness.reason})`,
    };
  }
  return { rejectedBy: null, detail: 'settled attestation for the current revision' };
}

/** Bounded one-liner naming WHICH card failed WHICH check — safe to splice into an error. */
function summarizeRejections(candidates: AcceptanceRubricVettingCandidate[], show = 5): string | null {
  const rejected = candidates.filter((c) => c.rejectedBy !== null);
  if (rejected.length === 0) return null;
  const shown = rejected
    .slice(0, show)
    .map((c) => `${c.issueId} → ${c.rejectedBy}: ${c.detail}`)
    .join('; ');
  const omitted = rejected.length - Math.min(rejected.length, show);
  return omitted > 0 ? `${shown}; +${omitted} more rejected card(s)` : shown;
}

/**
 * Read the single acceptance-rubric vetting verdict used by all consumers.
 *
 * A missing meta-rubric intentionally disables this prerequisite: that is the
 * existing fail-open compatibility rule which prevents a fresh workspace from
 * deadlocking every acceptance plan before the meta-rubric is installed.  Once
 * the meta-rubric exists, a missing or stale current-revision attestation is a
 * hard unsatisfied result.  An unreadable current revision preserves the
 * historical open behavior: any complete linked attestation is usable because
 * there is no trustworthy revision to compare against.
 */
export async function getAcceptanceRubricVettingStatus(
  rubric: Rubric,
  deps: AcceptanceRubricVettingDeps,
): Promise<AcceptanceRubricVettingStatus> {
  const gateEnabled =
    deps.vettingGateEnabled ??
    (deps.readVettingGateEnabled
      ? await deps.readVettingGateEnabled()
      : await getFlag(FLAGS.ACCEPTANCE_RUBRIC_VETTING_GATE, 'system').catch(() => true));

  if (rubric.kind !== 'acceptance') return notRequired('non-acceptance-rubric', gateEnabled);
  if (rubric.rubricId === META_ACCEPTANCE_RUBRIC_ID) return notRequired('meta-rubric', gateEnabled);
  if (rubric.criteria.length === 0) return notRequired('empty-acceptance-rubric', gateEnabled);
  if (!gateEnabled) return notRequired('gate-disabled', gateEnabled);

  const getRubric = deps.getRubric ?? defaultGetRubric;
  const getRubricPlanRevision = deps.getRubricPlanRevision ?? defaultGetRubricPlanRevision;
  const metaRubric = await getRubric(META_ACCEPTANCE_RUBRIC_ID);
  if (!metaRubric) return notRequired('meta-rubric-missing', gateEnabled);

  const [currentRevision, metaCards] = await Promise.all([
    getRubricPlanRevision(rubric.rubricId),
    deps.listScorecards({
      rubricRef: META_ACCEPTANCE_RUBRIC_ID,
      subjectRef: rubric.rubricId,
      limit: 50,
    }),
  ]);
  // Judge every card ONCE and keep the per-card verdict, rather than filtering
  // the population down and then inferring a cause from how many survived.  The
  // policy is unchanged — the checks and their order are the same, and
  // `vettedCards` still means "survived everything except currentness" — but a
  // rejection now travels with the card it belongs to.  P-013: a pending or
  // failed grade-the-grader stamp must never make a rubric appear vetted, while
  // unstamped pre-P-013 cards stay acceptable.  WI-41477: either critique
  // channel counts — a get_feedback consult, or the review work-item a launched
  // independent reviewer's comments land on.
  const candidates: AcceptanceRubricVettingCandidate[] = [];
  const vettedCards: ScorecardRow[] = [];
  const pendingAuditCandidates: Array<{ candidate: AcceptanceRubricVettingCandidate; targetOwnerId: string | null }> = [];
  let current: ScorecardRow | undefined;
  for (const card of [...metaCards].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
    const { rejectedBy, detail } = classifyVettingCandidate(card, {
      revision: currentRevision,
      criteriaHash: rubric.criteriaHash,
      meaningRevision: rubric.barContract?.meaningRevision,
    });
    const candidate: AcceptanceRubricVettingCandidate = {
      issueId: card.issueId,
      createdAt: card.createdAt,
      rejectedBy,
      detail,
      attestedRevision: card.vetting?.rubricRevision ?? null,
      attestedCriteriaHash: card.vetting?.criteriaHash ?? null,
    };
    candidates.push(candidate);
    if (rejectedBy === 'grading-audit-unsettled' && card.gradingAudit?.state === 'pending') {
      if (card.subject?.kind === 'rubric' && card.subjectRubricCurrentness?.state !== 'current') {
        const subjectCurrentness = card.subjectRubricCurrentness;
        candidate.detail =
          `${detail}. The subject rubric is ${subjectCurrentness?.state ?? 'unknown'}` +
          (subjectCurrentness?.reason ? ` (${subjectCurrentness.reason})` : '') +
          '; scorecards:repair skips non-current rubric subjects, so re-attest against the current revision instead';
      } else {
        pendingAuditCandidates.push({ candidate, targetOwnerId: card.createdBy });
      }
    }
    if (rejectedBy === null || rejectedBy === 'stale-revision') vettedCards.push(card);
    if (rejectedBy === null && !current) current = card;
  }
  // EI-24121421744054354: a pending audit settles only when an auditor is launched.
  // If dispatch is suppressed, say so ON the card it strands — otherwise the refusal
  // reads as "wait a bit" while nothing can move until an owner pause lifts.
  // WI-10005150: when dispatch is NOT suppressed, name the call that launches the
  // auditor now. Waiting is not guaranteed to help: automatic re-dispatch sweeps
  // only the newest scorecards, so an aged-out pending card never moves unaided.
  // Both annotations are skipped once a settled attestation carries — re-auditing
  // a card that no longer gates anything would spend an auditor for nothing.
  let gradingAuditDispatchSuppressed: GradingAuditDispatchSuppression | undefined;
  const repairableAuditTargets: string[] = [];
  if (!current && pendingAuditCandidates.length > 0) {
    const suppressionByOwner = new Map<string | null, GradingAuditDispatchSuppression | null>();
    const readSuppression = deps.readGradingAuditDispatchSuppression;
    for (const { candidate, targetOwnerId } of pendingAuditCandidates) {
      let suppression: GradingAuditDispatchSuppression | null = null;
      if (readSuppression) {
        if (suppressionByOwner.has(targetOwnerId)) suppression = suppressionByOwner.get(targetOwnerId) ?? null;
        else {
          suppression = await readSuppression(targetOwnerId).catch(() => null);
          suppressionByOwner.set(targetOwnerId, suppression);
        }
      }
      if (suppression) {
        gradingAuditDispatchSuppressed ??= suppression;
        candidate.detail = `${candidate.detail}. ${describeGradingAuditDispatchSuppression(suppression)}`;
        continue;
      }
      repairableAuditTargets.push(candidate.issueId);
      candidate.detail = `${candidate.detail}. ${describePendingGradingAuditRepair(candidate.issueId)}`;
    }
  }
  const pendingGradingAuditRepair: PendingGradingAuditRepair | undefined =
    repairableAuditTargets.length > 0
      ? { tool: 'scorecards:repair', args: { targetIds: repairableAuditTargets } }
      : undefined;
  const attestedRevisions = [
    ...new Set(vettedCards.map((card) => card.vetting?.rubricRevision).filter((v): v is number => v != null)),
  ];
  const diagnosis = summarizeRejections(candidates);

  if (!current) {
    return {
      required: true,
      satisfied: false,
      state: 'unvetted',
      // Three DIFFERENT facts, no longer collapsed: a complete attestation that
      // is merely out of date, an attestation that exists but failed a check,
      // and no attestation at all. `candidates` says which card and which check.
      reason:
        vettedCards.length > 0
          ? 'stale-attestation'
          : candidates.length > 0
            ? 'rejected-attestation'
            : 'missing-attestation',
      gateEnabled,
      metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
      currentRevision,
      currentCriteriaHash: rubric.criteriaHash ?? null,
      attestedRevision: vettedCards[0]?.vetting?.rubricRevision ?? null,
      attestedCriteriaHash: vettedCards[0]?.vetting?.criteriaHash ?? null,
      attestedRevisions,
      attestationIssueId: vettedCards[0]?.issueId ?? null,
      consultId: vettedCards[0]?.vetting?.consultId ?? null,
      workItemId: vettedCards[0]?.vetting?.workItemId ?? null,
      candidates,
      diagnosis,
      ...(gradingAuditDispatchSuppressed ? { gradingAuditDispatchSuppressed } : {}),
      ...(pendingGradingAuditRepair ? { pendingGradingAuditRepair } : {}),
    };
  }

  const vetting = current.vetting!;
  return {
    required: true,
    satisfied: true,
    state: 'vetted',
    reason: 'current',
    gateEnabled,
    metaRubricRef: META_ACCEPTANCE_RUBRIC_ID,
    currentRevision,
    currentCriteriaHash: rubric.criteriaHash ?? null,
    attestedRevision: vetting.rubricRevision ?? null,
    attestedCriteriaHash: vetting.criteriaHash ?? null,
    attestedRevisions,
    attestationIssueId: current.issueId,
    consultId: vetting.consultId ?? null,
    workItemId: vetting.workItemId ?? null,
    candidates,
    // Non-null when OTHER cards were rejected even though this one carried: a
    // satisfied verdict should not hide that some attestations did not count.
    diagnosis,
    // The unanswered waiver exists only on the consult channel (WI-41477: a
    // work-item link with no third-party comment is refused at emit, never waived).
    ...(vetting.unanswered && vetting.consultId
      ? {
          vettedUnderWaiver: {
            consultId: vetting.consultId,
            ...(vetting.unansweredReason ? { reason: vetting.unansweredReason } : {}),
          },
        }
      : {}),
  };
}
