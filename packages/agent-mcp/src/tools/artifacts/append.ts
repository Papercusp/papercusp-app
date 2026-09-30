/**
 * artifacts:append — append to one OR many PG-canonical text artifacts.
 *
 * Concatenates `suffix` to the existing `content`. If the row doesn't
 * exist yet, creates it with `suffix` as the initial content. Returns
 * the post-append byte length so callers can detect overflow without a
 * follow-up `load`.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness), and `suffix`
 * rides per item. Pass a single `{ slug?, rel_path, suffix }` for n=1, or
 * `items:[{ slug?, rel_path, suffix }]` for many → { ok, results:[{ ok, slug,
 * rel_path, appended_bytes, total_bytes, updated_at | error }], counts }. Each
 * result self-describes its (slug, rel_path); a missing-slug / invalid-slug
 * item fails only itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspUnifiedToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
import { SLUG_RE, slugRequires, resolveSlug } from './_slug-requires';
import { SU_WRITE_ROLES } from '../../role-config';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel (see artifacts/load.ts for why: ESM circular-init + node-moduleResolution).
import { runBulk, bulkContent } from '../../_bulk';

// NB: 'tester' is not an AGENT_ROLES member and never was — the phantom
// entry gated nothing (audit P-047).

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.papercusp\//, '');
}

const AppendItem = z.object({
  slug: z.string().min(1).regex(SLUG_RE).optional(),
  rel_path: z.string().min(1),
  suffix: z.string().min(1),
});
type AppendItem = z.infer<typeof AppendItem>;

export default defineTool({
  name: 'artifacts:append',
  needsWorkspaceTx: true,
  description:
    'Append to one OR many PG-canonical text artifacts (harness_text_artifacts); creates the row if absent. Pass a single `{ slug?, rel_path, suffix }` or `items:[{ slug?, rel_path, suffix }]` for several. Returns { ok, results:[{ ok, slug, rel_path, appended_bytes, total_bytes, updated_at | error }], counts } — correlate by (slug, rel_path), not by position; a missing / invalid-slug item fails only itself.',
  capability: 'artifacts:write',
  guidance: {
    when: 'Add to an existing artifact without losing prior content — running notes, ongoing log, accumulating findings. Append to several at once via `items`.',
    notWhen: 'For replacing the whole file, use `artifacts:save`. For ephemeral within-turn notes, just hold them in your reply.',
    chaining: 'Bulk: single { slug?, rel_path, suffix } | items[] → { ok, results, counts }; correlate by (slug, rel_path) not position; one failure never fails the rest.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  rolesQuota: {
    worker: { perChunk: 50 },
    architect: { perRun: 200 },
    scoper: { perRun: 200 },
    operator: { perRun: 500 },
  },
  args: z
    .object({
      slug: z.string().min(1).regex(SLUG_RE).optional(),
      rel_path: z.string().min(1).optional(),
      suffix: z.string().min(1).optional(),
      items: z.array(AppendItem).min(1).max(100).optional().describe('artifacts to append to (1–100), each { slug?, rel_path, suffix }'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.rel_path) && Boolean(a.suffix)), {
      message: 'pass `{ rel_path, suffix }` (one) or `items:[{ rel_path, suffix }]` (many)',
    }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires. The bulk
  // (`items`) path re-asserts per-item slug presence/validity in the handler.
  requires: slugRequires('artifacts:append'),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    const items: AppendItem[] = args.items?.length
      ? args.items
      : [{ slug: args.slug, rel_path: args.rel_path!, suffix: args.suffix! }];
    const now = Date.now();
    // ctx.tx, NOT getOrgPg() — RLS-scoped write; workspace_id stamps
    // GUC-first then ctx.workspaceId, and the conflict arm adopts
    // blank-stamped legacy rows (audit P-012 + EI-280, see save.ts).
    const wsFallback = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : '';
    const env = await runBulk(
      items,
      async (item) => {
        const r = resolveSlug('artifacts:append', item.slug, ctx.harnessSlug);
        const key = normalizeRelPath(item.rel_path);
        if ('error' in r) {
          return { ok: false as const, slug: item.slug ?? null, rel_path: key, error: r.error };
        }
        const { slug } = r;
        const rows = await tx<{ content: string }[]>`
          INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
          VALUES (${slug}, ${key}, ${item.suffix}, ${now},
                  COALESCE(NULLIF(current_setting('app.workspace_id', true), ''), ${wsFallback}))
          ON CONFLICT (harness_slug, rel_path) DO UPDATE SET
            content      = harness_text_artifacts.content || EXCLUDED.content,
            updated_at   = EXCLUDED.updated_at,
            workspace_id = CASE WHEN harness_text_artifacts.workspace_id = ''
                                THEN EXCLUDED.workspace_id
                                ELSE harness_text_artifacts.workspace_id END
          RETURNING content
        `;
        const merged = rows[0]?.content ?? item.suffix;
        return {
          ok: true as const,
          slug,
          rel_path: key,
          appended_bytes: item.suffix.length,
          total_bytes: merged.length,
          updated_at: now,
        };
      },
      { keyOf: (item) => ({ slug: item.slug ?? null, rel_path: normalizeRelPath(item.rel_path) }) },
    );
    return bulkContent(env);
  },
});
