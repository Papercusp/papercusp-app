import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getSessionUserOrDefault } from '../../auth';
import { authorizePersonalAccess } from '../../personal-vault/authorization';
import { discloseDocuments } from '../../personal-vault/disclosure-ledger';
import { buildPersonalQueryEmbedder, PERSONAL_EMBEDDER_MODE } from '../../personal-vault/embedding';
import { searchPersonalDocuments } from '../../personal-vault/store';
import { disclosureSubject } from '../_disclosure-subject';
import type { PapercuspUnifiedToolContext } from '../_tool-context';

const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle'] as const;

export default defineTool({
  name: 'personal:search',
  needsWorkspaceTx: true,
  capability: 'search:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  description:
    'Search the owner-local Personal Vault with hybrid lexical + local EmbeddingGemma retrieval. DEFAULT DENY: the server resolves this call\'s plan-template/binding/role identity and refuses without a live owner grant. Coding roles are refused even if a grant row exists.',
  guidance: {
    when: 'A granted plan or binding needs the owner\'s imported Gmail, Calendar, Contacts, Facebook/Instagram, or X context. Pass scopes and participant/time filters as narrowly as possible.',
    notWhen: 'General workspace memory/search — use memory:search or search:semantic. Never use from coding/review work; those roles are hard-denied.',
    chaining: 'The result contains bounded snippets only. Use the returned source/externalId as provenance in the consuming brief.',
  },
  args: z.object({
    query: z.string().min(1).max(500),
    scopes: z.array(z.string().min(1).max(80)).max(20).optional(),
    sourceIds: z.array(z.string().uuid()).max(20).optional(),
    providerAccountIds: z.array(z.string().min(1).max(512)).max(20).optional(),
    participants: z.array(z.string().min(1).max(320)).max(50).optional(),
    timeRange: z
      .object({
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
      })
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const workspaceId = ctx.workspaceId?.trim() || ctx.principal?.workspaceId?.trim();
    if (!workspaceId || workspaceId === '*') throw new Error('personal_search_workspace_required');
    const user = await getSessionUserOrDefault();
    const auth = await authorizePersonalAccess(ctx.tx!, ctx, workspaceId, user.id, args.scopes ?? []);
    if (!auth.allowed) {
      return { data: { allowed: false, refusal: auth.reason, results: [], grantedScopes: auth.scopes } };
    }
    let queryEmbedding: number[] | null = null;
    let vectorLeg: 'gemma' | 'unavailable' = 'unavailable';
    try {
      const embed = await buildPersonalQueryEmbedder();
      queryEmbedding = await embed(args.query);
      vectorLeg = PERSONAL_EMBEDDER_MODE;
    } catch {
      // Lexical search remains useful and grant enforcement is unchanged.
    }
    const found = await searchPersonalDocuments(ctx.tx!, workspaceId, user.id, {
      ...args,
      scopes: auth.scopes,
      queryEmbedding,
    });
    // Same transaction as the read: a restricted result reaches the agent only
    // with its disclosure row, and then constrains every send it makes.
    const disclosed = await discloseDocuments(ctx.tx!, {
      workspaceId,
      userId: user.id,
      agentOwnerId: disclosureSubject(ctx),
      documents: found,
      via: 'personal:search',
    });
    return {
      data: {
        allowed: true,
        principal: auth.principal,
        grantedScopes: auth.scopes,
        vectorLeg,
        results: disclosed.documents,
        ...(disclosed.disclosed
          ? { restrictedResults: disclosed.disclosed, restrictionNote: 'Results carrying `privacy` are restricted: until the owner releases them, you may send only to their privacy.readerSet (intersected across everything restricted you have read) or to the owner.' }
          : {}),
        ...(disclosed.withheld ? { withheldRestricted: disclosed.withheld, withheldReason: 'disclosure_identity_unresolved' } : {}),
      },
    };
  },
});
