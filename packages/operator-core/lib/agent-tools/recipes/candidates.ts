/**
 * recipes:candidates — the Queen's DETERMINISTIC graduation worklist for code
 * recipes (code-recipes-2026-06-21 Phase 3, P-013 / D-017).
 *
 * A READ tool (no LLM): it computes the deterministic usage signals per active
 * recipe in the caller's hive (run_count, distinct-agent reuse breadth,
 * success-rate, tool-set cohesion), scores them against the recipe rubric, and
 * returns ranked PROMOTE candidates (recipes worth building into a defineTool via
 * a work-item, D-013) plus the near-duplicate MERGE clusters (D-015). The Queen
 * CALLS this in her cadence (PULL, D-017) — she does the JUDGMENT, the code does
 * the counting (D-010). Redundant recipes (1-tool wrappers, or an id that collides
 * an existing tool) are excluded from promote candidates. Read-only.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { recipeCandidates } from '../../code-recipes-candidates';
import { buildQueryEmbedderResolved, interactiveEmbedAcquireBudgetMs } from '../search/embedder';
import { resolveProseProfileSelection } from '../../search/prose-vector-dims';
// tool-call-batching-wrappers-2026-06-21 P-004 / D-016 — the deterministic co-occurrence scoring leg.
import { buildRecipeCooccurrenceDep } from '../../recipe-cooccurrence-leg';

export default defineTool({
  name: 'recipes:candidates',
  description:
    'Deterministic graduation worklist for code:run RECIPES: ranked PROMOTE candidates (recipes worth ' +
    'building into a tool, scored by run-frequency + distinct-agent reuse + success-rate + tool-set ' +
    'cohesion, 1-tool/duplicate ones excluded) + near-duplicate MERGE clusters. No LLM — counting only; ' +
    'YOU decide promote/merge. Read-only.',
  guidance: {
    when:
      'The Mug calls this in her cadence to find recipes worth promoting to a tool or merging. It ' +
      'returns deterministic signals + a rubric promotionScore per active recipe in the hive — promote ' +
      'a top candidate by filing a work-item ("implement <recipe> as a defineTool"), and review each ' +
      'merge cluster for consolidation into one recipe.',
    notWhen:
      'To browse or run recipes (recipes:list / recipes:search / recipes:run) — this is the graduation ' +
      'review, not the reuse path. It does NOT promote or merge anything itself; it surfaces candidates ' +
      'for you to act on via your plan/work-item system (the gate is the normal coding pipeline).',
    chaining:
      'recipes:candidates → (for a promote candidate) work_items:create "implement <id> as a defineTool" ' +
      '→ (for a merge cluster) recipes:get each id to inspect, then consolidate. recipes:get { id } to ' +
      'read any candidate\'s script first.',
    seeAlso: [
      'recipes:merge (collapse a near-duplicate merge cluster)',
      'recipes:sweep (retire stale one-off recipes)',
      'recipes:get (read a candidate\'s script before acting)',
    ],
  },
  capability: 'recipes:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    minRunCount: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe('Only consider recipes run at least this many times (default 2 — a single run is no signal).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max promote candidates to return (default 25).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const resolved = await buildQueryEmbedderResolved({ acquireBudgetMs: interactiveEmbedAcquireBudgetMs() }).catch(() => null);
    const embeddingProfile = resolved
      ? resolveProseProfileSelection(resolved.mode, resolved.profile)
      : null;
    const embedder = resolved && embeddingProfile ? resolved.embed : null;
    // tool-call-batching-wrappers P-004 / D-016 — fold in the deterministic co-occurrence
    // leg: mean pairwise confidence of a recipe's tool-set, from dev:tool_cooccurrence.
    // (workspace-scoped telemetry — recipes are global, but this signal is per-workspace.)
    const toolCooccurrence = await buildRecipeCooccurrenceDep(workspaceId).catch(() => null);
    const { promoteCandidates, mergeClusters } = await recipeCandidates(
      getOrgPg().sql,
      {
        minRunCount: args.minRunCount,
        limit: args.limit,
      },
      { embedder, toolCooccurrence, log: (msg) => ctx.log(msg) },
    );
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            promoteCount: promoteCandidates.length,
            mergeClusterCount: mergeClusters.length,
            promoteCandidates,
            mergeClusters,
          }),
        },
      ],
    };
  },
});
