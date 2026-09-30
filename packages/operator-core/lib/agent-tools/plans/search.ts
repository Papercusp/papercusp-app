/**
 * plans:search — keyword search across plan content.
 *
 * Per agent-plan-tracking-2026-05-20.md §4.1.
 *
 * Scope-aware: search within { title, now, items, decisions, prose }
 * subsets. Defaults to all.
 *
 * Implementation note: this is a small-corpus search (~50 plans).
 * A real BM25 is overkill — we use TF-style scoring with case-
 * insensitive token matching and a position-weighted boost for
 * title/now hits. If/when corpus size or query complexity grows,
 * lift this to a proper index.
 *
 * WI-5683: the lexical TF ranking above is fused with the migration-553
 * plan-embedding semantic ranking by Reciprocal Rank Fusion before the top-N
 * cut. Prior to that fix, semantic hits were only ever appended (capped at 3)
 * AFTER the lexical results, so a topically-exact plan whose lexical score was
 * low — e.g. buried behind long plans that merely repeat common tokens, or
 * dropped entirely by the CANDIDATE_LIMIT ILIKE prefilter below — ranked dead
 * last or vanished from a `limit`-capped page.
 *
 * P-016 / D-025: that fusion is no longer hand-rolled here. Both legs are now
 * `@papercusp/search` `SearchSource` parts and `runHybridSearch` owns the
 * fusion, so this surface inherits the P-017 similarity FLOOR (the vector leg
 * used to hand fusion its k nearest rows whether or not any was a match) and
 * reports P-020 `legs` — a lexical-only result caused by a dead embedder is now
 * legible as degraded instead of looking like a healthy search that found less.
 * Ranking is unchanged by the move: the local fusion called
 * `rrfCombine(…, RRF_K_DEFAULT)` and the engine calls the same function with
 * the same constant, so deleting it de-duplicates rather than re-ranks.
 *
 * The 0.45 gemma floor was MEASURED on this corpus before being inherited
 * (D-025): worst in-domain top-10 0.5370 vs best off-domain top-1 0.5404, so
 * it cannot silently zero the leg. `harness_plans` is neither of the corpora
 * the floor was originally calibrated on, so that check was not optional.
 *
 * ⚠ The lexical leg here is NOT a tsvector rank, deliberately (D-025): it wraps
 * the in-JS scorer above and ignores the `sql` handle the engine passes. A
 * `ts_rank_cd` leg cannot produce the scope-attributed `matches[]` this tool
 * returns, cannot express six distinct scope weights (setweight has four
 * classes), and cannot honour the per-call `scope` arg. `SearchSource` requires
 * a ranked LIST, not a query, so wrapping the scorer is supported and exact.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { runHybridSearch, isVectorOnly, type SearchSource, type Listing } from '@papercusp/search';
import { listPlanRowsMatchingAnyToken, syntheticPlanPath, VALID_PLAN_SLUG } from './source';
import { parsePlan } from './parser';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlansEmbedder, planEmbeddingRanker, type PlanSemanticHit } from './semantic-leg';
import { lazyOrgSql } from '../../search/lazy-org-sql';
import { harnessArg, harnessScopedCtx, HARNESS_ALL, isAllHarnessSentinel } from '../_harness-scope';
// Installs papercusp's engine-level ranking policy (P-017) on import — the
// same side-effect import every other engine caller uses. Without it this
// surface would call the engine and inherit NO floor, which is the exact
// hand-propagation failure P-016 removes.
import '../../search/configure-search-defaults';

/**
 * SQL candidate cap (audit P-042). Scoring needs ≥1 exact-token hit and
 * every scope is a substring of the content blob, so the ILIKE prefilter
 * returns a candidate SUPERSET — only candidates get fetched + parsed.
 * When the cap bites, the response says so (`truncatedCandidates`).
 */
const CANDIDATE_LIMIT = 200;

/** Ranker/source label reported in the engine's `legs` and per-hit `rankers`. */
const SOURCE_KEY = 'plans';

/** Result ceiling. Arbitrary and read-only, so an over-large `limit` clamps. */
export const MAX_LIMIT = 50;

/**
 * Exported so the regression guard pins the SAY half of the repair without
 * reaching into zod internals to find it (EI-21253383007098268: the complaint
 * was never that a cap exists, but that it was invisible until it fired).
 */
export const LIMIT_DESCRIPTION =
  `Max results. Default 20, capped at ${MAX_LIMIT} — a larger value is CLAMPED to ${MAX_LIMIT} (response reports limitClamped), not refused.`;

const SCOPES = ['slug', 'title', 'now', 'items', 'decisions', 'prose'] as const;
type Scope = (typeof SCOPES)[number];

