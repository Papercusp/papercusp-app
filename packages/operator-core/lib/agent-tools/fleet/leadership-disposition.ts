/**
 * leadership-disposition.ts — what `fleet:leader-brief` should do when the caller
 * is NOT the fleet's registered leader (coordination-spec-adoption-2026-08-03
 * P-004, ruling D-096).
 *
 * PURE. No IO, no imports beyond the SessionState type — the caller supplies the
 * registry's leader and that leader's liveness, and this decides. Split out of
 * leader-brief.ts (already ~1300 lines, and over its prompt-weight budget) so the
 * rule can be tested exhaustively without standing up a roster.
 *
 * ── WHY NOT SIMPLY "AUTO-CLAIM", WHICH IS WHAT P-004 ASKED FOR ───────────────
 *
 * P-004 offered two options: auto-claim leadership, or refuse with the reason.
 * Both are defective as stated, and the measurement is what shows it.
 *
 * MEASURED 30d before designing (papercusp-workspace, leader-brief calls with an
 * explicit {fleet}, each matched against fleet_membership_events AS OF the
 * invocation): 377 calls by the fleet's registered leader, and 19 by a MEMBER of
 * it — spread across 12 DISTINCT callers, i.e. a broad one-off reflex (each agent
 * does this about once), not one agent looping.
 *
 *   • UNCONDITIONAL AUTO-CLAIM is wrong because `takeFleetLeadership` DEMOTES the
 *     incumbent and notifies them. `fleet:leader-brief` is a READ (capability
 *     `work_items:read`). Twelve different agents each performing a silent,
 *     destructive authority transfer as a side effect of asking for a health
 *     brief is a worse failure than the one being fixed.
 *   • REFUSE is wrong because the brief is genuinely useful to a member, and 19
 *     calls used it legitimately. Refusing removes a working capability to fix a
 *     bookkeeping gap.
 *
 * So the rule is neither: it is gated on the incumbent's LIVENESS, which the
 * roster already carries — no extra query, no new state.
 *
 * ── THE ASYMMETRY THAT SETS THE DEFAULT ──────────────────────────────────────
 *
 * The two errors this can make are NOT equally bad, so the bias is deliberate:
 *
 *   • A false AUTO-CLAIM (the incumbent was actually alive) demotes a working
 *     leader mid-supervision and notifies them they were replaced. Expensive,
 *     disruptive, and hard to notice.
 *   • A false NOT-LEADER (the incumbent was actually gone) costs the caller ONE
 *     extra explicit call, which the reply hands them ready to paste.
 *
 * Therefore **auto-claim requires POSITIVE evidence that there is nothing to take
 * from** — either no registered leader at all, or a leader whose session the
 * liveness oracle affirmatively reports as gone. ABSENCE OF EVIDENCE IS NEVER
 * ENOUGH: a leader missing from the roster, or in any live/ambiguous state
 * (`live`, `parked`, `draining`, `suspect`), yields `not-leader` and a nudge.
 *
 * ⚠ `suspect` is deliberately NOT dead. It means "a claim is not progressing",
 * which a slow turn produces just as readily as a corpse — and the whole point of
 * the asymmetry above is that we do not seize leadership on a maybe.
 *
 * ⚠ THE CALLER MUST PASS THE UNFILTERED ROSTER'S VIEW OF THE LEADER.
 * `selectLeaderBriefMembers` drops members with no claims and a stale heartbeat
 * unless `include_stale` is set, so a live-but-idle leader is routinely ABSENT
 * from the filtered group. Deciding from that view would read "idle leader" as
 * "no leader" and steal leadership from a live one — the exact false auto-claim
 * this file is built to prevent.
 */
import type { SessionState } from '../coordination/presence-wakeability';

/**
 * The session states that count as POSITIVE evidence the incumbent is gone.
 *
 * `ended` = the session terminated. `recorded` = it exists only as history (a
 * process may even still be warm, but it takes no turns — WI-2858's case, where a
 * warm-dead session reads `heartbeatFresh:true`). Everything else — including
 * `suspect` — is treated as alive for the purposes of taking its authority away.
 */
export const LEADER_GONE_STATES: readonly SessionState[] = ['ended', 'recorded'];

