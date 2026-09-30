/**
 * lexical-cursor — the LEXICAL hot loop for ambient-semantic-push-2026-07-14
 * (Phase 1: P-001 keyword pipeline + P-002 cursor), built to plan D-010.
 *
 * D-010 (owner-ratified reframe — "are we overrelying on vector search?"):
 * the ORIGINAL Phase-1 text put embeddings in the PER-TURN hot path (cursor =
 * embedding EMA, cosine scan per matcher tick). That is over-reliance — opaque
 * scores, embedding infra as a hard dependency, O(pairwise) collision scans.
 * INVERT IT. The hot loop is LEXICAL and deterministic:
 *
 *  1. MINE class-weighted keywords from each agent's self-authored journal
 *     notes (deterministic-context-carry P-012 output). Weight by class:
 *       • artifact ids  (WI-4790, P-001, D-010, plan slugs, migration 605)
 *         — HIGHEST: collision-PERFECT join keys nobody paraphrases;
 *       • paths + symbols (packages/…/foo.ts, coord:orient, computeMaxTurn)
 *         — next;
 *       • domain terms (compaction, cursor, hysteresis) — lowest.
 *  2. The CURSOR is a recency-DECAYED sparse term-weight vector (the lexical
 *     analog of the embedding EMA it replaces): a term's weight is an
 *     exponentially-decayed sum of its class-weighted appearances across the
 *     recent notes, so recent + high-class + recurring terms float to the top.
 *  3. MATCHERS score on weighted term OVERLAP (BM25-family: optional IDF from
 *     the inverted index makes a rare shared term — a specific WI id — outweigh
 *     a common one — "compaction"). The score is LEGIBLE: it comes with the
 *     shared terms, so the owner can read WHY a match fired ("shared:
 *     psu-launcher.mjs, compaction, WI-4790").
 *  4. An INVERTED INDEX (term → sessions recently emitting it) turns peer
 *     collision detection into an index lookup over sessions that share ≥1
 *     term, NOT a pairwise cosine scan of every live-session pair.
 *
 * ECHO-GUARD (D-001, unchanged under D-010): the cursor is built from the
 * agent's OWN journal notes ONLY — never pushed content, never tool output,
 * never machine-injected turns. A push about X must never make the cursor look
 * like it is about X. {@link selectCursorNotes} enforces the source filter.
 *
 * This module is the PURE, deterministic, no-LLM, no-embedding core — the same
 * pure-core / deferred-live-leg split the whole deterministic-context-carry
 * build uses. The LIVE legs ride later phases and land DEFAULT-OFF behind the
 * host seam: the coord topic delivery rail (P-003), emergent topics mined from
 * keyword clusters (Phase 4), and the OPTIONAL embedding-assisted SLOW loop
 * that proposes topic merges/aliases for the "same thing, different names"
 * caveat (D-010 §3c — embeddings become a refinement of a working lexical
 * system, never a load-bearing dependency of an unbuilt one). None of them live
 * here; this file is the reusable heart the live matchers and their tests share.
 */

/** The three keyword classes, in descending join-key strength (D-010 §1). */
export type TermClass = 'artifact-id' | 'path-or-symbol' | 'domain-term';

/** Per-class base weights. Deliberate constants (no runtime self-adaptation —
 *  carry D-001); the live matcher reads overrides from the carry P-023 config
 *  surface, this core takes them as an argument. Artifact ids dominate because
 *  they are collision-perfect; domain terms are the fuzzy floor. */
export interface ClassWeights {
  'artifact-id': number;
  'path-or-symbol': number;
  'domain-term': number;
}

export const DEFAULT_CLASS_WEIGHTS: ClassWeights = {
  'artifact-id': 3,
  'path-or-symbol': 2,
  'domain-term': 1,
};

