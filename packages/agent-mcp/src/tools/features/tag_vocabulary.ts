/**
 * Return the tag vocabulary for a harness — every distinct tag with
 * its usage count, ordered by count DESC.
 *
 * Useful for:
 *   - Scoper proposing new features: pick from existing tags rather
 *     than inventing variants ("auth" vs "Auth" vs "authentication").
 *   - Operator UI tag-input autocomplete.
 *   - Tag-governance review: spot near-duplicate tags before they sprawl.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';

const SLUG_RE = /^[a-z0-9._-]+$/i;

interface TagCount {
  tag: string;
  count: number;
}

export default defineTool({
  name: 'features:tag_vocabulary',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'features:read',
  guidance: {
    when: 'You need the set of known feature tags before tagging a new one — keeps tags consistent across the harness.',
    notWhen: 'For finding features BY a tag, use `features:search` (free-text) or `features:list_related`.',
  },
  args: z.object({
    slug: z.string().min(1),
    /** Hard cap on the returned list. Default 100. */
    limit: z.number().int().positive().max(500).default(100),
  }),
  async handler(args, ctx: PapercuspToolContext) {
    const tx = ctx.tx!;
    if (!SLUG_RE.test(args.slug)) {
      return { data: [], degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
    }

    let rows: Array<{ tag: string; count: bigint }> = [];
    try {
      // Unnest tags JSONB to text rows, group, count.
      rows = await tx<Array<{ tag: string; count: bigint }>>`
        SELECT tag, COUNT(*)::bigint AS count
          FROM harness_shared.harness_features_consolidated,
               jsonb_array_elements_text(COALESCE(tags, '[]'::jsonb)) AS tag
         WHERE harness_slug = ${args.slug}
         GROUP BY tag
         ORDER BY count DESC, tag ASC
         LIMIT ${args.limit}
      `;
    } catch (err) {
      return {
        data: [],
        degraded: true,
        degradedReasons: [`features:tag_vocabulary query failed: ${(err as Error).message.slice(0, 200)}`],
      };
    }

    const data: TagCount[] = rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
    return { data };
  },
});
