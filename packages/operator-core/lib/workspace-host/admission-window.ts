/**
 * The HTTP admission contract for workspace-host mutations (EI-23712230399040759).
 *
 * Provision, destroy and lifecycle workflows run for minutes. An HTTP boundary that
 * awaits their result is wrong under every bounded deadline upstream of it — the
 * request-only forwarder's transport deadline and the route-stack watchdog both report
 * accepted work as unknown/timeout. So a route waits at most this window for the
 * durably-enqueued workflow to settle: a fast typed refusal (a missing upgrade image, an
 * absent host) still comes back synchronously, and anything slower is answered 202 with
 * the operation id to follow on the host timeline.
 */
export const WORKSPACE_HOST_ADMISSION_WINDOW_MS = 5_000;

/**
 * The forwarder's transport deadline must outlive the controller's admission window plus
 * its own enqueue round-trip, or every slow-but-healthy admission is reported as a lost
 * response with an unknown outcome — the exact failure the window exists to remove.
 */
export const WORKSPACE_HOST_CONTROLLER_FORWARD_TIMEOUT_MS = WORKSPACE_HOST_ADMISSION_WINDOW_MS + 10_000;

/** A workflow that was durably enqueued but had not settled inside the admission window. */
export interface WorkspaceHostOperationAcceptance {
  status: 'accepted';
  operationId: string;
  hostId: string;
}

export function workspaceHostAuditUrl(hostId: string): string {
  return `/api/workspace-hosts/${hostId}/audit`;
}
