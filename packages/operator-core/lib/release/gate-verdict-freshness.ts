/**
 * gate-verdict-freshness.ts — is the green-gate's recorded verdict still TRUSTWORTHY? (WI-4489)
 *
 * ## The defect this closes
 *
 * `gate_health` (the green-checkpoint routine's metadata blob) is a mutable CACHE of the gate's
 * last verdict. It is written ONLY by ROUTINE-invoked checkpoint runs. But a routine fire that
 * loses the per-root run-lock records `skipped-locked`, which `classifyGateStallStatus` correctly
 * treats as a NO-OP (a lock collision proves nothing about gate health, EI-2615) — and the no-op
 * path returns WITHOUT touching `gate_health`.
 *
 * Meanwhile the fire itself still advances `routines.last_fired_at`. So:
 *
 *   - `fireStale` (WI-282) keys on `last_fired_at` ⇒ reads FRESH — the routine IS firing, hourly,
 *     on time.
 *   - `gate_health.consecutiveReds` keys on the last OBSERVATION ⇒ can be arbitrarily old.
 *
 * **A routine that fires and no-ops is indistinguishable from a routine that fires and works.**
 * WI-282's comment says `fireStale` exists to catch a checkpoint that *never ran* ("it can't go
 * red without running"). This is the uncovered inverse: one that RAN, SKIPPED, and WROTE NOTHING.
 *
 * Observed live 2026-07-12: the last real verdict was 18:29; the routine then fired at 19:15,
 * 20:15 and 21:15, each `skipped-locked`. For ~3.5h every consumer read `consecutiveReds: 4,
 * fireStale: false` — a confident RED — while the gate was in fact GREEN on every actual run
 * (`{"reason":"up-to-date","green":true}`) and all 8 named "failing" tests passed. The stale red
 * dispatched the release-fixer, whose MANUAL runs held the lock that kept the routine skipping,
 * which kept the blob stale: a self-sustaining phantom that could not clear itself.
 *
 * ## The principle
 *
 * > The `ready` pin advancing IS the gate's green verdict — durably recorded in git. `gate_health`
 * > is only a cache of it. **When the cache and the pin disagree, the PIN is the truth.**
 *
 * `release-actions.ts` already trusts exactly this inference — but only on the WRITE path
 * (`pinMoved` ⇒ reset the streak). It was never applied on the READ path, so any consumer reading
 * a starved cache was misled. This module applies it there.
 *
 * All three rules below are HARD EVIDENCE, not heuristics — deliberately so. The sibling lesson
 * from EI-10619 (`agent-insights/prove-it-discriminates-before-it-acts`) is that a detector built
 * on a statistic over the values you happen to have will fire on healthy states; so this one
 * reasons only from facts that PROVE the verdict was superseded:
 *
 *   1. PIN-ADVANCE — the release pin moved past the pin this red was recorded against. The pin
 *      only ever advances on a GREEN checkpoint, so a later green demonstrably happened.
 *   2. WRITER-STARVED — the routine has FIRED since the observation without producing a new one.
 *      Its runs are being skipped; the verdict is simply unverified.
 *   3. RETRIAGE-PROVEN (EI-13288) — the checkpoint run that PRODUCED this verdict already re-ran
 *      its own named failing files at a newer tip (green-checkpoint.ts's stale-candidate
 *      re-triage) and they PASSED, but the bounded auto-refire cap was reached before a full
 *      suite could confirm that tip green. Unlike rules 1-2 (both infer staleness from
 *      surrounding pipeline state), this is the run's own first-hand evidence about itself: it
 *      directly disproves its own failing-test names, at record time, without needing the pin to
 *      move or the routine to starve. See EI-13288 — a fresh, on-time, correctly-held gate can
 *      still name files its own retriage already knows don't reproduce.
 *   4. REFIRE-IN-FLIGHT (EI-18669342433807110) — a stale-candidate auto-refire for THIS EXACT red
 *      is running RIGHT NOW (green-checkpoint.ts already decided the red is stale and recursed
 *      onto a newer tip, but that recursion can take minutes and writes nothing to `gate_health`
 *      until it settles). Like rule 3 this is live first-hand evidence, not an inference — the run
 *      that produced the cached red is, this moment, re-verifying it. Checked FIRST: it is the
 *      most current of the four (rule 3 is about a run that already finished; this one hasn't).
 *   5. CANDIDATE-FOSSIL (EI-19346660748445728) — the verdict judged a commit that was ALREADY
 *      ancient when the verdict was written. See below; this is the only rule that needs nothing
 *      to have happened afterwards.
 *
 * A verdict you cannot distinguish from a STALE verdict is not a verdict.
 *
 * ## Rule 5 and the blind spot it closes (EI-19346660748445728)
 *
 * Rules 1-4 all ask the SAME question in different ways: *has something happened SINCE this
 * verdict?* (the pin moved, the writer starved, a re-triage ran, a refire is in flight). Every one
 * of them is therefore blind to a verdict that was **already describing ancient code at the moment
 * it was produced** — nothing needs to happen afterwards for that verdict to be untrustworthy, so
 * no "since" rule can catch it.
 *
 * That gap is not hypothetical. Measured across every persisted verdict on 2026-08-02 (n≈30),
 * candidate age at verdict time was tightly clustered at **19-35 min** — the structural cost of the
 * quiet-cut plus a ~55min suite — with a hard tail of outliers at **54, 70, 121, 362 and 651 min**.
 * The 651-minute case (verdict written 12:53:12Z judging a candidate committed 02:01:48Z) reported
 * 40 failures for a defect that had been FIXED ~9h before the verdict was written. Because no rule
 * covered it, `stale` came back FALSE and the red was presented as current: four agents reached
 * four contradictory conclusions from it and ~2h of fleet time went into diagnosing already-fixed
 * code. Its own header corroborated the fossil independently — `tasks=15` where every healthy
 * verdict that day ran `tasks=42`, because a base→candidate diff that narrow selects a completely
 * different affected set.
 *
 * The inputs this rule needs were ALREADY being recorded. `release-actions.ts` has written
 * `gate_health.candidateCommittedAt` + `commitsBehindTip` for some time, and mentions them in a
 * broadcast NOTE — but the machine-readable `stale` verdict that every consumer actually branches
 * on (`dev:pipeline_position`, `/admin/git`, the why-chain) never read them. A durable record
 * nobody reads is not a fix; it is the same silence with better bookkeeping. This rule is the
 * read side.
 *
 * Deliberately conservative: {@link CANDIDATE_FOSSIL_AGE_MS} defaults to 120 min — 2.2× the
 * oldest HEALTHY observation in that sample (54 min), so an ordinary quiet-cut verdict can never
 * trip it, while every genuine outlier measured does. It reports `stale` WITHOUT claiming green
 * (see `reasonCode`): a fossil verdict is unreliable, not disproven.
 */

