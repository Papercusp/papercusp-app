/**
 * artifacts:save — upsert one OR many PG-canonical text artifacts.
 *
 * Replaces the entire `content` for (harness_slug, rel_path). PG is
 * canonical (per the "PG-canonical, no FS mirrors" project rule); no
 * disk write happens here. If a consumer needs the content on disk
 * (orchestrator prompt assembly, harness-CLI), it should read from PG
 * via `artifacts:load` rather than tail a file.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness), and `content`
 * rides per item. Pass a single `{ slug?, rel_path, content }` for n=1, or
 * `items:[{ slug?, rel_path, content }]` for many → { ok, results:[{ ok, slug,
 * rel_path, bytes, updated_at | error }], counts }. Each result self-describes
 * its (slug, rel_path); a missing-slug / invalid-slug item fails only itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
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

const SaveItem = z.object({
  slug: z.string().min(1).regex(SLUG_RE).optional(),
  rel_path: z.string().min(1),
  content: z.string(),
});
type SaveItem = z.infer<typeof SaveItem>;

export default defineTool({
  name: 'artifacts:save',
  needsWorkspaceTx: true,
  description:
    'Upsert one OR many PG-canonical text artifacts (harness_text_artifacts) by (harness_slug, rel_path); replaces existing content. Pass a single `{ slug?, rel_path, content }` or `items:[{ slug?, rel_path, content }]` for several. Returns { ok, results:[{ ok, slug, rel_path, bytes, updated_at | error }], counts } — correlate by (slug, rel_path), not by position; a missing / invalid-slug item fails only itself.',
  capability: 'artifacts:write',
  guidance: {
    when: 'Persist a generated text artifact for later reads by other agents or future turns. Replaces existing content at the same (harness_slug, rel_path). Save several at once via `items`.',
    notWhen: 'For appending to an existing file, use `artifacts:append` — save fully replaces. For source code, write to the repo via filesystem tools, not artifacts.',
    chaining: 'Bulk: single { slug?, rel_path, content } | items[] → { ok, results, counts }; correlate by (slug, rel_path) not position; one failure never fails the rest.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES],
  rolesQuota: {
    worker: { perChunk: 20 },
    architect: { perRun: 50 },
    scoper: { perRun: 50 },
    operator: { perRun: 200 },
  },
  args: z
    .object({
      slug: z.string().min(1).regex(SLUG_RE).optional(),
      rel_path: z.string().min(1).optional(),
      content: z.string().optional(),
      items: z.array(SaveItem).min(1).max(100).optional().describe('artifacts to upsert (1–100), each { slug?, rel_path, content }'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.rel_path) && a.content !== undefined), {
      message: 'pass `{ rel_path, content }` (one) or `items:[{ rel_path, content }]` (many)',
    }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires. The bulk
  // (`items`) path re-asserts per-item slug presence/validity in the handler.
  requires: slugRequires('artifacts:save'),
  async handler(args, ctx) {
    const items: SaveItem[] = args.items?.length
      ? args.items
      : [{ slug: args.slug, rel_path: args.rel_path!, content: args.content! }];
    const now = Date.now();
    // ctx.tx, NOT getOrgPg() (audit P-012): the host picks the handle —
    // workspace-scoped (harness_app + app.workspace_id GUC, RLS-enforced)
    // for normal dispatch, admin only for superuser/cross-workspace
    // dispatch. The admin handle here bypassed harness_text_artifacts'
    // workspace-isolation policy. workspace_id stamps GUC-first, then
    // ctx.workspaceId — the admin path has no GUC, and a bare
    // COALESCE(...,'') there minted the blank legacy rows EI-280 had to
    // repair ('*' = no concrete workspace, never a stamp). The conflict
    // arm ADOPTS a blank-stamped legacy row instead of tripping the
    // policy on it.
    const wsFallback = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : '';
    const env = await runBulk(
      items,
      async (item) => {
        const r = resolveSlug('artifacts:save', item.slug, ctx.harnessSlug);
        const key = normalizeRelPath(item.rel_path);
        if ('error' in r) {
          return { ok: false as const, slug: item.slug ?? null, rel_path: key, error: r.error };
        }
        const { slug } = r;
        await ctx.tx`
          INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
          VALUES (${slug}, ${key}, ${item.content}, ${now},
                  COALESCE(NULLIF(current_setting('app.workspace_id', true), ''), ${wsFallback}))
          ON CONFLICT (harness_slug, rel_path) DO UPDATE SET
            content      = EXCLUDED.content,
            updated_at   = EXCLUDED.updated_at,
            workspace_id = CASE WHEN harness_text_artifacts.workspace_id = ''
                                THEN EXCLUDED.workspace_id
                                ELSE harness_text_artifacts.workspace_id END
        `;
        return { ok: true as const, slug, rel_path: key, bytes: item.content.length, updated_at: now };
      },
      { keyOf: (item) => ({ slug: item.slug ?? null, rel_path: normalizeRelPath(item.rel_path) }) },
    );
    return bulkContent(env);
  },
});
