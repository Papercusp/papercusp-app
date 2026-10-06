/**
 * consult:reconcile — record the terminal disposition of a PROCEED consult
 * (EI-23764501791910357, slice 3).
 *
 * PROD BINDING ONLY — verb logic in lib/consult/consult-verbs-core.ts
 * (consultReconcileCore). A consult opened under latency_contract:'proceed' tells
 * the requester to carry on and reconcile when the answer lands; the obligation
 * agenda re-surfaces that debt every orient until THIS verb clears it. Requester-only:
 * it is their assumption to disposition.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_REPLY_ROLES } from '../coordination/roles';
import { hardText } from '../limits';

const ok = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'consult:reconcile',
  description:
    "Record how a latency_contract:'proceed' consult resolved against the assumption you proceeded on: 'confirmed' (answer agrees), 'rescoped' (kept going, changed scope), 'reversed' (undid/redid work), or 'moot' (already shipped / question void). Requester-only and terminal; clears the proceed-reconciliation obligation. Works on an open, answered, or ended (expired/declined/cant_help) consult.",
  guidance: {
    when:
      "Your agenda lists a 'Reconcile proceed-consult <id>' row, or a consult you opened under proceed has answered / lapsed — read the thread, diff the reply (or its silence) against what you built, then record the disposition with a note.",
    notWhen:
      "You are the responder or the consult was not 'proceed' (blocking consults have no reconciliation debt). To settle the consult THREAD itself use consult:close; for a rescope/reversal other lanes must follow, ALSO record plans:add-decision and cite its id as decision_ref.",
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_REPLY_ROLES],
  args: z.object({
    conversation_id: z.string().min(1).describe('The proceed consult to reconcile (full id or unique prefix).'),
    disposition: z
      .enum(['confirmed', 'rescoped', 'reversed', 'moot'])
      .describe('confirmed = answer agrees with your assumption · rescoped = you changed scope · reversed = you undid/redid work · moot = already shipped or the question is void.'),
    note: hardText(2000).describe('What the answer (or its absence) changed — or why nothing did. Required: a bare "confirmed" is the debt-that-looks-discharged.'),
    decision_ref: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*#D-\d{3,}$/, "'<plan-slug>#D-NNN'")
      .optional()
      .describe('Optional <plan-slug>#D-NNN of the plan Decision recording a rescope/reversal (use plans:add-decision first).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const [{ getOrgPg }, { consultReconcileCore }, conversations] = await Promise.all([
      import('@papercusp/db-org'),
      import('../../consult/consult-verbs-core'),
      import('../coordination/conversations'),
    ]);
    const workspaceId = conversations.withConversationsIdentityScope(identity, undefined, () =>
      conversations.conversationsScopeWorkspace(),
    );
    const result = await consultReconcileCore(
      {
        workspaceId,
        authorId: identity.ownerId,
        conversationId: args.conversation_id,
        disposition: args.disposition,
        note: args.note,
        decisionRef: args.decision_ref,
      },
      { getSql: () => getOrgPg().sql },
    );
    return ok(result as unknown as Record<string, unknown>);
  },
});
