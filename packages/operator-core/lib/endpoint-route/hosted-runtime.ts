/** Production composition for the app.papercusp.com hosted control plane. */

import {
  withHostedServiceContext,
  withTenantContext,
  withWorkspace,
  type VerifiedTenantServerContext,
} from '@papercusp/db-org';
import {
  PostgresWorkosAccessClosureSink,
  PostgresWorkosLifecycleProjectionStore,
  workosLifecycleEventFromReceipt,
  type HostedServiceContextRunner,
} from '../auth/hosted/workos-lifecycle-postgres';
import { WorkosLifecycleWorker } from '../auth/hosted/workos-lifecycle-worker';
import { createWorkOSHostedIdentityProvider } from '../auth/hosted/workos-provider';
import {
  HostedRuntimeMembershipAuthority,
  HostedServiceIdentityDirectory,
  HostedServiceSessionStore,
  assertHostedServicePosture,
  serviceWorkOSSessionVault,
  type HostedTenantContextRunner,
} from '../auth/hosted/service-adapters';
import {
  intakeWorkOsWebhook,
  WorkOsWebhookReceiptStore,
  type WorkOsWebhookReceiptSink,
} from '../auth/hosted/workos-webhook-intake';
import { resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import {
  assembleHostedControlPlane,
  type AssembledHostedControlPlane,
} from './hosted-control-plane';
import { HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST, type HostedRouteAllowlistEntry } from './hosted-profile';
import { createHostedBrowserRoutes, type HostedBrowserRouteDependencies } from './hosted-browser';
import { ALL_ROUTES } from './routes';
import { createWorkOsWebhookRoute } from './routes/auth/workos-webhook';
import { HostedWorkspaceConnectorGateway, PostgresHostedWorkspaceConnectorStore } from './hosted-workspace-connector';
import { PostgresHostedCliStore } from './routes/hosted-cli';
import type { HostedPrincipal } from '../auth/hosted-principal';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationRecord,
} from '../workspace-host/hosted-provider-delegation';
import { resolveHostedGcpAuth } from '../workspace-host/hosted-gcp-auth';
import { awsProviderDelegationAdapter } from '../workspace-host/hosted-aws-auth';
import { hostedDelegationOrganization } from '../workspace-host/hosted-delegation-organization';
import { papercuspHostingGrantEffective } from '../workspace-host/hosted-gcp-hosting';
import { HostedSessionCookieCodec } from '../auth/hosted-session';
import { createWorkspaceHostProvisioningClient } from '../dbos/workspace-host-provision-client';
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { createHostedFirstWorkspace } from '../auth/hosted/first-workspace';
import {
  createHostedFirstWorkspaceDependencies,
  HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV,
  parseFirstWorkspaceOrganizations,
} from '../auth/hosted/first-workspace-dependencies';

export const HOSTED_CONTROL_PLANE_DISTRIBUTION_PROFILE = 'hosted-control-plane';

export const HOSTED_WORKOS_WEBHOOK_ALLOWLIST_ENTRY = {
  method: 'POST',
  path: '/auth/workos/webhook',
  access: 'public',
} as const satisfies HostedRouteAllowlistEntry;

