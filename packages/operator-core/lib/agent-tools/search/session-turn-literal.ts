/**
 * session-turn-literal.ts — the shared EXACT + FUZZY session-turn retrieval primitive and the
 * tier composer (plan session-transcript-exact-fuzzy-search-2026-09-14 P-003; design authority:
 * D-001 precedence, D-002 reuse, D-003 bounded branches, D-004 measured numbers, D-005 degrade).
 *
 * WHY THIS EXISTS. The agents-pill/HUD transcript search ran only `runHybridSearch`
 * (tokenized lexical + semantic). A literal that lives INSIDE a lexeme — `furnishedfinder` in
 * `www.furnishedfinder.com` — is unreachable by the dictionary leg and was found only by a
 * newest-50k-row window fill, so older exact hits vanished. This module adds two index-backed
 * tiers that run BEFORE the hybrid legs and are never displaced by them:
 *
 *   1. EXACT — `lower(text) LIKE '%literal%'`, served by the trigram GIN
 *      (session_turns_text_trgm_idx). Workspace/visibility/time predicates sit INSIDE the branch
 *      (D-003) so the candidate cap bounds the work, not the final sort.
 *   2. FUZZY — vocabulary expansion: each query token >= 5 chars is expanded through
 *      session_turn_vocab (trigram neighbours, similarity >= 0.45), the expanded phrase variants
 *      are then resolved through the SAME exact predicate. (A whole-corpus word_similarity scan
 *      was measured at >20 s and rejected in D-004.)
 *
 * `composeSessionTurnTiers` is the PURE half: exact > fuzzy > hybrid remainder, stable dedup on
 * the turn key, reserved slots, honest provenance. Wiring it into the route / sessions:search is
 * P-004's job; nothing here touches the HTTP surface.
 *
 * D-005: a tier whose index/vocabulary is absent is SKIPPED and reported in the receipt — it
 * must never degrade into a sequential scan. Every branch also carries a hard deadline
 * (`SET LOCAL statement_timeout`); a timeout yields a bounded empty/partial result plus a
 * `deadline` marker, never a hang.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { hitProvenance, type MatchProvenance, type SearchFilters, type SearchHit } from '@papercusp/search';
import { OWNER_CANDIDATE_TURN_VERDICTS } from '../../turn-provenance/turn-ref';
import { restrictedTurnSql } from '../../personal-vault/transcript-exclusion';
import {
  readSessionSearchReadiness,
  sessionSearchTierAvailability,
  SESSION_TURN_WINDOW_MAX_LITERAL,
  type SessionSearchReadiness,
} from '../../session-search-index-build';
import { parseTurnRef } from '../sessions/_shared';

// ─────────────────────────────────── policy ───────────────────────────────────

/**
 * One policy object, echoed verbatim in the receipt, so a reader can see which numbers a result
 * was produced under. The values are the D-004 measurements (1,355,857-row corpus); re-measure
 * if the corpus grows by more than ~2x.
 */
export interface SessionTurnLiteralPolicy {
  /** Total candidate slots a composed result may fill (the engine's per-search pool). */
  resultSlots: number;
  /** Slots reserved for exact hits — never displaced by fuzzy/lexical/semantic. */
  exactReserve: number;
  /** Slots reserved for fuzzy hits. */
  fuzzyReserve: number;
  /** Candidate rows each branch may materialise before ordering/limit (bounds the work). */
  candidateCap: number;
  /** A literal shorter than this skips the trigram branch (2-char literals seq-scanned at 15.65 s). */
  exactMinLiteralChars: number;
  exactDeadlineMs: number;
  /** Tokens shorter than this are not expanded ('plam' is 4 chars). */
  fuzzyMinTokenChars: number;
  fuzzyMaxTokenChars: number;
  /** pg_trgm.similarity_threshold applied to vocabulary neighbours. */
  fuzzySimilarity: number;
  /** Neighbours kept per expanded token (similarity desc, then ndoc desc). */
  fuzzyTopK: number;
  /** At most this many query tokens are expanded (each multiplies the variant list). */
  fuzzyMaxTokens: number;
  fuzzyExpandDeadlineMs: number;
  /** TOTAL budget for resolving every fuzzy variant (the sum across the isolated variant statements). */
  fuzzyResolveDeadlineMs: number;
  /**
   * Cap for ONE fuzzy variant's statement (WI-10004501). A variant is resolved in its own statement, so one
   * whose trigram candidates are mostly false positives (lossy recheck, measured 5.8 s for 'finished finder')
   * times out ALONE and the other variants' hits are still returned. Cost tracks the trigram posting
   * intersection, NOT the neighbour's document frequency, so a df ceiling cannot bound it.
   */
  fuzzyVariantDeadlineMs: number;
  /**
   * Share of `exactDeadlineMs` the trigram route (windows or legacy) may spend before the exact tier falls
   * back to the recency walk (WI-10005294). A literal present in most turns ('the', 'papercusp') cannot be
   * resolved by ANY trigram index inside the deadline, so the remainder is spent walking newest-first
   * instead of returning an empty deadline.
   */
  recencyTrigramShare: number;
  /** Span of the newest recency-walk slice; each older slice spans `recencySliceGrowth` times the previous. */
  recencyFirstSliceMs: number;
  recencySliceGrowth: number;
  /** Characters of context kept each side of the matched literal in the excerpt. */
  snippetRadius: number;
}

export const SESSION_TURN_LITERAL_POLICY: SessionTurnLiteralPolicy = {
  resultSlots: 150,
  exactReserve: 100,
  fuzzyReserve: 50,
  candidateCap: 300,
  exactMinLiteralChars: 3,
  exactDeadlineMs: 2000,
  fuzzyMinTokenChars: 5,
  fuzzyMaxTokenChars: 40,
  fuzzySimilarity: 0.45,
  fuzzyTopK: 8,
  fuzzyMaxTokens: 3,
  fuzzyExpandDeadlineMs: 1000,
  fuzzyResolveDeadlineMs: 2000,
  fuzzyVariantDeadlineMs: 500,
  recencyTrigramShare: 0.6,
  recencyFirstSliceMs: 20 * 60_000,
  recencySliceGrowth: 4,
  snippetRadius: 160,
};

