/**
 * Shared operative/supersession-clause extraction.
 *
 * Multiple carry surfaces excerpt long verbatim text (a fact body, a held
 * work-item checkpoint) down to a head-only slice to fit a response budget. A
 * head-only slice optimizes for "identify what this is" but discards
 * whatever falls AFTER the cut — and on append-style text, the NEWEST and
 * most-binding content is written last, i.e. exactly what a head-only slice
 * throws away first.
 *
 * Two independent incidents hit the same defect at two different call sites:
 *
 * - facts:list (P-002, knowledge-at-symptom-time-2026-08-09): a fact's
 *   IMPERATIVE was severed mid-word — "ALWAYS cross-read accounts:status"
 *   rendered as "ALWAYS cross-read acco…". The excerpt kept the fact's
 *   evidence (re-derivable) and discarded its instruction (the only part
 *   that changes behaviour).
 * - the carry-brief held-item checkpoint render (EI-19952485326105760): a
 *   checkpoint held an older plan followed by a LATER, SUPERSEDING owner
 *   directive that revoked it. The truncation cut landed between the two, so
 *   the successor's context inherited the superseded plan with no trace of
 *   what revoked it — the same head-only-slice defect, applied to a
 *   directive instead of an instruction.
 *
 * `extractOperativeClauses` is the one fix for both: pull any clause
 * matching an operative/supersession MARKER out of the FULL body (not just
 * the head) and let the caller append it verbatim, bounded by its own small
 * budget so this can never blow out the response the excerpt exists to
 * shrink.
 */

/** Total char budget across all preserved clauses, when the caller doesn't override it. */
export const OPERATIVE_CLAUSE_CHARS_DEFAULT = 220;
/** Max number of clauses preserved, when the caller doesn't override it. */
export const OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT = 2;
/** Independent budget for concrete identifiers rescued from past an excerpt cut. */
export const KNOWLEDGE_IDENTIFIER_CHARS_DEFAULT = 220;
/** Max number of concrete identifiers rescued from one excerpt. */
export const KNOWLEDGE_IDENTIFIER_MAX_DEFAULT = 8;

/**
 * Shapes this corpus uses when a line is telling the reader to do (or stop
 * doing) something, or is REVOKING a prior instruction. Case-sensitive on
 * the shouted words on purpose — authors upper-case these deliberately, and
 * matching case-insensitively would drag in ordinary prose ("we must have
 * missed it") and spend the whole budget on narration. `⛔` / `SUPERSEDING` /
 * `SUPERSEDED` / `NO MORE` and an inline `[owner:...]` tag are the
 * supersession shapes `carry-surface-provenance-lint.ts` already recognizes
 * (its `OWNER_TAG_RE`) — a clause carrying one of these is, by construction,
 * the thing most likely to revoke an earlier plan sitting earlier in the
 * same body. `RETIRED` is included as an explicit status marker because
 * append-style checkpoints commonly pair it with a lowercase "do not" and a
 * later `SUPERSEDES` clause; the uppercase status is what distinguishes that
 * cancellation from ordinary prose about a retired component.
 *
 * ⚠ The owner-tag alternative here is `[owner[:\s][^\]]*\]` — space or colon,
 * matched independently of `carry-surface-provenance-lint.ts`'s own detector.
 * Measured 2026-08-09 over the population that actually feeds this function —
 * `harness_shared.work_items.payload`, where checkpoints live — 43 of 50
 * tag-bearing rows use `[owner:` but 6 use a SPACE (`[owner 2026-08-09]`).
 * Colon-only would drop ~12% of real owner tags past a cut, which is
 * precisely the class EI-19952485326105760 is about: the heading matches on
 * `⛔` and survives, while the line carrying the owner's actual WORDS does
 * not, so the reader is told a directive exists and never told what it says.
 * Widening only ever preserves MORE, so it cannot cause the inverse failure.
 * (`OWNER_TAG_RE`'s own colon-only gap — same root cause, the lint-detection
 * side of it rather than this preservation side — is fixed as of
 * EI-19988211953593959: it, and every sibling detector in that module, now
 * accepts colon/space/`=`/`-` separators via a shared `OWNER_TAG_SEP`
 * fragment, so this module's independent widening and that module's
 * detection no longer disagree on which shapes count as an owner tag.)
 * Note a source-tree grep suggests the opposite ratio (89 space / 81 colon) —
 * that corpus is comments and prompts, NOT checkpoints. Measure the population
 * the code actually reads.
 */