import { describeRefireBudget, type StoredInFlightRetriage } from './in-flight-retriage';
// `import type` only — erased at compile time, so reusing the queue's own phase union here
// cannot create a runtime cycle, and the union is not re-declared (derived-truth ladder).
import type { FrozenCandidateRepairPhase } from './frozen-candidate-repair-queue';

/** One green-checkpoint fire interval. The routine is hourly; the 1.5× slack below keeps a fire
 *  that lands a little late from reading as a starved writer. */
export const GATE_FIRE_INTERVAL_MS = 60 * 60_000;

/**
 * Rule 5 threshold: how old the JUDGED CANDIDATE may be, at verdict time, before the verdict is
 * treated as describing a fossil rather than the tree we would ship.
 *
 * 120 min is chosen from measurement, not taste (EI-19346660748445728). The healthy population on
 * 2026-08-02 (n≈25) sat at 19-35 min with a single benign 54; the outliers were 70, 121, 362 and
 * 651. 120 min clears the healthy maximum by 2.2× — so the ordinary quiet-cut + ~55min-suite path
 * can NEVER trip this — while still catching every genuine outlier observed.
 *
 * Overridable per-call via `GateVerdictFreshnessInput.fossilAgeMs` (the module stays pure — env is
 * read by callers, never here), mirroring `intervalMs`/{@link GATE_FIRE_INTERVAL_MS}.
 */
export const CANDIDATE_FOSSIL_AGE_MS = 120 * 60_000;

