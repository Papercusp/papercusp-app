/**
 * miner-core.ts — the neologism miner's pure core
 * (self-learning-frontier-2026-06-12 P-011 / FB-05).
 *
 * A "neologism" here is emergent fleet vocabulary: a term agents coin and
 * keep using in coord traffic + insights ("wake-storm", "arming gate",
 * "deploy train") that has NO corresponding primitive — no tool, table,
 * verb, routine, or flag carries its name. Recurring coinage with no
 * primitive is a demand signal for an abstraction: the concept is real
 * enough that the fleet needed a word for it, but it still lives only in
 * prose, so it is unsearchable, unreferenceable, and unautomatable.
 *
 * This module turns raw coord rows (mined from
 * harness_shared.coord_event_log by scan.ts) + the insights corpus + the
 * primitive namespaces into a ranked emergent-term map and picks the capped
 * candidate set worth routing into Scout's improvement rail as abstraction
 * proposals (D-007's "route into the existing rails" — the proposal shape is
 * Scout's own `Proposal`, the body composer is router-deps' improvementBody).
 *
 * Pure on purpose (no PG, no fs, no clock — `asOf` is injected):
 * sanitization, term extraction, namespace coverage, the growth math, and
 * the fire-bar selection are all unit-testable; scan.ts owns the SQL/fs +
 * capture glue. Mirrors the negative-space miner's split (FB-04).
 */

import type { Proposal } from '../scout/types';

/** One coord row as scan.ts reads it off coord_event_log (prose kinds only). */
export interface CoordTextRow {
  /** Writer's owner id (body->>'from') — the distinct-speakers signal. */
  speaker: string;
  /** summary + body concatenated. */
  text: string;
  /** ISO timestamp of the envelope. */
  at: string;
}

/** One insights-corpus doc (slug + raw MDX text) — corroborating evidence. */
export interface InsightDoc {
  slug: string;
  text: string;
}

/** One emergent-term entry: a normalized term with its evidence. */
export interface NeologismEntry {
  /** Normalized term (lowercase, single-space-joined words). */
  term: string;
  /** Coord rows mentioning the term in the recent sub-window. */
  recentMentions: number;
  /** Coord rows mentioning the term in the prior sub-window. */
  priorMentions: number;
  /** Distinct speakers over the whole window. */
  distinctSpeakers: number;
  /** recent-rate / smoothed-prior-rate — the emergence signal. */
  growth: number;
  /** Insight docs whose text contains the term (corroboration, not time-series). */
  insightSlugs: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** A representative usage snippet (from the most recent mentioning row). */
  exampleText: string;
}

/* ────────────────────────────────────────────────────────────────────────
 * Sanitization + term extraction
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Functional stopwords only — content words stay so real compounds ("wake
 * queue", "deploy train") survive. The namespace check + fire bars are the
 * real noise filters; this list just kills grammatical bigrams.
 */
const STOPWORDS = new Set(
  (
    'the a an and or but nor if then than so as of to in on at by for with from into onto over under up down ' +
    'out off about above below between through during without within against because until since while when ' +
    'where which who whom whose this that these those it its is are was were be been being has have had do ' +
    'does did done not no yes all any each every some most more less few many much own same other another such ' +
    'only also just now here there what why how can could should would will shall may might must im ive dont ' +
    'doesnt didnt isnt arent wasnt werent cant wont my our your their his her you we they he she i me us them ' +
    'him via per vs etc still already never ever again once both was get got need needs needed want wants ' +
    'after before next last first second new old one two three'
  ).split(/\s+/),
);

/** Min letters for a word to participate in a term. */
const MIN_WORD_LEN = 3;
/** Max words in one term (hyphenated compounds can run longer in file names — capped out). */
const MAX_TERM_WORDS = 4;

