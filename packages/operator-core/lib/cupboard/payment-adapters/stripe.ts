/**
 * Stripe — the first `PaymentProviderAdapter` (P-010).
 *
 * Deliberately SDK-free: webhook signature verification is Stripe's documented
 * scheme (HMAC-SHA256 over `${t}.${rawBody}` with the endpoint secret, `v1=`
 * signatures in the `Stripe-Signature` header, a timestamp tolerance), and event
 * normalization reads the documented event/object shapes. Nothing outside this
 * file knows a Stripe field name; the ledger sees provider-neutral events whose
 * `source.provider` is `'stripe'`.
 *
 * Order identity crosses the provider boundary through Checkout Session
 * `client_reference_id` / `metadata.orderId` (set by `buildStripeCheckoutSessionParams`)
 * and is propagated by Stripe onto the PaymentIntent/Charge metadata.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { LedgerEvent, Money, Offer, Order, Product } from '../commerce-ledger';
import { headerLookup, type NormalizeVerdict, type PaymentProviderAdapter, type SignatureVerdict, type WebhookRequest } from '../webhook-inbox';

export const STRIPE_PROVIDER = 'stripe';
export const STRIPE_SIGNATURE_HEADER = 'stripe-signature';
export const STRIPE_DEFAULT_TOLERANCE_SEC = 300;

export interface StripeAdapterOptions {
  /** The endpoint's signing secret (`whsec_…`). Never a tree file — injected config. */
  readonly webhookSecret: string;
  /** Max |now − t| accepted, in seconds (Stripe's own default is 300). */
  readonly toleranceSec?: number;
}

export function parseStripeSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      timestamp = n;
    } else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function computeStripeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
}

