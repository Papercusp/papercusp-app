/**
 * Host-scoped DBOS admission for workspace-host provisioning (D-100).
 *
 * The runner is operation-replay-safe; this workflow adds the missing cross-operation mutex. A
 * stable workflow id resumes one operation, while the host-scoped deduplication id prevents two
 * different operation ids from mutating the same resource graph concurrently.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  resolveWorkspaceHostProvider,
  workspaceHostActionInvalidatesInitialization,
  workspaceHostWorkflowKeys,
  type WorkspaceHostDesiredSpec,
  type WorkspaceHostProviderConnection,
} from '@papercusp/deployment-driver';
import {
  executeAdmittedWorkspaceHostInitialization,
  executeAdmittedWorkspaceHostDesktopPack,
  prepareWorkspaceHostInitialization,
  type AdmittedWorkspaceHostInitialization,
  type WorkspaceHostDesktopPackRequest,
} from '../workspace-host/initialization-admission';
import {
  activateHostedCustomerWorkspace,
  enrollHostedWorkspaceConnector,
  hostedBringUpInitialization,
  PAPERCUSP_HOSTED_BRING_UP_AGENTS,
  readHostedBringUpBinding,
  retireHostedCustomerWorkspaceAfterDestroy,
  workspaceHostBringUpOperationIds,
  type WorkspaceHostBringUp,
} from '../workspace-host/hosted-bring-up';
import {
  runWorkspaceHostDestroy,
  runWorkspaceHostProvisioning,
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  WorkspaceHostProvisioningTransientError,
  type WorkspaceHostDestroyCanaryEvidence,
  type WorkspaceHostCanaryAdmission,
  type WorkspaceHostDestroyResult,
  type WorkspaceHostProvisioningResult,
} from '../workspace-host/provisioning-runner';
import {
  runWorkspaceHostLifecycle,
  validateWorkspaceHostLifecycleRequest,
  type RunWorkspaceHostLifecycleInput,
} from '../workspace-host/lifecycle-runner';
import {
  readWorkspaceHostDestroyTarget,
  recordWorkspaceHostOperationTerminalFailure,
  WorkspaceHostControllerFenceError,
} from '../workspace-host/observability-store';
import {
  WORKSPACE_HOST_ADMISSION_WINDOW_MS,
  type WorkspaceHostOperationAcceptance,
} from '../workspace-host/admission-window';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

const QUEUE_DEDUP_DUPLICATED_CODE = 28;
const MAX_WORKFLOW_TURNS = 1_800;
const DEFAULT_RETRY_AFTER_MS = 2_000;

export interface StartWorkspaceHostProvisioningInput {
  workspaceId: string;
  connectionId: string;
  name: string;
  desired: WorkspaceHostDesiredSpec;
  connection: WorkspaceHostProviderConnection;
  canary?: WorkspaceHostCanaryAdmission;
  operationId?: string;
  actorId?: string;
  /**
   * D-401: set up the machine once it is built (initialize -> desktop pack -> workspace active).
   * Only the hosted doors set this: first-workspace for every GCP host, and the hosted provision
   * route for a host whose customer workspace is still 'provisioning' (aws-byoc-gcp-parity
   * D-015); see `hosted-bring-up.ts`.
   */
  bringUp?: WorkspaceHostBringUp;
}

export interface StartWorkspaceHostDestroyInput {
  workspaceId: string;
  hostId: string;
  connectionId: string;
  connection: WorkspaceHostProviderConnection;
  disposition: 'snapshot' | 'backup' | 'discard';
  confirmation: {
    expectedHostId: string;
    confirmedBy: string;
    confirmedAt: string;
  };
  /** Present only for the canary wrapper; ordinary customer teardown does not manufacture it. */
  canary?: WorkspaceHostDestroyCanaryEvidence;
  /** Record the terminal census on this release's journal (`teardown.resource-census`, WI-10002510). */
  releaseTaskId?: string;
  operationId?: string;
  actorId?: string;
}