export const HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS = [
  'GET /health',
  'GET /health/ready',
  'POST /auth/workos/webhook',
  'GET /hosted/browser/rest-query',
  'GET /hosted/browser/sse',
  'POST /hosted/browser/workspace-hosts/connection',
  'POST /hosted/browser/workspace-hosts/provision',
  'POST /hosted/browser/workspace-hosts/action',
  'POST /hosted/browser/onboarding/first-workspace',
  'POST /hosted/browser/onboarding/select-workspace',
  'GET /hosted/browser/onboarding/tutorial-progress',
  'POST /hosted/browser/onboarding/tutorial-progress',
  'POST /hosted/browser/onboarding/tutorial-help',
  'POST /hosted/browser/onboarding/tutorial-speech',
  'POST /hosted/workspaces/:workspaceId/connectors/enroll',
  'POST /hosted/workspaces/:workspaceId/connectors/rotate',
  'POST /hosted/workspaces/:workspaceId/connectors/revoke',
  'POST /hosted/workspaces/:workspaceId/connectors/session-ticket',
  'POST /hosted/connectors/register',
  'POST /hosted/connectors/heartbeat',
  'GET /hosted/connectors/events',
  'GET /hosted/connectors/socket',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/onboard',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/verify',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/rotate',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/revoke',
  'POST /hosted/cli/device/code',
  'GET /hosted/cli/device',
  'POST /hosted/cli/device/decision',
  'POST /hosted/cli/device/token',
  'GET /hosted/cli/workspaces',
  'POST /hosted/cli/workspaces/:workspaceId/terminal',
  'POST /hosted/cli/logout',
  // EAA P-008 (D-031): a local install links to the portal relay by the same device grant.
  'POST /hosted/relay/device/code',
  'POST /hosted/relay/device/token',
  'POST /hosted/relay/unlink',
  'GET /hosted/auth/sign-in',
  'GET /hosted/auth/callback',
  'POST /hosted/auth/logout',
  'GET /hosted/auth/session',
] as const;

export interface HostedRuntimeConfiguration {
  readonly publicOrigin: string;
  readonly controlPlaneWorkspaceId: string;
  readonly hostedSessionCookieSecretRef: string;
  readonly workosClientId: string;
  readonly workosApiKeyRef: string;
  readonly workosCookiePasswordRef: string;
  readonly workosWebhookSecretRef: string;
  readonly workosWebhookSignatureKeyRef?: string;
  /** Organizations admitted through the first-workspace door (D-384). Absent = closed. */
  readonly firstWorkspaceOrganizations?: ReadonlySet<string>;
  /**
   * The DBOS primary's `applicationVersion` (its `DBOS__APPVERSION`; bg-host-v1 on this box).
   * This process never runs DBOS, so provisioning is ENQUEUED onto that executor's queue.
   * Absent = the first-workspace door answers provisioning_unavailable.
   */
  readonly provisioningDbosAppVersion?: string;
}

export type HostedRuntimeSecretResolver = (reference: string) => Promise<string>;

/**
 * The configuration names this runtime actually DEREFERENCES, paired with the
 * environment variable that carries each one, in boot-preflight order.
 *
 * `workosWebhookSignatureKeyRef` is deliberately ABSENT. It is never resolved:
 * `createWorkOsWebhookRoute` hands it to the receipt store as an opaque
 * provenance label (`workos-webhook-intake.ts` `safeExternalRef`), so it is a
 * signing-key IDENTIFIER, not a secret reference. Dereferencing it — here or in
 * a deployment gate — would fail a correctly configured deployment. See
 * WI-2141402 / D-046.
 */
export const HOSTED_RUNTIME_RESOLVED_SECRET_REFS = [
  { field: 'hostedSessionCookieSecretRef', env: 'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF' },
  { field: 'workosApiKeyRef', env: 'WORKOS_API_KEY_REF' },
  { field: 'workosCookiePasswordRef', env: 'WORKOS_COOKIE_PASSWORD_REF' },
  { field: 'workosWebhookSecretRef', env: 'WORKOS_WEBHOOK_SECRET_REF' },
] as const satisfies readonly { field: keyof HostedRuntimeConfiguration; env: string }[];

/**
 * The configuration names whose value IS the configuration — never a pointer to
 * one — paired with the environment variable that carries each.
 *
 * The sibling of `HOSTED_RUNTIME_RESOLVED_SECRET_REFS`, and required for the
 * same reason: a deployment gate has to test these two sets DIFFERENTLY (a
 * literal is tested directly, a reference is dereferenced), so it necessarily
 * holds its own copy of the partition and can drift from this one on either
 * leg. Pinning only the reference leg moves that drift rather than stopping it
 * — WI-2141766, which is what this list exists to close.
 *
 * Together the two lists are exactly what `readHostedRuntimeConfiguration`
 * REQUIRES; `hosted-cutover-gate-ref-set.test.ts` proves that by exercising the
 * reader rather than by re-reading it, so a fourth copy cannot silently appear.
 */
