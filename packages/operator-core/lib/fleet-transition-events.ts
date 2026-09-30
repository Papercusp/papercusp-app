/**
 * fleet-transition-events — the leader-facing fleet transition feed
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-009, D-008).
 *
 * A fleet leader used to learn about its fleet by POLLING: `loop:arm` on a short
 * interval, `fleet:leader-brief` every wake, most of them near-noops. The
 * measured run behind this plan burned ~14 wakes to notice one released claim, up
 * to 3 minutes late. `leader-brief` already DERIVES every transition a leader
 * reacts to; nothing published them, so there was nothing to park on.
 *
 * This module publishes them as fleet-scoped awaitable keys, so a leader DISCOVERS
 * them via `events:catalog` and sleeps instead of polling:
 *
 *   events:await { event: "fleet:member-dead:<my-fleet>" }      // a member died
 *   events:await { event: "fleet:member-left:<my-fleet>" }      // a clean exit left claims
 *   events:await { event: "fleet:context-critical:<my-fleet>" } // a member is about to compact
 *   events:await { event: "fleet:member-stalled:<my-fleet>" }  // a held claim stopped advancing
 *   events:await { event: "fleet:admission-blocked:<my-fleet>" } // the fleet spec refused work
 *   events:await { event: "fleet:repeated-recovery:<my-fleet>" } // a member repeated recovery-only cycles
 *   events:await { event: "fleet:claim-released:<my-fleet>" }   // work came back to the pool
 *   events:await { event: "fleet:item-completed:<my-fleet>" }   // a member finished something
 *
 * KEY SHAPE — `fleet:<transition>:<slug>`, NOT the `fleet:<slug>:<transition>` the
 * P-009 text sketched. The slug must come LAST because `familyKeyPrefix` (and so
 * `keyMatchesCatalog`) truncates a template at its FIRST placeholder: a
 * `fleet:<slug>:member-dead` template registers the catalog prefix `fleet:`, which
 * then matches EVERY `fleet:*` key ever awaited — including typos — and silently
 * disarms the EI-10870 orphan guard for the whole namespace. Putting the
 * transition first yields the precise prefix `fleet:member-dead:` and matches the
 * existing `fleet:drained:<slug>` family exactly, so the namespace stays uniform.
 *
 * WHY FLEET-SCOPED KEYS AND NOT A PAYLOAD FILTER (D-008). The reuse-first
 * instinct is to payload_filter an existing global key rather than mint a family.
 * There is no global key to filter: `work-items-events.ts` emits only
 * `work-item:done:<id>` and `claim:released:<id>`, both ID-SCOPED — they fire for
 * ONE known id. A leader does not know in advance which item will finish next, so
 * using them means registering N awaits and re-registering whenever the set
 * changes: a subscription treadmill driven by polling the item set, which is the
 * exact anti-pattern this plan exists to remove. Route (b) would have to mint
 * global families FIRST, so it saves no families, and then costs more: the
 * work-item payloads carry no fleet identity (`{id,state,kind,harness,title}`),
 * so the leader's predicate needs the same emit-time fleet lookup anyway; and a
 * global key loads EVERY leader's await row on EVERY system-wide settle only to
 * filter them out, where a fleet-scoped key loads just that fleet's.
 * `fleet:drained:<slug>` is the established precedent this extends.
 *
 * NOT IN THIS MODULE — `idle-with-claimable`, P-009's fifth transition, is ALREADY
 * served by the existing global `work-item:claimable` key, which is genuinely
 * payload-filtered (it carries `{id,kind,severity,harness,title,state,reason,plan,
 * tags,goal}`). A leader parks on it with `payload_filter: { plan: { eq: '<slug>' } }`.
 * Minting a fleet-scoped twin would duplicate an emission that already fires; the
 * catalog cross-references it instead.
 *
 * TWO SHAPES OF SIGNAL, deliberately. `claim-released` / `item-completed` have a
 * real TRANSITION SITE and co-fire from it (the shape `emitWorkItemClaimableEvent`
 * already uses). `member-dead` / `context-critical` have NONE — death is the
 * ABSENCE of a write, and context pressure is derived from reported token counts —
 * so they are DERIVED detectors driven by a periodic sweep, exactly as
 * `fleet-drained-events.ts` documents for its own computed condition. The pure
 * arithmetic lives here; the sweep only supplies observations and carries the
 * previous snapshot.
 *
 * PURE core + injectable seams (fleet-drained-events.ts / session-compacted-events.ts
 * discipline): no PG / IO / clock in the detector, so the whole module unit-tests
 * without a database.
 */

import { emitAwaitedEvent } from './events/await/engine';
import type { ContextPressureBucket } from './agent-tools/coordination/context-pressure';
import type { WorkItem } from './work-items';

/** The transition families this module publishes, as they appear in the key. */
export type FleetTransitionKind =
  | 'member-dead'
  | 'member-left'
  | 'context-critical'
  | 'member-stalled'
  | 'repeated-recovery'
  | 'admission-blocked'
  | 'claim-released'
  | 'item-completed';

/** Build the awaitable key for one fleet transition. Single-sourced so the
 *  emitters, the catalog entries and the tests can never drift on the shape.
 *  Slug LAST — see the key-shape note in the module header. */
export function fleetTransitionKey(fleetSlug: string, kind: FleetTransitionKind): string {
  return `fleet:${kind}:${fleetSlug}`;
}

