/**
 * gate-owner-brief.ts — gate-audit-hardening-2026-08-31 P-001.
 *
 * ONE COMPOSED, VINTAGE-STAMPED ANSWER to the owner's four-part question: *is main
 * green — if not, why not — who owns it — and is remediation actually alive?*
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * Audited 2026-08-31 (WI-1820224 + its correction comment), over the 11-day red that
 * began 2026-08-20T20:57Z: the owner's recurring experience was AGENTS TELLING HIM
 * CONFLICTING THINGS. Traced, none of the conflicts were factual disagreement — every
 * one was a vintage or denominator mismatch between separately-read surfaces:
 *
 *   • a streak counter ("42 reds") read as a current failure count;
 *   • a scoped typecheck ("clean on MY files") read as the gate's lint:tsc leg;
 *   • "plan shipped" read as "main green";
 *   • an instrument abort (zero tests executed) read as a code red — and vice versa;
 *   • a holder claim read as remediation, hours after the dispatched fixer had died.
 *
 * Each leg of that answer ALREADY EXISTS on `dev:pipeline_position` (verdict counters,
 * ownership + holder liveness, the frozen-repair-queue diagnostic with `fixerAlive`,
 * `inconclusive`) — what did not exist is the COMPOSITION: one read that answers all
 * four parts together, with each leg carrying the timestamp of the observation it came
 * from, so two agents quoting it cannot diverge without the divergence being visible.
 *
 * ── DESIGN RULES ────────────────────────────────────────────────────────────────
 * PURE COMPOSITION, ONE DERIVATION (the axis-5 doctrine): `composeGateOwnerBrief`
 * performs NO I/O and re-derives NOTHING — every input is a value
 * `gitPipelinePosition()` already computed for its existing gate block. Adding I/O
 * here would create a second derivation that can disagree with the first, which is
 * the exact class of defect the brief exists to end.
 *
 * VINTAGE ON EVERY LEG. A leg without a timestamp is a leg that can be quoted stale
 * without anyone noticing; `vintageSpreadMs` names the worst-case spread between the
 * legs so a reader can see when the composed answer mixes observations minutes apart.
 */

import type { CellOwnership } from './coord/gate-ownership';
import type { GateFailingTestsProvenance } from './git-pipeline-stats';
import type {
  FrozenCandidateBlockedReason,
  FrozenRepairAdmission,
  RepairSignatureEntry,
} from './release/frozen-candidate-repair-queue';
import type { FrozenRepairLegState } from './release/repair-leg-lifecycle';

/** The closed answer vocabulary — mirrored by the cell registration's assessment codes. */
export type GateOwnerBriefAnswer =
  | 'green'
  /**
   * P-005: green about what it JUDGED, but `main` has not fast-forwarded to it. Split out
   * of `green` because the two need different actions and the old `green` said so only in
   * prose — its safeAction told the reader to go read `git.mainBehindStaging` themselves,
   * which is precisely the second read this cell exists to remove.
   */
  | 'green-not-promoted'
  | 'red-owned-remediating'
  | 'red-owned-stalled'
  | 'red-owned-unconfirmed'
  | 'red-unowned'
  /**
   * P-005: the gate rendered NO verdict — a hold (`inconclusive`) is open and nothing was
   * judged red. Split out of the `red-*` family, which it used to fall into via
   * `red = reds > 0 || inconclusive != null`: a gate that never got to judge was reported
   * as a red someone owned, which is a manufactured failure rather than an absent one.
   * Distinct from `not-judging`, where the producer is not firing at all.
   */
  | 'no-verdict'
  | 'not-judging'
  | 'unknown';

/** WHEN a leg's underlying observation was made, and by what apparatus. */
export interface GateOwnerBriefVintage {
  observedAtMs: number | null;
  /** Age relative to the compose call's `nowMs`; null when the observation is unstamped. */
  ageMs: number | null;
  /** The apparatus the observation came from — prose, for a human reader. */
  source: string;
}

/**
 * main-green-status-visible-2026-09-03 P-010 — ONE LEG'S VINTAGE, ASSESSED.
 *
 * `vintageSpreadMs` answers "do these legs disagree about WHEN", and it was already here.
 * What it structurally cannot answer is WHICH ONE IS OLD — and that is the question a
 * reader has to answer before deciding which half of a mixed brief to believe. Measured
 * live 2026-09-03: spread 7,040,975ms (~1h57m) with no way, short of a metadata dig into
 * `gate_health`'s `readAttestation`/`failingTestsAttestation`/`inconclusiveAttestation`,
 * to tell the fresh leg from the two-hour-old one.
 */
export interface GateOwnerBriefAttestation extends GateOwnerBriefVintage {
  /** The brief path this stamps, so a reader can go from the attestation to the value. */
  leg: string;
  /** Is THIS leg past the staleness bound? `null` when the observation is unstamped. */
  stale: boolean | null;
}

