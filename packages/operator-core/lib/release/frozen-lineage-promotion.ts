/**
 * P-007 / D-004 (plan frozen-candidate-stays-frozen-through-all-fixes-2026-09-03).
 *
 * The promotion predicate for a frozen candidate's repair lineage.
 *
 * D-001 held that an isolated repair head was VERIFICATION-ONLY: a green repair could not
 * advance the release ref, so the gate joined it into the moving integration tip and re-ran
 * the complete gate at that joined sha. That discarded the proof the repair had just earned
 * and re-imported every commit landed since the freeze — the treadmill D-007 diagnosed.
 *
 * D-004 (RATIFIED by the owner, 2026-09-03 ~22:58Z) replaces the veto: `main` may fast-forward
 * to a commit OF THE FROZEN LINEAGE that passed the full canonical gate. This module is the
 * "of the frozen lineage" half — the veto's replacement, not its removal.
 *
 * It is deliberately FAIL-CLOSED and takes already-measured booleans rather than shelling out,
 * so the whole decision is a pure function the guard tests can enumerate exhaustively. An
 * unreadable git answer arrives as `null` and refuses exactly as loudly as a negative one: a
 * measurement that failed is never a verdict.
 */

export type FrozenLineagePromotionCode =
  | 'promotable'
  | 'judged-sha-is-not-the-repair-head'
  | 'repair-head-does-not-descend-from-candidate'
  | 'repair-head-absent-from-lineage-ref'
  | 'lineage-unreadable';

export interface FrozenLineagePromotionInput {
  /** The immutable frozen candidate the queue opened on. */
  candidate: string;
  /** The queue's current repair head — the candidate plus every admitted fix blob. */
  repairHead: string;
  /** The sha the full canonical gate actually judged green this run. */
  judged: string;
  /**
   * `git merge-base --is-ancestor <candidate> <judged>` — true when the judged sha is built
   * on top of the frozen candidate. `null` when the measurement could not be taken.
   */
  judgedDescendsFromCandidate: boolean | null;
  /**
   * `git merge-base --is-ancestor <judged> refs/papercusp/frozen/<candidate>` — true when the
   * judged sha is reachable from the CAS-advanced admission ledger ref, which is the only
   * record of what was actually admitted.
   *
   * `false` when the ref resolves and does not contain the sha, AND when the ref does not exist
   * at all: "no admission ever opened a lineage for this candidate" is a definite negative, not
   * an unmeasured one. Reserve `null` for a git invocation that actually FAILED.
   *
   * Ignored when `judged === candidate` (see below): a candidate with zero admissions is the
   * root of its own lineage and legitimately has no ledger ref yet.
   */
  judgedOnLineageRef: boolean | null;
}

export interface FrozenLineagePromotionVerdict {
  promotable: boolean;
  code: FrozenLineagePromotionCode;
  /** Human-readable reason; lands in the gate log and the promotion broadcast verbatim. */
  summary: string;
}

const short = (sha: string): string => sha.slice(0, 8);

/**
 * Decide whether a green full-gate verdict at `judged` may fast-forward the release ref.
 *
 * Every check is a positive proof obligation. The order is deliberate: identity first (is this
 * even the head we froze work onto?), then ancestry (is it built on the candidate?), then
 * membership (did an admission actually produce it?). Descent alone is NOT membership —
 * anything committed on top of the candidate descends from it, including a commit no admission
 * ever authored.
 */
export function assessFrozenLineagePromotion(
  input: FrozenLineagePromotionInput,
): FrozenLineagePromotionVerdict {
  const { candidate, repairHead, judged, judgedDescendsFromCandidate, judgedOnLineageRef } = input;

  if (judged !== repairHead) {
    return {
      promotable: false,
      code: 'judged-sha-is-not-the-repair-head',
      summary:
        `the full gate judged ${short(judged)}, which is not the frozen repair head ` +
        `${short(repairHead)}; only the head the freeze accumulated its admissions onto may ` +
        `advance the release ref`,
    };
  }

  if (judgedDescendsFromCandidate === null) {
    return {
      promotable: false,
      code: 'lineage-unreadable',
      summary:
        `whether ${short(judged)} descends from frozen candidate ${short(candidate)} could not ` +
        `be read; refusing to promote on an unmeasured lineage`,
    };
  }
  if (judgedDescendsFromCandidate === false) {
    return {
      promotable: false,
      code: 'repair-head-does-not-descend-from-candidate',
      summary:
        `${short(judged)} does not descend from frozen candidate ${short(candidate)}; it is a ` +
        `cut taken off the lineage, not a repair of it`,
    };
  }

  // A candidate that froze and went green with ZERO admissions is the root of its own lineage:
  // no admission ran, so `refs/papercusp/frozen/<candidate>` legitimately does not exist yet, and
  // demanding it would refuse the one case that needed no repair at all. Identity has already
  // been proven above (judged === repairHead), so this widens nothing else.
  if (judged === candidate) {
    return {
      promotable: true,
      code: 'promotable',
      summary:
        `${short(judged)} IS frozen candidate ${short(candidate)} — it passed the full canonical ` +
        `gate with no admissions, so there is no admission ledger to consult`,
    };
  }

  if (judgedOnLineageRef === null) {
    return {
      promotable: false,
      code: 'lineage-unreadable',
      summary:
        `the frozen lineage ref for candidate ${short(candidate)} could not be measured against ` +
        `${short(judged)}; refusing to promote on an unmeasured lineage`,
    };
  }
  if (judgedOnLineageRef === false) {
    return {
      promotable: false,
      code: 'repair-head-absent-from-lineage-ref',
      summary:
        `${short(judged)} is absent from the admission ledger ref for candidate ` +
        `${short(candidate)}; descent from the candidate is not proof an admission produced it`,
    };
  }

  return {
    promotable: true,
    code: 'promotable',
    summary:
      `${short(judged)} is the frozen repair head, descends from candidate ${short(candidate)} ` +
      `and is on its admission ledger ref; the full canonical gate passed at that exact sha`,
  };
}
