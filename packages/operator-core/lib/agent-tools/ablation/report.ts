/**
 * ablation:report — the prompt-sedimentology dead-weight report
 * (self-learning-frontier P-023 / FB-09): per-rule standings aggregated from
 * harness_shared.prompt_ablation_runs (migration 249), candidates first, plus
 * the recent cycle rows. Read-only; the write side is the weekly
 * `system:prompt-ablation` shadow cycle (lib/ablation/runner.ts) — and any
 * actual rule removal stays a normal reviewed edit riding the change ledger +
 * release gate, never an automated act of this surface.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { buildDeadWeightReport } from '../../ablation/scoring';
import { listAblationRuns } from '../../ablation/store';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'ablation:report',
  profile: 'engineer',
  description:
    'Prompt-sedimentology dead-weight report: per-SU-playbook-rule shadow-ablation standings (dead-weight-candidate / load-bearing / insufficient-evidence) aggregated across weekly cycles, candidates first, plus recent cycle rows (verdict, pass-rate delta, regressions, cost). Read-only over harness_shared.prompt_ablation_runs.',
  guidance: {
    when: 'Reviewing which SU-playbook governance rules earn their tokens: "which rules survived repeated ablation with zero behavioral delta?" — the owner review queue for prompt slimming, or checking what last week\'s shadow cycle measured.',
    notWhen: 'You want prompt MUTATION history (who changed what) — change_ledger:list. You want to RUN an ablation — the system:prompt-ablation routine (dark until the frontier P-001 arming gate).',
    chaining: 'ablation:report → for a candidate rule, read its ruleKey rows ({ ruleKey }) for the per-scenario evidence → an actual removal is a normal reviewed playbook edit (rides the change ledger + the su llm-test suite).',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ruleKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('drill into one rule: returns its full cycle rows instead of the rollup'),
    minRuns: z
      .number()
      .int()
      .positive()
      .max(20)
      .optional()
      .describe('conclusive cycles on one wording required for dead-weight-candidate (default 2)'),
    limit: z.number().int().positive().max(500).optional().describe('max recent cycle rows (default 20)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const { sql } = getOrgPg();
    if (args.ruleKey) {
      const rows = await listAblationRuns(sql, workspaceId, { ruleKey: args.ruleKey, limit: args.limit ?? 20 });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ workspaceId, ruleKey: args.ruleKey, count: rows.length, runs: rows }, null, 2) },
        ],
      };
    }
    // The rollup reads the full history (one row per weekly cycle — small).
    const history = await listAblationRuns(sql, workspaceId, { limit: 1000 });
    const report = buildDeadWeightReport(
      history.map((r) => ({
        ruleKey: r.ruleKey,
        ruleHash: r.ruleHash,
        ruleExcerpt: r.ruleExcerpt,
        verdict: r.verdict,
        passRateDelta: r.passRateDelta,
        finishedAt: r.finishedAt,
        capped: r.capped,
      })),
      { minRuns: args.minRuns ?? 2 },
    );
    const recent = history.slice(0, args.limit ?? 20).map((r) => ({
      id: r.id,
      finishedAt: r.finishedAt,
      ruleKey: r.ruleKey,
      verdict: r.verdict,
      passRateDelta: r.passRateDelta,
      scenarioCount: r.scenarioCount,
      capped: r.capped,
      costUsd: r.costUsd,
      replayLeg: r.replayLeg != null,
    }));
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { workspaceId, totalCycles: history.length, deadWeight: report, recentCycles: recent },
            null,
            2,
          ),
        },
      ],
    };
  },
});