export interface GateVerdictFreshnessInput {
  /** The red streak the cache is reporting. A ZERO-red (green) verdict going stale is harmless —
   *  it never misdirects anyone — so freshness is only ever judged for a RED. */
  consecutiveReds: number;
  /** When the last REAL verdict was observed (`gate_health.observedAt`). Null on a blob written
   *  before this field existed — rule 2 is then unavailable and says so, rather than guessing. */
  observedAtMs: number | null;
  /** The release pin as observed AT verdict time (`gate_health.lastFrom`), 12-char short sha. */
  observedFromPin: string | null;
  /** The release ("ready") pin RIGHT NOW — full or short sha. */
  currentGreenPinSha: string | null;
  /** The routine's last fire (`routines.last_fired_at`) — fresh even when the fire no-opped. */
  lastFiredAtMs: number | null;
  /** Fire interval; defaults to {@link GATE_FIRE_INTERVAL_MS}. */
  intervalMs?: number;
  /** EI-13288 — Rule 3 input. Non-null ⇒ the checkpoint run that produced THIS verdict already
   *  re-ran its own named failing files at this (short) tip sha, via the stale-candidate
   *  re-triage, and they PASSED — the auto-refire cap was reached before a full suite could
   *  confirm that tip green (`gate_health.retriageStaleTip`). This is hard evidence from the
   *  SAME run, not a heuristic: the verdict's own failure signature does not reproduce at a sha
   *  it already checked. Null/absent when the run's retriage never found a stale-candidate (the
   *  common, genuinely-broken case) or ran on a blob predating this field. */
  retriageStaleTip?: string | null;
  /** EI-18669342433807110 — Rule 4 input. The parsed `gate_health.inFlightRetriage` marker (already
   *  freshness-checked by `parseInFlightRetriage`), when a stale-candidate auto-refire is currently
   *  running. Null/absent when no refire is in flight, or its marker is missing/abandoned. */
  inFlightRetriage?: StoredInFlightRetriage | null;
  /** EI-19346660748445728 — Rule 5 input. When the COMMIT this verdict judged was authored
   *  (`gate_health.candidateCommittedAt`, parsed to epoch ms). Null/absent on a blob predating the
   *  field, or when the writer could not resolve it — the rule is then unavailable and says
   *  nothing, rather than guessing. Judged against `observedAtMs` (verdict time), never against
   *  `Date.now()`: the question is how stale the candidate was WHEN JUDGED, and using now-time
   *  would make every old-but-healthy verdict look like a fossil. */
  candidateCommittedAtMs?: number | null;
  /** EI-19346660748445728 — Rule 5 enrichment (`gate_health.commitsBehindTip`). Not required to
   *  fire the rule; when present it turns "the candidate was old" into the number that actually
   *  tells a reader how much newer work the verdict never saw. */
  commitsBehindTip?: number | null;
  /** Rule 5 threshold; defaults to {@link CANDIDATE_FOSSIL_AGE_MS}. */
  fossilAgeMs?: number;
  /**
   * EI-20571364274022293 — Rule 1's ORDERING input, and the field that makes rule 1 sound.
   *
   * TRUE ⇒ `observedFromPin` was FRESHLY READ by the run that wrote this verdict, so it really is
   * "the pin at verdict time" and a difference now proves the pin moved AFTER this red.
   * FALSE ⇒ that run could NOT resolve the live pin and the writer carried the previous value
   * forward (`gate_health.lastFrom = fromPin ?? gh.lastFrom`), so `observedFromPin` may be
   * arbitrarily old and a difference proves NOTHING about when the pin moved.
   * Null/absent ⇒ a blob predating this field; treated exactly like FALSE, because an
   * unprovenanced pin is not a timestamped one.
   *
   * ⚠ Why this and not a `lastGreenAt`/`firstRedAt` comparison: on a RED blob `lastGreenAt` is
   * ALWAYS earlier than `firstRedAt` by construction (the writer sets `lastGreenAt = now` only on
   * the green path, which simultaneously zeroes the streak), so ordering those two fields would
   * decline rule 1 on 100% of inputs — silently deleting a rule that genuinely catches a stale
   * blob. The pin's own provenance is the only ordering evidence the blob actually carries.
   */
  observedFromPinFresh?: boolean | null;
}

