/**
 * Stripe → hosted-billing facts. The ONE place hosted billing reads Stripe
 * subscription/invoice/checkout field names (the cupboard adapter
 * `cupboard/payment-adapters/stripe.ts` does the same job for listing orders;
 * signature verification is reused from there, not re-implemented).
 *
 * A delivery becomes zero or more FACTS. Facts are applied to Postgres as
 * order-independent max-registers (see `subscriptionOrderKey` and migration
 * 1276), so the final subscription row does not depend on delivery order.
 *
 * stripe-subscription-signup-2026-10-01 P-003.
 */
import { isHostedSubscriptionStatus, TERMINAL_SUBSCRIPTION_STATUSES, type HostedSubscriptionStatus } from './entitlement-seam';

export const HOSTED_BILLING_HANDLED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_failed',
] as const;

export interface SubscriptionStateFact {
  readonly kind: 'subscription';
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly status: Exclude<HostedSubscriptionStatus, 'pending'>;
  readonly priceId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
}

export interface InvoiceFact {
  readonly kind: 'invoice';
  /** Null when the invoice does not carry org metadata; the store resolves it from the customer mapping. */
  readonly organizationId: string | null;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
  readonly invoiceId: string;
  readonly invoiceStatus: 'paid' | 'payment_failed';
}

export interface CheckoutCompletedFact {
  readonly kind: 'checkout';
  readonly organizationId: string;
  readonly stripeCustomerId: string;
  readonly stripeSubscriptionId: string;
}

export type HostedBillingFact = SubscriptionStateFact | InvoiceFact | CheckoutCompletedFact;

export interface HostedBillingEvent {
  readonly eventId: string;
  readonly eventType: string;
  /** Stripe `created`, the ordering clock for this event's facts. */
  readonly createdAt: Date;
  readonly livemode: boolean;
  /** Empty = authenticated but irrelevant to subscription billing. */
  readonly facts: readonly HostedBillingFact[];
}

