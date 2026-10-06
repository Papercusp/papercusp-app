/**
 * liveness-oracle.ts — THE single agent-liveness verdict assembly
 * (presence-derivation-unification-2026-07-17 P-002 / P-005).
 *
 * `deriveSessionState` (presence-wakeability.ts) has always been the one PURE
 * verdict model — but its INPUT ASSEMBLY was re-composed by hand at every call
 * site, and each site picked a different subset of the legs:
 *
 *   - coord:presence (presence-snapshot.ts) fed all legs (wakeability + liveTurn
 *     + hardStale + pid probe + recorded + claimsHeld);
 *   - fleet:status (fleet-roster.ts) skipped the pid probe + the recorded leg;
 *   - fleet:assignments (reconcileWakeability) skipped the pid probe;
 *   - coord:send's MISS path (recipient-liveness.ts) skipped hardStale AND the
 *     pid probe — so a zombie-await dead session read `parked` exactly where the
 *     caller was deciding whether a transfer black-holed;
 *   - fleet:leader-brief applied a psu-host authority NO other surface applied.
 *
 * The same agent could therefore get a DIFFERENT verdict per tool. This module
 * is the fix: ONE `resolveSessionStates` that batches every input leg the same
 * way for every caller. Surfaces differ only in how they PROJECT the verdict,
 * never in how they derive it (D-001: one derivation, many lenses).
 *
 * The legs, all optional-but-uniform:
 *   1. wakeability + liveTurn — fetchWakeability (event_awaits + agent_activity).
 *   2. recorded — adv_sessions session-log authority: a NOT-wakeable owner whose
 *      recorded session is live (ended_at IS NULL) and has no active turn is
 *      `recorded` (alive, not inbox-wake-dispatchable), never `ended`. An
 *      actively tool-calling successor is `live` even before its inbox wake is
 *      armed. Unifies the two prior spellings
 *      (snapshot's source === RECORDED_SESSION_SOURCE; assignments'
 *      recordedLiveOwnerIds set) by accepting EITHER signal.
 *   3. hardStale — the PRESENCE_DEAD_MS (30m) zombie-await ceiling, from the
 *      subject's heartbeat.
 *   4. pid probe — probeProcessLiveness for rows carrying a supervisor-beat
 *      pid/host (WI-3898 P1); ESRCH is authoritative-dead in seconds.
 *   5. claimsHeld — caller-known claims classify a confirmed-dead owner as
 *      `suspect` until claim cleanup reconciles.
 *   6. psu-host authority (P-005, OPT-IN) — the box-local psu-pty host registry:
 *      a non-cup subject whose verdict lands `parked` but has NO live psu host is
 *      `ended` (a dead host can strand a fresh heartbeat + wake-await). Opt-in
 *      (`psuHostAuthority: true`) because findLiveHost cannot distinguish "never
 *      pty-hosted here" from "host dead" — enable it only for cohorts known to be
 *      psu-pty-hosted (leader-brief's desktop fleet members).
 *
 * Callers with only ownerIds (the send/handoff MISS path) can set
 * `hydratePerId: true` to fill heartbeat/stale/host/pid/source from each
 * subject's own coord_presence row, so a bare-id verdict carries the same legs
 * as a roster verdict.
 *
 * Every fetch is batched per CALL (never per subject) and injectable for
 * PG-free unit tests. The cross-surface parity contract is enforced by
 * liveness-parity.test.ts (P-001).
 */

import { probeProcessLiveness, getPresence, listPresence } from './presence';
import {
  fetchWakeability,
  deriveSessionState,
  isHardStale,
  isActivityDead,
  WARM_IDLE_ACTIVITY_MS,
  LIVE_TURN_WINDOW_MS,
  needsLivenessConfirmation,
  type SessionState,
  type WakeabilitySignals,
} from './presence-wakeability';
// Constant-only import from the pure package — see presence-wakeability.ts (WI-39450).
// The `probeProcessLiveness`/`getPresence` import above legitimately needs the local
// module; this constant does not, and routing it through the blanket-mocked './presence'
// is what stranded it in unit-test collection.
import { PRESENCE_STALE_MS } from '@papercusp/coordination/presence';
import {
  fetchSelfWake,
  type SelfWakeSignals,
  type SelfWakeSource,
} from './presence-selfwake';
import { RECORDED_ENDED_SESSION_SOURCE, RECORDED_SESSION_SOURCE } from './recorded-sessions';
import { endedRecordedOwnerIds, recordedLiveOwnerIds } from '../../adv-sessions';
import { findLiveHost } from '../../events/await/psu-pty-discovery';

