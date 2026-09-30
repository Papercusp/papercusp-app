/**
 * artifacts:delete — remove one OR many PG-canonical text artifacts.
 *
 * Restricted to non-worker roles to keep workers from accidentally
 * dropping a sibling worker's notes mid-chunk. The legacy disk-mirror
 * lib intentionally does NOT unlink the on-disk file when the row is
 * deleted; this tool just drops the PG row. Anything still relying on
 * a stale on-disk copy will be addressed when the orchestrator's
 * prompt assembly is migrated to PG-direct reads.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness). Pass a single
 * `{ slug?, rel_path }` for n=1, or `items:[{ slug?, rel_path }]` for many →
 * { ok, results:[{ ok, slug, rel_path, deleted | error }], counts }. Each
 * result self-describes its (slug, rel_path); a missing-slug / invalid-slug
 * item fails only itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { SLUG_RE, slugRequires, resolveSlug } from './_slug-requires';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel (see artifacts/load.ts for why: ESM circular-init + node-moduleResolution).
import { runBulk, bulkContent } from '../../_bulk';


function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.papercusp\//, '');
}

const DeleteItem = z.object({
  slug: z.string().min(1).regex(SLUG_RE).optional(),
  rel_path: z.string().min(1),
});
type DeleteItem = z.infer<typeof DeleteItem>;

export default defineTool({
  name: 'artifacts:delete',
  needsWorkspaceTx: true,
  description:
    'Delete one OR many PG-canonical text artifact rows by (harness_slug, rel_path). Restricted to architect/operator/curator roles. Pass a single `{ slug?, rel_path }` or `items:[{ slug?, rel_path }]` for several. Returns { ok, results:[{ ok, slug, rel_path, deleted | error }], counts } — correlate by (slug, rel_path), not by position; a missing / invalid-slug item fails only itself.',
  capability: 'artifacts:write',
  guidance: {
    when: 'Remove an artifact that\'s no longer relevant. Restricted to architect/operator/curator roles by `roles` allowlist. Delete several at once via `items`.',
    notWhen: 'Don\'t delete to "clean up" speculatively — artifacts cost nothing to keep, and other agents may rely on them.',
    chaining: 'Bulk: single { slug?, rel_path } | items[] → { ok, results, counts }; correlate by (slug, rel_path) not position; one failure never fails the rest.',
  },
  requirePrincipal: false,
  agentRoles: ['architect', 'operator', 'curator'],
  rolesQuota: {
    architect: { perRun: 20 },
    operator: { perRun: 100 },
    curator: { perRun: 50 },
  },
  args: z
    .object({
      slug: z.string().min(1).regex(SLUG_RE).optional(),
      rel_path: z.string().min(1).optional(),
      items: z.array(DeleteItem).min(1).max(100).optional().describe('artifact keys to delete (1–100), each { slug?, rel_path }'),
    })
    .refine((a) => Boolean(a.items?.length) || Boolean(a.rel_path), {
      message: 'pass `rel_path` (one) or `items:[{ rel_path }]` (many)',
    }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires. The bulk
  // (`items`) path re-asserts per-item slug presence/validity in the handler.
  requires: slugRequires('artifacts:delete'),
  async handler(args, ctx) {
    const items: DeleteItem[] = args.items?.length ? args.items : [{ slug: args.slug, rel_path: args.rel_path! }];
    const env = await runBulk(
      items,
      async (item) => {
        const r = resolveSlug('artifacts:delete', item.slug, ctx.harnessSlug);
        const key = normalizeRelPath(item.rel_path);
        if ('error' in r) {
          return { ok: false as const, slug: item.slug ?? null, rel_path: key, error: r.error };
        }
        const { slug } = r;
        // ctx.tx, NOT getOrgPg() — RLS confines the delete to the caller's
        // workspace (audit P-012, see save.ts).
        const result = await ctx.tx`
          DELETE FROM harness_shared.harness_text_artifacts
           WHERE harness_slug = ${slug} AND rel_path = ${key}
        `;
        return { ok: true as const, slug, rel_path: key, deleted: result.count > 0 };
      },
      { keyOf: (item) => ({ slug: item.slug ?? null, rel_path: normalizeRelPath(item.rel_path) }) },
    );
    return bulkContent(env);
  },
});
