/**
 * member-recovery.ts — P-009 (fleet-friction-remediation-2026-08-21): bounded, IDEMPOTENT
 * recovery for wedged and context-critical fleet members.
 *
 * WHY THIS EXISTS (measured, 2026-09-04 evening — the plan item's own reproduction). A steward
 * hit the same class three separate times in one evening:
 *   1. a dead claim holder that needed a FORCED release (liveness basis 'holder-warm-idle') —
 *      the process was gone, so nothing ever ran the release path, and the claim sat held;
 *   2. a live member running with `durableWake` MISSING — alive, but with no wake source, so it
 *      would never take another turn and no timeout would ever fire;
 *   3. two `coord:send { wake: 'required' }` calls reporting `queued:1 / woken:1` where NEITHER
 *      target ever took a turn — a delivery count read as a pickup confirmation.
 * In all three the member is neither healthy nor cleanly dead. `fleet:respawn-member` today has
 * exactly one answer for that band: refuse (`kill_failed` / `cooperative_drain_unverified`) and
 * return. The old member stays live and wedged, its claims stay held, nothing is marked, and the
 * leader's only recorded evidence is a failed tool call. That is the "indefinitely live wedge"
 * the acceptance criteria forbid.
 *
 * WHAT THIS MODULE IS. The PURE decision core for that band — no PG, no clock, no process
 * signals. It answers one question, "what should happen to this member right now?", and hands
 * the caller a disposition plus the exact side effects to perform. The IO (freeze, kill, launch,
 * emit, persist) stays with the callers, which is what makes every acceptance scenario below a
 * plain unit test rather than an integration fixture.
 *
 * WHY PURE + SHARED rather than inlined at the call site — the same reasoning recorded in
 * `scheduler/context-pressure-claim-gate.ts`, and for the same reason: there is more than one
 * surface that must answer identically. `fleet:respawn-member` decides recovery; the self-select
 * claim path decides context-critical benching; `fleet:leader-brief` renders the reason. Three
 * readers of one verdict. get_next.ts already carries the scar of letting exactly that drift
 * (its `concurrencyBlockedRefusal` comment records a refusal that existed on one branch only).
 *
 * ⚠ THE CENTRAL HAZARD — a recovery must never produce a SECOND live member on one lane.
 * Two members racing one claim lane is strictly worse than a wedge: the wedge is visible and
 * stationary, the race silently double-writes. Every ambiguous reading in this module therefore
 * resolves AWAY from launching. Three properties enforce it, each asserted by a test:
 *   1. THE TOKEN IS THE IDEMPOTENCY KEY. A recovery is identified by a durable token, not by
 *      wall-clock or roster position. Replaying the same token NEVER re-runs the decision — it
 *      replays the settled answer. A duplicate leader request is therefore a no-op that reports
 *      the replacement identity the first request already authorized.
 *   2. AT MOST ONE REPLACEMENT IDENTITY PER TOKEN. The replacement owner-id is derived from the
 *      token, so a reclaim after a leader crash re-derives the SAME identity rather than minting
 *      a second one. Combined with the caller's live-host collision check, a crashed leader
 *      cannot leave a replacement behind that a successor duplicates.
 *   3. UNCERTAINTY STRANDS, IT DOES NOT REPLACE. A kill that failed and a drain that was ignored
 *      both mean "the old process may still be running". Neither authorizes a launch. They
 *      freeze and MARK instead, which converts an invisible wedge into an actionable failure.
 *
 * ⚠ THE SECOND HAZARD, opposite direction — a stale reading must never manufacture a false
 * drain. Context pressure is cached by a ~2-minute watchdog sweep, not read live
 * (context-pressure-claim-gate.ts records a member whose cached row read 'critical' moments
 * after its own live gauge read 12%). So an UNKNOWN bucket never benches, and benching is not a
 * terminal state: a benched member is parked on a wake key with its claims intact, and comes
 * back on its own. Benching costs a member one compaction; stranding costs it its process. The
 * gap between those two is exactly why 'unknown' must fail open to neither.
 */

import type { ContextPressureBucket } from '../agent-tools/coordination/context-pressure';

/** How the leader's kill attempt actually resolved. Mirrors `killOutcome()` in respawn-member. */
export type MemberKillOutcome =
  /** SIGTERM delivered and the managed session is gone. */
  | 'killed'
  /** Nothing to kill — the process was already gone before we asked. */
  | 'already-dead'
  /** Not a managed session; a cooperative drain was requested instead. */
  | 'unmanaged'
  /** The kill was attempted and FAILED. The old process may still be running. */
  | 'failed';

