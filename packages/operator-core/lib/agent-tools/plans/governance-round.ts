/** Immutable shared-pot governance round records and deterministic rebuild (P-002). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { evaluatePlanAdmission, type PlanAdmissionPolicy, type PlanVote } from './plan-admission-policy';
import { reduceGovernanceVotes, type Delegation, type VotingMember, type VotingTally } from './governance-voting';

export interface GovernanceRound {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly eligibleMemberIds: readonly string[];
  readonly createdAtMs: number;
}

export interface GovernanceVoteEvent {
  readonly eventId: string;
  readonly roundId: string;
  readonly memberId: string;
  readonly choice: PlanVote['choice'];
  readonly sequence: number;
  readonly signature: string;
  /** Signing-key epoch of the ballot; a vote trailing its member's epoch is refused by the reducer. */
  readonly keyEpoch?: number;
}

export interface FinalizationCertificate {
  readonly roundId: string;
  readonly planRevisionHash: string;
  readonly policyVersion: number;
  readonly admitted: boolean;
  readonly reason: string;
  readonly voteEventIds: readonly string[];
  readonly finalizedAtMs: number;
  /**
   * The weighted tally reduceGovernanceVotes produced for this round. It is
   * covered by certificateHash, so a certificate cannot be re-attributed to a
   * tally it did not come from, and federation refuses any certificate that
   * carries none (i.e. one finalized without consulting the reducer).
   */
  readonly tally: VotingTally;
  readonly certificateHash: string;
}

export type GovernanceRoundError = 'invalid-round' | 'duplicate-member' | 'unknown-member' | 'duplicate-event' | 'invalid-sequence' | 'vote-reduction-refused';
export type RoundResult<T> = { ok: true; value: T } | { ok: false; code: GovernanceRoundError; detail: string };

export function createGovernanceRound(input: Omit<GovernanceRound, 'createdAtMs'> & { createdAtMs: number }): RoundResult<GovernanceRound> {
  if (!input.roundId.trim() || !input.planRevisionHash.trim() || !Number.isSafeInteger(input.policyVersion) || input.policyVersion < 1 || !Number.isFinite(input.createdAtMs)) return { ok: false, code: 'invalid-round', detail: 'round id, plan revision, policy epoch, and timestamp are required' };
  if (input.eligibleMemberIds.length === 0 || new Set(input.eligibleMemberIds).size !== input.eligibleMemberIds.length || input.eligibleMemberIds.some((id) => !id.trim())) return { ok: false, code: 'duplicate-member', detail: 'eligible member snapshot must contain unique non-empty ids' };
  return { ok: true, value: Object.freeze({ ...input, eligibleMemberIds: [...input.eligibleMemberIds] }) };
}

export function appendGovernanceVote(round: GovernanceRound, events: readonly GovernanceVoteEvent[], event: GovernanceVoteEvent): RoundResult<GovernanceVoteEvent[]> {
  if (event.roundId !== round.roundId || !round.eligibleMemberIds.includes(event.memberId)) return { ok: false, code: 'unknown-member', detail: 'vote round or member does not match the immutable eligibility snapshot' };
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.signature.trim()) return { ok: false, code: 'invalid-sequence', detail: 'vote sequence and signature are required' };
  if (events.some((e) => e.eventId === event.eventId || e.memberId === event.memberId)) return { ok: false, code: 'duplicate-event', detail: 'event id and member vote must be unique within a round' };
  return { ok: true, value: [...events, event].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId)) };
}

function certificateHash(cert: Omit<FinalizationCertificate, 'certificateHash'>): string {
  return createHash('sha256').update(canonicalJson(cert)).digest('hex');
}

/**
 * Finalize a round. The weighted reducer is CONSULTED FIRST and is load-bearing
 * twice over: its refusals (revoked member, stale key epoch, delegation cycle or
 * expiry, non-advancing sequence, invalid weight) abort finalization, and its
 * weighted tally can veto an admission the unweighted policy count would have
 * granted. `members`/`delegations` describe the voting roster; omitted, every id
 * in the round's own eligibility snapshot votes unrevoked at weight 1.
 */
export function finalizeGovernanceRound(input: { round: GovernanceRound; events: readonly GovernanceVoteEvent[]; policy: PlanAdmissionPolicy; nowMs: number; members?: readonly VotingMember[]; delegations?: readonly Delegation[] }): RoundResult<FinalizationCertificate> {
  const members: readonly VotingMember[] = input.members ?? input.round.eligibleMemberIds.map((memberId) => ({ memberId }));
  const rosterIds = new Set(members.map((m) => m.memberId));
  if (rosterIds.size !== members.length) return { ok: false, code: 'duplicate-member', detail: 'voting roster contains duplicate member ids' };
  const absent = input.round.eligibleMemberIds.find((id) => !rosterIds.has(id));
  if (absent != null) return { ok: false, code: 'unknown-member', detail: `eligible member '${absent}' is absent from the voting roster` };

  const reduced = reduceGovernanceVotes({
    members,
    events: input.events.map((e) => ({ memberId: e.memberId, choice: e.choice, sequence: e.sequence, keyEpoch: e.keyEpoch ?? 0 })),
    delegations: input.delegations,
    nowMs: input.nowMs,
  });
  if (!reduced.ok) return { ok: false, code: 'vote-reduction-refused', detail: `${reduced.code}: ${reduced.detail}` };
  const tally = reduced.value;

  const votes: PlanVote[] = input.events.map((e) => ({ memberId: e.memberId, choice: e.choice }));
  const verdict = evaluatePlanAdmission(input.policy, { planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion, eligibleMemberIds: [...input.round.eligibleMemberIds], votes, ratifiedAtMs: input.round.createdAtMs }, input.nowMs);
  // The policy count is unweighted. Where weights or delegations make the
  // weighted outcome disagree, the reducer wins: admitting a plan the weighted
  // electorate did not approve is the correctness gap the reducer closes.
  const weightedApproval = tally.approveWeight > tally.rejectWeight;
  const admitted = verdict.admitted && weightedApproval;
  const reason = verdict.admitted && !weightedApproval
    ? `weighted-tally-rejected: approve ${tally.approveWeight} did not exceed reject ${tally.rejectWeight}`
    : verdict.reason;

  const base: Omit<FinalizationCertificate, 'certificateHash'> = { roundId: input.round.roundId, planRevisionHash: input.round.planRevisionHash, policyVersion: input.round.policyVersion, admitted, reason, voteEventIds: input.events.map((e) => e.eventId).sort(), finalizedAtMs: input.nowMs, tally };
  return { ok: true, value: { ...base, certificateHash: certificateHash(base) } };
}

/** Recompute a certificate's hash and compare: any field edited after finalization fails this. */
export function verifyFinalizationCertificate(cert: FinalizationCertificate): boolean {
  const { certificateHash: claimed, ...base } = cert;
  return typeof claimed === 'string' && claimed.length > 0 && certificateHash(base) === claimed;
}

export function rebuildGovernanceRound(round: GovernanceRound, events: readonly GovernanceVoteEvent[]): RoundResult<GovernanceVoteEvent[]> {
  let current: GovernanceVoteEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId))) {
    const result = appendGovernanceVote(round, current, event);
    if (!result.ok) return result;
    current = result.value;
  }
  return { ok: true, value: current };
}
