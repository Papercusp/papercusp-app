/**
 * dev:orient_dedup_rate — the coord:orient redundant-recall rate as a
 * first-class read (WI-839, sibling of dev:code_run_adoption).
 *
 * Of the spawns that called coord:orient, how many ALSO re-called a tool
 * orient's bootstrap already subsumes (coord:plan-events / memory:search /
 * coord:inbox / coord:declare-intent)? measuring-code-run-adoption.mdx metric
 * #3 — the "bigger leak" than code:run itself. A fleet rollup + a graded
 * rating, so a regression surfaces in one call instead of a manual audit.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { readOrientDedupRate, gradeOrientDedupRate, type RunQuery } from '../../orient-dedup-rate';

export default defineTool({
  name: 'dev:orient_dedup_rate',
  profile: 'engineer',
  description:
    'coord:orient redundant-recall rate: of spawns that called coord:orient, how many ALSO re-called a tool ' +
    'orient already subsumed (plan-events/memory:search/inbox/declare-intent) — a fleet rollup + graded rating.',
  capability: 'intel:read',
  guidance: {
    when: 'Checking whether the orient-dedup guidance is landing (pctRedundant should trend down from the ~100% baseline).',
    notWhen: 'Raw per-tool call counts (dev:telemetry); which tools co-occur in a spawn (dev:tool_cooccurrence).',
    seeAlso: ['dev:code_run_adoption (code:run adoption metrics)', 'dev:tool_cooccurrence (co-occurrence detail)'],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    sinceHours: z.number().int().positive().max(24 * 30).optional().describe('Window in hours (default 24).'),
  }),
  async handler(args) {
    const sinceHours = args.sinceHours ?? 24;
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const rollup = await readOrientDedupRate(runQuery, { sinceHours });
    const grade = gradeOrientDedupRate(rollup);
    return { data: { ok: true, sinceHours, rollup, grade } };
  },
});