/**
 * The liveness verdicts that mean CONFIRMED dead.
 *
 * Deliberately ONLY `ended`. `draining` and `suspect` also read as "dead" in the
 * orphaned-claim arithmetic, but per WI-4400 both require a wake CONFIRMATION
 * before a coordinator may assume the owner is gone — so firing on them would wake
 * a leader on an unconfirmed suspicion, which is a false alarm, and a false alarm
 * in a monitor is itself a bug. A member that is genuinely gone reaches `ended`;
 * its presence row survives there until the TTL reaper evicts it
 * (presence-reaper.ts), so the state is observable, not a race.
 */
const CONFIRMED_DEAD_SESSION_STATES: ReadonlySet<string> = new Set(['ended']);

/** The context-pressure bucket that means "compaction is imminent". */
const CRITICAL_CONTEXT_BUCKET = 'critical';

/**
 * One fleet member as a sweep observes it — the minimal projection of the
 * roster/assignment row the detector reads. Kept narrow so the pure fn unit-tests
 * without importing the full presence types.
 */
export interface FleetMemberObservation {
  agentId: string;
  fleetSlug: string;
  /** The shared liveness oracle's verdict (live | parked | draining | suspect | ended | recorded). */
  sessionState: string | null;
  /** The context-pressure bucket (ok | high | critical), or null when unknown. */
  contextPressure: string | null;
  /** Whether a coordinator can currently deliver a wake to this member. */
  wakeable?: boolean | null;
  /** Total active claims, including plan-item and work-item claims. */
  claimCount?: number;
  /** Stable identities of those claims, independent of assignment row ordering. */
  claimKeys?: readonly string[];
  /** Whether the current assignment read classifies this member as stalled. */
  stalled?: boolean | null;
  /** Measured consecutive checkpoint-bounded recovery-only cycles. Null means
   * dual-ledger coverage was incomplete or intervention is suppressed. */
  consecutiveRecoveryOnlyCycles?: number | null;
  /** Durable fleet registry role, used to suppress intervention on the leader. */
  isRegisteredLeader?: boolean;
  /** A current claim has canonical activity='progressing'. */
  hasProgressingClaim?: boolean;
}

/**
 * A recorded session with no wake path and no claim is terminal control residue,
 * not a runnable fleet member. It must not enter the transition snapshot: doing
 * so lets stale context telemetry manufacture a context-critical wake after a
 * graceful stand-down. Missing enrichment stays actionable so degraded reads do
 * not silently suppress a real edge.
 */
export function isActionableFleetObservation(
  observation: Pick<FleetMemberObservation, 'sessionState' | 'wakeable' | 'claimCount'>,
): boolean {
  return !(observation.sessionState === 'recorded' && observation.wakeable === false && observation.claimCount === 0);
}

interface FleetTransitionEdgeBase {
  fleetSlug: string;
  agentId: string;
  /** The state the member crossed INTO (for the summary line). */
  to: string;
  /** The state it crossed FROM, for the summary line. */
  from: string | null;
}

/** One detected crossing, ready to emit. */
export type FleetTransitionEdge =
  | (FleetTransitionEdgeBase & {
      kind: Extract<FleetTransitionKind, 'member-dead' | 'context-critical' | 'member-stalled'>;
    })
  | (FleetTransitionEdgeBase & {
      kind: 'member-left';
      claimCount: number;
    })
  | (FleetTransitionEdgeBase & {
      kind: 'repeated-recovery';
      consecutiveRecoveryOnlyCycles: number;
      action: 'diagnose';
      takeoverAuthorized: false;
    });

/**
 * How long a member must be CONTINUOUSLY observed non-dead before `member-dead`
 * re-arms for it (see the latch note on `detectFleetTransitions`).
 *
 * 30 minutes = 3× PRESENCE_STALE_MS, the same dwell `presence-wakeability.ts`
 * already uses for the "is this thing really alive" question (it matches the
 * parked-claim reclaim grace). Chosen against the measured data rather than by
 * feel: the spurious live windows are ~one liveTurn window each (~10 min), while
 * a member doing real work emits activity continuously (measured 105–236 rows an
 * hour, versus the 2–7/hour trickle a dead one keeps emitting). A dwell of three
 * liveTurn windows clears the trickle without delaying a genuine relaunch's
 * second death by more than one notice.
 */
export const MEMBER_DEAD_REARM_DWELL_MS = 30 * 60 * 1000;

/**
 * How long a latch entry survives with no re-arm. Bounds the map for members
 * that leave the fleet or are reaped, and caps the worst case at one member-dead
 * notice per member per day rather than suppressing forever.
 */
export const MEMBER_DEAD_LATCH_TTL_MS = 24 * 60 * 60 * 1000;

/** Per-member state for the member-dead latch. Caller-owned so the detector stays pure. */
export interface FleetDeadLatchEntry {
  /** When `member-dead` last fired for this member. */
  firedAtMs: number;
  /** When the member was FIRST observed non-dead since that fire; null while it still reads dead. */
  aliveSinceMs: number | null;
}

/** A member-left notice stays latched across brief live/recorded flaps. */
export interface FleetLeftLatchEntry {
  claimSignature: string;
  /** First continuously wakeable observation after the notice. */
  recoveredSinceMs: number | null;
  /** Used only to discard members absent from the roster for a full day. */
  lastSeenAtMs: number;
}

