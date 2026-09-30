/**
 * Pure projection for release:trace.
 *
 * The release truth already exists, but it is split across git position, gate,
 * deploy, and event-await authorities.  This module joins their typed results
 * without inventing a second release state machine.
 */
import type { PipelinePosition } from './git-pipeline-position';
import type { DeployStatus } from './release-deploy-launch';
import {
  composeGateRedOwnership,
  projectGateRepairOwner,
  type GateRedOwnership,
} from './release/gate-red-ownership';
import { classifyReleaseParity } from './release-parity';
import {
  certifyCheckpointProgress,
  type ProgressBasis,
  type ProgressCertificate,
  type ProgressCertificateInput,
} from './release-trace-progress';

export interface ReleaseTraceGate {
  state: DeployStatus['state'];
  authoritative: boolean;
  consecutiveReds: number;
  failingTests: string[];
  /** True only when failingTests is a measurement for the requested candidate. */
  failingTestsMeasured?: boolean | null;
  /**
   * EI-18832825158594027: true when `failingTests` was INHERITED from an earlier observation of
   * this same candidate rather than produced by the tick behind the current verdict. Read it
   * before acting: a true here means re-verify at tip before editing anything, and it is NOT a
   * reason to re-fire the gate — re-firing to "refresh" this list is the expensive follow-on
   * mistake this marker exists to prevent.
   */
  failingTestsCarriedForward?: boolean | null;
  /** The writer's own verdict marker for the candidate named by observedCandidate. */
  recordedVerdict?: 'green' | 'not-green' | null;
  /**
   * When a frozen repair queue owns the exact candidate, these names are carried from the
   * prior gate-red blob. They are context for the queue, never failures produced by this
   * candidate, so they must not remain in `failingTests`.
   */
  inheritedRepairQueueFailingTests?: string[];
  inheritedRepairQueueFailingTestsSource?: 'prior-gate-verdict' | null;
  fireStale: boolean;
  fireStaleReason: string | null;
  verdictStale: boolean;
  verdictStaleReason: string | null;
  /**
   * The candidate the checkpoint verdict actually judged. This is independent of
   * GitHub/origin visibility: the green-checkpoint runs against the local
   * integration root, so a candidate can be gate-tested before the bridge publishes
   * it to origin/staging.
   */
  observedCandidate?: string | null;
  /**
   * The live checkpoint run, when measured. This is deliberately separate from
   * `observedCandidate`: that field names the last terminal verdict, while this
   * one names the candidate currently being judged by an in-flight run.
   */
  checkpointRunInFlight?: PipelinePosition['gate']['checkpointRunInFlight'];
  /**
   * The latest checkpoint attempt that rendered no verdict. This is needed when
   * a measured idle run-lock is paired with an external cancellation: there is
   * no producer left for a candidate-bound `checkpoint:await` to wake from.
   */
  inconclusive?: PipelinePosition['gate']['inconclusive'];
  /** EI-18672078222841101: who already owns this red (see `GateRedOwnership`). Optional so
   *  an unwired/legacy caller renders exactly as before. This is the surface that matters
   *  most: `release:trace` is what an agent reads when it decides whether to investigate,
   *  and on 2026-07-26 it told three agents about a red while saying nothing about the
   *  fixer already dispatched for it. */
  redOwner?: GateRedOwnership | null;
  /**
   * EI-21456558908416090: whether a recorded decision currently withholds manual
   * `release:checkpoint-run` authority. Optional so an unwired/legacy caller renders exactly
   * as before; when present and `withheld`, no checkpoint-run recommendation is issued.
   */
  manualRunAuthority?: ReleaseTraceManualRunAuthority | null;
}

export interface ReleaseTraceAwait {
  event: string;
  awaitId: number;
  subscriberId: string;
  state: 'registered' | 'fired' | 'expired' | 'cancelled';
  registeredAt: string;
  firedAt: string | null;
  firedReason: string | null;
  observedSha: string | null;
}

export interface ReleaseTraceWake {
  event: string;
  deliveryId: number;
  subscriberId: string;
  status: string;
  channel: string | null;
  createdAt: string;
  deliveredAt: string | null;
  observedSha: string | null;
}

export interface ReleaseTraceConstraint {
  code: string;
  blocking: boolean;
  summary: string;
}

export interface ReleaseTraceConsumedAuthority {
  /**
   * EI-21456558908416090: this was typed as the D-053 literal, which pinned the whole
   * suppression concept to one decision id. A governing ref is DATA — the next decision
   * that withholds this authority carries a different id, and a literal type guarantees
   * it falls through to the recommendation this field exists to stop.
   */
  governingRef: string;
  candidate: string;
  status: 'consumed';
  retryAllowed: false;
  reason: string;
}

/**
 * EI-21456558908416090 — manual `release:checkpoint-run` authority withheld by a recorded
 * decision, supplied as a typed INPUT so this module stays a pure projection.
 *
 * The distinction this exists to represent is one the pre-existing tokens could not draw.
 * `stable-candidate-related-gate-2026-08-23` D-061 deliberately RE-ARMED ordinary scheduled
 * gate fires while leaving every manual launch forbidden ("D-042's never-launch-a-duplicate
 * survives this decision intact, and a scheduled cron fire is not a manual launch"). The
 * scheduled-side admission token is therefore correctly clear, and the manual prohibition had
 * nowhere machine-readable to live — so `release:trace` kept recommending the one action the
 * active plan forbids. green-checkpoint.ts:2566 records that a manual fire inside a re-triage
 * window DISCARDS the auto-refire rescue and costs a ~55min suite, so the recommendation is
 * destructive, not merely disallowed.
 */
export interface ReleaseTraceManualRunAuthority {
  withheld: boolean;
  /** The recorded decision that withholds it, e.g. `<plan-slug>#D-061`. Never a code literal. */
  governingRef: string;
  /** Which live authority reported it, for a reader deciding where to go to lift it. */
  source?: 'manual-run-hold' | 'qualification-hold' | 'serializer-fence' | 'consumed-authority';
  reason: string;
}

export interface ReleaseTraceNextVerb {
  name: string;
  args?: Record<string, unknown>;
  reason: string;
}

export interface ReleaseTraceInput {
  position: PipelinePosition;
  deploy: DeployStatus;
  gate: ReleaseTraceGate;
  pipeline: string;
  inspectedKeys: string[];
  awaits: ReleaseTraceAwait[];
  wakes: ReleaseTraceWake[];
  snapshotGeneration: number;
  consumerGeneration?: number;
  requesterId?: string;
  workItem?: string;
  /**
   * P-005 / D-015: FLAGS.RELEASE_TRACE_PROGRESS_CERTIFICATE as the CALLER read it. This module
   * stays pure — the flag is resolved at the io seam (agent-tools/release/trace.ts) and handed in,
   * the same shape freeze-disposition.ts uses for the freeze switch.
   *
   * Undefined means ON, so a caller that has not been taught the flag keeps the shipped behaviour
   * rather than silently losing the certificate. `false` restores the plain checkpoint:await verb.
   * It gates STEERING only: the D-004 re-triage interlock in safeNextVerb reads the certificate
   * independently and is deliberately NOT gated (see progressGatedAwait / safeNextVerb).
   */
  progressCertificateEnabled?: boolean;
}

