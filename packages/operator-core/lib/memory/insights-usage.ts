/**
 * insights-usage.ts — which agent-insight runbooks actually get READ
 * (learning-system-audit-improvements-2026-06-09 P-051).
 *
 * Zero new instrumentation: `harness_shared.tool_invocations` already records
 * every `docs:get`/`docs:search` call with `args_json`, so usage is a pure
 * rollup over existing telemetry. High-use insights are promotion candidates
 * (prompt-base), zero-use ones are retirement candidates — the staleness
 * collector (insight-staleness.ts) covers the "cites dead code" axis; this
 * covers the "nobody reads it" axis.
 *
 * Pure rollup + thin PG glue (the usual seam split).
 */

import { getOrgPg } from '@papercusp/db-org';

export interface InsightUsageRow {
  slug: string;
  reads: number;
  lastReadAt: string | null;
}

interface InvocationLike {
  argsJson: unknown;
  invokedAt: string | null;
}

/** Extract agent-insights slugs from a docs:get-style args object. */
export function insightSlugsOf(argsJson: unknown): string[] {
  if (!argsJson || typeof argsJson !== 'object') return [];
  const slugs = (argsJson as { slugs?: unknown }).slugs;
  if (!Array.isArray(slugs)) return [];
  return slugs
    .filter((s): s is string => typeof s === 'string')
    .filter((s) => s.startsWith('agent-insights/'))
    .map((s) => s.slice('agent-insights/'.length).replace(/\.mdx?$/, ''));
}

/** Pure rollup: per-insight read counts + most recent read. */
export function rollupInsightUsage(rows: InvocationLike[]): InsightUsageRow[] {
  const bySlug = new Map<string, { reads: number; lastReadAt: string | null }>();
  for (const row of rows) {
    for (const slug of insightSlugsOf(row.argsJson)) {
      const cur = bySlug.get(slug) ?? { reads: 0, lastReadAt: null };
      cur.reads += 1;
      if (row.invokedAt && (!cur.lastReadAt || row.invokedAt > cur.lastReadAt)) {
        cur.lastReadAt = row.invokedAt;
      }
      bySlug.set(slug, cur);
    }
  }
  return [...bySlug.entries()]
    .map(([slug, v]) => ({ slug, ...v }))
    .sort((a, b) => b.reads - a.reads || a.slug.localeCompare(b.slug));
}

/** PG glue: docs:get invocations touching agent-insights in the trailing window. */
export async function readInsightUsage(days = 30): Promise<InsightUsageRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{ args_json: unknown; invoked_at: string | null }[]>`
    SELECT args_json, invoked_at::text AS invoked_at
      FROM harness_shared.tool_invocations
     WHERE tool_name = 'docs:get'
       AND invoked_at > now() - make_interval(days => ${days})
       AND args_json::text LIKE '%agent-insights%'
     LIMIT 5000`;
  return rollupInsightUsage(rows.map((r) => ({ argsJson: r.args_json, invokedAt: r.invoked_at })));
}