function memberClaimSignature(o: FleetMemberObservation): string {
  return JSON.stringify(o.claimKeys ? [...o.claimKeys].sort() : [o.claimCount ?? 0]);
}

/** A fleet-level admission-block crossing, ready to emit. */
export interface FleetAdmissionTransitionEdge {
  kind: 'admission-blocked';
  fleetSlug: string;
  from: number;
  to: number;
}

/** One fleet's current distinct admission-block count. */
export interface FleetAdmissionObservation {
  fleetSlug: string;
  /** null means the detector could not measure this fleet on this sweep. */
  blockedCount: number | null;
  /**
   * Epoch ms of the NEWEST listed block, when measured. Lets a first sighting
   * (no baseline for this fleet, e.g. the first sweep after a process restart)
   * tell a block raised since the baseline began from one the previous sweep
   * process already announced (WI-10003609). null/absent = unknown.
   */
  newestBlockAtMs?: number | null;
}

/** Options for {@link detectFleetAdmissionTransitions}. */
export interface FleetAdmissionTransitionOptions {
  /**
   * When set, a fleet with NO baseline entry fires only if its newest block was
   * raised at or after this instant. Older blocks were visible to the sweep
   * process that ran before this baseline existed, so re-announcing them is a
   * duplicate wake, not a new crossing. An unknown newest time fails open (fires):
   * a missed admission block starves a lane silently, a duplicate costs one turn.
   */
  firstSightingSinceMs?: number;
}

/** Snapshot identity for a member — a member is only ever compared against
 *  itself WITHIN a fleet, so a fleet change reads as a new member (and therefore
 *  never fires; see the first-observation rule below). */
function observationKey(o: { fleetSlug: string; agentId: string }): string {
  return `${o.fleetSlug}\0${o.agentId}`;
}

/** Index a set of observations for the next sweep's comparison. */
export function indexObservations(
  observations: readonly FleetMemberObservation[],
): Map<string, FleetMemberObservation> {
  return new Map(observations.map((o) => [observationKey(o), o]));
}

/**
 * PURE: which members crossed INTO a confirmed-dead state, or INTO critical
 * context pressure, between the previous sweep and this one.
 *
 * EDGE-ONLY, by two rules, both of which exist to stop a monitor crying wolf:
 *
 *   1. A member with NO previous observation never fires. A first sighting is not
 *      a crossing we witnessed — without this, the first sweep after any operator
 *      restart would wake every leader for every historically-dead row it happens
 *      to still see. The cost is a genuinely missed edge across a restart, which
 *      P-010 explicitly covers by retaining `loop:arm` as a long fallback
 *      heartbeat: the architecture is push-primary WITH a backstop.
 *   2. A member already in the target state does not re-fire while it STAYS there.
 *      `ended` and `critical` are both absorbing-ish states that persist for many
 *      sweeps; re-firing would turn one event into a wake storm.
 *
 *   3. A member-dead edge LATCHES: once fired for a member, it does not fire
 *      again until that member has been CONTINUOUSLY observed non-dead for
 *      MEMBER_DEAD_REARM_DWELL_MS. Rules 1 and 2 are both edge rules, and both
 *      assume the verdict, once `ended`, STAYS `ended` — which it does not.
 *      `sessionState` is derived, and its `liveTurn` leg is satisfied by ANY
 *      recent `agent_activity` row; a dead session keeps drawing a low-rate
 *      trickle of those long after it stops working, so the verdict oscillates
 *      ended→live→ended indefinitely and rule 2 never engages. Measured on
 *      EI-22125312396899848: one agent (ONE `adv_sessions` row — a single
 *      session, a single death) fired member-dead in 42 distinct minutes over
 *      ~10h, its activity having dropped from 105–236 rows/hour while working to
 *      a 2–7/hour trickle afterwards; bursts reached 14–15 agents across 5
 *      fleets in a single minute. Each one woke every leader awaiting that fleet.
 *
 *      This is the SAME failure the context-pressure branch below already guards
 *      (its rule on an unknown prior bucket, EI-21968977558564590). It needs a
 *      different shape here because the lapse is not laundered into `null` — the
 *      oracle degrades to a CONCRETE optimistic verdict (`live`/`parked`), which
 *      is indistinguishable from real liveness at this boundary. So the guard
 *      cannot be "ignore unknown priors"; it has to be "don't believe a
 *      resurrection until it holds".
 *
 *      The latch is caller-owned (passed in, mutated here) for the same reason
 *      `prev` is: this function stays pure and clock-free, and the sweep keeps
 *      the state. Omit it and the behaviour is exactly as before.
 *
 * A member that DISAPPEARS between sweeps is deliberately NOT a death signal: the
 * row could equally have been reaped on its TTL, or the member could have left the
 * fleet, and those are indistinguishable here. Disappearance-as-death would be a
 * guess, and the whole point of a push signal is that the leader can trust it.
 *
 * Deterministic order (fleet, then agent) so callers and tests are stable.
 */