/** How coherent the composed answer is — a VERDICT, not a number to interpret. */
export type GateOwnerBriefSpreadVerdict = 'not-knowable' | 'coherent' | 'mixed' | 'incoherent';

export interface GateOwnerBriefAttestations {
  /** One entry per STAMPED leg, newest first. An unstamped leg cannot attest to anything. */
  legs: GateOwnerBriefAttestation[];
  /** Identical to the brief's `vintageSpreadMs` BY CONSTRUCTION — that field reads this one. */
  spreadMs: number | null;
  verdict: GateOwnerBriefSpreadVerdict;
  /** The stale legs, NAMED — the whole point of the item. Empty when every leg is fresh. */
  staleLegs: string[];
  /** The oldest stamped leg: the one that bounds how far this brief can be trusted. */
  oldestLeg: string | null;
  /** One line, ready to quote. */
  summary: string;
}

/**
 * A leg observed longer ago than ONE GATE INTERVAL predates the most recent tick, so it
 * cannot be describing the run the brief's other legs describe. The green-checkpoint cron
 * is hourly (`37 22 * * * *`), which is what sets this bound — not a taste judgement.
 */
export const GATE_OWNER_BRIEF_LEG_STALE_MS = 60 * 60_000;

/**
 * Spread bands. `incoherent` starts at one gate interval for the same reason as above: at
 * that spread the legs straddle at least one tick, so they CANNOT all describe one run.
 * `coherent` is deliberately tight — legs composed in the same read are seconds apart, so
 * anything past a few minutes already means something was carried.
 */
export const GATE_OWNER_BRIEF_SPREAD_COHERENT_MS = 5 * 60_000;
export const GATE_OWNER_BRIEF_SPREAD_INCOHERENT_MS = GATE_OWNER_BRIEF_LEG_STALE_MS;

export interface GateOwnerBriefAssessment {
  code: GateOwnerBriefAnswer;
  meaning: string;
  safeAction: string;
}

/** D-013: staging's relation to the exact main pin written for the judged verdict. */
export type GateOwnerBriefStagingRelation =
  | 'equal'
  | 'ahead-after-absorption'
  | 'absorption-pending'
  | 'diverged'
  | 'unknown';

/** Human-readable, branchable lifecycle vocabulary requested by P-011. */
export type GateOwnerBriefRepairStatus =
  | 'red-at-candidate'
  | `admitted-in-${number}`
  | `green-at-${string}`;

export interface GateOwnerBriefPromotionInput {
  /** Candidate/repairHead the recorded verdict actually judged. */
  judgedSha: string | null;
  /** Where the gate writer observed main after that verdict completed. */
  mainPin: string | null;
  /** Exact ancestry result: does mainPin contain judgedSha? */
  mainContainsJudgedSha: boolean | null;
  /** Current staging head, sampled separately from the writer-owned verdict identity. */
  stagingHead: string | null;
  /** Does staging descend from the writer-owned main pin? */
  stagingContainsMainPin: boolean | null;
  /** Does staging descend from the judged sha? */
  stagingContainsJudgedSha: boolean | null;
  /** Ordinary uncheckpointed staging backlog; never promotion evidence. */
  stagingBufferPresent: boolean | null;
}

/**
 * D-013's closed staging relation. Equality is direct identity; every other positive
 * classification is backed by ancestry booleans computed by gitPipelinePosition().
 */
export function classifyGateOwnerBriefStagingRelation(
  input: GateOwnerBriefPromotionInput,
): GateOwnerBriefStagingRelation {
  const sameSha = (a: string, b: string): boolean => a === b || a.startsWith(b) || b.startsWith(a);
  if (!input.mainPin || !input.stagingHead) return 'unknown';
  if (sameSha(input.mainPin, input.stagingHead)) return 'equal';
  if (input.stagingContainsMainPin === true) return 'ahead-after-absorption';
  if (input.mainContainsJudgedSha === true && input.stagingContainsJudgedSha === false) {
    return 'absorption-pending';
  }
  if (input.stagingContainsMainPin === false && input.stagingContainsJudgedSha !== null) {
    return 'diverged';
  }
  return 'unknown';
}

