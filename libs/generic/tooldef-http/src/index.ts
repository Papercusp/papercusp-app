/**
 * @papercusp/tooldef-http — HTTP transport adapter for @papercusp/tooldef.
 *
 * Resolves an inbound tool request (method + pathname + headers + query) to a
 * projected tool, builds the `UnifiedToolContext` from `X-Papercusp-*` headers
 * / query params, and dispatches through the engine's gate stack. Host-specific
 * concerns — bearer→principal resolution, workspace tx, harness-path
 * resolution, superuser admission, quota/telemetry I/O — are injected via
 * `HttpToolHostExtras`; the adapter itself depends only on the engine
 * (`@papercusp/tooldef`) and the SSE writer (`@papercusp/sse`).
 *
 * Plan: apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md (P-030).
 */
export {
  PAPERCUSP_CONTEXT_HEADERS,
  buildHttpSpawnContext,
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  type HttpRequestContextInput,
  type HttpToolRequest,
  type HttpToolResponse,
  type HttpToolResult,
  type HttpToolHostExtras,
  type ToolScope,
} from './http-projection';