export const HOSTED_RUNTIME_LITERAL_CONFIGURATION = [
  { field: 'publicOrigin', env: 'PAPERCUSP_HOSTED_PUBLIC_ORIGIN' },
  { field: 'controlPlaneWorkspaceId', env: 'PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID' },
  { field: 'workosClientId', env: 'WORKOS_CLIENT_ID' },
] as const satisfies readonly { field: keyof HostedRuntimeConfiguration; env: string }[];

/**
 * The optional provenance LABEL: present in the configuration, never required,
 * never dereferenced. See `HOSTED_RUNTIME_RESOLVED_SECRET_REFS` for why the
 * `_REF` suffix on this env name does not make it a reference.
 */
export const HOSTED_RUNTIME_OPTIONAL_LABELS = [
  { field: 'workosWebhookSignatureKeyRef', env: 'WORKOS_WEBHOOK_SECRET_KEY_REF' },
] as const satisfies readonly { field: keyof HostedRuntimeConfiguration; env: string }[];

/**
 * Turn a resolver failure into a fixed, value-safe message.
 *
 * The resolver's own errors name the REFERENCE and never the value, so their
 * text is safe to surface. Anything else — a database connection failure in
 * particular, whose message can embed a connection string WITH its password —
 * collapses to a bare code. Never interpolate an unknown error message here.
 * Same discipline as `apps/operator/bin/hosted-check-refs.ts`.
 */
function safeResolverFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^(hosted_secret_ref_(missing|malformed):|egress: )/.test(message) ? message : 'resolution_error';
}

/**
 * Boot-time reference preflight (unified-web-portal-2026-08-29, WI-2141402).
 *
 * Every reference above is otherwise dereferenced only at its point of use —
 * the WorkOS API key and cookie password on a sign-in, the webhook secret on a
 * webhook. So a hosted unit whose `*_REF` names were SET while the referenced
 * secrets were ABSENT started clean and passed `/api/health` while failing
 * every real request: a half-configured public profile that looks healthy to
 * every check the cut-over runbook performs, which is exactly what D-037/D-044
 * exist to prevent. `--check-env` is the gate for that (D-046), but it is a
 * procedure an operator runs, and the store can change between gate and start.
 * Resolving here makes a half-configured start a refusal to start instead.
 *
 * Resolved values are discarded rather than cached, so point-of-use resolution
 * keeps picking up a rotated secret; only the cookie secret — which the session
 * store needs at composition time anyway — is returned.
 */
async function preflightHostedSecretRefs(
  configuration: HostedRuntimeConfiguration,
  resolveSecret: HostedRuntimeSecretResolver,
): Promise<{ sessionCookieSecret: string }> {
  const resolved = new Map<string, string>();
  for (const { field, env } of HOSTED_RUNTIME_RESOLVED_SECRET_REFS) {
    const reference = configuration[field] as string;
    try {
      const value = await resolveSecret(reference);
      if (typeof value !== 'string' || value.trim().length === 0) {
        // Defensive: a resolver returning empty must not read as success.
        throw new Error(`hosted_secret_ref_missing:${reference} (resolved to an empty value)`);
      }
      resolved.set(field, value);
    } catch (error) {
      throw new Error(`hosted_runtime_secret_ref_unresolved:${env} — ${safeResolverFailure(error)}`, {
        cause: error,
      });
    }
  }
  return { sessionCookieSecret: resolved.get('hostedSessionCookieSecretRef') as string };
}

export interface HostedRuntimeDependencies {
  readonly resolveSecret?: HostedRuntimeSecretResolver;
  readonly runService?: HostedServiceContextRunner;
  readonly runTenant?: HostedTenantContextRunner;
  /** Injectable hosted SPA route leaves for hermetic composition tests. */
  readonly hostedBrowser?: HostedBrowserRouteDependencies;
  readonly providerDelegationAdapters?: Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>>;
  /** Default: the organization's own account in the GCP identity project (D-397). */
  readonly delegationOrganization?: (organizationId: string) => HostedDelegationOrganization;
}

