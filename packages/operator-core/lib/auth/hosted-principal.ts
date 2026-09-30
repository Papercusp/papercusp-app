import type { Principal } from '@papercusp/tooldef';

/**
 * The complete permission vocabulary carried by a hosted browser session.
 *
 * Hosted permissions are deliberately narrower than the free-form capability
 * strings used by local/operator principals. Adding a value here is an
 * authorization-contract change: callers cannot smuggle an unknown string or
 * the local `*` wildcard into a hosted principal.
 */
export const HOSTED_PERMISSION_VOCABULARY = [
  'workspace:view',
  'workspace:operate',
  'workspace:destroy',
  'cloud-connection:manage',
  'members:manage',
  'billing:manage',
  'support:access',
] as const;

export type HostedPermission = (typeof HOSTED_PERMISSION_VOCABULARY)[number];

const HOSTED_PERMISSION_SET: ReadonlySet<string> = new Set(HOSTED_PERMISSION_VOCABULARY);

/**
 * A verified app.papercusp.com user session.
 *
 * `workspaceId` remains the operator/control-plane workspace required by the
 * shared Principal contract. `selectedWorkspaceId` is the optional customer
 * workspace selected inside the active organization; keeping the two fields
 * distinct prevents ambient operator workspace state from becoming customer
 * resource authority.
 */
export interface HostedPrincipal extends Principal<'user'> {
  readonly profile: 'hosted';
  readonly userId: string;
  readonly activeOrganizationId: string;
  readonly selectedWorkspaceId?: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly permissions: ReadonlySet<HostedPermission>;
  capabilities: ReadonlySet<HostedPermission>;
}

export interface CreateHostedPrincipalInput {
  /** Operator/control-plane workspace scope, not the selected customer workspace. */
  workspaceId: string;
  userId: string;
  activeOrganizationId: string;
  selectedWorkspaceId?: string;
  sessionId: string;
  sessionVersion: number;
  permissions?: Iterable<string>;
  label?: string;
}

export function isHostedPermission(value: unknown): value is HostedPermission {
  return typeof value === 'string' && HOSTED_PERMISSION_SET.has(value);
}

/**
 * Construct the only supported hosted Principal shape.
 *
 * Missing permissions produce an empty set (deny by default). Unknown values,
 * including `*`, fail closed. The typed `permissions` and the generic
 * `capabilities` view intentionally reference the same set so the route-level
 * Principal gate and hosted authorization helpers cannot drift.
 */
export function createHostedPrincipal(input: CreateHostedPrincipalInput): HostedPrincipal {
  const workspaceId = requireIdentifier(input.workspaceId, 'workspaceId');
  const userId = requireIdentifier(input.userId, 'userId');
  const activeOrganizationId = requireIdentifier(
    input.activeOrganizationId,
    'activeOrganizationId',
  );
  const selectedWorkspaceId = input.selectedWorkspaceId === undefined
    ? undefined
    : requireIdentifier(input.selectedWorkspaceId, 'selectedWorkspaceId');
  const sessionId = requireIdentifier(input.sessionId, 'sessionId');
  const sessionVersion = requireSessionVersion(input.sessionVersion);
  const permissions = normalizePermissions(input.permissions);

  return {
    kind: 'user',
    profile: 'hosted',
    slug: userId,
    userId,
    workspaceId,
    activeOrganizationId,
    ...(selectedWorkspaceId === undefined ? {} : { selectedWorkspaceId }),
    sessionId,
    sessionVersion,
    authMethod: 'cookie-session',
    trust: 'verified',
    permissions,
    capabilities: permissions,
    ...(input.label === undefined ? {} : { label: input.label }),
  };
}

/**
 * Distinguish hosted users from legacy/local `kind: 'user'` principals.
 *
 * This is intentionally stricter than checking `kind`: the explicit profile
 * marker, tenant/session bindings, exact vocabulary, and shared permission set
 * must all be present. A local user therefore never gains hosted authority by
 * fallback or structural coincidence.
 */
export function isHostedPrincipal(principal: Principal): principal is HostedPrincipal {
  const candidate = principal as Principal & Partial<HostedPrincipal>;
  if (
    candidate.kind !== 'user' ||
    candidate.profile !== 'hosted' ||
    candidate.authMethod !== 'cookie-session' ||
    candidate.trust !== 'verified' ||
    candidate.slug !== candidate.userId ||
    !isNonEmptyIdentifier(candidate.workspaceId) ||
    !isNonEmptyIdentifier(candidate.userId) ||
    !isNonEmptyIdentifier(candidate.activeOrganizationId) ||
    !isNonEmptyIdentifier(candidate.sessionId) ||
    !isSessionVersion(candidate.sessionVersion) ||
    (candidate.selectedWorkspaceId !== undefined &&
      !isNonEmptyIdentifier(candidate.selectedWorkspaceId)) ||
    candidate.permissions !== candidate.capabilities
  ) {
    return false;
  }

  try {
    return [...candidate.permissions].every(isHostedPermission);
  } catch {
    return false;
  }
}

function normalizePermissions(values: Iterable<string> | undefined): ReadonlySet<HostedPermission> {
  const permissions = new Set<HostedPermission>();
  if (values === undefined) return permissions;
  if (typeof values === 'string') {
    throw new TypeError('hosted_permissions_must_be_an_iterable_of_permission_values');
  }

  for (const value of values) {
    if (!isHostedPermission(value)) {
      throw new TypeError(`unknown_hosted_permission:${String(value)}`);
    }
    permissions.add(value);
  }
  return permissions;
}

function requireIdentifier(value: string, field: string): string {
  if (!isNonEmptyIdentifier(value)) {
    throw new TypeError(`invalid_hosted_principal_${field}`);
  }
  return value.trim();
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireSessionVersion(value: number): number {
  if (!isSessionVersion(value)) {
    throw new TypeError('invalid_hosted_principal_sessionVersion');
  }
  return value;
}

function isSessionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