export type StartWorkspaceHostLifecycleInput = Omit<
  RunWorkspaceHostLifecycleInput,
  'provider' | 'store' | 'signal'
>;

type WorkspaceHostProvisioningWorkflowInput = StartWorkspaceHostProvisioningInput & {
  action: 'provision';
  operationId: string;
};

type WorkspaceHostDestroyWorkflowInput = StartWorkspaceHostDestroyInput & {
  action: 'destroy';
  operationId: string;
};

type WorkspaceHostLifecycleWorkflowInput = StartWorkspaceHostLifecycleInput & {
  operationId: string;
};

type WorkspaceHostWorkflowInput =
  | WorkspaceHostProvisioningWorkflowInput
  | WorkspaceHostDestroyWorkflowInput
  | WorkspaceHostLifecycleWorkflowInput
  | (AdmittedWorkspaceHostInitialization & { action: 'initialize' })
  | WorkspaceHostDesktopPackRequest;

type WorkspaceHostWorkflowResult =
  | (WorkspaceHostProvisioningResult & {
      offboardedCustomerWorkspaceId?: string;
      alreadyAbsent?: boolean;
    })
  | {
      status: 'succeeded';
      operationId: string;
      hostId: string;
      alreadyAbsent?: boolean;
      offboardedCustomerWorkspaceId?: string;
    };

export type WorkspaceHostDestroyWorkflowResult =
  | (WorkspaceHostDestroyResult & { offboardedCustomerWorkspaceId?: string })
  | {
      status: 'succeeded';
      operationId: string;
      hostId: string;
      alreadyAbsent: true;
      offboardedCustomerWorkspaceId?: string;
    };

export type WorkspaceHostProvisioningExecutor = (
  input: WorkspaceHostWorkflowInput,
) => Promise<WorkspaceHostWorkflowResult>;

interface WorkflowHooks {
  executor?: WorkspaceHostProvisioningExecutor;
}

function hooks(): WorkflowHooks {
  const root = globalThis as typeof globalThis & {
    __papercuspWorkspaceHostProvisioningHooks__?: WorkflowHooks;
  };
  return (root.__papercuspWorkspaceHostProvisioningHooks__ ??= {});
}

export function setWorkspaceHostProvisioningExecutor(executor: WorkspaceHostProvisioningExecutor | null): void {
  if (executor) hooks().executor = executor;
  else delete hooks().executor;
}

/**
 * WI-10001739 link 1: a control-plane fence error must not spend the PROVIDER-NETWORK retry budget.
 *
 * `DBOS.runStep` below has a single `maxAttempts: 3`. A WorkspaceHostControllerFenceError is not a
 * provider failure at all, but it was being retried out of that same budget — measured 2026-09-17,
 * a destroy spent attempts 1 and 2 on fence errors and had exactly one left when it finally reached
 * the provider and hit a genuinely transient network error.
 *
 * Absorbing the fence here, INSIDE one step, is what makes the budgets separate: DBOS sees a single
 * step invocation, so this is replay-safe (no cross-step mutable counter to diverge on replay), and
 * the step's 3 attempts stay reserved for provider errors.
 *
 * A GENUINE supersede is unaffected: a newer operation holds the host permanently, so every attempt
 * here fails and the error is rethrown — bounded, never a spin. The window is sized off a single
 * observation (that fence cleared on its own within ~16s), which is why it is deliberately generous:
 * over-waiting on a transient race costs seconds, under-waiting costs the whole operation.
 */
const FENCE_RETRY_ATTEMPTS = 5;
const FENCE_RETRY_BASE_MS = 2_000;

