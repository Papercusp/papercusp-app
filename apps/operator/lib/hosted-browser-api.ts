/**
 * Browser-side contract for the hosted operator shell.
 *
 * The hosted server injects a small, data-only marker into the static SPA
 * document.  Keeping the parser here (rather than having each client caller
 * inspect `window` independently) gives sync and imperative workspace-host
 * actions one transport decision and one explicit local fallback.
 */

export const HOSTED_BROWSER_API_MARKER_VERSION = 1 as const;
export const HOSTED_BROWSER_API_GLOBAL =
  "__PAPERCUSP_HOSTED_BROWSER__" as const;
export const HOSTED_BROWSER_API_ALIAS_GLOBAL =
  "__PAPERCUSP_HOSTED_BROWSER_API__" as const;

export const LOCAL_BROWSER_REST_ENDPOINT = "/api/zero-harness" as const;
export const LOCAL_WORKSPACE_HOST_ENDPOINTS = Object.freeze({
  connection: "/api/workspace-hosts/connection",
  provision: "/api/workspace-hosts/provision",
  action: "/api/workspace-hosts/action",
});

export const HOSTED_BROWSER_REST_ENDPOINT = "/api/hosted/browser" as const;
export const HOSTED_BROWSER_SSE_ENDPOINT = "/api/hosted/browser/sse" as const;
export const HOSTED_WORKSPACE_SELECTION_ENDPOINT =
  "/api/hosted/browser/onboarding/select-workspace" as const;
export const HOSTED_WORKSPACE_HOST_ENDPOINTS = Object.freeze({
  connection: "/api/hosted/browser/workspace-hosts/connection",
  provision: "/api/hosted/browser/workspace-hosts/provision",
  action: "/api/hosted/browser/workspace-hosts/action",
});

export interface HostedBrowserApiMarker {
  readonly version: typeof HOSTED_BROWSER_API_MARKER_VERSION;
  readonly controlPlaneWorkspaceId: string;
  readonly restEndpoint: typeof HOSTED_BROWSER_REST_ENDPOINT;
  readonly sseEndpoint: typeof HOSTED_BROWSER_SSE_ENDPOINT;
  readonly workspaceHostEndpoints: typeof HOSTED_WORKSPACE_HOST_ENDPOINTS;
}

export interface BrowserApiTransport {
  readonly mode: "hosted" | "local";
  /** Base endpoint consumed by SyncProvider (it appends `/rest-query`). */
  readonly restEndpoint: string;
  /** Explicit SSE endpoint; local mode uses SyncProvider's derived path. */
  readonly sseEndpoint?: string;
  readonly workspaceHostEndpoints: Readonly<{
    connection: string;
    provision: string;
    action: string;
  }>;
  readonly controlPlaneWorkspaceId?: string;
}

declare global {
  interface Window {
    /** Server-injected hosted browser transport marker. */
    __PAPERCUSP_HOSTED_BROWSER__?: unknown;
    /** Compatibility alias used by an early hosted-browser shell build. */
    __PAPERCUSP_HOSTED_BROWSER_API__?: unknown;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 1_024
  );
}

function exactPath(value: unknown, expected: string): boolean {
  // Marker paths must stay relative and exact.  Accepting an absolute URL or
  // a path with query/hash data would let a stale/malformed shell redirect
  // credentialed traffic outside the same-origin hosted contract.
  return value === expected;
}

function parseMarker(value: unknown): HostedBrowserApiMarker | null {
  if (!isRecord(value)) return null;
  if (value.version !== HOSTED_BROWSER_API_MARKER_VERSION) return null;
  if (!nonEmptyIdentifier(value.controlPlaneWorkspaceId)) return null;
  if (!exactPath(value.restEndpoint, HOSTED_BROWSER_REST_ENDPOINT)) return null;
  if (!exactPath(value.sseEndpoint, HOSTED_BROWSER_SSE_ENDPOINT)) return null;

  const endpoints = value.workspaceHostEndpoints;
  if (!isRecord(endpoints)) return null;
  if (
    !exactPath(endpoints.connection, HOSTED_WORKSPACE_HOST_ENDPOINTS.connection)
  )
    return null;
  if (
    !exactPath(endpoints.provision, HOSTED_WORKSPACE_HOST_ENDPOINTS.provision)
  )
    return null;
  if (!exactPath(endpoints.action, HOSTED_WORKSPACE_HOST_ENDPOINTS.action))
    return null;

  return {
    version: HOSTED_BROWSER_API_MARKER_VERSION,
    controlPlaneWorkspaceId: value.controlPlaneWorkspaceId.trim(),
    restEndpoint: HOSTED_BROWSER_REST_ENDPOINT,
    sseEndpoint: HOSTED_BROWSER_SSE_ENDPOINT,
    workspaceHostEndpoints: HOSTED_WORKSPACE_HOST_ENDPOINTS,
  };
}