/**
 * Ordinary English morphology, not coinage: a TWO-segment compound whose
 * first segment is one of these is just a prefixed verb/adjective ("re-run",
 * "pre-existing", "mid-flight", "per-cycle") — the 30d backtest's top noise
 * class. Three-plus-segment compounds keep the prefix ("re-capture-flood"
 * could be a real coinage). Deliberately EXCLUDES productive fleet prefixes
 * like "auto"/"self"/"cross" ("auto-commit", "self-heal", "cross-machine"
 * are genuine vocabulary).
 */
const GRAMMATICAL_PREFIXES = new Set([
  're', 'co', 'de', 'un', 'pre', 'post', 'mid', 'non', 'semi', 'anti', 'sub', 'per',
]);

/**
 * Very common English words: a bigram whose halves are BOTH in this set
 * ("either way", "looks like", "work needing" — the backtest's other noise
 * class, much of it templated boilerplate) is conversation, not coinage. One
 * domain-ish half keeps the bigram ("green gate", "deploy train").
 */
const COMMON_WORDS = new Set(
  (
    'way ways like likes look looks looking either neither still well good bad real really work works working ' +
    'worked need needs needed needing time times thing things place case cases point parts part kind sort fact ' +
    'idea line lines side end ends back next going getting making doing done came come comes want wants wanted ' +
    'see sees seeing say said says saying know knows known think thinks thought made make makes take takes ' +
    'taken gets goes went left right keep keeps kept lets put puts rest others else enough sure yet far long ' +
    'later soon today currently current existing exists exist pre non via everything anything something nothing ' +
    'everyone anyone someone whole half lot lots bit bits stuff'
  ).split(/\s+/),
);

/**
 * Strip the text regions that breed false terms before extraction:
 * backtick code spans, URLs, path-like tokens (anything with a slash),
 * file-extension tokens, and the fleet's id vocabulary (F-NNN / EI-NNN /
 * P-NNN / WI-NNN / B-NN / FB-NN / D-NNN, su-/wf-/rt- ids, plan slugs with
 * dates). Digits in general never make it through extraction (terms are
 * alpha-only), but stripping here also prevents the WORDS around an id from
 * forming a bogus bigram across it.
 */
export function sanitizeCoordText(raw: string): string {
  return (
    raw
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      // path-like (a slash anywhere in the token) — files, routes, slugs
      .replace(/\S*\/\S*/g, ' ')
      // file tokens by extension (no slash, e.g. "miner-core.ts")
      .replace(/\b[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|mdx?|sql|rs|py|sh|ya?ml|toml|css|html|svg|lock)\b/gi, ' ')
      // fleet ids: F-012, EI-334, P-011, WI-3, B-08, FB-05, D-001, su-0ae39, wf-x, rt_y
      .replace(/\b(?:[A-Z]{1,3}-\d+|FB-\d+|su-[0-9a-f-]+|wf_[a-z0-9-]+|rt_[a-z0-9_]+)\b/g, ' ')
      // dated plan/slug tails that survived the path strip ("foo-2026-06-12")
      .replace(/\b[\w-]*\d{4}-\d{2}-\d{2}\b/g, ' ')
  );
}

/**
 * Extract candidate terms from one text, DEDUPED per text (a term counts
 * once per row — mention-counting is row-based so one chatty message can't
 * fake recurrence). Two shapes:
 *
 *   1. hyphenated compounds — `wake-storm`, `green-checkpoint` — all-alpha
 *      segments, each ≥ 2 chars (normalized to space-joined words);
 *   2. content bigrams — adjacent non-stopword words ≥ MIN_WORD_LEN within
 *      one punctuation-bounded segment ("arming gate", "deploy train").
 *
 * All terms are lowercase, space-joined, ≤ MAX_TERM_WORDS words.
 */
export function extractTerms(rawText: string): Set<string> {
  return extractTermsFromSanitized(sanitizeCoordText(rawText).toLowerCase());
}

/** The extraction body over already-sanitized+lowercased text — aggregate
 *  sanitizes once per row (dedup key + extraction share the pass). */