export interface ReleaseTraceCandidateVerdict {
  /** The verdict for the exact requested candidate, not the aggregate gate state. */
  state: 'green' | 'red' | 'inconclusive' | 'unknown';
  /** `null` is deliberate: the producer did not judge this candidate. */
  green: boolean | null;
  candidate: string | null;
  /** Normalized projection state (`inconclusive`, `green`, `red`, or `unknown`). */
  status: 'green' | 'red' | 'inconclusive' | 'unknown';
  /** Producer reason when the verdict is inconclusive, otherwise the explanatory reason. */
  reason: string | null;
  detail: string | null;
  observedAtMs: number | null;
  /**
   * The re-read addressed to the candidate that actually OWNS this verdict, present only
   * when `state` is `unknown` because the traced target is a different sha than the gate's
   * `observedCandidate`.
   *
   * Why this field exists rather than leaving the caller to construct it: a PATH trace
   * resolves `targetSha` to that path's own latest commit, so `classifyCandidateVerdict`
   * correctly declines to attribute the gate's verdict to it. Read without the candidate in
   * hand, that `unknown` looks like the gate failing to type its own state -- the exact
   * opacity class D-067 exists to close -- and it was misread that way by three separate
   * sessions of stable-candidate-related-gate-2026-08-23, producing two retracted findings
   * and a false ship blocker. `resync.nextVerb` does not help: it re-reads the SAME target,
   * which is the subject that produced the confusion. Handing back a handle already
   * addressed to the right subject is the same remedy `dev:pipeline_position` uses for its
   * per-path cells, and it makes the fail-closed rail self-correcting instead of alarming.
   */
  rereadForCandidate?: { name: 'release:trace'; args: { sha: string } } | null;
}

/**
 * The one branchable answer EI-19342701023112373 asks for: did the candidate that
 * produced the recorded gate verdict contain the caller's exact fix commit?
 *
 * This object intentionally contains NO action, gate-health prediction, or lever. A
 * containment verdict says only what ancestry proves; `release:trace.nextVerb` remains a
 * separate projection over the complete release state.
 */
export interface ReleaseTraceFixCommitContainment {
  fixSha: string | null;
  observedCandidate: string | null;
  verdict: 'contained' | 'not_contained' | 'unknown';
  reason:
    | 'target-unresolved'
    | 'observed-candidate-unavailable'
    | 'submodule-boundary'
    | 'ancestry-unreadable'
    | null;
}

function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function targetIsNotGreenPinned(position: PipelinePosition): boolean {
  // `positions.inMain` answers a different question: origin/main can contain a
  // newer or force-deployed commit than the last green pin. Only callers that omit
  // the new field entirely get the legacy fallback; an explicit null from the
  // resolver means the measurement failed and must fail closed.
  const measured = position.verdictProvenance.targetIncludedInGreenPin;
  return measured === undefined ? !position.positions.inMain : measured !== true;
}

function gateJudgedTarget(input: Pick<ReleaseTraceInput, 'position' | 'gate'>): boolean {
  // `position.gate` is the canonical projection for direct callers. The explicit
  // input field is preferred when the agent-tool wrapper supplies the same snapshot,
  // while the fallback keeps older callers safe during the field rollout.
  const observedCandidate = input.gate.observedCandidate ?? input.position.gate.observedCandidate;
  return sameSha(input.position.targetSha, observedCandidate);
}

function exactCandidateInconclusive(input: Pick<ReleaseTraceInput, 'position' | 'gate'>) {
  const inconclusive = input.gate.inconclusive ?? input.position.gate.inconclusive;
  return input.position.targetSha && sameSha(input.position.targetSha, inconclusive?.candidate) ? inconclusive : null;
}

/**
 * EI-21432980132792683 / EI-21433072117655298: a verdict the writer recorded FOR THE EXACT
 * requested candidate is immutable history about that SHA. Two later, unrelated events used to
 * erase it:
 *   - a repair reservation naming the same candidate (`gate.inconclusive`), and
 *   - the aggregate verdict going stale relative to newer staging (`gate.verdictStale`).
 *
 * Neither is a new judgement of this SHA. `inconclusive` is by its own contract "the latest
 * checkpoint attempt that rendered NO verdict", so it cannot supersede one that did; and
 * staleness means the historical verdict must not be applied to the CURRENT TIP -- which the
 * separate `gate-verdict-stale` constraint already says -- not that the candidate's own
 * terminal verdict may be rewritten. Rewriting it deletes the fail-closed branch a ratified
 * terminal red depends on (stable-candidate-related-gate-2026-08-23#D-059/#D-060), which is
 * how an already-terminal candidate was reported back as `inconclusive/repair-in-progress`
 * with `nextVerb: checkpoint:await` -- stranding readers on a verdict that will never arrive.
 *
 * Deliberately gated on BOTH an exact-SHA match and the explicit `recordedVerdict` marker,
 * never the `authoritative && consecutiveReds > 0` fallback below: `authoritative` goes false
 * precisely when the verdict goes stale, so that fallback cannot speak for a historical
 * candidate. A red recorded against a DIFFERENT `observedCandidate` is not this candidate's
 * verdict and still yields to an exact repair reservation.
 */
function exactCandidateRecordedTerminalVerdict(input: ReleaseTraceInput): ReleaseTraceCandidateVerdict | null {
  const targetSha = input.position.targetSha;
  const observedCandidate = input.gate.observedCandidate ?? input.position.gate.observedCandidate;
  if (!targetSha || !sameSha(targetSha, observedCandidate)) return null;
  const recorded = input.gate.recordedVerdict;
  if (recorded !== 'green' && recorded !== 'not-green') return null;
  const green = recorded === 'green';
  return {
    state: green ? 'green' : 'red',
    status: green ? 'green' : 'red',
    green,
    candidate: observedCandidate ?? targetSha,
    reason: null,
    detail: null,
    observedAtMs: null,
  };
}

/**
 * Project the verdict for the requested SHA without inheriting the global gate's older
 * counters. In particular, `gate_health.inconclusive` intentionally leaves a previous
 * red streak in place while the frozen repair queue progresses; that streak is not a
 * verdict about the repair candidate.
 */
