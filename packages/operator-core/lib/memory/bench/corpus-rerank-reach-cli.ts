/**
 * P-008 pre-design measurement — how much of the corpus leg's admitted page can
 * an UPSTREAM RERANKER actually control?
 * (context-injection-retrieval-reach-and-visibility-2026-08-03, P-008.)
 *
 *   npx tsx packages/operator-core/lib/memory/bench/corpus-rerank-reach-cli.ts \
 *     --queries 120 --seed 17 [--hybrid] [--perms 24] [--workspace <id>]
 *
 * ⚠ WHY THIS EXISTS. P-008 reads as a wiring job: "the reranker exists and
 * already runs for agents on `search:semantic` and `/api/user/search`", so add
 * it to the corpus leg. Reranking reorders an ARRAY, and every other consumer of
 * the reranker treats the post-Stage-B array order AS the relevance order —
 * `adv/sessions.ts:892` says so explicitly ("`ordered`, NOT `results`").
 *
 * The corpus leg's consumer does NOT. `selectCorpusLines` (corpus-recall.ts,
 * step 5) sorts by MULTI-RANKER AGREEMENT first and uses the incoming array
 * position only as a TIEBREAK:
 *
 *     agreement (hit.rankers.length) DESC, then input array position ASC
 *
 * with a stated reason — agreement "is the only quality signal here that does
 * not depend on an absolute scale" (D-037's no-absolute-floor rule). A
 * cross-encoder score IS an absolute-scale signal, so wiring rerank in front of
 * this consumer does not merely add a stage: it puts the reranker underneath a
 * key that can outrank it. That is a design decision, not a wiring change, and
 * it is the same decision P-010 owns.
 *
 * BEFORE arguing about which key should win, measure how much it costs today.
 * READ-ONLY. Touches no bench schema, seeds nothing, writes nothing, and calls
 * NO cross-encoder — see "why no real reranker" below.
 *
 * WHAT IT MEASURES
 *
 *   NULL CONTROL   The identity permutation, run twice, independently. Every
 *                  number must come out exactly zero. It validates the
 *                  permutation mechanism the whole run depends on, and it runs
 *                  FIRST (the D-051/D-053 discipline its sibling
 *                  `corpus-leg-lexical-acceptance-cli.ts` already enforces).
 *
 *   REACH CEILING  Structural, derived from the shipped sort. Because agreement
 *                  is the PRIMARY key, an upstream reorder can only choose the
 *                  page from within the TOP AGREEMENT TIER until that tier is
 *                  exhausted. Two regimes matter and they are opposites:
 *                    · SINGLE TIER  — every survivor has the same ranker count,
 *                      so agreement is constant, the tiebreak decides, and the
 *                      reranker has FULL control. This is the BM25-only regime:
 *                      no embedder ⇒ every hit is 1-ranker.
 *                    · CONFINED     — the top tier alone has ≥ CORPUS_MAX_ITEMS
 *                      members, so the whole page is drawn from it and the
 *                      reranker cannot pull ANY lower-tier hit into the page,
 *                      however highly it scores it.
 *
 *   PERMUTATION    Empirical, and deliberately able to FALSIFY the reading
 *   SENSITIVITY    above. Rather than trusting my reading of the sort, actually
 *                  permute the pool K ways (seeded) and measure how much the
 *                  admitted output moves. An upstream reranker IS a permutation
 *                  of the pool, so this is the honest upper bound on its
 *                  influence — it answers "how much could ANY reordering change
 *                  the page?" without assuming which reordering is good.
 *                  If sensitivity comes back HIGH, the reach-ceiling reading is
 *                  wrong and P-008 really is closer to a wiring job. That
 *                  outcome is a pass, not a failure, and the run says so.
 *
 *   LATENCY        The other half of P-008's problem, substantiated instead of
 *   HEADROOM       argued. The leg has a 2s WHOLE-leg bound
 *                  (`corpusRecallTimeoutMs`) while the rerank stage's own budget
 *                  is PROSE_RERANK_TIMEOUT_MS = 4s — twice the whole leg. Report
 *                  measured leg latency, then the projected rerank cost at the
 *                  MEASURED ~45ms/pair (rerank.ts RERANK_MAX_CANDIDATES header,
 *                  P-001 spike 2026-08-01 — linear, and explicitly with "no
 *                  parallelism escape hatch"), and how many queries would breach
 *                  the bound once reranking is added.
 *
 * ⚠ WHY NO REAL CROSS-ENCODER IS CALLED. At ~45ms/pair × up to 24 candidates ×
 * two cascade stages × 120 queries this run would cost ~4 minutes of pinned CPU
 * on a shared box, and it would measure the QUALITY of one particular reranker —
 * a different question. Every question here is about how much influence ANY
 * reordering has, which permutation answers exactly and more strongly: a real
 * reranker is one sample from the space this enumerates. The projected latency
 * uses the reranker's own measured constant rather than a fresh timing run for
 * the same reason.
 *
 * ⚠ WHAT THIS RUN CANNOT TELL YOU. It measures how much CONTROL a reranker
 * would have, never whether using that control improves the page. Judging that
 * needs relevance labels this run does not have (the same limit its sibling
 * states about MRR). A high sensitivity number is permission to proceed to a
 * quality experiment, not evidence of a win.
 */