async function executeToleratingControllerFence(
  input: WorkspaceHostWorkflowInput,
): Promise<WorkspaceHostWorkflowResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await execute(input);
    } catch (error) {
      // Matched by NAME, not instanceof, deliberately: this codebase already carries a rehydration
      // path for typed errors "after DBOS serialization erases their prototypes", so an instanceof
      // check here would silently stop matching the moment the error crosses that boundary.
      const isFence =
        error instanceof Error && error.name === 'WorkspaceHostControllerFenceError';
      if (!isFence || attempt >= FENCE_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, FENCE_RETRY_BASE_MS * attempt));
    }
  }
}

async function execute(input: WorkspaceHostWorkflowInput): Promise<WorkspaceHostWorkflowResult> {
  const injected = hooks().executor;
  if (injected) return injected(input);
  if (input.action === 'initialize') return executeAdmittedWorkspaceHostInitialization(input);
  if (input.action === 'install-desktop-pack') return executeAdmittedWorkspaceHostDesktopPack(input);
  const provider = resolveWorkspaceHostProvider(input.connection);
  if (input.action === 'destroy') {
    try {
      return await runWorkspaceHostDestroy({ ...input, provider });
    } catch (error) {
      // A prior destroy may already have persisted terminal absence while its customer
      // workspace update was interrupted. Re-enter offboarding from that exact condition;
      // the following workflow step rechecks host state before changing the customer row.
      if (
        error instanceof WorkspaceHostProvisioningRequestError &&
        error.problems.includes('workspace host is already absent')
      ) {
        return {
          status: 'succeeded',
          operationId: input.operationId,
          hostId: input.hostId,
          alreadyAbsent: true,
        };
      }
      throw error;
    }
  }
  if (input.action !== 'provision') {
    return runWorkspaceHostLifecycle({ ...input, provider });
  }
  return runWorkspaceHostProvisioning({
    ...input,
    provider,
  });
}

async function workspaceHostProvisioningWorkflowImpl(
  input: WorkspaceHostWorkflowInput,
): Promise<WorkspaceHostWorkflowResult> {
  const result = await runWorkspaceHostOperation(input);
  if (input.action === 'provision' && input.bringUp && result.status === 'succeeded') {
    await bringUpWorkspaceHost(input, input.bringUp);
  }
  // The lifecycle runner marks successful upgrades, repairs, restores, and completed upgrade
  // rollbacks with this explicit host-readiness signal. A rollback is still a failed upgrade
  // operation, but it has recreated the host and needs the same hosted bring-up as a success.
  if (
    isExistingHostLifecycle(input) &&
    'requiresInitialization' in result &&
    result.requiresInitialization === true
  ) {
    await bringUpHostedHostAgain(input);
  }
  return result;
}

function isExistingHostLifecycle(input: WorkspaceHostWorkflowInput): input is WorkspaceHostLifecycleWorkflowInput {
  return (
    input.action !== 'provision' &&
    input.action !== 'destroy' &&
    input.action !== 'initialize' &&
    input.action !== 'install-desktop-pack'
  );
}

/**
 * D-407: an upgrade recreates the machine on a new boot disk and a repair re-runs its bootstrap,
 * so both invalidate what the bring-up installed -- the desktop pack and the connector's credential
 * with it. A host that was brought up for a Papercusp-hosted workspace (it holds a live connector
 * enrollment, which a portal BYOC host also holds since aws-byoc-gcp-parity D-015) is brought up
 * again under the same operation; a desktop/local BYOC host is left to its owner, as
 * before. `restore` builds a DIFFERENT host, which this does not cover.
 */
