/**
 * Production assembly for workspace-host initialization (P-046 / WI-40474).
 *
 * Every piece of this flow already existed and was independently tested; nothing assembled
 * them, which is why `planWorkspaceHostInitialization` / `executeWorkspaceHostInitialization`
 * had zero production callers. This module is that assembly and deliberately contains no new
 * initialization logic of its own:
 *
 *   beginWorkspaceHostOperation(action:'initialize')   <- observability-store (migration 887/955)
 *     -> planWorkspaceHostInitialization(request)      <- contract library (validates + plans)
 *       -> ReplaySafeWorkspaceHostInitializationExecutor
 *            { operations: <host adapter, e.g. GcpIap...>, replayStore: <durable, migration 955> }
 *         -> executeWorkspaceHostInitialization(plan, executor)
 *           -> appendWorkspaceHostEvent / updateWorkspaceHostOperation per step
 *
 * Two ordering decisions here are load-bearing:
 *
 * 1. PLAN BEFORE RECORDING. `planWorkspaceHostInitialization` is what validates the request
 *    (contract version, ids, timestamps, credential-set coherence) and asserts secret
 *    isolation. Planning first means a malformed or secret-bearing request throws without
 *    leaving an orphaned `queued` operation row behind for an operation that never began.
 *
 * 2. PERSIST THE PLAN, NOT THE REQUEST. The request carries `credentialRefs` and
 *    `credentialDelivery`; only the PLAN is passed through
 *    `assertWorkspaceHostSecretIsolation` (by `executeWorkspaceHostInitialization`). So the
 *    plan is the artifact the library itself guarantees is free of secret material, and it is
 *    therefore the one safe to write to an operation row that is exported by the audit route.
 */
import { randomUUID } from 'node:crypto';
import {
  ReplaySafeWorkspaceHostInitializationExecutor,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  assertWorkspaceHostSecretIsolation,
  executeWorkspaceHostInitialization,
  planWorkspaceHostInitialization,
} from '@papercusp/deployment-driver';
import type {
  WorkspaceHostCredentialDeliverySet,
  WorkspaceHostCredentialRefs,
  WorkspaceHostDeliveryCapabilities,
  WorkspaceHostInitializationExecutor,
  WorkspaceHostInitializationHostOperations,
  WorkspaceHostInitializationPlan,
  WorkspaceHostInitializationRequest,
  WorkspaceHostInitializationSource,
  WorkspaceHostInitializationStepReceipt,
} from '@papercusp/deployment-driver';
import {
  assertWorkspaceHostAgentCredentialAdmissionEvidence,
  verifyWorkspaceHostAgentCredentialAdmission,
  type WorkspaceHostAgentCredentialAdmissionEvidence,
  type WorkspaceHostAgentCredentialAdmissionInput,
} from './agent-credential-admission';
import type { WorkspaceHostCredentialMaterialSource } from './credential-material-source';
import {
  openWorkspaceHostInitializationRelease,
  workspaceHostFixedAgentInitializationOutcome,
  workspaceHostRootBootstrapEvidenceRefs,
  WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
  type WorkspaceHostInitializationReleaseRecorder,
} from './initialization-release-receipt';
import { createWorkspaceHostInitializationReplayStore } from './initialization-replay-store';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  updateWorkspaceHostOperation,
} from './observability-store';

