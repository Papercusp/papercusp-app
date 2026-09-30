/**
 * Resolve a hosted browser request into a `HostedPrincipal`.
 *
 * This is the hosted counterpart to `require-principal.ts`, and it is
 * deliberately NOT a widening of it. The local resolver chain tries a cookie
 * session, a device JWT, a superuser bearer, an agent bearer and finally
 * loopback — every one of which can carry local or wildcard authority. None of
 * them is consulted here. A hosted request is authenticated by exactly one
 * thing: the HMAC-signed opaque hosted session cookie, resolved against the
 * revocable `papercusp_auth.hosted_sessions` row, with permissions re-derived
 * from the CURRENT organization membership on every request.
 *
 * Every failure is a typed reason, and every reason denies. There is no branch
 * that returns a principal with an empty permission set, no fallback tier, and
 * no path by which a local principal becomes a hosted one — `isHostedPrincipal`
 * would reject it anyway, but the resolver never constructs one.
 */
import { createHostedPrincipal, type HostedPrincipal } from './hosted-principal';
import type { HostedMembershipAuthority, HostedMembershipAuthorityReader } from './hosted-membership-authority';
import type { HostedSession, HostedSessionCookieCodec } from './hosted-session';
import type { HostedSessionAuthorizationState } from './hosted-authorization';

export const HOSTED_PRINCIPAL_DENIAL_REASONS = [
  /** No hosted session cookie, or the cookie failed its HMAC/format check. */
  'session_cookie_missing',
  /** Unknown, expired, or revoked session id. */
  'session_not_found',
  /** No currently-active membership binding this user to the session's org. */
  'membership_not_active',
  /** The authority row disagrees with the session about the tenant. */
  'session_organization_mismatch',
  /** The session's permission snapshot predates the current authority. */
  'session_permission_version_stale',
  /** The session's selected workspace does not belong to the active org. */
  'workspace_not_in_organization',
  /** The session store or membership authority could not be consulted. */
  'authority_unavailable',
] as const;

export type HostedPrincipalDenialReason = (typeof HOSTED_PRINCIPAL_DENIAL_REASONS)[number];

export type HostedPrincipalResolution =
  | {
      readonly ok: true;
      readonly principal: HostedPrincipal;
      readonly session: HostedSession;
      readonly membership: HostedMembershipAuthority;
    }
  | {
      readonly ok: false;
      readonly reason: HostedPrincipalDenialReason;
      /** Present when the denial happened after the session was loaded. */
      readonly session?: HostedSession;
    };

/** The session-store surface the resolver uses — read-only by construction. */
export interface HostedPrincipalSessionStore {
  resolve(id: string): Promise<HostedSession | null>;
}

export interface HostedPrincipalResolverDependencies {
  readonly sessionCookieCodec: Pick<HostedSessionCookieCodec, 'read'>;
  readonly sessionStore: HostedPrincipalSessionStore;
  readonly membershipAuthority: HostedMembershipAuthorityReader;
  /**
   * The operator/control-plane workspace the hosted deployment runs as. This
   * satisfies the shared `Principal.workspaceId` contract and is NEVER the
   * customer's selected workspace — keeping the two apart is what stops ambient
   * control-plane scope from becoming customer resource authority.
   */
  readonly controlPlaneWorkspaceId: string;
}

export type HostedPrincipalResolver = (headers: Headers) => Promise<HostedPrincipalResolution>;

/**
 * The authoritative session state for `authorizeHostedOperation`.
 *
 * Derived from the same row the principal was built from, so the version the
 * gate compares is the version the principal actually carries.
 */
export function hostedSessionAuthorizationState(session: HostedSession): HostedSessionAuthorizationState {
  return {
    sessionId: session.id,
    sessionVersion: session.permissionVersion,
    revoked: session.revokedAt !== null,
  };
}

export function createHostedPrincipalResolver(deps: HostedPrincipalResolverDependencies): HostedPrincipalResolver {
  const controlPlaneWorkspaceId = deps.controlPlaneWorkspaceId.trim();
  if (controlPlaneWorkspaceId.length === 0) {
    throw new TypeError('hosted_principal_resolver_requires_a_control_plane_workspace_id');
  }

  return async function resolveHostedPrincipal(headers) {
    const sessionId = deps.sessionCookieCodec.read(headers);
    if (!sessionId) return { ok: false, reason: 'session_cookie_missing' };

    let session: HostedSession | null;
    try {
      session = await deps.sessionStore.resolve(sessionId);
    } catch {
      // A database fault must never read as "anonymous but allowed" on a
      // public-adjacent surface, nor leak its message to the caller.
      return { ok: false, reason: 'authority_unavailable' };
    }
    if (!session) return { ok: false, reason: 'session_not_found' };
    // `resolve` already filters revoked/expired rows; re-checked here so a
    // future store change cannot silently admit one.
    if (session.revokedAt !== null) return { ok: false, reason: 'session_not_found', session };

    let membership: HostedMembershipAuthority | null;
    try {
      membership = await deps.membershipAuthority.resolveActive({
        userId: session.userId,
        organizationId: session.organizationId,
      });
    } catch {
      return { ok: false, reason: 'authority_unavailable', session };
    }
    if (!membership) return { ok: false, reason: 'membership_not_active', session };

    // The lookup is already keyed by the session's organization, so this can
    // only fire on an adapter bug — which is exactly when a tenant boundary
    // must not be taken on trust.
    if (membership.organizationId !== session.organizationId || membership.userId !== session.userId) {
      return { ok: false, reason: 'session_organization_mismatch', session };
    }

    if (session.permissionVersion !== membership.permissionVersion) {
      return { ok: false, reason: 'session_permission_version_stale', session };
    }

    // A membership with no permissions never reaches here (`resolveActive`
    // returns null for one), so an authenticated hosted principal always
    // carries at least the `workspace:view` baseline.
    if (membership.permissions.size === 0) {
      return { ok: false, reason: 'membership_not_active', session };
    }

    const selectedWorkspaceId = session.workspaceId ?? undefined;
    if (selectedWorkspaceId !== undefined) {
      let owned: boolean;
      try {
        owned = await deps.membershipAuthority.workspaceBelongsToOrganization({
          userId: membership.userId,
          sessionId: session.id,
          sessionVersion: session.permissionVersion,
          organizationId: membership.organizationId,
          customerWorkspaceId: selectedWorkspaceId,
          controlPlaneWorkspaceId,
        });
      } catch {
        return { ok: false, reason: 'authority_unavailable', session };
      }
      if (!owned) return { ok: false, reason: 'workspace_not_in_organization', session };
    }

    let principal: HostedPrincipal;
    try {
      principal = createHostedPrincipal({
        workspaceId: controlPlaneWorkspaceId,
        userId: membership.userId,
        activeOrganizationId: membership.organizationId,
        ...(selectedWorkspaceId === undefined ? {} : { selectedWorkspaceId }),
        sessionId: session.id,
        sessionVersion: session.permissionVersion,
        permissions: membership.permissions,
      });
    } catch {
      // `createHostedPrincipal` throws on an unknown permission or a malformed
      // identifier. Fail closed rather than surface a construction error.
      return { ok: false, reason: 'authority_unavailable', session };
    }

    return { ok: true, principal, session, membership };
  };
}