function classifyCandidateVerdict(input: ReleaseTraceInput): ReleaseTraceCandidateVerdict {
  const targetSha = input.position.targetSha;
  // Immutable exact-candidate history outranks every later reservation and staleness signal.
  const recordedTerminal = exactCandidateRecordedTerminalVerdict(input);
  if (recordedTerminal) return recordedTerminal;
  const inconclusive = exactCandidateInconclusive(input);
  if (inconclusive) {
    return {
      state: 'inconclusive',
      status: 'inconclusive',
      green: null,
      candidate: inconclusive.candidate,
      reason: inconclusive.status,
      detail: inconclusive.detail,
      observedAtMs: inconclusive.observedAtMs,
    };
  }

  const observedCandidate = input.gate.observedCandidate ?? input.position.gate.observedCandidate;
  if (!targetSha || !sameSha(targetSha, observedCandidate)) {
    return {
      state: 'unknown',
      status: 'unknown',
      green: null,
      candidate: observedCandidate ?? null,
      // State WHOSE verdict it is and what to do about it. The bare "does not name this
      // exact candidate" wording read as a gate defect rather than as the exact-SHA rail
      // declining to misattribute a verdict, which is what it actually is.
      reason: !targetSha
        ? 'target-unresolved'
        : observedCandidate
          ? `the gate verdict belongs to candidate ${observedCandidate}, not the traced target ${targetSha.slice(0, 12)} — exact-SHA fail-closed behaviour, NOT an untyped or missing verdict; re-read via rereadForCandidate to see that candidate's own verdict`
          : 'the gate has recorded no observed candidate to compare this target against',
      detail: null,
      observedAtMs: null,
      rereadForCandidate:
        targetSha && observedCandidate ? { name: 'release:trace', args: { sha: observedCandidate } } : null,
    };
  }
  // EI-21440269420198423: `observedCandidate` names the last terminal verdict, while an
  // active exact-candidate run names the SHA currently being judged. Until that run's writer
  // records its own verdict, the aggregate red streak is historical context, not a verdict for
  // this candidate. Keep the candidate unknown so exact-SHA readers cannot branch on a fabricated
  // terminal red before the scheduled writer publishes the result.
  if (input.gate.recordedVerdict == null && gateIsActivelyJudgingTarget(input)) {
    return {
      state: 'unknown',
      status: 'unknown',
      green: null,
      candidate: observedCandidate,
      reason: 'the exact candidate is actively being judged by a checkpoint run without a recorded verdict',
      detail: null,
      observedAtMs: null,
    };
  }
  if (input.gate.verdictStale) {
    return {
      state: 'unknown',
      status: 'unknown',
      green: null,
      candidate: observedCandidate,
      reason: input.gate.verdictStaleReason ?? 'the recorded gate verdict is stale',
      detail: null,
      observedAtMs: null,
    };
  }

  // Newer writers state their own green-ness. Keep the red fallback for older callers that
  // supplied an exact observed candidate but predate the marker; a zero counter alone is not
  // enough to manufacture a green verdict.
  if (input.gate.recordedVerdict === 'green') {
    return {
      state: 'green',
      status: 'green',
      green: true,
      candidate: observedCandidate,
      reason: null,
      detail: null,
      observedAtMs: null,
    };
  }
  if (input.gate.recordedVerdict === 'not-green' || (input.gate.authoritative && input.gate.consecutiveReds > 0)) {
    return {
      state: 'red',
      status: 'red',
      green: false,
      candidate: observedCandidate,
      reason: null,
      detail: null,
      observedAtMs: null,
    };
  }
  return {
    state: 'unknown',
    status: 'unknown',
    green: null,
    candidate: observedCandidate,
    reason: 'the candidate verdict marker is unavailable',
    detail: null,
    observedAtMs: null,
  };
}

function gateIsActivelyJudgingTarget(input: Pick<ReleaseTraceInput, 'position' | 'gate'>): boolean {
  // Repair verification may deliberately judge a detached worktree commit before the
  // separate staging-containment/promotion step. In that state origin visibility cannot
  // outrank the live singleton: the exact SHA is already being tested.
  const checkpointRun = input.gate.checkpointRunInFlight ?? input.position.gate.checkpointRunInFlight;
  return checkpointRun?.active === true && sameSha(input.position.targetSha, checkpointRun.candidate);
}

/**
 * A frozen repair head in `ready-to-verify` is already the gate's next candidate, even though
 * it intentionally lives on `refs/papercusp/frozen/<candidate>` rather than origin/staging.
 * Return the exact head so the caller can bind its await to that SHA; a queue for another target
 * or another phase must not bypass the normal publication route.
 */
function frozenRepairHeadReadyToVerify(input: Pick<ReleaseTraceInput, 'position'>): string | null {
  const queue = input.position.gate.repairQueue;
  return queue?.phase === 'ready-to-verify' && sameSha(input.position.targetSha, queue.repairHead)
    ? queue.repairHead
    : null;
}

function classifyFixCommitContainment(
  input: Pick<ReleaseTraceInput, 'position' | 'gate'>,
): ReleaseTraceFixCommitContainment {
  const fixSha = input.position.targetSha;
  const observedCandidate = input.gate.observedCandidate ?? input.position.gate.observedCandidate;
  if (!fixSha) {
    return { fixSha: null, observedCandidate: observedCandidate ?? null, verdict: 'unknown', reason: 'target-unresolved' };
  }
  if (!observedCandidate) {
    return { fixSha, observedCandidate: null, verdict: 'unknown', reason: 'observed-candidate-unavailable' };
  }
  if (input.position.submodule) {
    return { fixSha, observedCandidate, verdict: 'unknown', reason: 'submodule-boundary' };
  }

  const contained = input.position.verdictProvenance.targetIncludedInObservedCandidate;
  if (contained === true) return { fixSha, observedCandidate, verdict: 'contained', reason: null };
  if (contained === false) return { fixSha, observedCandidate, verdict: 'not_contained', reason: null };
  return { fixSha, observedCandidate, verdict: 'unknown', reason: 'ancestry-unreadable' };
}

/** EI-210996: recognize a producer death from evidence written by systemd, not by the
 * checkpoint process that may have been SIGKILLed. Candidate matching prevents a stale
 * finished-unit log from contaminating a newer exact-SHA trace. */
function checkpointRunTerminalInconclusive(input: Pick<ReleaseTraceInput, 'position' | 'gate'>) {
  const checkpointRun = input.gate.checkpointRunInFlight ?? input.position.gate.checkpointRunInFlight;
  const evidence = checkpointRun?.terminalEvidence;
  return checkpointRun?.active === false && checkpointRun.terminalMarker === false && evidence?.abnormal === true &&
    sameSha(input.position.targetSha, evidence.candidate)
    ? evidence
    : null;
}

/** EI-21103060581352507: a cancelled checkpoint has no future verdict to wake an
 * awaiter once the live run-lock has measured that its producer is gone. Keep the
 * guard exact-SHA and fail closed on the lock reading: an absent/unmeasured run
 * must not be mistaken for a terminal cancellation of the requested candidate. */
function checkpointRunCancelledNoProducer(input: Pick<ReleaseTraceInput, 'position' | 'gate'>) {
  const checkpointRun = input.gate.checkpointRunInFlight ?? input.position.gate.checkpointRunInFlight;
  const inconclusive = input.gate.inconclusive ?? input.position.gate.inconclusive;
  return checkpointRun?.active === false &&
    checkpointRun.activeSource === 'run-lock' &&
    inconclusive?.status === 'cancelled' &&
    sameSha(input.position.targetSha, inconclusive.candidate)
    ? inconclusive
    : null;
}

/**
 * D-053 authorizes one post-D-052 checkpoint only. An exact-candidate abnormal
 * terminal is therefore a consumed authority, even when systemd recorded a
 * terminal marker: the marker proves that the process ended, not that it
 * published an authoritative exact-candidate verdict.
 */
function checkpointAuthorityConsumed(input: Pick<ReleaseTraceInput, 'position' | 'gate'>): ReleaseTraceConsumedAuthority | null {
  const checkpointRun = input.gate.checkpointRunInFlight ?? input.position.gate.checkpointRunInFlight;
  const evidence = checkpointRun?.terminalEvidence;
  const targetSha = input.position.targetSha;
  if (checkpointRun?.active !== false || evidence?.abnormal !== true || !targetSha || !sameSha(targetSha, evidence.candidate)) {
    return null;
  }

  return {
    governingRef: 'stable-candidate-related-gate-2026-08-23#D-053',
    candidate: evidence.candidate ?? targetSha,
    status: 'consumed',
    retryAllowed: false,
    reason:
      `The exact candidate ended abnormally (${evidence.serviceResult}/${evidence.exitCode}:${evidence.exitStatus}) ` +
      'without an authoritative exact-candidate verdict; D-053 consumes its one-shot checkpoint authority. ' +
      'A retry requires another recorded decision.',
  };
}

