/**
 * In-process re-dispatch helper for COMPOUND tools (code-execution-tool-orchestration
 * B-CX-1B).
 *
 * A compound tool collapses a hot, FIXED multi-step agent flow (measured from
 * harness_shared.tool_invocations) into ONE call — the cheap/safe complement to
 * `code:run`. Where `code:run` runs an arbitrary script, a compound tool composes a
 * KNOWN sequence of existing tools server-side and returns a summary, so the agent
 * pays ONE inference turn instead of a sequential N-turn flow and sees only the compound summary.
 * Multiple direct calls emitted together are already one inference turn; this optimization targets
 * flows that would return intermediate results to the model between steps, not raw RPC count.
 *
 * Composition routes each sub-call through the SAME dispatcher pipeline every MCP
 * `tools/call` uses (role/capability/envelope gates, quota, authorize, telemetry,
 * audit, event-reactions) via `dispatchProjectedTool` + the host's real
 * `PROJECTED_DEPS` — the in-process re-dispatch pattern from
 * `events/dispatch-reaction.ts` (and the same deps `code:run` threads after B-CX-DEPS).
 * So a compound tool is just another caller of the dispatcher: each sub-step is
 * independently gated + recordInvocation-logged (visible to spend), not a parallel
 * tool path that bypasses the gates.
 */
