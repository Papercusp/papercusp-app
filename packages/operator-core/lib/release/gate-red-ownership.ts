/**
 * Who, if anyone, already OWNS the current red gate — rendered for the humans and
 * agents who receive a gate-red alert (EI-18672078222841101).
 *
 * THE PROBLEM THIS EXISTS FOR. On 2026-07-26 between 02:09 and 02:24, THREE agents
 * independently ran the identical diagnosis of the identical gate leg, each reached the
 * same conclusion, and each independently decided not to re-fire the run. ~3x waste on a
 * strictly single-owner question, and it scales with fleet size. Each agent behaved
 * CORRECTLY: the su playbook says verbatim that a red gate blocking your work is YOURS to
 * green, and that rule is deliberate — it exists because a days-red gate previously sat
 * unowned for days. The collectively-wrong outcome came from the alert, not the rule.
 *
 * WHY THIS IS A RENDERING MODULE AND NOT A NEW REGISTRY. The system ALREADY computes
 * ownership at red time and has since P-012/D-009: `last_fixer` (green-checkpoint routine
 * metadata) is keyed by the stable FAILURE SIGNATURE, carries the dispatched fixer's
 * `spawnId`, and `releaseFixerSpawnAlive` resolves real liveness off it using the same
 * definition the fleet_assignment view and the stale-claim reconciler use.
 * `decideReleaseFixerDispatch` already returns reason:'covered' when a live fixer holds the
 * current signature. All of that is used for exactly ONE purpose — suppressing a duplicate
 * fixer dispatch — and is never shown to anyone. So the fix is to SURFACE the owner the
 * system already knows about; minting a parallel per-signature ownership record beside
 * `last_fixer` would be a second answer to a question the first one already answers.
 *
 * WHY NOT THE TWO OBVIOUS FIXES:
 *  - "Tell agents to check first": adds a round-trip for every recipient and STILL races —
 *    all three of the above started within ~10 minutes, so a check at t=0 shows nobody.
 *  - "Make the gate leader-only": breaks the deliberate "a red gate is everyone's problem"
 *    property that keeps a red gate from sitting unowned.
 * Hence `unowned` is a first-class, LOUD state here: the point is not to stop agents from
 * taking the gate, it is to stop them from taking it THREE TIMES.
 */

/**
 * The P-012 failure signature: what the release-fixer dedup is keyed on. Sorted failing
 * test files, falling back to the candidate sha when the verdict named no files.
 *
 * THIS EXISTS SO THE DERIVATION CANNOT DRIFT. It was inlined at the dispatcher
 * (`maybeDispatchReleaseFixer`) and again at the stall-alert; a third copy was about to be
 * added at the pipeline-snapshot read. Three hand-copies of a dedup key is how a renderer
 * ends up quietly disagreeing with the dispatcher about whether two reds are "the same
 * failure" — the exact class of bug this whole item is about. One definition, three callers.
 *
 * Sorted because the gate's `failingTests` order is not stable across runs, and the whole
 * point of the key is that the SAME failure re-detected on a LATER candidate hashes the
 * same (while the gate is red, staging advances hourly, so every checkpoint is a new sha).
 */
export function gateFailureSignature(
  failingTests: readonly string[] | null | undefined,
  candidate: string | null | undefined,
): string | null {
  if (failingTests && failingTests.length > 0) return failingTests.slice().sort().join(',');
  return candidate ?? null;
}

import { ownershipHeldByLiveHolder, type CellOwnership, type GateOwnershipAssessment } from '../coord/gate-ownership';
import type { ConditionClaimState } from '../coord/condition-object';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import {
  assessCriticalClaimProgressLease,
  CRITICAL_CLAIM_PROGRESS_LEASE_MS,
} from '../agent-tools/work_items/release-force-guard';