/** What happened to the cooperative drain request, when one was needed. */
export type MemberDrainOutcome =
  /** No cooperative drain was required (the kill path settled it). */
  | 'not-required'
  /** The member acknowledged and reached a verified terminal state. */
  | 'verified'
  /** The member never reached a terminal state inside the window — the ignored-wake case. */
  | 'unverified';

/**
 * What the leader should do. Exactly one of these, and only `replace` authorizes a launch.
 *
 * `benched` and `stranded` are BOTH non-terminal for the member's work — the difference is
 * whether the member is expected to recover itself. A benched member will (it compacts and
 * resumes). A stranded one will not, and needs a leader.
 */
export type MemberRecoveryDisposition =
  /** Safe to launch EXACTLY ONE replacement under `replacementOwnerId`. */
  | 'replace'
  /** A live recovery already owns this member. Do not launch; verify the existing replacement. */
  | 'duplicate-suppressed'
  /** The old member may still be live. Freeze + mark it. NEVER launch behind it. */
  | 'stranded'
  /** The member is healthy but context-critical. Park it on a wake key; it recovers itself. */
  | 'benched'
  /** Recovery cannot proceed and needs a leader decision. Never launch. */
  | 'actionable-failure';

/** What must happen to the member's claims. A claim is never silently dropped. */
export type MemberClaimDisposition =
  /** The kill path released them as it terminated the session. Nothing further to do. */
  | 'released-by-kill'
  /**
   * The process is gone but nothing ran the release path, so the rows are still held by a dead
   * owner. The caller MUST force-release them — this is the 'holder-warm-idle' case from the
   * reproduction, where a claim outlived its holder.
   */
  | 'force-release-required'
  /**
   * Deliberately LEFT HELD. The old process may still be writing, so releasing the lane would
   * invite a second worker onto live work. Preserved until the strand is resolved.
   */
  | 'preserved-frozen'
  /** The member keeps its claims and resumes on them after it compacts. */
  | 'preserved-benched';

/** A durable, leader-crash-surviving record of one recovery attempt. */
export interface MemberRecoveryToken {
  version: 1;
  /** Stable identifier for this recovery attempt. Callers persist and replay by this. */
  token: string;
  fleetSlug: string;
  memberOwnerId: string;
  /** Owner-id of the leader that opened the recovery (audit + crash attribution). */
  openedBy: string;
  openedAt: number;
  /**
   * Lease expiry, epoch ms. While live, only `openedBy`'s recovery is honoured and every other
   * request is suppressed. Once expired the token is RECLAIMABLE — that is the leader-crash
   * path, and it re-derives the same replacement identity rather than minting a second.
   */
  leaseExpiresAt: number;
  /** The single replacement identity this token authorizes. Derived from the token. */
  replacementOwnerId: string;
  /** `open` while in flight; anything else is settled and replays verbatim. */
  outcome: 'open' | 'replaced' | 'stranded' | 'benched' | 'failed';
  /** Human-readable cause, carried onto the transition event and the leader brief. */
  reason: string;
}

/** Default lease: long enough to cover a worst-case drain + verify, short enough to reclaim. */
export const MEMBER_RECOVERY_LEASE_MS = 15 * 60 * 1000;

export interface MemberRecoveryDecision {
  disposition: MemberRecoveryDisposition;
  /** The ONLY field that authorizes a launch. False on every disposition but `replace`. */
  replacementAuthorized: boolean;
  /** The identity a launch must use, when one is authorized (or the one already authorized). */
  replacementOwnerId: string | null;
  claims: MemberClaimDisposition;
  /** True when the caller must freeze the old process before doing anything else. */
  freezeRequested: boolean;
  /**
   * The transition edge to emit, WITH its cause. The acceptance criteria require the reason to
   * travel with the event — an edge that says only "member-stalled" sends the next reader back
   * to the logs this whole module exists to replace.
   */
  transition: { kind: 'member-dead' | 'member-stalled' | 'context-critical'; reason: string } | null;
  /** One-line cause, suitable verbatim for the leader brief and the work-item record. */
  reason: string;
  /** The token to persist. Always returned, so a caller never has to reconstruct one. */
  token: MemberRecoveryToken;
  /** True when this decision replayed a settled token instead of evaluating fresh state. */
  replayed: boolean;
  /** True when an expired token was taken over from a crashed/departed leader. */
  reclaimed: boolean;
}

