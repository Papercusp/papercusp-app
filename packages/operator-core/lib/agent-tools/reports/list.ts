/**
 * reports:list — browse the Reports library (P-003; satisfies R-2, R-3, R-7).
 *
 * Returns the newest entry PER LINEAGE by default, so a report corrected three
 * times occupies one library row rather than three (R-3). Bodies are omitted — a
 * body may be 512KB and a list of them is not browsable; `reports:get` fetches one.
 *
 * The three axes filter INDEPENDENTLY (R-2), which is the whole reason they are
 * separate columns: `origin_harness_slug` asks where it was WRITTEN, `subject` asks
 * what it is ABOUT, and visibility is applied to every read as the gate.
 *
 * Server-only.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { listReports } from '../../report-library';
import {
  resolveViewer,
  resolveWorkspaceId,
  toReportSummary,
  zReportKind,
  zReportSubjectKind,
  zReportWire,
} from './_shared';

export default defineTool({
  name: 'reports:list',
  description:
    'Browse the Reports library — newest first, one entry per lineage (a corrected report collapses to ' +
    'its latest version, history reachable via reports:get { lineage:true }). Bodies are OMITTED; use ' +
    'reports:get for one. Filter independently by `kind`, by `subject` (what it is ABOUT), by ' +
    '`origin_harness_slug` (which pot WROTE it), and by `tags`. Retired reports are hidden unless you ask. ' +
    'Read-only; you see workspace-visible reports, your own pot\'s, and everything you authored.',
  guidance: {
    when:
      'To see what reports exist — for a subject, of a kind, or from a pot — before writing a new one, or ' +
      'to find the id of one you want to read or supersede.',
    notWhen:
      'When you have a text query rather than a filter — reports:search ranks by relevance. When you ' +
      'already have the id — reports:get.',
    chaining:
      'reports:list → reports:get { id } (read the body) → reports:publish { supersedes: id } (correct it). ' +
      'Checking for a prior report on your subject before publishing avoids a duplicate lineage.',
    returns:
      '{ ok, count, reports:[…] } newest-first. Each entry is the full record MINUS `bodyMd`, plus `path` ' +
      '(owner deep link) and `bodyBytes` (so you can tell a stub from a 400KB audit before fetching it). ' +
      '`collapse_lineage:false` returns every revision as its own row instead of the latest per lineage. ' +
      'An empty list means nothing matched THE FILTERS AND THE VISIBILITY GATE — it is not evidence that ' +
      'no such report exists, only that none is visible to you.',
    seeAlso: ['reports:search (rank by relevance)', 'reports:get (read one)', 'reports:publish (add one)'],
  },
  // Rows are the wire record (body omitted by construction — `toReportSummary` IS
  // `toReportWire`, which never carries `bodyMd`).
  result: z.object({
    ok: z.literal(true),
    count: z.number().int().nonnegative(),
    reports: z.array(zReportWire),
  }),
  capability: 'reports:read',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    kind: zReportKind.optional(),
    subject: z
      .object({ kind: zReportSubjectKind, ref: z.string().min(1).optional() })
      .optional()
      .describe('filter by what the reports are ABOUT'),
    origin_harness_slug: z.string().min(1).optional().describe('filter by the pot a report was WRITTEN in'),
    tags: z.array(z.string().min(1)).max(20).optional().describe('rows must carry ALL of these tags'),
    include_retired: z.boolean().optional().describe('include soft-retired reports (default false)'),
    collapse_lineage: z
      .boolean()
      .optional()
      .describe('one row per lineage, newest (default true); false returns every revision'),
    limit: z.number().int().min(1).max(200).optional().describe('default 50, max 200'),
  }),
  async handler(args, ctx) {
    const sql = getOrgPg().sql;
    const reports = await listReports(sql, {
      workspaceId: resolveWorkspaceId(ctx),
      viewer: resolveViewer(ctx),
      kind: args.kind,
      subject: args.subject,
      originHarnessSlug: args.origin_harness_slug,
      tags: args.tags,
      includeRetired: args.include_retired,
      collapseLineage: args.collapse_lineage,
      limit: args.limit,
    });
    return { data: { ok: true as const, count: reports.length, reports: reports.map(toReportSummary) } };
  },
});
