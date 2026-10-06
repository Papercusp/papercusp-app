/**
 * Apply a validated projection to a materialized tool result.
 *
 * FAIL-OPEN, WITH THE REASON ATTACHED. Everything reaching this file has already
 * passed parse.ts, so a failure here means the well-formed spec did not FIT the
 * actual result (a `pick` on a body that is not JSON, a path that matched
 * nothing). The tool has already run and returned something valid; throwing that
 * away over a presentational miss would be the wrong trade. So the result passes
 * through and the reason lands in `notes` — visible in `_meta.resultProjection`
 * AND in the in-band footer, because fail-open is only honest if it is loud.
 * A silent no-op would read exactly like "the tool returned everything", which
 * is precisely the misattribution D-042 forbids.
 *
 * ONE deliberate exception to pass-through: a `pick` that matches NOTHING on a
 * body larger than PICK_MISS_FAIL_OPEN_MAX_CHARS is REFUSED with a bounded key
 * list rather than failing open into the full body (EI-23774219620725180) — the
 * caller used `projection` to AVOID that cost, and the corrected path is what
 * they need, not the body. Still loud, still never an empty `{}`.
 *
 * Operator semantics track the coreutils they stand in for (uniq collapses only
 * ADJACENT runs; cut passes non-delimited lines through unless -s; grep emits
 * `--` between non-contiguous context groups) so that a rewrite of a real corpus
 * command means what the command meant. Sort is the one deliberate divergence:
 * codepoint order, never locale order, so the same result is reproducible on any
 * host. @see ./types.ts for the regex-flavor contract.
 */

import { describeProjection } from './parse';
import { parseFormatRequest } from '@papercusp/result-encoding';
import type { ProjectionReport, ProjectionSpec, ProjectionStage } from './types';
import { COORD_SEND_RECEIPT_RECOVERY, isCoordSendDeliveryDiagnostic } from '../agent-tools/coordination/tools/inbox-content-bounds';

/**
 * Choose the wire format for the intermediate body consumed by a projection.
 *
 * MCP's implicit/`compact` format may be TOON, while structured `pick` needs a
 * JSON body. Preserve every explicit format request; only replace the
 * transport default (including an unrecognized token that would fall back to
 * that default) with JSON for the in-process materialization step.
 */
export function projectionMaterializationFormat(
  requestedFormat: string | undefined,
  needsFullSource: boolean,
): string | undefined {
  if (!needsFullSource) return requestedFormat;
  const parsed = parseFormatRequest(requestedFormat);
  return parsed === undefined || parsed === 'compact' ? 'json' : requestedFormat;
}

/** The subset of an MCP tools/call result this stage reads/rewrites. */
export interface ProjectableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

function isTextItem(it: unknown): it is { type: 'text'; text: string } {
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { type?: unknown }).type === 'text' &&
    typeof (it as { text?: unknown }).text === 'string'
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * One line naming the body's ACTUAL root shape, for the pick-miss notes
 * (EI-20720054720826414). A miss report that only repeats the failed paths
 * costs the caller a blind second guess; naming the shape (and, for arrays,
 * the element keys and the `[].key` spelling) converts the round trip into a
 * corrected call. Bounded: at most 12 keys, first object element only.
 */
export function describeBodyShape(body: unknown): string {
  const keyList = (keys: string[]): string =>
    keys.slice(0, 12).join(', ') + (keys.length > 12 ? ', …' : '');
  if (Array.isArray(body)) {
    const first = body.find(isPlainObject);
    const keys = first ? Object.keys(first) : [];
    return (
      `an ARRAY of ${body.length} element(s)` +
      (keys.length ? ` with keys: ${keyList(keys)}` : '') +
      ` — select array elements with \`[].key\``
    );
  }
  if (isPlainObject(body)) {
    const keys = Object.keys(body);
    return keys.length ? `an OBJECT with key(s): ${keyList(keys)}` : 'an empty OBJECT';
  }
  return `a bare ${body === null ? 'null' : typeof body} value`;
}

// ── pick-miss REFUSAL (EI-23774219620725180) ──────────────────────────────────
//
// A `pick` that matches NOTHING used to fail open into the FULL unprojected
// body. That is loud, but it is the worst trade on exactly the bodies that make
// a caller reach for `projection`: the caller asked for less BECAUSE the body
// was large, the typo removed the protection while keeping the cost (measured:
// events:catalog, 61,066 of 61,066 chars retained, 0% removed, then spilled to
// scratch anyway — the full cost and still no complete result).
//
// Returning `{}` instead would be quiet-and-wrong (an empty result reads like a
// filter that worked — the silent false-negative family). The third option is to
// REFUSE: stay loud, stay bounded, and hand back the corrected path. The caller
// does not need the body; they need the spelling. Everything below is computed
// from the body the door already holds, so it adds no source read.
//
// Below the budget the whole body is returned unprojected as before: it costs
// no more than the diagnostic would, and is strictly more informative.

/** A body at or under this many chars still fails open unprojected (cheaper than the refusal). */
export const PICK_MISS_FAIL_OPEN_MAX_CHARS = 3000;
const PICK_MISS_HEAD_SAMPLE_CHARS = 600;
const PICK_MISS_MAX_KEYS = 40;
const PICK_MISS_MAX_NEAR_MISSES = 6;
const PICK_MISS_MAX_ROWS_SCANNED = 25;

function pickMissTypeTag(value: unknown): string {
  if (Array.isArray(value)) return `array[${value.length}]`;
  if (value === null) return 'null';
  if (isPlainObject(value)) return 'object';
  return typeof value;
}

/** `key (type)` hints for the union of keys over a set of nodes, first-seen order, bounded. */
function pickMissKeyHints(nodes: readonly unknown[]): string[] {
  const seen = new Map<string, string>();
  for (const node of nodes) {
    if (!isPlainObject(node)) continue;
    for (const [key, value] of Object.entries(node)) {
      if (!seen.has(key)) seen.set(key, pickMissTypeTag(value));
    }
  }
  const hints = [...seen].map(([key, tag]) => `${key} (${tag})`);
  return hints.length > PICK_MISS_MAX_KEYS
    ? [...hints.slice(0, PICK_MISS_MAX_KEYS), `… +${hints.length - PICK_MISS_MAX_KEYS} more`]
    : hints;
}

interface PickNearMiss {
  path: string;
  /** The longest leading part of the path that DID resolve against the body. */
  matchedPrefix: string;
  /** Keys available at that point (wildcards expand over the first rows). */
  keysThere: string[];
  /** Why the next segment failed, when that is knowable. */
  hint?: string;
}

/**
 * Walk a missed path as far as it resolves. Wildcard (`[]`) segments fan out over
 * the first rows so the keys reported are the union a caller can really address,
 * not the first row's accident. Returns null when not even the first segment
 * resolved: the root key list already says everything there is to say.
 */
