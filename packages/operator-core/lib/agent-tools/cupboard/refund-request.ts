/**
 * cupboard:refund-request — authorize a refund against an order's REFUNDABLE
 * remainder (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3d).
 *
 * The ceiling is `refundableMinor` = amount − settled − PENDING, not
 * `Order.refundedMinor` (EI-22438759043480870): subtracting refunds already in
 * flight is what stops two overlapping requests from together exceeding the
 * order. See `commerce-door-gate.gateRefundRequest` for the rule itself.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:refund-request',
  capability: 'harness:write',
  description:
    "Authorize a refund on a Cupboard order: checks the acting user may act for the buying org, that the order belongs to that org, and that the amount fits the order's REFUNDABLE remainder (amount minus already-settled minus refunds still in flight). Omit amountMinor to request the whole refundable remainder. Returns the authorized amount plus the refund position, including which installations keep running after revocation.",
  guidance: {
    when: 'A buying org wants money back on an order and you need the authorized amount plus the blast radius of revoking it.',
    notWhen:
      'Just reading refund positions without requesting one (cupboard:commerce-dashboards with dashboards:["refunds"]). Starting a purchase (cupboard:checkout).',
    chaining:
      'Read the returned position.intentsSurvivingRevocation before telling a user what they lose — a refund revokes the entitlement but still permits repair, so it is not a kill switch.',
    seeAlso: ['cupboard:commerce-dashboards', 'cupboard:support-request'],
  },
  args: z.object({
    buyerOrgId: z.string().max(200).describe('The organization that owns the order.'),
    actingUserId: z.string().max(200).describe('The user requesting the refund; must be a member of buyerOrgId.'),
    orderId: z.string().max(200).describe('The order to refund.'),
    amountMinor: z
      .number()
      .int()
      .optional()
      .describe('Minor units to refund; omit for the whole refundable remainder.'),
    reason: z.string().max(500).optional().describe('Why the refund was requested.'),
  }),
  async handler(args) {
    const { refundRequestDoor } = await import('../../cupboard/commerce-door-gate-io');
    const decision = await refundRequestDoor({
      buyerOrgId: args.buyerOrgId,
      actingUserId: args.actingUserId,
      orderId: args.orderId,
      ...(args.amountMinor !== undefined ? { amountMinor: args.amountMinor } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    });

    if (!decision.ok) {
      return text({
        ok: false,
        error: decision.code,
        detail: decision.detail,
        refusedBy: 'commerce-door-gate',
      });
    }

    return text({
      ok: true,
      request: decision.request,
      position: {
        orderId: decision.position.orderId,
        orderState: decision.position.orderState,
        orderAmountMinor: decision.position.orderAmountMinor,
        currency: decision.position.currency,
        settledMinor: decision.position.settledMinor,
        pendingMinor: decision.position.pendingMinor,
        refundableMinor: decision.position.refundableMinor,
        entitlementId: decision.position.entitlementId,
        entitlementState: decision.position.entitlementState,
        activeInstallations: decision.position.activeInstallations,
        intentsSurvivingRevocation: decision.position.intentsSurvivingRevocation,
      },
    });
  },
});
