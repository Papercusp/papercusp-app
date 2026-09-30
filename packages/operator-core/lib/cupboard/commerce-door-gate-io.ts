/**
 * commerce-door-gate-io — the production wiring the four `agent-tools/cupboard/
 * commerce-*.ts` doors call (D-045 §3d).
 *
 * `commerce-door-gate` holds the RULES and is pure; this module holds the I/O
 * those rules need — the commerce snapshot they decide on, and the hosted
 * checkout call. Splitting them is what lets every authorization rule be tested
 * without a network, and lets this file be read as exactly "where the outside
 * world enters".
 *
 * WHAT IS DELIBERATELY EMPTY HERE
 * -------------------------------
 * `loadCommerceState` returns an EMPTY snapshot today, and that is a measured
 * fact rather than an oversight. P-010's persistence landed in the hosted
 * Worker's D1 (`apps/operator-public/src/commerce-store.ts`, migration
 * `019_commerce_ledger.sql`); the desktop operator has no commerce tables and
 * no local writer, and the hosted API exposes no whole-ledger read — only
 * `GET /commerce/entitlements?buyer=`. So there is genuinely nothing to load
 * here yet.
 *
 * It is a NAMED seam rather than an absent one so that the persistence P-010
 * (or P-016) lands has exactly ONE place to arrive, instead of a fifth door
 * being invented for it. This is the same shape, and the same reasoning, as
 * `install-door-gate-io.loadReleaseChain` returning null.
 *
 * WHAT THIS MEANS THE DOORS DO IN PRODUCTION TODAY — STATED PLAINLY
 * ----------------------------------------------------------------
 * An empty snapshot has no organizations, so `authorizeOrgActor` refuses every
 * call with `unknown-org` until an org roster is published. That is FAIL-CLOSED
 * and deliberate: the alternative — treating an unknown id as an individual
 * buyer, which is what `resolveBuyerPrincipal` does on its own — would let any
 * caller name any string and be authorized as that buyer. A door that refuses
 * until it can actually check is the correct behaviour for a money surface;
 * a door that proceeds because the check is unavailable is the bug.
 *
 * The checkout door's hosted leg is NOT stubbed in the same way: it posts to
 * the real `POST /commerce/checkout-sessions` on the resolved Cupboard base
 * URL, so once a roster exists the path is live end to end.
 */
import { pinModuleState } from '@papercusp/module-singleton';

import { resolveCupboardBaseUrl } from './base-url';
import type { Installation, Organization, SeatPolicy, CreatorProfile } from './commerce-accounts';
import { reduceCommerceEvents, type CommerceEvent } from '../p2p/commerce-events';

import {
  reduceLedger,
  type LedgerEvent,
  type LedgerState,
  type Money,
  type PerUseOfferTerms,
  type PricingModel,
} from './commerce-ledger';
import {
  projectEntitlements,
  projectLedgerEntitlements,
  type EntitlementProjection,
} from './entitled-delivery';
import {
  bridgeCommerceEventsToLedger,
  bridgeFromCommerceEntitlements,
  mergeEntitlementProjections,
  perUseRollup,
  type PerUseRollup,
} from './ledger-p2p-bridge';
import {
  gateCheckout,
  gateCommerceDashboards,
  gateRefundRequest,
  gateSupportRequest,
  type CheckoutDoorDecision,
  type CheckoutDoorInput,
  type CheckoutSessionRequest,
  type CommerceSnapshot,
  type DashboardsDoorDecision,
  type DashboardsDoorInput,
  type RefundDoorDecision,
  type RefundDoorInput,
  type SupportDoorDecision,
  type SupportDoorInput,
} from './commerce-door-gate';

/**
 * The single seam every commerce door reads its state through.
 *
 * Returning an empty fold is the honest answer while no local writer exists;
 * synthesising rows here would make the doors look exercised in production when
 * they are not. When persistence lands, this function is the only thing that
 * changes.
 */
export async function loadCommerceLedgerEvents(): Promise<readonly LedgerEvent[]> {
  return [];
}

/**
 * The signed P-016 commerce stream this process can see, if any (P-035).
 *
 * Null and an empty array are DIFFERENT answers and both are honest: null means
 * no P2P commerce source is wired here, `[]` means one is and it is quiet. The
 * production default is null, because inventing a stream would make the bridge
 * look exercised while nothing publishes to it.
 */