function describePickNearMiss(body: unknown, path: string): PickNearMiss | null {
  const segs = parsePickPath(path);
  let nodes: unknown[] = [body];
  let prefix = '';
  let hint: string | undefined;
  for (const seg of segs) {
    let next: unknown[];
    let spelled: string;
    if (seg.kind === 'key') {
      next = nodes.filter((n) => isPlainObject(n) && seg.name in n).map((n) => (n as Record<string, unknown>)[seg.name]);
      spelled = prefix ? `.${seg.name}` : seg.name;
      if (next.length === 0 && nodes.length > 0 && nodes.every(Array.isArray)) {
        hint = `\`${prefix}\` is an ARRAY — select its elements with \`${prefix}[].${seg.name}\``;
      }
    } else if (seg.kind === 'array') {
      next = nodes.flatMap((n) => (Array.isArray(n) ? n.slice(0, PICK_MISS_MAX_ROWS_SCANNED) : []));
      spelled = '[]';
      if (nodes.length > 0 && next.length === 0 && !nodes.some(Array.isArray)) {
        hint = `\`${prefix || '(root)'}\` is not an array, so \`[]\` selects nothing here`;
      }
    } else {
      next = nodes.flatMap((n) => (Array.isArray(n) && seg.i < n.length ? [n[seg.i]] : []));
      spelled = `[${seg.i}]`;
    }
    if (next.length === 0) break;
    nodes = next;
    prefix += spelled;
  }
  if (prefix === '') return null;
  // An array node's addressable keys are its ELEMENTS' keys, via `[]`.
  const arrayNodes = nodes.every(Array.isArray) && nodes.length > 0;
  const rows = arrayNodes ? nodes.flatMap((n) => (n as unknown[]).slice(0, PICK_MISS_MAX_ROWS_SCANNED)) : nodes;
  return {
    path,
    matchedPrefix: arrayNodes ? `${prefix}[]` : prefix,
    keysThere: pickMissKeyHints(rows),
    ...(hint ? { hint } : {}),
  };
}

/** The bounded stand-in body returned INSTEAD of a large unprojected one. */
export function buildPickMissRefusal(
  body: unknown,
  requested: readonly string[],
  bodyChars: number,
  retainedWriteOutcome?: unknown,
): Record<string, unknown> {
  const rootNodes = Array.isArray(body)
    ? body.slice(0, PICK_MISS_MAX_ROWS_SCANNED)
    : [body];
  const nearMisses = requested
    .map((path) => describePickNearMiss(body, path))
    .filter((miss): miss is PickNearMiss => miss !== null)
    .slice(0, PICK_MISS_MAX_NEAR_MISSES);
  const sampleSource = Array.isArray(body) ? body[0] : body;
  const sampleJson = JSON.stringify(sampleSource) ?? '';
  const sampleTruncated = sampleJson.length > PICK_MISS_HEAD_SAMPLE_CHARS;
  return {
    projection_refused: 'pick_matched_nothing',
    requested_pick: requested,
    body_chars_withheld: bodyChars,
    body_shape: describeBodyShape(body),
    [Array.isArray(body) ? 'row_keys' : 'root_keys']: pickMissKeyHints(rootNodes),
    ...(nearMisses.length > 0 ? { near_misses: nearMisses } : {}),
    head_sample: sampleTruncated ? `${sampleJson.slice(0, PICK_MISS_HEAD_SAMPLE_CHARS)}…` : sampleJson,
    ...(sampleTruncated ? { head_sample_truncated: true } : {}),
    ...(retainedWriteOutcome !== undefined && isPlainObject(retainedWriteOutcome) && Object.keys(retainedWriteOutcome).length > 0
      ? { write_outcome_retained: retainedWriteOutcome }
      : {}),
    next:
      'Re-call with a pick spelled from root_keys / near_misses. To receive the whole body anyway, ' +
      'omit `projection` (the result door then bounds it), or use `pipe` alone.',
  };
}

/** How a materialized result body looks to the two projection domains. */
export interface ProjectionBodyShape {
  /** The JSON payload, when the body (or one of its text items) parses. */
  json: { parsed: unknown; itemIndex: number } | null;
  /** Lines the `pipe` operators would see. 1 ⇒ every line operator is
   *  all-or-nothing on this body. */
  lineCount: number;
}

/**
 * Classify a result body for projection: is there a JSON payload (⇒ `pick`
 * reduces it), and how many lines do the `pipe` operators actually see?
 *
 * Extracted so the two callers CANNOT diverge (D-012, plan
 * agent-context-firewall-and-output-spill-2026-08-02): `applyResultProjection`
 * uses it to find the payload `pick` operates on, and the result-door footer
 * uses it to decide which operator to RECOMMEND. Before this, the footer was a
 * constant that led with `pipe` unconditionally — advertising, on a one-line
 * JSON body, the one operator family that provably cannot reduce it (a
 * `grep` no-match returns an EMPTY body, which reads like a successful
 * filter). Same shape as P-015: derive the taught remedy from the code that
 * enforces it, so it cannot drift.
 *
 * The per-item fallback is load-bearing, not defensive: a structured result is
 * routinely NOT one text item — the JSON payload is followed by advisory prose
 * ("See also: …") — so the JOINED text does not parse even though the payload
 * plainly does.
 */
export function classifyProjectionBody(
  textItems: ReadonlyArray<{ text: string }>,
): ProjectionBodyShape {
  const joined = textItems.map((it) => it.text).join('\n\n');
  const lineCount = joined === '' ? 0 : splitLines(joined).lines.length;
  try {
    return { json: { parsed: JSON.parse(joined), itemIndex: -1 }, lineCount };
  } catch {
    /* not the joined body — try each item */
  }
  for (let i = 0; i < textItems.length; i += 1) {
    try {
      return { json: { parsed: JSON.parse(textItems[i].text), itemIndex: i }, lineCount };
    } catch {
      /* not this one — keep looking */
    }
  }
  return { json: null, lineCount };
}

/**
 * Truncation evidence that can survive in the body without the shared
 * `_meta.payloadProjection` envelope. Custom shapers own their output shape,
 * so they may emit camelCase/snake_case field markers, while the generic
 * bounded projector emits `_projection` and in-band recovery markers.
 *
 * This is deliberately bounded and marker-shaped rather than a broad search
 * for the word "truncated": result payloads can contain ordinary prose about
 * truncation, but these keys/placeholders are the contracts that mean the
 * body is partial. The result-door has a similar detector for spill wording;
 * projection must detect the same evidence BEFORE a pipe can remove it.
 */
interface BodyTruncationMarker {
  path: string;
  detail: string;
  kind?: 'read-window';
}

