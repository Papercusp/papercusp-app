/**
 * Workspace-host soak (D-391): start one durable soak on the controller, and read any soak's
 * verdict straight from its persisted samples.
 *
 * POST is forwarded to the background controller like initialize/desktop-pack (only it runs DBOS);
 * the forwarder's pre-chosen `operationId` becomes the soak id, so a lost response still leaves an
 * id to look the soak up by. GET is a pure database read and answers on any host.
 */
import { randomUUID } from 'node:crypto';
import { defineTool } from '@papercusp/agent-mcp';
import { dbosStarted } from '../../../dbos/bootstrap';
import {
  WorkspaceHostSoakConflictError,
  startWorkspaceHostSoakWorkflow,
} from '../../../dbos/workspace-host-soak-workflow';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defaultWorkspaceHostRequestForwarder } from '../../../workspace-host/controller-forwarding';
import {
  UnsupportedWorkspaceHostInitializationTargetError,
  WorkspaceHostDesiredSpecUnavailableError,
  WorkspaceHostInitializationControllerProfileError,
} from '../../../workspace-host/initialization-operations-resolver';
import {
  DEFAULT_WORKSPACE_HOST_SOAK_POLICY,
  WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE,
  WorkspaceHostSoakPolicyError,
  WorkspaceHostSoakSubjectError,
  evaluateWorkspaceHostSoak,
  pinWorkspaceHostSoakSubject,
  resolveWorkspaceHostSoakPolicy,
  workspaceHostSoakQualifiesForAcceptance,
} from '../../../workspace-host/soak';
import { redactWorkspaceHostText } from '../../../workspace-host/observability-store';
import { resolveGcpWorkspaceHostSoakSeams } from '../../../workspace-host/soak-gcp';
import {
  WorkspaceHostReleaseBindingError,
  resolveWorkspaceHostReleaseBinding,
} from '../../../workspace-host/release-stage-receipt';
import { assertWorkspaceHostSoakReceiptWritable } from '../../../workspace-host/soak-receipt';
import {
  readLatestWorkspaceHostSoakId,
  readWorkspaceHostRuntimeRelease,
  readWorkspaceHostSoak,
} from '../../../workspace-host/soak-store';

const HOST_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SOAK_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const START_KEYS = new Set(['operationId', 'durationSec', 'intervalSec', 'releaseTaskId']);

function badRequest(error: string): Response {
  return Response.json({ ok: false, error }, { status: 400 });
}

function optionalSeconds(value: unknown, label: string): number | undefined | string {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return `${label} must be a positive integer number of seconds`;
  }
  return value * 1000;
}

