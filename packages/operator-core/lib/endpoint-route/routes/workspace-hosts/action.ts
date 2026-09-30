/** POST /workspace-hosts/action — durable lifecycle admission used by the cloud-workspaces UI. */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import {
  isWorkspaceHostOperationAcceptance,
  startWorkspaceHostDestroyWorkflow,
  startWorkspaceHostLifecycleWorkflow,
  WorkspaceHostProvisioningConflictError,
  type StartWorkspaceHostDestroyInput,
  type StartWorkspaceHostLifecycleInput,
} from '../../../dbos/workspace-host-provision-workflow';
import { workspaceHostAuditUrl } from '../../../workspace-host/admission-window';
import type {
  WorkspaceHostDesiredSpec,
  WorkspaceHostImageRef,
  WorkspaceHostSnapshotRef,
} from '@papercusp/deployment-driver';
import { dbosStarted } from '../../../dbos/bootstrap';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  readWorkspaceHostConnection,
  readWorkspaceHostDestroyTarget,
  type StoredWorkspaceHostConnection,
  type StoredWorkspaceHostDestroyTarget,
} from '../../../workspace-host/observability-store';
import {
  WorkspaceHostProvisioningConnectionError,
  WorkspaceHostProvisioningRequestError,
  WorkspaceHostProvisioningTransientError,
  validateWorkspaceHostCanaryAdmission,
  type WorkspaceHostCanaryAdmission,
  type WorkspaceHostDestroyCanaryEvidence,
} from '../../../workspace-host/provisioning-runner';
import {
  defaultWorkspaceHostRequestForwarder,
  type WorkspaceHostRequestForwarder,
} from '../../../workspace-host/controller-forwarding';
import { WorkspaceHostReleaseBindingError } from '../../../workspace-host/release-stage-receipt';
import {
  openWorkspaceHostTeardownRelease,
  workspaceHostTeardownBillingSubject,
  workspaceHostTeardownReleaseRefusal,
} from '../../../workspace-host/teardown-release-receipt';
import {
  recordWorkspaceHostCustomerAcceptance,
  WorkspaceHostCustomerAcceptanceError,
} from '../../../workspace-host/customer-acceptance-release-receipt';
import {
  recordWorkspaceHostReleaseCleanup,
  WorkspaceHostReleaseCleanupError,
} from '../../../workspace-host/release-cleanup-release-receipt';
import {
  recordWorkspaceHostReleaseShipment,
  WorkspaceHostReleaseShipmentError,
} from '../../../workspace-host/release-shipment-green-receipt';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface WorkspaceHostActionBody {
  action?: unknown;
  workspaceId?: unknown;
  disposition?: unknown;
  operationId?: unknown;
  confirmation?: unknown;
  canary?: unknown;
  name?: unknown;
  image?: unknown;
  rollbackImage?: unknown;
  snapshot?: unknown;
  desired?: unknown;
  /** Release task whose destroy, acceptance, or cleanup milestone is being recorded. */
  releaseTaskId?: unknown;
  /** Shipment only: the published prior release that should match the manifest rollback target. */
  rollbackReleaseTaskId?: unknown;
  /** Customer acceptance only: the active customer workspace attached to the hosted takeover. */
  customerWorkspaceId?: unknown;
  /** Customer acceptance only: exact authenticated hosted session and control channel. */
  hostedSessionId?: unknown;
  channelId?: unknown;
}

const LIFECYCLE_ACTIONS = ['start', 'stop', 'restart', 'repair', 'snapshot', 'upgrade', 'restore'] as const;
type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];
const CUSTOMER_ACCEPTANCE_ACTION = 'customer-acceptance';
const RELEASE_CLEANUP_ACTION = 'release-cleanup';
const RELEASE_SHIPMENT_ACTION = 'release-shipment';
const DESTROY_DISPOSITIONS = ['snapshot', 'backup', 'discard'] as const;
type DestroyDisposition = (typeof DESTROY_DISPOSITIONS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isCostEvidence(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.cents === 'number' &&
    typeof value.observedAt === 'string' &&
    typeof value.providerEvidenceRef === 'string' &&
    (value.reservationId === undefined || typeof value.reservationId === 'string')
  );
}

/**
 * A teardown after a FAILED canary run. It carries the audit context in place of the economic
 * evidence such a run can never produce; it waives nothing about identity.
 */
