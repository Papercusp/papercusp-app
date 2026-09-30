/**
 * Payload tiers — a per-session / per-call axis over WHAT a tool returns
 * (field selection, row caps), distinct from the result-FORMAT axis
 * (serialize-result.ts, which encodes whatever data it is given).
 *
 * Contract (context-trimming-tiers-2026-07-01 D-004, owner-ratified):
 *   - `full` IS the tool's unshaped response while it fits the transport.
 *     Normal-size unshaped tools remain byte-identical (zero migration);
 *     oversized default-tier responses get a loud generic projection.
 *   - Tools opt in incrementally by declaring `shape.standard` /
 *     `shape.trimmed` on their definition; resolution falls back
 *     trimmed → standard → full.
 *   - The session's tier rides the host context (`ctx.contextTier`, wired by
 *     the host from its transport — e.g. an MCP URL param); any single call
 *     may override with a `payloadTier` arg (stripped before schema
 *     validation), so a trimmed session can always fetch one full payload.
 *   - Shaping NEVER breaks a call: a throwing shaper logs and serves the
 *     unshaped data.
 *   - No silent caps at the meta level: when a non-full session would receive
 *     a LARGE unshaped payload, the framework returns a bounded projection
 *     with omission evidence + a full-detail re-fetch instruction. A
 *     once-per-tool ratchet warning still names the missing custom shaper.
 *   - HARD CEILING (WI-2859): even `full` must fit the transport result cap —
 *     an over-cap result is rejected/file-dumped by the client, which is worse
 *     than a graceful downgrade. So a result over PAYLOAD_TIER_HARD_CEILING_CHARS
 *     force-applies the smallest declared shaper regardless of the resolved tier.
 */
import type { ToolResponse } from './types';

export type PayloadTier = 'trimmed' | 'standard' | 'full';
export const PAYLOAD_TIERS: readonly PayloadTier[] = ['trimmed', 'standard', 'full'] as const;

/** Context handed to a shaper: the validated call args + the resolved tier. */
export interface PayloadShaperCtx {
  args: unknown;
  tier: 'trimmed' | 'standard';
}

/**
 * Per-tool payload shapers. Each takes the handler's `data` and returns the
 * tier-appropriate projection of it (smaller field set, capped rows — with
 * counts/pointers for anything dropped, never a silent cap). Both optional:
 * absent tiers fall back down the chain (trimmed → standard → full).
 */
export interface PayloadShapers {
  standard?: (data: unknown, sctx: PayloadShaperCtx) => unknown;
  trimmed?: (data: unknown, sctx: PayloadShaperCtx) => unknown;
  /**
   * EI-20803112372029993 — opt a row-shaped `trimmed` projection into the
   * contract check (`trimmed-contract.ts`).
   *
   * A `trimmed` shaper that REBUILDS each row from a hardcoded allowlist drops
   * any field not on that list, on the tier agents get BY DEFAULT — and the
   * result still reads `ok:true` with a well-formed row, so the field looks
   * absent from the data rather than removed by the shaper. `routines:list`
   * shipped exactly that defect three times on one allowlist.
   *
   * Declaring `rows` is the whole opt-in. The FIELD LIST is deliberately NOT
   * repeated here: it is derived from the tool's own `guidance.returns`
   * "Each row: { a, b, c }" promise, so the promise and the check are one
   * artifact and cannot drift. `fields` is the escape hatch for a tool whose
   * `returns` prose is not in that form.
   */
  contract?: {
    /** Key of the row array in the handler's `data` envelope (e.g. `'routines'`). */
    rows: string;
    /** Override the fields parsed from `returns`. Prefer the derived list. */
    fields?: readonly string[];
    /**
     * ADDITIONAL row sets, each with its own required fields. Judged exactly
     * like `rows`/`fields`, once per axis.
     *
     * Two jobs, and the first is what makes the second reachable:
     *
     * 1. SATISFY THE SHAPER'S ENTRY GUARD. The check synthesises the envelope
     *    it feeds the shaper, and from `rows` alone it can only build one
     *    array. A shaper that bails unless SEVERAL arrays are present returns
     *    its input untouched, so the contract passes while asserting nothing.
     *    Naming the co-required sets here gets the shaper to actually run.
     * 2. GUARD A SECOND PROJECTOR. One tool often rebuilds two row kinds from
     *    two independent allowlists; a single `rows` axis can only ever guard
     *    one of them, leaving the other with the exact failure mode the pin
     *    exists to kill.
     */
    alsoRows?: Readonly<Record<string, readonly string[]>>;
    /**
     * Top-level envelope keys the trimmed projection must retain beside `rows`.
     * These are typically qualifiers such as scope, provenance, or bounded-read
     * metadata whose removal can make otherwise intact rows misleading.
     */
    preserve?: readonly string[];
  };
}

/** The arg key itself, exported so a consumer that needs to NAME it — e.g.
 *  `unknownArgHint`'s accepted-key rendering (EI-22174225494240206) — has one
 *  source instead of a second hand-typed `'payloadTier'` literal. */
export const PAYLOAD_TIER_ARG = 'payloadTier' as const;

export function parsePayloadTier(v: unknown): PayloadTier | undefined {
  return typeof v === 'string' && (PAYLOAD_TIERS as readonly string[]).includes(v)
    ? (v as PayloadTier)
    : undefined;
}

/**
 * Pull a per-call `payloadTier` override out of the RAW input (before schema
 * validation — the arg is framework-reserved, not part of any tool's schema).
 * Unknown/absent values leave the input untouched.
 */
export function extractPayloadTier(input: unknown): { input: unknown; callTier?: PayloadTier } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { input };
  const raw = (input as Record<string, unknown>)[PAYLOAD_TIER_ARG];
  if (raw === undefined) return { input };
  const callTier = parsePayloadTier(raw);
  const { [PAYLOAD_TIER_ARG]: _dropped, ...rest } = input as Record<string, unknown>;
  return { input: rest, callTier };
}

/** Per-call override outranks the session tier; absent both ⇒ full. */
export function resolvePayloadTier(
  callTier: PayloadTier | undefined,
  ctxTier: PayloadTier | undefined,
  opts?: {
    /**
     * WI-37843: this tool declared `ignoreSessionPayloadTier` — routine
     * per-session shaping does not apply to it, so the SESSION tier is
     * discarded and an un-overridden call resolves to 'full'.
     *
     * Deliberately narrow: an EXPLICIT per-call `payloadTier` still wins, so a
     * caller that asks for 'trimmed' still gets 'trimmed'. Only the ambient
     * session tier is ignored — the thing the caller never chose.
     */
    ignoreSessionTier?: boolean;
  },
): PayloadTier {
  if (opts?.ignoreSessionTier) return callTier ?? 'full';
  return callTier ?? ctxTier ?? 'full';
}

/** Unshaped payloads above this (JSON chars) served to a non-full session trip
 *  the ratchet warning — roughly the "worth writing a shaper" bar. */
export const PAYLOAD_TIER_RATCHET_CHARS = 8_000;

/**
 * HARD CEILING (JSON chars). A tool result — even `full`, even an already-shaped
 * one — must NEVER exceed the transport's result cap: the MCP client rejects an
 * over-cap result and dumps it to a file the caller has to page back in (the
 * coord:orient 59.8KB incident, WI-2859). So when a response exceeds this and the
 * tool DECLARED a shaper, force-apply the SMALLEST shaper regardless of the
 * resolved tier — graceful degradation (top rows + fetch-pointers) instead of a
 * hard failure. Set well under a typical client cap; force-shaping only ever
 * triggers on genuinely oversized payloads, so normal results are untouched. */
export const PAYLOAD_TIER_HARD_CEILING_CHARS = 30_000;

/** Generic projections intentionally leave ample room for transport envelopes. */
const GENERIC_PROJECTION_TARGET_CHARS: Record<'trimmed' | 'standard', number> = {
  trimmed: 7_000,
  standard: 18_000,
};
// Request args are a recovery hint, not a second result body. Keep their
// serialized contribution independently bounded so a large write request
// (for example, a bulk coord:send body) cannot re-expand a bounded result.
const GENERIC_PROJECTION_CURSOR_ARGS_TARGET_CHARS = 2_000;
const GENERIC_PROJECTION_OMISSION_SAMPLES = 20;

export interface BoundedPayloadProjection {
  _projection: {
    kind: 'bounded-payload';
    truncated: true;
    tier: PayloadTier;
    forced: boolean;
    originalChars: number;
    returnedChars: number;
    omittedCount: number;
    omitted: Array<{ path: string; reason: string }>;
    /** True when the `omitted` SAMPLE list was itself shortened to buy budget back
     *  for real content (EI-21215297173311865). `omittedCount` remains exact — only
     *  the per-path examples were shed. Absent means the sample list is as complete
     *  as GENERIC_PROJECTION_OMISSION_SAMPLES allows. */
    omittedSamplesDropped?: true;
    /**
     * Paths the caller EXPLICITLY selected (`preservePaths` — a `projection.pick`
     * or a tool's own door declaration) that were nevertheless dropped.
     *
     * EI-22186855527494865: `omitted` is a SAMPLE list, and the sample-shedding
     * ladder below trades it away entirely (to 5, then to 0) to buy budget back
     * for content — so the one omission a caller cannot possibly infer, the
     * absence of the field they asked for BY NAME, is exactly the one that gets
     * shed. Measured on `plans:get { shipReadiness:true }`: `omittedCount:24`
     * with `omitted:[]`, and no `shipReadiness` key, which reads as "nothing is
     * blocking this plan" — a false green on a ship gate. This list is tiny,
     * capped, and NEVER shed, because an unrequested field going missing is a
     * detail while a REQUESTED one going missing inverts the reading.
     */
    omittedPreserved?: readonly string[];
    cursor: {
      /** Host-defined recovery cursors may page a durable spill instead of
       * re-running the producing tool. `full-detail` remains the default. */
      kind: string;
      tool: string;
      args: Record<string, unknown>;
      /** True when args is an identity-only preview and cannot be replayed as-is. */
      argsTruncated?: true;
      [key: string]: unknown;
    };
    next: string;
  };
  [key: string]: unknown;
}