/** The per-owner inputs a caller supplies. Everything beyond `ownerId` is
 *  optional — a missing leg degrades exactly like the legacy call sites did
 *  (never a throw), and `hydratePerId` can fill the presence-row-derived
 *  fields from the store. */
export interface LivenessSubject {
  ownerId: string;
  /** ISO heartbeat timestamp (drives stale + the hardStale dead-ceiling). */
  heartbeatAt?: string | null;
  /** Precomputed heartbeat-freshness flag (PgPresenceStore's `stale`). When
   *  absent it is derived from `heartbeatAt` (> PRESENCE_STALE_MS ⇒ stale);
   *  when neither is present it defaults to false (legacy miss-path parity). */
  stale?: boolean | null;
  /** Caller-known claims signal (plan-item lane / work-item load) — classifies
   *  a confirmed-dead owner as `suspect` until claim cleanup runs. */
  claimsHeld?: boolean;
  /** Supervisor-beat pid/host when the row carries them (WI-3898 P1) — enables
   *  the local kill(pid,0) probe. */
  host?: string | null;
  pid?: number | null;
  /** Presence-row source — RECORDED_SESSION_SOURCE rows short-circuit to
   *  `recorded` when not wakeable and no turn is in flight
   *  (session-log-authoritative; never force-ended by heartbeat). */
  source?: string | null;
  /** Cohort hint for the psu-host authority leg (P-005): only non-'cup' rows
   *  with a KNOWN role may consult findLiveHost; bees stay nursery-governed. */
  agentRole?: string | null;
}

/** The unified verdict every surface projects from. */
export interface LivenessVerdict {
  ownerId: string;
  /**
   * The verdict — or `null` when NO wakeability signal was available for this
   * subject (EI-18771777750306094 / D-038 axis 2: an unknown is reported IN
   * BAND, never by omission from the result map).
   *
   * `null` is NOT a definite state and must never be collapsed into one: it
   * means "not measured", so `confirmLiveness` is forced true and
   * `signalMissing` is set alongside it. `classifyReadActionability(null)`
   * already maps it to 'unknown', which is the intended reading.
   */
  sessionState: SessionState | null;
  /**
   * Set — and only set — when this verdict carries NO wakeability signal, so
   * its `wakeable` / `liveTurn` legs are ABSENCE OF EVIDENCE rather than
   * measurements. Spread-when-present like `loopArmed`, so its absence means
   * the signal WAS present: the safe reading for a caller that never checks it.
   */
  signalMissing?: true;
  wakeable: boolean;
  liveTurn: boolean;
  /**
   * A terminal, turn-burning wake delivery was not followed by agent activity.
   * Never treats queued work as a pickup.
   *
   * ⚠ This DOES now drive `sessionState` (EI-21356139961831796) — it forces
   * `ended`/`suspect`. It previously did not, which is precisely how a
   * warm-dead owner (alive process, fresh heartbeat, no turn in 21h) kept
   * scoring `parked` and being handed fresh work while `release-force-guard`
   * — the one caller that DID read this field — considered it not live.
   */
  wakeAttemptMiss?: boolean;
  /**
   * Heartbeat fresh, but no turn for WARM_IDLE_ACTIVITY_MS
   * (EI-21356812816484561). REPORTED, never fatal: it does NOT move
   * `sessionState`, because an owner can legitimately be parked this long and
   * still wake fine. Read it to DE-PRIORITISE a dispatch candidate, never to
   * declare one dead — the ceiling that does declare is ACTIVITY_DEAD_MS.
   */
  warmIdle?: boolean;
  /** WI-4400: draining/suspect verdicts need a fresh required wake before a
   *  coordinator assumes the owner is dead or alive. */
  confirmLiveness: boolean | null;
  /** RAW heartbeat freshness (heartbeat within PRESENCE_STALE_MS). This is a
   *  process-keepalive signal, NOT a liveness verdict — the honest name for
   *  what several surfaces used to emit as `alive` (F6/P-008). */
  heartbeatFresh: boolean;
  /** EI-19407725333778711 — the FORWARD-LOOKING axis: is an active
   *  `loop-<ownerId>` routine going to re-wake this agent on a cadence?
   *  `undefined` = the self-wake leg was not fetched (opt-in) or degraded —
   *  UNKNOWN, never `false`. */
  loopArmed?: boolean;
  /** EI-19407725333778711 — will ANYTHING wake this agent unprompted
   *  (`loop` | `event` | `none`)? `undefined` = not fetched / degraded =
   *  UNKNOWN. `parked` + `none` is a dead member in a healthy costume; see
   *  presence-selfwake.ts for why unknown must never collapse to `none`. */
  selfWake?: SelfWakeSource;
}

