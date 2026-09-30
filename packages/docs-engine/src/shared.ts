/**
 * Pure utilities for the docs:* tool family.
 *
 * Kept free of fumadocs imports so the unit tests don't need to spin
 * up the loader. The tools (outline.ts, get.ts) compose these against
 * `source` from @/lib/source.
 */

export const MAX_PAYLOAD_BYTES = 50_000;

/** TOC entry shape we care about — narrower than fumadocs' full type. */
export interface TocEntry {
  url: string; // '#anchor-id'
  title: unknown; // string OR React element
  depth: number;
}

/**
 * Recursively extract plain text from a value that may be a string,
 * number, array, or React-element-shaped object (`{ props: { children } }`).
 *
 * Required because fumadocs' TOC sometimes yields React elements when
 * a heading contains inline code or other inline JSX — and `String(node)`
 * on those returns "[object Object]".
 */
export function reactToText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactToText).join('');
  if (node && typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    const props = (node as { props?: { children?: unknown } }).props;
    return reactToText(props?.children);
  }
  return '';
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize an authored heading, a rendered anchor, or a caller-supplied
 * heading ref into the common Starlight / doc-sections anchor vocabulary.
 *
 * Some older adapters preserve case and replace EACH punctuation character
 * with `-`, while Starlight and the semantic index lowercase and collapse a
 * punctuation run. `docs:get` has to accept both generations until every
 * stored TOC has been refreshed.
 */
export function normalizeHeadingAnchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Title-case a kebab-case slug. Fallback when meta.json has no title. */
export function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Bounded Levenshtein distance. Short-circuits on length > 100 to keep
 * O(n*m) bounded — doc slugs are short, so this is purely defensive.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 100 || b.length > 100) return Infinity;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

export interface NearestOpts {
  /** distance / max(target.length, candidate.length) must be ≤ this. Default 0.3. */
  maxRatio?: number;
  /** Max returned. Default 3. */
  k?: number;
}

export function levenshteinNearest(
  target: string,
  candidates: string[],
  opts: NearestOpts = {},
): string[] {
  const maxRatio = opts.maxRatio ?? 0.3;
  const k = opts.k ?? 3;
  return candidates
    .map((s) => ({ s, d: levenshtein(s, target) }))
    .filter(({ s, d }) => d !== Infinity && d / Math.max(s.length, target.length || 1) <= maxRatio)
    .sort((a, b) => a.d - b.d)
    .slice(0, k)
    .map(({ s }) => s);
}

/**
 * Slice markdown body to the section starting at `headingRef` and ending
 * at the next heading of equal-or-shallower depth (or EOF).
 *
 * Canonical anchor ids win. When no id matches, accept the visible heading
 * text (trimmed + case-insensitive) because docs:outline exposes both forms
 * and human callers naturally pass the label they just read.
 *
 * Returns null when the TOC entry is missing or the heading line can't
 * be located in the rendered markdown.
 */
