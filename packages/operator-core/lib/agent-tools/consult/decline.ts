/**
 * consult:decline — the responder's cheap honest exit (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; D-007(7)).
 *
 * PROD BINDING ONLY — verb logic in lib/consult/consult-verbs-core.ts. A
 * decline posts the reason and ADVANCES the cascade (D-005 always-advance,
 * consult-min-max-and-rubric-vetting-2026-08-17): the next selectee is woken
 * with the feedback so far (reach → notifyAgents). Only when the menu is
 * exhausted does it close consult_state as 'declined' and emit the latched
 * park key (nothing more is coming for a parked requester).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:decline',
  description:
    'Decline a consult routed to you — your context does not cover the question. Honest and cheap by design: posts the reason and the cascade ADVANCES server-side (the next selected responder is woken with the feedback so far); only when the menu is exhausted does the consult close as declined and wake the requester.',
  guidance: {
    when:
      'You validated the consult (read the cited evidence) and your context genuinely does not cover it. Declining fast is the helpful move — never answer from guesswork.',
    notWhen:
      "You can partially help → consult:reply (clarifying_question / new_fact). Settled, or the QUESTION is void (duplicate, inadmissible, already settled) → consult:close { outcome:'cant_help', reason }: terminal and non-advancing, where declining would spend the next reviewer.",
    chaining:
      'conversations:get { id } reads the thread FIRST — there is NO consult:read, and a wrong-door read returns EMPTY, so "no replies" may mean you used the wrong door → decline only against what is actually there.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z.object({
    conversation_id: z.string().min(1).describe('The consult conversation to decline.'),
    reason: hardText(2000).describe("Why your context does not cover it (e.g. 'my transcript touches the file but not this subsystem')."),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultDeclineCore }, conversations, { makeConsultReachDispatcher }] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
      import('../../consult/consult-dispatch'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultDeclineCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        reason: args.reason,
      },
      {
        getSql: () => getOrgPg().sql,
        post: (input) => conversations.postReply(identity, input),
        // Terminal declines have a typed `declined` consult_state outcome but
        // must also settle the coarse coord_conversations projection. The
        // shared settlement seam maps the non-answering outcome to `closed`.
        settleConversation: (input, tx) =>
          conversations.settleConsultConversation(
            identity,
            {
              conversationId: input.conversationId,
              outcome: 'cant_help',
              postId: input.postId,
              now: input.now,
            },
            tx,
          ),
        emitReplyEvent: async (e) => {
          await import('../../events/await/engine')
            .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ ...e, source: identity.ownerId }))
            .catch(() => {});
        },
        // D-005 cascade advance, D-002/D-011 delivery: fork/convert a fresh
        // answering session from the next selectee's transcript. No `reach`
        // binding here at all — a decline has no requester follow-up, so this
        // verb has no live agent it may legitimately message.
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
