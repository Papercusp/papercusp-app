/**
 * Hosted-customer tenant context for Postgres RLS.
 *
 * The caller supplies the already-authenticated hosted Principal plus the
 * server-resolved customer-workspace directory row. Raw route/body/query
 * identifiers are deliberately not accepted as separate arguments. The
 * workspace binding is checked against the Principal's active organization
 * before a transaction is opened, then all three tenant GUCs are installed
 * with transaction-local `set_config(..., true)` calls.
 *
 * `Principal.workspaceId` is the operator/control-plane workspace. It is used
 * only to acquire the existing workspace-scoped transaction. The optional
 * `selectedWorkspaceId` is the customer workspace written to
 * `app.workspace_id`; conflating the two would make ambient local workspace
 * state into hosted customer authority.
 */

import type { Sql } from 'postgres';
import { withWorkspace } from './workspace-context';

/** Structural subset of operator-core's HostedPrincipal needed by the DB seam. */
export interface HostedTenantPrincipal {
  readonly kind: 'user';
  readonly profile: 'hosted';
  readonly authMethod: 'cookie-session';
  readonly trust: 'verified';
  readonly slug: string;
  /** Operator/control-plane workspace, not the selected customer workspace. */
  readonly workspaceId: string;
  readonly userId: string;
  readonly activeOrganizationId: string;
  readonly selectedWorkspaceId?: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
}

/**
 * Result of resolving `selectedWorkspaceId` through the authoritative customer
 * workspace directory. Hosted request middleware owns that lookup; this module
 * owns checking that the resolved record still matches the verified Principal.
 */
export interface ResolvedTenantWorkspace {
  readonly id: string;
  readonly organizationId: string;
}

export interface VerifiedTenantServerContext {
  readonly principal: HostedTenantPrincipal;
  readonly selectedWorkspace?: ResolvedTenantWorkspace | null;
}

export interface DerivedTenantContext {
  readonly controlPlaneWorkspaceId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId?: string;
}

export type TenantContextErrorCode =
  | 'tenant_context_unverified_principal'
  | 'tenant_context_missing_scope'
  | 'tenant_context_principal_identity_mismatch'
  | 'tenant_context_workspace_binding_missing'
  | 'tenant_context_workspace_binding_unexpected'
  | 'tenant_context_workspace_binding_mismatch'
  | 'tenant_context_foreign_workspace'
  /**
   * The transaction could not assume {@link HOSTED_TENANT_ROLE}. Distinct from
   * the validation codes above: the Principal was fine and the refusal came from
   * the database, almost always because migration 997's membership grant has not
   * been applied by a superuser. Fail-closed, never a leak.
   */
  | 'tenant_context_hosted_role_unavailable';

export type HostedServiceContextErrorCode = 'hosted_service_role_unavailable';

export class HostedServiceContextError extends Error {
  override readonly name = 'HostedServiceContextError';

  constructor(
    readonly code: HostedServiceContextErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(code, options);
  }
}

export class TenantContextError extends Error {
  override readonly name = 'TenantContextError';

  constructor(
    readonly code: TenantContextErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(code, options);
  }
}

/**
 * Validate and reduce verified server context to the values safe to install as
 * tenant GUCs. This function is intentionally pure so every refusal is testable
 * without opening a database connection.
 */
export function deriveTenantContext(context: VerifiedTenantServerContext): DerivedTenantContext {
  const principal = context?.principal as Partial<HostedTenantPrincipal> | undefined;
  if (
    principal?.kind !== 'user' ||
    principal.profile !== 'hosted' ||
    principal.authMethod !== 'cookie-session' ||
    principal.trust !== 'verified'
  ) {
    throw new TenantContextError('tenant_context_unverified_principal');
  }

  const controlPlaneWorkspaceId = requireIdentifier(principal.workspaceId);
  const userId = requireIdentifier(principal.userId);
  const organizationId = requireIdentifier(principal.activeOrganizationId);
  const sessionId = requireIdentifier(principal.sessionId);
  if (
    !controlPlaneWorkspaceId ||
    !userId ||
    !organizationId ||
    !sessionId ||
    !Number.isSafeInteger(principal.sessionVersion) ||
    (principal.sessionVersion as number) < 0
  ) {
    throw new TenantContextError('tenant_context_missing_scope');
  }
  if (principal.slug !== userId) {
    throw new TenantContextError('tenant_context_principal_identity_mismatch');
  }

  const selectedWorkspaceId =
    principal.selectedWorkspaceId === undefined ? undefined : requireIdentifier(principal.selectedWorkspaceId);
  if (principal.selectedWorkspaceId !== undefined && !selectedWorkspaceId) {
    throw new TenantContextError('tenant_context_missing_scope');
  }

  const resolvedWorkspace = context.selectedWorkspace;
  if (selectedWorkspaceId === undefined) {
    if (resolvedWorkspace !== undefined && resolvedWorkspace !== null) {
      throw new TenantContextError('tenant_context_workspace_binding_unexpected');
    }
    return Object.freeze({ controlPlaneWorkspaceId, userId, organizationId });
  }

  if (resolvedWorkspace === undefined || resolvedWorkspace === null) {
    throw new TenantContextError('tenant_context_workspace_binding_missing');
  }
  const resolvedWorkspaceId = requireIdentifier(resolvedWorkspace.id);
  const resolvedOrganizationId = requireIdentifier(resolvedWorkspace.organizationId);
  if (!resolvedWorkspaceId || !resolvedOrganizationId) {
    throw new TenantContextError('tenant_context_missing_scope');
  }
  if (resolvedWorkspaceId !== selectedWorkspaceId) {
    throw new TenantContextError('tenant_context_workspace_binding_mismatch');
  }
  if (resolvedOrganizationId !== organizationId) {
    throw new TenantContextError('tenant_context_foreign_workspace');
  }

  return Object.freeze({
    controlPlaneWorkspaceId,
    userId,
    organizationId,
    workspaceId: selectedWorkspaceId,
  });
}

