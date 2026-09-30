/**
 * gate-ownership.ts — P-004 of `gate-ownership-condition-singleton-2026-08-03`.
 *
 * Folds "who owns this incident" onto the gate state cells, so an agent reading
 * `gate.greenCheckpoint.verdict` learns whether someone is ALREADY on the red
 * before it files the seventh work-item about it.
 *
 * ── WHY THIS IS A SEPARATE MODULE ─────────────────────────────────────────────
 * The natural place is inline in `git-pipeline-position.ts`, which owns both gate
 * cells. That file is 3,400 lines and its resolver is not unit-testable without a
 * repo + a snapshot. The interesting logic here — the projection, and the two
 * misreads it has to defend against — is pure, so it lives where it can be tested
 * with no git and no database.
 *
 * ── THE EVENT KEY, VERIFIED RATHER THAN ASSUMED (D-012) ───────────────────────
 * `green-stall:<harness>` is the gate's condition, confirmed against the live
 * alarm text rather than inferred from the name:
 *
 *   green-stall:papercusp        "green-checkpoint STALLED on papercusp — no green
 *                                 verdicts; deploys frozen."          <- THIS cell
 *   main-behind-staging:papercusp "main is 52 commits behind staging — promotion
 *                                 pipeline stalled."                  <- the SIBLING
 *                                 falsifier cell (git.mainBehindStaging), not this one
 *
 * Both read as "the pipeline is stalled" in English, and they are measured by
 * different apparatus — which is exactly why `GATE_VERDICT_CELL` and the
 * main-behind cell are declared MUTUAL FALSIFIERS. Attaching the wrong key here
 * would quietly point the gate's ownership at the other cell's incident.
 */
import { findConditionObjects, type ConditionClaimState, type ConditionObject } from './condition-object';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { cellUnknown, type CellUnknown } from '../cell-contract';
import { noSubjectThread, readCellThread, unmeasuredThread, type CellThread } from './cell-thread';
import { resolveSessionStates } from '../agent-tools/coordination/liveness-oracle';
import { needsLivenessConfirmation, type SessionState } from '../agent-tools/coordination/presence-wakeability';
import { assessCriticalClaimProgressLease } from '../agent-tools/work_items/release-force-guard';

/**
 * The condition whose lifetime IS a green-checkpoint stall.
 *
 * Emitted by `green-stall-watchdog.ts` as `green-stall:${row.install_slug}` — a
 * SLUG-suffixed family, so unlike `single-primary:` the harness is recoverable
 * from the key (see D-012 for why that is worth stating per-family rather than
 * assuming).
 */
export function gateStallConditionKey(harness: string): string {
  return `green-stall:${harness}`;
}

/**
 * The condition whose lifetime IS a RED gate — distinct from the stall above.
 *
 * ── WHY A SECOND KEY AND NOT A RE-POINT (P-005, and D-012/D-013 read literally) ─
 * `green-stall:` is the gate NOT PRODUCING verdicts: its two legs are fire-staleness
 * (the routine engine is not running it) and a 12h no-green backstop. A gate that
 * fires hourly and reds every time is the OPPOSITE state — the apparatus is healthy
 * and the answer is "no" — and the two need different responses (recover the engine
 * vs. fix the failing suite). Measured: `green-checkpoint:red` existed ONLY as an
 * event key (release-checkpoint-launch.ts) and NEVER as a conditionKey, so a plain
 * red gate had no condition at all, and therefore no ownable work-item — which is
 * why a 6-red streak could hold `main` for ~4h while `claimState` read `no-object`.
 *
 * So this is ADDITIVE: `green-stall:` keeps its existing meaning and stays the key
 * behind `gate.greenCheckpoint.verdict`'s ownership block.
 *
 * ⚠ BOTH CAN BE OPEN AT ONCE, deliberately, and a responder should know it. A red
 * streak that outlives the 12h no-green backstop opens `green-stall:` too, so one
 * gate can carry two owning work-items. That is accepted rather than suppressed:
 * cross-process suppression would couple two watchdogs that run in different
 * processes on different cadences, and the failure mode of getting THAT wrong is a
 * red gate with no owner at all — strictly worse than one with two. The alarm body
 * names the sibling instead, so the second claimant learns it from the alert rather
 * than from re-deriving it. See the plan Decision for the full trade-off.
 */