export interface BoundedPayloadRecovery {
  /** A schema-valid call the client can execute directly. */
  cursor: BoundedPayloadProjection['_projection']['cursor'];
  /** Human-readable recovery instruction paired with the cursor. */
  next: string;
}

/**
 * How a bounded projection recognizes the keyed-array bulk contract. Bulk
 * envelopes are special because a successful row can contain a large detail
 * object while a failed row's `{ ok:false, <key>, error }` is the only evidence
 * a caller needs to decide what to retry. When the budget is tight, evaluate
 * failed rows before those bulky successes, then restore the selected rows to
 * their original input order.
 */
export interface BulkEnvelopeProjectionOpts {
  /** Top-level array key (the house contract uses `results`). */
  resultsKey?: string;
  /** Per-row outcome key (the house contract uses `ok`). */
  failureKey?: string;
  /** Top-level accounting key (the house contract uses `counts`). */
  countsKey?: string;
}

export interface ProjectBoundedPayloadOpts {
  toolName: string;
  tier: PayloadTier;
  forced?: boolean;
  originalChars?: number;
  args?: unknown;
  /** Exact serialized target for this projection. The default remains the
   * tier's generic payload budget; transport doors can pass their own cap. */
  targetChars?: number;
  /** Override the default raw-args re-call with a host-owned durable cursor. */
  recovery?: BoundedPayloadRecovery;
  /**
   * Top-level fields the host must keep visible in the last-resort identity
   * fallback. The normal projection already preserves insertion order, but its
   * final metadata defense intentionally rebuilds a tiny identity-only preview;
   * a host may nominate an additional load-bearing field (for example,
   * coord:orient's post-compaction recovery block) for that rebuild.
   */
  preserveTopLevelKeys?: readonly string[];
  /**
   * Keep a projected top-level array as an array in the serialized result.
   *
   * The generic payload-tier contract defaults to an object wrapper so its
   * `_projection` metadata survives JSON serialization. A model-facing result
   * door may opt into the source tool's array root instead; metadata remains
   * attached as a non-enumerable property for the in-memory caller and the
   * door's own machine-readable metadata path.
   */
  preserveArrayRoot?: boolean;
  /**
   * Explicit caller-selected paths that must remain addressable when the bounded
   * preview reaches its depth/key fallback. The result door supplies the same
   * paths its caller used for `projection.pick`; values remain subject to the
   * normal string, key, array, and transport budgets.
   */
  preservePaths?: readonly string[];
  /**
   * EI-20720054720826414: the host's concrete raw-args dispatch spelling for a
   * `payloadTier:'full'` re-call (`{tool}` substituted with the tool name) —
   * see UnifiedToolContext.rawDispatchTemplate. Present ⇒ the recovery `next`
   * prints an EXECUTABLE call; absent ⇒ the generic host-neutral wording.
   */
  rawDispatchTemplate?: string;
  /**
   * Preserve semantic failures in keyed-array bulk results before projecting
   * bulky successful rows. `true` uses the house `{ results, counts, ok }`
   * spelling; an object customizes those keys. Omit to infer the house shape
   * from a canonical bulk envelope, or pass `false` to disable inference.
   */
  bulkEnvelope?: BulkEnvelopeProjectionOpts | boolean;
}

/** Once-per-(tool,tier) dedup for ratchet warnings — a worklist, not a log storm. */
const ratchetWarned = new Set<string>();

/** Test seam. */
export function resetPayloadTierRatchet(): void {
  ratchetWarned.clear();
}

/** Best-effort serialized length; 0 on a circular/throwing value. */
function jsonLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}

interface ProjectionState {
  remaining: number;
  omittedCount: number;
  omitted: Array<{ path: string; reason: string }>;
  /**
   * A second, independently-capped bucket for omissions that MUST survive into
   * the final sample regardless of how many lower-priority (field/depth) entries
   * arrived first. EI-19965559011729712: an array-ELEMENT drop (the count a
   * caller reads back — `criteria[12]` vs the true 17) was being silently
   * starved out of `omitted` by up to 20 per-field/per-depth entries recorded
   * for the elements that DID survive, so the one omission that actually
   * changes the apparent completeness of the result never made the sample.
   * Merged ahead of `omitted` when the metadata is assembled.
   */
  priorityOmitted: Array<{ path: string; reason: string }>;
  /** Explicitly-preserved paths this walk dropped anyway — see
   *  BoundedPayloadProjection._projection.omittedPreserved. */
  preservedOmittedPaths: string[];
  active: WeakSet<object>;
  limits: { maxArray: number; maxDepth: number; maxKeys: number; maxString: number };
  /**
   * The recovery route THIS projection's omission markers advertise. Per-
   * projection because the two callers of `projectBoundedPayload` recover by
   * different routes, and a marker naming the wrong one is a lie the model
   * trusts (see `omissionMarker`). Derived once in `projectBoundedPayload`.
   */
  recoveryPointer: string;
  preservePaths: readonly PreservePathSegment[][];
  bulkEnvelope?: Required<BulkEnvelopeProjectionOpts>;
}

type PreservePathSegment =
  | { kind: 'key'; name: string }
  | { kind: 'array' }
  | { kind: 'index'; index: number };

/** Parse the same dot/bracket path subset used by the dispatch projection seam. */
function parsePreservePath(path: string): PreservePathSegment[] {
  const segments: PreservePathSegment[] = [];
  for (const token of path.split('.')) {
    if (token === '') continue;
    const head = token.replace(/(\[\d*\])+$/, '');
    if (head) segments.push({ kind: 'key', name: head });
    const brackets = token.slice(head.length).match(/\[\d*\]/g) ?? [];
    for (const bracket of brackets) {
      const inner = bracket.slice(1, -1);
      segments.push(inner === '' ? { kind: 'array' } : { kind: 'index', index: Number(inner) });
    }
  }
  return segments;
}

/** Return path suffixes that select an object child; an empty path selects all descendants. */
function preserveObjectChildPaths(
  paths: readonly PreservePathSegment[][],
  key: string,
): PreservePathSegment[][] {
  const childPaths: PreservePathSegment[][] = [];
  for (const path of paths) {
    if (path.length === 0) {
      childPaths.push([]);
    } else if (path[0].kind === 'key' && path[0].name === key) {
      childPaths.push(path.slice(1));
    }
  }
  return childPaths;
}

/** Return path suffixes that select an array element; an empty path selects all descendants. */
function preserveArrayChildPaths(
  paths: readonly PreservePathSegment[][],
  index: number,
): PreservePathSegment[][] {
  const childPaths: PreservePathSegment[][] = [];
  for (const path of paths) {
    if (path.length === 0) {
      childPaths.push([]);
    } else if (path[0].kind === 'array' || (path[0].kind === 'index' && path[0].index === index)) {
      childPaths.push(path.slice(1));
    }
  }
  return childPaths;
}

function hasPreservedObjectChild(paths: readonly PreservePathSegment[][], key: string): boolean {
  return preserveObjectChildPaths(paths, key).length > 0;
}

/**
 * Where this key sits in the caller's DECLARED preserve order — the index of the
 * first `preservePaths` entry that selects it, or -1 when none does.
 *
 * EI-22186855527494865: a boolean "is preserved" flattened every selected path to
 * ONE priority, so two preserved siblings tied and fell back to insertion order —
 * and on `plans:get` the bulky one (`results[].items[].text`) is inserted before
 * the small one (`results[].shipReadiness`), so a large plan's items ate the whole
 * budget and the explicitly-requested ship verdict was still dropped. Measured: 22
 * items survived it, 126 did not, and reordering the preserve LIST changed nothing
 * because both entries ranked identically. Ranking by declared order makes the
 * caller's own ordering the tie-break, which is the only signal available that says
 * which of two requested fields matters more.
 */
function preservedChildRank(paths: readonly PreservePathSegment[][], key: string): number {
  for (let i = 0; i < paths.length; i += 1) {
    const path = paths[i];
    if (path.length === 0 || (path[0].kind === 'key' && path[0].name === key)) return i;
  }
  return -1;
}

/** Cap on the paths named in `_projection.omittedPreserved` — a pointer list, not a manifest. */
const PRESERVED_OMISSION_PATHS = 5;

/**
 * Record that an explicitly-preserved path was dropped anyway. Does NOT touch
 * `omittedCount` — the caller has already counted this key inside its aggregate
 * "remaining fields omitted" entry; this only makes the drop NAMEABLE.
 */
function notePreservedOmission(state: ProjectionState, path: string, reason: string): void {
  if (state.priorityOmitted.length < GENERIC_PROJECTION_OMISSION_SAMPLES) {
    state.priorityOmitted.push({ path, reason });
  }
  if (
    state.preservedOmittedPaths.length < PRESERVED_OMISSION_PATHS &&
    !state.preservedOmittedPaths.includes(path)
  ) {
    state.preservedOmittedPaths.push(path);
  }
}

/** Name every explicitly-preserved key in a dropped tail of object entries. */
function notePreservedDrops(
  state: ProjectionState,
  path: string,
  dropped: ReadonlyArray<[string, unknown]>,
  preservePaths: readonly PreservePathSegment[][],
): void {
  for (const [key] of dropped) {
    if (preservedChildRank(preservePaths, key) < 0) continue;
    notePreservedOmission(
      state,
      `${path}.${key}`,
      'explicitly preserved field omitted to fit projection budget',
    );
  }
}

function normalizeBulkEnvelopeOption(
  value: BulkEnvelopeProjectionOpts | boolean | undefined,
): Required<BulkEnvelopeProjectionOpts> | undefined {
  if (value === false) return undefined;
  if (value === true) return { resultsKey: 'results', failureKey: 'ok', countsKey: 'counts' };
  if (value === undefined) return undefined;
  return {
    resultsKey: value.resultsKey?.trim() || 'results',
    failureKey: value.failureKey?.trim() || 'ok',
    countsKey: value.countsKey?.trim() || 'counts',
  };
}