export function detectFleetTransitions(
  prev: ReadonlyMap<string, FleetMemberObservation>,
  next: readonly FleetMemberObservation[],
  opts: {
    /** Caller-owned member-dead latch (rule 3). Mutated in place; omit to disable latching. */
    deadLatch?: Map<string, FleetDeadLatchEntry>;
    /** Caller-owned member-left latch; suppresses repeated notices for unchanged claims. */
    leftLatch?: Map<string, FleetLeftLatchEntry>;
    /** Observation time. Required for the latch; the detector never reads a clock itself. */
    nowMs?: number;
    /** Override the re-arm dwell (tests). */
    rearmDwellMs?: number;
  } = {},
): FleetTransitionEdge[] {
  const { deadLatch, leftLatch, rearmDwellMs = MEMBER_DEAD_REARM_DWELL_MS } = opts;
  const nowMs = opts.nowMs ?? 0;
  const edges: FleetTransitionEdge[] = [];
  for (const o of next) {
    const key = observationKey(o);
    const before = prev.get(key);

    const isDead = CONFIRMED_DEAD_SESSION_STATES.has(o.sessionState ?? '');

    const left = leftLatch?.get(key);
    if (left) {
      left.lastSeenAtMs = nowMs;
      if ((o.claimCount ?? 0) === 0 || left.claimSignature !== memberClaimSignature(o)) {
        leftLatch?.delete(key); // changed work is a new actionable episode
      } else if ((o.sessionState === 'live' || o.sessionState === 'parked') && o.wakeable === true) {
        if (left.recoveredSinceMs === null) left.recoveredSinceMs = nowMs;
        else if (nowMs - left.recoveredSinceMs >= rearmDwellMs) leftLatch?.delete(key);
      } else {
        left.recoveredSinceMs = null; // a short live flap is not recovery
      }
    }

    // Rule 3 bookkeeping runs on EVERY observation, including a first sighting —
    // the dwell that re-arms a latched member must keep accruing across a gap in
    // `prev` (e.g. the snapshot reset after a restart), or a member could never
    // re-arm at all.
    const latched = deadLatch?.get(key);
    if (latched) {
      if (isDead) {
        latched.aliveSinceMs = null; // still dead — the dwell restarts from scratch
      } else if (latched.aliveSinceMs === null) {
        latched.aliveSinceMs = nowMs; // first non-dead sighting since the fire
      } else if (nowMs - latched.aliveSinceMs >= rearmDwellMs) {
        deadLatch?.delete(key); // sustained liveness — a later death is a real new edge
      }
    }

    if (!before) continue; // rule 1 — a first sighting is not a crossing

    const wasDead = CONFIRMED_DEAD_SESSION_STATES.has(before.sessionState ?? '');
    if (isDead && !wasDead && !deadLatch?.has(key)) {
      edges.push({
        kind: 'member-dead',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: o.sessionState ?? 'ended',
        from: before.sessionState,
      });
      deadLatch?.set(key, { firedAtMs: nowMs, aliveSinceMs: null });
    }

    const hasUnwakeableClaims =
      o.sessionState === 'recorded' && o.wakeable === false && (o.claimCount ?? 0) > 0;
    const hadUnwakeableClaims =
      before.sessionState === 'recorded' && before.wakeable === false && (before.claimCount ?? 0) > 0;
    const claimsChanged = memberClaimSignature(o) !== memberClaimSignature(before);
    if (hasUnwakeableClaims && (!hadUnwakeableClaims || claimsChanged) && !deadLatch?.has(key) && !leftLatch?.has(key)) {
      edges.push({
        kind: 'member-left',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: 'recorded',
        from: before.sessionState,
        claimCount: o.claimCount ?? 0,
      });
      leftLatch?.set(key, {
        claimSignature: memberClaimSignature(o),
        recoveredSinceMs: null,
        lastSeenAtMs: nowMs,
      });
    }

    // Rule 3 — an UNKNOWN previous bucket is not a crossing. `null` means the
    // pressure could not be derived, NOT that the member was comfortable, so
    // `!wasCritical` must not be read as "was below critical" when the prior
    // reading is absent. Coercing it manufactures a fresh edge for a member
    // that has been sitting at critical the whole time, every time the estimate
    // lapses and comes back.
    //
    // That lapse is routine, not exotic: `deriveContextPressure` deliberately
    // degrades any estimate older than CONTEXT_ESTIMATE_STALE_MS (15 min) to
    // `null` (EI-18729596985129261), and `gatherFleetObservations` also falls
    // back to an EMPTY pressure map whenever the batch read fails. Both are
    // correct on their own, and both hand this detector a `null` for a member
    // whose bucket never actually moved — so unknown→critical repeats for as
    // long as the member stays critical. That is the repeat behind
    // EI-21968977558564590's eight coalesced edges for one retired member,
    // whose frozen telemetry re-derives as critical after every lapse.
    //
    // Same rule the stalled verdict below already applies for the same reason;
    // this brings the context signal into line with it.
    const wasCritical = before.contextPressure === CRITICAL_CONTEXT_BUCKET;
    const isCritical = o.contextPressure === CRITICAL_CONTEXT_BUCKET;
    if (isCritical && !wasCritical && before.contextPressure !== null) {
      edges.push({
        kind: 'context-critical',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: CRITICAL_CONTEXT_BUCKET,
        from: before.contextPressure,
      });
    }

    // A stalled-holder verdict is a second, independent leader intervention
    // signal. Unknown is deliberately not coerced to false: the first reliable
    // observation after a degraded read must not manufacture a crossing.
    if (o.stalled === true && before.stalled === false) {
      edges.push({
        kind: 'member-stalled',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        to: 'stalled',
        from: before.stalled ? 'stalled' : 'clear',
      });
    }

    // D-007: only the measured 1→2 edge is actionable. Unknown/first sighting
    // is not evidence, and a persistent 2→3 streak must not wake the leader
    // again. Suppressed leader/progressing members arrive as null.
    if (before.consecutiveRecoveryOnlyCycles === 1 && o.consecutiveRecoveryOnlyCycles === 2) {
      edges.push({
        kind: 'repeated-recovery',
        fleetSlug: o.fleetSlug,
        agentId: o.agentId,
        from: '1',
        to: '2',
        consecutiveRecoveryOnlyCycles: 2,
        action: 'diagnose',
        takeoverAuthorized: false,
      });
    }
  }
  // Bound the latch. Entries are dropped by AGE, never by absence from this
  // sweep: `isActionableFleetObservation` legitimately filters a member out for a
  // sweep or two, and pruning on absence would hand back the exact re-fire rule 3
  // exists to stop. Past the TTL the member is long gone and one fresh notice is
  // cheaper than holding the key forever.
  if (deadLatch) {
    for (const [k, entry] of deadLatch) {
      if (nowMs - entry.firedAtMs > MEMBER_DEAD_LATCH_TTL_MS) deadLatch.delete(k);
    }
  }
  if (leftLatch) {
    for (const [k, entry] of leftLatch) {
      if (nowMs - entry.lastSeenAtMs > MEMBER_DEAD_LATCH_TTL_MS) leftLatch.delete(k);
    }
  }
  edges.sort(
    (a, b) =>
      a.fleetSlug.localeCompare(b.fleetSlug) || a.agentId.localeCompare(b.agentId) || a.kind.localeCompare(b.kind),
  );
  return edges;
}