async function bringUpHostedHostAgain(input: WorkspaceHostLifecycleWorkflowInput): Promise<void> {
  if (input.action === 'restore' || !workspaceHostActionInvalidatesInitialization(input.action)) return;
  const binding = await DBOS.runStep(
    () => readHostedBringUpBinding({ controlPlaneWorkspaceId: input.workspaceId, hostId: input.hostId }),
    { name: 'workspace-host-bring-up-again-read-binding', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 },
  );
  if (!binding) return;
  const desired = await DBOS.runStep(
    async () => {
      const target = await readWorkspaceHostDestroyTarget(input.workspaceId, input.hostId);
      if (!target) throw new Error(`host ${input.hostId} has no recorded spec to bring up again`);
      return target.desired;
    },
    { name: 'workspace-host-bring-up-again-read-desired', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 },
  );
  await bringUpWorkspaceHost(
    { workspaceId: input.workspaceId, operationId: input.operationId, desired },
    { customerWorkspaceId: binding.customerWorkspaceId, requestedAgents: PAPERCUSP_HOSTED_BRING_UP_AGENTS },
  );
}

/**
 * D-401 bring-up, as further steps of the SAME workflow rather than new enqueues: this workflow
 * still holds the host's deduplication id, so a separate initialize enqueued from here would be
 * refused as "already has a provisioning operation in progress" (and one enqueued just after it
 * ends was measured refused for ~25s). Each stage keeps its own operation record, which is what
 * the portal shows as the host's progress, and a stage failure is recorded on that record.
 */
async function bringUpWorkspaceHost(
  input: Pick<WorkspaceHostProvisioningWorkflowInput, 'workspaceId' | 'operationId' | 'desired'>,
  bringUp: WorkspaceHostBringUp,
): Promise<void> {
  const hostId = input.desired.hostId;
  const operationIds = workspaceHostBringUpOperationIds(input.operationId);
  // Admission reads the host's recorded spec and stamps a time, so it is a step: a replay must
  // reuse the request it admitted, not build a new one.
  const initialization = await DBOS.runStep(
    () =>
      prepareWorkspaceHostInitialization(
        hostedBringUpInitialization({
          workspaceId: input.workspaceId,
          operationId: operationIds.initialize,
          requestedAt: new Date().toISOString(),
          desired: input.desired,
          requestedAgents: bringUp.requestedAgents,
        }),
      ),
    { name: 'workspace-host-bring-up-admit-initialize', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 },
  );
  await runWorkspaceHostOperation({ ...initialization, action: 'initialize' }, BRING_UP_STEP_RETRY);

  const desktopRequestedAt = await DBOS.runStep(async () => new Date().toISOString(), {
    name: 'workspace-host-bring-up-admit-desktop-pack',
  });
  await runWorkspaceHostOperation({
    workspaceId: input.workspaceId,
    hostId,
    operationId: operationIds.desktopPack,
    requestedAt: desktopRequestedAt,
    action: 'install-desktop-pack',
  }, BRING_UP_STEP_RETRY);

  // D-403: before `active`, so an active workspace is one whose desktop can be opened. One step
  // enrolls AND delivers, returning only { generation, routeLabel }: the ticket never becomes a
  // persisted step output.
  await DBOS.runStep(
    () =>
      enrollHostedWorkspaceConnector({
        controlPlaneWorkspaceId: input.workspaceId,
        customerWorkspaceId: bringUp.customerWorkspaceId,
        hostId,
        operationId: operationIds.connector,
      }),
    { name: 'workspace-host-bring-up-connector', retriesAllowed: true, ...BRING_UP_STEP_RETRY },
  );

  const activated = await DBOS.runStep(
    () =>
      activateHostedCustomerWorkspace({
        controlPlaneWorkspaceId: input.workspaceId,
        customerWorkspaceId: bringUp.customerWorkspaceId,
        hostId,
      }),
    { name: 'workspace-host-bring-up-activate', retriesAllowed: true, maxAttempts: 3, intervalSeconds: 2 },
  );
  if (activated.state !== 'active') {
    console.warn(
      `[workspace-host] host ${hostId} is set up, but customer workspace ${bringUp.customerWorkspaceId} is '${activated.state}'`,
    );
  }
}

/** How often one operation's step may be re-run on a retryable error. */
interface OperationStepRetry {
  maxAttempts: number;
  intervalSeconds: number;
  backoffRate?: number;
}

