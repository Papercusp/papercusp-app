/**
 * plan_items:status — the merged per-item view for a plan (assignment + claim).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { mergedPlanItemStates } from '../../plan-items/liveness';
import { listWorkGroup } from '../../plan-items/work-group';

export default defineTool({
  name: 'plan_items:status',
  description:
    'The merged per-item view of a plan: each item\'s disposition (pooled / assigned-idle / active / claimed-pooled / claimed-mismatch) combining the durable assignment with the live claim, the optional linked implementing work-item (including claim-hold status and provenance), plus any work-group members. The coherent answer to "who is doing what on this plan" and why a linked record may be excluded from self-selection.',
  guidance: {
    when: 'Deciding what to pick up, or auditing who holds what on a plan.',
    notWhen: 'You only want YOUR assigned items — plan_items:my_items is narrower.',
    chaining: 'plan_items:status { harness, plan } → claim a "pooled"/"assigned-idle"(yours) item.',
    seeAlso: [
      'plan_items:claim (claim a pooled / assigned-idle item)',
      'plan_items:assign (assign an item to a peer)',
      'plan_items:my_items (just your own items)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
  }),
  async handler(args, _ctx) {
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const [items, workGroup] = await Promise.all([
      mergedPlanItemStates(workspaceId, harnessSlug, args.plan),
      listWorkGroup(workspaceId, harnessSlug, args.plan),
    ]);
    return {
      data: { ok: true, plan: args.plan, harness: harnessSlug, items, workGroup },
    };
  },
});