/** PURE: fire when a fleet gains a new distinct admission block. A persistent
 * block must not wake the leader every sweep, but a rising count is actionable
 * even when an older block is still present. A fleet with no baseline entry is
 * gated by `opts.firstSightingSinceMs` (see {@link FleetAdmissionTransitionOptions}). */
export function detectFleetAdmissionTransitions(
  prev: ReadonlyMap<string, number>,
  next: readonly FleetAdmissionObservation[],
  opts: FleetAdmissionTransitionOptions = {},
): FleetAdmissionTransitionEdge[] {
  const since = opts.firstSightingSinceMs;
  return next
    .filter(
      (observation): observation is FleetAdmissionObservation & { blockedCount: number } =>
        typeof observation.blockedCount === 'number' &&
        Number.isFinite(observation.blockedCount) &&
        observation.blockedCount > 0,
    )
    .map((observation) => {
      if (!prev.has(observation.fleetSlug) && typeof since === 'number' && Number.isFinite(since)) {
        const newest = observation.newestBlockAtMs;
        if (typeof newest === 'number' && Number.isFinite(newest) && newest < since) return null;
      }
      const before = prev.get(observation.fleetSlug) ?? 0;
      return before < observation.blockedCount
        ? {
            kind: 'admission-blocked' as const,
            fleetSlug: observation.fleetSlug,
            from: before,
            to: observation.blockedCount,
          }
        : null;
    })
    .filter((edge): edge is FleetAdmissionTransitionEdge => edge !== null)
    .sort((a, b) => a.fleetSlug.localeCompare(b.fleetSlug));
}

/**
 * Expected fail-soft noise for a best-effort fire-and-forget emit (never warn, or
 * vitest-fail-on-console flakes rig tests): a partial test schema ("… does not
 * exist"), or the async query outliving its Postgres pool
 * (CONNECTION_ENDED/DESTROYED). Anything else is a genuine surprise worth a warn.
 * Mirrors fleet-drained-events.ts / work-items-events.ts.
 */
function failSoft(scope: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (/does not exist/.test(msg)) return;
  const code = (e as { code?: unknown } | null)?.code;
  if (
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED' ||
    /CONNECTION_ENDED|CONNECTION_DESTROYED|Connection ended/i.test(msg)
  ) {
    return;
  }
  console.warn(`[fleet-transition-events] ${scope} emit failed: ${msg}`);
}

/** Injectable seams for tests. */
export interface FleetTransitionEventsDeps {
  emit?: typeof emitAwaitedEvent;
  /**
   * Re-read the current writer-backed context bucket immediately before a
   * `context-critical` event is emitted. The sweep's observation can be stale
   * by the time its detached emit runs; a non-critical current value suppresses
   * that stale wake. Omitted for non-sweep callers, which retain the historical
   * emit behavior.
   */
  currentContextPressure?: (agentId: string) => Promise<ContextPressureBucket | null>;
  /**
   * Read the member's current compaction/context generation immediately before
   * emitting a `context-critical` edge. A newer generation supersedes the
   * fire-time edge even when the cached pressure bucket has not caught up.
   */
  currentContextEpoch?: (agentId: string) => Promise<number | null>;
  /**
   * Re-read the member's current control state immediately before a queued
   * member-dead or context-critical edge emits. `null` means the member is no
   * longer in the fleet; a rejected read is treated as unknown and preserves
   * the old signal.
   */
  currentMemberObservation?: (
    fleetSlug: string,
    agentId: string,
  ) => Promise<
    Pick<
      FleetMemberObservation,
      'sessionState' | 'wakeable' | 'claimCount' | 'isRegisteredLeader' | 'hasProgressingClaim' | 'stalled'
    > | null
  >;
  /** Resolve an agent's current fleet. Default = the canonical append-only
   *  membership fact; injected as a stub in tests. */
  fleetOfAgent?: (workspaceId: string, ownerId: string) => Promise<string | null>;
  /** Confirm that a released item belongs to the fleet's authored claim lane.
   * Injected in unit tests; the default reads the fleet sentinel and reuses the
   * scheduler's WorkItem matcher. */
  fleetClaimScopeMatches?: (workspaceId: string, fleetSlug: string, item: WorkItem) => Promise<boolean>;
}