/**
 * Normalize the legacy `q` spelling and a single-string `scope` before the
 * strict args schema runs.
 *
 * Search callers commonly use the shorter `q` spelling, while this tool's
 * canonical input is `query`. Keep the published schema canonical and discard
 * the alias after normalization; when both spellings are present, explicit
 * `query` wins.
 *
 * `scope` is declared as an array of scope names, but a caller narrowing to ONE
 * scope naturally writes `scope: 'items'` and hit invalid_args before any search
 * ran (tool-contract-repair-2026-09-05 P-006 / EI-21166014275674822: "scope
 * expected array, received string; high-level discovery summary did not expose
 * that shape"). A bare string has exactly one possible reading here — the
 * one-element list — so it is widened rather than rejected. An unknown scope
 * name still fails the enum loudly; this only fixes the CONTAINER shape.
 */
export function normalizePlansSearchArgs(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const args = raw as Record<string, unknown>;

  let out = args;
  if (Object.prototype.hasOwnProperty.call(args, 'q')) {
    const { q, ...rest } = out;
    out = rest.query !== undefined ? rest : { ...rest, query: q };
  }
  if (typeof out.scope === 'string') {
    out = { ...out, scope: [out.scope] };
  }
  return out === args ? raw : out;
}

const argsSchema = z.preprocess(
  normalizePlansSearchArgs,
  z.object({
    query: z
      .string()
      .min(1)
      .optional()
      .describe('Search query (case-insensitive, whitespace-tokenized). Legacy alias: `q`. Required unless `slug` is supplied.'),
    slug: z
      .string()
      .min(1)
      .optional()
      .describe('Compatibility shorthand for a slug-only search. Equivalent to `{ query: slug, scope: ["slug"] }`; `query` wins when both are supplied.'),
    scope: z
      .array(z.enum(SCOPES as unknown as [Scope, ...Scope[]]))
      .optional()
      .describe('Scopes to search. Default: all. A bare string is accepted as the one-element list.'),
    // EI-21253383007098268: "limit: Too big: expected number to be <=50" — an
    // oversized limit on a READ-ONLY search where the cap is arbitrary and
    // nothing destructive follows. The plan's CLAMP-vs-REJECT rule puts that
    // squarely on the clamp side (reject only where the value changes WHAT is
    // measured), and the cap is now stated in the argument's own description —
    // the real complaint was never that a cap exists, but that it was invisible
    // until it fired. `clamped:true` is echoed on the response so a caller is
    // never silently given fewer results than they asked for.
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(LIMIT_DESCRIPTION),
    includeArchived: z.boolean().optional().describe('Search archived plans too. Default true (the dispersal problem was *unfindable*).'),
    includeLegacy: z.boolean().optional().describe('Search legacy plans (prose only). Default true.'),
    harness: harnessArg,
    semantic: z
      .boolean()
      .optional()
      .describe(
        'Fuse embedding-cosine hits with the lexical ranking via Reciprocal Rank Fusion (RRF) instead of ' +
          'scoring lexical alone — a topically-exact plan whose lexical score is low/zero can still rank near ' +
          'the top on the strength of its semantic rank. Default on (off under vitest); false = lexical-only. ' +
          'Read `legs` on the response for whether it actually ran: legs.degraded=true means the ranking is ' +
          'NOT the one this promises.',
      ),
  })
  .superRefine((args, ctx) => {
    if (!args.query && !args.slug) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'pass `query` (or the slug-only alias `slug`).',
      });
    }
  }));

interface Hit {
  plan: string;
  score: number;
  matches: Array<{ scope: Scope; snippet: string }>;
  /** Matches beyond MAX_MATCHES_PER_PLAN that were trimmed to keep the
   *  response under the token limit (a high-hit plan can match dozens of
   *  items/decisions). 0 → omitted. */
  matches_omitted?: number;
}

// Bound the per-plan snippet count: matches are pushed in scope order
// (title → now → items → decisions → prose), so the first few are the
// highest-signal. A plan matching 50 items previously emitted 50 snippets;
// across the default 20 results that overflowed the token limit.
const MAX_MATCHES_PER_PLAN = 4;

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9_-]+/g) ?? [];
}

function scoreScope(text: string, queryTokens: string[]): number {
  if (!text) return 0;
  const docTokens = tokenize(text);
  if (docTokens.length === 0) return 0;
  // Term-frequency tally: count every occurrence of every query token,
  // not just distinct presence. A doc that mentions `mem0` 20× should
  // rank above one that mentions it once — the prior Set-based check
  // gave both the same `1`, burying high-relevance plans in the long
  // score-1 tail.
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  let hits = 0;
  for (const q of queryTokens) hits += tf.get(q) ?? 0;
  return hits;
}