const OPERATION_STEP_RETRY: OperationStepRetry = { maxAttempts: 3, intervalSeconds: 2 };

/**
 * The bring-up stages run against a machine only minutes out of its first boot. Measured on
 * host-2f6a4b0c6dc222d8d20766ae (2026-09-23): the first local-inference check exited non-zero and
 * the retry two seconds later passed, so the default three quick attempts had one to spare. A
 * customer has no retry button for this chain, so it gets a wider, backed-off budget.
 */
const BRING_UP_STEP_RETRY: OperationStepRetry = { maxAttempts: 5, intervalSeconds: 10, backoffRate: 2 };

async function runWorkspaceHostOperation(
  input: WorkspaceHostWorkflowInput,
  retry: OperationStepRetry = OPERATION_STEP_RETRY,
): Promise<WorkspaceHostWorkflowResult> {
  try {
    if (input.action === 'restore') {
      const hostedBinding = await DBOS.runStep(
        () => readHostedBringUpBinding({ controlPlaneWorkspaceId: input.workspaceId, hostId: input.hostId }),
        {
          name: 'workspace-host-restore-check-hosted-binding',
          retriesAllowed: true,
          maxAttempts: 3,
          intervalSeconds: 2,
        },
      );
      if (hostedBinding) {
        const restoredHostId = input.desired?.hostId ?? '(unspecified)';
        throw new WorkspaceHostProvisioningRequestError([
          `Papercusp-hosted restore is refused before provider mutation: customer workspace ` +
            `'${hostedBinding.customerWorkspaceId}' remains bound to source host '${input.hostId}', while restore ` +
            `creates a distinct host '${restoredHostId}'. This workflow cannot move the ` +
            'customer workspace binding and connector credential.',
        ]);
      }
    }

    for (let turn = 0; turn < MAX_WORKFLOW_TURNS; turn += 1) {
      let result = await DBOS.runStep(() => executeToleratingControllerFence(input), {
        name: `workspace-host-${input.action}-${turn}`,
        retriesAllowed: true,
        ...retry,
        shouldRetry: (error) =>
          !(error instanceof WorkspaceHostProvisioningRequestError) &&
          !(error instanceof WorkspaceHostProvisioningConnectionError),
      });
      if (input.action === 'destroy' && result.status === 'succeeded') {
        const retired = await DBOS.runStep(
          () =>
            retireHostedCustomerWorkspaceAfterDestroy({
              controlPlaneWorkspaceId: input.workspaceId,
              hostId: input.hostId,
            }),
          {
            name: 'workspace-host-customer-workspace-offboarding',
            retriesAllowed: true,
            maxAttempts: 3,
            intervalSeconds: 2,
          },
        );
        if (retired) result = { ...result, offboardedCustomerWorkspaceId: retired.customerWorkspaceId };
      }
      if (result.status !== 'in-progress') return result;
      const retryAfterMs = Math.max(250, Math.min(30_000, result.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS));
      await DBOS.sleep(retryAfterMs);
    }
    throw new Error('Workspace-host provisioning exceeded its durable workflow turn budget');
  } catch (error) {
    // WI-10001739 link 2: a step that exhausts its retries throws straight out of this workflow.
    // Nothing downstream records that, so the operation row keeps its last-known status and a
    // stale updated_at — it looks ALIVE. ~20min later the hosted-lifecycle reconciler reaps it on
    // recency alone and writes a SYNTHESIZED hosted_lifecycle_recovery_exhausted, erasing the real
    // cause. Persist the true terminal cause here, at the only point that still has it.
    try {
      await DBOS.runStep(
        () =>
          recordWorkspaceHostOperationTerminalFailure({
            workspaceId: input.workspaceId,
            operationId: input.operationId,
            message: 'Workspace-host workflow failed',
            error,
          }),
        { name: `workspace-host-${input.action}-terminal-failure`, retriesAllowed: false },
      );
    } catch (recordError) {
      // The ORIGINAL error must always win: a failure to record must never mask what failed.
      console.error('[workspace-host] could not persist terminal failure', recordError);
    }
    throw error;
  }
}

