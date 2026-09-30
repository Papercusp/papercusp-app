/**
 * Per-tool-result door (deterministic-context-carry P-006 leg C, ornith-overflow brief).
 *
 * Caps the TEXT content of one MCP `tools/call` result at the `resultEach` door
 * (context-doors.ts — 1500 tokens at the universal 8K floor, ~6000 chars) so a
 * single oversized tool result cannot blow the per-hop ingestion budget the
 * compaction thresholds are derived from (P-007 holds by CONSTRUCTION). The FULL
 * original text is spilled to the existing scratch store (scratch-uri.ts,
 * "tool-output-as-resource" T2.3) behind a pointer line, so nothing is lost —
 * the reader pages the spill file instead of paying for the whole result in one
 * hop.
 *
 * Same universal-floor rationale as the wake-executor injection door (leg B):
 * this seam does not know the CALLER's context window, and /26 lands virtually
 * every fleet model at the 8K floor anyway, so the floor door applies to all.
 * P-023 makes the knobs configurable.
 *
 * Applied at ONE choke point — the direct tools/call `execute()` path in
 * _mcp-handler.ts, AFTER the delta proxy — because that is where every
 * model-facing result converges (a tools:invoke inner result re-enters through
 * its outer call). Machine-consumed dispatches (capabilities/invoke, the
 * tools:invoke inner re-dispatch, TUI plan-item routes) are deliberately NOT
 * doored: their consumers parse programmatically and pay no context rent.
 *
 * Never doored, by construction:
 *   - genuine delta ENVELOPE results (`_meta.delta.mode !== 'full'`) —
 *     content[0].text is structured JSON the CLIENT JSON.parses to
 *     reconstruct; a cap corrupts it (the delta protocol is itself a
 *     result-shrinking mechanism). NOTE: every delta-CAPABLE tool also
 *     stamps `_meta.delta` on an ORDINARY full response (`mode:'full'`,
 *     reason `no_request` or `proxy_reconstructed`) to advertise the
 *     capability + carry a cursor — that shape is a normal body and MUST
 *     still be doored (EI-19325631662380565: the mere presence of the
 *     block used to skip the door for the whole list-tool family, the
 *     fattest population it exists to cap);
 *   - non-text content items (images, resource links) — passed through intact.
 *
 * Kill-switch: PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely (operational
 * rollback, mirrors PAPERCUSP_INJECTION_DOOR_OFF). Fail-soft: any error while
 * capping/spilling returns the ORIGINAL result untouched — the door must never
 * turn a good result into a failure.
 */

import { createHash, randomUUID } from 'node:crypto';
import { projectBoundedPayload, type BulkEnvelopeProjectionOpts } from '@papercusp/tooldef';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from './context-doors';
import { getDoorConstantsSync } from './context-doors-config';
import { buildScratchUri, safeScratchFilesystemPath } from './scratch-uri';
import { buildSpillIndex } from './result-door-index';
import { classifyProjectionBody, type ProjectionBodyShape } from './result-projection';
import {
  buildOutputEnvelope,
  OUTPUT_EVIDENCE_CLASSES,
  type OutputEvidenceClass,
  type OutputEvidenceReferenceContentItem,
  type OutputReferenceContentItem,
} from './output-envelope';
import {
  contentMetadata,
  scratchReferencePayloadByteOffset,
  writeScratchReference,
  type ScratchReferenceManifest,
} from './scratch-reference';

/** The BAKED floor `resultEach` door (window 0 ⇒ the 8K-floor split ⇒ 1500 tokens).
 *  The live door is resolved per call through the P-023 config surface
 *  (getDoorConstantsSync — workspace defaults ⟵ per-session override); un-configured,
 *  it is exactly this value. */
export const RESULT_DOOR_TOKENS = computeTurnDoors(0).resultEach;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_SEGMENT_REGEX = /^[A-Za-z0-9._:-]+$/;

// Keep this model-facing ceiling synchronized with MAX_BYTE_PAGE in
// agent-tools/capability/read.ts. A cursor advertises the safe page request
// (3,072 bytes) separately, but callers also need the tool's schema maximum
// when they choose their own page size during recovery.
const CAPABILITY_READ_MAX_BYTE_PAGE = 4_096;

/** The subset of an MCP tools/call result the door reads/rewrites. */
export interface DoorableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

export interface ResultDoorOpts {
  /** Canonical tool name (colon form) — names the scratch subdir + pointer line. */
  toolName: string;
  /** Caller's workspace id; '*'/invalid shapes spill under 'unscoped'. */
  workspaceId?: string | null;
  /** Spawn run id when it is a UUID; otherwise a fresh UUID names the spill dir. */
  runId?: string | null;
  /** Caller's resolved agent ownerId (resolveAgentIdentity) — keys the P-023
   *  per-session door override; absent ⇒ workspace/baked constants. */
  ownerId?: string | null;
  /** Aggregate cohort reserved when this MCP call STARTED. Explicit client
   *  outputGroupId/turnId is preferred; legacy clients use a documented
   *  start-time compatibility cohort (see beginResultDoorAggregate). */
  aggregateScope?: ResultDoorAggregateScope | null;
  /** Explicit caller-selected paths that must survive a bounded identity
   * fallback when the result-door is applied after `projection.pick`. */
  preservePaths?: readonly string[];
  /**
   * Preserve semantic failures in keyed-array bulk results before projecting
   * bulky successful rows. `true` uses the canonical `{ results, counts, ok }`
   * envelope; an object supplies custom key names. Omit to let the projector
   * infer the canonical envelope from the returned body.
   */
  bulkEnvelope?: BulkEnvelopeProjectionOpts | boolean;
}

export interface ResultDoorAggregateScope {
  /** Opaque, bounded server key. Never contains the caller's raw ids. */
  key: string;
  mode: 'explicit' | 'compatibility';
  groupIdHash: string;
}

export interface ResultDoorAggregateReservation {
  mode: ResultDoorAggregateScope['mode'];
  groupIdHash: string;
  budgetBytes: number;
  consumedBeforeBytes: number;
  /** Bytes charged to the aggregate after applying the per-result ceiling.
   *  Raw sourceBytes remains visible separately for diagnosis. */
  chargedBytes: number;
  sourceBytes: number;
  acceptedBytes: number;
  consumedAfterBytes: number;
  exceeded: boolean;
}

const AGGREGATE_COMPAT_IDLE_GAP_MS = 2_000;
const AGGREGATE_STATE_TTL_MS = 5 * 60_000;
const aggregateCohorts = new Map<string, { generation: number; lastStartedAtMs: number }>();
const aggregateUsage = new Map<string, { usedBytes: number; lastTouchedAtMs: number }>();
let aggregateGeneration = 0;
let aggregateOps = 0;

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * Reserve a cohort at REQUEST START, not result completion. Parallel calls in a
 * legacy client therefore remain grouped even when one tool runs much longer
 * than its siblings. Clients that can identify a model turn/run should pass an
 * explicit outputGroupId (or compatibility alias turnId); that is the exact
 * route. The fallback groups starts separated by <=2s and is deliberately
 * declared best-effort because an MCP request alone carries no model-turn id.
 */
export function beginResultDoorAggregate(input: {
  sessionKey: string;
  outputGroupId?: string | number | null;
  startedAtMs?: number;
}): ResultDoorAggregateScope {
  const sessionHash = shortHash(input.sessionKey || 'unscoped');
  if (input.outputGroupId !== undefined && input.outputGroupId !== null && String(input.outputGroupId).trim()) {
    const groupIdHash = shortHash(String(input.outputGroupId));
    return { key: `${sessionHash}:explicit:${groupIdHash}`, mode: 'explicit', groupIdHash };
  }

  const startedAtMs = Number.isFinite(input.startedAtMs) ? Number(input.startedAtMs) : Date.now();
  const previous = aggregateCohorts.get(sessionHash);
  const generation =
    !previous || startedAtMs - previous.lastStartedAtMs > AGGREGATE_COMPAT_IDLE_GAP_MS
      ? ++aggregateGeneration
      : previous.generation;
  aggregateCohorts.set(sessionHash, {
    generation,
    lastStartedAtMs: Math.max(startedAtMs, previous?.lastStartedAtMs ?? startedAtMs),
  });
  const groupIdHash = shortHash(`compatibility:${generation}`);
  return { key: `${sessionHash}:compatibility:${generation}`, mode: 'compatibility', groupIdHash };
}

function pruneAggregateState(now: number): void {
  aggregateOps += 1;
  if (aggregateOps % 256 !== 0) return;
  for (const [key, value] of aggregateUsage) {
    if (now - value.lastTouchedAtMs > AGGREGATE_STATE_TTL_MS) aggregateUsage.delete(key);
  }
  for (const [key, value] of aggregateCohorts) {
    if (now - value.lastStartedAtMs > AGGREGATE_STATE_TTL_MS) aggregateCohorts.delete(key);
  }
}

