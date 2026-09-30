/**
 * change_ledger:calendar — the D-003 mutation-calendar ADVISORY view
 * (self-learning-frontier P-004 / FB-02): which mutation classes have live
 * activity, and whether more than one AUTOMATED class (gym, ablation, future
 * probation windows) is live at once. Surfaced, never enforced.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readRecentChanges } from '../../change-ledger/change-ledger';
import { computeMutationCalendar, DEFAULT_LIVE_WINDOW_MS } from '../../change-ledger/mutation-calendar';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'change_ledger:calendar',
  profile: 'engineer',
  description:
    'The mutation-calendar advisory over the behavior-change ledger: per mutation class (gym, manual-prompt, repo-prompt, ablation) the activity count, first/last timestamps, and liveness inside the window — plus the D-003 overlap advisory when more than one AUTOMATED class is live ("one live mutation class at a time" is policy, not enforcement).',
  guidance: {
    when: 'Before starting/scheduling a prompt-layer mutator (gym autoloop bring-up, an ablation run) — is another mutation class already live? Also the EKG\'s "what could explain this shift window" first read.',
    notWhen: 'You want the individual mutation rows — change_ledger:list.',
    chaining: 'change_ledger:calendar → on overlap, serialize with the other class\'s owner → change_ledger:list { mutationClass } for the specific rows.',
    seeAlso: [
      'change_ledger:list (the individual mutation rows)',
    ],
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    liveWindowDays: z.number().positive().max(90).optional().describe('liveness window in days (default 7)'),
    workspace: z.string().min(1).max(120).optional().describe('workspace to inspect (default: the session/active workspace)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, ctx.workspaceId, ctx.principal?.workspaceId);
    const liveWindowMs = args.liveWindowDays != null ? args.liveWindowDays * 86_400_000 : DEFAULT_LIVE_WINDOW_MS;
    // Read window = 4× the liveness window so first/last per class carry real
    // history context, bounded by the read cap.
    const rows = await readRecentChanges(workspaceId, {
      limit: 1000,
      sinceMs: Date.now() - liveWindowMs * 4,
    });
    const calendar = computeMutationCalendar(rows, { nowMs: Date.now(), liveWindowMs });
    return { data: { workspaceId, rowsConsidered: rows.length, ...calendar } };
  },
});
