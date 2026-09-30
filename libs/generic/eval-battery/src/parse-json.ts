/**
 * Recover a JSON object from an LLM reply that may be bare, ```-fenced, or wrapped
 * in prose. Pure + dependency-free on purpose: the scoring/parsing modules must NOT
 * pull in the operator's credentials / workspace-registry module graph (which a real
 * `llm-client` drags in). Factored out of the gym (`gym/parse-json.ts`) into the
 * shared eval-battery engine (reconciliation D-001) unchanged.
 */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    /* fall through */
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      /* fall through to the balanced scan */
    }
  }
  return scanBalancedObject(trimmed);
}

/**
 * LAST-RESORT recovery: find the first BALANCED `{…}` span that parses to an object.
 *
 * Strictly additive — only reached once both passes above have failed, so it can never
 * change an already-recoverable reply's result (the whole-document-validity precedence
 * pinned in parse-json.test.ts is untouched).
 *
 * WHY IT EXISTS (WI-35902): the first-`{`-to-last-`}` slice above assumes the reply's
 * FIRST brace opens the payload. A judge that reasons before answering routinely breaks
 * that — `The harness wrote { ... } in code. Verdict: {"d1":8,…}` slices from the brace
 * in the PROSE to the payload's close and yields garbage, so a perfectly well-formed
 * score object is reported unrecoverable. Scanning each `{` in turn recovers it.
 *
 * Deliberately object-only: a bare `[…]`/primitive that failed the whole-document parse
 * is genuinely malformed, and accepting a partial array span would invent data. String
 * literals (and their escapes) are tracked so a brace INSIDE a rationale never miscounts
 * the depth.
 *
 * An UNBALANCED earlier brace does not stop the scan (`The trace showed { and the verdict
 * {"d1":8,…}` — the prose brace never closes, the payload does), so each candidate is
 * tested independently. `MAX_SCAN_CANDIDATES` bounds the quadratic worst case on
 * pathological input (`{{{{{…`); a real judge reply has a handful of braces, not dozens.
 */
const MAX_SCAN_CANDIDATES = 64;

function scanBalancedObject(text: string): unknown {
  let tried = 0;
  for (let i = text.indexOf('{'); i >= 0 && tried < MAX_SCAN_CANDIDATES; i = text.indexOf('{', i + 1), tried++) {
    const end = matchingBrace(text, i);
    if (end < 0) continue; // this brace never closes — a LATER one still might
    try {
      const parsed: unknown = JSON.parse(text.slice(i, end + 1));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* not this span — keep scanning */
    }
  }
  return null;
}

/** Index of the `}` closing the `{` at `open`, or -1 if the span never closes. */
function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}