function reserveAggregateBytes(
  scope: ResultDoorAggregateScope,
  sourceBytes: number,
  chargedBytes: number,
  budgetBytes: number,
): ResultDoorAggregateReservation {
  const now = Date.now();
  pruneAggregateState(now);
  const prior = aggregateUsage.get(scope.key);
  const consumedBeforeBytes = prior?.usedBytes ?? 0;
  const remaining = Math.max(0, budgetBytes - consumedBeforeBytes);
  const acceptedBytes = Math.min(chargedBytes, remaining);
  const consumedAfterBytes = consumedBeforeBytes + acceptedBytes;
  aggregateUsage.set(scope.key, { usedBytes: consumedAfterBytes, lastTouchedAtMs: now });
  return {
    mode: scope.mode,
    groupIdHash: scope.groupIdHash,
    budgetBytes,
    consumedBeforeBytes,
    chargedBytes,
    sourceBytes,
    acceptedBytes,
    consumedAfterBytes,
    exceeded: chargedBytes > remaining,
  };
}

/** Test-only state reset; exported so focused tests never depend on process order. */
export function resetResultDoorAggregatesForTests(): void {
  aggregateCohorts.clear();
  aggregateUsage.clear();
  aggregateGeneration = 0;
  aggregateOps = 0;
}

// EI-18745696571494110: some tools truncate individual FIELDS inside their own
// JSON body (coord:inbox's per-entry `body_truncated`, plan/list summaries'
// `summary_truncated`, …) independently of this door's own budget — there is
// no shared `_meta` marker for this (unlike `payloadProjection` above), because
// each tool bakes its own field-level cutoff into the body it serializes. When
// that happens on a result that ALSO overflows the door, the spill faithfully
// preserves the tool's output — but that output was already missing the field
// content, so "page the spill instead of re-running" is a dead end: the spill
// can never contain what the tool itself never serialized. Detect the generic
// `"<name>_truncated": true` / `"<name>Truncated": true` JSON shapes and
// their bare TOON equivalents (`<name>Truncated: true`) textually (cheap,
// tool-agnostic). Then swap the footer/header wording so the reader is
// pointed at re-calling the tool with a wider field-level limit instead of
// paging a spill that cannot help. The camelCase form is used by
// build:typecheck's public fields (errorsTruncated, byFileTruncated).
const INNER_TRUNCATION_MARKER_REGEX =
  /(?:"((?:\w+_truncated|\w+Truncated))"|(?<![\w"])((?:\w+_truncated|\w+Truncated)))\s*:\s*true\b/g;
const INNER_TRUNCATION_TEXT_REGEX = /(?:…|\.\.\.)\[TRUNCATED[^\]]*\]/g;

/** Distinct `*_truncated: true` / `*Truncated: true` marker names found in
 *  `text` (capped — this feeds advisory wording, not an audit). Empty when
 *  none are present. */
function detectInnerTruncationMarkers(text: string): string[] {
  const found = new Set<string>();
  INNER_TRUNCATION_MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INNER_TRUNCATION_MARKER_REGEX.exec(text))) {
    found.add(m[1] ?? m[2]);
    if (found.size >= 5) break;
  }
  // Work-item and other custom shapers also put the cutoff directly in the
  // field value (`…[TRUNCATED ...]`) without a sibling boolean marker. Keep a
  // named marker for that shape so a hard reference spill cannot promise bytes
  // that the upstream shaper never serialized.
  INNER_TRUNCATION_TEXT_REGEX.lastIndex = 0;
  if (INNER_TRUNCATION_TEXT_REGEX.test(text)) found.add('textTruncated');
  return [...found];
}

/**
 * P-020 / D-041 discoverability. The projection stage is a DISPATCH-level
 * reserved arg, so it appears in no tool's inputSchema — which means no agent
 * would ever learn it exists, and a built-but-unreachable feature is dead code
 * however green its tests. Injecting the schema into all ~550 tools would blow
 * the P-011 prompt-weight budget for a knob most calls never use.
 *
 * A truncated result is the one moment the answer is both relevant and earned:
 * the caller has just been handed less than they asked for and is about to go
 * page a spill file. Teaching `projection` HERE costs zero standing context and
 * arrives exactly when it is actionable — the same "advise at the decision
 * point" shape as the code:run batch nudge.
 */
/**
 * D-012 (plan agent-context-firewall-and-output-spill-2026-08-02): the hint is
 * a FUNCTION of the payload, not a constant.
 *
 * The constant this replaces led with `pipe` "for text" on every result —
 * including the one-line JSON bodies that are the overwhelming majority of what
 * this door cuts. On such a body the line operators are provably all-or-nothing
 * (measured: `grep` with a non-matching pattern returns an EMPTY body, `head
 * n:3` returns the ENTIRE array), so the footer's first suggestion was the one
 * operator family that cannot reduce the payload it is attached to — and a
 * no-match reads exactly like a successful filter. Filed as
 * EI-19387749343846381.
 *
 * opencode does the same thing correctly and is where the ruling comes from
 * (`tool/truncate.ts:109-111`): its spill hint branches on `hasTaskTool(agent)`
 * so it never advertises a recovery route the reading agent cannot take. This
 * is that, applied to payload TYPE — and the classification comes from
 * `classifyProjectionBody`, the same function the projection stage itself uses
 * to find the body `pick` operates on, so the advertised operator cannot drift
 * from the one that would actually run.
 *
 * `preClassified` closes the one seam where that guarantee LEAKED. The spill
 * writer classifies the body with `classifyProjectionBody` AND, when that
 * misses, recovers a JSON payload carrying a same-item framework advisory
 * suffix (`See also:` / `[batch-hint]` / `[nudge]`) via `findJsonPrefixSlice`.
 * Re-deriving the shape here saw only the weaker half, so a body the door had
 * just proven to be JSON — and written to the spill as JSON — was advertised as
 * "N lines of non-JSON text … `pick` does not apply here", in the SAME `next`
 * string that says "JSON starts after cursor.bodyOffsetInPayload". Measured on
 * `work_items:claimable` (EI-20071580479842384): the same tool+args reduced 95%
 * under `pick: ["claimable[].id"]` while the spill told the reader to use
 * `pipe`, which on a JSON body is the all-or-nothing trap this hint exists to
 * warn about — a no-match returns an EMPTY body that reads like a filter that
 * worked. Callers that have already classified MUST pass their shape.
 */
export function buildProjectionHint(
  textItems: ReadonlyArray<{ text: string }>,
  toolName: string,
  preClassified?: ProjectionBodyShape | null,
): string {
  // BUDGET NOTE (measured, not assumed — the correction in D-016): this string
  // is emitted on EVERY doored result, ~2,600 times per 6 days, 83% of them
  // JSON. A first cut of this function was 570 chars against the 420-char
  // constant it replaced — +34.5% overall, i.e. it would have spent ~94k est.
  // tokens per 6d to fix a correctness bug. Every variant below is now AT OR
  // UNDER the constant's 420. Keep it that way: measure a wording change here,
  // do not eyeball it.
  const lead = ` ⓘ Get only what you need in ONE call instead of paging this spill: `;
  const asString = ` \`projection\` also accepts a JSON STRING.`;
  let shape: { json: unknown; lineCount: number };
  try {
    // A caller-supplied classification is authoritative: it is the one the door
    // actually acted on when it wrote the spill. Only re-derive when absent.
    shape = preClassified ?? classifyProjectionBody(textItems);
  } catch {
    // Fail-soft to the payload-agnostic wording rather than losing the hint.
    return (
      `${lead}\`projection: { pick: ["results[].id"] }\` for a JSON body, or ` +
      `\`projection: { pipe: [{ op:"grep", pattern:"..." }] }\` for multi-line text.${asString}`
    );
  }
  if (shape.json) {
    return (
      `${lead}\`projection: { pick: ["results[].id","results[].state"] }\`. This body is JSON on ` +
      `${shape.lineCount} line(s), so \`pick\` is what reduces it — the \`pipe\` line-operators are ` +
      `all-or-nothing here (a no-match returns an EMPTY body, which reads like a filter that ` +
      `worked).${asString}`
    );
  }
  if (shape.lineCount > 1) {
    return (
      `${lead}\`projection: { pipe: [{ op:"grep", pattern:"..." }, { op:"head", n:20 }] }\`. This body ` +
      `is ${shape.lineCount} lines of non-JSON text, so the line-operators are what reduce it: grep ` +
      `(fixed/ignoreCase/invert/before/after/context), head, tail, sort, uniq, cut, count, applied in ` +
      `order. \`pick\` does not apply here (it selects JSON fields).${asString}`
    );
  }
  return (
    ` ⓘ \`projection\` cannot help here: a single non-JSON line, so \`pick\` (JSON fields) and the ` +
    `\`pipe\` line-operators are both all-or-nothing on it. Page the spill with a bounded read, or ` +
    `re-call ${toolName} with narrower arguments.`
  );
}

/** Approximate context cost of a NON-text content item (WI-36613). Cheap by
 *  design — an MCP image/audio block carries its payload as a base64 `data`
 *  string, so its length IS the cost; anything else falls back to a fail-soft
 *  stringify. Called only for items that are already known not to be text, which
 *  in this corpus is a near-empty population. */
