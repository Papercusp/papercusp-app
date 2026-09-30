import { randomUUID } from 'node:crypto';
import {
  collectSiblingManagedTimers,
  DEFAULT_SIBLING_FANOUT_BUDGET_MS,
  listSiblingOperators,
  type SiblingManagedTimers,
  type SiblingOperator,
} from '../schedule-federation';
import { requestOnlyHost } from '../background-workers';
import { WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS } from './admission-window';

export type WorkspaceHostRequestPath =
  | '/api/workspace-hosts/action'
  | '/api/workspace-hosts/provision'
  | `/api/workspace-hosts/${string}/initialize`
  | `/api/workspace-hosts/${string}/desktop-pack`
  | `/api/workspace-hosts/${string}/soak`;

export type WorkspaceHostRequestForwarder = (
  path: WorkspaceHostRequestPath,
  body: unknown,
) => Promise<Response | null>;

export interface WorkspaceHostControllerForwardingOptions {
  isRequestOnly?: () => boolean;
  collectControllers?: (options: { timeoutMs: number; budgetMs: number }) => Promise<readonly SiblingManagedTimers[]>;
  listControllerRegistrations?: () => Promise<readonly SiblingOperator[]>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS = WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS;
export const DEFAULT_WORKSPACE_HOST_CONTROLLER_DISCOVERY_TIMEOUT_MS =
  DEFAULT_SIBLING_FANOUT_BUDGET_MS - 200;

function isDirectBackgroundController(row: SiblingManagedTimers): boolean {
  return (
    row.ok &&
    row.process === 'bg-host' &&
    !row.label.includes('(primary via :')
  );
}

function selectController(rows: readonly SiblingManagedTimers[]): SiblingManagedTimers | null {
  return (
    rows
      .filter(isDirectBackgroundController)
      .sort((a, b) => a.port - b.port)[0] ?? null
  );
}

/** Keep discovery failures distinguishable from a mutation whose response was lost. */
function controllerUnavailable(
  reason: 'discovery-failed' | 'no-controller' | 'controller-probe-timeout',
  rows: readonly SiblingManagedTimers[] = [],
): Response {
  const candidates = rows.slice(0, 8).map((row) => ({
    port: row.port,
    pid: row.pid,
    role: row.process === 'bg-host' || row.process === 'operator' ? row.process : 'unknown',
    reachable: row.ok,
    direct: !row.label.includes('(primary via :'),
    elapsedMs: row.elapsedMs,
  }));
  return Response.json({
    ok: false,
    error: 'workspace-host background controller unavailable',
    outcome: 'not-dispatched',
    controllerDiscovery: { reason, candidates, omittedCandidates: rows.length - candidates.length },
  }, { status: 503 });
}

/**
 * Request-only operator hosts (:3170 and clustered request workers) do not launch
 * DBOS. Prefer the process role already published in the per-port IPC registry so
 * a busy bg-host event loop cannot make a live controller look absent. Legacy
 * registrations still use the bounded loopback role probe before forwarding.
 */
export async function forwardWorkspaceHostRequest(
  path: WorkspaceHostRequestPath,
  body: unknown,
  options: WorkspaceHostControllerForwardingOptions = {},
): Promise<Response | null> {
  const isRequestOnly = options.isRequestOnly ?? (() => requestOnlyHost());
  if (!isRequestOnly()) return null;

  const listControllerRegistrations = options.listControllerRegistrations ??
    (options.collectControllers ? async () => [] : listSiblingOperators);
  let registrations: readonly SiblingOperator[] = [];
  try {
    registrations = await listControllerRegistrations();
  } catch {
    // Keep the bounded legacy discovery path available if local registration lookup fails.
  }
  const registeredController = registrations
    .filter((row) => row.processRole === 'bg-host')
    .sort((a, b) => a.port - b.port)[0] ?? null;
  let controllerPort = registeredController?.port;

  if (controllerPort === undefined && registrations.length > 0 && registrations.every((row) => row.processRole)) {
    return controllerUnavailable('no-controller', registrations.map((row) => ({
      port: row.port,
      pid: row.pid,
      label: `${row.processRole}:${row.port}`,
      process: row.processRole ?? null,
      ok: true,
      timers: [],
      dbosSchedules: [],
      stallWaker: null,
      elapsedMs: 0,
    })));
  }

  if (controllerPort === undefined) {
    const collectControllers = options.collectControllers ?? collectSiblingManagedTimers;
    let rows: readonly SiblingManagedTimers[];
    try {
      rows = await collectControllers({
        timeoutMs: DEFAULT_WORKSPACE_HOST_CONTROLLER_DISCOVERY_TIMEOUT_MS,
        budgetMs: DEFAULT_SIBLING_FANOUT_BUDGET_MS,
      });
    } catch {
      // Exceptions and probe error strings may carry private paths or credentials. Retain the
      // closed reason and public candidate metadata, never raw exception/provider bodies.
      return controllerUnavailable('discovery-failed');
    }
    const controller = selectController(rows);
    if (!controller) {
      const reason = rows.some((row) => row.probeFailure === 'timeout')
        ? 'controller-probe-timeout'
        : 'no-controller';
      return controllerUnavailable(reason, rows);
    }
    controllerPort = controller.port;
  }

  // Both callers validate an object before forwarding. Choose the operation ID
  // here, before crossing the transport boundary, so a lost response cannot also
  // lose the only identity with which to reconcile a possibly accepted mutation.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const operationId =
    'operationId' in body && typeof body.operationId === 'string'
      ? body.operationId
      : randomUUID();
  const forwardedBody = { ...body, operationId };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${controllerPort}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(
        options.timeoutMs ?? DEFAULT_WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS,
      ),
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(forwardedBody),
    });
    const contentType = response.headers.get('content-type');
    const location = response.headers.get('location');
    return new Response(await response.text(), {
      status: response.status,
      headers: {
        ...(contentType ? { 'content-type': contentType } : {}),
        ...(location ? { location } : {}),
      },
    });
  } catch {
    // The controller answers within its admission window (202 once enqueued), so this
    // deadline firing means the controller itself is wedged or unreachable. Once
    // dispatched, a timeout or lost response still says nothing about acceptance.
    // Reserve null for local-controller bypass; otherwise the route reports an
    // unavailable executor even while its mutation is running.
    return Response.json(
      {
        ok: false,
        error: 'workspace-host controller response unavailable',
        outcome: 'unknown',
        operationId,
        message: `Operation ${operationId} may have been accepted. Check the workspace host timeline before retrying, and preserve this operation ID.`,
      },
      { status: 504 },
    );
  }
}

export const defaultWorkspaceHostRequestForwarder: WorkspaceHostRequestForwarder = (
  path,
  body,
) => forwardWorkspaceHostRequest(path, body);
