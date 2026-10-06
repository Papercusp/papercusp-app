/**
 * cupboard:checkout — start a hosted checkout session for a buying organization
 * (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3d).
 *
 * The agent-callable face of `checkoutDoor`: authorize the actor against the
 * buying org locally, then POST the session to the hosted
 * `POST /commerce/checkout-sessions` route that owns the Stripe secrets. The
 * local gate runs FIRST so an unauthorized request never becomes a provider
 * round trip or a `pending` order row.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'cupboard:checkout',
  capability: 'harness:write',
  description:
    'Start a Cupboard checkout for a buying organization. One-time/subscription offers return a hosted provider session. Per-use offers bypass Stripe and return a deterministic P2P microcharge preflight with the signed price terms and an escrow-capped channel descriptor. Refuses before transport when the org is unknown, the acting user is not a member, quantity is not 1, or maxSpendMicros is invalid.',
  guidance: {
    when: 'A member of a buying organization wants to purchase a Cupboard offer and needs a payment link.',
    notWhen:
      'Reading what an org already bought (cupboard:commerce-dashboards). Refunding an order (cupboard:refund-request). Diagnosing why an install is blocked (cupboard:support-request).',
    chaining:
      'Pass a stable idempotencyKey and REUSE it on retry — a fresh key creates a second order. Hand the returned url to the buyer; the entitlement appears once the provider webhook settles.',
    seeAlso: ['cupboard:commerce-dashboards', 'cupboard:refund-request'],
  },
  args: z.object({
    buyerOrgId: z.string().max(200).describe('The buying organization the purchase is billed to.'),
    actingUserId: z.string().max(200).describe('The user making the purchase; must be a member of buyerOrgId.'),
    offerId: z.string().max(200).describe('The offer being purchased.'),
    successUrl: z.string().max(1000).describe('Where the provider returns the buyer after payment.'),
    cancelUrl: z.string().max(1000).describe('Where the provider returns the buyer on cancel.'),
    idempotencyKey: z
      .string()
      .max(200)
      .describe('Stable key for this purchase attempt — reuse it on retry to avoid a second order.'),
    quantity: z.number().int().optional().describe('Seats; only 1 is supported today.'),
    maxSpendMicros: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Required for a per-use offer: maximum micro-units this channel may commit.'),
  }),
  async handler(args, ctx) {
    const [{ checkoutDoor }, { activeWorkspaceId }] = await Promise.all([
      import('../../cupboard/commerce-door-gate-io'),
      import('../../workspace-registry'),
    ]);
    const outcome = await checkoutDoor({
      buyerOrgId: args.buyerOrgId,
      actingUserId: args.actingUserId,
      offerId: args.offerId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      idempotencyKey: args.idempotencyKey,
      ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
      ...(args.maxSpendMicros !== undefined ? { maxSpendMicros: args.maxSpendMicros } : {}),
    }, {}, {
      // P-016 (D-011): an identity-release preflight records its channel as this
      // workspace's funding for that release.
      workspaceId: ctx?.principal?.workspaceId ?? activeWorkspaceId(),
      actorId: args.actingUserId,
    });

    if (!outcome.ok) {
      return text({
        ok: false,
        error: outcome.code,
        detail: outcome.detail,
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        refusedBy: 'commerce-door-gate',
      });
    }

    if (outcome.session.kind === 'microcharge-preflight') {
      return text({
        ...outcome.session,
        ...(outcome.fundingBinding ? { fundingBinding: outcome.fundingBinding } : {}),
      });
    }

    return text({
      ok: true,
      orderId: outcome.session.orderId,
      providerSessionId: outcome.session.providerSessionId,
      url: outcome.session.url,
      idempotentReplay: outcome.session.idempotentReplay,
      ...(outcome.session.idempotentReplay
        ? {
            note: 'This idempotencyKey already had a session — the existing order was returned, nothing new was charged.',
          }
        : {}),
    });
  },
});
