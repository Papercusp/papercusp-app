/**
 * D-401: what a Papercusp-hosted workspace runs right after its machine is built.
 *
 * Provisioning alone leaves a machine with the runtime installed at first boot and nothing else:
 * no workspace, no agent, no desktop, and a `customer_workspaces` row that stays `provisioning`
 * forever because nothing ever wrote `active` (measured 2026-09-23 on
 * host-3b44551202aa97c3c3048660). The owner ruled the hosted path must reach a usable workspace
 * with no manual step, while the customer still connects their OWN agent accounts afterwards
 * (D-250 holds). So the chain is: initialize (local-inference agent only) -> desktop pack ->
 * mark the customer workspace `active`.
 *
 * WHO MAY ASK FOR IT. Only the hosted (app.papercusp.com) doors set a bring-up: first-workspace,
 * for every GCP and AWS host whether it runs in Papercusp's project/account or the customer's own
 * (an AWS host is reached over SSM, as the connection's own role — never ambient), and the hosted
 * provision route, for the bound host of a customer workspace still 'provisioning' (a retry of a
 * failed first build). A portal customer has no controller and no initialize route of their own,
 * so without it their workspace never leaves 'provisioning' (aws-byoc-gcp-parity D-015). It is an
 * explicit field on the provisioning input, never inferred from the spec, so a desktop/local
 * provision (the loopback route, the canary) still ends at the machine exactly as before.
 *
 * EVERY FIELD IS DERIVED ON THE SERVER. The initialization request below is built from the
 * host's own desired spec; nothing a browser sent reaches it.
 */
import { withHostedServiceContext, withWorkspace } from '@papercusp/db-org';
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  HostedWorkspaceConnectorGateway,
  PostgresHostedWorkspaceConnectorStore,
} from '../endpoint-route/hosted-workspace-connector';
import { enrollGcpIapWorkspaceHostConnector } from './gcp-iap-connector-enrollment';
import type { WorkspaceHostInitializationAdmission } from './initialization-admission';
import {
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
} from './initialization-operations-resolver';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  recordWorkspaceHostSignals,
  updateWorkspaceHostOperation,
} from './observability-store';

/**
 * `omp` only. It verifies against inference running on the customer's own machine, so it needs
 * no Papercusp or customer account. Omitting the list means claude+codex+omp, and those two need
 * accounts the customer has not connected yet: measured, initialization then fails agent
 * readiness (op d401-probe-init-2) and the workspace never becomes usable.
 */
export const PAPERCUSP_HOSTED_BRING_UP_AGENTS: readonly WorkspaceHostCanaryAgent[] = ['omp'];

export interface WorkspaceHostBringUp {
  /** The customer workspace bound to this host; it becomes `active` when the chain completes. */
  customerWorkspaceId: string;
  requestedAgents: readonly WorkspaceHostCanaryAgent[];
}

/** One operation per stage, derived from the provision so a replay reuses the same records. */
export function workspaceHostBringUpOperationIds(provisionOperationId: string): {
  initialize: string;
  desktopPack: string;
  connector: string;
} {
  return {
    initialize: `${provisionOperationId}.initialize`,
    desktopPack: `${provisionOperationId}.desktop-pack`,
    connector: `${provisionOperationId}.connector`,
  };
}

/**
 * The machine's own cloud identity, as a workload: a GCP VM's service account in its project, or an
 * EC2 instance's instance profile in its account (aws-byoc-gcp-parity D-015 rule 3). Either way the
 * instance metadata service answers it on the machine, so nothing is delivered to disk.
 */
const HOSTED_BRING_UP_SCOPE_KINDS: Readonly<Record<string, string>> = { gcp: 'project', aws: 'account' };

/**
 * Whether a provider has a hosted bring-up. Both doors (first-workspace, the hosted provision route)
 * ask this table instead of naming clouds themselves, so adding a cloud is one entry here.
 */
export function hostedBringUpSupportsProvider(provider: string): boolean {
  return Object.hasOwn(HOSTED_BRING_UP_SCOPE_KINDS, provider);
}

