/**
 * The per-use offer for a published identity release (agent-economy-flywheel
 * P-015, D-005/D-007).
 *
 * A paid identity is billed as a MARKUP on the inference a session runs while it
 * wears the identity (D-005). Buyers bring their own model accounts (D-007 point
 * 1), so what the offer charges is the markup alone. This module derives the
 * terms `cupboard:publish-offer` sends for such an offer; it adds no new offer
 * type, it fills in the existing per-use terms:
 *
 *   - `skuRef`            `identity-release:<id>@<version>`: the release itself.
 *   - `meterUnit`         one block of 1,000 micro-USD of billed inference.
 *   - `unitPriceMicros`   the markup on one block (markupBps / 10).
 *   - `splitManifestHash` the revenue split of each markup payment: the DAO
 *                         takes 1000 bps (D-007 point 3), the seller's creator
 *                         and component shares split the other 9000.
 *   - `priceVersion`      the markup and split, spelled out, so a buyer, a
 *                         settler or the offer door can rebuild the manifest from
 *                         the offer alone and check it against the hash.
 *
 * Because every term is derived here, a hand-authored identity offer cannot
 * commit to a skuRef, unit, price or split that disagrees with its own
 * priceVersion: `verifyIdentityPerUseOffer` rebuilds the terms and refuses any
 * mismatch.
 */
import {
  revenueSplitManifest,
  type RevenueShare,
  type RevenueSplitManifest,
} from '../p2p/revenue-settlement';

/** Prefix of an identity release's skuRef. */
export const IDENTITY_RELEASE_SKU_PREFIX = 'identity-release:';
/** One metered unit: a block of 1,000 micro-USD of billed inference. */
export const IDENTITY_INFERENCE_BLOCK_MICROS = 1_000;
export const IDENTITY_MARKUP_METER_UNIT = 'identity-inference-markup:1000-micro-usd';
/** The DAO's share of every markup payment (D-007 point 3; DAO plan D-012). */
export const IDENTITY_DAO_TAKE_BPS = 1_000;
/** What the listing form suggests to a seller who has not set a markup (D-007 point 3). */
export const IDENTITY_SUGGESTED_MARKUP_BPS = 2_000;
/** Version of the price scheme; also the split manifest's `version`. */
export const IDENTITY_MARKUP_PRICE_SCHEME = 'identity-markup-v1';

const SELLER_SHARE_BPS = 10_000 - IDENTITY_DAO_TAKE_BPS;
/** Markup is quoted per block of 1,000 micros, so 10 bps is one micro. */
const MARKUP_BPS_STEP = 10_000 / IDENTITY_INFERENCE_BLOCK_MICROS;

export interface IdentityReleaseRef {
  readonly id: string;
  readonly version: string;
}

export interface IdentityMarkupTerms {
  /** Markup on billed inference, in basis points (2000 = 20%). */
  readonly markupBps: number;
  /** Seller's creator share of each markup payment, in bps. */
  readonly creatorBps: number;
  /** Seller's component share, divided down the dependency closure by P-019. */
  readonly componentBps: number;
}

