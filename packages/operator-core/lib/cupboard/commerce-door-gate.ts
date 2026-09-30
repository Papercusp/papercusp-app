/**
 * commerce-door-gate — the ONE place a production Cupboard commerce door meets
 * the P-010 ledger and the P-011 account/dashboard projections
 * (shared-pot-dao-cupboard-v1-2026-09-04 D-045 §3d).
 *
 * WHY THIS EXISTS
 * ---------------
 * `commerce-accounts.ts` and `commerce-dashboards.ts` had ZERO production
 * importers (WI-2146273): P-011's text promises checkout, refund, support and
 * audit/export surfaces, and every one of them existed only as a module a test
 * imported directly. This gate is the reachability fix — the sibling of
 * `install-door-gate`, built to the same shape for the same reason.
 *
 * WHY ONE GATE RATHER THAN FOUR WIRINGS
 * -------------------------------------
 * The rules below are AUTHORIZATION properties — who may spend an org's money,
 * whose refund may be issued, how much of it. D-001 reuse-first exists so a
 * guard of that kind is decided once rather than in four hand-maintained copies
 * that drift apart. Each door supplies only what it alone knows (the offer, the
 * order, the intent); every rule is decided here.
 *
 * THE RULE THAT IS EASY TO MISS
 * -----------------------------
 * `resolveBuyerPrincipal` NEVER FAILS. An id that matches no organization comes
 * back as `{ kind: 'individual', userId: <that id> }` — which is correct for its
 * own callers, where the id is a buyer id that may legitimately be a person.
 * At a door it is a hole: a caller who passes a `buyerOrgId` naming an
 * organization that does not exist would be resolved to an INDIVIDUAL buyer
 * identified by that same string, and `principalEntitles` would then compare it
 * against the acting user rather than against any membership list. Every rule
 * here that takes an org id therefore asserts `kind === 'organization'`
 * explicitly (`unknown-org`) instead of trusting the resolver's fallback. The
 * fallback is not a bug in `commerce-accounts` — it is a shape whose safe use
 * depends on the caller knowing which of the two things it is holding.
 *
 * WHERE THE ACTING USER COMES FROM
 * --------------------------------
 * The agent-tool context carries `workspaceId` and `slug` only — there is no
 * user identity on it (measured: every `ctx.principal?.…` read in
 * `agent-tools/` is one of those two). So a door cannot infer WHO is acting and
 * must be told; `actingUserId` is a required argument on every door, and the
 * gate refuses an actor who is not a member of the buying organization
 * (`actor-not-in-org`). Inferring the actor from the workspace instead would
 * make every agent in a workspace able to spend any org's money.
 */
import {
  membershipOf,
  principalEntitles,
  resolveBuyerPrincipal,
  type Installation,
  type Organization,
  type OrgRole,
  type SeatPolicy,
} from './commerce-accounts';
import {
  checkoutDashboard,
  commerceCatalogDashboard,
  refundDashboard,
  supportDashboard,
  auditExport,
  type AuditExport,
  type CommerceCatalogLine,
  type CheckoutDashboard,
  type RefundPosition,
  type SupportDashboard,
} from './commerce-dashboards';
import type { CreatorProfile } from './commerce-accounts';
import type { LedgerState, Money } from './commerce-ledger';
import type { DeliveryIntent } from './entitled-delivery';
import { perUseDashboard, type PerUseDashboard, type PerUseRollup } from './ledger-p2p-bridge';

/**
 * Everything the four doors read, loaded once through the single persistence
 * seam (see `commerce-door-gate-io.loadCommerceState`).
 *
 * It is one object rather than four loader calls so that a dashboard read and
 * the authorization decision guarding it are computed from the SAME snapshot —
 * two loads could disagree, and the disagreement would show up as a refusal
 * that contradicts the numbers the caller was just shown.
 */
export interface CommerceSnapshot {
  readonly ledger: LedgerState;
  readonly orgs: ReadonlyMap<string, Organization>;
  readonly seatPolicies: ReadonlyMap<string, SeatPolicy>;
  readonly installations: readonly Installation[];
  readonly creatorProfiles: ReadonlyMap<string, CreatorProfile>;
  /**
   * Per-use positions bridged from the P-016 commerce stream (P-035).
   *
   * REQUIRED and explicitly nullable, so every loader states which it means:
   * `null` is "no P2P commerce source is configured for this process" and an
   * empty rollup is "a source is configured and there is no per-use activity".
   * Collapsing those two into one optional field is how a dashboard reports a
   * mis-wired loader as a quiet month.
   */
  readonly perUse: PerUseRollup | null;
}