/**
 * Run hosted-customer queries inside the canonical tenant transaction.
 *
 * `withWorkspace` is reused for the existing bounded app pool, acquisition
 * deadline/retry, PgBouncer-safe transaction, and search_path setup. Its initial
 * control-plane `app.workspace_id` is overwritten before the caller callback can
 * run; a request with no selected customer workspace gets an explicit empty
 * transaction-local value (fail closed), never ambient pooled-connection state.
 */
export async function withTenantContext<T>(
  context: VerifiedTenantServerContext,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const tenant = deriveTenantContext(context);
  return withWorkspace(tenant.controlPlaneWorkspaceId, async (tx) => {
    await tx`
      SELECT
        set_config('app.user_id', ${tenant.userId}, true),
        set_config('app.organization_id', ${tenant.organizationId}, true),
        set_config('app.workspace_id', ${tenant.workspaceId ?? ''}, true)
    `;
    await enterHostedAppRole(tx);
    return fn(tx);
  });
}

/**
 * The database role the hosted request path runs as.
 *
 * Migration 978 creates it `NOLOGIN`, and re-verifies on every run that no
 * hosted_* role can log in — so this role is reachable ONLY by assumption, never
 * by connecting as it. Migration 997 grants `harness_app` (the application pool
 * role) membership `WITH INHERIT FALSE`, which is what makes the switch below
 * both possible and non-ambient.
 */
export const HOSTED_TENANT_ROLE = 'hosted_app';

/**
 * Database role for provider lifecycle, session, and webhook work.
 *
 * Like hosted_app, this is a NOLOGIN role and must only be reached through a
 * transaction-local switch. Migration 1005 grants harness_app SET permission
 * with INHERIT FALSE, so ordinary application queries never receive these
 * global service privileges ambiently.
 */
export const HOSTED_SERVICE_ROLE = 'hosted_service';

/**
 * Run provider lifecycle work as hosted_service on the bounded application
 * pool. The fixed workspace sentinel is intentionally not customer authority:
 * hosted_service policies are global service policies and consult no tenant
 * GUC. Reusing withWorkspace keeps the canonical acquisition deadline,
 * connection retry, PgBouncer search_path repair, and transaction cleanup.
 */
export async function withHostedServiceContext<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  return withWorkspace('hosted-control-plane-service', async (tx) => {
    try {
      await enterHostedRole(tx, HOSTED_SERVICE_ROLE);
    } catch (cause) {
      throw new HostedServiceContextError('hosted_service_role_unavailable', { cause });
    }
    return fn(tx);
  });
}

/**
 * Switch the transaction into the hosted role.
 *
 * This is the step that makes the FORCE RLS policies of migrations 978/979
 * apply at all: every one of them is granted `TO hosted_app`, and the pool
 * connects as `harness_app`, which those same migrations REVOKE from the hosted
 * tables. Without this switch the hosted path is not "unprotected" — it is
 * inert, failing closed with `permission denied for table`.
 *
 * `SET LOCAL` is required rather than `SET`: it is reverted when the
 * transaction commits or rolls back, so a pooled connection can never be handed
 * to the next caller still wearing the hosted role.
 */
async function enterHostedAppRole(tx: Sql): Promise<void> {
  try {
    await enterHostedRole(tx, HOSTED_TENANT_ROLE);
  } catch (cause) {
    // Fail CLOSED and legibly. The common cause is migration 997's grant not
    // having been applied — it degrades to a warning precisely because it needs
    // a superuser — and the raw driver error ("permission denied to set role")
    // does not say which grant is missing.
    throw new TenantContextError('tenant_context_hosted_role_unavailable', { cause });
  }
}

async function enterHostedRole(tx: Sql, role: typeof HOSTED_TENANT_ROLE | typeof HOSTED_SERVICE_ROLE): Promise<void> {
  // `role` is a closed union of module constants, never caller input, so
  // `.unsafe` carries no injection surface — and SET ROLE cannot take a bind
  // parameter.
  await tx.unsafe(`SET LOCAL ROLE ${role}`);
}

function requireIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  return value;
}
