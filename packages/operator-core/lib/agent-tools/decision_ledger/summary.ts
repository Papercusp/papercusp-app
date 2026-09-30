/**
 * decision_ledger:summary — a compressed roll-up of the Queen decision ledger
 * (queen-autonomy-policy-2026-06-13 B-13 / P-113): counts by layer / posture /
 * category / disposition over a time window, the cheap "what's the shape of recent
 * decisions?" read before drilling in with decision_ledger:list.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { summarizeDecisionLedger } from '../../decision-ledger/read';
import { getCompletionIntegrityStats } from '../../work-items';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'decision_ledger:summary',
  profile: 'engineer',
  description:
    "Roll-up of the decision ledger: total + counts by layer (action/disposition), posture (auto/proposed/gated/rejected), category, and disposition verb, over a time window. Optionally include harness-scoped completion integrity stats so progress reads can separate genuine completions from dedup churn. The cheap shape-read before decision_ledger:list. Read-only.",
  guidance: {
    when: "Getting oriented: 'how much is being auto-decided vs gated?', 'which categories see the most gated actions?', 'what's the disposition mix this week?'. Then decision_ledger:list for the rows.",
    notWhen: 'You want the actual rows — decision_ledger:list. Live ceilings — autonomy:policy_get.',
    chaining: 'decision_ledger:summary → decision_ledger:list { the posture/category that stands out }.',
    seeAlso: [
      'decision_ledger:list (the actual rows)',
      'autonomy:policy_get (live ceilings)',
      'work_items:completion_stats (the standalone completion-integrity read)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    layer: z.enum(['action', 'disposition']).optional(),
    sinceHours: z.number().positive().max(24 * 90).optional().describe('window (default: all retained rows)'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Optional harness slug for progress reporting. When provided, the result includes `completionStats` so genuine completions are separated from dedup/unverified terminal rows.',
      ),
    workspace: z.string().min(1).max(120).optional(),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const [summary, completionStats] = await Promise.all([
      summarizeDecisionLedger(workspaceId, {
        ...(args.layer ? { layer: args.layer } : {}),
        ...(args.sinceHours != null ? { sinceMs: Date.now() - args.sinceHours * 3_600_000 } : {}),
      }),
      args.harness ? getCompletionIntegrityStats(args.harness) : Promise.resolve(null),
    ]);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              workspaceId,
              summary,
              ...(completionStats ? { completionStats } : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
});