/**
 * Read the shared session context generation for an edge payload. The ledger
 * helper is fail-soft and returns 0 when unavailable; 0 is treated as unknown
 * here so a transient read failure cannot stamp a false old generation onto a
 * real context-critical wake. Positive generations are optional payload data.
 */
async function readCurrentContextEpoch(agentId: string): Promise<number | null> {
  try {
    const [{ currentSessionEpoch }, { getOrgPg }] = await Promise.all([
      import('./memory/session-epoch-ledger'),
      import('@papercusp/db-org'),
    ]);
    const epoch = await currentSessionEpoch(getOrgPg().sql, agentId);
    return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
  } catch {
    return null;
  }
}

/**
 * The holder's fleet, from the CANONICAL append-only membership fact
 * (`harness_shared.fleet_membership_events`) rather than the `coord_presence`
 * projection of it.
 *
 * The distinction is load-bearing here: a work-item is very often released BY THE
 * REAPER precisely because its holder DIED, and the presence row of a dead agent is
 * evicted on a TTL (presence-reaper.ts). Reading the projection would therefore
 * lose the fleet exactly in the case a leader most needs the signal — an orphaned
 * claim. The membership fact survives death by design (WI-1345), so it answers.
 *
 * Fail-soft: any read failure resolves to null (no event), never a throw — this
 * runs inside a fire-and-forget emit on a write path that must not be breakable.
 */
export async function fleetSlugOfAgent(
  workspaceId: string,
  ownerId: string | null | undefined,
  deps: Pick<FleetTransitionEventsDeps, 'fleetOfAgent'> = {},
): Promise<string | null> {
  if (!ownerId) return null;
  const resolve =
    deps.fleetOfAgent ??
    (async (ws: string, owner: string) => {
      const { latestFleetMembership } = await import('./fleet-membership-store');
      return (await latestFleetMembership(ws, owner))?.fleetSlug ?? null;
    });
  try {
    return await resolve(workspaceId, ownerId);
  } catch {
    return null;
  }
}

/**
 * Keep a fleet-scoped release wake tied to the work its fleet can actually claim.
 *
 * Membership identifies the actor that released the item, not the item's lane.
 * A leader can therefore belong to fleet A while releasing a cross-harness item
 * from harness B. Read the fleet sentinel (rather than the member's possibly
 * overridden spec), require an authored fleet spec and its concrete harness
 * binding, then reuse the scheduler's WorkItem matcher for the remaining filter.
 * Any read or matcher failure fails closed: this is a wake optimization and must
 * never manufacture a cross-scope signal.
 */
async function defaultFleetClaimScopeMatches(
  workspaceId: string,
  fleetSlug: string,
  item: WorkItem,
): Promise<boolean> {
  const [{ getClaimSpecRecord, fleetSpecBeeKey }, { matchesWorkItemClaimSpec }] = await Promise.all([
    import('./scheduler/claim-spec-store'),
    import('./scheduler/claim-spec-match'),
  ]);
  const record = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleetSlug), workspaceId });
  if (record.source !== 'fleet' || record.fleetSlug !== fleetSlug) return false;
  if (record.harnessSlug && item.harness !== record.harnessSlug) return false;
  return matchesWorkItemClaimSpec(item, record.spec);
}

/**
 * Fire one detected member-dead / context-critical edge. Awaiter-only (no `to`
 * push): the audience is whoever registered interest in this fleet — which is the
 * leader, and the point is that it is ASLEEP. Fire-and-forget; never throws.
 */