function inferBulkEnvelope(value: unknown): Required<BulkEnvelopeProjectionOpts> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const envelope = value as Record<string, unknown>;
  const rows = envelope.results;
  const counts = envelope.counts;
  if (!Array.isArray(rows) || counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    return undefined;
  }
  const accounting = counts as Record<string, unknown>;
  if (typeof accounting.ok !== 'number' || typeof accounting.failed !== 'number') return undefined;
  // A generic object with `results` and `counts` is not enough on its own: only
  // infer the special walk when a failure row exposes the keyed bulk outcome
  // shape. Success-only envelopes continue through the ordinary identity-first
  // walk; the special ordering is needed specifically to rescue failures that
  // would otherwise be visited after bulky successful rows, and this narrower
  // discriminator avoids changing nested result summaries that happen to use the
  // same outer `{ ok, results, counts }` spelling.
  if (!rows.some((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
    const record = row as Record<string, unknown>;
    return record.ok === false || record.ok === 'failed' || record.ok === 'error' ||
      Object.prototype.hasOwnProperty.call(record, 'error');
  })) return undefined;
  return { resultsKey: 'results', failureKey: 'ok', countsKey: 'counts' };
}

function isBulkFailureRow(value: unknown, config: Required<BulkEnvelopeProjectionOpts>): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const outcome = row[config.failureKey];
  return outcome === false || outcome === 'failed' || outcome === 'error' ||
    Object.prototype.hasOwnProperty.call(row, 'error');
}

function isBulkResultsPath(path: string, config: Required<BulkEnvelopeProjectionOpts> | undefined): boolean {
  return config != null && path === `$.${config.resultsKey}`;
}

function bulkEnvelopeKeyPriority(
  path: string,
  key: string,
  config: Required<BulkEnvelopeProjectionOpts> | undefined,
): number {
  if (config == null || path !== '$') return 0;
  // Keep the tiny outcome/accounting fields in front of the large row array.
  if (key === config.failureKey || key === config.countsKey) return 20;
  if (key === config.resultsKey) return -1;
  return 0;
}

/**
 * Select the rows that have the highest recovery value from a bulk envelope.
 * Failures are selected before successes so a tail `{ok:false,error}` row is
 * not hidden behind the ordinary row cap. The returned indexes are sorted back
 * into input order for the caller; only the projection work order is failure
 * first.
 */
function selectBulkResultIndexes(
  rows: readonly unknown[],
  maxRows: number,
  config: Required<BulkEnvelopeProjectionOpts>,
): number[] {
  const failureIndexes: number[] = [];
  const successIndexes: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    (isBulkFailureRow(rows[index], config) ? failureIndexes : successIndexes).push(index);
  }
  return [...failureIndexes, ...successIndexes]
    .slice(0, Math.max(0, maxRows))
    .sort((a, b) => a - b);
}

function projectBulkResultsArray(
  value: unknown[],
  path: string,
  state: ProjectionState,
  preservePaths: readonly PreservePathSegment[][],
): unknown[] {
  const config = state.bulkEnvelope;
  if (config == null || !isBulkResultsPath(path, config)) return [];

  const selectedIndexes = selectBulkResultIndexes(value, state.limits.maxArray, config);
  const projectedByIndex = new Map<number, unknown>();
  // The work order deliberately differs from output order: failures first get
  // the shared budget, then successes spend whatever remains. This is what
  // makes a failure at the tail visible even when preceding success rows carry
  // large workItem/checkpoint/summary payloads.
  const workIndexes = [...selectedIndexes].sort((a, b) => {
    const failureDelta = Number(isBulkFailureRow(value[b], config)) - Number(isBulkFailureRow(value[a], config));
    return failureDelta || a - b;
  });
  for (const index of workIndexes) {
    if (state.remaining < 128) break;
    // A custom envelope may call its outcome field something other than `ok`.
    // Promote that configured field into the row's identity preview so the
    // failure/success discriminator remains visible after the same budget cut.
    const childPreservePaths = [
      ...preserveArrayChildPaths(preservePaths, index),
      [{ kind: 'key', name: config.failureKey } as const],
    ];
    projectedByIndex.set(
      index,
      projectIdentityPreview(value[index], `${path}[${index}]`, 0, state, childPreservePaths),
    );
  }

  const projected: unknown[] = [];
  for (const index of selectedIndexes) {
    const row = projectedByIndex.get(index);
    if (row === undefined && !projectedByIndex.has(index)) continue;
    projected.push(row);
  }
  // The row cap and budget can each omit input rows. Count both, but do not
  // invent a gap in the output: the marker describes the actual projected rows
  // and the original rendered input population.
  const droppedCount = value.length - projectedByIndex.size;
  if (droppedCount > 0) {
    recordOmission(
      state,
      `${path}[${projected.length}]`,
      `${droppedCount} bulk result row(s) omitted; failures were prioritized and output order follows input order; showing ${projected.length} of ${value.length} rendered input entries`,
      droppedCount,
      true,
    );
    projected.push(arrayTruncationValue(projected, droppedCount, projected.length, value.length));
  }
  return projected;
}

/**
 * The two recovery routes an omission marker can honestly advertise.
 *
 * `CURSOR` — a durable artifact holding the FULL pre-projection body already
 * exists (the caller passed `opts.recovery`; at the model-facing result door
 * that is the spill, written from `result.content` BEFORE this projection
 * runs). The omitted values are in it, so point there — which is also what
 * `truncationMarker`/`arrayTruncationMarker` already say.
 *
 * `RE_CALL` — no durable artifact. The exit is a re-call carrying an explicit
 * `payloadTier:'full'`, which sets `explicitFullRequest` and skips the
 * hard-ceiling force-shape (see `applyPayloadTier`) — but that route is
 * CONDITIONAL, and this marker is too short to carry the condition. It used to
 * read `re-call with payloadTier:'full'` and say nothing else, while
 * `buildDefaultRecoveryNext` — twenty lines away, building the `next` field of
 * this same projection — spelled out that `payloadTier` is framework-reserved,
 * stripped before schema validation, absent from the tool's published schema,
 * and therefore REJECTED by a schema-validating client on a direct call.
 *
 * Two emitters in one module, disagreeing about one route. The uncaveated one
 * is the string an agent actually reads (it travels INSIDE the truncated
 * payload, fired up to 5x per result) while the honest one is a sibling field
 * that is routinely not read — so the divergence resolved, every time, toward
 * the over-claim. WI-1697551.
 *
 * So it defers instead of asserting: it names the field that carries the whole
 * conditional story, exactly as `CURSOR` names the artifact that holds the
 * bytes. Both pointers now say "the truth is HERE" rather than "this call will
 * work". It is also 11 chars shorter than the claim it replaces, and this
 * string shares the projection's char budget with the retained preview
 * (EI-20685195115158619), so the honest form is the cheap one too.
 *
 * `recovery-pointer-guard.test.ts` is the recurrence guard for the class.
 */
const RECOVERY_POINTER = {
  CURSOR: 'recover: see _projection.cursor',
  RE_CALL: 'recover: see _projection.next',
} as const;

function recordOmission(
  state: ProjectionState,
  path: string,
  reason: string,
  count = 1,
  priority = false,
): void {
  state.omittedCount += Math.max(1, count);
  const bucket = priority ? state.priorityOmitted : state.omitted;
  if (bucket.length < GENERIC_PROJECTION_OMISSION_SAMPLES) {
    bucket.push({ path, reason });
  }
}

/**
 * A clipped string must ANNOUNCE ITS OWN CLIPPING, IN BAND.
 *
 * EI-19447969329510166. The previous marker was a bare `…` — a character that
 * occurs constantly inside real content (checkpoints, prose, tool guidance,
 * this very file's comments), so a truncated value was INDISTINGUISHABLE from a
 * complete one. The only evidence lived in a sibling `_projection.omitted` entry
 * the reader has to think to correlate.
 *
 * Measured cost: a `work_items:get` checkpoint clipped from ~13,000 chars to 800
 * read as a complete (if terse) note — the visible head ended mid-sentence at a
 * `-` and the reader nearly acted on a SUPERSEDED root-cause block whose
 * retraction sat in the dropped 85%. On the designated continuity surface a
 * silent clip does not merely lose information, it MANUFACTURES confident wrong
 * state, which is strictly worse than returning nothing.
 *
 * The marker is charged to the same projection budget as the content, so keep it
 * cheap — but never confusable with content. The square-bracket form matches
 * this file's existing `[circular]` / `[omitted: projection budget]` convention,
 * and `TRUNCATED` is greppable in a transcript.
 */
function truncationMarker(omittedChars: number): string {
  return `…[TRUNCATED +${omittedChars} chars — see _projection.cursor]`;
}

function clipString(value: string, keep: number): string {
  const head = value.slice(0, Math.max(0, keep));
  return `${head}${truncationMarker(value.length - head.length)}`;
}

/**
 * WI-36048 (borrow item 1 of the opencode/OMP token-reduction research).
 *
 * The sibling of `truncationMarker` above, for values dropped WHOLE rather than
 * clipped. Both answer the same question — "what was here, and can I get it
 * back?" — and until now only the clip path did.
 *
 * The comparison that motivated it: OMP replaces evicted content with
 * `[shaken ~N tokens — recover: artifact://<id> (region N)]`; opencode uses a
 * fixed `[Old tool result content cleared]`. The first tells the model how much
 * went and how to get it back, so it can decide whether recovery is worth a
 * call; the second tells it neither, so the only rational move is to re-run the
 * whole tool or silently proceed on partial data. Our bare
 * `[omitted: projection budget]` was the second kind.
 *
 * ⚠ The research is equally explicit that a self-describing placeholder is WORSE
 * than nothing if the recovery pointer it advertises does not resolve — it
 * becomes a lie the model trusts. So WHICH pointer is correct depends on the
 * caller, and this marker must not hard-code one.
 *
 * EI-19371883353428338 measured what hard-coding cost. This marker named
 * `payloadTier:'full'` unconditionally, including at the model-facing result
 * door where that lever provably cannot lift the cut. On `work_items:get` the
 * same request through all three documented routes — a bare re-call, a re-call
 * with `payloadTier:'full'`, and `tools:invoke { args:{ …, payloadTier:'full' }}`
 * (the door's own `rawDispatchTemplate`) — returned a BYTE-IDENTICAL truncated
 * body, while the spill this comment used to dismiss held the complete field
 * (3042 of 3042 chars, no truncation marker). Both halves of the old rationale
 * were inverted, and the marker fired 5x per result saying so confidently.
 *
 * The cause is that two layers cut, and `explicitFullRequest` exempts only one:
 * `applyPayloadTier`'s hard-ceiling force-shape. The result door
 * (`result-door.ts`) is a separate cut with no such exemption — but it spills
 * `result.content` BEFORE projecting, so its omitted values ARE recoverable,
 * just by the cursor rather than by a re-call. It signals this by passing
 * `opts.recovery`; that presence is the discriminant used below.
 *
 * Size is included only where the caller ALREADY computed it. The depth-boundary
 * sites deliberately omit it rather than pay a `JSON.stringify` per dropped node
 * — this marker is charged to the same projection budget as the content it
 * replaces, so it stays cheap.
 */