// ─────────────────────────────────── types ───────────────────────────────────

export interface SessionTurnLiteralQuery {
  workspaceId: string;
  /** The query as typed (trimmed by the caller or here). Matched as ONE contiguous literal. */
  query: string;
  /** harness_slug narrowing — same meaning as the session_turn source's `scopeFilter`. */
  scopeFilter?: string | null;
  /** The shared filter bag — identical semantics to the session_turn source (filter parity). */
  filters?: SearchFilters;
}

/** The precedence tiers. `both` = a hybrid hit that BOTH lexical and semantic legs returned. */
export type SessionTurnTier = 'exact' | 'fuzzy' | 'lexical' | 'semantic' | 'both';

export interface FuzzyMatch {
  /** The query token that was expanded. */
  token: string;
  /** The vocabulary word the turn actually contains. */
  word: string;
  similarity: number;
}

export interface SessionTurnLiteralHit {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
  speaker: string | null;
  owner: string | null;
  harnessSlug: string | null;
  ts: string | null;
  tier: 'exact' | 'fuzzy';
  /** Excerpt in the session_turn source's `[speaker owner ts] text` shape, centred on the match. */
  excerpt: string;
  /** Same excerpt with the matched run wrapped in <mark>. */
  highlight: string;
  /**
   * The lowercased literal this turn ACTUALLY contains — the exact needle, or the fuzzy phrase
   * variant (e.g. `plan` for a typed `plam`). A deep-link into the transcript must anchor on THIS,
   * not on the typed query: the viewer corroborates its anchor by requiring the focused message to
   * contain the term (SessionChatModal.focusIndex), so a fuzzy hit anchored on the typo falls back
   * to the transcript tail. Absent only when the SQL branch returned no needle.
   */
  focusTerm?: string;
  /** Present on fuzzy hits only. */
  fuzzy?: FuzzyMatch;
}

export type TierStatus = 'ran' | 'skipped' | 'deadline' | 'error';

export interface TierReceipt {
  status: TierStatus;
  /** Why the tier did not run (readiness, literal too short, nothing expandable, ...). */
  skipReason?: string;
  returned: number;
  elapsedMs: number;
  error?: string;
  /**
   * Exact only (WI-10005294): the trigram route hit its deadline, so the hits come from the recency walk
   * instead. `completeSince` = every matching turn with `ts >= completeSince` is in `returned`; older matches
   * may exist. Absent on a complete result.
   */
  partial?: boolean;
  completeSince?: string;
  /** Fuzzy only: what each expanded token was expanded to. */
  expanded?: Array<{ token: string; words: Array<{ word: string; similarity: number; ndoc: number }> }>;
  /** Fuzzy only: variants that hit their own deadline (or the total budget) and so contributed no hits. */
  timedOutVariants?: string[];
}

export interface SessionTurnLiteralReceipt {
  policy: SessionTurnLiteralPolicy;
  exact: TierReceipt;
  fuzzy: TierReceipt;
}

export interface SessionTurnLiteralResult {
  exact: SessionTurnLiteralHit[];
  fuzzy: SessionTurnLiteralHit[];
  receipt: SessionTurnLiteralReceipt;
}

// ─────────────────────────────── pure helpers ───────────────────────────────

/** Escape LIKE metacharacters (`\`, `%`, `_`) so the query is matched literally. */
export function escapeLikeLiteral(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercased alphanumeric tokens of the query that are eligible for vocabulary expansion. */
export function expandableTokens(
  query: string,
  policy: Pick<SessionTurnLiteralPolicy, 'fuzzyMinTokenChars' | 'fuzzyMaxTokenChars' | 'fuzzyMaxTokens'> = SESSION_TURN_LITERAL_POLICY,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < policy.fuzzyMinTokenChars || raw.length > policy.fuzzyMaxTokenChars) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= policy.fuzzyMaxTokens) break;
  }
  return out;
}