const MAX_BODY_TRUNCATION_MARKERS = 8;
const TRUNCATION_KEY_REGEX = /(?:^|_)[A-Za-z0-9]*(?:truncated|Truncated)$/;
const TRUNCATED_BY_KEY_REGEX = /^truncatedBy[A-Z]/;
// The `omitted:` arm keys on the `recover:` POINTER PREFIX, never on the route
// that follows it. `omissionMarker` emits several pointers — the cursor, and
// (WI-1697551) a deferral to `_projection.next` where it used to assert a
// re-call — and this consumer must detect the CUT, which every flavour shares,
// not the escape hatch, which varies by caller. Pinning the route made this
// blind to cursor-flavour omissions the whole time it looked exhaustive: the
// pipe could then strip truncation evidence it had failed to detect. That is
// the make-the-wording-load-bearing hazard P-009/D-007 is about, so keep this
// keyed to the stable prefix.
const INLINE_TRUNCATION_MARKER_REGEX =
  /(?:…)?\[(?:TRUNCATED\b[^\]\n]*|omitted:\s*[^\]\n]*\brecover:\s*[^\]\n]*|payload preview omitted:[^\]\n]*)\]/gi;
// capability:read's ordinary line view carries this marker when its default
// 2000-line window did not reach EOF. A projection grep can remove the marker
// itself, so detect it before running any pipe stages (EI-22600297478962145).
const READ_WINDOW_MARKER_REGEX = /(?:…)?\[\d[\d,]*\s+more lines\s+—\s+re-read with offset=\d+\]/gi;

function truncationPath(path: string, key: string): string {
  return path === '$' ? `$.${key}` : `${path}.${key}`;
}

function isTruncationKey(key: string): boolean {
  return key === '_partial' || key === 'truncated' || key === 'payloadTierForced' || TRUNCATION_KEY_REGEX.test(key) || TRUNCATED_BY_KEY_REGEX.test(key);
}

function hasNonEmptyPartialityValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value === true;
}

function isSelectionMetadataKey(key: string): boolean {
  return key === 'selection' || key.endsWith('Selection');
}

function addBodyTruncationMarker(
  markers: BodyTruncationMarker[],
  path: string,
  detail: string,
  kind?: BodyTruncationMarker['kind'],
): void {
  if (markers.length >= MAX_BODY_TRUNCATION_MARKERS) return;
  if (markers.some((marker) => marker.path === path)) return;
  markers.push({ path, detail, ...(kind ? { kind } : {}) });
}

/** Find the marker-shaped truncation contracts in a parsed result body. */
function detectBodyTruncationMarkers(toolName: string | undefined, ...sources: Array<{ value: unknown; text?: string }>): BodyTruncationMarker[] {
  const markers: BodyTruncationMarker[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: string): void => {
    if (markers.length >= MAX_BODY_TRUNCATION_MARKERS || value == null) return;
    if (typeof value === 'string') {
      const scanInlineMarkers = (regex: RegExp, kind?: BodyTruncationMarker['kind']): void => {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(value)) && markers.length < MAX_BODY_TRUNCATION_MARKERS) {
          addBodyTruncationMarker(markers, `${path} (inline)`, match[0].slice(0, 140), kind);
        }
      };
      scanInlineMarkers(INLINE_TRUNCATION_MARKER_REGEX);
      scanInlineMarkers(READ_WINDOW_MARKER_REGEX, 'read-window');
      return;
    }
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length && markers.length < MAX_BODY_TRUNCATION_MARKERS; i += 1) {
        visit(value[i], `${path}[${i}]`);
      }
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (markers.length >= MAX_BODY_TRUNCATION_MARKERS) break;
      const childPath = truncationPath(path, key);
      const markerObject = isPlainObject(child);
      const childTruncated = markerObject && child.truncated === true;

      if (key === 'payloadTierForced' && (child === true || typeof child === 'string')) {
        addBodyTruncationMarker(markers, childPath, `${key}=${String(child)}`);
      } else if ((key === '_projection' || key === 'projection' || key === 'payloadProjection') && childTruncated) {
        addBodyTruncationMarker(markers, `${childPath}.truncated`, 'truncated=true');
      } else if (
        isTruncationKey(key) && !isCoordSendDeliveryDiagnostic(toolName, key) &&
        (child === true || (markerObject && key !== 'truncated' && Object.keys(child).length > 0))
      ) {
        addBodyTruncationMarker(markers, childPath, key === 'truncated' ? 'truncated=true' : `${key} marker`);
      }
      if (isSelectionMetadataKey(key) && markerObject) {
        for (const partialityKey of ['deferred', 'missing'] as const) {
          if (hasNonEmptyPartialityValue(child[partialityKey])) {
            addBodyTruncationMarker(
              markers,
              `${childPath}.${partialityKey}`,
              `non-empty ${partialityKey} selection metadata`,
            );
          }
        }
      }
      if (key === 'omittedCount' && hasNonEmptyPartialityValue(child)) {
        addBodyTruncationMarker(markers, childPath, `omittedCount=${String(child)}`);
      }

      visit(child, childPath);
    }
  };

  for (const source of sources) {
    if (markers.length >= MAX_BODY_TRUNCATION_MARKERS) break;
    if (source.text !== undefined) visit(source.text, '$.content');
    visit(source.value, '$');
  }
  return markers;
}

function describeBodyTruncationMarkers(markers: BodyTruncationMarker[]): string {
  return markers.map(({ path, detail }) => `${path} (${detail})`).join('; ');
}

// ── line operators ────────────────────────────────────────────────────────────

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

/** grep, including GNU's `--` separator between non-contiguous context groups. */
function runGrep(lines: string[], s: Extract<ProjectionStage, { op: 'grep' }>): string[] {
  // Compiled ONCE per stage run, not per line — and parse.ts already proved it
  // compiles, so this cannot throw here.
  const re = s.fixed ? null : new RegExp(s.pattern, s.ignoreCase ? 'i' : '');
  const needle = s.fixed && s.ignoreCase ? s.pattern.toLowerCase() : s.pattern;
  const matches = (line: string): boolean => {
    if (re) return re.test(line);
    return s.ignoreCase ? line.toLowerCase().includes(needle) : line.includes(needle);
  };

  const hit: boolean[] = lines.map((l) => {
    const m = matches(l);
    return s.invert ? !m : m;
  });

  const before = s.before ?? 0;
  const after = s.after ?? 0;
  if (before === 0 && after === 0) return lines.filter((_, i) => hit[i]);

  // Mark the context window around every hit, then emit runs with `--` between
  // non-adjacent ones (GNU grep's exact presentation).
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!hit[i]) continue;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++) keep[j] = true;
  }
  const out: string[] = [];
  let prevKept = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    if (prevKept >= 0 && i > prevKept + 1) out.push('--');
    out.push(lines[i]);
    prevKept = i;
  }
  return out;
}

/** sort — codepoint order (see the file header on why not locale order). */
function runSort(lines: string[], s: Extract<ProjectionStage, { op: 'sort' }>): string[] {
  const cmp = s.numeric
    ? (a: string, b: string) => {
        const na = Number.parseFloat(a);
        const nb = Number.parseFloat(b);
        const va = Number.isNaN(na) ? 0 : na;
        const vb = Number.isNaN(nb) ? 0 : nb;
        return va === vb ? (a < b ? -1 : a > b ? 1 : 0) : va - vb;
      }
    : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  let out = [...lines].sort(cmp);
  if (s.reverse) out.reverse();
  if (s.unique) {
    const seen = new Set<string>();
    out = out.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
  }
  return out;
}

