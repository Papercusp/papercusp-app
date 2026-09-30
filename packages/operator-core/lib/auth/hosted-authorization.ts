import type { Principal } from '@papercusp/tooldef';
import {
  isHostedPermission,
  isHostedPrincipal,
  type HostedPermission,
  type HostedPrincipal,
} from './hosted-principal';

/** Permissions whose target must be an exact customer workspace. */
const WORKSPACE_PERMISSIONS: ReadonlySet<HostedPermission> = new Set([
  'workspace:view',
  'workspace:operate',
  'workspace:destroy',
]);

export type HostedAuthorizationResource =
  | {
      readonly kind: 'organization';
      readonly organizationId: string;
    }
  | {
      readonly kind: 'workspace';
      readonly organizationId: string;
      readonly workspaceId: string;
    };

/**
 * Current authoritative state loaded for the session named by the principal.
 *
 * Callers must load this snapshot for every protected operation. It is
 * deliberately separate from the signed/cookie-carried principal: comparing
 * the two is what makes a revocation or version bump effective immediately.
 */
export interface HostedSessionAuthorizationState {
  readonly sessionId: string;
  readonly sessionVersion: number;
  readonly revoked: boolean;
}

export interface HostedAuthorizationInput {
  readonly principal: Principal | null | undefined;
  readonly permission: HostedPermission;
  readonly resource: HostedAuthorizationResource;
  readonly session: HostedSessionAuthorizationState | null | undefined;
}

export const HOSTED_AUTHORIZATION_DENIAL_REASONS = [
  'principal_missing',
  'principal_not_hosted',
  'permission_invalid',
  'session_state_missing',
  'session_state_invalid',
  'session_id_mismatch',
  'session_revoked',
  'session_version_mismatch',
  'resource_scope_invalid',
  'resource_kind_mismatch',
  'organization_mismatch',
  'workspace_not_selected',
  'workspace_mismatch',
  'permission_missing',
] as const;

export type HostedAuthorizationDenialReason =
  (typeof HOSTED_AUTHORIZATION_DENIAL_REASONS)[number];

export interface HostedAuthorizationAuditRecord {
  readonly decision: 'allow' | 'deny';
  readonly reason: 'authorized' | HostedAuthorizationDenialReason;
  /** Runtime value is retained for audits even when it is outside the vocabulary. */
  readonly permission: string;
  readonly principalSlug: string | null;
  readonly organizationId: string | null;
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly sessionVersion: number | null;
}

export interface HostedAuthorizationAllowed {
  readonly allowed: true;
  readonly status: 200;
  readonly principal: HostedPrincipal;
  readonly audit: HostedAuthorizationAuditRecord & {
    readonly decision: 'allow';
    readonly reason: 'authorized';
  };
}

export interface HostedAuthorizationDenied {
  readonly allowed: false;
  readonly status: 401 | 403;
  readonly reason: HostedAuthorizationDenialReason;
  readonly audit: HostedAuthorizationAuditRecord & {
    readonly decision: 'deny';
    readonly reason: HostedAuthorizationDenialReason;
  };
}

export type HostedAuthorizationDecision =
  | HostedAuthorizationAllowed
  | HostedAuthorizationDenied;

/** Stable error shape for route middleware to translate into a generic response. */
export class HostedAuthorizationError extends Error {
  readonly name = 'HostedAuthorizationError';
  readonly code = 'hosted_authorization_denied';
  readonly status: 401 | 403;
  readonly reason: HostedAuthorizationDenialReason;
  readonly audit: HostedAuthorizationDenied['audit'];

  constructor(decision: HostedAuthorizationDenied) {
    super(`hosted_authorization_denied:${decision.reason}`);
    this.status = decision.status;
    this.reason = decision.reason;
    this.audit = decision.audit;
  }
}

/** The resource scope an exact hosted permission is allowed to target. */
export function hostedPermissionResourceKind(
  permission: HostedPermission,
): HostedAuthorizationResource['kind'] {
  return WORKSPACE_PERMISSIONS.has(permission) ? 'workspace' : 'organization';
}

/**
 * Evaluate one hosted operation without side effects.
 *
 * Every fact that grants access must be present and agree exactly: a verified
 * hosted principal, a live authoritative session at the same version, the
 * permission's declared resource kind, matching tenant bindings, and the
 * explicit permission itself. No local principal, wildcard, ambient workspace,
 * or omitted value is treated as authority.
 */
