/**
 * code-execution-tool-orchestration B-CX-1A — the DISPATCH BINDING.
 *
 * Binds the facade's injected `FacadeDispatch` to a real `UnifiedToolContext` + `DispatchProjectedDeps`,
 * so every tool call the model's script makes routes through the SAME dispatcher pipeline
 * (role/capability/envelope gates, quota, authorize, telemetry, audit) as an MCP `tools/call` —
 * code-mode is just another caller of the dispatcher, not a parallel tool path.
 *
 * On success it UNWRAPS the MCP `ToolResult` into the plain data the script should see (so model
 * code gets `result.items`, not `result.content[0].text`). On a dispatch failure it throws, so
 * the script's own try/catch — or the executor's error capture — surfaces it.
 */
import type { UnifiedToolContext, ProjectedTool } from '../tool-projection';
import type { DispatchProjectedDeps } from '../dispatch-types';
import type { ToolResult } from '../wire';
import { dispatchProjectedTool } from '../dispatch-projected';
import type { FacadeDispatch } from './tool-facade';
import { parseJsonWithTrailer } from './json-prefix';
import { decode, isResultFormat } from '@papercusp/result-encoding';

/** The `text` variant of a ToolResult content item, narrowed from the content union. */
type TextContent = Extract<NonNullable<ToolResult['content']>[number], { type: 'text' }>;

/** Matches the `format: <fmt>\n` self-identifying marker `serializeToolResponse` prefixes onto
 *  any non-JSON compact body (serialize-result.ts) — JSON itself carries no marker. */
const FORMAT_MARKER_RE = /^format: (\S+)\n/;

/**
 * Unwrap a settled `ToolResult` into the plain value the script should receive:
 * `structuredContent` if present, else the decoded text payload, else the raw text.
 *
 * EI-7689: a compact (non-JSON) tool response self-identifies with a leading `format:
 * <fmt>\n` marker (TOON/CSV/TSV/MD — serialize-result.ts) — none of those are valid JSON,
 * so a plain `JSON.parse` always THROWS on them and this used to silently fall back to
 * handing the script the raw marker+encoded STRING as its `result`. Any in-script
 * truthiness/property check on that string (`if (result.ok)`) then silently lies: a
 * non-empty string is always truthy no matter what's encoded inside it, so a genuine
 * server-side failure can read as success. Reproduced live 2026-07-05 (su-15a64): a
 * `plans:new` call failed server-side (`similar_exists`) but returned a truthy TOON
 * string, and the script's `result.ok` check passed, reporting a phantom plan creation.
 * Parse the marker first and DECODE with the matching format (the lossless inverse of
 * the encoder that produced it) so the script always sees the real structured value.
 *
 * WI-6458 is the same failure from the other direction: a PROXIED upstream MCP server
 * (gitnexus) ends its text with a chat affordance — `\n\n---\n**Next:** READ gitnexus://…`
 * — after otherwise-valid JSON, so `JSON.parse` throws and the script got the raw string.
 * `parseJsonWithTrailer` recovers the leading value; the trailing prose is DROPPED for the
 * script (it addresses a human/model reading the raw text, and the direct MCP path still
 * returns it verbatim — only the code-mode facade unwraps).
 */
export function unwrapToolResult(result: ToolResult | undefined): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) {
    return withIsErrorOk(result.structuredContent, result.isError);
  }
  // Narrow on the `type` discriminant — the prior `c is { text: string }` predicate was not a
  // subtype of the content union (TS2677) so it failed to narrow, leaving `.text` unreadable on
  // the image/resource variants (TS2339). Extracting the 'text' member fixes both.
  const textItem = result.content?.find((c): c is TextContent => c.type === 'text');
  if (!textItem) return result;
  const text = textItem.text;
  const marker = FORMAT_MARKER_RE.exec(text);
  if (marker && isResultFormat(marker[1]) && marker[1] !== 'md') {
    try {
      return withIsErrorOk(decode(text.slice(marker[0].length), marker[1]), result.isError);
    } catch {
      // Fall through to the JSON/raw-text attempts below — never let a decode
      // edge case throw here where the old behavior returned SOMETHING.
    }
  }
  try {
    return withIsErrorOk(JSON.parse(text), result.isError);
  } catch {
    const withTrailer = parseJsonWithTrailer(text);
    if (withTrailer) return withIsErrorOk(withTrailer.value, result.isError);
    return text;
  }
}

