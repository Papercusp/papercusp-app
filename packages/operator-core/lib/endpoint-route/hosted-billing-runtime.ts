/**
 * Narrow production composition for hosted subscription billing at
 * app.papercusp.com — the sibling of `hosted-auth-runtime.ts`, re-exported from
 * it so the portal's prebundled hosted-auth package carries both (one bundle,
 * one dynamic import). Kept equally light: no route registry, no agent tools,
 * no flags/PostHog client (the composition injects the live-mode flag reading).
 *
 * Billing is OPTIONAL infrastructure: with no Stripe configuration the runtime
 * still mounts, `/plans` reports `configured:false`, and mutating routes answer
 * 503 — sign-in and the rest of the portal are unaffected.
 *
 * Configuration (all injected; secrets are references, never values):
 *   PAPERCUSP_HOSTED_PUBLIC_ORIGIN            shared with hosted auth
 *   PAPERCUSP_STRIPE_SECRET_KEY_REF           env:/file: ref to sk_test_… (sk_live_… needs the flag)
 *   PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF       env:/file: ref to the endpoint's whsec_…
 *   PAPERCUSP_HOSTED_BILLING_PLANS            JSON [{ planKey, priceId, label, description? }]
 *   PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID  optional bpc_… (API-created portal configuration)
 *   PAPERCUSP_STRIPE_ACCOUNT_ID               optional acct_…; credentials must resolve to this account
 *   PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID
 *                                             optional: the workspace whose reconciliation pass
 *                                             records this Stripe account's payment receipts
 *                                             (P-046). Unset = `/receipts` answers 503.
 *
 * stripe-subscription-signup-2026-10-01 P-005; receipts WI-10004802.
 */
import { withWorkspace } from '@papercusp/db-org';
import { withHostedServiceContext } from '@papercusp/db-org/tenant-context';
import type { Sql } from 'postgres';
import { Hono } from 'hono';
import type { RefusalContract } from '../capability-envelope/refusal-contract-types';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import { PostgresHostedBillingStore, type HostedBillingStore } from '../auth/hosted/billing/billing-store';
import { PostgresHostedUsageStore } from '../auth/hosted/billing/usage-store';
import { createOpenRouterHostedUsageCollector } from '../auth/hosted/billing/openrouter-usage';
import { createHostedUsageSource, type HostedBillingUsageSource, type HostedUsageCollector } from '../auth/hosted/billing/usage-service';
import type { HostedSubscriptionEntitlementProvider } from '../auth/hosted/billing/entitlement-seam';
import { createStripeBillingClient, STRIPE_API_BASE } from '../auth/hosted/billing/stripe-billing-client';
import type { HostedServiceContextRunner } from '../auth/hosted/workos-lifecycle-postgres';
import { customerPaymentReceipts } from '../cupboard/payment-receipt-store';
import { resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import {
  HOSTED_BILLING_ROUTES,
  createHostedBillingRoutes,
  type HostedBillingPlan,
  type HostedBillingReceiptSource,
  type HostedBillingRoute,
  type HostedBillingStripe,
} from './routes/hosted-billing';

export const HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS = HOSTED_BILLING_ROUTES.map(
  (route) => `${route.method} ${route.path}`,
);

export interface HostedBillingRuntimeConfiguration {
  readonly publicOrigin: string;
  readonly stripeSecretKeyRef: string | null;
  readonly stripeWebhookSecretRef: string | null;
  readonly plans: readonly HostedBillingPlan[];
  /** Explicit customer-portal configuration (`bpc_…`, not a secret); null = Stripe's dashboard default. */
  readonly stripePortalConfigurationId?: string | null;
  /** Pin the credential's account identity, independently of its test/live mode. */
  readonly stripeAccountId?: string | null;
  /** Workspace whose ledger holds this Stripe account's payment receipts; null = receipts not served. */
  readonly receiptsWorkspaceId?: string | null;
}

const PORTAL_CONFIGURATION_ID = /^bpc_[A-Za-z0-9]+$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A malformed receipts workspace id is a configuration error, never silently ignored. */
export function parseReceiptsWorkspaceId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!WORKSPACE_ID.test(value)) {
    throw new TypeError('hosted_billing_configuration_invalid:PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID');
  }
  return value;
}

