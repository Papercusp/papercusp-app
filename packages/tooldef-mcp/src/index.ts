/**
 * @papercusp/tooldef-mcp — MCP transport bridge primitives for @papercusp/tooldef.
 *
 * The host-agnostic glue between an MCP server and the tooldef dispatcher:
 *
 *   1. **RequestHandlerExtra extractors** — pull the bearer token, request URL,
 *      and headers out of the `extra` object an MCP server hands a request
 *      handler. Vercel's `mcp-handler` shapes `extra` as
 *      `{ requestInfo: { headers, url }, sendNotification }`; these read that
 *      shape with loose typing so the package needs no `mcp-handler` dep.
 *   2. **Projected-dispatch → MCP-result mapper** — run a tool through the
 *      engine's dispatcher and shape the `{ ok, result | error }` outcome into
 *      an MCP `tools/call` result (`{ content }` or `{ isError, content }`).
 *
 * What is **NOT** here (by design): the MCP server *assembly* — `tools/list` /
 * `tools/call` wiring, spawn-context auth (superuser / power-user / HMAC
 * spawn-URL verification), the legacy-vs-projected pipeline routing. That is
 * inherently host-specific (Papercusp does it in
 * `apps/operator/.../transport/_mcp-handler.ts`) and putting it behind a
 * "generic factory" would only produce a Papercusp-shaped injection surface.
 * A host composes these primitives with its own `createMcpHandler` call + auth.
 *
 * Plan: apps/operator/docs/plans/papercusp-tooldef-extraction-2026-05-29.md (P-031).
 */
import {
  dispatchProjectedTool,
  type ProjectedTool,
  type UnifiedToolContext,
  type DispatchProjectedDeps,
} from '@papercusp/tooldef';

export { UdsMcpTransport, UdsMcpTransportError, type UdsMcpTransportOptions } from './uds-transport';

/* ─── RequestHandlerExtra extractors ─────────────────────────────────── */

/** Bearer token from an MCP request handler's `extra` (strips `Bearer `). */
export function bearerFromExtra(extra: unknown): string {
  const e = extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } };
  const raw = e?.requestInfo?.headers?.authorization;
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (!auth) return '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
}

/** Request URL from `extra`, or null if absent/unparseable. */
export function urlFromExtra(extra: unknown): URL | null {
  const e = extra as { requestInfo?: { url?: unknown } };
  const raw = e?.requestInfo?.url;
  if (!raw) return null;
  try {
    return new URL(raw as string);
  } catch {
    return null;
  }
}

/** Request headers from `extra` as a Web `Headers` (arrays joined). */
export function headersFromExtra(extra: unknown): Headers {
  const raw = (extra as { requestInfo?: { headers?: Record<string, string | string[] | undefined> } })
    ?.requestInfo?.headers ?? {};
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    const flat = Array.isArray(v) ? v.join(', ') : v;
    if (typeof flat === 'string') h.set(k, flat);
  }
  return h;
}

/* ─── Projected-dispatch → MCP result ────────────────────────────────── */

/** An MCP `tools/call` result shape. */
export interface McpToolCallResult {
  content: ReadonlyArray<{ type: 'text'; text: string } | Record<string, unknown>>;
  isError?: boolean;
  /**
   * Structured metadata returned alongside content (not shown to the model).
   * Carries the result's `format` tag + the pagination/degraded envelope routed
   * out of the body (token-efficient-tool-result-formats P-006). Threaded from
   * the dispatcher's `ToolResult._meta`.
   */
  _meta?: Record<string, unknown>;
  /**
   * Lossless structured JSON of the result `data`, per the tool's MCP
   * `outputSchema` (P-010). Present only when the tool opted in (a client asked
   * for it) — gated so the model never pays for both the compact text AND the
   * full JSON at once.
   */
  structuredContent?: unknown;
}

// Transport replay must not reserve a caller's idempotency key for a refusal
// that happened before the handler ran. Keep this decision off the MCP wire:
// the symbol is enumerable so result-shaping object spreads retain it, while
// JSON serialization (including `_meta`) cannot expose it to callers.
const DISPATCH_VALIDATION_FAILURE = Symbol('papercusp.mcp.dispatch-validation-failure');

/** True only for an MCP error produced by the projected dispatcher itself. */
export function isDispatchValidationFailure(result: McpToolCallResult): boolean {
  return (result as McpToolCallResult & { [DISPATCH_VALIDATION_FAILURE]?: true })[DISPATCH_VALIDATION_FAILURE] === true;
}

/**
 * Dispatch a projected tool through the engine and map the outcome to an MCP
 * `tools/call` result: success → `{ content, _meta?, structuredContent? }`;
 * failure → `{ isError: true, content: [{ type:'text', text:'<code>: <message>' }] }`.
 * The host has already resolved `ctx` (auth, harness paths, …) and supplies `deps`.
 */
export async function dispatchProjectedToolToMcp(
  tool: ProjectedTool,
  toolName: string,
  args: unknown,
  ctx: UnifiedToolContext,
  deps: DispatchProjectedDeps,
): Promise<McpToolCallResult> {
  const r = await dispatchProjectedTool(tool, toolName, args, ctx, deps);
  if (!r.ok) {
    const failure: McpToolCallResult = {
      isError: true,
      content: [{ type: 'text', text: `${r.error?.code}: ${r.error?.message}` }],
    };
    if (r.error?.code === 'invalid_input') {
      Object.defineProperty(failure, DISPATCH_VALIDATION_FAILURE, {
        value: true,
        enumerable: true,
      });
    }
    // EI-21903050648079438: a dispatch-level failure (a gate/schema rejection —
    // the target handler never ran) previously carried NO `structuredContent`,
    // so a code:run script's `unwrapToolResult` fell through to the plain-text
    // body and handed the script a raw STRING. The success path below always
    // threads `structuredContent` when the target set one, so a caller checking
    // `result.ok` saw `undefined` on failure but a real boolean on success —
    // the exact asymmetry `raw-text-result-shape.test.ts` pins for a handler's
    // OWN unstructured output, here at the dispatcher's uniform failure shape
    // instead. Gated on `ctx.codeMode` to match that same handler convention:
    // a non-code-mode (MCP model) caller pays nothing extra on the wire.
    if (ctx.codeMode) {
      failure.structuredContent = { ok: false, error: { code: r.error?.code, message: r.error?.message } };
    }
    return failure;
  }
  const out: McpToolCallResult = { content: r.result!.content };
  // EI-19386035445533031 (follow-on): `ok:true` here means the HANDLER did not
  // throw — it says nothing about whether the `ToolResult` it RETURNED itself
  // carries `isError:true` (the sanctioned way for a handler to self-report a
  // business-level failure while returning an already-MCP-shaped result — see
  // ToolResult's own doc comment and the `tools:invoke` meta-tool, which passes
  // a nested dispatch's raw `{ content, isError }` straight through). Dropping
  // it here silently downgraded a self-reported failure to a false "ok" MCP
  // response the moment it passed through ANY defineTool-wrapped re-dispatch
  // (e.g. a `tools:invoke`-mediated call) — the isError bit compiled fine
  // (McpToolCallResult already declares it) but was simply never read from
  // `r.result`.
  if (r.result!.isError) out.isError = true;
  const meta = r.result!._meta;
  if (meta && Object.keys(meta).length > 0) out._meta = meta;
  if (r.result!.structuredContent !== undefined) out.structuredContent = r.result!.structuredContent;
  return out;
}
