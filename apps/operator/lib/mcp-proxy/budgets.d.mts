/**
 * Types for the shared mcp-proxy timing budgets (WI-6738).
 *
 * budgets.mjs must stay plain ESM so psu-launcher.mjs (bare `node`, unbundled) can import
 * the same definitions the tsx-run proxy uses. This declaration keeps the TypeScript callers
 * type-checked without forcing that.
 */

/** Proxy's retry-on-refused window. Env: PAPERCUSP_MCP_PROXY_RETRY_MS (default 90_000). */
export const MCP_PROXY_RETRY_WINDOW_MS: number;

/** The path the proxy answers itself, before any upstream forwarding (WI-6743). */
export const MCP_PROXY_LOCAL_HEALTH_PATH: string;

/** Client-side margin added on top of the proxy window (default 30_000). */
export const PSU_CLIENT_HEADROOM_MS: number;

/** psu's per-request timeout. Env: PAPERCUSP_PSU_TIMEOUT_MS, else window + headroom. */
export const PSU_REQUEST_TIMEOUT_MS: number;

export function derivePsuTimeoutMs(opts?: {
  overrideMs?: number | null;
  retryWindowMs?: number;
  headroomMs?: number;
}): number;

/** True when a client budget is shorter than the proxy's — the WI-6738 defect condition. */
export function psuTimeoutInvertsProxyBudget(timeoutMs: number, retryWindowMs?: number): boolean;