/** One extracted keyword with its class (weight is applied at cursor build). */
export interface ClassifiedTerm {
  term: string;
  termClass: TermClass;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-001 — keyword extraction (class-weighted mining from a journal note)
// ─────────────────────────────────────────────────────────────────────────────

/** Artifact ids — the highest-value join keys. Order matters only for the
 *  human reading the source; a token matches at most one pass (span-consumed). */
const ARTIFACT_RES: RegExp[] = [
  // Dated plan slugs: deterministic-context-carry-2026-07-14, ambient-semantic-push-2026-07-14
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-\d{4}-\d{2}-\d{2}\b/g,
  // Prefixed ids: WI-4790, F-123, EI-9036, P-001, D-010 (1–3 upper alpha, dash, digits)
  /\b[A-Z]{1,3}-\d{2,}\b/g,
  // Migration numbers: "migration 605" / "migration-605" → normalized to migration-605
  /\bmigration[\s-]?\d{1,5}\b/gi,
];

/** Paths + symbols — strong, rarely-paraphrased, but not collision-perfect. */
const SYMBOL_RES: RegExp[] = [
  // File paths / filenames: a slash path or a dotted filename with a code ext.
  /\b[\w-]+(?:\/[\w.-]+)+\b/g, // has a slash: packages/operator-core/lib/foo.ts
  /\b[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|rs|py|sh|css|html|yaml|yml|toml)\b/gi, // dotted file
  // Namespaced tool names: coord:orient, work_items:checkpoint, plans:set-status
  /\b[a-z][a-z0-9_]*:[a-z][a-z0-9_-]*\b/gi,
  // camelCase / snake_case identifiers: computeMaxTurn, resolveDoorConstants, scoreCursorOverlap, some_fn
  /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g, // camelCase (a lowercase start then an uppercase hump)
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, // snake_case
];

/** Domain terms — the fuzzy floor. Lowercased content tokens, length ≥ 3,
 *  stopwords out. Internal hyphens are PRESERVED so this domain's compounds
 *  (dead-end, auto-subscribe, echo-loop, cross-agent) stay whole join keys
 *  instead of splitting into weaker halves. Mirrors intent-pivot.intentTokens'
 *  idiom, widened for the compound vocabulary. */
const DOMAIN_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*\b/gi;

/** Stopwords for the domain-term floor (superset of intent-pivot's — journal
 *  notes carry more scaffolding prose: "landed", "turn", "tests", etc. are
 *  ambient noise for a cursor, not topic signal). */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'then',
  'them', 'its', 'per', 'via', 'now', 'next', 'all', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'can', 'will', 'work', 'working', 'plan',
  'resume', 'continue', 'continuing', 'implement', 'implementing', 'landed',
  'land', 'turn', 'test', 'tests', 'tested', 'green', 'clean', 'done', 'add',
  'added', 'adds', 'fix', 'fixed', 'file', 'files', 'core', 'pure', 'left',
  'did', 'note', 'notes', 'item', 'items', 'phase', 'both', 'each', 'new',
  'over', 'they', 'their', 'when', 'what', 'which', 'made', 'make', 'using',
  'use', 'used', 'one', 'two', 'still', 'also', 'out', 'off', 'set',
]);

/** Overwrite a matched span with equal-length spaces so a later, lower-priority
 *  pass can never re-tokenize characters a higher-priority pass already claimed
 *  (a path `maxturn-sweep.ts` must not also emit the domain term `maxturn`). */
function consumeSpans(text: string, res: RegExp[], termClass: TermClass, out: ClassifiedTerm[], seen: Set<string>, normalize: (raw: string) => string | null): string {
  let residual = text;
  for (const re of res) {
    // Rebuild residual after each regex so overlapping patterns within the same
    // class also consume (dotted-file vs slash-path can overlap).
    let masked = residual;
    for (const m of residual.matchAll(re)) {
      const norm = normalize(m[0]);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        out.push({ term: norm, termClass });
      }
      // mask this span in `masked`
      const start = m.index ?? 0;
      masked = masked.slice(0, start) + ' '.repeat(m[0].length) + masked.slice(start + m[0].length);
    }
    residual = masked;
  }
  return residual;
}

const normalizeArtifact = (raw: string): string | null => {
  const t = raw.trim();
  if (/^migration[\s-]?\d+$/i.test(t)) return 'migration-' + t.replace(/[^\d]/g, '');
  // Prefixed ids upper-cased (WI-4790); dated slugs lower-cased as authored.
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? null : /-\d{4}-\d{2}-\d{2}$/.test(t) ? t.toLowerCase() : t.toUpperCase();
};
const normalizeSymbol = (raw: string): string | null => {
  const t = raw.trim();
  // A bare date fragment or a lone number is not a symbol.
  if (!t || /^\d+$/.test(t)) return null;
  return t; // identifiers/paths are case-significant — preserve verbatim
};
const normalizeDomain = (raw: string): string | null => {
  const t = raw.trim().toLowerCase();
  if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) return null;
  return t;
};

/**
 * Extract the class-weighted keyword set from ONE journal note. Deduped within
 * the note (a note that names WI-4790 twice is "about" it once — cursor weight
 * comes from recency-decayed accumulation ACROSS notes, not intra-note TF).
 * Span-consumed in priority order so every character belongs to at most one
 * term of the strongest class that claimed it. PURE.
 */
