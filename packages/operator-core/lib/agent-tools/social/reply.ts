import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { parseSocialPostRef, replyToCanonicalSocialPost } from '../../capability-verbs/social';
import { DisclosureRefused, disclosureRefusalData } from '../../personal-vault/disclosure-ledger';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'social:reply',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Reply to one social post the owner already has, named by its canonical postId ("<platform>:<id>"). You supply TEXT ONLY: the server resolves the account, thread, credential and audience from the stored post, so this tool cannot redirect a reply, choose which identity speaks, or widen who sees it.',
  guidance: {
    when: 'The owner asks you to answer a specific post. Locate it with social:search and pass the postId it returns, verbatim.',
    notWhen:
      'Posting something NEW, or to a community rather than a thread — that is social:post, which checks the destination. Not for email (mail:reply) or Slack (chat:reply).',
    chaining:
      'social:search → postId → social:reply. Never assemble a postId from a platform and an id yourself. Report the echoed label and visibility back to the owner as evidence of where it actually went and who can see it. Two refusals are terminal rather than retryable: `write-unverified` (the platform reads fine but its write path is unproven — social:read shows this as `replyable.allowed:false`) and `owner-blocked`. Report either one; retrying or switching platform will not clear it.',
  },
  args: z
    .object({
      postId: z.string().trim().min(1).max(512),
      text: z.string().trim().min(1).max(10_000),
      /**
       * Optional and NARROWING ONLY. Omit it to inherit the parent's audience,
       * which is the correct default; a wider value than the parent's is
       * refused by the seam rather than silently applied.
       */
      visibility: z.enum(['direct', 'followers', 'unlisted', 'public']).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('social_reply_workspace_required');
    // Parse first so an unknown or unverified platform is refused with the
    // registry's own reason before any credential work happens.
    const ref = parseSocialPostRef(args.postId);
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, [
      `personal:${ref.platform}`,
    ]);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await replyToCanonicalSocialPost(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        ref,
        text: args.text,
        visibility: args.visibility ?? null,
        agentOwnerId: disclosureSubject(ctx),
      });
      return { data: { ok: true, ...result } };
    } catch (error) {
      if (error instanceof DisclosureRefused) return { data: disclosureRefusalData(error) };
      throw error;
    }
  },
});