/** The ownership states a red gate can be in, most-covered first. */
export type GateRedOwnershipState =
  /** The recorded verdict is not current, so there may be no live red here at all — and the
   *  test names it carries must not be chased. Stand down until a fresh verdict lands. */
  | 'verdict-stale'
  /** A fixer holds the CURRENT signature and is confirmed alive. Stand down. */
  | 'owned-live'
  /** A fixer holds the current signature; liveness is unknowable (durable/legacy fire, no
   *  spawn id). `decideReleaseFixerDispatch` treats this as covered, so we do too. */
  | 'owned-unknown'
  /** A fixer was dispatched for this signature and is CONFIRMED GONE without clearing it.
   *  Genuinely unowned RIGHT NOW — and the most valuable state to name, because the alert
   *  prose ("a release-fixer is on it") is actively false here. */
  | 'owner-gone'
  /** A fixer exists but for a DIFFERENT failure signature — it is not working on this red. */
  | 'stale-signature'
  /** No fixer record at all. */
  | 'unowned'
  /**
   * NO automated fixer covers this red, but the gate's SINGLETON WORK-ITEM is held by a
   * holder the presence oracle positively reports as alive. A human/agent repair owner is
   * on it; stand down. See {@link composeGateRedOwnership} for why this is a composite
   * state on `state` rather than a sibling field nobody branches on.
   */
  | 'owned-by-repair-holder';

/**
 * The OTHER owner a red gate can have: the live singleton work-item holder.
 *
 * ── WHY THIS IS A SEPARATE BLOCK AND NOT A REWRITE OF THE FIXER FIELDS (P-008) ──
 * These are two different owners resolved by two different apparatus, and BOTH are
 * actionable at once. The automated fixer is a blueprint-launched spawn keyed by the
 * P-012 failure signature and resolved via `spawned_agents` heartbeat/PID liveness; the
 * repair owner is a `gate-red-streak:`/`green-stall:` condition singleton, claimed
 * through the ordinary work-item lease and falsified by the presence oracle.
 *
 * The first implementation of this composition (`canonicalRedOwner`, release-trace.ts,
 * 2026-09-02) SUBSTITUTED one for the other: on a live holder it replaced `gate.redOwner`
 * wholesale with `{ state:'owned-live', spawnId:null, ageMs:null }`. That made the trace
 * truthful about "is anyone on it" and simultaneously destroyed the answer to "did the
 * automated fixer die?" — which is the actionable half, because a dead fixer beside a live
 * holder is a fixer that needs re-dispatching, and a reader who cannot see it cannot know.
 * So the fixer verdict is PRESERVED verbatim in {@link GateRedOwnership.fixerState} and
 * this block is added beside it, never over it.
 */
export interface GateRepairOwner {
  /** The condition key the singleton owns (`gate-red-streak:` / `green-stall:`). */
  eventKey: string;
  /** The singleton work-item owning the incident, or null when nothing owns it yet. */
  workItem: string | null;
  /** The holder's coordination owner id. */
  takenBy: string | null;
  /**
   * The LEASE-derived claim state. NULL means UNMEASURED, never "nobody owns it" — the
   * same distinction `CellOwnership.claimState` draws, carried through unflattened.
   */
  claimState: ConditionClaimState | null;
  /** The presence oracle's INDEPENDENT verdict on the holder. Null = no verdict. */
  holderSessionState: SessionState | null;
  /** The closed assessment table's conclusion, carried through for a structured reader. */
  assessment: GateOwnershipAssessment | null;
  /**
   * POSITIVE liveness only, via `ownershipHeldByLiveHolder` — the SAME allowlist the
   * `release:checkpoint-run` stand-down rail uses, so the two can never disagree about
   * whether a peer is on the gate. False on every absence of evidence.
   */
  live: boolean;
  /** Newest genuine work-item progress (never a presence heartbeat), ISO. */
  lastProgressAt: string | null;
  /**
   * ms since the newest progress anchor (`lastProgressAt`, falling back to `takenAt`),
   * or null when neither is parseable — an UNMEASURED age, not a fresh one.
   */
  progressAgeMs: number | null;
  /**
   * Has the holder's ITEM progress gone stale past the shared critical-claim lease?
   *
   * ⚠ This deliberately does NOT flip `covered` to false. A live holder whose progress has
   * gone quiet is still the owner, and demoting them to "unowned" would re-create exactly
   * the pile-on this module exists to prevent (measured 2026-08-26: 37 distinct agents took
   * 97 stints on ONE gate item). The staleness is surfaced STRUCTURALLY here and named in
   * the label so a reader coordinates with the holder instead of racing them.
   */
  progressStale: boolean;
  /** The lease this staleness verdict was measured against, so a reader can re-derive it. */
  progressLeaseMs: number;
}