export interface GateVerdictFreshness {
  /** True ⇒ the recorded RED is not trustworthy: do NOT report it as the gate's current colour,
   *  and do NOT dispatch anyone to fix the tests it names. */
  stale: boolean;
  reason: string | null;
  /**
   * WHICH rule fired, when `stale` — callers that need to distinguish PROVEN-GREEN from
   * merely-UNVERIFIED must not just branch on `stale` (EI-13714):
   *   - 'pin-advance'      — HARD PROOF a green happened AFTER this red (the pin only moves on
   *                          green, AND the base pin it moved from was read live at verdict time,
   *                          so the move is ordered after the verdict). A caller may safely treat
   *                          the streak as reset to 0, not just "unknown".
   *   - 'pin-advance-unordered' — the pin DIFFERS from this verdict's base, but that base was
   *                          carried forward rather than observed (`observedFromPinFresh` false
   *                          or absent), so the difference may predate the red entirely. Same
   *                          contract as 'writer-starved': unverified, NOT proof of green — a
   *                          caller must NOT reset the streak on it (EI-20571364274022293, where
   *                          an order-blind rule 1 reported `consecutiveReds: 0` + "the gate has
   *                          greened since" for a gate that could not START at all, because the
   *                          pin had advanced ~2h BEFORE the first red and the writer — unable to
   *                          resolve the pin — had frozen `lastFrom` at a pre-incident value).
   *   - 'writer-starved'   — no new evidence either way; the true colour is genuinely unknown.
   *                          ⚠ This code means ONLY "fired without a new verdict". It does NOT
   *                          establish WHY, and must never be rendered as a claim about the
   *                          run-lock (see `reconcileGateVerdictFreshnessWithRepairQueue`).
   *   - 'repair-converging' — the fires produced no verdict because a frozen repair queue is
   *                          CONVERGING: those runs execute to completion and return
   *                          `{green:null, reason:'repair-in-progress'}`, which is never banked
   *                          as a verdict, so the staleness clock cannot reset. The gate is
   *                          HEALTHY. Like 'writer-starved' the true colour is unknown, but the
   *                          correct response is the opposite of contention triage: let the
   *                          queue converge. Cancelling or force-firing here destroys a real
   *                          ~55min suite and makes the qualification terminal code-inconclusive.
   *   - 'retriage-proven'  — this verdict's own named failures are proven not to reproduce at a
   *                          newer tip, but that is not a full-suite green proof.
   *   - 'refire-in-flight' — a stale-candidate auto-refire for this exact red is running RIGHT
   *                          NOW; a fresh verdict is imminent, so this cached red must not be
   *                          acted on in the meantime.
   *   - 'candidate-fossil' — the verdict judged a commit that was already ancient when it was
   *                          written, so it describes neither the tree we would ship nor, very
   *                          likely, current reality. NOT proof of green (like 'writer-starved',
   *                          the true colour is unknown) — but unlike it, the cause is concrete
   *                          and named, and the correct response is to re-judge at tip rather
   *                          than to fix the tests this verdict names.
   * `null` when `stale` is false.
   */
  reasonCode:
    | 'pin-advance'
    | 'pin-advance-unordered'
    | 'writer-starved'
    | 'run-in-flight'
    | 'repair-converging'
    | 'retriage-proven'
    | 'refire-in-flight'
    | 'candidate-fossil'
    | null;
  /** EI-19346660748445728: how stale the judged candidate was at verdict time, in ms — present
   *  whenever it could be computed, INDEPENDENT of whether rule 5 fired. A caller can surface the
   *  ordinary ~30min structural window (a real, load-bearing property of every verdict this gate
   *  produces) without waiting for the outlier threshold to trip. */
  candidateAgeMs?: number | null;
}

/**
 * The liveness reading that may refine a freshness verdict. `activeSource` is deliberately
 * optional: cache-backed readings describe the past and must not be promoted to measured
 * liveness merely because their `active` bit is true.
 */
export interface CheckpointRunLivenessReading {
  active: boolean;
  activeSource?: 'run-lock' | 'process-authority';
}

/**
 * PURE: distinguish healthy contention from true writer starvation when the caller has a
 * measured live run-lock reading. A verdict is necessarily unwritten while its checkpoint run
 * is still executing, so the same frozen `observedAt`/`lastFiredAt` pair that correctly identifies
 * a skipped fire also occurs during every healthy long-running suite.
 *
 * Only the combination of `writer-starved` + `active:true` from the LIVE run lock earns the new
 * `run-in-flight` classification. Cache-only activity, measured idle, unknown liveness, and all
 * stronger freshness rules preserve the original result and its evidence.
 */
export function reconcileGateVerdictFreshnessWithCheckpointRun(
  freshness: GateVerdictFreshness,
  measuredActive: CheckpointRunLivenessReading | null | undefined,
): GateVerdictFreshness {
  if (
    freshness.reasonCode !== 'writer-starved' ||
    measuredActive?.active !== true ||
    (measuredActive.activeSource !== 'run-lock' && measuredActive.activeSource !== 'process-authority')
  ) {
    return freshness;
  }

  return {
    ...freshness,
    reason:
      `the recorded red is unverified because a green-checkpoint run is IN FLIGHT (measured live ` +
      `${measuredActive.activeSource === 'run-lock' ? 'via the run lock' : 'via gate authority environment + cgroup'}), so its verdict is pending — do NOT fire release:checkpoint-run or fix ` +
      `the named tests while it runs; wait for this active run's verdict`,
    reasonCode: 'run-in-flight',
  };
}

