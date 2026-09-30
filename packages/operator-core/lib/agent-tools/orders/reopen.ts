/**
 * orders:reopen — undo a disposition (directive-ownership-clarity-2026-09-23
 * P-007 / D-005). Before this verb the only undo was a raw
 * `sudo -u postgres psql … UPDATE harness_shared.owner_directives SET
 * disposition_status = NULL …`, which is what an agent ran on 2026-09-23 after
 * closing five other sessions' directives by mistake. That bypassed every rail
 * and left no record of the wrong close or the undo.
 *
 * Who may reopen: anyone orders:disposition would let close it (the addressee, a
 * holder of linking work, an inheriting leader), PLUS the session that closed it
 * — so the agent that made a wrong close can always undo its own mistake. The
 * rail fails CLOSED (D-003): an unreadable verdict refuses, retryably.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { getOwnerDirective, reopenOwnerDirective } from '../../owner-directives';
import { directiveActionVerdict } from '../../owner-directive-agenda';
import { activeWorkspaceId } from '../../workspace-registry';

function reply(body: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    ...(isError ? { isError: true } : {}),
  };
}

export default defineTool({
  name: 'orders:reopen',
  profile: 'engineer',
  description:
    'Reopen an owner directive that was closed (done/declined) by mistake, with a MANDATORY reason. Records who reopened it, why, and which close it undid.',
  guidance: {
    when: 'A directive was closed wrongly — e.g. you closed another session\'s directive. Never undo a close with SQL.',
    notWhen: 'The owner re-issued the order: that is a new directive, not a reopen.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.number().int().positive().describe('The directive id.'),
    reason: z.string().trim().min(4).max(2000).describe('Why the close was wrong.'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = activeWorkspaceId();
    let row;
    let verdict;
    try {
      row = await getOwnerDirective(args.id);
      if (!row || row.workspaceId !== workspaceId) return reply({ ok: false, id: args.id, error: 'not_found' }, true);
      if (row.dispositionStatus == null) return reply({ ok: false, id: args.id, error: 'not_dispositioned', hint: 'It is already open.' }, true);
      verdict = row.dispositionedBy === identity.ownerId
        ? { allowed: true as const, because: 'closed-it' as const }
        : await directiveActionVerdict({ directiveId: args.id, ownerId: identity.ownerId, workspaceId });
    } catch (err) {
      return reply(
        { ok: false, id: args.id, error: 'verdict_unavailable', retryable: true, hint: `Could not confirm who may reopen #${args.id} (${String(err).slice(0, 160)}); nothing changed. Retry shortly.` },
        true,
      );
    }
    if ('notFound' in verdict) return reply({ ok: false, id: args.id, error: 'not_found' }, true);
    if (!verdict.allowed) {
      return reply(
        {
          ok: false,
          id: args.id,
          error: 'foreign_directive',
          addressedTo: verdict.addressedTo,
          closedBy: row.dispositionedBy,
          hint: `Directive #${args.id} is addressed to ${verdict.addressedTo} and was closed by ${row.dispositionedBy ?? 'unknown'}; ask one of them to reopen it.`,
        },
        true,
      );
    }
    const result = await reopenOwnerDirective({ id: args.id, workspaceId, reason: args.reason, reopenedBy: identity.ownerId });
    return result.ok
      ? reply({ ok: true, id: args.id, reopenedFrom: result.row.reopenedFrom, because: verdict.because })
      : reply({ ok: false, id: args.id, error: result.error }, true);
  },
});
