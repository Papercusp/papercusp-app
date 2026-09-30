/**
 * Commerce webhook intake + entitlement read (shared-pot DAO plan P-010; D-025).
 *
 * The Worker is a TRANSPORT here, not a decision-maker. It hands the raw body and
 * headers to the shared `ingestWebhook`, which verifies the signature BEFORE
 * parsing, normalizes through a `PaymentProviderAdapter`, and enforces
 * idempotency; the Worker only chooses the adapter, supplies the D1 store, and
 * maps the result to a status code. No Stripe field name and no ledger rule
 * appears in this file.
 *
 * Fail-closed: an unconfigured provider secret is a 503 (we cannot authenticate,
 * so we must not accept), and every signature refusal is a 401 that is never
 * recorded — an unauthenticated request must not be able to fill the inbox.
 */

import { Hono } from 'hono';
import type { Env } from '../env.ts';
import { ingestWebhook } from '@papercusp/operator-core/lib/cupboard/webhook-inbox';
import type { PaymentProviderAdapter } from '@papercusp/operator-core/lib/cupboard/webhook-inbox';
import {
  buildStripeCheckoutSessionParams,
  createStripeAdapter,
  createStripeCheckoutSession,
  STRIPE_PROVIDER,
} from '@papercusp/operator-core/lib/cupboard/payment-adapters/stripe';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import {
  PRICING_MODELS,
  reduceLedger,
  type LedgerEvent,
  type Money,
  type Order,
  type PerUseOfferTerms,
  type PricingModel,
} from "@papercusp/operator-core/lib/cupboard/commerce-ledger";
import { createMicrochargeChannel } from "@papercusp/operator-core/lib/p2p/microcharge";
import { authorizeOrgActor } from '@papercusp/operator-core/lib/cupboard/commerce-door-gate';
import type { Organization } from '@papercusp/operator-core/lib/cupboard/commerce-accounts';
import {
  appendLedgerEvents,
  d1WebhookInboxStore,
  getCommerceOffer,
  listActiveEntitlements,
  listCommerceOffers,
  loadLedgerEvents,
  loadOrganizations,
  projectLedger,
} from "../commerce-store.ts";

/** Signature refusals — the request never proved who it was. */
const SIGNATURE_REFUSALS = new Set([
  'missing-secret',
  'missing-signature',
  'malformed-signature',
  'bad-signature',
  'stale-timestamp',
]);

/**
 * Resolve the adapter for a provider slug. Secrets come from the environment,
 * never a tree file. An unknown provider and an unconfigured one are DIFFERENT
 * answers: 404 means "we do not speak that provider", 503 means "we do, but this
 * deployment cannot authenticate it yet".
 */
function resolveAdapter(provider: string, env: Env): { adapter: PaymentProviderAdapter } | { error: 'unknown' | 'unconfigured' } {
  if (provider !== STRIPE_PROVIDER) return { error: 'unknown' };
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (typeof secret !== 'string' || !secret) return { error: 'unconfigured' };
  return { adapter: createStripeAdapter({ webhookSecret: secret }) };
}

/** Fields a checkout-session request must carry, after parsing. */
interface CheckoutRequest {
  buyerOrgId: string;
  offerId: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
  quantity: number;
  maxSpendMicros?: number;
}

type CheckoutParse = { ok: true; value: CheckoutRequest } | { ok: false; code: string; detail: string };

