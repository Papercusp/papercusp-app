/**
 * autonomy:tripwire_revert — the owner's one-click undo of a Queen auto-decision
 * (queen-autonomy-policy-2026-06-13 B-16 / P-081; backs the settings feed's
 * one-click undo, P-031). Owner-authority.
 *
 * Trips an armed tripwire as `owner-thumbs-down`, runs the auto-revert (best
 * effort — the executor is the Queen execution seam), and demotes the category
 * one step (D-005). Audited via the policy-store demotion. The owner doing this
 * IS the strongest counter-signal, so it always demotes (honoring lock/pin).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'autonomy:tripwire_revert',
  profile: 'engineer',
  crossWorkspace: true,
  description:
    'Owner one-click undo of an auto-decision: trip its tripwire (owner-thumbs-down), revert the action, and demote the category one step. Owner-authority; the strongest counter-signal.',
  capability: 'audit:write',
  guidance: {
    when: 'The owner rejects a recent auto-decision in the settings feed — undo the action + tell the graduation engine this category was too aggressive (demote one step).',
    notWhen:
      'To just LIST auto-decisions use autonomy:tripwire_list. To change a ceiling directly use autonomy:policy_set.',
    seeAlso: [
      'autonomy:tripwire_list (list the auto-decisions to revert)',
      'autonomy:policy_set (change a ceiling directly instead)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    tripwireId: z.string().min(1).describe('The tripwire id from autonomy:tripwire_list.'),
    reason: z.string().optional().describe('Optional note recorded with the demotion.'),
  }),
  async handler(args, ctx) {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { getTripwire, markTripwireTripped, markTripwireReverted } = await import('../../autonomy/tripwire/store');
    const { getAutonomyCategoryPolicy, setAutonomyPolicy } = await import('../../autonomy/policy-store');
    const { demoteGraduatedLevel } = await import('../../autonomy/tripwire/core');

    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'owner';
    const { sql } = getOrgPg();
    const nowMs = Date.now();

    const row = await getTripwire(sql, ws, args.tripwireId);
    if (!row) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, reason: 'not_found', tripwireId: args.tripwireId }, null, 2),
          },
        ],
        isError: true,
      };
    }
    if (row.status !== 'armed') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: false, reason: 'already_resolved', status: row.status, tripwireId: args.tripwireId },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }

    // Trip it (owner thumbs-down).
    await markTripwireTripped(sql, ws, row.id, 'owner-thumbs-down', nowMs, actor);

    // Demote the category one step (honors lock/pin).
    const policy = await getAutonomyCategoryPolicy(sql, ws, row.category);
    const from = policy.graduatedLevel;
    const to = demoteGraduatedLevel(from);
    const pinned = policy.ownerOverride != null && (policy.ownerOverride as { pinned?: unknown }).pinned === true;
    let demoted = false;
    if (!policy.locked && !pinned && to !== from) {
      await setAutonomyPolicy(
        sql,
        ws,
        { category: row.category, graduatedLevel: to, reason: args.reason ?? `owner undo of ${row.id}` },
        actor,
      );
      demoted = true;
    }

    // Execute through the same registry the automatic trust scan uses. The
    // executor is non-throwing by contract: an unsupported/stale handle records
    // the trip+demotion and returns an honest failed outcome without wedging the
    // owner's counter-signal.
    const { executeRevertVia, makeRevertRegistry, defaultRevertHelpers } =
      await import('../../autonomy/tripwire/revert-executor');
    const revertOutcome = await executeRevertVia(row, makeRevertRegistry(), defaultRevertHelpers());
    const reverted = revertOutcome.reverted;
    if (reverted) await markTripwireReverted(sql, ws, row.id, nowMs);

    const { notifySyncInvalidate } = await import('../../sync-sse');
    // Name-only (no args): the settings table subscribes to autonomy.policy with no
    // args, so an args-scoped invalidate never matches its react-query key and the
    // surface wouldn't refetch. See the autonomy-policy-set route for the full note.
    await notifySyncInvalidate('autonomy.policy').catch(() => {});

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              workspaceId: ws,
              tripwireId: row.id,
              category: row.category,
              tripped: true,
              demoted,
              demotion: demoted
                ? { from, to }
                : { skipped: policy.locked ? 'locked' : pinned ? 'pinned' : 'no-change' },
              reverted,
              revertHandle: row.revertHandle,
              note: revertOutcome.note,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
