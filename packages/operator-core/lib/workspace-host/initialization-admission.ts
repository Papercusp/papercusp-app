/** Serializable admission for the existing host-scoped DBOS queue. No remote I/O before enqueue. */
import {
  assertWorkspaceHostSecretIsolation,
  planWorkspaceHostInitialization,
  workspaceHostInitializationStepFingerprint,
  type WorkspaceHostInitializationRequest,
  type WorkspaceHostRemoteInitializerStep,
} from '@papercusp/deployment-driver';
import { createOperatorWorkspaceHostCredentialMaterialSource } from './credential-material-source';
import {
  resolveWorkspaceHostDeliveryCapabilities,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
  WorkspaceHostDesiredSpecUnavailableError,
} from './initialization-operations-resolver';
import { openWorkspaceHostInitializationRelease } from './initialization-release-receipt';
import { runWorkspaceHostInitialization } from './initialization-runner';
import { appendWorkspaceHostEvent, beginWorkspaceHostOperation, readWorkspaceHostDesiredSpec, updateWorkspaceHostOperation } from './observability-store';
import { createWorkspaceHostInitializationReplayStore } from './initialization-replay-store';

/**
 * The durable request: the contract request plus, when the run is acceptance evidence for a
 * release, that release's task (initialization-release-receipt.ts). The task id is admission
 * context, not part of the host contract, so it never reaches the planner or the host.
 */
export type AdmittedWorkspaceHostInitialization = WorkspaceHostInitializationRequest & { releaseTaskId?: string };

export type WorkspaceHostInitializationAdmission = Omit<AdmittedWorkspaceHostInitialization, 'deliveryCapabilities'>;

export interface WorkspaceHostDesktopPackRequest {
  workspaceId: string;
  hostId: string;
  operationId: string;
  requestedAt: string;
  action: 'install-desktop-pack';
}

export async function prepareWorkspaceHostDesktopPack(input: WorkspaceHostDesktopPackRequest) {
  if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(input.operationId) ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(input.hostId) ||
      !input.workspaceId.trim() || !Number.isFinite(Date.parse(input.requestedAt))) {
    throw new WorkspaceHostInitializationRequestError();
  }
  resolveWorkspaceHostInitializationControllerProfile();
  const lookup = await readWorkspaceHostDesiredSpec(input.workspaceId, input.hostId);
  if (!lookup.desired) throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  resolveWorkspaceHostDeliveryCapabilities(lookup.desired);
  assertWorkspaceHostSecretIsolation(input, 'workspaceHost.desktopPack.admission');
  return input;
}

export async function executeAdmittedWorkspaceHostDesktopPack(input: WorkspaceHostDesktopPackRequest) {
  const step = {
    id: 'desktop-pack', kind: 'install-desktop-pack' as const, dependsOn: [],
    idempotencyKey: `${input.operationId}:desktop-pack`, input: { hostId: input.hostId },
  } satisfies WorkspaceHostRemoteInitializerStep;
  await beginWorkspaceHostOperation({
    workspaceId: input.workspaceId, hostId: input.hostId, operationId: input.operationId,
    // Existing operation family for the typed host initializer; the request/phase names the pack.
    action: 'initialize', status: 'running', message: 'Installing optional workspace desktop pack',
    request: { ...input, steps: [step] },
  });
  const { operations } = await resolveWorkspaceHostInitializationOperationsForHost({
    workspaceId: input.workspaceId, hostId: input.hostId,
    controller: resolveWorkspaceHostInitializationControllerProfile(),
  });
  await operations.awaitBootstrapReady?.();
  const replay = createWorkspaceHostInitializationReplayStore({
    workspaceId: input.workspaceId, hostId: input.hostId,
    leaseOwner: `workspace-host-desktop-pack:${input.operationId}`,
  });
  const receipt = await replay.runOnce({
    idempotencyKey: step.idempotencyKey,
    stepFingerprint: workspaceHostInitializationStepFingerprint(step),
  }, async () => ({ stepId: step.id, status: 'succeeded', ...await operations.execute(step) }));
  await appendWorkspaceHostEvent({
    workspaceId: input.workspaceId, hostId: input.hostId, operationId: input.operationId,
    occurredAt: receipt.observedAt, phase: 'desktop-pack:installed', status: 'succeeded',
    level: 'info', source: 'controller', message: 'Optional desktop pack installed',
    details: { publicEvidence: receipt.publicEvidence },
  });
  await updateWorkspaceHostOperation({
    workspaceId: input.workspaceId, operationId: input.operationId,
    status: 'succeeded', percent: 100, message: 'Optional desktop pack installed; desktop session acceptance is separate',
  });
  return { status: 'succeeded' as const, operationId: input.operationId, hostId: input.hostId };
}

export class WorkspaceHostInitializationRequestError extends Error {
  constructor() {
    super('Workspace-host initialization request rejected');
    this.name = 'WorkspaceHostInitializationRequestError';
  }
}

export async function prepareWorkspaceHostInitialization(
  input: WorkspaceHostInitializationAdmission,
): Promise<AdmittedWorkspaceHostInitialization> {
  // Configuration and local intent checks retain the API's 404/409/501/503 distinctions.
  resolveWorkspaceHostInitializationControllerProfile();
  const lookup = await readWorkspaceHostDesiredSpec(input.workspaceId, input.hostId);
  if (!lookup.desired) {
    throw new WorkspaceHostDesiredSpecUnavailableError(input.hostId, lookup.miss ?? 'no-recorded-spec');
  }
  const { releaseTaskId, ...contract } = input;
  const request = { ...contract, deliveryCapabilities: resolveWorkspaceHostDeliveryCapabilities(lookup.desired) };
  let plan;
  try {
    plan = planWorkspaceHostInitialization(request);
    // DBOS persists its input as well as the operation plan. Assert BOTH boundaries.
    assertWorkspaceHostSecretIsolation(request, 'workspaceHost.initialization.admission');
  } catch {
    throw new WorkspaceHostInitializationRequestError();
  }
  if (releaseTaskId === undefined) return request;
  // Refuse a release receipt that could never be written now, not after minutes of host work. The
  // durable run re-checks: the journal can move between this read and the run.
  await openWorkspaceHostInitializationRelease({
    releaseTaskId,
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    operationId: request.operationId,
    plan,
  });
  return { ...request, releaseTaskId };
}

export async function executeAdmittedWorkspaceHostInitialization(admitted: AdmittedWorkspaceHostInitialization) {
  const { releaseTaskId, ...request } = admitted;
  const plan = planWorkspaceHostInitialization(request);
  await beginWorkspaceHostOperation({
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    operationId: request.operationId,
    action: 'initialize',
    status: 'running',
    message: 'Resolving workspace-host initialization transport',
    request: plan,
  });
  const credentialMaterialSource = createOperatorWorkspaceHostCredentialMaterialSource();
  // Host-key discovery and credential probes may take minutes; they belong in the durable job.
  const { operations, deliveryCapabilities } = await resolveWorkspaceHostInitializationOperationsForHost({
    workspaceId: request.workspaceId,
    hostId: request.hostId,
    controller: resolveWorkspaceHostInitializationControllerProfile(),
    credentialMaterialSource,
  });
  const result = await runWorkspaceHostInitialization({
    ...request,
    ...(releaseTaskId !== undefined ? { releaseTaskId } : {}),
    operations,
    deliveryCapabilities,
    credentialMaterialSource,
  });
  return { status: 'succeeded' as const, operationId: result.operationId, hostId: request.hostId };
}
