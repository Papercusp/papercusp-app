/**
 * Format-aware serialization of a `ToolResponse` → MCP `content[]` + `_meta`.
 *
 * This is the SINGLE place result-format logic lives (plan P-005/P-006/P-007).
 * Every transport's projection — the principal-gated wrapper, the role-gated
 * wrapper, and the stdio MCP server — calls `serializeToolResponse` instead of
 * its own `JSON.stringify`, so the format contract can't drift across paths.
 *
 * Contract (D-004/D-006):
 *   - `response.data` is serialized in the chosen format; the pagination /
 *     degraded ENVELOPE (`nextCursor`, `degraded`, `degradedReasons`) is routed
 *     to `_meta`, never into the tabular body — that is what makes compact
 *     formats safe for paginated list tools.
 *   - Compact payloads self-identify: `content[0].text` is prefixed with a
 *     `format: <fmt>` marker (JSON, the assumed default, carries no marker so
 *     its bytes are unchanged).
 *   - The lossless guarantee is upheld by falling back to JSON whenever the
 *     chosen compact format can't faithfully represent the data; the downgrade
 *     is labeled via `_meta.formatFallback`.
 */

import {
  encode,
  encodeAuto,
  encodeToonChecked,
  encodePositionalRows,
  isFlatObjectArray,
  isObjectWithArrayField,
  parseFormatRequest,
  readPrePromptFormat,
  isPositionalReadEncoding,
  type ColumnSpec,
  type EligibilityResult,
  type FormatRequest,
  type ResultFormat,
} from '@papercusp/result-encoding';
import type { ToolResponse } from './types';
import type { UnifiedToolContext } from './tool-projection';
import type { DeltaNegotiation } from './delta-protocol';

export interface SerializeFormatOpts {
  /** Explicit client-requested format (negotiation), already parsed. Undefined → transport default. */
  requested?: FormatRequest;
  /** Capability info derived from the tool's output schema, or undefined (no schema → runtime auto). */
  eligibility?: EligibilityResult;
  /** When nothing is explicitly requested, default to compact? (MCP agent transport → true.) */
  defaultCompact: boolean;
  /**
   * Also attach the lossless structured `data` as `structuredContent` (P-010).
   * OFF by default — gated so the model never pays for both the compact text AND
   * the full JSON; a UI/programmatic consumer opts in (`?structured=1`).
   */
  includeStructured?: boolean;
  /**
   * Full tool name (e.g. `coord:inbox`) — consulted against the pre-prompt
   * registry for the Tier-3 prompt-declared-column read path
   * (token-efficient-agent-io P-004). Undefined → the tool isn't registry-aware.
   */
  toolName?: string;
  /**
   * The tool's READ columns (projected once at registration from its output
   * `data` schema). Present only when the schema is a flat scalar array; the
   * SAME projection drives the prompt legend (anti-desync guarantee, P-011).
   */
  readColumns?: ColumnSpec[];
  /**
   * Negotiated freshness outcome (agent-tool-delta-protocol-2026-06-22, P-005),
   * computed upstream from the tool's `delta` capability + `ctx.requestedDelta`.
   * When `mode === 'not_modified'` the data body is SUPPRESSED (the harness holds
   * the matching base) and only the marker + cursor are sent; otherwise the
   * fresh cursor rides `_meta.delta` alongside the normal full body. Absent ⇒ no
   * negotiation (today's behavior). The `delta` field never appears for a tool
   * that didn't declare a `delta` capability AND didn't get a `_delta` request.
   */
  delta?: DeltaNegotiation;
}

/** Shape the negotiation into the compact `_meta.delta` envelope (omit absent fields). */
function deltaMeta(delta: DeltaNegotiation): Record<string, unknown> {
  return {
    mode: delta.mode,
    supported: delta.supported,
    ...(delta.cursor ? { cursor: delta.cursor } : {}),
    ...(delta.reason ? { reason: delta.reason } : {}),
    ...(delta.checksum ? { checksum: delta.checksum } : {}),
    ...(delta.counts ? { counts: delta.counts } : {}),
    // itemKey FIELD NAME for out-of-process generic merge (the MCP proxy) — P-004.
    ...(delta.itemKeyField ? { itemKeyField: delta.itemKeyField } : {}),
    // P-024: this view is structurally un-deltaable right now (over
    // DELTA_MAX_DIGEST_ENTRIES). Without it on the wire the response is an ordinary
    // `full` and the caller cannot tell "nothing changed" from "this will NEVER delta",
    // so it keeps paying for `_delta` round-trips that can never pay off.
    ...(delta.semanticUnavailable ? { semanticUnavailable: delta.semanticUnavailable } : {}),
  };
}

