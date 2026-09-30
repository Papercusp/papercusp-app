/**
 * blender:attach-goal-evidence — append knowledge about a goal without any
 * authority to change the goal itself (P-003).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import type { PapercuspUnifiedToolContext } from '@papercusp/operator-core/lib/agent-tools/_tool-context';
import { SU_WRITE_ROLES } from '../../role-config';
import { appendGoalHistory } from './history';

export const goalEvidenceArgs = z
  .object({
    goalId: z.string().min(1),
    kind: z.enum(['evidence', 'finding']).default('evidence'),
    summary: z.string().trim().min(1).max(1000),
    detail: z.string().trim().min(1).max(12000).optional(),
    refs: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  })
  .strict();

export default defineTool({
  name: 'blender:attach-goal-evidence',
  needsWorkspaceTx: true,
  description:
    'Append evidence or a finding ABOUT an existing goal. This is structurally zero-authority: it writes only an append-only goal:evidence audit row and cannot change the goal title, outcome, criterion, budget, status, tripwires, or launch settings. The entry is returned by goals:get { id, detail:"full" } under history.',
  capability: 'goals:write',
  guidance: {
    when:
      'The Blender learned a fact, measurement, risk, or finding that changes what is KNOWN about a goal but not what the goal IS. Attach the concise summary, optional supporting detail, and durable refs.',
    notWhen:
      'Changing goal intent/state — use goals:update, which records a before/after amendment automatically. Filing a product idea — use improvements:capture or blender:route-idea.',
    chaining:
      'blender:attach-goal-evidence → goals:get { id:goalId, detail:"full" } to verify the append-only entry is readable from the goal.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_WRITE_ROLES, 'blender'],
  args: goalEvidenceArgs,
  async handler(args, ctx: PapercuspUnifiedToolContext) {
    const tx = ctx.tx!;
    const rows = await tx<Array<{ workspace_id: string }>>`
      SELECT workspace_id FROM harness_shared.goals WHERE id = ${args.goalId} LIMIT 1
    `;
    if (!rows.length) {
      return { data: null, degraded: true, degradedReasons: [`goal ${args.goalId} not found`] };
    }
    const author = ctx.uiClientId ?? ctx.principal?.slug ?? ctx.role ?? 'unknown';
    const entry = await appendGoalHistory(tx, {
      workspaceId: rows[0]!.workspace_id,
      goalId: args.goalId,
      author,
      detail: {
        kind: args.kind,
        summary: args.summary,
        ...(args.detail ? { detail: args.detail } : {}),
        ...(args.refs?.length ? { refs: args.refs } : {}),
      },
    });
    return { data: entry };
  },
});