function nonTextSize(it: unknown): number {
  const data = (it as { data?: unknown } | undefined)?.data;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(it) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/** Context-bearing bytes in an MCP result. Shared with the post-door telemetry
 * backfill so the metric and the enforcing door cannot drift on units. */
export function measureResultContextBytes(result: Pick<DoorableResult, 'content'>): number {
  let bytes = 0;
  for (const item of result.content) {
    bytes += isTextItem(item) ? Buffer.byteLength(item.text, 'utf8') : nonTextSize(item);
  }
  return bytes;
}

function isTextItem(it: unknown): it is { type: 'text'; text: string } {
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { type?: unknown }).type === 'text' &&
    typeof (it as { text?: unknown }).text === 'string'
  );
}

const SPEC_TEST_ADEQUACY_TOOL = 'plans:evaluate-spec-test-adequacy';
const PIPELINE_POSITION_TOOL = 'dev:pipeline_position';
/**
 * coord:send's result is a write receipt, not a list whose detail can be
 * safely reduced to row identity. These fields are the delivery verdict the
 * sender uses to distinguish "queued" from "missed" and to verify the durable
 * message handle. Keep them in the generic result-door projection even when a
 * large body/diagnostic section is evicted; otherwise a successful send can
 * render exactly like a failed one (EI-23481355842555588).
 */
const COORD_SEND_DELIVERY_PRESERVE_PATHS = [
  'results[].msg_id',
  'results[].queued',
  'results[].woken',
  'results[].wakeOutcome',
  'results[].pickupConfirmed',
  'results[].recipient_absent',
  'results[].wake.queued',
  'results[].wake.woken',
  'results[].wake.wakeOutcome',
  'results[].wake.pickupConfirmed',
  'results[].wake.recipient_absent',
] as const;
/**
 * `dev:pipeline_position`'s marker argument exists to settle these verdicts,
 * but the handler's compact response places them after the verbose gate/queue
 * fields. Keep the marker result and the two legs it corrects addressable when
 * this later, generic door has to project the response again.
 */