export interface GateRedOwnership {
  state: GateRedOwnershipState;
  /**
   * The AUTOMATED FIXER's own verdict, always, and never overwritten by the composition
   * in {@link composeGateRedOwnership}. Equal to `state` whenever no repair owner
   * displaced it. This is the field to read for "did the dispatched fixer survive?".
   */
  fixerState: GateRedOwnershipState;
  /**
   * The live singleton work-item holder, when ownership was resolvable. NULL means the
   * caller did not compose one in (or ownership was UNMEASURED) — never "nobody holds it";
   * a MEASURED absence arrives as a block whose `claimState` is `'no-object'`.
   */
  repairOwner: GateRepairOwner | null;
  /** True only when a responder should stand down rather than investigate. */
  covered: boolean;
  /** The dispatched fixer's spawn id, when there is one to name. */
  spawnId: string | null;
  /** The signature the recorded fixer is actually working on. */
  ownerSignature: string | null;
  /** ms since that fixer was dispatched, when known. */
  ageMs: number | null;
  /** One line, safe to paste into an alert body or a tool result. */
  label: string;
}

export interface GateRedOwnershipInput {
  /** `last_fixer.signature` — the failure signature the recorded fixer was dispatched for. */
  ownerSignature?: string | null;
  /** The signature of the red being reported RIGHT NOW. */
  currentSignature?: string | null;
  /** `last_fixer.at` (epoch ms). */
  dispatchedAtMs?: number | null;
  /** `last_fixer.spawnId`. */
  spawnId?: string | null;
  /** `releaseFixerSpawnAlive` result: true=alive, false=confirmed gone, null=unknowable.
   *  Deliberately the SAME tri-state that `decideReleaseFixerDispatch` consumes, so this
   *  renderer can never disagree with the dispatcher about who is covering the gate. */
  fixerAlive?: boolean | null;
  /**
   * WI-4489/EI-18669342433807110: is the recorded verdict itself stale (a `skipped-locked`
   * fire refreshes `last_fired_at` while writing no verdict, so `consecutiveReds` and
   * `failingTests` can be hours old while the routine looks healthy)?
   *
   * This is here because a stale verdict is the OTHER way this alert wastes a fleet's time,
   * and it is not hypothetical: at 02:19 on 2026-07-26 `release:trace` reported
   * failingTests ["lint:identity-leak"] from a verdict on candidate 221dc407 while the live
   * red was an entirely different leg. Two agents (me included) went and diagnosed the
   * named-but-already-fixed leg. An unowned-looking red whose verdict predates the current
   * candidate must not read as "free to claim" — there may be nothing there to claim.
   */
  verdictStale?: boolean;
  nowMs: number;
}

/** The fixer half alone, before {@link composeGateRedOwnership} attaches the repair half. */
type FixerOnlyOwnership = Omit<GateRedOwnership, 'fixerState' | 'repairOwner'>;