export async function loadP2pCommerceEvents(): Promise<readonly CommerceEvent[] | null> {
  return null;
}

/** Where a door's commerce snapshot comes from. See `configureCommerceIo`. */
export type CommerceStateLoader = () => Promise<CommerceSnapshot> | CommerceSnapshot;

/** Supplies the signed P-016 stream `loadCommerceState` bridges into the ledger. */
export type CommerceEventLoader = () =>
  | Promise<readonly CommerceEvent[] | null>
  | readonly CommerceEvent[]
  | null;

export interface CommerceIoSources {
  /** Supplies the snapshot every commerce door gates against. */
  readonly loadState?: CommerceStateLoader;
  /**
   * Supplies the signed P-016 commerce stream (P-035). Used only when
   * `loadState` is absent: a loader that builds the whole snapshot already owns
   * its own per-use view, and folding a second stream underneath it would let
   * the two disagree about the same channel.
   */
  readonly loadCommerceEvents?: CommerceEventLoader;
  /** Transport for the hosted checkout leg — merged UNDER any per-call deps. */
  readonly transport?: CheckoutTransportDeps;
}

const ioState = pinModuleState('@papercusp/operator-core.cupboard.commerce-door-io', () => ({
  sources: null as CommerceIoSources | null,
}));

/**
 * Register where this process's commerce doors read their state and reach the
 * hosted provider.
 *
 * The doors deliberately hold no state of their own, and `loadCommerceState`
 * below is honest-but-empty while no local writer exists (see its header). That
 * makes the door layer unreachable end to end: every door refuses `unknown-org`
 * against an empty fold, so nothing downstream of the gate is ever exercised.
 * This is the host seam that closes that gap — the SAME `configure*()` shape the
 * repo uses elsewhere to keep a domain module free of its environment.
 *
 * Two callers are expected: a future desktop persistence layer registering the
 * real reader, and P-012's journey suite registering a fold it built from real
 * signed webhook bytes. Passing `null` restores the production default, which is
 * what a test teardown must do — the pin is process-wide.
 */
export function configureCommerceIo(sources: CommerceIoSources | null): void {
  ioState.sources = sources;
}

/** The sources currently registered, or null when the default is in force. */
export function commerceIoSources(): CommerceIoSources | null {
  return ioState.sources;
}

/**
 * Fold the local ledger events and the signed P2P commerce stream into ONE
 * ledger state (P-035, D-048).
 *
 * The two streams are reduced TOGETHER rather than merged afterwards, because
 * `reduceLedger` owns every ordering and transition rule — a per-use refund
 * bridged from the P2P rail has to meet the same `refund-exceeds-order` check
 * as a Stripe one, and folding the P2P facts into a second state and unioning
 * the maps would skip exactly those checks.
 *
 * `reduceCommerceEvents` runs first and unconditionally: it owns signature
 * shape, idempotency and conflict quarantine, and only its `accepted` list may
 * reach the bridge. A conflicting or unsigned P2P fact therefore never becomes
 * a ledger event at all.
 */
export async function foldCommerceLedger(
  ledgerEvents: readonly LedgerEvent[],
  commerceEvents: readonly CommerceEvent[] | null,
): Promise<{ ledger: LedgerState; perUse: PerUseRollup | null }> {
  if (!commerceEvents) {
    return { ledger: reduceLedger(ledgerEvents), perUse: null };
  }
  const reduction = reduceCommerceEvents(commerceEvents);
  const bridged = bridgeCommerceEventsToLedger(reduction.accepted);
  return {
    ledger: reduceLedger([...ledgerEvents, ...bridged.ledgerEvents]),
    perUse: perUseRollup(reduction.accepted),
  };
}

export async function loadCommerceState(): Promise<CommerceSnapshot> {
  const configured = ioState.sources?.loadState;
  if (configured) return await configured();
  const events = await loadCommerceLedgerEvents();
  const commerceEvents = await (ioState.sources?.loadCommerceEvents ?? loadP2pCommerceEvents)();
  const folded = await foldCommerceLedger(events, commerceEvents);
  return {
    ledger: folded.ledger,
    orgs: new Map<string, Organization>(),
    seatPolicies: new Map<string, SeatPolicy>(),
    installations: [] as readonly Installation[],
    creatorProfiles: new Map<string, CreatorProfile>(),
    perUse: folded.perUse,
  };
}

