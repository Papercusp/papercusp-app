/**
 * Bind a verified upstream identity to a Papercusp user, organization, and
 * permission-version snapshot.
 *
 * `BindHostedIdentity` is the port the hosted callback route calls after the
 * identity provider has proven who the browser is. It is the LAST seam in the
 * hosted auth chain that had no adapter: the route module declares the type,
 * `createHostedControlPlane` requires one to be injected, and until this module
 * landed nothing in the tree produced one — so a hosted deployment could be
 * assembled only by hand-writing the translation from "WorkOS says this is
 * subject X" to "Papercusp says this is user U in organization O".
 *
 * **The one invariant this module exists to hold.** The binding's
 * `permissionVersion` is never computed here. It is taken from the membership
 * authority, which derives it through `hostedMembershipAuthorityVersion` — the
 * same function the request-time resolver re-computes on every hosted request.
 * A binder that stamped its own version (a clock read, a counter, a literal 0)
 * would mint sessions that `hosted-principal-resolver.ts` rejects immediately
 * as `session_permission_version_stale`, and the failure would look like a
 * session bug rather than a mint bug. Routing the value through the authority
 * makes the two agree by construction.
 *
 * **What this module deliberately does not do.**
 *
 *   - It never CREATES a user, organization, or membership. Admission is the
 *     onboarding orchestrator's transaction (`hosted/onboarding.ts`), which
 *     owns invitations, beta approval, legal acceptance, and entitlement. A
 *     sign-in that finds no membership is a denial, not an implicit join —
 *     otherwise the identity provider would become the admission authority,
 *     which is precisely the boundary the hosted design forbids.
 *   - It never WRITES. Resolution is read-only for the same reason the
 *     membership authority is: an authorization path may look identity up and
 *     may not change it. Last-seen bookkeeping belongs to the identity port
 *     that owns those columns.
 *   - It never selects a workspace. The binding leaves `workspaceId` null and
 *     the customer chooses one later, because a selection made here would
 *     bypass the org-ownership check the principal resolver applies to a
 *     session's selected workspace.
 *
 * Every failure returns `null`, because that is what the port allows and what
 * the callback route turns into a 403 `membership_required`. The reason is
 * still typed and handed to an optional observer so a deployment can audit and
 * alert on WHY sign-in was refused without widening the port or leaking the
 * distinction to the browser.
 */
import { getOrgPg } from '@papercusp/db-org/connection';
import {
  hostedMembershipAuthority,
  type HostedMembershipAuthorityReader,
} from './hosted-membership-authority';
import type {
  BindHostedIdentity,
  BindHostedIdentityInput,
  HostedIdentityBinding,
} from '../endpoint-route/routes/hosted-auth';

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

export const HOSTED_IDENTITY_BINDING_DENIAL_REASONS = [
  /** The provider id, subject, or verified-email contract was not satisfied. */
  'invalid_identity',
  /** No active `external_identities` row links this provider subject to a user. */
  'identity_not_linked',
  /** The linked hosted user is deactivated or deleted. */
  'user_not_active',
  /** The upstream organization hint matches no active Papercusp organization. */
  'organization_not_found',
  /** No organization hint, and the user has no active membership to fall back on. */
  'no_active_membership',
  /**
   * No organization hint, and the user is an active member of several
   * organizations. Picking one would be a guess about which tenant the session
   * belongs to, so this denies instead.
   */
  'organization_ambiguous',
  /** The user has no active membership in the resolved organization. */
  'membership_not_active',
  /** The directory or membership authority could not be consulted. */
  'authority_unavailable',
] as const;

export type HostedIdentityBindingDenialReason =
  (typeof HOSTED_IDENTITY_BINDING_DENIAL_REASONS)[number];

/**
 * The identity-directory reads the binder needs, as a narrow port.
 *
 * Split from the membership authority on purpose: that module answers "what may
 * this user do in this organization", this one answers "which user and
 * organization is the upstream talking about". Keeping them apart means a test
 * can drive an ambiguous-organization case without also faking permissions.
 */
