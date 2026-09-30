/**
 * guidance.seeAlso — result-aware cross-link pointers.
 *
 * The RESULT-TIME complement to `guidance.chaining`. Where `chaining` is a
 * static line rendered into the tool DESCRIPTION at catalog/selection time
 * ("what to call next"), `seeAlso` is computed from the ACTUAL tool result at
 * dispatch time so it can fill in real counts + the exact selector and
 * self-gate (emit nothing when not relevant). The dispatch layer renders it
 * uniformly into every transport envelope — structured `_meta._seeAlso` + a
 * one-line "See also:" text block — the same "declare once, project across
 * HTTP/MCP/IPC" model the endpoint system already uses.
 *
 * presence-coord-unification-2026-07-01 D-003.
 */
import type { ToolResult } from './wire';

/** A single cross-link pointer: the adjacent lens / sibling tool / history door. */
export interface SeeAlsoPointer {
  /** The tool to point at, e.g. `"coord:catch-up"`. Required. */
  tool: string;
  /** Why / when to reach for it, e.g. `"who was ever here"`. Kept short. */
  reason?: string;
  /** A concrete selector/arg to pass, e.g. `"@fleet:backend"` or `"owner:<id>"`. */
  selector?: string;
}

/** A see-also entry: a structured pointer, or a bare tool string for simple cases. */
export type SeeAlsoEntry = string | SeeAlsoPointer;

/**
 * Result-aware see-also guidance. Either:
 *  - a STATIC list (simple cases — evaluated as-is), or
 *  - a FUNCTION computed from the actual result so it can fill in real counts +
 *    the exact selector and self-gate (return `[]`/`null` to emit nothing).
 *
 * `args`/`ctx` are intentionally loosely typed (`unknown`) to keep this leaf
 * module free of host/role coupling; adopters narrow with a cast. Read the
 * semantic output of a content-encoded tool with {@link readJsonResult}.
 */
export type SeeAlso =
  | readonly SeeAlsoEntry[]
  | ((
      result: ToolResult,
      args: unknown,
      ctx: unknown,
    ) => readonly SeeAlsoEntry[] | null | undefined);

/** Normalize a single entry to a pointer; a bare string becomes `{ tool }`. */
function normalizeEntry(entry: SeeAlsoEntry): SeeAlsoPointer | null {
  if (typeof entry === 'string') {
    const tool = entry.trim();
    return tool ? { tool } : null;
  }
  if (
    entry &&
    typeof entry === 'object' &&
    typeof entry.tool === 'string' &&
    entry.tool.trim()
  ) {
    const p: SeeAlsoPointer = { tool: entry.tool.trim() };
    if (typeof entry.reason === 'string' && entry.reason.trim()) p.reason = entry.reason.trim();
    if (typeof entry.selector === 'string' && entry.selector.trim()) {
      p.selector = entry.selector.trim();
    }
    return p;
  }
  return null;
}

/**
 * Resolve a `guidance.seeAlso` value against a concrete result into a list of
 * normalized pointers. Evaluating the function form NEVER throws out — a broken
 * seeAlso callback must never fail the underlying tool call, so we swallow and
 * return `[]`.
 */
export function resolveSeeAlso(
  seeAlso: SeeAlso | undefined,
  result: ToolResult,
  args: unknown,
  ctx: unknown,
): SeeAlsoPointer[] {
  if (!seeAlso) return [];
  let entries: readonly SeeAlsoEntry[] | null | undefined;
  if (typeof seeAlso === 'function') {
    try {
      entries = seeAlso(result, args, ctx);
    } catch {
      return [];
    }
  } else {
    entries = seeAlso;
  }
  if (!entries || !Array.isArray(entries)) return [];
  const out: SeeAlsoPointer[] = [];
  for (const e of entries) {
    const p = normalizeEntry(e);
    if (p) out.push(p);
  }
  return out;
}

/** Render pointers to a single "See also:" line: `tool selector — reason; …`. */
export function renderSeeAlsoText(pointers: readonly SeeAlsoPointer[]): string {
  const parts = pointers.map((p) => {
    let s = p.tool;
    if (p.selector) s += ` ${p.selector}`;
    if (p.reason) s += ` — ${p.reason}`;
    return s;
  });
  return `See also: ${parts.join('; ')}`;
}

/**
 * Convenience for content-encoded tools (those returning a JSON-stringified
 * output as the first text block): parse it back into the semantic object a
 * `seeAlso` callback wants to read. Returns `undefined` on any failure.
 */
export function readJsonResult<T = unknown>(result: ToolResult): T | undefined {
  const first = result.content?.find((c) => c.type === 'text');
  if (!first || first.type !== 'text') return undefined;
  try {
    return JSON.parse(first.text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Apply `guidance.seeAlso` to a tool result: inject a structured
 * `_meta._seeAlso` array + append a one-line "See also:" text block to
 * `content`. Returns the result UNCHANGED when there are no pointers
 * (self-gating), when the tool declares no `seeAlso`, or when the result is a
 * soft error — so unrelated / failed calls pay nothing. Never throws.
 */
export function applySeeAlso(
  result: ToolResult,
  seeAlso: SeeAlso | undefined,
  args: unknown,
  ctx: unknown,
): ToolResult {
  if (!seeAlso || result.isError) return result;
  const pointers = resolveSeeAlso(seeAlso, result, args, ctx);
  if (pointers.length === 0) return result;
  return {
    ...result,
    _meta: { ...(result._meta ?? {}), _seeAlso: pointers },
    content: [...result.content, { type: 'text' as const, text: renderSeeAlsoText(pointers) }],
  };
}