export interface WorkspaceHostInitializationRunInput {
  workspaceId: string;
  /** An ALREADY-PROVISIONED host. Initialization is a lifecycle action on it, not a provision. */
  hostId: string;
  /** Supply to resume/retry an interrupted run: the replay store keys off the operation id. */
  operationId?: string;
  requestedAt?: string;
  source: WorkspaceHostInitializationSource;
  credentialRefs: WorkspaceHostCredentialRefs;
  credentialDelivery: WorkspaceHostCredentialDeliverySet;
  requestedAgents?: WorkspaceHostInitializationRequest['requestedAgents'];
  /** Exact controller-side source shared with the host delivery adapter. */
  credentialMaterialSource: WorkspaceHostCredentialMaterialSource;
  /**
   * Additional exact-generation receipts already produced by a compound admission such as the
   * canary's rotated/restored generations. They are persisted beside this run's own receipt.
   */
  additionalCredentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
  /**
   * The executing provider's declared transport features — pass the provider's real profile
   * (`profile.transportProfile.features`) rather than a transcribed boolean. A provider declaring
   * `fileTransfer: false` is refused here, at plan time, instead of failing on a running host.
   */
  deliveryCapabilities: WorkspaceHostDeliveryCapabilities;
  /** Persistable labels only; secret-isolation asserted by the planner. */
  publicMetadata?: Readonly<Record<string, unknown>>;
  /** The concrete capability-declaring host adapter (e.g. GcpIapWorkspaceHostInitializationOperations). */
  operations: WorkspaceHostInitializationHostOperations;
  /**
   * The release this host runs, when the run is acceptance evidence for it: the run then records
   * `workspace.root-bootstrap` and `workspace.fixed-agent-initialization` on that release's journal
   * (initialization-release-receipt.ts). Explicit, never discovered from the host's digest.
   */
  releaseTaskId?: string;
  /** Stable controller identity for lease re-entrancy; defaults to this operation. */
  leaseOwner?: string;
  leaseTtlMs?: number;
  /**
   * Called once the request has been VALIDATED and its exact agent generation has passed
   * authentication admission, still before any operation row exists.
   *
   * This exposes the one boundary a caller cannot otherwise observe: a throw from this function
   * either means the request was rejected by the contract, or means execution against a real host
   * failed — and those deserve opposite answers at an API edge (the first is the caller's fault
   * and retrying it unchanged is pointless; the second is not). Without this seam a surface has to
   * guess from the error's shape, which is exactly the kind of inference that silently rots.
   */
  onPlanned?: (plan: WorkspaceHostInitializationPlan) => void;
  /** Test seam. */
  now?: () => Date;
}

export interface WorkspaceHostInitializationRunResult {
  operationId: string;
  plan: WorkspaceHostInitializationPlan;
  receipts: readonly WorkspaceHostInitializationStepReceipt[];
  credentialAdmission?: WorkspaceHostAgentCredentialAdmissionEvidence;
  credentialAdmissions?: readonly WorkspaceHostAgentCredentialAdmissionEvidence[];
}

export interface WorkspaceHostInitializationRunnerDependencies {
  verifyAgentCredentialAdmission: (
    input: WorkspaceHostAgentCredentialAdmissionInput,
  ) => Promise<WorkspaceHostAgentCredentialAdmissionEvidence>;
  openRelease: typeof openWorkspaceHostInitializationRelease;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostInitializationRunnerDependencies = {
  verifyAgentCredentialAdmission: verifyWorkspaceHostAgentCredentialAdmission,
  openRelease: openWorkspaceHostInitializationRelease,
};

/**
 * Run a workspace-host initialization end to end, durably and resumably.
 *
 * Re-invoking with the same `operationId` replays: steps already recorded as complete return
 * their prior receipt without re-executing against the host, so an interrupted controller
 * resumes rather than repeating side effects.
 */
export async function runWorkspaceHostInitialization(
  input: WorkspaceHostInitializationRunInput,
  overrides: Partial<WorkspaceHostInitializationRunnerDependencies> = {},
): Promise<WorkspaceHostInitializationRunResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const operationId = input.operationId ?? randomUUID();
  const requestedAt = input.requestedAt ?? new Date().toISOString();

  const request: WorkspaceHostInitializationRequest = {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    operationId,
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    requestedAt,
    source: input.source,
    credentialRefs: input.credentialRefs,
    credentialDelivery: input.credentialDelivery,
    ...(input.requestedAgents !== undefined ? { requestedAgents: input.requestedAgents } : {}),
    deliveryCapabilities: input.deliveryCapabilities,
    ...(input.publicMetadata ? { publicMetadata: input.publicMetadata } : {}),
  };

  // (1) Validate by planning, before any row exists. See module header.
  const plan = planWorkspaceHostInitialization(request);
  const totalSteps = plan.steps.length;
  const agentCredentialRef = input.credentialRefs.agentCredentialRef;
  const agentDelivery = input.credentialDelivery.agent;
  const credentialAdmission =
    agentCredentialRef && agentDelivery
      ? await dependencies.verifyAgentCredentialAdmission({
          credentialRef: agentCredentialRef,
          delivery: agentDelivery,
          materialSource: input.credentialMaterialSource,
          requestedAgents: input.requestedAgents,
        })
      : undefined;
  if (credentialAdmission && agentCredentialRef && agentDelivery) {
    assertWorkspaceHostAgentCredentialAdmissionEvidence(credentialAdmission, {
      credentialRef: agentCredentialRef,
      delivery: agentDelivery,
      requestedAgents: input.requestedAgents,
    });
  }
  for (const evidence of input.additionalCredentialAdmissions ?? []) {
    assertWorkspaceHostAgentCredentialAdmissionEvidence(evidence);
  }
  const credentialAdmissions = [
    ...(input.additionalCredentialAdmissions ?? []),
    ...(credentialAdmission ? [credentialAdmission] : []),
  ];
  const admissionBindings = new Set<string>();
  for (const evidence of credentialAdmissions) {
    const key = [
      evidence.binding.family,
      evidence.binding.generation,
      evidence.binding.referenceDigest,
    ].join(':');
    if (admissionBindings.has(key)) {
      throw new Error('workspace-host initialization received duplicate credential admission evidence');
    }
    admissionBindings.add(key);
  }
  // A release receipt that could never be written refuses the request here, read-only, before any
  // row exists — the same boundary as a malformed request (see `onPlanned`).
  let release: WorkspaceHostInitializationReleaseRecorder | undefined;
  if (input.releaseTaskId !== undefined) {
    if (!input.operations.awaitBootstrapReady) {
      throw new WorkspaceHostReleaseBindingError(
        'stage-unobservable',
        WORKSPACE_HOST_ROOT_BOOTSTRAP_STAGE,
        'this host adapter cannot observe bootstrap readiness',
      );
    }
    release = await dependencies.openRelease({
      releaseTaskId: input.releaseTaskId,
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      plan,
    });
  }
  input.onPlanned?.(plan);

