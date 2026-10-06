/**
 * THE seam between hosted subscription billing and the (not yet ready)
 * metering/entitlement system: "what does an active subscription entitle?"
 *
 * Signup, checkout and webhook code depend ONLY on this interface. They never
 * encode entitlement policy themselves; they persist subscription FACTS
 * (status, price, period) and ask the configured provider what those facts are
 * worth. Nothing derived is persisted, so swapping the provider (the metering
 * work, papercusp-monetization P-004/P-005) changes every organization's
 * entitlement on the next read without a data migration.
 *
 * The output reuses the org-scoped entitlement vocabulary of
 * `hosted-entitlement-schema.ts` (WI-40806): a subscription resolves to a
 * bundle key plus an optional `HostedEntitlementPatch`, with source `billing` —
 * the source that schema already reserves for "a future billing projection".
 *
 * stripe-subscription-signup-2026-10-01 P-001 / D-001.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type { HostedEntitlementPatch } from '../../hosted-entitlement-schema';

/** Stripe subscription statuses, plus `pending` = known from checkout, no subscription event yet. */
export const HOSTED_SUBSCRIPTION_STATUSES = [
  'pending',
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
] as const;
export type HostedSubscriptionStatus = (typeof HOSTED_SUBSCRIPTION_STATUSES)[number];

export function isHostedSubscriptionStatus(value: unknown): value is HostedSubscriptionStatus {
  return typeof value === 'string' && (HOSTED_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}

/** Statuses after which Stripe never revives the subscription. */
export const TERMINAL_SUBSCRIPTION_STATUSES: ReadonlySet<HostedSubscriptionStatus> = new Set(['canceled', 'incomplete_expired']);

/** Statuses that block starting a second subscription for the same organization. */
export const SUBSCRIBED_STATUSES: ReadonlySet<HostedSubscriptionStatus> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
]);

/** The persisted facts about an organization's current subscription. */
export interface HostedSubscriptionSnapshot {
  readonly organizationId: string;
  readonly stripeSubscriptionId: string;
  readonly status: HostedSubscriptionStatus;
  /** Configured plan key for `priceId`; null when the price is not (or no longer) configured. */
  readonly planKey: string | null;
  readonly priceId: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: Date | null;
  readonly livemode: boolean;
  readonly latestInvoiceStatus: 'paid' | 'payment_failed' | null;
}

export type HostedSubscriptionEntitlementReason =
  | 'active'
  | 'trialing'
  | 'grace_past_due'
  | 'not_subscribed'
  | 'inactive'
  | 'unknown_plan';

export interface HostedSubscriptionEntitlement {
  readonly entitled: boolean;
  readonly reason: HostedSubscriptionEntitlementReason;
  /** The hosted entitlement bundle this subscription maps to; null when not entitled. */
  readonly bundleKey: string | null;
  /**
   * Allowances (quotas/budgets/limits) the subscription adds. NULL means the
   * provider makes no allowance claim — the stub's answer until metering lands.
   * It never means "unlimited".
   */
  readonly patch: HostedEntitlementPatch | null;
  readonly source: 'billing';
  /** Which provider produced this answer (for audit and for the UI). */
  readonly providerId: string;
}

export interface HostedSubscriptionEntitlementProvider {
  readonly id: string;
  entitlementFor(
    snapshot: HostedSubscriptionSnapshot | null,
    now: Date,
  ): HostedSubscriptionEntitlement | Promise<HostedSubscriptionEntitlement>;
}

export const STUB_ENTITLEMENT_PROVIDER_ID = 'stub:plan-key-bundle';

/**
 * Default provider until metering is ready: an entitled status maps the plan
 * key to the `hosted-paid:<planKey>` bundle and claims NO allowances.
 * `past_due` stays entitled (Stripe's own retry window is the grace period);
 * an unconfigured price fails closed.
 */
export const stubHostedSubscriptionEntitlementProvider: HostedSubscriptionEntitlementProvider = {
  id: STUB_ENTITLEMENT_PROVIDER_ID,
  entitlementFor(snapshot) {
    const base = { source: 'billing' as const, providerId: STUB_ENTITLEMENT_PROVIDER_ID, patch: null };
    if (!snapshot) return { ...base, entitled: false, reason: 'not_subscribed', bundleKey: null };
    const reason: HostedSubscriptionEntitlementReason | null =
      snapshot.status === 'active' ? 'active'
        : snapshot.status === 'trialing' ? 'trialing'
          : snapshot.status === 'past_due' ? 'grace_past_due'
            : null;
    if (!reason) return { ...base, entitled: false, reason: 'inactive', bundleKey: null };
    if (!snapshot.planKey) return { ...base, entitled: false, reason: 'unknown_plan', bundleKey: null };
    return { ...base, entitled: true, reason, bundleKey: `hosted-paid:${snapshot.planKey}` };
  },
};

const state = pinModuleState('@papercusp/operator-core.hosted-billing-entitlement-seam', () => ({
  provider: stubHostedSubscriptionEntitlementProvider as HostedSubscriptionEntitlementProvider,
}));

/** Install the provider the metering work supplies. Returns the previous one (tests restore it). */
export function configureHostedSubscriptionEntitlementProvider(
  provider: HostedSubscriptionEntitlementProvider,
): HostedSubscriptionEntitlementProvider {
  const previous = state.provider;
  state.provider = provider;
  return previous;
}

export function currentHostedSubscriptionEntitlementProvider(): HostedSubscriptionEntitlementProvider {
  return state.provider;
}

/**
 * Resolve through a provider, failing CLOSED: a provider that throws or answers
 * malformed yields `entitled:false` rather than taking billing down with it.
 */
export async function resolveHostedSubscriptionEntitlement(
  snapshot: HostedSubscriptionSnapshot | null,
  options: { provider?: HostedSubscriptionEntitlementProvider; now?: Date } = {},
): Promise<HostedSubscriptionEntitlement> {
  const provider = options.provider ?? state.provider;
  try {
    const answer = await provider.entitlementFor(snapshot, options.now ?? new Date());
    if (!answer || typeof answer.entitled !== 'boolean' || answer.source !== 'billing') throw new Error('malformed');
    if (answer.entitled && !answer.bundleKey) throw new Error('entitled without a bundle');
    return answer;
  } catch {
    return {
      entitled: false,
      reason: 'inactive',
      bundleKey: null,
      patch: null,
      source: 'billing',
      providerId: provider.id,
    };
  }
}
