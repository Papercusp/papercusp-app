/** Replay-safe production controller for an already-provisioned workspace host. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertWorkspaceHostSecretIsolation,
  assertWorkspaceHostReplacement,
  nextWorkspaceHostControllerAction,
  workspaceHostActionInvalidatesInitialization,
  workspaceHostProviderRetryClass,
  workspaceHostRecoveryAction,
  type WorkspaceHostApplyResult,
  type WorkspaceHostControllerAuthority,
  type WorkspaceHostDomainState,
  type WorkspaceHostImageRef,
  type WorkspaceHostInitializationReplayStore,
  type WorkspaceHostInitializationStepReceipt,
  type WorkspaceHostModel,
  type WorkspaceHostObservation,
  type WorkspaceHostPlan,
  type WorkspaceHostPlanRequest,
  type WorkspaceHostPlanStep,
  type WorkspaceHostProvider,
  type WorkspaceHostProviderConnection,
  type WorkspaceHostProviderContext,
  type WorkspaceHostResourceCheckpoint,
  type WorkspaceHostResourceRef,
  type WorkspaceHostRecoveryPlan,
  type WorkspaceHostRuntimeRelease,
  type WorkspaceHostSnapshotRef,
} from '@papercusp/deployment-driver';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  readWorkspaceHostDestroyTarget,
  readWorkspaceHostOperationPlan,
  readWorkspaceHostResourceCheckpoints,
  recordWorkspaceHostImage,
  recordWorkspaceHostObservation,
  recordWorkspaceHostRecoveryPoint,
  updateWorkspaceHostOperation,
  upsertWorkspaceHostResourceCheckpoint,
  type StoredWorkspaceHostDestroyTarget,
  upsertWorkspaceHost,
} from './observability-store';
import {
  assertProviderConnectionUsable,
  bindWorkspaceHostPlanRevision,
  nextWorkspaceHostControllerAuthority,
  resolveControllerWorkspaceHostBootstrap,
  validateWorkspaceHostCanaryAdmission,
  WorkspaceHostProvisioningRequestError,
  workspaceHostPlanDesiredRevision,
  type WorkspaceHostProvisioningResult,
  type WorkspaceHostCanaryAdmission,
} from './provisioning-runner';
import {
  WorkspaceHostInitializationReplayInFlightError,
  createWorkspaceHostInitializationReplayStore,
} from './initialization-replay-store';

const DEFAULT_RETRY_AFTER_MS = 2_000;
const MAX_CONTROLLER_TRANSITIONS_PER_REQUEST = 256;
const MAX_APPLY_ATTEMPTS = 3;

export type WorkspaceHostExistingLifecycleAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'repair'
  | 'snapshot'
  | 'upgrade'
  | 'restore';

export interface RunWorkspaceHostLifecycleInput {
  workspaceId: string;
  hostId: string;
  connection: WorkspaceHostProviderConnection;
  provider: WorkspaceHostProvider;
  action: WorkspaceHostExistingLifecycleAction;
  name?: string;
  image?: WorkspaceHostImageRef;
  rollbackImage?: WorkspaceHostImageRef;
  snapshot?: WorkspaceHostSnapshotRef;
  desired?: StoredWorkspaceHostDestroyTarget['desired'];
  /** A restore creates a new billable population and needs its own admission evidence. */
  canary?: WorkspaceHostCanaryAdmission;
  operationId?: string;
  actorId?: string;
  signal?: AbortSignal;
  store?: WorkspaceHostLifecycleStore;
  controllerAuthority?: WorkspaceHostControllerAuthority;
  desiredRevision?: number;
  /** Test/adapter seam; production derives this with the trusted bootstrap profile. */
  runtimeRelease?: WorkspaceHostRuntimeRelease;
  /** Test seam for lifecycle actions that must install the controller's current trusted release. */
  renderHostBootstrap?: (hostId: string) => Promise<string>;
  /** @internal The product wrapper keeps the operation running after provider completion. */
  providerCompletionMode?: 'terminal' | 'defer-to-product-controller';
}

export interface WorkspaceHostLifecycleStore {
  readTarget: typeof readWorkspaceHostDestroyTarget;
  upsertHost: typeof upsertWorkspaceHost;
  beginOperation: typeof beginWorkspaceHostOperation;
  readOperationPlan: typeof readWorkspaceHostOperationPlan;
  updateOperation: typeof updateWorkspaceHostOperation;
  readCheckpoints: typeof readWorkspaceHostResourceCheckpoints;
  upsertCheckpoint: typeof upsertWorkspaceHostResourceCheckpoint;
  appendEvent: typeof appendWorkspaceHostEvent;
  recordObservation: typeof recordWorkspaceHostObservation;
  recordRecoveryPoint: typeof recordWorkspaceHostRecoveryPoint;
  recordImage: typeof recordWorkspaceHostImage;
}

export const WORKSPACE_HOST_PRODUCT_LIFECYCLE_STAGES = [
  'data-recovery',
  'runtime-update',
  'credential-rebind',
  'initialization',
  'service-readiness',
  'reconnect',
] as const;
export type WorkspaceHostProductLifecycleStage = (typeof WORKSPACE_HOST_PRODUCT_LIFECYCLE_STAGES)[number];
export type WorkspaceHostRuntimeTransitionStrategy = 'bootc-stage-reboot' | 'transitional-bundle-update';
export type WorkspaceHostLifecycleStage = 'provider-complete' | WorkspaceHostProductLifecycleStage | 'workspace-usable';

export interface WorkspaceHostProductStageRequest {
  readonly stage: WorkspaceHostProductLifecycleStage;
  readonly workspaceId: string;
  readonly sourceHostId: string;
  readonly targetHostId: string;
  readonly operationId: string;
  readonly action: 'repair' | 'upgrade' | 'restore';
  readonly desiredRevision: number;
  readonly hostModel: WorkspaceHostModel;
  readonly runtimeStrategy: WorkspaceHostRuntimeTransitionStrategy;
  /** Present only for data recovery; it is the existing backup/recovery contract, not a new policy. */
  readonly recoveryPlan?: WorkspaceHostRecoveryPlan;
}

export interface WorkspaceHostProductStageObservation {
  readonly observedAt: string;
  /** Persistable measured facts. The controller validates the required facts per stage. */
  readonly postconditions: Readonly<Record<string, unknown>>;
}

/** Host supervision adapter. Implementations delegate to the existing recovery/init/credential seams. */
export interface WorkspaceHostProductLifecycleOperations {
  execute(request: WorkspaceHostProductStageRequest): Promise<WorkspaceHostProductStageObservation>;
}

export interface WorkspaceHostProductStageReceipt {
  readonly stage: WorkspaceHostProductLifecycleStage;
  readonly observedAt: string;
  readonly postconditions: Readonly<Record<string, unknown>>;
}

interface WorkspaceHostProductLifecycleController {
  readonly hostModel: WorkspaceHostModel;
  readonly operations: WorkspaceHostProductLifecycleOperations;
  readonly recoveryPlan?: WorkspaceHostRecoveryPlan;
  /** Test/advanced seam; production uses the existing durable initialization replay table. */
  readonly replayStore?: WorkspaceHostInitializationReplayStore;
  readonly leaseOwner?: string;
  readonly leaseTtlMs?: number;
}

export type RunWorkspaceHostProductLifecycleInput = Omit<
  RunWorkspaceHostLifecycleInput,
  'action' | 'providerCompletionMode'