/** The query with `token` (whole-token occurrences only) replaced by `word`, lowercased. */
export function fuzzyVariant(queryLower: string, token: string, word: string): string {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(token)}(?![\\p{L}\\p{N}])`, 'gu');
  return queryLower.replace(re, word);
}

/** `<mark>` the first case-insensitive occurrence of `needle` in `text`; text unchanged if absent. */
export function markFirst(text: string, needle: string): string {
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return `${text.slice(0, at)}<mark>${text.slice(at, at + needle.length)}</mark>${text.slice(at + needle.length)}`;
}

// ───────────────────────────── retrieval (SQL) ─────────────────────────────

type Sql = postgres.Sql;

export interface LiteralRow {
  source_kind: string;
  session_id: string;
  turn_idx: number;
  speaker: string | null;
  owner: string | null;
  harness_slug: string | null;
  ts: string | null;
  /** epoch seconds of COALESCE(ts, ingested_at) — the newest-first sort key when variant rows are merged. */
  sort_epoch: number | null;
  needle: string | null;
  needle_ord: number | null;
  snippet: string | null;
}

const isStatementTimeout = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === '57014';

/**
 * The windows-route lookup for one lowered literal (P-011). `windowPattern` is the escaped
 * `%prefix%` matched against `session_turn_windows.wtext`; the prefix is the literal's first
 * `SESSION_TURN_WINDOW_MAX_LITERAL` characters (counted in code points, as PostgreSQL counts them) so
 * the lookup stays recall-complete for any literal length. `verify` = the literal was longer than the
 * prefix, so the parent turn must still be checked against the FULL literal.
 */
export interface WindowsLookup {
  windowPattern: string;
  verify: boolean;
}

export function windowsLookupFor(loweredLiteral: string): WindowsLookup {
  const chars = Array.from(loweredLiteral);
  const verify = chars.length > SESSION_TURN_WINDOW_MAX_LITERAL;
  const prefix = verify ? chars.slice(0, SESSION_TURN_WINDOW_MAX_LITERAL).join('') : loweredLiteral;
  return { windowPattern: `%${escapeLikeLiteral(prefix)}%`, verify };
}

type Tx = postgres.TransactionSql;

/**
 * The scope + filter predicates every exact-tier query shape applies to `harness_shared.session_turns`
 * (the trigram branch's candidate CTE AND the recency walk) — one definition so the two can never disagree
 * about which turns a filter admits. Includes the D-006 reader rule, fail closed (WI-10005570): a turn an
 * agent recorded inside one of its disclosure windows matches only when `filters.readerIds` names that agent.
 */
function turnScopePredicate(tx: Tx, q: SessionTurnLiteralQuery) {
  const f = q.filters ?? {};
  const owners = f.owners && f.owners.length ? f.owners : null;
  return tx`(workspace_id = ${q.workspaceId} OR workspace_id = 'default')
             AND (${q.scopeFilter ?? null}::text IS NULL OR harness_slug = ${q.scopeFilter ?? null})
             AND (${owners}::text[] IS NULL OR owner = ANY(${owners}::text[]))
             AND (${f.speaker ?? null}::text IS NULL OR speaker = ${f.speaker ?? null})
             AND (${f.turnOrigin ?? null}::text IS NULL OR turn_origin_verdict = ${f.turnOrigin ?? null})
             AND (${f.ownerOnly ?? null}::boolean IS NULL OR NOT ${f.ownerOnly ?? null} OR turn_origin_verdict IN ('owner-typed', 'owner-dialog'))
             AND (${f.ownerCandidates ?? null}::boolean IS NULL OR NOT ${f.ownerCandidates ?? null} OR turn_origin_verdict = ANY(${OWNER_CANDIDATE_TURN_VERDICTS as string[]}::text[]))
             AND (${f.sessionId ?? null}::text IS NULL OR session_id = ${f.sessionId ?? null})
             AND (${f.sourceKind ?? null}::text IS NULL OR source_kind = ${f.sourceKind ?? null})
             AND (${f.since ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) >= ${f.since ?? null}::timestamptz)
             AND (${f.until ?? null}::timestamptz IS NULL OR COALESCE(ts, ingested_at) < ${f.until ?? null}::timestamptz)
             AND NOT ${restrictedTurnSql(tx as unknown as Parameters<typeof restrictedTurnSql>[0], 'session_turns', f.readerIds ?? []) as never}`;
}

// ─────────────────────── recency walk (WI-10005294, D-015) ───────────────────────

/** A time slice of `session_turns.ts`: `loMs <= ts < hiMs`; a null bound is open. */
export interface RecencySlice {
  loMs: number | null;
  hiMs: number | null;
}

/** The oldest slice reaches back this far, then its lower bound opens (a stale or skewed `ts` is still found). */
const RECENCY_WALK_HORIZON_MS = 400 * 24 * 3_600_000;

/**
 * Newest-first slices that tile all of time with no gap and no overlap: the first is open above (catches a
 * future-dated or clock-skewed turn) and spans `firstSliceMs`; each older slice spans `growth` times the
 * previous; the last is open below. Geometric growth bounds the total work at a small multiple of the last
 * slice walked, while the first slices stay small enough that a ubiquitous literal fills its limit inside one
 * of them.
 */
export function recencySlices(nowMs: number, firstSliceMs: number, growth: number): RecencySlice[] {
  const first = Math.max(1, Math.floor(firstSliceMs));
  const g = Math.max(1.5, growth);
  const slices: RecencySlice[] = [];
  let hi: number | null = null;
  let lo = nowMs - first;
  let span = first;
  for (;;) {
    if (nowMs - lo >= RECENCY_WALK_HORIZON_MS) {
      slices.push({ loMs: null, hiMs: hi });
      return slices;
    }
    slices.push({ loMs: lo, hiMs: hi });
    hi = lo;
    span = Math.ceil(span * g);
    lo = hi - span;
  }
}

export interface RecencyWalk {
  rows: LiteralRow[];
  /** `filled` = `limit` rows found (the newest `limit` matches); `exhausted` = every slice ran; `timeout` = budget spent. */
  status: 'filled' | 'exhausted' | 'timeout';
  /** Lower bound (epoch ms) of the oldest slice that COMPLETED, or null when no slice completed (or all did). */
  completeSinceMs: number | null;
}

/**
 * Walk `session_turns` newest-first in time slices, verifying the literal per turn with `position()` — a
 * predicate no trigram index serves, so the planner cannot pick the lossy GIN that makes a common literal
 * slow — and stop at `limit` rows or the budget. Cost tracks turns walked, not the literal's trigram
 * posting list, which is what makes it the right fallback when the trigram route times out. Ordering is by
 * `ts` (the indexed column); a turn with a NULL `ts` is not walked.
 */
export async function runRecencyWalk(
  sql: Sql,
  q: SessionTurnLiteralQuery,
  needle: string,
  limit: number,
  budgetMs: number,
  policy: SessionTurnLiteralPolicy,
  slices: readonly RecencySlice[] = recencySlices(Date.now(), policy.recencyFirstSliceMs, policy.recencySliceGrowth),
): Promise<RecencyWalk> {
  const t0 = Date.now();
  const radius = policy.snippetRadius;
  const rows: LiteralRow[] = [];
  let completeSinceMs: number | null = null;
  for (const slice of slices) {
    const remaining = Math.floor(budgetMs - (Date.now() - t0));
    if (remaining < 1) return { rows, status: 'timeout', completeSinceMs };
    const want = limit - rows.length;
    try {
      const part = await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL statement_timeout = ${remaining}`);
        return (await tx`
          SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug,
                 ts::text AS ts, extract(epoch FROM ts)::float8 AS sort_epoch,
                 ${needle}::text AS needle, 1 AS needle_ord,
                 substr(text, GREATEST(position(${needle} in lower(text)) - ${radius}, 1), ${radius * 2} + length(${needle})) AS snippet
            FROM harness_shared.session_turns
           WHERE ${turnScopePredicate(tx, q)}
             AND (${slice.loMs === null ? null : new Date(slice.loMs).toISOString()}::timestamptz IS NULL OR ts >= ${slice.loMs === null ? null : new Date(slice.loMs).toISOString()}::timestamptz)
             AND (${slice.hiMs === null ? null : new Date(slice.hiMs).toISOString()}::timestamptz IS NULL OR ts < ${slice.hiMs === null ? null : new Date(slice.hiMs).toISOString()}::timestamptz)
             AND position(${needle} in lower(text)) > 0
           ORDER BY session_turns.ts DESC
           LIMIT ${want}
        `) as unknown as LiteralRow[];
      });
      rows.push(...part);
      completeSinceMs = slice.loMs;
      if (rows.length >= limit) return { rows, status: 'filled', completeSinceMs };
    } catch (err) {
      if (isStatementTimeout(err)) return { rows, status: 'timeout', completeSinceMs };
      throw err;
    }
  }
  return { rows, status: 'exhausted', completeSinceMs: null };
}

