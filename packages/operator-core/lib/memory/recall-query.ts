/**
 * The structured recall query — context-injection-audit-2026-07-28 P-042 (F-J).
 *
 * WHY THIS EXISTS. The automatic memory-injection seam took a bare
 * `queryContext: string`, which forced ONE string to be three different things:
 * what the human said, what the agent is actually doing, and what gets issued to
 * the index. Phase 11 separates them, because the measured defect is that the
 * recall query represents the HUMAN's last utterance rather than the TURN — and
 * on a machine-injected turn (a loop fire, a wake envelope, the literal word
 * "continue") the human part is boilerplate or absent, so retrieval is asked a
 * question nobody actually asked.
 *
 * THE TWO TEXTS THIS MODULE PRODUCES (P-044 / F-L landed the second one):
 *
 *   `retrievalQueryText()`  → the COSINE leg's query. The user text ALONE, and
 *                             that is now a positive design commitment rather
 *                             than a not-yet: the cosine leg embeds its query as
 *                             ONE vector, so every identifier token in it drags
 *                             that vector off-topic (measured, D-041).
 *   `lexicalQueryText()`    → the LEXICAL leg's query. The user text PLUS a
 *                             bounded set of the agent's identifiers, which is
 *                             the leg that wins on exactly those.
 *
 * Both are QUERY composition. Per D-014 nothing here re-ranks or reorders a
 * leg's OUTPUT — reordering a fusion leg rewrites the fusion INPUT, the exact
 * trap F-D caught.
 *
 * ⚠ WHAT ROUTING SIGNALS TO THE LEXICAL LEG CAN AND CANNOT DO, because the
 * answer differs per caller and the optimistic reading is the wrong one on the
 * path that matters most. In `floored-union` fusion the lexical leg is a
 * co-equal RECALL source: a strong identifier match is ADMITTED even when the
 * cosine leg missed the row entirely. In `cosine-gated` it is a RE-RANKER only
 * — the candidate set is the cosine hits, so the lexical leg can promote the
 * on-topic record within them but can never rescue one the cosine leg dropped.
 * The operator's push path (`injectFusionMode()`) is cosine-gated. So on
 * turn-start / mid-turn injection these signals reorder the admitted set; the
 * lever that decides ADMISSION there is the cosine query, which is why P-044's
 * larger half is keeping identifiers OUT of it.
 */

/**
 * Grounded, ACTION-derived context about what the agent is actually doing.
 *
 * ⚠ EVERY FIELD IS AN IDENTIFIER OR A STORED ARTIFACT — NEVER THE AGENT'S OWN
 * PROSE OR THINKING. That exclusion is the whole design point rather than
 * timidity (P-043): prose is what creates the self-confirmation loop — the agent
 * asserts X, retrieval returns X, the agent asserts more X — whereas actions are
 * grounded in verifiable events the agent cannot talk itself into. The two are
 * cleanly separable, so v1 takes the half that carries no such risk. Whether
 * agent prose earns its place at all is deferred to P-047, to be settled on
 * bench evidence rather than a priori. Do not add a free-prose field here
 * without going through that item.
 *
 * Fields are listed in P-043's preference order.
 */
export interface AgentSignals {
  /**
   * (a) The claimed work-item / plan-item. Already structured, already scoped to
   * the agent's real task, and free to obtain — the highest-value source.
   */
  workItem?: {
    /** e.g. `WI-6635`, `EI-18881202063786528`, `P-042`. */
    id?: string;
    title?: string;
    /** The item's STORED body — authored text, not the agent's narration. */
    body?: string;
  };
  /**
   * (b) The recent tool-call trajectory, as IDENTIFIERS ONLY. These are
   * overwhelmingly what the lexical leg exists for and what cosine embedding is
   * worst at, which is why P-044 routes them there rather than into the cosine
   * query.
   */
  trajectory?: {
    /** Repo-relative file paths touched this turn. */
    paths?: readonly string[];
    /** Work-item / feature / plan-item ids referenced (`WI-…`, `EI-…`, `P-…`). */
    ids?: readonly string[];
    /** Symbol names — functions, types, tools — named in tool arguments. */
    symbols?: readonly string[];
  };
  /** (c) The file the agent is working in right now, repo-relative. */
  activeFile?: string;
}