/** Read-time actionability for owner-facing queues. */
export type ReadActionability = 'actionable' | 'non-actionable' | 'unknown';

/**
 * PURE: classify whether a read-side owner gate can still be acted on.
 * Missing liveness is deliberately unknown, never actionable.
 */
export function classifyReadActionability(
  sessionState: SessionState | null | undefined,
): ReadActionability {
  if (sessionState == null) return 'unknown';
  return sessionState === 'live' || sessionState === 'parked' || sessionState === 'recorded'
    ? 'actionable'
    : 'non-actionable';
}

export interface ResolveSessionStatesOpts {
  nowMs?: number;
  /** Fill missing heartbeat/stale/host/pid/source from each subject's own
   *  coord_presence row (one point-read per hydrated subject — for the small-N
   *  bare-id callers like the send-miss path, never for whole rosters). */
  hydratePerId?: boolean;
  /** Fill the same fields as `hydratePerId` with one owner-filtered list read.
   *  Use for candidate pools or rosters; the result preserves per-id semantics
   *  while avoiding one `coord_presence` query per subject. */
  hydrateBatch?: boolean;
  /** P-005: consult the box-local psu-pty host registry — `parked` + known
   *  non-cup role + no live host ⇒ `ended`. See the header for why opt-in. */
  psuHostAuthority?: boolean;
  /** EI-21007686537905985: use a positive live psu-pty host witness as
   * authoritative liveness, independently of the hostless-dead rule. */
  psuHostPositiveAuthority?: boolean;
  /**
   * EI-19407725333778711: also resolve the FORWARD-LOOKING self-wake axis
   * (`loopArmed` / `selfWake`), one extra batched query per call.
   *
   * Opt-in, following the `psuHostAuthority` precedent — but for the opposite
   * reason. That leg is opt-in because it can be WRONG for the wrong cohort;
   * this one is opt-in only because it costs a query that the non-supervisory
   * callers (the coord:send miss path, which asks "will THIS message land
   * now?") have no use for. Every SUPERVISORY surface — fleet:assignments,
   * fleet:status, coord:roster, leader-brief — should pass it, because
   * noticing a stranded member is precisely their job.
   */
  selfWake?: boolean;
  // ── DI seams (unit tests / bounded callers) ──
  fetchWakeabilityFn?: (ids: string[]) => Promise<Map<string, WakeabilitySignals>>;
  fetchSelfWakeFn?: (ids: string[]) => Promise<Map<string, SelfWakeSignals>>;
  fetchRecordedLiveFn?: (ids: string[]) => Promise<Set<string>>;
  /** Positive evidence that the owner's most-recent recorded session ended. */
  fetchRecordedEndedFn?: (ids: string[]) => Promise<Set<string>>;
  probePidFn?: (r: { host?: string | null; pid?: number | null }) => boolean | null;
  findHostFn?: (ownerId: string) => unknown | null;
  getPresenceFn?: (
    ownerId: string,
  ) => Promise<{
    heartbeatAt: string;
    stale: boolean;
    host: string | null;
    pid: number | null;
    source: string;
    /**
     * EI-22177969873560474: without this, `hydratePerId` had no way to fill
     * `LivenessSubject.agentRole` from the store, which silently disables the
     * psu-host authority leg (`psuHostAuthority` / `psuHostPositiveAuthority`)
     * for EVERY bare-id caller — `deriveVerdict`'s `psuHostKnownRole` check
     * requires a non-null agentRole, and a hydrated subject never had one.
     * Optional so existing fixtures/DI seams that omit it keep compiling; a
     * missing value degrades exactly like an unfetched leg (no rescue), never
     * a throw.
     */
    agentRole?: string | null;
  } | null>;
  /** Batched counterpart to `getPresenceFn`, injectable for PG-free tests. */
  listPresenceFn?: typeof listPresence;
}

