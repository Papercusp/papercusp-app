/** Deterministic voting, delegation, replacement, revocation and key epochs (P-003). */
export interface VotingMember { readonly memberId: string; readonly weight?: number; readonly revoked?: boolean; readonly keyEpoch?: number }
export interface Delegation { readonly from: string; readonly to: string; readonly expiresAtMs?: number; readonly epoch: number }
export interface VotingEvent { readonly memberId: string; readonly choice: 'approve' | 'reject' | 'abstain'; readonly sequence: number; readonly keyEpoch: number }
export type VotingRefusalCode = 'unknown-member' | 'revoked-member' | 'duplicate-vote' | 'delegation-cycle' | 'delegation-expired' | 'stale-key-epoch' | 'invalid-weight';
export type VotingResult<T> = { ok: true; value: T } | { ok: false; code: VotingRefusalCode; detail: string };

function resolveDelegate(memberId: string, delegations: readonly Delegation[], nowMs: number): VotingResult<string> {
  let current = memberId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return { ok: false, code: 'delegation-cycle', detail: `delegation cycle includes '${current}'` };
    seen.add(current);
    const d = delegations.find((candidate) => candidate.from === current);
    if (!d) return { ok: true, value: current };
    if (d.expiresAtMs != null && nowMs > d.expiresAtMs) return { ok: false, code: 'delegation-expired', detail: `delegation from '${d.from}' expired` };
    current = d.to;
  }
}

export interface VotingTally { readonly approveWeight: number; readonly rejectWeight: number; readonly abstainWeight: number; readonly totalEligibleWeight: number; readonly participatingWeight: number; readonly replacements: number; }

/** Reduce one snapshot. A newer sequence replaces an older vote from the same member. */
export function reduceGovernanceVotes(input: { members: readonly VotingMember[]; events: readonly VotingEvent[]; delegations?: readonly Delegation[]; nowMs: number }): VotingResult<VotingTally> {
  const members = new Map(input.members.map((m) => [m.memberId, m]));
  let totalEligibleWeight = 0;
  for (const member of input.members) {
    const weight = member.weight ?? 1;
    if (!Number.isFinite(weight) || weight <= 0) return { ok: false, code: 'invalid-weight', detail: `member '${member.memberId}' has invalid weight` };
    if (!member.revoked) totalEligibleWeight += weight;
  }
  const latest = new Map<string, VotingEvent>();
  let replacements = 0;
  for (const event of [...input.events].sort((a, b) => a.sequence - b.sequence)) {
    const member = members.get(event.memberId);
    if (!member) return { ok: false, code: 'unknown-member', detail: `vote from unknown member '${event.memberId}'` };
    if (member.revoked) return { ok: false, code: 'revoked-member', detail: `revoked member '${event.memberId}' cannot vote` };
    if (member.keyEpoch != null && event.keyEpoch < member.keyEpoch) return { ok: false, code: 'stale-key-epoch', detail: `vote key epoch ${event.keyEpoch} trails member epoch ${member.keyEpoch}` };
    const prior = latest.get(event.memberId);
    if (prior && event.sequence <= prior.sequence) return { ok: false, code: 'duplicate-vote', detail: `vote sequence for '${event.memberId}' did not advance` };
    if (prior) replacements += 1;
    latest.set(event.memberId, event);
  }
  const delegated = new Map<string, number>();
  for (const member of input.members) {
    if (member.revoked) continue;
    const target = resolveDelegate(member.memberId, input.delegations ?? [], input.nowMs);
    if (!target.ok) return target;
    delegated.set(target.value, (delegated.get(target.value) ?? 0) + (member.weight ?? 1));
  }
  let approveWeight = 0; let rejectWeight = 0; let abstainWeight = 0;
  for (const [memberId, event] of latest) {
    const resolved = resolveDelegate(memberId, input.delegations ?? [], input.nowMs);
    if (!resolved.ok) return resolved;
    // A delegating member's own ballot is inactive; its weight follows the
    // delegate's ballot. Only the terminal delegate's event receives the
    // aggregate delegated weight.
    if (resolved.value !== memberId) continue;
    const weight = delegated.get(memberId) ?? (members.get(memberId)?.weight ?? 1);
    if (event.choice === 'approve') approveWeight += weight;
    else if (event.choice === 'reject') rejectWeight += weight;
    else abstainWeight += weight;
  }
  return { ok: true, value: { approveWeight, rejectWeight, abstainWeight, totalEligibleWeight, participatingWeight: approveWeight + rejectWeight + abstainWeight, replacements } };
}