/**
 * The entitlement view a delivery gate should read (P-035).
 *
 * Combines the LEDGER's entitlements — which is where a Stripe purchase and a
 * bridged P2P order both land — with the P2P `entitlement` events that name the
 * release and subject the ledger deliberately does not know. Revocation from
 * either side wins (`mergeEntitlementProjections`), which is what makes a
 * refund settled on the P2P rail propagate to delivery rather than stopping at
 * the dashboard.
 */
export async function loadDeliveryEntitlements(): Promise<EntitlementProjection> {
  const events = await loadCommerceLedgerEvents();
  const commerceEvents = await (ioState.sources?.loadCommerceEvents ?? loadP2pCommerceEvents)();
  if (!commerceEvents) {
    // No P2P stream means no product→release / buyer→subject mapping exists,
    // and D-048 forbids guessing one. An empty projection is fail-closed: the
    // install door refuses `not-entitled` rather than delivering unmapped bytes.
    return { grants: new Map(), unusable: [] };
  }
  const reduction = reduceCommerceEvents(commerceEvents);
  const bridged = bridgeCommerceEventsToLedger(reduction.accepted);
  const ledger = reduceLedger([...events, ...bridged.ledgerEvents]);
  return mergeEntitlementProjections(
    projectEntitlements(reduction.accepted),
    projectLedgerEntitlements(ledger, bridgeFromCommerceEntitlements(reduction.accepted)),
  );
}

// ---------------------------------------------------------------------------
// The hosted checkout leg
// ---------------------------------------------------------------------------

/**
 * The hosted route, verified against the landed Worker rather than a proposal.
 *
 * `apps/operator-public/src/routes/index.ts` mounts `commerceRoute()` at '/',
 * and `routes/commerce.ts` registers `POST /commerce/checkout-sessions`. There
 * is NO `/v1` prefix — su-57f4104a flagged this explicitly, because the P-010
 * brief's text names one and faking it would mean the two halves never meet.
 */
export const CHECKOUT_SESSIONS_PATH = '/commerce/checkout-sessions';

/**
 * The identity form both halves must agree on.
 *
 * Org membership is matched by STRING EQUALITY on `OrgMembership.userId`, so a
 * desktop door writing `mia` while the Worker authenticates `gh:1234` would not
 * error — it would silently find no membership and refuse every legitimate
 * member as a stranger. A silent miss, not a loud one, which is why the form is
 * pinned here as a constant rather than left to convention (agreed with
 * su-57f4104a, WI-2146391).
 */
export const USER_ID_FORM = 'gh:<numeric github id>' as const;

export function isCanonicalUserId(userId: string): boolean {
  return /^gh:\d+$/.test(userId);
}

/** Error vocabulary the hosted route returns, as amended by its owner. */
export type CheckoutHostedErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  /** 403 — buyerOrgId names an org the Worker cannot resolve. */
  | 'org_membership_unknown'
  /** 403 — the authenticated principal is not a member of buyerOrgId. */
  | 'not_org_member'
  | 'unknown_offer'
  | 'unknown_product'
  | 'inactive_offer'
  | 'unsupported_pricing_model'
  | 'amount_mismatch'
  | 'zero_amount'
  | 'unsupported_quantity'
  | 'provider_error'
  | 'provider_not_configured';

export interface CheckoutSessionOk {
  readonly ok: true;
  readonly kind: 'hosted-checkout';
  readonly orderId: string;
  readonly providerSessionId: string;
  readonly url: string;
  /** True when the route replayed an existing order for a repeated key (200). */
  readonly idempotentReplay: boolean;
}

export interface PerUseCheckoutPreflightOk {
  readonly ok: true;
  readonly kind: 'microcharge-preflight';
  readonly rail: 'p2p-microcharge';
  readonly preflightId: string;
  readonly channel: {
    readonly channelId: string;
    readonly payer: string;
    readonly seller: string;
    readonly releaseRef: string;
    readonly escrowMicros: string;
    readonly committedMicros: string;
  };
  readonly terms: PerUseOfferTerms & { readonly currency: string };
}

export interface CheckoutSessionFailed {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
  readonly detail: string | null;
}

export type CheckoutSessionSuccess = CheckoutSessionOk | PerUseCheckoutPreflightOk;
export type CheckoutSessionResult = CheckoutSessionSuccess | CheckoutSessionFailed;