function verifyStripeSignature(options: StripeAdapterOptions, request: WebhookRequest): SignatureVerdict {
  if (!options.webhookSecret) return { ok: false, code: 'missing-secret', detail: 'stripe webhook secret is not configured' };
  const header = headerLookup(request.headers, STRIPE_SIGNATURE_HEADER);
  if (!header) return { ok: false, code: 'missing-signature', detail: `${STRIPE_SIGNATURE_HEADER} header is absent` };
  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return { ok: false, code: 'malformed-signature', detail: `${STRIPE_SIGNATURE_HEADER} header lacks t= or a v1= signature` };
  const expected = Buffer.from(computeStripeSignature(options.webhookSecret, parsed.timestamp, request.rawBody), 'hex');
  const matched = parsed.signatures.some((s) => {
    const candidate = Buffer.from(s, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!matched) return { ok: false, code: 'bad-signature', detail: 'no v1 signature matches the endpoint secret' };
  const tolerance = options.toleranceSec ?? STRIPE_DEFAULT_TOLERANCE_SEC;
  if (Math.abs(Math.floor(request.nowMs / 1000) - parsed.timestamp) > tolerance) return { ok: false, code: 'stale-timestamp', detail: `signature timestamp is outside the ${tolerance}s tolerance` };
  return { ok: true };
}

interface StripeEventShape {
  id?: unknown;
  type?: unknown;
  created?: unknown;
  data?: { object?: unknown };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (o: Obj, key: string): string | null => (typeof o[key] === 'string' && (o[key] as string).trim() ? (o[key] as string) : null);
const metadata = (o: Obj): Obj => (isObj(o.metadata) ? o.metadata : {});

function money(o: Obj, amountKey: string): Money | null {
  const amount = o[amountKey];
  const currency = o.currency;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) return null;
  return { amountMinor: amount as number, currency: currency.toUpperCase() };
}

function orderRef(o: Obj): string | null {
  return s(metadata(o), 'orderId') ?? s(o, 'client_reference_id');
}

function normalizeStripeEvent(rawBody: string): NormalizeVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: 'malformed-body', detail: 'body is not JSON', providerEventId: null };
  }
  if (!isObj(parsed)) return { ok: false, code: 'malformed-body', detail: 'event must be an object', providerEventId: null };
  const evt = parsed as StripeEventShape;
  const id = typeof evt.id === 'string' && evt.id.trim() ? evt.id : null;
  const type = typeof evt.type === 'string' ? evt.type : null;
  const created = typeof evt.created === 'number' && Number.isFinite(evt.created) && evt.created >= 0 ? evt.created : null;
  const object = evt.data && isObj(evt.data.object) ? evt.data.object : null;
  if (!id || !type || created === null || !object) return { ok: false, code: 'malformed-body', detail: 'event needs id, type, created and data.object', providerEventId: id };
  const occurredAtMs = created * 1000;
  const source = { provider: STRIPE_PROVIDER, providerEventId: id } as const;
  const events: LedgerEvent[] = [];
  const emit = (kind: LedgerEvent['kind'], payload: Record<string, unknown>) => {
    events.push({ ledgerEventId: `stripe:${id}:${events.length}`, kind, occurredAtMs, source, payload });
  };
  const missingOrder = (): NormalizeVerdict => ({ ok: false, code: 'missing-order-ref', detail: `${type} carries no metadata.orderId / client_reference_id`, providerEventId: id });
  const invalidAmount = (): NormalizeVerdict => ({ ok: false, code: 'invalid-amount', detail: `${type} amount/currency is not an integer minor-unit amount`, providerEventId: id });

  switch (type) {
    case 'checkout.session.completed': {
      if (object.payment_status !== 'paid') break; // async payment methods complete later via checkout.session.async_payment_succeeded
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, 'amount_total');
      if (!amount) return invalidAmount();
      emit('order.paid', { orderId, amount, providerRef: s(object, 'payment_intent') ?? s(object, 'id') });
      break;
    }
    case 'checkout.session.async_payment_succeeded': {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, 'amount_total');
      if (!amount) return invalidAmount();
      emit('order.paid', { orderId, amount, providerRef: s(object, 'payment_intent') ?? s(object, 'id') });
      break;
    }
    case 'checkout.session.async_payment_failed':
    case 'payment_intent.payment_failed': {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      emit('order.failed', { orderId, providerRef: s(object, 'id') });
      break;
    }
    case 'checkout.session.expired': {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      emit('order.canceled', { orderId, providerRef: s(object, 'id') });
      break;
    }
    case 'charge.refunded': {
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const refundsList = isObj(object.refunds) && Array.isArray(object.refunds.data) ? (object.refunds.data as unknown[]) : null;
      if (refundsList && refundsList.length) {
        for (const r of refundsList) {
          if (!isObj(r)) continue;
          if (r.status !== 'succeeded') continue;
          const refundId = s(r, 'id');
          const amount = money(r, 'amount');
          if (!refundId || !amount) return invalidAmount();
          emit('refund.succeeded', { refundId, orderId, amount, providerRef: refundId });
        }
      } else {
        const amount = money(object, 'amount_refunded');
        const chargeId = s(object, 'id');
        if (!amount || !chargeId) return invalidAmount();
        emit('refund.succeeded', { refundId: `${chargeId}:refund`, orderId, amount, providerRef: chargeId });
      }
      break;
    }
    case 'charge.refund.updated':
    case 'refund.updated':
    case 'refund.failed': {
      const refundId = s(object, 'id');
      if (!refundId) return { ok: false, code: 'malformed-body', detail: `${type} refund object has no id`, providerEventId: id };
      const orderId = orderRef(object);
      const status = object.status;
      if (status === 'failed' || status === 'canceled') emit('refund.failed', { refundId, ...(orderId ? { orderId } : {}) });
      else if (status === 'succeeded') {
        if (!orderId) return missingOrder();
        const amount = money(object, 'amount');
        if (!amount) return invalidAmount();
        emit('refund.succeeded', { refundId, orderId, amount, providerRef: refundId });
      }
      break;
    }
    case 'charge.dispute.created':
    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      const disputeId = s(object, 'id');
      if (!disputeId) {
        return {
          ok: false,
          code: 'malformed-body',
          detail: `${type} dispute object has no id`,
          providerEventId: id,
        };
      }
      // Only a funds-withdrawn/open/lost dispute reverses credits. A won or
      // warning-needs-response update is authenticated and recorded by the
      // webhook inbox, but does not move money.
      const status = s(object, 'status');
      const reverses =
        type === 'charge.dispute.created' ||
        type === 'charge.dispute.funds_withdrawn' ||
        status === 'lost';
      if (!reverses) break;
      const orderId = orderRef(object);
      if (!orderId) return missingOrder();
      const amount = money(object, 'amount');
      if (!amount) return invalidAmount();
      emit('refund.succeeded', {
        refundId: `dispute:${disputeId}`,
        orderId,
        amount,
        providerRef: disputeId,
        reversalReason: 'chargeback',
      });
      break;
    }
    case 'payout.created':
    case 'payout.paid':
    case 'payout.failed': {
      const payoutId = s(object, 'id');
      const creatorId = s(metadata(object), 'creatorId') ?? s(object, 'destination');
      const amount = money(object, 'amount');
      if (!payoutId) return { ok: false, code: 'malformed-body', detail: `${type} payout object has no id`, providerEventId: id };
      if (!amount) return invalidAmount();
      if (type === 'payout.created') {
        if (!creatorId) return { ok: false, code: 'missing-order-ref', detail: 'payout.created carries no metadata.creatorId / destination', providerEventId: id };
        emit('payout.created', { payoutId, creatorId, amount, providerRef: payoutId });
      } else emit(type === 'payout.paid' ? 'payout.paid' : 'payout.failed', { payoutId, providerRef: payoutId });
      break;
    }
    default:
      break; // authenticated but irrelevant → ignored by the inbox
  }
  return { ok: true, webhook: { providerEventId: id, providerEventType: type, occurredAtMs, events } };
}

