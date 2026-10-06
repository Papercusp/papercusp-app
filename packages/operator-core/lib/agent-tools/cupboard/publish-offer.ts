/**
 * cupboard:publish-offer — author a provider-neutral commerce product + offer
 * through the hosted Worker ledger (shared-pot DAO plan P-028).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  identityPerUseOfferTerms,
  isIdentityReleaseSkuRef,
  verifyIdentityPerUseOffer,
  type IdentityPerUseOfferResult,
} from '../../cupboard/identity-per-use-offer';

const data = (payload: Record<string, unknown>) => ({ data: payload });

/** A paid identity's offer: every per-use term is derived from these (flywheel P-015). */
const identityReleaseArgs = z
  .object({
    id: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    /** Markup on billed inference in bps; defaults to the suggested 2000 (20%). */
    markupBps: z.number().int().positive().optional(),
    /** Seller creator share of each markup payment; with componentBps it must total 9000. */
    creatorBps: z.number().int().nonnegative().optional(),
    componentBps: z.number().int().nonnegative().optional(),
  })
  .strict();

const offerArgs = z
  .object({
    productId: z.string().min(1).max(200),
    offerId: z.string().min(1).max(200),
    skuRef: z.string().min(1).max(300).optional(),
    identityRelease: identityReleaseArgs.optional(),
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
    if (args.identityRelease) {
      // Every term is derived from the identity release; a caller-supplied one
      // could only disagree with it.
      if (args.pricingModel !== 'per-use') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pricingModel'], message: 'an identityRelease offer is per-use' });
      }
      for (const field of ['skuRef', ...termFields] as const) {
        if (args[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is derived from identityRelease; omit it`,
          });
        }
      }
      return;
    }
    if (args.skuRef === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skuRef'], message: 'skuRef (or identityRelease) is required' });
    }
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
    'Publish or update a Cupboard commerce offer through the hosted append-only ledger. Per-use offers require unitPriceMicros, meterUnit, priceVersion and splitManifestHash; those exact terms are persisted in D1, exposed by the commerce catalog/dashboard, and returned by cupboard:checkout as a P2P microcharge preflight. For a paid identity pass identityRelease { id, version, markupBps? } instead of skuRef and the terms: they are derived (inference markup, DAO 10%). The authenticated GitHub principal becomes the product creator.',
  guidance: {
    when: 'A creator needs to define an executable Cupboard offer, especially a metered per-use offer or a paid identity (identityRelease).',
    notWhen:
      'Publishing a distributable listing/repository (use the relevant cupboard:publish-* listing tool) or buying an existing offer (cupboard:checkout).',
    chaining:
      'Read it back with cupboard:commerce-dashboards dashboards:["catalog"], then use cupboard:checkout with maxSpendMicros for a per-use offer.',
    seeAlso: ['cupboard:checkout', 'cupboard:commerce-dashboards'],
  },
  args: offerArgs,
  async handler(args) {
    // An identity offer's terms are derived (identityRelease) or checked against
    // what its own skuRef and priceVersion derive, BEFORE any network round trip.
    let identityOffer: IdentityPerUseOfferResult | null = null;
    if (args.identityRelease) {
      const { id, version, ...markup } = args.identityRelease;
      identityOffer = identityPerUseOfferTerms({ identity: { id, version }, ...markup });
    } else if (args.pricingModel === 'per-use' && args.skuRef && isIdentityReleaseSkuRef(args.skuRef)) {
      identityOffer = verifyIdentityPerUseOffer({
        skuRef: args.skuRef,
        meterUnit: args.meterUnit as string,
        unitPriceMicros: args.unitPriceMicros as number,
        priceVersion: args.priceVersion as string,
        splitManifestHash: args.splitManifestHash as string,
      });
    }
    if (identityOffer && !identityOffer.ok) {
      return data({ ok: false, error: identityOffer.code, detail: identityOffer.detail, status: 400 });
    }
    const perUse = identityOffer?.ok
      ? {
          unitPriceMicros: identityOffer.terms.unitPriceMicros,
          meterUnit: identityOffer.terms.meterUnit,
          priceVersion: identityOffer.terms.priceVersion,
          splitManifestHash: identityOffer.terms.splitManifestHash,
        }
      : {
          unitPriceMicros: args.unitPriceMicros as number,
          meterUnit: args.meterUnit as string,
          priceVersion: args.priceVersion as string,
          splitManifestHash: args.splitManifestHash as string,
        };

    const { postCommerceOffer } = await import('../../cupboard/commerce-door-gate-io');
    const result = await postCommerceOffer({
      productId: args.productId,
      offerId: args.offerId,
      skuRef: identityOffer?.ok ? identityOffer.terms.skuRef : (args.skuRef as string),
      title: args.title,
      pricingModel: args.pricingModel,
      price: { amountMinor: args.amountMinor, currency: args.currency },
      ...(args.active !== undefined ? { active: args.active } : {}),
      ...(args.pricingModel === 'per-use' ? { perUse } : {}),
    });
    const identity = identityOffer?.ok
      ? {
          identityOffer: {
            identity: identityOffer.identity,
            markup: identityOffer.markup,
            splitSharesBps: identityOffer.manifest.sharesBps,
          },
        }
      : {};
    return result.ok
      ? data({ ...result, ...identity })
      : data({
          ok: false,
          error: result.error,
          detail: result.detail,
          status: result.status,
        });
  },
});