/** Whether this host's target AND scope have a hosted bring-up. */
export function hostedBringUpSupportsHost(desired: WorkspaceHostDesiredSpec): boolean {
  const target = String(desired.target);
  return hostedBringUpSupportsProvider(target) && HOSTED_BRING_UP_SCOPE_KINDS[target] === desired.scope.kind;
}

function hostedBringUpWorkload(desired: WorkspaceHostDesiredSpec): {
  provider: string;
  scopeId: string;
  workloadId: string;
} {
  if (!hostedBringUpSupportsHost(desired)) {
    throw new Error(
      `hosted bring-up supports GCP project and AWS account hosts only (host ${desired.hostId}, ` +
        `target ${String(desired.target)}, scope ${String(desired.scope.kind)})`,
    );
  }
  return { provider: String(desired.target), scopeId: desired.scope.id, workloadId: desired.hostId };
}

/**
 * The initialization request for a freshly built hosted machine: an empty workspace and the
 * machine's own cloud identity (the instance metadata server answers it; nothing is delivered
 * to disk). A first build is the first binding, so the generation is 1.
 */
export function hostedBringUpInitialization(input: {
  workspaceId: string;
  operationId: string;
  requestedAt: string;
  desired: WorkspaceHostDesiredSpec;
  requestedAgents: readonly WorkspaceHostCanaryAgent[];
}): WorkspaceHostInitializationAdmission {
  const { desired } = input;
  const workload = hostedBringUpWorkload(desired);
  const generation = 1;
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    hostId: desired.hostId,
    operationId: input.operationId,
    requestedAt: input.requestedAt,
    source: { kind: 'empty' },
    credentialRefs: {
      cloudCredentialRef: {
        kind: 'cloud',
        ref: buildWorkspaceHostCredentialReference('cloud-workload-identity', workload),
      },
    },
    credentialDelivery: {
      cloud: {
        kind: 'provider-identity',
        generation,
        audience: desired.hostId,
        revocationRef: buildWorkspaceHostCredentialRevocationReference('cloud-workload-identity', workload, generation),
      },
    },
    requestedAgents: [...input.requestedAgents],
  };
}

/**
 * Mark the customer workspace usable. Only `provisioning` moves; a workspace that was suspended,
 * offboarded or deleted while its machine was being set up keeps that state, and one already
 * `active` (a replay) is left alone. Returns the state the row ends in.
 */
export async function activateHostedCustomerWorkspace(input: {
  controlPlaneWorkspaceId: string;
  customerWorkspaceId: string;
  hostId: string;
}): Promise<{ state: string }> {
  return withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
    await query`
      UPDATE harness_shared.customer_workspaces
         SET state = 'active', updated_at = now()
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
         AND workspace_host_id = ${input.hostId}
         AND state = 'provisioning'
    `;
    const rows = await query<Array<{ state: string; workspace_host_id: string }>>`
      SELECT state, workspace_host_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
    `;
    const row = rows[0];
    if (!row || row.workspace_host_id !== input.hostId) {
      throw new Error(
        `customer workspace ${input.customerWorkspaceId} is not bound to host ${input.hostId}`,
      );
    }
    return { state: row.state };
  });
}

/**
 * The connector's route label: the host id, which is unique and already a DNS label. A name the
 * customer typed would collide across organizations and change when renamed.
 */
export function hostedConnectorRouteLabel(hostId: string): string {
  const label = hostId.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new Error(`host id ${hostId} is not usable as a connector route label`);
  }
  return label;
}

/**
 * D-407: the customer workspace a host was brought up for, read from its unrevoked connector
 * enrollment -- the persisted proof that the host carries a hosted bring-up. Only the bring-up
 * enrolls connectors, so a caller never has to say it.
 *
 * aws-byoc-gcp-parity D-016 (c): a portal host whose provision succeeded but whose bring-up never
 * completed has no connector yet, so it falls back to its `customer_workspaces` binding -- but only
 * while that portal workspace is still 'provisioning'. That is the one state in which the
 * empty-source initialize is safe: the workspace has never served, so there is nothing for it to
 * overwrite. This is what lets `repair` recover such a host; without it the workspace stays
 * 'provisioning' forever (measured on host-0f9b1ba8db30d143becc130a). A desktop/local BYOC host has
 * neither binding and returns null.
 */
