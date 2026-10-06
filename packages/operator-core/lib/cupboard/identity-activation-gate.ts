/**
 * Activation gate for priced identity layers (agent-economy-flywheel-2026-08-30
 * P-016, decisions D-005, D-007 and D-011).
 *
 * Activating a Cupboard identity release that has a per-use offer requires money
 * behind it: a funded payment channel bound to the release, or prepaid credits.
 * Every door that activates identity layers (launch, attach/switch/rollback,
 * restart) asks this gate first; without funds it gets a typed refusal.
 *
 * This module is pure. The I/O half (`identity-activation-gate-io.ts`) resolves
 * which stack layers are Cupboard releases, reads the hosted offers and funds, and
 * hands the results here as readouts. Keeping the decision pure is what lets every
 * case (no funds, credits, channel, revocation, unreadable) be tested exactly.
 *
 * Scope rules:
 *   - Only Cupboard-installed identity releases are ever priced. Local layers,
 *     built-ins and the kernel never reach this gate.
 *   - A release with no active offer is free and always activates.
 *   - A priced release whose offer or funds cannot be read is refused
 *     (fail closed). A free release whose offers cannot be read right now still
 *     activates when the last successful read said it was free (the I/O half
 *     supplies that cached verdict).
 *   - Funds are re-read on every activation, so a closed channel or reversed
 *     credits refuse the next activation.
 */
import { verifyIdentityPerUseOffer, type IdentityReleaseRef } from './identity-per-use-offer';

/** One stack layer that resolves to an installed Cupboard identity release. */
export interface InstalledIdentityReleaseLayer {
  /** The stack ref exactly as the launch stack names it (`<slot>:<id>`). */
  readonly layerRef: string;
  readonly identity: IdentityReleaseRef;
  readonly skuRef: string;
}

/** The fields of a hosted offer (`GET /commerce/offers`) the gate reads. */
export interface IdentityOfferView {
  readonly offerId: string;
  readonly skuRef: string;
  readonly active: boolean;
  readonly productActive: boolean;
  readonly perUse: {
    readonly unitPriceMicros: number;
    readonly meterUnit: string;
    readonly priceVersion: string;
    readonly splitManifestHash: string;
  } | null;
}

export interface PrepaidBalanceView {
  readonly availableMicros: number;
  readonly debtMicros: number;
}

/** The fields of a hosted channel (`GET /commerce/payment-channels/:id`) the gate reads. */
export interface FundingChannelView {
  readonly channelId: string;
  readonly state: string;
  readonly escrowMicros: number;
  readonly committedMicros: number;
}

/** A value read from the hosted Cupboard, or why it could not be read. */
export type Readout<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly detail: string };

export type IdentityPricingVerdict =
  | { readonly kind: 'free' }
  | { readonly kind: 'priced'; readonly offerId: string; readonly unitPriceMicros: number }
  | { readonly kind: 'unverifiable'; readonly detail: string };

export type FundingSource =
  | { readonly kind: 'payment-channel'; readonly channelId: string }
  | { readonly kind: 'prepaid-credits' };

export type IdentityActivationRefusalCode =
  | 'identity-activation-unfunded'
  | 'identity-pricing-unverifiable'
  | 'identity-funding-unverifiable';

export interface IdentityActivationRefusedLayer {
  readonly layerRef: string;
  readonly skuRef: string;
  readonly code: IdentityActivationRefusalCode;
  readonly detail: string;
  readonly offerId?: string;
  readonly unitPriceMicros?: number;
}

export interface IdentityActivationChargedLayer {
  readonly layerRef: string;
  readonly skuRef: string;
  readonly offerId: string;
  readonly unitPriceMicros: number;
  readonly source: FundingSource;
}

export type IdentityActivationDecision =
  | { readonly ok: true; readonly charged: readonly IdentityActivationChargedLayer[] }
  | {
      readonly ok: false;
      readonly code: IdentityActivationRefusalCode;
      readonly detail: string;
      readonly refused: readonly IdentityActivationRefusedLayer[];
      readonly charged: readonly IdentityActivationChargedLayer[];
    };

/** Channel states in which escrow can still pay for a new unit. */
const SPENDABLE_CHANNEL_STATES = new Set(['open']);

/**
 * The pricing of one release, from the hosted offers. Only offers that are
 * active on an active product count. Every such offer must be a per-use offer
 * that verifies against its own priceVersion (P-015); one that does not makes
 * the release unverifiable rather than free, so a malformed offer can never
 * turn a priced release into a free one. The cheapest verified offer prices
 * the activation (ties by offerId, for a stable choice).
 */
export function identityReleasePricing(
  skuRef: string,
  offers: readonly IdentityOfferView[],
): IdentityPricingVerdict {
  const live = offers.filter((offer) => offer.skuRef === skuRef && offer.active && offer.productActive);
  if (live.length === 0) return { kind: 'free' };
  let best: { offerId: string; unitPriceMicros: number } | null = null;
  for (const offer of live) {
    if (!offer.perUse) {
      return {
        kind: 'unverifiable',
        detail: `offer ${offer.offerId} for ${skuRef} is not a per-use offer, so the identity markup it charges is unknown`,
      };
    }
    const verified = verifyIdentityPerUseOffer({ skuRef: offer.skuRef, ...offer.perUse });
    if (!verified.ok) {
      return { kind: 'unverifiable', detail: `offer ${offer.offerId} for ${skuRef}: ${verified.code}: ${verified.detail}` };
    }
    const price = verified.terms.unitPriceMicros;
    if (!best || price < best.unitPriceMicros || (price === best.unitPriceMicros && offer.offerId < best.offerId)) {
      best = { offerId: offer.offerId, unitPriceMicros: price };
    }
  }
  return { kind: 'priced', offerId: best!.offerId, unitPriceMicros: best!.unitPriceMicros };
}