export interface HostedIdentityDirectory {
  /** Resolve an active provider subject to its hosted user id. */
  resolveLinkedUser(input: {
    providerId: string;
    subject: string;
  }): Promise<{ userId: string } | null>;
  /** Resolve an upstream organization reference to an ACTIVE Papercusp organization. */
  resolveOrganization(input: {
    providerId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string } | null>;
  /** Active memberships in active organizations, used only to disambiguate. */
  listActiveOrganizationIds(input: { userId: string }): Promise<readonly string[]>;
}

export interface HostedIdentityBinderDependencies {
  readonly directory: HostedIdentityDirectory;
  readonly membershipAuthority?: HostedMembershipAuthorityReader;
  /**
   * Observes a refusal. Never called on success, never given the identity's
   * email or provider subject — a denial reason plus the resolved ids is
   * enough to alert on, and anything more would put verified personal data
   * into whatever sink a deployment wires up.
   */
  readonly onDenied?: (denial: {
    reason: HostedIdentityBindingDenialReason;
    providerId: string;
    userId?: string;
    organizationId?: string;
  }) => void;
}

function identifier(value: unknown, max = 512): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? null : trimmed;
}

/**
 * Build the `bindIdentity` dependency for `createHostedAuthRoutes`.
 *
 * The returned function never throws: the callback route treats a throw as
 * `identity_binding_unavailable` (503) and a null as `membership_required`
 * (403), and an infrastructure fault must not be reported to the browser as a
 * membership problem. Faults are therefore caught, reported as
 * `authority_unavailable` to the observer, and returned as null.
 */
export function createHostedIdentityBinder(
  deps: HostedIdentityBinderDependencies,
): BindHostedIdentity {
  const membershipAuthority = deps.membershipAuthority ?? hostedMembershipAuthority();

  return async function bindHostedIdentity(
    input: BindHostedIdentityInput,
  ): Promise<HostedIdentityBinding | null> {
    const providerId = identifier(input?.providerId, 64);
    const subject = identifier(input?.identity?.externalUserId);
    const email = identifier(input?.identity?.primaryEmail, 320);

    const deny = (
      reason: HostedIdentityBindingDenialReason,
      context: { userId?: string; organizationId?: string } = {},
    ): null => {
      deps.onDenied?.({ reason, providerId: providerId ?? '', ...context });
      return null;
    };

    // A literal `true` is required, not a truthy value: the provider contract
    // types `emailVerified` as `true` precisely so an unverified identity
    // cannot satisfy it, and this is the runtime half of that guarantee.
    if (!providerId || !subject || !email || input.identity.emailVerified !== true) {
      return deny('invalid_identity');
    }

    let linked: { userId: string } | null;
    try {
      linked = await deps.directory.resolveLinkedUser({ providerId, subject });
    } catch {
      return deny('authority_unavailable');
    }
    if (!linked) return deny('identity_not_linked');

    const userId = identifier(linked.userId);
    if (!userId) return deny('user_not_active');

    let organizationId: string;
    const externalOrganizationId = identifier(input.externalOrganizationId);
    if (externalOrganizationId) {
      let organization: { organizationId: string } | null;
      try {
        organization = await deps.directory.resolveOrganization({
          providerId,
          externalOrganizationId,
        });
      } catch {
        return deny('authority_unavailable', { userId });
      }
      if (!organization) return deny('organization_not_found', { userId });
      const resolved = identifier(organization.organizationId);
      if (!resolved) return deny('organization_not_found', { userId });
      organizationId = resolved;
    } else {
      // No upstream hint. A single active membership is unambiguous and is the
      // common single-tenant case; anything else must not be guessed at.
      let candidates: readonly string[];
      try {
        candidates = await deps.directory.listActiveOrganizationIds({ userId });
      } catch {
        return deny('authority_unavailable', { userId });
      }
      const unique = [...new Set(candidates.map((id) => identifier(id)).filter(
        (id): id is string => id !== null,
      ))];
      if (unique.length === 0) return deny('no_active_membership', { userId });
      if (unique.length > 1) return deny('organization_ambiguous', { userId });
      organizationId = unique[0];
    }

    // The authority is the ONLY source of the permission version. It is also
    // the check that the membership is currently active — the directory lookup
    // above establishes identity, never authorization.
    let membership;
    try {
      membership = await membershipAuthority.resolveActive({ userId, organizationId });
    } catch {
      return deny('authority_unavailable', { userId, organizationId });
    }
    if (!membership) return deny('membership_not_active', { userId, organizationId });

    // Defence against an adapter that answered about a different subject: the
    // session minted below is the tenant boundary, so a disagreement here must
    // never be resolved in favour of the caller's request.
    if (membership.userId !== userId || membership.organizationId !== organizationId) {
      return deny('membership_not_active', { userId, organizationId });
    }

    return {
      userId: membership.userId,
      organizationId: membership.organizationId,
      // Never selected at bind time — see the module header.
      workspaceId: null,
      permissionVersion: membership.permissionVersion,
    };
  };
}