function isFailedRunTeardown(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.actorId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.procedureRef === 'string' &&
    Array.isArray(value.failedOperationIds) &&
    value.failedOperationIds.length > 0 &&
    value.failedOperationIds.every((entry) => typeof entry === 'string')
  );
}

/**
 * The spend has not settled with the provider yet (D-274). Orthogonal to authorization: it answers
 * "is the cost knowable at teardown time", which for a short-lived canary is normally NO.
 */
function isSpendSettlement(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.status === 'deferred' &&
    typeof value.actorId === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.procedureRef === 'string' &&
    typeof value.reconcileAfter === 'string' &&
    Number.isFinite(Date.parse(value.reconcileAfter))
  );
}

function parseCanaryEvidence(value: unknown): WorkspaceHostDestroyCanaryEvidence | null {
  if (!isRecord(value) || !isCostEvidence(value.preRunZeroBaseline)) return null;
  if (!Array.isArray(value.costEvidence) || !value.costEvidence.every(isCostEvidence)) return null;
  if (
    value.lateObservedSpend !== undefined &&
    (!Array.isArray(value.lateObservedSpend) || !value.lateObservedSpend.every(isCostEvidence))
  ) {
    return null;
  }
  if (
    value.emergencyManualDestroy !== undefined &&
    (!isRecord(value.emergencyManualDestroy) ||
      typeof value.emergencyManualDestroy.actorId !== 'string' ||
      typeof value.emergencyManualDestroy.reason !== 'string' ||
      typeof value.emergencyManualDestroy.procedureRef !== 'string')
  ) {
    return null;
  }
  if (value.failedRunTeardown !== undefined && !isFailedRunTeardown(value.failedRunTeardown)) return null;
  if (value.spendSettlement !== undefined && !isSpendSettlement(value.spendSettlement)) return null;
  if (value.failedRunTeardown !== undefined) {
    // The two authorizations are mutually exclusive: a request may not present an approved contract
    // report AND claim the run failed. Accepting both would make the audit record ambiguous about
    // which evidence the destroy was actually admitted on.
    if (value.contractApproval !== undefined) return null;
  } else if (
    !isRecord(value.contractApproval) ||
    value.contractApproval.status !== 'approved' ||
    typeof value.contractApproval.suiteVersion !== 'string' ||
    typeof value.contractApproval.reportRef !== 'string' ||
    typeof value.contractApproval.approvedBy !== 'string' ||
    typeof value.contractApproval.approvedAt !== 'string'
  ) {
    return null;
  }
  if (
    typeof value.runId !== 'string' ||
    typeof value.workspaceId !== 'string' ||
    typeof value.teardownDeadlineAt !== 'string' ||
    typeof value.budgetEvidenceRef !== 'string' ||
    (value.maxSpendCents !== undefined && typeof value.maxSpendCents !== 'number')
  ) {
    return null;
  }
  return value as unknown as WorkspaceHostDestroyCanaryEvidence;
}

export interface WorkspaceHostActionRouteDependencies {
  activeWorkspaceId: () => string;
  provisioningAvailable: () => boolean;
  readTarget: (workspaceId: string, hostId: string) => Promise<StoredWorkspaceHostDestroyTarget | null>;
  readConnection: (workspaceId: string, connectionId: string) => Promise<StoredWorkspaceHostConnection | null>;
  startDestroy: (input: StartWorkspaceHostDestroyInput) => ReturnType<typeof startWorkspaceHostDestroyWorkflow>;
  startLifecycle: (input: StartWorkspaceHostLifecycleInput) => ReturnType<typeof startWorkspaceHostLifecycleWorkflow>;
  forwardRequest?: WorkspaceHostRequestForwarder;
  /** Read-only admission check for a destroy's census receipt; defaults to the real journal. */
  openTeardownRelease?: typeof openWorkspaceHostTeardownRelease;
  /** Record a customer-controlled hosted desktop takeover against its exact release task. */
  recordCustomerAcceptance?: typeof recordWorkspaceHostCustomerAcceptance;
  /** Measure D-396's release cleanup predicate and record it on the exact release task. */
  recordReleaseCleanup?: typeof recordWorkspaceHostReleaseCleanup;
  /** Verify green-main shipment and the published rollback target on the exact release task. */
  recordReleaseShipment?: typeof recordWorkspaceHostReleaseShipment;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostActionRouteDependencies = {
  activeWorkspaceId,
  provisioningAvailable: dbosStarted,
  readTarget: readWorkspaceHostDestroyTarget,
  readConnection: readWorkspaceHostConnection,
  startDestroy: startWorkspaceHostDestroyWorkflow,
  startLifecycle: startWorkspaceHostLifecycleWorkflow,
  recordCustomerAcceptance: recordWorkspaceHostCustomerAcceptance,
  recordReleaseCleanup: recordWorkspaceHostReleaseCleanup,
  recordReleaseShipment: recordWorkspaceHostReleaseShipment,
};

function requestError(error: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, message: error, ...extra }, { status });
}

