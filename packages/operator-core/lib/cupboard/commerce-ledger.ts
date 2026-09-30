/**
 * Provider-neutral commerce ledger (shared-pot DAO plan P-010; D-025, D-028).
 *
 * The ledger is an append-only stream of typed facts — products, offers, orders,
 * entitlements, refunds, payouts — folded by a deterministic reducer. Nothing in
 * here knows which payment provider produced a fact: a provider adapter (see
 * `webhook-inbox.ts` and `payment-adapters/*`) normalizes its webhooks into these
 * events, and the reducer enforces the invariants that make an entitlement
 * trustworthy regardless of provider:
 *
 *   - an entitlement exists only because an order reached `paid`;
 *   - a refund never exceeds what was paid, and a FULL refund revokes the
 *     entitlement while a partial one leaves it active;
 *   - every fact is idempotent by `ledgerEventId`, and two different facts
 *     claiming the same id are quarantined rather than silently merged;
 *   - money is integer minor units + ISO-4217 currency, never a float.
 *
 * Like `p2p/commerce-events.ts` this module is pure: persistence (the Cupboard
 * D1 tables) and transport (the webhook inbox) are separate layers.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export interface Money {
  /** Integer amount in the currency's minor unit (cents for USD). */
  readonly amountMinor: number;
  /** ISO-4217 code, upper case. */
  readonly currency: string;
}