import {
  lookupByMcpName,
  dispatchProjectedTool,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { decode, type ResultFormat } from '@papercusp/result-encoding';
import { parseJsonWithTrailer } from '@papercusp/tooldef';
import { PROJECTED_DEPS } from '../projected-tool-deps';
import { runWithWorkspaceIfConcrete } from '../workspace-als';
import { synthesizeDispatchPrincipal } from '../endpoint-route/routes/transport/role-principal-caps';

/**
 * A self-identifying compact body prefixes its text with `format: <fmt>\n`
 * (serialize-result.ts). We decode ONLY `toon` here: it is LOSSLESS, so the
 * composition gets back the exact structured value (booleans/numbers intact).
 * `csv`/`tsv` are deliberately NOT decoded — they are type-lossy (every cell
 * becomes a string, so `.ok`/`.count` would read as strings) and, being
 * flat-scalar-array read formats, never arise on the in-process compound path
 * (the transport:'in_process' stamp keeps sub-results lossless JSON regardless).
 * A csv/tsv/md-marked body therefore falls through to the raw-text fallback.
 */
const COMPACT_MARKER_RE = /^format:\s*(toon)\n/;

/**
 * The injected inner-dispatch a compound's pure composition fn calls. Returns the
 * UNWRAPPED sub-tool payload (the plain data the tool's ToolResult carried), so the
 * composition reads `result.workItem` / `result.ok`, not `result.content[0].text`.
 * THROWS on a dispatch/gate failure (so the compound's caller surfaces it); a sub-tool
 * that returns a business-level `{ ok:false, error }` resolves normally — the
 * composition inspects that payload itself.
 */
export type InnerCall = (name: string, args: unknown) => Promise<unknown>;

/** Unwrap a settled ToolResult into the plain value the composition should see.
 *  Mirrors tooldef's `unwrapToolResult` (cast-in-guard so the strict content union
 *  assigns cleanly): structuredContent if present, else the decoded text payload,
 *  else the raw text/result.
 *
 *  The text payload is normally lossless JSON on the in-process transport (see
 *  `inProcessCall` below, which stamps transport:'in_process' precisely so the
 *  dispatcher does NOT re-encode it to compact). But we ALSO decode a
 *  self-identifying compact body (`format: toon|csv|tsv\n…`) as defense in depth:
 *  if any path ever hands this seam a compact result, the composition still gets
 *  the structured value — never an opaque string it would misread (the
 *  templates:new-app 422-on-success class, owner-hit 2026-07-08). */
function unwrap(
  result: { structuredContent?: unknown; content?: ReadonlyArray<unknown> } | undefined,
): unknown {
  if (!result) return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textItem = result.content?.find(
    (c): c is { text: string } => typeof (c as { text?: unknown }).text === 'string',
  );
  if (!textItem) return result;
  const text = textItem.text;
  // Self-identifying compact body → decode losslessly to the structured value.
  const marker = COMPACT_MARKER_RE.exec(text);
  if (marker) {
    try {
      return decode(text.slice(marker[0].length), marker[1] as ResultFormat);
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    // WI-6458: a PROXIED upstream MCP tool (gitnexus) appends a `**Next:** READ …` chat
    // affordance after valid JSON, so the parse throws and the composition would read an
    // opaque string. Recover the leading value — same seam as tooldef's unwrapToolResult.
    const withTrailer = parseJsonWithTrailer(text);
    if (withTrailer) return withTrailer.value;
    return text;
  }
}

/**
 * Build the in-process `InnerCall` for a compound tool's handler, bound to the
 * caller's ctx. Each sub-call re-runs the full dispatch stack against that ctx, so
 * the agent can only compose tools it could call directly.
 * Cross-workspace sub-calls mirror the direct MCP dispatcher: they receive the
 * admin handle plus a synthesized principal before entering the dispatcher. This
 * matters for unscoped superuser compounds such as coord:orient, whose caller ctx
 * intentionally has neither a workspace transaction nor a principal.
 *
 * `opts.telemetrySurface` (orient-recall-quality-2026-07-12 P-001): stamp the
 * inner ctx with a recall-telemetry surface label so a compound's folded
 * memory:search records under the COMPOUND's own surface (e.g. 'orient') in
 * harness_shared.memory_recall_stats instead of blending into generic 'search' —
 * per-entry-point recall quality is only measurable if each fold self-identifies.
 * Ctx-borne on purpose: no public tool arg (no prompt-weight cost, not
 * agent-spoofable); only memory:search reads it (cast-borne, the contextTier
 * house pattern). Telemetry only — never affects recall content.
 */
export function inProcessCall(
  ctx: UnifiedToolContext,
  opts?: {
    telemetrySurface?: string;
    /**
     * WI-37843: drop the caller's SESSION payload tier for these sub-reads, so
     * each inner tool resolves to 'full' instead of inheriting `ctx.contextTier`.
     *
     * Opt-IN (default: inherit, unchanged) because it is only correct for a
     * compound tool that has itself declared `ignoreSessionPayloadTier` — the
     * outer result must still be bounded by SOMETHING, and for those tools it is
     * their own `payloadTierCeilingChars` valve.
     *
     * WHY IT MATTERS. The inner ctx is a spread of the outer one, so a compound
     * tool under a trimmed session gets trimmed SUB-READS even when the compound
     * tool itself serves full — the shaping happens one level below where anyone
     * is looking. That is not hypothetical: `fleet:assignments`' trimmed shaper
     * projects per-agent `claims[]` to `claims: claims.length` (a NUMBER, see
     * assignments-shape.ts), which is what killed coord:orient's planNow leg
     * (EI-20108229813877389) — a swallowed throw turned the type change into a
     * plausible-looking `null` rather than an error.
     *
     * This is the same class of perturbation `transport: 'in_process'` below
     * already exists to prevent: that keeps the sub-result from being re-encoded,
     * this keeps it from being re-shaped. A fold is data the compound tool
     * COMPUTES with, not text an agent reads, so trimming it for context economy
     * buys nothing and silently changes field types.
     */
    ignoreSessionPayloadTier?: boolean;
  },
): InnerCall {
  // The re-dispatch is IN-PROCESS, not the agent-facing MCP transport. Reuse the
  // caller's ctx (its auth/scope/quota/harness) but stamp transport:'in_process'
  // so the sub-tool result stays LOSSLESS JSON. Both the format contract
  // (serialize-result.ts `formatOptsFromCtx`: defaultCompact = transport==='mcp')
  // AND define-tool's `reencodableJsonPayload` re-encode gate key "keep the raw
  // bytes" on transport !== 'mcp' — and reencodableJsonPayload's own jsdoc names
  // THIS consumer ("inProcessCall's unwrap → JSON.parse") as one it must not
  // perturb. Inheriting the outer transport:'mcp' made the sub-result TOON-encoded
  // → unwrap fell back to a raw string → the composition misread .ok/.slug/.path
  // (templates:new-app returned a bogus 422 on a SUCCESSFUL harness:create, so the
  // template overlay never ran — owner-hit 2026-07-08, reproduced on the dev box).
  // Mirrors the sibling in-process re-dispatcher events/dispatch-reaction.ts.
  const innerCtx: UnifiedToolContext & { telemetrySurface?: string } = {
    ...ctx,
    transport: 'in_process',
    // WI-37843: see `ignoreSessionPayloadTier` above. Setting the key to
    // undefined (rather than omitting it) is load-bearing — it must OVERRIDE the
    // inherited `ctx.contextTier` from the spread, and resolvePayloadTier treats
    // undefined as "no session tier" ⇒ 'full'.
    ...(opts?.ignoreSessionPayloadTier ? { contextTier: undefined } : {}),
    ...(opts?.telemetrySurface ? { telemetrySurface: opts.telemetrySurface } : {}),
  };
  return async (name, args) => {
    const tool = lookupByMcpName(name);
    if (!tool) throw new Error(`compound: tool "${name}" is not registered`);
    let dispatchCtx = innerCtx;
    if (tool.crossWorkspace === true) {
      const { sql: adminTx } = getOrgPg();
      const workspaceId = innerCtx.workspaceId ?? innerCtx.principal?.workspaceId ?? '';
      dispatchCtx = {
        ...innerCtx,
        tx: adminTx,
        principal: await synthesizeDispatchPrincipal(adminTx, {
          workspaceId,
          role: innerCtx.role ?? '',
          isSuperuser: innerCtx.isSuperuser,
        }),
      };
      return runWithWorkspaceIfConcrete(dispatchCtx.workspaceId, async () => {
        const r = await dispatchProjectedTool(tool, name, args, dispatchCtx, PROJECTED_DEPS);
        if (!r.ok) {
          throw new Error(
            `${name} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`,
          );
        }
        return unwrap(r.result);
      });
    }
    const r = await dispatchProjectedTool(tool, name, args, dispatchCtx, PROJECTED_DEPS);
    if (!r.ok) {
      throw new Error(
        `${name} failed [${r.error?.code ?? 'error'}]: ${r.error?.message ?? 'unknown error'}`,
      );
    }
    return unwrap(r.result);
  };
}
