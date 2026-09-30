/** POST /workspace-hosts/:hostId/canary — resumable production P-046 canary controller. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  WORKSPACE_HOST_CANARY_AGENTS,
  WorkspaceHostDestroyEvidenceError,
  workspaceHostCanaryIdentityProblems,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import { activeWorkspaceId } from '../../../workspace-registry';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
} from '../../../workspace-host/initialization-operations-resolver';
import { createOperatorWorkspaceHostCredentialMaterialSource } from '../../../workspace-host/credential-material-source';
import {
  runWorkspaceHostCanary,
  WorkspaceHostCanaryRunError,
  type WorkspaceHostCanaryRunInput,
  type WorkspaceHostCanaryRunResult,
} from '../../../workspace-host/canary-runner';
import { WorkspaceHostReleaseBindingError } from '../../../workspace-host/release-stage-receipt';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
// Same grammar as the initialize route's releaseTaskId, so the two entry points accept one set.
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

interface CanaryBody extends Record<string, unknown> {
  runId?: unknown;
  requestedAt?: unknown;
  source?: unknown;
  credentials?: unknown;
  requestedAgents?: unknown;
  destroyFinalization?: unknown;
  releaseTaskId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasCredentialGeneration(value: unknown): boolean {
  return isRecord(value) && isRecord(value.credentialRefs) && isRecord(value.delivery);
}

function hasCredentials(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasCredentialGeneration(value.initial) &&
    hasCredentialGeneration(value.rotated) &&
    // WI-10002402: reconnect needs its OWN strictly-increasing generation — the preceding revoke
    // kills the rotated one, so a payload without this cannot complete the lifecycle.
    hasCredentialGeneration(value.reconnected) &&
    hasCredentialGeneration(value.restored)
  );
}

/**
 * Mirrors `resolveWorkspaceHostRequestedAgents` so a bad scope is refused as a 400 here rather than
 * surfacing as a 500 from deep inside the driver. Narrowing the set SKIPS the omitted agent — it
 * never marks one ready (D-338 supersedes the all-ready requirement only for the Codex leg).
 */
function requestedAgentsProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const invalid = 'requestedAgents must be a nonempty array of distinct claude, codex, or omp agents';
  if (!Array.isArray(value) || value.length === 0) return invalid;
  if (new Set(value).size !== value.length) return invalid;
  if (value.some((agent) => !WORKSPACE_HOST_CANARY_AGENTS.includes(agent as never))) return invalid;
  return undefined;
}

function hasDestroyFinalization(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    Array.isArray(value.credentialTeardown) &&
    isRecord(value.teardown) &&
    isRecord(value.destroyEvidence)
  );
}

export interface WorkspaceHostCanaryRouteDependencies {
  activeWorkspaceId: typeof activeWorkspaceId;
  resolveControllerProfile: typeof resolveWorkspaceHostInitializationControllerProfile;
  resolveOperationsForHost: typeof resolveWorkspaceHostInitializationOperationsForHost;
  runCanary: typeof runWorkspaceHostCanary;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostCanaryRouteDependencies = {
  activeWorkspaceId,
  resolveControllerProfile: resolveWorkspaceHostInitializationControllerProfile,
  resolveOperationsForHost: resolveWorkspaceHostInitializationOperationsForHost,
  runCanary: runWorkspaceHostCanary,
};

function requestError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, ...extra }, { status });
}

function summarize(result: WorkspaceHostCanaryRunResult) {
  return [
    {
      phase: 'initialize' as const,
      operationId: result.initialization.operationId,
      steps: result.initialization.plan.steps.map((step) => ({ id: step.id, kind: step.kind })),
      receiptStepIds: result.initialization.receipts.map((receipt) => receipt.stepId),
    },
    ...result.lifecycle.map(({ phase, result: lifecycle }) => ({
      phase,
      operationId: lifecycle.operationId,
      action: lifecycle.plan.action,
      steps: lifecycle.plan.steps.map((step) => ({
        id: step.id,
        kind: step.kind,
        channel: step.channel,
      })),
      receiptStepIds: lifecycle.receipts.map((receipt) => receipt.stepId),
    })),
  ];
}

