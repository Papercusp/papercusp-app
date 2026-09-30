/**
 * experiment:results — read recorded experiment runs from the ledger
 * (`experiment-registry-invocation-api` P-050). Closes the loop: experiment:run
 * writes the run-level summary to experiment_runs; this reads it back (the
 * programmatic scoreboard the Learning-tab UI will also render).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { PgExperimentLedger } from '../../experiment/ledger';

export default defineTool({
  name: 'experiment:results',
  description:
    'List recent experiment runs (the experiment_runs ledger) for this workspace — battery, test, tier, winner, per-arm scores, total cost, and decision (proposed|applied|rejected). Read-only; newest-first; filter by testId. Closes the loop with experiment:run (which records here).',
  guidance: {
    when: 'Reviewing how past experiments performed — which arms won, at what cost, and whether they were applied. Filter by testId to a single test kind.',
    notWhen: 'Running a new experiment (experiment:run). Discovering test kinds (experiment:catalog).',
    chaining: 'experiment:run → experiment:results (read back the recorded outcomes).',
    seeAlso: [
      'experiment:run (run a new experiment)',
      'experiment:catalog (discover test kinds)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  // Overwatch excluded too (overwatch-role-2026-06-15): not an experiment surface, and it
  // carries harness:read — so the allowlist is what keeps this off its surface.
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    testId: z.string().optional().describe('Filter to one test id (e.g. "replay").'),
    limit: z.number().int().positive().max(200).optional().describe('Max rows (default 20).'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { getOrgPg } = await import('@papercusp/db-org');
    const runs = await new PgExperimentLedger(getOrgPg().sql).listRecent(workspaceId, {
      testId: args.testId,
      limit: args.limit,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: runs.length, runs }) }] };
  },
});