/** uniq — ADJACENT runs only, exactly like the binary. `-c` uses its %7d format. */
function runUniq(lines: string[], s: Extract<ProjectionStage, { op: 'uniq' }>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let n = 1;
    while (i + n < lines.length && lines[i + n] === lines[i]) n++;
    out.push(s.count ? `${String(n).padStart(7)} ${lines[i]}` : lines[i]);
    i += n;
  }
  return out;
}

/** cut -f. Non-delimited lines pass through whole unless `onlyDelimited` (-s). */
function runCut(lines: string[], s: Extract<ProjectionStage, { op: 'cut' }>): string[] {
  const delim = s.delimiter ?? '\t';
  const out: string[] = [];
  for (const line of lines) {
    if (!line.includes(delim)) {
      if (!s.onlyDelimited) out.push(line);
      continue;
    }
    const parts = line.split(delim);
    const picked = s.fields.filter((f) => f <= parts.length).map((f) => parts[f - 1]);
    out.push(picked.join(delim));
  }
  return out;
}

function runStage(lines: string[], stage: ProjectionStage): string[] {
  switch (stage.op) {
    case 'grep':
      return runGrep(lines, stage);
    case 'head':
      return lines.slice(0, stage.n);
    case 'tail':
      return stage.n === 0 ? [] : lines.slice(-stage.n);
    case 'sort':
      return runSort(lines, stage);
    case 'uniq':
      return runUniq(lines, stage);
    case 'cut':
      return runCut(lines, stage);
    case 'count':
      return [String(lines.length)];
  }
}

// ── structured `pick` ─────────────────────────────────────────────────────────

type Seg = { kind: 'key'; name: string } | { kind: 'array' } | { kind: 'index'; i: number };

// Keep wildcard-array misses addressable while sibling paths are merged. A
// normal array hole (or `undefined`) is serialized as `null`, which made a
// wholly unmatched `active[].state` look like a real row. This sentinel is
// removed only after every requested path has merged, so a later sibling path
// can still use the source index and stay correlated with its peers.
const PROJECTION_NO_MATCH = Symbol('projection-no-match');

/** `results[].payload.id` → [key results, array, key payload, key id] */
export function parsePickPath(path: string): Seg[] {
  const segs: Seg[] = [];
  for (const token of path.split('.')) {
    if (token === '') continue;
    const head = token.replace(/(\[\d*\])+$/, '');
    if (head) segs.push({ kind: 'key', name: head });
    const brackets = token.slice(head.length).match(/\[\d*\]/g) ?? [];
    for (const b of brackets) {
      const inner = b.slice(1, -1);
      segs.push(inner === '' ? { kind: 'array' } : { kind: 'index', i: Number(inner) });
    }
  }
  return segs;
}

/**
 * Rebuild the sub-shape `segs` selects out of `src`, MERGING into `into` so that
 * sibling paths land in the same object. Merging (rather than one flat
 * `{ path: value }` map) is what keeps `results[].id` and `results[].state`
 * correlated as `results:[{id,state}]` — a flat map would hand back two parallel
 * arrays the caller has to zip by position, and position is exactly the wrong
 * key to correlate a work-item list on.
 */
function projectPath(src: unknown, segs: Seg[], into: unknown, hit: { matched: boolean }): unknown {
  if (segs.length === 0) {
    hit.matched = true;
    return src;
  }
  const [seg, ...rest] = segs;
  if (seg.kind === 'key') {
    if (!isPlainObject(src) || !(seg.name in src)) return into;
    const base = isPlainObject(into) ? into : {};
    const childHit = { matched: false };
    const projected = projectPath(src[seg.name], rest, base[seg.name], childHit);
    if (!childHit.matched) return into;
    hit.matched = true;
    base[seg.name] = projected;
    return base;
  }
  if (!Array.isArray(src)) return into;
  if (seg.kind === 'index') {
    if (seg.i >= src.length) return into;
    const base = Array.isArray(into) ? into : [];
    const childHit = { matched: false };
    const projected = projectPath(src[seg.i], rest, base[seg.i], childHit);
    if (!childHit.matched) return into;
    hit.matched = true;
    base[seg.i] = projected;
    return base;
  }
  const base = Array.isArray(into) ? into : [];
  for (let i = 0; i < src.length; i++) {
    const childHit = { matched: false };
    const projected = projectPath(src[i], rest, base[i], childHit);
    if (childHit.matched) {
      base[i] = projected;
      hit.matched = true;
    } else if (!(i in base) || base[i] === undefined) {
      // Preserve the source index until sibling paths have had a chance to
      // merge into it; compactProjectionNoMatches removes this marker at the
      // projection boundary instead of letting JSON.stringify emit `null`.
      base[i] = PROJECTION_NO_MATCH;
    }
  }
  return base;
}

/** Remove internal wildcard misses after all paths have been correlated. */
function compactProjectionNoMatches(value: unknown): unknown {
  if (value === PROJECTION_NO_MATCH) return PROJECTION_NO_MATCH;
  if (Array.isArray(value)) {
    const compacted: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value) || value[i] === PROJECTION_NO_MATCH) continue;
      compacted.push(compactProjectionNoMatches(value[i]));
    }
    return compacted;
  }
  if (!isPlainObject(value)) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === PROJECTION_NO_MATCH) continue;
    compacted[key] = compactProjectionNoMatches(child);
  }
  return compacted;
}

/** Apply every `pick` path to a parsed body; reports paths that matched nothing. */
export function applyPick(body: unknown, paths: string[]): { picked: unknown; unmatched: string[] } {
  let acc: unknown = undefined;
  const unmatched: string[] = [];
  for (const p of paths) {
    const hit = { matched: false };
    acc = projectPath(body, parsePickPath(p), acc, hit);
    if (!hit.matched) unmatched.push(p);
  }
  return { picked: compactProjectionNoMatches(acc === undefined ? {} : acc), unmatched };
}

/**
 * WI-10002073 — the projection ROOT is not uniform across tools, and nothing in
 * a tool's schema or description announces which root it uses: `plans:get`
 * answers under `results[]`, `plans:get-spec-evidence` under `evidence[]`,
 * `work_items:get` under `results[].workItem`, and some tools answer at a bare
 * ARRAY root. So a `pick` path that is correct for one tool silently matches
 * nothing on another, and the only recovery is a second round-trip — per tool,
 * per agent, forever.
 *
 * The dispatch layer already holds the answer: it is the same knowledge the
 * no-match guard uses to enumerate the body's real keys. This turns that
 * knowledge into a REPAIR, under the two teeth EI-20720054720826414 already
 * established for the array-root case:
 *   1. only a path that MISSED is ever rewritten, so a working path is never
 *      reinterpreted; and
 *   2. a rewrite is applied only when it PROVABLY matches THIS body.
 * Plus a third that the object-root case needs and the array-root case did not:
 * when SEVERAL candidate spellings would match, NONE is applied. A leaf name
 * alone cannot say which one the caller meant, and guessing would trade a loud
 * miss for a silent wrong read — the one outcome worse than the round-trip.
 * The candidates are NAMED instead, which still removes the blind retry.
 */