export type HostedBillingEventParse =
  | { readonly ok: true; readonly event: HostedBillingEvent }
  | { readonly ok: false; readonly code: 'malformed-body' | 'missing-organization'; readonly detail: string; readonly eventId: string | null; readonly eventType: string | null; readonly livemode: boolean | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (o: Obj | null | undefined, key: string): string | null =>
  o && typeof o[key] === 'string' && (o[key] as string).trim() ? (o[key] as string) : null;
/** Stripe expandable fields arrive either as an id string or as the expanded object. */
const ref = (o: Obj, key: string): string | null => {
  const v = o[key];
  if (typeof v === 'string' && v.trim()) return v;
  return isObj(v) ? str(v, 'id') : null;
};
const epoch = (v: unknown): Date | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null;
const meta = (o: Obj | null | undefined): Obj => (o && isObj(o.metadata) ? o.metadata : {});

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const orgId = (v: string | null): string | null => (v && ORG_ID.test(v) ? v.toLowerCase() : null);
const SUB_ID = /^sub_[A-Za-z0-9]+$/;
const CUS_ID = /^cus_[A-Za-z0-9]+$/;

function firstItem(sub: Obj): Obj | null {
  const items = isObj(sub.items) && Array.isArray(sub.items.data) ? (sub.items.data as unknown[]) : [];
  return isObj(items[0]) ? items[0] : null;
}

function subscriptionFact(sub: Obj): SubscriptionStateFact | 'missing-organization' | null {
  const stripeSubscriptionId = str(sub, 'id');
  const stripeCustomerId = ref(sub, 'customer');
  const status = sub.status;
  if (!stripeSubscriptionId || !SUB_ID.test(stripeSubscriptionId) || !stripeCustomerId || !CUS_ID.test(stripeCustomerId)) return null;
  if (!isHostedSubscriptionStatus(status) || status === 'pending') return null;
  const organizationId = orgId(str(meta(sub), 'organizationId'));
  if (!organizationId) return 'missing-organization';
  const item = firstItem(sub);
  const price = item && isObj(item.price) ? item.price : null;
  return {
    kind: 'subscription',
    organizationId,
    stripeCustomerId,
    stripeSubscriptionId,
    status,
    priceId: str(price, 'id') ?? (item ? ref(item, 'price') : null),
    // API 2025-03-31+ moved the period onto the subscription item; older versions keep it on the subscription.
    currentPeriodEnd: epoch(sub.current_period_end) ?? (item ? epoch(item.current_period_end) : null),
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    canceledAt: epoch(sub.canceled_at),
  };
}

function invoiceSubscriptionId(inv: Obj): string | null {
  const direct = ref(inv, 'subscription');
  if (direct) return direct;
  const parent = isObj(inv.parent) ? inv.parent : null;
  const details = parent && isObj(parent.subscription_details) ? parent.subscription_details : null;
  return details ? ref(details, 'subscription') : null;
}

function invoiceOrganizationId(inv: Obj): string | null {
  const legacy = isObj(inv.subscription_details) ? inv.subscription_details : null;
  const parent = isObj(inv.parent) ? inv.parent : null;
  const details = parent && isObj(parent.subscription_details) ? parent.subscription_details : null;
  return orgId(str(meta(details), 'organizationId') ?? str(meta(legacy), 'organizationId') ?? str(meta(inv), 'organizationId'));
}

/** Parse an AUTHENTICATED Stripe event body (verify the signature first). */
export function parseHostedBillingEvent(rawBody: string): HostedBillingEventParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: 'malformed-body', detail: 'body is not JSON', eventId: null, eventType: null, livemode: null };
  }
  if (!isObj(parsed)) return { ok: false, code: 'malformed-body', detail: 'event must be an object', eventId: null, eventType: null, livemode: null };
  const eventId = str(parsed, 'id');
  const eventType = str(parsed, 'type');
  const createdAt = epoch(parsed.created);
  const livemode = typeof parsed.livemode === 'boolean' ? parsed.livemode : null;
  const object = isObj(parsed.data) && isObj(parsed.data.object) ? parsed.data.object : null;
  const fail = (code: 'malformed-body' | 'missing-organization', detail: string): HostedBillingEventParse =>
    ({ ok: false, code, detail, eventId: eventId && /^evt_[A-Za-z0-9]+$/.test(eventId) ? eventId : null, eventType, livemode });
  if (!eventId || !/^evt_[A-Za-z0-9]+$/.test(eventId) || !eventType || !createdAt || livemode === null || !object) {
    return fail('malformed-body', 'event needs id (evt_…), type, created, livemode and data.object');
  }
  const facts: HostedBillingFact[] = [];
  switch (eventType) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed': {
      const fact = subscriptionFact(object);
      if (fact === 'missing-organization') return fail('missing-organization', `${eventType} subscription carries no metadata.organizationId`);
      if (!fact) return fail('malformed-body', `${eventType} subscription object lacks id/customer/status`);
      facts.push(fact);
      break;
    }
    case 'checkout.session.completed': {
      if (object.mode !== 'subscription') break; // one-time/cupboard checkouts belong to the cupboard ledger
      const stripeSubscriptionId = ref(object, 'subscription');
      const stripeCustomerId = ref(object, 'customer');
      const organizationId = orgId(str(meta(object), 'organizationId') ?? str(object, 'client_reference_id'));
      if (!organizationId) return fail('missing-organization', 'subscription checkout carries no organization reference');
      if (!stripeSubscriptionId || !SUB_ID.test(stripeSubscriptionId) || !stripeCustomerId || !CUS_ID.test(stripeCustomerId)) {
        return fail('malformed-body', 'subscription checkout lacks subscription/customer ids');
      }
      facts.push({ kind: 'checkout', organizationId, stripeCustomerId, stripeSubscriptionId });
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const stripeSubscriptionId = invoiceSubscriptionId(object);
      if (!stripeSubscriptionId) break; // a one-off invoice is not subscription state
      const stripeCustomerId = ref(object, 'customer');
      const invoiceId = str(object, 'id');
      if (!SUB_ID.test(stripeSubscriptionId) || !stripeCustomerId || !CUS_ID.test(stripeCustomerId) || !invoiceId) {
        return fail('malformed-body', `${eventType} invoice lacks id/customer/subscription`);
      }
      facts.push({
        kind: 'invoice',
        organizationId: invoiceOrganizationId(object),
        stripeCustomerId,
        stripeSubscriptionId,
        invoiceId,
        invoiceStatus: eventType === 'invoice.paid' ? 'paid' : 'payment_failed',
      });
      break;
    }
    default:
      break; // authenticated but irrelevant
  }
  return { ok: true, event: { eventId, eventType, createdAt, livemode, facts } };
}

/**
 * Same-second tie-break: the later lifecycle stage wins. Terminal statuses are
 * handled separately (they dominate regardless of time).
 */
const STATUS_RANK: Readonly<Record<HostedSubscriptionStatus, number>> = {
  pending: -1,
  incomplete: 0,
  trialing: 1,
  active: 2,
  past_due: 3,
  unpaid: 4,
  paused: 5,
  incomplete_expired: 6,
  canceled: 7,
};

export interface SubscriptionOrderKey {
  readonly terminal: boolean;
  readonly createdMs: number;
  readonly statusRank: number;
  readonly eventId: string;
}

export function subscriptionOrderKey(status: HostedSubscriptionStatus, createdAt: Date, eventId: string): SubscriptionOrderKey {
  return { terminal: TERMINAL_SUBSCRIPTION_STATUSES.has(status), createdMs: createdAt.getTime(), statusRank: STATUS_RANK[status], eventId };
}

/** Lexicographic comparison matching the SQL row comparison in billing-store.ts. */
export function compareSubscriptionOrderKeys(a: SubscriptionOrderKey, b: SubscriptionOrderKey): number {
  if (a.terminal !== b.terminal) return a.terminal ? 1 : -1;
  if (a.createdMs !== b.createdMs) return a.createdMs < b.createdMs ? -1 : 1;
  if (a.statusRank !== b.statusRank) return a.statusRank < b.statusRank ? -1 : 1;
  return a.eventId === b.eventId ? 0 : a.eventId < b.eventId ? -1 : 1;
}