export interface SerializedToolResult {
  content: Array<Record<string, unknown>>;
  _meta: Record<string, unknown>;
  format: ResultFormat;
  /** True when the served format differs from the requested/ideal one (graceful downgrade). */
  fallback: boolean;
  /** Lossless structured `data`, present only when `includeStructured` was set (P-010). */
  structuredContent?: unknown;
}

/** Build the format options for a call from the request context + the tool's precomputed eligibility. */
export function formatOptsFromCtx(
  ctx: Pick<UnifiedToolContext, 'requestedFormat' | 'transport' | 'requestedStructured'>,
  eligibility: EligibilityResult | undefined,
): SerializeFormatOpts {
  return {
    requested: parseFormatRequest(ctx.requestedFormat),
    eligibility,
    // The MCP transport is the agent-facing surface (the LLM reads content text):
    // deliver compact by default. Every other transport (HTTP catch-all,
    // in-process, IPC) defaults to lossless JSON unless it explicitly negotiates.
    defaultCompact: ctx.transport === 'mcp',
    includeStructured: ctx.requestedStructured === true,
  };
}

/** Encode `data` in `format`, or return null when it can't be represented losslessly/validly. */
function tryEncode(format: ResultFormat, data: unknown): { format: ResultFormat; text: string } | null {
  try {
    if (format === 'json') return { format, text: encode(data, 'json') };
    if (format === 'toon') {
      const t = encodeToonChecked(data);
      return t.lossless ? { format, text: t.text } : null;
    }
    // csv / tsv / md require a flat array of scalar-only objects at runtime.
    if (!isFlatObjectArray(data)) return null;
    return { format, text: encode(data, format) };
  } catch {
    return null;
  }
}

function chooseFormat(
  data: unknown,
  opts: SerializeFormatOpts,
): { format: ResultFormat; text: string; fallback: boolean } {
  const req: FormatRequest = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
  // Bare arrays AND object-rooted-but-array-bearing payloads (bulk envelopes
  // `{ ok, results:[…], counts }`, list wrappers `{ items:[…], nextCursor }`)
  // both win from TOON; a plain object / scalar stays JSON (TOON's gain there is
  // marginal). `encodeToonChecked` is lossless-or-fallback, so attempting TOON on
  // an object is safe — a non-lossless shape falls through to JSON below.
  // (definetool-token-optimization-adoption P-001.)
  const autoBest: ResultFormat = Array.isArray(data) || isObjectWithArrayField(data) ? 'toon' : 'json';

  // `json` request → lossless JSON, unconditionally.
  if (req === 'json') {
    return { format: 'json', text: encode(data, 'json'), fallback: false };
  }

  // `compact` request (the agent default) → the auto pick (schema bestFormat,
  // else autoBest), but SIZE-GUARDED (D-005): never serve a compact body that
  // isn't actually SMALLER than JSON. TOON is lossless-checked yet can be LARGER
  // than JSON for a HETEROGENEOUS object array — rows with differing key sets
  // (e.g. a bulk envelope whose failed items carry an extra `error` field) defeat
  // TOON's tabular form and fall back to a per-row expansion bigger than JSON;
  // serving it would INCREASE tokens. Choosing JSON there is the honest optimum,
  // NOT a degradation, so `fallback` stays false. (CSV/TSV are only reached here
  // via an eligibility bestFormat over a proven-flat array, where they are
  // reliably smaller, so the same size check is safe for them.)
  if (req === 'compact') {
    const jsonText = encode(data, 'json');
    const want = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
    if (want !== 'json') {
      const r = tryEncode(want, data);
      if (r && r.text.length < jsonText.length) return { ...r, fallback: false };
    }
    return { format: 'json', text: jsonText, fallback: false };
  }

  // Explicit non-JSON format (csv/toon/tsv/md): a DELIBERATE client ask — honor it
  // (no size guard; the client chose it), trying it first, then the
  // eligibility/auto fallback, then JSON. `fallback` flags "served other than
  // `want`" — an unsupported explicit request or a shape the format can't hold.
  const want: ResultFormat = req;
  const allowed = opts.eligibility ? opts.eligibility.capabilities.has(req) : true;
  const fb = opts.eligibility ? opts.eligibility.bestFormat : autoBest;
  const candidates: ResultFormat[] = allowed ? [req, fb, 'json'] : [fb, 'json'];
  for (const f of candidates) {
    const r = tryEncode(f, data);
    if (r) return { ...r, fallback: r.format !== want };
  }
  // Unreachable in practice (json always encodes), but keep the contract total.
  // `want` is typed to the non-json formats, so the comparison is dead — cast to keep
  // the contract explicit (and tsc happy after a concurrent narrowing of the format type).
  return { format: 'json', text: encode(data, 'json'), fallback: (want as string) !== 'json' };
}