export async function readHostedBringUpBinding(input: {
  controlPlaneWorkspaceId: string;
  hostId: string;
}): Promise<{ customerWorkspaceId: string } | null> {
  const enrolled = await withHostedServiceContext(async (sql) => {
    const rows = await sql<Array<{ customer_workspace_id: string }>>`
      SELECT DISTINCT customer_workspace_id
        FROM papercusp_auth.hosted_workspace_connectors
       WHERE control_workspace_id = ${input.controlPlaneWorkspaceId}
         AND host_id = ${input.hostId}
         AND revoked_at IS NULL
    `;
    if (rows.length > 1) {
      throw new Error(`host ${input.hostId} holds live connectors for ${rows.length} customer workspaces`);
    }
    return rows[0] ? { customerWorkspaceId: rows[0].customer_workspace_id } : null;
  });
  if (enrolled) return enrolled;

  const pending = await withWorkspace(input.controlPlaneWorkspaceId, async (query) =>
    query<Array<{ id: string }>>`
      SELECT id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND workspace_host_id = ${input.hostId}
         AND kind = 'hosted'
         AND state = 'provisioning'
       ORDER BY id
       LIMIT 2
    `,
  );
  if (pending.length > 1) {
    throw new Error(`host ${input.hostId} is bound to ${pending.length} provisioning customer workspaces`);
  }
  return pending[0] ? { customerWorkspaceId: pending[0].id } : null;
}

export async function revokeHostedWorkspaceConnectorsForDestroyedHost(input: {
  controlPlaneWorkspaceId: string;
  hostId: string;
}): Promise<void> {
  const bindings = await withHostedServiceContext((sql) => sql<Array<{
    control_workspace_id: string;
    organization_id: string;
    customer_workspace_id: string;
    host_id: string;
    route_label: string;
  }>>`
    SELECT control_workspace_id, organization_id, customer_workspace_id, host_id, route_label
      FROM papercusp_auth.hosted_workspace_connectors
     WHERE control_workspace_id = ${input.controlPlaneWorkspaceId}
       AND host_id = ${input.hostId}
       AND state <> 'revoked'
  `);
  if (bindings.length === 0) return;

  const gateway = new HostedWorkspaceConnectorGateway(
    new PostgresHostedWorkspaceConnectorStore(withHostedServiceContext),
  );
  for (const binding of bindings) {
    await gateway.revoke({
      controlPlaneWorkspaceId: binding.control_workspace_id,
      organizationId: binding.organization_id,
      customerWorkspaceId: binding.customer_workspace_id,
      hostId: binding.host_id,
      routeLabel: binding.route_label,
    });
  }
}

/**
 * Complete the customer-workspace half of host offboarding after provider destroy has
 * produced terminal absence evidence. Soft deletion frees the organization's live-workspace
 * slot while keeping the audit identity. Connector credentials are revoked first; both
 * operations are replay-safe if the durable workflow retries.
 */
