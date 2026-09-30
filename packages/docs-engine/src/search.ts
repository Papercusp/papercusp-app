/**
 * searchDocs — substring/keyword scoring over a DocSource.
 *
 * Title ×4, description ×2, body via BM25-style length-normalized term
 * frequency. Tokenizes on common punctuation, dedupes, ignores tokens
 * shorter than 2 chars.
 *
 * EI-10937 — why the body term is length-normalized:
 * The body used to score as a RAW occurrence count (`count * 1`), unnormalized
 * by document length. That makes ranking a proxy for FILE SIZE: a long document
 * accumulates more raw hits than a short one no matter how focused the short one
 * is. In the live corpus (669 pages, mean 10.1KB) the effect was severe — the two
 * generated aggregator pages `reference/agent-insights-index` (304KB — every
 * insight's title+description) and `reference/plans-index` (276KB) matched
 * essentially EVERY query and out-ranked the one doc that actually answered it.
 * Measured before this fix: the correct doc landed at rank #5 (semantic leg only)
 * or did not appear at all, and every junk hit was one of the 12 largest files in
 * the corpus. Agents therefore concluded "not documented" and re-derived knowledge
 * that was already written down — a silent wrong answer, and a major source of the
 * hand-carried "tribal knowledge" problem (EI-10904 / EI-10941).
 *
 * Two independent guards, because either alone is insufficient:
 *   1. `page.searchable === false` drops generated NAVIGATION aggregators from the
 *      corpus entirely (see DocPage.searchable).
 *   2. BM25 length normalization kills the CLASS — without it, excluding the two
 *      known index pages would simply promote the next-largest docs
 *      (project-sharing 99KB, agent-e2e 98KB, lifecycle 75KB) into the same role.
 */

import type { DocSource, EngineCtx, SearchArgs, SearchHit, SearchResult } from './types.js';
import { evaluateOkfTrust, okfTrustIsNotable } from './okf.js';

// EI-10097: hyphen is a WORD separator for tokenization purposes (doc slugs
// and runbook titles are kebab-case — 'su-persona-render-and-edit-path' must
// tokenize to ['su','persona','render','and','edit','path'], not survive as
// one un-matchable compound token). Placed last in the class so it reads as
// a literal hyphen, not a range.
const STOP_TOKEN_RE = /[\s,.;:!?(){}[\]<>"'`/\\-]+/;

export function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of query.toLowerCase().split(STOP_TOKEN_RE)) {
    if (part.length < 2) continue;
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!haystack || !needle) return 0;
  const hay = haystack.toLowerCase();
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) return n;
    n += 1;
    from = idx + needle.length;
  }
}

function firstMatchIndex(haystack: string, tokens: string[]): number {
  const hay = haystack.toLowerCase();
  let earliest = -1;
  for (const t of tokens) {
    const idx = hay.indexOf(t);
    if (idx === -1) continue;
    if (earliest === -1 || idx < earliest) earliest = idx;
  }
  return earliest;
}

/** Collapse a free-text query to a kebab-case comparable slug fragment. */
function normalizeToSlug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * EI-10097: an exact (or near-exact) slug match is the strongest possible
 * lexical signal — an agent quoting a doc's own slug back at the search
 * ('su-persona-render-and-edit-path') should hard-hit that doc even when
 * its title/description/body wording doesn't share vocabulary with the
 * query. Scored separately from token-substring scoring so it dominates
 * regardless of body length or token frequency.
 */