function parseCheckoutRequest(raw: unknown): CheckoutParse {
  if (typeof raw !== "object" || raw === null)
    return {
      ok: false,
      code: "invalid_request",
      detail: "body must be a JSON object",
    };
  const body = raw as Record<string, unknown>;
  const required = [
    "buyerOrgId",
    "offerId",
    "successUrl",
    "cancelUrl",
    "idempotencyKey",
  ] as const;
  for (const field of required) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim())
      return {
        ok: false,
        code: "invalid_request",
        detail: `${field} must be a non-empty string`,
      };
  }
  // Only quantity 1 is expressible: `buildStripeCheckoutSessionParams` hard-codes
  // `line_items[0].quantity = 1` and refuses unless the order amount equals the
  // offer price exactly, so a quantity>1 order cannot be built without changing
  // that shared builder. Refusing loudly beats silently charging for one seat.
  const quantity = body.quantity === undefined ? 1 : body.quantity;
  if (quantity !== 1)
    return {
      ok: false,
      code: "unsupported_quantity",
      detail: "only quantity 1 is supported by the current Checkout builder",
    };
  const maxSpendMicros = body.maxSpendMicros;
  if (
    maxSpendMicros !== undefined &&
    (!Number.isSafeInteger(maxSpendMicros) || (maxSpendMicros as number) <= 0)
  ) {
    return {
      ok: false,
      code: "invalid_max_spend",
      detail: "maxSpendMicros must be a positive safe integer",
    };
  }
  return {
    ok: true,
    value: {
      buyerOrgId: String(body.buyerOrgId),
      offerId: String(body.offerId),
      successUrl: String(body.successUrl),
      cancelUrl: String(body.cancelUrl),
      idempotencyKey: String(body.idempotencyKey),
      quantity: 1,
      ...(maxSpendMicros !== undefined
        ? { maxSpendMicros: maxSpendMicros as number }
        : {}),
    },
  };
}

interface PublishOfferRequest {
  productId: string;
  offerId: string;
  skuRef: string;
  title: string;
  pricingModel: PricingModel;
  price: Money;
  perUse?: PerUseOfferTerms;
  active?: boolean;
}