export function gateRedStreakConditionKey(harness: string): string {
  return `gate-red-streak:${harness}`;
}

/**
 * Ownership of the incident a state cell describes.
 *
 * ⚠ TWO MISREADS THIS BLOCK INVITES, both of which turn a helpful field into a
 * confidently wrong conclusion. They are the reason `claimState` is an explicit
 * enum and the reason this doc-block exists:
 *
 *   1. `claimState: 'no-object'` does NOT mean "the gate is fine". It means no
 *      work-item owns the condition — which is equally true of a healthy gate and
 *      of a red one nobody has filed yet. OWNERSHIP IS ORTHOGONAL TO REDNESS: read
 *      `gate.consecutiveReds` / `verdictStale` for the gate's health, and this
 *      block only for "is someone already on it".
 *
 *   2. `takenBy != null` does NOT mean someone is working on it. A dead agent's
 *      abandoned lease has a non-null `takenBy` forever. That is what separates
 *      `held` from `lease-expired`, and why a caller must branch on `claimState`
 *      rather than null-testing `takenBy` — reporting a dead holder as live
 *      ownership is worse than reporting none, because it suppresses the next
 *      agent from picking the work up.
 *
 * `lease-expired` is still only a LEASE check — it asks whether the claim's clock
 * ran out, not whether the holder is alive. An agent that died holding a long
 * lease reads `held` here. Closing that gap is P-005's falsifier
 * (`ownership.holderSessionState`, measured by the presence oracle), which is a
 * deliberately independent apparatus rather than a refinement of this field.
 */
export interface CellOwnership {
  /**
   * Decision-ready ownership conclusion, derived once from the claim + liveness
   * truth table. `null` means the required claim-state measurement was
   * unavailable; callers must not infer an owner state from the nullable raw
   * fields in that case.
   */
  assessment: GateOwnershipAssessment | null;
  /** The condition key this cell's incident is keyed by. */
  eventKey: string;
  /** The singleton work-item owning it, or null when nothing owns it yet. */
  workItem: string | null;
  /**
   * EXPLICIT — never infer this from which of the fields below are null.
   *
   * NULL means UNMEASURED (see `unknown`), which is deliberately NOT the same
   * value as `'no-object'`. P-004 shipped this as a non-null enum that degraded to
   * `'no-object'` when the store was unreachable — so "nobody owns this" and "we
   * could not tell" were the same byte, and the failure read as the reassuring
   * one. Registering the cell forced the question (`CellSpec` axis 2: can the
   * verdict be unknown?) and the honest answer is yes.
   */
  claimState: ConditionClaimState | null;
  /** In-band unknown, non-null exactly when `claimState` is null. */
  unknown: CellUnknown | null;
  takenBy: string | null;
  takenAt: string | null;
  /** Genuine work-item progress; never inferred from presence heartbeat. */
  lastProgressAt: string | null;
  expiresAt: string | null;
  /**
   * THE FALSIFIER (P-005). The holder's liveness per the presence oracle —
   * INDEPENDENT apparatus from `claimState`, which is computed purely from the
   * work-item's own lease columns (`taken_by`, `expires_at`).
   *
   * That independence is the entire point. A lease expires on a CLOCK, so a claim
   * with a long or absent expiry reads `held` forever — including one held by an
   * agent that died minutes after taking it. The oracle measures something the
   * lease cannot see (heartbeat, wakeability, a pid probe, recorded sessions), so
   * `claimState: 'held'` + `holderSessionState: 'ended'` is the exact contradiction
   * this field exists to expose.
   *
   * ⚠ Do NOT substitute `heartbeatFresh` if you ever reach for the raw verdict:
   * that is process-keepalive freshness, not a liveness verdict, and a warm-dead
   * session reads `heartbeatFresh: true` with `sessionState: 'ended'`.
   *
   * NULL when there is no holder to measure, or when the oracle could not answer —
   * both of which mean "no contradiction established", never "the holder is live".
   */
  holderSessionState: SessionState | null;
  /**
   * Extra open work-items on the SAME key beyond the canonical one.
   *
   * Expected EMPTY now that P-002's partial unique index is enforcing. A non-empty
   * value means rows predating the index (or hand-set keys) — surfaced rather than
   * hidden, because a silently-picked canonical row is how a duplicate becomes
   * invisible instead of fixed.
   */
  duplicates: readonly string[];
  /**
   * P-006. What has already been SAID about this incident — the last few posts on
   * the owning work-item's thread, plus pointers to the areas it is filed under.
   *
   * ⚠ ADVISORY PAYLOAD, deliberately OUTSIDE this cell's falsifier contract
   * (D-006). The falsifier is `holderSessionState`, which measures the HOLDER; a
   * prose excerpt asserts nothing beyond "these bytes were posted", so there is no
   * apparatus that could contradict it. Do not reach for it when you want to know
   * whether the ownership above is TRUE — it answers a different question ("has
   * anyone explained this yet"), and treating a confident-sounding comment as
   * evidence about the claim is how a stale message outranks a measurement.
   */
  thread: CellThread;
}