function extractTermsFromSanitized(text: string): Set<string> {
  const terms = new Set<string>();

  // 1. hyphenated compounds
  for (const m of text.matchAll(/\b[a-z]{2,}(?:-[a-z]{2,})+\b/g)) {
    const words = m[0].split('-');
    if (words.length > MAX_TERM_WORDS) continue;
    if (words.length === 2 && GRAMMATICAL_PREFIXES.has(words[0])) continue;
    if (words.every((w) => !STOPWORDS.has(w))) terms.add(words.join(' '));
  }

  // 2. content bigrams within punctuation-bounded segments
  for (const segment of text.split(/[^a-z\s-]+/)) {
    const words = segment
      .split(/[\s-]+/)
      .filter((w) => w.length >= MIN_WORD_LEN && /^[a-z]+$/.test(w));
    for (let i = 0; i + 1 < words.length; i++) {
      const a = words[i];
      const b = words[i + 1];
      if (a === b || STOPWORDS.has(a) || STOPWORDS.has(b)) continue;
      if (COMMON_WORDS.has(a) && COMMON_WORDS.has(b)) continue;
      terms.add(`${a} ${b}`);
    }
  }

  return terms;
}

/* ────────────────────────────────────────────────────────────────────────
 * Namespace coverage — "no corresponding primitive"
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Build the covered-vocabulary set from primitive names (tool names, table
 * names, routine names/targets, flag keys). Each name is split on the
 * separator vocabulary (`:` `_` `-` `.` `/` space) and every contiguous
 * word n-gram (1..MAX_TERM_WORDS) is registered, so the term "negative
 * space" is covered by the table `negative_space_demand` and "memory
 * search" by the tool `memory:search`.
 */
export function buildNamespaceIndex(primitiveNames: Iterable<string>): Set<string> {
  const covered = new Set<string>();
  for (const name of primitiveNames) {
    const words = name.toLowerCase().split(/[:_./\s-]+/).filter(Boolean);
    for (let n = 1; n <= MAX_TERM_WORDS; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        covered.add(words.slice(i, i + n).join(' '));
      }
    }
  }
  return covered;
}

/** Is the (normalized) term already named by some primitive? */
export function isCoveredByNamespace(term: string, index: ReadonlySet<string>): boolean {
  return index.has(term);
}

/* ────────────────────────────────────────────────────────────────────────
 * Kind/taxonomy fidelity at the filing edge (frontier P-044 / FB-18, D-008)
 *
 * Two shapes leave this miner:
 *
 *   primitive-near-miss  — the fleet's term is ONE word-edit from a real
 *                          primitive phrase: agents repeatedly reference a
 *                          primitive under a spelling that doesn't resolve.
 *                          Clear correct state (the term resolves to the
 *                          primitive — alias/doc anchor — or the vocabulary
 *                          is corrected), regression-testable → kind=bug.
 *   abstraction-proposal — genuinely unnamed vocabulary; whether to mint the
 *                          primitive is a judgment call → kind=change, the
 *                          Scout-rail proposal (today's shape, unchanged).
 * ──────────────────────────────────────────────────────────────────────── */

export type NeologismFindingClass = 'neologism:primitive-near-miss' | 'neologism:abstraction-proposal';

/** Levenshtein-distance-≤1 check (lengths within 1, single edit), cheap + exact. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (longer.length - shorter.length > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (edits > 0) return false;
    edits = 1;
    if (shorter.length === longer.length) i += 1; // substitution
    j += 1; // deletion from the longer
  }
  return true; // any trailing char is the one allowed edit
}

/** Word-level fuzz: singular/plural variants, or one edit on words long enough to trust. */
function wordsNearlyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (a + 's' === b || b + 's' === a || a + 'es' === b || b + 'es' === a) return true;
  if (a.length >= 5 && b.length >= 5) return withinOneEdit(a, b);
  return false;
}

/**
 * Does this (uncovered) term near-miss an indexed primitive phrase — same
 * word count, exactly ONE word differing by plural form or a single edit?
 * Returns the matched phrase or null. Pure, so the bug-vs-judgment line is
 * pinned by unit tests; the tick runs it only over the capped candidates.
 */
