import type {
  WorkspaceHostDestroyConfirmation,
  WorkspaceHostLifecycleAction,
  WorkspaceHostPlanStep,
  WorkspaceHostProviderTarget,
  WorkspaceHostResourceRef,
} from './workspace-host-types';

/** Stable identity persisted before a workspace-host mutation starts. */
export interface WorkspaceHostWorkflowIdentity {
  workspaceId: string;
  hostId: string;
  operationId: string;
  planId: string;
  target: WorkspaceHostProviderTarget;
  /** Monotonic desired-state revision implemented by this plan and its postconditions. */
  desiredRevision: number;
}

/**
 * DBOS identities for one workspace-host operation.
 *
 * The workflow id is stable for a client operation, so a controller restart or
 * duplicate request resumes the same durable result. The deduplication id is
 * host-scoped, so two desired mutations cannot race the same resource graph.
 */
export interface WorkspaceHostWorkflowKeys {
  workflowId: string;
  deduplicationId: string;
}

function keyPart(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Workspace-host workflow ${field} must not be empty`);
  return encodeURIComponent(trimmed);
}

export function workspaceHostWorkflowKeys(
  identity: Pick<WorkspaceHostWorkflowIdentity, 'workspaceId' | 'hostId' | 'operationId'>,
): WorkspaceHostWorkflowKeys {
  const target = `workspace-host:${keyPart(identity.workspaceId, 'workspaceId')}:${keyPart(identity.hostId, 'hostId')}`;
  return {
    workflowId: `${target}:operation:${keyPart(identity.operationId, 'operationId')}`,
    deduplicationId: target,
  };
}

export const WORKSPACE_HOST_RETRY_CLASSES = [
  'transient',
  'throttled',
  'ambiguous',
  'terminal',
] as const;
export type WorkspaceHostRetryClass = (typeof WORKSPACE_HOST_RETRY_CLASSES)[number];

export interface WorkspaceHostCompensationPlan {
  action: WorkspaceHostLifecycleAction;
  /** Separate stable provider key; compensation may itself be replayed. */
  idempotencyKey: string;
}

/** Provider plan step plus controller-owned persistence and compensation policy. */
export interface WorkspaceHostDurableResourcePlan {
  /** Stable key in workspace_host_resources; not a provider-generated id. */
  logicalKey: string;
  step: WorkspaceHostPlanStep;
  /** False for a selected pre-existing network, disk, or other shared resource. */
  createdByOperation: boolean;
  /** Explicitly retain this operation-created resource if the operation is cancelled. */
  retainOnCancel?: boolean;
  /** Present only when cancellation/failure should compensate this resource. */
  compensation?: WorkspaceHostCompensationPlan;
  /** Destroy cannot complete until this resource has a fresh absence receipt. */
  deleteOnDestroy: boolean;
}

export interface WorkspaceHostDurableWorkflowSpec {
  identity: WorkspaceHostWorkflowIdentity;
  action: WorkspaceHostLifecycleAction;
  resources: readonly WorkspaceHostDurableResourcePlan[];
  /** Bounded apply attempts. Ambiguous outcomes reconcile instead of consuming another apply attempt. */
  maxApplyAttempts: number;
}

export const WORKSPACE_HOST_RESOURCE_CHECKPOINT_STATES = [
  'planned',
  'applying',
  'reconciling',
  'retry-wait',
  'applied',
  'unchanged',
  'compensating',
  'compensated',
  'absent',
  'failed',
] as const;
export type WorkspaceHostResourceCheckpointState =
  (typeof WORKSPACE_HOST_RESOURCE_CHECKPOINT_STATES)[number];

/** Durable projection of one workspace_host_resources row. */
export interface WorkspaceHostResourceCheckpoint {
  logicalKey: string;
  state: WorkspaceHostResourceCheckpointState;
  attempts: number;
  retryClass?: WorkspaceHostRetryClass;
  retryAfterMs?: number;
  providerRequestId?: string;
  providerResource?: WorkspaceHostResourceRef;
  deletionConfirmation?: WorkspaceHostDestroyConfirmation;
  error?: string;
}

export type WorkspaceHostRecoveryAction =
  | 'apply'
  | 'retry'
  | 'reconcile'
  | 'compensate'
  | 'halt'
  | 'none';

/**
 * Decide how a durable resource row resumes after controller loss.
 * `applying` is deliberately reconciled: the provider may have succeeded after
 * the controller lost the response, so issuing a fresh create would be unsafe.
 */
export function workspaceHostRecoveryAction(
  checkpoint: WorkspaceHostResourceCheckpoint,
  maxApplyAttempts: number,
): WorkspaceHostRecoveryAction {
  switch (checkpoint.state) {
    case 'planned':
      return 'apply';
    case 'applying':
    case 'reconciling':
      return 'reconcile';
    case 'compensating':
      return 'compensate';
    case 'retry-wait':
    case 'failed':
      if (checkpoint.retryClass === 'ambiguous') return 'reconcile';
      if (checkpoint.retryClass === 'terminal') return 'halt';
      if (checkpoint.attempts >= maxApplyAttempts) return 'halt';
      return checkpoint.retryClass === 'transient' || checkpoint.retryClass === 'throttled'
        ? 'retry'
        : 'halt';
    case 'applied':
    case 'unchanged':
    case 'compensated':
    case 'absent':
      return 'none';
  }
}

export interface WorkspaceHostWorkflowValidation {
  ok: boolean;
  errors: readonly string[];
}

/** Validate the persisted, topologically ordered controller contract. */
export function validateWorkspaceHostWorkflow(
  spec: WorkspaceHostDurableWorkflowSpec,
): WorkspaceHostWorkflowValidation {
  const errors: string[] = [];
  for (const [field, value] of Object.entries({
    workspaceId: spec.identity.workspaceId,
    hostId: spec.identity.hostId,
    operationId: spec.identity.operationId,
    planId: spec.identity.planId,
    target: spec.identity.target,
  })) {
    if (!value.trim()) errors.push(`${field} must not be empty`);
  }
  if (!Number.isSafeInteger(spec.identity.desiredRevision) || spec.identity.desiredRevision < 1) {
    errors.push('desiredRevision must be a positive safe integer');
  }
  if (!Number.isSafeInteger(spec.maxApplyAttempts) || spec.maxApplyAttempts < 1) {
    errors.push('maxApplyAttempts must be a positive safe integer');
  }
  if (spec.resources.length === 0) errors.push('resources must not be empty');

  const allStepIds = new Set(spec.resources.map((resource) => resource.step.id));
  const seenStepIds = new Set<string>();
  const logicalKeys = new Set<string>();
  const providerKeys = new Set<string>();

  for (const resource of spec.resources) {
    const { step } = resource;
    if (!resource.logicalKey.trim()) errors.push('logicalKey must not be empty');
    if (logicalKeys.has(resource.logicalKey)) errors.push(`duplicate logicalKey '${resource.logicalKey}'`);
    logicalKeys.add(resource.logicalKey);

    if (!step.id.trim()) errors.push('step id must not be empty');
    if (seenStepIds.has(step.id)) errors.push(`duplicate step id '${step.id}'`);
    if (!step.idempotencyKey.trim()) errors.push(`step '${step.id}' idempotencyKey must not be empty`);
    if (providerKeys.has(step.idempotencyKey)) {
      errors.push(`duplicate provider idempotency key '${step.idempotencyKey}'`);
    }
    providerKeys.add(step.idempotencyKey);
    if (step.rollback) {
      if (!step.rollback.idempotencyKey.trim()) {
        errors.push(`step '${step.id}' rollback idempotencyKey must not be empty`);
      } else if (providerKeys.has(step.rollback.idempotencyKey)) {
        errors.push(`duplicate provider idempotency key '${step.rollback.idempotencyKey}'`);
      }
      providerKeys.add(step.rollback.idempotencyKey);
      if (!step.dependsOn.length) {
        errors.push(`step '${step.id}' rollback needs the destructive predecessor it compensates for`);
      }
    }

    for (const dependency of step.dependsOn) {
      if (!allStepIds.has(dependency)) errors.push(`step '${step.id}' has unknown dependency '${dependency}'`);
      else if (!seenStepIds.has(dependency)) {
        errors.push(`step '${step.id}' must appear after dependency '${dependency}'`);
      }
    }

    if (resource.createdByOperation && !resource.compensation && !resource.retainOnCancel) {
      errors.push(`resource '${resource.logicalKey}' needs compensation or retainOnCancel`);
    }
    if (resource.retainOnCancel && resource.compensation) {
      errors.push(`resource '${resource.logicalKey}' cannot both retain and compensate on cancellation`);
    }
    if (resource.compensation) {
      if (!resource.compensation.idempotencyKey.trim()) {
        errors.push(`resource '${resource.logicalKey}' compensation idempotencyKey must not be empty`);
      }
      if (resource.compensation.idempotencyKey === step.idempotencyKey) {
        errors.push(`resource '${resource.logicalKey}' apply and compensation keys must differ`);
      }
    }
    seenStepIds.add(step.id);
  }

  if (spec.action === 'destroy' && !spec.resources.some((resource) => resource.deleteOnDestroy)) {
    errors.push('destroy workflow must identify at least one resource that requires confirmed deletion');
  }
  return { ok: errors.length === 0, errors };
}

function checkpointMap(
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): Map<string, WorkspaceHostResourceCheckpoint> {
  const map = new Map<string, WorkspaceHostResourceCheckpoint>();
  for (const checkpoint of checkpoints) {
    if (map.has(checkpoint.logicalKey)) {
      throw new Error(`Duplicate workspace-host checkpoint '${checkpoint.logicalKey}'`);
    }
    map.set(checkpoint.logicalKey, checkpoint);
  }
  return map;
}

function isSatisfied(checkpoint: WorkspaceHostResourceCheckpoint | undefined): boolean {
  return checkpoint?.state === 'applied' || checkpoint?.state === 'unchanged' || checkpoint?.state === 'absent';
}

/** Reverse dependency order, limited to resources this operation created and may delete. */
export function workspaceHostCompensationOrder(
  spec: WorkspaceHostDurableWorkflowSpec,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): readonly WorkspaceHostDurableResourcePlan[] {
  const records = checkpointMap(checkpoints);
  return [...spec.resources].reverse().filter((resource) => {
    if (!resource.createdByOperation || !resource.compensation || resource.retainOnCancel) return false;
    const state = records.get(resource.logicalKey)?.state;
    return state === 'applied' || state === 'unchanged' || state === 'compensating';
  });
}

/** A destroy is final only after every owned delete target has a fresh provider-read absence receipt. */
export function workspaceHostDestroyIsConfirmed(
  spec: WorkspaceHostDurableWorkflowSpec,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
): boolean {
  if (spec.action !== 'destroy') return false;
  const records = checkpointMap(checkpoints);
  return spec.resources.filter((resource) => resource.deleteOnDestroy).every((resource) => {
    const checkpoint = records.get(resource.logicalKey);
    if (checkpoint?.state !== 'absent' || checkpoint.deletionConfirmation?.source !== 'provider-read') return false;
    const providerId = checkpoint.providerResource?.providerId;
    return !providerId || checkpoint.deletionConfirmation.providerResourceId === providerId;
  });
}

export type WorkspaceHostControllerAction =
  | { kind: 'record-plan'; resources: readonly WorkspaceHostDurableResourcePlan[] }
  | { kind: 'apply'; resource: WorkspaceHostDurableResourcePlan }
  | { kind: 'retry'; resource: WorkspaceHostDurableResourcePlan; retryAfterMs?: number }
  | { kind: 'reconcile'; resource: WorkspaceHostDurableResourcePlan }
  | { kind: 'compensate'; resource: WorkspaceHostDurableResourcePlan }
  | { kind: 'blocked'; reason: 'dependency' | 'terminal-failure' | 'destroy-unconfirmed' }
  | { kind: 'complete'; status: 'succeeded' | 'failed' | 'cancelled' };

/**
 * Pure next-action oracle used by the DBOS controller and deterministic fault
 * tests. Callers persist the returned transition before invoking a provider.
 */
export function nextWorkspaceHostControllerAction(
  spec: WorkspaceHostDurableWorkflowSpec,
  checkpoints: readonly WorkspaceHostResourceCheckpoint[],
  options: { cancellationRequested?: boolean } = {},
): WorkspaceHostControllerAction {
  const validation = validateWorkspaceHostWorkflow(spec);
  if (!validation.ok) throw new Error(`Invalid workspace-host workflow: ${validation.errors.join('; ')}`);

  const records = checkpointMap(checkpoints);
  for (const key of records.keys()) {
    if (!spec.resources.some((resource) => resource.logicalKey === key)) {
      throw new Error(`Checkpoint '${key}' is not present in the workflow plan`);
    }
  }

  // Plan rows are one transaction and always precede the first provider call.
  const missing = spec.resources.filter((resource) => !records.has(resource.logicalKey));
  if (missing.length > 0) return { kind: 'record-plan', resources: missing };

  // Recover uncertain or interrupted side effects before cancellation/failure handling.
  for (const resource of spec.resources) {
    const checkpoint = records.get(resource.logicalKey)!;
    const recovery = workspaceHostRecoveryAction(checkpoint, spec.maxApplyAttempts);
    if (recovery === 'reconcile') return { kind: 'reconcile', resource };
    if (recovery === 'compensate') return { kind: 'compensate', resource };
  }

  const terminalFailure = spec.resources.some((resource) => {
    const checkpoint = records.get(resource.logicalKey)!;
    return workspaceHostRecoveryAction(checkpoint, spec.maxApplyAttempts) === 'halt';
  });
  if (options.cancellationRequested || terminalFailure) {
    const compensation = workspaceHostCompensationOrder(spec, checkpoints)[0];
    if (compensation) return { kind: 'compensate', resource: compensation };
    return { kind: 'complete', status: options.cancellationRequested ? 'cancelled' : 'failed' };
  }

  for (const resource of spec.resources) {
    const checkpoint = records.get(resource.logicalKey)!;
    const recovery = workspaceHostRecoveryAction(checkpoint, spec.maxApplyAttempts);
    if (recovery === 'retry') {
      return { kind: 'retry', resource, retryAfterMs: checkpoint.retryAfterMs };
    }
    if (recovery !== 'apply') continue;
    const dependenciesReady = resource.step.dependsOn.every((dependencyId) => {
      const dependency = spec.resources.find((candidate) => candidate.step.id === dependencyId)!;
      return isSatisfied(records.get(dependency.logicalKey));
    });
    if (dependenciesReady) return { kind: 'apply', resource };
  }

  if (spec.action === 'destroy' && !workspaceHostDestroyIsConfirmed(spec, checkpoints)) {
    return { kind: 'blocked', reason: 'destroy-unconfirmed' };
  }
  const allSatisfied = spec.resources.every((resource) => isSatisfied(records.get(resource.logicalKey)));
  return allSatisfied
    ? { kind: 'complete', status: 'succeeded' }
    : { kind: 'blocked', reason: 'dependency' };
}