export interface GateOwnerBrief {
  /** The composed verdict — the one word the owner asked for. */
  answer: GateOwnerBriefAnswer;
  assessment: GateOwnerBriefAssessment;
  /** Is the gate green about what it last judged? null = counters unmeasured. */
  mainGreen: { value: boolean | null; vintage: GateOwnerBriefVintage };
  /**
   * D-013: exact judged-SHA promotion and the staging buffer are orthogonal axes.
   * `mainContainsJudgedSha` alone controls `green-not-promoted`; the staging relation
   * remains visible even when ordinary commits have accumulated after absorption.
   */
  promotion: {
    judgedSha: string | null;
    mainPin: string | null;
    mainContainsJudgedSha: boolean | null;
    vintage: GateOwnerBriefVintage;
    staging: {
      headSha: string | null;
      bufferPresent: boolean | null;
      relation: GateOwnerBriefStagingRelation;
      vintage: GateOwnerBriefVintage;
    };
  };
  /** Present exactly when the answer is a red/unknown family member with named legs. */
  whyNot: {
    failingLegs: string[];
    /** True only when a real verdict measured `failingLegs`; false/null = carried or unstamped. */
    measured: boolean | null;
    /**
     * P-005 / D-002: WHICH of the four measurement states `failingLegs` is in. `measured`
     * alone cannot say — `carried` and `unknown` are both `null` on it — so a reader could
     * only tell them apart by inspecting the list's emptiness, which is the exact
     * inference-from-silence this plan exists to end.
     */
    provenance: GateFailingTestsProvenance;
    /**
     * P-007: the NON-TEST legs (lint / perf / desktop / delta) that are red with no landed
     * fix, by id. `failingLegs` above names TEST FILES only, so a gate red on a lint leg
     * alone used to compose `failingLegs: []` beside a red answer — a red explained by
     * nothing, which reads as "nothing is actually failing". Paired with
     * `nonTestLegsMeasured` (P-012): `not-recorded` means no leg was looked at, and an
     * empty list beside it is NOT "no legs failing".
     */
    failingNonTestLegs: string[];
    nonTestLegsMeasured: 'measured' | 'not-recorded' | null;
    inconclusiveStatus: string | null;
    vintage: GateOwnerBriefVintage;
  } | null;
  ownership: {
    claimState: string | null;
    holder: string | null;
    workItem: string | null;
    /** The branchable liveness reading — `held-live` etc. — from the ownership oracle. */
    assessmentCode: string | null;
    vintage: GateOwnerBriefVintage;
  };
  /** Present when a frozen repair queue exists — the "is anyone actually fixing it" leg. */
  remediation: {
    frozenCandidate: string | null;
    repairHead: string | null;
    phase: string | null;
    frozenSinceAtMs: number | null;
    admissions: readonly FrozenRepairAdmission[];
    admissionsMeasured: boolean;
    signature: ReadonlyArray<RepairSignatureEntry & { status: GateOwnerBriefRepairStatus }>;
    signatureMeasured: boolean;
    legs: ReadonlyArray<FrozenRepairLegState & { status: GateOwnerBriefRepairStatus }>;
    legsMeasured: boolean;
    blockedReason: FrozenCandidateBlockedReason | null;
    blockedReasonMeasured: boolean;
    verdictProvenance: {
      frozenCandidate: string;
      repairHead: string;
      phase: string;
      frozenCandidateVerdict: 'not-judged' | 'full-gate-red';
      repairHeadVerdict:
        | 'not-judged'
        | 'same-as-frozen-full-gate-red'
        | 'full-gate-red'
        | 'isolated-repair-green';
    } | null;
    attempts: number | null;
    fixerSpawnId: string | null;
    /** null = liveness unmeasurable; false = a dispatched fixer is DEAD (the 5h-gap case). */
    fixerAlive: boolean | null;
    zeroAttemptStalled: boolean | null;
    queueAgeMs: number | null;
    vintage: GateOwnerBriefVintage;
  } | null;
  lastGreen: { atMs: number | null; ageMs: number | null };
  /**
   * Worst-case spread (ms) between the newest and oldest stamped legs — the
   * conflicting-reports detector: a large spread means this answer mixes observations
   * from different moments, which is exactly how two honest reads diverge.
   *
   * P-010: now READ FROM `attestations.spreadMs` rather than computed a second time, so
   * the number and the per-leg breakdown that explains it cannot drift apart.
   */
  vintageSpreadMs: number | null;
  /**
   * P-010 — per-leg measurement freshness, and the spread as a VERDICT.
   *
   * `vintageSpreadMs` above says the legs disagree about when; this says WHICH ONE IS OLD
   * (`staleLegs`, `oldestLeg`) and whether the disagreement is large enough to matter
   * (`verdict`). Always present — an empty `legs` with `verdict: 'not-knowable'` is the
   * honest answer when nothing was stamped, never an absent field.
   */
  attestations: GateOwnerBriefAttestations;
  /** Legs that could not be read, named — so absence is never silent. */
  unknownLegs: Array<{ leg: string; why: string }>;
}