/**
 * ONE index-served literal branch: scope + filter predicates INSIDE the branch, a MATERIALIZED
 * candidate cap, then newest-first. `likePatterns` are already-escaped, already-lowercased
 * `%literal%` patterns; one pattern is a plain LIKE (the exact tier), several is LIKE ANY (the
 * fuzzy variants — the planner turns it into a BitmapOr over the same trigram GIN).
 */
async function runLiteralBranch(
  sql: Sql,
  q: SessionTurnLiteralQuery,
  likePatterns: readonly string[],
  needles: readonly string[],
  limit: number,
  deadlineMs: number,
  policy: SessionTurnLiteralPolicy,
  windows?: WindowsLookup,
): Promise<{ rows: LiteralRow[]; deadline: boolean }> {
  const f = q.filters ?? {};
  const radius = policy.snippetRadius;
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(deadlineMs))}`);
      // Legacy route: the whole-turn trigram predicate. Windows route (P-011): the window GIN already
      // proved the literal's (<= 65-char) prefix occurs in the turn, so the parent-turn predicate is only
      // re-checked when the literal was longer than one window overlap (prefix-filtered).
      const match = windows
        ? windows.verify
          ? tx`lower(text) LIKE ${likePatterns[0]!}`
          : tx`TRUE`
        : likePatterns.length === 1
          ? tx`lower(text) LIKE ${likePatterns[0]!}`
          : tx`lower(text) LIKE ANY (${likePatterns as unknown as string[]}::text[])`;
      // The windows candidate set: turns having ANY window that contains the literal, resolved BEFORE the
      // parent-turn predicates. Per-window recheck is the lever: a 512-char window costs ~8 us to recheck
      // where a whole turn (up to 8000 chars) costs ~80 us, and a window trigram match is ~20x rarer.
      const hitCte = windows
        ? tx`hit AS MATERIALIZED (
          SELECT DISTINCT w.workspace_id, w.source_kind, w.session_id, w.turn_idx
            FROM harness_shared.session_turn_windows w
           WHERE (w.workspace_id = ${q.workspaceId} OR w.workspace_id = 'default')
             AND (${f.sessionId ?? null}::text IS NULL OR w.session_id = ${f.sessionId ?? null})
             AND (${f.sourceKind ?? null}::text IS NULL OR w.source_kind = ${f.sourceKind ?? null})
             AND w.wtext LIKE ${windows.windowPattern}
        ),`
        : tx``;
      const fromTurns = windows
        ? tx`harness_shared.session_turns JOIN hit USING (workspace_id, source_kind, session_id, turn_idx)`
        : tx`harness_shared.session_turns`;
      return (await tx`
        WITH ${hitCte} cand AS MATERIALIZED (
          SELECT source_kind, session_id, turn_idx, speaker, owner, harness_slug, ts, ingested_at, text
            FROM ${fromTurns}
           WHERE ${turnScopePredicate(tx, q)}
             AND ${match}
           LIMIT ${policy.candidateCap}
        )
        SELECT c.source_kind, c.session_id, c.turn_idx, c.speaker, c.owner, c.harness_slug,
               c.ts::text AS ts, extract(epoch FROM COALESCE(c.ts, c.ingested_at))::float8 AS sort_epoch,
               m.needle, m.ord AS needle_ord,
               substr(c.text, GREATEST(m.pos - ${radius}, 1), ${radius * 2} + length(m.needle)) AS snippet
          FROM cand c
          JOIN LATERAL (
            SELECT n.needle, n.ord, position(n.needle in lower(c.text)) AS pos
              FROM unnest(${needles as unknown as string[]}::text[]) WITH ORDINALITY AS n(needle, ord)
             WHERE position(n.needle in lower(c.text)) > 0
             ORDER BY n.ord LIMIT 1
          ) m ON true
         ORDER BY COALESCE(c.ts, c.ingested_at) DESC
         LIMIT ${limit}
      `) as unknown as LiteralRow[];
    });
    return { rows, deadline: false };
  } catch (err) {
    if (isStatementTimeout(err)) return { rows: [], deadline: true };
    throw err;
  }
}

function toHit(
  r: LiteralRow,
  tier: 'exact' | 'fuzzy',
  fuzzy?: FuzzyMatch,
): SessionTurnLiteralHit {
  const snippet = (r.snippet ?? '').replace(/\s+/g, ' ');
  const head = `[${r.speaker ?? 'unknown'}${r.owner ? ` ${r.owner}` : ''}${r.ts ? ` ${r.ts}` : ''}] `;
  return {
    sourceKind: r.source_kind,
    sessionId: r.session_id,
    turnIdx: r.turn_idx,
    speaker: r.speaker,
    owner: r.owner,
    harnessSlug: r.harness_slug,
    ts: r.ts,
    tier,
    excerpt: head + snippet,
    highlight: markFirst(snippet, r.needle ?? ''),
    ...(r.needle ? { focusTerm: r.needle } : {}),
    ...(fuzzy ? { fuzzy } : {}),
  };
}

/**
 * The exact tier. Caller has already established readiness; this never checks it. `route` is the
 * route readiness chose (`sessionSearchTierAvailability(...).exact.route`): `windows` resolves the
 * literal through the per-window trigram index (bounded latency for common literals), `legacy` (the
 * default) through the whole-turn trigram index.
 */
export async function retrieveSessionTurnExact(
  sql: Sql,
  q: SessionTurnLiteralQuery,
  policy: SessionTurnLiteralPolicy = SESSION_TURN_LITERAL_POLICY,
  route: 'windows' | 'legacy' = 'legacy',
): Promise<{ hits: SessionTurnLiteralHit[]; deadline: boolean; partial?: { completeSince: string | null } }> {
  const literal = q.query.trim();
  const lowered = literal.toLowerCase();
  const limit = policy.exactReserve + policy.fuzzyReserve;
  const t0 = Date.now();
  // The trigram route gets a share of the budget; a literal present in most turns cannot finish inside it.
  const trigramBudgetMs = Math.max(1, Math.floor(policy.exactDeadlineMs * policy.recencyTrigramShare));
  const { rows, deadline } = await runLiteralBranch(
    sql, q, [`%${escapeLikeLiteral(lowered)}%`], [lowered], limit, trigramBudgetMs, policy,
    route === 'windows' ? windowsLookupFor(lowered) : undefined,
  );
  if (!deadline) return { hits: rows.map((r) => toHit(r, 'exact')), deadline: false };
  // WI-10005294 (D-015): never answer a deadline with nothing when matches exist. Spend the rest of the
  // budget walking newest-first; the first `limit` verified hits ARE the newest `limit` matches, so a filled
  // (or exhausted) walk is a complete answer, and a timed-out walk is a bounded PARTIAL with an honest marker.
  const walk = await runRecencyWalk(sql, q, lowered, limit, policy.exactDeadlineMs - (Date.now() - t0), policy);
  const hits = walk.rows.map((r) => toHit(r, 'exact'));
  if (walk.status !== 'timeout') return { hits, deadline: false };
  return {
    hits,
    deadline: true,
    partial: { completeSince: walk.completeSinceMs === null ? null : new Date(walk.completeSinceMs).toISOString() },
  };
}

interface Neighbour { word: string; similarity: number; ndoc: number }

/** Vocabulary neighbours of one token (workspace + the host-global 'default' vocabulary). */
async function vocabNeighbours(
  sql: Sql,
  workspaceId: string,
  token: string,
  deadlineMs: number,
  policy: SessionTurnLiteralPolicy,
): Promise<{ words: Neighbour[]; deadline: boolean }> {
  try {
    const words = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(deadlineMs))}`);
      await tx`SELECT set_config('pg_trgm.similarity_threshold', ${String(policy.fuzzySimilarity)}, true)`;
      return (await tx`
        SELECT word, max(similarity(word, ${token}))::float8 AS similarity, max(ndoc)::int AS ndoc
          FROM harness_shared.session_turn_vocab
         WHERE workspace_id = ANY(${[workspaceId, 'default']}::text[])
           AND word % ${token} AND word <> ${token}
         GROUP BY word
         ORDER BY similarity DESC, ndoc DESC, word
         LIMIT ${policy.fuzzyTopK}
      `) as unknown as Neighbour[];
    });
    return { words, deadline: false };
  } catch (err) {
    if (isStatementTimeout(err)) return { words: [], deadline: true };
    throw err;
  }
}