/** Runs one read inside a workspace-scoped transaction (the receipt tables are workspace-RLS). */
export type HostedBillingWorkspaceRunner = <T>(workspaceId: string, fn: (sql: Sql) => Promise<T>) => Promise<T>;

/**
 * The default receipts source: the given workspace's ledger, read under that
 * workspace's RLS context. The route passes only the signed-in org's own
 * customer id, so this can never list another customer's payments.
 */
export function workspaceReceiptSource(
  workspaceId: string,
  runWorkspace: HostedBillingWorkspaceRunner = (id, fn) => withWorkspace(id, fn),
): HostedBillingReceiptSource {
  return (stripeCustomerId) => runWorkspace(workspaceId, (sql) => customerPaymentReceipts(workspaceId, stripeCustomerId, { sql }));
}

/** A malformed portal configuration id is a configuration error, never silently ignored. */
export function parseStripePortalConfigurationId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!PORTAL_CONFIGURATION_ID.test(value)) {
    throw new TypeError('hosted_billing_configuration_invalid:PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID');
  }
  return value;
}

export function parseStripeAccountId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!ACCOUNT_ID.test(value)) throw new TypeError('hosted_billing_configuration_invalid:PAPERCUSP_STRIPE_ACCOUNT_ID');
  return value;
}

const PLAN_KEY = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PRICE_ID = /^price_[A-Za-z0-9]+$/;

/** Parse the plan list; a malformed list is a configuration error, never silently empty. */
export function parseHostedBillingPlans(raw: string | undefined): HostedBillingPlan[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError('hosted_billing_configuration_invalid:PAPERCUSP_HOSTED_BILLING_PLANS');
  }
  if (!Array.isArray(parsed)) throw new TypeError('hosted_billing_configuration_invalid:PAPERCUSP_HOSTED_BILLING_PLANS');
  const seen = new Set<string>();
  return parsed.map((entry, index) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    const planKey = typeof e.planKey === 'string' ? e.planKey.trim() : '';
    const priceId = typeof e.priceId === 'string' ? e.priceId.trim() : '';
    const label = typeof e.label === 'string' ? e.label.trim() : '';
    if (!PLAN_KEY.test(planKey) || !PRICE_ID.test(priceId) || !label || label.length > 80 || seen.has(planKey)) {
      throw new TypeError(`hosted_billing_configuration_invalid:PAPERCUSP_HOSTED_BILLING_PLANS[${index}]`);
    }
    seen.add(planKey);
    const description = typeof e.description === 'string' && e.description.trim() ? e.description.trim().slice(0, 280) : null;
    return { planKey, priceId, label, description };
  });
}

const optionalRef = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function readHostedBillingRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): HostedBillingRuntimeConfiguration {
  const publicOrigin = env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN?.trim();
  if (!publicOrigin) throw new TypeError('hosted_billing_runtime_configuration_missing:PAPERCUSP_HOSTED_PUBLIC_ORIGIN');
  return {
    publicOrigin,
    stripeSecretKeyRef: optionalRef(env.PAPERCUSP_STRIPE_SECRET_KEY_REF),
    stripeWebhookSecretRef: optionalRef(env.PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF),
    plans: parseHostedBillingPlans(env.PAPERCUSP_HOSTED_BILLING_PLANS),
    stripePortalConfigurationId: parseStripePortalConfigurationId(env.PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID),
    stripeAccountId: parseStripeAccountId(env.PAPERCUSP_STRIPE_ACCOUNT_ID),
    receiptsWorkspaceId: parseReceiptsWorkspaceId(env.PAPERCUSP_HOSTED_BILLING_RECEIPTS_WORKSPACE_ID),
  };
}

