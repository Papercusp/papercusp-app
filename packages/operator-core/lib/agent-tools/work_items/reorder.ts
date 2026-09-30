/**
 * work_items:reorder — the per-assignee work-list REORDER (local-hive-orchestration
 * Phase 2, P-020 / D-004 / D-008).
 *
 * Each assigned work-item carries a per-assignee `rank` — the externalized, ordered
 * version of the bee's invisible TodoWrite. This tool MOVES one item to a `rank` within
 * its assignee's queue (insert-at-rank: peers shift down). It is:
 *   • bee-authored by DEFAULT (a bee resequences its own list / slots a discovery in) —
 *     writer 'bee';
 *   • Queen-writable (inject at a rank, rebalance) — writer 'queen'.
 *
 * `writer` is the propose/dispose AUDIT (D-008): the Queen PROPOSES (writer 'queen'); the
 * bee DISPOSES (owns its actual sequencing, writer 'bee').
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): move ONE item inline
 * ({ id, rank }) or MANY (items:[{ id, rank, writer?, harness? }]) → { ok, results:[{ ok,
 * id, … | error }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { reorderWorkItem, RANK_WRITERS } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1).describe('Work-item id (WI-/F-/EI-).'),
  rank: z.number().int().min(0).describe('Target position (0 = head-of-line; clamped to queue length).'),
  writer: z.enum([...RANK_WRITERS] as [string, ...string[]]).optional(),
  harness: z.string().max(80).optional(),
});

export default defineTool({
  name: 'work_items:reorder',
  profile: 'engineer',
  description:
    "Move one OR many work-items to a position (`rank`, 0-based, 0 = head-of-line) within their assignee's ordered work-list — peers shift down. Single: { id, rank }. Many: items:[{ id, rank, writer?, harness? }]. `writer`='cup' (default, a cup resequencing its own list) | 'mug' (Mug overlay). Returns { ok, results:[{ ok, id, … | error }], counts }.",
  guidance: {
    when: "You are a cup resequencing your own work-list, or the Mug injecting/rebalancing — for one item or several at once. Claim items first; rank is per-assignee.",
    notWhen:
      'You only want to START an item (work_items:claim) or change its lifecycle state (work_items:set_state). Reorder changes ORDER, not ownership or state.',
    chaining:
      'work_items:claim → work_items:reorder → fleet:assignments { agent } to see the ordered queue. The Mug: fleet:assignments → work_items:reorder { writer:"mug", items:[…] }.',
    seeAlso: [
      'work_items:set_priority (GLOBAL backlog order, pre-claim — not a per-assignee rank)',
      'work_items:co_locate (pin work to a Swarm rather than order a queue)',
      'fleet:assignments (view the ordered queue you just reranked)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `rank`)'),
      rank: z.number().int().min(0).optional().describe('single shorthand: target position (use with `id`)'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('reorder many items at once — each { id, rank, writer?, harness? }'),
      writer: z.enum([...RANK_WRITERS] as [string, ...string[]]).optional().describe('default writer for the inline/items (cup default)'),
      harness: z.string().max(80).optional(),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.id) && a.rank !== undefined), {
      message: 'pass { id, rank } for one, or items:[{ id, rank }] for many',
    }),
  async handler(args, ctx) {
    // Identity isn't strictly needed (rank is keyed on the item's assignee), but resolving
    // it keeps the per-edit liveness heartbeat + audit attribution consistent with peers.
    resolveAgentIdentity(ctx);
    const items = args.items?.length
      ? args.items
      : [{ id: args.id as string, rank: args.rank as number, writer: args.writer, harness: args.harness }];
    const env = await runBulk(
      items,
      async (it) => {
        const result = await reorderWorkItem(it.id, it.rank, {
          writer: ((it.writer ?? args.writer) as 'cup' | 'mug' | undefined) ?? 'cup',
          harness: it.harness ?? args.harness,
        });
        return 'error' in result
          ? { ...result, ok: false as const, id: it.id }
          : { ...result, ok: true as const, id: it.id };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
