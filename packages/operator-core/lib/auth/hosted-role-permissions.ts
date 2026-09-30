/**
 * The hosted authorization matrix: organization membership → hosted permissions.
 *
 * `hosted-session.ts` promises that a hosted session stores "only tenant
 * identity plus a permission-version snapshot; current permissions are derived
 * from the membership/grant model on every authorization path". This module is
 * that derivation, and it is deliberately the ONLY place a role becomes
 * authority.
 *
 * Two properties make it safe to derive live rather than trust the session:
 *
 *   - **Deny by default.** An unknown role, a non-`active` membership status,
 *     or a missing row yields the EMPTY set. There is no fallback tier, no
 *     ambient permission, and no `*` — `createHostedPrincipal` rejects the
 *     wildcard outright, so it cannot enter a hosted principal by any path.
 *   - **Live re-derivation.** Because every request recomputes permissions from
 *     the current membership row, a demotion or suspension takes effect on the
 *     next request even if the cookie and its session row are still valid. The
 *     permission-version check in the resolver is defence in depth on top of
 *     that, not the mechanism.
 *
 * `support:access` is intentionally unreachable from every role. It belongs to
 * time-bounded `support_access_grants` issued to Papercusp staff (migration
 * 906, `hosted/governance.ts`), not to organization membership — a customer
 * role must never be able to mint staff support authority.
 */
import { isHostedPermission, type HostedPermission } from './hosted-principal';

/**
 * The organization role vocabulary.
 *
 * DERIVED, NOT DECLARED: this list mirrors the
 * `organization_memberships_role_ck` CHECK constraint in migration
 * `903-customer-organization-boundary.sql`, which is the source of truth.
 * `hosted-role-permissions.test.ts` reads that migration and fails if the two
 * ever disagree, so a role added in SQL cannot silently land here with no
 * permission mapping (it would otherwise deny-by-default and look like a
 * mysterious authorization bug rather than an unfinished migration).
 */
export const HOSTED_ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'billing'] as const;

export type HostedOrganizationRole = (typeof HOSTED_ORGANIZATION_ROLES)[number];

/**
 * Membership lifecycle statuses, mirroring
 * `organization_memberships_status_ck` in the same migration. Only `active`
 * carries authority; `suspended` and `revoked` both resolve to no permissions.
 */
export const HOSTED_MEMBERSHIP_STATUSES = ['active', 'suspended', 'revoked'] as const;

export type HostedMembershipStatus = (typeof HOSTED_MEMBERSHIP_STATUSES)[number];

const ROLE_SET: ReadonlySet<string> = new Set(HOSTED_ORGANIZATION_ROLES);
const STATUS_SET: ReadonlySet<string> = new Set(HOSTED_MEMBERSHIP_STATUSES);

/**
 * The matrix itself.
 *
 * `workspace:view` is the baseline every ACTIVE member holds, including
 * `billing`: it is what "you are a member of this organization" means, and the
 * hosted session/logout routes require it, so a billing-only member who could
 * not hold it could not read or end their own session. It grants visibility
 * within the member's own organization only — the tenant binding is enforced
 * separately by `authorizeHostedOperation`, which compares the resource's
 * organization against the principal's, so `workspace:view` never reaches
 * another tenant.
 *
 * Mutating authority is graded above that baseline:
 *   - `member`  operates workspaces but cannot destroy them or change people.
 *   - `admin`   adds destroy, cloud-connection management, and member management.
 *   - `owner`   adds billing on top of admin.
 *   - `billing` is a NARROW role, not a senior one: billing plus the baseline.
 */
const ROLE_PERMISSIONS: Readonly<Record<HostedOrganizationRole, readonly HostedPermission[]>> =
  Object.freeze({
    owner: [
      'workspace:view',
      'workspace:operate',
      'workspace:destroy',
      'cloud-connection:manage',
      'members:manage',
      'billing:manage',
    ],
    admin: [
      'workspace:view',
      'workspace:operate',
      'workspace:destroy',
      'cloud-connection:manage',
      'members:manage',
    ],
    member: ['workspace:view', 'workspace:operate'],
    billing: ['workspace:view', 'billing:manage'],
  });

const EMPTY_PERMISSIONS: ReadonlySet<HostedPermission> = Object.freeze(
  new Set<HostedPermission>(),
) as ReadonlySet<HostedPermission>;

export function isHostedOrganizationRole(value: unknown): value is HostedOrganizationRole {
  return typeof value === 'string' && ROLE_SET.has(value);
}

export function isHostedMembershipStatus(value: unknown): value is HostedMembershipStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

/** The membership facts authority is derived from — nothing else is consulted. */
export interface HostedMembershipFacts {
  readonly role: string;
  readonly status: string;
}

/**
 * Resolve the permissions an organization membership currently carries.
 *
 * Returns the EMPTY set — never null, never a partial grant — for every
 * non-authoritative input: an unknown role, an unknown or non-`active` status,
 * or a value of the wrong type. Callers therefore cannot forget to handle a
 * denial branch; an empty set fails every permission check downstream.
 */
export function hostedPermissionsForMembership(
  membership: HostedMembershipFacts,
): ReadonlySet<HostedPermission> {
  if (!isHostedMembershipStatus(membership.status) || membership.status !== 'active') {
    return EMPTY_PERMISSIONS;
  }
  if (!isHostedOrganizationRole(membership.role)) return EMPTY_PERMISSIONS;
  return hostedPermissionsForRole(membership.role);
}

/**
 * The permissions a role carries, ignoring status. Prefer
 * `hostedPermissionsForMembership` on any authorization path: it is the one
 * that refuses a suspended or revoked membership. This exists for the
 * member-management UI, which must describe a role before assigning it.
 */
export function hostedPermissionsForRole(
  role: HostedOrganizationRole,
): ReadonlySet<HostedPermission> {
  const permissions = ROLE_PERMISSIONS[role];
  const resolved = new Set<HostedPermission>();
  for (const permission of permissions) {
    // Belt and braces: the vocabulary in `hosted-principal.ts` is the contract,
    // and a permission removed there must not survive here as a live grant.
    if (isHostedPermission(permission)) resolved.add(permission);
  }
  return resolved;
}

/** The matrix as plain data, for tests, audit surfaces, and documentation. */
export function hostedRolePermissionMatrix(): Readonly<
  Record<HostedOrganizationRole, readonly HostedPermission[]>
> {
  return ROLE_PERMISSIONS;
}