/**
 * The frozen-repair-queue reading that may refine a freshness verdict. Structural on purpose: the
 * phase is the only field this judgement needs, and a narrow shape keeps the pure evaluator from
 * depending on the queue module's full row.
 */
export interface FrozenRepairConvergenceReading {
  /**
   * The gate's OWN recorded disposition for the last completed run
   * (`gate.inconclusive.status`). This is the strongest evidence available: it is a direct
   * measurement of why no verdict was banked, not an inference from surrounding state.
   */
  status?: 'repair-in-progress' | 'repair-staging-mismatch' | (string & {}) | null;
  /**
   * Structural corroboration: a frozen queue exists and is in a converging phase. Used when no
   * recorded disposition is available, and to name the phase in the message.
   */
  phase?: FrozenCandidateRepairPhase | null;
}

/** The recorded dispositions that mean "this run completed but banked no verdict, by design". */
const REPAIR_NON_VERDICT_STATUSES = new Set(['repair-in-progress', 'repair-staging-mismatch']);

/**
 * PURE: distinguish a CONVERGING frozen repair queue from true writer starvation.
 *
 * Rule 2 fires on a purely TEMPORAL observation — the routine fired since the last verdict — and
 * that observation has several causes demanding OPPOSITE actions. Two are already separated: a run
 * executing right now becomes `run-in-flight` via {@link reconcileGateVerdictFreshnessWithCheckpointRun}.
 * This reconciler separates the third: while freeze-and-converge holds a frozen candidate, every
 * run executes to completion and returns `{green:null, reason:'repair-in-progress'}`, which is
 * never banked as a verdict — so `observedAt` stays frozen while `last_fired_at` advances, exactly
 * like a skipped fire, and the reading defaults to blaming the run-lock.
 *
 * That default is not merely vague, it is INVERTED: it sends readers to cancel or force-fire a
 * healthy gate. Measured 2026-09-20 (WI-10002059) — the run judged a repair head, self-refired when
 * an admission advanced it mid-run, judged the new head, and ended `reason:'repair-in-progress'`.
 *
 * Applied AFTER the checkpoint-run reconciler so a live run still wins: an in-flight run is the
 * more immediate truth ("wait for this run") than the standing convergence it happens to sit in.
 *
 * `'blocked'` is deliberately NOT treated as converging — a blocked queue is not making progress,
 * so it keeps the original reading rather than being reassured about.
 */
export function reconcileGateVerdictFreshnessWithRepairQueue(
  freshness: GateVerdictFreshness,
  queue: FrozenRepairConvergenceReading | null | undefined,
): GateVerdictFreshness {
  if (freshness.reasonCode !== 'writer-starved' || !queue) return freshness;

  // Direct evidence: the gate itself recorded WHY the last completed run banked no verdict.
  const recorded = typeof queue.status === 'string' && REPAIR_NON_VERDICT_STATUSES.has(queue.status);
  // Structural evidence: a frozen queue exists in a phase that is actively converging. 'blocked'
  // is excluded on purpose — a blocked queue is NOT making progress, so reassuring a reader that
  // "the gate is healthy" would trade one wrong conclusion for another.
  const converging = queue.phase != null && queue.phase !== 'blocked';
  if (!recorded && !converging) return freshness;

  const evidence = recorded
    ? `the gate recorded '${queue.status}' for its last completed run`
    : `a frozen repair queue is converging (phase '${queue.phase}')`;

  return {
    ...freshness,
    reason:
      `the green-checkpoint has fired since this verdict without producing a new one, but its runs are ` +
      `NOT being skipped on the run-lock: ${evidence}. A converging run executes to COMPLETION and then ` +
      `returns 'repair-in-progress', which is never banked as a verdict — so the staleness clock cannot ` +
      `reset and this red stays unverified while the gate is HEALTHY. Do NOT release:checkpoint-cancel and ` +
      `do NOT force a run to "unwedge" it: cancelling destroys a real ~55min suite and makes the ` +
      `qualification terminal code-inconclusive. Let the queue converge, or land a fix onto the frozen ` +
      `lineage with release:repair-queue { op:'admit', paths:[…] }`,
    reasonCode: 'repair-converging',
  };
}