export function emitFleetTransitionEdge(edge: FleetTransitionEdge, deps: FleetTransitionEventsDeps = {}): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  const currentContextEpoch = deps.currentContextEpoch ?? readCurrentContextEpoch;
  const summary =
    edge.kind === 'member-dead'
      ? `fleet ${edge.fleetSlug}: member ${edge.agentId} is DEAD (${edge.from ?? 'unknown'} → ${edge.to})`
      : edge.kind === 'member-left'
        ? 'fleet ' +
          edge.fleetSlug +
          ': member ' +
          edge.agentId +
          ' is recorded and unwakeable with ' +
          edge.claimCount +
          ' active claim(s); inspect assignments before reclaiming'
      : edge.kind === 'context-critical'
        ? `fleet ${edge.fleetSlug}: member ${edge.agentId} context pressure is CRITICAL (${edge.from ?? 'unknown'} → ${edge.to})`
        : edge.kind === 'repeated-recovery'
          ? `fleet ${edge.fleetSlug}: member ${edge.agentId} completed ${edge.consecutiveRecoveryOnlyCycles} consecutive recovery-only cycles — diagnose the blocker; takeover is NOT authorized`
          : `fleet ${edge.fleetSlug}: member ${edge.agentId} claim is STALLED (${edge.from ?? 'unknown'} → ${edge.to})`;
  void Promise.resolve()
    .then(async () => {
      // A queued edge can outlive a graceful stand-down. Revalidate the member
      // control state before delivery so recorded/non-wakeable claimless residue
      // cannot wake a leader after it has become non-actionable.
      if (
        (edge.kind === 'member-dead' ||
          edge.kind === 'member-left' ||
          edge.kind === 'context-critical' ||
          edge.kind === 'member-stalled' ||
          edge.kind === 'repeated-recovery') &&
        deps.currentMemberObservation
      ) {
        let currentMember:
          | Pick<
              FleetMemberObservation,
              'sessionState' | 'wakeable' | 'claimCount' | 'isRegisteredLeader' | 'hasProgressingClaim' | 'stalled'
            >
          | null
          | undefined;
        try {
          currentMember = await deps.currentMemberObservation(edge.fleetSlug, edge.agentId);
        } catch (e: unknown) {
          failSoft(`${edge.kind} member revalidation for ${edge.fleetSlug}/${edge.agentId}`, e);
        }
        if (currentMember === null) return;
        if (
          edge.kind === 'member-dead' &&
          currentMember !== undefined &&
          currentMember.sessionState !== null &&
          currentMember.sessionState !== 'ended'
        ) {
          return;
        }
        if (
          edge.kind === 'member-left' &&
          currentMember !== undefined &&
          (currentMember.sessionState !== 'recorded' ||
            currentMember.wakeable !== false ||
            (currentMember.claimCount ?? 0) === 0)
        ) {
          return;
        }
        if (
          edge.kind === 'context-critical' &&
          currentMember !== undefined &&
          !isActionableFleetObservation(currentMember)
        ) {
          return;
        }
        if (
          edge.kind === 'member-stalled' &&
          currentMember !== undefined &&
          currentMember.stalled !== true
        ) {
          return;
        }
        if (
          edge.kind === 'repeated-recovery' &&
          currentMember !== undefined &&
          (currentMember.isRegisteredLeader === true || currentMember.hasProgressingClaim === true)
        ) {
          return;
        }
      }
      // The sweep's bucket is a watchdog-cached observation. Revalidate only
      // this derived edge, at the last responsible moment, so recovery between
      // observation and delivery cannot wake a leader with an obsolete payload.
      if (edge.kind === 'context-critical' && deps.currentContextPressure) {
        let current: ContextPressureBucket | null;
        try {
          current = await deps.currentContextPressure(edge.agentId);
        } catch (e: unknown) {
          // A failed revalidation must not break the detached event path. The
          // original sweep observation is still the best available signal when
          // the current writer cannot be read; a successful non-critical read
          // is what suppresses the stale wake.
          failSoft(`context-critical revalidation for ${edge.fleetSlug}/${edge.agentId}`, e);
          current = CRITICAL_CONTEXT_BUCKET;
        }
        if (current !== CRITICAL_CONTEXT_BUCKET) return;
      }
      let contextEpoch: number | null = null;
      if (edge.kind === 'context-critical') {
        try {
          const observed = await currentContextEpoch(edge.agentId);
          if (typeof observed === 'number' && Number.isSafeInteger(observed) && observed >= 0) {
            contextEpoch = observed;
          }
        } catch (e: unknown) {
          failSoft(`context-critical generation for ${edge.fleetSlug}/${edge.agentId}`, e);
        }
      }
      await emit({
        key: fleetTransitionKey(edge.fleetSlug, edge.kind),
        summary,
        payload: {
          fleetSlug: edge.fleetSlug,
          agentId: edge.agentId,
          transition: edge.kind,
          from: edge.from,
          to: edge.to,
          ...(edge.kind === 'repeated-recovery'
            ? {
                consecutiveRecoveryOnlyCycles: edge.consecutiveRecoveryOnlyCycles,
                action: edge.action,
                takeoverAuthorized: edge.takeoverAuthorized,
              }
            : {}),
          ...(edge.kind === 'member-left' ? { claimCount: edge.claimCount } : {}),
          ...(contextEpoch === null ? {} : { contextEpoch }),
        },
        source: 'fleet',
      });
    })
    .catch((e: unknown) => failSoft(`${edge.kind} for ${edge.fleetSlug}/${edge.agentId}`, e));
}

/** Fire a fleet-level admission-block edge. Awaiter-only and fail-soft, like
 * the member transition emitter above. */
export function emitFleetAdmissionTransitionEdge(
  edge: FleetAdmissionTransitionEdge,
  deps: FleetTransitionEventsDeps = {},
): void {
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(edge.fleetSlug, edge.kind),
        summary: `fleet ${edge.fleetSlug}: claim admission is BLOCKED (${edge.from} → ${edge.to} distinct refusal(s))`,
        payload: {
          fleetSlug: edge.fleetSlug,
          transition: edge.kind,
          from: edge.from,
          to: edge.to,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`${edge.kind} for ${edge.fleetSlug}`, e));
}

/**
 * Fire `fleet:<slug>:claim-released` — a member's claim returned to the pool, so
 * the leader can re-place the work without waiting for its next poll. Co-fired
 * from `releaseWorkItem`'s existing emit point alongside the id-scoped
 * `claim:released:<id>`, which keeps firing unchanged for delegators awaiting a
 * SPECIFIC item.
 *
 * `fleetSlug` is the PRIOR holder's fleet, resolved by the caller — a released
 * item no longer carries its holder, so the fleet cannot be recovered from the
 * item alone. A caller that cannot resolve one passes null and nothing fires:
 * an unfleeted agent's release is not a fleet transition. Never throws.
 */