/** Everything the composer needs — all values the position resolver already holds. */
export interface GateOwnerBriefInput {
  nowMs: number;
  consecutiveReds: number | null | undefined;
  failingTests: string[] | null | undefined;
  failingTestsMeasured: boolean | null | undefined;
  /** P-005: {@link GateFailingTestsProvenance} for the list above; absent on old fixtures. */
  failingTestsProvenance?: GateFailingTestsProvenance | null | undefined;
  /**
   * P-005: has `main` fast-forwarded to the green pin? `true` = a promotion buffer exists,
   * which splits `green` into `green-not-promoted`. `null` = UNMEASURABLE, which never
   * flips the headline (an unknown promotion state is not a reason to call a green gate
   * un-promoted) but is named in `unknownLegs` rather than passing silently as `false`.
   */
  mainBehindStaging?: boolean | null | undefined;
  /**
   * D-013's exact promotion operands. Optional only for pre-P-011 fixtures/readers; an
   * omitted value remains UNKNOWN and can never be reconstructed from mainBehindStaging.
   */
  promotion?: GateOwnerBriefPromotionInput | null | undefined;
  lastGreenAtMs: number | null | undefined;
  verdictObservedAtMs: number | null | undefined;
  fireStale: boolean | null | undefined;
  verdictStale: boolean | null | undefined;
  inconclusive: { status: string; detail: string | null; observedAtMs: number | null } | null | undefined;
  repairQueue:
    | {
        frozenCandidate?: string | null;
        candidate?: string | null;
        repairHead?: string | null;
        phase: string;
        openedAtMs?: number | null;
        admissions?: readonly FrozenRepairAdmission[];
        signature?: readonly RepairSignatureEntry[];
        legs?: readonly FrozenRepairLegState[];
        blockedReason?: FrozenCandidateBlockedReason | null;
        verdictProvenance?: NonNullable<GateOwnerBrief['remediation']>['verdictProvenance'];
        attempts: number;
        updatedAtMs: number;
        ageMs: number;
        fixerSpawnId: string | null;
        fixerAlive: boolean | null;
        zeroAttemptStalled: boolean;
      }
    | null
    | undefined;
  ownership: Pick<CellOwnership, 'claimState' | 'takenBy' | 'workItem' | 'assessment'> | null | undefined;
  /**
   * main-green-status-visible-2026-09-03 P-007: the NAMED non-test legs (lint / perf /
   * desktop / delta), from `gate.candidateFailures.nonTestLegs` — `outstanding` is the
   * ids that are red with no landed fix, by that module's one rule. `measured` is the
   * P-012 measured-ness flag: `not-recorded` means no leg was looked at, which is NOT an
   * empty outstanding list. Absent on old fixtures / when no repair queue is open.
   *
   * Why the brief needs it: `failingTests` names TEST FILES, so a gate red on a lint leg
   * alone composed a whyNot with `failingLegs: []` — a red answer explained by nothing,
   * which a reader rounds to "nothing is actually failing". The brief must never read
   * all-clear while a leg is red, and must name the leg.
   */
  nonTestLegs?: { measured: 'measured' | 'not-recorded'; outstanding: readonly string[] } | null | undefined;
}

const vintage = (observedAtMs: number | null | undefined, source: string, nowMs: number): GateOwnerBriefVintage => ({
  observedAtMs: observedAtMs ?? null,
  ageMs: observedAtMs != null ? Math.max(0, nowMs - observedAtMs) : null,
  source,
});

/**
 * The ownership-oracle codes that mean "a POSITIVELY live session holds this incident".
 *
 * ⚠ `held-needs-confirmation` is deliberately NOT here, and putting it back re-creates
 * EI-22123840107491540. The ownership oracle's own vocabulary is explicit that the code
 * means "not a live holder and not a dead one" (`assessGateOwnership`: `draining` /
 * `suspect` / unread), and `gate-ownership.ts` acts on it accordingly —
 * `POSITIVELY_LIVE` marks both ambiguous states `false`, so `shouldStandDownForLivePeer`
 * already FAILS OPEN for them. Counting the same code as a live hold HERE made the two
 * modules contradict each other, and only this one could be read as "someone is on it":
 * a gate whose holder went `suspect` could never reach {@link OWNED_UNCONFIRMED_CODES}'
 * stranded answer, so it read as owned-and-remediating (or owned-and-stalled, whose
 * safeAction ends at "tell the holder / escalate") no matter how long nobody moved.
 * Measured cost: a gate red 89 consecutive runs / ~12 days behind a holder that had not
 * taken a turn in 5h11m and had never dispatched a fixer.
 */
const OWNED_LIVE_CODES = new Set(['held-live']);

/**
 * The ownership-oracle codes that mean "a claim exists but its holder's liveness is
 * AMBIGUOUS" — held, and neither confirmed alive nor confirmed dead.
 *
 * Separate from {@link OWNED_LIVE_CODES} because the two need different answers when
 * remediation is not progressing: a live holder gets `red-owned-stalled` (coordinate
 * with them — they can still act), an unconfirmed one gets `red-owned-unconfirmed`
 * (the hold cannot be assumed to protect anything, so the answer must terminate in a
 * reclaim rather than in another wake nobody will absorb).
 */
const OWNED_UNCONFIRMED_CODES = new Set(['held-needs-confirmation']);