function slugMatchBonus(query: string, page: { slug: string; slugs: string[] }): number {
  const q = normalizeToSlug(query);
  if (!q || q.length < 3) return 0;
  const lastSegment = (page.slugs[page.slugs.length - 1] ?? '').toLowerCase();
  const fullSlugFlat = page.slug.toLowerCase().replace(/\//g, '-');
  if (q === lastSegment || q === fullSlugFlat) return 1000;
  if (lastSegment && (lastSegment.includes(q) || q.includes(lastSegment))) return 50;
  if (fullSlugFlat && (fullSlugFlat.includes(q) || q.includes(fullSlugFlat))) return 30;
  return 0;
}

/**
 * BM25 term-frequency saturation with length normalization (EI-10937).
 *
 * k1 caps how much repetition can buy (TF saturates rather than growing
 * linearly); b=0.75 is the standard length-normalization strength. The net
 * effect: a term appearing 3× in a focused 5KB doc outranks the same term
 * appearing 400× in a 300KB aggregate dump — which is exactly the inversion
 * the old raw-count scoring produced.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Inverse document frequency — the half of BM25 that actually kills the
 * aggregate-dump black hole, and the one it is easy to forget.
 *
 * Length normalization alone is NOT enough. A query like
 * `nuqs throttled url flush race` mixes one RARE, discriminating token (`nuqs`,
 * in ~1 doc) with several COMMON ones (`url`, `race`, `flush`, in hundreds). A
 * 304KB page that carries the vocabulary of all 491 docs racks up a large score
 * on the COMMON tokens and wins — even though the rare token is the one that
 * identifies the true answer. IDF prices that in: a token appearing in most
 * documents is worth ~nothing, a token appearing in one document is worth a lot.
 * Breadth of vocabulary stops being a ranking advantage, which is precisely the
 * property an index/catalog page was exploiting.
 */
function idf(docFreq: number, totalDocs: number): number {
  // Standard BM25 IDF with the +1 shift, so it is always >= 0 (a token present in
  // every document contributes ~0 rather than going negative).
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

function bm25BodyScore(
  count: number,
  bodyLen: number,
  avgBodyLen: number,
  tokenIdf: number,
): number {
  if (count === 0) return 0;
  const norm = 1 - BM25_B + BM25_B * (bodyLen / (avgBodyLen || 1));
  const tf = (count * (BM25_K1 + 1)) / (count + BM25_K1 * norm);
  return tokenIdf * tf;
}

function makeExcerpt(body: string, tokens: string[], window = 120): string {
  const hitAt = firstMatchIndex(body, tokens);
  if (hitAt === -1) {
    return body.slice(0, window * 2).replace(/\s+/g, ' ').trim();
  }
  const start = Math.max(0, hitAt - Math.floor(window / 3));
  const end = Math.min(body.length, start + window * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return (prefix + body.slice(start, end) + suffix).replace(/\s+/g, ' ').trim();
}

export async function searchDocs(source: DocSource, args: SearchArgs, ctx: EngineCtx = {}): Promise<SearchResult> {
  const limit = args.limit ?? 8;
  // ONE clock for the whole result set (see getDocs) — hits must not disagree
  // about whether "today" has crossed a stale_after boundary mid-response.
  const now = ctx.now ?? new Date();
  if (ctx.signal?.aborted) throw new Error('cancelled');
  const tokens = tokenize(args.query);
  if (tokens.length === 0) {
    ctx.metadata?.({ query_tokens: 0, hit_count: 0, returned: 0 });
    return { query: args.query, tokenCount: 0, hitCount: 0, hits: [] };
  }

  const allPages = await source.listPages();
  // EI-10937 guard 1: generated navigation aggregators opt out via
  // `searchable: false` frontmatter. They stay fully reachable through
  // docs:get and the outline — they are simply not ANSWERS to a query.
  const pages = allPages.filter((p) => p.searchable !== false);
  const excludedCount = allPages.length - pages.length;
  if (ctx.signal?.aborted) throw new Error('cancelled');
  ctx.progress?.(10, `searching ${pages.length} pages`);

  // Per-page render, with abort checks at each step. Promise.all keeps
  // the parallelism but every renderer throws on abort so the whole
  // batch unwinds.
  let scanned = 0;
  const rendered = await Promise.all(
    pages.map(async (p) => {
      if (ctx.signal?.aborted) throw new Error('cancelled');
      const body = await source.getContent(p);
      scanned += 1;
      if (scanned % 25 === 0) {
        const pct = 10 + Math.floor((scanned / pages.length) * 70);
        ctx.progress?.(pct, `scored ${scanned}/${pages.length}`);
      }
      return { page: p, body };
    }),
  );
  if (ctx.signal?.aborted) throw new Error('cancelled');
  ctx.progress?.(85, 'ranking');

  // EI-10937 guard 2: mean body length across the searched corpus is the BM25
  // normalization baseline, so "long" is measured relative to THIS corpus rather
  // than a hard-coded byte threshold that would rot as the docs grow.
  const avgBodyLen = rendered.length
    ? rendered.reduce((sum, r) => sum + r.body.length, 0) / rendered.length
    : 1;

  // Document frequency per query token, over the searched corpus — the input to
  // IDF. Computed once per query, not per page.
  const totalDocs = rendered.length;
  const tokenIdf = new Map<string, number>();
  for (const t of tokens) {
    let df = 0;
    for (const { page, body } of rendered) {
      const hay = `${page.title ?? ''} ${page.description ?? ''} ${body}`;
      if (hay.toLowerCase().includes(t)) df += 1;
    }
    tokenIdf.set(t, idf(df, totalDocs));
  }

  const scored: SearchHit[] = [];
  for (const { page, body } of rendered) {
    const title = page.title ?? '';
    const description = page.description ?? '';
    let score = 0;
    for (const t of tokens) {
      const w = tokenIdf.get(t) ?? 1;
      // IDF applies to EVERY field, not just the body. Weighting only the body by
      // informativeness leaves the same hole one level up: a page whose TITLE is
      // full of common query words ('...race conditions, url routing and flush
      // semantics') would out-rank the page that actually answers the rare part of
      // the query. Field weights (title ×4, description ×2) survive as multipliers
      // ON the informativeness-weighted score, so a title hit is still a strong
      // signal — just not a strong signal for a word that means nothing.
      score += countOccurrences(title, t) * 4 * w;
      score += countOccurrences(description, t) * 2 * w;
      score += bm25BodyScore(countOccurrences(body, t), body.length, avgBodyLen, w);
    }
    score += slugMatchBonus(args.query, page);
    if (score === 0) continue;

    // OKF read-time trust (P-005): a hit that is PAST its stale_after must say so
    // in the result list, so a reader can skip it before spending a docs:get on it.
    const trust = evaluateOkfTrust(page.okf, now);
    scored.push({
      slug: page.slug || '_root',
      url: page.url,
      title,
      ...(description ? { description } : {}),
      score,
      excerpt: makeExcerpt(body, tokens),
      ...(okfTrustIsNotable(trust) ? { trust } : {}),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  const hits = scored.slice(0, limit);

  ctx.metadata?.({
    query_tokens: tokens.length,
    hit_count: scored.length,
    returned: hits.length,
    non_searchable_excluded: excludedCount,
  });

  return { query: args.query, tokenCount: tokens.length, hitCount: scored.length, hits };
}
