/**
 * Fuzzy tool-name dispatch seam (plan fuzzy-tool-name-resolution-2026-07-02, P-007 / D-008).
 *
 * `resolveDispatchTarget` (P-006) is the flag-gated policy hook; this module is what a dispatch
 * seam wraps around it so a typo-recovered call is NEVER SILENT (D-008):
 *   - the reply carries `note: interpreted "<in>" as "<out>" (distance N)` — APPENDED as a second
 *     text block (+ `_meta.fuzzyResolution`), never spliced into `content[0]`, whose text may be a
 *     JSON body a caller parses;
 *   - a telemetry row (in, out, distance, transport, model, tier, outcome) is recorded so mangling
 *     rates per model can be measured and T/M re-tuned.
 *
 * Miss-path only (D-003): an exact registered name takes the untouched fast path — zero cost, zero
 * behaviour change. Everything here is dependency-injected so the wrapper is unit-testable without
 * the MCP host; `_mcp-host.ts` supplies the real deps.
 */
import type { ProjectedTool, ResolveMcpNameOptions, ResolvedMcpName } from '@papercusp/agent-mcp';

export type FuzzyOutcome = 'resolved' | 'canonical' | 'ambiguous' | 'blocked';

/** The telemetry row (D-008): what was sent, what it became, and under what conditions. */
export interface FuzzyResolutionRecord {
  readonly in: string;
  readonly out: string | null;
  readonly distance: number | null;
  readonly transport: string;
  readonly model: string | null;
  readonly tier: string | null;
  readonly outcome: FuzzyOutcome;
  readonly alternatives: readonly string[];
}