function requiredConfiguration(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
    throw new TypeError(`hosted_runtime_configuration_missing:${name}`);
  }
  return value.trim();
}

export function readHostedRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): HostedRuntimeConfiguration {
  return {
    publicOrigin: requiredConfiguration(env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN, 'PAPERCUSP_HOSTED_PUBLIC_ORIGIN'),
    controlPlaneWorkspaceId: requiredConfiguration(
      env.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID,
      'PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID',
    ),
    hostedSessionCookieSecretRef: requiredConfiguration(
      env.PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF,
      'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF',
    ),
    workosClientId: requiredConfiguration(env.WORKOS_CLIENT_ID, 'WORKOS_CLIENT_ID'),
    workosApiKeyRef: requiredConfiguration(env.WORKOS_API_KEY_REF, 'WORKOS_API_KEY_REF'),
    workosCookiePasswordRef: requiredConfiguration(env.WORKOS_COOKIE_PASSWORD_REF, 'WORKOS_COOKIE_PASSWORD_REF'),
    workosWebhookSecretRef: requiredConfiguration(env.WORKOS_WEBHOOK_SECRET_REF, 'WORKOS_WEBHOOK_SECRET_REF'),
    ...(env.WORKOS_WEBHOOK_SECRET_KEY_REF?.trim()
      ? { workosWebhookSignatureKeyRef: env.WORKOS_WEBHOOK_SECRET_KEY_REF.trim() }
      : {}),
    ...(env[HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV]?.trim()
      ? { firstWorkspaceOrganizations: parseFirstWorkspaceOrganizations(env[HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV]) }
      : {}),
    ...(env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION?.trim()
      ? { provisioningDbosAppVersion: env.PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION.trim() }
      : {}),
  };
}

export function isHostedControlPlaneDistributionProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === HOSTED_CONTROL_PLANE_DISTRIBUTION_PROFILE;
}

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

export function productionProviderDelegationAdapters(): Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>> {
  const unavailable = (provider: 'azure'): HostedProviderDelegationAdapter => ({
    async verify() { throw new Error(`hosted_provider_delegation_${provider}_adapter_unavailable`); },
    async revoke(record) {
      return { evidenceRef: `delegation://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked` };
    },
  });
  const gcp: HostedProviderDelegationAdapter = {
    async verify(record: HostedProviderDelegationRecord) {
      const auth = await resolveHostedGcpAuth({
        credentialRef: record.credentialRef,
        provider: { hostedDelegation: { ...record, status: 'verified' } },
      });
      // A token mints as soon as the account exists; the host reservation takes a minute or
      // two longer to reach GCP's enforcement, and provisioning before it does would fail.
      const source = record.configuration.provider === 'gcp' ? record.configuration.source : null;
      if (source?.method === 'papercusp-hosted') {
        const effective = await papercuspHostingGrantEffective({
          projectId: source.projectId,
          hostId: source.hostId,
          accessToken: auth.accessToken,
        });
        if (!effective) throw new Error('hosted_provider_delegation_papercusp_hosting_not_effective');
      }
      return {
        identity: auth.identity ?? (record.configuration.provider === 'gcp'
          ? record.configuration.source.serviceAccountEmail
          : 'gcp:delegated'),
        evidenceRef: `gcp://projects/${auth.projectId ?? 'unknown'}/delegations/${record.connectionId}/${record.generation}`,
      };
    },
    async revoke(record) {
      return { evidenceRef: `delegation://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked` };
    },
  };
  // AWS walks the real chain: control plane -> the org's own role -> the customer's role
  // with the org's ExternalId, then proves the customer role refuses it WITHOUT the ExternalId
  // (aws-byoc-gcp-parity P-008, D-001, D-007).
  return { gcp, aws: awsProviderDelegationAdapter(), azure: unavailable('azure') };
}

