/**
 * HostedOnboardingWorkspacePort — the admission half of hosted first-workspace onboarding.
 *
 * WHY THIS EXISTS (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, D-380/D-381/D-383).
 * A hosted organization could not obtain its FIRST workspace. Four individually-correct
 * layers composed into a system with a coherent steady state and no entry into it:
 *
 *   1. every hosted-browser route resolves through `selectedHostedPrincipal`, which
 *      returns `workspace_not_selected` without an already-selected workspace;
 *   2. `customer_workspaces_app_scope` (hosted_app) WITH CHECK requires
 *      `id = current_setting('app.workspace_id')`, unsatisfiable before one exists;
 *   3. `customer_workspaces.workspace_host_id` is NOT NULL and FKs `workspace_hosts`;
 *   4. and `harness_app` held no GRANT on `customer_workspaces` at all (migration 1193).
 *
 * In one line: the table was reachable only by a principal that ALREADY HELD the workspace
 * it was trying to create. This module is the privileged, org-scoped admission step that
 * breaks that cycle from OUTSIDE it — which is why the fix is not, and must never become,
 * a relaxation of layer 1 or 2. Loosening either re-opens the tenant boundary closed by
 * D-368 / WI-10002396; migration 1193 deliberately left the hosted_app predicate untouched.
 *
 * WHAT IS DELIBERATELY INJECTED. `resolveDesiredSpec` is a dependency rather than logic
 * here. Building a `WorkspaceHostDesiredSpec` requires region/size/image/credentials, and
 * those follow from an unsettled product question (what a hosted-free self-signup
 * workspace runs on). The ADMISSION ordering and its idempotency do not depend on that
 * answer, so they are implemented and tested now; the spec choice plugs in later without
 * reopening this file.
 */
import { createHash } from 'node:crypto';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import type { HostedOnboardingWorkspacePort } from './onboarding';

/** Matches the provision route's own id guard so an admitted id can never be unroutable. */
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

/** Field separator for the identity digest; escaped, never a raw control byte in source. */
const DIGEST_SEPARATOR = '\x00';

export type HostedWorkspaceProvider = 'gcp' | 'aws' | 'azure';

export interface HostedWorkspaceBinding {
  workspaceId: string;
  organizationId: string;
  workspaceHostId: string;
  state: string;
}

export interface HostedWorkspaceAdmissionDependencies {
  /** The control-plane tenant scope (harness_shared.*.workspace_id), NOT the customer workspace. */
  controlPlaneWorkspaceId(): string;
  readConnection(
    controlPlaneWorkspaceId: string,
    connectionId: string,
  ): Promise<{ id: string } | null>;
  readBinding(
    controlPlaneWorkspaceId: string,
    workspaceId: string,
  ): Promise<HostedWorkspaceBinding | null>;
  resolveDesiredSpec(input: {
    organizationId: string;
    provider: HostedWorkspaceProvider;
    connectionId: string;
    hostId: string;
    displayName: string;
  }): Promise<WorkspaceHostDesiredSpec>;
  upsertHost(input: {
    controlPlaneWorkspaceId: string;
    hostId: string;
    name: string;
    connectionId: string;
    desiredSpec: WorkspaceHostDesiredSpec;
  }): Promise<void>;
  /**
   * Idempotent INSERT of the binding; reports whether THIS call created the row. Throws
   * `organization_has_live_workspace` when the organization already holds another live
   * workspace, after removing the host row this attempt wrote.
   */
  bindWorkspace(input: {
    controlPlaneWorkspaceId: string;
    workspaceId: string;
    organizationId: string;
    workspaceHostId: string;
    displayName: string;
    userId: string;
  }): Promise<{ created: boolean }>;
  /**
   * Enqueue provisioning. Intentionally NOT awaited by this module: the durable workflow
   * helper resolves only when the whole provision finishes, and onboarding must not block
   * a signup on a cloud VM coming up. Progress and failure are carried by the
   * workspace_host_operations ledger under `provisionOperationId`.
   */
  startProvisioning(input: {
    controlPlaneWorkspaceId: string;
    /** The workspace this host serves; a bring-up (D-401) marks it active when it completes. */
    customerWorkspaceId: string;
    connectionId: string;
    hostId: string;
    name: string;
    desiredSpec: WorkspaceHostDesiredSpec;
    operationId: string;
    actorId: string;
  }): void;
}

export class HostedWorkspaceAdmissionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_input'
      | 'connection_not_found'
      | 'organization_mismatch'
      | 'identifier_unroutable'
      | 'spec_host_mismatch'
      /** One live workspace — and so one host — per organization (D-397, migration 1200). */
      | 'organization_has_live_workspace',
  ) {
    super(message);
    this.name = 'HostedWorkspaceAdmissionError';
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HostedWorkspaceAdmissionError(`${name} is required`, 'invalid_input');
  }
  return value.trim();
}

/**
 * Derive stable identifiers from the orchestrator's operationKey.
 *
 * Idempotency is STRUCTURAL rather than stateful: the same operationKey yields the same
 * workspace id, host id and provision operation id, so a replayed attempt re-reads its own
 * binding and re-uses the deduplicated provisioning operation instead of creating a second
 * workspace. The organization id is mixed in so the same key under a different org can
 * never collide onto one identity.
 */
