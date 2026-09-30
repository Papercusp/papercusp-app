/**
 * `papercusp://harness/{slug}/issues` — per-harness issue list.
 *
 * Templated resource. The `list` callback expands the template against
 * the workspace's harness inventory, so `resources/list` returns one
 * entry per active harness. This is the cross-harness consolidation
 * that the `issues:list` tool degraded out of.
 */

import { defineResource } from '@papercusp/tooldef';
import { matchResource } from '@papercusp/tooldef';
import type { ResourceContents, ResourceListEntry } from '@papercusp/tooldef';
import type { PapercuspToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';

export default defineResource({
  name: 'harness:issues',
  uri: 'papercusp://harness/{slug}/issues',
  capability: 'issues:read',
  mimeType: 'application/json',
  description:
    'Validator-filed issues for a specific harness. Reads the harness_<slug>.issues table.',

  async list(ctx: PapercuspToolContext): Promise<ResourceListEntry[]> {
    const tx = ctx.tx!;
    const rows: Array<{ slug: string; name: string }> = await tx`
      SELECT slug, name FROM harness_shared.projects ORDER BY slug
    `;
    return rows.map((r) => ({
      uri: `papercusp://harness/${r.slug}/issues`,
      name: `${r.slug} issues`,
      description: `Issues filed against tasks in harness "${r.name}".`,
      mimeType: 'application/json',
    }));
  },

  async read(uri, ctx: PapercuspToolContext): Promise<ResourceContents> {
    const tx = ctx.tx!;
    const matched = matchResource(uri);
    const slug = matched?.vars.slug;
    if (!slug) {
      throw new Error(`Invalid harness/issues URI: ${uri}`);
    }
    // Per-harness schema: `harness_<slug>.issues`. Use a parameterized
    // identifier — postgres-js's tagged identifier is the safe path.
    const schema = `harness_${slug.replace(/[^a-z0-9_]/gi, '_')}`;
    let rows: Array<Record<string, unknown>> = [];
    let degraded = false;
    let degradedReason: string | undefined;
    try {
      rows = await tx<Array<Record<string, unknown>>>`
        SELECT id, task_id, filed_by, severity, body, created_at
          FROM ${tx(schema)}.issues
         ORDER BY created_at DESC
         LIMIT 200
      `;
    } catch (err) {
      degraded = true;
      degradedReason =
        err instanceof Error ? err.message : 'unknown error reading issues';
    }
    return {
      uri,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          slug,
          issues: rows,
          ...(degraded ? { degraded: true, degradedReason } : {}),
        },
        null,
        2,
      ),
    };
  },
});
