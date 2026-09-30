/**
 * cupboard:publish-offer — author a provider-neutral commerce product + offer
 * through the hosted Worker ledger (shared-pot DAO plan P-028).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const data = (payload: Record<string, unknown>) => ({ data: payload });

const offerArgs = z
  .object({
    productId: z.string().min(1).max(200),
    offerId: z.string().min(1).max(200),
    skuRef: z.string().min(1).max(300),
    title: z.string().min(1).max(300),
    pricingModel: z.enum(['free', 'one-time', 'subscription', 'per-use']),
    amountMinor: z.number().int().nonnegative().default(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
    active: z.boolean().optional(),
    unitPriceMicros: z.number().int().positive().optional(),
    meterUnit: z.string().min(1).max(200).optional(),
    priceVersion: z.string().min(1).max(200).optional(),
    splitManifestHash: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/i)
      .optional(),
  })
  .superRefine((args, ctx) => {
    const termFields = ['unitPriceMicros', 'meterUnit', 'priceVersion', 'splitManifestHash'] as const;
    if (args.pricingModel === 'per-use') {
      for (const field of termFields) {
        if (args[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required for a per-use offer`,
          });
        }
      }
      return;
    }
    for (const field of termFields) {
      if (args[field] !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only valid for a per-use offer`,
        });
      }
    }
  });

export default defineTool({
  name: 'cupboard:publish-offer',
  capability: 'harness:write',
  description:
    'Publish or update a Cupboard commerce offer through the hosted append-only ledger. Per-use offers require unitPriceMicros, meterUnit, priceVersion and splitManifestHash; those exact terms are persisted in D1, exposed by the commerce catalog/dashboard, and returned by cupboard:checkout as a P2P microcharge preflight. The authenticated GitHub principal becomes the product creator.',
  guidance: {
    when: 'A creator needs to define an executable Cupboard offer, especially a metered per-use offer.',
    notWhen:
      'Publishing a distributable listing/repository (use the relevant cupboard:publish-* listing tool) or buying an existing offer (cupboard:checkout).',
    chaining:
      'Read it back with cupboard:commerce-dashboards dashboards:["catalog"], then use cupboard:checkout with maxSpendMicros for a per-use offer.',
    seeAlso: ['cupboard:checkout', 'cupboard:commerce-dashboards'],
  },
  args: offerArgs,
  async handler(args) {
    const { postCommerceOffer } = await import('../../cupboard/commerce-door-gate-io');
    const result = await postCommerceOffer({
      productId: args.productId,
      offerId: args.offerId,
      skuRef: args.skuRef,
      title: args.title,
      pricingModel: args.pricingModel,
      price: { amountMinor: args.amountMinor, currency: args.currency },
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.pricingModel === 'per-use'
        ? {
            perUse: {
              unitPriceMicros: args.unitPriceMicros as number,
              meterUnit: args.meterUnit as string,
              priceVersion: args.priceVersion as string,
              splitManifestHash: args.splitManifestHash as string,
            },
          }
        : {}),
    });
    return result.ok
      ? data({ ...result })
      : data({
          ok: false,
          error: result.error,
          detail: result.detail,
          status: result.status,
        });
  },
});