/** WI-10005725: true only when `host` (a `findLiveHost` result) names a live psu
 *  host under a CONCRETE pid that differs from the recorded one, i.e. positive
 *  evidence that the dead recorded pid belongs to a predecessor incarnation. */
function liveHostSupersedesRecordedPid(
  host: unknown,
  recordedPid: number | null | undefined,
): boolean {
  if (host == null || typeof host !== 'object') return false;
  const hostPid = (host as { pid?: unknown }).pid;
  return (
    typeof hostPid === 'number' && Number.isInteger(hostPid) && hostPid > 0 && hostPid !== recordedPid
  );
}

/** PURE: one subject's verdict from already-fetched signals — the single place
 *  the legs meet deriveSessionState. Exported for the parity test (P-001). */
export function deriveVerdict(
  subject: LivenessSubject,
  w: WakeabilitySignals,
  recordedLive: ReadonlySet<string>,
  nowMs: number,
  probePidFn: ResolveSessionStatesOpts['probePidFn'] = probeProcessLiveness,
  psuHost?: {
    enabled: boolean;
    /** Defaults true for the legacy `psuHostAuthority` call shape. */
    negative?: boolean;
    positive?: boolean;
    findHostFn: (ownerId: string) => unknown | null;
  },
  /** EI-19407725333778711: the self-wake signals when the (opt-in) leg ran.
   *  Omitted ⇒ the verdict carries NO loopArmed/selfWake fields at all, which
   *  reads as UNKNOWN — deliberately NOT `none`. */
  selfWake?: SelfWakeSignals,
  /** Positive session-log evidence that the owner's most-recent session ended.
   *  A current recorded-live successor wins over this set. */
  recordedEnded: ReadonlySet<string> = new Set<string>(),
  // EI-18771777750306094: NARROWER than LivenessVerdict on purpose. This is the
  // pure path and it is only ever called WITH a wakeability signal, so it can
  // never produce the in-band unknown — only `resolveSessionStates` can. Saying
  // so in the type keeps every direct deriveVerdict caller (e.g. plans/
  // liveness-decoration) free of a null it cannot actually receive.
): LivenessVerdict & { sessionState: SessionState } {
  const psuHostKnownRole = subject.agentRole != null && subject.agentRole !== 'cup';
  const psuHostLive =
    psuHost?.enabled === true && psuHostKnownRole && psuHost.findHostFn(subject.ownerId) != null;
  const hbMs = subject.heartbeatAt ? Date.parse(subject.heartbeatAt) : null;
  const stale =
    subject.stale ??
    (hbMs != null && Number.isFinite(hbMs) ? nowMs - hbMs > PRESENCE_STALE_MS : false);
  const heartbeatSignalPresent =
    subject.stale != null || (hbMs != null && Number.isFinite(hbMs));
  // Session-log authority: a not-wakeable owner whose recorded session is live
  // and has no turn in flight is `recorded` — classified BEFORE the
  // heartbeat/pid path so it is never force-ended (presence-derive-from-
  // session-log P-001; PRESENCE_DEAD_MS note). A fresh turn is stronger
  // evidence than the launch-window fallback: an actively tool-calling
  // successor must remain `live` even before it arms an inbox wake.
  // EI-21572355077403526: an affirmative ESRCH DISQUALIFIES the session-log
  // rescue. `recorded` infers liveness from `adv_sessions.ended_at IS NULL`,
  // but that column is written by a session-end hook that SIGKILL bypasses —
  // so for a killed session the row is STALE, not live, and the inference is
  // simply wrong. Left unguarded it outranked the pid probe permanently: a
  // killed goal holder read `recorded`, `holderCountsAsAlive` counts that as
  // alive (goals/holder.ts), and the goal became unrelaunchable forever with
  // `already-held` while `launch_settings.holder.onLoss: 'deactivate'` could
  // never fire either.
  //
  // This restores the precedence this module already documents for
  // `pidConfirmedDead` ("authoritative FIRST ... a DIRECT OS-level observation
  // that the process is gone, not a timing heuristic, so it beats even
  // `hardStale`"). It is deliberately the NARROWEST possible disqualifier:
  // `probePidFn` returns `false` ONLY for an affirmative ESRCH on a row whose
  // host is this machine. Every ambiguous case — remote host, no pid recorded,
  // EPERM — returns `null`, which leaves `recorded` untouched. The generosity
  // the goal-holder predicate depends on is preserved for genuine ambiguity;
  // only a KNOWN-dead process loses it.
  //
  // WI-10005725: `subject.pid` is the RECORDED liveness pid (the supervisor
  // beat's launcher pid, carried on the presence row), not necessarily the
  // CURRENT incarnation's. A session relaunched under a REUSED ownerId
  // (fleet:respawn-member, a goal-holder respawn, a successor launch) keeps the
  // predecessor's pid until its own beat lands, and a beat that never lands
  // leaves it there. That ESRCH describes the predecessor, yet it outranks
  // `liveTurn` in deriveSessionState, so a working successor read `ended`
  // (measured: a respawned fleet leader at lastActiveSecAgo 6). A dead recorded
  // pid therefore ends the session only when no identity-verified psu host for
  // this owner is alive under a DIFFERENT concrete pid. `findLiveHost` already
  // checks owner identity, socket, pid-alive and the psu-host cmdline, so such
  // a host is positive evidence of a current incarnation. A witness with no
  // concrete pid, or the same pid, is not: the probe stays authoritative and
  // EI-21572355077403526's killed-holder trap stays closed. The host lookup
  // runs only on this rare dead-pid path.
  const recordedPidDead = probePidFn({ host: subject.host, pid: subject.pid }) === false;
  const pidConfirmedDead =
    recordedPidDead &&
    !liveHostSupersedesRecordedPid(psuHost?.findHostFn(subject.ownerId), subject.pid);
  const recordedLiveOnly =
    !w.wakeable &&
    !w.liveTurn &&
    !pidConfirmedDead &&
    (subject.source === RECORDED_SESSION_SOURCE ||
      recordedLive.has(subject.ownerId) ||
      (psuHostLive && psuHost?.positive === true));
  let sessionState: SessionState;
  if (
    recordedEnded.has(subject.ownerId) ||
    subject.source === RECORDED_ENDED_SESSION_SOURCE
  ) {
    // A warm heartbeat and a lingering wake-await can outlive the process.
    // Positive session-log death evidence settles that ambiguity immediately;
    // claims still held remain suspect until their cleanup is reconciled.
    sessionState = subject.claimsHeld ? 'suspect' : 'ended';
  } else if (recordedLiveOnly) {
    sessionState = 'recorded';
  } else {
    sessionState = deriveSessionState({
      stale: !!stale,
      wakeable: w.wakeable,
      liveTurn: w.liveTurn,
      hardStale: isHardStale(hbMs, nowMs),
      // Reuses the single probe taken above — same value, one syscall, and it
      // cannot drift between the two decision points the way two separate
      // probes could.
      pidConfirmedDead,
      // EI-21356139961831796: this signal was already computed by the
      // wakeability leg and emitted on the verdict below, but was never fed
      // INTO the state machine — so a session we woke that never took a turn
      // kept scoring `parked`.
      wakeAttemptMiss: w.wakeAttemptMiss === true,
      // EI-21356812816484561: the ACTIVITY-clock dead ceiling. `hardStale`
      // above only ever watched the heartbeat, so a live-but-wedged agent loop
      // was invisible to it.
      activityDead: isActivityDead(w.lastActivityMs ?? null, nowMs),
      claimsHeld: !!subject.claimsHeld,
    });
    // P-005: the psu-host authority leg — a `parked` verdict for a known
    // non-cup cohort with no live psu host on this box is a dead host that
    // stranded its heartbeat + wake-await.
    if (
      psuHost?.enabled &&
      sessionState === 'parked' &&
      psuHostKnownRole &&
      psuHost.negative !== false &&
      !psuHostLive
    ) {
      sessionState = 'ended';
    }
    // EI-21572355077403526: the SAME disqualifier applies to the psu-host
    // rescue. This leg exists to save a session whose heartbeat/wake look dead
    // but whose host process is demonstrably live — a genuine ambiguity. An
    // affirmative ESRCH is not that ambiguity: the process is GONE, and a live
    // host registry entry for it is stale bookkeeping, not counter-evidence.
    // Without this guard the fix above would be a half-fix — a confirmed-dead
    // holder derives `ended` here and is then flipped straight back to
    // `recorded`, re-arming the identical unrelaunchable-goal trap through a
    // different leg.
    if (
      psuHostLive &&
      psuHost?.positive === true &&
      !pidConfirmedDead &&
      (sessionState === 'ended' || sessionState === 'suspect')
    ) {
      sessionState = w.wakeable ? (stale ? 'draining' : 'parked') : 'recorded';
    }
  }
  return {
    ownerId: subject.ownerId,
    sessionState,
    wakeable: w.wakeable,
    liveTurn: w.liveTurn,
    wakeAttemptMiss: w.wakeAttemptMiss === true,
    // EI-21356812816484561: heartbeat fresh but no turn for WARM_IDLE_ACTIVITY_MS.
    // REPORTED, never fatal — it does not move `sessionState`, because a
    // legitimately parked owner can sit here for hours and still wake fine. It
    // exists so a router can de-prioritise instead of treating every `parked`
    // row as an equal-footing candidate (measured: 107 of 180 heartbeat-fresh
    // rows were in this band, all offered to dispatch identically).
    warmIdle:
      w.lastActivityMs != null && Number.isFinite(w.lastActivityMs)
        ? nowMs - w.lastActivityMs >= WARM_IDLE_ACTIVITY_MS
        : false,
    confirmLiveness: needsLivenessConfirmation(sessionState),
    heartbeatFresh: heartbeatSignalPresent ? !stale : false,
    // Spread-when-present, never a `?? false` default: an absent self-wake leg
    // must stay ABSENT so a reader cannot mistake "not fetched" for "nothing
    // will wake this agent" (presence-selfwake.ts § Why `unknown` is not `none`).
    ...(selfWake ? { loopArmed: selfWake.loopArmed, selfWake: selfWake.selfWake } : {}),
  };
}

