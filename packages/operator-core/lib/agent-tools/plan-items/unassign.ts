/**
 * plan_items:unassign — release a plan-item assignment (soft, federated).
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): unassign ONE inline
 * ({ plan, item }), MANY in the SAME plan ({ plan, itemIds:[…] }), or MANY
 * heterogeneous (items:[{ plan, item, harness? }]) → { ok, results:[{ ok, plan,
 * item, released? | error }], counts }. Each result self-describes its { plan,
 * item }; a no-op (no active assignment) is still ok:true with released:null.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { unassignItem } from '../../plan-items/assignments';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

interface UnassignSpecItem {
  plan: string;
  item: string;
  harness?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
});

export default defineTool({
  name: 'plan_items:unassign',
  description:
    "Release one OR many plan items' assignment so each returns to the unassigned pool. History persists (soft-release). Does NOT drop a live claim — release that with plan_items:release. Single: { plan, item }. Many same plan: { plan, itemIds:[…] }. Many heterogeneous: items:[{ plan, item, harness? }]. Returns { ok, results:[{ ok, plan, item, released? | error }], counts } — correlate by { plan, item }; a no-op (no active assignment) stays ok:true with released:null.",
  guidance: {
    when: 'An assignment is no longer wanted — reassigning to nobody, or freeing item(s) back to the pool. Unassign several at once via itemIds:[…] or items:[…].',
    notWhen: 'You just want to stop actively working but keep the item assigned to you — that is plan_items:release (drops the live claim, keeps the assignment).',
    chaining: 'plan_items:status to see assignments → plan_items:unassign { harness, plan, item }.',
    seeAlso: [
      'plan_items:status (see assignments first)',
      'plan_items:assign (re-assign to someone else)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-unassign shorthand: the plan-item id (P-NNN)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('unassign MANY items in `plan` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('unassign many plan items at once — each { plan, item, harness? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.plan) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))), {
      message: 'pass { plan, item } for one, { plan, itemIds:[…] } for many of the same plan, or items:[{ plan, item }] for many',
    }),
  async handler(args, _ctx) {
    const list: UnassignSpecItem[] = args.items?.length
      ? args.items.map((it) => ({ plan: it.plan, item: it.item, harness: it.harness ?? args.harness }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({ plan: args.plan as string, item, harness: args.harness }))
        : [{ plan: args.plan as string, item: args.item as string, harness: args.harness }];
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        const released = await unassignItem(workspaceId, harnessSlug, it.plan, it.item);
        return released
          ? { ok: true, plan: it.plan, item: it.item, released }
          : { ok: true, plan: it.plan, item: it.item, released: null, note: 'no active assignment' };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
