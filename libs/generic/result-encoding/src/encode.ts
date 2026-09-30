/**
 * Format-dispatching encode/decode + the runtime auto-encoder.
 *
 * `encode(value, format)` renders a JSON value in one of the supported formats;
 * `decode(text, format)` is its inverse where defined. The lossless contract:
 * `decode(encode(v, 'toon'), 'toon')` deep-equals `v` for any JSON value (the
 * round-trip property test enforces this). `json` is trivially lossless. `csv`/
 * `tsv` are LOSSY (every cell stringifies) so their round-trip recovers string-
 * coerced rows; `md` is display-only and not decodable.
 */

import { encode as toonEncode, decode as toonDecode } from '@toon-format/toon';
import { decodeDelimited, encodeDelimited, encodeMarkdownTable } from './csv';
import { ResultEncodeError, type ResultFormat } from './formats';

/** Compact JSON (no whitespace) — the lossless universal serialization. */
function encodeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** Render a JSON value in the given format. Throws `ResultEncodeError` for shapes a format can't hold. */
export function encode(value: unknown, format: ResultFormat): string {
  switch (format) {
    case 'json':
      return encodeJson(value);
    case 'toon':
      return toonEncode(value);
    case 'csv':
      return encodeDelimited(value, ',');
    case 'tsv':
      return encodeDelimited(value, '\t');
    case 'md':
      return encodeMarkdownTable(value);
    default: {
      const never: never = format;
      throw new ResultEncodeError(`unknown format: ${String(never)}`);
    }
  }
}

/** Inverse of `encode` where defined. `md` throws (display-only). csv/tsv recover string rows. */
export function decode(text: string, format: ResultFormat): unknown {
  switch (format) {
    case 'json':
      return JSON.parse(text);
    case 'toon':
      return toonDecode(text);
    case 'csv':
      return decodeDelimited(text, ',');
    case 'tsv':
      return decodeDelimited(text, '\t');
    case 'md':
      throw new ResultEncodeError('markdown-table is a display-only format and cannot be decoded');
    default: {
      const never: never = format;
      throw new ResultEncodeError(`unknown format: ${String(never)}`);
    }
  }
}

/**
 * Above this many bytes of TOON output we SKIP the lossless round-trip
 * verification (the `toonDecode` + double `JSON.stringify`). On the operator's
 * single event loop that verification is synchronous and O(size)×3, so on a big
 * list result it blocks the loop long enough to drop MCP/SSE connections under
 * load (operator-scalability-event-loop P1-1 / app-wide-load-traps F-A1). The
 * round-trip is a cheap insurance check against a rare encoder edge case; below
 * the gate we keep paying it, above it we don't — a large payload takes the
 * safe lossless-JSON path instead of risking a corrupt-but-unverified compact
 * body. 16 KiB comfortably covers the small list results where TOON's token win
 * matters; multi-hundred-row dumps fall back to JSON (and shouldn't be TOON-
 * encoded on the hot path anyway).
 */
export const TOON_VERIFY_MAX_BYTES = 16 * 1024;

/**
 * Encode to TOON only when it round-trips losslessly. `@toon-format/toon` is a
 * JSON-lossless superset in the common case, but has rare edge cases (e.g. an
 * empty-string key wrapping a nested object — `[{"": {":": 0}}]`) where
 * `decode(encode(v)) !== v` or the decoder throws. The lossless-to-JSON
 * guarantee is the encoder's contract, not the dependency's, so below
 * `TOON_VERIFY_MAX_BYTES` we VERIFY the round-trip and report whether it held —
 * callers fall back to JSON when it didn't, rather than hand the model a corrupt
 * compact payload.
 *
 * Above the gate the verification is skipped (it's the synchronous hot-path
 * cost P1-1/F-A1 targets): `lossless` is reported `false` so callers route the
 * large payload to plain JSON, never to an UNVERIFIED TOON body. The encoder is
 * lossless in the overwhelming common case, so the only cost of the skip is
 * forgoing TOON's token win on payloads where it barely helps.
 */
export function encodeToonChecked(value: unknown): { text: string; lossless: boolean } {
  let text: string;
  try {
    text = toonEncode(value);
  } catch {
    return { text: '', lossless: false };
  }
  // Size-gate: above the threshold, skip the O(size)×3 round-trip verify and
  // report not-lossless so the caller falls back to JSON (never serves an
  // unverified compact body).
  if (text.length > TOON_VERIFY_MAX_BYTES) {
    return { text, lossless: false };
  }
  try {
    const back = toonDecode(text);
    return { text, lossless: JSON.stringify(back) === JSON.stringify(value) };
  } catch {
    return { text, lossless: false };
  }
}

/**
 * True when `value` is a non-null plain object (NOT an array) with at least one
 * own enumerable ARRAY-valued field — the shape where TOON's nested-list encoding
 * beats JSON: a bulk envelope `{ ok, results:[…], counts }`, a list wrapper
 * `{ items:[…], nextCursor }`, etc. Used by the compact-path auto-format picker so
 * object-rooted-but-array-bearing results get TOON, not just bare arrays
 * (definetool-token-optimization-adoption P-001 / D-008 — the bulk envelope
 * TOON-encodes ~38% smaller, lossless).
 */
export function isObjectWithArrayField(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (Array.isArray(v)) return true;
  }
  return false;
}

/** True when `value` is a non-empty array of plain objects whose every leaf is a scalar (runtime CSV-safe). */
export function isFlatObjectArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const row of value) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
    for (const v of Object.values(row as Record<string, unknown>)) {
      if (v !== null && typeof v === 'object') return false;
    }
  }
  return true;
}

/**
 * Runtime auto-encoder for the no-output-schema path (D-002): sniff the value
 * and pick a lossless compact format. Arrays → TOON (tabular when uniform,
 * nested otherwise); single objects / scalars → JSON (TOON's win there is
 * marginal and JSON is the natural default, matching the schema'd non-array
 * rule). Lossless either way, so safe to apply to every unschematized tool.
 */
export function encodeAuto(value: unknown): { format: ResultFormat; text: string } {
  if (Array.isArray(value)) {
    const toon = encodeToonChecked(value);
    if (toon.lossless) return { format: 'toon', text: toon.text };
    // TOON couldn't faithfully represent this array — fall back to lossless JSON.
  }
  return { format: 'json', text: encodeJson(value) };
}