/**
 * EI-21456558908416090 — the ONE predicate for "may this trace recommend a manual
 * `release:checkpoint-run`?".
 *
 * Deliberately a generalization rather than a second special case. The prior code expressed
 * exactly one way authority can be withheld (the D-053 abnormal-terminal case) and pinned it to
 * that decision's id, so EVERY later decision fell through and the forbidden recommendation was
 * re-issued — the same shape as EI-21411776375901170, one decision later. Both the in-module
 * consumed authority and any live authority the caller measured now answer through here, so a
 * new source of withholding is a new INPUT, never a new branch at each recommendation site.
 */
function manualCheckpointRunWithheld(
  input: Pick<ReleaseTraceInput, 'position' | 'gate'>,
): ReleaseTraceManualRunAuthority | null {
  const consumed = checkpointAuthorityConsumed(input);
  if (consumed) {
    return {
      withheld: true,
      governingRef: consumed.governingRef,
      source: 'consumed-authority',
      reason: consumed.reason,
    };
  }
  const declared = input.gate.manualRunAuthority;
  if (declared?.withheld === true && typeof declared.governingRef === 'string' && declared.governingRef.trim() !== '') {
    return declared;
  }
  return null;
}

/**
 * Compose the canonical gate owner WITH the historical release-fixer record.
 *
 * `gate.redOwner` comes from `last_fixer`, which is useful lineage for the
 * fixer-dispatch dedupe but can outlive that fixer.  The gate singleton and the
 * live run lock are the current execution authorities: when either says a live
 * red is already being handled, an obsolete fixer must not make this trace tell
 * every reader to claim the red again.
 *
 * ⚠ P-008 — this used to SUBSTITUTE, and that was the remaining half of the bug.
 * It returned a synthetic `{ state:'owned-live', spawnId:null, ageMs:null }`, so a
 * reader who learned "someone is on it" simultaneously lost "and the dispatched
 * fixer is dead" — the actionable half, since a dead fixer beside a live holder is
 * one that needs re-dispatching. It also fired ONLY on a positively-live holder, so
 * a held claim whose holder read draining/suspect/unmeasured fell through to a BARE
 * `owner-gone` naming no holder at all. Both are now decided by the one pure
 * composer in `gate-red-ownership.ts`, which every gate-red surface calls, so this
 * trace and the gate-red alert cannot render contradictory truth about one red.
 */
function canonicalRedOwner(input: ReleaseTraceInput): GateRedOwnership | null {
  const fixer = input.gate.redOwner ?? null;
  if (!fixer || input.gate.consecutiveReds <= 0) return null;

  const checkpointRun = input.position.gate.checkpointRunInFlight;
  const checkpointRunLive =
    checkpointRun?.active === true &&
    (checkpointRun.activeSource === 'run-lock' || checkpointRun.activeSource === 'process-authority');
  const executorText =
    checkpointRun?.activeSource === 'process-authority'
      ? 'the gate-authorized checkpoint process is live in its cgroup before candidate publication'
      : 'the live checkpoint run-lock is held by the canonical gate executor';

  return composeGateRedOwnership({
    fixer,
    repairOwner: projectGateRepairOwner(input.position.gate.ownership, Date.now()),
    // Independent of the fixer record's own staleness leg — see the composer's
    // `verdictStale` doc for why the caller's verdict also suppresses promotion.
    verdictStale: input.gate.verdictStale === true,
    executorCover: checkpointRunLive
      ? {
          label:
            `OWNED — ${executorText}; checkpoint run is active${
              checkpointRun?.candidate ? ` on ${checkpointRun.candidate}` : ''
            }. Do NOT start a parallel diagnosis; await the canonical gate owner’s verdict via ` +
            'checkpoint:await and re-read release:trace.',
        }
      : null,
  });
}