const start = defineTool({
  method: 'POST', path: '/workspace-hosts/:hostId/soak', auth: 'loopback',
  async handler(req, ctx) {
    const hostId = String(ctx.params.hostId ?? '');
    if (!HOST_ID.test(hostId)) return badRequest('invalid workspace host id');
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { return badRequest('invalid json'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !START_KEYS.has(key))) {
      return badRequest(`soak accepts only ${[...START_KEYS].join(', ')}`);
    }
    if (body.operationId !== undefined && (typeof body.operationId !== 'string' || !SOAK_ID.test(body.operationId))) {
      return badRequest('operationId has an invalid value');
    }
    if (body.releaseTaskId !== undefined && (typeof body.releaseTaskId !== 'string' || !TASK_ID.test(body.releaseTaskId))) {
      return badRequest('releaseTaskId has an invalid value');
    }
    const durationMs = optionalSeconds(body.durationSec, 'durationSec');
    const intervalMs = optionalSeconds(body.intervalSec, 'intervalSec');
    if (typeof durationMs === 'string') return badRequest(durationMs);
    if (typeof intervalMs === 'string') return badRequest(intervalMs);

    const soakId = typeof body.operationId === 'string' ? body.operationId : randomUUID();
    const forwarded = await defaultWorkspaceHostRequestForwarder(`/api/workspace-hosts/${hostId}/soak`, {
      ...body,
      operationId: soakId,
    });
    if (forwarded) return forwarded;
    if (!dbosStarted()) {
      return Response.json({ ok: false, error: 'workspace-host durable controller unavailable', outcome: 'not-dispatched' }, { status: 503 });
    }

    const workspaceId = activeWorkspaceId();
    try {
      const policy = resolveWorkspaceHostSoakPolicy({
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
      });
      let releaseBinding = null;
      if (typeof body.releaseTaskId === 'string') {
        if (!workspaceHostSoakQualifiesForAcceptance(policy)) {
          return badRequest(`a soak shorter than ${DEFAULT_WORKSPACE_HOST_SOAK_POLICY.durationMs / 1000}s cannot record ${WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE}`);
        }
        releaseBinding = await resolveWorkspaceHostReleaseBinding({
          releaseTaskId: body.releaseTaskId,
          stage: WORKSPACE_HOST_SOAK_ACCEPTANCE_STAGE,
          hostRuntimeRelease: await readWorkspaceHostRuntimeRelease(workspaceId, hostId),
        });
        await assertWorkspaceHostSoakReceiptWritable(releaseBinding, policy);
      }
      // Preflight the pin so a host that cannot be soaked is refused now, not a step later in a
      // workflow nobody is watching. The workflow re-pins from its own read; this one is discarded.
      const seams = await resolveGcpWorkspaceHostSoakSeams({ workspaceId, hostId });
      pinWorkspaceHostSoakSubject({ workspaceId, hostId, soakId }, await seams.readInstance());

      const result = await startWorkspaceHostSoakWorkflow({ workspaceId, hostId, soakId, policy, releaseBinding });
      const statusUrl = `/api/workspace-hosts/${hostId}/soak?soakId=${encodeURIComponent(soakId)}`;
      return Response.json(
        { ok: true, ...result, policy, releaseTaskId: releaseBinding?.taskId ?? null, statusUrl },
        { status: 202, headers: { location: statusUrl } },
      );
    } catch (error) {
      if (error instanceof WorkspaceHostSoakPolicyError) return badRequest(error.message);
      if (error instanceof WorkspaceHostReleaseBindingError) {
        return Response.json({ ok: false, error: error.message, reason: error.reason }, { status: error.reason === 'task-not-found' ? 404 : 409 });
      }
      if (error instanceof WorkspaceHostSoakSubjectError) {
        return Response.json({ ok: false, error: error.message }, { status: 409 });
      }
      if (error instanceof WorkspaceHostSoakConflictError) {
        return Response.json({ ok: false, error: error.message, soakId }, { status: 409 });
      }
      if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
        return Response.json({ ok: false, error: error.message, reason: error.reason }, { status: error.reason === 'host-not-found' ? 404 : 409 });
      }
      if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
        return Response.json({ ok: false, error: error.message, target: error.target }, { status: 501 });
      }
      if (error instanceof WorkspaceHostInitializationControllerProfileError) {
        return Response.json({ ok: false, error: 'workspace-host controller is not configured', problems: error.problems }, { status: 503 });
      }
      // The caller gets a closed message; the cause goes to the controller log, redacted, so an
      // untyped refusal is diagnosable without reproducing it by hand.
      console.error(
        '[workspace-host-soak] admission failed',
        { hostId, soakId },
        redactWorkspaceHostText(error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000),
      );
      return Response.json({ ok: false, error: 'soak admission failed; check the host timeline before retrying', outcome: 'unknown', hostId, soakId }, { status: 500 });
    }
  },
});

const status = defineTool({
  method: 'GET', path: '/workspace-hosts/:hostId/soak', auth: 'loopback',
  async handler(req, ctx) {
    const hostId = String(ctx.params.hostId ?? '');
    if (!HOST_ID.test(hostId)) return badRequest('invalid workspace host id');
    const requested = new URL(req.url).searchParams.get('soakId');
    if (requested !== null && !SOAK_ID.test(requested)) return badRequest('soakId has an invalid value');
    const workspaceId = activeWorkspaceId();
    const soakId = requested ?? (await readLatestWorkspaceHostSoakId(workspaceId, hostId));
    if (!soakId) return Response.json({ ok: false, error: `workspace host '${hostId}' has no recorded soak` }, { status: 404 });
    const record = await readWorkspaceHostSoak(workspaceId, hostId, soakId);
    if (record.samples.length === 0 && record.malformedRows === 0) {
      return Response.json({ ok: false, error: `no samples recorded for soak '${soakId}'`, soakId }, { status: 404 });
    }
    const policy = record.envelope?.policy ?? DEFAULT_WORKSPACE_HOST_SOAK_POLICY;
    const evaluation = evaluateWorkspaceHostSoak({ samples: record.samples, policy });
    const lastSampleAgeMs = evaluation.window.last ? Date.now() - Date.parse(evaluation.window.last) : null;
    return Response.json({
      ok: true,
      hostId,
      soakId,
      releaseTaskId: record.envelope?.releaseTaskId ?? null,
      policy,
      malformedRows: record.malformedRows,
      lastSampleAgeMs,
      // A still-running soak whose sampler has gone quiet longer than the gap budget is already
      // failing; say so rather than reporting `running` for a soak nobody is taking samples for.
      stalled: evaluation.verdict === 'running' && lastSampleAgeMs !== null &&
        lastSampleAgeMs > policy.maxGapIntervals * policy.intervalMs,
      evaluation,
    });
  },
});

export default [start, status];