export function composeGateOwnerBrief(inp: GateOwnerBriefInput): GateOwnerBrief {
  const unknownLegs: Array<{ leg: string; why: string }> = [];

  const verdictVintage = vintage(
    inp.verdictObservedAtMs,
    'gate_health snapshot (green-checkpoint routine metadata)',
    inp.nowMs,
  );
  const ownershipVintage = vintage(inp.nowMs, 'readGateOwnership() — resolved live at this read', inp.nowMs);
  const remediationVintage = vintage(
    inp.repairQueue?.updatedAtMs ?? null,
    'frozen-repair-queue diagnostic (incl. live fixer-spawn liveness)',
    inp.nowMs,
  );
  const promotionVintage = vintage(
    inp.verdictObservedAtMs,
    'gate_health promotion identity (observedCandidate + lastMainPin)',
    inp.nowMs,
  );
  const stagingVintage = vintage(inp.nowMs, 'devDeployState staging ancestry — resolved live at this read', inp.nowMs);

  const promotionInput: GateOwnerBriefPromotionInput =
    inp.promotion ?? {
      judgedSha: null,
      mainPin: null,
      mainContainsJudgedSha: null,
      stagingHead: null,
      stagingContainsMainPin: null,
      stagingContainsJudgedSha: null,
      // Compatibility only: this preserves the ordinary buffer reading for old callers,
      // but it is never used to derive exact promotion or a staging relation.
      stagingBufferPresent: inp.mainBehindStaging ?? null,
    };
  const stagingRelation = classifyGateOwnerBriefStagingRelation(promotionInput);

  const reds = inp.consecutiveReds ?? null;
  if (reds === null) {
    unknownLegs.push({ leg: 'verdict', why: 'consecutiveReds was not measured on the gate_health snapshot' });
  }
  if (inp.ownership == null) {
    unknownLegs.push({ leg: 'ownership', why: 'the ownership oracle returned nothing for this read' });
  }
  if (inp.repairQueue != null && inp.repairQueue.fixerAlive === null) {
    unknownLegs.push({ leg: 'remediation.fixerAlive', why: 'fixer-spawn liveness was unmeasurable on this read' });
  }
  if (promotionInput.mainContainsJudgedSha == null) {
    unknownLegs.push({
      leg: 'promotion.mainContainsJudgedSha',
      why: 'the writer-owned main pin and judged sha could not be compared on this read',
    });
  }
  if (promotionInput.stagingBufferPresent == null) {
    unknownLegs.push({
      leg: 'promotion.staging.bufferPresent',
      why: 'whether staging has an uncheckpointed buffer was unmeasurable on this read',
    });
  }
  if (stagingRelation === 'unknown') {
    unknownLegs.push({
      leg: 'promotion.staging.relation',
      why: 'staging could not be related to the writer-owned main pin and judged sha on this read',
    });
  }
  if (inp.repairQueue != null) {
    if (!(inp.repairQueue.frozenCandidate ?? inp.repairQueue.candidate)) {
      unknownLegs.push({ leg: 'remediation.frozenCandidate', why: 'the repair diagnostic omitted its immutable candidate' });
    }
    if (!inp.repairQueue.repairHead) {
      unknownLegs.push({ leg: 'remediation.repairHead', why: 'the repair diagnostic omitted its mutable repair head' });
    }
    if (inp.repairQueue.openedAtMs == null) {
      unknownLegs.push({ leg: 'remediation.frozenSinceAtMs', why: 'the repair diagnostic omitted when the freeze opened' });
    }
    if (inp.repairQueue.admissions === undefined) {
      unknownLegs.push({ leg: 'remediation.admissions', why: 'the repair diagnostic omitted the admission ledger' });
    }
    if (inp.repairQueue.signature === undefined) {
      unknownLegs.push({ leg: 'remediation.signature', why: 'the repair diagnostic omitted the typed failure signature' });
    }
    if (inp.repairQueue.legs === undefined) {
      unknownLegs.push({ leg: 'remediation.legs', why: 'the repair diagnostic omitted per-leg lifecycle state' });
    }
    if (inp.repairQueue.blockedReason === undefined) {
      unknownLegs.push({ leg: 'remediation.blockedReason', why: 'the repair diagnostic omitted blocked-state measurement' });
    }
  }

  // `assessment` is the ownership oracle's closed string union (GateOwnershipAssessment).
  const ownershipCode = inp.ownership?.assessment ?? null;
  const ownedLive = ownershipCode !== null && OWNED_LIVE_CODES.has(ownershipCode);
  const ownedUnconfirmed = ownershipCode !== null && OWNED_UNCONFIRMED_CODES.has(ownershipCode);

  // "Remediation is not visibly progressing" — one predicate, so the live and the
  // unconfirmed answers can never disagree about what stalled means.
  const remediationStalled =
    inp.repairQueue != null &&
    (inp.repairQueue.fixerAlive === false || inp.repairQueue.zeroAttemptStalled) &&
    inp.repairQueue.fixerAlive !== true;

  // P-007: a red non-test leg is a red, full stop. If the verdict counter says zero reds
  // while a leg is measured red, the two legs of this brief CONTRADICT each other — and
  // the safe reading of a contradiction is `unknown`, never the green half of it. Named
  // in `unknownLegs` so the reader sees which instrument to distrust.
  const outstandingNonTestLegs = inp.nonTestLegs?.outstanding ?? [];
  const legContradictsGreen = reds === 0 && outstandingNonTestLegs.length > 0;
  if (legContradictsGreen) {
    unknownLegs.push({
      leg: 'verdict',
      why: `consecutiveReds is 0 but non-test leg(s) ${outstandingNonTestLegs.join(', ')} are measured red — the legs disagree, so no green is reported off the counter`,
    });
  }

  const red = (reds ?? 0) > 0 || inp.inconclusive != null;
  const green = reds === 0 && !inp.verdictStale && inp.inconclusive == null && !legContradictsGreen;

  // P-005: `red` above is true whenever a hold is open, EVEN AT ZERO REDS — so a gate that
  // never rendered a verdict used to be answered as a red with an owner. Nothing was judged
  // red here; the gate was prevented from judging. Separate the two.
  const noVerdict = reds === 0 && inp.inconclusive != null;

  // P-005: the green family splits on whether `main` actually moved. Only a POSITIVE
  // `true` splits it — `null` (unmeasurable) must not manufacture a promotion claim in
  // either direction, so it stays `green` and is named in `unknownLegs` below instead.
  const greenAnswer: GateOwnerBriefAnswer =
    promotionInput.mainContainsJudgedSha === false ? 'green-not-promoted' : 'green';
  const failingTestsProvenance: GateFailingTestsProvenance =
    inp.failingTestsProvenance ??
    (inp.failingTestsMeasured === true
      ? 'measured'
      : inp.failingTestsMeasured === false
        ? 'not-measured'
        : 'unknown');

  let answer: GateOwnerBriefAnswer;
  if (inp.fireStale) {
    answer = 'not-judging';
  } else if (reds === null || legContradictsGreen) {
    answer = 'unknown';
  } else if (green) {
    answer = greenAnswer;
  } else if (noVerdict) {
    answer = 'no-verdict';
  } else if (!red) {
    // reds === 0 but the verdict is stale: judged state is green, subject may have moved.
    answer = greenAnswer;
  } else if (!ownedLive && !ownedUnconfirmed) {
    answer = 'red-unowned';
  } else if (ownedUnconfirmed && remediationStalled) {
    // An ambiguous holder AND nothing remediating: the stranded shape. An ambiguous
    // holder with a LIVE fixer is genuinely being worked, so it falls through to
    // `red-owned-remediating` — the new code stays narrowly reachable on purpose.
    answer = 'red-owned-unconfirmed';
  } else if (remediationStalled) {
    answer = 'red-owned-stalled';
  } else {
    answer = 'red-owned-remediating';
  }

  const ASSESSMENTS: Record<GateOwnerBriefAnswer, Omit<GateOwnerBriefAssessment, 'code'>> = {
    green: {
      meaning:
        'The gate is green about what it last judged. Read promotion for the exact judged-SHA/main relationship and the independent staging relation; an ordinary staging buffer does not make this not-promoted.',
      safeAction:
        'Proceed on the green verdict. If unknownLegs names promotion.mainContainsJudgedSha, do not claim the judged SHA reached main until that exact ancestry read succeeds.',
    },
    'green-not-promoted': {
      meaning:
        'The gate is green about its last judged SHA, but exact ancestry says that SHA did not reach the writer-owned main pin. This is independent of whether staging has an ordinary buffer.',
      safeAction:
        'Resume the frozen-lineage promotion/absorption transaction after checking gate.greenCheckpoint.retriage; do not substitute a fresh staging-tip verdict or fast-forward main by hand.',
    },
    'red-owned-remediating': {
      meaning: 'The gate is red, a LIVE session owns the incident, and remediation shows signs of life.',
      safeAction:
        'Do not open a second lane and do not re-derive status by hand — quote THIS read (it is vintage-stamped) and coordinate with the holder for anything that must move.',
    },
    'red-owned-stalled': {
      meaning:
        'The gate is red and owned by a POSITIVELY LIVE holder, but the dispatched fixer is dead or the queue shows zero-attempt stall — remediation is NOT visibly progressing. This is the shape that once idled ~5h before a human noticed.',
      safeAction:
        'Tell the holder their fixer is dead (coord:send with this read attached). If the holder does not respond, escalate — a dead fixer never resumes by itself.',
    },
    'red-owned-unconfirmed': {
      meaning:
        "The gate is red, a claim exists, and remediation is NOT visibly progressing — but the holder's liveness is AMBIGUOUS (draining/suspect/unread), so the claim is not evidence anyone is working it. The hold is stranded until proven otherwise.",
      safeAction:
        'Send ONE required wake to the holder, then STOP waiting on it: a missed wake is not proof of death, but it is also not a reason to keep the whole fleet blocked. If no turn follows and remediation.fixerSpawnId is still null (nobody was ever dispatched), treat the hold as stranded — reclaim the incident and work it. Waiting is not the safe action here; the coordination rail already fails open for this liveness verdict.',
    },
    'red-unowned': {
      meaning: 'The gate is red and NO live session owns the incident — the every-agent-waits / 37-agent-pileup shape.',
      safeAction:
        'Read gate.greenCheckpoint.ownership and claim the incident (or wake whoever should) — an unowned red is everyone\'s blocker and no one\'s work.',
    },
    'no-verdict': {
      meaning:
        'The latest gate attempt rendered no verdict: an inconclusive hold stopped judgment, so zero new reds is NOT evidence of green.',
      safeAction:
        'Clear the condition named by whyNot.inconclusiveStatus, then run the gate again; do not chase carried failingLegs as though this attempt measured them.',
    },
    'not-judging': {
      meaning: 'The gate has not fired within its interval — nothing is being judged, so red/green counters describe the past.',
      safeAction: 'Recover the green-checkpoint producer first; do not act on the counters beside this answer.',
    },
    unknown: {
      meaning: 'The verdict counters were not measured on this read — this answer says NOTHING about gate health.',
      safeAction: 'Treat gate state as unknown; read unknownLegs for what was missing and retry or escalate the instrument.',
    },
  };

  // P-010. Composed from the SAME vintage objects the legs below carry, so an attestation
  // and the value it stamps cannot disagree — the same one-derivation rule that governs the
  // whole composer. `whyNot`'s own vintage falls back to the verdict's when the inconclusive
  // record is unstamped, so only the stamped case earns a `whyNot` attestation; that is
  // exactly the set `vintageSpreadMs` has always been computed over.
  const attestations = composeAttestations(
    [
      { leg: 'mainGreen', vintage: verdictVintage },
      { leg: 'ownership', vintage: ownershipVintage },
      ...(inp.promotion != null
        ? [
            { leg: 'promotion', vintage: promotionVintage },
            { leg: 'promotion.staging', vintage: stagingVintage },
          ]
        : []),
      ...(inp.repairQueue != null ? [{ leg: 'remediation', vintage: remediationVintage }] : []),
      ...(inp.inconclusive?.observedAtMs != null
        ? [{ leg: 'whyNot', vintage: vintage(inp.inconclusive.observedAtMs, 'gate inconclusive record', inp.nowMs) }]
        : []),
    ],
    inp.nowMs,
  );

  return {
    answer,
    assessment: { code: answer, ...ASSESSMENTS[answer] },
    mainGreen: {
      // P-007: a counter contradicted by a red leg answers `null`, never the counter's half.
      value: reds === null || noVerdict || legContradictsGreen ? null : green || !red,
      vintage: verdictVintage,
    },
    promotion: {
      judgedSha: promotionInput.judgedSha,
      mainPin: promotionInput.mainPin,
      mainContainsJudgedSha: promotionInput.mainContainsJudgedSha,
      vintage: promotionVintage,
      staging: {
        headSha: promotionInput.stagingHead,
        bufferPresent: promotionInput.stagingBufferPresent,
        relation: stagingRelation,
        vintage: stagingVintage,
      },
    },
    whyNot:
      answer === 'green' || answer === 'green-not-promoted'
        ? null
        : {
            failingLegs: inp.failingTests ?? [],
            measured: inp.failingTestsMeasured ?? null,
            provenance: failingTestsProvenance,
            // P-007: the non-test legs, NAMED, beside the test files — so an empty
            // `failingLegs` next to a red answer is explained rather than read as "nothing".
            failingNonTestLegs: [...outstandingNonTestLegs],
            nonTestLegsMeasured: inp.nonTestLegs?.measured ?? null,
            inconclusiveStatus: inp.inconclusive?.status ?? null,
            vintage:
              inp.inconclusive?.observedAtMs != null
                ? vintage(inp.inconclusive.observedAtMs, 'gate inconclusive record', inp.nowMs)
                : verdictVintage,
          },
    ownership: {
      claimState: inp.ownership?.claimState ?? null,
      holder: inp.ownership?.takenBy ?? null,
      workItem: inp.ownership?.workItem ?? null,
      assessmentCode: ownershipCode,
      vintage: ownershipVintage,
    },
    remediation:
      inp.repairQueue == null
        ? null
        : {
            frozenCandidate: inp.repairQueue.frozenCandidate ?? inp.repairQueue.candidate ?? null,
            repairHead: inp.repairQueue.repairHead ?? null,
            phase: inp.repairQueue.phase,
            frozenSinceAtMs: inp.repairQueue.openedAtMs ?? null,
            admissions: [...(inp.repairQueue.admissions ?? [])],
            admissionsMeasured: inp.repairQueue.admissions !== undefined,
            signature: (inp.repairQueue.signature ?? []).map((entry) => ({
              ...entry,
              status:
                entry.admittedRound <= 1
                  ? 'red-at-candidate'
                  : (`admitted-in-${entry.admittedRound}` as const),
            })),
            signatureMeasured: inp.repairQueue.signature !== undefined,
            legs: (inp.repairQueue.legs ?? []).map((leg) => ({
              ...leg,
              status:
                leg.state === 'fixed'
                  ? (`green-at-${leg.resolvedHead ?? leg.lastMeasuredHead}` as const)
                  : leg.admittedRound <= 1
                    ? 'red-at-candidate'
                    : (`admitted-in-${leg.admittedRound}` as const),
            })),
            legsMeasured: inp.repairQueue.legs !== undefined,
            blockedReason: inp.repairQueue.blockedReason ?? null,
            blockedReasonMeasured: inp.repairQueue.blockedReason !== undefined,
            verdictProvenance: inp.repairQueue.verdictProvenance ?? null,
            attempts: inp.repairQueue.attempts,
            fixerSpawnId: inp.repairQueue.fixerSpawnId,
            fixerAlive: inp.repairQueue.fixerAlive,
            zeroAttemptStalled: inp.repairQueue.zeroAttemptStalled,
            queueAgeMs: inp.repairQueue.ageMs,
            vintage: remediationVintage,
          },
    lastGreen: {
      atMs: inp.lastGreenAtMs ?? null,
      ageMs: inp.lastGreenAtMs != null ? Math.max(0, inp.nowMs - inp.lastGreenAtMs) : null,
    },
    // P-010: read from the attestation roll-up rather than recomputed, so the headline
    // number and the per-leg breakdown that explains it are one derivation.
    vintageSpreadMs: attestations.spreadMs,
    attestations,
    unknownLegs,
  };
}