export interface MemberRecoveryInput {
  fleetSlug: string;
  memberOwnerId: string;
  /** The leader making the request. */
  leaderOwnerId: string;
  /** Stable per-attempt key. The SAME key is the same recovery — that is the idempotency. */
  attemptKey: string;
  kill: MemberKillOutcome;
  /** Defaults to 'not-required'. */
  drain?: MemberDrainOutcome;
  /** The member's cached context-pressure bucket; null/undefined means unknown. */
  contextPressure?: ContextPressureBucket | null;
  /**
   * Whether the member is observably still live. Used only to distinguish a healthy
   * context-critical member (bench) from a wedge (strand) — never to authorize a launch.
   */
  memberLive?: boolean;
  /** The durable token from a previous request under the same attemptKey, if any. */
  priorToken?: MemberRecoveryToken | null;
  now: number;
  leaseMs?: number;
  /** Injectable so the derived identity is deterministic in tests. */
  deriveReplacementOwnerId?: (token: string) => string;
}

/** Field separator for the token digest. NUL can never occur inside a slug or owner-id. */
const TOKEN_FIELD_SEPARATOR = '\x00';

/**
 * Derive the recovery token id. Deterministic in its inputs so the SAME (fleet, member,
 * attemptKey) triple always names the same recovery — including across a leader crash, which is
 * what lets a successor reclaim rather than duplicate.
 *
 * Not a cryptographic identity: it names a recovery attempt, it does not authorize one. The
 * lease and `outcome` do that.
 */