export type CommerceDoorRefusalCode =
  /** The id named an organization that does not exist. See the module header. */
  | 'unknown-org'
  /** The acting user is not a member of the buying organization. */
  | 'actor-not-in-org'
  /** The hosted checkout builder accepts quantity 1 only (P-010 contract). */
  | 'unsupported-quantity'
  /** The per-use channel cap must be a positive safe integer. */
  | 'invalid-max-spend'
  | 'unknown-order'
  /** The order exists but belongs to a different buyer. */
  | 'order-not-owned'
  /** Nothing is left to refund on this order. */
  | 'nothing-refundable'
  /** The amount asked for exceeds what may safely be issued. */
  | 'refund-exceeds-refundable'
  | 'currency-mismatch';

export interface CommerceDoorRefusal {
  readonly ok: false;
  readonly code: CommerceDoorRefusalCode;
  readonly detail: string;
}

function refuse(code: CommerceDoorRefusalCode, detail: string): CommerceDoorRefusal {
  return { ok: false, code, detail };
}

/**
 * Resolve a BUYING ORGANIZATION and check the actor may act for it.
 *
 * Every door funnels through this, which is what makes "unknown org" and
 * "actor is a stranger" impossible to forget in one door and remember in
 * another.
 */
export type OrgActorVerdict =
  | { readonly ok: true; readonly org: Organization; readonly role: OrgRole }
  | CommerceDoorRefusal;

export function authorizeOrgActor(
  buyerOrgId: string,
  actingUserId: string,
  orgs: ReadonlyMap<string, Organization>,
): OrgActorVerdict {
  const principal = resolveBuyerPrincipal(buyerOrgId, orgs);
  if (principal.kind !== 'organization') {
    // NOT a fallthrough to the individual-buyer path: see the module header.
    return refuse('unknown-org', `no organization ${buyerOrgId} exists`);
  }
  const membership = membershipOf(principal.org, actingUserId);
  if (!membership) {
    return refuse(
      'actor-not-in-org',
      `${actingUserId} is not a member of ${buyerOrgId} and may not act for it`,
    );
  }
  return { ok: true, org: principal.org, role: membership.role };
}

// ---------------------------------------------------------------------------
// §1 — checkout
// ---------------------------------------------------------------------------

export interface CheckoutDoorInput {
  readonly buyerOrgId: string;
  readonly actingUserId: string;
  readonly offerId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
  readonly quantity?: number;
  /** Required by a per-use offer; ignored only until the hosted offer lookup. */
  readonly maxSpendMicros?: number;
}

/** The request body the hosted `POST /commerce/checkout-sessions` route takes. */
export interface CheckoutSessionRequest {
  readonly buyerOrgId: string;
  readonly offerId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
  readonly quantity: number;
  readonly maxSpendMicros?: number;
}

export type CheckoutDoorDecision =
  | { readonly ok: true; readonly request: CheckoutSessionRequest; readonly actorRole: OrgRole }
  | CommerceDoorRefusal;

/**
 * Decide whether a checkout may be started, and shape the hosted request.
 *
 * The quantity check is deliberately made HERE as well as by the Worker: the
 * hosted route's 422 is a backstop for a caller that bypasses this door, and
 * refusing locally means an unsupported request never becomes a provider round
 * trip (or a `pending` order row) in the first place.
 */