export type LeadershipDisposition =
  /** The caller is the registered leader (or leadership is not determinable) — serve the brief unchanged. */
  | { kind: 'is-leader' }
  /** Nothing to take: no registered leader, or the incumbent's session is affirmatively gone. */
  | { kind: 'auto-claim'; reason: 'no-registered-leader' | 'registered-leader-gone'; previousLeader: string | null }
  /** Someone else holds it and may still be working — serve the brief, name them, hand over the claim call. */
  | { kind: 'not-leader'; leader: string; leaderState: SessionState | 'not-in-roster' };

export interface LeadershipDispositionInput {
  /** The calling session's ownerId. Undefined when identity did not resolve. */
  callerOwnerId: string | undefined;
  /** The REGISTRY's leader for this fleet (`AgentFleetRecord.leaderOwnerId`) — the authority, not a presence inference. */
  registeredLeader: string | null;
  /**
   * The registered leader's session state as read from the UNFILTERED roster.
   * `undefined`/`null` means the leader has no roster row at all — which is
   * ambiguous, not dead (see the file header), and never auto-claims.
   */
  leaderSessionState: SessionState | null | undefined;
}

/**
 * Decide what leader-brief should do for this caller. See the file header for the
 * rules and, more importantly, for why auto-claim is gated the way it is.
 */
export function decideLeadershipDisposition(
  input: LeadershipDispositionInput,
): LeadershipDisposition {
  const { callerOwnerId, registeredLeader, leaderSessionState } = input;

  // No resolvable identity ⇒ nothing to compare and nobody to install. Serving the
  // brief unchanged is the only safe move: this path predates the ruling and a
  // read must not start failing because identity resolution is degraded.
  if (!callerOwnerId) return { kind: 'is-leader' };

  if (registeredLeader === callerOwnerId) return { kind: 'is-leader' };

  // Nothing to take from — the unambiguous half of "self-claiming leadership".
  if (!registeredLeader) {
    return { kind: 'auto-claim', reason: 'no-registered-leader', previousLeader: null };
  }

  // POSITIVE evidence only. A missing roster row is absence of evidence and falls
  // through to the nudge below, deliberately.
  if (leaderSessionState && LEADER_GONE_STATES.includes(leaderSessionState)) {
    return {
      kind: 'auto-claim',
      reason: 'registered-leader-gone',
      previousLeader: registeredLeader,
    };
  }

  return {
    kind: 'not-leader',
    leader: registeredLeader,
    leaderState: leaderSessionState ?? 'not-in-roster',
  };
}

/** The block leader-brief attaches when the caller does not hold leadership. */
export interface NotLeaderNotice {
  /** The registered leader the caller is NOT. */
  registeredLeader: string;
  /** Why leadership was not taken automatically. */
  leaderState: SessionState | 'not-in-roster';
  reason: string;
  /** The exact call that claims it, ready to paste. */
  claimWith: string;
}

/** The block leader-brief attaches when it DID install the caller as leader. */
export interface AutoClaimedNotice {
  claimed: true;
  reason: 'no-registered-leader' | 'registered-leader-gone';
  previousLeader: string | null;
  /** Whether the displaced prior leader was notified (always false for a fleet that had none). */
  notified: boolean;
  note: string;
}

/**
 * Render the not-leader nudge. Kept beside the decision so the WORDING is
 * test-pinned too: the whole value of this branch is that the caller learns it is
 * acting without the authority it assumed, and a vague message loses that.
 */
export function buildNotLeaderNotice(
  d: Extract<LeadershipDisposition, { kind: 'not-leader' }>,
  fleet: string,
): NotLeaderNotice {
  const gone = d.leaderState === 'not-in-roster';
  return {
    registeredLeader: d.leader,
    leaderState: d.leaderState,
    reason: gone
      ? `You are NOT the registered leader of '${fleet}' — ${d.leader} is, and has no presence row, so their liveness is UNKNOWN (not proven dead). Leadership was not taken automatically: seizing it on absence of evidence would demote a leader who may simply be idle.`
      : `You are NOT the registered leader of '${fleet}' — ${d.leader} is, and their session reads '${d.leaderState}'. Leadership was not taken automatically because that would demote a live leader as a side effect of a READ.`,
    claimWith: `fleet:take-leadership { fleet: "${fleet}" }`,
  };
}