/**
 * ⚠ The case-sensitivity is LOAD-BEARING — do NOT "simplify" this to /i.
 *
 * Uppercase is the author's own emphasis marker, and it is what separates a
 * directive from ordinary prose ("I do not think…", "this must be why…"). But
 * the all-caps-only form under-matched badly: agents overwhelmingly write the
 * emphatic negation as `do NOT` — lowercase auxiliary, uppercase NOT — which
 * the original `DO NOT` alternative missed entirely.
 *
 * Measured on a live 24-fact orient fold: the all-caps form matched 7 clauses,
 * the modal+NOT form below catches 7 MORE (doubling recall), and every one of
 * those 7 is a genuine directive — "do NOT check the Tauri desktop binary's
 * pid. That is the SHELL, not the server", "do NOT assert load causation
 * without a mechanism". A naive case-insensitive pass over the same corpus
 * matched 35, i.e. 5x, which would spend the (deliberately small) clause budget
 * on ordinary prose and crowd out the real directives. Hence: the auxiliary may
 * be any case, the NOT may not.
 */
export const OPERATIVE_MARKERS =
  /\b(ALWAYS|NEVER|MUST|DO NOT|DON'T|REQUIRED|RULE:|NO MORE|RETIRED)\b|\b(?:[Dd]o|[Dd]oes|[Mm]ust|[Ss]hould)\s+NOT\b|⛔|SUPERSED(?:ING|ED|ES?)|\[owner[:\s][^\]]*\]/;

export interface ExtractOperativeClausesOptions {
  /** Total char budget across all preserved clauses. */
  maxChars?: number;
  /** Max number of clauses to preserve. */
  maxClauses?: number;
}

export interface ExtractKnowledgeIdentifiersOptions {
  /** Total char budget across complete identifiers (identifiers are never cut mid-token). */
  maxChars?: number;
  /** Max number of identifiers to preserve. */
  maxIdentifiers?: number;
}

export interface CapPreservingOperativeOptions
  extends ExtractOperativeClausesOptions,
    ExtractKnowledgeIdentifiersOptions {
  /**
   * The concrete call that returns the UNTRUNCATED text (e.g.
   * `work_items:get { id: 'WI-1234' }`). Carried into the structured
   * `truncation` marker, and — when `inlineNotice` is set — rendered into the
   * excerpt itself. Omit only when the caller genuinely has no fetch path.
   */
  more?: string;
  /**
   * Render the withheld-chars notice INTO the returned string. For prose/markdown
   * surfaces (the cold carry brief), where there is no sibling field to put a
   * structured marker in. Structured (JSON) callers should leave this off and
   * emit the returned `truncation` object instead, so the disclosure is machine
   * -readable and the excerpt stays byte-identical to the pre-disclosure shape.
   */
  inlineNotice?: boolean;
}

/**
 * What an excerpt withheld, and how to get it back. Mirrors the disclosure
 * convention every sibling fold in `coord:orient` already follows
 * (`factsTruncated` / `claimableTruncated` / `recentTruncated` /
 * `bodiesTruncated`: a total, a shown-count, and a `more` fetch verb).
 */
export interface CapPreservingOperativeTruncation {
  /** Chars of the ORIGINAL body carried in the excerpt's head slice. */
  keptChars: number;
  /** Length of the original body. */
  totalChars: number;
  /** Chars of the original body NOT delivered (`totalChars - keptChars`). */
  withheldChars: number;
  /** Operative/supersession clauses rescued from PAST the cut and appended. */
  operativeClausesKept: number;
  /** Concrete answer-bearing identifiers rescued from PAST the cut and appended. */
  identifiersKept: number;
  /** The concrete call that returns the untruncated text, when the caller supplied one. */
  more?: string;
}

export interface CapPreservingOperativeResult {
  text: string;
  /** Present ONLY when the body was actually truncated — absent ⇒ `text` is complete. */
  truncation?: CapPreservingOperativeTruncation;
}

/**
 * Pull the operative/supersession clauses out of `body` that are not already
 * visible in `head`. Returns clauses that begin AT the marker (not the whole
 * sentence — the lead-in is usually evidence the head already carries) and
 * run to the end of their sentence/line, skipping any already visible in
 * `head` (no point spending budget repeating what the reader can see),
 * bounded by both a clause count and a total char budget so a pathological
 * body cannot blow the response. Pure and directly testable — no I/O.
 */
export function extractOperativeClauses(
  body: string,
  head: string,
  opts: ExtractOperativeClausesOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? OPERATIVE_CLAUSE_CHARS_DEFAULT;
  const maxClauses = opts.maxClauses ?? OPERATIVE_CLAUSE_MAX_CLAUSES_DEFAULT;
  if (maxChars <= 0 || maxClauses <= 0) return [];

  // Append-style checkpoints put the newest, most-binding section at the end.
  // Collect first and select from the tail so an early directive cannot consume
  // the whole clause-count budget before a later RETIRED/SUPERSEDES cancellation
  // is considered. The selected clauses are restored to source order below so
  // the excerpt remains readable and verbatim.
  const candidates: string[] = [];
  for (const rawSentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    const m = OPERATIVE_MARKERS.exec(sentence);
    if (!m) continue;
    // Start AT the marker, not at the sentence start — the lead-in is
    // usually the evidence the head already carried.
    const clause = sentence.slice(m.index).trim();
    // Already legible in the excerpt head ⇒ spend nothing on it.
    if (head.includes(clause)) continue;
    candidates.push(clause);
  }

  const selected = candidates.slice(Math.max(0, candidates.length - maxClauses));
  const out: string[] = [];
  let spent = 0;
  for (const clause of selected) {
    if (out.length >= maxClauses || spent >= maxChars) break;
    const room = maxChars - spent;
    const kept = clause.length > room ? `${clause.slice(0, Math.max(0, room - 1))}…` : clause;
    if (!kept || kept === '…') break;
    out.push(kept);
    spent += kept.length;
  }
  return out;
}

/**
 * Identifier shapes that frequently ARE the answer rather than prose about the
 * answer. P-011 (knowledge-at-symptom-time-2026-08-09) measured the concrete
 * failure: the operative pass correctly rescued a late freeze directive while
 * dropping the 40-hex candidate SHA beside it, leaving the successor with the
 * rule but not the object the rule governed.
 *
 * Keep this deliberately narrower than a generic "word with punctuation"
 * matcher. These are stable, actionable identifiers used throughout this repo:
 * commit SHAs, ledger/plan refs, explicit ports, and repo-rooted source paths.
 */
const KNOWLEDGE_IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /\b[0-9a-f]{40}\b/gi,
  /\b(?:WI|EI|F)-\d+\b/g,
  /\bP-\d{3,}\b/g,
  // Do not mistake the second half of a clock (`15:57`) for a port. A bare
  // `:3070` is the house shape in prompts/briefs; URL paths are rescued by the
  // repo-path/source-ref alternatives around them when present.
  /(?<![\d:]):(?:[1-9]\d{1,4})\b/g,
  /(?:\.papercusp|apps|config|docs|infra|libs|migrations|packages|scripts|src|templates|tests?)\/[A-Za-z0-9_@.+/-]*[A-Za-z0-9_@.+-]/g,
];