export function findPrimitiveNearMiss(term: string, index: ReadonlySet<string>): string | null {
  if (index.has(term)) return null; // exact coverage is not a near-miss (never reaches filing anyway)
  const words = term.split(' ');
  for (const phrase of index) {
    if (Math.abs(phrase.length - term.length) > 3) continue; // cheap pre-filter
    const phraseWords = phrase.split(' ');
    if (phraseWords.length !== words.length) continue;
    let mismatches = 0;
    let ok = true;
    for (let i = 0; i < words.length; i++) {
      if (words[i] === phraseWords[i]) continue;
      if (!wordsNearlyEqual(words[i], phraseWords[i]) || mismatches > 0) {
        ok = false;
        break;
      }
      mismatches = 1;
    }
    if (ok && mismatches === 1) return phrase;
  }
  return null;
}

/** STABLE near-miss capture title (no counts/timestamps, dedup contract). */
export function neologismNearMissTitle(term: string, primitivePhrase: string): string {
  return `Vocabulary resolution gap: fleet term "${term}" near-misses primitive phrase "${primitivePhrase}"`;
}

/** Near-miss capture body — evidence + the correct state (the bug shape's contract). */
export function neologismNearMissBody(entry: NeologismEntry, primitivePhrase: string, windowDays: number): string {
  return (
    `Neologism miner signal (self-learning-frontier P-011, kind-fidelity per P-044): the fleet writes ` +
    `"${entry.term}" — ${entry.recentMentions + entry.priorMentions} mention(s) by ${entry.distinctSpeakers} ` +
    `distinct agent(s) over the last ${windowDays}d — but no primitive carries that exact name; the nearest ` +
    `real primitive phrase is "${primitivePhrase}" (one word-edit away). Agents are referencing a primitive ` +
    `under a spelling that doesn't resolve.\n\n` +
    `Latest usage: ${JSON.stringify(entry.exampleText)}\n` +
    `Window: ${entry.firstSeenAt} → ${entry.lastSeenAt}\n\n` +
    `Correct state: the fleet's spelling resolves — alias/anchor "${entry.term}" to the primitive behind ` +
    `"${primitivePhrase}" (doc anchor, tool alias, or a docs note pinning the canonical name). ` +
    `Regression test: findPrimitiveNearMiss("${entry.term}") stops firing once the spelling is covered.`
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Aggregation + emergence
 * ──────────────────────────────────────────────────────────────────────── */

export interface NeologismFilingOptions {
  /** Trailing mining window in days. Default 30. */
  windowDays?: number;
  /** The "recent" emergence sub-window in days (must be < windowDays). Default 7. */
  recentDays?: number;
  /** Fire bar: rows mentioning the term in the recent sub-window. Default 4. */
  minRecentMentions?: number;
  /** Fire bar: distinct speakers over the window ("fleet vocabulary, not one agent's tic"). Default 3. */
  minSpeakers?: number;
  /** Fire bar: recent-rate over smoothed-prior-rate. Default 3. */
  growthFactor?: number;
  /** Per-tick filing cap (the anti-flood half capture-core doesn't own). Default 2. 0 = mine-only. */
  maxPerTick?: number;
}

export const DEFAULT_NEOLOGISM_OPTIONS: Required<NeologismFilingOptions> = {
  windowDays: 30,
  recentDays: 7,
  minRecentMentions: 4,
  minSpeakers: 3,
  growthFactor: 3,
  maxPerTick: 2,
};

function resolveOptions(opts: NeologismFilingOptions): Required<NeologismFilingOptions> {
  const merged = { ...DEFAULT_NEOLOGISM_OPTIONS, ...opts };
  if (merged.recentDays >= merged.windowDays) merged.recentDays = DEFAULT_NEOLOGISM_OPTIONS.recentDays;
  return merged;
}

/**
 * Aggregate coord rows + insight docs into the emergent-term map, namespace-
 * filtered and sorted hottest-first. `asOf` anchors the recent/prior window
 * split (injected — the core owns no clock).
 *
 * Growth math: recentRate = recentMentions / recentDays;
 * priorRate = (priorMentions + 1) / priorDays (Laplace-smoothed so a term
 * with zero prior history gets a large-but-finite growth). A term the fleet
 * has used steadily all window scores ≈ 1 and is correctly NOT emergent.
 *
 * Insights are corroboration, not time-series: MDX files carry no usable
 * timestamps, so insight mentions never enter the growth math — they rank
 * (score) and they evidence (the proposal body names the slugs).
 *
 * Insight corroboration is computed ONLY for fire-bar-passing entries (top
 * MAX_CORROBORATED by traffic×spread). Scanning every term was
 * O(terms · corpusBytes) of synchronous `.includes` — at live size (~50k+
 * terms × 3.7 MB of insights, twice per miss) hundreds of GB of byte
 * scanning per tick, the single hottest frame in the 2026-07-07 bg-host
 * loop-saturation profiles (43% of all real self-time; ~14 min of sustained
 * event-loop saturation at every 6h slot). The fire bars never depended on
 * corroboration, so candidate SELECTION is byte-identical; only the ranking
 * of never-selectable non-passers (and their `insightSlugs`, now `[]`) moved.
 */
/** Yield control to the event loop so a large synchronous scan cannot block
 *  routinesTick / the DBOS scheduler (the 2026-06-30 6h-slot freeze cascade). */
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/** Ceiling on fire-bar passers that get the full-corpus corroboration scan
 *  per tick (each scan ≈ the whole insights corpus, ~7 ms/MB) — a flood of
 *  passers must not reopen the O(terms · corpusBytes) regime this bounds. */
const MAX_CORROBORATED = 200;

export async function aggregateNeologisms(
  rows: readonly CoordTextRow[],
  insights: readonly InsightDoc[],
  namespaceIndex: ReadonlySet<string>,
  asOf: string,
  opts: NeologismFilingOptions = {},
): Promise<NeologismEntry[]> {
  const o = resolveOptions(opts);
  const asOfMs = Date.parse(asOf);
  const recentStartMs = asOfMs - o.recentDays * 86_400_000;

  interface Acc {
    recent: number;
    prior: number;
    speakers: Set<string>;
    firstSeenAt: string;
    lastSeenAt: string;
    exampleText: string;
  }
  const byTerm = new Map<string, Acc>();

  // Collapse template re-broadcasts BEFORE counting: rows whose sanitized,
  // digit-normalized text is identical are one utterance, not independent
  // coinage events (the live corpus' worst offender: resource-lock drain
  // notices — one template, dozens of synthetic senders). Keep the freshest.
  // The sanitized+lowercased text rides along so extraction below doesn't
  // re-run the 6-regex sanitize pass over the whole corpus a second time.
  const byText = new Map<string, { row: CoordTextRow; lc: string }>();
  let _dedupN = 0;
  for (const row of rows) {
    if ((++_dedupN & 0x1ff) === 0) await yieldToEventLoop();
    const lc = sanitizeCoordText(row.text).toLowerCase();
    const key = lc.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
    const prev = byText.get(key);
    if (!prev || row.at > prev.row.at) byText.set(key, { row, lc });
  }

  let _scanN = 0;
  for (const { row, lc } of byText.values()) {
    if ((++_scanN & 0xff) === 0) await yieldToEventLoop();
    const atMs = Date.parse(row.at);
    if (!Number.isFinite(atMs) || atMs > asOfMs) continue;
    const isRecent = atMs >= recentStartMs;
    for (const term of extractTermsFromSanitized(lc)) {
      if (isCoveredByNamespace(term, namespaceIndex)) continue;
      const acc = byTerm.get(term);
      if (!acc) {
        byTerm.set(term, {
          recent: isRecent ? 1 : 0,
          prior: isRecent ? 0 : 1,
          speakers: new Set([row.speaker || 'unknown']),
          firstSeenAt: row.at,
          lastSeenAt: row.at,
          exampleText: row.text,
        });
        continue;
      }
      if (isRecent) acc.recent += 1;
      else acc.prior += 1;
      acc.speakers.add(row.speaker || 'unknown');
      if (row.at < acc.firstSeenAt) acc.firstSeenAt = row.at;
      if (row.at > acc.lastSeenAt) {
        acc.lastSeenAt = row.at;
        acc.exampleText = row.text;
      }
    }
  }

  const priorDays = o.windowDays - o.recentDays;
  const entries: NeologismEntry[] = [];
  let _termN = 0;
  for (const [term, acc] of byTerm) {
    if ((++_termN & 0xff) === 0) await yieldToEventLoop();
    const recentRate = acc.recent / o.recentDays;
    const priorRate = (acc.prior + 1) / priorDays;
    entries.push({
      term,
      recentMentions: acc.recent,
      priorMentions: acc.prior,
      distinctSpeakers: acc.speakers.size,
      growth: recentRate / priorRate,
      insightSlugs: [],
      firstSeenAt: acc.firstSeenAt,
      lastSeenAt: acc.lastSeenAt,
      exampleText: acc.exampleText.slice(0, 300),
    });
  }

  // Insight corroboration, ONLY for fire-bar passers (see the docstring): each
  // corroboration is a full-corpus substring scan, so the passer set is capped
  // and every scan is preceded by a yield. Passers are corroborated in
  // traffic×spread order so a pathological over-cap tick still corroborates
  // the hottest ones; within the cap, candidate selection is byte-identical
  // to the old scan-everything behavior.
  const insightsLc = insights.map((d) => ({ slug: d.slug, lc: d.text.toLowerCase() }));
  const passers = entries
    .filter(
      (e) =>
        e.recentMentions >= o.minRecentMentions &&
        e.distinctSpeakers >= o.minSpeakers &&
        e.growth >= o.growthFactor,
    )
    .sort((a, b) => score(b) - score(a));
  for (const e of passers.slice(0, MAX_CORROBORATED)) {
    await yieldToEventLoop();
    const termDash = e.term.replace(/ /g, '-');
    e.insightSlugs = insightsLc
      .filter((d) => d.lc.includes(e.term) || d.lc.includes(termDash))
      .map((d) => d.slug);
  }

  return entries.sort(
    (a, b) =>
      score(b) - score(a) ||
      b.growth - a.growth ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
  );
}

/** Ranking score: traffic × spread, with insight corroboration weighted in. */
function score(e: NeologismEntry): number {
  return e.recentMentions * e.distinctSpeakers + 5 * e.insightSlugs.length;
}

/**
 * The capped candidate selection: entries over ALL fire bars (recent
 * mentions, speakers, growth), hottest-first, cut at the per-tick cap.
 * There is no filed-id ledger here — capture-core's watchdogKey dedup is
 * the cross-tick net (a re-mined term re-offers and is declined while its
 * item is open; a resolved item re-files only on fresh evidence).
 */
export function selectNeologismCandidates(
  entries: readonly NeologismEntry[],
  opts: NeologismFilingOptions = {},
): NeologismEntry[] {
  const o = resolveOptions(opts);
  if (o.maxPerTick <= 0) return [];
  return entries
    .filter(
      (e) =>
        e.recentMentions >= o.minRecentMentions &&
        e.distinctSpeakers >= o.minSpeakers &&
        e.growth >= o.growthFactor,
    )
    .slice(0, o.maxPerTick);
}

/* ────────────────────────────────────────────────────────────────────────
 * The abstraction proposal (Scout's rail shape)
 * ──────────────────────────────────────────────────────────────────────── */

/** Stable cross-tick capture identity (payload.watchdogKey). */
export function neologismWatchdogKey(term: string): string {
  return `neologism:${term.replace(/ /g, '-')}`;
}

/** STABLE capture title — no counts/timestamps, per the search-first dedup contract. */
export function neologismCaptureTitle(term: string): string {
  return `Abstraction proposal: name the recurring fleet term "${term}"`;
}

/**
 * Shape one emergent term as a Scout `Proposal` — the abstraction-proposal
 * form P-011 asks for, dispatched down Scout's improvement rail (D-007).
 * Deterministic (no LLM): the framing/mechanism/bet are template prose over
 * the entry's evidence; the D-006 cheap experiment is the owner-review test
 * every proposal must carry.
 */
export function neologismProposal(entry: NeologismEntry, windowDays: number): Proposal {
  const id = neologismWatchdogKey(entry.term);
  const insightNote = entry.insightSlugs.length
    ? ` It also appears in ${entry.insightSlugs.length} insight doc(s): ${entry.insightSlugs.slice(0, 5).join(', ')}.`
    : '';
  return {
    id,
    framing: `Emerging fleet vocabulary "${entry.term}" has no corresponding primitive (tool/table/verb)`,
    mechanism:
      `Promote "${entry.term}" into a named primitive: give the recurring mechanism it names a ` +
      `first-class home — a tool/verb, a table, a routine, or at minimum a docs/insight page that ` +
      `defines it — so the concept becomes searchable, referenceable, and automatable instead of ` +
      `living only in coord prose.`,
    whyNew:
      `Coined organically in fleet traffic: ${entry.recentMentions + entry.priorMentions} mention(s) by ` +
      `${entry.distinctSpeakers} distinct agent(s) over the last ${windowDays}d, recent-week rate ` +
      `×${entry.growth.toFixed(1)} vs prior, and absent from every primitive namespace checked ` +
      `(tools, tables, routines, flags).${insightNote}\n\nLatest usage: ${JSON.stringify(entry.exampleText)}`,
    bet:
      `If the term names a real recurring mechanism, minting its primitive turns tacit coordination ` +
      `vocabulary into infrastructure; if it is a passing turn of phrase, the candidate dies cheaply in review.`,
    cheapExperiment: {
      hypothesis: `"${entry.term}" denotes a recurring mechanism agents need to reference precisely — not a passing turn of phrase.`,
      method:
        `Owner/Mug review: write the one-paragraph definition (docs or insight page), link this traffic, ` +
        `and if the concept holds, mint the primitive it implies (verb, table, routine, or doc anchor).`,
      falsifiableSignal:
        `Usage fades (no new mentions in the next ${windowDays}d) or review finds the concept already ` +
        `covered by an existing primitive under another name.`,
    },
    sourceIdeaIds: [id],
    routeHint: 'improvement',
    addressesPatternRefs: [],
  };
}

/**
 * Tuning knobs off the routine's payload_template (mirrors
 * demandOptionsFromPayload — re-tunable without a deploy). Unknown/invalid
 * values are ignored.
 */
export function neologismOptionsFromPayload(
  payload: Record<string, unknown> | null | undefined,
): NeologismFilingOptions {
  const out: NeologismFilingOptions = {};
  if (!payload) return out;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
  const int = (v: unknown): number | undefined => {
    const n = num(v);
    return n === undefined ? undefined : Math.floor(n);
  };
  const windowDays = int(payload.windowDays);
  const recentDays = int(payload.recentDays);
  const minRecentMentions = int(payload.minRecentMentions);
  const minSpeakers = int(payload.minSpeakers);
  const growthFactor = num(payload.growthFactor);
  const maxPerTick = int(payload.maxPerTick);
  if (windowDays !== undefined && windowDays > 0) out.windowDays = windowDays;
  if (recentDays !== undefined && recentDays > 0) out.recentDays = recentDays;
  if (minRecentMentions !== undefined) out.minRecentMentions = minRecentMentions;
  if (minSpeakers !== undefined) out.minSpeakers = minSpeakers;
  if (growthFactor !== undefined) out.growthFactor = growthFactor;
  if (maxPerTick !== undefined) out.maxPerTick = maxPerTick;
  return out;
}