export function createStripeAdapter(options: StripeAdapterOptions): PaymentProviderAdapter {
  return {
    provider: STRIPE_PROVIDER,
    verifySignature: (request) => verifyStripeSignature(options, request),
    normalize: (rawBody) => normalizeStripeEvent(rawBody),
  };
}

/**
 * The provider-neutral order → Stripe Checkout Session request. A pure object the
 * caller posts to `/v1/checkout/sessions`; the order id rides in
 * `client_reference_id` + metadata so every later webhook can be mapped back.
 */
export type StripeCheckoutBuild =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; code: 'unsupported-pricing-model' | 'amount-mismatch' | 'zero-amount'; detail: string };

export function buildStripeCheckoutSessionParams(input: { order: Order; offer: Offer; product: Product; successUrl: string; cancelUrl: string }): StripeCheckoutBuild {
  const { order, offer, product } = input;
  if (offer.pricingModel === 'free' || offer.pricingModel === 'per-use') return { ok: false, code: 'unsupported-pricing-model', detail: `${offer.pricingModel} offers do not go through Checkout` };
  if (order.amount.amountMinor !== offer.price.amountMinor || order.amount.currency !== offer.price.currency) return { ok: false, code: 'amount-mismatch', detail: 'order amount differs from the offer price' };
  if (order.amount.amountMinor === 0) return { ok: false, code: 'zero-amount', detail: 'Checkout requires a positive amount' };
  const purchaseMetadata = {
    orderId: order.orderId,
    offerId: offer.offerId,
    productId: product.productId,
    buyerId: order.buyerId,
    skuRef: product.skuRef,
  };
  const priceData: Record<string, unknown> = {
    currency: order.amount.currency.toLowerCase(),
    unit_amount: order.amount.amountMinor,
    product_data: { name: product.title, metadata: { skuRef: product.skuRef, productId: product.productId } },
  };
  if (offer.pricingModel === 'subscription') priceData.recurring = { interval: 'month' };
  return {
    ok: true,
    params: {
      mode: offer.pricingModel === 'subscription' ? 'subscription' : 'payment',
      client_reference_id: order.orderId,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      line_items: [{ quantity: 1, price_data: priceData }],
      // Stripe enables Managed Payments by default on new accounts, and under it
      // EVERY line item must carry a product tax code — which an ad-hoc
      // `price_data` product cannot have, so the account default alone made every
      // Checkout Session here a hard 400 ("the product tax code is missing").
      // Measured against the live test-mode account 2026-09-06 (P-038).
      //
      // Disabling it is the CORRECT answer, not merely the smaller one: under
      // Managed Payments Stripe becomes merchant of record and owns settlement,
      // which is precisely what this system does NOT want — the DAO's own split
      // manifest and settlement batches (P-033/P-034) distribute the proceeds, and
      // that only works on a direct charge into our own balance. Setting some tax
      // code instead would have silently handed payouts to a different rail.
      managed_payments: { enabled: false },
      metadata: purchaseMetadata,
      // Charges/disputes are downstream of the PaymentIntent, not the Checkout
      // Session. Copy the complete purchase identity so a chargeback can still
      // resolve the principal and top-up SKU without an address inference.
      payment_intent_data: offer.pricingModel === 'one-time' ? { metadata: purchaseMetadata } : undefined,
    },
  };
}

