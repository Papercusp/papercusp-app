/** POST /workspace-hosts/:hostId/credential-lifecycle — durable rotate/revoke/reconnect/rebind. */
import { defineTool } from '@papercusp/agent-mcp';
import {
  type WorkspaceHostCredentialLifecycleStep,
  type WorkspaceHostInitializationStep,
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
  runWorkspaceHostCredentialLifecycle,
  type WorkspaceHostCredentialLifecycleHostOperations,
  type WorkspaceHostCredentialLifecycleRunInput,
} from '../../../workspace-host/credential-lifecycle-runner';
import { GcpIapWorkspaceHostBootstrapNotReadyError } from '../../../workspace-host/gcp-iap-initialization-operations';

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

/**
 * How long this SYNCHRONOUS route holds the request open for the host's bootstrap (WI-10002499).
 * Sized from the measured post-upgrade recreate: create 21:59:00Z -> startup-script exit 0 at
 * 22:05:31Z (~6.5 min) on host-pc-p318-canary-20260922-r39. Deliberately below the adapter's
 * 20-minute initialization default: initialization is a durable 202 enqueue, this route is not,
 * and a stuck host should come back as a typed refusal the caller can retry rather than a
 * request held for twenty minutes.
 */
export const CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS = 10 * 60_000;
/**
 * Room for the lifecycle steps themselves once the gate opens: a six-step reconnect against a
 * ready host measured 29.5s and 29.9s (2026-09-22, r39), i.e. flush against the old 30s default.
 */
const CREDENTIAL_LIFECYCLE_STEPS_BUDGET_MS = 5 * 60_000;
/**
 * The route's own watchdog, DERIVED from the budgets it has to cover. Left at the route-stack's
 * 30s default, a reconnect that waited out a post-upgrade bootstrap and then SUCCEEDED came back
 * `408 route exceeded 30s` at t=294.9s (op p318-j1-reconnect-r39-20260922-5, 2026-09-22 22:37Z):
 * the stack discards a handler's response once its abort fires, so the caller was told the
 * reconnect failed after it had committed.
 */
export const CREDENTIAL_LIFECYCLE_ROUTE_TIMEOUT_SEC = Math.ceil(
  (CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS + CREDENTIAL_LIFECYCLE_STEPS_BUDGET_MS) / 1000,
);
const BOOTSTRAP_NOT_READY_RETRY_AFTER_SEC = 60;