const MAX_REPAIR_CANDIDATES = 24;

/** Keys of the first plain-object row whose value is itself a plain object. */
function nestedRowKeys(rows: readonly unknown[]): string[] {
  const row = rows.find(isPlainObject);
  if (!row) return [];
  return Object.keys(row).filter((key) => isPlainObject(row[key]));
}

/**
 * Strip a leading envelope segment (`key[]` or `[]`) from a pick path, leaving
 * the part that addresses a row. `results[].workItem.state` → `workItem.state`;
 * `[].id` → `id`; a bare `id` is already a tail and is returned unchanged.
 */
export function pickPathTail(path: string): string {
  const keyed = /^[A-Za-z0-9_$]+\[\]\.(.+)$/.exec(path);
  if (keyed) return keyed[1];
  const bare = /^\[\]\.(.+)$/.exec(path);
  if (bare) return bare[1];
  return path;
}

/**
 * Re-root spellings worth TESTING for a path that missed. Generation is cheap
 * and deliberately over-broad; correctness comes from the caller proving each
 * candidate against the real body, never from this list being right.
 */
export function pickRepairCandidates(body: unknown, path: string): string[] {
  const out: string[] = [];
  const push = (candidate: string): void => {
    if (candidate !== path && !out.includes(candidate)) out.push(candidate);
  };

  if (Array.isArray(body)) {
    // The original array-root case: a bare key addresses an object root.
    if (!path.startsWith('[')) push(`[].${path}`);
    return out.slice(0, MAX_REPAIR_CANDIDATES);
  }
  if (!isPlainObject(body)) return out;

  // A keyed envelope: the caller's path may name the wrong envelope key, omit
  // it entirely, or stop one level short of where the row actually nests.
  const tail = pickPathTail(path);
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      push(`${key}[].${tail}`);
      for (const nested of nestedRowKeys(value)) push(`${key}[].${nested}.${tail}`);
    } else if (isPlainObject(value)) {
      push(`${key}.${tail}`);
    }
  }
  return out.slice(0, MAX_REPAIR_CANDIDATES);
}

/**
 * Classify each missed path as repairable (exactly one candidate provably
 * matches) or ambiguous (several do). A path with no matching candidate is in
 * neither map and stays a loud miss.
 */
export function proposePickRepairs(
  body: unknown,
  missed: readonly string[],
  alreadySelected: readonly string[],
): { repairs: Map<string, string>; ambiguous: Map<string, string[]> } {
  const repairs = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const path of missed) {
    const matching = pickRepairCandidates(body, path).filter(
      (candidate) =>
        !alreadySelected.includes(candidate) && applyPick(body, [candidate]).unmatched.length === 0,
    );
    if (matching.length === 1) repairs.set(path, matching[0]);
    else if (matching.length > 1) ambiguous.set(path, matching);
  }
  return { repairs, ambiguous };
}

/**
 * Return the outcome paths that are present in a write result.  The paths are
 * discovered from the actual envelope rather than blindly appended: not every
 * write uses the keyed-array contract, and a successful bulk row normally has
 * no `error` property to retain.
 */
function writeOutcomePickPaths(body: unknown): string[] {
  if (!isPlainObject(body)) return [];

  const paths: string[] = [];
  for (const key of ['ok', 'error', 'counts'] as const) {
    if (Object.prototype.hasOwnProperty.call(body, key)) paths.push(key);
  }

  const results = body.results;
  if (Array.isArray(results)) {
    const rows = results.filter(isPlainObject);
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'ok'))) {
      paths.push('results[].ok');
    }
    if (rows.some((row) => Object.prototype.hasOwnProperty.call(row, 'error'))) {
      paths.push('results[].error');
    }
  }
  return paths;
}

// ── the stage ─────────────────────────────────────────────────────────────────

export interface ApplyProjectionOpts {
  /** Canonical tool name — names the tool in the in-band footer. */
  toolName?: string;
  /**
   * The tool's declared side-effect class. Write results retain their outcome
   * envelope even when the caller's pick names only success fields, because a
   * semantic write failure is commonly a resolved, ordinary JSON result rather
   * than an MCP `isError` transport envelope.
   */
  effect?: 'read' | 'write';
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  return `${Math.round((1 - part / whole) * 100)}%`;
}

/**
 * Apply `spec` to `result`. Returns the ORIGINAL object untouched when there is
 * no spec, when the result is a delta envelope (its content[0].text is
 * client-parsed JSON that a footer would corrupt), or when anything throws —
 * the same fail-soft contract the result-door holds: this stage must never turn
 * a good result into a failure.
 */