export function gateCheckout(
  input: CheckoutDoorInput,
  snapshot: Pick<CommerceSnapshot, 'orgs'>,
): CheckoutDoorDecision {
  const actor = authorizeOrgActor(input.buyerOrgId, input.actingUserId, snapshot.orgs);
  if (!actor.ok) return actor;

  const quantity = input.quantity ?? 1;
  if (quantity !== 1) {
    return refuse(
      'unsupported-quantity',
      `quantity ${quantity} is not supported — the hosted checkout builder issues one seat per order`,
    );
  }
  if (
    input.maxSpendMicros !== undefined &&
    (!Number.isSafeInteger(input.maxSpendMicros) || input.maxSpendMicros <= 0)
  ) {
    return refuse('invalid-max-spend', 'maxSpendMicros must be a positive safe integer');
  }

  return {
    ok: true,
    actorRole: actor.role,
    request: {
      buyerOrgId: input.buyerOrgId,
      offerId: input.offerId,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      idempotencyKey: input.idempotencyKey,
      quantity,
      ...(input.maxSpendMicros !== undefined ? { maxSpendMicros: input.maxSpendMicros } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// §2 — refund request
// ---------------------------------------------------------------------------

export interface RefundDoorInput {
  readonly buyerOrgId: string;
  readonly actingUserId: string;
  readonly orderId: string;
  /** Omit to request the whole refundable remainder. */
  readonly amountMinor?: number;
  readonly reason?: string;
}

export interface RefundDoorRequest {
  readonly orderId: string;
  readonly amount: Money;
  readonly reason: string | null;
}

export type RefundDoorDecision =
  | {
      readonly ok: true;
      readonly request: RefundDoorRequest;
      readonly position: RefundPosition;
    }
  | CommerceDoorRefusal;

/**
 * Decide whether a refund may be requested, and for how much.
 *
 * The ceiling is `RefundPosition.refundableMinor`, which is
 * `amount - settled - PENDING` (EI-22438759043480870): subtracting refunds that
 * are merely in flight is what stops two overlapping requests from together
 * exceeding the order. Using `Order.refundedMinor` instead — the obvious
 * reading — would report the full remainder as available to BOTH requests, and
 * the ledger's own `refund-exceeds-order` rejection would then be the first
 * thing to notice, after the provider had already been asked for the money.
 */
export function gateRefundRequest(
  input: RefundDoorInput,
  snapshot: Pick<CommerceSnapshot, 'ledger' | 'orgs' | 'installations'>,
): RefundDoorDecision {
  const actor = authorizeOrgActor(input.buyerOrgId, input.actingUserId, snapshot.orgs);
  if (!actor.ok) return actor;

  const order = snapshot.ledger.orders.get(input.orderId);
  if (!order) return refuse('unknown-order', `order ${input.orderId} is not in the ledger`);
  if (order.buyerId !== input.buyerOrgId) {
    // Ownership is checked against the ORDER, not only the actor's membership:
    // being an admin of one org must not let you refund another org's order.
    return refuse(
      'order-not-owned',
      `order ${input.orderId} belongs to ${order.buyerId}, not ${input.buyerOrgId}`,
    );
  }

  const positions = refundDashboard({
    ledger: snapshot.ledger,
    installations: snapshot.installations,
    buyerId: input.buyerOrgId,
  });
  const position = positions.find((p) => p.orderId === input.orderId);
  if (!position) {
    return refuse('unknown-order', `order ${input.orderId} has no refund position`);
  }
  if (position.refundableMinor <= 0) {
    return refuse(
      'nothing-refundable',
      `order ${input.orderId} has nothing refundable (settled ${position.settledMinor}, pending ${position.pendingMinor} of ${position.orderAmountMinor})`,
    );
  }

  const requested = input.amountMinor ?? position.refundableMinor;
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return refuse('refund-exceeds-refundable', `${String(requested)} is not a positive minor-unit amount`);
  }
  if (requested > position.refundableMinor) {
    return refuse(
      'refund-exceeds-refundable',
      `${requested} exceeds the ${position.refundableMinor} refundable on ${input.orderId} ` +
        `(${position.settledMinor} already settled, ${position.pendingMinor} still in flight)`,
    );
  }

  return {
    ok: true,
    position,
    request: {
      orderId: input.orderId,
      amount: { amountMinor: requested, currency: position.currency },
      reason: input.reason ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// §3 — support request
// ---------------------------------------------------------------------------

export interface SupportDoorInput {
  readonly buyerOrgId: string;
  readonly actingUserId: string;
  /** The user being diagnosed; defaults to the acting user. */
  readonly subjectUserId?: string;
  readonly intent: DeliveryIntent;
}

export type SupportDoorDecision =
  | { readonly ok: true; readonly dashboard: SupportDashboard }
  | CommerceDoorRefusal;

/**
 * "Why can't this user install?", answered at a door.
 *
 * The SUBJECT need not be the actor — an org admin diagnosing a colleague is
 * the whole point of the surface — but the ACTOR must still belong to the org,
 * which is why both ids appear.
 */
export function gateSupportRequest(
  input: SupportDoorInput,
  snapshot: Pick<CommerceSnapshot, 'ledger' | 'orgs' | 'seatPolicies' | 'installations'>,
): SupportDoorDecision {
  const actor = authorizeOrgActor(input.buyerOrgId, input.actingUserId, snapshot.orgs);
  if (!actor.ok) return actor;

  const subjectUserId = input.subjectUserId ?? input.actingUserId;
  return {
    ok: true,
    dashboard: supportDashboard({
      userId: subjectUserId,
      buyerId: input.buyerOrgId,
      intent: input.intent,
      ledger: snapshot.ledger,
      orgs: snapshot.orgs,
      seatPolicies: snapshot.seatPolicies,
      installations: snapshot.installations,
    }),
  };
}

// ---------------------------------------------------------------------------
// §4 — dashboards read
// ---------------------------------------------------------------------------

export const COMMERCE_DASHBOARDS = ['catalog', 'checkout', 'refunds', 'audit', 'per-use'] as const;
export type CommerceDashboardName = (typeof COMMERCE_DASHBOARDS)[number];

export interface DashboardsDoorInput {
  readonly buyerOrgId: string;
  readonly actingUserId: string;
  /** Omit for every dashboard. */
  readonly dashboards?: readonly CommerceDashboardName[];
  /** Denomination the checkout totals are reported in. */
  readonly currency?: string;
}

export interface DashboardsDoorResult {
  readonly catalog?: readonly CommerceCatalogLine[];
  readonly checkout?: CheckoutDashboard;
  readonly refunds?: readonly RefundPosition[];
  readonly audit?: AuditExport;
  /**
   * Per-use revenue and reversals (P-035). Reported in MICROS as decimal
   * strings rather than in the ledger's minor units: a per-use unit is
   * routinely worth a fraction of one cent, so converting here would round most
   * of this dashboard's rows to zero.
   */
  readonly perUse?: PerUseDashboard;
}

export type DashboardsDoorDecision =
  | { readonly ok: true; readonly result: DashboardsDoorResult }
  | CommerceDoorRefusal;

/**
 * Read the P-011 projections for one buying organization.
 *
 * PURITY IS THE CONTRACT: every function called here is a fold over the
 * snapshot and writes nothing. That is what makes a dashboards read safe to
 * expose to an agent at all — a read surface that could mutate the ledger would
 * be a write door wearing a report's name. The gate adds only authorization;
 * it never filters or reshapes the projections, because a dashboard that
 * quietly hides rows is worse than one that refuses.
 */
export function gateCommerceDashboards(
  input: DashboardsDoorInput,
  snapshot: CommerceSnapshot,
): DashboardsDoorDecision {
  const actor = authorizeOrgActor(input.buyerOrgId, input.actingUserId, snapshot.orgs);
  if (!actor.ok) return actor;

  const wanted = new Set<CommerceDashboardName>(input.dashboards ?? COMMERCE_DASHBOARDS);
  const result: {
    catalog?: readonly CommerceCatalogLine[];
    checkout?: CheckoutDashboard;
    refunds?: readonly RefundPosition[];
    audit?: AuditExport;
    perUse?: PerUseDashboard;
  } = {};

  if (wanted.has('catalog')) {
    result.catalog = commerceCatalogDashboard(snapshot.ledger);
  }
  if (wanted.has('checkout')) {
    result.checkout = checkoutDashboard({
      buyerId: input.buyerOrgId,
      ledger: snapshot.ledger,
      orgs: snapshot.orgs,
      seatPolicies: snapshot.seatPolicies,
      installations: snapshot.installations,
      currency: input.currency ?? 'USD',
    });
  }
  if (wanted.has('refunds')) {
    result.refunds = refundDashboard({
      ledger: snapshot.ledger,
      installations: snapshot.installations,
      buyerId: input.buyerOrgId,
    });
  }
  if (wanted.has('audit')) {
    result.audit = auditExport({
      ledger: snapshot.ledger,
      installations: snapshot.installations,
      orgs: snapshot.orgs,
      creatorProfiles: snapshot.creatorProfiles,
    });
  }
  if (wanted.has('per-use')) {
    // Scoped to the acting org by `perUseDashboard`, for the same reason
    // `refundDashboard` takes a buyerId: a per-use channel names a payer and a
    // seller, and showing a stranger's settled revenue on a read surface is a
    // leak whether or not it was meant as one.
    result.perUse = perUseDashboard(snapshot.perUse, input.buyerOrgId);
  }

  return { ok: true, result };
}

/** Whether a decision is the refusal branch — the one check every door makes. */
export function isCommerceRefusal(
  decision: { readonly ok: boolean },
): decision is CommerceDoorRefusal {
  return decision.ok === false;
}

/** Re-exported so `principalEntitles` has exactly one import path at the doors. */
export { principalEntitles };
