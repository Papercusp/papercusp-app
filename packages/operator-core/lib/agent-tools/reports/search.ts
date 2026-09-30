/**
 * reports:search — full-text search across the Reports library (P-003; R-7).
 *
 * Ranking rides the STORED generated `search_tsv` column (migration 1166), which
 * weights title > summary/subject_label > body, so a report titled for your query
 * outranks one that merely mentions it in passing. Gated by the same `visibleTo`
 * fragment every other read path composes.
 *
 * This is the LEXICAL half. P-005 registers `report` as a source in the unified
 * search stack (semantic chunk embedding); this verb stays the direct, dependency-
 * free way to find a report by its words.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { searchReports } from '../../report-library';
import { resolveViewer, resolveWorkspaceId, toReportSummary, zReportKind, zReportWire } from './_shared';

export default defineTool({
  name: 'reports:search',
  description:
    'Full-text search the Reports library and get matches ranked by relevance — title matches outrank ' +
    'summary matches, which outrank body matches. Supports quoted "exact phrases", OR, and -negation. ' +
    'Returns the newest version per lineage, so a hit is never a superseded body. Bodies are omitted; use ' +
    'reports:get for one. Read-only, and gated by the same visibility rule as the rest of the library.',
  guidance: {
    when:
      'When you remember WHAT a report said but not its id or exact subject — "the postmortem about the ' +
      'green gate", "anything mentioning pgbouncer". Also to check whether someone already wrote up the ' +
      'thing you are about to write up.',
    notWhen:
      'When you can express it as a filter (kind / subject / pot / tag) — reports:list is exact and cheaper. ' +
      'When you have the id — reports:get.',
    chaining:
      'reports:search { query } → reports:get { id } (read the body) → reports:publish { supersedes: id }. ' +
      'Search BEFORE publishing a new audit on a subject that may already have one.',
    returns:
      '{ ok, count, query, hits:[{ rank, ...record }] } ranked best-first. Each hit is the record MINUS ' +
      '`bodyMd`, plus `path` and `bodyBytes`; `rank` is the ts_rank score (higher is better) — use it to ' +
      'tell a strong match from a passing mention. Zero hits means nothing VISIBLE TO YOU matched the ' +
      'parsed query; it is not evidence the report does not exist. A query of only stopwords parses to an ' +
      'empty tsquery and legitimately matches nothing — retry with a distinctive term before concluding.',
    seeAlso: ['reports:list (exact filters)', 'reports:get (read one)', 'search:semantic (across all corpora)'],
  },
  // A hit is the wire record with the ts_rank score spread on top; `query` echoes the
  // parsed input so a zero-hit result is distinguishable from a mis-sent one.
  result: z.object({
    ok: z.literal(true),
    query: z.string(),
    count: z.number().int().nonnegative(),
    hits: z.array(zReportWire.extend({ rank: z.number() })),
  }),
  capability: 'reports:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    query: z.string().min(2).max(500).describe('free text; quoted phrases, OR and -negation supported'),
    kind: zReportKind.optional(),
    include_retired: z.boolean().optional().describe('include soft-retired reports (default false)'),
    collapse_lineage: z
      .boolean()
      .optional()
      .describe('one hit per lineage, newest (default true); false searches every revision'),
    limit: z.number().int().min(1).max(200).optional().describe('default 50, max 200'),
  }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const hits = await searchReports(sql, {
      workspaceId: resolveWorkspaceId(ctx),
      viewer: resolveViewer(ctx),
      query: args.query,
      kind: args.kind,
      includeRetired: args.include_retired,
      collapseLineage: args.collapse_lineage,
      limit: args.limit,
    });
    return {
      data: {
        ok: true as const,
        query: args.query,
        count: hits.length,
        hits: hits.map((hit) => ({ rank: hit.rank, ...toReportSummary(hit.report) })),
      },
    };
  },
});