function humanAge(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'unknown age';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * PURE. Decide + render who owns the current red.
 *
 * Note the signature comparison is what makes this meaningful rather than decorative:
 * while the gate stays red, staging advances hourly so every checkpoint is a NEW candidate
 * — which is precisely why P-012 keyed the dedup on the signature and not the sha. A
 * surface that reports `lastFixerCandidate` (as the pipeline snapshot did) therefore tells
 * a reader almost nothing about whether anyone is on THIS failure.
 */
function describeFixerOwnership(input: GateRedOwnershipInput): FixerOnlyOwnership {
  const ownerSignature = input.ownerSignature ?? null;
  const currentSignature = input.currentSignature ?? null;
  const spawnId = input.spawnId ?? null;
  const dispatchedAtMs =
    typeof input.dispatchedAtMs === 'number' && Number.isFinite(input.dispatchedAtMs)
      ? input.dispatchedAtMs
      : null;
  const ageMs = dispatchedAtMs != null ? Math.max(0, input.nowMs - dispatchedAtMs) : null;
  const who = spawnId ? `release-fixer ${spawnId}` : 'a release-fixer';

  // Checked FIRST and before any ownership reasoning: if the verdict is not current then
  // neither is `currentSignature`, so every answer below would be computed against names
  // that may already be fixed. "Nobody owns it" and "there may be nothing to own" demand
  // the same immediate response (stand down) but for opposite reasons — say which.
  if (input.verdictStale === true) {
    return {
      state: 'verdict-stale',
      covered: true,
      spawnId,
      ownerSignature,
      ageMs,
      label:
        'STALE VERDICT — this red is from an older verdict and may already be fixed. Do NOT ' +
        'diagnose the failures it names; get a fresh verdict (release:checkpoint-run) first.',
    };
  }

  if (!ownerSignature) {
    return {
      state: 'unowned',
      covered: false,
      spawnId: null,
      ownerSignature: null,
      ageMs: null,
      label: 'UNOWNED — no release-fixer has been dispatched for this red. Claim it before investigating.',
    };
  }

  // A fixer on a DIFFERENT failure is not covering this one. Only compare when we actually
  // know the current signature — with it unknown we cannot claim a mismatch, so fall
  // through to the liveness answer rather than inventing a false 'stale-signature'.
  if (currentSignature && ownerSignature !== currentSignature) {
    return {
      state: 'stale-signature',
      covered: false,
      spawnId,
      ownerSignature,
      ageMs,
      label:
        `UNOWNED — the last release-fixer (dispatched ${humanAge(ageMs)}) is working a DIFFERENT failure ` +
        `(${ownerSignature}), not this one. Claim this red before investigating.`,
    };
  }

  if (input.fixerAlive === false) {
    return {
      state: 'owner-gone',
      covered: false,
      spawnId,
      ownerSignature,
      ageMs,
      label:
        `UNOWNED — ${who} was dispatched ${humanAge(ageMs)} but is CONFIRMED GONE without clearing this red. ` +
        `Claim it before investigating.`,
    };
  }

  const unknown = input.fixerAlive == null;
  return {
    state: unknown ? 'owned-unknown' : 'owned-live',
    covered: true,
    spawnId,
    ownerSignature,
    ageMs,
    label:
      `OWNED — ${who} has been on this exact failure since ${humanAge(ageMs)}` +
      (unknown
        ? ' (liveness unknowable: durable fire with no spawn id — treated as covered).'
        : ' and is alive.') +
      // EI-18696737036975615: the old text said "coordinate with the owner instead" — but a
      // release-fixer is a blueprint-launched spawn with NO coordination-roster identity
      // (confirmed: harness_shared.spawned_agents.session_owner/session_id are null even for
      // a LIVE fixer spawn, not just a finished one), so coord:send addressed at spawnId always
      // comes back unknown_recipient. That left a reader with two instructions — "don't
      // diagnose" and "coordinate instead" — where the second was never actually possible,
      // which is worse than no instruction: it invites either silently dropping real evidence
      // or doing the forbidden parallel diagnosis anyway. Say what IS true and actionable.
      ' Do NOT start a parallel diagnosis: release-fixer spawns have no coordination-roster ' +
      'identity, so coord:send to this spawnId will fail (unknown_recipient) — "coordinate ' +
      "with the owner\" is not literally possible here. If you already have relevant evidence, " +
      'file it (improvements:capture or a work-item comment) referencing this failure signature ' +
      'so it is not lost, then stand down and wait for the fresh verdict via checkpoint:await.',
  };
}

/**
 * PURE. The automated-fixer verdict alone, with the repair half left explicitly UNREAD.
 *
 * `repairOwner: null` here means "this caller did not compose one in", which is why the
 * field's doc forbids reading it as "nobody holds the item". A caller that CAN resolve
 * ownership must pass it through {@link composeGateRedOwnership}; one that cannot (a
 * fixer-only alert rung) gets a shape that says so rather than a fabricated absence.
 */
export function describeGateRedOwnership(input: GateRedOwnershipInput): GateRedOwnership {
  const fixer = describeFixerOwnership(input);
  return { ...fixer, fixerState: fixer.state, repairOwner: null };
}

/** A duration, not a point in time — `humanAge` renders "5m ago", this renders "5m". */
function humanSpan(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'an unknown period';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins}m`;
  return `${Math.round(mins / 60)}h`;
}

/**
 * PURE. Project the gate's ownership cell onto the repair half of {@link GateRedOwnership}.
 *
 * Every derived field delegates rather than re-deriving: `live` is
 * `ownershipHeldByLiveHolder` (the same POSITIVE-only allowlist `release:checkpoint-run`'s
 * stand-down rail uses) and the freshness verdict is `assessCriticalClaimProgressLease`
 * (the same lease `work_items:release force:true` uses to decide a claim is abandoned).
 * Both are deliberate: a second opinion about one holder's liveness — or about when a
 * claim has gone quiet — is how two surfaces end up contradicting each other about a
 * single red, which is the whole defect P-008 exists to close.
 */
export function projectGateRepairOwner(
  ownership: CellOwnership | null | undefined,
  nowMs: number,
  progressLeaseMs: number = CRITICAL_CLAIM_PROGRESS_LEASE_MS,
): GateRepairOwner | null {
  if (!ownership) return null;
  const lease = assessCriticalClaimProgressLease({
    takenAt: ownership.takenAt,
    lastProgressAt: ownership.lastProgressAt,
    nowMs,
    leaseMs: progressLeaseMs,
  });
  return {
    eventKey: ownership.eventKey,
    workItem: ownership.workItem,
    takenBy: ownership.takenBy,
    claimState: ownership.claimState,
    holderSessionState: ownership.holderSessionState,
    assessment: ownership.assessment,
    live: ownershipHeldByLiveHolder(ownership),
    lastProgressAt: ownership.lastProgressAt,
    progressAgeMs: lease.ageMs,
    progressStale: lease.expired,
    progressLeaseMs: lease.leaseMs,
  };
}

/**
 * Does a fixer verdict, ON ITS OWN, cover the red?
 *
 * Derived from the STATE rather than read off `GateRedOwnership.covered`, because on an
 * already-composed value that boolean reports the COMPOSITE's cover — so reading it would
 * make a second composition treat a live holder's cover as the fixer's own and re-enter
 * the wrong branch. Caught by the idempotence test, not by inspection.
 *
 * A `Record<GateRedOwnershipState, …>` so a new state is a compile error demanding a
 * decision here, never a silent default.
 */
const FIXER_COVERS: Record<GateRedOwnershipState, boolean> = {
  'verdict-stale': true,
  'owned-live': true,
  'owned-unknown': true,
  'owner-gone': false,
  'stale-signature': false,
  unowned: false,
  // Not a fixer verdict at all — it is the composite this table feeds. It can never
  // legitimately appear as a `fixerState`; answering false keeps a corrupted input
  // fail-OPEN (an agent investigates a covered red) rather than fail-silent.
  'owned-by-repair-holder': false,
};

/** Does this block describe an ACTUAL claim, as opposed to a measured "nobody owns it"? */
function repairOwnerIsRecorded(repair: GateRepairOwner): boolean {
  return repair.workItem != null || (repair.claimState != null && repair.claimState !== 'no-object');
}

function repairOwnerSentence(repair: GateRepairOwner): string {
  const item = repair.workItem ?? '(work-item unavailable)';
  const who = repair.takenBy ?? 'an unnamed holder';
  const session = repair.holderSessionState ?? 'unmeasured';
  const freshness = repair.progressStale
    ? ` Its item progress has been QUIET for ${humanSpan(repair.progressAgeMs)} (lease ${humanSpan(
        repair.progressLeaseMs,
      )}) — a live holder that has gone quiet is still the owner, so coordinate (coord:send ${who}) or read ${item} rather than opening a second diagnosis.`
    : repair.progressAgeMs == null
      ? ' Its progress freshness is UNMEASURED (no parseable progress or claim timestamp) — that is an unread measurement, not a fresh one.'
      : ` Last genuine item progress ${humanAge(repair.progressAgeMs)}.`;
  return `the gate singleton ${item} is held by ${who} (session ${session})${freshness}`;
}

/**
 * PURE. Compose the AUTOMATED FIXER verdict with the LIVE SINGLETON WORK-ITEM HOLDER.
 *
 * ── THE DEFECT THIS CLOSES (P-008, EI-21271478314960803 / EI-21161168765519905) ──────
 * `describeGateRedOwnership` can only see `last_fixer`. When the dispatched fixer died
 * without clearing the red it renders `owner-gone` — "UNOWNED — claim it before
 * investigating" — and that sentence is ACTIVELY FALSE whenever a live agent holds the
 * gate's condition singleton and is repairing it. Measured 2026-08-23: a trace named a
 * 32h-dead fixer as the reason to claim a red that `dev:pipeline_position` showed was held
 * by a live owner in the same minute. The cost of that false invitation is not abstract —
 * 37 distinct agents took 97 stints on ONE gate item on 2026-08-26.
 *
 * ── WHY THE COMPOSITE LANDS ON `state` AND NOT A SIBLING FIELD ────────────────────────
 * Because `state` is what readers branch on. The canonical corrected recipe in
 * `agent-insights/release-fixer-liveness-check-release-trace-redowner-not-coord-presence`
 * literally returns `{ verdict: redOwner.state, covered: redOwner.covered }`, so a
 * truthful sibling field beside an untouched `state: 'owner-gone'` would still deliver the
 * bare owner-gone the acceptance forbids. The fixer's own verdict is preserved unchanged
 * in `fixerState`, which is what "report the two separately" means here: two fields, two
 * apparatus, neither overwritten — as opposed to the substitution this replaces.
 *
 * ── ORDERING IS LOAD-BEARING ─────────────────────────────────────────────────────────
 *  1. `verdict-stale` wins outright and is returned untouched. A stale verdict means the
 *     failure names may already be fixed, so "who owns it" is the wrong question and the
 *     stand-down-and-get-a-fresh-verdict instruction must not be diluted. This is also
 *     what keeps gate-stop-chasing-the-tip behaviour unchanged.
 *  2. A fixer that covers THIS signature keeps its verdict; a live holder beside it is
 *     appended to the label, never used to displace it.
 *  3. Only then does a positively-live holder promote the state.
 *  4. A recorded-but-not-positively-live holder does NOT promote it — that would stand
 *     agents down on an absence of evidence — but it is NAMED, so the owner-gone is never
 *     bare and the reader knows a claim exists to confirm rather than a vacuum to fill.
 *
 * Idempotent: re-composing an already-composed value re-reads `fixerState`, so a caller
 * that composes twice (a snapshot passed through two layers) cannot promote the fixer's
 * verdict into its own history.
 */
export function composeGateRedOwnership(input: {
  fixer: GateRedOwnership;
  repairOwner: GateRepairOwner | null;
  /**
   * A cover reason resolved from an authority this module cannot see — today only
   * `release:trace`'s live checkpoint run-lock, which proves the gate is EXECUTING even
   * when no work-item claim exists. Applied last and only when nothing above covered,
   * so it can add cover but never mask a fixer or holder verdict.
   */
  executorCover?: { label: string } | null;
  /**
   * The CALLER's own staleness verdict, when it holds one the fixer record does not
   * (`ReleaseTraceGate.verdictStale` is measured separately from the `verdictStale` fed
   * into `describeGateRedOwnership`). True suppresses every promotion below, exactly as
   * a `fixerState` of `'verdict-stale'` does — a stale verdict must never be dressed up
   * as covered ownership, whichever apparatus noticed it.
   */
  verdictStale?: boolean;
}): GateRedOwnership {
  const { fixer, repairOwner } = input;
  // Re-read rather than trust `state`: composing twice must not treat a promoted
  // composite as if it were the fixer's own verdict.
  const fixerState = fixer.fixerState ?? fixer.state;
  const fixerCovered = FIXER_COVERS[fixerState];
  // A value that already carries a repair block has been composed before, so its `label`
  // already carries whatever this pass would append. Structural, not string-sniffing:
  // an uncomposed fixer verdict always has `repairOwner === null`.
  const alreadyComposed = fixer.repairOwner != null;
  const base: GateRedOwnership = {
    ...fixer,
    state: fixerState,
    covered: fixerCovered,
    fixerState,
    repairOwner,
  };
  const executorCover = input.executorCover ?? null;

  if (fixerState === 'verdict-stale' || input.verdictStale === true) return base;

  const recorded = repairOwner != null && repairOwnerIsRecorded(repairOwner);

  if (fixerCovered) {
    if (!recorded || !repairOwner!.live || alreadyComposed) return base;
    return { ...base, label: `${fixer.label} ALSO: ${repairOwnerSentence(repairOwner!)}` };
  }

  if (recorded && repairOwner!.live) {
    const fixerNote =
      fixerState === 'owner-gone'
        ? ` The automated release-fixer${fixer.spawnId ? ` ${fixer.spawnId}` : ''} dispatched ${humanAge(
            fixer.ageMs,
          )} is CONFIRMED GONE — that is worth reporting to the holder (it may need re-dispatching), but it does NOT mean this red is unowned.`
        : fixerState === 'stale-signature'
          ? ` The last automated release-fixer is working a DIFFERENT failure (${fixer.ownerSignature}), so it is not covering this one.`
          : ' No automated release-fixer has been dispatched for this red.';
    return {
      ...base,
      state: 'owned-by-repair-holder',
      covered: true,
      label:
        `OWNED — ${repairOwnerSentence(repairOwner!)}${fixerNote} Do NOT start a parallel diagnosis or ` +
        'claim this red; send any evidence you already have to the holder or file it on that work-item, ' +
        'then await the next checkpoint verdict.',
    };
  }

  if (recorded) {
    if (alreadyComposed) return base;
    const session = repairOwner!.holderSessionState ?? 'unmeasured';
    return {
      ...base,
      label:
        `${fixer.label} A gate singleton DOES exist — ${repairOwnerSentence(repairOwner!)} — but its holder ` +
        `is not POSITIVELY live (session ${session}), which is an absence of evidence rather than a confirmed ` +
        'abandonment: confirm with a required wake (coord:send wake:"required") before treating the claim as free.',
    };
  }

  if (executorCover) {
    return { ...base, covered: true, state: 'owned-live', label: executorCover.label };
  }

  return base;
}
