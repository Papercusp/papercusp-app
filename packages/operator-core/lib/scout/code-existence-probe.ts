/**
 * code-existence-probe — does the capability an idea proposes ALREADY EXIST in
 * the tree? (WI-9476, closing the corpus gap WI-6773 names.)
 *
 * ## Why this exists — it is a CORPUS gap, not a missing check
 *
 * Scout already runs a prior-art check: `noveltyPriorArt` (novelty-precheck.ts)
 * over `readNoveltyCorpus()` — prior plans, ratified decisions, and routed-ledger
 * idea TITLES. That corpus is the set of PAST PROPOSED IDEAS. It is not the
 * shipped feature set.
 *
 * So a capability that was **engineered directly** — built by someone who never
 * filed it as a Scout idea — is structurally invisible to that check. Three
 * independent instances of exactly that escape:
 *
 *   - EI-8167 + EI-8337 both proposed an already-implemented graduated
 *     429-escalation ladder (EI-18801316749542776, the incident behind WI-6773).
 *   - EI-7303 proposed an "antibody library" of structural failure signatures.
 *     `watchdogKey` already implemented it — 3,485 work-items across 1,329
 *     distinct keys. Engineered directly, never proposed, therefore invisible.
 *
 * EI-7303 is the expensive shape and the reason this probe is a SEPARATE leg
 * rather than a follow-up to premise re-validation: its own stated falsification
 * experiment PASSED on current data. An agent who re-measured the premise exactly
 * as advised would have been greenlit to build a duplicate. Re-measuring a premise
 * and asking "does this already exist" are independent questions, and only the
 * second one catches this class.
 *
 * ## What it does
 *
 * Deterministic and cheap — no LLM call, matching the design WI-6773 asks for.
 * Two stages, deliberately split so the risky one is testable in isolation:
 *
 *   1. `extractDistinctiveTerms` — pure, no I/O. Pulls the idea's own distinctive
 *      vocabulary (backticked spans, camelCase/PascalCase identifiers, `group:verb`
 *      tool names, source paths) and drops generic prose. ALL the precision risk
 *      lives here, which is why it is a pure function with its own tests.
 *   2. `probeCodeExistence` — runs those terms against an injectable searcher.
 *
 * ## Report-only, and fail-open
 *
 * This NEVER declines or closes anything. It returns evidence for a human or agent
 * to weigh (mirroring `noveltyPriorArt`'s report-only D-005 contract). A search
 * backend that throws degrades to `searched: false` with no matches — the same
 * fail-open posture as the semantic novelty leg — because a probe outage must
 * never read as "no prior art exists", which is the exact false-negative this
 * module was built to prevent.
 */

import {
  probePlanSlugs,
  summarisePlanSlugLeg,
  type PlanRecord,
  type PlanSlugLegReport,
  type PlanSlugOptions,
} from './plan-slug-leg';

/** One distinctive term from an idea that WAS found in the tree. */
export interface CodeExistenceMatch {
  /** The term as extracted from the idea text. */
  term: string;
  /** How the term was recognised — useful for weighing a hit. */
  source: 'backtick' | 'identifier' | 'tool-name' | 'path';
  /** Number of tracked files containing it (bounded by the searcher's cap). */
  fileCount: number;
  /** Up to `maxExamples` example paths, for drill-in. */
  examples: string[];
  /**
   * STRONG  — found, and specific enough that the hit means something.
   * WEAK    — found, but so widespread it is probably vocabulary, not prior art.
   */
  strength: 'strong' | 'weak';
}

/**
 * A semantically-near prior surface, from the SECOND retrieval leg.
 *
 * Kept in its own field and NEVER unioned into `matches` — see the leg-separation
 * note on `CodeExistenceReport`.
 */
export interface SemanticPriorArtMatch {
  /** Where the near surface lives (path or ref). */
  ref: string;
  /** Similarity in [0,1], as reported by the backend. */
  score: number;
  /** A short excerpt/title for the reader to judge. */
  excerpt?: string;
}