export function memberRecoveryTokenId(fleetSlug: string, memberOwnerId: string, attemptKey: string): string {
  const normalized = [fleetSlug, memberOwnerId, attemptKey].join(TOKEN_FIELD_SEPARATOR);
  // FNV-1a 32-bit, doubled over two offsets for a 64-bit-wide id. Deliberately dependency-free
  // and synchronous: this module stays pure so every acceptance case is a unit test.
  const fnv = (seed: number): string => {
    let hash = seed >>> 0;
    for (let i = 0; i < normalized.length; i += 1) {
      hash ^= normalized.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x7f4a7c15)}`;
}

/** The replacement identity a token authorizes. One token, one identity, forever. */
export function replacementOwnerIdForToken(token: string): string {
  return `su-respawn-${token}`;
}

function settledOutcomeToDisposition(outcome: MemberRecoveryToken['outcome']): MemberRecoveryDisposition {
  switch (outcome) {
    case 'replaced':
      return 'duplicate-suppressed';
    case 'stranded':
      return 'stranded';
    case 'benched':
      return 'benched';
    default:
      return 'actionable-failure';
  }
}

function claimsForSettled(outcome: MemberRecoveryToken['outcome']): MemberClaimDisposition {
  switch (outcome) {
    case 'replaced':
      return 'released-by-kill';
    case 'stranded':
      return 'preserved-frozen';
    case 'benched':
      return 'preserved-benched';
    default:
      return 'preserved-frozen';
  }
}

/**
 * The decision. PURE: same inputs, same answer, no IO and no ambient clock.
 *
 * ORDERING IS LOAD-BEARING and mirrors the context-pressure gate's rationale — the checks that
 * PREVENT a launch are consulted before the ones that could authorize one, so no stale or
 * partial reading can defeat them:
 *   1. a settled token replays (a duplicate request can never re-run the decision);
 *   2. a live lease held by anyone suppresses (concurrent leaders cannot both launch);
 *   3. an expired lease reclaims onto the SAME identity (a crashed leader cannot be duplicated);
 *   4. context-critical benches BEFORE any kill reading is trusted (a healthy member that merely
 *      needs to compact must never be killed for it);
 *   5. only then does the kill/drain reading get to authorize a replacement.
 */
export function decideMemberRecovery(input: MemberRecoveryInput): MemberRecoveryDecision {
  const {
    fleetSlug,
    memberOwnerId,
    leaderOwnerId,
    attemptKey,
    kill,
    now,
  } = input;
  const drain: MemberDrainOutcome = input.drain ?? 'not-required';
  const leaseMs = input.leaseMs ?? MEMBER_RECOVERY_LEASE_MS;
  const tokenId = memberRecoveryTokenId(fleetSlug, memberOwnerId, attemptKey);
  const derive = input.deriveReplacementOwnerId ?? replacementOwnerIdForToken;
  const replacementOwnerId = derive(tokenId);
  const prior = input.priorToken ?? null;

  const freshToken = (
    outcome: MemberRecoveryToken['outcome'],
    reason: string,
    openedBy = leaderOwnerId,
    openedAt = now,
  ): MemberRecoveryToken => ({
    version: 1,
    token: tokenId,
    fleetSlug,
    memberOwnerId,
    openedBy,
    openedAt,
    leaseExpiresAt: now + leaseMs,
    replacementOwnerId,
    outcome,
    reason,
  });

  // 1. SETTLED TOKEN → replay verbatim. A duplicate leader request must never re-evaluate:
  //    re-evaluating is how a second replacement gets authorized for a recovery that already
  //    produced one.
  if (prior && prior.token === tokenId && prior.outcome !== 'open') {
    const disposition = settledOutcomeToDisposition(prior.outcome);
    return {
      disposition,
      replacementAuthorized: false,
      replacementOwnerId: prior.replacementOwnerId,
      claims: claimsForSettled(prior.outcome),
      freezeRequested: false,
      transition: null,
      reason: `recovery ${prior.token} already settled as '${prior.outcome}': ${prior.reason}`,
      token: prior,
      replayed: true,
      reclaimed: false,
    };
  }

  // 2. OPEN TOKEN WITH A LIVE LEASE → suppress, whoever asked. Reporting the already-authorized
  //    replacement identity is what makes this an idempotent answer rather than a bare refusal:
  //    the caller can go VERIFY that replacement instead of launching a second one.
  if (prior && prior.token === tokenId && prior.outcome === 'open' && prior.leaseExpiresAt > now) {
    return {
      disposition: 'duplicate-suppressed',
      replacementAuthorized: false,
      replacementOwnerId: prior.replacementOwnerId,
      claims: 'preserved-frozen',
      freezeRequested: false,
      transition: null,
      reason:
        `recovery ${prior.token} is already in flight (opened by ${prior.openedBy}, lease expires ` +
        `${new Date(prior.leaseExpiresAt).toISOString()}) — verify replacement ${prior.replacementOwnerId}; ` +
        'do not launch a second one',
      token: prior,
      replayed: false,
      reclaimed: false,
    };
  }

  // 3. OPEN TOKEN WITH AN EXPIRED LEASE → the opening leader is gone. Reclaim onto the SAME
  //    derived identity and fall through to a fresh evaluation. This is the leader-crash case;
  //    it must not mint a second identity, or the crash turns into a duplicate.
  const reclaimed = Boolean(prior && prior.token === tokenId && prior.outcome === 'open' && prior.leaseExpiresAt <= now);
  const inheritedOpenedBy = reclaimed && prior ? prior.openedBy : leaderOwnerId;
  const inheritedOpenedAt = reclaimed && prior ? prior.openedAt : now;

  // 4. CONTEXT-CRITICAL BENCH, before any kill reading is trusted. A member that is merely full
  //    is not wedged: it will compact and resume on its own claims. Killing it discards a live
  //    session for a condition that resolves itself, so the bench is checked first and wins.
  //    Only a LIVE member with a KNOWN-critical bucket benches — an unknown bucket must never
  //    manufacture a bench any more than it may manufacture a refusal.
  if (input.memberLive === true && input.contextPressure === 'critical' && kill !== 'failed') {
    const reason =
      `member ${memberOwnerId} is live at CRITICAL context pressure — benched to self-compact rather ` +
      'than replaced; its claims are preserved and it resumes on them';
    return {
      disposition: 'benched',
      replacementAuthorized: false,
      replacementOwnerId: null,
      claims: 'preserved-benched',
      freezeRequested: false,
      transition: { kind: 'context-critical', reason },
      reason,
      token: freshToken('benched', reason),
      replayed: false,
      reclaimed,
    };
  }

  // 5. THE KILL / DRAIN READING. Everything from here either authorizes exactly one replacement
  //    or strands. There is deliberately no third answer that leaves the member as it found it.
  if (kill === 'failed') {
    const reason =
      `kill of ${memberOwnerId} FAILED — the old process may still be running, so no replacement was ` +
      'launched. Frozen and stranded; its claims are preserved until a leader resolves the wedge';
    return {
      disposition: 'stranded',
      replacementAuthorized: false,
      replacementOwnerId: null,
      claims: 'preserved-frozen',
      freezeRequested: true,
      transition: { kind: 'member-stalled', reason },
      reason,
      token: freshToken('stranded', reason),
      replayed: false,
      reclaimed,
    };
  }

  if (kill === 'unmanaged' && drain === 'unverified') {
    const reason =
      `unmanaged member ${memberOwnerId} did not reach a verified terminal state within the drain ` +
      'window (the ignored-wake case: delivery was queued but no turn followed) — frozen and stranded ' +
      'rather than replaced, because a live unmanaged session behind a replacement double-runs the lane';
    return {
      disposition: 'stranded',
      replacementAuthorized: false,
      replacementOwnerId: null,
      claims: 'preserved-frozen',
      freezeRequested: true,
      transition: { kind: 'member-stalled', reason },
      reason,
      token: freshToken('stranded', reason),
      replayed: false,
      reclaimed,
    };
  }

  if (kill === 'already-dead') {
    // The dead-PID case from the reproduction. Nothing ran the release path, so the claims are
    // still held by an owner that no longer exists — the caller must force-release them, and
    // saying so explicitly is the difference between a recovered lane and a silently stuck one.
    const reason =
      `member ${memberOwnerId} was already dead (no process to kill) — its claims outlived their holder ` +
      'and must be force-released before the replacement pulls';
    return {
      disposition: 'replace',
      replacementAuthorized: true,
      replacementOwnerId,
      claims: 'force-release-required',
      freezeRequested: false,
      transition: { kind: 'member-dead', reason },
      reason,
      token: freshToken('open', reason, inheritedOpenedBy, inheritedOpenedAt),
      replayed: false,
      reclaimed,
    };
  }

  // 'killed', or 'unmanaged' with a verified cooperative drain: the session terminated through a
  // path that releases its own claims, so exactly one replacement is authorized.
  const drained = kill === 'unmanaged' ? 'cooperatively drained' : 'killed';
  const reason = `member ${memberOwnerId} was ${drained} cleanly; claims released with the session`;
  return {
    disposition: 'replace',
    replacementAuthorized: true,
    replacementOwnerId,
    claims: 'released-by-kill',
    freezeRequested: false,
    transition: { kind: 'member-dead', reason },
    reason,
    token: freshToken('open', reason, inheritedOpenedBy, inheritedOpenedAt),
    replayed: false,
    reclaimed,
  };
}

/**
 * Settle an open token once the caller has finished the side effects it was handed. Callers
 * persist the returned record; a later request under the same attemptKey then REPLAYS it instead
 * of re-running the decision, which is what closes the duplicate-replacement hole across a
 * leader crash that lands between the launch and the persist.
 */
export function settleMemberRecoveryToken(
  token: MemberRecoveryToken,
  outcome: Exclude<MemberRecoveryToken['outcome'], 'open'>,
  reason: string,
): MemberRecoveryToken {
  return { ...token, outcome, reason };
}

/**
 * The claim-path half of P-009: should this self-selecting member be BENCHED before its claim
 * lane is even evaluated?
 *
 * This is deliberately NOT a second context-pressure policy. `decideContextPressureGate` already
 * owns whether a critical member is SERVED, and it must stay the single authority on that — this
 * answers the different question of what to do with the member once it has been refused. Today a
 * refused member is told to compact and left to re-pull on its own, which is exactly the shape
 * that produced the reproduction's third case: nothing observes whether it ever came back.
 * Benching it parks it on a wake key the leader can see and count.
 *
 * Fail-closed on bench, fail-open on work: an unknown bucket benches NOBODY, and a bench never
 * touches the member's claims.
 */
export function decideContextCriticalBench(input: {
  /** The gate's own verdict. Benching only ever follows an actual refusal. */
  claimRefused: boolean;
  bucket: ContextPressureBucket | null | undefined;
  /** Whether a bench wake key is available for this fleet. Without one, do not bench. */
  wakeEvent?: string | null;
  /** Already parked? Then this is a no-op, not a second bench. */
  alreadyBenched?: boolean;
}): { bench: boolean; wakeEvent: string | null; reason: string } {
  if (!input.claimRefused) {
    return { bench: false, wakeEvent: null, reason: 'claim was served; nothing to bench' };
  }
  if (input.bucket !== 'critical') {
    return { bench: false, wakeEvent: null, reason: `context pressure '${input.bucket ?? 'unknown'}' is not critical` };
  }
  if (input.alreadyBenched === true) {
    return { bench: false, wakeEvent: null, reason: 'member is already benched on a wake key' };
  }
  const wakeEvent = input.wakeEvent?.trim();
  if (!wakeEvent) {
    return {
      bench: false,
      wakeEvent: null,
      reason: 'no bench wake key is available for this fleet — refusing to park a member with no way back',
    };
  }
  return {
    bench: true,
    wakeEvent,
    reason:
      'context pressure CRITICAL and the claim was refused — benched on ' +
      `${wakeEvent} so the leader can see the member is parked rather than silently idle; ` +
      'claims are preserved and the member resumes on them after it compacts',
  };
}