export function extractKeywords(note: string): ClassifiedTerm[] {
  if (typeof note !== 'string' || !note.trim()) return [];
  const out: ClassifiedTerm[] = [];
  const seen = new Set<string>();
  let residual = consumeSpans(note, ARTIFACT_RES, 'artifact-id', out, seen, normalizeArtifact);
  residual = consumeSpans(residual, SYMBOL_RES, 'path-or-symbol', out, seen, normalizeSymbol);
  consumeSpans(residual, [DOMAIN_RE], 'domain-term', out, seen, normalizeDomain);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Echo-guard input selection (D-001 / D-010): cursor from own journal notes only
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal journal-row shape the cursor consumes (structural — decoupled
 *  from turn-journal-store's DB row). `source` distinguishes a deliberate
 *  ⟦journal⟧ line ('agent') from the mechanical first-line fallback. */
export interface JournalNoteInput {
  note: string;
  source?: 'agent' | 'mechanical';
  flagged?: boolean;
}

/**
 * Filter journal rows down to the cursor's legitimate input (echo-guard). Keeps
 * agent-authored notes; drops the mechanical fallback by default (nobody wrote
 * it on purpose, so it is a weak topic signal). Returns notes in the SAME order
 * given — the caller supplies them newest-first for {@link buildCursor}. PURE.
 */
export function selectCursorNotes(rows: JournalNoteInput[], opts: { includeMechanical?: boolean } = {}): string[] {
  const includeMechanical = opts.includeMechanical ?? false;
  const out: string[] = [];
  for (const r of rows) {
    if (!r || typeof r.note !== 'string' || !r.note.trim()) continue;
    if (r.source === 'mechanical' && !includeMechanical) continue;
    // Honor the row's own flag, not just its source: turn-journal flags every
    // note nobody deliberately authored (today that is exactly the mechanical
    // fallback, but the field is the contract — a future flag source must not
    // silently leak into the cursor's topic signal).
    if (r.flagged && !includeMechanical) continue;
    out.push(r.note);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// P-002 — the cursor: a recency-decayed sparse term-weight vector
// ─────────────────────────────────────────────────────────────────────────────

export interface CursorTerm {
  term: string;
  termClass: TermClass;
  weight: number;
}

export interface LexicalCursor {
  sessionId: string | null;
  /** Terms, descending by weight, capped to `maxTerms` (sparse). */
  terms: CursorTerm[];
  /** term → accumulated weight (the scoring vector). */
  weightByTerm: Map<string, number>;
  /** term → class (for legible, class-aware output). */
  classByTerm: Map<string, TermClass>;
  /** How many notes fed this cursor. */
  noteCount: number;
}

export interface BuildCursorOptions {
  sessionId?: string | null;
  /** Per-note recency decay ∈ (0,1]. A note at index i (0 = newest) contributes
   *  decay^i. 1 = no decay (flat window); 0.85 default fades older notes. */
  decay?: number;
  classWeights?: ClassWeights;
  /** Cap the sparse vector to the top-weighted terms. */
  maxTerms?: number;
  /** Only consider the newest N notes (bound the window before decay). */
  maxNotes?: number;
}

export const DEFAULT_CURSOR_DECAY = 0.85;
export const DEFAULT_CURSOR_MAX_TERMS = 64;

/**
 * Build the cursor from `notes` given NEWEST FIRST. Each note's class-weighted
 * terms accumulate into a sparse term→weight vector with exponential recency
 * decay (the lexical analog of the embedding EMA it replaces). A term seen with
 * two classes across notes keeps the STRONGER class (its heavier base weight).
 * PURE — no I/O, no LLM, no embedding.
 */
export function buildCursor(notes: string[], opts: BuildCursorOptions = {}): LexicalCursor {
  const decay = clamp01(opts.decay ?? DEFAULT_CURSOR_DECAY);
  const classWeights = opts.classWeights ?? DEFAULT_CLASS_WEIGHTS;
  const maxTerms = Math.max(1, opts.maxTerms ?? DEFAULT_CURSOR_MAX_TERMS);
  const windowed = typeof opts.maxNotes === 'number' && opts.maxNotes >= 0 ? notes.slice(0, opts.maxNotes) : notes;

  const weightByTerm = new Map<string, number>();
  const classByTerm = new Map<string, TermClass>();
  let noteCount = 0;

  for (let i = 0; i < windowed.length; i += 1) {
    const note = windowed[i];
    if (typeof note !== 'string' || !note.trim()) continue;
    noteCount += 1;
    const recency = Math.pow(decay, i);
    for (const { term, termClass } of extractKeywords(note)) {
      const base = classWeights[termClass] ?? 0;
      if (base <= 0) continue;
      weightByTerm.set(term, (weightByTerm.get(term) ?? 0) + base * recency);
      // Keep the stronger class if this term has appeared as another class.
      const prior = classByTerm.get(term);
      if (prior === undefined || (classWeights[termClass] ?? 0) > (classWeights[prior] ?? 0)) {
        classByTerm.set(term, termClass);
      }
    }
  }

  const terms: CursorTerm[] = [...weightByTerm.entries()]
    .map(([term, weight]) => ({ term, weight, termClass: classByTerm.get(term) ?? 'domain-term' }))
    // Descending weight; ties broken by term for a deterministic, stable order.
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, maxTerms);

  // Re-tighten the maps to the retained (capped) terms so scoring and the
  // inverted index see exactly the sparse vector `terms` exposes.
  const keptWeight = new Map<string, number>();
  const keptClass = new Map<string, TermClass>();
  for (const t of terms) {
    keptWeight.set(t.term, t.weight);
    keptClass.set(t.term, t.termClass);
  }

  return {
    sessionId: opts.sessionId ?? null,
    terms,
    weightByTerm: keptWeight,
    classByTerm: keptClass,
    noteCount,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-002 — overlap scoring (BM25-family weighted term overlap, legible)
// ─────────────────────────────────────────────────────────────────────────────

export interface SharedTerm {
  term: string;
  termClass: TermClass;
  weightA: number;
  weightB: number;
  /** This term's contribution to the (pre-normalization) dot product. */
  contribution: number;
}

export interface CursorOverlap {
  /** Cosine of the two (optionally IDF-scaled) sparse weight vectors ∈ [0,1]. */
  score: number;
  /** Shared terms, descending by contribution — the legible "why it matched". */
  sharedTerms: SharedTerm[];
}

export interface OverlapOptions {
  /** Optional inverse-document-frequency per term (from the inverted index):
   *  a rare shared term (a specific WI id) then outweighs a common one. Omitted
   *  ⇒ plain weighted cosine. This is the BM25-family rarity leg. */
  idf?: (term: string) => number;
}

/**
 * Score the overlap of two cursors: the cosine of their sparse term-weight
 * vectors (each weight optionally IDF-scaled), returned WITH the shared terms
 * so the match is legible. Symmetric; ∈ [0,1]; 0 when either cursor is empty or
 * they share no term. PURE.
 */
export function scoreCursorOverlap(a: LexicalCursor, b: LexicalCursor, opts: OverlapOptions = {}): CursorOverlap {
  const idf = opts.idf;
  const scale = (term: string, w: number): number => (idf ? w * Math.max(0, idf(term)) : w);

  // Full-vector norms (over the idf-scaled vectors) for the cosine denominator.
  let normA = 0;
  for (const [term, w] of a.weightByTerm) { const s = scale(term, w); normA += s * s; }
  let normB = 0;
  for (const [term, w] of b.weightByTerm) { const s = scale(term, w); normB += s * s; }
  if (normA === 0 || normB === 0) return { score: 0, sharedTerms: [] };

  // Iterate the smaller cursor for the intersection.
  const [small, large] = a.weightByTerm.size <= b.weightByTerm.size ? [a, b] : [b, a];
  const sharedTerms: SharedTerm[] = [];
  let dot = 0;
  for (const [term, wSmall] of small.weightByTerm) {
    const wLarge = large.weightByTerm.get(term);
    if (wLarge === undefined) continue;
    const contribution = scale(term, wSmall) * scale(term, wLarge);
    dot += contribution;
    sharedTerms.push({
      term,
      termClass: a.classByTerm.get(term) ?? b.classByTerm.get(term) ?? 'domain-term',
      weightA: a.weightByTerm.get(term) ?? 0,
      weightB: b.weightByTerm.get(term) ?? 0,
      contribution,
    });
  }
  sharedTerms.sort((x, y) => y.contribution - x.contribution || x.term.localeCompare(y.term));
  const score = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return { score, sharedTerms };
}

/** A compact, human-legible "why it matched" line from an overlap result:
 *  `shared: WI-4790, psu-launcher.mjs, compaction`. Highest-contribution terms
 *  first, capped. D-010's legibility promise, rendered. */
export function describeOverlap(overlap: CursorOverlap, maxTerms = 5): string {
  if (overlap.sharedTerms.length === 0) return 'shared: (none)';
  return 'shared: ' + overlap.sharedTerms.slice(0, maxTerms).map((s) => s.term).join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// P-002 — inverted index: term → sessions (collision candidates by lookup)
// ─────────────────────────────────────────────────────────────────────────────

export interface InvertedIndex {
  /** term → set of sessionIds whose cursor carries it. */
  postings: Map<string, Set<string>>;
  /** sessionId → its cursor (so a candidate can be scored). */
  cursorsBySession: Map<string, LexicalCursor>;
  sessionCount: number;
  /** BM25 idf: ln(1 + (N - df + 0.5)/(df + 0.5)) — rarer terms weigh more,
   *  always ≥ 0. A term absent from the corpus has df 0 ⇒ maximal idf. */
  idf: (term: string) => number;
}

/**
 * Build the inverted index over a set of cursors (each MUST carry a sessionId;
 * cursors without one are skipped). Postings + BM25 idf; the same structure
 * makes collision detection an index lookup instead of an all-pairs scan. PURE.
 */
export function buildInvertedIndex(cursors: LexicalCursor[]): InvertedIndex {
  const postings = new Map<string, Set<string>>();
  const cursorsBySession = new Map<string, LexicalCursor>();
  for (const cursor of cursors) {
    const sid = cursor.sessionId;
    if (!sid) continue;
    cursorsBySession.set(sid, cursor);
    for (const term of cursor.weightByTerm.keys()) {
      let set = postings.get(term);
      if (!set) { set = new Set(); postings.set(term, set); }
      set.add(sid);
    }
  }
  const sessionCount = cursorsBySession.size;
  const idf = (term: string): number => {
    const df = postings.get(term)?.size ?? 0;
    return Math.log(1 + (sessionCount - df + 0.5) / (df + 0.5));
  };
  return { postings, cursorsBySession, sessionCount, idf };
}

export interface CollisionCandidate {
  sessionId: string;
  overlap: CursorOverlap;
}

export interface CollisionOptions {
  /** Do not return a candidate below this overlap score (default 0 — all that
   *  share ≥1 term). The live matcher raises this + adds hysteresis (P-004). */
  minScore?: number;
  /** Exclude this session id (the querying session itself). */
  excludeSessionId?: string;
  /** Cap the returned candidates (highest score first). */
  maxCandidates?: number;
  /** Use the index's BM25 idf in scoring (default true — rare shared ids win). */
  useIdf?: boolean;
}

/**
 * Find the sessions whose cursor collides with `cursor`, by INDEX LOOKUP: gather
 * only sessions that share ≥1 term (union of the query terms' postings), then
 * score just those — never an O(pairwise) scan of every session. Returns
 * candidates above `minScore`, highest first. This is the P-004 collision
 * matcher's pure core; the live leg adds the hysteresis, severity gating, and
 * coord delivery (all DEFAULT-OFF, later phases). PURE.
 */
export function collisionCandidates(index: InvertedIndex, cursor: LexicalCursor, opts: CollisionOptions = {}): CollisionCandidate[] {
  const minScore = opts.minScore ?? 0;
  const useIdf = opts.useIdf ?? true;
  const exclude = opts.excludeSessionId ?? cursor.sessionId ?? undefined;

  // Union of candidate sessions from the query terms' postings — the lookup.
  const candidateIds = new Set<string>();
  for (const term of cursor.weightByTerm.keys()) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    for (const sid of posting) {
      if (sid !== exclude) candidateIds.add(sid);
    }
  }

  const idfFn = useIdf ? index.idf : undefined;
  const out: CollisionCandidate[] = [];
  for (const sid of candidateIds) {
    const other = index.cursorsBySession.get(sid);
    if (!other) continue;
    const overlap = scoreCursorOverlap(cursor, other, { idf: idfFn });
    if (overlap.score > 0 && overlap.score >= minScore) out.push({ sessionId: sid, overlap });
  }
  out.sort((a, b) => b.overlap.score - a.overlap.score || a.sessionId.localeCompare(b.sessionId));
  return typeof opts.maxCandidates === 'number' ? out.slice(0, Math.max(0, opts.maxCandidates)) : out;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return DEFAULT_CURSOR_DECAY;
  if (x <= 0) return 0.0001; // a 0 decay would zero every note but the newest; keep it barely positive
  return x > 1 ? 1 : x;
}