/**
 * The pinned-repair reading that may RELEASE a fossil classification — a single boolean, not the
 * queue row, on purpose.
 *
 * The judgement itself belongs to the module that OWNS the queue (`isJudgingPinnedActiveRepair`,
 * frozen-candidate-repair-queue), and this module imports that one with `import type` ONLY — see
 * the note beside that import — specifically to avoid a runtime cycle. Pulling the predicate in as
 * a value here would create exactly the cycle that `import type` exists to prevent. So the CALLER,
 * which already depends on both modules, computes the answer and passes it. That also keeps ONE
 * definition of the judgement: D-004 records that the write side (green-checkpoint's withholding
 * rule) and this read side are a COUPLED PAIR, and a second hand-rolled copy of the test is
 * exactly how the two drift back apart (WI-10002121).
 */
export interface PinnedActiveRepairReading {
  /**
   * Did this verdict judge the head of a DELIBERATELY PINNED, still-active repair lineage?
   *
   * Compute it with `isJudgingPinnedActiveRepair({ candidate: <the sha THIS verdict judged>,
   * repairQueue })` — never by re-deriving the comparison inline. The candidate must be the JUDGED
   * sha (`observedCandidate`), not the current tip and not the frozen pin: the exemption is about
   * what this verdict actually measured.
   */
  judgingPinnedActiveRepair: boolean;
}

/**
 * PURE: release rule 5 when the "fossil" it found is a DELIBERATELY FROZEN repair head.
 *
 * Rule 5 (`candidate-fossil`) catches an ACCIDENTALLY stale candidate, whose red can dispatch
 * agents against code the gate never judged as current — so it tells the reader to re-judge at tip
 * and NOT to fix the tests the verdict names. Under freeze-and-converge that advice INVERTS. A
 * frozen repair queue judges one immutable sha ON PURPOSE, and its head is designed to age past
 * any wall-clock threshold while fixes land on it; its red IS the failing-test signature the queue
 * needs in order to advance, and re-judging at tip is the one move the policy forbids (it discards
 * the queue and restarts the treadmill D-007 diagnosed).
 *
 * So on a pinned active repair head rule 5 emits a confident instruction that is backwards on BOTH
 * halves. This is the READ-side twin of the WRITE-side withholding rule; D-004 records that the
 * pair must be repaired together, because fixing either alone re-creates the livelock.
 *
 * Returns the canonical NON-STALE triple rather than minting a new reason code. Two reasons:
 *   • the actionable sentence already has an owner — `frozenRepairQueueSafeLever` defers to the
 *     queue's own `nextAction` ("land your fix with release:repair-queue { op:'converge' }"), and
 *     inventing second advice here is precisely what that function's contract warns against;
 *   • the reason travels to a field literally named `verdictStaleReason`, so a non-null string
 *     beside `stale:false` reads as a staleness complaint to every consumer that renders it.
 * `candidateAgeMs` is preserved deliberately: the age is REAL and worth surfacing — what is wrong
 * is calling it a fossil, not reporting it.
 *
 * A queue that has GIVEN UP is NOT exempt: `blocked`/`blockedReason` means no repair is advancing,
 * so the red stops being anybody's working signature and the ordinary rules apply. That test lives
 * inside `isJudgingPinnedActiveRepair`, which is why this takes its answer rather than the row.
 *
 * Guard note: this keys on `'candidate-fossil'` while both sibling reconcilers key on
 * `'writer-starved'`, so the three are DISJOINT and chain order is not load-bearing between them.
 * Do not introduce an ordering dependency without a test that pins it.
 */
