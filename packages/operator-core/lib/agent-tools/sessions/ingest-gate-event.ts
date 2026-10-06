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
      'From a turn-end / pre-tool-use / notification hook the moment it observes a structured ask (AskUserQuestion/ExitPlanMode mirror), a permission-wait, or that ask being answered. Almost never called by hand — EXCEPT kind:"suppressed_ask": call it yourself when you decide NOT to re-send an owner ask ("do not ask a 4th time") instead of burying that in a checkpoint. Pass question + decideBy (ISO) + defaultIfUnanswered; it stays on the owner feed after you end.',
    notWhen:
      'To READ pending gates use `sessions:list-pending-gates`. For a genuine owner-facing escalation card, `coord:escalate` remains the preferred ask (D-001) — this tool is the blocked-SESSION signal, not the card itself.',
    seeAlso: ['sessions:list-pending-gates (read the open gates)', 'journal:record-turn (the sibling turn-end ingest)'],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sessionId: z.string().min(1).max(256).describe('The native client session/thread id.'),
    client: z.enum(['claude', 'omp', 'codex']).default('claude'),
    kind: z.enum(['ask', 'permission_wait', 'suppressed_ask', 'cleared']),
    refId: z
      .string()
      .min(1)
      .max(256)
      .describe('Correlation id you generate for ask/permission_wait; repeat the SAME value on the matching cleared event.'),
    question: z.string().max(2000).optional(),
    decideBy: z
      .string()
      .max(64)
      .optional()
      .describe("ISO-8601 deadline for the owner's answer. REQUIRED for kind 'suppressed_ask'."),
    defaultIfUnanswered: z
      .string()
      .max(500)
      .optional()
      .describe("What you WILL do if the owner never answers. REQUIRED for kind 'suppressed_ask'."),
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

    // A SUPPRESSED ask is the agent's own declaration that it owes the owner a decision it will
    // not re-send ("DO NOT ask a 4th time"). With no tool_use to wait on it would otherwise be
    // invisible, so admission demands the three things that make it actionable from ONE
    // plans:attention read: what is being decided, the default, and the deadline. Refused via the
    // handler return (a structured, retryable result), not a new refusal-contract key.
    let decideBy: Date | null = null;
    if (args.kind === 'suppressed_ask') {
      const missing = [
        !question && 'question',
        !args.decideBy && 'decideBy',
        !args.defaultIfUnanswered && 'defaultIfUnanswered',
      ].filter((m): m is string => typeof m === 'string');
      if (missing.length > 0) {
        return {
          data: {
            ok: false,
            gateId: null,
            state: 'refused',
            reason: `suppressed_ask requires ${missing.join(', ')}: state the decision, the default you will proceed under, and the ISO deadline.`,
          },
        };
      }
      decideBy = new Date(args.decideBy as string);
      if (Number.isNaN(decideBy.getTime())) {
        return {
          data: {
            ok: false,
            gateId: null,
            state: 'refused',
            reason: `decideBy "${args.decideBy}" is not a parseable ISO-8601 datetime.`,
          },
        };
      }
    }

    const { id, outcome } = await openOrTouchGate({
      workspaceId,
      sessionId: args.sessionId,
      client: args.client,
      kind: args.kind,
      refId: args.refId,
      ownerId,
      question,
      options: args.options ?? null,
      source: args.kind === 'suppressed_ask' ? 'agent' : 'hook',
      harnessSlug: args.harness ?? null,
      decideBy,
      defaultIfUnanswered: args.kind === 'suppressed_ask' ? args.defaultIfUnanswered : undefined,
    });
    return { data: { ok: true, gateId: id || null, state: outcome === 'opened' ? 'opened' : 'already_open' } };
  },
});