/**
 * Order fuzzy variants BEST-SIMILARITY FIRST and collapse duplicate texts onto their best match
 * (WI-10004501 / D-009): the variant list is consumed front-to-back under a total budget, so the tail
 * the budget drops must be the LEAST similar. The sort is stable (ties keep generation order) and a
 * text produced by several (token, word) pairs keeps the first — i.e. highest-similarity — match.
 */
export function orderFuzzyVariants<M extends { similarity: number }>(
  variants: ReadonlyArray<{ text: string; match: M }>,
): { texts: string[]; byText: Map<string, M> } {
  const sorted = [...variants].sort((a, b) => b.match.similarity - a.match.similarity);
  const byText = new Map<string, M>();
  for (const v of sorted) if (!byText.has(v.text)) byText.set(v.text, v.match);
  return { texts: [...byText.keys()], byText };
}

/**
 * Resolve fuzzy variants ISOLATED (WI-10004501): `run` executes ONE variant under `deadlineMs`; a variant
 * that times out is recorded and skipped, never allowed to zero the others. `variants` are best-similarity
 * first, so on budget exhaustion the dropped tail is the least likely. Rows merge newest-first
 * (`sort_epoch`), a turn matched by several variants keeps the EARLIEST (best-similarity) one's row.
 * Pure over `run` + `now`, so the isolation contract is unit-testable without a database.
 */
export async function resolveVariantsIsolated(
  variants: readonly string[],
  run: (variant: string, deadlineMs: number) => Promise<{ rows: LiteralRow[]; deadline: boolean }>,
  opts: { limit: number; totalDeadlineMs: number; variantDeadlineMs: number; now?: () => number },
): Promise<{ rows: LiteralRow[]; deadline: boolean; timedOut: string[] }> {
  const now = opts.now ?? Date.now;
  const start = now();
  const timedOut: string[] = [];
  const byTurn = new Map<string, LiteralRow>();
  for (let i = 0; i < variants.length; i++) {
    const remaining = opts.totalDeadlineMs - (now() - start);
    if (remaining < 1) {
      timedOut.push(...variants.slice(i)); // total budget spent: the rest never ran
      break;
    }
    const variant = variants[i]!;
    const r = await run(variant, Math.min(opts.variantDeadlineMs, remaining));
    if (r.deadline) {
      timedOut.push(variant);
      continue;
    }
    for (const row of r.rows) {
      const key = `${row.source_kind}\u0000${row.session_id}\u0000${row.turn_idx}`;
      if (!byTurn.has(key)) byTurn.set(key, row);
    }
  }
  const rows = [...byTurn.values()]
    .sort((a, b) => (b.sort_epoch ?? -Infinity) - (a.sort_epoch ?? -Infinity))
    .slice(0, opts.limit);
  return { rows, deadline: timedOut.length > 0, timedOut };
}