export function classifyReleaseWake(
  targetSha: string | null,
  wakes: ReleaseTraceWake[],
): {
  verdict: 'none' | 'current' | 'stale' | 'indeterminate';
  event: string | null;
  observedSha: string | null;
  observedAt: string | null;
  reason: string;
} {
  const latest = [...wakes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  if (!latest) {
    return {
      verdict: 'none',
      event: null,
      observedSha: null,
      observedAt: null,
      reason: 'No release wake delivery is recorded for the inspected exact-SHA/gate keys.',
    };
  }
  if (!targetSha) {
    return {
      verdict: 'indeterminate',
      event: latest.event,
      observedSha: latest.observedSha,
      observedAt: latest.deliveredAt ?? latest.createdAt,
      reason: 'The wake cannot be lineage-checked because the requested commit did not resolve.',
    };
  }
  const exactDeployKey = `release:deployed:${targetSha.toLowerCase()}`;
  const current = latest.event.toLowerCase() === exactDeployKey || sameSha(targetSha, latest.observedSha);
  return current
    ? {
        verdict: 'current',
        event: latest.event,
        observedSha: latest.observedSha,
        observedAt: latest.deliveredAt ?? latest.createdAt,
        reason: 'The latest release wake carries the requested SHA (or used its exact deploy key).',
      }
    : latest.observedSha
      ? {
          verdict: 'stale',
          event: latest.event,
          observedSha: latest.observedSha,
          observedAt: latest.deliveredAt ?? latest.createdAt,
          reason: `The latest release wake is for ${latest.observedSha}, not ${targetSha}; re-read this full trace instead of acting on that wake.`,
        }
      : {
          verdict: 'indeterminate',
          event: latest.event,
          observedSha: null,
          observedAt: latest.deliveredAt ?? latest.createdAt,
          reason: 'The latest release wake has no SHA in its payload, so it cannot authorize an exact-SHA transition.',
        };
}

function applicableConstraints(input: ReleaseTraceInput): ReleaseTraceConstraint[] {
  const { position, deploy, gate } = input;
  const constraints: ReleaseTraceConstraint[] = [];
  const add = (code: string, blocking: boolean, summary: string) => constraints.push({ code, blocking, summary });
  const targetWasGateTested = gateJudgedTarget(input);
  const targetIsUnderActiveVerification = gateIsActivelyJudgingTarget(input);
  const terminalInconclusive = checkpointRunTerminalInconclusive(input);
  const cancelledNoProducer = checkpointRunCancelledNoProducer(input);
  const consumedAuthority = checkpointAuthorityConsumed(input);
  const candidateVerdict = classifyCandidateVerdict(input);
  const frozenRepairHead = frozenRepairHeadReadyToVerify(input);

  if (!position.targetSha) add('target-unresolved', true, 'The requested path/SHA did not resolve to a commit.');
  if (terminalInconclusive) {
    add(
      'checkpoint-run-inconclusive',
      true,
      `The checkpoint for ${terminalInconclusive.candidate ?? position.targetSha ?? 'this target'} ended ` +
        `${terminalInconclusive.serviceResult}/${terminalInconclusive.exitCode}:${terminalInconclusive.exitStatus} ` +
        'without a valid checkpoint result marker. This is explicitly INCONCLUSIVE, not red or green.',
    );
  }
  if (cancelledNoProducer) {
    add(
      'checkpoint-run-cancelled',
      true,
      `The checkpoint for ${cancelledNoProducer.candidate ?? position.targetSha ?? 'this target'} was externally cancelled ` +
      'without a verdict, and the measured run-lock is idle; no producer remains for a candidate-bound checkpoint:await.',
    );
  }
  if (consumedAuthority) {
    add('checkpoint-authority-consumed', true, consumedAuthority.reason);
  } else if (gate.manualRunAuthority?.withheld === true && gate.manualRunAuthority.governingRef?.trim()) {
    // NON-blocking on purpose. `ok` means "this exact SHA is release-complete"; a governance
    // decision about who may fire the gate by hand says nothing about that, so marking it
    // blocking would make a green, deployed, parity-matched target report ok:false.
    add(
      'manual-checkpoint-authority-withheld',
      false,
      `${gate.manualRunAuthority.governingRef} withholds manual release:checkpoint-run authority: ` +
        `${gate.manualRunAuthority.reason} Scheduled gate fires are unaffected by this constraint.`,
    );
  }
  if (position.dirtyUncommitted) {
    add('dirty-path', true, 'The path has uncommitted edits; its reported target SHA predates those edits.');
  }
  if (position.submodule) {
    add(
      'submodule-lineage',
      true,
      `The path is inside submodule ${position.submodule}; the superproject green/deploy chain is not authoritative for it.`,
    );
  }
  if (position.runtime && !position.runtime.releasePipelineApplies) {
    add('runtime-not-release-carried', true, position.runtime.activation);
  }
  if (position.targetSha && !position.positions.onStaging) {
    add(
      'not-on-origin-staging',
      true,
      targetWasGateTested
        ? `The target commit is not present on origin/staging, but the local green-checkpoint already judged this exact candidate; origin visibility is a separate public-release requirement.`
        : targetIsUnderActiveVerification
          ? `The target commit is not present on origin/staging, but the live green-checkpoint is actively judging this exact detached candidate; origin visibility is a separate post-verification requirement.`
        : 'The target commit is not present on origin/staging, so the green gate cannot test it.',
    );
  }
  if (candidateVerdict.state === 'inconclusive') {
    const inherited = gate.inheritedRepairQueueFailingTests ?? [];
    add(
      'gate-inconclusive',
      true,
      `The exact candidate ${candidateVerdict.candidate ?? position.targetSha ?? 'this target'} has no gate verdict ` +
        `(green:null; reason=${candidateVerdict.reason ?? 'unknown'}). ${
          candidateVerdict.detail ?? 'The checkpoint rendered no code verdict.'
        }` +
        (inherited.length > 0
          ? ` The ${inherited.length} failingTests shown below are inherited repair-queue context from the prior gate verdict, not failures produced by this candidate.`
          : ''),
    );
  } else if (gate.verdictStale) {
    add(
      'gate-verdict-stale',
      true,
      `${gate.verdictStaleReason ?? 'The recorded gate verdict is stale.'} Do not chase its failing-test names until a fresh verdict replaces it.`,
    );
  } else if (gate.consecutiveReds > 0) {
    add(
      'gate-red',
      true,
      `The authoritative gate is red (${gate.consecutiveReds}); fix the named failures before treating the target as tested.` +
        // EI-18672078222841101: the blocker used to stop at "fix the named failures", which
        // every reader correctly reads as an instruction to go fix them — and which three
        // agents acted on simultaneously because nothing here said one of them already had.
        (gate.redOwner ? ` ${gate.redOwner.label}` : ''),
    );
    add(
      'no-force-past-red',
      true,
      'A force deploy would ship known-broken, untested code; the safe release path remains fixing and re-running the gate.',
    );
  }
  if (gate.fireStale)
    add('gate-not-firing', true, gate.fireStaleReason ?? 'The green-checkpoint is not producing fresh verdicts.');
  if (position.targetSha && targetIsNotGreenPinned(position)) {
    const measured = position.verdictProvenance.targetIncludedInGreenPin;
    const targetInMain = position.positions.inMain;
    const summary =
      measured === false
        ? targetInMain
          ? 'The target is in origin/main but is not contained by the recorded green pin; main/deploy presence does not prove gate testing.'
          : 'The target is not in origin/main and is not contained by the recorded green pin; neither origin/main visibility nor green-pin containment proves gate testing.'
        : !targetInMain
          ? 'The target is not in origin/main, and green-pin containment was not measured; this trace cannot prove the target was gate-tested.'
          : 'The target-to-green-pin ancestry could not be measured, so this trace cannot prove the target was gate-tested.';
    add(
      measured === false || (measured === undefined && !targetInMain)
        ? 'target-not-green-pinned'
        : 'green-pin-containment-unmeasured',
      true,
      summary,
    );
  }
  if (position.verdictProvenance.deployOrigin === 'ahead-of-gate') {
    add(
      'deployed-ahead-of-gate',
      true,
      'The live deployment is ahead of the green pin; deployed does not imply tested for this lineage.',
    );
  }
  if (position.targetSha && !position.positions.deployed) {
    add('target-not-live', true, 'The target SHA has not reached the live :3070 operator.');
  }
  if (deploy.errors.length > 0) add('trace-read-degraded', true, deploy.errors.join('; '));
  return constraints;
}

/**
 * P-002 — why an `active === true` reading is not enough to recommend awaiting a verdict.
 *
 * Two branches below tell the reader to await an in-flight run's terminal verdict. Both rested
 * on `active`, which says a run EXISTS, not that it is still deciding. When the run is wedged
 * those recommendations strand the reader on a producer that will never wake them, and the
 * natural escape from an apparently-overdue await is a manual `release:checkpoint-run` — which
 * inside a re-triage window discards the in-flight rescue and spends a full suite. So the proof
 * the recommendation needs is PROGRESS, and it already rides on the object those branches read.
 *
 * `progressing` keeps the await and appends the certificate's own line. `stalled` and `unknown`
 * route ELSEWHERE, and they route to DIFFERENT places on purpose: a stall is a claim about the
 * producer (go measure it), while an `unknown` is a claim about the READING (go get a better
 * one). Collapsing the two — or collapsing the several `unknown` bases into one sentence — is
 * exactly how "we could not tell" is read as "nothing is happening", which is the reader error
 * this plan exists to prevent.
 */
const PROGRESS_UNKNOWN_CLAUSE: Record<ProgressBasis, string> = {
  'no-run': 'This reading carries no in-flight run at all, so there is no verdict in flight to await.',
  'evidence-too-old':
    'This reading came from a cache older than its trust window, so it cannot say the run is healthy OR wedged (D-005) — ' +
    'a stale snapshot of an advancing run and a live snapshot of a stopped one are the same bytes.',
  'verdict-published':
    'The active run has ALREADY published its verdict and is now salvaging, so its elapsed time measures the process, ' +
    'not the decision; read the published outcome instead of awaiting one that already arrived.',
  'ambiguous-fallback':
    'The heartbeat equals the run start instant, which is the documented fallback collision and NOT a stall (D-003); ' +
    'no advancing proof exists yet, so obtain one rather than inferring either health or a wedge from it.',
  'progress-unmeasured':
    'This reading carries no heartbeat at all, so nothing establishes advancement in either direction.',
  'clock-skew':
    'The heartbeat is meaningfully ahead of the observing clock; the two clocks disagree, so no age computed from it — ' +
    'including a stall age — can be trusted.',
  // Neither basis below can reach an `unknown` verdict; both are decided readings. Present so a
  // later basis→verdict change surfaces as a wrong SENTENCE rather than an absent one.
  'live-heartbeat': 'The reading is live but could not be resolved to a verdict.',
  'heartbeat-stale': 'The reading is stale but could not be resolved to a verdict.',
};

function progressGatedAwait(
  awaitVerb: ReleaseTraceNextVerb,
  run: ProgressCertificateInput | null | undefined,
  nowMs: number,
  position: PipelinePosition,
  enabled: boolean,
): ReleaseTraceNextVerb {
  // P-005 / D-015 kill-switch (FLAGS.RELEASE_TRACE_PROGRESS_CERTIFICATE, default ON). OFF hands
  // back the caller's plain await, which is exactly the pre-certificate recommendation — so the
  // switch is a clean revert of the steering rather than a third behaviour nobody has tested.
  //
  // It is deliberately the FIRST statement: the certificate is not consulted at all when the
  // steering is off, so a threshold judgement that turns out to be wrong cannot reach a reader
  // through some other field once the owner has switched it off.
  if (!enabled) return awaitVerb;

  const cert: ProgressCertificate = certifyCheckpointProgress(run, nowMs);

  if (cert.verdict === 'progressing') {
    // `verdict-published` is `progressing` because the run is healthy — but the thing the await
    // would wait for HAS ALREADY ARRIVED, so awaiting it is waiting on the past. "Only on
    // progressing" is a necessary condition for the await, never a sufficient one.
    if (cert.basis === 'verdict-published') {
      return {
        name: 'state:read',
        args: { cell: 'gate.greenCheckpoint.verdict' },
        reason:
          `${cert.detail} The verdict you would await already exists, so read it instead of waiting for it; ` +
          'an overdue-looking runtime here is the salvage phase, not a wedge.',
      };
    }
    return { ...awaitVerb, reason: `${awaitVerb.reason} ${cert.detail}` };
  }

  // D-004 interlock. The certificate surfaces this flag on EVERY non-advancing verdict, precisely
  // because a run that looks stuck is when the forbidden verb is most tempting. No branch below
  // recommends it; the wording says so out loud rather than leaving the reader to reach for it
  // from memory, which is how the discarded-rescue incident actually happened.
  const retriage = cert.inRetriageWindow
    ? ' D-004: this run is inside its auto-refire re-triage window — a manual release:checkpoint-run there discards ' +
      'the in-flight rescue and spends a full suite, so do not fire the gate by hand.'
    : ' Do not fire release:checkpoint-run to "try again": it cuts a fresh candidate at tip and restarts the treadmill ' +
      'that freeze-and-converge exists to stop.';

  if (cert.verdict === 'stalled') {
    return {
      // A stall is a claim about the PRODUCER, so the next move measures the producer. A second
      // await cannot tell a slow run from a dead one — that is what stranded the reader here.
      name: 'processes:list',
      args: {},
      reason:
        `The in-flight run is NOT certified as advancing. ${cert.detail} ` +
        'Awaiting its verdict risks stranding on a producer that has stopped, so measure whether it is still doing ' +
        `work before waiting on it.${retriage}`,
    };
  }

  // `unknown` splits on WHO answered, because that decides which move can add information.
  //
  // A live authority (run-lock / process-authority) has already given the best reading this
  // interface can produce. Re-reading cannot supply a heartbeat that was never emitted, so
  // recommending a re-read there is a loop dressed as an action — measure the producer instead.
  // Without a live authority the READING is the limitation, and a live re-read genuinely fixes it.
  if (cert.liveAuthority) {
    return {
      name: 'processes:list',
      args: {},
      reason:
        `A live authority answered, but the run's progress still could not be certified. ` +
        `${PROGRESS_UNKNOWN_CLAUSE[cert.basis]} ${cert.detail} ` +
        'This establishes neither health nor a wedge, and re-reading cannot add a heartbeat that was never emitted, ' +
        `so measure the producer directly before awaiting or intervening.${retriage}`,
    };
  }

  return {
    name: 'dev:pipeline_position',
    args: position.input.path ? { path: position.input.path } : { sha: position.input.sha },
    reason:
      `No live authority answered, so the run's progress could not be certified. ` +
      `${PROGRESS_UNKNOWN_CLAUSE[cert.basis]} ${cert.detail} ` +
      `Re-read from a live authority before awaiting or intervening.${retriage}`,
  };
}

/**
 * The unguarded recommendation. Four separate branches below can return
 * `release:checkpoint-run`; `safeNextVerb` applies the withheld-authority guard once, at the
 * boundary, rather than repeating a condition at each of them.
 */
function unguardedNextVerb(input: ReleaseTraceInput): ReleaseTraceNextVerb | null {
  const { position, deploy, gate, pipeline, workItem } = input;
  const targetSha = position.targetSha;
  const targetWasGateTested = gateJudgedTarget(input);
  const checkpointRun = gate.checkpointRunInFlight ?? position.gate.checkpointRunInFlight;
  const targetIsUnderActiveVerification = gateIsActivelyJudgingTarget(input);
  const terminalInconclusive = checkpointRunTerminalInconclusive(input);
  const cancelledNoProducer = checkpointRunCancelledNoProducer(input);
  const consumedAuthority = checkpointAuthorityConsumed(input);
  const candidateVerdict = classifyCandidateVerdict(input);
  const frozenRepairHead = frozenRepairHeadReadyToVerify(input);
  if (!targetSha) {
    return {
      name: 'dev:pipeline_position',
      args: position.input.path ? { path: position.input.path } : { sha: position.input.sha },
      reason: 'Resolve a real commit before taking a release action.',
    };
  }
  if (position.dirtyUncommitted) {
    return {
      name: 'git-sync:await',
      args: {},
      reason: 'The current path edits do not have a SHA yet; wait for the commit event before tracing lineage.',
    };
  }
  if (position.submodule) {
    return {
      name: 'dev:pipeline_position',
      args: { path: position.input.path },
      reason: 'Use the submodule-aware path probe; do not infer superproject gate/deploy provenance.',
    };
  }
  if (position.runtime && !position.runtime.releasePipelineApplies) {
    return position.runtime.restartTarget
      ? {
          name: 'dev:restart',
          args: { target: position.runtime.restartTarget, confirm: true },
          reason: 'This path is loaded from staging by its runtime; a release deploy cannot activate it.',
        }
      : null;
  }
  if (consumedAuthority) return null;
  if (terminalInconclusive) {
    return {
      name: 'release:checkpoint-run',
      args: {},
      reason:
        `The previous checkpoint for ${terminalInconclusive.candidate ?? targetSha} terminated ` +
        `${terminalInconclusive.serviceResult}/${terminalInconclusive.exitCode}:${terminalInconclusive.exitStatus} ` +
        'without a verdict. Its terminal state is inconclusive; launch one fresh guarded verdict after fixing the cause.',
    };
  }
  if (cancelledNoProducer) {
    return {
      name: 'release:checkpoint-run',
      args: {},
      reason:
        `The checkpoint for ${cancelledNoProducer.candidate ?? targetSha} was externally cancelled without a verdict, ` +
        'and the measured run-lock is idle; do not await a candidate-bound result from that stopped producer. ' +
      'Launch one fresh guarded verdict after the cancellation cause is resolved.',
    };
  }
  if (candidateVerdict.state === 'inconclusive') {
    // R-1 / EI-23365548566505155. This branch sits AHEAD of both active-run branches below, so
    // an inconclusive candidate reaches the reader first — and it used to hand back a BARE
    // `checkpoint:await`, bypassing the certificate entirely. That is the exact shape of
    // EI-21432980132792683 / EI-21433072117655298: an already-terminal candidate reported back
    // as inconclusive/repair-in-progress with `nextVerb: checkpoint:await`, stranding readers
    // "on a verdict that can never arrive" because the attempt is OVER and no producer remains.
    //
    // `inconclusive` means by contract that the latest attempt rendered NO verdict, so there is
    // no standing guarantee a producer is still running — which is precisely when R-1's
    // "progressing is NECESSARY for the await" has to bite. Routing through progressGatedAwait
    // keeps the await when a run IS certified advancing (the reason text is preserved and
    // extended), and replaces it with a measurement when it is not: `no-run` resolves to
    // `unknown`, which routes to a live re-read instead of an unbounded wait.
    //
    // Deliberately NOT extended to the `frozenRepairHead` branch below: phase `ready-to-verify`
    // is by contract a state a scheduled run picks up, so that await has an expected producer
    // and no recorded stranding. Gating it would degrade a sound recommendation.
    return progressGatedAwait(
      {
        name: 'checkpoint:await',
        args: { pipeline, candidateSha: targetSha },
        reason:
          `The exact candidate ${candidateVerdict.candidate ?? targetSha} rendered no code verdict (green:null; ` +
          `reason=${candidateVerdict.reason ?? 'unknown'}). ` +
          (candidateVerdict.reason === 'repair-in-progress' || candidateVerdict.reason === 'repair-staging-mismatch'
            ? 'The frozen repair queue owns progress; await its next checkpoint outcome instead of opening a new gate-failure diagnosis.'
            : 'Await the next checkpoint outcome instead of treating the prior gate state as a verdict for this candidate.'),
      },
      checkpointRun,
      input.snapshotGeneration,
      position,
      input.progressCertificateEnabled !== false,
    );
  }
  if (frozenRepairHead) {
    return {
      name: 'checkpoint:await',
      args: { pipeline, candidateSha: frozenRepairHead },
      reason:
        `The frozen repair queue is ready to verify repairHead ${frozenRepairHead}; ` +
        'await its candidate-bound checkpoint verdict before the verified lineage is promoted to staging.',
    };
  }
  if (!position.positions.onStaging && !targetWasGateTested) {
    if (targetIsUnderActiveVerification) {
      return progressGatedAwait(
        {
          name: 'checkpoint:await',
          args: { pipeline },
          reason:
            `A green-checkpoint run is already actively judging this exact detached candidate ${targetSha}; ` +
            'await its terminal verdict, then re-read release:trace instead of waiting on publication or launching a duplicate.',
        },
        checkpointRun,
        input.snapshotGeneration,
        position,
        input.progressCertificateEnabled !== false,
      );
    }
    if (position.positions.committedLocal) {
      return {
        // A local commit has already fired git-sync:committed:<sha>; waiting on
        // that local event again strands release recovery. The missing proof is
        // the bridged origin/staging egress event.
        name: 'events:await',
        args: { event: `git-sync:egressed:${targetSha}` },
        reason: 'The target commit exists locally but origin/staging egress is not confirmed; await its exact bridge egress before asking the gate to test it.',
      };
    }
    return {
      name: 'git-sync:await',
      args: { sha: targetSha },
      reason: 'Wait on the exact commit reaching origin/staging before asking the gate to test it.',
    };
  }
  if (targetIsNotGreenPinned(position)) {
    if (checkpointRun?.active) {
      return progressGatedAwait(
        {
          name: 'checkpoint:await',
          args: { pipeline },
          reason:
            `A green-checkpoint run is already active${checkpointRun.candidate ? ` on candidate ${checkpointRun.candidate}` : ''}; ` +
            'await its terminal verdict, then re-read release:trace instead of launching a duplicate.',
        },
        checkpointRun,
        input.snapshotGeneration,
        position,
        input.progressCertificateEnabled !== false,
      );
    }
    if (gate.verdictStale || gate.fireStale) {
      return {
        name: 'release:checkpoint-run',
        args: {},
        reason: 'Replace the stale/non-firing gate state with one fresh full-suite verdict.',
      };
    }
    if (gate.consecutiveReds > 0) {
      // EI-18672078222841101: this recommendation is the single highest-leverage line in the
      // whole trace — it is what an agent does next. Sending every reader of a red gate to
      // `testing:flakiness` is right when nobody is on it and wasteful when someone is: on
      // 2026-07-26 three agents ran the identical diagnosis within 15 minutes. When the
      // system already knows a live fixer holds THIS signature, wait for its verdict instead
      // of opening a parallel investigation of it.
      const redOwner = gate.redOwner;
      if (redOwner?.covered) {
        return {
          name: 'checkpoint:await',
          // The current red event is already latched. A candidate-bound
          // checkpoint:await probes that same terminal red and returns
          // already_judged, so it cannot observe the fixer’s successor verdict.
          // Await the next pipeline verdict instead; the trace still carries the
          // exact live owner above for a paced liveness re-check.
          args: { pipeline },
          reason:
            `${redOwner.label} The current red event is already latched; await the next checkpoint verdict ` +
            'without candidate binding and re-check the live owner/fixer at a paced cadence rather than opening a second diagnosis.',
        };
      }
      return {
        name: 'testing:flakiness',
        args: {},
        reason:
          'Classify the exact gate failures before fixing them; do not deploy past an authoritative red.' +
          (gate.redOwner ? ` ${gate.redOwner.label}` : ''),
      };
    }
    return {
      // EI-12457: bind the wait to the EXACT candidate being traced — a verdict for
      // any other (superseded) SHA on this pipeline will not wake the caller.
      name: 'checkpoint:await',
      args: { pipeline, candidateSha: targetSha },
      reason: 'The commit is on staging with no red verdict; await this pipeline’s exact gate outcome for this candidate.',
    };
  }
  if (!position.positions.deployed) {
    return deploy.canTriggerGreen
      ? {
          name: 'release:deploy',
          args: { op: 'trigger', confirm: true },
          reason: 'The target is green-pinned and green code is ahead of the live deployment; expedite only that pin.',
        }
      : {
          name: 'deploy:await',
          args: { sha: targetSha },
          reason: 'The target is green but not live; await its exact deploy key instead of polling.',
        };
  }
  if (position.verdictProvenance.deployOrigin === 'ahead-of-gate') {
    return {
      name: 'release:checkpoint-run',
      args: {},
      reason:
        'The deployed lineage is ahead of the green pin; obtain a fresh full-suite verdict before live-proof completion.',
    };
  }
  if (workItem) {
    return {
      name: 'work_items:set_live_verified',
      args: {
        id: workItem,
        testedSha: position.verdictProvenance.lastGreenSha,
        deployedSha: position.deployedSha,
      },
      reason:
        'The exact SHA is green and deployed; record live evidence on the work item after exercising the behavior.',
    };
  }
  return null;
}

/**
 * EI-21456558908416090 — suppress a manual checkpoint-run recommendation whenever a recorded
 * decision withholds that authority, whatever the id of the decision.
 *
 * Keyed on the RECOMMENDED VERB, not on the branch that produced it: every current and future
 * path that would tell a reader to fire the gate by hand passes through this one test. The
 * substitution is deliberate — a bare `null` teaches the reader nothing and invites them to
 * reach for the forbidden verb from memory, so the reply names the governing decision and hands
 * back the non-destructive action that IS authorized (await the next scheduled verdict).
 */
function safeNextVerb(input: ReleaseTraceInput): ReleaseTraceNextVerb | null {
  const verb = unguardedNextVerb(input);
  if (verb?.name !== 'release:checkpoint-run') return verb;

  const withheld = manualCheckpointRunWithheld(input);
  if (withheld) {
    return {
      name: 'checkpoint:await',
      args: { pipeline: input.pipeline },
      reason:
        `MANUAL CHECKPOINT AUTHORITY WITHHELD by ${withheld.governingRef}: ${withheld.reason} ` +
        `A release:checkpoint-run recommendation (${verb.reason}) was suppressed — do NOT fire the gate by hand: ` +
        'a manual fire inside a re-triage window discards the auto-refire rescue and spends a ~55min suite. ' +
        'Await the next scheduled verdict, or record a newer decision granting manual authority before launching.',
    };
  }

  // P-003 / D-004. The withheld-authority guard above answers "is there a recorded DECISION
  // forbidding this?"; the re-triage window is a live RUNTIME fact and answers a different
  // question, so a trace with no such decision on file reached the forbidden verb anyway.
  //
  // Read through the certificate rather than the raw reading so this module keeps ONE reader of
  // the flag: the certificate resolves it on every basis including `no-run`, which is precisely
  // the shape production emits here — the auto-refire has VOIDED the previous run, so nothing is
  // active, and an absent run must not be able to launder the prohibition away.
  //
  // P-005 / D-015: this read is deliberately NOT gated by input.progressCertificateEnabled. That
  // flag exists for one carried risk — the 600s stall THRESHOLD is a judgement — and this branch
  // reads `inRetriageWindow`, which is a window-membership fact that no threshold enters. Gating
  // it would make a steering kill-switch silently re-arm the discarded-rescue footgun D-004 was
  // written to close. The falsifier is in release-trace.test.ts: interlock fires with the flag OFF.
  if (certifyCheckpointProgress(retriageReading(input), input.snapshotGeneration).inRetriageWindow) {
    return {
      name: 'checkpoint:await',
      args: { pipeline: input.pipeline },
      reason:
        'D-004: the gate is inside its auto-refire re-triage window, so manual checkpoint authority is withheld. ' +
        `A release:checkpoint-run recommendation (${verb.reason}) was suppressed — firing here discards the ` +
        'in-flight rescue the refire already started and spends a ~55min suite to re-learn what it is measuring. ' +
        'Await the refire\'s verdict; it is judging a candidate this trace cannot see yet.',
    };
  }

  return verb;
}

/** The reading the re-triage flag rides on, preferring the gate's over the position's. */
function retriageReading(input: ReleaseTraceInput): ProgressCertificateInput | null | undefined {
  return input.gate.checkpointRunInFlight ?? input.position.gate.checkpointRunInFlight;
}

export function buildReleaseTrace(input: ReleaseTraceInput) {
  const canonicalOwner = canonicalRedOwner(input);
  const effectiveInput = canonicalOwner ? { ...input, gate: { ...input.gate, redOwner: canonicalOwner } } : input;
  const candidateVerdict = classifyCandidateVerdict(effectiveInput);
  const fixCommitContainment = classifyFixCommitContainment(effectiveInput);
  const targetSha = input.position.targetSha;
  const requesterWakes = input.requesterId
    ? input.wakes.filter((wake) => wake.subscriberId === input.requesterId)
    : input.wakes;
  const wake = classifyReleaseWake(targetSha, requesterWakes);
  const constraints = applicableConstraints(effectiveInput);
  const activeAwaits = input.awaits.filter((a) => a.state === 'registered');
  const generationBehind = input.consumerGeneration != null && input.consumerGeneration !== input.snapshotGeneration;
  const testedSha = input.position.verdictProvenance.lastGreenSha;
  const deployedSha = input.position.deployedSha;
  const pinParity = classifyReleaseParity({
    testedSha,
    claimedDeployedSha: deployedSha,
    actualDeployedSha: deployedSha,
    greenPinSha: testedSha,
  });
  const measuredTargetInGreenPin = input.position.verdictProvenance.targetIncludedInGreenPin;
  const targetInGreenPin =
    measuredTargetInGreenPin === undefined ? input.position.positions.inMain : measuredTargetInGreenPin === true;
  const parity = targetSha != null && targetInGreenPin && input.position.positions.deployed && pinParity.ok;
  const nextVerb = safeNextVerb(effectiveInput);
  const consumedAuthority = checkpointAuthorityConsumed(effectiveInput);
  const ok = input.position.positions.deployed && parity && constraints.every((c) => !c.blocking);

  return {
    ok,
    generatedAtMs: input.snapshotGeneration,
    target: {
      requestedPath: input.position.input.path,
      requestedSha: input.position.input.sha,
      sha: targetSha,
      subject: input.position.targetSubject,
      dirtyUncommitted: input.position.dirtyUncommitted,
      presence: input.position.positions,
      runtime: input.position.runtime,
    },
    gate: { ...effectiveInput.gate, candidateVerdict, fixCommitContainment, consumedAuthority },
    greenPin: {
      sha: testedSha,
      targetIncluded: input.position.verdictProvenance.targetIncludedInGreenPin ?? null,
      mainFastForwarded: input.position.verdictProvenance.mainFastForwarded,
    },
    deploy: {
      sha: deployedSha,
      targetIncluded: input.position.positions.deployed,
      origin: input.position.verdictProvenance.deployOrigin,
      behindGreenPin: input.position.verdictProvenance.deployedBehindGreenPin,
    },
    testedDeployedParity: {
      ok: parity,
      targetSha,
      testedSha,
      deployedSha,
      state:
        targetIsNotGreenPinned(input.position) || !input.position.positions.deployed
          ? 'target-not-included'
          : pinParity.state,
    },
    awaits: {
      inspectedKeys: input.inspectedKeys,
      registered: activeAwaits,
      totalRegistrations: input.awaits.length,
      activeRegistrations: activeAwaits.length,
    },
    staleWake: wake,
    constraints,
    nextVerb,
    resync: {
      required: generationBehind,
      consumerGeneration: input.consumerGeneration ?? null,
      authoritativeGeneration: input.snapshotGeneration,
      rule: 'release:trace is a full exact-SHA snapshot. Replace the cached trace whenever required=true or a release wake arrives; never merge fields from different generations.',
      nextVerb: targetSha
        ? { name: 'release:trace', args: { sha: targetSha, after_generation: input.snapshotGeneration } }
        : null,
    },
    summary: ok
      ? `${targetSha} is present on staging/main, green-pinned, and deployed with matching lineage.`
      : `${targetSha ?? 'unresolved target'} is not release-complete: ${
          constraints
            .filter((c) => c.blocking)
            .map((c) => c.code)
            .join(', ') || 'follow nextVerb'
        }.`,
  };
}