/**
 * Slug scope scores a SUBSTRING match (not exact-token): the tokenizer keeps
 * hyphens, so a slug like `watchdog-audit-2026-06-09` is one token that a query
 * token `watchdog-audit` (also one token) never token-equals — yet the user
 * plainly means that plan. Substring also mirrors the SQL prefilter's
 * `plan_slug ILIKE %token%`, so candidacy and scoring agree. Counts query
 * tokens present in the slug (case-insensitive).
 */
function scoreSlug(slug: string, queryTokens: string[]): number {
  if (!slug) return 0;
  const lower = slug.toLowerCase();
  let hits = 0;
  for (const q of queryTokens) {
    // Skip bare-numeric tokens (`2026`, `06`): nearly every slug carries a date
    // stamp, so a numeric token would slug-match almost all plans and flood the
    // results. A hyphenated date like `2026-06-09` is ONE token (the tokenizer
    // keeps hyphens) and stays — it's a meaningful slug fragment.
    if (/^\d+$/.test(q)) continue;
    if (lower.includes(q)) hits += 1;
  }
  return hits;
}

function snippet(text: string, queryTokens: string[], maxLen = 160): string {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const q of queryTokens) {
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + q.length + maxLen - 40);
      return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
    }
  }
  return text.slice(0, maxLen);
}

