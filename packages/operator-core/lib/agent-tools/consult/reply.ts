/**
 * consult:reply — post a TYPED reply into a consult thread (plan
 * get-feedback-relevance-consults-2026-08-16, P-004).
 *
 * PROD BINDING ONLY — all verb logic lives in lib/consult/consult-verbs-core.ts
 * (core/binding split, mirrors get-feedback.ts). This file wires the prod
 * seams: post → conversations.postReply (with the internal via_consult_verb
 * kind-gate opt-in), emitReplyEvent → emitAwaitedEvent (latched park key),
 * reach → notifyAgents (requester-follow-up wake; unconditional — the wake
 * budget is removed, consult-min-max-and-rubric-vetting-2026-08-17 D-005).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import type { ToolResult } from '@papercusp/tooldef';
import { resolveAgentIdentity } from '../coordination/identity';
import type { IdleRecipientReport } from '../coordination/inbox-wake';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { hardText } from '../limits';
import { consultPostAbortCompletionReceipt } from './abort-completion';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

/** A follow-up may reroute only on a complete, positive ended-session verdict. */
export function isConfirmedDeadConsultResponder(
  report: Pick<IdleRecipientReport, 'confirmedDead' | 'degraded'> | null | undefined,
  responder: string,
): boolean {
  return report?.degraded !== true && report?.confirmedDead?.includes(responder) === true;
}

/**
 * The handler writes the consult post before finishing its remaining work. If the
 * handler returns after the tool deadline, preserve the completed reply identity so
 * the caller does not mistake a committed post for a safe retry. This does not make
 * the non-idempotent post globally idempotent.
 */
export function consultReplyAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
): ReturnType<typeof consultPostAbortCompletionReceipt> {
  return consultPostAbortCompletionReceipt(args, result, 'consult:reply');
}

const evidenceRef = z.object({
  session_id: z.string().min(1),
  turn_idx: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export default defineTool({
  name: 'consult:reply',
  description:
    'Post a TYPED reply into a consult thread. Responder kinds: answer (evidence REQUIRED — cite the transcript turns), clarifying_question, new_fact. Requester follow-up kinds: question, new_fact. Untyped posts into a consult are refused (conversations:post will not work); the exchange cap binds — at the cap, close instead.',
  guidance: {
    when:
      'You were routed a consult (a 🧭 wake naming a conversation) and are answering/clarifying from your own transcript — or you are the requester following up.',
    notWhen:
      "Your context does not cover it but another reviewer might → consult:decline (cheap, honest). Settled, or the QUESTION is void (duplicate, inadmissible, already settled) → consult:close { outcome:'cant_help', reason }: terminal and non-advancing, where EVERY reply kind advances and spends the next reviewer. A non-consult conversation → conversations:post.",
    chaining:
      'READ THE THREAD FIRST: conversations:get { id } — there is NO consult:read, and a wrong-door read returns EMPTY, which looks exactly like a thread with no replies (a reviewer answered without the requester\'s posts that way). → validate relevance (sessions:read the cited evidence) → consult:reply { kind } → when settled, consult:close { outcome }.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  abortCompletionReceipt: consultReplyAbortCompletionReceipt,
  args: z
    .object({
      conversation_id: z.string().min(1).describe('The consult conversation (from the wake / get_feedback result).'),
      kind: z
        .enum(['answer', 'clarifying_question', 'new_fact', 'question'])
        .describe('Responder: answer | clarifying_question | new_fact. Requester follow-up: question | new_fact.'),
      body: hardText(8000),
      evidence: z
        .array(evidenceRef)
        .max(16)
        .optional()
        .describe('Transcript grounding [{ session_id, turn_idx, note? }] — REQUIRED for kind=answer (D-004).'),
    })
    .refine((a) => a.kind !== 'answer' || (a.evidence?.length ?? 0) > 0, {
      message: 'kind=answer requires evidence — cite the transcript turns the answer rests on',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    // Heavy prod seams — imported per-call, never at registration.
    const [{ getOrgPg }, { consultReplyCore }, conversations, { notifyAgents }, { makeConsultReachDispatcher }, { reportIdleRecipients }] =
      await Promise.all([
        import('@papercusp/db-org'),
        import('../../consult/consult-verbs-core'),
        import('../coordination/conversations'),
        import('../coordination/notify-agents'),
        import('../../consult/consult-dispatch'),
        import('../coordination/inbox-wake'),
      ]);

    // Same partition resolver as the conversation writes (WI-1571).
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );

    const result = await consultReplyCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        kind: args.kind,
        body: args.body,
        evidence: args.evidence,
      },
      {
        getSql: () => getOrgPg().sql,
        post: (input) => conversations.postReply(identity, input),
        emitReplyEvent: async (e) => {
          await import('../../events/await/engine')
            .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ ...e, source: identity.ownerId }))
            .catch(() => {});
        },
        // D-011 seam 1 of 2: the requester's follow-up, addressed to the
        // session ALREADY answering this consult (consult-verbs-core resolves
        // the answering identity). That session is our own worker, so this is
        // the ONE consult delivery that legitimately notifies a live agent.
        reach: async (opts) => {
          const r = await notifyAgents(identity, {
            addressees: [opts.responder],
            objectRef: { kind: 'conversation', ref: opts.conversationId },
            summary: opts.summary,
            body: opts.body,
            wake: true,
          });
          if (r.woke !== 0) return { woke: r.woke };
          const report = await reportIdleRecipients([opts.responder], {
            workspaceId: identity.workspaceId ?? undefined,
          });
          return {
            woke: r.woke,
            confirmedDead: isConfirmedDeadConsultResponder(report, opts.responder),
          };
        },
        // D-011 seam 2 of 2: a cascade advance addresses an expert who is NOT
        // in this conversation — fork/convert a fresh answering session from
        // their transcript, never a wake.
        dispatch: makeConsultReachDispatcher({
          workspaceId,
          harnessSlug: ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null,
          launchedBy: identity.ownerId,
        }),
      },
    );
    return ok(result as unknown as Record<string, unknown>);
  },
});
