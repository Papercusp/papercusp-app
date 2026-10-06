/**
 * consult:close — settle a consult with a STRUCTURED outcome (plan
 * get-feedback-relevance-consults-2026-08-16, P-004; D-001/D-003).
 *
 * PROD BINDING ONLY — verb logic in lib/consult/consult-verbs-core.ts.
 * outcome 'answered' requires the answer (+ optional confidence/evidence);
 * 'cant_help' requires the reason — an honest terminal outcome, not a
 * failure. Either participant may close; a responder close wakes a parked
 * requester via the latched park key.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

const evidenceRef = z.object({
  session_id: z.string().min(1),
  turn_idx: z.number().int().min(0),
  note: z.string().max(500).optional(),
});

export default defineTool({
  name: 'consult:close',
  description:
    "Close a consult with a structured outcome: 'answered' (requires answer; optional confidence 0..1 + evidence), 'cant_help' (requires reason), or 'graduate' (requires reason — the consult outgrew its bounds: mints a shared work item both participants follow, D-004). Terminal — after the close no further consult posts are accepted. Either participant may close; at the exchange cap this is the only way forward.",
  guidance: {
    when:
      'The consult is settled (answered) — or engaged-but-stuck: you validated relevance yet cannot help (cant_help, with the reason) — or the QUESTION is void (duplicate, inadmissible, already settled elsewhere): cant_help + reason is the TERMINAL, NON-ADVANCING exit, the only one that does not spend the next reviewer — or cap-hit while STILL deliberating: graduate it into shared live work.',
    notWhen:
      'Still exchanging → consult:reply. Not your area but another reviewer might cover it → consult:decline (that ADVANCES the cascade and wakes them).',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z
    .object({
      conversation_id: z.string().min(1).describe('The consult conversation to close.'),
      outcome: z
        .enum(['answered', 'cant_help', 'graduate'])
        .describe("'answered' = structured answer below; 'cant_help' = honest can't-help with reason; 'graduate' = the consult outgrew its bounds (D-004) — mints a shared work item, requires reason."),
      answer: hardText(8000).optional().describe('The settled answer (required for outcome=answered).'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence in the answer, 0..1 (answered only).'),
      evidence: z.array(evidenceRef).max(16).optional().describe('Transcript grounding [{ session_id, turn_idx, note? }] — an ARRAY of transcript-turn tuples, never prose or tool-probe output. If your evidence is not a transcript turn, OMIT this field; never fabricate session_id/turn_idx.'),
      reason: hardText(2000).optional().describe("Why (required for outcome=cant_help and outcome=graduate — for graduate: why the question outgrew the consult)."),
    })
    .refine((a) => (a.outcome === 'answered' ? Boolean(a.answer?.trim()) : Boolean(a.reason?.trim())), {
      message: "outcome=answered requires answer; outcome=cant_help and outcome=graduate require reason",
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultCloseCore }, conversations] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultCloseCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        outcome: args.outcome,
        answer: args.answer,
        confidence: args.confidence,
        evidence: args.evidence,
        reason: args.reason,
      },
      {
        getSql: () => getOrgPg().sql,
        post: (input) => conversations.postReply(identity, input),
        settleConversation: (input, tx) => conversations.settleConsultConversation(identity, input, tx),
        emitReplyEvent: async (e) => {
          await import('../../events/await/engine')
            .then(({ emitAwaitedEvent }) => emitAwaitedEvent({ ...e, source: identity.ownerId }))
            .catch(() => {});
        },
        // P-005 graduation (D-004): mint the shared work item, subscribe BOTH
        // participants (createWorkItem auto-subscribes only the creator), and
        // link it rel:'relates' to the consult conversation.
        mintGraduationWorkItem: async (g) => {
          const [workItems, { getCoordSubscriptionStore }] = await Promise.all([
            import('../../work-items'),
            import('../coordination/subscription-store'),
          ]);
          const q = g.question.replace(/\s+/g, ' ').trim();
          const wi = await workItems.createWorkItem({
            kind: 'task',
            title: `graduated consult: ${q.length > 90 ? `${q.slice(0, 90)}…` : q}`,
            summary:
              `Graduated from consult ${g.conversationId} (D-004: the question outgrew the consult's bounds).\n\n` +
              `Participants: requester ${g.requesterId} ↔ responder ${g.responderId ?? '(none)'} — graduated by ${g.closedBy}.\n` +
              `Why graduated: ${g.reason}\n\n` +
              `Thread: conversations:get { id: '${g.conversationId}' } carries the full exchange.`,
            createdBy: g.closedBy,
            workspaceId: g.workspaceId,
          });
          // Subscribe the OTHER participant(s) — the closer is auto-subscribed
          // as creator. Best-effort: a subscribe failure must not lose the mint.
          const others = [g.requesterId, g.responderId].filter(
            (p): p is string => Boolean(p) && p !== g.closedBy,
          );
          for (const other of others) {
            await getCoordSubscriptionStore()
              .subscribe({
                subscriber_id: other,
                target_kind: 'object',
                target_ref: `issue:${wi.id}`,
                delivery_mode: 'full',
                created_ts: new Date().toISOString(),
              })
              .catch(() => {});
          }
          await workItems
            .linkWorkItem(wi.id, { kind: 'conversation', ref: g.conversationId }, 'relates', { by: g.closedBy })
            .catch(() => {});
          return { id: wi.id };
        },
      },
    );
    return ok(result as unknown as Record<string, unknown>);
  },
});
