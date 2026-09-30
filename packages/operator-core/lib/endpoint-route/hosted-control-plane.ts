/**
 * The hosted control plane's composition root.
 *
 * `createHostedControlPlane` (hosted-profile.ts) mounts the hosted surface, but
 * it takes its two hardest dependencies — a `bindIdentity` adapter and a
 * principal resolver — already constructed. Every hosted leaf shipped a port
 * and left that assembly to the integration item, so before this module the
 * only way to stand up a hosted deployment was to hand-wire a session store, a
 * cookie codec, a membership authority, a binder, and a resolver, and to get
 * every one of the couplings below right by inspection.
 *
 * Two of those couplings are not merely tedious, they are silent when wrong:
 *
 *   1. **One membership authority.** The binder stamps a session's
 *      `permissionVersion` from the authority at mint time; the resolver
 *      re-derives it from the authority on every request and rejects any
 *      disagreement as `session_permission_version_stale`. Wire two different
 *      authority instances — or, worse, two different databases — and every
 *      session mints successfully and then fails on its very first request.
 *      This module passes ONE authority to both sides, so they cannot diverge.
 *   2. **One session store and one cookie codec.** The auth routes create and
 *      revoke sessions; the resolver reads them. A second store (a second pool,
 *      a different clock) makes a freshly-minted session unresolvable, and a
 *      second codec makes the cookie it just set unreadable.
 *
 * Everything here is injectable so a test can drive the seam, but the defaults
 * are the production objects: calling this with a provider, an origin, a cookie
 * secret and a workspace id yields a complete, mounted hosted control plane.
 */