/** PURE: the in-band UNKNOWN verdict for a subject carrying no wakeability
 *  signal (EI-18771777750306094). Nothing here is INFERRED from the missing
 *  signal:
 *
 *   - `heartbeatFresh` stays honest — it derives from the subject's OWN
 *     caller-supplied heartbeat, which is not part of the wakeability leg, so
 *     it is genuinely known even here.
 *   - the wakeability-derived booleans are pinned to their no-evidence value
 *     behind THREE independent markers — a null `sessionState`, `signalMissing`,
 *     and a forced `confirmLiveness` — so a caller that reads any one of them
 *     cannot mistake absence of evidence for evidence of absence.
 *
 *  Exported so the parity/boundary tests can assert the shape directly. */
export function unknownVerdict(subject: LivenessSubject, nowMs: number): LivenessVerdict {
  const hbMs = subject.heartbeatAt ? Date.parse(subject.heartbeatAt) : null;
  const stale =
    subject.stale ??
    (hbMs != null && Number.isFinite(hbMs) ? nowMs - hbMs > PRESENCE_STALE_MS : false);
  const heartbeatSignalPresent =
    subject.stale != null || (hbMs != null && Number.isFinite(hbMs));
  return {
    ownerId: subject.ownerId,
    sessionState: null,
    signalMissing: true,
    wakeable: false,
    liveTurn: false,
    wakeAttemptMiss: false,
    // Never assume a subject we could not measure is safe to act on.
    confirmLiveness: true,
    heartbeatFresh: heartbeatSignalPresent ? !stale : false,
  };
}