import { getOrgPg } from '@papercusp/db-org';
import { runHybridSearch, type Embedder } from '@papercusp/search';

import { SEARCH_SOURCES } from '../../agent-tools/search/sources';
import { buildQueryEmbedder } from '../../agent-tools/search/embedder';
import {
  CORPUS_BUDGET_CHARS,
  CORPUS_MAX_ITEMS,
  corpusQueryText,
  handleRefOfHit,
  selectCorpusLines,
  type CorpusHit,
} from '../corpus-recall';
import { corpusRecallTimeoutMs } from '../corpus-recall-io';
import { sensitivityVerdict, tierShape } from './corpus-rerank-reach';

const CORPUS_SOURCE_NAMES = ['session_turn', 'work_item'] as const;

/**
 * Measured cost per query/document pair for the local cross-encoder, from the
 * P-001 spike recorded in `agent-tools/search/rerank.ts`
 * (RERANK_MAX_CANDIDATES header): ~45ms, linear in candidates, and it does NOT
 * improve with more cores. Quoted rather than re-measured so this run and the
 * reranker's own cap calibration cannot drift apart.
 */
const RERANK_MS_PER_PAIR = 45;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERIES = Number(argValue('--queries') ?? 120);
const PERMS = Number(argValue('--perms') ?? 24);
const SEED = argValue('--seed') ?? '17';
const WORKSPACE = argValue('--workspace') ?? 'papercusp-workspace';
const USE_EMBEDDER = process.argv.includes('--hybrid');

/** Deterministic RNG — a re-run with the same seed must be comparable. */
function rng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Run `selectCorpusLines` over a given pool ORDER and return the admitted refs. */
function admittedFor(hits: readonly CorpusHit[], queryText: string): string[] {
  const { lines } = selectCorpusLines({
    hits: [...hits],
    queryText,
    harnessSlugs: [],
    maxItems: CORPUS_MAX_ITEMS,
    budgetChars: CORPUS_BUDGET_CHARS,
  });
  return lines.map((l) => l.handle.ref);
}

/**
 * The candidates ORDERING actually operates on: those that survived the filter
 * stages (self-session, out-of-scope, no-term-overlap, duplicate-ref, not-novel)
 * and were therefore eligible for the cap/budget walk.
 *
 * Derived from the SHIPPED function's own `dropped` audit rather than by
 * re-implementing its filters here — a reimplementation would silently drift
 * from the leg it claims to measure, which is the failure mode this whole file
 * exists to avoid.
 */
const FILTER_REASONS = new Set(['self-session', 'out-of-scope', 'no-term-overlap', 'duplicate-ref', 'not-novel']);