> &
  (
    | {
        action: 'restore';
        product: Omit<WorkspaceHostProductLifecycleController, 'recoveryPlan'> & {
          recoveryPlan: WorkspaceHostRecoveryPlan;
        };
      }
    | {
        action: 'repair' | 'upgrade';
        product: Omit<WorkspaceHostProductLifecycleController, 'recoveryPlan'> & {
          recoveryPlan?: never;
        };
      }
  );

export interface WorkspaceHostLifecycleResult extends WorkspaceHostProvisioningResult {
  lifecycleStage?: WorkspaceHostLifecycleStage;
  productStageReceipts?: readonly WorkspaceHostProductStageReceipt[];
  /** WI-10002490: present once a failed step's precomputed rollback has reached a verdict. */
  rollback?: {
    stepId: string;
    status: 'succeeded' | 'failed';
    image?: WorkspaceHostImageRef;
    error?: string;
  };
}

const DEFAULT_STORE: WorkspaceHostLifecycleStore = {
  readTarget: readWorkspaceHostDestroyTarget,
  upsertHost: upsertWorkspaceHost,
  beginOperation: beginWorkspaceHostOperation,
  readOperationPlan: readWorkspaceHostOperationPlan,
  updateOperation: updateWorkspaceHostOperation,
  readCheckpoints: readWorkspaceHostResourceCheckpoints,
  upsertCheckpoint: upsertWorkspaceHostResourceCheckpoint,
  appendEvent: appendWorkspaceHostEvent,
  recordObservation: recordWorkspaceHostObservation,
  recordRecoveryPoint: recordWorkspaceHostRecoveryPoint,
  recordImage: recordWorkspaceHostImage,
};

