/**
 * work_items:withdraw — RETRACT a filing in ONE call (frontier-remediation P-002).
 *
 * The gap this closes. Retracting a filing you should not have made previously took
 * TWO calls that no single verb composed, and the second one was easy to forget:
 *
 *   1. `work_items:set_state { state:'dropped' }` flips the row terminal. That alone
 *      ALREADY removes it from the claimable pool — `ISSUE_FAMILY_CLAIMABLE_STATES`
 *      (work-items.ts) is an allow-list of exactly `['open']`, so ANY non-open state
 *      is excluded by construction. No claimable-side filter is needed, and none is
 *      added here.
 *   2. …but NOTHING on any terminal path releases the CLAIM. `setWorkItemState` reads
 *      `assignee` only to capture `priorAssignee`, and `complete.ts` reads it only to
 *      refuse a mismatched close. So after a bare state flip the retracted row stays
 *      ASSIGNED to the person who withdrew it — it keeps occupying their lane, their
 *      load, and their `holding:` line forever.
 *
 * So "flips state and marks the claim withdrawn in one call" = compose (1) with
 * `releaseWorkItem`, atomically from the caller's point of view.
 *
 * Why `dropped` and not a new `withdrawn` state: the state vocabulary is deliberately
 * COLLAPSING toward exactly `['done','dropped']` (see the comment on
 * `SETTLED_WORK_ITEM_STATES`), so minting a third terminal would fight that direction.
 * The withdrawal is recorded in the completion ref instead, which is what makes it
 * distinguishable from an ordinary drop when reading the row back.
 *
 * Why `announceClaimable:false` on BOTH writes: a withdrawn item must never be served
 * to anyone. The default (`true`) fires the broad pool-wide `work-item:claimable` wake
 * — which would rouse the fleet toward a row that is terminal and unservable. Passing
 * false suppresses only that broad co-fire; the item-scoped events still fire.
 *
 * Why no `assumptions` declaration (unlike set_state / complete): those are COMPLETION
 * commitments, and an assumption record describes what a completion rests on. A
 * retraction asserts nothing and completes nothing, so requiring a declaration here
 * would manufacture an assumption record for a close no agent is standing behind.
 * `completionRef` alone satisfies the completion gate.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getWorkItem, setWorkItemState, releaseWorkItem, isSettledWorkItemState } from '../../work-items';
import { resolveAdoptedName } from '../../plan-items/agent-names';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

/** The stable prefix that marks a terminal row as a RETRACTION rather than an ordinary drop. */
export const WITHDRAWN_COMPLETION_PREFIX = 'withdrawn:';

export default defineTool({
  name: 'work_items:withdraw',
  profile: 'engineer',
  description:
    'RETRACT a filing in one call: flips the work-item to the terminal `dropped` state AND releases your claim on it, so a withdrawn row stops occupying your lane. Marks the row as a retraction (not an ordinary drop) via a `withdrawn:` completion ref. A withdrawn row is absent from work_items:claimable and scheduler:get_next by construction. Refuses an item held by someone else (pass force:true to override) and an already-terminal item. Pass `id` for one or `ids` for several. Returns { ok, results:[{ ok, id, previousAssignee?, error? }], counts }.',
  guidance: {
    when: 'You filed a work-item you should not have — a duplicate, a mistaken bug, an observation that turned out to be wrong, a filing whose premise you have since retracted — and you want it off the board AND off your lane in one call.',
    notWhen:
      'The work was genuinely DONE (use work_items:complete, which records evidence) — or you merely want to hand it to someone else while it stays open (that is a release/reassign, not a withdrawal).',
    chaining: 'work_items:create → (premise falsified) → work_items:withdraw. Verify with work_items:claimable — the row is absent.',
    seeAlso: [
      'work_items:complete (finish real work, with completion evidence)',
      'work_items:set_state (flip state WITHOUT touching the claim)',
      'work_items:claimable (confirm the withdrawn row is no longer served)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to withdraw (1–100)'),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe('why you are retracting this filing — stored on the row so a later reader sees WHY it was withdrawn, not merely that it was'),
      harness: z.string().max(80).optional(),
      force: z
        .boolean()
        .optional()
        .describe('withdraw even when the item is currently held by ANOTHER agent (default false — a live peer’s claim is refused)'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const ids = mergeIds(args.id, args.ids);
    const reason = args.reason.trim();

    // Holder matching mirrors complete.ts: an agent may hold work under an ADOPTED name
    // rather than its raw ownerId, so comparing ownerId alone would refuse a legitimate
    // self-withdrawal. Resolved ONCE per call (it is per-caller, not per-item) and
    // fail-soft — an unresolvable name must not block a withdrawal.
    const adoptedName = ident.workspaceId
      ? await resolveAdoptedName(ident.workspaceId, ident.ownerId).catch(() => null)
      : null;

    const env = await runBulk(
      ids,
      async (id) => {
        const existing = await getWorkItem(id, args.harness);
        if (!existing) return { ok: false as const, id, error: 'not_found' };

        // An already-terminal row has nothing to withdraw; saying so is more useful than
        // a silent second terminal write that would overwrite the real completion record.
        if (isSettledWorkItemState(existing.state)) {
          return { ok: false as const, id, error: `already terminal (${existing.state}) — nothing to withdraw` };
        }

        // A live peer's claim is theirs. Mirrors the assignee-mismatch refusal in
        // complete.ts: withdrawing work someone else is actively holding destroys their lane.
        const holder = existing.assignee ?? null;
        const callerHolds = !holder || holder === ident.ownerId || (!!adoptedName && holder === adoptedName);
        if (!callerHolds && !args.force) {
          return {
            ok: false as const,
            id,
            error: `held by '${holder}', not you ('${ident.ownerId}') — coordinate with the holder, or pass force:true`,
          };
        }

        // Flip FIRST, release SECOND: the state write happens while the row is still
        // attributed, so the terminal record carries who retracted it.
        await setWorkItemState(id, 'dropped', {
          harness: args.harness,
          by: ident.ownerId,
          completionRef: `${WITHDRAWN_COMPLETION_PREFIX} ${reason}`,
          announceClaimable: false,
        });

        // WI-6678: read the pre-release holder from releaseWorkItem's OWN row-read via
        // onPriorState rather than a second, racy pre-read of our own.
        let previousAssignee: string | null = null;
        await releaseWorkItem(id, {
          harness: args.harness,
          releasingOwnerId: ident.ownerId,
          announceClaimable: false,
          onPriorState: (prior) => {
            previousAssignee = prior.assignee;
          },
        });

        return { ok: true as const, id, state: 'dropped', withdrawn: true, previousAssignee };
      },
      { keyOf: (id) => ({ id }) },
    );

    return bulkContent(env);
  },
});
