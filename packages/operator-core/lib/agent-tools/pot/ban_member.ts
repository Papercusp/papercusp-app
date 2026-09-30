/**
 * pot:ban_member — OWNER bans a member for repeat abuse (Brief EN-3 / P-MOD, the
 * teeth). Two composed legs:
 *   1. append the github id to the owner-SIGNED moderation.bannedGithubIds (federates
 *      the ban; the membership admission gate then DENIES re-join — ban persistence,
 *      keyed on the stable numeric id so a renamed login can't slip back in).
 *   2. revokePotContributor — drop their devices from federation. This is the
 *      write-plane block now; the C-001 re-key turns it into a READ cut-off at the next
 *      epoch (su-313d1/46b7a's op-path). So `revoke.live` is false until the re-key lands
 *      — the ban + rejoin-deny are effective immediately; the read cut-off follows.
 *
 * Pass unban:true to lift the ban (remove from the signed list; re-join allowed again).
 * AUTHORITY: mutatePotPolicy + revokePotContributor both require the owning Swarm.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { banMember, unbanMember } from '../../hive-moderation';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:ban_member',
  profile: 'engineer',
  description:
    "OWNER bans a member for repeat abuse: records the ban in the owner-signed policy (denies re-join, keyed on the stable github id) AND revokes their devices (write-block now; a READ cut-off at the next C-001 re-key epoch). Pass unban:true to lift. Requires holding the Pot key. revoke:false bans (policy-only) without revoking.",
  guidance: {
    when: 'A member is a confirmed repeat abuser (see pot:moderation_queue) and you (the owner) want them removed AND unable to re-join.',
    notWhen: 'Hiding one piece of content — that is pot:takedown. Revoking your OWN device — substrate:revoke_self_device.',
    chaining: 'pot:moderation_queue → pot:ban_member → pot:moderation_resolve (mark actioned). The read cut-off completes when the C-001 re-key op-path lands.',
    seeAlso: [
      'pot:moderation_queue (the reports that justify a ban)',
      'pot:moderation_resolve (mark the report actioned after banning)',
      'pot:add-member (re-admit a member later)',
    ],
  },
  capability: 'intel:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({
    pot: z.string().min(1).max(120).describe("The Pot's home harness slug."),
    githubUserId: z.number().int().positive().describe('The numeric GitHub user id of the member to ban (the stable id, not the login).'),
    unban: z.boolean().optional().describe('Set true to LIFT a ban (remove from the signed ban list; re-join allowed again).'),
    revoke: z
      .boolean()
      .optional()
      .describe('Default true: also revoke the member\'s devices (the re-key cut-off teeth). Set false to ban (policy-only) without revoking.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(
      args.workspace,
      ctx.workspaceId,
      ctx.principal?.workspaceId,
    );
    if (args.unban) {
      const result = await unbanMember({ workspaceId, potHomeSlug: args.pot, githubUserId: args.githubUserId });
      return text({ action: 'unban', githubUserId: args.githubUserId, ...result });
    }
    const result = await banMember({
      workspaceId,
      potHomeSlug: args.pot,
      githubUserId: args.githubUserId,
      revoke: args.revoke,
    });
    return text({ action: 'ban', githubUserId: args.githubUserId, ...result });
  },
});
