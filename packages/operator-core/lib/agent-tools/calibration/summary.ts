/**
 * calibration:summary — per-persona per-domain calibration (Brier scores +
 * trust weights) from harness_shared.calibration_predictions (migration 253,
 * self-learning-frontier P-041 / FB-13). Read-only; the write side is the
 * capture seams (improvements:resolve confidence, plans:start, flake filings)
 * and the system:calibration-resolve maturity sweep.
 *
 * THE Queen-weighting read (D-005): when the Queen weighs an agent's claimed
 * confidence — a "fixed" resolution, a ship estimate — this is where the
 * persona's earned trust lives. Weights only ever re-weigh attention;
 * explicit owner grades stay sovereign.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { calibrationScores, openBetCounts } from '../../calibration/store';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'calibration:summary',
  profile: 'engineer',
  description:
    'Per-persona per-domain calibration from recorded bets: Brier score, base rate, sample size, and the shrunk trust weight (0.5 = unknown, →1 proven-sharp, →0 proven-noisy) — plus the open-bet rollup. Read-only over harness_shared.calibration_predictions.',
  guidance: {
    when: "Weighing how much to trust a persona's stated confidence — before acting on a 'fixed, 0.9 sure' claim, when triaging items whose ranker breakdown shows a calibration contribution, or when reviewing whose bets are sharp vs noise.",
    notWhen:
      'You want the queue order itself — improvements:digest (the ranker already folds calibration in as a feature). You want raw bet rows — they are deliberately not exposed; the scores are the consumption surface.',
    chaining:
      "improvements:digest (rank.features shows a 'calibration' contribution) → calibration:summary { predictor } for that bettor's record → weigh their claim accordingly.",
    seeAlso: [
      'improvements:digest (the rank breakdown that surfaces a calibration contribution)',
      'improvements:triage (weigh a bettor\'s claim when triaging)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    domain: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("filter to one domain: 'fix-survival' | 'plan-ship' | 'flake-recurrence'"),
    predictor: z.string().min(1).max(120).optional().describe('filter to one persona (ownerId)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    const [scores, openBets] = await Promise.all([
      calibrationScores(sql, { workspaceId, domain: args.domain, predictor: args.predictor }),
      openBetCounts(sql, { workspaceId }),
    ]);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ workspaceId, scored: scores.length, scores, openBets }, null, 2),
        },
      ],
    };
  },
});
