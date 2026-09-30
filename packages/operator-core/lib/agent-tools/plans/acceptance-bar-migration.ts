/**
 * plans:migrate-acceptance-bars — bounded P-010 cohort migration.
 *
 * The policy and transaction adapter live in the storage-agnostic
 * `acceptance-bar-migration` module. This thin tool is the operator-facing
 * door: it resolves the same workspace+harness write scope as other plans
 * writers, and exposes dry-run/cursor controls without a second migration
 * implementation.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolvePlanWriteScope } from './_write-scope';
import { runAcceptanceBarMigrationInDatabase } from '../../acceptance-bar-migration';

const argsSchema = z.object({
  harness: harnessArg,
  planSlug: z.string().min(1).max(200).optional().describe('Optional single-plan scope for a controlled dogfood pass.'),
  legacyCriterionMap: z.record(z.string().regex(/^R-\d+$/), z.string().min(1)).optional()
    .describe('First backfill only: explicit R-N to existing acceptance criterion key mapping. Must cover both complete sets one-to-one. Preserves existing identity, outcome, falsifier and METHOD; never rewrites a locked BAR contract. Requires planSlug.'),
  cursor: z.string().min(1).max(500).optional().describe('Slug cursor returned by a prior page.'),
  batchSize: z.number().int().positive().max(500).optional().describe('Plans per page (default 25).'),
  dryRun: z
    .boolean()
    .optional()
    .describe('Classify and report the page without writing markers, rubrics, or projections.'),
});

export default defineTool({
  name: 'plans:migrate-acceptance-bars',
  description:
    'Run one bounded, cursor-resumable acceptance BAR cohort migration page. Terminal history is skipped, drafts use strict post-epoch seeding, legacy Requirements use legacy-backfilled seeding, and untrusted sources are refused. Each plan writes through the canonical transactional BAR seed writer and rolls back independently on refusal. Run with dryRun:true first.',
  guidance: {
    when: 'Adopting the acceptance BAR contract for existing plans after the gate/writer rollout; repeat with the returned nextCursor until complete.',
    notWhen:
      'Routine plan edits, rubric amendments, or a plan that is already fully seeded. This is a bounded migration door.',
    chaining:
      'plans:migrate-acceptance-bars { dryRun:true } → repeat with nextCursor → plans:get / plans:items to verify the seeded rubric and projections.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    if (args.legacyCriterionMap && !args.planSlug) throw new Error('invalid_args: legacyCriterionMap requires a single planSlug');
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const actorId = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]).ownerId;
    const result = await runAcceptanceBarMigrationInDatabase({
      workspaceId,
      harnessSlug,
      planSlug: args.planSlug,
      actorId,
      cursor: args.cursor,
      batchSize: args.batchSize,
      dryRun: args.dryRun,
      legacyCriterionMap: args.legacyCriterionMap,
    });
    const ctxAny = ctx as { metadata?: (data: Record<string, unknown>) => void };
    ctxAny.metadata?.({
      workspaceId,
      harnessSlug,
      dryRun: result.dryRun,
      complete: result.complete,
      nextCursor: result.nextCursor,
      outcomes: result.outcomes.length,
    });
    return { data: { workspaceId, harnessSlug, ...result } };
  },
});