/** A bare owner id has no presence-derived liveness evidence to feed the
 *  state machine. In particular, `fetchWakeability` deliberately emits a
 *  `wakeable:false/liveTurn:false` row for every requested id, so that
 *  negative pair is not evidence that the owner ended. */
function hasPresenceSignal(subject: LivenessSubject): boolean {
  return (
    subject.heartbeatAt != null ||
    subject.stale != null ||
    subject.host != null ||
    subject.pid != null ||
    subject.source != null
  );
}

/** Positive wakeability evidence is sufficient to classify a subject even when
 *  the caller supplied only an owner id. Negative/default wakeability values
 *  are not: they are also what the batch fetch returns for an unknown id. */
function hasPositiveWakeabilitySignal(w: WakeabilitySignals): boolean {
  return w.wakeable || w.liveTurn || w.wakeAttemptMiss === true || w.lastActivityMs != null;
}

/**
 * THE liveness oracle: batched verdicts for a set of subjects.
 *
 * TOTAL by construction (EI-18771777750306094): EVERY subject gets an entry.
 * A subject with no wakeability signal gets an explicit `unknownVerdict`
 * (`sessionState: null` + `signalMissing`), never silent omission — so a
 * missing key can only ever mean "you did not ask about this owner", which is
 * a distinction a bare Map lookup otherwise cannot express. Before this, every
 * caller had to re-derive its own unknown handling from an absent key, and
 * `delegated-spawn-outcome-resolve` had to fail closed on one to stay safe.
 *
 * Fail-soft is still the CALLER's choice for a whole-batch failure (wrap in
 * withBoundedTimeout / .catch): the wakeability leg deliberately has no
 * `.catch()` here, so a fetch rejection propagates rather than quietly
 * degrading every subject to unknown.
 */