/** The fuzzy tier (vocabulary expansion, then the exact predicate). Readiness is the caller's. */
export async function retrieveSessionTurnFuzzy(
  sql: Sql,
  q: SessionTurnLiteralQuery,
  policy: SessionTurnLiteralPolicy = SESSION_TURN_LITERAL_POLICY,
): Promise<{
  hits: SessionTurnLiteralHit[];
  deadline: boolean;
  expanded: NonNullable<TierReceipt['expanded']>;
  timedOutVariants: string[];
}> {
  const lowered = q.query.trim().toLowerCase();
  const tokens = expandableTokens(lowered, policy);
  const expanded: NonNullable<TierReceipt['expanded']> = [];
  const variants: Array<{ text: string; match: FuzzyMatch }> = [];
  let deadline = false;
  for (const token of tokens) {
    const { words, deadline: d } = await vocabNeighbours(sql, q.workspaceId, token, policy.fuzzyExpandDeadlineMs, policy);
    if (d) deadline = true;
    expanded.push({ token, words });
    for (const w of words) {
      const text = fuzzyVariant(lowered, token, w.word);
      if (text !== lowered) variants.push({ text, match: { token, word: w.word, similarity: w.similarity } });
    }
  }
  if (variants.length === 0) return { hits: [], deadline, expanded, timedOutVariants: [] };

  // Best-similarity variant first: it runs first and wins a turn that several variants contain.
  const { texts, byText } = orderFuzzyVariants(variants);
  // One statement per variant: a lossy-trigram variant (73k candidates / 0 true matches, 5.8 s on the real
  // corpus) times out alone instead of zeroing the batch (WI-10004501).
  const resolved = await resolveVariantsIsolated(
    texts,
    (text, deadlineMs) => runLiteralBranch(sql, q, [`%${escapeLikeLiteral(text)}%`], [text], policy.fuzzyReserve, deadlineMs, policy),
    { limit: policy.fuzzyReserve, totalDeadlineMs: policy.fuzzyResolveDeadlineMs, variantDeadlineMs: policy.fuzzyVariantDeadlineMs },
  );
  return {
    hits: resolved.rows.map((r) => toHit(r, 'fuzzy', r.needle ? byText.get(r.needle) : undefined)),
    deadline: deadline || resolved.deadline,
    expanded,
    timedOutVariants: resolved.timedOut,
  };
}

/**
 * Run both literal tiers under the D-005 readiness rules. A tier whose index/vocabulary is not
 * ready is SKIPPED (never a seq scan) and says why; a failing tier is fail-soft — it reports
 * `error` and the other tier / the hybrid legs still serve the query.
 */
export async function retrieveSessionTurnLiteralTiers(
  sql: Sql,
  q: SessionTurnLiteralQuery,
  opts: { policy?: SessionTurnLiteralPolicy; readiness?: SessionSearchReadiness } = {},
): Promise<SessionTurnLiteralResult> {
  const policy = opts.policy ?? SESSION_TURN_LITERAL_POLICY;
  const literal = q.query.trim();
  const workspaces = [q.workspaceId, 'default'];
  const skipped = (reason: string): TierReceipt => ({ status: 'skipped', skipReason: reason, returned: 0, elapsedMs: 0 });

  let availability: ReturnType<typeof sessionSearchTierAvailability>;
  try {
    const readiness = opts.readiness ?? (await readSessionSearchReadiness(sql, workspaces));
    availability = sessionSearchTierAvailability(readiness, workspaces);
  } catch (err) {
    const why = `readiness-unreadable: ${(err as Error).message}`;
    return { exact: [], fuzzy: [], receipt: { policy, exact: skipped(why), fuzzy: skipped(why) } };
  }

  const runExact = async (): Promise<{ hits: SessionTurnLiteralHit[]; receipt: TierReceipt }> => {
    if (literal.length < policy.exactMinLiteralChars) return { hits: [], receipt: skipped('literal-too-short') };
    if (!availability.exact.available) return { hits: [], receipt: skipped(availability.exact.skipReason ?? 'exact-unavailable') };
    const t0 = Date.now();
    try {
      const { hits, deadline, partial } = await retrieveSessionTurnExact(sql, q, policy, availability.exact.route ?? 'legacy');
      return {
        hits,
        receipt: {
          status: deadline ? 'deadline' : 'ran',
          returned: hits.length,
          elapsedMs: Date.now() - t0,
          ...(partial ? { partial: true, ...(partial.completeSince ? { completeSince: partial.completeSince } : {}) } : {}),
        },
      };
    } catch (err) {
      return { hits: [], receipt: { status: 'error', returned: 0, elapsedMs: Date.now() - t0, error: (err as Error).message } };
    }
  };
  const runFuzzy = async (): Promise<{ hits: SessionTurnLiteralHit[]; receipt: TierReceipt }> => {
    if (!availability.fuzzy.available) return { hits: [], receipt: skipped(availability.fuzzy.skipReason ?? 'fuzzy-unavailable') };
    if (expandableTokens(literal, policy).length === 0) return { hits: [], receipt: skipped('no-expandable-token') };
    const t0 = Date.now();
    try {
      const { hits, deadline, expanded, timedOutVariants } = await retrieveSessionTurnFuzzy(sql, q, policy);
      return {
        hits,
        receipt: {
          status: deadline ? 'deadline' : 'ran',
          returned: hits.length,
          elapsedMs: Date.now() - t0,
          expanded,
          ...(timedOutVariants.length > 0 ? { timedOutVariants } : {}),
        },
      };
    } catch (err) {
      return { hits: [], receipt: { status: 'error', returned: 0, elapsedMs: Date.now() - t0, error: (err as Error).message } };
    }
  };

  const [exact, fuzzy] = await Promise.all([runExact(), runFuzzy()]);
  return { exact: exact.hits, fuzzy: fuzzy.hits, receipt: { policy, exact: exact.receipt, fuzzy: fuzzy.receipt } };
}

// ───────────────────────────── composition (pure) ─────────────────────────────

