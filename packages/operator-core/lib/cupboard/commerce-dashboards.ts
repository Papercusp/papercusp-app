/**
 * Checkout, refund, support and audit/export dashboards (P-011).
 *
 * Every function here is a PURE PROJECTION over state two other modules own:
 * P-010's `LedgerState` (`./commerce-ledger`) and P-011's identity/consumption
 * layer (`./commerce-accounts`). Nothing in this file mutates either, performs
 * I/O, or reads a clock — a dashboard that could change what it reports is not
 * a dashboard. That is what makes an audit export reproducible: the same inputs
 * must render the same bytes, forever.
 *
 * Three rails are deliberate and are guarded by tests, because each one is a
 * place where the obvious implementation is quietly wrong:
 *
 *  1. MONEY NEVER SILENTLY AGGREGATES ACROSS CURRENCIES. `sumMoney` refuses a
 *     mixed set rather than adding minor units of different denominations. A
 *     dashboard summing 100 JPY into 100 USD produces a number that looks like
 *     money and is not, and no downstream reader can detect it.
 *
 *  2. REFUNDABILITY SUBTRACTS REFUNDS THAT ARE STILL PENDING. P-010's
 *     `Order.refundedMinor` only advances on `refund.succeeded`, which is
 *     correct for the ledger — money has not moved yet — and catastrophic for a
 *     dashboard: two operators reading "refundable" while one refund is in
 *     flight would each issue the remainder, and the reducer's
 *     `refund-exceeds-order` rejection is the only thing standing between that
 *     and a double payout. `refundPosition` reports the CONSERVATIVE figure.
 *
 *  3. THE AUDIT EXPORT CANNOT OMIT REJECTIONS OR DUPLICATES. An export that
 *     shows only the events that applied describes a ledger that never had a
 *     problem, which is precisely the ledger an auditor is looking for. The
 *     rejected and duplicate sets travel WITH the accepted one.
 *
 * The support dashboard delegates its "may this proceed?" verdict to
 * `authorizeSeatIntent` rather than re-deriving the rule. Re-deriving it would
 * fork D-042's yank semantics a second time — the exact drift `commerce-accounts`
 * was written to prevent.
 */

import type {
  Entitlement,
  LedgerRejection,
  LedgerState,
  Money,
  Offer,
  Order,
  OrderState,
  PerUseOfferTerms,
  Payout,
  Product,
  Refund,
} from './commerce-ledger';
import {
  authorizeSeatIntent,
  membershipOf,
  payoutReadiness,
  principalEntitles,
  resolveBuyerPrincipal,
  seatUsage,
  seatsForOffer,
  type BuyerPrincipal,
  type CreatorProfile,
  type Installation,
  type Organization,
  type OrgRole,
  type PayoutReadiness,
  type SeatPolicy,
  type SeatUsage,
} from './commerce-accounts';
import { type DeliveryIntent } from '../p2p/artifact-distribution';

// ---------------------------------------------------------------------------
// Money aggregation — refuses to mix currencies
// ---------------------------------------------------------------------------

export type MoneySum =
  | { readonly ok: true; readonly total: Money }
  | { readonly ok: false; readonly code: 'currency-mismatch'; readonly detail: string };

/**
 * Sum `amounts`, refusing a mixed-currency set. `currency` fixes the expected
 * denomination so an EMPTY set still yields a well-typed zero instead of an
 * untyped one — a dashboard reporting `0` with no currency is a bug waiting to
 * be formatted as dollars.
 */
export function sumMoney(amounts: readonly Money[], currency: string): MoneySum {
  let totalMinor = 0;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      return {
        ok: false,
        code: 'currency-mismatch',
        detail: `cannot aggregate ${amount.currency} into a ${currency} total`,
      };
    }
    totalMinor += amount.amountMinor;
  }
  return { ok: true, total: { amountMinor: totalMinor, currency } };
}

// ---------------------------------------------------------------------------
// Offer catalog dashboard
// ---------------------------------------------------------------------------

export interface CommerceCatalogLine {
  readonly offerId: string;
  readonly productId: string;
  readonly productTitle: string | null;
  readonly skuRef: string | null;
  readonly creatorId: string | null;
  readonly pricingModel: Offer['pricingModel'];
  readonly price: Money;
  readonly perUse: PerUseOfferTerms | null;
  readonly active: boolean;
  readonly productActive: boolean | null;
}

