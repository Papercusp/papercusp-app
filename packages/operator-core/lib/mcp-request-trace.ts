/** Shared, bounded correlation contract for the local MCP proxy → operator hop. */
import { createHash } from 'node:crypto';
import { headersFromExtra, urlFromExtra } from '@papercusp/tooldef-mcp';

export const MCP_REQUEST_TRACE_HEADER = 'x-papercusp-mcp-trace-id';
export const MAX_MCP_REQUEST_TRACE_ID_CHARS = 36;

/**
 * Proxy-owned signal that the local MCP data plane recently retried or failed an
 * upstream hop. The proxy overwrites/removes any client value before forwarding,
 * so the operator can safely use it as a non-authoritative diagnostic hint.
 */
export const MCP_DATA_PLANE_DEGRADED_AT_HEADER = 'x-papercusp-mcp-data-plane-degraded-at';

export type McpRequestTraceStage =
  | 'request_started'
  | 'inner_dispatch_started'
  | 'inner_dispatch_settled'
  | 'deadline'
  | 'tools_list_completed'
  | 'stale_contract_rejected';

export type McpSessionBaselineObservation = 'recorded' | 'unavailable' | 'missing' | 'current' | 'stale';

export interface McpRequestTraceEvent {
  traceId: string;
  toolName: string;
  stage: McpRequestTraceStage;
  elapsedMs: number;
  deadlineMs?: number;
  phase?: 'pre_dispatch' | 'inner_dispatch';
  outcome?: 'success' | 'tool_error' | 'rejected';
  afterDeadline?: boolean;
  /** Hashes only; never persist the protocol/native session identifiers themselves. */
  mcpSessionKeyFingerprint?: string | null;
  wireMcpSessionIdFingerprint?: string | null;
  nativeSessionClaimFingerprint?: string | null;
  nativeSessionCarrier?: 'header' | 'query' | 'none';
  sessionBaseline?: McpSessionBaselineObservation;
  servingGeneration?: string;
  previousGeneration?: string;
  declaredGeneration?: string;
}

type McpSessionSurfaceTraceInput = Pick<
  McpRequestTraceEvent,
  'traceId' | 'toolName' | 'stage' | 'elapsedMs'
> & {
  extra: unknown;
  sessionKey: string | null;
  sessionBaseline: McpSessionBaselineObservation;
  servingGeneration: string;
  previousGeneration?: string;
  declaredGeneration?: string;
  phase?: McpRequestTraceEvent['phase'];
  outcome?: McpRequestTraceEvent['outcome'];
};

function fingerprintSessionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/** Build bounded lifecycle evidence that distinguishes protocol and native sessions. */
export function buildMcpSessionSurfaceTraceEvent(input: McpSessionSurfaceTraceInput): McpRequestTraceEvent {
  let wireMcpSessionId: string | null = null;
  let nativeHeader = '';
  let nativeQuery = '';
  try {
    const headers = headersFromExtra(input.extra);
    wireMcpSessionId = headers.get('mcp-session-id');
    nativeHeader = (headers.get('x-papercusp-native-session') ?? '').trim();
  } catch {
    // Diagnostic identity extraction must never change the MCP response.
  }
  try {
    nativeQuery = (urlFromExtra(input.extra)?.searchParams.get('native_session') ?? '').trim();
  } catch {
    // An incomplete request envelope simply leaves the query identity absent.
  }
  const nativeClaim = nativeHeader || nativeQuery;
  return {
    traceId: input.traceId,
    toolName: input.toolName.slice(0, 120),
    stage: input.stage,
    elapsedMs: Math.max(0, input.elapsedMs),
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.outcome ? { outcome: input.outcome } : {}),
    mcpSessionKeyFingerprint: fingerprintSessionId(input.sessionKey),
    wireMcpSessionIdFingerprint: fingerprintSessionId(wireMcpSessionId),
    nativeSessionClaimFingerprint: fingerprintSessionId(nativeClaim),
    nativeSessionCarrier: nativeHeader ? 'header' : nativeQuery ? 'query' : 'none',
    sessionBaseline: input.sessionBaseline,
    servingGeneration: input.servingGeneration,
    ...(input.previousGeneration ? { previousGeneration: input.previousGeneration } : {}),
    ...(input.declaredGeneration ? { declaredGeneration: input.declaredGeneration } : {}),
  };
}

/** Emit bounded, argument-free MCP handler evidence without changing request behavior. */
export function logMcpRequestTrace(event: McpRequestTraceEvent): void {
  try {
    console.info(`[mcp-request-trace] ${JSON.stringify(event)}`);
  } catch {
    // Diagnostics must never change the request result.
  }
}

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