export const STRIPE_CHECKOUT_SESSIONS_URL = 'https://api.stripe.com/v1/checkout/sessions';

/**
 * Flatten a Checkout params object into Stripe's form encoding.
 *
 * Stripe's REST API is `application/x-www-form-urlencoded`, NOT JSON — nested
 * structures travel as bracket paths (`line_items[0][price_data][currency]`).
 * Posting `JSON.stringify(params)` is accepted by the transport and then
 * rejected as a malformed request, which is why this lives beside the builder
 * rather than being improvised at the call site.
 *
 * `undefined` and `null` members are DROPPED, not encoded as the strings
 * "undefined"/"null": `buildStripeCheckoutSessionParams` leaves
 * `payment_intent_data` undefined for non-one-time offers, and sending that
 * literal would be a Stripe 400.
 */
export function encodeStripeFormParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(`${prefix}[${index}]`, entry));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) walk(`${prefix}[${key}]`, inner);
      return;
    }
    out.append(prefix, String(value));
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return out;
}

export type StripeCheckoutSessionResult =
  | { ok: true; sessionId: string; url: string }
  | { ok: false; code: 'provider-error' | 'malformed-response'; status: number | null; detail: string };

/**
 * POST a built params object to Stripe and return the session handle.
 *
 * `fetchImpl` is injected so a caller can exercise this without network access,
 * and the secret key is a parameter rather than a module-scope global, so a
 * deployment that has not configured one cannot post unauthenticated by default.
 *
 * `idempotencyKey` is forwarded as Stripe's own `Idempotency-Key` header: a
 * retry — ours or a client replay — must not create a SECOND Checkout Session
 * and therefore a second charge. Ledger-side idempotency cannot cover the
 * window between the Stripe call and the ledger append; only the provider can,
 * which is what this header is for.
 */
export async function createStripeCheckoutSession(input: {
  secretKey: string;
  params: Record<string, unknown>;
  fetchImpl: typeof fetch;
  idempotencyKey?: string;
}): Promise<StripeCheckoutSessionResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.secretKey}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey;

  let response: Response;
  try {
    response = await input.fetchImpl(STRIPE_CHECKOUT_SESSIONS_URL, {
      method: 'POST',
      headers,
      body: encodeStripeFormParams(input.params).toString(),
    });
  } catch (err) {
    return { ok: false, code: 'provider-error', status: null, detail: err instanceof Error ? err.message : String(err) };
  }

  const text = await response.text();
  if (!response.ok) {
    // Surface Stripe's own message when it sent one, never the raw body, which
    // echoes the request (including params we would rather not re-emit).
    let detail = `stripe responded ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } };
      if (typeof parsed?.error?.message === 'string') detail = parsed.error.message;
    } catch {
      /* non-JSON error body — keep the status-only detail */
    }
    return { ok: false, code: 'provider-error', status: response.status, detail };
  }

  let parsed: { id?: unknown; url?: unknown };
  try {
    parsed = JSON.parse(text) as { id?: unknown; url?: unknown };
  } catch {
    return { ok: false, code: 'malformed-response', status: response.status, detail: 'stripe response was not JSON' };
  }
  if (typeof parsed.id !== 'string' || !parsed.id) {
    return { ok: false, code: 'malformed-response', status: response.status, detail: 'stripe response carried no session id' };
  }
  if (typeof parsed.url !== 'string' || !parsed.url) {
    return { ok: false, code: 'malformed-response', status: response.status, detail: 'stripe response carried no checkout url' };
  }
  return { ok: true, sessionId: parsed.id, url: parsed.url };
}