/** Exact offer terms visible to buyers before they choose a payment rail. */
export function commerceCatalogDashboard(
  ledger: LedgerState,
): readonly CommerceCatalogLine[] {
  return sortedById(ledger.offers.values(), (offer) => offer.offerId).map((offer) => {
    const product = ledger.products.get(offer.productId);
    return {
      offerId: offer.offerId,
      productId: offer.productId,
      productTitle: product?.title ?? null,
      skuRef: product?.skuRef ?? null,
      creatorId: product?.creatorId ?? null,
      pricingModel: offer.pricingModel,
      price: offer.price,
      perUse: offer.perUse ?? null,
      active: offer.active,
      productActive: product?.active ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Checkout dashboard
// ---------------------------------------------------------------------------

export interface CheckoutLine {
  readonly orderId: string;
  readonly orderState: OrderState;
  readonly productId: string;
  readonly productTitle: string | null;
  readonly offerId: string;
  readonly pricingModel: Offer['pricingModel'] | null;
  readonly perUse: PerUseOfferTerms | null;
  readonly amount: Money;
  readonly refundedMinor: number;
  /** Null when the order never reached `paid` — there is nothing to entitle. */
  readonly entitlementId: string | null;
  readonly entitlementState: Entitlement['state'] | null;
  /** Null when there is no entitlement to seat against. */
  readonly seats: SeatUsage | null;
  readonly createdAtMs: number;
}

export interface CheckoutDashboard {
  readonly buyerId: string;
  readonly principal: BuyerPrincipal;
  readonly lines: readonly CheckoutLine[];
  readonly currency: string;
  /** Gross of every order in a settled state, before refunds. */
  readonly grossMinor: number;
  /** Refunds the ledger has actually settled. */
  readonly refundedMinor: number;
  readonly netMinor: number;
  /** Set when the buyer's orders span currencies; the totals are then zero. */
  readonly currencyMismatch: string | null;
}

export interface CheckoutDashboardInput {
  readonly buyerId: string;
  readonly ledger: LedgerState;
  readonly orgs: ReadonlyMap<string, Organization>;
  readonly seatPolicies: ReadonlyMap<string, SeatPolicy>;
  readonly installations: readonly Installation[];
  /** Denomination the totals are reported in. */
  readonly currency: string;
}

/** Orders whose money is real: everything except a failed or canceled attempt. */
const SETTLED_ORDER_STATES: ReadonlySet<OrderState> = new Set<OrderState>([
  'paid',
  'partially-refunded',
  'refunded',
]);

/**
 * What one buyer bought, and what each purchase currently entitles them to.
 *
 * A REVOKED entitlement is reported, not filtered out. Hiding it produces the
 * single most common support ticket in a commerce system — "I paid for this and
 * it vanished" — where the honest answer is that a refund revoked it.
 */
export function checkoutDashboard(input: CheckoutDashboardInput): CheckoutDashboard {
  const { buyerId, ledger, orgs, seatPolicies, installations, currency } = input;
  const principal = resolveBuyerPrincipal(buyerId, orgs);

  const entitlementByOrder = new Map<string, Entitlement>();
  for (const ent of ledger.entitlements.values()) {
    if (ent.buyerId === buyerId) entitlementByOrder.set(ent.orderId, ent);
  }

  const lines: CheckoutLine[] = [];
  for (const order of sortedById(ledger.orders.values(), (o) => o.orderId)) {
    if (order.buyerId !== buyerId) continue;
    const product: Product | undefined = ledger.products.get(order.productId);
    const offer: Offer | undefined = ledger.offers.get(order.offerId);
    const ent = entitlementByOrder.get(order.orderId) ?? null;
    lines.push({
      orderId: order.orderId,
      orderState: order.state,
      productId: order.productId,
      productTitle: product?.title ?? null,
      offerId: order.offerId,
      pricingModel: offer?.pricingModel ?? null,
      perUse: offer?.perUse ?? null,
      amount: order.amount,
      refundedMinor: order.refundedMinor,
      entitlementId: ent?.entitlementId ?? null,
      entitlementState: ent?.state ?? null,
      seats: ent ? seatUsage(ent.entitlementId, seatsForOffer(order.offerId, seatPolicies), installations) : null,
      createdAtMs: order.createdAtMs,
    });
  }

  const settled = lines.filter((l) => SETTLED_ORDER_STATES.has(l.orderState));
  const gross = sumMoney(
    settled.map((l) => l.amount),
    currency,
  );
  if (!gross.ok) {
    return {
      buyerId,
      principal,
      lines,
      currency,
      grossMinor: 0,
      refundedMinor: 0,
      netMinor: 0,
      currencyMismatch: gross.detail,
    };
  }
  const refundedMinor = settled.reduce((sum, l) => sum + l.refundedMinor, 0);
  return {
    buyerId,
    principal,
    lines,
    currency,
    grossMinor: gross.total.amountMinor,
    refundedMinor,
    netMinor: gross.total.amountMinor - refundedMinor,
    currencyMismatch: null,
  };
}

// ---------------------------------------------------------------------------
// Refund dashboard
// ---------------------------------------------------------------------------

export interface RefundPosition {
  readonly orderId: string;
  readonly orderState: OrderState;
  readonly orderAmountMinor: number;
  readonly currency: string;
  /** Refunds the ledger has settled (`Order.refundedMinor`). */
  readonly settledMinor: number;
  /** Requested but not yet succeeded or failed — money that may still leave. */
  readonly pendingMinor: number;
  /**
   * `amount - settled - pending`. Conservative BY DESIGN: issuing this much is
   * safe even if every in-flight refund succeeds.
   */
  readonly refundableMinor: number;
  readonly refunds: readonly Refund[];
  readonly entitlementId: string | null;
  readonly entitlementState: Entitlement['state'] | null;
  /**
   * Installations that keep running if this order is fully refunded. Revocation
   * refuses `install`/`update` and still permits `repair` (D-042), so a refund
   * is not a kill switch and the dashboard must not imply that it is.
   */
  readonly activeInstallations: number;
  readonly intentsSurvivingRevocation: readonly DeliveryIntent[];
}

export interface RefundDashboardInput {
  readonly ledger: LedgerState;
  readonly installations: readonly Installation[];
  /** Restrict to one buyer; omit for the whole ledger. */
  readonly buyerId?: string;
}

const REFUND_INTENT_PROBES: readonly DeliveryIntent[] = ['install', 'update', 'repair'];

function survivingIntents(entitlement: Entitlement, installation: Installation): DeliveryIntent[] {
  // Ask the shared rule rather than restating it — see the module header.
  return REFUND_INTENT_PROBES.filter(
    (intent) => authorizeSeatIntent(installation, entitlement, intent).ok,
  );
}

/**
 * The refund position of every order, with the blast radius of revoking it.
 *
 * `pendingMinor` is the rail: `Order.refundedMinor` alone would report the full
 * remainder as refundable while a refund is already in flight.
 */
export function refundDashboard(input: RefundDashboardInput): readonly RefundPosition[] {
  const { ledger, installations, buyerId } = input;

  const refundsByOrder = new Map<string, Refund[]>();
  for (const refund of sortedById(ledger.refunds.values(), (r) => r.refundId)) {
    const bucket = refundsByOrder.get(refund.orderId);
    if (bucket) bucket.push(refund);
    else refundsByOrder.set(refund.orderId, [refund]);
  }

  const entitlementByOrder = new Map<string, Entitlement>();
  for (const ent of ledger.entitlements.values()) entitlementByOrder.set(ent.orderId, ent);

  const positions: RefundPosition[] = [];
  for (const order of sortedById(ledger.orders.values(), (o) => o.orderId)) {
    if (buyerId !== undefined && order.buyerId !== buyerId) continue;
    const refunds = refundsByOrder.get(order.orderId) ?? [];
    const pendingMinor = refunds
      .filter((r) => r.state === 'pending')
      .reduce((sum, r) => sum + r.amount.amountMinor, 0);
    const ent = entitlementByOrder.get(order.orderId) ?? null;

    const held = ent
      ? installations.filter((i) => i.entitlementId === ent.entitlementId && i.state === 'active')
      : [];
    // Every active installation resolves identically under the shared rule, so
    // one probe describes them all; an empty set survives nothing.
    const surviving = ent && held.length > 0 ? survivingIntents({ ...ent, state: 'revoked' }, held[0]) : [];

    positions.push({
      orderId: order.orderId,
      orderState: order.state,
      orderAmountMinor: order.amount.amountMinor,
      currency: order.amount.currency,
      settledMinor: order.refundedMinor,
      pendingMinor,
      refundableMinor: Math.max(0, order.amount.amountMinor - order.refundedMinor - pendingMinor),
      refunds,
      entitlementId: ent?.entitlementId ?? null,
      entitlementState: ent?.state ?? null,
      activeInstallations: held.length,
      intentsSurvivingRevocation: surviving,
    });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Support dashboard
// ---------------------------------------------------------------------------

export type SupportBlockCode =
  | 'no-entitlement'
  | 'not-entitled'
  | 'entitlement-revoked'
  | 'installation-released'
  | 'no-seats-available';

export interface SupportFinding {
  readonly entitlementId: string;
  readonly orderId: string;
  readonly productId: string;
  readonly entitlementState: Entitlement['state'];
  readonly seats: SeatUsage;
  /** This user's installation against the entitlement, if any. */
  readonly installationId: string | null;
  readonly installationState: Installation['state'] | null;
  /** Null when nothing blocks the requested intent. */
  readonly blocked: { readonly code: SupportBlockCode; readonly detail: string } | null;
}

export interface SupportDashboard {
  readonly userId: string;
  readonly buyerId: string;
  readonly intent: DeliveryIntent;
  readonly principal: BuyerPrincipal;
  /** The user's role in the buying org; null for an individual buyer. */
  readonly orgRole: OrgRole | null;
  readonly entitled: boolean;
  readonly findings: readonly SupportFinding[];
  /** True when at least one finding permits `intent`. */
  readonly anyPermitted: boolean;
}

export interface SupportDashboardInput {
  readonly userId: string;
  readonly buyerId: string;
  readonly intent: DeliveryIntent;
  readonly ledger: LedgerState;
  readonly orgs: ReadonlyMap<string, Organization>;
  readonly seatPolicies: ReadonlyMap<string, SeatPolicy>;
  readonly installations: readonly Installation[];
}

/**
 * "Why can't this user install?", answered per entitlement.
 *
 * The refusal ORDER matches `allocateSeat` deliberately: entitlement existence,
 * then membership, then seat state, then capacity. Reporting "no seats
 * available" to someone who was never entitled sends an admin to buy seats that
 * would not help.
 */
export function supportDashboard(input: SupportDashboardInput): SupportDashboard {
  const { userId, buyerId, intent, ledger, orgs, seatPolicies, installations } = input;
  const principal = resolveBuyerPrincipal(buyerId, orgs);
  const orgRole =
    principal.kind === 'organization' ? (membershipOf(principal.org, userId)?.role ?? null) : null;
  const entitled = principalEntitles(principal, userId);

  const findings: SupportFinding[] = [];
  for (const ent of sortedById(ledger.entitlements.values(), (e) => e.entitlementId)) {
    if (ent.buyerId !== buyerId) continue;
    const order = ledger.orders.get(ent.orderId);
    const granted = order ? seatsForOffer(order.offerId, seatPolicies) : 1;
    const seats = seatUsage(ent.entitlementId, granted, installations);
    const mine =
      installations.find((i) => i.entitlementId === ent.entitlementId && i.holderId === userId) ?? null;

    let blocked: SupportFinding['blocked'] = null;
    if (!entitled) {
      blocked = {
        code: 'not-entitled',
        detail:
          principal.kind === 'organization'
            ? `'${userId}' is not a member of org '${principal.org.orgId}'`
            : `'${userId}' is not the individual buyer '${buyerId}'`,
      };
    } else if (mine) {
      const verdict = authorizeSeatIntent(mine, ent, intent);
      if (!verdict.ok) blocked = { code: verdict.code, detail: verdict.detail };
    } else if (seats.available < 1) {
      blocked = {
        code: 'no-seats-available',
        detail: `entitlement ${ent.entitlementId} has ${seats.used}/${seats.granted} seats in use`,
      };
    }

    findings.push({
      entitlementId: ent.entitlementId,
      orderId: ent.orderId,
      productId: ent.productId,
      entitlementState: ent.state,
      seats,
      installationId: mine?.installationId ?? null,
      installationState: mine?.state ?? null,
      blocked,
    });
  }

  if (findings.length === 0) {
    return {
      userId,
      buyerId,
      intent,
      principal,
      orgRole,
      entitled,
      findings: [],
      anyPermitted: false,
    };
  }
  return {
    userId,
    buyerId,
    intent,
    principal,
    orgRole,
    entitled,
    findings,
    anyPermitted: findings.some((f) => f.blocked === null),
  };
}

// ---------------------------------------------------------------------------
// Audit / export dashboard
// ---------------------------------------------------------------------------

export interface AuditIntegrity {
  readonly appliedCount: number;
  readonly duplicateCount: number;
  readonly rejectedCount: number;
  /** Every rejection, in fold order. Never elided — see the module header. */
  readonly rejections: readonly LedgerRejection[];
  /** Rejection codes present, sorted, for a one-glance triage. */
  readonly rejectionCodes: readonly string[];
}

export interface AuditPayoutRow {
  readonly payoutId: string;
  readonly creatorId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: Payout['state'];
  /** Whether the creator could actually be paid at export time. */
  readonly payoutReady: boolean;
  readonly payoutBlockCode: string | null;
}

export interface AuditExport {
  readonly schema: 'cupboard.audit.v1';
  readonly products: readonly Product[];
  readonly offers: readonly Offer[];
  readonly orders: readonly Order[];
  readonly entitlements: readonly Entitlement[];
  readonly refunds: readonly Refund[];
  readonly payouts: readonly AuditPayoutRow[];
  readonly installations: readonly Installation[];
  readonly organizations: readonly { readonly orgId: string; readonly memberCount: number }[];
  readonly integrity: AuditIntegrity;
}

export interface AuditExportInput {
  readonly ledger: LedgerState;
  readonly installations: readonly Installation[];
  readonly orgs: ReadonlyMap<string, Organization>;
  readonly creatorProfiles: ReadonlyMap<string, CreatorProfile>;
}

/**
 * A deterministic, reproducible export of ledger + accounts state.
 *
 * Every collection is sorted by its own id, so the same state exports the same
 * bytes regardless of insertion order — the property that lets two exports
 * taken from different replicas be compared directly.
 */
export function auditExport(input: AuditExportInput): AuditExport {
  const { ledger, installations, orgs, creatorProfiles } = input;

  const payouts: AuditPayoutRow[] = sortedById(ledger.payouts.values(), (p) => p.payoutId).map((p) => {
    const readiness: PayoutReadiness = payoutReadiness(p.creatorId, creatorProfiles);
    return {
      payoutId: p.payoutId,
      creatorId: p.creatorId,
      amountMinor: p.amount.amountMinor,
      currency: p.amount.currency,
      state: p.state,
      payoutReady: readiness.ok,
      payoutBlockCode: readiness.ok ? null : readiness.code,
    };
  });

  const rejectionCodes = [...new Set(ledger.rejected.map((r) => r.code))].sort();

  return {
    schema: 'cupboard.audit.v1',
    products: sortedById(ledger.products.values(), (p) => p.productId),
    offers: sortedById(ledger.offers.values(), (o) => o.offerId),
    orders: sortedById(ledger.orders.values(), (o) => o.orderId),
    entitlements: sortedById(ledger.entitlements.values(), (e) => e.entitlementId),
    refunds: sortedById(ledger.refunds.values(), (r) => r.refundId),
    payouts,
    installations: [...installations].sort((a, b) =>
      a.installationId < b.installationId ? -1 : a.installationId > b.installationId ? 1 : 0,
    ),
    organizations: [...orgs.values()]
      .map((o) => ({ orgId: o.orgId, memberCount: o.memberships.length }))
      .sort((a, b) => (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0)),
    integrity: {
      appliedCount: ledger.applied.length,
      duplicateCount: ledger.duplicates.length,
      rejectedCount: ledger.rejected.length,
      rejections: [...ledger.rejected],
      rejectionCodes,
    },
  };
}

// ---------------------------------------------------------------------------

function sortedById<T>(values: Iterable<T>, key: (value: T) => string): T[] {
  return [...values].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