export async function retireHostedCustomerWorkspaceAfterDestroy(
  input: { controlPlaneWorkspaceId: string; hostId: string },
  dependencies: {
    revokeConnectors?: (input: { controlPlaneWorkspaceId: string; hostId: string }) => Promise<void>;
  } = {},
): Promise<{ customerWorkspaceId: string } | null> {
  const bindings = await withWorkspace(input.controlPlaneWorkspaceId, async (query) =>
    query<Array<{
      id: string;
      state: string;
      desired_state: string;
      observed_state: string;
    }>>`
      SELECT customer.id, customer.state, host.desired_state, host.observed_state
        FROM harness_shared.customer_workspaces customer
        JOIN harness_shared.workspace_hosts host
          ON host.workspace_id = customer.workspace_id
         AND host.id = customer.workspace_host_id
       WHERE customer.workspace_id = ${input.controlPlaneWorkspaceId}
         AND customer.workspace_host_id = ${input.hostId}
       ORDER BY customer.id
       LIMIT 2
    `,
  );
  if (bindings.length === 0) return null;
  if (bindings.length > 1) {
    throw new Error(`host ${input.hostId} is bound to multiple customer workspaces`);
  }

  const binding = bindings[0]!;
  if (binding.desired_state !== 'absent' || binding.observed_state !== 'absent') {
    throw new Error(
      `customer workspace ${binding.id} cannot be deleted before host ${input.hostId} is terminally absent ` +
        `(desired=${binding.desired_state}, observed=${binding.observed_state})`,
    );
  }

  await (dependencies.revokeConnectors ?? revokeHostedWorkspaceConnectorsForDestroyedHost)(input);

  const updated = await withWorkspace(input.controlPlaneWorkspaceId, async (query) =>
    query<Array<{ id: string }>>`
      UPDATE harness_shared.customer_workspaces AS customer
         SET state = 'deleted',
             deleted_at = COALESCE(customer.deleted_at, now()),
             updated_at = now()
        FROM harness_shared.workspace_hosts AS host
       WHERE customer.workspace_id = ${input.controlPlaneWorkspaceId}
         AND customer.id = ${binding.id}
         AND customer.workspace_host_id = ${input.hostId}
         AND customer.state <> 'deleted'
         AND host.workspace_id = ${input.controlPlaneWorkspaceId}
         AND host.id = ${input.hostId}
         AND host.desired_state = 'absent'
         AND host.observed_state = 'absent'
      RETURNING customer.id
    `,
  );
  if (updated[0]) return { customerWorkspaceId: updated[0].id };

  const current = await withWorkspace(input.controlPlaneWorkspaceId, async (query) =>
    query<Array<{ id: string; state: string; desired_state: string; observed_state: string }>>`
      SELECT customer.id, customer.state, host.desired_state, host.observed_state
        FROM harness_shared.customer_workspaces customer
        JOIN harness_shared.workspace_hosts host
          ON host.workspace_id = customer.workspace_id
         AND host.id = customer.workspace_host_id
       WHERE customer.workspace_id = ${input.controlPlaneWorkspaceId}
         AND customer.id = ${binding.id}
         AND customer.workspace_host_id = ${input.hostId}
       LIMIT 1
    `,
  );
  const row = current[0];
  if (row?.state === 'deleted' && row.desired_state === 'absent' && row.observed_state === 'absent') {
    return { customerWorkspaceId: row.id };
  }
  throw new Error(`customer workspace ${binding.id} could not be retired after host ${input.hostId} destroy`);
}

export interface HostedConnectorEnrollmentDependencies {
  readOrganizationId(input: { controlPlaneWorkspaceId: string; customerWorkspaceId: string; hostId: string }): Promise<string>;
  gateway: Pick<HostedWorkspaceConnectorGateway, 'enroll'>;
  /** Deliver the ticket to the host's enrollment conduit; resolves with the generation it registered. */
  deliverTicket(input: { workspaceId: string; hostId: string; ticket: string }): Promise<{ generation: number }>;
  beginOperation: typeof beginWorkspaceHostOperation;
  updateOperation: typeof updateWorkspaceHostOperation;
  appendEvent: typeof appendWorkspaceHostEvent;
  /** Publish the connector on the host's tunnel status, where the desktop surface reads it. */
  recordSignals: typeof recordWorkspaceHostSignals;
}

async function readBoundOrganizationId(input: {
  controlPlaneWorkspaceId: string;
  customerWorkspaceId: string;
  hostId: string;
}): Promise<string> {
  return withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
    const rows = await query<Array<{ organization_id: string }>>`
      SELECT organization_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
         AND workspace_host_id = ${input.hostId}
    `;
    const organizationId = rows[0]?.organization_id;
    if (!organizationId) {
      throw new Error(`customer workspace ${input.customerWorkspaceId} is not bound to host ${input.hostId}`);
    }
    return organizationId;
  });
}

