/**
 * rationale:reproject — maintenance verb for the rationale projection
 * (docs-and-memory-as-projections-2026-06-05 D-003).
 *
 * Mostly fired by the event engine (../../rationale/rules): a decision added, a
 * source tagged, a work-item's state changed → reproject just that source. Also
 * callable directly for a bulk backfill (`kind:'all'`) or a one-off resync. The
 * underlying op is idempotent — re-projecting a source diffs against its prior
 * contributions, so a redundant call converges to the same index.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import {
  reprojectPlan,
  reprojectWorkItem,
  reprojectTagged,
  reprojectInsights,
  backfillAll,
} from '../../rationale/service';
import { bulkContent, runBulk } from '../_bulk';

const reprojectItemSchema = z.object({
  kind: z
    .enum(['plan', 'work_item', 'insight', 'tagged', 'all'])
    .describe('What to reproject. "all" = full backfill; "insight" = all insights.'),
  id: z.string().optional().describe('Plan slug or work-item id (for kind plan/work_item).'),
  harness: z.string().optional().describe('Harness slug, when disambiguating a plan/work-item.'),
  objectKind: z.string().optional().describe('For kind="tagged": the tagged object kind.'),
  objectRef: z.string().optional().describe('For kind="tagged": the tagged object ref.'),
});

export default defineTool({
  name: 'rationale:reproject',
  description:
    'Re-derive a source (plan / work-item / insight) into the topic-keyed rationale index, or backfill all of them. Idempotent. Normally fired automatically by the event engine; call directly to backfill (kind:"all") or force a resync.',
  guidance: {
    when: 'To backfill the rationale index (kind:"all") on a fresh DB, or force-resync one source after an out-of-band change. Routine maintenance is automatic.',
    notWhen: 'To READ the projection — that is rationale:feed.',
    seeAlso: [
      'rationale:feed (READ the projection)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      kind: z
        .enum(['plan', 'work_item', 'insight', 'tagged', 'all'])
        .optional()
        .describe('What to reproject. "all" = full backfill; "insight" = all insights.'),
      id: z.string().optional().describe('Plan slug or work-item id (for kind plan/work_item).'),
      harness: z.string().optional().describe('Harness slug, when disambiguating a plan/work-item.'),
      objectKind: z.string().optional().describe('For kind="tagged": the tagged object kind.'),
      objectRef: z.string().optional().describe('For kind="tagged": the tagged object ref.'),
      items: z.array(reprojectItemSchema).min(1).max(200).optional().describe('sources to reproject in one call'),
    })
    .refine((a) => Boolean(a.kind) || (a.items?.length ?? 0) > 0, {
      message: 'pass a single source or items[]',
    }),
  async handler(args) {
    const items = args.items ?? [args as z.infer<typeof reprojectItemSchema>];
    const env = await runBulk(
      items,
      async (item) => {
        const summary = await reprojectOne(item);
        return { ok: true as const, ...summary };
      },
      { keyOf: (item) => ({ kind: item.kind, ...(item.id ? { id: item.id } : {}), ...(item.objectRef ? { objectRef: item.objectRef } : {}) }) },
    );
    return bulkContent(env);
  },
});

async function reprojectOne(args: z.infer<typeof reprojectItemSchema>): Promise<Record<string, unknown>> {
  switch (args.kind) {
      case 'plan':
        if (!args.id) throw new Error('id (plan slug) required for kind="plan"');
        await reprojectPlan(args.id, args.harness);
        return { reprojected: 'plan', id: args.id };
      case 'work_item':
        if (!args.id) throw new Error('id (work-item id) required for kind="work_item"');
        await reprojectWorkItem(args.id, args.harness);
        return { reprojected: 'work_item', id: args.id };
      case 'tagged':
        if (!args.objectKind || !args.objectRef)
          throw new Error('objectKind + objectRef required for kind="tagged"');
        await reprojectTagged(args.objectKind, args.objectRef);
        return { reprojected: 'tagged', objectKind: args.objectKind, objectRef: args.objectRef };
      case 'insight': {
        const n = await reprojectInsights();
        return { reprojected: 'insight', count: n };
      }
      case 'all': {
        const r = await backfillAll();
        return { reprojected: 'all', ...r };
      }
  }
}