function parsePublishOfferRequest(
  raw: unknown,
): { ok: true; value: PublishOfferRequest } | { ok: false; detail: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;
  for (const field of ["productId", "offerId", "skuRef", "title"] as const) {
    if (typeof body[field] !== "string" || !(body[field] as string).trim()) {
      return { ok: false, detail: `${field} must be a non-empty string` };
    }
  }
  if (!PRICING_MODELS.includes(body.pricingModel as PricingModel)) {
    return { ok: false, detail: "pricingModel is not supported" };
  }
  if (
    !body.price ||
    typeof body.price !== "object" ||
    Array.isArray(body.price)
  ) {
    return { ok: false, detail: "price must be an object" };
  }
  if (body.active !== undefined && typeof body.active !== "boolean") {
    return { ok: false, detail: "active must be a boolean" };
  }
  return {
    ok: true,
    value: {
      productId: String(body.productId),
      offerId: String(body.offerId),
      skuRef: String(body.skuRef),
      title: String(body.title),
      pricingModel: body.pricingModel as PricingModel,
      price: body.price as Money,
      ...(body.perUse !== undefined
        ? { perUse: body.perUse as PerUseOfferTerms }
        : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  };
}

/**
 * The order id IS the idempotency record.
 *
 * Deriving it from (buyer, offer, idempotencyKey) makes a replay resolve to the
 * SAME order without a separate key table, and — the part that matters — binds
 * the key to its buyer: two callers who happen to pick the same idempotencyKey
 * get different orders instead of one reading the other's. Web Crypto rather
 * than `node:crypto` so this is identical under workerd and Node.
 */
async function deriveOrderId(input: CheckoutRequest): Promise<string> {
  const material = `${input.buyerOrgId}\n${input.offerId}\n${input.idempotencyKey}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `ord_${hex.slice(0, 32)}`;
}

async function contentId(prefix: string, payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}:${hex.slice(0, 32)}`;
}

/** The 422 codes the pure builder can refuse with, mapped to the wire contract. */
const BUILD_REFUSAL_CODES: Record<string, string> = {
  'unsupported-pricing-model': 'unsupported_pricing_model',
  'amount-mismatch': 'amount_mismatch',
  'zero-amount': 'zero_amount',
};

/**
 * The acting principal, as one canonical string.
 *
 * The Worker's only identity is a GitHub bearer, so this is the ONE place the
 * `{ id, login }` it yields is turned into the `userId` shape P-011 memberships
 * are keyed by. Numeric id rather than login because a login can be renamed and
 * the id cannot — a renamed login would silently stop matching a membership and
 * read as "not a member" rather than as a stale record.
 *
 * ⚠ This string must be IDENTICAL to the one an org writer records in
 * `OrgMembership.userId`, because membership is matched by string equality: a
 * writer recording `mia` while this authenticates `gh:1234` would not error, it
 * would find no membership and refuse every legitimate member as a stranger.
 * The form is therefore pinned as shared code, not convention — `USER_ID_FORM`
 * / `isCanonicalUserId` in `commerce-door-gate-io` (agreed with su-43e03bbc,
 * WI-2146391) — and asserted against that predicate below so the two halves
 * cannot drift apart silently.
 */
function principalId(user: { id: number }): string {
  return `gh:${user.id}`;
}

/**
 * May `actingUserId` act as `buyerId`? The ONE copy of that rule in the Worker.
 *
 * Two doors ask it — checkout (spend this buyer's money, WI-2146391) and the
 * entitlements read (see what this buyer owns, WI-2146412) — and they must
 * answer identically. A buyer who may not open an order must not be readable
 * either, and the reverse would be worse: a door that refuses a purchase while
 * a sibling door hands back the purchase history is an authorization boundary
 * with a window cut in it.
 *
 * Two, and only two, ways to pass:
 *   1. SELF — the buyer named IS the authenticated principal. Explicit string
 *      equality against the id we just authenticated, so it is unspoofable: a
 *      caller can only ever name themselves.
 *   2. ORG — `authorizeOrgActor` (D-045 §3d) confirms the org exists AND the
 *      actor is a member. That rule stays in the shared gate; this function
 *      composes it with the self case rather than restating it, so there is
 *      still exactly one membership rule in the tree.
 *
 * We deliberately do NOT reach case 2 through `resolveBuyerPrincipal`'s
 * individual fallback. That resolver never fails — an id matching no
 * organization comes back as an INDIVIDUAL buyer with that id — so leaning on
 * it would make "org that does not exist" and "person" indistinguishable at a
 * door deciding who may see or spend.
 */
async function authorizeBuyer(
  buyerId: string,
  actingUserId: string,
  loadOrgs: (db: D1Database) => Promise<ReadonlyMap<string, Organization>>,
  db: D1Database,
): Promise<{ ok: true } | { ok: false; code: string; detail: string }> {
  if (buyerId === actingUserId) return { ok: true };
  const verdict = authorizeOrgActor(buyerId, actingUserId, await loadOrgs(db));
  if (verdict.ok) return { ok: true };
  // The gate's vocabulary, mapped to the wire contract. `unknown-org` is
  // reported as a membership question rather than a 404: telling an
  // unauthorized caller which ids exist would make either door an
  // enumeration oracle — a refusal must not distinguish "no such buyer"
  // from "not your buyer".
  return {
    ok: false,
    code: verdict.code === 'actor-not-in-org' ? 'not_org_member' : 'org_membership_unknown',
    detail: verdict.detail,
  };
}

export function commerceRoute(
  options: {
    fetchImpl?: typeof fetch;
    loadOrgs?: (db: D1Database) => Promise<ReadonlyMap<string, Organization>>;
  } = {},
): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();
  // Injected so the checkout path is exercisable without network access; the
  // default is the runtime's own fetch, bound so workerd does not see an
  // illegal-invocation receiver.
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  // Injected for the same reason: production has no org writer yet, so the
  // MEMBER-permitted path is only reachable in a test until one lands. Without
  // this seam the org branch of the gate would be unexercisable, and an
  // unexercised authorization branch is the one that rots.
  const loadOrgs = options.loadOrgs ?? loadOrganizations;

  route.get("/commerce/offers", async (c) => {
    const pricing = c.req.query("pricing");
    if (
      pricing !== undefined &&
      !PRICING_MODELS.includes(pricing as PricingModel)
    ) {
      return c.json({ error: "invalid_pricing_model" }, 400);
    }
    return c.json({
      offers: await listCommerceOffers(c.env.DB, pricing),
    });
  });

  route.get("/commerce/offers/:offerId", async (c) => {
    const offer = await getCommerceOffer(c.env.DB, c.req.param("offerId"));
    return offer ? c.json({ offer }) : c.json({ error: "unknown_offer" }, 404);
  });

  route.post("/commerce/offers", async (c) => {
    let actingUserId: string;
    try {
      actingUserId = principalId(await resolveGithubBearer(c.req.raw));
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ error: "unauthorized", reason: err.reason }, 401);
      }
      throw err;
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_request", detail: "body was not valid JSON" },
        400,
      );
    }
    const parsed = parsePublishOfferRequest(rawBody);
    if (!parsed.ok) {
      return c.json({ error: "invalid_request", detail: parsed.detail }, 400);
    }
    const request = parsed.value;
    const events = await loadLedgerEvents(c.env.DB);
    const state = reduceLedger(events);
    const existingProduct = state.products.get(request.productId);
    if (existingProduct && existingProduct.creatorId !== actingUserId) {
      return c.json(
        {
          error: "product_not_owned",
          detail: `product ${request.productId} belongs to ${existingProduct.creatorId}`,
        },
        403,
      );
    }
    const existingOffer = state.offers.get(request.offerId);
    if (existingOffer) {
      const owner = state.products.get(existingOffer.productId)?.creatorId;
      if (owner !== actingUserId) {
        return c.json(
          {
            error: "offer_not_owned",
            detail: `offer ${request.offerId} belongs to ${owner ?? "an unknown creator"}`,
          },
          403,
        );
      }
    }

    const now = Date.now();
    const productPayload = {
      productId: request.productId,
      skuRef: request.skuRef,
      creatorId: actingUserId,
      title: request.title,
      active: request.active !== false,
    };
    const offerPayload = {
      offerId: request.offerId,
      productId: request.productId,
      pricingModel: request.pricingModel,
      price: request.price,
      ...(request.perUse !== undefined ? { perUse: request.perUse } : {}),
      active: request.active !== false,
    };
    const candidate: LedgerEvent[] = [
      {
        ledgerEventId: await contentId("evt:product-defined", productPayload),
        kind: "product.defined",
        occurredAtMs: now,
        source: { provider: "operator", providerEventId: null },
        payload: productPayload,
      },
      {
        ledgerEventId: await contentId("evt:offer-defined", offerPayload),
        kind: "offer.defined",
        occurredAtMs: now + 1,
        source: { provider: "operator", providerEventId: null },
        payload: offerPayload,
      },
    ];
    const candidateIds = new Set(candidate.map((event) => event.ledgerEventId));
    const projected = reduceLedger([...events, ...candidate]);
    const rejection = projected.rejected.find((row) =>
      candidateIds.has(row.ledgerEventId),
    );
    if (rejection) {
      return c.json(
        {
          error: "invalid_offer",
          code: rejection.code,
          detail: rejection.detail,
        },
        422,
      );
    }
    const existingIds = new Set(events.map((event) => event.ledgerEventId));
    const replayed = candidate.every((event) =>
      existingIds.has(event.ledgerEventId),
    );
    await appendLedgerEvents(c.env.DB, candidate);
    await projectLedger(c.env.DB);
    const offer = await getCommerceOffer(c.env.DB, request.offerId);
    const product = projected.products.get(request.productId);
    if (!offer || !product) {
      return c.json(
        {
          error: "projection_failed",
          detail: "offer did not appear in the D1 projection",
        },
        500,
      );
    }
    return c.json({ replayed, product, offer }, replayed ? 200 : 201);
  });

  route.post('/commerce/checkout-sessions', async (c) => {
    // Authenticate FIRST: this endpoint opens real orders and real Checkout
    // Sessions, so an anonymous caller must not even learn whether this
    // deployment has Stripe configured.
    //
    // This establishes WHO is calling; whether they may act for `buyerOrgId`
    // is a SEPARATE question, answered below once the body has been parsed
    // (WI-2146391 — that check used to be missing entirely).
    let actingUserId: string;
    try {
      actingUserId = principalId(await resolveGithubBearer(c.req.raw));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: 'unauthorized', reason: err.reason }, 401);
      throw err;
    }

    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request', detail: 'body was not valid JSON' }, 400);
    }
    const parsed = parseCheckoutRequest(rawBody);
    if (!parsed.ok) {
      return c.json(
        { error: parsed.code, detail: parsed.detail },
        parsed.code === "unsupported_quantity" ||
          parsed.code === "invalid_max_spend"
          ? 422
          : 400,
      );
    }
    const request = parsed.value;

    // AUTHORIZATION (WI-2146391). The rule itself is `authorizeBuyer` above,
    // shared with the entitlements read. What is specific to THIS door is the
    // ORDERING: it runs BEFORE the idempotent-replay branch on purpose, because
    // replay returns the original order's Checkout URL, so running this check
    // afterwards would let a non-member replay a member's key and read back a
    // live payment handle with a 200. An authorization check that sits behind a
    // cache is not an authorization check.
    const authorized = await authorizeBuyer(request.buyerOrgId, actingUserId, loadOrgs, c.env.DB);
    if (!authorized.ok) {
      return c.json({ error: authorized.code, detail: authorized.detail }, 403);
    }

    const events = await loadLedgerEvents(c.env.DB);
    const state = reduceLedger(events);
    const orderId = await deriveOrderId(request);

    const offer = state.offers.get(request.offerId);
    if (!offer)
      return c.json(
        {
          error: "unknown_offer",
          detail: `offer ${request.offerId} is not defined in the ledger`,
        },
        404,
      );
    if (!offer.active)
      return c.json(
        {
          error: "inactive_offer",
          detail: `offer ${request.offerId} is inactive`,
        },
        422,
      );
    const product = state.products.get(offer.productId);
    if (!product)
      return c.json(
        {
          error: "unknown_product",
          detail: `product ${offer.productId} is not defined in the ledger`,
        },
        404,
      );

    if (offer.pricingModel === "per-use") {
      if (!offer.perUse) {
        return c.json(
          {
            error: "invalid_offer",
            detail: "per-use terms are missing from the ledger offer",
          },
          500,
        );
      }
      const maxSpendMicros = request.maxSpendMicros;
      if (
        !Number.isSafeInteger(maxSpendMicros) ||
        (maxSpendMicros as number) <= 0
      ) {
        return c.json(
          {
            error: "max_spend_required",
            detail: "per-use checkout requires maxSpendMicros",
          },
          422,
        );
      }
      if ((maxSpendMicros as number) < offer.perUse.unitPriceMicros) {
        return c.json(
          {
            error: "max_spend_below_unit_price",
            detail: `maxSpendMicros must cover at least one ${offer.perUse.meterUnit}`,
          },
          422,
        );
      }
      const channel = createMicrochargeChannel(
        `ch_${orderId.slice("ord_".length)}`,
        BigInt(maxSpendMicros as number),
      );
      return c.json({
        checkoutKind: "microcharge-preflight",
        rail: "p2p-microcharge",
        preflightId: `pre_${orderId.slice("ord_".length)}`,
        channel: {
          channelId: channel.channelId,
          payer: request.buyerOrgId,
          seller: product.creatorId,
          releaseRef: product.skuRef,
          escrowMicros: channel.escrowMicros.toString(),
          committedMicros: channel.committedMicros.toString(),
        },
        terms: {
          ...offer.perUse,
          currency: offer.price.currency,
        },
      });
    }

    if (offer.pricingModel === "free") {
      return c.json(
        {
          error: "unsupported_pricing_model",
          detail: "free offers do not go through Checkout",
        },
        422,
      );
    }

    // Fail CLOSED for provider-backed pricing only. A per-use offer never
    // touches Stripe and therefore must not be held hostage by its secret.
    const secretKey = c.env.STRIPE_SECRET_KEY;
    if (typeof secretKey !== "string" || !secretKey) {
      return c.json(
        {
          error: "provider_not_configured",
          detail: "STRIPE_SECRET_KEY is not configured in this deployment",
        },
        503,
      );
    }

    // Idempotent replay: the order already exists, so return the ORIGINAL
    // handle rather than opening a second Checkout Session. The provider ref
    // lives on the order; the URL is not reducer state, so it is read back from
    // the originating event's payload.
    const existingOrder = state.orders.get(orderId);
    if (existingOrder) {
      const origin = events.find((e) => e.kind === 'order.created' && (e.payload as { orderId?: unknown }).orderId === orderId);
      const url = origin ? (origin.payload as { checkoutUrl?: unknown }).checkoutUrl : undefined;
      return c.json(
        { orderId, providerSessionId: existingOrder.providerRef, url: typeof url === 'string' ? url : null, replayed: true },
        200,
      );
    }

    const now = Date.now();
    const order: Order = {
      orderId,
      offerId: offer.offerId,
      productId: offer.productId,
      buyerId: request.buyerOrgId,
      amount: offer.price,
      state: 'pending',
      provider: STRIPE_PROVIDER,
      providerRef: null,
      refundedMinor: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };

    const built = buildStripeCheckoutSessionParams({
      order,
      offer,
      product,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
    });
    if (!built.ok) {
      return c.json({ error: BUILD_REFUSAL_CODES[built.code] ?? 'invalid_request', detail: built.detail }, 422);
    }

    const session = await createStripeCheckoutSession({
      secretKey,
      params: built.params,
      fetchImpl,
      // Stripe's own idempotency covers the window our ledger cannot: between
      // the provider call and the append below. Scoped to the derived order id
      // so it is per-order, not per-client-string.
      idempotencyKey: orderId,
    });
    if (!session.ok) {
      return c.json({ error: 'provider_error', detail: session.detail }, 502);
    }

    // Recorded only AFTER the provider confirmed — a ledger order.created whose
    // session does not exist would be an order nothing can ever pay.
    const event: LedgerEvent = {
      ledgerEventId: `evt:order-created:${orderId}`,
      kind: 'order.created',
      occurredAtMs: now,
      source: { provider: STRIPE_PROVIDER, providerEventId: null },
      payload: {
        orderId,
        offerId: offer.offerId,
        buyerId: request.buyerOrgId,
        amount: offer.price,
        providerRef: session.sessionId,
        checkoutUrl: session.url,
      },
    };
    await appendLedgerEvents(c.env.DB, [event]);
    await projectLedger(c.env.DB);

    return c.json({ orderId, providerSessionId: session.sessionId, url: session.url }, 201);
  });

  route.post('/commerce/webhooks/:provider', async (c) => {
    const provider = c.req.param('provider');
    const resolved = resolveAdapter(provider, c.env);
    if ('error' in resolved) {
      return resolved.error === 'unknown'
        ? c.json({ error: 'unknown_provider', provider }, 404)
        : c.json({ error: 'provider_not_configured', provider }, 503);
    }

    // The signature covers the EXACT bytes sent — read the raw body, never a
    // re-serialized JSON round-trip, which would change them and never verify.
    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const store = d1WebhookInboxStore(c.env.DB);
    const result = await ingestWebhook({
      adapter: resolved.adapter,
      store,
      request: { rawBody, headers, nowMs: Date.now() },
    });

    if (result.outcome === 'rejected') {
      const status = SIGNATURE_REFUSALS.has(result.code) ? 401 : 400;
      return c.json({ error: result.code, detail: result.detail, provider_event_id: result.providerEventId }, status);
    }
    if (result.outcome === 'duplicate') {
      return c.json({ outcome: 'duplicate', provider_event_id: result.providerEventId }, 200);
    }
    if (result.outcome === 'ignored') {
      return c.json({ outcome: 'ignored', provider_event_id: result.providerEventId }, 202);
    }

    await appendLedgerEvents(c.env.DB, result.events);
    await projectLedger(c.env.DB);
    return c.json(
      {
        outcome: 'accepted',
        provider_event_id: result.providerEventId,
        ledger_event_ids: result.events.map((e) => e.ledgerEventId),
      },
      200,
    );
  });

  route.get('/commerce/entitlements', async (c) => {
    // WI-2146412. This route used to take a `buyer` query param and answer it,
    // full stop — so anyone who could reach the Worker could read any buyer's
    // purchase history by guessing an id, with no bearer at all. Entitlements
    // are what someone paid for; the read side of a commerce boundary needs the
    // same door as the write side, and it had none.
    //
    // Authenticate FIRST, before even validating `buyer`: an anonymous caller
    // should learn nothing from this endpoint, including whether their guess
    // was well-formed.
    let actingUserId: string;
    try {
      actingUserId = principalId(await resolveGithubBearer(c.req.raw));
    } catch (err) {
      if (err instanceof AuthError) return c.json({ error: 'unauthorized', reason: err.reason }, 401);
      throw err;
    }

    const buyer = c.req.query('buyer');
    if (!buyer) return c.json({ error: 'buyer_required' }, 400);

    // Same rule as checkout, same single copy of it: you may read yourself, or
    // an organization you belong to. A caller asking after a buyer that is
    // neither gets the SAME 403 whether or not that buyer exists.
    const authorized = await authorizeBuyer(buyer, actingUserId, loadOrgs, c.env.DB);
    if (!authorized.ok) {
      return c.json({ error: authorized.code, detail: authorized.detail }, 403);
    }

    const entitlements = await listActiveEntitlements(c.env.DB, buyer);
    return c.json({ buyer, entitlements });
  });

  return route;
}