interface LifecycleBody extends Record<string, unknown> {
  action?: unknown;
  operationId?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireObjects(
  body: LifecycleBody,
  fields: readonly string[],
): Response | undefined {
  const missing = fields.filter((field) => !isRecord(body[field]));
  return missing.length > 0
    ? Response.json(
        { ok: false, error: `missing or ill-typed required object field(s): ${missing.join(', ')}` },
        { status: 400 },
      )
    : undefined;
}

export interface WorkspaceHostCredentialLifecycleRouteDependencies {
  activeWorkspaceId: typeof activeWorkspaceId;
  resolveControllerProfile: typeof resolveWorkspaceHostInitializationControllerProfile;
  resolveOperationsForHost: typeof resolveWorkspaceHostInitializationOperationsForHost;
  runLifecycle: typeof runWorkspaceHostCredentialLifecycle;
}

const DEFAULT_DEPENDENCIES: WorkspaceHostCredentialLifecycleRouteDependencies = {
  activeWorkspaceId,
  resolveControllerProfile: resolveWorkspaceHostInitializationControllerProfile,
  resolveOperationsForHost: resolveWorkspaceHostInitializationOperationsForHost,
  runLifecycle: runWorkspaceHostCredentialLifecycle,
};

export function createWorkspaceHostCredentialLifecycleRoute(
  dependencies: WorkspaceHostCredentialLifecycleRouteDependencies = DEFAULT_DEPENDENCIES,
) {
  return defineTool({
    method: 'POST',
    path: '/workspace-hosts/:hostId/credential-lifecycle',
    auth: 'loopback',
    timeoutSec: CREDENTIAL_LIFECYCLE_ROUTE_TIMEOUT_SEC,
    async handler(req, ctx) {
      const hostId = String(ctx.params.hostId ?? '').trim();
      if (!SAFE_ID.test(hostId)) {
        return Response.json({ ok: false, error: 'invalid workspace host id' }, { status: 400 });
      }

      let body: LifecycleBody;
      try {
        body = (await req.json()) as LifecycleBody;
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
      }
      if (!isRecord(body)) {
        return Response.json({ ok: false, error: 'body must be an object' }, { status: 400 });
      }
      if (body.operationId !== undefined &&
          (typeof body.operationId !== 'string' || !SAFE_ID.test(body.operationId))) {
        return Response.json({ ok: false, error: 'invalid operationId' }, { status: 400 });
      }

      let shapeError: Response | undefined;
      switch (body.action) {
        case 'rotate':
          shapeError = requireObjects(body, [
            'currentCredentialRefs', 'currentDelivery', 'nextCredentialRefs', 'nextDelivery',
          ]);
          break;
        case 'revoke':
          shapeError = requireObjects(body, ['currentCredentialRefs', 'currentDelivery']);
          if (!shapeError &&
              (!Array.isArray(body.channels) || body.channels.some((channel) => typeof channel !== 'string'))) {
            shapeError = Response.json(
              { ok: false, error: 'channels must be an array of strings' },
              { status: 400 },
            );
          }
          break;
        case 'reconnect':
          shapeError = requireObjects(body, ['currentCredentialRefs', 'currentDelivery']);
          break;
        case 'restore-rebind':
          shapeError = requireObjects(body, ['backup', 'nextCredentialRefs', 'nextDelivery']);
          break;
        default:
          return Response.json(
            { ok: false, error: 'action must be rotate, revoke, reconnect, or restore-rebind' },
            { status: 400 },
          );
      }
      if (shapeError) return shapeError;

      const workspaceId = dependencies.activeWorkspaceId();
      let controller;
      try {
        controller = dependencies.resolveControllerProfile();
      } catch (error) {
        if (error instanceof WorkspaceHostInitializationControllerProfileError) {
          return Response.json(
            { ok: false, error: 'workspace-host credential lifecycle is not configured', problems: error.problems },
            { status: 503 },
          );
        }
        throw error;
      }

      let hostOperations;
      let deliveryCapabilities;
      try {
        ({ operations: hostOperations, deliveryCapabilities } = await dependencies.resolveOperationsForHost({
          workspaceId,
          hostId,
          controller,
          // D-216. A rotation's `bind` needs the NEW generation's material on the host exactly as
          // much as the first binding did, so the lifecycle route resolves a source too.
          credentialMaterialSource: createOperatorWorkspaceHostCredentialMaterialSource(),
        }));
      } catch (error) {
        if (error instanceof WorkspaceHostDesiredSpecUnavailableError) {
          return Response.json(
            {
              ok: false,
              error: error.reason === 'host-not-found'
                ? 'workspace host not found'
                : 'workspace host has no recorded provisioning intent',
              reason: error.reason,
            },
            { status: error.reason === 'host-not-found' ? 404 : 409 },
          );
        }
        if (error instanceof UnsupportedWorkspaceHostInitializationTargetError) {
          return Response.json(
            { ok: false, error: 'workspace-host credential lifecycle target is not implemented', target: error.target },
            { status: 501 },
          );
        }
        throw error;
      }

      const operations: WorkspaceHostCredentialLifecycleHostOperations = {
        async execute(step: WorkspaceHostCredentialLifecycleStep) {
          // Keep the planner shape intact until the concrete transport boundary. The GCP IAP
          // adapter owns lifecycle-on-initializer wire encoding; encoding here as well would make
          // it flatten an already-flattened step and silently drop channel/ref/delivery.
          return hostOperations.execute(
            step as unknown as WorkspaceHostInitializationStep,
          );
        },
        // Forwarded explicitly: this wrapper used to expose `execute` alone, which satisfied the
        // type (the gate is optional) while silently dropping it — the same dead-gate shape
        // gcp-iap-credential-delivery.ts documents for initialization (WI-10002499).
        ...(hostOperations.awaitBootstrapReady
          ? { awaitBootstrapReady: hostOperations.awaitBootstrapReady.bind(hostOperations) }
          : {}),
      };
      const common = {
        workspaceId,
        hostId,
        operations,
        deliveryCapabilities,
        bootstrapReadinessTimeoutMs: CREDENTIAL_LIFECYCLE_BOOTSTRAP_READINESS_TIMEOUT_MS,
        ...(typeof body.operationId === 'string' ? { operationId: body.operationId } : {}),
      };
      let planned = false;
      let operationId: string | undefined;

      try {
        let input: WorkspaceHostCredentialLifecycleRunInput;
        switch (body.action) {
          case 'rotate':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
              nextCredentialRefs: body.nextCredentialRefs as never,
              nextDelivery: body.nextDelivery as never,
            };
            break;
          case 'revoke':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
              channels: body.channels as never,
            };
            break;
          case 'reconnect':
            input = {
              ...common,
              action: body.action,
              currentCredentialRefs: body.currentCredentialRefs as never,
              currentDelivery: body.currentDelivery as never,
            };
            break;
          case 'restore-rebind':
            input = {
              ...common,
              action: body.action,
              backup: body.backup as never,
              nextCredentialRefs: body.nextCredentialRefs as never,
              nextDelivery: body.nextDelivery as never,
            };
            break;
        }
        input.onPlanned = (plan) => {
          planned = true;
          operationId = plan.operationId;
        };
        const result = await dependencies.runLifecycle(input);
        return Response.json({
          ok: true,
          operationId: result.operationId,
          hostId,
          action: result.plan.action,
          steps: result.plan.steps.map((step) => ({ id: step.id, kind: step.kind, channel: step.channel })),
          receipts: result.receipts.map((receipt) => ({
            stepId: receipt.stepId,
            channel: receipt.evidence.channel,
            operation: receipt.evidence.operation,
            generation: receipt.evidence.generation,
            referenceDigest: receipt.evidence.referenceDigest,
          })),
        });
      } catch (error) {
        if (!planned) {
          return Response.json(
            { ok: false, error: 'credential lifecycle request rejected' },
            { status: 422 },
          );
        }
        if (error instanceof GcpIapWorkspaceHostBootstrapNotReadyError) {
          // `answered` separates a host that kept saying "conduit not there yet" (bootstrap
          // unfinished: retryable, 503) from one that never gave a clean answer at all
          // (transport / OS Login / IAP: an upstream failure, 502, and waiting will not fix it).
          const unfinished = error.answered;
          return Response.json(
            {
              ok: false,
              error: unfinished
                ? 'workspace host bootstrap has not finished; retry once it completes'
                : 'workspace host was unreachable for the whole readiness window',
              reason: unfinished ? 'host-bootstrap-unfinished' : 'host-unreachable',
              hostId,
              operationId,
              waitedMs: error.waitedMs,
              probes: error.probes,
            },
            unfinished
              ? { status: 503, headers: { 'retry-after': String(BOOTSTRAP_NOT_READY_RETRY_AFTER_SEC) } }
              : { status: 502 },
          );
        }
        return Response.json(
          {
            ok: false,
            error: 'workspace host credential lifecycle failed; see the host timeline for details',
            hostId,
            operationId,
          },
          { status: 500 },
        );
      }
    },
  });
}

export default createWorkspaceHostCredentialLifecycleRoute();