export interface CodeExistenceReport {
  /** The distinctive terms actually probed (post-extraction, post-cap). */
  terms: string[];
  /**
   * LEXICAL leg — terms found verbatim in the tree. Strongest first.
   * Empty is a real answer ONLY when `searched` is true.
   */
  matches: CodeExistenceMatch[];
  /**
   * Did the lexical backend actually run? `false` = the empty `matches` carries
   * NO information. Never read `false` as "nothing found".
   *
   * TWO distinct causes set it false, and `unavailableReason` distinguishes them:
   *   1. the search backend threw (a probe outage);
   *   2. no distinctive terms could be extracted, so the backend was never
   *      called at all.
   *
   * Cause 2 is easy to mistake for a real miss — it looks like a completed probe
   * that found nothing. It is not. See the early return in `probeCodeExistence`.
   */
  searched: boolean;
  /** Present when `searched` is false — why the probe could not run. */
  unavailableReason?: string;

  /**
   * SEMANTIC leg — reported SEPARATELY, deliberately never merged into `matches`.
   *
   * Rationale (su-b9269a31, msg msdmgp4s): symbol-grep only finds prior art that is
   * NAMED close to the proposal. It misses prior art that is semantically the same
   * and lexically unrelated — which is precisely the case an idea's author would
   * most likely have missed, since they would otherwise have found it themselves.
   * The lexical technique is therefore validated on the EASY half.
   *
   * Keeping the legs separate makes each leg's precision measurable instead of
   * blended. If semantic adds nothing above the noise floor, that is a publishable
   * result and the shortlist stays lexical-only.
   */
  semantic?: SemanticPriorArtMatch[];
  /** Did the semantic backend run? `undefined` = not configured; `false` = it failed. */
  semanticSearched?: boolean;

  /**
   * Files citing the item's OWN id (e.g. "EI-7303") — the cheapest and highest-
   * precision probe of the three, because an implementation frequently cites the
   * id it closed in its docstring (su-b9269a31, msg msdj21cp: EI-6144's
   * implementation cited its own id). A hit here is close to conclusive.
   */
  selfIdHits?: string[];

  /**
   * ASSERTED prior art — references the idea's own author NAMED in the text.
   *
   * The cheapest leg of all and the highest precision, because it needs no
   * retrieval at all: the filing confesses. Observed live (su-b9269a31, msg
   * msdmrkli) — EI-7526's summary opens "Existing EI-7347 tooling detects
   * actor-less signals reactively", i.e. the author states the prior art in the
   * first sentence, and a screen that only greps symbols never reads it.
   *
   * Precision here is near-1 by construction (an assertion, not an inference),
   * so these resolve FIRST and are reported before any retrieval leg.
   */
  assertedPriorArt?: AssertedPriorArt[];

  /**
   * PLAN-SLUG leg — plans whose SLUG overlaps the idea's vocabulary. Reported in
   * its own nested shape, deliberately never merged into `matches` or `semantic`.
   *
   * Independent of every other leg by construction: it searches plan NAMES rather
   * than code, which is the only leg that can bridge an idea phrased as a CONDITION
   * to an implementation named for its MECHANISM. See `plan-slug-leg.ts` for the
   * worked case (`orphaned-dispatch.ts`, which symbol-grep provably misses).
   *
   * `undefined` = not configured. A configured-but-failed leg reports
   * `searched: false` INSIDE this object — never read that as "no plan covers this".
   */
  planSlugs?: PlanSlugLegReport;
}

/** A prior-art reference the idea's own text names outright. */
export interface AssertedPriorArt {
  /** The reference as written — "EI-7347", "WI-2374", or the phrase's object. */
  ref: string;
  /** How it was asserted: a bare work-item id, or an "existing <X>" phrase. */
  kind: 'work-item-id' | 'existing-phrase';
  /** The surrounding sentence fragment, so a reader can judge without re-opening. */
  context: string;
}