/** A recall query, with the human part and the agent part kept separate. */
export interface RecallQuery {
  /**
   * What the human said — the ONLY thing that reached retrieval before Phase 11.
   * On the turn-start push path this is the raw submitted prompt, envelope and
   * all, which is precisely what makes P-041's origin classification free.
   */
  userText: string;
  /** Grounded agent context. OPTIONAL — see `RecallQueryInput` for why. */
  agentSignals?: AgentSignals;
  /**
   * A PRE-COMPOSED lexical-leg query, for a caller that already knows its own
   * identifier text and would lose it by round-tripping through `AgentSignals`
   * (P-044). The mid-turn endpoint is the case this exists for: its signal is a
   * tool BATCH, whose paths are frequently DIRECTORIES (`apps/operator-vite/src`
   * — the exact text D-041 measured), and the signal-derived composition below
   * reduces a path to its basename stem, which turns that directory into the
   * useless token `src`. So mid-turn hands the full derived text over verbatim
   * and keeps only the prose in `userText`.
   *
   * Wins over `agentSignals` when both are present. Same length warning as
   * `SearchOptions.lexicalQuery`: this string is SCORED against a token-count
   * normalization, so it is not a free place to put text.
   */
  lexicalText?: string;
}

/**
 * What the seam ACCEPTS. A bare string is shorthand for `{ userText }`.
 *
 * ⚠ THIS UNION IS THE DESIGN, not a compatibility shim scheduled for removal.
 * `MemoryInjectionInput` is constructed at ~14 production sites (oracle,
 * architect ×2, operator-converse, launch-profile, mcp-prelude, the memory suite
 * ×6, turn-start-memory, agent-chats, cup-wake-dossier) plus ~45 test fixtures —
 * and only THREE of them, all inside injection.ts, ever READ the field.
 * Requiring the object form would invalidate every construction site at once, in
 * files this change never touches and `test:affected` never selects: the
 * `AgentFact.confidence` / `OwnerSteering.createWakeSuppressPlans` /
 * `PipelinePosition.submodulePin` class, which bit three separate changes on
 * 2026-07-26 alone. And the string form is not merely tolerated — a chat route
 * genuinely has only user text, so those sites are CORRECT to keep passing a
 * string permanently.
 */
export type RecallQueryInput = string | RecallQuery;

/** Normalize the accepted forms to the structured one. */
export function toRecallQuery(input: RecallQueryInput): RecallQuery {
  return typeof input === 'string' ? { userText: input } : input;
}

/**
 * The COSINE leg's query text.
 *
 * ⚠ IT IGNORES `agentSignals`, and after P-044 that is the POINT rather than a
 * placeholder — do not "finish the job" by folding signals in here. The cosine
 * leg embeds this string as one vector; identifiers in it were measured
 * DILUTING that vector (D-041), which is the defect P-044 removes. Signals go to
 * `lexicalQueryText()` below.
 *
 * ⚠ DO NOT concatenate signals into `userText` at a call site either — same
 * effect by the back door, and it would additionally corrupt P-041's
 * query-shape telemetry, which records what was asked.
 */
export function retrievalQueryText(query: RecallQuery): string {
  return query.userText;
}

// ─────────────────── the lexical leg's query (P-044 / F-L) ───────────────────

/**
 * How many of each identifier class reach the lexical query.
 *
 * ⚠ THESE ARE FAR TIGHTER THAN `agent-signals.ts`'s OWN CAPS (12 paths / 8 ids /
 * 8 symbols) AND THAT IS DELIBERATE — the two caps bound different things. The
 * resolver's caps bound how much SIGNAL it carries; these bound how much of it
 * may enter a SCORED QUERY, and the scoring makes a long query actively harmful
 * rather than merely wasteful:
 *
 *  - `canonical-store.lexicalSearch` scores a row `Σ(per-token field weight) /
 *    (tokens × 3)`. The denominator is the QUERY's token count, so each extra
 *    token lowers every hit's normalized score. `minLexScore` (0.40 on the push
 *    path) is an absolute bar on that number and genuine exact-identifier
 *    matches already run 0.33–0.96, so an unbounded identifier dump does not
 *    "add signal" — it pushes real matches UNDER the admission bar and removes
 *    the hits it was meant to rescue.
 *  - `lexicalTokens` caps at LEXICAL_MAX_TOKENS = 32 and slices the TAIL, so an
 *    over-long query silently discards its own end.
 *
 * A single repo path is worth ~6-8 tokens on its own (`packages/operator-core/
 * lib/memory/injection.ts` → 6 whole + 2 sub), which is why paths contribute
 * their BASENAME here rather than the whole path: the basename is the
 * discriminative part, and it is also how the corpus tends to name a file in
 * prose. These numbers are a bounded starting point, not a tuned one — P-045 is
 * where they get measured, and D-008's lesson applies before reaching for them.
 */
