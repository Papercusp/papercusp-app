/**
 * plans:set-priority — set the cross-plan dispatch priority for a
 * started plan (dbos-system-completion-2026-06-01 P-045/D-013).
 *
 * Writes `harness_shared.harness_plans.op_priority` (INTEGER, NULLable;
 * lower = dispatched first — the operational column folded in from the retired
 * harness_plan_status table, plans-pg-canonical-migration-2026-06-03).
 * The frontier groups the ready feature set by
 * plan and orders the groups by this column, so operators drag-to-reorder
 * started plans to control which plan's features the pipeline tackles next.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, runBulk } from '../_bulk';

const setPriorityItemSchema = z.object({
  slug: z.string().min(1).describe('Plan slug to prioritize.'),
  priority: z.number().int().nullable().describe(
    'Dispatch rank — lower = dispatched first. Pass null to clear (no explicit priority; uses started_at order).',
  ),
});

const argsSchema = setPriorityItemSchema.extend({
  harness: harnessArg,
  items: z.array(setPriorityItemSchema).min(1).max(200).optional().describe('plan priorities to set in one call'),
});

export default defineTool({
  name: 'plans:set-priority',
  description:
    'Set the cross-plan dispatch priority for a started plan. Lower = dispatched first. The drag-to-reorder UI calls this automatically; agents can also call it when explicit ordering matters.',
  guidance: {
    when: 'User drags a started plan to a new position in the Plans rail, or explicitly asks "do plan A before plan B".',
    notWhen: 'For pausing a plan, use plans:pause. For the run lifecycle, use plans:set-run-status.',
    chaining: 'plans:list to see started plans and their current priorities.',
    seeAlso: [
      'plans:set-importance (rank ITEMS within a plan, not whole plans)',
      'plans:pause (stop a plan instead of reordering it)',
      'plans:set-run-status (the run lifecycle, not the rail order)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    // ⚠ WI-5125 / EI-16183 / WI-5825 class: harness_plans is keyed on
    // (workspace_id, harness_slug, plan_slug), and that key MUST come from the
    // same authority the readers use — see resolvePlanWriteScope's doc comment
    // for the three generations of this bug. Never activeWorkspaceId(), never a
    // DEFAULT_WORKSPACE_ID literal, never the un-collapsed ctx slug.
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const items = args.items ?? [{ slug: args.slug, priority: args.priority }];
    const env = await runBulk(
      items,
      async (item) => {
        const now = new Date().toISOString();
        const rows = await withWorkspace(workspaceId, async (tx) => {
          return tx<{ plan_slug: string }[]>`
            UPDATE harness_shared.harness_plans
               SET op_priority  = ${item.priority},
                   op_updated_at = ${now}
             WHERE workspace_id = ${workspaceId}
               AND harness_slug = ${harnessSlug}
               AND plan_slug    = ${item.slug}
            RETURNING plan_slug
          `;
        });
        // A slug that matches nothing is a caller error worth surfacing per-item
        // (runBulk keeps the rest of the batch going) rather than a silent no-op
        // masquerading as ok:true (the bug this fixes).
        if (!rows || rows.length === 0) {
          return {
            ok: false as const,
            slug: item.slug,
            harnessSlug,
            error: 'plan_not_found',
          };
        }
        return { ok: true as const, slug: item.slug, harnessSlug, priority: item.priority };
      },
      { keyOf: (item) => ({ slug: item.slug }) },
    );
    return bulkContent(env);
  },
});