/** Registered workflow name AND queue name — a DBOS client enqueues by these strings. */
export const WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME = 'workspace-host-provision';

export const workspaceHostProvisioningWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostProvisioningWorkflowImpl, {
    name: WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
    maxRecoveryAttempts: 20,
  }),
);

export const workspaceHostProvisioningQueue = idempotentWorkflowQueue(
  WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME,
  () => new WorkflowQueue(WORKSPACE_HOST_PROVISIONING_WORKFLOW_NAME, { concurrency: queueConcurrency(4) }),
);

/**
 * The exact enqueue request for one provision. Both the in-process start below and the
 * hosted control plane's DBOS client (`workspace-host-provision-client.ts`) build it here,
 * so a client-enqueued provision carries the same workflow id, dedup key and input as an
 * in-process one — and a replay of either collapses onto the same durable workflow.
 */
export function workspaceHostProvisioningEnqueueRequest(input: StartWorkspaceHostProvisioningInput): {
  workflowInput: WorkspaceHostProvisioningWorkflowInput;
  workflowId: string;
  deduplicationId: string;
} {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostProvisioningWorkflowInput = { ...input, action: 'provision', operationId };
  const keys = workspaceHostWorkflowKeys({
    workspaceId: input.workspaceId,
    hostId: input.desired.hostId,
    operationId,
  });
  return { workflowInput, workflowId: keys.workflowId, deduplicationId: keys.deduplicationId };
}

/**
 * The durable enqueue request for a lifecycle action on an existing host (stop, start, snapshot,
 * repair, upgrade, restore, ...). Shared by the in-process start and the DBOS client, exactly as
 * {@link workspaceHostProvisioningEnqueueRequest} is for provision, so a hosted action enqueued
 * from a process without DBOS is the same workflow, with the same keys, as an in-process one.
 * Request-shape errors throw here, before anything is enqueued.
 */
export function workspaceHostLifecycleEnqueueRequest(input: StartWorkspaceHostLifecycleInput): {
  workflowInput: WorkspaceHostLifecycleWorkflowInput;
  workflowId: string;
  deduplicationId: string;
} {
  validateWorkspaceHostLifecycleRequest(input);
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostLifecycleWorkflowInput = { ...input, operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  return { workflowInput, workflowId: keys.workflowId, deduplicationId: keys.deduplicationId };
}

/** The durable enqueue request for a destroy; see {@link workspaceHostLifecycleEnqueueRequest}. */
export function workspaceHostDestroyEnqueueRequest(input: StartWorkspaceHostDestroyInput): {
  workflowInput: WorkspaceHostDestroyWorkflowInput;
  workflowId: string;
  deduplicationId: string;
} {
  const operationId = input.operationId ?? randomUUID();
  const workflowInput: WorkspaceHostDestroyWorkflowInput = { ...input, action: 'destroy', operationId };
  const keys = workspaceHostWorkflowKeys({ workspaceId: input.workspaceId, hostId: input.hostId, operationId });
  return { workflowInput, workflowId: keys.workflowId, deduplicationId: keys.deduplicationId };
}

export class WorkspaceHostProvisioningConflictError extends Error {
  constructor(readonly hostId: string) {
    super(`Workspace host '${hostId}' already has a provisioning operation in progress`);
    this.name = 'WorkspaceHostProvisioningConflictError';
  }
}

export function isWorkspaceHostProvisioningDedupConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { dbosErrorCode?: number }).dbosErrorCode === QUEUE_DEDUP_DUPLICATED_CODE
  );
}

