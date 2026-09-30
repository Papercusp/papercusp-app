/**
 * Wire types — the transport-facing shapes the framework owns.
 *
 * These were historically defined in `@papercusp/plugin-sdk`; the
 * framework now owns them and the plugin SDK re-exports them (dependency
 * inversion, plan `papercusp-tooldef-extraction-2026-05-29` P-003). Nothing
 * here is host-specific — these are the MCP-shaped result and the streaming
 * callbacks every tool handler sees.
 */

/**
 * MCP-style tool result. Mirrors the MCP spec's `content[]` shape so
 * handlers can return text, images, or resource references.
 */
export interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string; _meta?: Record<string, unknown> }
    | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  >;
  /** Marks this tool call as failed for protocol purposes (handler may still throw). */
  isError?: boolean;
  /** Structured metadata returned alongside content (not shown to the model). */
  _meta?: Record<string, unknown>;
  /**
   * Lossless structured JSON of the result, mirroring the tool's MCP
   * `outputSchema` (token-efficient-tool-result-formats P-010). When present,
   * the MCP transport forwards it as `tools/call` `structuredContent` for
   * UI/programmatic consumers. Gated by negotiation so the model never pays for
   * both the compact `content` text AND this JSON — absent on the default
   * compact path.
   */
  structuredContent?: unknown;
  /**
   * Path to a scratch-dir artifact this tool produced. The dispatcher records
   * it on the telemetry row (`outputRef`); a host that surfaces large outputs
   * can deep-link to the file rather than re-rendering megabytes inline.
   *
   * Tools that return large outputs should set this.
   */
  outputRef?: string;
  /**
   * Size in bytes of the artifact pointed to by `outputRef`. Falls back
   * to `JSON.stringify(content).length` if `outputRef` is unset.
   */
  outputSize?: number;
}

/**
 * Per-role quota windows. A "chunk" is the smallest unit of work (e.g. one
 * worker turn); a "run" is one orchestrated invocation. The dispatcher reads
 * these via the host-supplied window-key function — the shape is generic,
 * the keying policy is host-injected.
 */
export interface RolesQuota {
  /** Chunk-window cap — calls allowed within one chunk. */
  perChunk?: number;
  /** Run-window cap — calls allowed within one run. */
  perRun?: number;
  /** Global cap, regardless of role/window. */
  perDay?: number;
}

/**
 * Progress callback passed to every tool handler. Calling this emits a
 * progress event over the active transport (MCP `notifications/progress`,
 * an SSE `event: progress` frame, or the in-process event iterator).
 *
 * `pct` is 0–100; pass `undefined` for indeterminate progress. `msg` is a
 * one-line human-readable status. Streaming is built in — tools that don't
 * care simply never call `progress()`. It is a thin alias over `emit`.
 */
export type ProgressCallback = (pct: number | undefined, msg?: string) => void;

/**
 * Typed-event streaming callback. Tools call `ctx.emit(name, data)` to fan a
 * named event over the active transport:
 *   - HTTP/SSE → `event: <name>\ndata: <payload>` (raw text or JSON per the
 *     event's declared schema)
 *   - MCP → a JSON-RPC notification carrying `{ event, data }`
 *   - In-process → the next value of the event async-iterator
 *
 * No-op when the transport has no event channel attached (a non-streaming
 * HTTP request, or an MCP client that didn't supply a progress token).
 * `ctx.progress` is a thin alias over `emit('progress', ...)`.
 *
 * Reserved event names: `'done' | 'progress' | 'heartbeat' | 'result' | 'card'`.
 */
export type EmitCallback = (name: string, data: unknown) => void;