export function admissionIdentity(
  organizationId: string,
  operationKey: string,
): { workspaceId: string; hostId: string; provisionOperationId: string } {
  const digest = createHash('sha256')
    .update(organizationId)
    .update(DIGEST_SEPARATOR)
    .update(operationKey)
    .digest('hex')
    .slice(0, 24);
  return {
    workspaceId: `ws-${digest}`,
    hostId: `host-${digest}`,
    provisionOperationId: `prov-${digest}`,
  };
}

export function createHostedWorkspaceAdmission(
  deps: HostedWorkspaceAdmissionDependencies,
): HostedOnboardingWorkspacePort {
  return {
    async ensureProvisioned(input) {
      const organizationId = required(input.organizationId, 'organizationId');
      const userId = required(input.userId, 'userId');
      const connectionId = required(input.connectionId, 'connectionId');
      const displayName = required(input.displayName, 'displayName');
      const operationKey = required(input.operationKey, 'operationKey');
      const controlPlaneWorkspaceId = deps.controlPlaneWorkspaceId();

      const derived = admissionIdentity(organizationId, operationKey);
      // A caller-requested id is honoured, but it is still subject to the ownership check
      // below — so naming someone else's existing workspace is a refusal, never a takeover.
      const workspaceId = input.requestedWorkspaceId?.trim() || derived.workspaceId;
      if (!SAFE_ID.test(workspaceId) || !SAFE_ID.test(derived.hostId)) {
        throw new HostedWorkspaceAdmissionError(
          'derived workspace/host identifier is not routable',
          'identifier_unroutable',
        );
      }

      // REPLAY / OWNERSHIP. Read before writing: an existing binding for another
      // organization must never be adopted, and an existing binding for THIS organization
      // is a completed admission to return verbatim.
      const existing = await deps.readBinding(controlPlaneWorkspaceId, workspaceId);
      if (existing) {
        if (existing.organizationId !== organizationId) {
          throw new HostedWorkspaceAdmissionError(
            'workspace is bound to a different organization',
            'organization_mismatch',
          );
        }
        return { workspaceId, provisionOperationId: derived.provisionOperationId };
      }

      const connection = await deps.readConnection(controlPlaneWorkspaceId, connectionId);
      if (!connection) {
        throw new HostedWorkspaceAdmissionError(
          `connection ${connectionId} is not admitted in this control plane`,
          'connection_not_found',
        );
      }

      const desiredSpec = await deps.resolveDesiredSpec({
        organizationId,
        provider: input.provider,
        connectionId,
        hostId: derived.hostId,
        displayName,
      });

      // IDENTITY, NOT A FORMALITY. The provisioning runner takes the host's identity from
      // the SPEC (`nonEmpty(input.desired.hostId, 'desired.hostId')`), while the binding
      // below references `derived.hostId`. If a resolver returns a spec naming a different
      // host, BOTH writes succeed: the workspace is bound to the host row admission wrote,
      // and provisioning goes on to build a different one. Nothing throws, nothing is
      // logged, and the workspace is permanently attached to a machine that will never
      // exist. Refuse instead — a divergence with no failing call cannot be debugged later.
      if (desiredSpec.hostId !== derived.hostId) {
        throw new HostedWorkspaceAdmissionError(
          `resolved desired spec names host '${desiredSpec.hostId}', not the admitted '${derived.hostId}'`,
          'spec_host_mismatch',
        );
      }

      // ORDER IS LOAD-BEARING: customer_workspaces.workspace_host_id is NOT NULL and FKs
      // workspace_hosts, so the host row must exist before the binding can reference it.
      await deps.upsertHost({
        controlPlaneWorkspaceId,
        hostId: derived.hostId,
        name: displayName,
        connectionId,
        desiredSpec,
      });

      const { created } = await deps.bindWorkspace({
        controlPlaneWorkspaceId,
        workspaceId,
        organizationId,
        workspaceHostId: derived.hostId,
        displayName,
        userId,
      });

      // Only the call that actually created the binding enqueues provisioning. A concurrent
      // replay that lost the INSERT race must not enqueue a second provision for the host.
      if (created) {
        deps.startProvisioning({
          controlPlaneWorkspaceId,
          customerWorkspaceId: workspaceId,
          connectionId,
          hostId: derived.hostId,
          name: displayName,
          desiredSpec,
          operationId: derived.provisionOperationId,
          actorId: userId,
        });
      }

      return { workspaceId, provisionOperationId: derived.provisionOperationId };
    },

    async resolveSelectable(input) {
      const organizationId = required(input.organizationId, 'organizationId');
      const workspaceId = required(input.workspaceId, 'workspaceId');
      const binding = await deps.readBinding(deps.controlPlaneWorkspaceId(), workspaceId);
      // Selectability is ownership plus liveness: a deleted binding is not selectable even
      // though the row survives for audit.
      return Boolean(
        binding && binding.organizationId === organizationId && binding.state !== 'deleted',
      );
    },
  };
}