function tenantServerContext(principal: HostedPrincipal): VerifiedTenantServerContext {
  const selectedWorkspaceId = principal.selectedWorkspaceId;
  if (!selectedWorkspaceId) throw new Error('hosted_provider_delegation_workspace_required');
  return {
    principal: {
      kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified',
      slug: principal.userId, workspaceId: principal.workspaceId, userId: principal.userId,
      activeOrganizationId: principal.activeOrganizationId, selectedWorkspaceId,
      sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
    },
    selectedWorkspace: { id: selectedWorkspaceId, organizationId: principal.activeOrganizationId },
  };
}

export function assertHostedRuntimeMounted(plane: AssembledHostedControlPlane): void {
  const mounted = plane.mounted.map(routeKey);
  if (
    mounted.length !== HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS.length ||
    mounted.some((key, index) => key !== HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS[index])
  ) {
    throw new Error(`hosted_runtime_mounted_surface_mismatch:${JSON.stringify(mounted)}`);
  }
}

/**
 * Resolve only secret references, construct the service/tenant-scoped adapters,
 * inject the signed webhook route, and assert the exact internet surface.
 */
export async function createHostedRuntime(
  configuration: HostedRuntimeConfiguration,
  dependencies: HostedRuntimeDependencies = {},
): Promise<AssembledHostedControlPlane> {
  const runService = dependencies.runService ?? withHostedServiceContext;
  await assertHostedServicePosture(runService);

  // Default = the generic env:/file: resolver. The encrypted-store resolver
  // (`integration:NAME`, auth/hosted/secret-ref.ts) is injected by the process
  // composition that owns the full operator graph — apps/operator/bin/hosted-
  // handler.ts — never defaulted here, so a bundler prebundling a hosted runtime
  // never inherits operator-state-pg (EI-22091008218242870).
  const resolveSecret = dependencies.resolveSecret ?? resolveSecretRef;
  const runTenant = dependencies.runTenant ?? withTenantContext;
  // Fail fast on a half-configured profile rather than serving a healthy-looking
  // one that fails on live traffic — see preflightHostedSecretRefs (WI-2141402).
  const { sessionCookieSecret } = await preflightHostedSecretRefs(configuration, resolveSecret);

  const sessionStore = new HostedServiceSessionStore(runService);
  const membershipAuthority = new HostedRuntimeMembershipAuthority(runService, runTenant);
  const identityDirectory = new HostedServiceIdentityDirectory(runService);
  const lifecycleStore = new PostgresWorkosLifecycleProjectionStore(runService);
  const lifecycleWorker = new WorkosLifecycleWorker(lifecycleStore, new PostgresWorkosAccessClosureSink(runService));
  const receiptSink: WorkOsWebhookReceiptSink = {
    enqueue: (event, options) =>
      runService((sql) => new WorkOsWebhookReceiptStore(sql as never).enqueue(event, options)),
  };
  const connectorGateway = new HostedWorkspaceConnectorGateway(new PostgresHostedWorkspaceConnectorStore(runService));
  const delegationAdapters = dependencies.providerDelegationAdapters ?? productionProviderDelegationAdapters();
  const delegationOrganization = dependencies.delegationOrganization
    ?? ((organizationId: string) => hostedDelegationOrganization(organizationId));
  const providerDelegationManager = (principal: HostedPrincipal) =>
    new HostedProviderDelegationManager(
      new PostgresHostedProviderDelegationStore(
        (fn) => runTenant(tenantServerContext(principal), fn),
        principal.workspaceId,
      ),
      delegationAdapters,
      // The session's organization, never the request body's (D-397).
      delegationOrganization(principal.activeOrganizationId),
    );

  const provider = createWorkOSHostedIdentityProvider({
    configuration: {
      clientId: configuration.workosClientId,
      apiKeyRef: configuration.workosApiKeyRef,
      cookiePasswordRef: configuration.workosCookiePasswordRef,
    },
    resolveSecret: (reference) => resolveSecret(reference),
    sessionVault: serviceWorkOSSessionVault(runService),
  });

  const webhookRoute = createWorkOsWebhookRoute({
    secret: () => resolveSecret(configuration.workosWebhookSecretRef),
    signatureKeyRef: () => configuration.workosWebhookSignatureKeyRef,
    intake: async (input) => {
      const receipt = await intakeWorkOsWebhook({ ...input, receiptSink });
      const event = workosLifecycleEventFromReceipt(receipt);
      if (event) await lifecycleWorker.apply(event);
      else await lifecycleStore.markIgnored(receipt.eventId);
      return receipt;
    },
  });

  // The first-workspace door (D-384) is the one browser leaf that runs OUTSIDE the tenant
  // runner: it is the bootstrap that creates the tenant's first binding. Its gate defaults
  // closed — an empty organization set admits nobody.
  // ONE enqueuer for every hosted provision this process starts: the first-workspace door AND
  // the browser provision route (a retry of a failed first build). This process never runs DBOS,
  // so without it the browser route forwards the raw body to the controller and loses the
  // server-derived actor and D-015 bring-up (measured: canary host-0f9b1ba8db30d143becc130a
  // retries r2..r6 all reached the workflow with neither).
  // The same client also enqueues lifecycle actions and destroy for the browser action route
  // (WI-10005363): forwarding those raw lost the actor and answered a false 504.
  const dbosClient = configuration.provisioningDbosAppVersion
    ? createWorkspaceHostProvisioningClient({
        systemDatabaseUrl: getHarnessAdminUrlWithSource().url,
        appVersion: configuration.provisioningDbosAppVersion,
      })
    : undefined;
  const provisioning = dependencies.hostedBrowser?.provisioning ?? dbosClient;
  const operations = dependencies.hostedBrowser?.operations ?? dbosClient;
  const firstWorkspace = dependencies.hostedBrowser?.firstWorkspace ?? createHostedFirstWorkspace(
    createHostedFirstWorkspaceDependencies({
      controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
      runService,
      delegationAdapters,
      delegationOrganization,
      enabledOrganizations: configuration.firstWorkspaceOrganizations ?? new Set(),
      ...(provisioning ? { provisioning } : {}),
      ...(dependencies.hostedBrowser?.provisioningAvailable
        ? { provisioningAvailable: dependencies.hostedBrowser.provisioningAvailable }
        : {}),
    }),
  );
  const sessionCookies = new HostedSessionCookieCodec(sessionCookieSecret);

  // The hosted SPA gets its own explicit browser boundary. Keep the browser
  // leaf on the same tenant runner as the hosted identity/session stack so
  // every customer read/write enters the RLS transaction exactly once.
  const hostedBrowser = createHostedBrowserRoutes({
    publicOrigin: configuration.publicOrigin,
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
    dependencies: {
      ...(dependencies.hostedBrowser ?? {}),
      runTenant: dependencies.hostedBrowser?.runTenant ?? runTenant,
      firstWorkspace,
      ...(provisioning ? { provisioning } : {}),
      ...(operations ? { operations } : {}),
      issueSessionCookie:
        dependencies.hostedBrowser?.issueSessionCookie ??
        ((sessionId, expiresAt) => sessionCookies.serialize(sessionId, expiresAt, new Date())),
    },
  });

  const plane = assembleHostedControlPlane({
    provider,
    publicOrigin: configuration.publicOrigin,
    sessionCookieSecret,
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
    sessionStore,
    membershipAuthority,
    identityDirectory,
    connectorGateway,
    providerDelegationManager,
    // psu CLI sign-in reads the org's workspaces with the same control-plane privilege the
    // first-workspace door uses; the organization always comes from the verified CLI token.
    cliStore: new PostgresHostedCliStore(
      runService,
      (fn) => withWorkspace(configuration.controlPlaneWorkspaceId, fn),
      configuration.controlPlaneWorkspaceId,
    ),
    routes: [...ALL_ROUTES, webhookRoute, ...hostedBrowser.routes],
    staticAllowlist: [
      ...HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST,
      HOSTED_WORKOS_WEBHOOK_ALLOWLIST_ENTRY,
      ...hostedBrowser.allowlist,
    ],
  });
  assertHostedRuntimeMounted(plane);
  return plane;
}
