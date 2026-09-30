/**
 * sessions:ingest-gate-event — the push half of the client-agnostic owner-gate
 * tracker (owner-inbox-single-pane-2026-07-17 P-002; store: gate-store.ts,
 * table: migration 619 session_pending_gates).
 *
 * Called by the per-CLI hook layer (P-001's Claude Stop/PreToolUse/Notification
 * hooks; P-004's OMP turn_end port) — same "thin ping, server does the work"
 * shape as `journal:record-turn`. The CALLER generates a correlation `refId`
 * (a uuid) for a fresh 'ask'/'permission_wait' and repeats the SAME refId on
 * the matching 'cleared' event; the transcript watcher (gate-watch.ts) instead
 * uses the transcript's own tool_use id as refId — both producers upsert the
 * same table, keyed on (workspace, session, refId), so whichever sees a given
 * ask first "wins" the open and the other is a harmless idempotent touch.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { activeWorkspaceId } from '../../workspace-registry';
import { closeGate, openOrTouchGate } from '../../attention/gate-store';

const optionSpec = z.object({
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
});

export default defineTool({
  name: 'sessions:ingest-gate-event',
  profile: 'engineer',
  description:
    "Ingest one owner-gate event from a per-CLI hook: 'ask' or 'permission_wait' OPENS a pending gate (the session is blocked waiting on the human owner); 'cleared' closes it. Correlate the open+close pair with the SAME `refId` (you generate it — a uuid is fine). Upserts harness_shared.session_pending_gates, the client-agnostic blocked-sessions store the attention system reads (sessions:list-pending-gates) and the transcript watcher (gate-watch.ts) also feeds.",
  capability: 'activity:report',
  guidance: {
    when:
      'From a turn-end / pre-tool-use / notification hook the moment it observes a structured ask (AskUserQuestion/ExitPlanMode mirror), a permission-wait, or that ask being answered. Almost never called by hand.',
    notWhen:
      'To READ pending gates use `sessions:list-pending-gates`. For a genuine owner-facing escalation card, `coord:escalate` remains the preferred ask (D-001) — this tool is the blocked-SESSION signal, not the card itself.',
    seeAlso: ['sessions:list-pending-gates (read the open gates)', 'journal:record-turn (the sibling turn-end ingest)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sessionId: z.string().min(1).max(256).describe('The native client session/thread id.'),
    client: z.enum(['claude', 'omp', 'codex']).default('claude'),
    kind: z.enum(['ask', 'permission_wait', 'cleared']),
    refId: z
      .string()
      .min(1)
      .max(256)
      .describe('Correlation id you generate for ask/permission_wait; repeat the SAME value on the matching cleared event.'),
    question: z.string().max(2000).optional(),
    options: z.array(optionSpec).max(20).optional(),
    text: z.string().max(4000).optional().describe('Free-text context (e.g. the parsed question-shaped turn-final text).'),
    ownerId: z.string().max(256).optional().describe("The asking agent's coord ownerId, when known — tags the gate."),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = identity.workspaceId ?? activeWorkspaceId();
    const ownerId = args.ownerId ?? identity.ownerId ?? null;

    if (args.kind === 'cleared') {
      const outcome = await closeGate({
        workspaceId,
        sessionId: args.sessionId,
        refId: args.refId,
        reason: 'hook_cleared',
      });
      return {
        data: {
          ok: true,
          gateId: null,
          state: outcome === 'closed' ? 'closed' : outcome === 'already_closed' ? 'closed' : 'not_found',
        },
      };
    }

    const question = args.question ?? args.text ?? null;
    const { id, outcome } = await openOrTouchGate({
      workspaceId,
      sessionId: args.sessionId,
      client: args.client,
      kind: args.kind,
      refId: args.refId,
      ownerId,
      question,
      options: args.options ?? null,
      source: 'hook',
      harnessSlug: args.harness ?? null,
    });
    return { data: { ok: true, gateId: id || null, state: outcome === 'opened' ? 'opened' : 'already_open' } };
  },
});