export function authorizeHostedOperation(
  input: HostedAuthorizationInput,
): HostedAuthorizationDecision {
  if (!input.principal) return deny(input, 'principal_missing', 401);
  if (!isHostedPrincipal(input.principal)) {
    return deny(input, 'principal_not_hosted', 403);
  }
  const principal = input.principal;

  if (!isHostedPermission(input.permission)) {
    return deny(input, 'permission_invalid', 403, principal);
  }
  if (!input.session) {
    return deny(input, 'session_state_missing', 401, principal);
  }
  if (!isValidSessionState(input.session)) {
    return deny(input, 'session_state_invalid', 401, principal);
  }
  if (input.session.sessionId !== principal.sessionId) {
    return deny(input, 'session_id_mismatch', 401, principal);
  }
  if (input.session.revoked) {
    return deny(input, 'session_revoked', 401, principal);
  }
  if (input.session.sessionVersion !== principal.sessionVersion) {
    return deny(input, 'session_version_mismatch', 401, principal);
  }

  if (!isValidResource(input.resource)) {
    return deny(input, 'resource_scope_invalid', 403, principal);
  }
  if (hostedPermissionResourceKind(input.permission) !== input.resource.kind) {
    return deny(input, 'resource_kind_mismatch', 403, principal);
  }
  if (input.resource.organizationId !== principal.activeOrganizationId) {
    return deny(input, 'organization_mismatch', 403, principal);
  }
  if (input.resource.kind === 'workspace') {
    if (principal.selectedWorkspaceId === undefined) {
      return deny(input, 'workspace_not_selected', 403, principal);
    }
    if (input.resource.workspaceId !== principal.selectedWorkspaceId) {
      return deny(input, 'workspace_mismatch', 403, principal);
    }
  }
  if (!principal.permissions.has(input.permission)) {
    return deny(input, 'permission_missing', 403, principal);
  }

  return {
    allowed: true,
    status: 200,
    principal,
    audit: auditRecord(input, 'allow', 'authorized', principal),
  };
}

/** Evaluate and either return the narrowed hosted principal or throw a typed denial. */
export function requireHostedOperation(input: HostedAuthorizationInput): HostedPrincipal {
  const decision = authorizeHostedOperation(input);
  if (!decision.allowed) throw new HostedAuthorizationError(decision);
  return decision.principal;
}

function deny(
  input: HostedAuthorizationInput,
  reason: HostedAuthorizationDenialReason,
  status: 401 | 403,
  principal?: HostedPrincipal,
): HostedAuthorizationDenied {
  return {
    allowed: false,
    status,
    reason,
    audit: auditRecord(input, 'deny', reason, principal),
  };
}

function auditRecord<TDecision extends 'allow' | 'deny', TReason extends HostedAuthorizationAuditRecord['reason']>(
  input: HostedAuthorizationInput,
  decision: TDecision,
  reason: TReason,
  hostedPrincipal?: HostedPrincipal,
): HostedAuthorizationAuditRecord & { decision: TDecision; reason: TReason } {
  const principal = input.principal;
  const resource = input.resource && typeof input.resource === 'object'
    ? input.resource as unknown as Record<string, unknown>
    : {};
  const session = input.session;
  return {
    decision,
    reason,
    permission: typeof input.permission === 'string' ? input.permission : '<invalid>',
    principalSlug: hostedPrincipal?.slug ?? readString(principal, 'slug'),
    organizationId: readNonEmpty(resource.organizationId),
    workspaceId: readNonEmpty(resource.workspaceId),
    sessionId: readNonEmpty(session?.sessionId) ?? hostedPrincipal?.sessionId ?? null,
    sessionVersion: isSessionVersion(session?.sessionVersion)
      ? session.sessionVersion
      : hostedPrincipal?.sessionVersion ?? null,
  };
}

function isValidSessionState(
  session: HostedSessionAuthorizationState,
): session is HostedSessionAuthorizationState {
  return (
    readNonEmpty(session.sessionId) !== null &&
    isSessionVersion(session.sessionVersion) &&
    typeof session.revoked === 'boolean'
  );
}

function isValidResource(resource: HostedAuthorizationResource): boolean {
  if (!resource || readNonEmpty(resource.organizationId) === null) return false;
  if (resource.kind === 'organization') {
    return !('workspaceId' in resource);
  }
  return resource.kind === 'workspace' && readNonEmpty(resource.workspaceId) !== null;
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') return null;
  return readNonEmpty((value as Record<string, unknown>)[key]);
}

function readNonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isSessionVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