export interface HostedBillingRuntimeDependencies {
  /** The hosted-auth runtime's resolver — billing never re-implements session authority. */
  readonly resolvePrincipal: HostedPrincipalResolver;
  readonly resolveSecret?: (reference: string) => Promise<string>;
  readonly runService?: HostedServiceContextRunner;
  readonly store?: HostedBillingStore;
  readonly fetchImpl?: typeof fetch;
  /**
   * The `papercusp-hosted-billing-live-mode` flag (default OFF, owner-authority).
   * Absent = live mode refused: a composition that cannot read the flag must
   * not be able to charge real cards.
   */
  readonly liveModeAllowed?: () => Promise<boolean>;
  readonly entitlementProvider?: HostedSubscriptionEntitlementProvider;
  /** Overrides the configured receipts source (tests, or a composition with its own ledger access). */
  readonly receipts?: HostedBillingReceiptSource;
  /** Trusted server source overrides and collectors; no request can install a collector. */
  readonly usage?: HostedBillingUsageSource;
  readonly usageStore?: Pick<PostgresHostedUsageStore, 'append' | 'readRecords' | 'readOpenRouterBindings'>;
  readonly usageCollectors?: readonly HostedUsageCollector[];
  /** Workspace-scoped transaction runner for the default receipts source. */
  readonly runWorkspace?: HostedBillingWorkspaceRunner;
  readonly clock?: () => Date;
}

export interface HostedBillingRuntime {
  readonly app: Hono;
  readonly mounted: readonly HostedBillingRoute[];
  readonly configured: boolean;
  readonly unavailableReason: string | null;
}

