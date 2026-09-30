/**
 * List harnesses registered in the current workspace.
 *
 * Reads the **harness registry** (`harness_shared.harness_registry` — the
 * runtime store-of-record `harness:create` / the desktop "add project" route
 * write) merged with the org-level `harness_shared.projects` rows (status /
 * budget metadata, when a matching row exists). Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so registry harnesses — including every harness the Pot
 * creates via `harness:create` — were invisible to the operator's own
 * world-model. Registry entries report `source:'registry'`; org-project rows
 * with no registry entry are kept as `source:'project'` so the org view
 * doesn't disappear.
 *
 * Returns slug, status, and source for each. Use to answer "what harnesses
 * do I have?" or to find a slug before calling harness:get / harness:status.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { readRegistryProjects, type SqlLike } from './registry-read';

interface ProjectRow {
  slug: string;
  name: string | null;
  status: string | null;
  updated_ts: string | number | null;
}

export default defineTool({
  name: 'harness:list',
  needsWorkspaceTx: true,
  profile: 'engineer',
  capability: 'harness:read',
  guidance: {
    when: 'User asks "what harnesses do I have?", "show me my projects", or you need a slug to feed into harness:get / harness:status. Returns EVERY registered harness, hive/pot homes included — the registry stores no kind, so there is no includeHives-style filter and none is needed.',
    notWhen: 'For ONE specific harness, use `harness:get`. For a single harness\'s live health (active/done counts), use `harness:status`.',
    chaining: 'Pair with `harness:get` (detail) or `harness:status` (live counts) once you have the slug.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
    workspace: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Per-call workspace scope (superuser only). An unscoped superuser session (workspaceId "*") MUST pass this — the dispatch layer opens the workspace tx from it (EI-30). Scoped sessions ignore it (power-user callers have it clamped to their token workspace).',
      ),
  }),
  // Output schema (token-efficient-tool-result-formats P-013). Both modes are
  // flat scalar arrays → unlock CSV + MCP outputSchema advertisement. Declared
  // as the default `summary` shape; `full` adds more scalar columns the runtime
  // flatness check still serves as CSV.
  result: z.array(
    z.object({
      slug: z.string(),
      status: z.string().nullable(),
      source: z.enum(['registry', 'project']),
    }),
  ),
  async handler(args, ctx) {
    const tx = ctx.tx as SqlLike;
    const ws = ctx.principal?.workspaceId ?? '';
    const registry = await readRegistryProjects(tx, ws);
    const projectRows = (await tx`
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
       LIMIT 200
    `) as ProjectRow[];
    const projBySlug = new Map(projectRows.map((r) => [r.slug, r]));

    const limit = args.limit ?? 50;
    const rows = [
      // The registry is the authoritative harness set; org-project rows enrich.
      ...registry.map((r) => {
        const p = projBySlug.get(r.slug);
        return {
          slug: r.slug,
          name: p?.name ?? r.slug,
          status: p?.status ?? 'registered',
          updated_ts: p?.updated_ts ?? null,
          path: r.path ?? null,
          source: 'registry' as const,
        };
      }),
      // Org projects with no registry entry stay visible (the org/Pot view).
      ...projectRows
        .filter((p) => !registry.some((r) => r.slug === p.slug))
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          updated_ts: p.updated_ts,
          path: null,
          source: 'project' as const,
        })),
    ].slice(0, limit);

    if ((args.detail ?? 'summary') === 'summary') {
      return { data: rows.map((r) => ({ slug: r.slug, status: r.status, source: r.source })) };
    }
    return { data: rows };
  },
});