export function createWorkspaceHostActionRoute(
  dependencies: WorkspaceHostActionRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/action',
    auth: 'loopback',
    async handler(req) {
      let body: WorkspaceHostActionBody;
      try {
        body = (await req.json()) as WorkspaceHostActionBody;
      } catch {
        return requestError('invalid json');
      }
      if (!isRecord(body)) return requestError('body must be an object');
      const action = typeof body.action === 'string' ? body.action : '';
      if (
        action !== 'destroy' &&
        action !== CUSTOMER_ACCEPTANCE_ACTION &&
        action !== RELEASE_CLEANUP_ACTION &&
        action !== RELEASE_SHIPMENT_ACTION &&
        !LIFECYCLE_ACTIONS.includes(action as LifecycleAction)
      ) {
        return requestError('workspace-host lifecycle action is not implemented', 501, {
          action: action || null,
        });
      }

      const hostId = typeof body.workspaceId === 'string' ? body.workspaceId.trim() : '';
      if (!SAFE_ID.test(hostId)) return requestError('invalid workspaceId');
      if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return requestError('invalid operationId');
      }
      if (body.releaseTaskId !== undefined) {
        if (
          action !== 'destroy' &&
          action !== CUSTOMER_ACCEPTANCE_ACTION &&
          action !== RELEASE_CLEANUP_ACTION &&
          action !== RELEASE_SHIPMENT_ACTION
        ) {
          return requestError(
            'releaseTaskId is recorded only by a destroy, customer acceptance, release cleanup, or release shipment',
          );
        }
        if (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId)) {
          return requestError('releaseTaskId has an invalid value');
        }
      }
      if (action === CUSTOMER_ACCEPTANCE_ACTION) {
        if (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId)) {
          return requestError('customer acceptance requires a valid releaseTaskId');
        }
        for (const [field, value] of [
          ['customerWorkspaceId', body.customerWorkspaceId],
          ['hostedSessionId', body.hostedSessionId],
          ['channelId', body.channelId],
        ] as const) {
          if (typeof value !== 'string' || !value.trim() || value.length > 300) {
            return requestError(`customer acceptance requires a valid ${field}`);
          }
        }
      }
      if (action === RELEASE_CLEANUP_ACTION && (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId))) {
        return requestError('release cleanup requires a valid releaseTaskId');
      }
      if (body.rollbackReleaseTaskId !== undefined) {
        if (action !== RELEASE_SHIPMENT_ACTION) {
          return requestError('rollbackReleaseTaskId is recorded only by a release shipment');
        }
        if (typeof body.rollbackReleaseTaskId !== 'string' || !TASK_ID.test(body.rollbackReleaseTaskId)) {
          return requestError('rollbackReleaseTaskId has an invalid value');
        }
      }
      // D-437: rollbackReleaseTaskId is optional here; the receipt decides whether the current
      // manifest's declared rollback edge (or a genuine first green shipment) makes it required.
      if (
        action === RELEASE_SHIPMENT_ACTION &&
        (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId))
      ) {
        return requestError('release shipment requires a valid releaseTaskId');
      }
      let destroyAdmission:
        | {
            disposition: DestroyDisposition;
            expectedHostId: string;
            confirmedBy: string;
            confirmedAt: string;
            canary?: WorkspaceHostDestroyCanaryEvidence;
          }
        | undefined;
      if (action === 'destroy') {
        if (!DESTROY_DISPOSITIONS.includes(body.disposition as DestroyDisposition)) {
          return requestError('destroy disposition must be snapshot, backup, or discard', 422);
        }
        if (!isRecord(body.confirmation)) return requestError('destroy confirmation is required');
        const expectedHostId =
          typeof body.confirmation.expectedHostId === 'string' ? body.confirmation.expectedHostId.trim() : '';
        const confirmedBy = typeof body.confirmation.confirmedBy === 'string' ? body.confirmation.confirmedBy.trim() : '';
        const confirmedAt = typeof body.confirmation.confirmedAt === 'string' ? body.confirmation.confirmedAt.trim() : '';
        if (expectedHostId !== hostId || !confirmedBy || !Number.isFinite(Date.parse(confirmedAt))) {
          return requestError('destroy confirmation must name this host, an actor, and an ISO timestamp');
        }
        const canary = body.canary === undefined ? undefined : parseCanaryEvidence(body.canary);
        if (body.canary !== undefined && !canary) return requestError('destroy canary evidence is malformed');
        if (canary && body.disposition !== 'discard') {
          return requestError('canary destroy requires disposition=discard', 422);
        }
        if (body.releaseTaskId !== undefined) {
          const refusal = workspaceHostTeardownReleaseRefusal(canary);
          if (refusal) return requestError(refusal);
        }
        destroyAdmission = {
          disposition: body.disposition as DestroyDisposition,
          expectedHostId,
          confirmedBy,
          confirmedAt,
          ...(canary ? { canary } : {}),
        };
      }
      const workspaceId = dependencies.activeWorkspaceId();
      if (action === CUSTOMER_ACCEPTANCE_ACTION) {
        try {
          const receipt = await (dependencies.recordCustomerAcceptance ?? recordWorkspaceHostCustomerAcceptance)({
            workspaceId,
            hostId,
            releaseTaskId: body.releaseTaskId as string,
            customerWorkspaceId: body.customerWorkspaceId as string,
            hostedSessionId: body.hostedSessionId as string,
            channelId: body.channelId as string,
          });
          return Response.json({ ok: true, receipt });
        } catch (error) {
          if (error instanceof WorkspaceHostCustomerAcceptanceError) {
            return requestError('workspace-host customer acceptance was not verified', 409, {
              reason: error.reason,
            });
          }
          if (error instanceof WorkspaceHostReleaseBindingError) {
            return requestError('workspace-host customer acceptance could not bind to the release', 409, {
              reason: error.reason,
            });
          }
          return requestError('workspace-host customer acceptance could not be recorded', 500);
        }
      }
      if (action === RELEASE_CLEANUP_ACTION) {
        try {
          const receipt = await (dependencies.recordReleaseCleanup ?? recordWorkspaceHostReleaseCleanup)({
            workspaceId,
            hostId,
            releaseTaskId: body.releaseTaskId as string,
          });
          return receipt.outcome === 'committed'
            ? Response.json({ ok: true, receipt })
            : requestError('workspace-host release cleanup requirements are not met', 409, { receipt });
        } catch (error) {
          if (error instanceof WorkspaceHostReleaseCleanupError) {
            return requestError('workspace-host release cleanup could not be verified', 409, { reason: error.reason });
          }
          if (error instanceof WorkspaceHostReleaseBindingError) {
            return requestError('workspace-host release cleanup could not bind to the release', 409, {
              reason: error.reason,
            });
          }
          return requestError('workspace-host release cleanup could not be recorded', 500);
        }
      }
      if (action === RELEASE_SHIPMENT_ACTION) {
        try {
          const receipt = await (dependencies.recordReleaseShipment ?? recordWorkspaceHostReleaseShipment)({
            workspaceId,
            hostId,
            releaseTaskId: body.releaseTaskId as string,
            rollbackReleaseTaskId: (body.rollbackReleaseTaskId as string | undefined) ?? null,
          });
          return receipt.outcome === 'committed'
            ? Response.json({ ok: true, receipt })
            : requestError('workspace-host release shipment requirements are not met', 409, { receipt });
        } catch (error) {
          if (error instanceof WorkspaceHostReleaseShipmentError) {
            return requestError('workspace-host release shipment could not be verified', 409, {
              reason: error.reason,
            });
          }
          if (error instanceof WorkspaceHostReleaseBindingError) {
            return requestError('workspace-host release shipment could not bind to the release', 409, {
              reason: error.reason,
            });
          }
          return requestError('workspace-host release shipment could not be recorded', 500);
        }
      }
      if (!dependencies.provisioningAvailable()) {
        try {
          const forwarded = await (dependencies.forwardRequest ?? defaultWorkspaceHostRequestForwarder)(
            '/api/workspace-hosts/action',
            body,
          );
          if (forwarded) return forwarded;
        } catch {
          // A controller transport failure is reported through the same typed 503
          // admission response as an undiscovered controller.
        }
        return requestError('workspace-host provisioning workflow is unavailable on this operator', 503);
      }

      const target = await dependencies.readTarget(workspaceId, hostId);
      if (!target) return requestError('workspace host not found', 404);
      const stored = await dependencies.readConnection(workspaceId, target.connectionId);
      if (!stored) return requestError('workspace-host connection not found', 404);
      // 'degraded' means the LAST INSPECTION could not reach the provider, not that the connection
      // is bad — and the runner re-validates it live before it mutates anything, so that fresh read
      // is the authority here. Refusing on a stale cached status would let one transport blip during
      // an unrelated inspection lock every later lifecycle action out (WI-1743793).
      if (stored.status !== 'connected' && stored.status !== 'degraded') {
        return requestError('workspace-host connection is not ready', 409, {
          status: stored.status,
          ...(stored.statusDetail ? { detail: stored.statusDetail } : {}),
        });
      }
      if (stored.target !== target.target || target.target !== 'gcp') {
        return requestError('workspace-host lifecycle target is not implemented', 501, { target: target.target });
      }

      try {
        const releaseTaskId = typeof body.releaseTaskId === 'string' ? body.releaseTaskId : undefined;
        const restoreCanary = action === 'restore' ? body.canary as WorkspaceHostCanaryAdmission | undefined : undefined;
        if (action === 'restore' && isRecord(body.desired)) {
          validateWorkspaceHostCanaryAdmission({
            workspaceId,
            desired: body.desired as unknown as WorkspaceHostDesiredSpec,
            connection: stored.connection,
            canary: restoreCanary,
            sourceLabels: target.desired.labels,
          });
        }
        // A census receipt names the destroy it came from, so the operation id is fixed HERE when
        // one is recorded: the admission check and the durable run must agree on it.
        const operationId =
          typeof body.operationId === 'string' ? body.operationId : releaseTaskId !== undefined ? randomUUID() : undefined;
        if (releaseTaskId !== undefined) {
          await (dependencies.openTeardownRelease ?? openWorkspaceHostTeardownRelease)({
            releaseTaskId,
            workspaceId,
            hostId,
            operationId: operationId!,
            billing: workspaceHostTeardownBillingSubject(destroyAdmission!.canary!),
          });
        }
        const common = {
          workspaceId,
          hostId,
          connection: { ...stored.connection, scope: target.desired.scope },
          ...(operationId !== undefined ? { operationId } : {}),
        };
        const result = action === 'destroy'
          ? await dependencies.startDestroy({
              ...common,
              connectionId: target.connectionId,
              disposition: destroyAdmission!.disposition,
              confirmation: {
                expectedHostId: destroyAdmission!.expectedHostId,
                confirmedBy: destroyAdmission!.confirmedBy,
                confirmedAt: destroyAdmission!.confirmedAt,
              },
              ...(destroyAdmission!.canary ? { canary: destroyAdmission!.canary } : {}),
              ...(releaseTaskId !== undefined ? { releaseTaskId } : {}),
              actorId: destroyAdmission!.confirmedBy,
            })
          : await dependencies.startLifecycle({
              ...common,
              action: action as LifecycleAction,
              ...(typeof body.name === 'string' && body.name.trim() ? { name: body.name.trim() } : {}),
              ...(isRecord(body.image) ? { image: body.image as unknown as WorkspaceHostImageRef } : {}),
              ...(isRecord(body.rollbackImage)
                ? { rollbackImage: body.rollbackImage as unknown as WorkspaceHostImageRef }
                : {}),
              ...(isRecord(body.snapshot) ? { snapshot: body.snapshot as unknown as WorkspaceHostSnapshotRef } : {}),
              ...(isRecord(body.desired) ? { desired: body.desired as unknown as WorkspaceHostDesiredSpec } : {}),
              ...(restoreCanary ? { canary: restoreCanary } : {}),
            });
        if (isWorkspaceHostOperationAcceptance(result)) {
          // Durably enqueued but still queued or running after the admission window: a 202 with
          // the operation id, never a request held open past every upstream deadline
          // (EI-23712230399040759). A 202 confirms acceptance, not the outcome.
          const auditUrl = workspaceHostAuditUrl(result.hostId);
          return Response.json(
            {
              ok: true,
              status: 'accepted',
              operationId: result.operationId,
              hostId: result.hostId,
              auditUrl,
              message: `Workspace-host ${action} accepted; follow the host timeline for progress`,
            },
            { status: 202, headers: { location: auditUrl } },
          );
        }
        const planId = 'plan' in result ? result.plan.planId : undefined;
        const resources = 'checkpoints' in result
          ? result.checkpoints.map((checkpoint) => ({
              logicalKey: checkpoint.logicalKey,
              state: checkpoint.state,
              attempts: checkpoint.attempts,
              ...(checkpoint.deletionConfirmation ? { deletionConfirmation: checkpoint.deletionConfirmation } : {}),
            }))
          : [];
        const resultMetadata = result as typeof result & {
          alreadyAbsent?: boolean;
          offboardedCustomerWorkspaceId?: string;
        };
        const requiresInitialization = 'requiresInitialization' in result ? result.requiresInitialization : undefined;
        const response = {
          ok: result.status !== 'failed',
          status: result.status,
          operationId: result.operationId,
          hostId: result.hostId,
          ...(planId ? { planId } : {}),
          resources,
          ...(resultMetadata.offboardedCustomerWorkspaceId
            ? {
                customerWorkspace: {
                  id: resultMetadata.offboardedCustomerWorkspaceId,
                  state: 'deleted',
                },
              }
            : {}),
          ...('retryAfterMs' in result && result.retryAfterMs !== undefined
            ? { retryAfterMs: result.retryAfterMs }
            : {}),
          ...('evidence' in result && result.evidence ? { evidence: result.evidence } : {}),
          // Read the runner's own verdict rather than re-deriving readiness from `action` here.
          // An initialization-invalidating action succeeds while leaving the host unable to serve
          // until initialization is run again (WI-2143797/WI-2146639). The runner already decided
          // that; a second copy of the rule here is what let the ledger and HTTP response disagree.
          ...(requiresInitialization ? { requiresInitialization: true } : {}),
          message: result.status === 'succeeded'
            ? action === 'destroy'
              ? resultMetadata.alreadyAbsent
                ? resultMetadata.offboardedCustomerWorkspaceId
                  ? 'Workspace host was already absent; its customer workspace was marked deleted'
                  : 'Workspace host is already absent'
                : resultMetadata.offboardedCustomerWorkspaceId
                  ? 'Workspace-host discard teardown completed; its customer workspace was marked deleted'
                  : 'Workspace-host discard teardown completed with terminal evidence'
              : requiresInitialization
                ? `Workspace-host ${action} completed its provider steps, but the host CANNOT SERVE yet: ` +
                  `${action} invalidated the host's initialized state, so initialization must be run again before use`
                : `Workspace-host ${action} completed`
            : result.status === 'in-progress'
              ? `Workspace-host ${action} is in progress`
              : `Workspace-host ${action} failed; see the host timeline for details`,
        };
        return Response.json(response, {
          status: result.status === 'succeeded' ? 200 : result.status === 'in-progress' ? 202 : 500,
        });
      } catch (error) {
        if (error instanceof WorkspaceHostReleaseBindingError) {
          return requestError(error.message, error.reason === 'task-not-found' ? 404 : 409, { reason: error.reason });
        }
        if (error instanceof WorkspaceHostProvisioningConflictError) {
          return requestError('workspace host already has an operation in progress', 409);
        }
        if (error instanceof WorkspaceHostProvisioningConnectionError) {
          return requestError('workspace-host connection validation failed', 409, { problems: error.problems });
        }
        if (error instanceof WorkspaceHostProvisioningTransientError) {
          // The provider API could not be reached, so the connection was never disproved. 503 (not
          // 409) so the caller retries instead of going to audit a credential that is fine.
          return requestError('workspace-host provider is temporarily unreachable', 503, {
            problems: error.problems,
            retryable: true,
          });
        }
        if (error instanceof WorkspaceHostProvisioningRequestError) {
          return requestError(`workspace-host ${action} request rejected`, 422, { problems: error.problems });
        }
        return requestError(`workspace-host ${action} failed; see the host timeline for details`, 500);
      }
    },
  });
}

export default createWorkspaceHostActionRoute();