/**
 * Tier-3 read path (token-efficient-agent-io P-004/D-001): when the tool is in
 * the pre-prompt registry and its `data` is a flat scalar array, render it as a
 * HEADERLESS CSV/TSV body with a `[N]` row-count guard — the columns live in the
 * prompt's "## Wire schemas" legend, not on the wire. Returns null (fall through
 * to the normal compact path) unless every precondition holds AND the resolved
 * request is compact (an explicit `json`/`toon`/other ask is respected, so a UI
 * or lossless consumer is never handed the headerless form).
 */
function tryTier3Read(
  data: unknown,
  opts: SerializeFormatOpts,
): { format: ResultFormat; text: string } | null {
  if (!opts.toolName || !opts.readColumns || opts.readColumns.length === 0) return null;
  const fmt = readPrePromptFormat(opts.toolName);
  // 'toon' / 'off' → normal path. Shared with the legend generator so the two
  // ends of the positional protocol cannot drift (see isPositionalReadEncoding).
  if (!isPositionalReadEncoding(fmt)) return null;
  if (opts.includeStructured) return null; // structured consumer wants the lossless body
  const req: FormatRequest = opts.requested ?? (opts.defaultCompact ? 'compact' : 'json');
  if (req !== 'compact' && req !== fmt) return null; // honor an explicit different/lossless ask
  // Shape must actually be a flat array at runtime — but an EMPTY array is valid
  // (renders as `[0]`), so a Tier-3 tool always self-presents in the declared
  // format (the model never sees TOON for the empty case). A non-empty array with
  // a nested cell declines Tier-3 → safe fallback to the compact/lossless path.
  if (!Array.isArray(data)) return null;
  if (data.length > 0 && !isFlatObjectArray(data)) return null;
  const text = encodePositionalRows(data as Array<Record<string, unknown>>, opts.readColumns, fmt === 'tsv' ? '\t' : ',');
  return { format: fmt, text };
}

/**
 * Serialize a `ToolResponse` into MCP `content[]` + `_meta`. `uiResources` are
 * appended verbatim after the text item (parity with the legacy wrappers).
 */
