/**
 * Terminal-owner remote-origin self-heal (EI-22189521072988065).
 *
 * A LEAF module for the same reason as `work-items-orphan-author.ts` and
 * `work-items-harness-scope.ts`: its callers are the write verbs
 * (`work_items:complete`, `work_items:set_state`), and those `vi.mock('./work-items')`
 * wholesale in their unit tests — a guard living in that module would silently
 * become `undefined` at exactly the call site that most needs it. `work-items.ts`
 * re-exports the write half so it stays discoverable next to
 * `selfHealAuthorOriginIfStranded`.
 *
 * THE DEFECT THIS CLOSES
 * -----------------------
 * `origin` can flip local→remote well after a row is already TERMINAL (the same
 * unresolved federation/replay-provenance defect EI-19313515375179600 documents
 * for the at-creation-time case). The existing self-heal
 * (`selfHealAuthorOriginIfStranded`) exempts only the recorded `created_by` — but
 * the agent who actually claimed, worked, and CLOSED the item (stamped as
 * `terminal_owner` by the completion-integrity gate) is routinely a DIFFERENT
 * peer than whoever originally filed it. `work_items:complete`'s own advisory,
 * on a close that lands `completionAuthority:'proposed'` from a content-identity
 * mismatch, instructs exactly that closer to wait for the git-sync sweep and
 * re-send an IDENTICAL completion to upgrade it to `committed`. If `origin`
 * flips to 'remote' in the interim, that re-send is refused — the origin flip
 * revokes the only repair path the close itself told the caller to take, and
 * wedges the row at `proposed` (out of burn-down) forever.
 *
 * SCOPED NARROWLY, mirroring the sibling guards — never a general
 * remote-mutation bypass:
 *  - the row is actually remote-origin;
 *  - the row was ALREADY in a settled/terminal state BEFORE this call (so no
 *    FRESH completion is being manufactured — only evidence attached to one
 *    that already exists; a caller must pass `wasAlreadySettled` computed from
 *    the row's OWN state at read time, not from the requested state);
 *  - the row's own recorded `terminal_owner` — stamped at the ORIGINAL close by
 *    the same completion-integrity gate that requires a real `by` — is the
 *    caller.
 * A caller who is neither the creator nor the recorded terminal owner of an
 * already-closed row is refused unchanged; a row that was NOT already settled
 * before this call is refused unchanged (that is exactly the fresh-completion
 * case `healOrphanedRemoteOriginIfAuthorEnded` already governs).
 */
import { getOrgPg } from '@papercusp/db-org';

export type TerminalOwnerOriginHealReason =
  | 'not-remote'
  | 'not-already-settled'
  | 'no-recorded-terminal-owner'
  | 'caller-not-terminal-owner'
  | 'terminal-owner-match';

/**
 * The POLICY, as a pure function so it is unit-testable without a database —
 * mirrors `decideOrphanAuthorClose`'s shape in `work-items-orphan-author.ts`.
 *
 * `wasAlreadySettled` is deliberately the CALLER's responsibility to compute
 * from the row's state as read BEFORE this write (`isSettledWorkItemState(wi.state)`
 * in `work-items.ts`, or `existing.state` in `work_items:complete`'s fast-fail
 * guard) — this module takes no dependency on `work-items.ts` to stay a true
 * leaf and avoid a circular import back into the module it heals.
 */
export function decideTerminalOwnerOriginHeal(input: {
  origin: string | null | undefined;
  wasAlreadySettled: boolean;
  terminalOwner: string | null | undefined;
  callerOwnerId: string | null | undefined;
}): { permit: boolean; reason: TerminalOwnerOriginHealReason } {
  if (input.origin !== 'remote') return { permit: false, reason: 'not-remote' };
  if (!input.wasAlreadySettled) return { permit: false, reason: 'not-already-settled' };
  if (!input.terminalOwner) return { permit: false, reason: 'no-recorded-terminal-owner' };
  if (!input.callerOwnerId || input.callerOwnerId !== input.terminalOwner) {
    return { permit: false, reason: 'caller-not-terminal-owner' };
  }
  return { permit: true, reason: 'terminal-owner-match' };
}

/**
 * The WRITE half. Same shape as `selfHealAuthorOriginIfStranded`: resets
 * `origin` back to 'local' directly on the BASE table (bypassing the
 * `engineer_issues` view's INSTEAD OF trigger, which unconditionally no-ops any
 * write while the base table still reads `origin='remote'` — this function IS
 * the identity check that trigger cannot perform), scoped tight in its own WHERE
 * clause so it can only ever heal a row whose OWN recorded `terminal_owner`
 * matches the caller — never a row genuinely owned by a different peer.
 *
 * Runs `decideTerminalOwnerOriginHeal` first and no-ops (returns false without
 * touching the database) when the policy refuses — callers may inspect
 * `decideTerminalOwnerOriginHeal`'s own reason separately if they need to
 * explain a refusal; this function reports only healed/not-healed.
 */
export async function selfHealTerminalOwnerOriginIfStranded(
  id: string,
  callerOwnerId: string | null | undefined,
  row: { origin: string | null | undefined; wasAlreadySettled: boolean; terminalOwner: string | null | undefined },
): Promise<boolean> {
  if (!id) return false;
  const decision = decideTerminalOwnerOriginHeal({
    origin: row.origin,
    wasAlreadySettled: row.wasAlreadySettled,
    terminalOwner: row.terminalOwner,
    callerOwnerId,
  });
  // Narrows `callerOwnerId` from `string | null | undefined` to `string` for the
  // interpolation below — behaviorally a no-op, since decideTerminalOwnerOriginHeal
  // already refuses (permit:false) whenever callerOwnerId is falsy.
  if (!decision.permit || !callerOwnerId) return false;
  const { sql } = getOrgPg();
  const rows = await sql<{ feature_id: string }[]>`
    UPDATE harness_shared.work_items
       SET origin = 'local'
     WHERE feature_id = ${id}
       AND origin = 'remote'
       AND terminal_owner = ${callerOwnerId}
    RETURNING feature_id`;
  return rows.length > 0;
}