function survivorsOf(hits: readonly CorpusHit[], queryText: string): CorpusHit[] {
  const { dropped } = selectCorpusLines({
    hits: [...hits],
    queryText,
    harnessSlugs: [],
    maxItems: CORPUS_MAX_ITEMS,
    budgetChars: CORPUS_BUDGET_CHARS,
  });
  const filteredOut = new Set(dropped.filter((d) => FILTER_REASONS.has(d.reason)).map((d) => d.ref));
  const seen = new Set<string>();
  const out: CorpusHit[] = [];
  for (const hit of hits) {
    const ref = handleRefOfHit(hit);
    if (!ref || filteredOut.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(hit);
  }
  return out;
}

interface QueryReport {
  candidates: number;
  survivors: number;
  admitted: number;
  /** survivor count by rankers.length, e.g. { '1': 9, '2': 4 }. */
  tiers: Record<number, number>;
  topTierSize: number;
  singleTier: boolean;
  /** Top tier alone fills the page ⇒ no lower-tier hit is reachable at all. */
  confined: boolean;
  /** Permutations (of PERMS) that changed admitted position 1. */
  top1Changed: number;
  /** Permutations that changed the admitted SET, not merely its order. */
  setChanged: number;
  /** Permutations that changed the admitted ORDER (set may be identical). */
  orderChanged: number;
  nullControlViolations: number;
  legMs: number;
}

async function measureQuery(
  sql: ReturnType<typeof getOrgPg>['sql'],
  rawText: string,
  embedder: Embedder | null,
  rand: () => number,
): Promise<QueryReport | null> {
  const queryText = corpusQueryText(rawText);
  if (!queryText) return null;

  const sources = SEARCH_SOURCES.filter((s) =>
    (CORPUS_SOURCE_NAMES as readonly string[]).includes(s.name),
  );

  // Deliberately the SAME context `recallCorpusContext` builds for its stage-1
  // ('and') search, so this measures the shipped leg and not a lookalike.
  const t0 = Date.now();
  const fused = await runHybridSearch(sources, {
    sql,
    query: queryText,
    workspaceId: WORKSPACE,
    scopeFilter: null,
    limit: Math.max(CORPUS_MAX_ITEMS * 4, 8),
    mode: 'hybrid',
    embedder,
    embedTimeoutMs: 2_000,
    deferHighlight: true,
    lexicalMode: 'and',
  });
  const legMs = Date.now() - t0;

  const hits: CorpusHit[] = fused.results.map((r) => ({
    source: r.source,
    sourceId: r.source_id,
    scope: r.scope ?? null,
    excerpt: r.excerpt ?? '',
    highlight: r.highlight ?? null,
    score: r.score,
    ts: r.ts ?? null,
    rankers: r.rankers,
  }));
  if (hits.length === 0) return null;

  const baseline = admittedFor(hits, queryText);
  // NULL CONTROL, first: the identity "permutation" run again must reproduce the
  // baseline exactly. A nonzero here invalidates every number below it.
  const control = admittedFor(hits, queryText);
  const nullControlViolations =
    JSON.stringify(control) === JSON.stringify(baseline) ? 0 : 1;

  const survivors = survivorsOf(hits, queryText);
  // Tier shape (and the ≥2-tier confinement rule) comes from the unit-tested
  // module, never from a local copy — see its header for the two conclusion
  // bugs that copy shipped.
  const shape = tierShape(survivors.map((h) => h.rankers?.length ?? 1), CORPUS_MAX_ITEMS);

  let top1Changed = 0;
  let setChanged = 0;
  let orderChanged = 0;
  const baseSet = new Set(baseline);
  for (let p = 0; p < PERMS; p++) {
    const permuted = admittedFor(shuffled(hits, rand), queryText);
    if (permuted[0] !== baseline[0]) top1Changed++;
    if (JSON.stringify(permuted) !== JSON.stringify(baseline)) orderChanged++;
    if (permuted.length !== baseSet.size || permuted.some((r) => !baseSet.has(r))) setChanged++;
  }

  return {
    candidates: hits.length,
    survivors: survivors.length,
    admitted: baseline.length,
    tiers: shape.tiers,
    topTierSize: shape.topTierSize,
    singleTier: shape.singleTier,
    confined: shape.confined,
    top1Changed,
    setChanged,
    orderChanged,
    nullControlViolations,
    legMs,
  };
}

function render(reports: QueryReport[], bound: number, hybrid: boolean): string {
  const n = reports.length;
  const out: string[] = [];
  const nullViolations = reports.reduce((a, r) => a + r.nullControlViolations, 0);

  out.push('# P-008 — how much of the corpus page can an upstream reranker control?');
  out.push('');
  out.push(
    `queries: ${n} · permutations/query: ${PERMS} · seed ${SEED} · ranker: ${
      hybrid ? 'hybrid (bm25 + embeddings, RRF)' : 'BM25-only (no embedder)'
    } · whole-leg bound ${bound}ms`,
  );
  out.push('');

  out.push('## Null control (must be zero, read this first)');
  out.push('');
  out.push(
    nullViolations === 0
      ? `- ✓ **0/${n}** — the identity run reproduced its own baseline on every query. The permutation mechanism is sound and the numbers below mean what they say.`
      : `- ⛔ **${nullViolations}/${n} VIOLATIONS** — \`selectCorpusLines\` is not deterministic over an unchanged pool. EVERY number below is uninterpretable; fix this before reading further.`,
  );
  if (nullViolations > 0) return out.join('\n');
  out.push('');

  const single = reports.filter((r) => r.singleTier).length;
  const confined = reports.filter((r) => r.confined).length;
  out.push('## Reach ceiling (structural)');
  out.push('');
  out.push(`| regime | queries | share | what it means for a reranker |`);
  out.push(`|---|---|---|---|`);
  out.push(
    `| SINGLE TIER (agreement constant) | ${single}/${n} | ${pct(single, n)} | full control — the tiebreak decides, so array order IS the page |`,
  );
  out.push(
    `| CONFINED (top tier ≥ ${CORPUS_MAX_ITEMS}) | ${confined}/${n} | ${pct(confined, n)} | cannot pull ANY lower-tier hit into the page, at any score |`,
  );
  out.push('');
  out.push(
    `- mean survivors/query: **${mean(reports.map((r) => r.survivors)).toFixed(1)}** · mean top-tier size: **${mean(reports.map((r) => r.topTierSize)).toFixed(1)}** · page size ${CORPUS_MAX_ITEMS}`,
  );
  out.push('');

  const top1Rate = mean(reports.map((r) => r.top1Changed / PERMS));
  const setRate = mean(reports.map((r) => r.setChanged / PERMS));
  const orderRate = mean(reports.map((r) => r.orderChanged / PERMS));
  out.push('## Permutation sensitivity (empirical — can falsify the above)');
  out.push('');
  out.push(`| an arbitrary upstream reorder changes… | rate |`);
  out.push(`|---|---|`);
  out.push(`| the admitted top-1 | **${(100 * top1Rate).toFixed(1)}%** |`);
  out.push(`| the admitted SET | **${(100 * setRate).toFixed(1)}%** |`);
  out.push(`| the admitted ORDER | **${(100 * orderRate).toFixed(1)}%** |`);
  out.push('');
  // ⚠ THE VERDICT IS CONDITIONED ON TIER STRUCTURE, and must be. The override
  // under test is "agreement outranks array order", which can only occur when
  // there is MORE THAN ONE agreement tier. A BM25-only arm has exactly one tier
  // by construction (no embedder ⇒ every hit is 1-ranker), so it cannot exhibit
  // the effect at all — and its sensitivity is HIGH for that very reason.
  // Reading that HIGH as "the concern is falsified" is precisely backwards: it
  // is the control arm confirming that array order reaches the page WHEN
  // NOTHING OUTRANKS IT. An earlier revision of this file printed exactly that
  // wrong verdict, which is why the guard is here rather than in a comment.
  const mt = reports.filter((r) => !r.singleTier);
  const multiTier = mt.length;
  // The rate MUST be restricted to multi-tier queries — the pooled rate is
  // dominated by single-tier ones where a reorder trivially reaches the page.
  const mtTop1 = mean(mt.map((r) => r.top1Changed / PERMS));
  const verdict = sensitivityVerdict(multiTier, mtTop1);
  if (verdict !== 'not-a-test') {
    out.push(
      `- restricted to the **${multiTier}/${n}** (${pct(multiTier, n)}) MULTI-TIER queries — the only ones where the override can occur — an arbitrary reorder changes the top-1 **${(100 * mtTop1).toFixed(1)}%** of the time.`,
    );
  }
  out.push(
    verdict === 'not-a-test'
      ? `- ⇒ **NOT A TEST OF THE OVERRIDE.** Every query in this arm had a SINGLE agreement tier, so the agreement key was constant and could not outrank anything; the tiebreak (array order) decided by construction. The high sensitivity above is this arm working as a CONTROL — it shows the pool order does reach the page when nothing outranks it. It says nothing about P-008. **Re-run with \`--hybrid\`** — the override can only appear when both rankers contribute.`
      : verdict === 'low'
        ? `- ⇒ **LOW on the queries that matter.** A reranker's ordering is largely absorbed before it reaches the page: on multi-tier queries, reordering the pool arbitrarily leaves the top-1 unchanged ${((1 - mtTop1) * 100).toFixed(1)}% of the time. P-008 is NOT a wiring job — the agreement key has to be settled first, and that is P-010's decision.`
        : `- ⇒ **HIGH on the queries that matter — this FALSIFIES the reach-ceiling concern.** Even where an agreement tiebreak exists, an upstream reorder still reaches the page, so wiring the reranker in front of \`selectCorpusLines\` would take effect and P-008 can proceed closer to as written. Latency (below) remains the open question.`,
  );
  out.push('');

  const legs = reports.map((r) => r.legMs);
  const cands = reports.map((r) => Math.min(r.candidates, 24));
  // Cost of reranking BOTH cascade stages, which is what the leg would pay when
  // stage 1 under-fills — the common case its own header documents.
  const projected = reports.map((r, i) => r.legMs + 2 * cands[i] * RERANK_MS_PER_PAIR);
  const breach = projected.filter((ms) => ms > bound).length;
  const breachOneStage = reports
    .map((r, i) => r.legMs + cands[i] * RERANK_MS_PER_PAIR)
    .filter((ms) => ms > bound).length;

  out.push('## Latency headroom');
  out.push('');
  out.push(`| | p50 | p95 |`);
  out.push(`|---|---|---|`);
  out.push(`| leg today | ${quantile(legs, 0.5)}ms | ${quantile(legs, 0.95)}ms |`);
  out.push(
    `| + rerank, one stage | ${quantile(reports.map((r, i) => r.legMs + cands[i] * RERANK_MS_PER_PAIR), 0.5)}ms | ${quantile(reports.map((r, i) => r.legMs + cands[i] * RERANK_MS_PER_PAIR), 0.95)}ms |`,
  );
  out.push(
    `| + rerank, both cascade stages | ${quantile(projected, 0.5)}ms | ${quantile(projected, 0.95)}ms |`,
  );
  out.push('');
  out.push(
    `- queries that would BREACH the ${bound}ms whole-leg bound: **${breachOneStage}/${n}** (${pct(breachOneStage, n)}) reranking one stage, **${breach}/${n}** (${pct(breach, n)}) reranking both.`,
  );
  out.push(
    `- ⚠ A breach is not a slow page — \`recallCorpusContext\` returns \`empty('timed-out')\`, i.e. NO pointer section at all. The degradation is strictly worse than not reranking.`,
  );
  out.push(
    `- projection uses the reranker's own measured ${RERANK_MS_PER_PAIR}ms/pair (rerank.ts, P-001 spike) against a ${24}-candidate cap; no cross-encoder was called by this run.`,
  );

  return out.join('\n');
}

async function main(): Promise<void> {
  const { sql } = getOrgPg();
  const bound = corpusRecallTimeoutMs();

  // Real turn-start envelopes: the production query distribution, sampled
  // deterministically so a re-run is comparable. Same sampling as the sibling
  // acceptance CLI, on purpose — the two runs should be talking about the same
  // queries.
  const rows = (await sql`
    SELECT text
      FROM harness_shared.session_turns
     WHERE (workspace_id = ${WORKSPACE} OR workspace_id = 'default')
       AND speaker = 'user'
       AND length(text) BETWEEN 200 AND 8000
     ORDER BY md5(source_kind || session_id || turn_idx::text || ${SEED})
     LIMIT ${QUERIES}
  `) as unknown as Array<{ text: string }>;

  const texts = rows.map((r) => r.text);
  console.log(`sampled ${texts.length} real user turns (seed=${SEED}, workspace=${WORKSPACE})`);

  let embedder: Embedder | null = null;
  if (USE_EMBEDDER) {
    const inner = await buildQueryEmbedder({ acquireBudgetMs: 5_000 });
    if (inner) {
      const cache = new Map<string, Promise<number[]>>();
      embedder = (t: string) => {
        const hit = cache.get(t);
        if (hit) return hit;
        const p = inner(t);
        cache.set(t, p);
        return p;
      };
    } else {
      console.log('⚠ --hybrid requested but no embedder could be acquired — running BM25-only.');
    }
  }

  const rand = rng(SEED);
  const reports: QueryReport[] = [];
  for (const text of texts) {
    const r = await measureQuery(sql, text, embedder, rand);
    if (r) reports.push(r);
  }

  if (reports.length === 0) {
    console.log('no query produced candidates — nothing to measure.');
    return;
  }
  console.log('');
  console.log(render(reports, bound, embedder !== null));
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