export function createWorkspaceHostCanaryRoute(
  dependencies: WorkspaceHostCanaryRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/canary',
    auth: 'loopback',
    // The route-stack default is a 30s watchdog, which this route CANNOT satisfy: it drives a real
    // five-phase cloud credential lifecycle against a live host (measured 2026-09-22 — 72s for the
    // reconnect + restore-rebind legs, ~35s to merely REPLAY a complete run from stored receipts).
    // That mattered more than a slow request: the assembled evidence/validation/backupManifest is
    // never persisted (workspace_host_operations keeps only `request`/`error`), so the response is
    // its SOLE carrier — a 30s abort made a green 5/5 run's evidence structurally unobtainable,
    // and re-POSTing to recover it hit the same wall every time. Peer precedent for a long-running
    // route: cupboard-install-plugin (120s), zero-harness/sse (null).
    timeoutSec: 1800,
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!SAFE_ID.test(hostId)) return requestError('invalid workspace host id', 400);

      let body: CanaryBody;
      try {
        body = (await req.json()) as CanaryBody;
      } catch {
        return requestError('invalid json', 400);
      }
      if (!isRecord(body)) return requestError('body must be an object', 400);
      if (typeof body.runId !== 'string' || !SAFE_ID.test(body.runId)) {
        return requestError('invalid runId', 400);
      }
      if (typeof body.requestedAt !== 'string' || !Number.isFinite(Date.parse(body.requestedAt))) {
        return requestError('requestedAt must be an ISO timestamp', 400);
      }
      if (!isRecord(body.source)) return requestError('source must be an object', 400);
      if (!hasCredentials(body.credentials)) {
        return requestError(
          'credentials must contain initial, rotated, reconnected, and restored credentialRefs/delivery objects',
          400,
        );
      }
      const agentScopeProblem = requestedAgentsProblem(body.requestedAgents);
      if (agentScopeProblem) return requestError(agentScopeProblem, 400);
      if (body.releaseTaskId !== undefined && (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId))) {
        return requestError('releaseTaskId has an invalid value', 400);
      }
      const releaseTaskId = typeof body.releaseTaskId === 'string' ? body.releaseTaskId : undefined;
      if (body.destroyFinalization !== undefined && !hasDestroyFinalization(body.destroyFinalization)) {
        return requestError(
          'destroyFinalization requires operationId, credentialTeardown, teardown, and destroyEvidence',
          400,
        );
      }

      const workspaceId = dependencies.activeWorkspaceId();
      let controller;
      try {
        controller = dependencies.resolveControllerProfile();
      } catch (error) {
        if (error instanceof WorkspaceHostInitializationControllerProfileError) {
          return requestError('workspace-host canary is not configured', 503, {
            problems: error.problems,
          });
        }
        throw error;
      }

      let desired: WorkspaceHostDesiredSpec;
      let operations;
      let deliveryCapabilities;
      const credentialMaterialSource = createOperatorWorkspaceHostCredentialMaterialSource();
      try {
        ({ desired, operations, deliveryCapabilities } = await dependencies.resolveOperationsForHost({
          workspaceId,
          hostId,
          controller,
          // D-216. The canary binds git and agent, both of which require delivered material, so
          // without this the run refuses at its first binding step naming the missing store keys —
          // which is the intended pre-flight signal, not a failure discovered on a running VM.
          credentialMaterialSource,
        }));
      } catch (error) {
        if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
          return requestError(
            error.reason === 'host-not-found'
              ? 'workspace host not found'
              : 'workspace host has no recorded provisioning intent',
            error.reason === 'host-not-found' ? 404 : 409,
            { reason: error.reason },
          );
        }
        if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
          return requestError('workspace-host canary target is not implemented', 501, {
            target: error.target,
          });
        }
        throw error;
      }

      // IDENTITY preflight. The destroy gate will demand exactly these labels in the stored spec,
      // and nothing after this point can add them — so a host that fails here is one this run
      // could drive to completion and then be unable to retire through the product route at all.
      // Refusing now costs a rejected request; refusing at teardown costs a billing VM that only
      // an out-of-band script can delete. Provisioning declares the run (`canary.runId`); this
      // checks that the host in front of us is the one that declaration produced.
      const identityProblems = workspaceHostCanaryIdentityProblems(desired.labels, {
        runId: body.runId,
        workspaceId,
      });
      if (identityProblems.length > 0) {
        return requestError('workspace host is not provisioned as a canary for this run', 422, {
          problems: identityProblems,
        });
      }

      let phaseStarted = false;
      try {
        const result = await dependencies.runCanary({
          runId: body.runId,
          workspaceId,
          hostId,
          requestedAt: body.requestedAt,
          ...(releaseTaskId !== undefined ? { releaseTaskId } : {}),
          source: body.source as never,
          credentials: body.credentials as never,
          ...(body.requestedAgents !== undefined
            ? { requestedAgents: body.requestedAgents as never }
            : {}),
          operations,
          deliveryCapabilities,
          credentialMaterialSource,
          ...(body.destroyFinalization ? { destroyFinalization: body.destroyFinalization as never } : {}),
          onPhaseStart: () => {
            phaseStarted = true;
          },
        } satisfies WorkspaceHostCanaryRunInput);

        return Response.json({
          ok: true,
          status: result.adaptedDestroyEvidence ? 'destroy-verified' : 'ready-for-destroy',
          runId: result.runId,
          workspaceId: result.workspaceId,
          hostId: result.hostId,
          requestedAt: result.requestedAt,
          releaseTaskId: releaseTaskId ?? null,
          operationIds: result.operationIds,
          phases: summarize(result),
          evidence: result.assembly.evidence,
          validation: result.assembly.validation,
          backupManifest: result.backupManifest,
          ...(result.adaptedDestroyEvidence ? { adaptedDestroyEvidence: result.adaptedDestroyEvidence } : {}),
        });
      } catch (error) {
        if (error instanceof WorkspaceHostDestroyEvidenceError) {
          return requestError('destroy evidence rejected', 422, { problems: error.problems });
        }
        if (error instanceof WorkspaceHostCanaryRunError) {
          return requestError('workspace-host canary request rejected', 422, { problems: error.problems });
        }
        // Thrown by the initialize phase BEFORE any row exists: the named release is not what this
        // host runs (or cannot take the stage). Its message names journal facts, never credential
        // material, so it is surfaced exactly as the initialize route surfaces it.
        if (error instanceof WorkspaceHostReleaseBindingError) {
          return requestError(error.message, error.reason === 'task-not-found' ? 404 : 409, { reason: error.reason });
        }
        if (!phaseStarted) {
          // The RESPONSE stays opaque deliberately: an untyped preflight error may carry
          // provider, credential or remote-output detail, and canary.test.ts pins that it
          // must not reach the caller. But discarding it entirely left a preflight fault
          // undiagnosable from either side — a bare 422 with no record anywhere. Record it
          // server-side (peer-route convention) while the response contract is unchanged.
          console.error(
            `[workspace-host-canary] preflight rejected for ${hostId} before any phase started:`,
            error,
          );
          return requestError('workspace-host canary request rejected', 422);
        }
        console.error(
          `[workspace-host-canary] run failed for ${hostId} after a phase started:`,
          error,
        );
        return requestError('workspace-host canary failed; see the host timeline for details', 500, { hostId });
      }
    },
  });
}

export default createWorkspaceHostCanaryRoute();