export type GateOwnershipAssessment =
  | 'duplicate-owners'
  | 'unowned'
  | 'claimable'
  | 'hold-blocked'
  | 'lease-expired'
  | 'held-live'
  | 'held-stalled'
  | 'held-needs-confirmation'
  | 'held-by-ended-session';

/**
 * PURE. The closed assessment table for `gate.greenCheckpoint.ownership`.
 *
 * Order is load-bearing: duplicates outrank whichever canonical row happened to
 * be selected, and a held claim is not called live until the independent
 * session oracle positively says so. A positively-live claim is only called
 * `held-stalled` when the shared critical-claim progress lease has expired;
 * presence alone is not evidence that this item is moving. A new claim or
 * session state is therefore a compile-time exhaustiveness failure rather than
 * a reassuring default.
 */
export function assessGateOwnership(input: {
  claimState: ConditionClaimState | null;
  holderSessionState: SessionState | null;
  duplicates: readonly string[];
  /** Genuine item progress, with takenAt as the new-claim fallback anchor. */
  takenAt?: string | Date | null;
  lastProgressAt?: string | Date | null;
  /** Injected for deterministic callers/tests; defaults inside the shared helper. */
  nowMs?: number;
}): GateOwnershipAssessment | null {
  if (input.claimState === null) return null;
  if (input.duplicates.length > 0) return 'duplicate-owners';

  switch (input.claimState) {
    case 'no-object':
      return 'unowned';
    case 'claimable':
      return 'claimable';
    case 'hold-blocked':
      return 'hold-blocked';
    case 'lease-expired':
      return 'lease-expired';
    case 'held':
      switch (input.holderSessionState) {
        case 'live':
        case 'parked':
        case 'recorded':
          return assessCriticalClaimProgressLease({
            takenAt: input.takenAt ?? null,
            lastProgressAt: input.lastProgressAt ?? null,
            nowMs: input.nowMs,
          }).expired
            ? 'held-stalled'
            : 'held-live';
        case 'draining':
        case 'suspect':
        case null:
          return 'held-needs-confirmation';
        case 'ended':
          return 'held-by-ended-session';
        default: {
          const exhaustive: never = input.holderSessionState;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = input.claimState;
      return exhaustive;
    }
  }
}

/** PURE. Project a resolved condition onto a cell's ownership block. */
export function toCellOwnership(
  obj: ConditionObject,
  holderSessionState: SessionState | null = null,
  thread: CellThread = noSubjectThread('thread not read on this projection'),
  nowMs?: number,
): CellOwnership {
  return {
    assessment: assessGateOwnership({
      claimState: obj.claimState,
      holderSessionState,
      duplicates: obj.duplicates,
      takenAt: obj.takenAt,
      lastProgressAt: obj.lastProgressAt,
      nowMs,
    }),
    eventKey: obj.conditionKey,
    workItem: obj.workItem,
    claimState: obj.claimState,
    unknown: null,
    takenBy: obj.takenBy,
    takenAt: obj.takenAt,
    lastProgressAt: obj.lastProgressAt,
    expiresAt: obj.expiresAt,
    holderSessionState,
    duplicates: obj.duplicates,
    thread,
  };
}

/**
 * PURE. A MEASURED "nobody owns this" — the store answered and found nothing.
 *
 * Distinct from {@link unmeasuredCell}. Collapsing the two is the bug the
 * `claimState` doc describes.
 */
export function unownedCell(eventKey: string): CellOwnership {
  return {
    assessment: 'unowned',
    eventKey,
    workItem: null,
    claimState: 'no-object',
    unknown: null,
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    // Nothing owns the condition, so there is no thread to have — FINAL
    // (`not-applicable`), not an empty one and not a failed read.
    thread: noSubjectThread('no work-item owns this condition, so there is no thread to read'),
  };
}

/** PURE. Ownership could NOT be read — never rendered as "nobody owns this". */
export function unmeasuredCell(eventKey: string, detail: string): CellOwnership {
  return {
    assessment: null,
    eventKey,
    workItem: null,
    claimState: null,
    unknown: cellUnknown('resolver-failed', detail),
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    // Ownership was unreadable, so the thread is unknown TOO — never silence.
    // Reporting "nothing was said" here would restate the failure as reassurance.
    thread: unmeasuredThread(`ownership unreadable, so its thread was not read: ${detail}`),
  };
}

/**
 * PURE. Does the lease-derived claim CONTRADICT the presence oracle?
 *
 * The falsifier's verdict in one call, so a consumer never has to re-derive the
 * comparison — which is worth a helper precisely because re-deriving it is easy
 * to get subtly, expensively wrong. Two states look dead and are not:
 *
 *   - `parked`   — alive and inbox-wakeable, just idle. The IDEAL dispatch target.
 *   - `recorded` — ⚠ ALIVE. Authoritatively live per the session log
 *                  (`adv_sessions.ended_at IS NULL`), merely not yet
 *                  coord-wake-dispatchable. The oracle classifies it BEFORE the
 *                  heartbeat/pid path expressly "so it is never force-ended"
 *                  (liveness-oracle.ts). It covers EVERY console/autonomous agent
 *                  and any interactive session inside its launch→first-await
 *                  window — a large, ordinary population, not an exotic case.
 *
 * This function shipped in P-005 counting `recorded` as a contradiction. That was
 * backwards, and backwards in the costly direction: the falsifier exists to stop a
 * DEAD holder being reported as live ownership, and instead it reported a LIVE
 * holder as an abandoned claim — an invitation to take work off an agent that is
 * actively doing it. Fixed 2026-08-03 (P-007), untested until then because the
 * P-005 suite exercised only `ended` and `parked`.
 *
 * ONLY `ended` is a confirmed contradiction: not wakeable AND no authoritative
 * liveness signal. `draining` and `suspect` are deliberately NOT contradictions —
 * they are AMBIGUOUS, and the shared oracle says so itself; route them through
 * {@link ownershipNeedsLivenessConfirmation} and confirm with a required wake
 * before treating the claim as abandoned.
 */
export function ownershipContradicted(own: CellOwnership): boolean {
  if (own.claimState !== 'held') return false;
  return own.holderSessionState === 'ended';
}

/**
 * PURE. Is the holder's liveness too AMBIGUOUS to act on without confirming?
 *
 * `true` for `draining` / `suspect` — a stale heartbeat with a wake still armed,
 * or a process confirmed gone while claims may still need reconciliation. Both
 * need a fresh required wake before a coordinator concludes anything. `null` when
 * there is no verdict to judge (no holder, or the oracle could not answer).
 *
 * DELEGATES to the presence module's own `needsLivenessConfirmation` rather than
 * re-listing the states here. That delegation is the actual fix for the bug above:
 * the defect was not a typo, it was this file inventing its own liveness taxonomy
 * beside the module that owns one. A future state added to `SessionState` now
 * reaches this verdict automatically instead of silently defaulting to "alive".
 */
export function ownershipNeedsLivenessConfirmation(own: CellOwnership): boolean | null {
  if (own.claimState !== 'held' || own.holderSessionState === null) return null;
  return needsLivenessConfirmation(own.holderSessionState);
}

/**
 * The THIRD verdict, and the only one that is an explicit ALLOWLIST.
 *
 * `ownershipContradicted` answers "confirmed dead" and
 * `ownershipNeedsLivenessConfirmation` answers "too ambiguous to act on". Neither
 * answers the question a COORDINATION rail actually asks — "is a peer positively
 * on this right now, so I should stand down?" — and deriving it as the complement
 * of the other two is wrong in a way that matters.
 *
 * A complement would classify any state added to `SessionState` later as
 * positively-live, i.e. it would REFUSE on a state nobody has reasoned about.
 * For this rail that is the wrong default: the run-lock singleton is the real
 * safety mechanism, this is coordination on top of it, so an unknown verdict must
 * FAIL OPEN (let the run through) rather than wedge the gate for the whole fleet
 * on an enum change. Hence an allowlist — but a `Record<SessionState, …>`, so a
 * new member is a COMPILE ERROR demanding a decision, never a silent default.
 * That is the structural half of the D-018 lesson: the P-005 bug was not a wrong
 * string, it was a hand-rolled liveness taxonomy that no type forced anyone to
 * revisit.
 */
const POSITIVELY_LIVE: Record<SessionState, boolean> = {
  live: true,
  // Alive and inbox-wakeable, merely idle — a peer between turns still owns its work.
  parked: true,
  // ⚠ ALIVE per the session log (see ownershipContradicted's note). Excluding it
  // here would re-introduce the P-005 bug on the rail instead of in the helper.
  recorded: true,
  // AMBIGUOUS — route via ownershipNeedsLivenessConfirmation and confirm with a
  // required wake. Never enough on its own to block a peer's gate run.
  draining: false,
  suspect: false,
  // Confirmed dead. A dead holder must NEVER wedge the gate.
  ended: false,
};

/**
 * PURE. Is this claim held by a holder the oracle POSITIVELY reports as alive?
 *
 * `false` whenever the answer is not a positive yes — no holder, an unread oracle
 * (`null`), an ambiguous verdict, or a confirmed-dead one. Callers standing down on
 * a `true` therefore never stand down on an absence of evidence.
 */
export function ownershipHeldByLiveHolder(own: CellOwnership): boolean {
  if (own.claimState !== 'held' || own.holderSessionState === null) return false;
  // A live process can be wedged on this item. `held-stalled` is the explicit
  // progress falsifier, so it must not retain the stand-down rail merely because
  // the presence oracle still sees the holder alive.
  if (own.assessment === 'held-stalled') return false;
  return POSITIVELY_LIVE[own.holderSessionState] ?? false;
}

/**
 * PURE. Should a caller STAND DOWN because a live PEER already owns this incident?
 *
 * P-007's whole decision, in one testable place. It lives here rather than inline
 * in `release:checkpoint-run` because a four-way conjunction spread across a tool
 * handler is exactly the shape that looks obviously-correct and cannot be tested:
 * the handler is a detached-launch side effect, so the only way to exercise its
 * branch is to fire a ~55min suite.
 *
 * Every clause fails OPEN (returns false ⇒ proceed):
 *   - no positive liveness verdict (unread / ambiguous / dead holder)
 *   - no holder recorded at all
 *   - the CALLER could not be identified — we cannot prove it is not our own claim
 *   - the claim IS the caller's own
 *
 * `callerOwnerId` is deliberately required rather than optional: a caller that has
 * not resolved its identity must pass `null` and get a `false`, instead of omitting
 * the argument and silently standing down against its own claim.
 */
export function shouldStandDownForLivePeer(own: CellOwnership, callerOwnerId: string | null): boolean {
  if (!ownershipHeldByLiveHolder(own)) return false;
  if (!own.takenBy || !callerOwnerId) return false;
  return own.takenBy !== callerOwnerId;
}

/**
 * PURE. Choose which of the gate's two conditions an ownership cell reports as
 * ITS incident, given whichever of them the store actually found.
 *
 * BUGFIX (WI-37451): the resolver used to look up ONLY `gateStallConditionKey`,
 * so a gate that was firing healthily and answering red — `gate-red-streak:`
 * open, `green-stall:` never opened at all — read as `claimState: 'no-object'`
 * even while its ownable work-item existed and was claimable. Both consumers of
 * this cell (`gate.greenCheckpoint.ownership`, and `checkpoint-run`'s
 * stand-down check) were blind to it.
 *
 * D-002(b) of `gate-ownership-followup-2026-08-08` establishes the two keys can
 * be open SIMULTANEOUSLY by design (a red streak outliving the 12h no-green
 * backstop opens both) and deliberately does not couple their watchdogs. That
 * makes this a single-valued cell reporting on a condition that can genuinely
 * have two owners — so when only one key resolves, report it (this is the
 * WI-37451 fix); when BOTH resolve, prefer `gate-red-streak:` — it is the more
 * specific, currently-firing incident ("the gate IS producing verdicts and they
 * are red"), which is what a reader of `gate.greenCheckpoint.verdict` or a
 * manual-refire caller actually wants to know. A caller that specifically needs
 * the stall condition's own ownership can resolve `green-stall:<harness>`
 * directly via `findConditionObjects`; this cell stays intentionally
 * single-valued rather than growing a merge shape nothing consumes.
 */
/**
 * Pick which of the two gate conditions this single-valued cell reports, preferring
 * the red-streak incident when it is genuinely open (D-002(b)).
 *
 * ⚠ MAP PRESENCE IS NOT OPENNESS — this is the whole reason the function exists in
 * this shape. `findConditionObjects` sets an entry for EVERY requested key: a key
 * with no linked rows still comes back as a `no-object` ConditionObject with
 * `workItem: null`, in all three of its branches (pg-fast-path, the catch, and the
 * normal path). So `objs.has(redStreakKey)` was ALWAYS true in production, the
 * red-streak key ALWAYS won, and the `stallKey` branch was unreachable dead code.
 *
 * Consequence, measured live 2026-09-20: `green-stall:papercusp` was open and
 * linked to WI-10001932 while this cell answered `unowned` — whose stated safeAction
 * is "File the owning work-item and claim it before starting." That recruits a NEW
 * fixer onto an incident that already had an owner, which is the duplicate-filing
 * this cell exists to prevent.
 *
 * The sibling tests did not catch it because each injects a map that OMITS the key
 * it means to be absent — a shape the real finder never produces, i.e. a mock more
 * forgiving than reality. Read openness off the OBJECT, never off map membership.
 */
function pickGateConditionKey(
  stallKey: string,
  redStreakKey: string,
  objs: ReadonlyMap<string, ConditionObject>,
): string {
  return objs.get(redStreakKey)?.workItem != null ? redStreakKey : stallKey;
}

/**
 * Read ownership of the green-checkpoint gate's incident — either the STALL
 * condition (`green-stall:<harness>`, the gate not producing verdicts) or the
 * RED-STREAK condition (`gate-red-streak:<harness>`, the gate producing red
 * verdicts) — whichever is open. See {@link pickGateConditionKey} for the
 * selection rule when both are.
 *
 * Costs ONE indexed SELECT (`findConditionObjects` is batched and capped), not a
 * fork or a git call — the same reasoning that makes `checkpointRunInFlight` safe
 * to read on every `dev:pipeline_position` call. Batching both keys into that one
 * call keeps this a single round trip regardless of which (or both) resolve.
 *
 * FAIL-SOFT to `no-object`: `findConditionObjects` already degrades rather than
 * throwing when the store is unreachable, and this adds the same guarantee at the
 * boundary. A cell must always render; "no owner" is the correct non-misleading
 * answer when ownership cannot be seen. It is NOT, however, a claim that the gate
 * is healthy — see misread #1 above.
 */
export async function readGateOwnership(
  opts: {
    harness?: string;
    findConditionObjects?: typeof findConditionObjects;
    resolveSessionStates?: typeof resolveSessionStates;
    readCellThread?: typeof readCellThread;
    nowMs?: number;
  } = {},
): Promise<CellOwnership> {
  // Workspace-scoped tool dispatch uses '*' as a sentinel, not a harness slug.
  const requestedHarness = opts.harness?.trim();
  const harness = requestedHarness && requestedHarness !== '*' ? requestedHarness : operatorHomeHarnessSlug();
  const stallKey = gateStallConditionKey(harness);
  const redStreakKey = gateRedStreakConditionKey(harness);

  let objs: ReadonlyMap<string, ConditionObject>;
  try {
    const find = opts.findConditionObjects ?? findConditionObjects;
    objs = await find([stallKey, redStreakKey], { harnessSlug: harness });
  } catch (err) {
    return unmeasuredCell(stallKey, `ownership store unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const eventKey = pickGateConditionKey(stallKey, redStreakKey, objs);
  const obj = objs.get(eventKey);
  if (!obj) return unownedCell(eventKey);

  // The falsifier leg. Only worth a call when there IS a holder to measure —
  // and its failure degrades to null (no contradiction established), never to a
  // guess about liveness in either direction.
  let holderSessionState: SessionState | null = null;
  if (obj.takenBy) {
    try {
      const resolve = opts.resolveSessionStates ?? resolveSessionStates;
      const verdicts = await resolve([{ ownerId: obj.takenBy, claimsHeld: obj.claimState === 'held' }], {
        hydratePerId: true,
        // EI-22177969873560474: without this leg, a holder whose base derivation
        // lands 'suspect'/'ended' (wakeAttemptMiss / activityDead / hardStale) but
        // who has a confirmed-live psu-pty host read 'suspect' HERE while
        // coord:presence's own oracle call (presence-snapshot.ts) rescues the SAME
        // owner to 'parked' — the two surfaces disagreeing about one owner's
        // liveness at one instant, which this field's own docstring above says
        // must never happen ("measured by the presence oracle"). Matching
        // presence-snapshot's `{ enabled: true, negative: false, positive: true }`
        // psu-host leg restores the one-oracle invariant instead of leaving this
        // the one caller that omits it.
        psuHostPositiveAuthority: true,
      });
      holderSessionState = verdicts.get(obj.takenBy)?.sessionState ?? null;
    } catch {
      holderSessionState = null;
    }
  }

  // P-006, advisory. Independent of the falsifier above and fails soft on its own
  // — a thread that cannot be read must never degrade the OWNERSHIP verdict, which
  // was measured successfully and is the part of this cell anyone branches on.
  const readThread = opts.readCellThread ?? readCellThread;
  const thread = await readThread(obj.workItem, { harness });

  return toCellOwnership(obj, holderSessionState, thread, opts.nowMs);
}
