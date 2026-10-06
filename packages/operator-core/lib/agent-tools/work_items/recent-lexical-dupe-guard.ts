/**
 * recent-lexical-dupe-guard — a cheap, embedding-INDEPENDENT complement to the P-008
 * semantic-dupe-guard (EI-9940, filed off the 2026-07-12 WI-4241/WI-4242 incident).
 *
 * The WI-4242 case: L1 reported a create failure, self-resolved it a minute later as
 * WI-4241, but the leader (working off the stale failure report) created a duplicate
 * WI-4242 five minutes on. semantic-dupe-guard's query filters `embedding IS NOT NULL`
 * — the embed-backfill sweep that populates it is ASYNC, so a row created moments ago
 * (like WI-4241 at create time) is *structurally invisible* to that guard regardless of
 * threshold tuning. This guard closes exactly that gap: instead of cosine similarity
 * over vectors, it does word-overlap (Jaccard) over RECENTLY-created OPEN titles in the
 * same harness — no embedding required, so it has no indexing lag.
 *
 * STRICTLY ADVISORY — unlike the semantic guard's hard band, this NEVER refuses a
 * create (word-overlap on this repo's long, jargon-dense titles is too coarse a signal
 * to safely block on; two genuinely distinct items routinely share "WI-4070" / "p2p" /
 * "tower" tokens). A match is merged into the same candidate set the semantic guard
 * feeds, tagged `source: 'lexical-recent'`. ⚠ That tag is load-bearing, not decoration:
 * this leg's score is Jaccard word-overlap, NOT cosine, so the create-time edge writer
 * excludes it from `dedup_edges` (D-010) — the census metric is cosine-only.
 *
 * FAIL-OPEN, same contract as semantic-dupe-guard: any DB error, timeout, or the kill
 * switch returns null ("no verdict") — the caller proceeds silently. Kill switch:
 * PAPERCUSP_WI_RECENT_DUPE=off. Overrides: PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN (default
 * 10), PAPERCUSP_WI_RECENT_DUPE_THRESHOLD (default 0.5, Jaccard 0..1).
 */
import { getOrgPg } from '@papercusp/db-org';
import { issuesScopeWorkspace } from '../../issues-engineer';
import { activeWorkspaceId } from '../../workspace-registry';
import { ALL_TERMINAL_STATUSES } from '../../work-item-blocking';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';
import { extractMeasurements, measurementOverlap } from '../../harness/improvements/measurement-tuples';

const DEFAULT_WINDOW_MIN = 10;
const DEFAULT_THRESHOLD = 0.5;
/** Cheap single indexed query — generous but bounded, mirrors semantic-dupe-guard's BUDGET_MS. */
const BUDGET_MS = 1500;
/** Cap the candidate scan so a busy harness never pays an unbounded comparison cost. */
const CANDIDATE_LIMIT = 50;
/** Surface at most this many advisory matches. */
const TOP_K = 3;
/** Tokens shorter than this, or in this domain-generic stopword set, don't count toward
 *  overlap — otherwise two unrelated titles that both happen to say "the fix for the"
 *  would look similar. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'this', 'that', 'it', 'its', 'be', 'as', 'at', 'by', 'from', 'into', 'via', 'not',
  'no', 'do', 'does', 'did', 'has', 'have', 'had', 'was', 'were', 'will', 'would',
]);

export interface RecentDupeCandidateRow {
  id: string;
  title: string;
  /** Body text; feeds the measurement-overlap signal alongside the title. */
  summary?: string;
  state: string;
  harness: string | null;
  /** Whether the semantic guard's embedding-filtered query could see this row. */
  hasEmbedding: boolean;
}

export interface RecentDupeCensus {
  rows: RecentDupeCandidateRow[];
  /** True when at least one row beyond the bounded candidate window exists. */
  truncated: boolean;
}

export interface RecentDupeCoverage {
  scanned: number;
  unembedded: number;
  truncated: boolean;
  complete: boolean;
}

export interface RecentLexicalDupeResult {
  candidates: SemanticDupeCandidate[];
  coverage: RecentDupeCoverage;
}

/** Injectable seam (tests + any future non-work_items space). */
export interface RecentLexicalDupeDeps {
  queryRecentOpenItems: (windowMin: number, harness?: string) => Promise<RecentDupeCensus>;
}

function threshold(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : dflt;
}

function windowMinutes(raw: string | undefined, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

export function recentDupeConfig(): { windowMin: number; threshold: number } {
  return {
    windowMin: windowMinutes(process.env.PAPERCUSP_WI_RECENT_DUPE_WINDOW_MIN, DEFAULT_WINDOW_MIN),
    threshold: threshold(process.env.PAPERCUSP_WI_RECENT_DUPE_THRESHOLD, DEFAULT_THRESHOLD),
  };
}

/** Normalize a title into a comparable token set: lowercase, strip punctuation, drop
 *  short/stopword tokens. Exported for tests. */
export function titleTokens(title: string): Set<string> {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);
  return new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

/** Jaccard similarity over two token sets: |intersection| / |union|. 0 when either is empty. */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open (mirrors
 *  semantic-dupe-guard's withBudget). */
function withBudget<T>(ms: number, p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      () => { clearTimeout(t); resolve(null); },
    );
  });
}