function omissionMarker(pointer: string, reason: string, omittedChars?: number): string {
  const size = omittedChars != null && omittedChars > 0 ? `, ~${omittedChars} chars` : '';
  return `[omitted: ${reason}${size} — ${pointer}]`;
}

/**
 * An array whose ELEMENT COUNT was truncated must announce it the same way a
 * clipped string does (see `truncationMarker`) — otherwise the array's own
 * `.length` (and any header a downstream encoder derives from it, e.g. TOON's
 * `key[N]{fields}`) silently asserts a complete count. Appended as an extra
 * element so the signal travels WITH the array into whatever the caller does
 * with it — a `.length` read, a completeness check, a rendered table header —
 * rather than living only in a `_projection.omitted` entry a reader has to
 * think to correlate (EI-19965559011729712). The marker names both numbers and
 * explains that the downstream header includes the marker itself: TOON has no
 * lossless `N of TOTAL` header syntax, so the adjacent marker is the honest
 * bounded-count label. `renderedCount` is deliberately named as a rendered
 * input count: this generic projector cannot know how many rows the underlying
 * query matched before its input was materialized, so it must never imply that
 * this number is a query population total.
 */
function arrayTruncationMarker(droppedCount: number, shownCount: number, renderedCount: number): string {
  return `[TRUNCATED +${droppedCount} more item(s) — header count includes this marker; showing ${shownCount} of ${renderedCount} rendered input entries — renderedCount is NOT the query population; see _projection.cursor]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Preserve an array's element contract while keeping truncation visible in band.
 *
 * ⚠ `projectedRows` MUST be the array the marker is about to be APPENDED TO — not
 * the source array it was projected from (EI-21219452028880493). The two diverge,
 * and only the projected one is what the caller ends up iterating:
 *
 *  - a source element PAST the truncation window can be a non-object (a stray
 *    string, a nested array, a marker left by an earlier shaping pass) while every
 *    element the caller can SEE is an object. Judging by the source then picked the
 *    string form and handed back a heterogeneous array — the reported failure, where
 *    locks:queue returned `active_locks` with a string among objects and
 *    `jq group_by(.lock_id)` died with "Cannot index string with string lock_id".
 *  - symmetrically, a source of all plain objects can PROJECT to strings (an element
 *    replaced by `omissionMarker(...)`, `'[circular]'`, or a depth-limit marker),
 *    where judging by the source would append an object into an array of strings.
 *
 * The rule is simply that the marker must match the contract of the array it JOINS.
 * An empty `projectedRows` carries no contract to preserve, so it keeps the string.
 */
function arrayTruncationValue(
  projectedRows: unknown[],
  droppedCount: number,
  shownCount: number,
  renderedCount: number,
): string | Record<string, unknown> {
  const note = arrayTruncationMarker(droppedCount, shownCount, renderedCount);
  if (projectedRows.length > 0 && projectedRows.every(isPlainObject)) {
    return {
      id: '(truncated)',
      // This is an ARRAY MARKER, not a domain row. `id:'(truncated)'` remains
      // for backwards compatibility with callers that already filter that
      // sentinel, but the explicit discriminator keeps positional readers from
      // treating the marker's missing message fields as a failed/empty entry
      // (EI-23481355842555588).
      kind: 'projection-truncation',
      type: 'projection-truncation',
      _truncated: true,
      omittedCount: droppedCount,
      shownCount,
      renderedCount,
      note,
    };
  }
  return note;
}

function takePrimitive(state: ProjectionState, value: unknown, path: string): unknown {
  if (typeof value !== 'string') {
    const size = jsonLen(value);
    if (size > state.remaining) {
      recordOmission(state, path, 'value omitted to fit projection budget');
      return omissionMarker(state.recoveryPointer, 'projection budget', size);
    }
    state.remaining -= size;
    return value;
  }

  // Two independent clip pressures — the per-tier `maxString` cap and the
  // running budget. The SECOND one used to be entirely silent: the old halving
  // loop appended a bare `…` and never called recordOmission at all, so a string
  // clipped by budget alone produced NO in-band marker AND no `_projection`
  // entry — nothing anywhere said it had been cut. Both paths now converge on
  // one clip + exactly one omission record carrying the FINAL char count.
  let keep = value.length > state.limits.maxString ? state.limits.maxString : value.length;
  let candidate = keep < value.length ? clipString(value, keep) : value;
  let size = jsonLen(candidate);
  while (size > state.remaining && keep > 32) {
    keep = Math.max(32, Math.floor(keep / 2) - 1);
    candidate = clipString(value, keep);
    size = jsonLen(candidate);
  }
  if (keep < value.length) {
    recordOmission(state, path, `${value.length - keep} string characters omitted`);
  }
  if (size > state.remaining) {
    recordOmission(state, path, 'value omitted to fit projection budget');
    // The WHOLE string is dropped here, not the clipped candidate — so the
    // omitted amount is the original length, which we already have for free.
    return omissionMarker(state.recoveryPointer, 'projection budget', value.length);
  }
  state.remaining -= size;
  return candidate;
}

/**
 * Identity fields survive when a useful row lands exactly at the generic depth
 * limit. EI-11404's concrete failure was a recipes:run summary containing ten
 * successful work_items:get envelopes: every array element became the same
 * `[omitted: depth limit]` scalar, erasing the ids needed to fetch or act on a
 * row. At the boundary we now spend the remaining budget on a deliberately
 * small per-row projection instead of erasing the whole value.
 */
const IDENTITY_FIELDS = new Set([
  'id', 'title', 'name', 'slug', 'ref', 'kind', 'state', 'status', 'ok', 'error',
  'item', 'itemId', 'key', 'plan', 'planSlug', 'rubricRef', 'workItemId',
  // A bounded object may already be passing through a second projection seam
  // (payload tier -> result door). Its honesty markers and array-count receipt
  // are identity too: dropping them recreates a complete-looking partial row.
  '_partial', '_omitted', '_truncated', 'omittedCount', 'shownCount', 'renderedCount', 'totalCount',
  // EI-21197620758075816: a rubric criterion's structured `check` is its
  // executable identity. Dropping it makes a bound criterion indistinguishable
  // from a fuzzy/unbound one. The value is handled as a bounded structured
  // field below so its discriminated-union payload (files/instrument/scope)
  // survives without promoting generic keys such as `files` globally.
  'check',
  // EI-21364690783677984: a rubric criterion's `method` is the GRADING
  // INSTRUCTION its reader acts on, so losing it is not a neutral loss of
  // detail — it silently changes the verdict.
  //
  // Measured 2026-08-31. Criterion 1's method carried a REFERENCE OBSERVATION
  // (a row the author supplies "so it can be CHECKED, not re-read as the
  // answer") FOLLOWED by the prohibition "do NOT rate `pass` on the reference
  // row alone". The cut kept the reference and dropped the prohibition, so the
  // grader measured the author's own supplied row, agreed with it, and rated
  // `pass` — the exact failure that criterion was written to prevent. It cost a
  // wrong acceptance card and a public retraction. A truncation that preserves
  // a HAZARD while removing its SAFETY RAIL does not merely lose information,
  // it inverts the instrument — the same class `truncationMarker` above exists
  // for, one level up.
  //
  // Kept so it survives the depth cut. When it is still too long for the tier
  // it is CLIPPED by `clipString`, whose in-band marker tells the grader the
  // instruction is incomplete — which is the whole point: a partial method that
  // reads as whole is what produced the bad grade.
  'method',
  // EI-21058972492075433: the outcome-identity of a WRITE/LAUNCH receipt (a
  // singleton fire-and-can't-safely-retry call like release:checkpoint-run) —
  // "did it launch, and against what" is exactly as load-bearing as `ok`/`id`
  // above, and just as cheap to prioritize ahead of verbose diagnostics.
  'launched', 'candidate', 'unit', 'runId',
]);
const IDENTITY_ENVELOPES = new Set(['results', 'items', 'workItem', 'counts']);
const STRUCTURED_IDENTITY_FIELDS = new Set(['check']);
const IDENTITY_PREVIEW_DEPTH = 4;
/** Announces, ON a depth-compacted object, that non-identity fields were withheld —
 *  so a partial object is never read as a complete one (EI-21364503818966104).
 *  Underscore-prefixed to match `_projection` and stay clear of real payload keys. */
const PARTIAL_MARKER_KEY = '_omitted';
/** Minimal, machine-readable truth bit for EVERY object that loses a direct
 * field to depth/key/budget projection. The prose `_omitted` marker remains the
 * richer explanation when it fits; this bit is deliberately cheap enough to
 * survive the exact budget edge where that explanation cannot. */
const PARTIAL_FLAG_KEY = '_partial';
const PARTIAL_MARKER_MAX_KEYS = 6;

function identityPriority(key: string): number {
  // Correlation outranks outcome. A row with only `{ok:true}` is unusable and
  // reads complete; `{id,_partial:true}` is both attributable and honest.
  if (key === 'id' || key === 'itemId' || key === 'workItemId' || key === 'ref') return 4;
  if (key === PARTIAL_FLAG_KEY || key === PARTIAL_MARKER_KEY || key === '_truncated') return 3;
  return IDENTITY_FIELDS.has(key) ? 2 : IDENTITY_ENVELOPES.has(key) ? 1 : 0;
}

/** Base rank for an explicitly-preserved key — strictly above every identity tier. */
const PRESERVED_PRIORITY_BASE = 100;

/**
 * Projection order for one object key: an explicitly-preserved key outranks every
 * identity tier, and among preserved keys the caller's DECLARED order decides
 * (earlier path wins). Falls back to `identityPriority` for everything else.
 */
function keyProjectionPriority(
  preservePaths: readonly PreservePathSegment[][],
  key: string,
): number {
  const rank = preservedChildRank(preservePaths, key);
  if (rank < 0) return identityPriority(key);
  // Floor at 6 so even a pathologically long preserve list still ranks every
  // selected key above `id` (4) rather than sinking beneath the identity tiers.
  return Math.max(6, PRESERVED_PRIORITY_BASE - rank);
}

function markPartial(projected: Record<string, unknown>, state: ProjectionState): void {
  if (projected[PARTIAL_FLAG_KEY] === true) return;
  projected[PARTIAL_FLAG_KEY] = true;
  // Charge the flag when there is room, but never suppress the truth bit at the
  // boundary that caused it. The exact serialized-size backstop below remains
  // authoritative for pathological escaping/metadata combinations.
  const cost = jsonLen(PARTIAL_FLAG_KEY) + jsonLen(true) + 3;
  state.remaining = Math.max(0, state.remaining - cost);
}

function projectIdentityPreview(
  value: unknown,
  path: string,
  depth: number,
  state: ProjectionState,
  preservePaths: readonly PreservePathSegment[][] = state.preservePaths,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return takePrimitive(state, value, path);
  }
  if (typeof value === 'bigint') return takePrimitive(state, value.toString(), path);
  if (typeof value === 'undefined') return takePrimitive(state, '[undefined]', path);
  if (typeof value === 'function' || typeof value === 'symbol') {
    return takePrimitive(state, `[${typeof value}]`, path);
  }
  if (value instanceof Date) return takePrimitive(state, value.toISOString(), path);
  if (value instanceof Error) {
    return projectIdentityPreview({ name: value.name, error: value.message }, path, depth, state, preservePaths);
  }
  if (typeof value !== 'object') return takePrimitive(state, String(value), path);
  if (state.active.has(value)) {
    recordOmission(state, path, 'circular reference omitted');
    return '[circular]';
  }
  if (depth >= IDENTITY_PREVIEW_DEPTH) {
    recordOmission(state, path, 'non-identity detail omitted at compact preview depth');
    return omissionMarker(state.recoveryPointer, 'compact preview depth');
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      const shown = value.slice(0, state.limits.maxArray);
      const projected: unknown[] = [];
      for (let i = 0; i < shown.length; i += 1) {
        if (state.remaining < 128) break;
        projected.push(
          projectIdentityPreview(
            shown[i],
            `${path}[${i}]`,
            depth + 1,
            state,
            preserveArrayChildPaths(preservePaths, i),
          ),
        );
      }
      const droppedCount = value.length - projected.length;
      if (droppedCount > 0) {
        // priority: an element-count drop must survive the omitted[] sample cap
        // even when per-row entries for the KEPT elements would otherwise fill it
        // first (EI-19965559011729712).
        recordOmission(
          state,
          `${path}[${projected.length}]`,
          `${droppedCount} identity row(s) omitted; showing ${projected.length} of ${value.length} rendered input entries`,
          droppedCount,
          true,
        );
        projected.push(arrayTruncationValue(projected, droppedCount, projected.length, value.length));
      }
      return projected;
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const chosen = entries
      .filter(
        ([key]) =>
          IDENTITY_FIELDS.has(key) ||
          IDENTITY_ENVELOPES.has(key) ||
          hasPreservedObjectChild(preservePaths, key),
      )
      .sort(
        (a, b) =>
          keyProjectionPriority(preservePaths, b[0]) -
          keyProjectionPriority(preservePaths, a[0]),
      );
    if (chosen.length === 0) {
      recordOmission(state, path, 'nested value omitted at projection depth limit');
      return omissionMarker(state.recoveryPointer, 'depth limit');
    }

    const projected: Record<string, unknown> = {};
    let chosenProjected = 0;
    for (const [key, child] of chosen) {
      const keyCost = jsonLen(key) + 2;
      if (state.remaining < keyCost + 128) {
        recordOmission(state, `${path}.${key}`, 'remaining identity fields omitted to fit projection budget', chosen.length - chosenProjected);
        notePreservedDrops(state, path, chosen.slice(chosenProjected), preservePaths);
        markPartial(projected, state);
        break;
      }
      state.remaining -= keyCost;
      const childPreservePaths = preserveObjectChildPaths(preservePaths, key);
      projected[key] =
        childPreservePaths.length > 0 || STRUCTURED_IDENTITY_FIELDS.has(key)
          ? projectValue(child, `${path}.${key}`, 0, state, childPreservePaths)
          : projectIdentityPreview(child, `${path}.${key}`, depth + 1, state, childPreservePaths);
      chosenProjected += 1;
    }
    const dropped = entries.length - chosen.length;
    if (dropped > 0) {
      recordOmission(state, `${path}.*`, `${dropped} non-identity fields omitted at projection depth limit`, dropped);
      markPartial(projected, state);
      // EI-21364503818966104: the surviving identity fields make this object look
      // WHOLE. A reader cannot tell "the field is empty in the store" from "the
      // projection withheld it", and the global _projection.omitted[] list is both
      // easy to read past and sample-capped — so the object must announce its own
      // partialness. This cost a false major bug filing plus wrong findings
      // delivered to two rubric authors: `rubrics:get` renders each criterion down
      // to title+check, and populated model/method/driftMarkers read as absent.
      // Naming the dropped keys is what makes it actionable (you can see WHICH
      // falsifier is missing), so spend the bytes on names when the budget allows.
      const droppedKeys = entries
        .filter(([key]) => !IDENTITY_FIELDS.has(key) && !IDENTITY_ENVELOPES.has(key))
        .map(([key]) => key);
      const shownKeys = droppedKeys.slice(0, PARTIAL_MARKER_MAX_KEYS);
      const named = shownKeys.length < droppedKeys.length
        ? `${shownKeys.join(', ')}, +${droppedKeys.length - shownKeys.length} more`
        : shownKeys.join(', ');
      const marker = `[omitted: ${dropped} non-identity field(s) at projection depth limit: ${named} — ${state.recoveryPointer}]`;
      const markerCost = jsonLen(PARTIAL_MARKER_KEY) + jsonLen(marker) + 4;
      if (state.remaining >= markerCost) {
        state.remaining -= markerCost;
        projected[PARTIAL_MARKER_KEY] = marker;
      }
    }
    return projected;
  } finally {
    state.active.delete(value);
  }
}

function projectValue(
  value: unknown,
  path: string,
  depth: number,
  state: ProjectionState,
  preservePaths: readonly PreservePathSegment[][] = state.preservePaths,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return takePrimitive(state, value, path);
  }
  if (typeof value === 'bigint') return takePrimitive(state, value.toString(), path);
  if (typeof value === 'undefined') return takePrimitive(state, '[undefined]', path);
  if (typeof value === 'function' || typeof value === 'symbol') {
    return takePrimitive(state, `[${typeof value}]`, path);
  }
  if (value instanceof Date) return takePrimitive(state, value.toISOString(), path);
  if (value instanceof Error) {
    return projectValue({ name: value.name, message: value.message }, path, depth, state, preservePaths);
  }
  if (typeof value !== 'object') return takePrimitive(state, String(value), path);
  if (state.active.has(value)) {
    recordOmission(state, path, 'circular reference omitted');
    return '[circular]';
  }
  if (depth >= state.limits.maxDepth) {
    // An explicit `projection.pick` may end exactly at this object (the empty
    // preserve-path suffix means "keep this value"). The ordinary identity
    // preview is intentionally lossy and therefore wrong for that request:
    // once the suffix is consumed it would keep only identity keys, making a
    // selected object such as `payload.observation` look partial even though
    // the caller named the object itself. Restart the normal bounded walk at
    // this selected endpoint. Passing no preserve paths is deliberate: the
    // caller selected this object, not every descendant, so nested values keep
    // their ordinary depth/key/string limits and circular-reference handling.
    if (preservePaths.some((preservePath) => preservePath.length === 0)) {
      return projectValue(value, path, 0, state, []);
    }
    recordOmission(state, path, 'nested value compacted at projection depth limit');
    return projectIdentityPreview(value, path, 0, state, preservePaths);
  }

  state.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (isBulkResultsPath(path, state.bulkEnvelope)) {
        return projectBulkResultsArray(value, path, state, preservePaths);
      }
      const shown = value.slice(0, state.limits.maxArray);
      const projected: unknown[] = [];
      for (let i = 0; i < shown.length; i += 1) {
        if (state.remaining < 128) break;
        const childPreservePaths = preserveArrayChildPaths(preservePaths, i);
        projected.push(
          preservePaths.length > 0 && shown.length > 1
            ? projectIdentityPreview(shown[i], `${path}[${i}]`, 0, state, childPreservePaths)
            : projectValue(shown[i], `${path}[${i}]`, depth + 1, state, childPreservePaths),
        );
      }
      const droppedCount = value.length - projected.length;
      if (droppedCount > 0) {
        // priority: an element-count drop must survive the omitted[] sample cap
        // even when per-row entries for the KEPT elements would otherwise fill it
        // first — this is the omission that changes the array's APPARENT
        // completeness (a `criteria[12]` header/`.length` read over a 17-element
        // source), so it must never be the one that gets starved out
        // (EI-19965559011729712). The in-band marker also travels WITH the array
        // itself, so a downstream encoder's own element count reflects the drop.
        recordOmission(
          state,
          `${path}[${projected.length}]`,
          `${droppedCount} array item(s) omitted; showing ${projected.length} of ${value.length} rendered input entries`,
          droppedCount,
          true,
        );
        projected.push(arrayTruncationValue(projected, droppedCount, projected.length, value.length));
      }
      return projected;
    }

    // EI-18683546971375407: project IDENTITY_FIELDS (id/ok/kind/title/status/…)
    // BEFORE any other key, regardless of the object's own insertion order. Without
    // this, a bulk `results[i]` element whose non-identity fields (workItem,
    // checkpoint, summary, …) are large can exhaust `state.remaining` partway
    // through the key loop — and since the budget check below breaks the loop the
    // MOMENT it trips, whichever keys hadn't been reached yet (often `id` itself,
    // since handlers conventionally return `{ ok, id, ...detail }` but detail is
    // what's bulky) are silently dropped, producing a bare `{ok:true}` or even `{}`
    // stub that has lost its correlation key entirely. That reads exactly like a
    // dropped row (a bulk caller sees fewer usable results than ids requested,
    // `ok:true`, no error) when the row was actually present, just stripped bare by
    // projection. Same failure CLASS as EI-11404's depth-limit case (which already
    // fixed the analogous problem at the nesting-depth boundary via
    // projectIdentityPreview) — this fixes the budget-exhaustion boundary in the
    // NORMAL (non-depth-limited) path with the same IDENTITY_FIELDS priority.
    const entries = Object.entries(value as Record<string, unknown>);
    const prioritized = entries.length > 1
      ? [...entries].sort(
          (a, b) => {
            const bulkDelta =
              bulkEnvelopeKeyPriority(path, b[0], state.bulkEnvelope) -
              bulkEnvelopeKeyPriority(path, a[0], state.bulkEnvelope);
            return bulkDelta || keyProjectionPriority(preservePaths, b[0]) - keyProjectionPriority(preservePaths, a[0]);
          },
        )
      : entries;
    const projected: Record<string, unknown> = {};
    const shown = prioritized.slice(0, state.limits.maxKeys);
    let partial = prioritized.length > shown.length;
    for (let i = 0; i < shown.length; i += 1) {
      const [key, child] = shown[i];
      const keyCost = jsonLen(key) + 2;
      if (state.remaining < keyCost + 128) {
        recordOmission(state, `${path}.${key}`, 'remaining fields omitted to fit projection budget', shown.length - i);
        notePreservedDrops(state, path, shown.slice(i), preservePaths);
        partial = true;
        break;
      }
      state.remaining -= keyCost;
      projected[key] = projectValue(
        child,
        `${path}.${key}`,
        depth + 1,
        state,
        preserveObjectChildPaths(preservePaths, key),
      );
    }
    if (prioritized.length > shown.length) {
      recordOmission(state, `${path}.*`, `${prioritized.length - shown.length} object fields omitted`, prioritized.length - shown.length);
      notePreservedDrops(state, path, prioritized.slice(shown.length), preservePaths);
    }
    if (partial) markPartial(projected, state);
    return projected;
  } finally {
    state.active.delete(value);
  }
}

/**
 * Keep the recovery cursor useful without copying an arbitrarily large request
 * into the bounded result. Small argument objects remain exact. Once they
 * cross the cursor budget, retain only identity-shaped fields; nested request
 * bodies become omission markers and the caller is told to use its originals.
 */
function projectCursorArgs(args: unknown): {
  args: Record<string, unknown> & { payloadTier: 'full' };
  truncated: boolean;
} {
  const source = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  const exact = { ...source, payloadTier: 'full' as const };
  const exactSize = jsonLen(exact);
  if (exactSize > 0 && exactSize <= GENERIC_PROJECTION_CURSOR_ARGS_TARGET_CHARS) {
    return { args: exact, truncated: false };
  }

  const state: ProjectionState = {
    // Leave room for the payloadTier key and JSON punctuation. The final size
    // check below is still authoritative for pathological keys/escaping.
    remaining: GENERIC_PROJECTION_CURSOR_ARGS_TARGET_CHARS - 128,
    omittedCount: 0,
    omitted: [],
    priorityOmitted: [],
    preservedOmittedPaths: [],
    active: new WeakSet<object>(),
    limits: { maxArray: 12, maxDepth: 5, maxKeys: 40, maxString: 800 },
    // This projection BUILDS the cursor args, so it cannot point at the cursor
    // it is producing. It defers to `_projection.next` instead — which, for
    // this branch, is `buildDefaultRecoveryNext(opts, argsTruncated: true)`:
    // the one string that says these args are a bounded identity preview and
    // the ORIGINAL args are what to restore. That is strictly more than the
    // bare re-call this used to name, and it is co-located, so the two cannot
    // drift apart.
    recoveryPointer: RECOVERY_POINTER.RE_CALL,
    preservePaths: [],
  };
  const preview = projectIdentityPreview(source, '$._projection.cursor.args', 0, state);
  const bounded = preview && typeof preview === 'object' && !Array.isArray(preview)
    ? { ...(preview as Record<string, unknown>), payloadTier: 'full' as const }
    : { payloadTier: 'full' as const };

  // This is deliberately fail-closed. A malformed/circular arg object must
  // never make the cursor unbounded merely because JSON.stringify failed.
  if (jsonLen(bounded) === 0 || jsonLen(bounded) > GENERIC_PROJECTION_CURSOR_ARGS_TARGET_CHARS) {
    return { args: { payloadTier: 'full' }, truncated: true };
  }
  return { args: bounded, truncated: true };
}

/**
 * The generic recovery `next` for a bounded payload — kept budget-conscious on
 * purpose: this string shares the projection's char budget with the retained
 * preview, so every char here evicts a preview field (EI-20685195115158619).
 * With a host `rawDispatchTemplate` the abstract "route through your host's
 * raw-args dispatch path" explainer is REPLACED by the concrete executable
 * call, so the executable branch is no longer than the abstract one.
 */
function buildDefaultRecoveryNext(opts: ProjectBoundedPayloadOpts, argsTruncated: boolean): string {
  const rawCall = opts.rawDispatchTemplate?.replaceAll('{tool}', opts.toolName);
  const lessHint =
    ` Prefer LESS over more: re-call with the tool's own narrowing args (limit/since/filters) ` +
    `or projection { pick: ["[].field"] } instead of paging a full payload.`;
  if (argsTruncated) {
    return (
      `Call ${opts.toolName} again with the ORIGINAL request args and payloadTier:'full' for full detail. ` +
      `_projection.cursor.args is only a bounded identity preview; ` +
      (rawCall
        ? `dispatch it as: ${rawCall} (with the original args restored).`
        : `route the original args through your host's raw-args dispatch path.`) +
      lessHint
    );
  }
  return (
    `Call ${opts.toolName} again with _projection.cursor.args for full detail. ` +
    `NOTE: 'payloadTier' is FRAMEWORK-RESERVED — stripped before schema validation and absent from ` +
    `${opts.toolName}'s published schema (additionalProperties:false), so a schema-validating client ` +
    `REJECTS it on a direct call; ` +
    (rawCall
      ? `dispatch it as: ${rawCall}.`
      : `route these args through your host's raw-args dispatch path instead.`) +
    lessHint
  );
}