function markerValuesEqual(
  a: HostedBrowserApiMarker,
  b: HostedBrowserApiMarker,
): boolean {
  return (
    a.version === b.version &&
    a.controlPlaneWorkspaceId === b.controlPlaneWorkspaceId &&
    a.restEndpoint === b.restEndpoint &&
    a.sseEndpoint === b.sseEndpoint &&
    a.workspaceHostEndpoints.connection ===
      b.workspaceHostEndpoints.connection &&
    a.workspaceHostEndpoints.provision === b.workspaceHostEndpoints.provision &&
    a.workspaceHostEndpoints.action === b.workspaceHostEndpoints.action
  );
}

/** Build the server-injected marker using the same constants the client validates. */
export function hostedBrowserApiMarker(
  controlPlaneWorkspaceId: string,
): HostedBrowserApiMarker {
  const id = controlPlaneWorkspaceId.trim();
  if (!id)
    throw new TypeError(
      "hosted_browser_marker_requires_a_control_plane_workspace_id",
    );
  return {
    version: HOSTED_BROWSER_API_MARKER_VERSION,
    controlPlaneWorkspaceId: id,
    restEndpoint: HOSTED_BROWSER_REST_ENDPOINT,
    sseEndpoint: HOSTED_BROWSER_SSE_ENDPOINT,
    workspaceHostEndpoints: HOSTED_WORKSPACE_HOST_ENDPOINTS,
  };
}

/**
 * Read and validate the host marker.  A malformed marker is treated as absent:
 * callers take the ordinary local transport, while hosted route absence still
 * fails closed at the server's explicit allowlist.
 */
export function readHostedBrowserApiMarker(): HostedBrowserApiMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const primary = parseMarker(window[HOSTED_BROWSER_API_GLOBAL]);
    const alias = parseMarker(window[HOSTED_BROWSER_API_ALIAS_GLOBAL]);
    const primaryPresent = window[HOSTED_BROWSER_API_GLOBAL] !== undefined;
    const aliasPresent = window[HOSTED_BROWSER_API_ALIAS_GLOBAL] !== undefined;

    if (primary && alias && !markerValuesEqual(primary, alias)) return null;
    if (primaryPresent && !primary) return null;
    if (aliasPresent && !alias) return null;
    return primary ?? alias;
  } catch {
    // A hostile getter or an older browser global must never break hydration.
    return null;
  }
}

/** Resolve one transport for both sync reads and workspace-host mutations. */
export function resolveBrowserApiTransport(): BrowserApiTransport {
  const hosted = readHostedBrowserApiMarker();
  if (hosted) {
    return {
      mode: "hosted",
      restEndpoint: hosted.restEndpoint,
      sseEndpoint: hosted.sseEndpoint,
      workspaceHostEndpoints: hosted.workspaceHostEndpoints,
      controlPlaneWorkspaceId: hosted.controlPlaneWorkspaceId,
    };
  }
  return {
    mode: "local",
    restEndpoint: LOCAL_BROWSER_REST_ENDPOINT,
    workspaceHostEndpoints: LOCAL_WORKSPACE_HOST_ENDPOINTS,
  };
}

export type HostedWorkspaceSelectionBootstrapResult =
  | "not-hosted"
  | "selected"
  | "no-workspace"
  | "already-selected"
  | "unavailable";

/**
 * On a hosted sign-in, select the organization's sole existing workspace before
 * the app mounts sync queries. The server derives organization and workspace
 * from the authenticated session, and returns a rotated session cookie. A
 * missing workspace is an ordinary first-run state, so it must not block the
 * app from rendering its onboarding UI.
 */
export async function bootstrapHostedWorkspaceSelection(
  fetcher: typeof fetch = fetch,
): Promise<HostedWorkspaceSelectionBootstrapResult> {
  if (!readHostedBrowserApiMarker()) return "not-hosted";
  try {
    const response = await fetcher(HOSTED_WORKSPACE_SELECTION_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (response.ok) return "selected";
    const payload: unknown = await response.json().catch(() => null);
    const code =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : null;
    if (code === "no_workspace") return "no-workspace";
    if (code === "workspace_already_selected") return "already-selected";
    return "unavailable";
  } catch {
    // An auth/network failure must not deadlock the shell; the normal route
    // authorization surfaces the underlying issue after sync mounts.
    return "unavailable";
  }
}