export function reconcileGateVerdictFreshnessWithPinnedRepair(
  freshness: GateVerdictFreshness,
  pinned: PinnedActiveRepairReading | null | undefined,
): GateVerdictFreshness {
  if (freshness.reasonCode !== 'candidate-fossil' || pinned?.judgingPinnedActiveRepair !== true) {
    return freshness;
  }
  return { ...freshness, stale: false, reason: null, reasonCode: null };
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * PURE. Judge whether a recorded RED verdict has been superseded or was never verified.
 *
 * Returns `stale: false` for a green (0-red) blob: there is nothing to mistrust, and marking a
 * green stale would only invent a second phantom pointing the other way.
 */
export function evaluateGateVerdictFreshness(input: GateVerdictFreshnessInput): GateVerdictFreshness {
  const {
    consecutiveReds,
    observedAtMs,
    observedFromPin,
    currentGreenPinSha,
    lastFiredAtMs,
    retriageStaleTip,
    inFlightRetriage,
    candidateCommittedAtMs,
    commitsBehindTip,
    observedFromPinFresh,
  } = input;
  const intervalMs = input.intervalMs ?? GATE_FIRE_INTERVAL_MS;
  const fossilAgeMs = input.fossilAgeMs ?? CANDIDATE_FOSSIL_AGE_MS;

  // Rule 5's measurement, computed once. Deliberately relative to `observedAtMs` (verdict time),
  // not now-time — see `candidateCommittedAtMs`. A negative age means the writer's two clocks
  // disagree (clock skew, or a committer date in the future); that is not evidence of a fossil,
  // so it is treated as unavailable rather than folded into the comparison below.
  const candidateAgeMs =
    observedAtMs != null && candidateCommittedAtMs != null && observedAtMs >= candidateCommittedAtMs
      ? observedAtMs - candidateCommittedAtMs
      : null;

  // Only a RED verdict can misdirect. A stale green is inert.
  if (consecutiveReds <= 0) return { stale: false, reason: null, reasonCode: null, candidateAgeMs };

  // Rule 4 — REFIRE-IN-FLIGHT (EI-18669342433807110). Checked FIRST — this is live, RIGHT-NOW
  // evidence (a run is this moment re-verifying the exact red being read), more current than any
  // of the other three rules. Only trusted when the marker names the SAME candidate this cached
  // red was recorded against — a marker left over from an earlier, already-superseded red must
  // never silence a genuinely new, unrelated one.
  if (inFlightRetriage && observedFromPin && inFlightRetriage.fromCandidate === observedFromPin) {
    return {
      stale: true,
      reason:
        `a stale-candidate auto-refire for this exact red is IN FLIGHT right now ` +
        `(${describeRefireBudget(inFlightRetriage).label}, re-verifying tip ` +
        `${short(inFlightRetriage.refiringCandidate)}) — do NOT go fix the test(s) it names; a fresh ` +
        `verdict is imminent` +
        // EI-19343516395023183: at the cap the imminent verdict is the FINAL one, so "wait, it will
        // sort itself out" stops being true here. Saying so is the difference between waiting
        // correctly and waiting through the one red that was always going to stick.
        (describeRefireBudget(inFlightRetriage).atCap
          ? ` ⚠ this is the LAST refire — if it comes back red the verdict STICKS, so be ready to act on it`
          : ''),
      reasonCode: 'refire-in-flight',
      candidateAgeMs,
    };
  }

  // Rule 3 — RETRIAGE-PROVEN (EI-13288). Checked first of the post-hoc rules: this is the run's OWN evidence about
  // ITSELF (a real re-test it performed, not an inference from surrounding state), so it is the
  // most direct of the three rules. The gate held (correctly — the auto-refire cap bounds how
  // long we chase a moving tip), but the specific failing-test NAMES this verdict carries are
  // proven, by the run's own hand, not to reproduce at `retriageStaleTip`.
  if (retriageStaleTip) {
    return {
      stale: true,
      reason:
        `this verdict's own stale-candidate re-triage already re-ran its named failing file(s) at tip ` +
        `${short(retriageStaleTip)} and they PASSED — the auto-refire cap was reached before a full ` +
        `suite could confirm ${short(retriageStaleTip)} green, so the recorded failing-test names are ` +
        `unconfirmed at record time (they may already be fixed)`,
      reasonCode: 'retriage-proven',
      candidateAgeMs,
    };
  }

  // Rule 1 — PIN-ADVANCE. The pin only advances on a green checkpoint, so a pin that differs from
  // the one this red was recorded against is evidence a green happened.
  //
  // ⚠ EI-20571364274022293 — "a green happened" is NOT "a green happened SINCE THIS RED". The pin
  // comparison is order-BLIND: `observedFromPin` is the pin as the writer saw it, and nothing
  // constrains WHEN it stopped matching the live pin. Measured 2026-08-16: the pin had advanced
  // ~2h BEFORE the streak's first red, so the difference was a fossil of an OLD green — and this
  // rule reported `stale: true, 'pin-advance'` for a gate that could not even START, which
  // `pinProvenGateCorrection` then rendered as `consecutiveReds: 0`. A dead gate presented as a
  // healthy one, and the false green survived a retraction to the owner because the rule's own
  // documentation called it "hard proof". The ordering is what makes it proof; without the
  // ordering it is a coincidence of two shas.
  //
  // So: fire the PROOF code only when the green is ordered strictly AFTER the streak began;
  // DECLINE outright when it provably predates it (fall through — the later rules may still have
  // something true to say about this verdict); and when the ordering is simply unavailable, say
  // "unordered" rather than "proven".
  if (observedFromPin && currentGreenPinSha && short(currentGreenPinSha) !== short(observedFromPin)) {
    const advance = `${short(observedFromPin)} → ${short(currentGreenPinSha)}`;

    if (observedFromPinFresh === true) {
      return {
        stale: true,
        reason:
          `the release pin has advanced ${advance} since this red was recorded (the base pin was read ` +
          `live by the run that wrote this verdict, so the move happened AFTER it) — ` +
          `the pin only moves on a GREEN checkpoint, so the gate has provably greened since`,
        reasonCode: 'pin-advance',
        candidateAgeMs,
      };
    }

    return {
      stale: true,
      reason:
        `the release pin differs from this verdict's base (${advance}), but that base pin was NOT read live ` +
        `when the verdict was written — the writer carried a previous value forward because it could not ` +
        `resolve the pin — so it is UNKNOWN whether the pin moved before or after this red. Treat this red as ` +
        `UNVERIFIED, NOT as greened: do NOT reset the red streak on this evidence. Re-judge at tip ` +
        `(release:checkpoint-run) to settle it, and check whether the gate can resolve the release pin at all — ` +
        `a pin it cannot read is usually a gate that cannot run`,
      reasonCode: 'pin-advance-unordered',
      candidateAgeMs,
    };
  }

  // Rule 5 — CANDIDATE-FOSSIL (EI-19346660748445728). Placed AFTER rule 1 and BEFORE rule 2 on
  // purpose. Rule 1 outranks it: a pin-advance PROVES a green happened, which lets a caller reset
  // the streak outright, whereas a fossil only says the verdict is unreliable. Rule 2 ranks below
  // it: "the writer starved" is the weakest inference here and explains nothing about the verdict
  // itself, while this names a concrete, measured defect in what was judged. Both can hold at once
  // (an old verdict about an old candidate); the more explanatory one should be what a reader sees.
  if (candidateAgeMs != null && candidateAgeMs > fossilAgeMs) {
    const hrs = Math.round((candidateAgeMs / 3_600_000) * 10) / 10;
    return {
      stale: true,
      reason:
        `this verdict judged a commit that was ALREADY ${hrs}h old when the verdict was written` +
        (commitsBehindTip != null && commitsBehindTip > 0
          ? ` (${commitsBehindTip} commit(s) landed on staging that it never saw)`
          : '') +
        ` — far beyond the ~30min structural quiet-cut+suite window, so it describes neither the ` +
        `tree we would ship nor, most likely, current reality. Do NOT go fix the test(s) it names ` +
        `on this evidence: re-judge at tip first, and treat the fossil candidate itself as a bug ` +
        `in candidate selection`,
      reasonCode: 'candidate-fossil',
      candidateAgeMs,
    };
  }

  // Rule 2 — WRITER-STARVED. The routine fired again but produced no new verdict (its runs are
  // being skipped on the run-lock), so `consecutiveReds` is simply unverified. Note this reads
  // `last_fired_at`, which a `skipped-locked` no-op DOES refresh — that mismatch is the whole bug.
  if (observedAtMs != null && lastFiredAtMs != null && lastFiredAtMs > observedAtMs + intervalMs * 1.5) {
    const hrs = Math.round(((lastFiredAtMs - observedAtMs) / 3_600_000) * 10) / 10;
    return {
      stale: true,
      reason:
        `the green-checkpoint has fired since this verdict without producing a new one (last verdict ${hrs}h before the last fire), ` +
        `so this red is unverified. The CAUSE is not measured here: a fire produces no verdict when it is ` +
        `skipped on the run-lock, when a run is still executing, AND when a frozen repair queue is converging ` +
        `(those runs complete but return 'repair-in-progress', which is never banked). Establish which before ` +
        `acting — they demand opposite responses, and cancelling a healthy run destroys a real ~55min suite`,
      reasonCode: 'writer-starved',
      candidateAgeMs,
    };
  }

  // A blob predating `observedAt` cannot be judged by rule 2. Say so plainly instead of guessing:
  // absence of a timestamp is not evidence of freshness, but it is not evidence of staleness either.
  // `candidateAgeMs` still rides along: the ordinary ~30min window is worth surfacing on a verdict
  // that is NOT stale, and a caller that shows it cannot be surprised by it later.
  return { stale: false, reason: null, reasonCode: null, candidateAgeMs };
}