/** One turn in the composed result, with the tier that WON it and every other tier that found it. */
export interface TieredTurnHit {
  /** `<sourceKind>:<sessionId>:<turnIdx>` — the dedup key. */
  key: string;
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
  /** The highest-precedence tier that returned this turn. */
  tier: SessionTurnTier;
  /** Lower-precedence tiers that ALSO returned it (never includes `tier`). Honest provenance. */
  alsoMatchedBy: SessionTurnTier[];
  excerpt: string;
  highlight: string;
  /** Hybrid score when the hybrid legs returned the turn; else the tier-native value (exact 1, fuzzy similarity). */
  score: number;
  ts?: string | null;
  /**
   * The ENGINE's provenance for this turn: lexical/semantic/both when a hybrid leg returned it,
   * `unknown` when only a literal tier did — "no claim", never a default. `tier` is the real claim.
   */
  matchedBy: MatchProvenance;
  lexicalScore?: number;
  semanticScore?: number;
  /** Literal-tier hits only: the lowercased literal the turn contains (see SessionTurnLiteralHit). */
  focusTerm?: string;
  fuzzy?: FuzzyMatch;
}

export interface ComposeInput {
  exact: readonly SessionTurnLiteralHit[];
  fuzzy: readonly SessionTurnLiteralHit[];
  /**
   * The hybrid (tokenized lexical + semantic) hits in the order the caller wants them kept —
   * the engine's fused order, or the Stage-B reranked order. It is NOT re-sorted: re-partitioning
   * a reranked list silently undoes the cross-encoder (see groupHitsBySession, P-010).
   */
  hybrid: readonly SearchHit[];
  /** Total slots to return. Defaults to the policy's resultSlots. */
  limit?: number;
  policy?: Pick<SessionTurnLiteralPolicy, 'resultSlots' | 'exactReserve' | 'fuzzyReserve'>;
  /**
   * At most this many turns per (sourceKind, sessionId), counted across ALL tiers in precedence
   * order and applied BEFORE slotting. Callers that page by SESSION (the agents-pill/HUD search)
   * need it: the hybrid engine groups to one hit per session, but a literal tier can return
   * dozens of turns of one chatty session and would otherwise consume the whole page before a
   * second session appeared. A turn dropped by the cap is gone from every tier; a higher tier's
   * turn always claims the session's slots first. Unset = no cap.
   */
  maxPerSession?: number;
}

export interface ComposeResult {
  hits: TieredTurnHit[];
  /** Candidates per tier BEFORE dedup/slotting, and how many each tier contributed AFTER. */
  counts: Record<'exact' | 'fuzzy' | 'hybrid', { candidates: number; kept: number }>;
  /** Turns dropped by `maxPerSession` (after dedup, before slotting), all tiers together. */
  sessionCapped: number;
}

const keyOf = (kind: string, sid: string, idx: number): string => `${kind}:${sid}:${idx}`;

/** The hybrid tier a hit belongs to, from its ranker attribution. */
function hybridTier(m: MatchProvenance): SessionTurnTier {
  return m === 'semantic' ? 'semantic' : m === 'both' ? 'both' : 'lexical';
}

/**
 * Deterministic precedence: exact, then fuzzy, then the hybrid remainder in its incoming order.
 * Dedup is by turn key — the highest tier wins the row and every other tier that found it is
 * recorded in `alsoMatchedBy`. Slots: exact keeps up to `exactReserve`, fuzzy up to
 * `fuzzyReserve` (a floor each, scaled down by `limit`); leftover slots go exact-overflow, then
 * fuzzy-overflow, then hybrid. Output is tier-ordered, so an exact hit is always ahead of every
 * fuzzy-only, lexical-only, and semantic-only candidate. Pure.
 */