/**
 * PURE (P-010): turn the composed leg vintages into per-leg attestations plus an assessed
 * spread. Split out so the bands are exercisable directly, and so the composer above reads
 * as one statement rather than fifteen lines of arithmetic.
 *
 * ⚠ Only STAMPED legs enter. An unstamped observation cannot attest to its own freshness,
 * and admitting one with `stale: null` would let a leg nobody can date silently widen or
 * narrow the spread — the "measured empty renders as nothing failing" defect, one axis over.
 */
function composeAttestations(
  legs: ReadonlyArray<{ leg: string; vintage: GateOwnerBriefVintage }>,
  nowMs: number,
): GateOwnerBriefAttestations {
  const stamped = legs
    .filter((l) => l.vintage.observedAtMs != null)
    .map(({ leg, vintage: v }) => ({
      leg,
      observedAtMs: v.observedAtMs,
      ageMs: v.ageMs,
      source: v.source,
      stale: v.ageMs != null ? v.ageMs > GATE_OWNER_BRIEF_LEG_STALE_MS : null,
    }))
    // Newest first: the reader's question is "how far back does this brief reach", and the
    // answer is the tail of this list.
    .sort((a, b) => (b.observedAtMs ?? 0) - (a.observedAtMs ?? 0));

  const times = stamped.map((a) => a.observedAtMs).filter((v): v is number => v != null);
  const spreadMs = times.length >= 2 ? Math.max(...times) - Math.min(...times) : null;
  const staleLegs = stamped.filter((a) => a.stale === true).map((a) => a.leg);
  const oldestLeg = stamped.length > 0 ? stamped[stamped.length - 1]!.leg : null;

  // `not-knowable` is NOT `coherent`. Fewer than two stamped legs means there is nothing to
  // compare, and reporting that as agreement is the same false-green shape as a zero
  // computed over an empty measurement.
  const verdict: GateOwnerBriefSpreadVerdict =
    spreadMs === null
      ? 'not-knowable'
      : spreadMs >= GATE_OWNER_BRIEF_SPREAD_INCOHERENT_MS
        ? 'incoherent'
        : spreadMs >= GATE_OWNER_BRIEF_SPREAD_COHERENT_MS
          ? 'mixed'
          : 'coherent';

  const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;
  const summary =
    verdict === 'not-knowable'
      ? `Freshness NOT KNOWABLE — ${stamped.length} stamped leg(s), so there is nothing to compare. This is not agreement.`
      : verdict === 'coherent'
        ? `Legs agree on when: spread ${mins(spreadMs!)}, every leg within one gate interval.`
        : `⚠ This brief MIXES observations ${mins(spreadMs!)} apart` +
          (verdict === 'incoherent'
            ? ' — at least one gate interval, so the legs cannot all describe the same run. '
            : '. ') +
          (staleLegs.length > 0
            ? `Stale leg(s): ${staleLegs.join(', ')}. Oldest is "${oldestLeg}" — do not quote it as current.`
            : `Oldest is "${oldestLeg}"; no single leg is past the staleness bound, but they were not observed together.`);

  return { legs: stamped, spreadMs, verdict, staleLegs, oldestLeg, summary };
}
