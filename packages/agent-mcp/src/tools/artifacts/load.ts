/**
 * artifacts:load — read one OR many PG-canonical text artifacts for a harness.
 *
 * Same store as `apps/operator/lib/text-artifacts.ts` (Migration 035):
 * `harness_shared.harness_text_artifacts`, keyed (harness_slug, rel_path).
 * Used for memory/*.md, supervisor-notes.md, issues.md, and other free-
 * form per-harness text. Role-gated; agents may read across harnesses
 * by passing an explicit `slug`.
 *
 * The `rel_path` may be passed with or without a leading `.papercusp/`;
 * it's normalised to the bare relative-to-harness-dir form for lookup.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness). Pass a single
 * `{ slug?, rel_path }` for n=1, or `items:[{ slug?, rel_path }]` for many →
 * { ok, results:[{ ok, slug, rel_path, found, content, updated_at | error }],
 * counts }. Each result self-describes its (slug, rel_path); a missing-slug /
 * invalid-slug item fails only itself.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspUnifiedToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
import { SLUG_RE, slugRequires, resolveSlug } from './_slug-requires';
import { SU_ROLES } from '../../role-config';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel: the barrel re-exports through index.ts, an ESM circular-init that
// leaves runBulk/bulkContent undefined at runtime, AND the package-subpath
// self-reference fails the production build's `node` moduleResolution. The
// relative leaf resolves under both and dodges the cycle.
import { runBulk, bulkContent } from '../../_bulk';

// NB: 'tester' is not an AGENT_ROLES member and never was — the phantom
// entry gated nothing (audit P-047).

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.papercusp\//, '');
}

const LoadItem = z.object({
  slug: z.string().min(1).regex(SLUG_RE).optional(),
  rel_path: z.string().min(1),
});
type LoadItem = z.infer<typeof LoadItem>;

export default defineTool({
  name: 'artifacts:load',
  needsWorkspaceTx: true,
  description:
    'Read one OR many PG-canonical text artifacts (harness_text_artifacts) by (harness_slug, rel_path). Pass a single `{ slug?, rel_path }` or `items:[{ slug?, rel_path }]` for several. Returns { ok, results:[{ ok, slug, rel_path, found, content, updated_at | error }], counts } — correlate by (slug, rel_path), not by position; a missing / invalid-slug item fails only itself. LARGE artifact? Paginate: `offset` + `max_chars` slice each result\'s content (echoed back as content_total_chars / content_offset / content_truncated); ~4000-char pages ride under the model-facing result door, so a series of paged reads beats one clipped blob plus scratch-cursor paging.',
  capability: 'artifacts:read',
  guidance: {
    when: 'You need to read a file the harness wrote earlier (notes, intermediate outputs, plans) by its harness_slug + rel_path. Pass every (slug, rel_path) at once via `items`.',
    notWhen: 'For SOURCE CODE in the user\'s repo, use the filesystem tools / gitnexus. Artifacts are harness-scoped PG-canonical text only.',
    chaining: 'Pair with `artifacts:save` to round-trip, `artifacts:append` to add to an existing one. Bulk: single { slug?, rel_path } | items[] → { ok, results, counts }; correlate by (slug, rel_path) not position; one failure never fails the rest.',
  },
  requirePrincipal: false,
  // The frozen judge must be able to inspect acceptance evidence it is asked
  // to grade. Keep this grant local to the read-only tool: adding `judge` to
  // SU_ROLES would unintentionally widen every standard SU-tool allowlist.
  agentRoles: [...SU_ROLES, 'judge'],
  args: z
    .object({
      slug: z.string().min(1).regex(SLUG_RE).optional(),
      rel_path: z.string().min(1).optional(),
      items: z.array(LoadItem).min(1).max(100).optional().describe('artifact keys to read (1–100), each { slug?, rel_path }'),
      // EI-21471082146021784: deterministic paging for large artifacts. The
      // model-facing result door bounds every result, so a whole-artifact
      // read of a big body arrives clipped with only an opaque scratch
      // cursor; explicit slices let the caller page the REAL content through
      // this tool instead. Same convention as capability:read's byte pages.
      offset: z.number().int().min(0).optional().describe('char offset into each result\'s content (default 0)'),
      max_chars: z
        .number()
        .int()
        .min(1)
        .max(20_000)
        .optional()
        .describe('slice length per result (default: whole content; ~4000 stays under the result door)'),
    })
    .refine((a) => Boolean(a.items?.length) || Boolean(a.rel_path), {
      message: 'pass `rel_path` (one) or `items:[{ rel_path }]` (many)',
    }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires. The bulk
  // (`items`) path re-asserts per-item slug presence/validity in the handler.
  requires: slugRequires('artifacts:load'),
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    const items: LoadItem[] = args.items?.length ? args.items : [{ slug: args.slug, rel_path: args.rel_path! }];
    const env = await runBulk(
      items,
      async (item) => {
        const r = resolveSlug('artifacts:load', item.slug, ctx.harnessSlug);
        const key = normalizeRelPath(item.rel_path);
        if ('error' in r) {
          return { ok: false as const, slug: item.slug ?? null, rel_path: key, error: r.error };
        }
        const { slug } = r;
        // ctx.tx, NOT getOrgPg() — the workspace-scoped handle keeps reads
        // inside the caller's workspace via RLS (audit P-012, see save.ts).
        const rows = await tx<{ content: string; updated_at: string }[]>`
          SELECT content, updated_at
            FROM harness_shared.harness_text_artifacts
           WHERE harness_slug = ${slug} AND rel_path = ${key}
           LIMIT 1
        `;
        const found = rows.length > 0;
        const full = found ? rows[0].content : null;
        const totalChars = full ? full.length : 0;
        const offset = args.offset ?? 0;
        const slice =
          full !== null && args.max_chars != null
            ? full.slice(offset, Math.min(offset + args.max_chars, totalChars))
            : full;
        const truncated = slice !== null && args.max_chars != null && offset + args.max_chars < totalChars;
        return {
          ok: true as const,
          slug,
          rel_path: key,
          found,
          content: slice,
          updated_at: found ? Number(rows[0].updated_at) : null,
          ...(full !== null && args.max_chars != null
            ? { content_total_chars: totalChars, content_offset: offset, content_truncated: truncated }
            : {}),
        };
      },
      { keyOf: (item) => ({ slug: item.slug ?? null, rel_path: normalizeRelPath(item.rel_path) }) },
    );
    return bulkContent(env);
  },
});