function controllerStore(
  store: WorkspaceHostLifecycleStore,
  controllerAuthority: WorkspaceHostControllerAuthority,
  operationId: string,
): WorkspaceHostLifecycleStore {
  return {
    ...store,
    beginOperation: (input) => store.beginOperation({ ...input, controllerAuthority }),
    updateOperation: (input) => store.updateOperation({ ...input, controllerAuthority }),
    upsertCheckpoint: (input) => store.upsertCheckpoint({ ...input, controllerAuthority }),
    appendEvent: (input) => store.appendEvent({ ...input, controllerAuthority }),
    recordObservation: (workspaceId, observation) =>
      store.recordObservation(workspaceId, observation, { operationId, controllerAuthority }),
    recordRecoveryPoint: (input) => store.recordRecoveryPoint({ ...input, operationId, controllerAuthority }),
    recordImage: (input) => store.recordImage({ ...input, operationId, controllerAuthority }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * WI-10002527: the plan an earlier turn of this operation persisted, or undefined on its first
 * turn. Only a plan carrying every step's input is executable; step identities alone are not.
 */
function persistedLifecyclePlan(stored: unknown): WorkspaceHostPlan | undefined {
  if (!stored || typeof stored !== 'object') return undefined;
  const plan = stored as Partial<WorkspaceHostPlan>;
  if (typeof plan.planId !== 'string' || !Array.isArray(plan.steps)) return undefined;
  return plan.steps.every((step) => typeof step === 'object' && step !== null && 'input' in step)
    ? (plan as WorkspaceHostPlan)
    : undefined;
}

function canonicalProductJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('product lifecycle replay identity contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalProductJson).join(',')}]`;
  if (!value || typeof value !== 'object') {
    throw new Error('product lifecycle replay identity contains a non-JSON value');
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      if (entry === undefined) throw new Error(`product lifecycle replay identity field '${key}' is undefined`);
      return `${JSON.stringify(key)}:${canonicalProductJson(entry)}`;
    })
    .join(',')}}`;
}

function productStageFingerprint(request: WorkspaceHostProductStageRequest): string {
  assertWorkspaceHostSecretIsolation(request, `workspaceHost.productLifecycle.${request.stage}.request`);
  return createHash('sha256').update(canonicalProductJson(request), 'utf8').digest('hex');
}

function requiredProductPostconditions(request: WorkspaceHostProductStageRequest): Readonly<Record<string, unknown>> {
  const common = { workspaceId: request.workspaceId, hostId: request.targetHostId };
  switch (request.stage) {
    case 'data-recovery':
      return {
        ...common,
        sourceHostId: request.sourceHostId,
        dataRetained: true,
        schemaCompatible: true,
      };
    case 'runtime-update':
      return {
        ...common,
        runtimeStrategy: request.runtimeStrategy,
        signedReleaseVerified: true,
        transitionCompleted: true,
      };
    case 'credential-rebind':
      return { ...common, credentialsRebound: true };
    case 'initialization':
      return { ...common, initialized: true, migrationSucceeded: true };
    case 'service-readiness':
      return { ...common, serviceReady: true, healthStatus: 'healthy' };
    case 'reconnect':
      return { ...common, reconnected: true };
  }
}

function validateProductStageObservation(
  request: WorkspaceHostProductStageRequest,
  observation: WorkspaceHostProductStageObservation,
): void {
  if (!Number.isFinite(Date.parse(observation.observedAt))) {
    throw new Error(`product lifecycle stage '${request.stage}' did not return an ISO observedAt`);
  }
  if (
    !observation.postconditions ||
    typeof observation.postconditions !== 'object' ||
    Array.isArray(observation.postconditions)
  ) {
    throw new Error(`product lifecycle stage '${request.stage}' did not return measured postconditions`);
  }
  assertWorkspaceHostSecretIsolation(
    observation.postconditions,
    `workspaceHost.productLifecycle.${request.stage}.postconditions`,
  );
  for (const [key, expected] of Object.entries(requiredProductPostconditions(request))) {
    if (observation.postconditions[key] !== expected) {
      throw new Error(`product lifecycle stage '${request.stage}' did not prove ${key}=${JSON.stringify(expected)}`);
    }
  }
}

async function runProductStage(
  replayStore: WorkspaceHostInitializationReplayStore,
  operations: WorkspaceHostProductLifecycleOperations,
  request: WorkspaceHostProductStageRequest,
): Promise<WorkspaceHostProductStageReceipt> {
  const receipt = await replayStore.runOnce(
    {
      idempotencyKey:
        `workspace-host-product:${request.workspaceId}:${request.targetHostId}:` +
        `${request.operationId}:${request.stage}`,
      stepFingerprint: productStageFingerprint(request),
    },
    async (): Promise<WorkspaceHostInitializationStepReceipt> => {
      const observation = await operations.execute(request);
      validateProductStageObservation(request, observation);
      return {
        stepId: request.stage,
        status: 'succeeded',
        observedAt: observation.observedAt,
        publicEvidence: observation.postconditions,
      };
    },
  );
  if (receipt.stepId !== request.stage || receipt.status !== 'succeeded') {
    throw new Error(`product lifecycle replay receipt for '${request.stage}' has the wrong identity`);
  }
  const observation = { observedAt: receipt.observedAt, postconditions: receipt.publicEvidence ?? {} };
  validateProductStageObservation(request, observation);
  return { stage: request.stage, ...observation };
}

function productStageRequests(input: {
  workspaceId: string;
  sourceHostId: string;
  targetHostId: string;
  operationId: string;
  action: 'repair' | 'upgrade' | 'restore';
  desiredRevision: number;
  product: WorkspaceHostProductLifecycleController;
}): readonly WorkspaceHostProductStageRequest[] {
  const hostModel = input.product.hostModel;
  if (hostModel !== 'bootc-image' && hostModel !== 'ubuntu-release-bundle') {
    throw new WorkspaceHostProvisioningRequestError([`unsupported product host model '${String(hostModel)}'`]);
  }
  const runtimeStrategy: WorkspaceHostRuntimeTransitionStrategy =
    hostModel === 'bootc-image' ? 'bootc-stage-reboot' : 'transitional-bundle-update';
  const common = {
    workspaceId: input.workspaceId,
    sourceHostId: input.sourceHostId,
    targetHostId: input.targetHostId,
    operationId: input.operationId,
    action: input.action,
    desiredRevision: input.desiredRevision,
    hostModel,
    runtimeStrategy,
  } as const;
  const requests: WorkspaceHostProductStageRequest[] = [];
  if (input.action === 'restore') {
    const recoveryPlan = input.product.recoveryPlan;
    if (!recoveryPlan) throw new WorkspaceHostProvisioningRequestError(['restore recoveryPlan is required']);
    if (
      recoveryPlan.workspaceId !== input.workspaceId ||
      recoveryPlan.sourceHostId !== input.sourceHostId ||
      recoveryPlan.targetHostId !== input.targetHostId
    ) {
      throw new WorkspaceHostProvisioningRequestError([
        'restore recoveryPlan must preserve the exact workspace, source Host, and target Host identities',
      ]);
    }
    requests.push({ ...common, stage: 'data-recovery', recoveryPlan });
  } else if (input.product.recoveryPlan !== undefined) {
    throw new WorkspaceHostProvisioningRequestError(['recoveryPlan is valid only for restore']);
  }
  requests.push({ ...common, stage: 'runtime-update' });
  if (input.action === 'restore') requests.push({ ...common, stage: 'credential-rebind' });
  requests.push(
    { ...common, stage: 'initialization' },
    { ...common, stage: 'service-readiness' },
    { ...common, stage: 'reconnect' },
  );
  return requests;
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkspaceHostProvisioningRequestError([`${label} must not be empty`]);
  return trimmed;
}

function replaceCheckpoint(
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  checkpoint: WorkspaceHostResourceCheckpoint,
): WorkspaceHostResourceCheckpoint[] {
  return [...checkpoints.filter((entry) => entry.logicalKey !== checkpoint.logicalKey), checkpoint].sort((a, b) =>
    a.logicalKey.localeCompare(b.logicalKey),
  );
}

function knownResources(
  target: StoredWorkspaceHostDestroyTarget | undefined,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): WorkspaceHostResourceRef[] {
  const byIdentity = new Map<string, WorkspaceHostResourceRef>();
  for (const resource of (target?.resources ?? []).map((entry) => entry.resource)) {
    byIdentity.set(`${resource.target}:${resource.kind}:${resource.providerId}`, resource);
  }
  for (const checkpoint of checkpoints) {
    const resource = checkpoint.providerResource;
    if (resource && (checkpoint.state === 'applied' || checkpoint.state === 'unchanged')) {
      byIdentity.set(`${resource.target}:${resource.kind}:${resource.providerId}`, resource);
    }
  }
  return [...byIdentity.values()];
}

function progress(checkpoints: readonly WorkspaceHostResourceCheckpoint[], total: number): number {
  if (total === 0) return 100;
  const settled = checkpoints.filter((entry) => ['applied', 'unchanged', 'absent'].includes(entry.state)).length;
  return Math.max(0, Math.min(99, Math.floor((settled / total) * 100)));
}

function resultCheckpoint(
  prior: WorkspaceHostResourceCheckpoint,
  attempts: number,
  result: WorkspaceHostApplyResult,
): WorkspaceHostResourceCheckpoint {
  const common = {
    logicalKey: prior.logicalKey,
    attempts,
    ...(result.providerRequestId || prior.providerRequestId
      ? { providerRequestId: result.providerRequestId ?? prior.providerRequestId }
      : {}),
  };
  if (result.state === 'in-progress') {
    return {
      ...common,
      state: 'retry-wait',
      retryClass: 'ambiguous',
      retryAfterMs: result.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
    };
  }
  if (result.state === 'destroyed') {
    return {
      ...common,
      state: 'absent',
      ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
      deletionConfirmation: result.confirmation,
    };
  }
  // D-389: a snapshot step reports what it made as `result.snapshot`, never `result.resource`.
  // Dropping it left the checkpoint with no provider identity, so the host never registered its
  // own recovery point and every later destroy census called that snapshot an untracked orphan.
  // Same mapping as the destroy runner's preserve-disk step.
  const snapshotResource: WorkspaceHostResourceRef | undefined = result.snapshot
    ? { target: result.snapshot.target, kind: 'snapshot', providerId: result.snapshot.providerId }
    : undefined;
  return {
    ...common,
    state: result.state,
    ...(result.resource || snapshotResource || prior.providerResource
      ? { providerResource: result.resource ?? snapshotResource ?? prior.providerResource }
      : {}),
  };
}

/**
 * WI-10002490: an upgrade's way back defaults to the image the host is recorded as running, so
 * every upgrade carries a rollback the provider validates BEFORE its destructive step — not only
 * those whose caller thought to ask for one.
 */
function effectiveRollbackImage(
  input: RunWorkspaceHostLifecycleInput,
  target: StoredWorkspaceHostDestroyTarget,
): WorkspaceHostImageRef | undefined {
  return input.action === 'upgrade' ? (input.rollbackImage ?? target.desired.image) : undefined;
}

/** The checkpoint row of a step's rollback leg; never a plan step's own key (= its step id). */
function rollbackLogicalKey(step: WorkspaceHostPlanStep): string {
  return `${step.id}:rollback`;
}

/**
 * The step whose failure strands the host: it carries a precomputed rollback, it has not completed,
 * and the destructive step it depends on HAS applied. A failure before that point removed nothing,
 * so there is nothing to roll back and the operation simply fails.
 */
function strandedByFailure(
  plan: WorkspaceHostPlan,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): WorkspaceHostPlanStep | undefined {
  const settled = (stepId: string) =>
    ['applied', 'unchanged', 'absent'].includes(checkpoints.find((entry) => entry.logicalKey === stepId)?.state ?? '');
  return plan.steps.find(
    (step) =>
      step.rollback !== undefined &&
      !settled(step.id) &&
      step.dependsOn.every(settled) &&
      step.dependsOn.some((stepId) => plan.steps.find((candidate) => candidate.id === stepId)?.destructive),
  );
}

export function validateWorkspaceHostLifecycleRequest<
  T extends Pick<RunWorkspaceHostLifecycleInput, 'action' | 'hostId' | 'image' | 'snapshot' | 'desired'>,
>(
  input: T,
): asserts input is T &
  (
    | { action: 'upgrade'; image: WorkspaceHostImageRef }
    | {
        action: 'restore';
        snapshot: WorkspaceHostSnapshotRef;
        desired: StoredWorkspaceHostDestroyTarget['desired'];
      }
    | { action: Exclude<WorkspaceHostExistingLifecycleAction, 'upgrade' | 'restore'> }
  ) {
  if (input.action === 'upgrade' && !input.image) {
    throw new WorkspaceHostProvisioningRequestError(['upgrade image is required']);
  }
  if (input.action === 'restore') {
    if (!input.snapshot) throw new WorkspaceHostProvisioningRequestError(['restore snapshot is required']);
    if (!input.desired) throw new WorkspaceHostProvisioningRequestError(['restore desired host spec is required']);
    if (input.desired.hostId === input.hostId) {
      throw new WorkspaceHostProvisioningRequestError(['restore must target a distinct desired.hostId']);
    }
  }
}

function planRequest(
  input: RunWorkspaceHostLifecycleInput,
  target: StoredWorkspaceHostDestroyTarget,
  operationId: string,
  desiredRevision: number,
): WorkspaceHostPlanRequest {
  validateWorkspaceHostLifecycleRequest(input);
  const base = {
    operationId,
    idempotencyKey: `workspace-host:${input.workspaceId}:${input.hostId}:revision:${desiredRevision}:${operationId}:${input.action}`,
    host: {
      hostId: input.hostId,
      target: target.desired.target,
      resources: target.resources.map((entry) => entry.resource),
    },
  } as const;
  if (input.action === 'snapshot')
    return { ...base, action: input.action, ...(input.name ? { name: input.name } : {}) };
  if (input.action === 'upgrade') {
    const rollbackImage = effectiveRollbackImage(input, target);
    return {
      ...base,
      action: input.action,
      image: input.image,
      ...(rollbackImage ? { rollbackImage } : {}),
      // WI-10005971: an AWS upgrade launches a replacement instance from the recorded launch spec.
      desired: target.desired,
    };
  }
  if (input.action === 'restore') {
    return { ...base, action: input.action, snapshot: input.snapshot, desired: input.desired };
  }
  return { ...base, action: input.action };
}

function matchingExistingResource(
  target: StoredWorkspaceHostDestroyTarget,
  step: WorkspaceHostPlan['steps'][number],
): WorkspaceHostResourceRef | undefined {
  // A snapshot step always CREATES a new recovery point; its step input names neither an instance
  // nor a resource, so the kind-only fallback below would pre-stamp the host's OLDEST registered
  // snapshot onto a new snapshot's checkpoint (D-389 made snapshots registered resources).
  if (step.resourceKind === 'snapshot') return undefined;
  const providerId = [step.input.instanceName, step.input.resourceName].find(
    (value): value is string => typeof value === 'string',
  );
  return target.resources
    .map((entry) => entry.resource)
    .find((resource) => resource.kind === step.resourceKind && (!providerId || resource.providerId === providerId));
}

/**
 * The host's population once this operation's steps have taken effect: the registered resources,
 * then each checkpoint in plan order (a step's rollback leg right after the step), where an
 * applied/unchanged resource joins and a confirmed-absent one leaves. Order matters because one
 * identity can be both: GCP's upgrade deletes then re-inserts the SAME VM name, while an AWS
 * upgrade stops, then terminates, the original instance after launching its replacement under a
 * new id (WI-10005971). Observing the start-of-turn list instead would read the terminated
 * original and record the upgraded host as absent.
 */
function populationAfterOperation(
  target: StoredWorkspaceHostDestroyTarget,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  plan: WorkspaceHostPlan,
): WorkspaceHostResourceRef[] {
  const identity = (resource: WorkspaceHostResourceRef) => `${resource.target}:${resource.kind}:${resource.providerId}`;
  const live = new Map<string, WorkspaceHostResourceRef>();
  for (const { resource } of target.resources) live.set(identity(resource), resource);
  const byKey = new Map(checkpoints.map((entry) => [entry.logicalKey, entry]));
  for (const key of plan.steps.flatMap((step) => [step.id, rollbackLogicalKey(step)])) {
    const checkpoint = byKey.get(key);
    const resource = checkpoint?.providerResource;
    if (!checkpoint || !resource) continue;
    if (checkpoint.state === 'applied' || checkpoint.state === 'unchanged') live.set(identity(resource), resource);
    else if (checkpoint.state === 'absent') live.delete(identity(resource));
  }
  return [...live.values()];
}

async function observe(
  input: RunWorkspaceHostLifecycleInput,
  target: StoredWorkspaceHostDestroyTarget,
  store: WorkspaceHostLifecycleStore,
  context: WorkspaceHostProviderContext,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  plan?: WorkspaceHostPlan,
): Promise<WorkspaceHostObservation | undefined> {
  try {
    const observation = await input.provider.observe(
      // A restore built a distinct host: observe what THIS operation created, never the source's
      // population (that stamped the source VM's state onto the new host id, and had nothing to
      // read at all once the source was destroyed).
      input.action === 'restore'
        ? {
            hostId: input.desired!.hostId,
            target: input.desired!.target,
            resources: knownResources(undefined, checkpoints),
          }
        : {
            hostId: input.hostId,
            target: target.desired.target,
            // An upgrade may replace resources; every other action leaves the population as registered.
            resources:
              input.action === 'upgrade' && plan
                ? populationAfterOperation(target, checkpoints, plan)
                : target.resources.map((entry) => entry.resource),
          },
      context,
    );
    await store.recordObservation(input.workspaceId, observation);
    return observation;
  } catch (error) {
    await store.appendEvent({
      workspaceId: input.workspaceId,
      // The operation lives on the host this action produced; for restore that is NOT the source,
      // and the fenced store refuses an event whose operation belongs to a different host.
      hostId: input.action === 'restore' ? input.desired!.hostId : input.hostId,
      operationId: context.requestId,
      phase: 'observe',
      status: 'running',
      level: 'warn',
      message: `Provider lifecycle mutation completed, but observation is pending: ${message(error)}`,
    });
    return undefined;
  }
}

interface RollbackLeg {
  input: RunWorkspaceHostLifecycleInput;
  store: WorkspaceHostLifecycleStore;
  context: WorkspaceHostProviderContext;
  target: StoredWorkspaceHostDestroyTarget;
  ownPopulation: StoredWorkspaceHostDestroyTarget | undefined;
  plan: WorkspaceHostPlan;
  /** The stranded step whose precomputed rollback this leg applies. */
  step: WorkspaceHostPlanStep;
  workspaceId: string;
  hostId: string;
  operationId: string;
  checkpoints: readonly WorkspaceHostResourceCheckpoint[];
  /** The leg's own checkpoint when resuming; absent on the turn the leg starts. */
  prior: WorkspaceHostResourceCheckpoint | undefined;
  rollbackImage: WorkspaceHostImageRef | undefined;
}

/**
 * WI-10002490: apply a stranded step's precomputed rollback in its place — the same apply /
 * reconcile / bounded-retry discipline as a plan step, under its own `<step>:rollback` checkpoint,
 * so a rollback interrupted mid-flight resumes (and is never issued twice) on the next turn.
 *
 * The operation ends `failed` either way: the action did not happen. What the leg decides is whether
 * the host was put back — and it says so in the ledger, because "upgrade failed, host restored" and
 * "upgrade failed, host has no VM" call for entirely different operator responses.
 */
async function runRollbackLeg(leg: RollbackLeg): Promise<WorkspaceHostLifecycleResult> {
  const { input, store, context, plan, step, workspaceId, hostId, operationId } = leg;
  const rollback = step.rollback!;
  const logicalKey = rollbackLogicalKey(step);
  const cause =
    leg.checkpoints.find((entry) => entry.logicalKey === step.id)?.error ?? `step '${step.id}' did not complete`;
  const towards = leg.rollbackImage ? ` to '${leg.rollbackImage.id}'` : '';
  const rollbackStep: WorkspaceHostPlanStep = {
    id: logicalKey,
    action: step.action,
    resourceKind: step.resourceKind,
    dependsOn: step.dependsOn,
    idempotencyKey: rollback.idempotencyKey,
    destructive: false,
    input: rollback.input,
  };
  let current: WorkspaceHostResourceCheckpoint;
  const withCurrent = () => replaceCheckpoint(leg.checkpoints, current);

  if (leg.prior) {
    current = leg.prior;
  } else {
    current = { logicalKey, state: 'planned', attempts: 0 };
    await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: current });
    await store.appendEvent({
      workspaceId,
      hostId,
      operationId,
      phase: 'rollback',
      status: 'running',
      level: 'warn',
      message: `Step '${step.id}' failed after [${step.dependsOn.join(', ')}] applied; rolling back${towards}`,
      details: { error: cause },
    });
  }

  for (let transition = 0; transition < MAX_CONTROLLER_TRANSITIONS_PER_REQUEST; transition += 1) {
    const recovery = workspaceHostRecoveryAction(current, MAX_APPLY_ATTEMPTS);
    if (recovery === 'none') {
      await observe(input, leg.target, store, context, withCurrent(), plan);
      // The instance now boots the rollback image; without this the host row would keep naming the
      // image the failed upgrade never delivered (WI-10002494's defect, reached from the other side).
      if (leg.rollbackImage) await store.recordImage({ workspaceId, hostId, image: leg.rollbackImage });
      const text =
        `Workspace-host ${input.action} failed at '${step.id}' and was rolled back${towards}; ` +
        'the host was recreated and must be initialized again before use';
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'failed',
        percent: progress(leg.checkpoints, plan.steps.length),
        message: text,
        error: {
          reason: cause,
          rolledBack: true,
          ...(leg.rollbackImage ? { rollbackImage: leg.rollbackImage.id } : {}),
        },
      });
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: 'rollback',
        status: 'failed',
        level: 'warn',
        message: text,
        details: { error: cause },
      });
      return {
        status: 'failed',
        operationId,
        hostId,
        plan,
        checkpoints: withCurrent(),
        requiresInitialization: true,
        rollback: {
          stepId: step.id,
          status: 'succeeded',
          ...(leg.rollbackImage ? { image: leg.rollbackImage } : {}),
        },
      };
    }
    if (recovery === 'halt' || recovery === 'compensate') {
      const rollbackError = current.error ?? `rollback checkpoint halted in state '${current.state}'`;
      const text =
        `Workspace-host ${input.action} failed at '${step.id}', and its rollback${towards} failed too; ` +
        `the host is NOT restored and needs operator attention`;
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'failed',
        percent: progress(leg.checkpoints, plan.steps.length),
        message: text,
        error: { reason: cause, rolledBack: false, rollbackError },
      });
      await store.appendEvent({
        workspaceId,
        hostId,
        operationId,
        phase: 'rollback',
        status: 'failed',
        level: 'error',
        message: text,
        details: { error: cause, rollbackError },
      });
      return {
        status: 'failed',
        operationId,
        hostId,
        plan,
        checkpoints: withCurrent(),
        rollback: {
          stepId: step.id,
          status: 'failed',
          ...(leg.rollbackImage ? { image: leg.rollbackImage } : {}),
          error: rollbackError,
        },
      };
    }

    const reconciling = recovery === 'reconcile';
    const attempts = current.attempts + 1;
    const beforeCall: WorkspaceHostResourceCheckpoint = {
      logicalKey,
      state: reconciling ? 'reconciling' : 'applying',
      attempts,
      ...(current.providerResource ? { providerResource: current.providerResource } : {}),
      ...(current.providerRequestId ? { providerRequestId: current.providerRequestId } : {}),
    };
    await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: beforeCall });
    const prior = current;
    current = beforeCall;
    const applyRequest = {
      planId: plan.planId,
      operationId,
      step: rollbackStep,
      knownResources: knownResources(leg.ownPopulation, leg.checkpoints),
    };
    let providerResult: WorkspaceHostApplyResult;
    try {
      providerResult = reconciling
        ? await input.provider.reconcile(
            {
              ...applyRequest,
              reason: 'resume',
              ...(prior.providerRequestId ? { previousProviderRequestId: prior.providerRequestId } : {}),
            },
            context,
          )
        : await input.provider.apply(applyRequest, context);
    } catch (error) {
      const retryClass = workspaceHostProviderRetryClass(error);
      current = {
        logicalKey,
        state: 'failed',
        attempts,
        retryClass,
        ...(retryClass === 'terminal' ? {} : { retryAfterMs: DEFAULT_RETRY_AFTER_MS }),
        ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
        ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
        error: message(error),
      };
      await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: current });
      if (workspaceHostRecoveryAction(current, MAX_APPLY_ATTEMPTS) === 'halt') continue;
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: progress(leg.checkpoints, plan.steps.length),
        message: `Rollback of '${step.id}' will be retried: ${message(error)}`,
      });
      return {
        status: 'in-progress',
        operationId,
        hostId,
        plan,
        checkpoints: withCurrent(),
        retryAfterMs: DEFAULT_RETRY_AFTER_MS,
      };
    }
    current = resultCheckpoint(prior, attempts, providerResult);
    await store.upsertCheckpoint({ workspaceId, hostId, operationId, checkpoint: current });
    if (providerResult.state === 'in-progress') {
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: progress(leg.checkpoints, plan.steps.length),
        message: `Rollback of '${step.id}'${towards} is still in progress`,
      });
      return {
        status: 'in-progress',
        operationId,
        hostId,
        plan,
        checkpoints: withCurrent(),
        retryAfterMs: providerResult.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
      };
    }
  }

  throw new Error(`Workspace-host ${input.action} rollback exceeded its bounded controller transition budget`);
}

export async function runWorkspaceHostLifecycle(
  input: RunWorkspaceHostLifecycleInput,
): Promise<WorkspaceHostLifecycleResult> {
  const baseStore = input.store ?? DEFAULT_STORE;
  const workspaceId = nonEmpty(input.workspaceId, 'workspaceId');
  const hostId = nonEmpty(input.hostId, 'hostId');
  const operationId = nonEmpty(input.operationId ?? randomUUID(), 'operationId');
  const target = await baseStore.readTarget(workspaceId, hostId);
  if (!target) throw new WorkspaceHostProvisioningRequestError([`workspace host '${hostId}' was not found`]);
  // D-388: a snapshot exists for the day its source is gone, and a destroyed source is observed
  // absent with its resources deregistered — so restore alone may name one, and only from a snapshot
  // of that exact host. The provider's READY / managed-label / same-project checks remain the gate.
  const restoresOwnSnapshot =
    input.action === 'restore' && input.snapshot?.hostId === hostId && input.snapshot.target === target.target;
  if (target.observedState === 'absent' && !restoresOwnSnapshot) {
    throw new WorkspaceHostProvisioningRequestError(['workspace host is absent']);
  }
  if (target.resources.length === 0 && !restoresOwnSnapshot) {
    throw new WorkspaceHostProvisioningRequestError(['workspace host has no registered provider resource population']);
  }
  if (target.id !== hostId || target.desired.hostId !== hostId) {
    throw new WorkspaceHostProvisioningRequestError(['stored workspace-host identity does not match hostId']);
  }
  if (input.connection.target !== target.target || input.provider.target !== target.target) {
    throw new WorkspaceHostProvisioningRequestError([
      'workspace-host provider and connection must match stored target',
    ]);
  }
  const controllerAuthority =
    input.controllerAuthority ?? nextWorkspaceHostControllerAuthority(target.controllerAuthority);
  const store = controllerStore(baseStore, controllerAuthority, operationId);

  if (input.action === 'restore') {
    if (!input.desired) throw new WorkspaceHostProvisioningRequestError(['restore desired host spec is required']);
    validateWorkspaceHostCanaryAdmission({
      ...input,
      desired: input.desired,
      sourceLabels: target.desired.labels,
    });
  }

  let hostBootstrapScript: string | undefined;
  let runtimeRelease = input.runtimeRelease;
  if (
    input.provider.capabilities.lifecycle.hostBootstrap &&
    (input.action === 'repair' || input.action === 'upgrade' || input.action === 'restore')
  ) {
    const bootstrapHostId = input.action === 'restore' ? input.desired?.hostId : hostId;
    if (!bootstrapHostId) {
      throw new WorkspaceHostProvisioningRequestError(['restore desired host spec is required']);
    }
    try {
      if (input.renderHostBootstrap) {
        hostBootstrapScript = await input.renderHostBootstrap(bootstrapHostId);
      } else {
        const statusChannel = input.provider.capabilities.lifecycle.bootstrapStatusChannel;
        const resolved = await resolveControllerWorkspaceHostBootstrap(
          bootstrapHostId,
          statusChannel ? { statusChannel } : {},
        );
        hostBootstrapScript = resolved.script;
        runtimeRelease = resolved.runtimeRelease;
      }
    } catch (error) {
      throw new WorkspaceHostProvisioningRequestError([message(error)]);
    }
  }

  const context: WorkspaceHostProviderContext = {
    workspaceId,
    requestId: operationId,
    connection: { ...input.connection, scope: target.desired.scope },
    ...(hostBootstrapScript ? { hostBootstrapScript } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };
  await assertProviderConnectionUsable(input.provider, context);

  // WI-10002527: a resumed turn executes the plan this operation resolved on its first turn and
  // persisted with its request (beginOperation below), never a fresh one. Re-planning is unsound
  // for any plan derived from state its own steps destroy: a GCP upgrade builds its re-create from
  // a live read of the VM its first step deletes, so once that delete applied no new plan could be
  // made, and the upgrade died with no VM and its precomputed rollback unreachable.
  const persistedPlan = persistedLifecyclePlan(await store.readOperationPlan(workspaceId, operationId));
  const desiredRevision =
    input.desiredRevision ??
    workspaceHostPlanDesiredRevision(persistedPlan?.planId) ??
    target.desiredRevision + 1;
  let plan: WorkspaceHostPlan;
  if (persistedPlan) {
    plan = persistedPlan;
  } else {
    try {
      plan = bindWorkspaceHostPlanRevision(
        await input.provider.plan(planRequest(input, target, operationId, desiredRevision), context),
        desiredRevision,
      );
      // Persisted verbatim with the operation, so it must hold nothing that may not be persisted.
      assertWorkspaceHostSecretIsolation(plan, 'workspaceHost.lifecyclePlan');
    } catch (error) {
      if (error instanceof WorkspaceHostProvisioningRequestError) throw error;
      throw new WorkspaceHostProvisioningRequestError([message(error)]);
    }
  }
  const resultHostId = input.action === 'restore' ? input.desired!.hostId : hostId;
  const identityProblems: string[] = [];
  if (plan.operationId !== operationId) identityProblems.push('provider lifecycle plan changed operationId');
  if (plan.hostId !== resultHostId) identityProblems.push('provider lifecycle plan changed hostId');
  if (plan.target !== target.target) identityProblems.push('provider lifecycle plan changed target');
  if (identityProblems.length > 0) throw new WorkspaceHostProvisioningRequestError(identityProblems);

  if (input.action === 'restore') {
    const replacement: WorkspaceHostDomainState = {
      workspaceId,
      hostId: resultHostId,
      hostGeneration: target.hostGeneration + 1,
      connectionId: target.connectionId,
      desiredRevision,
      observedRevision: target.observedRevision,
      ...((runtimeRelease ?? target.runtimeRelease) ? { runtimeRelease: runtimeRelease ?? target.runtimeRelease } : {}),
      controllerAuthority,
    };
    assertWorkspaceHostReplacement(
      {
        workspaceId,
        hostId,
        hostGeneration: target.hostGeneration,
        connectionId: target.connectionId,
        desiredRevision: target.desiredRevision,
        observedRevision: target.observedRevision,
        ...(target.runtimeRelease ? { runtimeRelease: target.runtimeRelease } : {}),
        ...(target.controllerAuthority ? { controllerAuthority: target.controllerAuthority } : {}),
      },
      replacement,
    );
    // Structural, not textual: the stored spec round-tripped through jsonb, which re-orders object
    // keys, so a byte comparison refused an identical policy whose request listed keys differently.
    if (
      !isDeepStrictEqual(input.desired!.data, target.desired.data) ||
      !isDeepStrictEqual(input.desired!.credentials, target.desired.credentials)
    ) {
      throw new WorkspaceHostProvisioningRequestError([
        'restore replacement must preserve workspace data policy and credential permissions',
      ]);
    }
    await store.upsertHost({
      workspaceId,
      id: resultHostId,
      name: input.name?.trim() || target.name,
      connectionId: target.connectionId,
      target: input.desired!.target,
      scopeLabel: input.desired!.scope.id,
      region: input.desired!.region,
      size: input.desired!.size,
      image: input.desired!.image.id,
      diskGiB: input.desired!.data.volumeGiB,
      network: 'restored',
      desiredState: 'running',
      observedState: 'provisioning',
      desiredSpec: input.desired!,
      hostGeneration: replacement.hostGeneration,
      desiredRevision: replacement.desiredRevision,
      observedRevision: replacement.observedRevision,
      ...(replacement.runtimeRelease ? { runtimeRelease: replacement.runtimeRelease } : {}),
      ...(replacement.controllerAuthority ? { controllerAuthority: replacement.controllerAuthority } : {}),
    });
  }

  const workflow = {
    identity: {
      workspaceId,
      hostId: resultHostId,
      operationId,
      planId: plan.planId,
      target: plan.target,
      desiredRevision,
    },
    action: input.action,
    resources: plan.steps.map((step) => ({
      logicalKey: step.id,
      step,
      createdByOperation: input.action === 'snapshot' || input.action === 'restore',
      deleteOnDestroy: input.action === 'snapshot' || input.action === 'restore',
      retainOnCancel: true,
    })),
    maxApplyAttempts: MAX_APPLY_ATTEMPTS,
  } as const;
  // The provider population this operation acts ON. A restore acts on a host it is building, so the
  // source's resources are never its own: seeding them into the replacement's checkpoints stamped
  // the source VM/disk identities onto the new host, and offering them as known resources let the
  // "disk persisted before insert-instance" gate pass on a disk this operation never made.
  const ownPopulation = input.action === 'restore' ? undefined : target;
  // A rollback leg's row is not a plan step, so the controller oracle (which refuses any
  // checkpoint outside the plan) only ever sees the plan's own rows.
  const rollbackKeys = new Set(plan.steps.filter((step) => step.rollback).map(rollbackLogicalKey));
  const storedCheckpoints = await store.readCheckpoints(workspaceId, resultHostId, operationId);
  let checkpoints = storedCheckpoints.filter((entry) => !rollbackKeys.has(entry.logicalKey));
  const rollbackImage = effectiveRollbackImage(input, target);
  const rollbackLeg = (step: WorkspaceHostPlanStep) =>
    runRollbackLeg({
      input,
      store,
      context,
      target,
      ownPopulation,
      plan,
      step,
      workspaceId,
      hostId: resultHostId,
      operationId,
      checkpoints,
      prior: storedCheckpoints.find((entry) => entry.logicalKey === rollbackLogicalKey(step)),
      rollbackImage,
    });
  await store.beginOperation({
    workspaceId,
    operationId,
    hostId: resultHostId,
    action: input.action,
    status: 'running',
    message: `Workspace-host ${input.action} started`,
    request: {
      sourceHostId: hostId,
      ...(input.action === 'restore' && input.canary ? { canary: input.canary } : {}),
      ...(input.name ? { name: input.name } : {}),
      // The whole resolved plan, step inputs and rollbacks included: every later turn reads it
      // back instead of re-planning, and the request fence proves each turn executes this one.
      plan,
    },
    desiredRevision,
  });

  // Once a rollback has begun the forward plan is abandoned: resume the leg, never the step it replaced.
  const rollingBack = plan.steps.find(
    (step) => step.rollback && storedCheckpoints.some((entry) => entry.logicalKey === rollbackLogicalKey(step)),
  );
  if (rollingBack) return rollbackLeg(rollingBack);

  for (let transition = 0; transition < MAX_CONTROLLER_TRANSITIONS_PER_REQUEST; transition += 1) {
    const action = nextWorkspaceHostControllerAction(workflow, checkpoints);
    if (action.kind === 'record-plan') {
      for (const resource of action.resources) {
        const existing = ownPopulation ? matchingExistingResource(ownPopulation, resource.step) : undefined;
        const checkpoint: WorkspaceHostResourceCheckpoint = {
          logicalKey: resource.logicalKey,
          state: 'planned',
          attempts: 0,
          ...(existing ? { providerResource: existing } : {}),
        };
        await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint });
        checkpoints = replaceCheckpoint(checkpoints, checkpoint);
      }
      await store.appendEvent({
        workspaceId,
        hostId: resultHostId,
        operationId,
        phase: 'plan',
        status: 'running',
        message: `Recorded ${action.resources.length} ${input.action} step(s) before mutation`,
      });
      continue;
    }

    if (action.kind === 'apply' || action.kind === 'retry' || action.kind === 'reconcile') {
      const prior = checkpoints.find((entry) => entry.logicalKey === action.resource.logicalKey);
      if (!prior) throw new Error(`Missing lifecycle checkpoint '${action.resource.logicalKey}'`);
      const attempts = prior.attempts + 1;
      const beforeCall: WorkspaceHostResourceCheckpoint = {
        logicalKey: prior.logicalKey,
        state: action.kind === 'reconcile' ? 'reconciling' : 'applying',
        attempts,
        ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
        ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
      };
      await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: beforeCall });
      checkpoints = replaceCheckpoint(checkpoints, beforeCall);
      const applyRequest = {
        planId: plan.planId,
        operationId,
        step: action.resource.step,
        knownResources: knownResources(ownPopulation, checkpoints),
      };
      let providerResult: WorkspaceHostApplyResult;
      try {
        providerResult =
          action.kind === 'reconcile'
            ? await input.provider.reconcile(
                {
                  ...applyRequest,
                  reason: 'resume',
                  ...(prior.providerRequestId ? { previousProviderRequestId: prior.providerRequestId } : {}),
                },
                context,
              )
            : await input.provider.apply(applyRequest, context);
      } catch (error) {
        // Classify the refusal; do not assume it is uncertain. A deterministic 4xx (an expired
        // credential, a quota denial, a retired image) will be refused identically forever, and
        // `ambiguous` is exempt from the attempt ceiling in workspaceHostRecoveryAction — so
        // recording every failure as ambiguous turned a hard failure into a permanent hang that
        // reconciled on every resume and never reached a terminal verdict. This is the same
        // defect WI-1743793 fixed in the provisioning runner; both now share one classifier.
        const retryClass = workspaceHostProviderRetryClass(error);
        const failed: WorkspaceHostResourceCheckpoint = {
          logicalKey: prior.logicalKey,
          state: 'failed',
          attempts,
          retryClass,
          ...(retryClass === 'terminal' ? {} : { retryAfterMs: DEFAULT_RETRY_AFTER_MS }),
          ...(prior.providerResource ? { providerResource: prior.providerResource } : {}),
          ...(prior.providerRequestId ? { providerRequestId: prior.providerRequestId } : {}),
          error: message(error),
        };
        await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: failed });
        checkpoints = replaceCheckpoint(checkpoints, failed);
        if (retryClass === 'terminal') {
          const stranded = strandedByFailure(plan, checkpoints);
          if (stranded) return rollbackLeg(stranded);
          await store.updateOperation({
            workspaceId,
            operationId,
            status: 'failed',
            percent: progress(checkpoints, plan.steps.length),
            message: `Provider rejected step '${prior.logicalKey}'`,
            error: { reason: message(error) },
          });
          await store.appendEvent({
            workspaceId,
            hostId: resultHostId,
            operationId,
            phase: prior.logicalKey,
            status: 'failed',
            level: 'error',
            message: 'Provider rejected the request; retrying it unchanged cannot succeed',
            details: { error: message(error) },
          });
          return { status: 'failed', operationId, hostId: resultHostId, plan, checkpoints };
        }
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'running',
          percent: progress(checkpoints, plan.steps.length),
          message: `Provider outcome for '${prior.logicalKey}' is uncertain; reconciliation required`,
        });
        return {
          status: 'in-progress',
          operationId,
          hostId: resultHostId,
          plan,
          checkpoints,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        };
      }

      const afterCall = resultCheckpoint(prior, attempts, providerResult);
      await store.upsertCheckpoint({ workspaceId, hostId: resultHostId, operationId, checkpoint: afterCall });
      checkpoints = replaceCheckpoint(checkpoints, afterCall);
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: progress(checkpoints, plan.steps.length),
        message:
          providerResult.state === 'in-progress'
            ? `Provider ${input.action} step '${prior.logicalKey}' is still in progress`
            : `Provider ${input.action} step '${prior.logicalKey}' ${providerResult.state}`,
      });
      if (providerResult.state === 'in-progress') {
        return {
          status: 'in-progress',
          operationId,
          hostId: resultHostId,
          plan,
          checkpoints,
          retryAfterMs: providerResult.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        };
      }
      continue;
    }

    if (action.kind === 'complete' && action.status === 'succeeded') {
      await observe(input, target, store, context, checkpoints, plan);
      if (input.action === 'snapshot') {
        // WI-10002470: without this the host kept reading "No recovery point recorded" right after
        // a successful snapshot — false, and it argues the user out of the restore they can do.
        const recoveryPoints = checkpoints
          .filter((entry) => entry.state === 'applied' || entry.state === 'unchanged')
          .map((entry) => entry.providerResource)
          .filter((entry): entry is WorkspaceHostResourceRef => entry?.kind === 'snapshot');
        if (recoveryPoints.length === 0) {
          throw new Error(`Workspace-host snapshot '${operationId}' completed without a provider snapshot identity`);
        }
        await store.recordRecoveryPoint({
          workspaceId,
          hostId: resultHostId,
          recoverability: {
            kind: 'snapshot',
            label: recoveryPoints.map((resource) => resource.providerId).sort().join(', '),
            updatedAt: new Date().toISOString(),
          },
        });
      }
      if (input.action === 'upgrade') {
        // WI-10002494: every provider step applied, so the instance was recreated from input.image.
        // Without this the host row and desired spec kept the pre-upgrade image, and the next
        // recreate built from that spec would silently undo the upgrade.
        // WI-10002798: and onto the runtime release its re-rendered bootstrap installed.
        await store.recordImage({
          workspaceId,
          hostId: resultHostId,
          image: input.image!,
          ...(runtimeRelease ? { runtimeRelease } : {}),
        });
      }
      /*
       * This branch is generic across every lifecycle action, so on its own it can only ever
       * describe the PROVIDER mutation — never whether the host can serve. For most actions
       * those coincide. For an initialization-invalidating action they do not: `upgrade`
       * recreates the instance, `restore` builds a distinct host, and `repair` installs fresh
       * startup metadata before resetting the existing instance. In all three cases provider
       * completion arrives before the initialization leg has re-established a serving host.
       * Initialization is a SEPARATE operation the caller must sequence; saying only
       * "completed" is what let a ledger row read succeeded|100 while the host was not ready.
       *
       * Say it instead of probing for it: a readiness gate here would have to ask the provider,
       * and `attestHealth` cannot answer (GCP attests `unknown` — `agentOnline` has no producer),
       * so gating would replace a premature success with a permanent hang.
       */
      const requiresInitialization = workspaceHostActionInvalidatesInitialization(input.action);
      if (requiresInitialization && input.providerCompletionMode === 'defer-to-product-controller') {
        const providerMessage =
          `Workspace-host ${input.action} provider steps completed; ` +
          'the durable product controller is continuing to workspace-usable';
        await store.updateOperation({
          workspaceId,
          operationId,
          status: 'running',
          percent: 50,
          message: providerMessage,
        });
        await store.appendEvent({
          workspaceId,
          hostId: resultHostId,
          operationId,
          phase: 'provider-complete',
          status: 'running',
          message: providerMessage,
        });
        return {
          status: 'in-progress',
          operationId,
          hostId: resultHostId,
          plan,
          checkpoints,
          requiresInitialization: true,
          lifecycleStage: 'provider-complete',
        };
      }
      const message = requiresInitialization
        ? `Workspace-host ${input.action} completed its provider steps, but the host CANNOT SERVE yet: ` +
          `${input.action} invalidated the host's initialized state, so initialization must be run again before use`
        : `Workspace-host ${input.action} completed`;
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'succeeded',
        percent: 100,
        message,
      });
      await store.appendEvent({
        workspaceId,
        hostId: resultHostId,
        operationId,
        phase: 'complete',
        status: 'succeeded',
        message,
      });
      return {
        status: 'succeeded',
        operationId,
        hostId: resultHostId,
        plan,
        checkpoints,
        requiresInitialization,
        lifecycleStage: requiresInitialization ? 'provider-complete' : 'workspace-usable',
      };
    }

    // Also the crash-safe entry: a step that halted (attempts spent, or a terminal refusal recorded
    // just before the controller died) still reaches its rollback on the next turn.
    const stranded = strandedByFailure(plan, checkpoints);
    if (stranded) return rollbackLeg(stranded);
    const reason = action.kind === 'blocked' ? action.reason : action.kind === 'complete' ? action.status : action.kind;
    await store.updateOperation({
      workspaceId,
      operationId,
      status: 'failed',
      percent: progress(checkpoints, plan.steps.length),
      message: `Workspace-host ${input.action} controller is blocked`,
      error: { reason },
    });
    return { status: 'failed', operationId, hostId: resultHostId, plan, checkpoints };
  }

  throw new Error(`Workspace-host ${input.action} exceeded its bounded controller transition budget`);
}