/**
 * Pull complete identifier tokens out of `body` that are not already visible
 * in `head`. Results retain source order and are independently bounded: an
 * identifier is never truncated mid-token, because a partial SHA/ref/path is
 * not a weaker answer — it is a different, usually unresolvable identifier.
 */
export function extractKnowledgeIdentifiers(
  body: string,
  head: string,
  opts: ExtractKnowledgeIdentifiersOptions = {},
): string[] {
  const maxChars = opts.maxChars ?? KNOWLEDGE_IDENTIFIER_CHARS_DEFAULT;
  const maxIdentifiers = opts.maxIdentifiers ?? KNOWLEDGE_IDENTIFIER_MAX_DEFAULT;
  const matches: Array<{ token: string; index: number }> = [];

  for (const pattern of KNOWLEDGE_IDENTIFIER_PATTERNS) {
    for (const match of body.matchAll(pattern)) {
      const token = match[0];
      if (!token || match.index == null) continue;
      if (token.startsWith(':') && Number(token.slice(1)) > 65_535) continue;
      matches.push({ token, index: match.index });
    }
  }

  matches.sort((a, b) => a.index - b.index || a.token.localeCompare(b.token));
  const out: string[] = [];
  const seen = new Set<string>();
  let spent = 0;
  for (const { token } of matches) {
    if (out.length >= maxIdentifiers) break;
    if (seen.has(token) || head.includes(token)) continue;
    seen.add(token);
    const cost = token.length + (out.length > 0 ? 1 : 0);
    if (spent + cost > maxChars) continue;
    out.push(token);
    spent += cost;
  }
  return out;
}