import type { Hono } from 'hono';
import type { ZodTypeAny } from 'zod';
import {
  createHostedIdentityBinder,
  PostgresHostedIdentityDirectory,
  type HostedIdentityBindingDenialReason,
  type HostedIdentityDirectory,
} from '../auth/hosted-identity-binding';
import { hostedMembershipAuthority, type HostedMembershipAuthorityReader } from '../auth/hosted-membership-authority';
import { createHostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import { HostedSessionCookieCodec, HostedSessionStore } from '../auth/hosted-session';
import type { HostedIdentityProvider } from '../auth/hosted/provider';
import type { RouteDefinition } from './define-route';
import { createHostedControlPlane, type HostedControlPlane, type HostedRouteAllowlistEntry } from './hosted-profile';
import type { HostedAuthFlowStore } from './routes/hosted-auth/flow';
import { HostedWorkspaceConnectorGateway } from './hosted-workspace-connector';
import {
  createHostedProviderDelegationRoutes,
  HOSTED_PROVIDER_DELEGATION_ROUTES,
  type HostedProviderDelegationManagerFactory,
} from './routes/hosted-provider-delegation';
import { createHostedWorkspaceConnectorRoutes, HOSTED_WORKSPACE_CONNECTOR_ROUTES } from './routes/hosted-workspace-connector';
import { createHostedCliRoutes, HOSTED_CLI_ROUTES, type HostedCliStore } from './routes/hosted-cli';

type AnyRoute = RouteDefinition<ZodTypeAny | undefined>;

/** The session surface the hosted plane needs — create, resolve, revoke. */
export type HostedControlPlaneSessionStore = Pick<HostedSessionStore, 'create' | 'resolve' | 'revoke'>;

export interface HostedControlPlaneConfig {
  /**
   * The upstream identity provider. Provider-neutral on purpose: this module
   * composes whatever proves identity, and never lets it become the
   * authorization source.
   */
  readonly provider: HostedIdentityProvider;
  /** Exact externally reachable HTTPS origin, e.g. https://app.papercusp.com. */
  readonly publicOrigin: string;
  /** HMAC secret for the `__Host-` session cookie; at least 32 bytes. */
  readonly sessionCookieSecret: string | Uint8Array;
  /**
   * The operator/control-plane workspace the deployment runs as. Never a
   * customer workspace — keeping the two apart is what stops ambient
   * control-plane scope from becoming customer resource authority.
   */
  readonly controlPlaneWorkspaceId: string;

  /** Overrides, all defaulting to the production objects. */
  readonly sessionStore?: HostedControlPlaneSessionStore;
  readonly membershipAuthority?: HostedMembershipAuthorityReader;
  readonly identityDirectory?: HostedIdentityDirectory;
  readonly routes?: ReadonlyArray<AnyRoute>;
  readonly staticAllowlist?: ReadonlyArray<HostedRouteAllowlistEntry>;
  /** Server-owned OAuth state; injectable so boot/route tests remain hermetic. */
  readonly flowStore?: HostedAuthFlowStore;
  readonly clock?: () => Date;
  /** Cryptographic entropy source. Production uses node:crypto; tests may fix it. */
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly connectorGateway?: HostedWorkspaceConnectorGateway;
  readonly providerDelegationManager?: HostedProviderDelegationManagerFactory;
  /**
   * psu CLI sign-in + terminal tickets (WI-10002874). Mounted only beside a connector gateway,
   * which is what the terminal route issues tickets through.
   */
  readonly cliStore?: HostedCliStore;
  /** Audit hook for refused sign-ins. Never called on success. */
  readonly onSignInDenied?: (denial: {
    reason: HostedIdentityBindingDenialReason;
    providerId: string;
    userId?: string;
    organizationId?: string;
  }) => void;
}

export interface AssembledHostedControlPlane extends HostedControlPlane {
  readonly app: Hono;
  /** Exactly what was mounted, in mount order — the auditable surface. */
  readonly mounted: ReadonlyArray<AnyRoute>;
  /**
   * The objects the plane was built from. Exposed so a deployment can assert
   * the couplings above hold (and so an operational path can revoke a session
   * without constructing a second store).
   */
  readonly components: {
    readonly sessionStore: HostedControlPlaneSessionStore;
    readonly sessionCookieCodec: HostedSessionCookieCodec;
    readonly membershipAuthority: HostedMembershipAuthorityReader;
    readonly identityDirectory: HostedIdentityDirectory;
    readonly connectorGateway?: HostedWorkspaceConnectorGateway;
    readonly providerDelegationManager?: HostedProviderDelegationManagerFactory;
  };
}

/**
 * Build the complete hosted control plane from configuration.
 *
 * Throws rather than returning a half-built plane: a bad cookie secret, a
 * non-HTTPS origin, or a blank control-plane workspace id are configuration
 * faults that must stop a deployment at boot, not admit requests.
 */
export function assembleHostedControlPlane(config: HostedControlPlaneConfig): AssembledHostedControlPlane {
  const controlPlaneWorkspaceId = config.controlPlaneWorkspaceId?.trim() ?? '';
  if (controlPlaneWorkspaceId.length === 0) {
    throw new TypeError('hosted_control_plane_requires_a_control_plane_workspace_id');
  }

  // Constructed once and shared. See the module header: these four are the
  // couplings that fail silently when duplicated.
  const sessionCookieCodec = new HostedSessionCookieCodec(config.sessionCookieSecret);
  const sessionStore = config.sessionStore ?? new HostedSessionStore();
  const membershipAuthority = config.membershipAuthority ?? hostedMembershipAuthority();
  const identityDirectory = config.identityDirectory ?? new PostgresHostedIdentityDirectory();

  const bindIdentity = createHostedIdentityBinder({
    directory: identityDirectory,
    membershipAuthority,
    ...(config.onSignInDenied ? { onDenied: config.onSignInDenied } : {}),
  });

  const resolvePrincipal = createHostedPrincipalResolver({
    sessionCookieCodec,
    sessionStore,
    membershipAuthority,
    controlPlaneWorkspaceId,
  });

  const cliRoutes = config.cliStore && config.connectorGateway
    ? createHostedCliRoutes({
        publicOrigin: config.publicOrigin,
        controlPlaneWorkspaceId,
        store: config.cliStore,
        membershipAuthority,
        connectorGateway: config.connectorGateway,
        resolvePrincipal,
        ...(config.clock ? { clock: config.clock } : {}),
        ...(config.randomBytes ? { randomBytes: config.randomBytes } : {}),
      })
    : [];

  const plane = createHostedControlPlane({
    hostedAuth: {
      provider: config.provider,
      bindIdentity,
      sessionStore,
      sessionCookieCodec,
      publicOrigin: config.publicOrigin,
      ...(config.flowStore ? { flowStore: config.flowStore } : {}),
      ...(config.clock ? { clock: config.clock } : {}),
      ...(config.randomBytes ? { randomBytes: config.randomBytes } : {}),
    },
    resolvePrincipal,
    ...(config.routes || config.connectorGateway || config.providerDelegationManager
      ? { routes: [
          ...(config.routes ?? []),
          ...(config.connectorGateway ? createHostedWorkspaceConnectorRoutes(config.connectorGateway) : []),
          ...(config.providerDelegationManager ? createHostedProviderDelegationRoutes(config.providerDelegationManager) : []),
          ...cliRoutes,
        ] }
      : {}),
    ...(config.staticAllowlist || config.connectorGateway || config.providerDelegationManager
      ? { staticAllowlist: [
          ...(config.staticAllowlist ?? []),
          ...(config.connectorGateway ? HOSTED_WORKSPACE_CONNECTOR_ROUTES : []),
          ...(config.providerDelegationManager ? HOSTED_PROVIDER_DELEGATION_ROUTES : []),
          ...(cliRoutes.length > 0 ? HOSTED_CLI_ROUTES : []),
        ] }
      : {}),
  });

  return {
    ...plane,
    components: {
      sessionStore,
      sessionCookieCodec,
      membershipAuthority,
      identityDirectory,
      ...(config.connectorGateway ? { connectorGateway: config.connectorGateway } : {}),
      ...(config.providerDelegationManager ? { providerDelegationManager: config.providerDelegationManager } : {}),
    },
  };
}
