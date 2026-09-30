/**
 * dev:limit_failure_rate — the tool-arg limit-rejection failure rate as a
 * first-class read (WI-839, sibling of dev:code_run_adoption).
 *
 * Of the recent tool-invocation failures, how many were caused by an
 * advisory-field / string-length cap being hit (a tool arg rejected as "too
 * long" instead of truncated)? Per-tool breakdown + a fleet total + a graded
 * rating, so a regression (a new tool shipping a tight cap, or a fix
 * regressing) surfaces in one call instead of a manual dev:pg_query.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readLimitFailureRate, gradeLimitFailureRate, type RunQuery } from '../../limit-failure-rate';

export default defineTool({
  name: 'dev:limit_failure_rate',
  profile: 'engineer',
  description:
    'Tool-arg limit-rejection failure rate: too-long-string validation failures by tool over the last N days ' +
    '(measuring-code-run-adoption.mdx metric #1) — a fleet total, per-tool breakdown, and a graded rating.',
  capability: 'intel:read',
  guidance: {
    when:
      'Checking whether a string/advisory-field cap fix landed (should trend toward 0), or which tool is currently ' +
      'rejecting long args most often.',
    notWhen: 'Raw per-tool call counts (dev:telemetry); code:run adoption (dev:code_run_adoption).',
    seeAlso: ['dev:code_run_adoption (code:run adoption metrics)', 'dev:orient_dedup_rate (orient re-call redundancy)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    sinceDays: z.number().int().positive().max(90).optional().describe('Window in days (default 14).'),
  }),
  async handler(args) {
    const sinceDays = args.sinceDays ?? 14;
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const rollup = await readLimitFailureRate(runQuery, { sinceDays });
    const grade = gradeLimitFailureRate(rollup);
    return { data: { ok: true, sinceDays, rollup, grade } };
  },
});
