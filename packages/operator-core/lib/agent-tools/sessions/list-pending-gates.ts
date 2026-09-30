/**
 * sessions:list-pending-gates — the blocked-sessions surface (P-002): reads
 * harness_shared.session_pending_gates, fed by both `sessions:ingest-gate-event`
 * (hook push) and the transcript watcher (gate-watch.ts, client-agnostic
 * pull). This is the read side the future plans/attention.ts adapter (P-005
 * lane) wraps into the unified inbox feed — a pure, standalone read so P-005
 * can build that adapter without touching this file.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { listPendingGates } from '../../attention/gate-store';

export default defineTool({
  name: 'sessions:list-pending-gates',
  profile: 'engineer',
  description:
    'List sessions currently blocked waiting on the human owner (an unanswered AskUserQuestion/ExitPlanMode, a permission-wait, or a hook-mirrored ask) — oldest-blocking-first by default. The blocked-sessions surface backing the unified owner Inbox.',
  capability: 'search:read',
  guidance: {
    when: 'Checking which sessions are stuck waiting on a human answer, or building an attention adapter over the gate store.',
    notWhen: 'To open/close a gate — use sessions:ingest-gate-event or the transcript watcher.',
    seeAlso: ['sessions:ingest-gate-event'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sessionId: z.string().max(256).optional(),
    includeClosed: z.boolean().optional(),
    order: z.enum(['oldest', 'newest']).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? activeWorkspaceId();
    const rows = await listPendingGates({
      workspaceId,
      sessionId: args.sessionId,
      includeClosed: args.includeClosed,
      order: args.order,
      limit: args.limit,
    });
    return {
      data: {
        ok: true,
        count: rows.length,
        gates: rows.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          client: r.client,
          kind: r.kind,
          question: r.question,
          options: r.options,
          ownerId: r.owner_id,
          source: r.source,
          openedAt: r.opened_at,
          closedAt: r.closed_at,
          closedReason: r.closed_reason,
        })),
      },
    };
  },
});