export async function resolveSessionStates(
  subjects: readonly LivenessSubject[],
  opts: ResolveSessionStatesOpts = {},
): Promise<Map<string, LivenessVerdict>> {
  const out = new Map<string, LivenessVerdict>();
  if (subjects.length === 0) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const fetchWake = opts.fetchWakeabilityFn ?? fetchWakeability;
  const fetchRecorded = opts.fetchRecordedLiveFn ?? recordedLiveOwnerIds;
  const fetchEnded = opts.fetchRecordedEndedFn ?? endedRecordedOwnerIds;
  const probePidFn = opts.probePidFn ?? probeProcessLiveness;
  const findHostFn = opts.findHostFn ?? findLiveHost;

  let hydrated: readonly LivenessSubject[] = subjects;
  if (opts.hydrateBatch) {
    const needsHydration = subjects.filter((s) => s.heartbeatAt == null && s.stale == null);
    if (needsHydration.length > 0) {
      try {
        const rows = await (opts.listPresenceFn ?? listPresence)({
          ownerIds: needsHydration.map((s) => s.ownerId),
        });
        const byOwner = new Map(rows.map((row) => [row.ownerId, row]));
        hydrated = subjects.map((s) => {
          if (s.heartbeatAt != null || s.stale != null) return s;
          const p = byOwner.get(s.ownerId);
          if (!p) return s;
          return {
            ...s,
            heartbeatAt: p.heartbeatAt,
            stale: p.stale,
            host: s.host ?? p.host,
            pid: s.pid ?? p.pid,
            source: s.source ?? p.source,
            agentRole: s.agentRole ?? p.agentRole,
          };
        });
      } catch {
        // Match the per-id path: best-effort hydration must never block a verdict.
        hydrated = subjects;
      }
    }
  } else if (opts.hydratePerId) {
    const getPresenceFn = opts.getPresenceFn ?? getPresence;
    hydrated = await Promise.all(
      subjects.map(async (s) => {
        if (s.heartbeatAt != null || s.stale != null) return s;
        try {
          const p = await getPresenceFn(s.ownerId);
          if (!p) return s;
          return {
            ...s,
            heartbeatAt: p.heartbeatAt,
            stale: p.stale,
            host: s.host ?? p.host,
            pid: s.pid ?? p.pid,
            source: s.source ?? p.source,
            // EI-22177969873560474: was missing — every hydratePerId caller
            // that also enables psuHostAuthority/psuHostPositiveAuthority
            // (readGateOwnership, fleet/respawn-member's readMemberSessionState)
            // had the leg silently disabled, since deriveVerdict's
            // `psuHostKnownRole` requires a non-null agentRole and a bare-id
            // subject never carried one through hydration.
            agentRole: s.agentRole ?? p.agentRole,
          };
        } catch {
          return s; // hydration is best-effort — a store hiccup never blocks the verdict
        }
      }),
    );
  }

  const ids = hydrated.map((s) => s.ownerId);
  const fetchSelf = opts.fetchSelfWakeFn ?? fetchSelfWake;
  const [wakeability, recordedLive, recordedEnded, selfWake] = await Promise.all([
    fetchWake(ids),
    // Recorded-session authority is an ENRICHMENT leg — best-effort by design
    // (adv_sessions may lag/miss); a failure degrades to "no recorded rescue",
    // never fails the verdict batch.
    fetchRecorded(ids).catch(() => new Set<string>()),
    // Positive ended-session evidence closes the warm-heartbeat / stale-await
    // gap. A read failure degrades to the older oracle, never to a death claim.
    fetchEnded(ids).catch(() => new Set<string>()),
    // Self-wake is likewise an ENRICHMENT leg: a failure degrades every subject
    // to "self-wake unknown" (the fields are simply absent) and never fails the
    // batch — a supervisor losing one column must not cost it the whole roster.
    opts.selfWake === true
      ? fetchSelf(ids).catch(() => new Map<string, SelfWakeSignals>())
      : Promise.resolve(new Map<string, SelfWakeSignals>()),
  ]);
  const psuHost = {
    enabled: opts.psuHostAuthority === true || opts.psuHostPositiveAuthority === true,
    negative: opts.psuHostAuthority === true,
    positive: opts.psuHostPositiveAuthority === true,
    findHostFn,
  };
  for (const s of hydrated) {
    const w = wakeability.get(s.ownerId);
    if (!w) {
      // D-038 axis 2: report the unknown IN BAND rather than dropping the
      // subject. Not reachable through the DEFAULT fetch — `fetchWakeability`
      // emits an entry for every requested id, and its rejection propagates
      // instead of degrading per-subject — so this is the `fetchWakeabilityFn`
      // DI seam's path. That is precisely why the unknown must be
      // REPRESENTABLE: an injected partial map used to shrink the result
      // silently, and the shrink was indistinguishable from "not asked".
      out.set(s.ownerId, unknownVerdict(s, nowMs));
      continue;
    }
    const hasRecordedEvidence = recordedLive.has(s.ownerId) || recordedEnded.has(s.ownerId);
    const psuHostLive =
      psuHost.positive === true &&
      s.agentRole != null &&
      s.agentRole !== 'cup' &&
      findHostFn(s.ownerId) != null;
    if (!hasPresenceSignal(s) && !hasPositiveWakeabilitySignal(w) && !hasRecordedEvidence && !psuHostLive) {
      // A wakeability row with only negative/default values is not a measured
      // death verdict for a bare id: the batch query manufactures that row for
      // ids it has never seen. Preserve the existing in-band UNKNOWN shape.
      out.set(s.ownerId, unknownVerdict(s, nowMs));
      continue;
    }
    out.set(
      s.ownerId,
      deriveVerdict(
        s,
        w,
        recordedLive,
        nowMs,
        probePidFn,
        psuHost,
        selfWake.get(s.ownerId),
        recordedEnded,
      ),
    );
  }
  return out;
}

