/**
 * work_items:links — read the typed relations recorded by work_items:link.
 *
 * Reads one or many work-items in either direction. The limit is applied to
 * each item independently, and topic-tag edges are omitted because tags are
 * not work-item references (work_items:tag / work_items:get expose those).
 *
 * The two work-item families do not share one coord workspace implementation:
 * issue links use the dynamically scoped issue store, while feature links use
 * the canonical blocking reader. Keeping that dispatch here prevents an issue
 * read from silently querying the legacy DEFAULT_COORD_WORKSPACE partition.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PgLinkStore, type LinkRow, type ObjectRef } from '@papercusp/coordination/capabilities';
import { getOrgPg } from '@papercusp/db-org';
import { coordScopeWorkspace } from '../coordination/log';
import { COORD_ROLES } from '../coordination/roles';
import { blockingEdgeReader, createBlockingEdgeReader, type BlockingEdgeReader } from '../../work-item-blocking';
import { getWorkItem, workItemObjectRef } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** The compact relation shape returned by this read surface. */
export interface WorkItemLink {
  rel: string;
  src?: ObjectRef;
  dst?: ObjectRef;
  satisfaction?: 'settled' | 'success';
}

/** Keep the endpoint relevant to the requested direction, matching get(detail:true)'s compact shape. */
export function projectWorkItemLink(row: LinkRow, direction: 'out' | 'in'): WorkItemLink {
  const satisfaction = 'satisfaction' in row ? (row.satisfaction as 'settled' | 'success') : undefined;
  return direction === 'out'
    ? { rel: row.rel, dst: row.dst, ...(satisfaction ? { satisfaction } : {}) }
    : { rel: row.rel, src: row.src, ...(satisfaction ? { satisfaction } : {}) };
}

/**
 * Issues have a per-workspace coord partition when COORD_PER_WORKSPACE is on.
 * This resolver is intentionally dynamic: PgLinkStore calls it at read time,
 * so a long-lived tool module never pins issue links to the workspace at import.
 */
const issueCoordStore = new PgLinkStore({
  getSql: () => getOrgPg().sql,
  ensureSchema: async () => {},
  getWorkspaceId: () => coordScopeWorkspace(),
});
const issueBlockingLinks: BlockingEdgeReader = createBlockingEdgeReader(issueCoordStore);

function readLinks(reader: BlockingEdgeReader, ref: ObjectRef, direction: 'out' | 'in'): Promise<LinkRow[]> {
  return direction === 'out' ? reader.listOut(ref) : reader.listIn(ref);
}

export default defineTool({
  name: 'work_items:links',
  profile: 'engineer',
  capability: 'work_items:read',
  requirePrincipal: false,
  // This handler uses getWorkItem plus the family-specific link readers, each
  // of which owns its own database access; do not retain an ambient tx across
  // the await-heavy per-item reads.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  description:
    'Read typed links for one OR many work-items. `direction:"out"` returns what each item points to; `direction:"in"` returns what points to each item. Pass `id` or `ids`, with a shared per-item `limit` (default 20, max 100). Topic-tag edges are omitted. Returns { ok, results:[{ ok, id, direction, links? | error }], counts } — correlate by id.',
  guidance: {
    when: 'You need the structured relations recorded by work_items:link, including blockers, duplicates, fixes, and descriptive edges. Use direction:"out" for the item’s targets or direction:"in" for references to the item; pass ids:[…] for several items.',
    notWhen: 'For topic tags use work_items:tag or work_items:get { detail:true }; tags are intentionally omitted from this relation read.',
    chaining: 'work_items:get → work_items:links { id, direction:"out" | "in" } → work_items:get { ids:[…] } for selected linked work-items.',
  },
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to read (1–100)'),
      direction: z
        .enum(['out', 'in'])
        .default('out')
        .describe('out = links from each item; in = links pointing to each item'),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_LIMIT)
        .default(DEFAULT_LIMIT)
        .describe(`maximum links returned for EACH item (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`),
      harness: z.string().max(80).optional().describe('caller harness scope for resolving feature-family ids'),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, {
      message: 'pass `id` (one) or `ids` (many)',
    }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    const direction = args.direction ?? 'out';
    const limit = args.limit ?? DEFAULT_LIMIT;
    const env = await runBulk(
      ids,
      async (id) => {
        const item = await getWorkItem(id, args.harness);
        if (!item) return { ok: false as const, id, error: `work_item '${id}' not found` };

        const ref = workItemObjectRef(item);
        // The production blockingEdgeReader is the canonical feature-family
        // reader. Issue-family reads need the dynamically scoped store above;
        // both readers still merge canonical work_item_deps for `blocks`.
        const reader = ref.kind === 'issue' ? issueBlockingLinks : blockingEdgeReader;
        const rows = await readLinks(reader, ref, direction);
        const links = rows
          .filter((row) => row.rel !== 'tagged')
          .slice(0, limit)
          .map((row) => projectWorkItemLink(row, direction));
        return { ok: true as const, id, direction, links };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
