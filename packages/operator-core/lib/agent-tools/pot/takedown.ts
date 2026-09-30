/**
 * pot:takedown — OWNER hides (or restores) reported content in a Pot
 * (Brief EN-3 / P-MOD). The content ref is appended to the owner-SIGNED policy's
 * moderation.takedownList (re-signed + federated); honest peers then HIDE it. Because
 * the takedown rides the signed, monotonically-versioned policy, a removed/old policy
 * can never resurrect it (a malicious peer can't forge the owner signature, and an
 * older policy loses on policy_version/fed_hlc) — the brief's "no resurrection".
 *
 * AUTHORITY: enforced by mutatePotPolicy (signs with the Pot key) — a non-owning
 * Swarm gets not_owner_swarm.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { takedownContent, restoreContent } from '../../hive-moderation';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'pot:takedown',
  profile: 'engineer',
  description:
    "OWNER takedown: hide a piece of content across the Pot by adding its ref to the owner-signed moderation.takedownList (re-signed + federated; honest peers honor it as a tombstone, no resurrection). Pass restore:true to un-hide. Requires holding the Pot key.",
  guidance: {
    when: 'A member reported content (pot:moderation_queue) that you (the owner) want hidden on every honest peer.',
    notWhen: 'Banning the AUTHOR for repeat abuse — that is pot:ban_member (revoke + re-key teeth). Takedown hides content; ban removes a member.',
    chaining: 'pot:moderation_queue → pot:takedown (hide) → pot:moderation_resolve (mark actioned).',
    seeAlso: [
      'pot:moderation_queue (the report that triggered the takedown)',
      'pot:moderation_resolve (mark actioned after hiding)',
      'pot:ban_member (ban the author too)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({
    pot: z.string().min(1).max(120).describe("The Pot's home harness slug."),
    contentRef: z.string().min(1).max(200).describe('The content ref to take down (a feature / work-item id).'),
    restore: z.boolean().optional().describe('Set true to RESTORE (un-hide) a previously taken-down ref.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const result = args.restore
      ? await restoreContent({ workspaceId, potHomeSlug: args.pot, contentRef: args.contentRef })
      : await takedownContent({ workspaceId, potHomeSlug: args.pot, contentRef: args.contentRef });
    return text({ action: args.restore ? 'restore' : 'takedown', contentRef: args.contentRef, ...result });
  },
});