/**
 * Framework fallback for a large result whose tool has no usable custom
 * shaper. It preserves a structural preview, makes every omission explicit,
 * and points to the opt-in full-detail request. The returned value is always
 * an object so arrays/scalars can carry projection metadata too.
 */
export function projectBoundedPayload(
  data: unknown,
  opts: ProjectBoundedPayloadOpts,
): BoundedPayloadProjection {
  const projectionTier = opts.tier === 'standard' ? 'standard' : 'trimmed';
  const configuredTarget = opts.targetChars;
  const target = typeof configuredTarget === 'number' && Number.isFinite(configuredTarget)
    ? Math.max(1_500, Math.floor(configuredTarget))
    : GENERIC_PROJECTION_TARGET_CHARS[projectionTier];
  const state: ProjectionState = {
    remaining: Math.max(1_000, target - 1_600),
    omittedCount: 0,
    omitted: [],
    priorityOmitted: [],
    preservedOmittedPaths: [],
    active: new WeakSet<object>(),
    limits: projectionTier === 'standard'
      ? { maxArray: 40, maxDepth: 8, maxKeys: 100, maxString: 2_500 }
      : { maxArray: 12, maxDepth: 5, maxKeys: 40, maxString: 800 },
    // A caller-supplied `recovery` is a durable artifact holding the FULL
    // pre-projection body (at the result door, the spill — written from
    // `result.content` before this runs). Its presence is what makes the
    // cursor the pointer that RESOLVES; without it the only exit is the
    // explicit-full re-call. EI-19371883353428338: advertising the re-call at
    // the door was measurably inert, so this is chosen per projection.
    recoveryPointer: opts.recovery ? RECOVERY_POINTER.CURSOR : RECOVERY_POINTER.RE_CALL,
    preservePaths: (opts.preservePaths ?? [])
      .map(parsePreservePath)
      .filter((path) => path.length > 0),
    bulkEnvelope:
      normalizeBulkEnvelopeOption(opts.bulkEnvelope) ??
      (opts.bulkEnvelope === false ? undefined : inferBulkEnvelope(data)),
  };
  const preview = projectValue(data, '$', 0, state);
  const cursorArgs = projectCursorArgs(opts.args);
  const metadata: BoundedPayloadProjection['_projection'] = {
    kind: 'bounded-payload',
    truncated: true,
    tier: opts.tier,
    forced: opts.forced === true,
    originalChars: opts.originalChars ?? jsonLen(data),
    returnedChars: 0,
    omittedCount: Math.max(1, state.omittedCount),
    // priorityOmitted first: an array-element-count drop must never be starved
    // out of the sample by lower-priority field/depth entries recorded for the
    // elements that survived (EI-19965559011729712).
    omitted: [...state.priorityOmitted, ...state.omitted].slice(0, GENERIC_PROJECTION_OMISSION_SAMPLES),
    // EI-22186855527494865: a separate, never-shed list. `omitted` above is a
    // SAMPLE the ladder below trades away for content; a field the caller asked
    // for BY NAME must stay nameable after that trade.
    ...(state.preservedOmittedPaths.length > 0
      ? { omittedPreserved: [...state.preservedOmittedPaths] }
      : {}),
    cursor: opts.recovery?.cursor ?? {
      kind: 'full-detail',
      tool: opts.toolName,
      args: cursorArgs.args,
      ...(cursorArgs.truncated ? { argsTruncated: true as const } : {}),
    },
    // EI-19447969329510166: this used to read "Call <tool> with the EXACT args in
    // _projection.cursor.args" — advice that is literally un-executable from a
    // schema-validating client. `payloadTier` is framework-reserved: it is pulled
    // off the raw input by extractPayloadTier BEFORE schema validation, so it is
    // deliberately absent from every published input schema, and
    // deepStrictifyInPlace stamps those schemas additionalProperties:false. The
    // caller therefore gets a validation rejection while following the tool's own
    // printed recovery instruction — at exactly the moment they are trying to
    // recover a field they have just been told was dropped. Say what is true —
    // and, when the host has told us its raw-dispatch spelling
    // (rawDispatchTemplate, EI-20720054720826414), say the EXECUTABLE thing:
    // "route through your host's raw-args dispatch path" is a description of an
    // instruction, not an instruction. Both branches also close with the
    // ask-for-LESS lead: for an oversized result, narrowing beats paging.
    next: opts.recovery?.next ?? buildDefaultRecoveryNext(opts, cursorArgs.truncated),
  };
  const buildArrayRootResult = (
    body: unknown[],
    meta: BoundedPayloadProjection['_projection'],
  ): BoundedPayloadProjection => {
    // JSON.stringify intentionally ignores non-index array properties, so the
    // model-facing body stays a bare array while callers inside this process can
    // still inspect the durable projection metadata before serialization.
    Object.defineProperty(body, '_projection', {
      value: meta,
      enumerable: false,
      configurable: true,
    });
    return body as unknown as BoundedPayloadProjection;
  };
  const buildResultFrom = (
    body: unknown,
    meta: BoundedPayloadProjection['_projection'],
  ): BoundedPayloadProjection =>
    Array.isArray(body)
      ? opts.preserveArrayRoot
        ? buildArrayRootResult(body, meta)
        : { items: body, _projection: meta }
      : body && typeof body === 'object'
        ? { ...(body as Record<string, unknown>), _projection: meta }
        : { value: body, _projection: meta };
  const buildResult = (meta: BoundedPayloadProjection['_projection']): BoundedPayloadProjection =>
    buildResultFrom(preview, meta);
  let result: BoundedPayloadProjection = buildResult(metadata);
  metadata.returnedChars = jsonLen(result);

  // Exact last-line defense: pathological keys/escaping must not defeat the
  // transport bound even if the approximate recursion budget under-counted.
  //
  // EI-21058972492075433: the walk above already spent ITS OWN budget honestly
  // and preserved identity fields (ok/launched/candidate/unit/...) whenever they
  // fit — what usually pushes the total over here is the METADATA built on TOP
  // of that preview (up to GENERIC_PROJECTION_OMISSION_SAMPLES omission entries
  // plus a GENERIC_PROJECTION_CURSOR_ARGS_TARGET_CHARS-sized cursor.args), not
  // the data itself. A rich write receipt (release:checkpoint-run's launch
  // reply, with a repair-queue object, excluded-commit lists, and a long prose
  // note) can legitimately produce enough distinct omissions to blow the fixed
  // metadata reserve on its own. Discarding the WHOLE preview here used to throw
  // those already-fitting identity fields away too — unrecoverable for a caller
  // that must not retry a singleton write just to learn whether it launched.
  //
  // Fall back to a SEPARATELY, tightly budgeted identity-only preview instead of
  // a bare summary placeholder, so the load-bearing outcome fields survive even
  // when the full preview + metadata genuinely cannot. Only when NOTHING
  // identifiable survives even that (no id/ok/launched/... anywhere in the
  // payload) does this keep the old all-detail-erased summary — there is
  // nothing left to preserve.
  if (metadata.returnedChars >= Math.min(target, PAYLOAD_TIER_HARD_CEILING_CHARS)) {
    // EI-21215297173311865: shed the DIAGNOSTIC manifest before sacrificing DATA.
    // The block above correctly identifies the metadata as what usually blows the
    // bound — but the identity-only fallback below then discards the whole preview
    // while keeping that same oversized metadata intact, which inverts the value
    // order: `omitted[]` is a list of per-path EXAMPLES a caller can re-derive
    // nothing from, whereas the preview is the only copy of the data. Observed on
    // coord:orient { afterCompaction:true } — a 131KB payload returned `{ok:true}`
    // plus a ~2.9KB manifest of 152 omissions and ZERO content fields, which reads
    // as a successful orient over an empty world (no peers, no claims, no unanswered
    // messages) precisely on the post-compaction path where the caller has the least
    // independent state to notice.
    //
    // `omittedCount` — the load-bearing number, and the marker that keeps a bounded
    // measurement from reading as a real zero — is preserved at full precision in
    // every branch; only the per-path samples are shed, disclosed via
    // `omittedSamplesDropped`. Recovery (`cursor` + `next`) is never traded away:
    // it is what makes the omission actionable.
    const ceiling = Math.min(target, PAYLOAD_TIER_HARD_CEILING_CHARS);
    let leanMetadata = metadata;
    for (const sampleCap of [5, 0]) {
      if (leanMetadata.omitted.length <= sampleCap) continue;
      leanMetadata = {
        ...metadata,
        omitted: metadata.omitted.slice(0, sampleCap),
        omittedSamplesDropped: true,
        returnedChars: 0,
      };
      const candidate = buildResult(leanMetadata);
      const candidateChars = jsonLen(candidate);
      if (candidateChars < ceiling) {
        candidate._projection.returnedChars = candidateChars;
        return candidate;
      }
    }

    // Shedding samples alone is not always enough, and the reason is structural: the
    // preview above was budgeted against a FIXED metadata reserve (target - 1_600)
    // that this call's metadata overran, so preview + metadata cannot fit however
    // much of the manifest is shed. Re-project the DATA against the budget the lean
    // metadata actually leaves, instead of dropping to an identity-only husk. A
    // PARTIAL reading of the real payload beats a complete inventory of what was
    // withheld — the caller can act on the former and can re-derive nothing from the
    // latter.
    // `state.remaining` is an APPROXIMATE recursion budget (see the "pathological
    // keys/escaping" note above — it is exactly why this exact-measurement backstop
    // exists), so a single sized attempt can still overshoot. Step the content
    // budget down and take the first projection that measurably fits, rather than
    // giving up on content after one miss.
    const leanMetaChars = jsonLen({ ...leanMetadata, returnedChars: 0 });
    const contentHeadroom = ceiling - leanMetaChars - 64;
    // The walk's `remaining` under-counts the SERIALIZED size by a wide and
    // payload-dependent factor (measured 3.5x-5.7x on an orient-shaped payload:
    // a 1,129-char budget serialized to 3,927 chars), so a fixed fraction ladder
    // misses unpredictably — one measured case landed 24 chars over a 3,000
    // ceiling and fell through to the husk. Re-aim each attempt using the
    // overshoot the previous attempt actually exhibited, and require a strict
    // decrease so the loop always terminates.
    let contentBudget = contentHeadroom;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (contentBudget < 200) break;
      const reState: ProjectionState = {
        remaining: contentBudget,
        omittedCount: 0,
        omitted: [],
        priorityOmitted: [],
        preservedOmittedPaths: [],
        active: new WeakSet<object>(),
        limits: { maxArray: 6, maxDepth: 4, maxKeys: 24, maxString: 300 },
        // Same projection, narrower budget — the route that recovers is
        // unchanged, so it must not silently revert to the generic re-call.
        recoveryPointer: state.recoveryPointer,
        preservePaths: state.preservePaths,
        bulkEnvelope: state.bulkEnvelope,
      };
      const rePreview = projectValue(data, '$', 0, reState);
      // `omittedPreserved` names fields that are MISSING FROM THIS BODY, so it is
      // recomputed from the walk being returned rather than inherited. Carrying
      // the discarded walk's list forward reports a field as dropped while it sits
      // in the payload — measured: the fuller walk dropped `shipReadiness`, this
      // narrower one clipped its bulky sibling instead and kept it. That is the
      // opposite direction from `omittedCount`, where over-reporting is the safe
      // side; here it manufactures a phantom absence.
      const { omittedPreserved: _discardedPreserved, ...reBase } = leanMetadata;
      const reMetadata: BoundedPayloadProjection['_projection'] = {
        ...reBase,
        // Count the omissions of the projection ACTUALLY RETURNED, and never
        // under-report the fuller walk that was discarded: a bounded measurement
        // that reads as a real zero is the failure mode this whole block exists to
        // prevent.
        omittedCount: Math.max(leanMetadata.omittedCount, reState.omittedCount),
        ...(reState.preservedOmittedPaths.length > 0
          ? { omittedPreserved: [...reState.preservedOmittedPaths] }
          : {}),
        returnedChars: 0,
      };
      const candidate = buildResultFrom(rePreview, reMetadata);
      const candidateChars = jsonLen(candidate);
      if (candidateChars < ceiling) {
        candidate._projection.returnedChars = candidateChars;
        return candidate;
      }
      const serializedContent = Math.max(1, candidateChars - leanMetaChars);
      const overshoot = Math.max(1.1, serializedContent / contentBudget);
      contentBudget = Math.min(
        Math.floor(contentHeadroom / overshoot),
        Math.floor(contentBudget * 0.7),
      );
    }

    const identityState: ProjectionState = {
      remaining: Math.max(400, Math.floor(target * 0.2)),
      omittedCount: 0,
      omitted: [],
      priorityOmitted: [],
      preservedOmittedPaths: [],
      active: new WeakSet<object>(),
      limits: { maxArray: 8, maxDepth: 3, maxKeys: 20, maxString: 300 },
      // The identity-only husk drops the MOST, so its markers are the ones a
      // reader is likeliest to act on — they need the route that resolves.
      recoveryPointer: state.recoveryPointer,
      preservePaths: state.preservePaths,
    };
    const identityOnly = projectIdentityPreview(data, '$', 0, identityState);
    const identityFields =
      identityOnly && typeof identityOnly === 'object' && !Array.isArray(identityOnly)
        ? (identityOnly as Record<string, unknown>)
        : null;
    const sourceFields =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : null;
    if (identityFields && sourceFields) {
      for (const key of opts.preserveTopLevelKeys ?? []) {
        if (!Object.prototype.hasOwnProperty.call(sourceFields, key) || key in identityFields) continue;
        identityFields[key] = projectValue(sourceFields[key], `$.${key}`, 0, identityState);
      }
    }
    // Same rule as the re-walk above: describe the husk actually returned.
    const { omittedPreserved: _supersededPreserved, ...fallbackBase } = leanMetadata;
    const fallbackMetadata = {
      ...fallbackBase,
      ...(identityState.preservedOmittedPaths.length > 0
        ? { omittedPreserved: [...identityState.preservedOmittedPaths] }
        : {}),
      returnedChars: 0,
    };
    result =
      opts.preserveArrayRoot && Array.isArray(identityOnly)
        ? buildArrayRootResult(identityOnly, fallbackMetadata)
        : identityFields && Object.keys(identityFields).length > 0
          ? { ...identityFields, _projection: fallbackMetadata }
          : {
              summary: '[payload preview omitted: serialized projection exceeded transport budget]',
              _projection: fallbackMetadata,
            };
    result._projection.returnedChars = jsonLen(result);
  }
  return result;
}

