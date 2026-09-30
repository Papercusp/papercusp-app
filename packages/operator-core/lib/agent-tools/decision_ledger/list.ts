/**
 * decision_ledger:list — the Queen decision ledger, newest first
 * (queen-autonomy-policy-2026-06-13 B-13 / P-113). One queryable view over BOTH
 * capture layers: the action-chokepoint rows (every governed action that ran,
 * B-06/P-110) and the decider-disposition rows (the Queen's per-item choices,
 * P-111). Filterable by layer / category / posture / disposition / time. Read-only
 * over harness_shared.decision_ledger.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readDecisionLedger } from '../../decision-ledger/read';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'decision_ledger:list',
  profile: 'engineer',
  description:
    "The decision ledger newest-first: governed actions (layer=action — what ran, with posture auto/gated/rejected) and the deciding agent's per-item dispositions (layer=disposition — act/defer/reject/route-to-research/no-op + why). Filter by layer/category/posture/disposition/time. Each row carries the autonomy axes (category, risk_tier, reversibility, authority) + provenance links. Read-only.",
  guidance: {
    when: "Auditing what has been decided / what the fleet has done: 'what auto-decisions happened?', 'show the gated actions in spend-budget', 'what did it defer?'. Pair with autonomy:policy_get to see why a category gates.",
    notWhen:
      'A roll-up of counts by posture/category — decision_ledger:summary. Prompt/rule mutations specifically — change_ledger:list. The live policy ceilings — autonomy:policy_get.',
    chaining:
      'decision_ledger:summary (the shape) → decision_ledger:list { layer, category, posture } for the rows → a row.links (runId/spawnId/itemRef) to drill to the transcript / item.',
    seeAlso: [
      'decision_ledger:summary (the roll-up shape)',
      'autonomy:policy_get (the live policy ceilings)',
      'change_ledger:list (prompt / rule mutations specifically)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    layer: z.enum(['action', 'disposition']).optional().describe('action (governed actions) | disposition (decider choices)'),
    category: z.string().min(1).max(60).optional().describe('one autonomy category (e.g. spend-budget, plan-governance)'),
    posture: z
      .enum(['auto', 'proposed', 'gated', 'rejected'])
      .optional()
      .describe('auto | proposed | gated | rejected'),
    disposition: z
      .enum(['act', 'defer', 'reject', 'route-to-research', 'no-op'])
      .optional()
      .describe('disposition-layer verb'),
    sinceHours: z.number().positive().max(24 * 90).optional().describe('only rows in the trailing N hours'),
    limit: z.number().int().positive().max(500).optional().describe('max rows (default 50)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const entries = await readDecisionLedger(workspaceId, {
      ...(args.layer ? { layer: args.layer } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.posture ? { posture: args.posture } : {}),
      ...(args.disposition ? { disposition: args.disposition } : {}),
      ...(args.sinceHours != null ? { sinceMs: Date.now() - args.sinceHours * 3_600_000 } : {}),
      limit: args.limit ?? 50,
    });
    return {
      content: [
        { type: 'text', text: JSON.stringify({ workspaceId, count: entries.length, entries }, null, 2) },
      ],
    };
  },
});