/** Injectable search backend, so tests never shell out. */
export interface CodeSearchDeps {
  /**
   * Tracked files containing `term` as a literal substring. Implementations
   * should cap their own result count; the probe treats the length as a
   * lower bound on true file count.
   */
  search(term: string): Promise<string[]>;
  /**
   * OPTIONAL second retrieval leg — semantically near surfaces for free text.
   * Omit to skip the leg entirely (`semanticSearched` stays undefined).
   */
  searchSemantic?(text: string): Promise<SemanticPriorArtMatch[]>;
  /**
   * OPTIONAL fifth leg — candidate plans to score by SLUG overlap. Omit to skip the
   * leg entirely (`planSlugs` stays undefined).
   *
   * ⚠ An implementation reading `harness_shared.harness_plans` MUST scope on BOTH
   * `workspace_id` AND `harness_slug` — that table is multi-tenant.
   */
  searchPlans?(text: string): Promise<PlanRecord[]>;
}

export interface CodeExistenceOptions {
  /** Max distinctive terms to probe (default 12) — bounds the search cost. */
  maxTerms?: number;
  /** Max example paths retained per match (default 3). */
  maxExamples?: number;
  /**
   * At or above this file count a hit is graded `weak` — the term is common
   * vocabulary rather than a specific existing surface (default 150).
   */
  ubiquitousFileCount?: number;
  /** Minimum length for a bare identifier to count as distinctive (default 8). */
  minIdentifierLength?: number;
  /**
   * The idea's OWN work-item id (e.g. "EI-7303"). When set, the probe greps the
   * tree for it and reports `selfIdHits` — an implementation that closed this item
   * often names it in a docstring, which makes this the highest-precision leg.
   */
  selfId?: string;
  /** Max semantic matches retained (default 5). */
  maxSemanticMatches?: number;
  /** Options for the plan-slug leg (thresholds, caps). See `plan-slug-leg.ts`. */
  planSlug?: PlanSlugOptions;
}

const DEFAULTS = {
  maxTerms: 12,
  maxExamples: 3,
  ubiquitousFileCount: 150,
  minIdentifierLength: 8,
  maxSemanticMatches: 5,
} as const;

/**
 * Generic engineering vocabulary that is camelCase-shaped and long enough to pass
 * the length filter, but says nothing about whether a specific capability exists.
 * Kept deliberately small and literal — an over-eager stoplist would suppress real
 * hits, which is the failure direction that costs a duplicate build.
 */
const STOPLIST = new Set([
  'workitems',
  'worklitem',
  'implementation',
  'implementations',
  'infrastructure',
  'configuration',
  'documentation',
  'functionality',
  'requirements',
  'observability',
  'architecture',
  'performance',
  'application',
  'components',
  'mechanisms',
  'strategies',
  'thresholds',
  'monitoring',
  'escalation',
  'experiment',
  'hypothesis',
  'falsified',
  'generated',
  'currently',
  'therefore',
  'something',
  'different',
  'available',
  'described',
]);

/**
 * Boilerplate that appears in EVERY Scout idea body. Probing these would return a
 * hit for every idea and drown the real signal.
 */
const BOILERPLATE = /(?:scout-generated|cheap experiment|source ideas?|falsified if|the bet)/gi;

function isStopword(term: string): boolean {
  return STOPLIST.has(term.toLowerCase());
}

/** camelCase / PascalCase / snake_case with an internal boundary — i.e. code-shaped. */
function looksLikeIdentifier(word: string): boolean {
  if (/[a-z][A-Z]/.test(word)) return true; // camelCase or PascalCase boundary
  if (/^[A-Z][a-z]+[A-Z]/.test(word)) return true; // PascalCase
  if (/_/.test(word) && /^[a-z0-9_]+$/i.test(word)) return true; // snake_case
  return false;
}

/**
 * The idea's distinctive vocabulary, de-duplicated, in descending order of how
 * much a hit would mean. PURE — no I/O, so the precision risk is unit-testable.
 *
 * Ordering matters: `probeCodeExistence` truncates to `maxTerms`, so the most
 * meaningful term shapes must sort first.
 */