  // (2) Persist the secret-isolated plan plus the CLOSED admission receipt. The receipt contains
  // only a public reference digest, generation and probe reason codes — never material bytes or a
  // digest of them. Keeping it on the operation request binds the successful probe to the exact
  // request an audit later reads, instead of leaving it as an ephemeral controller assertion.
  const persistedRequest =
    credentialAdmissions.length > 0 ? { ...plan, credentialAdmissions } : plan;
  assertWorkspaceHostSecretIsolation(persistedRequest, 'workspaceHost.initialization.admittedPlan');
  await beginWorkspaceHostOperation({
    workspaceId: input.workspaceId,
    operationId,
    hostId: input.hostId,
    action: 'initialize',
    status: 'running',
    percent: 0,
    message: `Initializing workspace host (${totalSteps} steps)`,
    request: persistedRequest,
  });

  let completedSteps = 0;

  try {
    // The durable workflow may already have recorded transport discovery. Enrich that same row
    // with the exact credential admission evidence instead of losing it to INSERT ON CONFLICT.
    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'running',
      percent: 0,
      message: `Initializing workspace host (${totalSteps} steps)`,
      request: { ...persistedRequest },
    });
    // Everything after beginWorkspaceHostOperation is inside the same failure boundary. Adapter
    // capability validation and replay-store setup can fail synchronously; if either does, the
    // operation row must become a durable failed operation rather than an apparently live 0%
    // orphan with no step/event evidence.
    const replayStore = createWorkspaceHostInitializationReplayStore({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      leaseOwner: input.leaseOwner ?? `workspace-host-initialization:${operationId}`,
      ...(input.leaseTtlMs !== undefined ? { leaseTtlMs: input.leaseTtlMs } : {}),
      ...(input.now ? { now: input.now } : {}),
    });

    const replaySafe = new ReplaySafeWorkspaceHostInitializationExecutor({
      operations: input.operations,
      replayStore,
    });

    /**
     * Progress reporting wraps the replay-safe executor rather than being folded into it: the
     * replay store must own execution-exactly-once, and timeline writes must NOT participate in
     * that ownership. A failure to append an event after a step has already succeeded therefore
     * cannot cause the step to re-run against the host — the receipt is already durable, so a
     * retry replays it.
     */
    const reportingExecutor: WorkspaceHostInitializationExecutor = {
      async execute(step) {
        const receipt = await replaySafe.execute(step);
        completedSteps += 1;

        await appendWorkspaceHostEvent({
          workspaceId: input.workspaceId,
          hostId: input.hostId,
          operationId,
          occurredAt: receipt.observedAt,
          phase: `initialize:${step.kind}`,
          status: 'running',
          level: 'info',
          source: 'controller',
          message: `Initialization step '${step.id}' (${step.kind}) succeeded`,
          details: {
            stepId: step.id,
            kind: step.kind,
            ...(receipt.publicEvidence ? { publicEvidence: receipt.publicEvidence } : {}),
          },
        });

        await updateWorkspaceHostOperation({
          workspaceId: input.workspaceId,
          operationId,
          status: 'running',
          // Capped below 100 so terminal completion is the only writer of 100.
          percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
          message: `Completed ${completedSteps}/${totalSteps}: ${step.kind}`,
        });

        return receipt;
      },
    };

    /**
     * Gate on the host's OWN bootstrap before touching step 1 (WI-10001677).
     *
     * `provision` reports success once the provider's resources exist, but the bootstrap it
     * delivered as instance startup metadata is still running — and it installs the programs
     * every step below invokes near the END of its work. Without this gate a prompt
     * initialization died on its first step with a bare
     * `exit 127 … No such file or directory`, which names a missing file and therefore reads as
     * a packaging defect in a bundle that was fine and verified every time.
     *
     * Placed INSIDE the failure boundary deliberately: a readiness timeout must land as a
     * durable failed operation carrying its own diagnosis, not as an apparently-live 0% orphan.
     * It runs before the first step so the message says "bootstrap did not finish" rather than
     * attributing the failure to whichever step happened to be first.
     *
     * Adapters that cannot probe their host omit the method, and absence means "no gate" — the
     * other providers do not yet consume a host bootstrap at all, so requiring one from them
     * would convert a capability they never declared into a refusal.
     */
    if (input.operations.awaitBootstrapReady) {
      await release?.begin('root-bootstrap');
      const readiness = await input.operations.awaitBootstrapReady({
        onWaiting: async ({ elapsedMs, timeoutMs }) => {
          await updateWorkspaceHostOperation({
            workspaceId: input.workspaceId,
            operationId,
            status: 'running',
            percent: 0,
            message:
              `Waiting for host bootstrap to finish (${Math.round(elapsedMs / 1000)}s of ` +
              `${Math.round(timeoutMs / 1000)}s)`,
          });
        },
      });
      // Emitted only when waiting was actually required, so the timeline records the race being
      // absorbed rather than adding a line to every initialization. `waitedMs` is the number that
      // says whether the default budget still matches reality.
      if (!readiness.readyImmediately) {
        await appendWorkspaceHostEvent({
          workspaceId: input.workspaceId,
          hostId: input.hostId,
          operationId,
          phase: 'initialize:bootstrap-ready',
          status: 'running',
          level: 'info',
          source: 'controller',
          message: `Host bootstrap became ready after ${Math.round(readiness.waitedMs / 1000)}s`,
          details: { waitedMs: readiness.waitedMs, probes: readiness.probes },
        });
      }
      await release?.settle(
        'root-bootstrap',
        'committed',
        workspaceHostRootBootstrapEvidenceRefs(input, readiness),
      );
    }

    await release?.begin('fixed-agents');
    const receipts = await executeWorkspaceHostInitialization(plan, reportingExecutor);
    if (release) {
      // Judged from the verify step's own agent evidence. An unconfirmed agent refuses the RECEIPT;
      // the initialization itself did succeed, so it is not reported as a failed operation.
      const fixedAgents = workspaceHostFixedAgentInitializationOutcome({
        subject: input,
        stage: release.stage('fixed-agents'),
        receipts,
        credentialAdmissions,
      });
      await release.settle('fixed-agents', fixedAgents.outcome, fixedAgents.evidenceRefs);
    }

    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'succeeded',
      percent: 100,
      message: `Workspace host initialization completed (${receipts.length} steps)`,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: 'initialize:complete',
      status: 'succeeded',
      level: 'info',
      source: 'controller',
      message: `Workspace host initialization completed (${receipts.length} steps)`,
      details: { stepIds: plan.steps.map((step) => step.id) },
    });

    return {
      operationId,
      plan,
      receipts,
      ...(credentialAdmission ? { credentialAdmission } : {}),
      ...(credentialAdmissions.length > 0 ? { credentialAdmissions } : {}),
    };
  } catch (error) {
    // Only the error's class name reaches the release journal: its message may quote host output.
    await release?.refuseOpen([
      `initialize-failure:${error instanceof Error ? error.name : 'unknown'}`,
      `initialize-completed-steps:${completedSteps}/${totalSteps}`,
    ]);
    // The thrown message may quote host output, so it is passed ONLY through `error`, which the
    // observability store redacts — never interpolated into the human-facing message field.
    await updateWorkspaceHostOperation({
      workspaceId: input.workspaceId,
      operationId,
      status: 'failed',
      percent: Math.min(99, Math.round((completedSteps / Math.max(totalSteps, 1)) * 100)),
      message: `Workspace host initialization failed after ${completedSteps}/${totalSteps} steps`,
      error,
    });
    await appendWorkspaceHostEvent({
      workspaceId: input.workspaceId,
      hostId: input.hostId,
      operationId,
      phase: 'initialize:failed',
      status: 'failed',
      level: 'error',
      source: 'controller',
      message: `Workspace host initialization failed after ${completedSteps}/${totalSteps} steps`,
      details: { completedSteps, totalSteps },
    });
    throw error;
  }
}
