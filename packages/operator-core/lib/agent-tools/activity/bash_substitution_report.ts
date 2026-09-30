/**
 * activity:bash-substitution-report — the bash→tool substitution metric as a
 * first-class read (plan `bash-to-tool-substitution-2026-07-26`, P-002).
 *
 * The repeatable form of the one-shot 2026-07-26 audit: Bash share of tool_use
 * blocks, per-intent bucket counts, each bucket's tool-counterpart usage, and
 * the result-token cost — plus the frozen 7d baseline per bucket, so the
 * before/after P-029 needs is one call rather than a re-run of a scratch script
 * against a corpus that has since rolled off.
 *
 * Thin by design: the canonical SQL, the pure summariser and the grader live in
 * `lib/bash-substitution/report.ts` (the dev:code_run_adoption shape), so the
 * numbers are unit-tested without Postgres and the SQL stays runnable by hand.
 */
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { getSubstitutionRows } from '../../bash-substitution/registry';
import { gradeSubstitution, readSubstitutionReport, type RunQuery } from '../../bash-substitution/report';

export default defineTool({
  name: 'activity:bash-substitution-report',
  profile: 'engineer',
  description:
    'Bash→tool substitution metric: Bash share of tool_use blocks, per-intent bucket counts with each ' +
    "bucket's tool-counterpart usage and frozen 7d baseline, and result-token cost. Last N days.",
  capability: 'intel:read',
  guidance: {
    when:
      'Checking whether bash usage is moving to its tool counterparts (the P-029 before/after), or ' +
      'grading how much registered shell intent a tool already serves. Returns the fleet numbers + a rating.',
    notWhen:
      'Whether ONE command has a tool form (locks:check_command); raw per-tool MCP call counts (dev:telemetry).',
    seeAlso: [
      'locks:check_command (does this specific command have a registered substitution)',
      'dev:code_run_adoption (the sibling batching-adoption metric)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  args: z.object({
    sinceDays: z.number().int().positive().max(90).optional().describe('Window in days (default 7).'),
  }),
  async handler(args) {
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    // The REGISTRY is tenant-scoped ('papercusp-workspace'); the ROLLUP is under
    // the 'default' corpus namespace. Two different ids on purpose — see
    // ROLLUP_CORPUS_WORKSPACE. Reading either with the other's id silently
    // returns nothing.
    const registry = await getSubstitutionRows(activeWorkspaceId());
    const report = await readSubstitutionReport(runQuery, registry, { sinceDays: args.sinceDays });
    const grade = gradeSubstitution(report);
    // { data } over hand-rolled inline JSON: the framework owns wire encoding (incl.
    // auto-TOON on the MCP transport). tool-data-shape-ratchet.test.ts counts the
    // legacy self-serialized content shape and is shrink-only. Do NOT spell that
    // shape's literal token in this file — the ratchet scans source, so a comment
    // quoting it self-matches and the migration reads as a no-op.
    return { data: { ok: true, ...report, grade } };
  },
});