export interface IdentityPerUseOfferTerms {
  readonly skuRef: string;
  readonly meterUnit: string;
  readonly unitPriceMicros: number;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

export type IdentityOfferRefusalCode =
  | 'invalid-identity-release'
  | 'invalid-markup'
  | 'invalid-split'
  | 'not-an-identity-offer'
  | 'identity-offer-mismatch';

export type IdentityPerUseOfferResult =
  | {
      readonly ok: true;
      readonly identity: IdentityReleaseRef;
      readonly markup: IdentityMarkupTerms;
      readonly terms: IdentityPerUseOfferTerms;
      readonly manifest: RevenueSplitManifest;
    }
  | { readonly ok: false; readonly code: IdentityOfferRefusalCode; readonly detail: string };

const refuse = (code: IdentityOfferRefusalCode, detail: string) => ({ ok: false as const, code, detail });

// The id and version must survive the `<id>@<version>` join unambiguously.
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

export function identityReleaseSkuRef(identity: IdentityReleaseRef): string {
  return `${IDENTITY_RELEASE_SKU_PREFIX}${identity.id}@${identity.version}`;
}

/** The identity release a skuRef names, or null when it names something else. */
export function parseIdentityReleaseSkuRef(skuRef: string): IdentityReleaseRef | null {
  if (!skuRef.startsWith(IDENTITY_RELEASE_SKU_PREFIX)) return null;
  const rest = skuRef.slice(IDENTITY_RELEASE_SKU_PREFIX.length);
  const at = rest.lastIndexOf('@');
  if (at <= 0) return null;
  const identity = { id: rest.slice(0, at), version: rest.slice(at + 1) };
  return ID_PATTERN.test(identity.id) && VERSION_PATTERN.test(identity.version) ? identity : null;
}

/** True for any skuRef in the identity-release namespace, well-formed or not. */
export function isIdentityReleaseSkuRef(skuRef: string): boolean {
  return skuRef.startsWith(IDENTITY_RELEASE_SKU_PREFIX);
}

export function identityMarkupSplitManifest(markup: Pick<IdentityMarkupTerms, 'creatorBps' | 'componentBps'>): RevenueSplitManifest {
  const sharesBps: Record<RevenueShare, number> = {
    creator: markup.creatorBps,
    host: 0,
    component: markup.componentBps,
    dao: IDENTITY_DAO_TAKE_BPS,
    reserve: 0,
    tax: 0,
    operating: 0,
  };
  return revenueSplitManifest({ version: IDENTITY_MARKUP_PRICE_SCHEME, sharesBps });
}

export function identityMarkupPriceVersion(markup: IdentityMarkupTerms): string {
  return (
    `${IDENTITY_MARKUP_PRICE_SCHEME};markup=${markup.markupBps}` +
    `;creator=${markup.creatorBps};component=${markup.componentBps};dao=${IDENTITY_DAO_TAKE_BPS}`
  );
}

/** The markup a priceVersion spells out, or null when it is not this scheme. */
export function parseIdentityMarkupPriceVersion(priceVersion: string): IdentityMarkupTerms | null {
  const match =
    /^identity-markup-v1;markup=(\d+);creator=(\d+);component=(\d+);dao=(\d+)$/.exec(priceVersion);
  if (!match) return null;
  if (Number(match[4]) !== IDENTITY_DAO_TAKE_BPS) return null;
  return { markupBps: Number(match[1]), creatorBps: Number(match[2]), componentBps: Number(match[3]) };
}

function checkMarkup(markup: IdentityMarkupTerms): { ok: true } | ReturnType<typeof refuse> {
  const { markupBps, creatorBps, componentBps } = markup;
  if (!Number.isSafeInteger(markupBps) || markupBps <= 0 || markupBps % MARKUP_BPS_STEP !== 0) {
    return refuse(
      'invalid-markup',
      `markupBps must be a positive multiple of ${MARKUP_BPS_STEP} (one micro per ${IDENTITY_INFERENCE_BLOCK_MICROS}-micro block); got ${markupBps}`,
    );
  }
  for (const [name, bps] of [['creatorBps', creatorBps], ['componentBps', componentBps]] as const) {
    if (!Number.isSafeInteger(bps) || bps < 0) return refuse('invalid-split', `${name} must be a non-negative integer; got ${bps}`);
  }
  if (creatorBps + componentBps !== SELLER_SHARE_BPS) {
    return refuse(
      'invalid-split',
      `creatorBps + componentBps must be ${SELLER_SHARE_BPS} (the DAO takes ${IDENTITY_DAO_TAKE_BPS}); got ${creatorBps + componentBps}`,
    );
  }
  return { ok: true };
}

/**
 * Derive the per-use offer terms for an identity release. The markup defaults
 * to the suggested 20% and the seller share to the creator; the component share
 * stays 0 until the seller names one (P-019 divides it among the dependencies).
 */
export function identityPerUseOfferTerms(input: {
  readonly identity: IdentityReleaseRef;
  readonly markupBps?: number;
  readonly creatorBps?: number;
  readonly componentBps?: number;
}): IdentityPerUseOfferResult {
  const { identity } = input;
  if (!ID_PATTERN.test(identity.id) || !VERSION_PATTERN.test(identity.version)) {
    return refuse(
      'invalid-identity-release',
      `identity id and version must be plain identifiers (got ${JSON.stringify(identity.id)}@${JSON.stringify(identity.version)})`,
    );
  }
  const componentBps = input.componentBps ?? 0;
  const markup: IdentityMarkupTerms = {
    markupBps: input.markupBps ?? IDENTITY_SUGGESTED_MARKUP_BPS,
    creatorBps: input.creatorBps ?? SELLER_SHARE_BPS - componentBps,
    componentBps,
  };
  const checked = checkMarkup(markup);
  if (!checked.ok) return checked;
  const manifest = identityMarkupSplitManifest(markup);
  return {
    ok: true,
    identity: { id: identity.id, version: identity.version },
    markup,
    manifest,
    terms: {
      skuRef: identityReleaseSkuRef(identity),
      meterUnit: IDENTITY_MARKUP_METER_UNIT,
      unitPriceMicros: (markup.markupBps * IDENTITY_INFERENCE_BLOCK_MICROS) / 10_000,
      priceVersion: identityMarkupPriceVersion(markup),
      splitManifestHash: manifest.manifestHash,
    },
  };
}

/**
 * Check that a per-use offer in the identity-release namespace commits to
 * exactly the terms its own skuRef and priceVersion derive. A mismatch in any
 * term (a skuRef naming another release, a unit or price that is not the
 * markup, a split hash that is not the spelled-out split) is refused.
 */
export function verifyIdentityPerUseOffer(offer: IdentityPerUseOfferTerms): IdentityPerUseOfferResult {
  if (!isIdentityReleaseSkuRef(offer.skuRef)) {
    return refuse('not-an-identity-offer', `skuRef ${JSON.stringify(offer.skuRef)} is not an identity release`);
  }
  const identity = parseIdentityReleaseSkuRef(offer.skuRef);
  if (!identity) {
    return refuse('invalid-identity-release', `skuRef ${JSON.stringify(offer.skuRef)} is not identity-release:<id>@<version>`);
  }
  const markup = parseIdentityMarkupPriceVersion(offer.priceVersion);
  if (!markup) {
    return refuse(
      'identity-offer-mismatch',
      `priceVersion must spell out the identity markup (${IDENTITY_MARKUP_PRICE_SCHEME};markup=…;creator=…;component=…;dao=${IDENTITY_DAO_TAKE_BPS}); got ${JSON.stringify(offer.priceVersion)}`,
    );
  }
  const derived = identityPerUseOfferTerms({ identity, ...markup });
  if (!derived.ok) return derived;
  for (const field of ['skuRef', 'meterUnit', 'unitPriceMicros', 'priceVersion', 'splitManifestHash'] as const) {
    if (offer[field] !== derived.terms[field]) {
      return refuse(
        'identity-offer-mismatch',
        `${field} ${JSON.stringify(offer[field])} disagrees with the terms its priceVersion derives (${JSON.stringify(derived.terms[field])})`,
      );
    }
  }
  return derived;
}
