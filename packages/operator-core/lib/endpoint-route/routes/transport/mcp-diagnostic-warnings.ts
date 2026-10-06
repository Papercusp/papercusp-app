/**
 * Pure MCP result diagnostics shared by the HTTP route and direct probes.
 *
 * Keep this module free of the MCP host, operator tool registry, database, and
 * timers. Helper consumers (including tsx boot guards) must be able to import
 * and invoke it in a one-shot process without starting host infrastructure.
 */
import { parseMcpToolText } from './mcp-result-text';
import { OUTPUT_ENVELOPE_SCHEMA_VERSION } from '../../../output-envelope';

export type McpCallResult = {
  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
};

export interface McpDiagnosticContext {
  workspaceId: string;
  workspaceResolution?: 'registry-fallback';
  dataPlaneDegradedAtMs?: number;
}

function withMcpDiagnosticWarning<T extends McpCallResult>(
  result: T,
  jsonKey: string,
  metaKey: string,
  warning: string,
): T {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  if (first && 'type' in first && first.type === 'text' && typeof (first as { text?: unknown }).text === 'string') {
    try {
      const parsed: unknown = JSON.parse((first as { text: string }).text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        (parsed as Record<string, unknown>)[jsonKey] = warning;
        return {
          ...result,
          content: [{ type: 'text' as const, text: JSON.stringify(parsed) }, ...content.slice(1)],
        };
      }
    } catch {
      /* non-JSON text content (or a malformed body) — fall through to _meta */
    }
  }
  return { ...result, _meta: { ...(result._meta ?? {}), [metaKey]: warning } };
}

function hasPopulatedMcpResult(result: McpCallResult): boolean {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  if (!first || !('type' in first) || first.type !== 'text' || typeof first.text !== 'string') return false;

  let parsed: unknown;
  try {
    parsed = parseMcpToolText(first.text);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (!parsed || typeof parsed !== 'object') return false;

  const body = parsed as Record<string, unknown>;
  if (body.authoritative === true) return true;
  if (body.notFound === true || body.not_found === true || body.missing === true) return false;
  if (typeof body.status === 'string' && body.status.replace(/[-\s]/g, '_').toLowerCase() === 'not_found') return false;
  if (typeof body.code === 'string' && body.code.replace(/[-\s]/g, '_').toLowerCase() === 'not_found') return false;
  const completionReceipt = body.completionReceipt;
  if (
    body.ok === true &&
    completionReceipt &&
    typeof completionReceipt === 'object' &&
    !Array.isArray(completionReceipt) &&
    (completionReceipt as Record<string, unknown>).status === 'recorded' &&
    typeof (completionReceipt as Record<string, unknown>).effectRef === 'string' &&
    ((completionReceipt as Record<string, unknown>).effectRef as string).trim().length > 0
  ) {
    return true;
  }
  if (Array.isArray(body.entries) && body.entries.length > 0) return true;
  // The result door moves large, intact payloads behind a typed reference envelope.
  // These have no `ok` field, so the generic success-envelope check below would
  // otherwise call a recoverable populated result empty and attach a misleading
  // data-plane warning to it.
  if (
    body.schemaVersion === OUTPUT_ENVELOPE_SCHEMA_VERSION &&
    Array.isArray(body.content) &&
    body.content.length > 0
  ) {
    return true;
  }
  if (
    typeof body.ownerId === 'string' &&
    body.ownerId.trim().length > 0 &&
    typeof body.source === 'string' &&
    body.source.trim().length > 0
  ) {
    return true;
  }
  // tools:find and testing:runs use populated top-level arrays without the legacy `{ ok: true, ... }` shape.
  if (Array.isArray(body.hits) && body.hits.length > 0) return true;
  if (Array.isArray(body.runs) && body.runs.length > 0) return true;
  // activity:tool-log returns a nonempty row/call count instead of a result array.
  // Keep zero counts empty so a genuinely empty log still receives the warning.
  if (
    ['calls', 'rawRows'].some((key) => {
      const value = body[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    })
  ) {
    return true;
  }
  if (body.ok !== true) return false;
  if (body.ended === true || body.verified === true) return true;
  if (
    (typeof body.await_id === 'number' && Number.isSafeInteger(body.await_id) && body.await_id > 0) ||
    (typeof body.await_id === 'string' && body.await_id.trim().length > 0)
  ) {
    return true;
  }

  let sawResultField = false;
  let hasPopulatedField = false;
  for (const key of ['results', 'items', 'data', 'result', 'value', 'presence', 'facts', 'hits', 'scorecard']) {
    if (!(key in body)) continue;
    sawResultField = true;
    const value = body[key];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      hasPopulatedField ||= value.length > 0;
      continue;
    }
    if (typeof value === 'object') {
      hasPopulatedField ||= Object.keys(value as object).length > 0;
      continue;
    }
    hasPopulatedField = true;
  }
  return sawResultField && hasPopulatedField;
}

export function withMcpDiagnosticWarnings<T extends McpCallResult>(result: T, spawnCtx: McpDiagnosticContext): T {
  if (!result || result.isError) return result;
  let annotated = result;
  if (spawnCtx.workspaceResolution === 'registry-fallback') {
    const warning =
      `⚠ SCOPE GUESSED, NOT VERIFIED: this session's workspace could not be resolved from an explicit ` +
      `param, header, or launch record — it was scoped to '${spawnCtx.workspaceId}' as a REGISTRY-FALLBACK ` +
      `GUESS (the box's active workspace), which can be wrong on a multi-workspace box. If this result ` +
      `looks like an unexpected empty/not-found for something you expect to exist, suspect WRONG-WORKSPACE ` +
      `SCOPING before concluding data is missing — verify independently (dev:pg_query / psql against the ` +
      `expected workspace) rather than trusting this result at face value.`;
    annotated = withMcpDiagnosticWarning(annotated, '_scopeGuessWarning', 'scopeGuessWarning', warning);
  }
  if (spawnCtx.dataPlaneDegradedAtMs && !hasPopulatedMcpResult(annotated)) {
    const observedAt = new Date(spawnCtx.dataPlaneDegradedAtMs).toISOString();
    const warning =
      `⚠ DATA PLANE MAY BE DEGRADED: this session's local MCP proxy observed an upstream retry or ` +
      `connection failure at ${observedAt}. During this short warning window, an unexpected empty/not-found ` +
      `result may be a transport symptom rather than authoritative absence. Retry or verify independently ` +
      `before concluding that data is missing.`;
    annotated = withMcpDiagnosticWarning(annotated, '_dataPlaneMayBeDegraded', 'dataPlaneMayBeDegraded', warning);
  }
  return annotated;
}
