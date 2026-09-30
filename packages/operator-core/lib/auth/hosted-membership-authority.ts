/**
 * The Papercusp-authoritative membership lookup behind hosted authorization.
 *
 * Every hosted leaf (P-069…P-088) declared a PORT for this and deliberately
 * left the adapter to the integration item: `HostedOnboardingMembershipPort.
 * resolveActive` in `hosted/onboarding.ts` states the contract, and until this
 * module landed no production code read `papercusp_auth.organization_memberships`
 * at all. This is that adapter, and it is the single place a stored membership
 * row becomes authority.
 *
 * **The permission version.** `hosted_sessions.permission_version` is a
 * SNAPSHOT taken when a session is minted; its column comment calls it the
 * "authorization snapshot version checked against current membership/grant
 * state before a hosted request is admitted". The authority side has no version
 * column, so the version is DERIVED here from the membership row's `updated_at`
 * — whole seconds since the epoch — by `hostedMembershipAuthorityVersion`.
 * Deriving it in one function is what makes the check meaningful: the same
 * function stamps the session at mint time and re-computes it at check time, so
 * the two cannot disagree by construction, and any lifecycle write that changes
 * a role or status necessarily moves `updated_at` and therefore invalidates
 * sessions minted under the old authority.
 *
 * This is defence in depth, not the primary revocation path. Two other
 * mechanisms fire first: the WorkOS lifecycle worker emits `revoke-session` on
 * `membership.revoked` / `role.changed`, and permissions are re-derived live
 * from the current row on every single request (`hosted-role-permissions.ts`),
 * so a demotion takes effect immediately whether or not the version moved.
 */
import { getOrgPg } from '@papercusp/db-org/connection';
import {
  hostedPermissionsForMembership,
  isHostedMembershipStatus,
  isHostedOrganizationRole,
  type HostedMembershipStatus,
  type HostedOrganizationRole,
} from './hosted-role-permissions';
import type { HostedPermission } from './hosted-principal';

type SqlClient = ReturnType<typeof getOrgPg>['sql'];

interface MembershipRow {
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  updated_at: Date | string;
}

interface WorkspaceRow {
  organization_id: string;
}

/** One resolved, currently-authoritative organization membership. */
export interface HostedMembershipAuthority {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: HostedOrganizationRole;
  readonly status: HostedMembershipStatus;
  readonly permissionVersion: number;
  readonly permissions: ReadonlySet<HostedPermission>;
}

/**
 * Derive the authority version for a membership row.
 *
 * Whole seconds, never negative, never fractional: `hosted_sessions.
 * permission_version` is a `BIGINT` with a `>= 0` CHECK, so a fractional or
 * negative value would be rejected by the database at mint time rather than
 * fail closed at check time.
 */
export function hostedMembershipAuthorityVersion(updatedAt: Date | string): number {
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new TypeError('hosted_membership_authority_version_requires_a_valid_timestamp');
  }
  return Math.max(0, Math.floor(ms / 1000));
}

/**
 * The read side of the membership port, as the resolver consumes it. Narrow on
 * purpose: an authorization path may look a membership up, and may not write.
 */
export interface HostedMembershipAuthorityReader {
  resolveActive(input: { userId: string; organizationId: string }): Promise<HostedMembershipAuthority | null>;
  /**
   * Whether a customer workspace belongs to the organization. The hosted
   * session carries a selected workspace id; without this check a session whose
   * selection was made before a workspace moved (or was forged upstream) would
   * carry a tenant-crossing selection into the principal.
   *
   * `controlPlaneWorkspaceId` is required, not optional: `customer_workspaces`
   * is keyed `(workspace_id, id)`, so an `(organization_id, id)` filter alone
   * is not unique and could match a row belonging to a different control-plane
   * workspace.
   */
  workspaceBelongsToOrganization(input: {
    userId: string;
    sessionId: string;
    sessionVersion: number;
    organizationId: string;
    customerWorkspaceId: string;
    controlPlaneWorkspaceId: string;
  }): Promise<boolean>;
}

export class PostgresHostedMembershipAuthority implements HostedMembershipAuthorityReader {
  constructor(private readonly sql: SqlClient = getOrgPg().sql) {}

  async resolveActive(input: { userId: string; organizationId: string }): Promise<HostedMembershipAuthority | null> {
    const userId = identifier(input.userId);
    const organizationId = identifier(input.organizationId);
    if (userId === null || organizationId === null) return null;

    // Filtered on status in SQL as well as in code: the row is not fetched at
    // all unless it is currently active, so a suspended membership cannot be
    // mishandled by a later branch.
    const rows = await this.sql<MembershipRow[]>`
      SELECT organization_id::text AS organization_id,
             user_id::text         AS user_id,
             role,
             status,
             updated_at
        FROM papercusp_auth.organization_memberships
       WHERE user_id = ${userId}::uuid
         AND organization_id = ${organizationId}::uuid
         AND status = 'active'
         AND revoked_at IS NULL
       LIMIT 1
    `;
    if (rows.length === 0) return null;
    return toAuthority(rows[0]);
  }

  async workspaceBelongsToOrganization(input: {
    userId: string;
    sessionId: string;
    sessionVersion: number;
    organizationId: string;
    customerWorkspaceId: string;
    controlPlaneWorkspaceId: string;
  }): Promise<boolean> {
    const userId = identifier(input.userId);
    const sessionId = identifier(input.sessionId);
    const organizationId = identifier(input.organizationId);
    const customerWorkspaceId = identifier(input.customerWorkspaceId);
    const controlPlaneWorkspaceId = identifier(input.controlPlaneWorkspaceId);
    if (
      organizationId === null ||
      userId === null ||
      sessionId === null ||
      !Number.isSafeInteger(input.sessionVersion) ||
      input.sessionVersion < 0 ||
      customerWorkspaceId === null ||
      controlPlaneWorkspaceId === null
    ) {
      return false;
    }

    const rows = await this.sql<WorkspaceRow[]>`
      SELECT organization_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${controlPlaneWorkspaceId}
         AND id = ${customerWorkspaceId}
         AND organization_id = ${organizationId}
         AND deleted_at IS NULL
       LIMIT 1
    `;
    return rows.length === 1;
  }
}

/**
 * Build a `HostedMembershipAuthority` from a raw row, failing closed.
 *
 * Exported so the session-minting path derives the permission version through
 * exactly the same function the checking path uses.
 */
export function toAuthority(row: {
  organization_id: string;
  user_id: string;
  role: string;
  status: string;
  updated_at: Date | string;
}): HostedMembershipAuthority | null {
  if (!isHostedOrganizationRole(row.role)) return null;
  if (!isHostedMembershipStatus(row.status)) return null;
  const organizationId = identifier(row.organization_id);
  const userId = identifier(row.user_id);
  if (organizationId === null || userId === null) return null;

  const permissions = hostedPermissionsForMembership({ role: row.role, status: row.status });
  if (permissions.size === 0) return null;

  let permissionVersion: number;
  try {
    permissionVersion = hostedMembershipAuthorityVersion(row.updated_at);
  } catch {
    return null;
  }

  return {
    organizationId,
    userId,
    role: row.role,
    status: row.status,
    permissionVersion,
    permissions,
  };
}

function identifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

let cached: PostgresHostedMembershipAuthority | null = null;

/** The process-wide reader, constructed lazily so importing costs no connection. */
export function hostedMembershipAuthority(): HostedMembershipAuthorityReader {
  cached ??= new PostgresHostedMembershipAuthority();
  return cached;
}