function serializedProvisioningProblems(error: unknown, expectedName: string): readonly string[] | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; problems?: unknown };
  if (candidate.name !== expectedName || !Array.isArray(candidate.problems) || candidate.problems.length === 0) {
    return null;
  }
  if (!candidate.problems.every((problem) => typeof problem === 'string' && problem.length > 0)) return null;
  return candidate.problems;
}

/**
 * WI-10005474: a request reusing the operationId of a workflow that already ended in a fence
 * refusal (WI-10005312) re-admits that SAME workflow, so `getResult` rethrows its stored error at
 * once. Only the validated shape (fence name + non-empty host id) is restored.
 */
function serializedControllerFenceHostId(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { name?: unknown; hostId?: unknown };
  if (candidate.name !== 'WorkspaceHostControllerFenceError') return null;
  return typeof candidate.hostId === 'string' && candidate.hostId.length > 0 ? candidate.hostId : null;
}

function rehydrateWorkspaceHostProvisioningError(error: unknown): unknown {
  if (
    error instanceof WorkspaceHostProvisioningRequestError ||
    error instanceof WorkspaceHostProvisioningConnectionError ||
    error instanceof WorkspaceHostProvisioningTransientError ||
    error instanceof WorkspaceHostControllerFenceError
  ) {
    return error;
  }

  const fenceHostId = serializedControllerFenceHostId(error);
  if (fenceHostId) return new WorkspaceHostControllerFenceError(fenceHostId);

  const requestProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningRequestError');
  if (requestProblems) return new WorkspaceHostProvisioningRequestError(requestProblems);

  const connectionProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningConnectionError');
  if (connectionProblems) return new WorkspaceHostProvisioningConnectionError(connectionProblems);

  const transientProblems = serializedProvisioningProblems(error, 'WorkspaceHostProvisioningTransientError');
  if (transientProblems) return new WorkspaceHostProvisioningTransientError(transientProblems);

  return error;
}

/**
 * Wait at most the admission window for a durably-enqueued workflow (EI-23712230399040759).
 * `DBOS.getResult` rethrows the workflow's own failure, so a fast typed refusal still reaches
 * the route's typed mapping; `null` means the workflow is queued or running and the caller
 * answers 202 instead of holding the request open for minutes.
 */
async function settleWithinAdmissionWindow<T>(
  workflowId: string,
  accepted: WorkspaceHostOperationAcceptance,
): Promise<T | WorkspaceHostOperationAcceptance> {
  const settled = await DBOS.getResult<T>(workflowId, {
    timeoutSeconds: WORKSPACE_HOST_ADMISSION_WINDOW_MS / 1_000,
  });
  return settled ?? accepted;
}

export function isWorkspaceHostOperationAcceptance(value: unknown): value is WorkspaceHostOperationAcceptance {
  return typeof value === 'object' && value !== null && (value as { status?: unknown }).status === 'accepted';
}

export async function startWorkspaceHostProvisioningWorkflow(
  input: StartWorkspaceHostProvisioningInput,
): Promise<WorkspaceHostProvisioningResult | WorkspaceHostOperationAcceptance> {
  const request = workspaceHostProvisioningEnqueueRequest(input);
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: request.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: request.deduplicationId },
    })(request.workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostProvisioningResult>(request.workflowId, {
      status: 'accepted',
      operationId: request.workflowInput.operationId,
      hostId: input.desired.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.desired.hostId);
    }
    // DBOS serializes workflow errors through serialize-error. That preserves
    // name + enumerable fields, but deliberately rebuilds a plain Error and
    // therefore erases the custom prototype that the route uses for typed HTTP
    // mapping. Rehydrate only the validated typed shapes at this durable
    // boundary; unrelated errors retain their original identity.
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export async function startWorkspaceHostDestroyWorkflow(
  input: StartWorkspaceHostDestroyInput,
): Promise<WorkspaceHostDestroyWorkflowResult | WorkspaceHostOperationAcceptance> {
  const request = workspaceHostDestroyEnqueueRequest(input);
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: request.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: request.deduplicationId },
    })(request.workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostDestroyWorkflowResult>(request.workflowId, {
      status: 'accepted',
      operationId: request.workflowInput.operationId,
      hostId: input.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

export async function startWorkspaceHostLifecycleWorkflow(
  input: StartWorkspaceHostLifecycleInput,
): Promise<WorkspaceHostProvisioningResult | WorkspaceHostOperationAcceptance> {
  // Reject request-shape errors before DBOS binds the operationId to a workflow result. A corrected
  // retry with the same ID must remain admissible after an invalid request.
  const request = workspaceHostLifecycleEnqueueRequest(input);
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: request.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: request.deduplicationId },
    })(request.workflowInput);
    return await settleWithinAdmissionWindow<WorkspaceHostProvisioningResult>(request.workflowId, {
      status: 'accepted',
      operationId: request.workflowInput.operationId,
      hostId: input.hostId,
    });
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
}

