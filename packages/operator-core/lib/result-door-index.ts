/**
 * result-door-index.ts — give a spilled LIST-shaped result a one-line-per-entry index.
 *
 * ## Why (plan `agent-epistemics-2026-08-02` P-003)
 *
 * The result door already handles SIZE correctly: an over-budget result is spilled
 * whole to scratch and the caller gets a pointer. But the reader who follows that
 * pointer lands in a wall of rich JSON, and the question they almost always have is
 * not "what is in entry 7", it is **"which of these do I care about"**. Answering
 * that by scanning the payload is what drove an agent on 2026-08-02 to
 * `grep -o '"summary":"[^"]\{0,300\}'` over a spill file — shell-scraping a JSON
 * tool result, precisely the anti-pattern the bash-vs-tool routing table exists to
 * kill. The index is the cheap fix: it goes in the FILE, not the returned result,
 * so it costs the agent zero context and is there the moment they page.
 *
 * ## Design constraints, in priority order
 *
 * 1. **Never break a spill.** `applyResultDoor` is fail-soft by contract — an
 *    index is a convenience, so every path here returns `null` rather than throws.
 *    A spill without an index is mildly annoying; a spill that failed to write
 *    because its index blew up loses the payload.
 * 2. **Identify, don't summarise.** One line per entry, identity fields only. If
 *    the index grows big enough to need its own index, it has failed.
 * 3. **Silent when unhelpful.** No list, a trivially short list, or entries with
 *    no recognisable identity ⇒ no index. An index of `[0] · [1] · [2]` is worse
 *    than none: it costs a screen and answers nothing.
 */

/** Keys that identify an entry, most-identifying first. */
const IDENTITY_KEYS = [
  'id',
  'msg_id',
  'msgId',
  'key',
  'slug',
  'ref',
  'name',
  'title',
  'file',
  'path',
  'tool',
  'tool_name',
  'event',
] as const;

/** Keys that say what STATE an entry is in — the usual second question after "which one". */
const STATUS_KEYS = [
  'state',
  'status',
  'kind',
  'severity',
  'verdict',
  'ok',
  'assignee',
  'sessionState',
  'active',
] as const;

const MAX_INDEXED_ENTRIES = 200;
const MAX_LINE_CHARS = 160;
const MAX_VALUE_CHARS = 60;
/** Below this, a list is small enough to just read — an index would be pure noise. */
const MIN_ENTRIES_TO_INDEX = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Render a scalar compactly; returns null for values not worth indexing. */
function scalar(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    return t.length > MAX_VALUE_CHARS ? `${t.slice(0, MAX_VALUE_CHARS - 1)}…` : t;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

/**
 * Find the array most likely to BE the result's list.
 *
 * Depth-first, preferring the LONGEST array of objects — a result commonly nests
 * its payload (`{ results: [...] }`, `{ ok, counts, items: [...] }`), and the
 * interesting list is the big one, not a two-element `content` wrapper.
 */
export function findDominantList(root: unknown, depth = 0): Record<string, unknown>[] | null {
  if (depth > 6) return null;
  let best: Record<string, unknown>[] | null = null;
  const consider = (candidate: Record<string, unknown>[] | null): void => {
    if (candidate && (!best || candidate.length > best.length)) best = candidate;
  };

  if (Array.isArray(root)) {
    const objects = root.filter(isPlainObject);
    // Mostly-objects, not a stray object in a list of strings.
    if (objects.length >= MIN_ENTRIES_TO_INDEX && objects.length >= root.length / 2) consider(objects);
    for (const el of root) consider(findDominantList(el, depth + 1));
    return best;
  }
  if (isPlainObject(root)) {
    for (const v of Object.values(root)) consider(findDominantList(v, depth + 1));
    return best;
  }
  return null;
}

/** Build one index line for an entry, or null when it carries no usable identity. */
export function indexLine(entry: Record<string, unknown>, i: number): string | null {
  const parts: string[] = [];
  for (const k of IDENTITY_KEYS) {
    const s = k in entry ? scalar(entry[k]) : null;
    if (s !== null) {
      parts.push(`${k}=${s}`);
      break; // ONE identity field — the index identifies, it does not summarise.
    }
  }
  if (parts.length === 0) return null; // no identity ⇒ an index line that answers nothing
  for (const k of STATUS_KEYS) {
    const s = k in entry ? scalar(entry[k]) : null;
    if (s !== null) {
      parts.push(`${k}=${s}`);
      break;
    }
  }
  const line = `  [${i}] ${parts.join(' · ')}`;
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

/**
 * Build a compact index for a spilled result, or `null` when one would not help.
 *
 * `text` is the serialized result body. JSON only by design: TOON-formatted results
 * are already line-per-row compact, so indexing them would duplicate what the
 * reader can already see.
 */
export function buildSpillIndex(text: string): string | null {
  try {
    const trimmed = text.trim();
    // Cheap structural pre-check — avoids handing megabytes of prose to JSON.parse
    // just to have it throw.
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null; // not JSON (TOON, prose, a truncated body) — no index, no error
    }
    const list = findDominantList(parsed);
    if (!list || list.length < MIN_ENTRIES_TO_INDEX) return null;

    const shown = list.slice(0, MAX_INDEXED_ENTRIES);
    const lines: string[] = [];
    for (let i = 0; i < shown.length; i++) {
      const line = indexLine(shown[i] as Record<string, unknown>, i);
      if (line) lines.push(line);
    }
    // If most entries had no identity, the index is noise — say nothing.
    if (lines.length < MIN_ENTRIES_TO_INDEX || lines.length < shown.length / 2) return null;

    const omitted = list.length - shown.length;
    const tail = omitted > 0 ? `\n  … +${omitted} more (indexed the first ${MAX_INDEXED_ENTRIES})` : '';
    return (
      `# INDEX — ${list.length} entr${list.length === 1 ? 'y' : 'ies'}, one line each. ` +
      `Scan this to find the one you want, then search the payload below for its id.\n` +
      `${lines.join('\n')}${tail}\n`
    );
  } catch {
    return null; // fail-soft by contract: an index must never be able to break a spill
  }
}