/**
 * Cap `s` to `max` chars, but — unlike a plain head-only slice — never let
 * the cut discard an operative/supersession clause OR a concrete identifier:
 * clauses are appended after `⚠ OPERATIVE:` and identifiers after their own
 * `⚠ IDENTIFIERS:` marker. Shared excerpt shape for any carry surface that
 * truncates long verbatim text.
 *
 * ⚠ This returns the excerpt STRING only, so a caller using it alone cannot
 * tell its reader HOW MUCH was withheld or how to fetch the rest — a bare `…`
 * is exactly the silent-loss shape that `coord:orient`'s sibling folds were
 * fixed not to emit (EI-20113865649946366). Prefer
 * `capPreservingOperativeDetailed`, which returns the same text plus a
 * structured `truncation` marker; this wrapper stays for callers that have
 * genuinely nowhere to put one.
 */
export function capPreservingOperative(
  s: string,
  max: number,
  opts?: CapPreservingOperativeOptions,
): string {
  return capPreservingOperativeDetailed(s, max, opts).text;
}

/**
 * `capPreservingOperative` + the disclosure a reader needs to act on the gap:
 * how many chars were withheld, out of how many, and the call that returns
 * them.
 *
 * Why this exists: a truncated carry surface that says nothing about being
 * truncated is indistinguishable from a complete one, so a successor reads a
 * partial checkpoint as the whole story. That is the owner-reported failure
 * behind this thread ("agents missing details they needed in an orient in a
 * new epoch"), and it is the same defect class already fixed for orient's
 * claimable slice, `rubrics:get` (13 of 25 criteria under a header asserting
 * completeness, EI-19965559011729712) and `work_items:get`'s `_shapeNote`.
 *
 * The excerpt text is byte-identical to the pre-disclosure shape unless the
 * caller opts into `inlineNotice`, so adopting this is safe for a JSON payload
 * that would rather carry the marker as its own field.
 */
export function capPreservingOperativeDetailed(
  s: string,
  max: number,
  opts?: CapPreservingOperativeOptions,
): CapPreservingOperativeResult {
  const t = s.trim();
  if (t.length <= max) return { text: t };

  // An inline notice is part of the excerpt's BUDGET, not an addition to it.
  // Appending it past `max` is how a disclosure fix becomes an over-budget
  // regression — measured here: it produced an "excerpt" 737 chars long for a
  // 684-char checkpoint, i.e. longer than the thing it was excerpting. Reserve
  // the room up front instead, using the widest the notice could render
  // (withheld is at most total, and `keptChars` never appears in it), so the
  // reservation never under-shoots and the head shrinks by exactly what the
  // disclosure costs.
  const reserved = opts?.inlineNotice
    ? renderWithheldNotice({
        keptChars: 0,
        totalChars: t.length,
        withheldChars: t.length,
        operativeClausesKept: 0,
        identifiersKept: 0,
        ...(opts.more ? { more: opts.more } : {}),
      }).length + 1
    : 0;

  const head = t.slice(0, Math.max(0, max - 1 - reserved));
  const operative = extractOperativeClauses(t, head, opts);
  const identifiers = extractKnowledgeIdentifiers(t, head, opts);
  const truncation: CapPreservingOperativeTruncation = {
    keptChars: head.length,
    totalChars: t.length,
    withheldChars: t.length - head.length,
    operativeClausesKept: operative.length,
    identifiersKept: identifiers.length,
    ...(opts?.more ? { more: opts.more } : {}),
  };
  const rescued: string[] = [];
  if (operative.length) rescued.push(`⚠ OPERATIVE: ${operative.join(' ')}`);
  if (identifiers.length) rescued.push(`⚠ IDENTIFIERS: ${identifiers.join(' ')}`);
  let text = `${head}…${rescued.length ? ` ${rescued.join(' ')}` : ''}`;
  if (opts?.inlineNotice) text += ` ${renderWithheldNotice(truncation)}`;
  return { text, truncation };
}

/**
 * The human-readable form of a `truncation` marker, for prose surfaces that
 * have no sibling field. Kept next to the type so the two cannot drift.
 */
export function renderWithheldNotice(t: CapPreservingOperativeTruncation): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    `⟨excerpt: ${n(t.withheldChars)} of ${n(t.totalChars)} chars withheld` +
    `${t.more ? ` — full text: ${t.more}` : ''}⟩`
  );
}