export function applyResultProjection<T extends ProjectableResult>(
  result: T,
  spec: ProjectionSpec | null,
  opts: ApplyProjectionOpts = {},
): T {
  if (!spec) return result;
  try {
    // EI-19944567995100280: an ERROR envelope is not a result being reduced —
    // there is nothing in it the caller wants filtered, and a `pipe`/`pick`
    // spec authored for the SUCCESS shape routinely matches nothing against an
    // error body (a one-line `invalid_input: ...` string, or JSON with a
    // completely different shape). Running it anyway silently deletes the
    // reason for the failure — measured live: a `grep` spec against a 94-char
    // `invalid_input` error reduced it to 0 lines / 0 chars, and the footer's
    // own "(100% saved)" wording read as a successful, empty filter rather than
    // a swallowed error. The caller retried three times believing the result
    // set was genuinely empty. Bypass entirely and pass the error through
    // UNTOUCHED — never partially reduced, never even the footer appended, so
    // an agent that greps the reply for the failing arg name still finds it.
    if (result.isError) {
      return {
        ...result,
        _meta: {
          ...result._meta,
          resultProjection: {
            applied: false,
            spec,
            linesIn: 0,
            linesOut: 0,
            charsIn: 0,
            charsOut: 0,
            notes: [
              'projection SKIPPED: this result is an ERROR envelope — reducing an error body ' +
                'risks deleting the reason for the failure, so it is always passed through ' +
                'unfiltered. Fix the call per the error text below, then re-add `projection` once ' +
                'it succeeds.',
            ],
          } satisfies ProjectionReport,
        },
      };
    }

    const items = result.content;
    if (!Array.isArray(items)) return result;

    // A genuine DELTA envelope reconstructs client-side from a patch payload in
    // content[0].text; appending a footer (or reshaping the body) breaks that
    // parse, so it is skipped — noted in _meta, which is not part of what the
    // client parses.
    //
    // But `_meta.delta` alone does NOT mean that. Every delta-CAPABLE tool
    // stamps the block on ordinary responses too, to advertise the capability
    // and carry the cursor: `mode:'full'` + `reason:'no_request'` is a normal
    // full body from a caller who never asked for delta, and
    // `reason:'proxy_reconstructed'` is a plain JSON row array the proxy
    // rebuilt. Both are ordinary content that projects perfectly well.
    //
    // Guarding on mere PRESENCE therefore silently disabled this whole stage
    // for every list tool in the catalog — caught only by running it live
    // against work_items:list, which returned the full 4.8KB payload and no
    // footer while every unit test passed. `mode` is the honest discriminator:
    // 'full' means the body is normal, anything else means it is a patch.
    const deltaMeta = (result._meta as { delta?: { mode?: unknown } } | undefined)?.delta;
    if (deltaMeta != null && deltaMeta.mode !== 'full') {
      return {
        ...result,
        _meta: {
          ...result._meta,
          resultProjection: {
            applied: false,
            spec,
            linesIn: 0,
            linesOut: 0,
            charsIn: 0,
            charsOut: 0,
            notes: [
              `projection SKIPPED: this is a delta-protocol result (mode=${String(deltaMeta.mode)}), whose ` +
                'body is a client-reconstructed patch — reshaping it would corrupt the reconstruction. ' +
                'Re-call without delta to project.',
            ],
          } satisfies ProjectionReport,
        },
      };
    }

    const textItems = items.filter(isTextItem);
    if (textItems.length === 0) return result;

    const original = textItems.map((it) => it.text).join('\n\n');
    // P-015: a note now carries whether it DEGRADES trust in the body it rides
    // on, because the footer's ordering depends on it (see `degraded` below).
    // `degrades` defaults TRUE: a note nobody classified is far more likely to
    // be a caveat than a courtesy, and the failure this fixes is a real caveat
    // read as a footnote — so the unclassified case must fail loud, not quiet.
    const noteRows: Array<{ text: string; degrades: boolean }> = [];
    const note = (text: string, degrades = true): void => {
      noteRows.push({ text, degrades });
    };
    let working = original;
    let regexFlavor: 'js-regexp' | undefined;

    // Classify ONCE, before either projection domain changes the body. The
    // same result is used by `pick` below and by the warning for pipe-only JSON
    // so the stage cannot teach one shape while operating on another.
    const bodyShape = classifyProjectionBody(textItems);
    const { json } = bodyShape;
    const upstream = (
      result._meta as
        | { payloadProjection?: { truncated?: boolean; tier?: string; omittedCount?: number } }
        | undefined
    )?.payloadProjection;

    // `pipe` deliberately has line semantics. That is correct for text, but a
    // compact JSON array is commonly ONE rendered line, so grep|count over it
    // returns a line count (often 1), not the number of matching items. Keep
    // the documented operator behavior and make the dimensional mismatch
    // impossible to mistake for an item-level finding. `pick` is the explicit
    // structured form and runs before `pipe` when the caller wants item counts.
    if ((spec.pipe?.length ?? 0) > 0 && !spec.pick && json) {
      const hasCount = spec.pipe?.some((stage) => stage.op === 'count') ?? false;
      note(
        `pipe applied directly to structured JSON: these operators inspect rendered ` +
          `JSON lines, not array/object items${hasCount ? '; `count` reports rendered line count, not matching item count' : ''}. ` +
          `This body is JSON on ${bodyShape.lineCount} line(s), so any count is a line count over the rendering. ` +
          `Use \`pick\` first (for example, \`pick: ["items[].field"]\`) for item-level filtering/counting.`,
      );
    }

    // Custom tier shapers and field-level bounds often have no shared
    // `_meta.payloadProjection` envelope. Inspect their marker-shaped body
    // contracts BEFORE `pick`/`pipe` can discard them. Do not duplicate the
    // stronger framework-level warning when that envelope is present.
    const bodyTruncationMarkers = upstream?.truncated
      ? []
      : detectBodyTruncationMarkers(
          opts.toolName,
          { value: json?.parsed, text: original },
          ...(result.structuredContent !== undefined ? [{ value: result.structuredContent }] : []),
        );
    if (bodyTruncationMarkers.length > 0) {
      const hasReadWindowMarker = bodyTruncationMarkers.some((marker) => marker.kind === 'read-window');
      const hasSourcePageMarker = bodyTruncationMarkers.some((marker) =>
        /(?:^|\.)(?:truncatedByLimit|rowsTruncated|itemsTruncated|pageTruncated)(?:\s|\(|\.|$)/.test(marker.path),
      );
      if (hasReadWindowMarker) {
        note(
          `capability:read returned a bounded line window before this projection ` +
            `(${describeBodyTruncationMarkers(bodyTruncationMarkers)}). The projection searched only the retained ` +
            `lines; omitted lines were never searched, so a zero or partial result is NOT evidence of absence. ` +
            `Re-read with capability:read using the next offset named by the marker (and an appropriate limit), ` +
            `or use capability:bash with rg for an exhaustive search before concluding a value is absent.`,
        );
      } else {
        const recovery = opts.toolName === 'coord:send'
          ? COORD_SEND_RECEIPT_RECOVERY
          : hasSourcePageMarker
          ? `payloadTier:'full' changes response shaping but does not widen the source query; check ` +
            `the tool's count/total/truncation fields and use its documented page-widening/pagination argument ` +
            `(or a narrower exact lookup)`
          : opts.toolName
            ? `re-call ${opts.toolName} with payloadTier:'full' (or narrower args)`
            : `re-call the tool with payloadTier:'full' (or narrower args)`;
        note(
          `the tool or its payload shaper marked field-level/custom-shaper truncation or partial-result metadata before this projection ` +
            `(${describeBodyTruncationMarkers(bodyTruncationMarkers)}). The projection can inspect only the ` +
            `retained subset/window — if the source is rank-ordered, this is the HEAD of a ranking, not a ` +
            `representative slice; any filter/count is a floor over that retained data and may be systematically ` +
            `skewed toward whatever the ordering favors. The pick may also have dropped the marker itself. omitted ` +
            `fields/items were never serialized, so any filter/count is not a complete population finding. ${recovery} ` +
            `before concluding a value is absent.`,
        );
      }
    }

    if (spec.pick) {
      // SHARED with the result-door footer (classifyProjectionBody) so the
      // operator we RECOMMEND cannot drift from the one that actually runs —
      // D-012. The per-item fallback inside it is load-bearing: a structured
      // result is routinely NOT one text item (the JSON payload is followed by
      // advisory prose, "See also: …"), so the joined text does not parse even
      // though the payload plainly does. Caught live on work_items:list, where
      // `pick` reported "not JSON" against a body visibly starting `[{"id":…`.
      // itemIndex >= 0 means it took that per-item fallback: say the advisory
      // items were dropped rather than dropping them quietly.
      if (json && json.itemIndex >= 0 && textItems.length > 1) {
        // Not trust-degrading: `pick` did exactly what was asked and says what
        // it set aside. The reader's selection is intact.
        note(
          `pick applied to the JSON payload item; ${textItems.length - 1} advisory text item(s) ` +
            `(e.g. "See also" routing hints) were dropped — re-call without \`pick\` to keep them.`,
          false,
        );
      }
      if (!json) {
        note(
          'pick SKIPPED: this result body is not JSON, so there are no fields to select — ' +
            'the text was passed to `pipe` unchanged. Use `pipe` line operators for text results.',
        );
      } else {
        // A write can fail semantically while still resolving with a normal
        // result body (`{ ok:false, error }`) or a bulk envelope whose top-level
        // `ok` is true but whose row/count fields report failure.  A caller that
        // picks only success fields must never be allowed to project away that
        // outcome.  Retain only fields that exist in this particular envelope so
        // ordinary write responses without the house outcome shape do not gain
        // spurious unmatched-path warnings.
        const implicitWritePaths =
          opts.effect === 'write'
            ? writeOutcomePickPaths(json.parsed).filter((path) => !spec.pick!.includes(path))
            : [];
        const pickPaths = [...spec.pick, ...implicitWritePaths];
        let pickRun = applyPick(json.parsed, pickPaths);
        let effectivePick = spec.pick;
        let requestedUnmatched = pickRun.unmatched.filter((path) => !implicitWritePaths.includes(path));
        // EI-20720054720826414 (array root) + WI-10002073 (keyed-envelope root):
        // the root a pick path must address is NOT uniform across tools and no
        // schema announces it, so a path correct for one tool silently matches
        // nothing on another. When exactly one re-rooted spelling PROVABLY
        // matches, apply it instead of failing open into the full promoted body
        // (which is larger than the un-projected default and then spills). Only
        // paths that missed are rewritten, and only when the rewrite is verified
        // to match, so a working path is never reinterpreted and a genuine miss
        // still misses.
        let ambiguityHint = '';
        if (requestedUnmatched.length > 0) {
          const { repairs, ambiguous } = proposePickRepairs(
            json.parsed,
            requestedUnmatched,
            effectivePick,
          );
          if (repairs.size > 0) {
            effectivePick = effectivePick.map((p) => repairs.get(p) ?? p);
            pickRun = applyPick(json.parsed, [...effectivePick, ...implicitWritePaths]);
            requestedUnmatched = pickRun.unmatched.filter((path) => !implicitWritePaths.includes(path));
            // Non-degrading: the caller's intended selection was recovered and
            // is exactly what the body below contains — but say so, so the
            // corrected spelling is learned rather than silently absorbed.
            note(
              `pick path(s) auto-adjusted for this ` +
                `${Array.isArray(json.parsed) ? 'array-root' : 'keyed-envelope'} body: ` +
                [...repairs].map(([from, to]) => `${from} → ${to}`).join(', ') +
                (Array.isArray(json.parsed)
                  ? ` — a bare key addresses an object root; use \`[].key\` on an array. `
                  : ` — the projection ROOT differs per tool, so a path correct for one tool can ` +
                    `address a key this body does not use. `) +
                `The adjusted selection is applied below.`,
              false,
            );
          }
          if (ambiguous.size > 0) {
            // Several spellings match, so auto-adjusting would be a guess — and a
            // wrong guess here is a SILENT wrong read, strictly worse than the
            // miss. Name them instead: the retry is still one call, not a probe.
            ambiguityHint =
              ` Candidate spelling(s) that WOULD match this body: ` +
              [...ambiguous].map(([from, tos]) => `${from} → ${tos.join(' | ')}`).join('; ') +
              ` — more than one matches, so none was applied; name the one you meant.`;
          }
        }
        const { picked, unmatched } = pickRun;
        const implicitRetained = implicitWritePaths.filter((path) => !unmatched.includes(path));
        if (requestedUnmatched.length === effectivePick.length) {
          if (working.length > PICK_MISS_FAIL_OPEN_MAX_CHARS) {
            // EI-23774219620725180: REFUSE with the key list instead of dumping a
            // body the caller asked to shrink. Still loud (degraded note, leads the
            // content) and still never `{}` — see the pick-miss REFUSAL block above.
            note(
              `pick matched NOTHING (${requestedUnmatched.join(', ')}) — the ${working.length}-char body was ` +
                `WITHHELD and replaced by its key list (a miss on a body this large would otherwise cost the ` +
                `whole body and still need re-reducing). The body is ${describeBodyShape(json.parsed)}.` +
                ambiguityHint,
            );
            working = JSON.stringify(
              buildPickMissRefusal(json.parsed, requestedUnmatched, working.length, picked),
              null,
              2,
            );
          } else {
            note(
              `pick matched NOTHING (${requestedUnmatched.join(', ')}) — body left unprojected rather than ` +
                `returning an empty object. The body is ${describeBodyShape(json.parsed)}.` +
                ambiguityHint,
            );
          }
        } else {
          if (requestedUnmatched.length > 0) {
            // The PARTIAL miss is the dangerous one and the case P-015 names:
            // the matched path shrinks the body dramatically, the footer reports
            // a large saving, and the field the caller actually came for is
            // silently absent. Loud, and — via `degraded` — ahead of the number.
            note(
              `pick path(s) matched nothing: ${requestedUnmatched.join(', ')} — those field(s) are ABSENT ` +
                `from the body below, which is otherwise a normal-looking result. ` +
                `The body is ${describeBodyShape(json.parsed)}.` +
                ambiguityHint,
            );
          }
          if (implicitRetained.length > 0) {
            // This is an intentional, non-degrading addition to the caller's
            // selection: it makes the write outcome observable without making
            // every write projection look like a warning.
            note(
              `write outcome retained implicitly: ${implicitRetained.join(', ')} — ` +
                'projection cannot hide whether the mutation succeeded.',
              false,
            );
          }
          working = JSON.stringify(picked, null, 2);
        }
      }
    }

    const { lines, trailingNewline } = splitLines(working);
    const linesIn = lines.length;
    let current = lines;
    for (const stage of spec.pipe ?? []) {
      if (stage.op === 'grep' && !stage.fixed) regexFlavor = 'js-regexp';
      current = runStage(current, stage);
    }
    const linesOut = current.length;
    const projectedText = current.join('\n') + (trailingNewline && current.length > 0 ? '\n' : '');

    // Decided BEFORE the footer is rendered: a note appended afterwards would
    // live only in _meta, and the in-band footer is the copy the agent actually
    // reads. (Getting this order wrong is how a "loud" fail-open goes quiet.)
    const dropStructured = result.structuredContent !== undefined;
    if (dropStructured) {
      // Not trust-degrading: dropping it is the point of asking for less, and
      // the text body the caller reads is complete on its own terms.
      note(
        'structuredContent dropped: it would have carried the UNPROJECTED payload alongside the ' +
          'reduced text. Re-call without `projection` if you need the structured form.',
        false,
      );
    }

    // EI-19361771982678588: this stage runs AFTER the tool's own payload-tier
    // bounding, so `original` may already be a PARTIAL corpus. The result-door
    // does carry an upstream-truncation warning — but only on the path where it
    // ALSO spills, because it returns early when the result already fits the
    // door budget (result-door.ts:160). A projection that shrinks the body under
    // that budget therefore SUPPRESSES the only notice saying the corpus was
    // incomplete, and this footer replaces it with a confident "N of M lines".
    //
    // The failure that motivated this: a `grep` over a 40-row facts:list that
    // had been tier-trimmed to 4 rows reported `0 of 3 lines` with no caveat,
    // which reads as "no such fact exists". Four matching rows existed. That is
    // the D-042 misattribution this file already guards against, reached from
    // the opposite direction — not "the tool returned everything", but "the
    // corpus I searched was everything". A filter is only honest about a MISS if
    // it is honest about what it was allowed to search.
    if (upstream?.truncated) {
      const omitted = upstream.omittedCount ?? 0;
      const scope =
        `payload tier=${String(upstream.tier ?? 'unknown')}` +
        (omitted > 0 ? `, ${omitted.toLocaleString()} field(s)/row(s) omitted upstream` : '');
      const reCall = opts.toolName === 'coord:send'
        ? COORD_SEND_RECEIPT_RECOVERY
        : opts.toolName
          ? `re-call ${opts.toolName} with payloadTier:'full' (or narrower args)`
          : `re-call the tool with payloadTier:'full' (or narrower args)`;
      note(
        linesOut === 0
          ? `ZERO lines survived this projection, and the corpus it searched was ALREADY TRUNCATED ` +
              `before this stage ran (${scope}) — that omitted content was never serialized, so it was ` +
              `never searched. This empty result is NOT evidence of absence: ${reCall} before ` +
              `concluding the value does not exist.`
          : `the corpus this projection filtered was ALREADY TRUNCATED before this stage ran ` +
              `(${scope}) — matches shown come from the RETAINED portion only, and absence from them ` +
              `is not evidence of absence. For an exhaustive answer, ${reCall}.`,
      );
    }

    const notes = noteRows.map((n) => n.text);

    const report: ProjectionReport = {
      applied: true,
      spec,
      linesIn,
      linesOut,
      charsIn: original.length,
      charsOut: projectedText.length,
      ...(regexFlavor ? { regexFlavor } : {}),
      notes,
    };

    // P-015. The footer used to LEAD with a congratulatory savings statistic and
    // relegate every caveat behind it, so the most important case — a `pick`
    // that matched nothing, a corpus already truncated upstream — was headlined
    // "(97% saved)". That reads as a filter that worked; the correction sat
    // below it and was read, if at all, as a footnote to a success. A warning
    // subordinate to a success metric is not a warning.
    //
    // Two changes, both about ORDER and FRAMING, not about the numbers:
    //   1. When any note degrades trust in the body, the caveat goes FIRST and
    //      the statistic follows it.
    //   2. In that state the number stops being an achievement: "N% saved"
    //      becomes "N% of the body removed". A projection that dropped the field
    //      you asked for did not save you anything.
    // An honest reduction — every path matched, nothing truncated upstream —
    // renders exactly as before, so the ordinary case pays nothing for this.
    // `linesOut === 0` earns its own headline: an empty body is the one result
    // that is READ as an answer ("there are none") rather than as a filter
    // artifact, and it is indistinguishable from a genuine empty set without it.
    const emptyLead =
      linesOut === 0 && linesIn > 0
        ? `⚠ THIS PROJECTION REMOVED EVERYTHING — the body below is empty because the filter ` +
          `matched nothing, NOT because the result was empty. Do not read it as an absence.`
        : null;

    // An empty body degrades trust on its own, with or without a note. A pure
    // `pipe` grep that matches nothing pushes NO note, so keying `degraded` off
    // the notes alone left the two halves contradicting each other in one
    // footer: "REMOVED EVERYTHING" above, "(100% saved)" below. Caught by this
    // fix's own test — which is the reason the empty case gets a control.
    const degraded = noteRows.some((n) => n.degrades) || emptyLead !== null;
    const removed = pct(projectedText.length, original.length);
    const stats =
      `[projection: ${describeProjection(spec)} → ${linesOut.toLocaleString()} of ` +
      `${linesIn.toLocaleString()} lines, ${projectedText.length.toLocaleString()} of ` +
      `${original.length.toLocaleString()} chars ` +
      (degraded ? `(${removed} of the body removed)` : `(${removed} saved)`) +
      (regexFlavor ? ' · grep pattern applied as a JavaScript RegExp, not GNU ERE' : '');

    const leadNotes = noteRows.filter((n) => n.degrades).map((n) => n.text);
    const tailNotes = noteRows.filter((n) => !n.degrades).map((n) => n.text);
    const footerCore =
      (emptyLead ? `${emptyLead}\n` : '') +
      (leadNotes.length ? `⚠ ${leadNotes.join('\n⚠ ')}\n` : '') +
      stats +
      (tailNotes.length ? `\n⚠ ${tailNotes.join('\n⚠ ')}` : '') +
      ']';

    const rebuilt: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    let placedText = false;
    for (const it of items) {
      if (isTextItem(it)) {
        if (placedText) continue; // every text item was folded into `original`
        rebuilt.push({ type: 'text', text: projectedText });
        placedText = true;
        continue;
      }
      rebuilt.push(it as Record<string, unknown>);
    }
    // EI-20720054720826414 (delivery half): the result-door's over-budget
    // truncation keeps the HEAD of the serialized text and drops the TAIL — and
    // the fail-open case (a pick that matched nothing, leaving the full promoted
    // body in place) is precisely the case most likely to overflow it. A caveat
    // living only in a tail footer is therefore deleted at the exact moment it
    // matters most (observed live: an all-miss warning tail-truncated away by
    // the spill, leaving a confident-looking raw body). So a DEGRADED verdict
    // renders as a HEADER, ahead of the body, where no head-keeping truncation
    // can silence it. An honest, un-degraded reduction keeps the tail footer
    // and pays nothing.
    if (degraded) rebuilt.unshift({ type: 'text', text: footerCore });
    else rebuilt.push({ type: 'text', text: `\n${footerCore}` });

    const out = {
      ...result,
      content: rebuilt,
      _meta: { ...(result._meta ?? {}), resultProjection: report },
    } as T;
    // A full structuredContent alongside a reduced text body defeats the whole
    // point — it is the larger half of the payload, and the caller asked for
    // less. Dropped here; the note was recorded above so it reaches the footer.
    if (dropStructured) delete (out as { structuredContent?: unknown }).structuredContent;
    return out;
  } catch {
    return result; // fail-soft: never let the projection break a good result
  }
}
