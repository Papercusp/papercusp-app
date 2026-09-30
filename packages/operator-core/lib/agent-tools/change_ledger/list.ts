/**
 * change_ledger:list — recent behavior-affecting changes (prompt/rule
 * mutations) from harness_shared.behavior_change_ledger (migration 242,
 * self-learning-frontier P-004 / FB-02). Read-only; the write side is the
 * hooks in lib/change-ledger/change-ledger.ts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readRecentChanges } from '../../change-ledger/change-ledger';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'change_ledger:list',
  profile: 'engineer',
  description:
    'List recent behavior-affecting changes — every ledgered prompt/rule mutation (gym champion commits, prompt-override API edits, repo playbook/persona file edits, ablations) newest first, with source, mutation class, target, diff ref, and actor. Read-only over harness_shared.behavior_change_ledger.',
  guidance: {
    when: 'Attributing a behavior shift: "what changed in the prompt layer recently?" — after a fleet anomaly, before/after a gym promotion, or when auditing who mutated which role prompt and when.',
    notWhen: 'You want the overlap advisory / per-class liveness rollup — change_ledger:calendar. You want prompt CONTENT — read the prompt source or harness_prompt_overrides.',
    chaining: 'change_ledger:calendar (which classes are live) → change_ledger:list { mutationClass } for the rows → the diff_ref (gym proposal id / git sha) for the change content.',
    seeAlso: [
      'change_ledger:calendar (per-class liveness / overlap advisory)',
      'decision_ledger:list (auto-decide vs gate rows)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    limit: z.number().int().positive().max(500).optional().describe('max rows (default 50)'),
    mutationClass: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("filter to one class: 'gym' | 'manual-prompt' | 'repo-prompt' | 'ablation'"),
    sinceHours: z.number().positive().max(24 * 90).optional().describe('only rows recorded in the trailing N hours'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const rows = await readRecentChanges(workspaceId, {
      limit: args.limit ?? 50,
      mutationClass: args.mutationClass,
      sinceMs: args.sinceHours != null ? Date.now() - args.sinceHours * 3_600_000 : undefined,
    });
    return { data: { workspaceId, count: rows.length, changes: rows } };
  },
});