/**
 * EI-18664105352441219: the MCP protocol's own `isError` flag is the AUTHORITATIVE
 * "this call failed" signal (set by a tool returning `isError: true` alongside its
 * content) — independent of whatever shape the handler's own JSON body happens to
 * use. Several handlers signal failure via a bare `{ error: '<code>', ... }` body
 * with NO `ok: false` field (plans:new's `similar_exists` refusal is the reported
 * case: `{ error: 'similar_exists', slug, similar, hint }`, isError: true) — every
 * sibling refusal in the same file has the identical shape (`busy`, `slug_exists`).
 * Downstream, `isOkFalseResult` (orchestrate.ts) and a script's own idiomatic
 * `res?.ok !== false` guard both only recognize a top-level `ok === false`, so the
 * bare-`error` shape reads as a SUCCESS — no plan is written, but the caller (and
 * the orchestrator's own semantic-failure tally) never finds out. Stamping
 * `ok: false` onto the unwrapped value whenever the protocol says `isError` closes
 * the gap for every existing and future handler using this shape, without
 * requiring each one to remember to add `ok: false` explicitly. A handler that
 * already sets `ok: false` (or anything other than a plain object, e.g. a raw-text
 * fallback) is left untouched.
 */
function withIsErrorOk(value: unknown, isError: boolean | undefined): unknown {
  if (!isError) return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.ok !== false) return { ...v, ok: false };
  }
  return value;
}

/**
 * Dispatcher error codes decided BEFORE the tool's handler runs — a gate or a schema
 * rejection. When dispatch fails with one of these, the tool's side effects
 * DEFINITIVELY did not happen: nothing was written, so a retry is safe.
 *
 * This distinction is load-bearing (EI-10951). The orchestrator used to count every
 * DISPATCHED write-effect call as "executed", including one the dispatcher rejected on
 * its args — so a script whose last call had a typo'd argument came back with
 * "1 write-effect call(s) already executed before this failure — do NOT blindly re-run
 * … to avoid a double-write." Nothing had executed. The warning sent the agent off to
 * verify a write that never happened, and taught it to distrust a warning that is
 * RIGHT in the case it exists for (a real partial batch). A safety warning that cries
 * wolf on the most common failure (a bad arg) is worse than no warning.
 *
 * Conservative by construction: a code NOT in this set is treated as UNKNOWN (it may
 * have landed), so a genuinely ambiguous failure still gets the loud warning. Only
 * codes that provably precede the handler belong here.
 */
export const PRE_EXECUTION_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_input',
  'invalid_args',
  'schema_validation_failed',
  'unknown_tool',
  'tool_not_found',
  'role_not_allowed',
  'missing_capability',
  'capability_denied',
  'envelope_denied',
  'quota_exceeded',
  'rate_limited',
  // The orchestration's own abort fence: refused before the dispatcher is entered.
  'orchestration_aborted',
]);

/**
 * A dispatch-level failure, carrying the dispatcher's own error `code` instead of
 * flattening it into a string. `preExecution` answers the only question a caller
 * recovering from a failed batch actually has: did this write land or not?
 *
 * The `message` format is UNCHANGED (`tool <name> failed [<code>]: <msg>`) — scripts in
 * the wild match on it, and this is a strictly additive widening of the thrown value.
 */
export class ToolDispatchError extends Error {
  readonly code: string;
  readonly toolName: string;
  /** True ⇒ the dispatcher rejected the call before the handler ran; nothing was written. */
  readonly preExecution: boolean;

  constructor(toolName: string, code: string, message: string) {
    super(`tool ${toolName} failed [${code}]: ${message}`);
    this.name = 'ToolDispatchError';
    this.code = code;
    this.toolName = toolName;
    this.preExecution = PRE_EXECUTION_ERROR_CODES.has(code);
  }
}

/** True when a thrown value is a dispatch rejection that provably never reached the handler. */
export function isPreExecutionFailure(err: unknown): boolean {
  return err instanceof ToolDispatchError && err.preExecution;
}

export function realDispatch(ctx: UnifiedToolContext, deps: DispatchProjectedDeps): FacadeDispatch {
  return async (tool: ProjectedTool, toolName: string, args: unknown): Promise<unknown> => {
    const r = await dispatchProjectedTool(tool, toolName, args, ctx, deps);
    if (!r.ok) {
      throw new ToolDispatchError(
        toolName,
        r.error?.code ?? 'error',
        r.error?.message ?? 'unknown error',
      );
    }
    return unwrapToolResult(r.result);
  };
}