export function extractDistinctiveTerms(
  text: string,
  opts: CodeExistenceOptions = {},
): { term: string; source: CodeExistenceMatch['source'] }[] {
  const minLen = opts.minIdentifierLength ?? DEFAULTS.minIdentifierLength;
  const cleaned = (text ?? '').replace(BOILERPLATE, ' ');
  const seen = new Set<string>();
  const out: { term: string; source: CodeExistenceMatch['source'] }[] = [];

  const push = (raw: string, source: CodeExistenceMatch['source']) => {
    const term = raw.trim().replace(/^[`'"(\[]+|[`'"),.\]]+$/g, '');
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ term, source });
  };

  // 1. Source paths — the most specific claim an idea can make about the tree.
  for (const m of cleaned.matchAll(/\b[\w./-]+\/[\w./-]+\.(?:ts|tsx|mjs|js|sql|rs)\b/g)) {
    push(m[0], 'path');
  }

  // 2. `group:verb` tool names — unambiguous, and cheap to confirm.
  for (const m of cleaned.matchAll(/\b([a-z][a-z0-9_-]{2,}):([a-z][a-z0-9_-]{2,})\b/g)) {
    push(m[0], 'tool-name');
  }

  // 3. Backticked code spans — the author explicitly marked these as code.
  for (const m of cleaned.matchAll(/`([^`\n]{3,80})`/g)) {
    const inner = m[1].trim();
    if (/\s/.test(inner)) continue; // a phrase in backticks is prose, not a symbol
    if (inner.length < 3) continue;
    push(inner.replace(/\(\)$/, ''), 'backtick');
  }

  // 4. Bare code-shaped identifiers in prose.
  for (const m of cleaned.matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g)) {
    const word = m[0];
    if (word.length < minLen) continue;
    if (!looksLikeIdentifier(word)) continue;
    if (isStopword(word)) continue;
    push(word, 'identifier');
  }

  return out;
}

/**
 * Prior art the idea's own text NAMES. Pure, no I/O, no retrieval.
 *
 * This is the leg with the best cost/precision ratio in the whole module, because
 * it is reading an assertion rather than inferring one. `ownId` is excluded — that
 * is the self-id leg's job, and counting it here would make every item look like
 * it cites prior art.
 */
export function extractAssertedPriorArt(text: string, ownId?: string): AssertedPriorArt[] {
  const src = text ?? '';
  const out: AssertedPriorArt[] = [];
  const seen = new Set<string>();

  const clip = (at: number, len: number): string =>
    src
      .slice(Math.max(0, at - 60), at + len + 60)
      .replace(/\s+/g, ' ')
      .trim();

  // 1. Bare work-item ids — "EI-7347", "WI-2374".
  for (const m of src.matchAll(/\b((?:EI|WI)-\d{3,})\b/g)) {
    const ref = m[1];
    if (ownId && ref.toUpperCase() === ownId.toUpperCase()) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, kind: 'work-item-id', context: clip(m.index ?? 0, ref.length) });
  }

  // 2. "existing <X>" / "already <verb>" phrasings — the author conceding prior art
  //    in prose. Bounded to a short object so a whole sentence is never captured.
  for (const m of src.matchAll(/\b(?:existing|already(?:\s+\w+)?)\s+([`'"]?[\w./:-]{4,60}[`'"]?)/gi)) {
    const ref = m[1].replace(/^[`'"]+|[`'".,]+$/g, '');
    if (!ref) continue;
    if (ownId && ref.toUpperCase() === ownId.toUpperCase()) continue;
    const key = `phrase:${ref.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, kind: 'existing-phrase', context: clip(m.index ?? 0, m[0].length) });
  }

  return out;
}

/**
 * Probe whether the idea's distinctive vocabulary already exists in the tree.
 *
 * Report-only and fail-open: a throwing searcher yields `searched: false`, which
 * callers MUST NOT read as "no prior art".
 */
export async function probeCodeExistence(
  text: string,
  deps: CodeSearchDeps,
  opts: CodeExistenceOptions = {},
): Promise<CodeExistenceReport> {
  const maxTerms = opts.maxTerms ?? DEFAULTS.maxTerms;
  const maxExamples = opts.maxExamples ?? DEFAULTS.maxExamples;
  const ubiquitous = opts.ubiquitousFileCount ?? DEFAULTS.ubiquitousFileCount;

  const candidates = extractDistinctiveTerms(text, opts).slice(0, maxTerms);
  const terms = candidates.map((c) => c.term);

  // Leg 4 (free) — prior art the filing itself names. Runs first because it needs
  // no backend at all, so it survives any retrieval outage.
  const asserted = extractAssertedPriorArt(text, opts.selfId);
  const assertedPriorArt = asserted.length > 0 ? asserted : undefined;

  // Leg 3 (cheapest retrieval, highest precision) — does anything in the tree cite
  // this item's OWN id? An implementation usually names the item it closed.
  let selfIdHits: string[] | undefined;
  if (opts.selfId) {
    try {
      const hits = await deps.search(opts.selfId);
      if (hits && hits.length > 0) selfIdHits = hits.slice(0, maxExamples);
    } catch {
      // Fail-open and stay silent: an unavailable self-id probe must not be
      // reported as "no implementation cites this item".
      selfIdHits = undefined;
    }
  }

  // Leg 2 — semantic, run independently of the lexical leg and reported apart.
  let semantic: SemanticPriorArtMatch[] | undefined;
  let semanticSearched: boolean | undefined;
  if (deps.searchSemantic) {
    try {
      const found = await deps.searchSemantic(text);
      semantic = (found ?? []).slice(0, opts.maxSemanticMatches ?? DEFAULTS.maxSemanticMatches);
      semanticSearched = true;
    } catch {
      semantic = [];
      semanticSearched = false; // distinct from "configured and found nothing"
    }
  }

  // Leg 5 — plan slugs. Independent of the lexical leg by construction (it reads
  // plan NAMES, not code), so it runs even when term extraction yields nothing,
  // and it is carried into EVERY return path below. `probePlanSlugs` fails open
  // internally, so no try/catch is needed here.
  let planSlugs: PlanSlugLegReport | undefined;
  if (deps.searchPlans) {
    const searchPlans = deps.searchPlans.bind(deps);
    planSlugs = await probePlanSlugs(text, { searchPlans }, opts.planSlug);
  }

  if (candidates.length === 0) {
    // ZERO-WORK FALSE GREEN — do not "simplify" this back to `searched: true`.
    //
    // No candidate terms means the lexical backend was NEVER CALLED. Reporting
    // `searched: true` here would claim a probe ran and found nothing, which is
    // the exact false negative this module exists to prevent — the same shape as
    // `tsc -p .` typechecking zero files and reporting clean.
    //
    // It also fails in the most expensive direction: an idea whose text yields no
    // greppable vocabulary (short, prose-only, no backticked identifiers) is
    // precisely the one whose prior art is hardest to find, so it would receive
    // the CLEANEST "nothing found" of the whole backlog.
    return {
      terms,
      matches: [],
      searched: false,
      unavailableReason:
        'no distinctive terms could be extracted from the idea text — the lexical backend was never called',
      semantic,
      semanticSearched,
      selfIdHits,
      assertedPriorArt,
      planSlugs,
    };
  }

  const matches: CodeExistenceMatch[] = [];
  for (const { term, source } of candidates) {
    let files: string[];
    try {
      files = await deps.search(term);
    } catch (err) {
      // Fail-open on the FIRST backend failure: a partial probe reported as a
      // complete one is precisely the false "no prior art exists" this prevents.
      return {
        terms,
        matches: [],
        searched: false,
        unavailableReason: err instanceof Error ? err.message : String(err),
        semantic,
        semanticSearched,
        selfIdHits,
        assertedPriorArt,
        planSlugs,
      };
    }
    if (!files || files.length === 0) continue;
    matches.push({
      term,
      source,
      fileCount: files.length,
      examples: files.slice(0, maxExamples),
      strength: files.length >= ubiquitous ? 'weak' : 'strong',
    });
  }

  // Strong before weak; within a grade, the more specific (fewer files) first.
  matches.sort((a, b) => {
    if (a.strength !== b.strength) return a.strength === 'strong' ? -1 : 1;
    return a.fileCount - b.fileCount;
  });

  return {
    terms,
    matches,
    searched: true,
    semantic,
    semanticSearched,
    selfIdHits,
    assertedPriorArt,
    planSlugs,
  };
}

/**
 * One-line verdict for a screening report.
 *
 * Deliberately hedged: this probe can only ever say "these terms exist in the
 * tree", never "this capability is already built". The judgement stays with the
 * reader, so the wording must not invite a bulk close — EI-19458723447066799
 * explicitly warns against bulk-closing on a shared premise.
 */
export function summariseCodeExistence(report: CodeExistenceReport): string {
  // The plan-slug leg is CONTEXT ONLY — it is appended to whatever verdict the
  // high-precision legs reach, and never returned on its own or ahead of them.
  // A slug overlap is a token-count inference with unmeasured precision, exactly
  // like the lexical leg that was already demoted for the same reason.
  const planNote = report.planSlugs ? ` | ${summarisePlanSlugLeg(report.planSlugs)}` : '';

  // Leg 3 first: a file naming the item's own id is the strongest single signal.
  if (report.selfIdHits && report.selfIdHits.length > 0) {
    return (
      `LIKELY ALREADY IMPLEMENTED — source cites this item's own id: ${report.selfIdHits.join(', ')}` +
      planNote
    );
  }

  // Leg 4 next: the filing NAMED its own prior art. An assertion, not an inference,
  // so it outranks both retrieval legs and needs no backend to have run.
  //
  // ONLY the id-bearing kind drives a verdict. A bare "existing <X>" phrase is NOT
  // near-1 precision: authors routinely open with "Existing <thing> is inadequate"
  // as MOTIVATION, which is the opposite of conceding prior art. (EI-7303's own body
  // opens "Existing retry/backoff logic reacts to individual failures without
  // cross-recurrence memory" — a complaint, not a concession.) The peer's worked
  // example held up precisely because it named an id: "Existing EI-7347 tooling…".
  const namedIds = (report.assertedPriorArt ?? []).filter((a) => a.kind === 'work-item-id');
  if (namedIds.length > 0) {
    const refs = namedIds.slice(0, 4).map((a) => a.ref).join(', ');
    return `AUTHOR NAMES PRIOR ART (resolve these first): ${refs}` + planNote;
  }

  const semanticNote =
    report.semanticSearched === false
      ? ' | semantic leg UNAVAILABLE'
      : report.semantic && report.semantic.length > 0
        ? ` | semantic leg (SEPARATE, not merged): ${report.semantic.length} near surface(s), top ${report.semantic[0].ref}`
        : report.semanticSearched
          ? ' | semantic leg: no near surface'
          : '';

  if (!report.searched) {
    return (
      `lexical probe UNAVAILABLE (${report.unavailableReason ?? 'unknown'}) — this is NOT evidence of absence` +
      semanticNote +
      planNote
    );
  }
  const strong = report.matches.filter((m) => m.strength === 'strong');
  if (strong.length === 0) {
    const lex =
      report.matches.length === 0
        ? `no existing surface found for ${report.terms.length} probed term(s)`
        : `only ubiquitous vocabulary matched (${report.matches.length}) — weak signal`;
    return lex + semanticNote + planNote;
  }
  const top = strong
    .slice(0, 3)
    .map((m) => `${m.term} (${m.fileCount} file${m.fileCount === 1 ? '' : 's'}, e.g. ${m.examples[0]})`)
    .join('; ');
  return `possible existing surface — ${top}` + semanticNote + planNote;
}