export function serializeToolResponse(
  response: ToolResponse,
  opts: SerializeFormatOpts,
): SerializedToolResult {
  const _meta: Record<string, unknown> = {};
  const hasData = response.data !== undefined && response.data !== null;
  if (hasData) {
    if (response.nextCursor !== undefined) _meta.nextCursor = response.nextCursor;
    if (response.degraded !== undefined) _meta.degraded = response.degraded;
    if (response.degradedReasons !== undefined) _meta.degradedReasons = response.degradedReasons;
    // EI-13918: surface payload-tier truncation in `_meta` (not just inline in
    // the serialized body) so a downstream consumer that reads only `_meta`
    // (the per-result door, result-door.ts) can tell `data` is already a lossy
    // projection without parsing the body.
    if (response.payloadProjection !== undefined) _meta.payloadProjection = response.payloadProjection;
    // EI-22167228731928620: surface the explicit-full opt-out in `_meta` too,
    // for the same reason as `payloadProjection` above — the per-result door
    // (result-door.ts) reads only `_meta` and must be able to tell this body
    // is the tool's true raw output before deciding how to bound it.
    if (response.explicitFullRequest !== undefined) _meta.explicitFullRequest = response.explicitFullRequest;
  }
  const data = response.data ?? response;

  // Freshness negotiation (agent-tool-delta-protocol-2026-06-22, P-005). A
  // `not_modified` outcome SUPPRESSES the body entirely — the harness already
  // holds the matching base in context, so we send only a tiny marker + the
  // fresh cursor. This is the whole point of the protocol: don't replay an
  // unchanged snapshot into the model's context. (No data → nothing to merge →
  // base-presence-safe, D-004/D-006.) The `full` branch below attaches the
  // fresh cursor so the NEXT call can ask `not_modified`.
  if (opts.delta && opts.delta.mode === 'not_modified') {
    _meta.delta = deltaMeta(opts.delta);
    const count = Array.isArray(data)
      ? data.length
      : isObjectWithArrayField(data)
        ? undefined
        : undefined;
    const text = count !== undefined ? `mode: not_modified\ncount: ${count}` : 'mode: not_modified';
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) content.push(ui as unknown as Record<string, unknown>);
    }
    // `format: 'json'` is the internal label only — `_meta.format` is deliberately
    // left unset (there is no compact body to tag; telemetry reads delta.mode).
    return { content, _meta, format: 'json', fallback: false };
  }

  // Semantic delta (Lane E): the BODY is the changed rows (added/updated/removed),
  // not the full snapshot — a compact array the harness merges onto its retained
  // base, then verifies against `_meta.delta.checksum`. Same format machinery as a
  // full body (TOON/compact-eligible), so the changes ride the token-efficient path.
  if (opts.delta && opts.delta.mode === 'delta') {
    _meta.delta = deltaMeta(opts.delta);
    const changes = opts.delta.changes ?? [];
    const chosen = chooseFormat(changes, opts);
    _meta.format = chosen.format;
    if (chosen.fallback) _meta.formatFallback = true;
    const text = chosen.format === 'json' ? chosen.text : `format: ${chosen.format}\n${chosen.text}`;
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
    if (Array.isArray(response.uiResources)) {
      for (const ui of response.uiResources) content.push(ui as unknown as Record<string, unknown>);
    }
    return { content, _meta, format: chosen.format, fallback: chosen.fallback };
  }

  // Tier-3 (prompt-declared columns) takes precedence over the generic compact
  // path for registry tools; otherwise fall through to bestFormat/TOON-auto.
  const tier3 = tryTier3Read(data, opts);
  const chosen = tier3 ? { ...tier3, fallback: false } : chooseFormat(data, opts);
  _meta.format = chosen.format;
  if (tier3) _meta.prePrompt = true;
  if (chosen.fallback) _meta.formatFallback = true;

  // Compact payloads self-identify with a ~3-token marker; JSON (the assumed
  // default) is left unmarked so its bytes are identical to the legacy path.
  const text = chosen.format === 'json' ? chosen.text : `format: ${chosen.format}\n${chosen.text}`;

  const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
  if (Array.isArray(response.uiResources)) {
    for (const ui of response.uiResources) content.push(ui as unknown as Record<string, unknown>);
  }
  // Full-body path: attach the negotiated freshness envelope (fresh cursor, so
  // the next call can request `not_modified`; `supported:false` tells a harness
  // this endpoint isn't delta-capable so it stops sending `_delta`).
  if (opts.delta) _meta.delta = deltaMeta(opts.delta);
  const result: SerializedToolResult = { content, _meta, format: chosen.format, fallback: chosen.fallback };
  // Opt-in lossless structured payload for UI/programmatic consumers (P-010).
  //
  // EI-13245: this used to also require `chosen.format !== 'json'`, on the
  // theory that when the compact TEXT body already IS the lossless JSON,
  // structuredContent would just duplicate it. That reasoning doesn't hold:
  // `structuredContent` is a distinct MCP response field, and the official
  // MCP SDK's `Client.callTool()` enforces its presence purely from whether
  // the tool advertised an `outputSchema` in `tools/list` — it never looks at
  // `content[]`. Any tool with an object-rooted `result` schema (which is
  // EVERY tool whose chosen text format resolves to plain JSON, i.e. most
  // non-tabular tools) unconditionally advertises `outputSchema`
  // (tool-projection.ts), so a caller that opts in via `_meta.structured`
  // must always get `structuredContent` back — never conditioned on which
  // text format happened to be chosen — or a strict client throws
  // `"has an output schema but did not return structured content"` even
  // though the caller asked for exactly that. (Scoped to the full-body path:
  // no registered tool today combines an object-rooted `result` with a
  // `delta` capability, so the not_modified/delta early-returns above are
  // unaffected — see their branches if that combination is ever added.)
  if (opts.includeStructured && hasData) {
    result.structuredContent = data;
    _meta.structured = true;
  }
  return result;
}