/** The slice of an MCP `tools/call` result this module reads or extends. */
export interface ToolCallResultLike {
  content: unknown[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

export interface FuzzyDispatchDeps {
  /** Exact registry lookup — a hit means the fuzzy path is never entered (D-003). */
  readonly lookup: (name: string) => unknown;
  /** The flag-gated resolver (`resolveDispatchTarget`). */
  readonly resolve: (name: string, opts: ResolveMcpNameOptions) => Promise<ResolvedMcpName>;
  /** Names fuzzy resolution must skip (plugin-namespaced: the plugin host may still be warming). */
  readonly skip?: (name: string) => boolean;
  /** D-009: the caller's dispatchable set; `undefined` ⇒ every registered tool. */
  readonly visibleFor?: (extra: unknown) => ((tool: ProjectedTool) => boolean) | undefined;
  /** D-007: capability tier of a registered name. */
  readonly tierOf?: (mcpName: string) => string | undefined;
  readonly transport: string;
  readonly modelOf?: (extra: unknown) => string | null;
  /** Durable telemetry sink. Best-effort — a throw here must never change the reply. */
  readonly record: (rec: FuzzyResolutionRecord, extra: unknown) => Promise<void>;
}

/** `interpreted "<in>" as "<out>" (distance N)` — the D-008 annotation text. */
export function fuzzyNote(input: string, resolved: string, distance: number | null | undefined): string {
  return `note: interpreted "${input}" as "${resolved}"${distance === null || distance === undefined ? '' : ` (distance ${distance})`}`;
}

function appendNote<R extends ToolCallResultLike>(result: R, text: string, meta?: Record<string, unknown>): R {
  const next: R = {
    ...result,
    content: [...result.content, { type: 'text' as const, text }],
  };
  if (meta) next._meta = { ...(result._meta ?? {}), ...meta };
  return next;
}

/** Annotate a reply whose call was typo-recovered (D-008). Never mutates `result`. */
export function annotateFuzzyResult<R extends ToolCallResultLike>(
  result: R,
  rec: { input: string; resolvedName: string; distance: number | null },
): R {
  return appendNote(result, fuzzyNote(rec.input, rec.resolvedName, rec.distance), {
    fuzzyResolution: { in: rec.input, out: rec.resolvedName, distance: rec.distance },
  });
}

/** "Did you mean" text for a call the resolver declined (ambiguous / write-tier). */
export function refusedResolutionNote(rec: FuzzyResolutionRecord): string | null {
  if (rec.alternatives.length === 0) return null;
  if (rec.outcome === 'ambiguous') {
    return `note: "${rec.in}" was NOT auto-resolved — it is equally close to ${rec.alternatives.join(', ')}. Call the exact name.`;
  }
  if (rec.outcome === 'blocked') {
    return `note: "${rec.in}" is closest to ${rec.alternatives[0]}, a mutating tool — a mistyped name is never auto-resolved to a write. Call the exact name.`;
  }
  return null;
}

export type FuzzyLookup =
  | { readonly kind: 'exact' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'miss'; readonly record: FuzzyResolutionRecord }
  | {
      readonly kind: 'rewrite';
      readonly name: string;
      readonly tool: ProjectedTool | undefined;
      readonly record: FuzzyResolutionRecord;
    };

/**
 * Shared core for both seams: classify `name`, and on a resolvable miss say what to dispatch
 * under. Records telemetry for every non-exact outcome (best-effort).
 */
export async function resolveWithFuzzy(name: string, extra: unknown, deps: FuzzyDispatchDeps): Promise<FuzzyLookup> {
  if (deps.lookup(name) !== undefined) return { kind: 'exact' };
  if (deps.skip?.(name)) return { kind: 'skipped' };
  const visible = deps.visibleFor?.(extra);
  let r: ResolvedMcpName;
  try {
    r = await deps.resolve(name, { ...(visible ? { visible } : {}), ...(deps.tierOf ? { tierOf: deps.tierOf } : {}) });
  } catch {
    return { kind: 'skipped' };
  }
  const base = {
    in: name,
    transport: deps.transport,
    model: deps.modelOf?.(extra) ?? null,
    alternatives: r.alternatives,
  };
  const out = r.resolvedName ?? null;
  const tier = out !== null ? (deps.tierOf?.(out) ?? null) : null;
  const dispatchable = r.tool !== undefined && out !== null && (r.via === 'fuzzy' || r.via === 'canonical');
  if (dispatchable) {
    const record: FuzzyResolutionRecord = {
      ...base,
      out,
      distance: r.distance ?? 0,
      tier,
      outcome: r.via === 'fuzzy' ? 'resolved' : 'canonical',
    };
    await deps.record(record, extra).catch(() => undefined);
    return { kind: 'rewrite', name: out, tool: r.tool, record };
  }
  if (r.ambiguous || r.blocked) {
    const record: FuzzyResolutionRecord = {
      ...base,
      out,
      distance: r.distance ?? null,
      tier,
      outcome: r.blocked ? 'blocked' : 'ambiguous',
    };
    await deps.record(record, extra).catch(() => undefined);
    return { kind: 'miss', record };
  }
  return { kind: 'skipped' };
}

/**
 * Wrap a `tools/call` handler: a mangled name is rewritten to its canonical registered name
 * BEFORE the handler runs (so every gate, quota and telemetry key sees the real tool), and the
 * reply is annotated (D-008). Unresolvable names reach the handler unchanged, so today's
 * `unknown_tool` referral still fires — enriched with the resolver's alternatives.
 */
export function withFuzzyToolName<Req extends { params: { name: string } }, Res extends ToolCallResultLike>(
  inner: (req: Req, extra: unknown) => Promise<Res>,
  deps: FuzzyDispatchDeps,
): (req: Req, extra: unknown) => Promise<Res> {
  return async (req, extra) => {
    const name = req.params.name;
    const lookup = await resolveWithFuzzy(name, extra, deps);
    if (lookup.kind === 'rewrite') {
      const res = await inner({ ...req, params: { ...req.params, name: lookup.name } }, extra);
      return lookup.record.outcome === 'resolved'
        ? annotateFuzzyResult(res, { input: name, resolvedName: lookup.name, distance: lookup.record.distance })
        : res;
    }
    const res = await inner(req, extra);
    if (lookup.kind === 'miss' && res.isError) {
      const note = refusedResolutionNote(lookup.record);
      if (note) return appendNote(res, note);
    }
    return res;
  };
}