export function emitFleetClaimReleasedEvent(
  fleetSlug: string | null | undefined,
  item: { id: string; title?: string | null; harness?: string | null },
  priorAssignee: string | null,
  deps: FleetTransitionEventsDeps = {},
): void {
  if (!fleetSlug) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(fleetSlug, 'claim-released'),
        summary: `fleet ${fleetSlug}: ${item.id} released by ${priorAssignee ?? 'unknown'} — back to the pool`,
        payload: {
          fleetSlug,
          transition: 'claim-released',
          id: item.id,
          title: item.title ?? null,
          harness: item.harness ?? null,
          priorAssignee,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`claim-released for ${fleetSlug}/${item.id}`, e));
}

/**
 * Fire `fleet:<slug>:item-completed` — a member settled an item, so the leader can
 * feed it more work or judge the burn-down without polling. Co-fired from
 * `emitWorkItemSettledEvents` alongside the id-scoped `work-item:done:<id>`, which
 * keeps firing unchanged.
 *
 * `fleetSlug` is the settling holder's fleet, resolved by the caller; null fires
 * nothing (an unfleeted agent's completion is not a fleet transition). Never throws.
 */
export function emitFleetItemCompletedEvent(
  fleetSlug: string | null | undefined,
  item: { id: string; state: string; title?: string | null; harness?: string | null; assignee?: string | null },
  deps: FleetTransitionEventsDeps = {},
): void {
  if (!fleetSlug) return;
  const emit = deps.emit ?? emitAwaitedEvent;
  void Promise.resolve()
    .then(() =>
      emit({
        key: fleetTransitionKey(fleetSlug, 'item-completed'),
        summary: `fleet ${fleetSlug}: ${item.id} settled → ${item.state} by ${item.assignee ?? 'unknown'}`,
        payload: {
          fleetSlug,
          transition: 'item-completed',
          id: item.id,
          state: item.state,
          title: item.title ?? null,
          harness: item.harness ?? null,
          assignee: item.assignee ?? null,
        },
        source: 'fleet',
      }),
    )
    .catch((e: unknown) => failSoft(`item-completed for ${fleetSlug}/${item.id}`, e));
}

/** Resolve the workspace for a fleet lookup. Injectable so the announce helpers
 *  below unit-test without the workspace registry. */
async function defaultWorkspaceId(): Promise<string> {
  const { activeWorkspaceId } = await import('./workspace-registry');
  return activeWorkspaceId();
}

/** The announce helpers' seams: everything `emit`/`fleetOfAgent` need, plus the
 *  workspace resolution the fleet lookup is scoped by. */
export interface FleetAnnounceDeps extends FleetTransitionEventsDeps {
  workspaceId?: () => Promise<string>;
}

/**
 * Resolve the PRIOR holder's fleet and fire `fleet:claim-released:<slug>`.
 *
 * The one-line call-site form for `releaseWorkItem`, which already knows the
 * pre-release assignee from the row-read it performs before the UPDATE (passing it
 * in avoids a second, racy read — see releaseWorkItem's `onPriorState` doc).
 * Entirely fire-and-forget: nothing here can reject into, or delay, the release.
 */
export function announceFleetClaimReleased(
  priorAssignee: string | null | undefined,
  item: WorkItem,
  deps: FleetAnnounceDeps = {},
): void {
  if (!priorAssignee) return; // an unheld item's release is not a fleet transition
  void Promise.resolve()
    .then(async () => {
      const ws = await (deps.workspaceId ?? defaultWorkspaceId)();
      const fleetSlug = await fleetSlugOfAgent(ws, priorAssignee, deps);
      if (!fleetSlug) return;
      const inFleetScope = await (deps.fleetClaimScopeMatches ?? defaultFleetClaimScopeMatches)(ws, fleetSlug, item);
      if (!inFleetScope) return;
      emitFleetClaimReleasedEvent(fleetSlug, item, priorAssignee, deps);
    })
    .catch((e: unknown) => failSoft(`claim-released announce for ${item.id}`, e));
}

/**
 * Resolve the settling holder's fleet and fire `fleet:item-completed:<slug>`.
 * The one-line call-site form for `emitWorkItemSettledEvents`. Terminal writes
 * clear the item's assignee, so callers pass the pre-write holder explicitly.
 * Fire-and-forget.
 */
export function announceFleetItemCompleted(
  item: { id: string; state: string; title?: string | null; harness?: string | null; assignee?: string | null },
  priorAssignee: string | null | undefined = item.assignee,
  deps: FleetAnnounceDeps = {},
): void {
  if (!priorAssignee) return; // an unheld item settling is not a fleet transition
  void Promise.resolve()
    .then(async () => {
      const ws = await (deps.workspaceId ?? defaultWorkspaceId)();
      const fleetSlug = await fleetSlugOfAgent(ws, priorAssignee, deps);
      // Keep the post-state item truthful while giving the event its real
      // attribution. This copy never escapes the event fanout.
      emitFleetItemCompletedEvent(fleetSlug, { ...item, assignee: priorAssignee }, deps);
    })
    .catch((e: unknown) => failSoft(`item-completed announce for ${item.id}`, e));
}