/**
 * Drive an initialization-invalidating lifecycle action through provider-complete to a measured,
 * replay-safe workspace-usable result under one durable operation identity.
 */
export async function runWorkspaceHostProductLifecycle(
  input: RunWorkspaceHostProductLifecycleInput,
): Promise<WorkspaceHostLifecycleResult> {
  const { product, ...lifecycleInput } = input;
  const baseStore = input.store ?? DEFAULT_STORE;
  const workspaceId = nonEmpty(input.workspaceId, 'workspaceId');
  const sourceHostId = nonEmpty(input.hostId, 'hostId');
  const source = await baseStore.readTarget(workspaceId, sourceHostId);
  if (!source) {
    throw new WorkspaceHostProvisioningRequestError([`workspace host '${sourceHostId}' was not found`]);
  }
  const targetHostId = input.action === 'restore' ? input.desired!.hostId : sourceHostId;
  const operationId = nonEmpty(input.operationId ?? randomUUID(), 'operationId');
  const controllerAuthority =
    input.controllerAuthority ?? nextWorkspaceHostControllerAuthority(source.controllerAuthority);
  const desiredRevision = input.desiredRevision ?? source.desiredRevision + 1;
  const requests = productStageRequests({
    workspaceId,
    sourceHostId,
    targetHostId,
    operationId,
    action: input.action,
    desiredRevision,
    product,
  });

  const providerResult = await runWorkspaceHostLifecycle({
    ...lifecycleInput,
    action: input.action,
    operationId,
    controllerAuthority,
    desiredRevision,
    providerCompletionMode: 'defer-to-product-controller',
  });
  if (providerResult.lifecycleStage !== 'provider-complete') return providerResult;

  const store = controllerStore(baseStore, controllerAuthority, operationId);
  const replayStore =
    product.replayStore ??
    createWorkspaceHostInitializationReplayStore({
      workspaceId,
      hostId: targetHostId,
      leaseOwner: product.leaseOwner ?? `workspace-host-product:${operationId}`,
      ...(product.leaseTtlMs !== undefined ? { leaseTtlMs: product.leaseTtlMs } : {}),
    });
  const receipts: WorkspaceHostProductStageReceipt[] = [];
  let activeStage: WorkspaceHostProductLifecycleStage = requests[0]!.stage;

  try {
    for (const [index, request] of requests.entries()) {
      activeStage = request.stage;
      const receipt = await runProductStage(replayStore, product.operations, request);
      receipts.push(receipt);
      const percent = Math.min(99, 50 + Math.round(((index + 1) / requests.length) * 49));
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent,
        message: `Workspace-host ${input.action} product stage '${request.stage}' completed`,
      });
      await store.appendEvent({
        workspaceId,
        hostId: targetHostId,
        operationId,
        occurredAt: receipt.observedAt,
        phase: `product:${request.stage}`,
        status: 'running',
        level: 'info',
        source: 'controller',
        message: `Measured product stage '${request.stage}' completed`,
        details: { postconditions: receipt.postconditions },
      });
    }
  } catch (error) {
    if (error instanceof WorkspaceHostInitializationReplayInFlightError) {
      await store.updateOperation({
        workspaceId,
        operationId,
        status: 'running',
        percent: Math.min(99, 50 + Math.round((receipts.length / requests.length) * 49)),
        message: `Workspace-host product stage '${activeStage}' is owned by another live controller`,
      });
      return {
        ...providerResult,
        status: 'in-progress',
        lifecycleStage: activeStage,
        productStageReceipts: receipts,
        retryAfterMs: DEFAULT_RETRY_AFTER_MS,
      };
    }
    await store.updateOperation({
      workspaceId,
      operationId,
      status: 'failed',
      percent: Math.min(99, 50 + Math.round((receipts.length / requests.length) * 49)),
      message: `Workspace-host product stage '${activeStage}' failed its measured postconditions`,
      error,
    });
    await store.appendEvent({
      workspaceId,
      hostId: targetHostId,
      operationId,
      phase: `product:${activeStage}`,
      status: 'failed',
      level: 'error',
      source: 'controller',
      message: `Product stage '${activeStage}' failed; workspace is not usable`,
    });
    return {
      ...providerResult,
      status: 'failed',
      lifecycleStage: activeStage,
      productStageReceipts: receipts,
      requiresInitialization: true,
    };
  }

  const finalMessage = `Workspace-host ${input.action} reached workspace-usable`;
  await store.updateOperation({
    workspaceId,
    operationId,
    status: 'succeeded',
    percent: 100,
    message: finalMessage,
  });
  await store.appendEvent({
    workspaceId,
    hostId: targetHostId,
    operationId,
    phase: 'workspace-usable',
    status: 'succeeded',
    message: finalMessage,
  });
  return {
    ...providerResult,
    status: 'succeeded',
    lifecycleStage: 'workspace-usable',
    productStageReceipts: receipts,
    requiresInitialization: false,
  };
}