export interface CheckoutTransportDeps {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  /** Override the GitHub bearer; omitted in production, supplied by tests. */
  readonly authToken?: string;
}

/**
 * POST the checkout session to the hosted route.
 *
 * A 201 is a fresh session and a 200 is the idempotent replay of one already
 * created for the same key — both carry the same body, so the distinction is
 * reported rather than flattened: a caller that retried after a timeout needs
 * to know it did not create a second order.
 */
export async function postCheckoutSession(
  request: CheckoutSessionRequest,
  deps: CheckoutTransportDeps = {},
): Promise<CheckoutSessionResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');

  // The route authenticates with a GitHub bearer (`resolveGithubBearer`), the
  // SAME scheme publish-listing and delete-listing already use — reuse rather
  // than a second credential path. Resolving it BEFORE the request turns a
  // missing token into a local, named refusal instead of an opaque hosted 401.
  let token = deps.authToken;
  if (token === undefined) {
    const { getGhAuthToken } = await import('../identity/gh-token');
    const resolved = await getGhAuthToken();
    if (resolved.kind !== 'ok') {
      return {
        ok: false,
        status: 401,
        error: 'gh_auth_required',
        detail: 'no GitHub token is available to authenticate the checkout request',
      };
    }
    token = resolved.token;
  }

  let response: Response;
  try {
    response = await fetchImpl(`${base}${CHECKOUT_SESSIONS_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'transport_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const payload = (body ?? {}) as Record<string, unknown>;

  if (response.status !== 200 && response.status !== 201) {
    return {
      ok: false,
      status: response.status,
      error: typeof payload.error === 'string' ? payload.error : `http_${response.status}`,
      detail: typeof payload.detail === 'string' ? payload.detail : null,
    };
  }

  if (payload.checkoutKind === 'microcharge-preflight') {
    const channel = payload.channel;
    const terms = payload.terms;
    if (
      payload.rail !== 'p2p-microcharge' ||
      typeof payload.preflightId !== 'string' ||
      !channel ||
      typeof channel !== 'object' ||
      Array.isArray(channel) ||
      !terms ||
      typeof terms !== 'object' ||
      Array.isArray(terms)
    ) {
      return {
        ok: false,
        status: response.status,
        error: 'malformed_response',
        detail: `expected a microcharge preflight contract from ${CHECKOUT_SESSIONS_PATH}`,
      };
    }
    const c = channel as Record<string, unknown>;
    const t = terms as Record<string, unknown>;
    if (
      typeof c.channelId !== 'string' ||
      typeof c.payer !== 'string' ||
      typeof c.seller !== 'string' ||
      typeof c.releaseRef !== 'string' ||
      typeof c.escrowMicros !== 'string' ||
      typeof c.committedMicros !== 'string' ||
      !Number.isSafeInteger(t.unitPriceMicros) ||
      typeof t.meterUnit !== 'string' ||
      typeof t.priceVersion !== 'string' ||
      typeof t.splitManifestHash !== 'string' ||
      typeof t.currency !== 'string'
    ) {
      return {
        ok: false,
        status: response.status,
        error: 'malformed_response',
        detail: `expected complete channel + terms from ${CHECKOUT_SESSIONS_PATH}`,
      };
    }
    return {
      ok: true,
      kind: 'microcharge-preflight',
      rail: 'p2p-microcharge',
      preflightId: payload.preflightId,
      channel: {
        channelId: c.channelId,
        payer: c.payer,
        seller: c.seller,
        releaseRef: c.releaseRef,
        escrowMicros: c.escrowMicros,
        committedMicros: c.committedMicros,
      },
      terms: {
        unitPriceMicros: t.unitPriceMicros as number,
        meterUnit: t.meterUnit,
        priceVersion: t.priceVersion,
        splitManifestHash: t.splitManifestHash,
        currency: t.currency,
      },
    };
  }

  const orderId = payload.orderId;
  const providerSessionId = payload.providerSessionId;
  const url = payload.url;
  if (typeof orderId !== 'string' || typeof providerSessionId !== 'string' || typeof url !== 'string') {
    // A 2xx whose body does not carry the contract is a contract breach, not a
    // success — surfacing it as one would hand the caller `undefined` order ids.
    return {
      ok: false,
      status: response.status,
      error: 'malformed_response',
      detail: `expected { orderId, providerSessionId, url } from ${CHECKOUT_SESSIONS_PATH}`,
    };
  }

  return {
    ok: true,
    kind: 'hosted-checkout',
    orderId,
    providerSessionId,
    url,
    idempotentReplay: response.status === 200,
  };
}

// ---------------------------------------------------------------------------
// Hosted offer authoring
// ---------------------------------------------------------------------------

export const COMMERCE_OFFERS_PATH = '/commerce/offers';

export interface CommerceOfferPublishRequest {
  readonly productId: string;
  readonly offerId: string;
  readonly skuRef: string;
  readonly title: string;
  readonly pricingModel: PricingModel;
  readonly price: Money;
  readonly perUse?: PerUseOfferTerms;
  readonly active?: boolean;
}

export type CommerceOfferPublishResult =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly product: Record<string, unknown>;
      readonly offer: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly detail: string | null;
    };

/** Publish a product + offer through the authenticated hosted ledger door. */
export async function postCommerceOffer(
  request: CommerceOfferPublishRequest,
  deps: CheckoutTransportDeps = {},
): Promise<CommerceOfferPublishResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const base = (deps.baseUrl ?? resolveCupboardBaseUrl()).replace(/\/+$/, '');

  let token = deps.authToken;
  if (token === undefined) {
    const { getGhAuthToken } = await import('../identity/gh-token');
    const resolved = await getGhAuthToken();
    if (resolved.kind !== 'ok') {
      return {
        ok: false,
        status: 401,
        error: 'gh_auth_required',
        detail: 'no GitHub token is available to authenticate the offer publish request',
      };
    }
    token = resolved.token;
  }

  let response: Response;
  try {
    response = await fetchImpl(`${base}${COMMERCE_OFFERS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(request),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: 'transport_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  if (response.status !== 200 && response.status !== 201) {
    return {
      ok: false,
      status: response.status,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : `http_${response.status}`,
      detail:
        typeof payload.detail === 'string' ? payload.detail : null,
    };
  }
  if (
    typeof payload.replayed !== 'boolean' ||
    !payload.product ||
    typeof payload.product !== 'object' ||
    !payload.offer ||
    typeof payload.offer !== 'object'
  ) {
    return {
      ok: false,
      status: response.status,
      error: 'malformed_response',
      detail: `expected { replayed, product, offer } from ${COMMERCE_OFFERS_PATH}`,
    };
  }
  return {
    ok: true,
    replayed: payload.replayed,
    product: payload.product as Record<string, unknown>,
    offer: payload.offer as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// The four calls the doors make
// ---------------------------------------------------------------------------

export type CheckoutDoorOutcome =
  | { readonly ok: true; readonly session: CheckoutSessionSuccess }
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly status?: number };

/**
 * The single call `cupboard:checkout` makes: authorize locally, then start the
 * hosted session. The local gate runs FIRST so an unauthorized request never
 * becomes a provider round trip.
 */
export async function checkoutDoor(
  input: CheckoutDoorInput,
  deps: CheckoutTransportDeps = {},
): Promise<CheckoutDoorOutcome> {
  const snapshot = await loadCommerceState();
  const decision: CheckoutDoorDecision = gateCheckout(input, snapshot);
  if (!decision.ok) return { ok: false, code: decision.code, detail: decision.detail };

  // Per-call deps win key by key, so an explicit argument is never overridden by
  // a registered default — the registration is a fallback, not a hijack.
  const transport: CheckoutTransportDeps = { ...(ioState.sources?.transport ?? {}), ...deps };
  const session = await postCheckoutSession(decision.request, transport);
  if (!session.ok) {
    return { ok: false, code: session.error, detail: session.detail ?? '', status: session.status };
  }
  return { ok: true, session };
}

export async function refundRequestDoor(input: RefundDoorInput): Promise<RefundDoorDecision> {
  return gateRefundRequest(input, await loadCommerceState());
}

export async function supportRequestDoor(input: SupportDoorInput): Promise<SupportDoorDecision> {
  return gateSupportRequest(input, await loadCommerceState());
}

export async function commerceDashboardsDoor(
  input: DashboardsDoorInput,
): Promise<DashboardsDoorDecision> {
  return gateCommerceDashboards(input, await loadCommerceState());
}