async function resolveStripe(
  configuration: HostedBillingRuntimeConfiguration,
  dependencies: HostedBillingRuntimeDependencies,
): Promise<{ stripe: HostedBillingStripe | null; reason: string | null }> {
  if (!configuration.stripeSecretKeyRef || !configuration.stripeWebhookSecretRef) {
    return { stripe: null, reason: 'billing_not_configured' };
  }
  if (configuration.plans.length === 0) return { stripe: null, reason: 'no_plans_configured' };
  const resolveSecret = dependencies.resolveSecret ?? resolveSecretRef;
  const [resolvedSecretKey, resolvedWebhookSecret] = await Promise.all([
    resolveSecret(configuration.stripeSecretKeyRef),
    resolveSecret(configuration.stripeWebhookSecretRef),
  ]);
  const secretKey = resolvedSecretKey.trim();
  const webhookSecret = resolvedWebhookSecret.trim();
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) return { stripe: null, reason: 'invalid_webhook_secret' };
  const liveModeAllowed = dependencies.liveModeAllowed ? await dependencies.liveModeAllowed().catch(() => false) : false;
  const built = createStripeBillingClient({
    secretKey,
    fetchImpl: dependencies.fetchImpl ?? fetch,
    liveModeAllowed,
  });
  if (!built.ok) return { stripe: null, reason: built.code };
  if (configuration.stripeAccountId) {
    // A test credential is not proof that it belongs to the intended business.
    // Verify once at composition; never expose credentials or provider errors.
    try {
      const response = await (dependencies.fetchImpl ?? fetch)(`${STRIPE_API_BASE}/account`, {
        headers: { Authorization: `Bearer ${secretKey}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      if (!response.ok) return { stripe: null, reason: 'stripe_account_unavailable' };
      const account: unknown = await response.json();
      if (!account || typeof account !== 'object' || !('id' in account) || typeof account.id !== 'string') {
        return { stripe: null, reason: 'stripe_account_unavailable' };
      }
      if (account.id !== configuration.stripeAccountId) return { stripe: null, reason: 'stripe_account_mismatch' };
    } catch {
      return { stripe: null, reason: 'stripe_account_unavailable' };
    }
  }
  return {
    stripe: {
      client: built.client,
      webhookSecret,
      portalConfigurationId: configuration.stripePortalConfigurationId ?? null,
    },
    reason: null,
  };
}

function denial(status: 401 | 403 | 503, message: string): Response {
  const code = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authority_unavailable';
  return Response.json({ ok: false, error: { code, message } }, { status });
}

export async function createHostedBillingRuntime(
  configuration: HostedBillingRuntimeConfiguration,
  dependencies: HostedBillingRuntimeDependencies,
): Promise<HostedBillingRuntime> {
  const { stripe, reason } = await resolveStripe(configuration, dependencies);
  const store = dependencies.store ?? new PostgresHostedBillingStore(dependencies.runService ?? withHostedServiceContext);
  const usageStore = dependencies.usageStore ?? new PostgresHostedUsageStore(dependencies.runService ?? withHostedServiceContext);
  const routes = createHostedBillingRoutes({
    publicOrigin: configuration.publicOrigin,
    plans: configuration.plans,
    store,
    stripe,
    unavailableReason: reason,
    entitlementProvider: dependencies.entitlementProvider,
    receipts: dependencies.receipts
      ?? (configuration.receiptsWorkspaceId
        ? workspaceReceiptSource(configuration.receiptsWorkspaceId, dependencies.runWorkspace)
        : undefined),
    usage: dependencies.usage ?? createHostedUsageSource({
      store: usageStore,
      collectors: dependencies.usageCollectors ?? [createOpenRouterHostedUsageCollector({
        store: usageStore, readCredential: dependencies.resolveSecret ?? resolveSecretRef,
        fetch: dependencies.fetchImpl,
      })],
      maximumAgeMs: 5 * 60_000,
    }),
    clock: dependencies.clock,
  });
  const mounted = routes.map((route) => `${route.method} ${route.path}`);
  if (
    mounted.length !== HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS.length
    || mounted.some((key, index) => key !== HOSTED_BILLING_RUNTIME_MOUNTED_ROUTE_KEYS[index])
  ) throw new Error(`hosted_billing_runtime_surface_mismatch:${JSON.stringify(mounted)}`);

  const app = new Hono().basePath('/api');
  for (const route of routes) {
    const required = route.auth === 'public' ? [] : route.auth.capabilities;
    if (route.auth !== 'public' && required.length === 0) {
      throw new Error(`hosted_billing_runtime_invalid_authority:${route.method} ${route.path}`);
    }
    app.on(route.method, route.path, async (context) => {
      if (route.auth === 'public') return route.handler(context.req.raw, { principal: null });
      const resolution = await dependencies.resolvePrincipal(context.req.raw.headers);
      if (!resolution.ok) {
        const status = resolution.reason === 'authority_unavailable' ? 503
          : resolution.reason === 'membership_not_active'
            || resolution.reason === 'session_organization_mismatch'
            || resolution.reason === 'workspace_not_in_organization' ? 403 : 401;
        return denial(status, resolution.reason);
      }
      if (required.some((permission) => !resolution.principal.capabilities.has(permission))) {
        return Response.json({
          ok: false,
          error: {
            code: 'forbidden',
            message: 'permission_missing',
            refusal: {
              observed: { route: `${route.method} ${route.path}`, required: required.join(',') },
              liftsWhen:
                'the session principal holds every capability the billing route requires (a hosted-membership ' +
                'role change by the organization owner/admin; the session then re-resolves on its next request). ' +
                'Retrying the same session without the capability changes nothing',
              whoCanMakeItTrue: ['owner'],
            } satisfies RefusalContract,
          },
        }, { status: 403 });
      }
      return route.handler(context.req.raw, { principal: resolution.principal });
    });
  }
  return { app, mounted: routes, configured: stripe !== null, unavailableReason: reason };
}
