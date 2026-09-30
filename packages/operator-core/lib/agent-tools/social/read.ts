import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { parseSocialPostRef } from '../../capability-verbs/social';
import { readSocialPost } from '../../capability-verbs/social-read';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'social:read',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Read one social post the owner already has, by its canonical postId ("<platform>:<id>"). Returns the text, author, audience and whether replying is currently possible. Scoped to the owner\'s own vault, so an id that is not theirs simply is not found.',
  guidance: {
    when: 'You need the full text of a post before answering it, or to confirm what a postId actually refers to.',
    notWhen: 'Finding a post you cannot already name — that is social:search, which also mints the postId this takes.',
    chaining:
      'social:search → postId → social:read → social:reply. A postId is an OPAQUE token: pass whatever minted it verbatim, never assemble one from a platform and an id. Check `replyable.allowed` before drafting — a platform can be readable and still refuse every write. This is also the ONLY source of the `confirmToken` social:delete requires.',
  },
  args: z.object({ postId: z.string().trim().min(1).max(512) }).strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('social_read_workspace_required');
    // Parse first so an unknown or unverified platform refuses with the
    // registry's reason before any grant or vault work happens.
    const ref = parseSocialPostRef(args.postId);
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, [
      `personal:${ref.platform}`,
    ]);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    const post = await readSocialPost(ctx.tx as unknown as postgres.Sql, {
      workspaceId,
      userId: user.id,
      postId: args.postId,
    });
    return { data: { allowed: true, post } };
  },
});