const PIPELINE_POSITION_PRESERVE_PATHS = [
  'changeInCandidate.markerJudging',
  'changeInCandidate.markerNext',
  'changeInCandidate.judgingSha',
  'changeInCandidate.nextCandidateSha',
  'changeInCandidate.judgingContainsPath',
  'changeInCandidate.nextContainsPath',
  'changeInCandidate.missingReason',
  'positions.inMain',
  'positions.deployed',
  'positionsMarker',
] as const;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keep evaluator decisions inline; verbose evidence remains in the spill. */
function compactSpecTestAdequacyRatings(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const compact: JsonObject = {};
  for (const [criterion, entry] of Object.entries(value)) {
    if (!isJsonObject(entry) || typeof entry.rating !== 'string') return null;
    // `_partial` describes the lossy projection of the surrounding row, not a
    // criterion. Keeping it out of this homogeneous map lets generic consumers
    // enumerate every value as an AdequacyRatingEntry without a boolean guard.
    compact[criterion] = { rating: entry.rating };
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function copyJsonKeys(source: JsonObject, target: JsonObject, keys: readonly string[]): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
}

function compactSpecTestAdequacyRow(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const ratings = compactSpecTestAdequacyRatings(value.ratings);
  if (!ratings) return null;
  // Evidence/suggestions are intentionally omitted from every criterion, so
  // mark the row envelope rather than contaminating the ratings map.
  const compact: JsonObject = { ratings, _partial: true };
  copyJsonKeys(value, compact, [
    'planSlug', 'specId', 'specRevision', 'specFingerprint', 'planItemId',
    'classRef', 'behaviorClass', 'requiredProofFloor', 'verdict', 'wouldBlock',
  ]);
  const draft = isJsonObject(value.scorecardDraft) ? value.scorecardDraft : null;
  if (draft) {
    const compactDraft: JsonObject = { ratings };
    copyJsonKeys(draft, compactDraft, ['rubricRef', 'subject', 'title', 'rerunRecipe', 'terminal']);
    if (Object.prototype.hasOwnProperty.call(draft, 'body')) compactDraft._partial = true;
    compact.scorecardDraft = compactDraft;
  }
  return compact;
}

function compactSpecTestAdequacyBody(body: unknown): JsonObject | null {
  if (!isJsonObject(body) || body.ok !== true || !Array.isArray(body.rows)) return null;
  const rows = body.rows.map(compactSpecTestAdequacyRow);
  if (rows.some((row) => row === null)) return null;
  const compact: JsonObject = { rows };
  copyJsonKeys(body, compact, [
    'ok', 'slug', 'harnessSlug', 'classRef', 'rubricRef', 'count', 'verdicts',
    'wouldBlock', 'uncoveredWorkItemSelection',
  ]);
  compact._compactProjection = {
    kind: 'evaluator-specific',
    tool: SPEC_TEST_ADEQUACY_TOOL,
    preserves: [
      'rows[].ratings.<criterion>.rating', 'rows[].requiredProofFloor',
      'rows[].verdict', 'rows[].wouldBlock', 'verdicts', 'wouldBlock',
    ],
    omits: [
      'rows[].ratings.<criterion>.evidence', 'rows[].ratings.<criterion>.suggestion',
      'rows[].scorecardDraft.body',
    ],
    recovery: 'full result is in _projection.cursor',
  };
  return compact;
}

/** Shape the parts so buildScratchUri's validators accept them (fail-soft names,
 *  never fail-the-spill on a weird caller identity). */
function scratchParts(opts: ResultDoorOpts): { workspaceId: string; toolName: string; runId: string } {
  const rawWs = opts.workspaceId ?? '';
  const workspaceId = TOOL_SEGMENT_REGEX.test(rawWs) && rawWs !== '.' && rawWs !== '..' ? rawWs : 'unscoped';
  let toolName = TOOL_SEGMENT_REGEX.test(opts.toolName) ? opts.toolName : 'unknown:tool';
  if (!toolName.includes('.') && !toolName.includes(':')) toolName = `tool:${toolName}`;
  const runId = opts.runId && UUID_V4_REGEX.test(opts.runId) ? opts.runId : randomUUID();
  return { workspaceId, toolName, runId };
}

interface JsonPrefixSlice {
  start: number;
  end: number;
}

/** Find a complete object/array JSON value at the start of a text item. Some
 * dispatch paths append guidance to the SAME text item rather than emitting a
 * separate content item, so JSON.parse(item.text) cannot identify the payload
 * even though the bytes before the guidance are a complete JSON document. */
function findJsonPrefixSlice(text: string): JsonPrefixSlice | null {
  const start = text.search(/\S/);
  if (start < 0 || (text[start] !== '{' && text[start] !== '[')) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const end = index + 1;
        try {
          JSON.parse(text.slice(start, end));
          const trailing = text.slice(end).trim();
          // Only split a same-item suffix when it has the framework's known
          // advisory shape. A JSON snippet followed by arbitrary text can be a
          // genuine non-JSON result (including tool-owned truncation samples),
          // and treating that as a complete payload would overclaim recovery.
          if (trailing && !/^(?:See also:|\[batch-hint\]|\[nudge\])/i.test(trailing)) return null;
          return { start, end };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Keep a per-item JSON payload parseable when the MCP result also carries
 * advisory text items (for example a tool's `guidance.seeAlso` entry).
 *
 * `classifyProjectionBody` deliberately finds JSON in one item even when the
 * joined content does not parse. The spill must make the same distinction:
 * putting the advisory item after that JSON turns an otherwise valid body into
 * `JSON + prose`, so `jq` cannot consume the bytes. Preserve the advisory text
 * as one JSON-encoded comment before the payload and leave the payload as the
 * final byte stream. The encoded array is lossless (including newlines) while
 * the comment cannot contaminate the JSON body after its advertised offset.
 */
function buildSpillAdvisoryPrefix(
  textItems: ReadonlyArray<{ text: string }>,
  jsonItemIndex: number,
  jsonSlice?: JsonPrefixSlice | null,
): string {
  if (jsonItemIndex < 0) return '';
  const advisoryTexts: string[] = [];
  textItems.forEach((item, index) => {
    if (index !== jsonItemIndex) {
      advisoryTexts.push(item.text);
      return;
    }
    if (!jsonSlice) return;
    const before = item.text.slice(0, jsonSlice.start).trim();
    const after = item.text.slice(jsonSlice.end).trim();
    if (before) advisoryTexts.push(before);
    if (after) advisoryTexts.push(after);
  });
  if (advisoryTexts.length === 0) return '';
  return (
    `# result-door advisory text item(s) moved before the JSON payload so the payload remains parseable\n` +
    `# advisory-text-items-json: ${JSON.stringify(advisoryTexts)}\n`
  );
}

const STRUCTURAL_PROJECTION_WARNING_MAX_CHARS = 1_200;

/**
 * Keep a trust-degrading projection verdict in the model-facing result when
 * the result door replaces the projection's text body with a structural JSON
 * preview.
 *
 * `applyResultProjection` deliberately emits degraded verdicts as a leading
 * `⚠` text item so a downstream head-truncation cannot hide them. The result
 * door used to keep only the parsed JSON item, undoing that guarantee exactly
 * when the fail-open body was large enough to overflow. Courtesy/advisory
 * text (including a clean projection footer) is still intentionally dropped:
 * only a leading warning from the projection stage is load-bearing here.
 *
 * The warning is bounded independently of the JSON preview. An unusually
 * verbose upstream footer must not consume the entire result door.
 */
function extractStructuralProjectionWarning(
  result: Pick<DoorableResult, '_meta'>,
  textItems: ReadonlyArray<{ text: string }>,
  jsonItemIndex: number,
): string | null {
  const projection = (
    result._meta as
      | { resultProjection?: { applied?: unknown; notes?: unknown } }
      | undefined
  )?.resultProjection;
  if (projection?.applied !== true || jsonItemIndex <= 0) return null;
  if (!Array.isArray(projection.notes) && projection.notes !== undefined) return null;

  const warning = textItems
    .slice(0, jsonItemIndex)
    .find((item) => item.text.trimStart().startsWith('⚠'))
    ?.text;
  if (!warning) return null;
  if (warning.length <= STRUCTURAL_PROJECTION_WARNING_MAX_CHARS) return warning;
  return warning.slice(0, STRUCTURAL_PROJECTION_WARNING_MAX_CHARS - 1) + '…';
}

const EVIDENCE_KEY_CLASS: Readonly<Record<string, OutputEvidenceClass>> = {
  workitem: 'work-item', workitems: 'work-item', issue: 'work-item', issues: 'work-item',
  event: 'event', events: 'event', eventstatus: 'event', eventstatuses: 'event',
  fleet: 'fleet', fleets: 'fleet',
  capacity: 'capacity', capacities: 'capacity',
  account: 'account', accounts: 'account',
  release: 'release', releases: 'release',
};

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Discover evidence groups in script-authored JSON without coupling the door
 * to one script schema. Only explicit field names count; values are never
 * guessed from IDs or prose. */
export function detectResultEvidence(content: readonly unknown[]): Array<{
  evidenceClass: OutputEvidenceClass;
  contentIndex: number;
  jsonPointers: string[];
}> {
  const found = new Map<string, { evidenceClass: OutputEvidenceClass; contentIndex: number; jsonPointers: string[] }>();
  const visit = (value: unknown, contentIndex: number, pointer: string, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPointer = `${pointer}/${jsonPointerSegment(key)}`;
      const evidenceClass = EVIDENCE_KEY_CLASS[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (evidenceClass) {
        const mapKey = `${evidenceClass}:${contentIndex}`;
        const row = found.get(mapKey) ?? { evidenceClass, contentIndex, jsonPointers: [] };
        if (!row.jsonPointers.includes(childPointer)) row.jsonPointers.push(childPointer);
        found.set(mapKey, row);
      }
      visit(child, contentIndex, childPointer, depth + 1);
    }
  };
  content.forEach((item, contentIndex) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!row || row.type !== 'text' || typeof row.text !== 'string') return;
    try { visit(JSON.parse(row.text), contentIndex, '', 0); } catch { /* prose is not typed evidence */ }
  });
  return [...found.values()].sort((a, b) =>
    OUTPUT_EVIDENCE_CLASSES.indexOf(a.evidenceClass) - OUTPUT_EVIDENCE_CLASSES.indexOf(b.evidenceClass));
}

/** Every route `spillResultAsReferenceEnvelope` can be reached for — see each
 *  branch's call site for what triggers it. */
type SpillReason =
  | 'aggregate-output-budget-exceeded'
  | 'non-text-result-budget-exceeded'
  | 'explicit-full-request-overflow';

/**
 * The one actionable fact each spill reason implies, stated where the MODEL
 * reads it — the envelope in `content` — rather than only in
 * `_meta.resultDoor.aggregate`. The aggregate reservation was already recorded
 * there while every reporter below read the envelope, saw the word "omitted",
 * and concluded the bytes were gone (EI-21954450841272611 and friends).
 *
 * The aggregate size diagnosis is derived: the cohort budget is
 * `resultEach * resultSlots` chars, a single result is charged at most
 * `resultEach` (`reserveAggregateBytes`' `chargedBytes` is
 * `min(sourceBytes, budgetChars)`), and `resultSlots` is a positive integer —
 * so a call that is FIRST in its cohort can never exceed the budget. Reaching
 * this reason proves earlier calls in the SAME COHORT consumed it, and that
 * this result was not oversized on its own. A compatibility cohort is only
 * a 2s start-time heuristic; it does NOT prove a shared model turn.
 */
function spillRecoveryNote(
  reason: SpillReason,
  input: { upstreamProjection?: boolean; innerTruncationMarkers?: readonly string[]; aggregateMode?: ResultDoorAggregateScope['mode'] } = {},
): string {
  const recoverable =
    'Nothing was lost: the complete result was written to the reference in `content` — page it to read it. ';
  const innerTruncationMarkers = input.innerTruncationMarkers ?? [];
  if (input.upstreamProjection) {
    return (
      'The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. ' +
      'However, the tool had already applied a lossy upstream projection before this spill; omitted fields were ' +
      'never serialized and paging this reference cannot recover them. Re-call the tool with payloadTier:\'full\' ' +
      '(or narrower arguments) for the missing detail.'
    );
  }
  if (innerTruncationMarkers.length > 0) {
    return (
      'The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. ' +
      `However, the TOOL ITSELF already truncated field(s) before this spill (${innerTruncationMarkers.join(', ')}); ` +
      'paging this reference cannot recover those omitted fields. Re-call the tool with a wider per-field limit.'
    );
  }
  if (reason === 'aggregate-output-budget-exceeded') {
    return (
      `${recoverable}This result was NOT too large on its own; earlier calls in the same ` +
      `${input.aggregateMode === 'compatibility' ? '2-second compatibility cohort' : 'explicit output cohort'} ` +
      'consumed the shared budget. This does not prove they were parallel siblings. ' +
      'Read the spill in bounded byte pages, or retry in a NEW output cohort; reissuing ' +
      'within the same cohort can spill again.'
    );
  }
  if (reason === 'explicit-full-request-overflow') {
    // EI-22167228731928620: an explicit payloadTier:'full' skipped the tool's
    // own field-aware shaper, so the raw body reaching this door is LARGER
    // than what a 'trimmed' call would have produced — re-projecting it here
    // with the generic, field-blind bounded-payload walk could leave less
    // inline than 'trimmed' does, i.e. worse than the tier the caller opted
    // out of. Spilling the untouched full body and saying so plainly is
    // honest about the size AND strictly recoverable, unlike that reprojection.
    return (
      `${recoverable}This is the RAW, unshaped payload you explicitly requested with payloadTier:'full' ` +
      "(or an equivalent transport-cap exemption) — it does not fit inline at this size. If you don't need " +
      "the full raw payload, omit payloadTier (or don't request 'full') for a properly tier-shaped, " +
      'field-aware inline summary instead — often MORE informative than a generic re-projection of the full body.'
    );
  }
  return (
    `${recoverable}It took this route because a non-text block (image/audio/resource) cannot be ` +
    'sliced, so re-running the same call alone will spill again — page the reference rather than retrying.'
  );
}

/**
 * Hard overflow route for aggregate exhaustion and non-text results. The
 * existing text projector cannot safely slice an image/audio/resource block,
 * so the full MCP content array is serialized once to the existing scratch
 * store and replaced by the shared typed reference envelope.
 *
 * ⚠ Everything this route touches is RELOCATED, never dropped: the whole
 * content array is serialized into the spill above, and the `incomplete`
 * descriptor must say so. It previously reported `omittedItems: content.length`
 * — a field reserved for bytes that were never serialized (see
 * `OutputEnvelopeIncomplete`) — which stated the exact opposite of the truth
 * AND counted MCP content blocks, which readers took for domain rows ("omitted
 * three items"). Note the spill-failure branch below returns state:'error'
 * instead, so on this `incomplete` branch the spill always succeeded. The
 * reference is recoverable when the source was complete; if the source already
 * carried an upstream truncation marker, the bytes are still inspectable but
 * `recoverable` is false because the omitted fields never reached this door.
 */
function spillResultAsReferenceEnvelope<T extends DoorableResult>(input: {
  result: T;
  opts: ResultDoorOpts;
  reason: SpillReason;
  sourceBytes: number;
  nonTextBytes: number;
  doorTokens: number;
  aggregate?: ResultDoorAggregateReservation;
}): T {
  const upstreamProjection = (
    input.result._meta as
      | { payloadProjection?: { truncated?: unknown } }
      | undefined
  )?.payloadProjection;
  const innerTruncationMarkers = upstreamProjection
    ? []
    : detectInnerTruncationMarkers(
        input.result.content.filter(isTextItem).map((item) => item.text).join('\n\n'),
      );
  const sourceWasPartial = Boolean(upstreamProjection?.truncated) || innerTruncationMarkers.length > 0;
  const payload = JSON.stringify({
    content: input.result.content,
    ...(input.result.isError !== undefined ? { isError: input.result.isError } : {}),
  });
  let spillPath: string | null = null;
  let spillUri: string | null = null;
  let spillError: string | null = null;
  let spillErrorCode: string | null = null;
  let manifest: ScratchReferenceManifest | null = null;
  const evidence = detectResultEvidence(input.result.content);
  try {
    const parts = scratchParts(input.opts);
    // EI-21282689413153947: NOT `.json` — every spill is a self-describing
    // scratch reference (magic + manifest + payload), so a `.json` name lies
    // about the bytes and invites a direct `jq <file>` that dies on the header
    // ("Invalid numeric literal at line 2"). The payload INSIDE the reference
    // stays machine-parseable JSON; recover it via parseScratchReference or the
    // cursor recipe, never by parsing the whole file.
    const basename = `result-door-${Date.now()}-${randomUUID().slice(0, 8)}.spill`;
    spillUri = buildScratchUri({ ...parts, basename });
    spillPath = safeScratchFilesystemPath(spillUri);
    manifest = writeScratchReference({
      filePath: spillPath,
      payload,
      workspaceId: parts.workspaceId,
      ownerId: input.opts.ownerId,
      audience: input.opts.ownerId ? 'owner' : 'workspace',
      mediaType: 'application/json',
      content: contentMetadata(input.result.content),
      evidence,
    });
  } catch (err) {
    spillError = err instanceof Error ? err.message : String(err);
    spillErrorCode = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
    spillPath = null;
    spillUri = null;
  }

  const firstText = input.result.content.find(isTextItem)?.text ?? '';
  const preview = firstText
    ? firstText.slice(0, 240)
    : `[${input.result.content.map((item) => String((item as { type?: unknown }).type ?? 'unknown')).join(', ')}]`;
  const reference: OutputReferenceContentItem | null = spillUri && manifest
    ? {
        kind: 'reference',
        uri: spillUri,
        preview,
        byteCount: manifest.byteCount,
        sha256: manifest.sha256,
        expiresAt: manifest.expiresAt,
        ...(manifest.ownerId ? { ownerId: manifest.ownerId } : {}),
        audience: manifest.audience,
      }
    : null;
  const evidenceReferences: OutputEvidenceReferenceContentItem[] = reference
    ? [...new Set(evidence.map((entry) => entry.evidenceClass))].map((evidenceClass) => ({
        ...reference,
        kind: 'evidence-reference' as const,
        evidenceClass,
        preview: `${evidenceClass} evidence`,
      }))
    : [];
  const envelope = reference
    ? buildOutputEnvelope(
        {
          summary: '',
          content: evidenceReferences.length > 0 ? evidenceReferences : [reference],
          state: 'incomplete',
          incomplete: {
            reason: input.reason,
            spilledItems: input.result.content.length,
            recoverable: !sourceWasPartial,
            note: spillRecoveryNote(input.reason, {
              upstreamProjection: Boolean(upstreamProjection?.truncated),
              innerTruncationMarkers,
              aggregateMode: input.aggregate?.mode,
            }),
          },
        },
        { summaryBudgetChars: 0 },
      )
    : buildOutputEnvelope(
        {
          summary: '',
          state: 'error',
          error: {
            code: 'output_spill_failed',
            message: `Output exceeded its hard budget and the spill write failed (${spillErrorCode ?? 'unknown error'}).`,
            retryable: true,
          },
        },
        { summaryBudgetChars: 0 },
      );

  return {
    ...input.result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    _meta: {
      ...(input.result._meta ?? {}),
      resultDoor: {
        truncated: true,
        structural: true,
        spillPath,
        spillUri,
        spillFailed: spillPath == null,
        spillError,
        spillErrorCode,
        originalChars: input.sourceBytes,
        originalBytes: input.sourceBytes,
        nonTextChars: input.nonTextBytes,
        nonTextBytes: input.nonTextBytes,
        doorTokens: input.doorTokens,
        reason: input.reason,
        upstreamProjected: Boolean(upstreamProjection?.truncated),
        innerTruncationMarkers,
        ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        outputEnvelope: envelope,
      },
    },
  } as T;
}

/**
 * Apply both model-facing output rails: the existing per-result door and, when
 * the transport supplied a cohort, one aggregate budget across the fan-out.
 * Text overflow is structurally projected; non-text or aggregate overflow is
 * stored once and replaced by the shared typed-reference envelope.
 */
export function applyResultDoor<T extends DoorableResult>(result: T, opts: ResultDoorOpts): T {
  try {
    if (process.env.PAPERCUSP_RESULT_DOOR_OFF === '1') return result;
    // EI-19325631662380565: `_meta.delta` presence alone is NOT the marker of a
    // genuine delta envelope — every delta-CAPABLE tool also stamps this block on
    // an ordinary full response (mode:'full', reason 'no_request' or
    // 'proxy_reconstructed') to advertise the capability + carry a cursor. Only a
    // non-'full' mode is a client-reconstructed patch that a text cap would corrupt.
    const deltaMeta = (result._meta as { delta?: { mode?: unknown } } | undefined)?.delta;
    if (deltaMeta != null && deltaMeta.mode !== 'full') return result;
    const items = result.content;
    if (!Array.isArray(items)) return result;

    // P-023: the effective resultEach door for THIS caller (workspace defaults ⟵
    // session override; sync snapshot, fail-soft to the baked 1500-token floor).
    const effectiveConstants = getDoorConstantsSync(opts.ownerId);
    const doors = computeTurnDoors(0, effectiveConstants);
    const doorTokens = doors.resultEach;
    const budgetChars = doorTokens * CHARS_PER_TOKEN_ESTIMATE;
    // EI-13918: `result.data` may ALREADY have been replaced upstream by a
    // lossy payload-tier projection (payload-tier.ts) BEFORE this door ever
    // saw it — in which case `fullText` below is not the tool's true full
    // output; the genuinely-omitted content was never serialized at all, so
    // paging this spill file can never recover it. Detect that via the
    // `_meta.payloadProjection` marker (serialize-result.ts) rather than
    // sniffing the serialized JSON text, and pick truthful header/footer
    // wording for each case instead of unconditionally claiming "FULL".
    const upstreamProjection = (
      result._meta as
        | {
            payloadProjection?: {
              truncated: true;
              tier: string;
              forced: boolean;
              originalChars: number;
              returnedChars: number;
              omittedCount: number;
            };
          }
        | undefined
    )?.payloadProjection;
    // EI-22167228731928620: an EXPLICIT payloadTier:'full' (or an equivalent
    // transport-cap exemption) skipped payload-tier.ts's own tier shaper AND
    // its hard-ceiling force-shape — `data` is the tool's true raw output.
    // Mutually exclusive with `upstreamProjection` by construction (payload-tier.ts
    // returns before ever setting `payloadProjection` on this path).
    const explicitFullRequest = Boolean(
      (result._meta as { explicitFullRequest?: unknown } | undefined)?.explicitFullRequest,
    );
    let totalChars = 0;
    let textBytes = 0;
    // D-021 activates the old WI-36613 detector: non-text content is now a live
    // output path, so it participates in the same byte accounting as text.
    let nonTextChars = 0;
    for (const it of items) {
      if (isTextItem(it)) {
        totalChars += it.text.length;
        textBytes += Buffer.byteLength(it.text, 'utf8');
      } else nonTextChars += nonTextSize(it);
    }
    const sourceBytes = textBytes + nonTextChars;
    const aggregate = opts.aggregateScope
      ? reserveAggregateBytes(
          opts.aggregateScope,
          sourceBytes,
          // Aggregate accounting is downstream of the per-result rail. A
          // 20KB single result becomes a <=6KB structural projection and must
          // not consume the whole 12KB fan-out budget by its pre-door size.
          // Charging the per-result ceiling is conservative (the returned
          // envelope is normally smaller) while preserving the existing
          // structural projection path and enforcing the aggregate invariant.
          Math.min(sourceBytes, budgetChars),
          doors.resultEach * doors.resultSlots * CHARS_PER_TOKEN_ESTIMATE,
        )
      : undefined;

    // D-021 activates the old WI-36613 revisit condition: now that media is a
    // live output path, non-text participates in the SAME hard accounting. A
    // non-text block cannot be structurally sliced, so spill the whole MCP
    // content array once and return the typed reference envelope. Aggregate
    // exhaustion takes the same route for text or non-text.
    if (aggregate?.exceeded || (nonTextChars > 0 && sourceBytes > budgetChars)) {
      return spillResultAsReferenceEnvelope({
        result,
        opts,
        reason: aggregate?.exceeded ? 'aggregate-output-budget-exceeded' : 'non-text-result-budget-exceeded',
        sourceBytes,
        nonTextBytes: nonTextChars,
        doorTokens,
        aggregate,
      });
    }

    // EI-22167228731928620: an explicit-full body that STILL overflows the
    // transport door takes the same hard-overflow route as aggregate/non-text
    // exhaustion, rather than falling into the generic bounded-payload
    // reprojection below. That generic walk is field-blind (it does not know
    // e.g. `summary` deserves the priority a tool's own trimmed shaper gives
    // it), and the RAW body it would be walking here is LARGER than a
    // 'trimmed' call's output precisely because payload-tier.ts's
    // explicitFullRequest exemption skipped that shaper — so re-projecting it
    // generically can leave LESS useful content inline than plain 'trimmed'
    // would have: worse than the tier the caller explicitly opted out of.
    // Spilling the untouched full body and pointing at it is honest about the
    // size and strictly recoverable in full, which the generic reprojection
    // is not.
    if (explicitFullRequest && sourceBytes > budgetChars) {
      return spillResultAsReferenceEnvelope({
        result,
        opts,
        reason: 'explicit-full-request-overflow',
        sourceBytes,
        nonTextBytes: nonTextChars,
        doorTokens,
        aggregate,
      });
    }

    if (sourceBytes <= budgetChars) {
      // EI-19361771982678588: FITTING THE DOOR IS NOT BEING COMPLETE. This
      // early return is the fast path for an ordinary small result — but a
      // result that was tier-trimmed upstream and THEN landed under the door
      // budget took this path too, and every truncation disclosure below is
      // downstream of here. So the more aggressively a tool trimmed its own
      // payload, the more likely it was to say nothing about it: the warning
      // fired only when the *already-trimmed* body still overflowed. The
      // facts:list case that motivated this cleared the door by 245 chars out
      // of ~6,000 — a slightly tighter trim would have gone silent.
      //
      // Nothing to spill (the omitted rows were never serialized), so this
      // discloses in-band and returns; the identity fast-path is preserved for
      // the overwhelmingly common untruncated case.
      if (!upstreamProjection?.truncated) return result;
      const fastPathNotices: string[] = [];
      if (upstreamProjection?.truncated) {
        fastPathNotices.push(
          `\n[⚠ PARTIAL RESULT — this fit the per-result door, but it is NOT the tool's full ` +
            `output: it was tier-projected upstream (payloadProjection: tier=${upstreamProjection.tier} ` +
            `forced=${upstreamProjection.forced} omittedCount=${upstreamProjection.omittedCount}, ` +
            `${upstreamProjection.returnedChars} of ${upstreamProjection.originalChars} chars). Those ` +
            `${upstreamProjection.omittedCount} field(s)/row(s) were never serialized, so nothing ` +
            `downstream can recover them and their ABSENCE HERE IS NOT EVIDENCE THEY DO NOT EXIST. ` +
            `Re-call ${opts.toolName} with payloadTier:'full' (or narrower args) for the missing detail.]`,
        );
      }
      return {
        ...result,
        content: [...items, ...fastPathNotices.map((text) => ({ type: 'text' as const, text }))],
      } as T;
    }

    const textItems = items.filter(isTextItem);
    const fullText = textItems.map((it) => it.text).join('\n\n');
    // A structured JSON payload is often followed by a separate advisory
    // content item. Classify once before writing the spill so the machine-
    // readable payload can be kept as the final byte stream, with those
    // advisories preserved in the prefix rather than appended after JSON.
    const classifiedBodyShape = classifyProjectionBody(textItems);
    let jsonItemIndex = classifiedBodyShape.json?.itemIndex ?? -1;
    let jsonSlice = jsonItemIndex >= 0 ? findJsonPrefixSlice(textItems[jsonItemIndex].text) : null;
    if (jsonItemIndex < 0) {
      for (let index = 0; index < textItems.length; index += 1) {
        const candidate = findJsonPrefixSlice(textItems[index].text);
        if (!candidate) continue;
        jsonItemIndex = index;
        jsonSlice = candidate;
        break;
      }
    }
    const bodyShape = classifiedBodyShape.json || !jsonSlice
      ? classifiedBodyShape
      : {
          ...classifiedBodyShape,
          json: {
            parsed: JSON.parse(textItems[jsonItemIndex].text.slice(jsonSlice.start, jsonSlice.end)),
            itemIndex: jsonItemIndex,
          },
        };
    const spillBodyText = jsonItemIndex >= 0 && jsonSlice
      ? textItems[jsonItemIndex].text.slice(jsonSlice.start, jsonSlice.end)
      : jsonItemIndex >= 0
        ? textItems[jsonItemIndex].text
        : fullText;
    const spillAdvisoryPrefix = buildSpillAdvisoryPrefix(textItems, jsonItemIndex, jsonSlice);
    // Preserve the same typed evidence index on ordinary text spills as on the
    // hard-overflow reference envelope. A result can reach this branch when the
    // outer result door caps a JSON `work_items:get` response; without the index,
    // capability:read's evidence_class selector sees a valid scratch reference
    // but cannot resolve its work-item/event/fleet evidence (EI-22586299911603348).
    const spillEvidence = detectResultEvidence(items);
    // WI-36047 (borrow item 9, opencode/OMP research): THE SPILL GETS ITS OWN
    // FAIL-SOFT BOUNDARY, SEPARATE FROM THE CAP.
    //
    // This door's cap is implemented as a side-effect of "park the full copy
    // somewhere first", and that shape has TWO distinct failure modes which
    // deserve OPPOSITE answers:
    //   - the CAPPING fails  → returning the original result is right (the door
    //     must never turn a good result into a failure);
    //   - the SPILL WRITE fails → returning the original result is WRONG. It
    //     re-exposes the full, context-blowing payload the door exists to bound,
    //     and it does so precisely when the box is already unhealthy (disk full,
    //     unwritable scratch, permissions).
    // Until this fix ONE `try` spanned both, so the second case silently took the
    // first case's answer. OMP has the identical bug with the sign flipped: it
    // gets the save-FAILED path right (output-meta.ts:684-692, truncates anyway,
    // under an explicit comment that a save failure must never re-expose the full
    // output) and the store-ABSENT path wrong (`:656`, returns uncapped).
    //
    // So: a spill we could not write degrades to TRUNCATE-WITHOUT-RECOVERY —
    // still capped, and the footer says the overflow is gone rather than naming a
    // path that does not exist. Never to no-cap.
    let fsPath: string | null = null;
    let uri: string | null = null;
    let spillError: string | null = null;
    // The FOOTER is model-facing prose and gets the terse errno only. A raw fs
    // error message embeds the full failing path (`ENOTDIR: not a directory,
    // mkdir '/…/scratch/ws-1/plans:get/…'`), which would put a filesystem path
    // back into a footer whose entire job here is to name NO path — and a reader
    // that sees one will try to page it. The full message stays on `_meta`.
    let spillErrorCode: string | null = null;
    let spillManifest: ScratchReferenceManifest | null = null;
    const noteSpillFailure = (err: unknown): void => {
      spillError = err instanceof Error ? err.message : String(err);
      spillErrorCode = (err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error';
      spillManifest = null;
      fsPath = null;
      uri = null;
    };
    try {
      const parts = scratchParts(opts);
      const basename = `result-door-${Date.now()}.md`;
      uri = buildScratchUri({ ...parts, basename });
      fsPath = safeScratchFilesystemPath(uri);
    } catch (err) {
      // A path we cannot even NAME is the store-absent case: cap, disclose, move on.
      noteSpillFailure(err);
    }
    // EI-18745696571494110: no upstream `_meta` marker fired, but the tool may
    // have still truncated individual FIELDS inside its own body (coord:inbox's
    // per-entry `body_truncated`, a list's `summary_truncated`, …) — check only
    // when upstreamProjection didn't already explain the shortfall, since that
    // case is more severe (the WHOLE result is a partial projection) and takes
    // priority over a field-level marker.
    const innerTruncationMarkers = upstreamProjection ? [] : detectInnerTruncationMarkers(fullText);
    const header = upstreamProjection
      ? `# result-door spill — an ALREADY-PROJECTED (partial) tool result\n` +
        `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
        `# upstream payload-tier shaping already replaced the tool's full output with a ` +
        `bounded projection BEFORE this door ran: tier=${upstreamProjection.tier} ` +
        `forced=${upstreamProjection.forced} originalChars=${upstreamProjection.originalChars} ` +
        `returnedChars=${upstreamProjection.returnedChars} omittedCount=${upstreamProjection.omittedCount}.\n` +
        `# The ${upstreamProjection.omittedCount} omitted field(s)/row(s) were NEVER serialized and are ` +
        `NOT recoverable from this file — re-call ${opts.toolName} with payloadTier:'full' ` +
        `(or narrower args) for the missing detail.\n` +
        `# What follows is only that already-partial projection, further capped at the ` +
        `per-result door (${doorTokens} tokens) below.\n\n`
      : innerTruncationMarkers.length > 0
        ? `# result-door spill — FULL door-level text, but the TOOL ITSELF already truncated field(s)\n` +
          `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
          `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n` +
          `# detected marker(s): ${innerTruncationMarkers.join(', ')} — these mark field(s) the tool cut\n` +
          `# short BEFORE this door ever ran. This file holds everything the tool DID emit, but the\n` +
          `# marked field(s) are themselves incomplete and were never fully serialized — paging this\n` +
          `# file will NOT recover them. Re-call ${opts.toolName} with a wider per-field limit/budget\n` +
          `# argument for the missing detail.\n\n`
        : // EI-18762253154342502: never claim "FULL" unconditionally — no marker firing
          // proves nothing was cut upstream, only that no DETECTED marker was found (a
          // tool can truncate a field with a plain ellipsis and no `_truncated` flag,
          // as plans:items did before this fix). "as it reached this door" is always
          // true and never overclaims what was actually recoverable.
          `# result-door spill — the text as it reached this door (no upstream truncation marker detected;\n` +
          `# that does NOT guarantee the tool emitted every field in full — only that none of its known\n` +
          `# _truncated markers fired)\n` +
          `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
          `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n\n`;
    // P-003 (agent-epistemics-2026-08-02): for a LIST-shaped result, lead the file
    // with one line per entry. The door already solves SIZE; this solves the question
    // the reader actually arrives with — "which of these do I care about" — which was
    // otherwise answered by grepping the spill file by hand. It lives in the FILE, not
    // in the returned result, so it costs the agent zero context. `buildSpillIndex`
    // returns null (never throws) whenever an index would not help, keeping the
    // door's fail-soft contract: a missing index is an annoyance, a failed WRITE
    // loses the payload.
    const spillIndex = buildSpillIndex(spillBodyText);
    // EI-21949915395361184: the recipe belongs in the FILE, for the reader who has only
    // the file. The manifest carries the boundary as a number; this says how to use it
    // without the cursor this call returns — and names the wrong guess explicitly,
    // because "parse from the first `{`" does not error, it returns the MANIFEST.
    // Deliberately prints no offset of its own: a number written here would sit inside
    // the very payload it measures.
    const spillBodyRecipe =
      bodyShape.json != null
        ? '# recover the JSON body from this file alone — the boundary is in the manifest on line 2:\n' +
          "#   P=$(sed -n 2p FILE | jq -r '.bodyOffsetInPayload'); H=$(head -2 FILE | wc -c)\n" +
          '#   tail -c +$((H + P + 1)) FILE | jq .\n' +
          '# Do NOT parse from the first `{` — that is the manifest: well-formed, wrong object.\n\n'
        : '';
    const spillPrefix = header + spillBodyRecipe + spillAdvisoryPrefix + (spillIndex ? `${spillIndex}\n` : '');
    if (fsPath != null) {
      try {
        const parts = scratchParts(opts);
        spillManifest = writeScratchReference({
          filePath: fsPath,
          payload: spillPrefix + spillBodyText,
          workspaceId: parts.workspaceId,
          ownerId: opts.ownerId,
          audience: opts.ownerId ? 'owner' : 'workspace',
          mediaType: 'text/plain',
          content: contentMetadata(items),
          evidence: spillEvidence,
          // EI-21949915395361184: put the boundary IN THE FILE, not only in the cursor
          // this call returns. Ten reports across five months all describe the same
          // consumer — one holding the path and nothing else — and every guess that
          // consumer can make fails: `jq .` chokes on the magic line, and "first `{`
          // through EOF" silently parses the MANIFEST instead of the body. Declared for
          // a JSON body only, so its ABSENCE is the honest answer "there is no JSON here"
          // rather than a boundary that points at prose.
          ...(bodyShape.json != null
            ? { bodyOffsetInPayload: Buffer.byteLength(spillPrefix, 'utf8') }
            : {}),
        });
      } catch (err) {
        // WI-36047: the write failed — fall through to the CAP anyway, and null
        // the path so no footer, no `_meta`, and no telemetry backfill advertises
        // a spill file that is not there. Truncate-without-recovery, never no-cap.
        noteSpillFailure(err);
      }
    }

    const baseResultDoorMeta = {
      truncated: true,
      /** null when the spill could NOT be written (WI-36047) — the result was
       *  still capped, but nothing was parked, so `_mcp-handler`'s outputRef
       *  backfill correctly declines to advertise a file that is not there. */
      spillPath: fsPath,
      spillUri: uri,
      /** True when the cap applied but the spill write failed, i.e. the cut
       *  content is gone. Distinct from `upstreamProjected` (content that was
       *  never serialized) — this is content the door itself discarded. */
      spillFailed: fsPath == null,
      /** Full fs error message (carries the failing path — kept OUT of the
       *  model-facing footer, which gets `spillErrorCode` instead). */
      spillError,
      spillErrorCode,
      originalChars: totalChars,
      /** Exact UTF-8 bytes as they reached the door. Unlike originalChars this
       * remains comparable to intermediateBytes for non-ASCII payloads. */
      originalBytes: sourceBytes,
      /** UTF-8 bytes of non-text content carried by this result. Kept under the
       *  legacy key for telemetry compatibility; D-021 makes it enforced. */
      nonTextChars,
      nonTextBytes: nonTextChars,
      doorTokens,
      /** True when `data` was ALREADY a lossy upstream projection before this
       *  door saw it — i.e. paging the spill cannot recover what was omitted. */
      upstreamProjected: Boolean(upstreamProjection),
      /** Field-level cutoffs the TOOL itself applied; the spill cannot recover
       *  these either (EI-18745696571494110). Empty when none were detected. */
      innerTruncationMarkers,
    };

    // WI-38402 / EI-20244970883634313 / EI-20435986111760474: character-slicing
    // ANY oversized text body creates an incomplete transport value. JSON was
    // the obvious case, but raw text is equally unsafe for a machine-readable
    // caller: code:tools emits TypeScript, and tools:invoke used to return a
    // sliced declaration followed by prose. ptool correctly refused that as an
    // incomplete payload, so a ten-signature acceptance read could not recover.
    //
    // This is the universal model-facing choke point. Project both JSON and
    // non-JSON text STRUCTURALLY and serialize only after projection completes.
    // Non-JSON text gets a stable `{ text, _projection }` envelope; JSON retains
    // its native object/array shape plus `_projection`. The durable spill is
    // written first, so both forms carry the same schema-valid capability:read
    // cursor and no client ever has to parse a chopped prefix plus a prose footer.
    const parsedJsonBody = bodyShape.json != null;
    // A valid JSON body can still be only the tool's emitted SAMPLE: custom
    // shapers such as plans:get mark clipped record fields with
    // `body_truncated:true`.  It is safe to expose the spill for inspection,
    // but it is NOT safe to advertise the byte boundary as an exact, complete
    // JSON recovery point — the omitted records were never serialized.
    const partialJsonBody = parsedJsonBody && innerTruncationMarkers.length > 0;
    // TWO different byte streams reach a caller here, and ONE offset cannot
    // serve both — EI-21239097430071791 followed this cursor exactly as written
    // and landed mid-body, because the offset was measured against a stream the
    // caller was never handed:
    //   * the RAW on-disk file at `cursor.args.file_path` — what shell / jq /
    //     grep users read. Its body is preceded by the scratch-reference
    //     manifest header AND the result-door prefix.
    //   * capability:read's returned `response.data` — what THIS cursor's own
    //     `next` tells the caller to fetch. read.ts strips the manifest
    //     (`bytes = parsed.payload`) BEFORE applying byte_offset, so only the
    //     result-door prefix precedes the body there.
    // The manifest header is ~450 bytes, so using the file-relative offset
    // against capability:read's payload overshoots into the middle of the JSON
    // and yields an unparseable fragment. Naming each field for the stream it
    // measures is the durable fix: a bare `bodyByteOffset` silently means the
    // wrong thing to whichever of the two audiences does not own it.
    const spillPrefixBytes = Buffer.byteLength(spillPrefix, 'utf8');
    const bodyOffsetInPayload = spillPrefixBytes;
    const bodyOffsetInFile = spillManifest == null
      ? null
      : scratchReferencePayloadByteOffset(spillManifest) + spillPrefixBytes;
    const recovery =
      fsPath != null && uri != null
        ? {
            cursor: {
              kind: 'scratch-page',
              tool: 'capability:read',
              args: { file_path: fsPath, byte_offset: 0, byte_limit: 3_072 },
              maxByteLimit: CAPABILITY_READ_MAX_BYTE_PAGE,
              uri,
              // EI-20685195115158619: named `dataEncoding`, not `encoding`. Bare
              // and adjacent to `file_path`, it read as "the file at that path is
              // base64" — an agent took that reading, ran `base64 -d <path>`, got
              // `invalid input`, and burned calls. Only capability:read's response
              // `data` field is base64 (byte-window mode, read.ts); the spill FILE
              // is plaintext UTF-8, and being directly greppable/tailable is the
              // point of writing it that way. The key binds to the field it
              // describes and costs 4 chars against the budget guarded below;
              // `result-door-encoding-contract.test.ts` then follows this cursor
              // end-to-end so the declaration and the bytes cannot drift apart.
              dataEncoding: 'base64',
              // The spill is plaintext with a Markdown header (and, for
              // list-shaped results, an index) before the body, and the RAW file
              // additionally opens with the scratch-reference manifest — whose
              // `{` is the file's FIRST `{`. So the natural fallback, "start
              // parsing at the first brace", finds the MANIFEST: a well-formed
              // but WRONG object. JSON callers need the exact boundary for the
              // stream they are actually reading, never a guess.
              //
              // Emitted for EVERY valid JSON body, INCLUDING a tool-internally
              // clipped one. The prior rule withheld it whenever the tool had
              // marked field truncation (EI-21185758364267344), which treated
              // "where does the body start" as though it were "is the body
              // complete" — two orthogonal facts. That filing's actual complaint
              // was the COMPLETENESS promise, not the locator, and withholding
              // the locator never stopped anyone parsing the same bytes: it only
              // pushed them onto the first-brace fallback above, converting a
              // loud failure into a silent wrong object (EI-21208128396414381,
              // EI-21202588767992062). Completeness now travels as its own
              // machine-readable field rather than being signalled by ABSENCE,
              // which no caller can distinguish from "this door emitted nothing".
              ...(parsedJsonBody
                ? {
                    bodyOffsetInPayload,
                    ...(bodyOffsetInFile != null ? { bodyOffsetInFile } : {}),
                    ...(partialJsonBody ? { bodyComplete: false } : {}),
                  }
                : {}),
            },
            next:
              // `response.data` rather than a bare `data`: naming the field's OWNER
              // is what stops the misread, and stating the file's encoding outright
              // beats the old "begins with a text header" hint that left the reader
              // to infer it. Both are paid for by tightening the trailing sentence
              // — this pointer is NET SHORTER than the ambiguous version it
              // replaced, which is the only reason it clears WI-5656 below.
              `Use capability:read with _projection.cursor.args; file_path is an encoded ` +
              `scratch-reference, not JSON. For each page, validate response.data as canonical ` +
              `base64 and decoded.length===byte_length; follow next_cursor; parse JSON only at ` +
              `eof:true + next_cursor:null. ` +
              (partialJsonBody
                ? `inspect the emitted spill bytes at cursor.bodyOffsetInPayload. The tool marked ` +
                  `${innerTruncationMarkers.join(', ')}; this JSON is partial (bodyComplete:false) and ` +
                  `paging cannot recover omitted fields. Re-call ${opts.toolName} with a wider per-field limit.`
                : `recover spill; ` +
                  (parsedJsonBody
                    ? `JSON starts after cursor.bodyOffsetInPayload in response.data.`
                    : `the spill opens with a text header.`)) +
              // Keep the JSON recovery pointer compact. The payload projector budgets
              // the pointer together with the retained JSON preview; page-integrity
              // and EOF gating are load-bearing, so the contract above is deliberately
              // terse and its bounded size is pinned by result-door-encoding-contract.test.ts.
              // Raw text needs the fuller honesty wording because its new
              // `{ text, _projection }` envelope replaced the former prose footer
              // that carried those disclosures.
              (parsedJsonBody
                ? ''
                : ` The unwrapped spill payload is plaintext. Read it through capability:read; ` +
                  `direct shell access to args.file_path can be sandbox-masked. Do not ` +
                  `\`base64 -d\` the manifest-bearing file (response.data is base64).`) +
              (parsedJsonBody || partialJsonBody
                ? ''
                : upstreamProjection
                  ? ` ⚠ This is NOT the tool's full output: it was ALREADY tier-projected upstream ` +
                    `(tier=${upstreamProjection.tier}, forced=${upstreamProjection.forced}, ` +
                    `omittedCount=${upstreamProjection.omittedCount}); paging cannot recover those omitted ` +
                    `fields. Re-call ${opts.toolName} with payloadTier:'full' for full detail.`
                  : innerTruncationMarkers.length > 0
                    ? ` ⚠ The TOOL ITSELF already truncated field(s) before this door ` +
                      `(${innerTruncationMarkers.join(', ')}); paging preserves what it emitted but cannot ` +
                      `recover those fields. Re-call ${opts.toolName} with a wider per-field limit.`
                    : ` No upstream truncation marker was detected; that does not prove the tool emitted ` +
                      `every field in full.`) +
              buildProjectionHint(textItems, opts.toolName, bodyShape),
          }
        : {
            cursor: {
              kind: 'unavailable',
              tool: opts.toolName,
              args: {},
              reason: 'spill-write-failed',
            },
            next:
              `The result was structurally bounded, but its spill write failed ` +
              `(${spillErrorCode ?? 'unknown error'}), so the omitted bytes are NOT recoverable and no ` +
              `spill path exists. Re-call ${opts.toolName} with narrower arguments or a projection.` +
              (upstreamProjection
                ? ` It was ALSO tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                  `so those fields were never serialized either.`
                : '') +
              buildProjectionHint(textItems, opts.toolName, bodyShape),
          };
    // plans:get's item text is the semantic payload of the detail read, not an
    // optional identity field. Promote it through the generic fallback so a
    // deep/key-bounded result keeps the instruction the caller came to read.
    // The projector still applies its normal string/transport budgets, whose
    // in-band markers make a clipped value honest; this only prevents the field
    // from disappearing as an identity-only omission. Merge caller-selected
    // paths rather than replacing them (projection.pick remains additive).
    // Order is PRIORITY (payload-tier.ts `preservedChildRank`): the earlier path
    // wins the budget. `shipReadiness` leads because it is opt-in and default-OFF
    // — a caller only sees it by asking for it BY NAME, and its absence reads as
    // "nothing is blocking this plan", a false green on a ship gate
    // (EI-22186855527494865). `items[].text` follows: also load-bearing, but an
    // items array announces its own truncation in band, so a cut there is visible.
    const preservePaths = [
      ...(opts.toolName === 'plans:get' ? ['results[].shipReadiness', 'results[].items[].text'] : []),
      ...(opts.toolName === PIPELINE_POSITION_TOOL ? PIPELINE_POSITION_PRESERVE_PATHS : []),
      ...(opts.toolName === 'coord:send' ? COORD_SEND_DELIVERY_PRESERVE_PATHS : []),
      // work_items:complete writes these fields before its bulky echoes, and its
      // tier shaper deliberately spreads them through unchanged. The generic
      // result-door is a later, independent projection seam, though: without an
      // explicit priority here, a multi-row completion can keep row 1/2's
      // identity while reducing a later row to `{id,ok,workItem:{_partial:true}}`.
      // That is especially dangerous for `completionAuthority:'proposed'` and
      // its two load-bearing warnings: the caller sees a close receipt but loses
      // the evidence that it is not counted and why. Keep correlation first,
      // then the authority/count verdict, then the explanatory warnings; values
      // still obey the projector's normal string and transport budgets.
      ...(opts.toolName === 'work_items:complete'
        ? [
            'results[].ok',
            'results[].id',
            'results[].completionAuthority',
            'results[].countsTowardBurnDown',
            'results[].authorityWarning',
            'results[].requirementShortfallWarning',
          ]
        : []),
      ...(opts.preservePaths ?? []),
    ];
    const structuralProjectionWarning = extractStructuralProjectionWarning(result, textItems, jsonItemIndex);
    // The warning is a separate model-facing content item, so reserve its
    // UTF-8 bytes before asking the generic projector to fill the result door.
    // Without this reservation, preserving the warning can make the combined
    // result exceed the same cap this branch is enforcing.
    const structuralTargetChars = Math.max(
      1_500,
      budgetChars -
        (structuralProjectionWarning ? Buffer.byteLength(structuralProjectionWarning, 'utf8') : 0),
    );
    const evaluatorCompactBody =
      parsedJsonBody && opts.toolName === SPEC_TEST_ADEQUACY_TOOL
        ? compactSpecTestAdequacyBody(bodyShape.json!.parsed)
        : null;
    const projected = projectBoundedPayload(
      evaluatorCompactBody ?? (parsedJsonBody ? bodyShape.json!.parsed : { text: fullText }),
      {
      toolName: opts.toolName,
      tier: 'trimmed',
      forced: true,
      originalChars: totalChars,
      targetChars: structuralTargetChars,
      recovery,
      // The generic payload-tier projection wraps arrays so its `_projection`
      // metadata can survive JSON serialization. At this model-facing door the
      // source tool's top-level shape is part of its contract (notably
      // work_items:list), so keep an array root while retaining the metadata
      // out-of-band for this process and in `_meta.resultDoor` below.
      preserveArrayRoot: parsedJsonBody && Array.isArray(bodyShape.json!.parsed),
      // These roots contain model-facing state that cannot be reconstructed
      // from the generic identity fields. Keep them visible even if
      // projection metadata forces the final identity-only fallback;
      // ordinary tools retain the generic behavior.
      ...(opts.toolName === 'coord:orient'
        ? { preserveTopLevelKeys: ['self', 'recovery'] as const }
        : opts.toolName === 'events:status'
          ? { preserveTopLevelKeys: ['event_inspection'] as const }
          : {}),
      ...(evaluatorCompactBody == null && preservePaths.length > 0 ? { preservePaths } : {}),
      bulkEnvelope: opts.bulkEnvelope,
    });
    const structuralText = JSON.stringify(projected);
    let inserted = false;
    const structuralContent: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    for (const item of items) {
      if (isTextItem(item)) {
        if (!inserted) {
          structuralContent.push({ type: 'text', text: structuralText });
          inserted = true;
        }
      } else {
        structuralContent.push(item as Record<string, unknown>);
      }
    }
    if (structuralProjectionWarning) {
      // Degraded projection verdicts are intentionally kept ahead of the
      // structural JSON so a caller cannot mistake a fail-open body for a
      // successful selection. Ordinary advisory text remains spill-only.
      structuralContent.unshift({ type: 'text', text: structuralProjectionWarning });
    }
    return {
      ...result,
      _meta: {
        ...(result._meta ?? {}),
        resultDoor: {
          ...baseResultDoorMeta,
          structural: true,
          ...(evaluatorCompactBody != null
            ? { compactProjection: 'evaluator-specific:plans:evaluate-spec-test-adequacy' }
            : {}),
          recoveryCursor: recovery.cursor,
        },
      },
      content: structuralContent,
      // EI-20335562969900283: `structuredContent` is the schema-bearing MCP
      // payload, not a second copy of the model-facing text body. Replacing it
      // with `projected` can violate the declared outputSchema after a generic
      // projection omits rows/required fields. Preserve it byte-for-byte; only
      // model-facing text is subject to this context door.
    } as T;
  } catch {
    return result; // fail-soft: never let the door break a good result
  }
}