/** Stamp a marker so a caller can tell its `full`/`standard` request was
 *  force-downgraded to fit the transport cap (and can re-fetch specifics via the
 *  in-payload `*Truncated` pointers). No-op on non-object data. */
function markForced(data: unknown): unknown {
  return data && typeof data === 'object' && !Array.isArray(data)
    ? { ...(data as Record<string, unknown>), payloadTierForced: 'trimmed' }
    : data;
}

export interface ApplyPayloadTierOpts {
  toolName: string;
  shape: PayloadShapers | undefined;
  response: ToolResponse;
  tier: PayloadTier;
  /**
   * True when the CALLER explicitly passed `payloadTier: 'full'` on this call
   * (as opposed to 'full' merely being the resolved default). An explicit full
   * request is the documented escape hatch out of shaping (every shaper `hint`
   * points at it — e.g. plans:attention's attention-shape.ts) and is how
   * capped-transport-exempt consumers (the in-process sync-resolver / admin-UI
   * dispatch, which feed the operator UI) read the unshaped payload. It SKIPS
   * the hard-ceiling force-shape below: before this flag the ceiling re-trimmed
   * even explicit-full reads, which silently emptied every plans.attention UI
   * surface (Queue / Overview needs-you / sidebar Inbox — WI-5078: the UI's
   * normalizeAttentionGroups drops the item-less summary rows the forced
   * shaper emits). An MCP agent that explicitly asks for full and overflows
   * its client cap gets the client's own result-door (file + paged reads) —
   * a deliberate choice, not a silent failure.
   */
  explicitFullRequest?: boolean;
  args: unknown;
  log?: (msg: string) => void;
  /**
   * WI-37843: per-tool override of `PAYLOAD_TIER_HARD_CEILING_CHARS` for THIS
   * tool, from its `payloadTierCeilingChars` declaration. Absent (or not a
   * finite positive number) ⇒ the shared ceiling, unchanged.
   *
   * Exists because exempting a tool from the result door is only half an
   * uncapping — this ceiling runs EARLIER and is strictly worse when it fires,
   * since what it drops is never serialized (the door at least spills what it
   * cuts). Raising it is deliberately per-tool: the shared default protects
   * every ordinary result, and only a tool whose full payload is the point
   * should opt out of it.
   */
  ceilingChars?: number;
  /** See ProjectBoundedPayloadOpts.rawDispatchTemplate — threaded from the
   * host's UnifiedToolContext into every generic bounded projection this
   * function emits (EI-20720054720826414). */
  rawDispatchTemplate?: string;
}

