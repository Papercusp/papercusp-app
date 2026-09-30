/** Shared, bounded correlation contract for the local MCP proxy → operator hop. */
import { headersFromExtra } from '@papercusp/tooldef-mcp';

export const MCP_REQUEST_TRACE_HEADER = 'x-papercusp-mcp-trace-id';
export const MAX_MCP_REQUEST_TRACE_ID_CHARS = 36;

/**
 * Proxy-owned signal that the local MCP data plane recently retried or failed an
 * upstream hop. The proxy overwrites/removes any client value before forwarding,
 * so the operator can safely use it as a non-authoritative diagnostic hint.
 */
export const MCP_DATA_PLANE_DEGRADED_AT_HEADER = 'x-papercusp-mcp-data-plane-degraded-at';

/** Accept only the fixed UUID shape minted by the proxy; reject arbitrary client input. */
export function mcpTraceIdFromExtra(extra: unknown): string | null {
  const value = headersFromExtra(extra).get(MCP_REQUEST_TRACE_HEADER)?.trim() ?? '';
  if (value.length > MAX_MCP_REQUEST_TRACE_ID_CHARS) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/** Accept only a bounded integer millisecond timestamp minted by the local proxy. */
export function mcpDataPlaneDegradedAtFromExtra(extra: unknown): number | null {
  const value = headersFromExtra(extra).get(MCP_DATA_PLANE_DEGRADED_AT_HEADER)?.trim() ?? '';
  if (!/^\d{1,16}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 && Number.isFinite(new Date(timestamp).getTime())
    ? timestamp
    : null;
}