function channelRemainingMicros(channel: FundingChannelView): number {
  return channel.escrowMicros - channel.committedMicros;
}

/**
 * Decide whether a set of release layers may be activated.
 *
 * `channels` maps a skuRef to the re-read of its bound channel: `value: null`
 * means no channel is bound (or the hosted owner-only read no longer finds it).
 * A bound channel is tried first because it is the buyer's explicit routing
 * choice; prepaid credits cover the rest. Credits are one balance shared by all
 * layers, so each layer they fund reserves its unit price from the same pool.
 */
export function evaluateIdentityActivation(input: {
  readonly layers: readonly InstalledIdentityReleaseLayer[];
  readonly pricing: ReadonlyMap<string, IdentityPricingVerdict>;
  readonly prepaid: Readout<PrepaidBalanceView> | null;
  readonly channels: ReadonlyMap<string, Readout<FundingChannelView | null>>;
}): IdentityActivationDecision {
  const charged: IdentityActivationChargedLayer[] = [];
  const refused: IdentityActivationRefusedLayer[] = [];
  let prepaidRemaining =
    input.prepaid?.ok && input.prepaid.value.debtMicros === 0 ? input.prepaid.value.availableMicros : 0;

  for (const layer of input.layers) {
    const pricing = input.pricing.get(layer.skuRef) ?? {
      kind: 'unverifiable' as const,
      detail: `no pricing verdict was read for ${layer.skuRef}`,
    };
    if (pricing.kind === 'free') continue;
    if (pricing.kind === 'unverifiable') {
      refused.push({ layerRef: layer.layerRef, skuRef: layer.skuRef, code: 'identity-pricing-unverifiable', detail: pricing.detail });
      continue;
    }
    const price = pricing.unitPriceMicros;
    const priced = { layerRef: layer.layerRef, skuRef: layer.skuRef, offerId: pricing.offerId, unitPriceMicros: price };

    const channelReadout = input.channels.get(layer.skuRef) ?? null;
    const channel = channelReadout?.ok ? channelReadout.value : null;
    if (channel && SPENDABLE_CHANNEL_STATES.has(channel.state) && channelRemainingMicros(channel) >= price) {
      charged.push({ ...priced, source: { kind: 'payment-channel', channelId: channel.channelId } });
      continue;
    }
    if (prepaidRemaining >= price) {
      prepaidRemaining -= price;
      charged.push({ ...priced, source: { kind: 'prepaid-credits' } });
      continue;
    }

    const reasons: string[] = [];
    let unreadable = false;
    if (channelReadout && !channelReadout.ok) {
      unreadable = true;
      reasons.push(`its payment channel could not be read (${channelReadout.detail})`);
    } else if (!channel) {
      reasons.push('no payment channel is bound to it');
    } else if (!SPENDABLE_CHANNEL_STATES.has(channel.state)) {
      reasons.push(`its payment channel ${channel.channelId} is ${channel.state}`);
    } else {
      reasons.push(`its payment channel ${channel.channelId} has ${channelRemainingMicros(channel)} micros left`);
    }
    if (!input.prepaid) {
      unreadable = true;
      reasons.push('prepaid credits were not read');
    } else if (!input.prepaid.ok) {
      unreadable = true;
      reasons.push(`prepaid credits could not be read (${input.prepaid.detail})`);
    } else if (input.prepaid.value.debtMicros > 0) {
      reasons.push(`prepaid credits carry ${input.prepaid.value.debtMicros} micros of debt`);
    } else {
      reasons.push(`prepaid credits have ${prepaidRemaining} micros available`);
    }
    refused.push({
      ...priced,
      code: unreadable ? 'identity-funding-unverifiable' : 'identity-activation-unfunded',
      detail: `${layer.skuRef} costs ${price} micros per ${1_000}-micro inference block; ${reasons.join('; ')}`,
    });
  }

  if (refused.length === 0) return { ok: true, charged };
  const code: IdentityActivationRefusalCode = refused.some((r) => r.code === 'identity-pricing-unverifiable')
    ? 'identity-pricing-unverifiable'
    : refused.some((r) => r.code === 'identity-funding-unverifiable')
      ? 'identity-funding-unverifiable'
      : 'identity-activation-unfunded';
  return {
    ok: false,
    code,
    refused,
    charged,
    detail: refused.map((r) => `${r.layerRef}: ${r.detail}`).join(' | '),
  };
}

/** Thrown by a door that cannot activate the requested layers. */
export class IdentityActivationRefusedError extends Error {
  readonly code: IdentityActivationRefusalCode;
  readonly refused: readonly IdentityActivationRefusedLayer[];

  constructor(decision: Extract<IdentityActivationDecision, { ok: false }>) {
    super(`${decision.code}: ${decision.detail}`);
    this.name = 'IdentityActivationRefusedError';
    this.code = decision.code;
    this.refused = decision.refused;
  }
}

export function isIdentityActivationRefusedError(error: unknown): error is IdentityActivationRefusedError {
  return error instanceof IdentityActivationRefusedError ||
    (error instanceof Error && error.name === 'IdentityActivationRefusedError' &&
      typeof (error as { code?: unknown }).code === 'string');
}