function defaultConnectorEnrollmentDependencies(): HostedConnectorEnrollmentDependencies {
  return {
    readOrganizationId: readBoundOrganizationId,
    gateway: new HostedWorkspaceConnectorGateway(new PostgresHostedWorkspaceConnectorStore(withHostedServiceContext)),
    async deliverTicket({ workspaceId, hostId, ticket }) {
      const { transport } = await resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId,
        hostId,
        controller: resolveWorkspaceHostInitializationControllerProfile(),
      });
      return enrollGcpIapWorkspaceHostConnector(transport, ticket);
    },
    beginOperation: beginWorkspaceHostOperation,
    updateOperation: updateWorkspaceHostOperation,
    appendEvent: appendWorkspaceHostEvent,
    recordSignals: recordWorkspaceHostSignals,
  };
}

/**
 * D-403: connect the machine's desktop to Papercusp. Enroll a connector for (organization,
 * customer workspace, host), hand the single-use ticket to the host, and require the host to
 * report registering the SAME generation.
 *
 * Returns only public facts. It runs as one durable step, and a step's return value is persisted,
 * so the ticket must never be part of it. A retry enrolls again: the store bumps the generation,
 * which invalidates any ticket or bearer from the failed attempt.
 */
export async function enrollHostedWorkspaceConnector(
  input: { controlPlaneWorkspaceId: string; customerWorkspaceId: string; hostId: string; operationId: string },
  dependencies: HostedConnectorEnrollmentDependencies = defaultConnectorEnrollmentDependencies(),
): Promise<{ generation: number; routeLabel: string }> {
  const { controlPlaneWorkspaceId: workspaceId, hostId, operationId } = input;
  await dependencies.beginOperation({
    workspaceId,
    hostId,
    operationId,
    action: 'initialize',
    status: 'running',
    message: 'Connecting the workspace desktop to Papercusp',
    request: { hostId, customerWorkspaceId: input.customerWorkspaceId, stage: 'connector' },
  });
  try {
    const routeLabel = hostedConnectorRouteLabel(hostId);
    const organizationId = await dependencies.readOrganizationId(input);
    const enrollment = await dependencies.gateway.enroll({
      controlPlaneWorkspaceId: workspaceId,
      organizationId,
      customerWorkspaceId: input.customerWorkspaceId,
      hostId,
      routeLabel,
      transport: 'websocket',
    });
    const registered = await dependencies.deliverTicket({ workspaceId, hostId, ticket: enrollment.ticket });
    if (registered.generation !== enrollment.binding.generation) {
      throw new Error(
        `host ${hostId} registered connector generation ${registered.generation}, but generation ` +
          `${enrollment.binding.generation} was enrolled`,
      );
    }
    // The shape `readHostedWorkspaceConnector` (cloud-workspaces) reads: without it the desktop
    // surface has no route label and cannot mint a viewer ticket.
    await dependencies.recordSignals({
      workspaceId,
      hostId,
      tunnelStatus: { hostedConnector: { routeLabel, transport: 'websocket', generation: registered.generation } },
    });
    await dependencies.appendEvent({
      workspaceId,
      hostId,
      operationId,
      phase: 'connector:registered',
      status: 'succeeded',
      level: 'info',
      source: 'controller',
      message: 'Workspace desktop connected to Papercusp',
      details: { generation: registered.generation, routeLabel },
    });
    await dependencies.updateOperation({
      workspaceId,
      operationId,
      status: 'succeeded',
      percent: 100,
      message: 'Workspace desktop connected to Papercusp',
    });
    return { generation: registered.generation, routeLabel };
  } catch (error) {
    await dependencies
      .updateOperation({
        workspaceId,
        operationId,
        status: 'failed',
        percent: 100,
        message: 'Could not connect the workspace desktop to Papercusp',
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