export const LEXICAL_MAX_PATHS = 4;
export const LEXICAL_MAX_IDS = 4;
export const LEXICAL_MAX_SYMBOLS = 2;

/** Strip a directory prefix and one trailing extension: `a/b/injection.ts` → `injection`. */
function pathStem(p: string): string {
  const base = p.slice(p.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function pushCapped(into: string[], seen: Set<string>, value: string, cap: number): void {
  const v = value.trim();
  if (!v || seen.has(v.toLowerCase())) return;
  if (into.length >= cap) return;
  seen.add(v.toLowerCase());
  into.push(v);
}

/**
 * The identifier terms a `RecallQuery`'s signals contribute to the lexical leg,
 * most-recent-first within each class (the resolver hands them over in that
 * order and the caps keep the head).
 *
 * Ordered ids → activeFile → paths → symbols: an id is the single most
 * discriminative token this system has, and the ordering decides who survives
 * `lexicalTokens`' 32-token cap if the user text is long.
 *
 * ⚠ The work-item's TITLE and BODY are deliberately NOT included. They are
 * authored prose — the same class the lexical query's token normalization
 * punishes hardest — and `workItem.body` alone is capped at 1,200 chars
 * upstream, which would swamp both the token cap and every real hit's score.
 * Only its ID is an identifier. (Whether agent-adjacent PROSE belongs in
 * retrieval at all is P-047's question, to be settled on bench evidence.)
 */
export function agentSignalTerms(signals: AgentSignals | undefined): string[] {
  if (!signals) return [];
  const terms: string[] = [];
  const seen = new Set<string>();

  const idCap = LEXICAL_MAX_IDS;
  const wiId = signals.workItem?.id?.trim();
  if (wiId) pushCapped(terms, seen, wiId, idCap);
  for (const id of signals.trajectory?.ids ?? []) pushCapped(terms, seen, id, idCap);

  const paths: string[] = [];
  const pathSeen = new Set<string>();
  if (signals.activeFile) pushCapped(paths, pathSeen, pathStem(signals.activeFile), LEXICAL_MAX_PATHS);
  for (const p of signals.trajectory?.paths ?? []) {
    pushCapped(paths, pathSeen, pathStem(p), LEXICAL_MAX_PATHS);
  }
  terms.push(...paths);

  const symbols: string[] = [];
  const symSeen = new Set<string>();
  for (const s of signals.trajectory?.symbols ?? []) {
    pushCapped(symbols, symSeen, s, LEXICAL_MAX_SYMBOLS);
  }
  terms.push(...symbols);

  return terms;
}

/**
 * The LEXICAL leg's query text — `SearchOptions.lexicalQuery`.
 *
 * Returns `undefined` when there is nothing to add, so the caller passes no
 * override and the backend gives both legs the same string: with no agent
 * signals this path is byte-identical to pre-P-044 behaviour, which is what
 * keeps the change measurable against the P-041 baseline.
 *
 * The user text is KEPT, not replaced. A human who types a literal `WI-6512` is
 * the exact-identifier case this leg exists for, and dropping their words to
 * make room for the agent's would trade a real signal for a speculative one.
 */
export function lexicalQueryText(query: RecallQuery): string | undefined {
  const pre = query.lexicalText?.trim();
  if (pre) return pre;
  const terms = agentSignalTerms(query.agentSignals);
  if (terms.length === 0) return undefined;
  const user = query.userText.trim();
  return user ? `${user} ${terms.join(' ')}` : terms.join(' ');
}