/**
 * Durably enqueue a lifecycle operation and return at once, without waiting out the admission
 * window. For a caller that is itself a DBOS workflow (the standing-health pass restarting a
 * reclaimed spot host, WI-10005210): it must start the child at the workflow layer and must not
 * block on the child's result. A host another operation already holds raises
 * `WorkspaceHostProvisioningConflictError`, exactly as the admitting route does.
 */
export async function enqueueWorkspaceHostLifecycleWorkflow(
  input: StartWorkspaceHostLifecycleInput & { operationId: string },
): Promise<WorkspaceHostOperationAcceptance> {
  validateWorkspaceHostLifecycleRequest(input);
  const workflowInput: WorkspaceHostLifecycleWorkflowInput = input;
  const keys = workspaceHostWorkflowKeys({
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    operationId: input.operationId,
  });
  try {
    await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw rehydrateWorkspaceHostProvisioningError(error);
  }
  return { status: 'accepted', operationId: input.operationId, hostId: input.hostId };
}

export class WorkspaceHostOperationIdentityConflictError extends Error {
  constructor() {
    super('Workspace-host operation ID is already bound to a different request');
    this.name = 'WorkspaceHostOperationIdentityConflictError';
  }
}

/** Return once DBOS has durably enqueued, never await the remote result at an HTTP boundary. */
export async function startWorkspaceHostInitializationWorkflow(request: AdmittedWorkspaceHostInitialization) {
  return startWorkspaceHostRemoteOperation({ ...request, action: 'initialize' });
}

export async function startWorkspaceHostDesktopPackWorkflow(request: WorkspaceHostDesktopPackRequest) {
  return startWorkspaceHostRemoteOperation(request);
}

async function startWorkspaceHostRemoteOperation(input: (AdmittedWorkspaceHostInitialization & { action: 'initialize' }) | WorkspaceHostDesktopPackRequest) {
  const keys = workspaceHostWorkflowKeys(input);
  try {
    const handle = await DBOS.startWorkflow(workspaceHostProvisioningWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostProvisioningQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(input);
    // DBOS binds the first input to an ID. A retry may change only its admission timestamp.
    const [stored] = await handle.getWorkflowInputs<[WorkspaceHostWorkflowInput]>();
    const { requestedAt: _requestedAt, ...identity } = input;
    if (stored.action !== 'initialize' && stored.action !== 'install-desktop-pack') throw new WorkspaceHostOperationIdentityConflictError();
    const { requestedAt: _storedRequestedAt, ...storedIdentity } = stored;
    if (!isDeepStrictEqual(identity, storedIdentity)) throw new WorkspaceHostOperationIdentityConflictError();
    return { operationId: input.operationId, hostId: input.hostId, status: 'accepted' as const };
  } catch (error) {
    if (isWorkspaceHostProvisioningDedupConflict(error)) {
      throw new WorkspaceHostProvisioningConflictError(input.hostId);
    }
    throw error;
  }
}
