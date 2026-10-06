/**
 * steward-hand-dispatch.ts — the GOAL HOLDER may FILE work; it may not HAND IT OUT.
 *
 * WI-10005281 (recurrence of WI-10004867). A goal's holder is a portfolio manager:
 * the goal brief's rule is that it routes work by creating it UNASSIGNED (goal-
 * stamped) and then steering through the claim rails — priority, scope, claim specs,
 * wake cadence — never `work_items:create { assign_to: <someone else> }` plus a
 * direct "assigned to you" message. The first occurrence (WI-10004867) was closed by
 * telling the holder; the next holder (su-9ec5d030) never read that, and did it
 * twice (WI-10005246 / WI-10005247, assigned to the drain leader). Guidance that
 * only reaches the holder who was told cannot prevent the next one, so the rail is
 * enforced where the hand-out happens.
 *
 * ── WHY A DOWNGRADE, NOT A REFUSAL ──────────────────────────────────────────
 * Same stance as the fleet-scope / work-scope / assignee-resolution downgrades in
 * `work_items:create`: filing is never what is wrong, only the claim it would mint.
 * The item is still filed (so the finding is durable and the drain fleet's claim
 * spec can pull it); the hand-out is dropped, and the caller is told plainly what
 * to do instead. No `admissionBypass` is granted — a named assignment must not be a
 * way to step around the duplicate-screening floor (WI-10004867 case 1).
 *
 * ── WHO IS A "STEWARD" HERE ─────────────────────────────────────────────────
 * ONLY the session that RUNS the goal: elected holder, or a still-live named
 * handoff (`readGoalHolderAuthority` status `elected` | `handoff`). A fleet member or
 * leader launched under the goal merely INHERITS goal context
 * (`session_briefs.goal_id`) and routinely assigns work to its own members — that is
 * its job, so inherited context alone never trips this. Assigning to SELF is also not
 * a hand-out here (it is a different rule: a holder never implements).
 *
 * Fail-OPEN on an unreadable authority store: `resolveGoalContext` has already run
 * the fail-CLOSED mutation fence for this caller, so this predicate only decides
 * whether to ADD a downgrade, and a read failure must never turn into a refused
 * filing.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { readGoalHolderAuthority } from './holder-authority';

export type StewardHandDispatchVerdict =
  | { handDispatch: false }
  | { handDispatch: true; goalId: string; requestedAssignee: string; notice: string };

/** The caller-facing notice, shared with the persisted payload marker's tests. */
export function stewardHandDispatchNotice(goalId: string, requestedAssignee: string): string {
  return (
    `FILED UNASSIGNED — you run goal ${goalId}, and a goal holder steers work through the claim ` +
    `rails instead of hand-dispatching it. The item exists on the ledger (goal-stamped, claimable ` +
    `by the goal's drain fleet), but the assignment to ${requestedAssignee} was dropped. To move it: ` +
    `change the drain fleet's claim spec / the item's priority (scheduler:set_claim_spec, ` +
    `work_items:update), or launch an executor through the rails (fleet:launch-on-plan / ` +
    `capability:launch-agent). Do not follow this with a coord:send "assigned to you", and do not ` +
    `use a named work_items:claim to step around an admission-pending floor (WI-10004867).`
  );
}

/**
 * Decide whether `assignTo` is a goal holder's hand-out. `goalContextId` is the
 * caller's already-RESOLVED goal context (null when the caller serves no goal — the
 * common case, which costs no read).
 */
export async function evaluateStewardHandDispatch(args: {
  workspaceId: string | null | undefined;
  ownerId: string | null | undefined;
  assignTo: string | null | undefined;
  goalContextId: string | null;
  sql?: Sql;
}): Promise<StewardHandDispatchVerdict> {
  const { workspaceId, ownerId, assignTo, goalContextId } = args;
  if (!assignTo || !goalContextId || !ownerId || !workspaceId || workspaceId === '*') {
    return { handDispatch: false };
  }
  if (assignTo === ownerId) return { handDispatch: false };
  try {
    const authority = await readGoalHolderAuthority(args.sql ?? getOrgPg().sql, workspaceId, ownerId);
    if (authority.status !== 'elected' && authority.status !== 'handoff') {
      return { handDispatch: false };
    }
    const goalId = authority.goalId ?? goalContextId;
    return {
      handDispatch: true,
      goalId,
      requestedAssignee: assignTo,
      notice: stewardHandDispatchNotice(goalId, assignTo),
    };
  } catch {
    return { handDispatch: false };
  }
}
