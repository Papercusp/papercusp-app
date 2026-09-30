/**
 * Production wiring for {@link createHostedFirstWorkspace}.
 *
 * `first-workspace.ts` owns the bootstrap ORDERING, its idempotency and its refusals, and
 * takes every effect as an injected dependency so those properties are testable without a
 * database. This file is the other half: the real Postgres/DBOS effects, assembled once by
 * the hosted runtime.
 *
 * WHY THE DELEGATION STORE RUNS UNDER `withWorkspace` AND NOT THE TENANT RUNNER (D-384).
 * The steady-state delegation routes run as hosted_app inside the caller's tenant context,
 * and migration 979's hosted_app policy only admits a `workspace_host_connections` row that
 * a host ALREADY BOUND to the caller's workspace references. A first workspace has no such
 * host, so that INSERT is refused by construction (measured: RLS error, positive control 1
 * row). `withWorkspace(controlPlaneWorkspaceId, …)` is the harness_app pool with the
 * control-plane scope set — the same privilege `workspace-admission-dependencies.ts` uses
 * for `customer_workspaces` — and it is safe here ONLY because `first-workspace.ts` derives
 * every identifier (workspace, host, connection, credential reference) from the caller's
 * session-authenticated organization. Nothing a request body carries reaches this store as
 * a key.
 */
import { withWorkspace } from '@papercusp/db-org';
import { dbosStarted } from '../../dbos/bootstrap';
import type { WorkspaceHostProvisioningEnqueuer } from '../../dbos/workspace-host-provision-client';
import { HostedSessionStore } from '../hosted-session';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
} from '../../workspace-host/hosted-provider-delegation';
import { gcpDelegationOrganization } from '../../workspace-host/hosted-gcp-auth';
import type { HostedFirstWorkspaceDependencies } from './first-workspace';
import { createHostedWorkspaceAdmission } from './workspace-admission';
import { createDefaultHostedWorkspaceAdmissionDependencies } from './workspace-admission-dependencies';
import type { HostedServiceContextRunner } from './workos-lifecycle-postgres';

/**
 * Comma-separated organization ids allowed through the first-workspace door. Unset or empty
 * means CLOSED for everyone — the D-384 confused-deputy gate stays shut until an operator
 * names an organization explicitly.
 */
export const HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV = 'PAPERCUSP_HOSTED_FIRST_WORKSPACE_ORGANIZATIONS';

export function parseFirstWorkspaceOrganizations(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export interface HostedFirstWorkspaceRuntimeOptions {
  /** The control-plane tenant scope (harness_shared.*.workspace_id), NOT a customer workspace. */
  readonly controlPlaneWorkspaceId: string;
  /** The hosted service runner that owns `papercusp_auth.hosted_sessions`. */
  readonly runService: HostedServiceContextRunner;
  readonly delegationAdapters: Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>>;
  readonly enabledOrganizations: ReadonlySet<string>;
  /**
   * A DBOS-client enqueuer for a process that does not run DBOS (the hosted control plane).
   * When present, provisioning is available by construction; when absent, provisioning runs
   * in-process and is available only once DBOS has started.
   */
  readonly provisioning?: WorkspaceHostProvisioningEnqueuer;
  readonly provisioningAvailable?: () => boolean;
  /** Default: the organization's own account in the GCP identity project (D-397). */
  readonly delegationOrganization?: (organizationId: string) => HostedDelegationOrganization;
}

export function createHostedFirstWorkspaceDependencies(
  options: HostedFirstWorkspaceRuntimeOptions,
): HostedFirstWorkspaceDependencies {
  const controlPlaneWorkspaceId = options.controlPlaneWorkspaceId;
  const store = new PostgresHostedProviderDelegationStore(
    (fn) => withWorkspace(controlPlaneWorkspaceId, fn),
    controlPlaneWorkspaceId,
  );
  const delegationOrganization = options.delegationOrganization ?? ((organizationId: string) =>
    gcpDelegationOrganization(organizationId));
  // One manager per organization: it stamps and checks the owner of every record it touches.
  const manager = (organizationId: string) =>
    new HostedProviderDelegationManager(store, options.delegationAdapters, delegationOrganization(organizationId));
  const provisioning = options.provisioning;

  return {
    isEnabledFor: (organizationId) => options.enabledOrganizations.has(organizationId),
    provisioningAvailable: options.provisioningAvailable ?? (provisioning ? () => true : dbosStarted),
    delegationOrganization,

    organizationWorkspaceIds(organizationId) {
      return withWorkspace(controlPlaneWorkspaceId, async (sql) => {
        const rows = await sql<{ id: string }[]>`
          SELECT id
            FROM harness_shared.customer_workspaces
           WHERE workspace_id = ${controlPlaneWorkspaceId}
             AND organization_id = ${organizationId}
             AND state <> 'deleted'
        `;
        return rows.map((row) => row.id);
      });
    },

    readDelegation: (workspaceId, connectionId) => store.read(workspaceId, connectionId),
    onboardDelegation: (input) => manager(input.organizationId).onboard(input),
    onboardPapercuspHostedDelegation: (organizationId, input, hostId) =>
      manager(organizationId).onboardPapercuspHosted(input, hostId),
    verifyDelegation: (organizationId, workspaceId, connectionId) =>
      manager(organizationId).verify(workspaceId, connectionId),

    createAdmission: (resolveDesiredSpec, admissionOptions) =>
      createHostedWorkspaceAdmission({
        ...createDefaultHostedWorkspaceAdmissionDependencies({
          resolveDesiredSpec,
          ...(provisioning ? { startWorkflow: (input) => provisioning.enqueue(input) } : {}),
          ...(admissionOptions?.bringUp ? { bringUp: admissionOptions.bringUp } : {}),
        }),
        // The default reads the operator's active workspace; the hosted process is scoped by
        // its configured control plane instead, and the delegation store above uses the same.
        controlPlaneWorkspaceId: () => controlPlaneWorkspaceId,
      }),

    async selectWorkspace(input) {
      // Rotation mints a NEW session id; the route re-issues the cookie from it.
      const session = await options.runService((sql) =>
        new HostedSessionStore(sql as never).rotate(input.sessionId, {
          expectedPermissionVersion: input.expectedPermissionVersion,
          workspaceId: input.workspaceId,
        }),
      );
      return session ? { sessionId: session.id, expiresAt: session.expiresAt } : null;
    },
  };
}
