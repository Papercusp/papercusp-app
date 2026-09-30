/**
 * work_items:promote — give a non-pipeline work-item (a filed bug/change) a feature
 * pipeline run (D-005). Mints an F-FIX feature (reusing mintFixFeatureRow), links
 * it, and records the linkage. A feature-family work-item already IS a pipeline
 * work-item — no-op.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): promote ONE item inline
 * ({ id, harness? }) or MANY (items:[{ id, harness? }]) → { ok, results:[{ ok, id,
 * … | error }], counts }. Each result self-describes its id; one failure never fails
 * the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { promoteToPipeline } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1).describe('the bug/change work-item id to promote'),
  harness: z.string().max(80).optional().describe('per-item target harness (else the batch `harness` default)'),
});

export default defineTool({
  name: 'work_items:promote',
  profile: 'engineer',
  description:
    'Promote one OR many bug/change work-items into a feature pipeline run (mints an F-FIX feature in the target harness and links it). Single: { id, harness? }. Many: items:[{ id, harness? }]. An operator-scope item needs an explicit harness. Returns { ok, results:[{ ok, id, … | error }], counts } — correlate by id; one failure never fails the rest.',
  guidance: {
    when: 'A filed bug/change is ready to be worked by the pipeline — for one item or several at once.',
    notWhen: 'It is a passing idea (leave it filed) or already a feature.',
    chaining: 'work_items:create { kind:"bug" } → work_items:promote { harness } → the pipeline picks up the feature.',
    seeAlso: [
      'work_items:create (file the bug/change first)',
      'work_items:claim_next (the pipeline agent self-selects the promoted feature)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id to promote'),
      items: z.array(itemSpec).min(1).max(100).optional().describe('promote many work-items at once — each { id, harness? }'),
      harness: z.string().max(80).optional().describe('default target harness for the inline id / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or items:[{ id }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const items = args.items?.length ? args.items : [{ id: args.id as string, harness: args.harness }];
    const env = await runBulk(
      items,
      async (it) => {
        const res = await promoteToPipeline(it.id, { harness: it.harness ?? args.harness, actor: ident.ownerId });
        return 'error' in res ? { ok: false as const, id: it.id, error: res.error } : { ok: true as const, id: it.id, ...res };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