/**
 * Apply the resolved tier's shaper to a `{ data }` response.
 * Resolution: trimmed → shape.trimmed ?? shape.standard ?? unshaped;
 * standard → shape.standard ?? generic bounded projection; full → unshaped
 * while it fits the transport. A missing/throwing shaper on a LARGE default
 * payload fires the once-per-tool ratchet warning and returns the generic
 * projection instead of flooding the model context.
 *
 * FINALLY, regardless of RESOLVED tier, a HARD CEILING guard force-applies the
 * smallest available shaper if the result is still oversized — so a shaper-tool
 * can never emit a result the transport rejects (WI-2859). The ONE exit is an
 * EXPLICIT per-call `payloadTier: 'full'` (`explicitFullRequest`) — the escape
 * hatch every shaper hint documents, and the contract the UI's in-process
 * dispatch relies on (WI-5078).
 */
export function applyPayloadTier(opts: ApplyPayloadTierOpts): ToolResponse {
  const { toolName, shape, response, tier, explicitFullRequest, args, log } = opts;
  if (!response || typeof response !== 'object' || response.data === undefined) return response;
  // WI-37843: a tool may raise its OWN hard ceiling. Validate rather than trust —
  // a NaN/0/negative override must fall back to the shared ceiling, never disable
  // the guard (a ceiling of 0 would force-shape every result; NaN would compare
  // false against every size and silently uncap the tool).
  const ceiling =
    typeof opts.ceilingChars === 'number' && Number.isFinite(opts.ceilingChars) && opts.ceilingChars > 0
      ? opts.ceilingChars
      : PAYLOAD_TIER_HARD_CEILING_CHARS;

  // 1. Normal tier shaping (full ⇒ no tier shaper; keeps prior behavior).
  let out: ToolResponse = response;
  const tierShaper =
    tier === 'full' ? undefined : tier === 'trimmed' ? (shape?.trimmed ?? shape?.standard) : shape?.standard;
  let customShapeApplied = false;
  if (tierShaper) {
    try {
      // `tierShaper` is only ever set (see the ternary above) when
      // `tier !== 'full'` — TS can't see that implication through the
      // separate `tierShaper` variable, so narrow explicitly at the call
      // site rather than widening PayloadShaperCtx.tier to include 'full'
      // (a shaper is never invoked for 'full', so it should never need to
      // handle it).
      out = { ...response, data: tierShaper(response.data, { args, tier: tier as 'trimmed' | 'standard' }) };
      customShapeApplied = true;
    } catch (err) {
      (log ?? console.warn)(
        `[payload-tier] ${toolName} ${tier} shaper threw (serving unshaped data): ${err instanceof Error ? err.message : String(err)}`,
      );
      out = response;
    }
  }

  if (tier !== 'full' && !customShapeApplied) {
    // Ratchet + safe default: name fat unshaped payloads and bound them now.
    const size = jsonLen(response.data);
    const key = `${toolName} ${tier}`;
    if (size > PAYLOAD_TIER_RATCHET_CHARS) {
      if (!ratchetWarned.has(key)) {
        ratchetWarned.add(key);
        (log ?? console.warn)(
          `[payload-tier] ${toolName} bounded a ${size}-char unshaped payload for a '${tier}' session — add shape.${tier} for a domain-specific projection (context-trimming-tiers P-011)`,
        );
      }
      const projected = projectBoundedPayload(response.data, {
        toolName, tier, originalChars: size, args, rawDispatchTemplate: opts.rawDispatchTemplate,
      });
      out = {
        ...response,
        data: projected,
        payloadProjection: {
          truncated: true,
          tier: projected._projection.tier,
          forced: projected._projection.forced,
          originalChars: projected._projection.originalChars,
          returnedChars: projected._projection.returnedChars,
          omittedCount: projected._projection.omittedCount,
        },
      };
    }
  }

  // 2. Hard ceiling: never emit an over-cap result. Prefer the tool's smallest
  //    domain-specific shaper, then fall back to the generic bounded projection.
  //    An EXPLICIT payloadTier:'full' call opts out (see explicitFullRequest) —
  //    that is the documented escape hatch, and the UI/sync in-process path.
  // EI-22167228731928620: mark the response as an explicit-full opt-out, not
  // just silently return it unshaped. Without this, the MCP transport's
  // result-door (result-door.ts) — a SEPARATE, later size-enforcement pass
  // with no visibility into `explicitFullRequest` at all — cannot tell this
  // apart from an ordinary oversized payload, and re-projects it with a
  // generic, field-blind walk when it overflows the transport door. That
  // walk has no idea a field like `summary` deserves the priority a tool's
  // own shaper gives it, so a caller who explicitly asked for 'full' could
  // end up with LESS inline detail than a plain 'trimmed' call — worse, not
  // better, than the tier they opted out of. The marker lets the door choose
  // "spill the untouched full body and point at it" instead.
  if (explicitFullRequest) return { ...out, explicitFullRequest: true };
  const size = jsonLen(out.data);
  if (size > ceiling) {
    const smallest = shape?.trimmed ?? shape?.standard;
    if (smallest) {
      try {
        const forced = smallest(response.data, { args, tier: 'trimmed' });
        const forcedSize = jsonLen(forced);
        // Only swap if it genuinely shrank (a trimmed tier already at this size
        // gains nothing — that shaper still needs to bound a growing field).
        if (forcedSize < size && forcedSize <= ceiling) {
          (log ?? console.warn)(
            `[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${ceiling}; force-applied the trimmed shaper (${forcedSize} chars) to fit the transport cap (WI-2859)`,
          );
          return {
            ...response,
            data: markForced(forced),
            // No `_projection` marker rides a custom shaper's own output, but
            // it is exactly as lossy from the door's point of view: `data` was
            // swapped for a smaller representation than the tool's true full
            // result. Flag it the same way (EI-13918) — omittedCount is
            // unknown here (the shaper owns its own omission bookkeeping), so
            // report it as unspecified (0) rather than fabricate a count.
            payloadProjection: {
              truncated: true,
              tier: 'trimmed',
              forced: true,
              originalChars: size,
              returnedChars: forcedSize,
              omittedCount: 0,
            },
          };
        }
      } catch (err) {
        (log ?? console.warn)(
          `[payload-tier] ${toolName} hard-ceiling force-shape threw (using generic bounded projection): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    (log ?? console.warn)(
      `[payload-tier] ${toolName} '${tier}' result ${size} chars > hard ceiling ${ceiling}; used the generic bounded projection to fit the transport cap`,
    );
    {
      const projected = projectBoundedPayload(out.data, {
        toolName, tier, forced: true, originalChars: size, args, rawDispatchTemplate: opts.rawDispatchTemplate,
      });
      return {
        ...response,
        data: projected,
        payloadProjection: {
          truncated: true,
          tier: projected._projection.tier,
          forced: projected._projection.forced,
          originalChars: projected._projection.originalChars,
          returnedChars: projected._projection.returnedChars,
          omittedCount: projected._projection.omittedCount,
        },
      };
    }
  }
  return out;
}