async function queryRecentOpenItemsReal(windowMin: number, harness?: string): Promise<RecentDupeCensus> {
  const { sql } = getOrgPg();
  const terminal = [...ALL_TERMINAL_STATUSES];
  const workspaces = [...new Set([issuesScopeWorkspace(), activeWorkspaceId()])];
  const rows = await sql<Array<{
    id: string;
    title: string;
    summary: string;
    state: string;
    harness_slug: string;
    has_embedding: boolean;
  }>>`
    SELECT feature_id AS id, COALESCE(title, '') AS title, COALESCE(summary, '') AS summary,
           COALESCE(status, 'todo') AS state, harness_slug,
           (embedding IS NOT NULL) AS has_embedding
      FROM harness_shared.work_items
     WHERE workspace_id = ANY(${workspaces}::text[])
       AND created_ts >= now() - (${windowMin} || ' minutes')::interval
       AND (status IS NULL OR NOT (status = ANY(${terminal}::text[])))
       AND ${harness ? sql`harness_slug = ${harness}` : sql`TRUE`}
     ORDER BY created_ts DESC
     LIMIT ${CANDIDATE_LIMIT + 1}`;
  const truncated = rows.length > CANDIDATE_LIMIT;
  return {
    rows: rows.slice(0, CANDIDATE_LIMIT).map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      state: r.state,
      harness: r.harness_slug || null,
      hasEmbedding: r.has_embedding,
    })),
    truncated,
  };
}

/** Test seam for the real bounded query and its embedding/truncation evidence. */
export const __queryRecentOpenItemsForTest = queryRecentOpenItemsReal;

const realDeps: RecentLexicalDupeDeps = { queryRecentOpenItems: queryRecentOpenItemsReal };

/**
 * Measurement-overlap score: shared DISTINCT anchors n -> n/(n+1), so 2 anchors
 * score 0.67 and the measured 8-anchor pair 0.89. Monotone, bounded below 1, and
 * never read as a cosine (dedup-edges skips every row that carries a `source`).
 */
function measurementScore(sharedAnchors: number): number {
  return Math.round((sharedAnchors / (sharedAnchors + 1)) * 100) / 100;
}

type ScoredRow = RecentDupeCandidateRow & {
  similarity: number;
  source: 'lexical-recent' | 'measurement-overlap';
};

async function classify(
  d: RecentLexicalDupeDeps,
  input: { title: string; summary?: string; harness?: string; excludeId?: string },
  overlap: typeof measurementOverlap = measurementOverlap,
): Promise<RecentLexicalDupeResult> {
  const cfg = recentDupeConfig();
  const census = await d.queryRecentOpenItems(cfg.windowMin, input.harness);
  const rows = census.rows.filter(
    (r) => r.id !== input.excludeId,
  );
  const newTokens = titleTokens(input.title);
  const hits: ScoredRow[] = [];
  const misses: RecentDupeCandidateRow[] = [];
  for (const r of rows) {
    const similarity = jaccardSimilarity(newTokens, titleTokens(r.title));
    if (similarity >= cfg.threshold) hits.push({ ...r, similarity, source: 'lexical-recent' });
    else misses.push(r);
  }
  // Observed-measurement signal (plan duplicate-screening-keys-on-authored-prose…,
  // P-002 / D-002): two filings of the same measurement agree on identifier-anchored
  // numbers while their prose differs (title Jaccard ~0.25 for the measured pair).
  // Fail-open (R-5): any extractor fault drops ONLY this signal, never the Jaccard hits.
  if (misses.length > 0) {
    try {
      const newText = `${input.title}\n${input.summary ?? ''}`;
      const newMeasurements = extractMeasurements(newText);
      if (newMeasurements.length > 0) {
        for (const r of misses) {
          const o = overlap(newMeasurements, `${r.title}\n${r.summary ?? ''}`);
          if (o.match) hits.push({ ...r, similarity: measurementScore(o.anchors.length), source: 'measurement-overlap' });
        }
      }
    } catch {
      // swallow: advisory signal only
    }
  }
  const unembedded = rows.filter((row) => !row.hasEmbedding).length;
  const candidates = hits
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_K)
    .map((r) => ({
      id: r.id,
      title: r.title,
      state: r.state,
      harness: r.harness,
      similarity: r.similarity,
      source: r.source,
    }));
  return {
    candidates,
    coverage: {
      scanned: rows.length,
      unembedded,
      truncated: census.truncated,
      complete: !census.truncated && unembedded === 0,
    },
  };
}

/** Test seam: classify with an injectable overlap function (R-5 thrown-extractor case). */
export const __classifyRecentForTest = classify;

/**
 * Prescreen a new work-item's title against OPEN items created within the last
 * `windowMin` minutes in the same harness, by word-overlap (no embedding needed).
 * Returns candidates plus bounded-census coverage evidence; null means "no verdict"
 * (disabled, timed out, errored). This remains advisory-only and NEVER blocks a
 * create by itself.
 */
export async function findRecentLexicalDupes(
  input: { title: string; summary?: string; harness?: string; excludeId?: string },
  deps?: RecentLexicalDupeDeps,
): Promise<RecentLexicalDupeResult | null> {
  if (process.env.PAPERCUSP_WI_RECENT_DUPE === 'off') return null;
  // Inert under vitest unless a test injects deps — mirrors semantic-dupe-guard so
  // unrelated tool tests never pay a real DB round-trip.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, classify(deps ?? realDeps, input));
  } catch {
    return null;
  }
}