export const PRICING_MODELS = ['free', 'one-time', 'subscription', 'per-use'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export interface Product {
  readonly productId: string;
  /** Opaque provider-neutral SKU reference (matches the catalog's `sku_ref`, D-028). */
  readonly skuRef: string;
  readonly creatorId: string;
  readonly title: string;
  readonly active: boolean;
}

/**
 * Terms that make a `per-use` offer executable on the P2P microcharge rail.
 *
 * The unit price is a safe integer at the JSON/D1 boundary and is converted to
 * bigint by the microcharge path before arithmetic. The remaining fields are
 * signed into every cumulative voucher, so changing any of them is a new price
 * version rather than a mutable display-only edit.
 */
export interface PerUseOfferTerms {
  readonly unitPriceMicros: number;
  readonly meterUnit: string;
  readonly priceVersion: string;
  readonly splitManifestHash: string;
}

export interface Offer {
  readonly offerId: string;
  readonly productId: string;
  readonly pricingModel: PricingModel;
  readonly price: Money;
  /** Present only for `pricingModel: 'per-use'`. */
  readonly perUse?: PerUseOfferTerms | null;
  readonly active: boolean;
}

export type OrderState = 'pending' | 'paid' | 'failed' | 'canceled' | 'partially-refunded' | 'refunded';

export interface Order {
  readonly orderId: string;
  readonly offerId: string;
  readonly productId: string;
  readonly buyerId: string;
  readonly amount: Money;
  readonly state: OrderState;
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly refundedMinor: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type EntitlementState = 'active' | 'revoked';

export interface Entitlement {
  readonly entitlementId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly buyerId: string;
  readonly state: EntitlementState;
  readonly grantedAtMs: number;
  readonly revokedAtMs: number | null;
  readonly revokeReason: string | null;
}

export type RefundState = 'pending' | 'succeeded' | 'failed';

export interface Refund {
  readonly refundId: string;
  readonly orderId: string;
  readonly amount: Money;
  readonly state: RefundState;
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type PayoutState = 'pending' | 'paid' | 'failed';

export interface Payout {
  readonly payoutId: string;
  readonly creatorId: string;
  readonly amount: Money;
  readonly state: PayoutState;
  readonly provider: string | null;
  readonly providerRef: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export const LEDGER_EVENT_KINDS = [
  'product.defined',
  'offer.defined',
  'order.created',
  'order.paid',
  'order.failed',
  'order.canceled',
  'refund.requested',
  'refund.succeeded',
  'refund.failed',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'entitlement.revoked',
] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

export interface LedgerEventSource {
  /** `stripe`, `p2p`, `operator`, … — informational; the reducer never branches on it. */
  readonly provider: string;
  /** The provider's own event id when the fact came from a webhook, else null. */
  readonly providerEventId: string | null;
}

export interface LedgerEvent {
  readonly ledgerEventId: string;
  readonly kind: LedgerEventKind;
  readonly occurredAtMs: number;
  readonly source: LedgerEventSource;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type LedgerRejectionCode =
  | 'invalid-event'
  | 'invalid-money'
  | 'unknown-product'
  | 'unknown-offer'
  | 'inactive-offer'
  | 'unknown-order'
  | 'unknown-refund'
  | 'unknown-payout'
  | 'unknown-entitlement'
  | 'currency-mismatch'
  | 'amount-mismatch'
  | 'refund-exceeds-order'
  | 'invalid-transition'
  | 'duplicate-conflict';

export interface LedgerRejection {
  readonly ledgerEventId: string;
  readonly kind: string;
  readonly code: LedgerRejectionCode;
  readonly detail: string;
}

export interface LedgerState {
  readonly products: Map<string, Product>;
  readonly offers: Map<string, Offer>;
  readonly orders: Map<string, Order>;
  readonly entitlements: Map<string, Entitlement>;
  readonly refunds: Map<string, Refund>;
  readonly payouts: Map<string, Payout>;
  /** Event ids applied, in fold order. */
  readonly applied: string[];
  /** Exact replays (same id, same bytes) — harmless. */
  readonly duplicates: string[];
  readonly rejected: LedgerRejection[];
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const SPLIT_MANIFEST_HASH_RE = /^sha256:[0-9a-f]{64}$/i;

export function isMoney(value: unknown): value is Money {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Partial<Money>;
  return Number.isSafeInteger(m.amountMinor) && (m.amountMinor as number) >= 0 && typeof m.currency === 'string' && CURRENCY_RE.test(m.currency);
}

export function moneyEquals(a: Money, b: Money): boolean {
  return a.amountMinor === b.amountMinor && a.currency === b.currency;
}

function perUseTerms(value: unknown): PerUseOfferTerms | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const terms = value as Partial<PerUseOfferTerms>;
  if (!Number.isSafeInteger(terms.unitPriceMicros) || (terms.unitPriceMicros as number) <= 0) return null;
  if (typeof terms.meterUnit !== 'string' || !terms.meterUnit.trim()) return null;
  if (typeof terms.priceVersion !== 'string' || !terms.priceVersion.trim()) return null;
  if (typeof terms.splitManifestHash !== 'string' || !SPLIT_MANIFEST_HASH_RE.test(terms.splitManifestHash)) {
    return null;
  }
  return {
    unitPriceMicros: terms.unitPriceMicros as number,
    meterUnit: terms.meterUnit,
    priceVersion: terms.priceVersion,
    splitManifestHash: terms.splitManifestHash.toLowerCase(),
  };
}

/** The entitlement an order grants is addressed by the order, so a replayed `order.paid` can never mint a second one. */
export function entitlementIdFor(orderId: string): string {
  return `ent:${orderId}`;
}

export function ledgerEventDigest(event: LedgerEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

export type LedgerEventValidation = { ok: true; event: LedgerEvent } | { ok: false; code: 'invalid-event'; detail: string };

export function validateLedgerEvent(raw: unknown): LedgerEventValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, code: 'invalid-event', detail: 'event must be an object' };
  const e = raw as Partial<LedgerEvent>;
  if (typeof e.ledgerEventId !== 'string' || !e.ledgerEventId.trim()) return { ok: false, code: 'invalid-event', detail: 'ledgerEventId is required' };
  if (!LEDGER_EVENT_KINDS.includes(e.kind as LedgerEventKind)) return { ok: false, code: 'invalid-event', detail: `unsupported ledger event kind '${String(e.kind)}'` };
  if (!Number.isFinite(e.occurredAtMs) || (e.occurredAtMs as number) < 0) return { ok: false, code: 'invalid-event', detail: 'occurredAtMs must be a non-negative finite number' };
  if (!e.source || typeof e.source !== 'object' || typeof e.source.provider !== 'string' || !e.source.provider.trim()) return { ok: false, code: 'invalid-event', detail: 'source.provider is required' };
  if (e.source.providerEventId !== null && typeof e.source.providerEventId !== 'string') return { ok: false, code: 'invalid-event', detail: 'source.providerEventId must be a string or null' };
  if (!e.payload || typeof e.payload !== 'object' || Array.isArray(e.payload)) return { ok: false, code: 'invalid-event', detail: 'payload must be an object' };
  return { ok: true, event: e as LedgerEvent };
}

function str(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * Minor units already RESERVED against an order by refunds that are requested but
 * not yet settled. Capacity for a NEW request is settled + reserved, not settled
 * alone — checking against settlement only is the classic reservation bug, and it
 * moves the refusal from request time (actionable: "that order already has a full
 * refund in flight") to settlement time (a refund an operator already promised a
 * customer, now permanently unsettleable). `refund.failed` releases the
 * reservation for free by moving the refund out of `pending`.
 */
function pendingRefundMinorFor(state: LedgerState, orderId: string): number {
  let pending = 0;
  for (const refund of state.refunds.values()) {
    if (refund.orderId === orderId && refund.state === 'pending') pending += refund.amount.amountMinor;
  }
  return pending;
}

function emptyState(): LedgerState {
  return { products: new Map(), offers: new Map(), orders: new Map(), entitlements: new Map(), refunds: new Map(), payouts: new Map(), applied: [], duplicates: [], rejected: [] };
}

type ApplyResult = { ok: true } | { ok: false; code: LedgerRejectionCode; detail: string };

function applyEvent(state: LedgerState, event: LedgerEvent): ApplyResult {
  const p = event.payload;
  const at = event.occurredAtMs;
  const provider = event.source.provider;
  switch (event.kind) {
    case 'product.defined': {
      const productId = str(p, 'productId');
      const skuRef = str(p, 'skuRef');
      const creatorId = str(p, 'creatorId');
      const title = str(p, 'title');
      if (!productId || !skuRef || !creatorId || !title) return { ok: false, code: 'invalid-event', detail: 'product.defined needs productId, skuRef, creatorId, title' };
      state.products.set(productId, { productId, skuRef, creatorId, title, active: p.active !== false });
      return { ok: true };
    }
    case 'offer.defined': {
      const offerId = str(p, 'offerId');
      const productId = str(p, 'productId');
      const pricingModel = p.pricingModel as PricingModel;
      if (!offerId || !productId || !PRICING_MODELS.includes(pricingModel)) return { ok: false, code: 'invalid-event', detail: 'offer.defined needs offerId, productId, pricingModel' };
      if (!isMoney(p.price)) return { ok: false, code: 'invalid-money', detail: 'offer.defined price must be integer minor units + ISO-4217 currency' };
      if (!state.products.has(productId)) return { ok: false, code: 'unknown-product', detail: `product ${productId} is not defined` };
      if (pricingModel === 'free' && p.price.amountMinor !== 0) return { ok: false, code: 'amount-mismatch', detail: 'a free offer must price at 0' };
      const terms = pricingModel === 'per-use' ? perUseTerms(p.perUse) : null;
      if (pricingModel === 'per-use' && !terms) {
        return {
          ok: false,
          code: 'invalid-event',
          detail:
            'a per-use offer needs positive unitPriceMicros, meterUnit, priceVersion, and a sha256 splitManifestHash',
        };
      }
      if (pricingModel !== 'per-use' && p.perUse != null) {
        return { ok: false, code: 'invalid-event', detail: 'perUse terms are only valid for a per-use offer' };
      }
      state.offers.set(offerId, {
        offerId,
        productId,
        pricingModel,
        price: p.price,
        perUse: terms,
        active: p.active !== false,
      });
      return { ok: true };
    }
    case 'order.created': {
      const orderId = str(p, 'orderId');
      const offerId = str(p, 'offerId');
      const buyerId = str(p, 'buyerId');
      if (!orderId || !offerId || !buyerId) return { ok: false, code: 'invalid-event', detail: 'order.created needs orderId, offerId, buyerId' };
      const offer = state.offers.get(offerId);
      if (!offer) return { ok: false, code: 'unknown-offer', detail: `offer ${offerId} is not defined` };
      if (!offer.active) return { ok: false, code: 'inactive-offer', detail: `offer ${offerId} is inactive` };
      if (p.amount !== undefined) {
        if (!isMoney(p.amount)) return { ok: false, code: 'invalid-money', detail: 'order.created amount must be integer minor units + ISO-4217 currency' };
        if (p.amount.currency !== offer.price.currency) return { ok: false, code: 'currency-mismatch', detail: `order currency ${p.amount.currency} != offer currency ${offer.price.currency}` };
        if (p.amount.amountMinor !== offer.price.amountMinor) return { ok: false, code: 'amount-mismatch', detail: `order amount ${p.amount.amountMinor} != offer price ${offer.price.amountMinor}` };
      }
      const existing = state.orders.get(orderId);
      if (existing) return { ok: false, code: 'invalid-transition', detail: `order ${orderId} already exists in state ${existing.state}` };
      state.orders.set(orderId, { orderId, offerId, productId: offer.productId, buyerId, amount: offer.price, state: 'pending', provider, providerRef: str(p, 'providerRef'), refundedMinor: 0, createdAtMs: at, updatedAtMs: at });
      return { ok: true };
    }
    case 'order.paid': {
      const orderId = str(p, 'orderId');
      if (!orderId) return { ok: false, code: 'invalid-event', detail: 'order.paid needs orderId' };
      const order = state.orders.get(orderId);
      if (!order) return { ok: false, code: 'unknown-order', detail: `order ${orderId} is not known to the ledger` };
      if (p.amount !== undefined) {
        if (!isMoney(p.amount)) return { ok: false, code: 'invalid-money', detail: 'order.paid amount must be integer minor units + ISO-4217 currency' };
        if (p.amount.currency !== order.amount.currency) return { ok: false, code: 'currency-mismatch', detail: `paid currency ${p.amount.currency} != order currency ${order.amount.currency}` };
        if (p.amount.amountMinor !== order.amount.amountMinor) return { ok: false, code: 'amount-mismatch', detail: `paid ${p.amount.amountMinor} != order amount ${order.amount.amountMinor}` };
      }
      if (order.state === 'paid') return { ok: true }; // a second provider announcement of the same payment is a no-op, not a second entitlement
      if (order.state !== 'pending') return { ok: false, code: 'invalid-transition', detail: `order ${orderId} cannot move ${order.state} -> paid` };
      state.orders.set(orderId, { ...order, state: 'paid', provider, providerRef: str(p, 'providerRef') ?? order.providerRef, updatedAtMs: at });
      const entitlementId = entitlementIdFor(orderId);
      if (!state.entitlements.has(entitlementId)) {
        state.entitlements.set(entitlementId, { entitlementId, orderId, productId: order.productId, buyerId: order.buyerId, state: 'active', grantedAtMs: at, revokedAtMs: null, revokeReason: null });
      }
      return { ok: true };
    }
    case 'order.failed':
    case 'order.canceled': {
      const orderId = str(p, 'orderId');
      if (!orderId) return { ok: false, code: 'invalid-event', detail: `${event.kind} needs orderId` };
      const order = state.orders.get(orderId);
      if (!order) return { ok: false, code: 'unknown-order', detail: `order ${orderId} is not known to the ledger` };
      const next: OrderState = event.kind === 'order.failed' ? 'failed' : 'canceled';
      if (order.state === next) return { ok: true };
      if (order.state !== 'pending') return { ok: false, code: 'invalid-transition', detail: `order ${orderId} cannot move ${order.state} -> ${next}` };
      state.orders.set(orderId, { ...order, state: next, updatedAtMs: at });
      return { ok: true };
    }
    case 'refund.requested':
    case 'refund.succeeded': {
      const refundId = str(p, 'refundId');
      if (!refundId) return { ok: false, code: 'invalid-event', detail: `${event.kind} needs refundId` };
      const prior = state.refunds.get(refundId);
      const orderId = str(p, 'orderId') ?? prior?.orderId ?? null;
      if (!orderId) return { ok: false, code: 'invalid-event', detail: `${event.kind} needs orderId` };
      const order = state.orders.get(orderId);
      if (!order) return { ok: false, code: 'unknown-order', detail: `order ${orderId} is not known to the ledger` };
      const amountRaw = p.amount !== undefined ? p.amount : prior?.amount;
      if (!isMoney(amountRaw)) return { ok: false, code: 'invalid-money', detail: `${event.kind} amount must be integer minor units + ISO-4217 currency` };
      const amount = amountRaw;
      if (amount.currency !== order.amount.currency) return { ok: false, code: 'currency-mismatch', detail: `refund currency ${amount.currency} != order currency ${order.amount.currency}` };
      if (event.kind === 'refund.requested') {
        if (prior) return { ok: false, code: 'invalid-transition', detail: `refund ${refundId} already exists in state ${prior.state}` };
        if (order.state !== 'paid' && order.state !== 'partially-refunded') return { ok: false, code: 'invalid-transition', detail: `order ${orderId} in state ${order.state} cannot be refunded` };
        const reserved = pendingRefundMinorFor(state, orderId);
        if (order.refundedMinor + reserved + amount.amountMinor > order.amount.amountMinor) return { ok: false, code: 'refund-exceeds-order', detail: `refund ${amount.amountMinor} + already refunded ${order.refundedMinor} + ${reserved} pending exceeds paid ${order.amount.amountMinor}` };
        state.refunds.set(refundId, { refundId, orderId, amount, state: 'pending', provider, providerRef: str(p, 'providerRef'), createdAtMs: at, updatedAtMs: at });
        return { ok: true };
      }
      // refund.succeeded — may arrive without a prior request (a provider-side refund)
      if (prior?.state === 'succeeded') return { ok: true };
      if (prior && prior.state !== 'pending') return { ok: false, code: 'invalid-transition', detail: `refund ${refundId} cannot move ${prior.state} -> succeeded` };
      if (order.state !== 'paid' && order.state !== 'partially-refunded') return { ok: false, code: 'invalid-transition', detail: `order ${orderId} in state ${order.state} cannot be refunded` };
      if (order.refundedMinor + amount.amountMinor > order.amount.amountMinor) return { ok: false, code: 'refund-exceeds-order', detail: `refund ${amount.amountMinor} + already refunded ${order.refundedMinor} exceeds paid ${order.amount.amountMinor}` };
      const refundedMinor = order.refundedMinor + amount.amountMinor;
      const full = refundedMinor === order.amount.amountMinor;
      state.refunds.set(refundId, { refundId, orderId, amount, state: 'succeeded', provider, providerRef: str(p, 'providerRef') ?? prior?.providerRef ?? null, createdAtMs: prior?.createdAtMs ?? at, updatedAtMs: at });
      state.orders.set(orderId, { ...order, state: full ? 'refunded' : 'partially-refunded', refundedMinor, updatedAtMs: at });
      if (full) {
        const entitlementId = entitlementIdFor(orderId);
        const ent = state.entitlements.get(entitlementId);
        if (ent && ent.state === 'active') state.entitlements.set(entitlementId, { ...ent, state: 'revoked', revokedAtMs: at, revokeReason: 'refunded' });
      }
      return { ok: true };
    }
    case 'refund.failed': {
      const refundId = str(p, 'refundId');
      if (!refundId) return { ok: false, code: 'invalid-event', detail: 'refund.failed needs refundId' };
      const refund = state.refunds.get(refundId);
      if (!refund) return { ok: false, code: 'unknown-refund', detail: `refund ${refundId} is not known to the ledger` };
      if (refund.state === 'failed') return { ok: true };
      if (refund.state !== 'pending') return { ok: false, code: 'invalid-transition', detail: `refund ${refundId} cannot move ${refund.state} -> failed` };
      state.refunds.set(refundId, { ...refund, state: 'failed', updatedAtMs: at });
      return { ok: true };
    }
    case 'payout.created': {
      const payoutId = str(p, 'payoutId');
      const creatorId = str(p, 'creatorId');
      if (!payoutId || !creatorId) return { ok: false, code: 'invalid-event', detail: 'payout.created needs payoutId, creatorId' };
      if (!isMoney(p.amount)) return { ok: false, code: 'invalid-money', detail: 'payout.created amount must be integer minor units + ISO-4217 currency' };
      const existing = state.payouts.get(payoutId);
      if (existing) return moneyEquals(existing.amount, p.amount) && existing.creatorId === creatorId ? { ok: true } : { ok: false, code: 'invalid-transition', detail: `payout ${payoutId} already exists with different terms` };
      state.payouts.set(payoutId, { payoutId, creatorId, amount: p.amount, state: 'pending', provider, providerRef: str(p, 'providerRef'), createdAtMs: at, updatedAtMs: at });
      return { ok: true };
    }
    case 'payout.paid':
    case 'payout.failed': {
      const payoutId = str(p, 'payoutId');
      if (!payoutId) return { ok: false, code: 'invalid-event', detail: `${event.kind} needs payoutId` };
      const payout = state.payouts.get(payoutId);
      if (!payout) return { ok: false, code: 'unknown-payout', detail: `payout ${payoutId} is not known to the ledger` };
      const next: PayoutState = event.kind === 'payout.paid' ? 'paid' : 'failed';
      if (payout.state === next) return { ok: true };
      if (payout.state !== 'pending') return { ok: false, code: 'invalid-transition', detail: `payout ${payoutId} cannot move ${payout.state} -> ${next}` };
      state.payouts.set(payoutId, { ...payout, state: next, providerRef: str(p, 'providerRef') ?? payout.providerRef, updatedAtMs: at });
      return { ok: true };
    }
    case 'entitlement.revoked': {
      const entitlementId = str(p, 'entitlementId');
      if (!entitlementId) return { ok: false, code: 'invalid-event', detail: 'entitlement.revoked needs entitlementId' };
      const ent = state.entitlements.get(entitlementId);
      if (!ent) return { ok: false, code: 'unknown-entitlement', detail: `entitlement ${entitlementId} is not known to the ledger` };
      if (ent.state === 'revoked') return { ok: true };
      state.entitlements.set(entitlementId, { ...ent, state: 'revoked', revokedAtMs: at, revokeReason: str(p, 'reason') ?? 'revoked' });
      return { ok: true };
    }
    default:
      return { ok: false, code: 'invalid-event', detail: `unhandled kind ${String((event as LedgerEvent).kind)}` };
  }
}

/**
 * Deterministically fold an unordered batch of ledger events. The fold order is
 * (occurredAtMs, ledgerEventId); exact replays are reported as duplicates and two
 * different facts under one id are rejected (`duplicate-conflict`) so a forged or
 * corrupted replay can never rewrite history.
 */
export function reduceLedger(events: readonly unknown[]): LedgerState {
  const state = emptyState();
  const valid: LedgerEvent[] = [];
  for (const raw of events) {
    const v = validateLedgerEvent(raw);
    if (v.ok) valid.push(v.event);
    else state.rejected.push({ ledgerEventId: raw && typeof raw === 'object' && typeof (raw as { ledgerEventId?: unknown }).ledgerEventId === 'string' ? (raw as { ledgerEventId: string }).ledgerEventId : '', kind: raw && typeof raw === 'object' ? String((raw as { kind?: unknown }).kind ?? '') : '', code: v.code, detail: v.detail });
  }
  valid.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.ledgerEventId.localeCompare(b.ledgerEventId));
  const seen = new Map<string, string>();
  for (const event of valid) {
    const digest = ledgerEventDigest(event);
    const priorDigest = seen.get(event.ledgerEventId);
    if (priorDigest !== undefined) {
      if (priorDigest === digest) state.duplicates.push(event.ledgerEventId);
      else state.rejected.push({ ledgerEventId: event.ledgerEventId, kind: event.kind, code: 'duplicate-conflict', detail: 'a different fact already carries this ledgerEventId' });
      continue;
    }
    seen.set(event.ledgerEventId, digest);
    const result = applyEvent(state, event);
    if (result.ok) state.applied.push(event.ledgerEventId);
    else state.rejected.push({ ledgerEventId: event.ledgerEventId, kind: event.kind, code: result.code, detail: result.detail });
  }
  return state;
}

/** Plain, sorted arrays for persistence or transport. */
export function serializeLedgerState(state: LedgerState): {
  products: Product[]; offers: Offer[]; orders: Order[]; entitlements: Entitlement[]; refunds: Refund[]; payouts: Payout[];
} {
  const byKey = <T>(m: Map<string, T>): T[] => [...m.keys()].sort().map((k) => m.get(k) as T);
  return { products: byKey(state.products), offers: byKey(state.offers), orders: byKey(state.orders), entitlements: byKey(state.entitlements), refunds: byKey(state.refunds), payouts: byKey(state.payouts) };
}

/** Does `buyerId` hold an active entitlement for `productId`? The delivery gate (P-009) asks exactly this. */
export function hasActiveEntitlement(state: LedgerState, buyerId: string, productId: string): boolean {
  for (const ent of state.entitlements.values()) {
    if (ent.buyerId === buyerId && ent.productId === productId && ent.state === 'active') return true;
  }
  return false;
}
