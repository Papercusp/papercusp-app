/**
 * Enqueue a workspace-host provision from a process that does NOT run DBOS.
 *
 * WHY (plan byoc-cloud-workspaces-gcp-aws-azure-2026-08-22, WI-10002240). The hosted control
 * plane (`serve.ts` under the hosted-control-plane profile) is request-only: it never runs
 * host-bootstrap, so `startDbos()` never runs there and `DBOS.startWorkflow` is unavailable.
 * The provisioning EXECUTOR already exists — the DBOS primary (the bg-host) drains the
 * `workspace-host-provision` queue — so the hosted process only needs to put the workflow on
 * that queue. A DBOS client does exactly that against the system database, without
 * launching an executor, recovering workflows, or registering anything.
 *
 * THE APP VERSION IS PINNED, NEVER LEFT NULL. The executor dequeues rows whose
 * `application_version` equals its own OR IS NULL, so a NULL-version row is claimable by ANY
 * DBOS host that registers this queue — including a staging host running different code
 * (the EI-90 appVersion war). The caller names the primary's version explicitly.
 *
 * The request (workflow id, dedup key, input) comes from
 * {@link workspaceHostProvisioningEnqueueRequest}, the same builder the in-process start
 * uses, so a client-enqueued provision is the same durable workflow as an in-process one.
 */
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { withDbosIdleTxGrace } from './bootstrap';
import {
  WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
  workspaceHostDestroyEnqueueRequest,
  workspaceHostLifecycleEnqueueRequest,
  workspaceHostProvisioningEnqueueRequest,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
  type StartWorkspaceHostProvisioningInput,
} from './workspace-host-provision-workflow';

/** The subset of `DBOSClient` this module drives — the seam tests replace. */
export interface WorkspaceHostProvisioningDbosClient {
  enqueue(
    options: {
      queueName: string;
      workflowName: string;
      workflowID: string;
      deduplicationID: string;
      appVersion: string;
    },
    input: unknown,
  ): Promise<{ workflowID: string }>;
}

export interface WorkspaceHostProvisioningEnqueuer {
  /** Resolves once the workflow is durably ENQUEUED — not when provisioning finishes. */
  enqueue(input: StartWorkspaceHostProvisioningInput): Promise<{ workflowId: string }>;
}

/**
 * Lifecycle actions and destroy for an EXISTING host, enqueued the same way (WI-10005363). Without
 * it the hosted action route forwards the raw browser body to the controller's loopback route,
 * which drops every server-derived field (the actor) and answers a false 504 while the controller
 * waits out its admission window.
 */
export interface WorkspaceHostOperationEnqueuer {
  enqueueLifecycle(input: StartWorkspaceHostLifecycleInput): Promise<{ workflowId: string; operationId: string }>;
  enqueueDestroy(input: StartWorkspaceHostDestroyInput): Promise<{ workflowId: string; operationId: string }>;
}

export interface WorkspaceHostProvisioningClientOptions {
  readonly systemDatabaseUrl: string;
  /** The DBOS primary's `applicationVersion` (its `DBOS__APPVERSION`). Required. */
  readonly appVersion: string;
  readonly createClient?: (systemDatabaseUrl: string) => Promise<WorkspaceHostProvisioningDbosClient>;
}

async function createDbosClient(systemDatabaseUrl: string): Promise<WorkspaceHostProvisioningDbosClient> {
  // Same system database and schema the executor launched with (dbos/bootstrap.ts).
  return DBOSClient.create({
    systemDatabaseUrl: withDbosIdleTxGrace(systemDatabaseUrl),
    systemDatabaseSchemaName: 'dbos',
  }) as Promise<WorkspaceHostProvisioningDbosClient>;
}

export function createWorkspaceHostProvisioningClient(
  options: WorkspaceHostProvisioningClientOptions,
): WorkspaceHostProvisioningEnqueuer & WorkspaceHostOperationEnqueuer {
  const appVersion = options.appVersion.trim();
  if (!appVersion) throw new Error('workspace_host_provisioning_client_app_version_required');
  if (!options.systemDatabaseUrl.trim()) {
    throw new Error('workspace_host_provisioning_client_system_database_required');
  }
  const create = options.createClient ?? createDbosClient;
  let client: Promise<WorkspaceHostProvisioningDbosClient> | null = null;
  const connected = () => {
    // One pool per process, opened on first use; a failed open is retried next call.
    client ??= create(options.systemDatabaseUrl).catch((error: unknown) => {
      client = null;
      throw error;
    });
    return client;
  };

  // Every action is the one workspace-host workflow on its one queue; only the request differs.
  const enqueueRequest = async (request: { workflowId: string; deduplicationId: string; workflowInput: unknown }) => {
    const handle = await (await connected()).enqueue(
      {
        queueName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
        workflowName: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
        workflowID: request.workflowId,
        deduplicationID: request.deduplicationId,
        appVersion,
      },
      request.workflowInput,
    );
    return handle.workflowID;
  };

  return {
    async enqueue(input) {
      return { workflowId: await enqueueRequest(workspaceHostProvisioningEnqueueRequest(input)) };
    },
    async enqueueLifecycle(input) {
      const request = workspaceHostLifecycleEnqueueRequest(input);
      return { workflowId: await enqueueRequest(request), operationId: request.workflowInput.operationId };
    },
    async enqueueDestroy(input) {
      const request = workspaceHostDestroyEnqueueRequest(input);
      return { workflowId: await enqueueRequest(request), operationId: request.workflowInput.operationId };
    },
  };
}
