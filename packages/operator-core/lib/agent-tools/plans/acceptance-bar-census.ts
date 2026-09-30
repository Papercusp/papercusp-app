/** plans:acceptance-bar-census — P-009's versioned BAR coverage report. */
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { resolvePlanWriteScope } from './_write-scope';
import { runAcceptanceBarCensus } from '../../acceptance-bar-census';

const argsSchema = z.object({
  harness: harnessArg,
  residualLimit: z.number().int().positive().max(10_000).optional().describe('Maximum residual plans returned (default 10,000).'),
});

export default defineTool({
  name: 'plans:acceptance-bar-census',
  description:
    'Run the versioned, rerunnable P-009 acceptance BAR census. It reports Requirements-heading adoption separately from BAR-contract coverage, names explicit exclusions/cohorts, and returns every residual plan with a repair reason. The query and parameters are included for reproduction.',
  guidance: {
    when: 'After the acceptance BAR migration reaches the queried database, to publish the measured adoption baseline and post-epoch executable coverage denominator.',
    notWhen: 'To seed or repair a plan. Use plans:migrate-acceptance-bars for writes; this door is read-only.',
    chaining: 'plans:acceptance-bar-census → plans:get / plans:migrate-acceptance-bars for named residuals; rerun with identical parameters to compare measuredAt reports.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const { workspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const report = await withWorkspace(workspaceId, (tx) =>
      runAcceptanceBarCensus(tx as unknown as Parameters<typeof runAcceptanceBarCensus>[0], {
        workspaceId,
        harnessSlug,
        residualLimit: args.residualLimit,
      }),
    );
    return { data: report };
  },
});
