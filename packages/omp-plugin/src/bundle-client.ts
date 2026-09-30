/**
 * HTTP client for the Papercusp `/api/agent-bundle` and
 * `/api/agent-tokens/power-user/refresh` endpoints.
 *
 * The access token always travels in an `Authorization: Bearer` header,
 * never in a URL or argv (D-006).
 */

export interface BundleFile {
  name: string;
  source: string;
}

/**
 * Per-session OMP inference-gateway model config (omp-account-pinning-gateway P-005).
 * Present (non-null) only when the gateway is on AND the session is pinned to a
 * pool account; absent/null = normal direct egress. The client temp-installs
 * `content` at `<HOME>/.omp/agent/<relPath-tail>` (backed up + restored on exit)
 * and selects `modelSelector` as the session model.
 */
export interface OmpGatewayModels {
  relPath: string;
  content: string;
  modelSelector: string;
}

export interface AgentBundle {
  persona: string;
  toolsmd: string;
  skills: BundleFile[];
  hooks: BundleFile[];
  mcp_url: string;
  workspace: { id: string; name: string };
  user: { id: string; username: string; displayName: string };
  /** OMP gateway routing config, or null/absent when not gateway-routed. */
  omp_gateway_models?: OmpGatewayModels | null;
  expires_at: string;
}

export interface RefreshResult {
  access_token: string;
  access_expires_at: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** True for an HttpError with the given status. */
export function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof HttpError && err.status === status;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Fetch the agent bundle. Throws HttpError on a non-2xx response. */
export async function fetchBundle(
  bundleUrl: string,
  accessToken: string,
): Promise<AgentBundle> {
  const res = await fetch(bundleUrl, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `agent-bundle fetch failed: ${await readError(res)}`);
  }
  return (await res.json()) as AgentBundle;
}

/**
 * Derive the refresh endpoint from a bundle URL — same origin, fixed
 * path. Keeps the plugin from having to be told two URLs.
 */
export function refreshUrlFor(bundleUrl: string): string {
  return new URL('/api/agent-tokens/power-user/refresh', bundleUrl).toString();
}

/**
 * Exchange a refresh token for a fresh access token. Throws HttpError;
 * a 401 means the session was revoked or the refresh token expired —
 * callers should stop the refresh loop and let the session wind down.
 */
export async function refreshAccessToken(
  refreshUrl: string,
  refreshToken: string,
): Promise<RefreshResult> {
  const res = await fetch(refreshUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!res.ok) {
    throw new HttpError(res.status, `token refresh failed: ${await readError(res)}`);
  }
  return (await res.json()) as RefreshResult;
}