export function composeSessionTurnTiers(input: ComposeInput): ComposeResult {
  const policy = input.policy ?? SESSION_TURN_LITERAL_POLICY;
  const limit = Math.max(0, input.limit ?? policy.resultSlots);

  // Index the hybrid hits once so a literal hit can absorb its lexical/semantic provenance.
  const hybridByKey = new Map<string, { hit: SearchHit; prov: ReturnType<typeof hitProvenance>; kind: string; sid: string; idx: number; rank: number }>();
  for (const h of input.hybrid) {
    const ref = parseTurnRef(h.source_id);
    if (!ref) continue;
    const key = keyOf(ref.sourceKind, ref.sessionId, ref.turnIdx);
    if (!hybridByKey.has(key)) {
      hybridByKey.set(key, { hit: h, prov: hitProvenance(h), kind: ref.sourceKind, sid: ref.sessionId, idx: ref.turnIdx, rank: hybridByKey.size });
    }
  }
  /**
   * In-tier order. A literal tier arrives newest-first (its SQL has no relevance signal), so for a
   * common word ("plan") the page would fill with the newest substring hits and the engine's
   * reranked order — the only relevance signal there is — would be buried even for turns that are
   * BOTH an exact match and highly relevant. Turns the hybrid engine also returned therefore lead
   * the tier in ITS order; literal-only turns (the ones the engine missed — the reason this tier
   * exists) follow in their incoming order. Tier precedence is untouched: this only orders INSIDE
   * a tier, and it is stable.
   */
  const byHybridRank = (hits: readonly SessionTurnLiteralHit[]): SessionTurnLiteralHit[] => {
    const known: Array<{ l: SessionTurnLiteralHit; rank: number }> = [];
    const rest: SessionTurnLiteralHit[] = [];
    for (const l of hits) {
      const h = hybridByKey.get(keyOf(l.sourceKind, l.sessionId, l.turnIdx));
      if (h) known.push({ l, rank: h.rank });
      else rest.push(l);
    }
    known.sort((a, b) => a.rank - b.rank); // Array#sort is stable: equal ranks keep incoming order
    return [...known.map((k) => k.l), ...rest];
  };

  const claimed = new Set<string>();
  // Per-session cap, shared by every tier so a higher tier claims a session's slots first.
  const maxPerSession =
    input.maxPerSession !== undefined && input.maxPerSession >= 1 ? Math.floor(input.maxPerSession) : null;
  const perSession = new Map<string, number>();
  let sessionCapped = 0;
  const admitSession = (kind: string, sid: string): boolean => {
    if (maxPerSession === null) return true;
    const sk = `${kind}:${sid}`;
    const n = perSession.get(sk) ?? 0;
    if (n >= maxPerSession) {
      sessionCapped++;
      return false;
    }
    perSession.set(sk, n + 1);
    return true;
  };
  const literalTier = (hits: readonly SessionTurnLiteralHit[]): TieredTurnHit[] => {
    const out: TieredTurnHit[] = [];
    for (const l of byHybridRank(hits)) {
      const key = keyOf(l.sourceKind, l.sessionId, l.turnIdx);
      if (claimed.has(key)) continue;
      claimed.add(key);
      if (!admitSession(l.sourceKind, l.sessionId)) continue;
      const h = hybridByKey.get(key);
      out.push({
        key,
        sourceKind: l.sourceKind,
        sessionId: l.sessionId,
        turnIdx: l.turnIdx,
        tier: l.tier,
        alsoMatchedBy: h ? [hybridTier(h.prov.matchedBy)] : [],
        excerpt: l.excerpt,
        highlight: l.highlight,
        score: h ? h.hit.score : l.fuzzy ? l.fuzzy.similarity : 1,
        ts: l.ts,
        matchedBy: h ? h.prov.matchedBy : 'unknown',
        ...(h?.prov.lexicalScore !== undefined ? { lexicalScore: h.prov.lexicalScore } : {}),
        ...(h?.prov.semanticScore !== undefined ? { semanticScore: h.prov.semanticScore } : {}),
        ...(l.focusTerm ? { focusTerm: l.focusTerm } : {}),
        ...(l.fuzzy ? { fuzzy: l.fuzzy } : {}),
      });
    }
    return out;
  };
  const exact = literalTier(input.exact);
  const fuzzy = literalTier(input.fuzzy); // an exact-claimed turn is dropped here — stable dedup
  // `alsoMatchedBy` must also record that an exact-claimed turn was seen by the fuzzy tier.
  const fuzzySeen = new Set(input.fuzzy.map((l) => keyOf(l.sourceKind, l.sessionId, l.turnIdx)));
  for (const e of exact) if (fuzzySeen.has(e.key)) e.alsoMatchedBy.push('fuzzy');

  const hybrid: TieredTurnHit[] = [];
  for (const [key, h] of hybridByKey) {
    if (claimed.has(key)) continue;
    claimed.add(key);
    if (!admitSession(h.kind, h.sid)) continue;
    hybrid.push({
      key,
      sourceKind: h.kind,
      sessionId: h.sid,
      turnIdx: h.idx,
      tier: hybridTier(h.prov.matchedBy),
      alsoMatchedBy: [],
      excerpt: h.hit.excerpt,
      highlight: h.hit.highlight,
      score: h.hit.score,
      ts: h.hit.ts == null ? null : String(h.hit.ts),
      matchedBy: h.prov.matchedBy,
      ...(h.prov.lexicalScore !== undefined ? { lexicalScore: h.prov.lexicalScore } : {}),
      ...(h.prov.semanticScore !== undefined ? { semanticScore: h.prov.semanticScore } : {}),
    });
  }

  // Slotting: floors first (exact, then fuzzy), then leftovers by precedence.
  const eFloor = Math.min(policy.exactReserve, limit, exact.length);
  const fFloor = Math.min(policy.fuzzyReserve, limit - eFloor, fuzzy.length);
  let free = limit - eFloor - fFloor;
  const eExtra = Math.min(free, exact.length - eFloor);
  free -= eExtra;
  const fExtra = Math.min(free, fuzzy.length - fFloor);
  free -= fExtra;
  const hKeep = Math.min(free, hybrid.length);

  const hits = [
    ...exact.slice(0, eFloor + eExtra),
    ...fuzzy.slice(0, fFloor + fExtra),
    ...hybrid.slice(0, hKeep),
  ];
  return {
    hits,
    counts: {
      exact: { candidates: input.exact.length, kept: eFloor + eExtra },
      fuzzy: { candidates: input.fuzzy.length, kept: fFloor + fExtra },
      hybrid: { candidates: input.hybrid.length, kept: hKeep },
    },
    sessionCapped,
  };
}

/**
 * The wire projection of one composed turn for `/api/adv/sessions/search-transcripts`
 * (P-004). Pure, so the optional-field rules are testable without the route:
 *   · `tier` is ALWAYS present — it is the real provenance claim for a literal-only turn;
 *   · `alsoMatchedBy` only when a lower tier also returned the turn (an empty array is noise);
 *   · `focusTerm` / `fuzzy` / `lexicalScore` / `semanticScore` only when set, so an older client
 *     and a hybrid-only hit see exactly the shape they always did plus `tier`.
 */
export function tieredHitToWire(c: TieredTurnHit): {
  sourceKind: string;
  sessionId: string;
  turnIdx: number;
  excerpt: string;
  highlight: string;
  score: number;
  matchedBy: MatchProvenance;
  lexicalScore?: number;
  semanticScore?: number;
  tier: SessionTurnTier;
  alsoMatchedBy?: SessionTurnTier[];
  focusTerm?: string;
  fuzzy?: FuzzyMatch;
} {
  return {
    sourceKind: c.sourceKind,
    sessionId: c.sessionId,
    turnIdx: c.turnIdx,
    excerpt: c.excerpt,
    highlight: c.highlight,
    score: c.score,
    matchedBy: c.matchedBy,
    ...(c.lexicalScore !== undefined ? { lexicalScore: c.lexicalScore } : {}),
    ...(c.semanticScore !== undefined ? { semanticScore: c.semanticScore } : {}),
    tier: c.tier,
    ...(c.alsoMatchedBy.length > 0 ? { alsoMatchedBy: c.alsoMatchedBy } : {}),
    ...(c.focusTerm ? { focusTerm: c.focusTerm } : {}),
    ...(c.fuzzy ? { fuzzy: c.fuzzy } : {}),
  };
}