export function sliceByHeading(md: string, headingRef: string, toc: TocEntry[]): string | null {
  const exactRef = headingRef.trim();
  const targetById = toc.find((h) => (h.url ?? '').replace(/^#/, '') === exactRef);
  const exactTextRef = exactRef.toLowerCase();
  const normalizedRef = normalizeHeadingAnchor(exactRef);
  const normalizedMatches = toc.filter((h) => {
    const id = (h.url ?? '').replace(/^#/, '');
    const text = reactToText(h.title);
    return normalizeHeadingAnchor(id) === normalizedRef || normalizeHeadingAnchor(text) === normalizedRef;
  });
  const target =
    targetById ??
    toc.find((h) => {
      const text = reactToText(h.title).trim().toLowerCase();
      return text.length > 0 && text === exactTextRef;
    }) ??
    (normalizedMatches.length === 1 ? normalizedMatches[0] : undefined);
  if (!target) return null;

  const text = reactToText(target.title);
  if (!text) return null;

  const headerRe = new RegExp(`^#{${target.depth}}\\s+${escapeRegex(text)}\\s*$`, 'm');
  const startMatch = md.match(headerRe);
  if (!startMatch || startMatch.index === undefined) return null;

  const start = startMatch.index;
  const afterStart = md.slice(start + startMatch[0].length);
  const nextRe = new RegExp(`^#{1,${target.depth}}\\s+`, 'm');
  const nextMatch = afterStart.match(nextRe);
  const end =
    nextMatch?.index !== undefined ? start + startMatch[0].length + nextMatch.index : md.length;

  return md.slice(start, end).trim();
}

/**
 * The stable literal every truncation tail opens with.
 *
 * ONE definition, TWO consumers: {@link truncationTail} EMITS it and
 * {@link hasTruncationTail} DETECTS it. That is deliberate — the write-side
 * guard in `docs:author` refuses a body carrying this marker, and if the
 * detector held its own copy of the wording, rewording the tail would silently
 * disarm the guard while every test still passed. `shared.test.ts` asserts the
 * round trip, so the pair cannot drift apart.
 */
export const TRUNCATION_TAIL_MARKER = `…[truncated at ${MAX_PAYLOAD_BYTES} bytes;`;

/** How far back from the end of a body {@link hasTruncationTail} looks for the marker. */
export const TRUNCATION_TAIL_WINDOW = 400;

/**
 * The half of the tail that says what NOT to do with a clipped read, and how to
 * get the rest. Both halves matter: the warning alone leaves a caller who needs
 * the whole page with nowhere to go, which is what sent them to raw SQL.
 */
function truncationTailAdvice(nextOffset?: number): string {
  const resume =
    nextOffset === undefined ? '' : ` To read the REST, re-fetch the same slug with offset=${nextOffset}.`;
  return `${resume} ⛔ This body is INCOMPLETE — do NOT pass it to docs:author { overwrite:true }: that would delete everything past the cut.`;
}

export function truncationTail(args: { firstH2Id?: string; h2Count: number; nextOffset?: number }): string {
  const advice = truncationTailAdvice(args.nextOffset);
  if (args.firstH2Id) {
    return `\n\n${TRUNCATION_TAIL_MARKER} this page has ${args.h2Count} H2 headings — re-fetch with heading="${args.firstH2Id}" (or another id from docs:outline) for a slice.${advice}]\n`;
  }
  return `\n\n${TRUNCATION_TAIL_MARKER} page has no H2 headings to slice on.${advice}]\n`;
}

/**
 * Does this body END with `docs:get`'s truncation tail — i.e. is it a CLIPPED
 * READ rather than a whole document?
 *
 * Scoped to the last {@link TRUNCATION_TAIL_WINDOW} characters on purpose: a doc
 * that merely QUOTES the marker in its prose (this failure mode is worth writing
 * about) carries it mid-body, while a pasted clipped read carries it at the very
 * end. Callers pair this with a length floor — a real clipped read is always at
 * least {@link MAX_PAYLOAD_BYTES} long — so the two conditions together leave no
 * plausible false positive.
 */
export function hasTruncationTail(body: string): boolean {
  return body.slice(-TRUNCATION_TAIL_WINDOW).includes(TRUNCATION_TAIL_MARKER);
}

/**
 * The MCP RESULT DOOR's own clip marker — a SECOND clipping layer, above this one.
 *
 * Measured 2026-08-31 (WI-1511581): `docs:get { source: true }` returned the whole
 * 6,119-char row from the tool, and the result door then trimmed the response to
 * ~2.4KB, replacing the tail of `$.results[0].content` with
 * `…[TRUNCATED +5319 chars — see _projection.cursor]`. The envelope reports the
 * clip honestly (`_projection.truncated`, `omitted[]`, a recovery cursor) — but the
 * BODY the agent then pastes into `docs:author` carries a marker
 * {@link hasTruncationTail} never knew about, so the HARD `truncated_body` refusal
 * did not fire and the clipped write fell through to the weaker, overridable
 * shrink heuristic.
 *
 * Two markers, one failure: a guard that knows only its OWN layer's clip is blind
 * to every other layer that can clip the same bytes.
 */
export const RESULT_DOOR_TRUNCATION_RE = /…\[TRUNCATED \+[\d,]+ chars? — see _projection\.cursor\]\s*$/;

/**
 * Does this body end with the result door's clip marker?
 *
 * Anchored to the very END (trailing whitespace only) rather than scanned within a
 * window, and DELIBERATELY carries no length floor: the door clips at a few KB, far
 * under {@link MAX_PAYLOAD_BYTES}, so the floor that makes {@link hasTruncationTail}
 * safe would make this one never fire. The end-anchor is what keeps it off a doc
 * that merely writes ABOUT this failure mode — including this package's own tests.
 */
export function hasResultDoorTruncation(body: string): boolean {
  return RESULT_DOOR_TRUNCATION_RE.test(body);
}
