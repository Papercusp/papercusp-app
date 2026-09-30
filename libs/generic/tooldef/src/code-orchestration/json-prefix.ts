/**
 * Parse a JSON value that a producer appended human-facing prose to.
 *
 * WI-6458: an MCP server we PROXY (rather than author) may end its text content with a
 * chat affordance — gitnexus appends `\n\n---\n**Next:** READ gitnexus://repo/{name}/context …`
 * after a perfectly good JSON array. The call succeeded and the data is right there, but
 * `JSON.parse` throws on the trailer, so the code-mode facade used to hand the script the
 * whole raw STRING. The script's first natural line of consumption then fails with
 * `Unexpected non-whitespace character after JSON at position 1040` — which reads as "the
 * tool is broken" and sends the agent back to grep, the exact behaviour the tool exists to
 * replace.
 *
 * Scanning for the balanced close of the FIRST value is what makes this safe. The obvious
 * workaround (`s.slice(0, s.lastIndexOf(']') + 1)`) is wrong on the real payload: gitnexus's
 * own footer contains a `{name}` placeholder, so the last bracket in the string sits AFTER
 * the JSON and the sliced parse throws too (measured 2026-07-27).
 */

/** The characters that can begin a JSON value — used to spot a trailer that is itself JSON. */
const JSON_OPENERS = '{[';

/**
 * Index of the character that closes the balanced object/array starting at `from`,
 * or -1 if it never closes. String-aware (a `}` inside a quoted string doesn't count)
 * and escape-aware.
 */
function scanBalanced(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * True when `text` begins with something that is itself a JSON value — the guard against
 * silently swallowing a concatenated / NDJSON stream (`{"a":1}\n{"b":2}`), where returning
 * only the first value would DROP data rather than drop an affordance.
 */
function startsWithJsonValue(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) return false;
  if (JSON_OPENERS.includes(trimmed[0]!)) return scanBalanced(trimmed, 0) >= 0;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export interface JsonWithTrailer {
  /** The parsed leading JSON value. */
  value: unknown;
  /** The trailing text that followed it, trimmed (never empty). */
  trailer: string;
}

/**
 * Parse a complete JSON object/array at the START of `text` when it is followed by
 * non-JSON trailing text; `null` when that is not the shape (so callers keep whatever
 * behaviour they had).
 *
 * Deliberately narrow — it returns null for all of:
 *   - text that is entirely valid JSON (a plain `JSON.parse` already handles that);
 *   - a leading bare scalar (`123 apples` must not read as `123`);
 *   - a trailer that is itself a JSON value (NDJSON / concatenated stream).
 */
export function parseJsonWithTrailer(text: string): JsonWithTrailer | null {
  const start = text.search(/\S/);
  if (start < 0) return null;
  if (!JSON_OPENERS.includes(text[start]!)) return null;

  const end = scanBalanced(text, start);
  if (end < 0) return null;

  const trailer = text.slice(end + 1).trim();
  if (trailer.length === 0) return null;
  if (startsWithJsonValue(trailer)) return null;

  try {
    return { value: JSON.parse(text.slice(start, end + 1)), trailer };
  } catch {
    return null;
  }
}
