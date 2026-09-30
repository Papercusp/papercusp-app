/**
 * wiki:backlinks — find markdown references to a [[target]] across
 * the workspace. Same scanner as GET /api/wiki-backlinks.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): look up ONE page (`target`) or MANY
 * (`targets:[…]`) in ONE call, with a shared `harness` filter. Returns
 * { ok, results:[{ ok, target, harness, hits[] | error }], counts } — correlate
 * each result by its `target`, not by array position; one failed scan never
 * fails the rest.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { findWikiBacklinks } from '../../wiki-backlinks';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'wiki:backlinks',
  profile: 'engineer',
  guidance: {
    when: 'User asks "what links to X?", "where is `[[name]]` referenced?". Wiki-style backlink lookup across markdown files. Look up several pages at once via `targets:[…]`.',
    notWhen: 'For cross-resource full-text search, use `search:query`. For markdown TOC, use `harness:markdown_index`.',
    chaining: 'single `target` | `targets:[…]` → { ok, results:[{ ok, target, harness, hits[] | error }], counts } — correlate by target not position; one failure never fails the rest.',
  },
  description:
    'Find markdown files that reference [[target]] across the workspace, for one OR many pages in ONE call — pass `target` for one or `targets:[…]` for several (1–100), with an optional shared `harness` filter. Returns { ok, results:[{ ok, target, harness, hits[] | error }], counts } — correlate each result by its target, not by position; one failed scan never fails the rest.',
  capability: 'wiki:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z
    .object({
      target: z.string().min(1).optional().describe('a single page/title to find backlinks for (n=1 shorthand for targets:[target])'),
      targets: z.array(z.string().min(1)).max(100).optional().describe('pages/titles to find backlinks for (1–100)'),
      harness: z.string().optional().describe('optional harness filter applied to every target'),
    })
    .refine((a) => Boolean(a.target) || (a.targets?.length ?? 0) > 0, {
      message: 'pass `target` (one) or `targets` (many)',
    }),
  async handler(args) {
    const targets = mergeIds(args.target, args.targets);
    const harness = args.harness ?? null;
    const env = await runBulk(
      targets,
      async (target) => {
        const result = await findWikiBacklinks(target, harness);
        return { ok: true as const, target, harness: result.harness, hits: result.hits };
      },
      { keyOf: (target) => ({ target }) },
    );
    return bulkContent(env);
  },
});