/**
 * P-005 shared helper: reconcile ALREADY-derived per-agent session states with
 * the psu-host authority — the exact rule fleet:leader-brief used to apply
 * privately (reconcilePsuHostLiveness), now exported from the oracle so any
 * surface whose cohort is known-psu-hosted applies the SAME rule. Mutates in
 * place and returns the list.
 *
 * `liveTurn` is derived from recent agent_activity, not from the host process
 * itself. A stale directed wake can therefore leave a dead owner looking
 * `live` after its psu host has exited. For a known non-cup cohort, the local
 * psu host is the stronger authority for `live`/`parked` only when the canonical
 * roster has no fresh genuine activity evidence. `lastActiveSecAgo` is optional
 * because some legacy callers do not carry the tier-1 turn-parts join; when it
 * is present and inside the same live-turn window, that positive evidence wins
 * a transiently missing host. `recorded` remains exempt because it is the
 * session-log authority for a session that has not yet registered an inbox-wake
 * await.
 */
export function applyPsuHostAuthority<
  T extends {
    agentId: string;
    sessionState?: SessionState | null;
    alive?: boolean;
    lastActiveSecAgo?: number | null;
  },
>(
  agents: T[],
  agentRoles: ReadonlyMap<string, string | null>,
  findHostFn: (ownerId: string) => unknown | null = findLiveHost,
): T[] {
  for (const agent of agents) {
    const role = agentRoles.get(agent.agentId);
    if (role == null || role === 'cup') continue;
    const activityAgeSec = agent.lastActiveSecAgo;
    const hasFreshGenuineActivity =
      typeof activityAgeSec === 'number' &&
      Number.isFinite(activityAgeSec) &&
      activityAgeSec >= 0 &&
      activityAgeSec < LIVE_TURN_WINDOW_MS / 1000;
    if (
      (agent.sessionState === 'live' || agent.sessionState === 'parked') &&
      !hasFreshGenuineActivity &&
      findHostFn(agent.agentId) == null
    ) {
      agent.sessionState = 'ended';
      if ('alive' in agent) agent.alive = false;
    }
  }
  return agents;
}