interface LinkedUserRow {
  hosted_user_id: string;
}

interface OrganizationRow {
  id: string;
}

interface MembershipOrganizationRow {
  organization_id: string;
}

/**
 * The Postgres identity directory.
 *
 * Every query filters lifecycle state in SQL rather than in code, so a
 * deactivated identity, a deleted user, or a suspended organization is not
 * fetched at all and cannot be mishandled by a later branch.
 */
export class PostgresHostedIdentityDirectory implements HostedIdentityDirectory {
  constructor(private readonly sql: SqlClient = getOrgPg().sql) {}

  async resolveLinkedUser(input: {
    providerId: string;
    subject: string;
  }): Promise<{ userId: string } | null> {
    // Joined to hosted_users rather than trusting the link row alone: the FK
    // guarantees the user EXISTS, not that it is still active, and a
    // deactivated user must not be able to sign in through a link that was
    // never torn down.
    const rows = await this.sql<LinkedUserRow[]>`
      SELECT ei.hosted_user_id::text AS hosted_user_id
        FROM papercusp_auth.external_identities AS ei
        JOIN papercusp_auth.hosted_users AS hu
          ON hu.id = ei.hosted_user_id
       WHERE ei.provider = ${input.providerId}
         AND ei.subject = ${input.subject}
         AND ei.status = 'active'
         AND ei.deleted_at IS NULL
         AND ei.deactivated_at IS NULL
         AND hu.status = 'active'
         AND hu.deleted_at IS NULL
         AND hu.deactivated_at IS NULL
       LIMIT 1
    `;
    return rows.length === 0 ? null : { userId: rows[0].hosted_user_id };
  }

  async resolveOrganization(input: {
    providerId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string } | null> {
    // `status = 'active'` excludes suspended and offboarding tenants: sign-in
    // into a suspended organization would mint a session whose permissions are
    // then re-derived every request, which reads as a working login right up
    // until every action is refused.
    const rows = await this.sql<OrganizationRow[]>`
      SELECT id::text AS id
        FROM papercusp_auth.organizations
       WHERE identity_provider = ${input.providerId}
         AND external_organization_id = ${input.externalOrganizationId}
         AND status = 'active'
         AND deleted_at IS NULL
       LIMIT 1
    `;
    return rows.length === 0 ? null : { organizationId: rows[0].id };
  }

  async listActiveOrganizationIds(input: { userId: string }): Promise<readonly string[]> {
    // Bounded deliberately: this result is only ever used to decide "exactly
    // one or not", so two rows already settle it and an unbounded scan would
    // let a pathological membership set slow the sign-in path.
    const rows = await this.sql<MembershipOrganizationRow[]>`
      SELECT m.organization_id::text AS organization_id
        FROM papercusp_auth.organization_memberships AS m
        JOIN papercusp_auth.organizations AS o
          ON o.id = m.organization_id
       WHERE m.user_id = ${input.userId}::uuid
         AND m.status = 'active'
         AND m.revoked_at IS NULL
         AND o.status = 'active'
         AND o.deleted_at IS NULL
       LIMIT 2
    `;
    return rows.map((row) => row.organization_id);
  }
}

/**
 * The production binder: the Postgres directory plus the process-wide
 * membership authority. Constructed lazily so importing costs no connection.
 */
export function hostedIdentityBinder(
  overrides: Partial<HostedIdentityBinderDependencies> = {},
): BindHostedIdentity {
  return createHostedIdentityBinder({
    directory: overrides.directory ?? new PostgresHostedIdentityDirectory(),
    ...(overrides.membershipAuthority ? { membershipAuthority: overrides.membershipAuthority } : {}),
    ...(overrides.onDenied ? { onDenied: overrides.onDenied } : {}),
  });
}
