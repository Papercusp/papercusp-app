/**
 * plans:backfill-dependency-edges — give ALREADY-promoted plan items the dependency edges
 * promotion would write for them today.
 *
 * work-item-dependency-edges-2026-08-02, P-009 (D-014 / D-015).
 *
 * Promotion (P-006) writes `blocks` edges only for the items it mints in that call, so every plan
 * promoted before P-006 landed carries its NODES with none of its GRAPH — the dependency structure
 * the plan describes exists nowhere the scheduler can query, which is the exact failure this plan
 * exists to fix. This verb is the one-shot repair.
 *
 * Thin on purpose: all of the behavior lives in `backfillPromotedDependencyEdges`, which REUSES
 * promotion's own `writePromotedDependencyEdges` rather than re-deriving the policy (D-014). So
 * this inherits, for free and un-forkably, D-010's authoritative writer, D-012's per-edge cycle
 * pre-flight, the terminal-blocker skip, and the dangling-vs-unresolved counter split — and it
 * cannot trip P-007's `lint:no-raw-block-edge` guard.
 *
 * Idempotent (the same property `plans:backfill-revisions` relies on): the writer is
 * set-to-exactly-this-list and D-015's union is order-stable, so re-running converges rather than
 * duplicating. Safe to run twice; safe to run after a partial run.
 *
 * RUN `dryRun: true` FIRST. It is not a formality — the dry run is the only honest source of the
 * expected write count. The headline "233 blocker refs" is the INPUT set, and the number of edges
 * actually written is materially lower (terminal blockers are skipped, dangling refs refused,
 * cyclic pairs rejected). Deriving it by arithmetic instead of by rehearsal has been wrong every
 * time it has been tried on this plan.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { backfillPromotedDependencyEdges } from '../../plan-workitem-promotion-run';

const argsSchema = z.object({
  harness: harnessArg,
  dryRun: z
    .boolean()
    .optional()
    .describe(
      'Compute and report every counter WITHOUT writing. Run this first — it is the only reliable source of the expected write count.',
    ),
  planSlugs: z
    .array(z.string().min(1))
    .max(500)
    .optional()
    .describe('Restrict to these plans. Omit to cover every plan with at least one promoted item.'),
});

export default defineTool({
  name: 'plans:backfill-dependency-edges',
  description:
    "One-time, idempotent repair (P-009): write the feature→feature `blocks` edges promotion would produce today for plan items that were ALREADY promoted — plans promoted before P-006 carry their nodes but not their dependency graph, so their blockers gate nothing. Reuses the promotion writer, so the cycle pre-flight, terminal-blocker skip and authoritative-writer rules all apply unchanged. PRESERVES edges written by any other author instead of replacing them (D-015). Run with dryRun:true first.",
  guidance: {
    when: 'Once, after P-006 promotion ships, to give existing plans the edges promotion only writes for newly-minted items — or to repair one plan whose edges were never written.',
    notWhen:
      'Routine use. Promotion maintains these edges automatically for anything it mints; this is a migration, not an everyday tool.',
    chaining:
      'plans:backfill-dependency-edges { dryRun: true } → read the counters → backup:snapshot_create → plans:backfill-dependency-edges → work_items:claimable to confirm the newly-gated items left the claimable set.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    // WI-5125 / EI-16183 / WI-5825 class — resolve the write scope ONCE, from the SAME authority
    // the plan readers use. This handler reads plans via readPlanBySlug (inside the backfill) and
    // writes edges keyed off the resolved harness, so deriving either on a second path is exactly
    // how the two come to disagree. Never activeWorkspaceId(), never a literal.
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);

    const result = await backfillPromotedDependencyEdges({
      workspaceId,
      harnessSlug,
      planSlugs: args.planSlugs,
      dryRun: args.dryRun,
    });

    ctxAny.metadata?.({
      harnessSlug,
      dryRun: result.dryRun,
      plansTouched: result.plansTouched,
      edgesWritten: result.edgesWritten,
      edgesPreserved: result.edgesPreserved,
    });

    // Canonical ToolResponse shape: return the payload and let the single
    // serializeToolResponse path own wire encoding (auto-TOON on the agent-facing
    // MCP transport). Hand-rolled inline JSON is the legacy shape the
    // tool-data-shape ratchet counts.
    return { data: { harnessSlug, ...result } };
  },
});