export default defineTool({
  name: 'plans:search',
  description:
    'Search across SU plans by keyword. Scopes: slug, title, now, items, decisions, prose. Includes archived + legacy by default. A slug (or slug fragment) finds the plan it names — not only plans that mention it. `slug` is a compatibility shorthand for a slug-only search; `query` remains the canonical search field and wins when both are supplied.',
  guidance: {
    when: 'You\'re looking for prior work, decisions, or items by topic and don\'t have a slug — or you have a slug fragment and want the plan it names.',
    notWhen:
      'You already know the full exact slug — use plans:get (a direct PG key read). For full prose recall across the project (chats, escalations), use search:fulltext.',
    chaining:
      'plans:search { query } → plans:get { slug } on the top hit.',
  },
  capability: 'plans:read',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  // + overwatch (overwatch-role-2026-06-15 B-01): searches plans to ground its nudges.
  agentRoles: [...SU_ROLES, 'kettle'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void; signal?: AbortSignal };
    const query = args.query ?? args.slug;
    if (!query) throw new Error('plans:search requires `query` or `slug`');
    const scopes: Scope[] =
      (args.scope as Scope[] | undefined) ??
      (args.slug && !args.query ? ['slug'] : [...SCOPES]);
    // Clamp rather than refuse (EI-21253383007098268); report it so a caller
    // never silently receives fewer results than they asked for.
    const requestedLimit = args.limit ?? 20;
    const limit = Math.min(requestedLimit, MAX_LIMIT);
    const limitClamped = requestedLimit > MAX_LIMIT;
    const includeArchived = args.includeArchived !== false;
    const includeLegacy = args.includeLegacy !== false;
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ hits: [] }) }],
      };
    }

    // Check if query looks like an exact plan slug (e.g., P-001, feature-name, etc.)
    const queryIsSlugLike = VALID_PLAN_SLUG.test(query) && query.trim().length < 50;
    const isExplicitAllScope = isAllHarnessSentinel(args.harness);

    const sctx = harnessScopedCtx(args.harness, ctx);
    const opts = await ctxToPlanSourceOpts(sctx);

    // Captured by the LEXICAL leg on its way through, and read after fusion:
    // the engine's `SearchHit` is domain-free and carries none of `matches[]`,
    // `score`, or `matches_omitted`, which are this tool's actual product.
    const hydration = new Map<string, Hit>();
    let truncated = false;
    let crossHarnessHit = false;

    /**
     * The lexical leg: the in-JS TF scorer above, wrapped as a ranked list.
     *
     * Returns the FULL scored list rather than slicing to the engine's
     * over-fetch `limit` — exactly what the hand-rolled fusion fed to
     * `rrfCombine` before, so fused ranking is bit-for-bit the same. The
     * candidate ceiling that actually bounds this leg is the SQL prefilter's
     * CANDIDATE_LIMIT, which is independent of the caller's `limit`.
     */
    const runLexical = async (): Promise<Hit[]> => {
      // SQL candidate prefilter (audit P-042 — EI-98/EI-174/EI-175): only
      // plans containing ≥1 query token leave PG; everything else used to be
      // fetched + parsed per request just to score 0.
      const { rows: candidates, truncated: wasTruncated } = await listPlanRowsMatchingAnyToken(queryTokens, {
        includeArchived,
        ...opts,
        limit: CANDIDATE_LIMIT,
      });
      truncated = wasTruncated;

      // EI-397: If query looks like an exact slug and we got zero hits in the
      // scoped harness, retry across all harnesses to avoid the "plan exists but
      // hidden by harness scope" problem (harness-scoped agents searching for
      // Papercusp plans would get zero hits).
      let finalCandidates = candidates;
      if (queryIsSlugLike && candidates.length === 0 && !isExplicitAllScope && opts.harnessSlug !== HARNESS_ALL) {
        const crossOpts = await ctxToPlanSourceOpts({ harnessSlug: HARNESS_ALL });
        const { rows: crossCandidates } = await listPlanRowsMatchingAnyToken(queryTokens, {
          includeArchived,
          ...crossOpts,
          limit: CANDIDATE_LIMIT,
        });
        if (crossCandidates.length > 0) {
          finalCandidates = crossCandidates;
          crossHarnessHit = true;
        }
      }
      const parsedPlans = finalCandidates.map((row) => ({
        parsed: parsePlan(row.content, {
          filePath: syntheticPlanPath(row.harnessSlug, row.planSlug),
        }),
        slug: row.planSlug,
      }));
      const hits: Hit[] = [];

    for (const { parsed, slug } of parsedPlans) {
      if (parsed.isLegacy && !includeLegacy) continue;

      const matches: Hit['matches'] = [];
      let score = 0;

      // Slug scope first (highest-identity signal): the PG slug is not part of
      // the scored content (the parser strips frontmatter from prose), so without
      // this a search for a plan's own slug zero-hits the plan itself
      // (F-FIX-028/029). Weighted above title — an exact-slug query should land
      // its plan on top.
      if (scopes.includes('slug')) {
        const s = scoreSlug(slug, queryTokens);
        if (s > 0) {
          score += s * 5;
          matches.push({ scope: 'slug', snippet: slug });
        }
      }

      if (parsed.isLegacy) {
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      } else {
        if (scopes.includes('title') && parsed.frontmatter.title) {
          const s = scoreScope(parsed.frontmatter.title, queryTokens);
          if (s > 0) {
            score += s * 4;
            matches.push({ scope: 'title', snippet: parsed.frontmatter.title });
          }
        }
        if (scopes.includes('now') && parsed.now) {
          const text = parsed.now.raw;
          const s = scoreScope(text, queryTokens);
          if (s > 0) {
            score += s * 3;
            matches.push({ scope: 'now', snippet: snippet(text, queryTokens) });
          }
        }
        if (scopes.includes('items')) {
          for (const it of parsed.items) {
            const s = scoreScope(it.text, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({ scope: 'items', snippet: `${it.id}: ${snippet(it.text, queryTokens, 120)}` });
            }
          }
        }
        if (scopes.includes('decisions')) {
          for (const d of parsed.decisions) {
            const s = scoreScope(d.title + ' ' + d.body, queryTokens);
            if (s > 0) {
              score += s * 2;
              matches.push({ scope: 'decisions', snippet: `${d.id} ${d.title}: ${snippet(d.body, queryTokens, 120)}` });
            }
          }
        }
        if (scopes.includes('prose')) {
          const s = scoreScope(parsed.prose, queryTokens);
          if (s > 0) {
            score += s;
            matches.push({ scope: 'prose', snippet: snippet(parsed.prose, queryTokens) });
          }
        }
      }

      if (score > 0) {
        const omitted = Math.max(0, matches.length - MAX_MATCHES_PER_PLAN);
        hits.push({
          // WI-7259 (sibling of WI-7246): `slug` here is already the canonical
          // `row.planSlug` destructured above — a snapshot's frontmatter.slug
          // reads its PARENT's slug, so falling back to it would silently
          // misattribute every snapshot hit to its parent.
          plan: slug,
          score,
          matches: omitted > 0 ? matches.slice(0, MAX_MATCHES_PER_PLAN) : matches,
          ...(omitted > 0 ? { matches_omitted: omitted } : {}),
        });
      }
    }

      hits.sort((a, b) => b.score - a.score);
      return hits;
    };

    // `embedder: null` is reserved for "no semantic leg was ever wanted" — the
    // ONE case the engine's `not-run` correctly describes. When the leg IS
    // wanted, resolvePlansEmbedder returns a REJECTING embedder on every
    // degraded path, so a dead embedder reports `blocked` (D-023) instead of
    // being indistinguishable from `semantic:false`.
    const semanticOn = args.semantic ?? !process.env.VITEST;
    const { embedder, embeddingMode } = semanticOn
      ? await resolvePlansEmbedder()
      : { embedder: null, embeddingMode: null };

    const source: SearchSource = {
      name: SOURCE_KEY,
      async lexical(): Promise<Listing> {
        const hits = await runLexical();
        return hits.map((h) => {
          hydration.set(h.plan, h);
          return {
            key: h.plan,
            score: h.score,
            row: {
              source: SOURCE_KEY,
              source_id: h.plan,
              excerpt: h.matches[0]?.snippet ?? h.plan,
              highlight: h.plan,
              score: h.score,
              rankers: ['lexical'],
            },
          };
        });
      },
      // No resolved embedding space ⇒ no `embedding` method, so the engine
      // never issues a vector query it has no space for. The rejecting embedder
      // above is what still makes that state report as `blocked`: the engine
      // sets it when the query embed throws, before any source's embedding
      // method would have been consulted.
      ...(embeddingMode
        ? {
            embedding: planEmbeddingRanker(
              SOURCE_KEY,
              embeddingMode,
              { ...opts, includeArchived },
              (h: PlanSemanticHit) => {
                // A plan the lexical leg never scored still needs a row to
                // return; the title match mirrors what the old fusion
                // synthesized for a semantic-only hit.
                if (!hydration.has(h.slug)) {
                  hydration.set(h.slug, {
                    plan: h.slug,
                    score: 0,
                    matches: [{ scope: 'title', snippet: h.title ?? h.slug }],
                  });
                }
              },
            ),
          }
        : {}),
    };

    const { results, legs, applied } = await runHybridSearch([source], {
      caller: 'plans:search',
      sql: lazyOrgSql,
      query,
      // Both legs resolve their own workspace/harness scope from `opts` (the
      // plan store is scoped by `resolvePlanScope`, not by the engine's keys).
      workspaceId: '',
      scopeFilter: null,
      limit,
      mode: 'hybrid',
      embedder,
      ...(ctxAny.signal ? { signal: ctxAny.signal } : {}),
    });

    let semanticHitCount = 0;
    const merged: Array<Hit & { semantic?: true; similarity?: number }> = results.map((r) => {
      const base: Hit = hydration.get(r.source_id) ?? { plan: r.source_id, score: 0, matches: [] };
      const raw = r.rankerScores?.embeddings;
      const similarity = raw === undefined ? undefined : Math.round(raw * 1000) / 1000;
      // Only mark semantic:true (the "this wasn't a lexical match" signal
      // downstream callers key on) when the plan has NO lexical score of its
      // own — a plan found by both legs keeps its real lexical matches and just
      // also carries the similarity that helped rank it.
      if (isVectorOnly(r)) {
        semanticHitCount += 1;
        return { ...base, semantic: true as const, similarity };
      }
      return similarity !== undefined ? { ...base, similarity } : base;
    });

    ctxAny.metadata?.({
      query,
      scopes,
      count: merged.length - semanticHitCount,
      ...(semanticHitCount > 0 ? { semanticHitCount } : {}),
      ...(truncated ? { truncatedCandidates: true } : {}),
      ...(crossHarnessHit ? { crossHarnessHit: true } : {}),
      ...(legs.degraded ? { legsDegraded: true, legsWarning: legs.warning } : {}),
    });

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          hits: merged,
          ...(semanticHitCount > 0 ? { semanticHitCount } : {}),
          // P-020 + D-023's corollary: inheriting the engine's leg report and
          // then DISCARDING it is half the migration. `legs.degraded` +
          // `legs.warning` are the ready-made verdict for "was this really a
          // hybrid ranking?", and `applied` says which floors actually ran —
          // without them a lexical-only result caused by a dead embedder is
          // indistinguishable from a healthy search that found less.
          legs,
          applied,
          // No silent caps: the candidate prefilter hit its ceiling — ranking
          // covered the first CANDIDATE_LIMIT matching plans only. Narrow the
          // query (or scope by harness) for exhaustive coverage.
          ...(truncated ? { truncatedCandidates: true } : {}),
          // No silent caps, the CALLER's half: an over-large `limit` was
          // clamped rather than refused (EI-21253383007098268), so say the cap
          // out loud instead of letting a short page read as "that is all
          // there was".
          ...(limitClamped ? { limitClamped: { requested: requestedLimit, applied: limit } } : {}),
          ...(crossHarnessHit ? { crossHarnessHit: 'Zero hits in scoped harness; result is from cross-harness search.' } : {}),
        }),
      }],
    };
  },
});
