import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { parseSocialPostRef } from '../../capability-verbs/social';
import { deleteCanonicalSocialPost, SocialDeleteNotConfirmed } from '../../capability-verbs/social-delete';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'social:delete',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'operator:write',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    'Permanently delete one of the owner\'s own social posts. Irreversible — there is no undo on these platforms. Requires the confirmToken that social:read returns for that exact post, so a post can only be deleted after it has been read.',
  guidance: {
    when: 'The owner asks you to take a post down, or to retract something that was posted in error.',
    notWhen:
      'Editing or replacing content — delete does not do that. Never delete to "clean up" or on your own initiative; only on an explicit owner instruction.',
    chaining:
      'social:read → confirmToken → social:delete: read returns `confirmToken` under that exact name, so pass it straight through. It is derived from the post\'s own text, so it cannot be guessed or reused across posts. Report `deleted` honestly: false means the platform found nothing to remove, which is NOT the same as having deleted it.',
    byRole: {
      'papercup-deep': {
        notWhen:
          'You are never user-facing, so you cannot obtain the explicit owner instruction this verb requires. Surface the request through the fast half instead of deleting.',
      },
    },
  },
  args: z
    .object({
      postId: z.string().trim().min(1).max(512),
      /** From social:read on this same post. Not a boolean: it proves the post was read. */
      confirmToken: z.string().trim().min(1).max(128),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('social_delete_workspace_required');
    // Parse first so an unknown or unverified platform refuses with the
    // registry's reason before any grant or vault work happens.
    const ref = parseSocialPostRef(args.postId);
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, [
      `personal:${ref.platform}`,
    ]);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    try {
      const result = await deleteCanonicalSocialPost(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        postId: ref,
        confirmToken: args.confirmToken,
      });
      return { data: { allowed: true, ...result } };
    } catch (err) {
      if (err instanceof SocialDeleteNotConfirmed) {
        // Returned rather than thrown so the agent gets the actionable reason
        // (re-read the post) instead of a stack trace it will retry blindly.
        return { data: { allowed: true, deleted: false, refusal: err.reason, detail: err.message } };
      }
      throw err;
    }
  },
});
