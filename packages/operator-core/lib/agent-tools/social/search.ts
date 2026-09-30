import { z } from 'zod';
import type postgres from 'postgres';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { buildPersonalQueryEmbedder, PERSONAL_EMBEDDER_MODE } from '../../personal-vault/embedding';
import { searchSocialPosts, SocialSearchNotGranted } from '../../capability-verbs/social-read';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

export default defineTool({
  name: 'social:search',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'papercup', 'papercup-deep'],
  description:
    "Search the owner's social posts across every connected platform at once. Each hit carries a ready-to-use canonical postId — pass it to social:read or social:reply UNCHANGED; never build one yourself from the platform and id.",
  guidance: {
    when: 'Grounding a reply in prior context, or locating the post the owner is referring to.',
    notWhen:
      'Mail, calendar or contacts context — that is personal:search. General workspace memory is memory:search. And NOT for a post you were already handed: pass that postId straight to social:read/social:reply, because re-searching can surface a near-duplicate and answer the wrong post.',
    chaining:
      'social:search → take a hit\'s postId verbatim → social:read / social:reply. Read `skipped` before reporting nothing was found, and `scopesSearched` for which platforms were actually covered.',
  },
  args: z
    .object({
      query: z.string().trim().min(1).max(500),
      /** Narrows within the grant; it can never reach a platform the owner did not grant. */
      platforms: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
      participants: z.array(z.string().trim().min(1).max(320)).max(50).optional(),
      timeRange: z
        .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
        .optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('social_search_workspace_required');
    const user = await getSessionUserOrDefault();
    // Deliberately request NO scopes, then narrow below. Requesting the ten
    // platform scopes up front would trip `scope_not_granted` and refuse the
    // whole call for any owner who granted a subset — which is the normal case.
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, []);
    if (!auth.allowed) return { data: { allowed: false, refusal: auth.reason } };
    let queryEmbedding: number[] | null = null;
    let vectorLeg: 'gemma' | 'unavailable' = 'unavailable';
    try {
      queryEmbedding = await (await buildPersonalQueryEmbedder())(args.query);
      vectorLeg = PERSONAL_EMBEDDER_MODE;
    } catch {
      // Lexical search remains useful and the grant fence is unchanged.
    }
    try {
      const outcome = await searchSocialPosts(ctx.tx as unknown as postgres.Sql, {
        workspaceId,
        userId: user.id,
        query: args.query,
        // The granted set, narrowed to social sources by the seam. Passing it
        // through unfiltered would search the owner's mail as well.
        grantedScopes: auth.scopes,
        platforms: args.platforms,
        participants: args.participants,
        timeRange: args.timeRange,
        limit: args.limit,
        queryEmbedding,
      });
      return { data: { allowed: true, principal: auth.principal, vectorLeg, ...outcome } };
    } catch (err) {
      if (err instanceof SocialSearchNotGranted) {
        return {
          data: { allowed: false, refusal: 'no_social_scope', grantedScopes: err.grantedScopes },
        };
      }
      throw err;
    }
  },
});
