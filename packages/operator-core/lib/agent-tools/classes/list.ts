/** Capability-class discovery over the registry's tsv + embedding columns. */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import {
  capabilityClassVectorStorageAcceptsProfile,
  listCapabilityClasses,
} from '../../capability-class-registry-store';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from '../search/embedder';

export const listCapabilityClassesTool = defineTool({
  name: 'classes:list',
  description:
    'Discover versioned capability classes in this workspace. Query search fuses the registry title_tsv and ' +
    'stored embedding; tag filtering and version-history controls are explicit.',
  guidance: {
    when: 'Before defining or granting a capability class, to reuse the existing fine-grained contract and exact version.',
    notWhen: 'To inspect full schemas/provider attestations — use classes:get. To define a class — classes:define is platform-only.',
    chaining: 'classes:list { query } → classes:get { ref } → classes:validate for a provider implementation.',
    seeAlso: ['classes:get', 'classes:define', 'classes:validate'],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    query: z.string().min(1).max(500).optional(),
    tag: z.string().min(1).max(80).optional(),
    includeInactive: z.boolean().optional(),
    includeVersions: z.boolean().optional().describe('Return all matching versions instead of only the newest per class id.'),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId;
    if (!workspaceId) return { data: { ok: true, classes: [], count: 0 } };
    const resolved = args.query
      ? await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null)
      : null;
    const embeddingProfile =
      resolved && capabilityClassVectorStorageAcceptsProfile(resolved.profile)
        ? resolved.profile
        : null;
    const embedding = resolved && embeddingProfile && args.query
      ? await resolved.embed(args.query).catch(() => null)
      : null;
    const classes = await listCapabilityClasses(getOrgPg().sql, workspaceId, {
      query: args.query,
      tag: args.tag,
      includeInactive: args.includeInactive,
      includeVersions: args.includeVersions,
      limit: args.limit,
      embedding,
      embeddingProfile: embedding ? embeddingProfile : null,
    });
    return {
      data: {
        ok: true,
        count: classes.length,
        classes: classes.map((row) => ({
          ref: row.ref,
          id: row.id,
          version: row.version,
          title: row.title,
          description: row.description,
          tags: row.tags,
          status: row.status,
          reviewStatus: row.reviewStatus,
          hasEmbedding: row.hasEmbedding,
          ...(row.score == null ? {} : { score: row.score }),
        })),
      },
    };
  },
});

export default listCapabilityClassesTool;
