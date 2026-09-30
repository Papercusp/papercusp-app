/**
 * labelled-relevance-cli.ts — run P-038's labelled relevance pass against the
 * LIVE hybrid stack (plan semantic-search-fingerprint-coverage-2026-08-03,
 * D-079 / WI-37638).
 *
 * Samples REAL mid/long queries from `tool_invocations` per D-079's strata,
 * runs each through the same engine path `search:semantic` uses, judges the
 * top-k with the frozen, content-versioned search rubric, and scores each ranking
 * with `evaluateRelevance` from `@papercusp/search-core`.
 *
 * READ-ONLY against PG. It writes one JSON artifact to disk and nothing else.
 *
 * ⚠ COSTS MONEY: ~1,500 judge calls at 150 queries x k=10 ≈ $12-15. Always
 * `--dry-run` first — it does the sampling and the retrieval, prints what would
 * be judged, and spends nothing.
 *
 *   npx tsx packages/operator-core/lib/search/bench/labelled-relevance-cli.ts --dry-run
 *   npx tsx ... --queries 150 --k 10 --seed p038-labelled-v1
 *   npx tsx ... --secondary            # the memory/recipes strata, REPORTED SEPARATELY
 *   npx tsx ... --pool-all             # label the WHOLE fused pool (2.4x cost) — see below
 *
 * ⚠ `--pool-all` COSTS 2.4x A NORMAL RUN. It judges every candidate in the fused
 * pool instead of only the k that make the page — at k=10 that is
 * `rerankCandidateCount(10)` = 24 candidates per query, so ~$3.5/arm at 20
 * queries on the anthropic-direct judging path. It exists for D-084's floor
 * study, which needs labels for the candidates a floor would CUT; those never
 * reach the page and are invisible to every top-k metric. The aggregates are
 * UNCHANGED by it — they stay top-k, so a pool run is still directly comparable
 * with D-083 (see the denominator trap on `rollUp`).
 */
import fs from 'node:fs';

import type { SearchHit } from '@papercusp/search';

import { llmCall } from '../../llm-testing/llm-client';
import {
  JUDGE_AGREEMENT_MODEL,
  JUDGE_AGREEMENT_RUBRIC_VERSION,
  judgeRelevance,
} from './judge-agreement';
import { createCachedJudge, isReapablePath } from './judge-cache';
import {
  DOC_CHARS,
  formatLabelledReport,
  runLabelledPass,
  type QueryOutcome,
  type RankedHit,
  type RetrievalResult,
} from './labelled-relevance';
import {
  allocateProportional,
  queryCensusSql,
  querySampleSql,
  SEARCH_STACK_TOOLS,
  SECONDARY_STRATUM_TOOLS,
  type QueryStratum,
  type SampledQuery,
} from './query-sample';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * The text the judge scores.
 *
 * ⚠ This is the RESULT AS PRESENTED — the 200-char excerpt plus the
 * match-centred `ts_headline` — not the full document. `SearchHit` carries no
 * body, and re-fetching one per source would mean writing per-source SQL, i.e.
 * forking the source registry to run a bench against it.
 *
 * It is also arguably the right thing to measure: the rubric asks whether a
 * person issuing this query would be satisfied to find this among the results,
 * and this is what they would actually see. But it biases in ONE direction and
 * the report must say so — a document whose relevance only becomes visible
 * deeper in its body can be under-scored here. See the caveat emitted below.
 */
function judgedText(hit: { excerpt: string; highlight: string; source: string }): string {
  const marked = hit.highlight.replace(/<\/?mark>/g, '');
  const parts = [hit.excerpt.trim(), marked.trim()].filter(Boolean);
  const deduped = parts[1] && parts[0]?.includes(parts[1]) ? [parts[0]] : parts;
  return `[${hit.source}] ${deduped.join('\n…\n')}`.slice(0, DOC_CHARS);
}

/**
 * One engine hit → the bench's `RankedHit`, carrying ALL THREE per-hit
 * magnitudes D-084 enumerated so the floor study can plot against each:
 * `score` (fused RRF — rank-derived, in nobody's units), `rankerScores`
 * (pre-fusion native), and `rerankScore` (the cross-encoder judgement, the only
 * one a floor can actually be expressed in).
 *
 * ⚠ `rerankScore` is spread CONDITIONALLY on purpose — a candidate the
 * cross-encoder never scored must arrive with the property ABSENT, never 0
 * (D-085's load-bearing invariant). `rerankScore: h.rerankScore` would write
 * `undefined` for those under a non-exactOptionalPropertyTypes reading and
 * `?? 0` would collapse "never judged" into "judged maximally irrelevant" —
 * which, since a degrade hits every row of a call, is what makes a floor
 * calibrated on a dead engine come out HIGH.
 */
function toRankedHit(h: SearchHit, i: number): RankedHit {
  return {
    docId: `${h.source}:${h.source_id}`,
    docText: judgedText(h),
    rank: i + 1,
    source: h.source,
    score: h.score,
    ...(h.rankerScores ? { rankerScores: h.rankerScores } : {}),
    ...(typeof h.rerankScore === 'number' ? { rerankScore: h.rerankScore } : {}),
  };
}

async function main(): Promise<void> {
  const wanted = argInt('--queries', 150);
  const k = argInt('--k', 10);
  const seed = argValue('--seed') ?? 'p038-labelled-v1';
  const dryRun = process.argv.includes('--dry-run');
  const secondary = process.argv.includes('--secondary');
  // WI-37638 follow-up: the CONTROL ARM for Stage B. The v1 pass applied
  // `rerankProseHits` to every stratum uniformly, which measured a pipeline the
  // live tools do not all run — `docs:search`, `plans:search` and
  // `work_items:search` have NO rerank stage at all. Without an off-arm the v1
  // numbers cannot say what Stage B is worth on any surface.
  //
  // The control is the fused RRF order truncated at k — deliberately NOT a
  // second retrieval path: it is byte-identical to what `rerankProseHits`
  // already returns through its own fail-safe passthrough, so the arms differ
  // in exactly one thing. Over-fetch stays at `rerankCandidateCount(k)` in BOTH
  // arms so the fused pool being cut is the same pool.
  const noRerank = process.argv.includes('--no-rerank');
  // D-084's whole-pool floor study. Judges every over-fetched candidate, not
  // just the k that make the page — the floor's whole question is about the
  // candidates it would CUT, and those are exactly the ones a top-k pass never
  // labels. 2.4x the judge calls at k=10; the aggregates stay top-k.
  const poolAll = process.argv.includes('--pool-all');
  const tools = secondary ? SECONDARY_STRATUM_TOOLS : SEARCH_STACK_TOOLS;

  const [{ runHybridSearch }, { SEARCH_SOURCES }, { buildQueryEmbedder }, { activeWorkspaceId }, { getOrgPg }] =
    await Promise.all([
      import('@papercusp/search'),
      import('../../agent-tools/search/sources'),
      import('../../agent-tools/search/embedder'),
      import('../../workspace-registry'),
      import('@papercusp/db-org'),
    ]);
  const { rerankProseHits, rerankCandidateCount } = await import('../../agent-tools/search/rerank');

  const { sql } = getOrgPg();
  const workspaceId = activeWorkspaceId();

  // ---- Sample -------------------------------------------------------------
  // Re-measure the census rather than hard-coding D-079's table: it is a
  // property of a growing telemetry table, and an allocation computed from a
  // stale denominator mis-weights every stratum.
  const census = await sql.unsafe<QueryStratum[]>(queryCensusSql(workspaceId, tools));
  // `--tools a,b` RESTRICTS the census to named strata before allocation.
  //
  // Why this exists: allocation is PROPORTIONAL to each stratum's distinct-query
  // count, which is correct for a headline number but makes a small stratum
  // unstudiable. Measured 2026-08-12 at --queries 40 the census was
  // sessions=16 fulltext=11 work_items=8 docs=4 plans=1 semantic=0 — so the two
  // strata that carry NO rerank stage live (docs, plans), i.e. exactly the ones
  // an adoption decision is about, drew n=4 and n=1. No amount of total N fixes
  // that ratio; the small strata stay small.
  //
  // Restricting the census first makes `--queries` spend entirely WITHIN the
  // named strata, so `--tools docs:search,plans:search --queries 30` is a real
  // 15/15 study instead of 4/1 buried in a run dominated by other surfaces.
  // Proportional allocation is unchanged for every existing invocation.
  const onlyTools = (argValue('--tools') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  // Annotated as a plain array, NOT inferred from `census`: the query returns a
  // postgres.js RowList, and `.filter()` yields a bare array that will not
  // assign back into a RowList-typed binding.
  let censusForAlloc: QueryStratum[] = census;
  if (onlyTools.length) {
    censusForAlloc = census.filter((c) => onlyTools.includes(c.tool));
    const missing = onlyTools.filter((t) => !census.some((c) => c.tool === t));
    if (censusForAlloc.length === 0) {
      // Fail loudly. A silently-empty restriction would sample nothing and the
      // pass would report a clean, confident zero — the failure shape this
      // bench has already been bitten by twice.
      console.error(
        `[labelled] --tools matched NO stratum in the census. asked=${JSON.stringify(onlyTools)} ` +
          `available=${JSON.stringify(census.map((c) => c.tool))}`,
      );
      process.exitCode = 1;
      return;
    }
    if (missing.length) console.warn(`[labelled] --tools: no census rows for ${JSON.stringify(missing)} — ignoring those`);
    console.log(`[labelled] --tools restriction ACTIVE: ${censusForAlloc.map((c) => c.tool).join(',')}`);
  }
  const allocation = allocateProportional(censusForAlloc, wanted);
  console.log(
    `[labelled] census: ` +
      allocation.map((a) => `${a.tool}=${a.want}/${a.distinct}`).join(' ') +
      ` (total ${allocation.reduce((s, a) => s + a.want, 0)})`,
  );

  const queries: SampledQuery[] = [];
  for (const a of allocation) {
    if (a.want === 0) continue;
    queries.push(...(await sql.unsafe<SampledQuery[]>(querySampleSql(workspaceId, a.tool, a.want, seed))));
  }
  if (queries.length === 0) {
    console.error('[labelled] nothing to measure — the sample is empty');
    process.exitCode = 1;
    return;
  }

  // ---- Retrieval ----------------------------------------------------------
  // ⚠ THE DEGRADE TRAP. A null embedder silently degrades the engine to
  // lexical-only. This pass would then rank with keywords and report it as
  // hybrid — the same class D-031 caught from the other side. It is not
  // guarded per query only: acquiring it is attempted ONCE here, and a failure
  // aborts rather than measuring 150 queries of the wrong system.
  const embedder = await buildQueryEmbedder({ acquireBudgetMs: 30_000 }).catch(() => null);
  if (!embedder && !dryRun) {
    console.error(
      `[labelled] REFUSING TO RUN: the query embedder is unavailable, so the engine would degrade ` +
        `to lexical-only. That measures a DIFFERENT system than the hybrid stack this pass is ` +
        `about, and would spend ~$12-15 to do it. Bring the embed sidecar up and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  // Every registered source, not `search:semantic`'s 4-surface no-scope
  // default: the sampled queries were issued to six different search tools
  // (docs, work-items, plans, sessions, …), and restricting the corpus to four
  // surfaces would make a large share of them structurally unanswerable and
  // then score that as poor relevance.
  const sources = SEARCH_SOURCES;

  const retrieve = async (query: string): Promise<RetrievalResult> => {
    const startedAt = Date.now();
    const { results, legs } = await runHybridSearch(sources, {
      sql,
      query,
      workspaceId,
      scopeFilter: null,
      // Stage B over-fetch, exactly as the live tool sizes it.
      limit: rerankCandidateCount(k),
      mode: 'hybrid' as const,
      embedder,
      embedTimeoutMs: 30_000,
      signal: new AbortController().signal,
      deferHighlight: false,
    });

    // POOL MODE reorders the pool WITHOUT cutting it (`rerankRows`' documented
    // "pass rows.length rather than your page size" case) so every candidate
    // comes back carrying its cross-encoder score. The page is then this list's
    // top-k prefix.
    //
    // ⚠ WHY THE PAGE IS UNPERTURBED BY THE WIDER SLICE — the property the whole
    // arm's comparability rests on. In `rankWithReranker` the slice reaches only
    // two places: `W = window ?? max(limit, 15)` and the trailing
    // `.slice(0, limit)` (search-core/src/rank.ts:159,182). Both cut a list that
    // was ALREADY fully sorted by (rerank bucket, qualityScore), and V8's sort is
    // stable, so a longer cut of the same sorted array shares its prefix
    // exactly. The one path that could reorder rather than cut is the tiered
    // `llmRerank` escalation — and `rerankProseHits` passes no `llm`, so it
    // cannot fire here. `runLabelledPass` re-checks the prefix per query anyway,
    // before spending a cent: this reasoning is about the code as it stands, and
    // the invariant must hold for the code as it lands.
    const sliceTo = poolAll ? results.length : k;

    // `attempted` is necessary-not-sufficient (WI-37670): a call that resolved
    // an engine but scored zero rows returns the retrieval order, which is
    // byte-identical to no reranking at all. Require BOTH.
    let rerankApplied = false;
    const reranked = noRerank
      ? results.slice(0, sliceTo)
      : await rerankProseHits(query, results, sliceTo, {
          onOutcome: (o) => {
            rerankApplied = o.attempted && (o.scored ?? 0) > 0;
          },
        });

    const ranked = reranked.map(toRankedHit);

    return {
      hits: ranked.slice(0, k),
      // NOTE the `--no-rerank` arm carries NO `rerankScore` on any candidate:
      // the cross-encoder never ran, so there is nothing to floor on. That is
      // correct and load-bearing — the floor curve is a property of the ON arm,
      // and the OFF arm's absent scores must not be read as zeros.
      ...(poolAll ? { poolHits: ranked } : {}),
      degraded: Boolean(legs?.degraded),
      degradeWarning: legs?.warning ?? null,
      rerankApplied,
      latencyMs: Date.now() - startedAt,
    };
  };

  // ---- Dry run ------------------------------------------------------------
  if (dryRun) {
    console.log(
      `[labelled] --dry-run: sampled ${queries.length} queries; retrieving 3 of them.` +
        (poolAll ? ` POOL MODE: would judge the WHOLE fused pool per query, not just the top-${k}.` : '') +
        `\n`,
    );
    const observedPools: number[] = [];
    for (const q of queries.slice(0, 3)) {
      const r = await retrieve(q.query);
      observedPools.push(r.poolHits?.length ?? r.hits.length);
      console.log(
        `--- ${q.tool} (${q.terms} terms) degraded=${r.degraded} rerank=${r.rerankApplied} ` +
          `hits=${r.hits.length}${r.poolHits ? ` pool=${r.poolHits.length}` : ''} ${r.latencyMs}ms\nquery: ${q.query}`,
      );
      for (const h of r.hits.slice(0, 3)) {
        console.log(`   #${h.rank} ${h.docId}: ${h.docText.slice(0, 160).replace(/\s+/g, ' ')}…`);
      }
      // The candidates BELOW the page are the entire point of pool mode — they
      // are what a floor would cut and what no top-k run has ever labelled. Show
      // the magnitude a floor would be expressed in, printing an unscored one as
      // ABSENT rather than as a blank or a zero.
      for (const h of r.poolHits?.slice(k, k + 3) ?? []) {
        console.log(
          `   (below page) #${h.rank} ${h.docId} rerankScore=${h.rerankScore ?? 'ABSENT'} ` +
            `score=${h.score?.toFixed(4) ?? 'ABSENT'}`,
        );
      }
    }
    // Estimated from the pool actually MEASURED above, not from the ceiling
    // alone: a stratum whose corpus returns fewer than `rerankCandidateCount(k)`
    // candidates costs less, and quoting the ceiling as the estimate would
    // overstate the spend that is about to be authorised.
    const perQuery = poolAll ? Math.max(k, ...observedPools) : k;
    console.log(
      `\n[labelled] would judge ~${queries.length * perQuery} pairs (${perQuery}/query` +
        (poolAll
          ? `, ≈${(perQuery / k).toFixed(1)}x a top-${k} run; pool ceiling ` +
            `rerankCandidateCount(${k})=${rerankCandidateCount(k)}, observed pools ${observedPools.join(',')}`
          : '') +
        `). No judge calls made, nothing spent.`,
    );
    return;
  }

  // ---- Judge + score ------------------------------------------------------
  const out = argValue('--out') ?? `/tmp/claude-1000/p038-labelled-${Date.now()}.json`;
  const rowsPath = `${out}.rows.jsonl`;
  // Persist EVERY row AS IT LANDS, not only at the end. A paid run that dies at
  // query 120 must still be worth 120 queries — and it is the per-hit rows plus
  // the judge's own rationale, never the aggregates, that adjudicate a
  // surprising number. The pilot learned this the expensive way.
  const rowStream = fs.createWriteStream(rowsPath, { flags: 'a' });

  if (poolAll) {
    console.log(
      `[labelled] POOL MODE ACTIVE — judging the whole fused pool (ceiling ` +
        `rerankCandidateCount(${k})=${rerankCandidateCount(k)} per query, ` +
        `≈${(rerankCandidateCount(k) / k).toFixed(1)}x a top-${k} run). Every aggregate stays TOP-${k}; ` +
        `the pool labels land in outcomes[].poolHits and feed no mean.`,
    );
  }

  // ---- Judge-grade reuse ---------------------------------------------------
  // Grades are PAID DATA. They persist to Postgres keyed on the judged TEXT
  // (not rank, not tool), so the control arm — the same documents in a
  // different order — reuses this arm's judgements for free. See judge-cache.ts
  // and EI-20653219342536753, filed after ~$21.68 of grades were reaped from
  // /tmp along with the "$0 re-sweep" capability that depended on them.
  const runId = `${seed}:${Date.now()}`;
  const cached = createCachedJudge({
    sql,
    workspaceId,
    judgeModel: JUDGE_AGREEMENT_MODEL,
    rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
    runId,
    inner: (input) => judgeRelevance(input, llmCall),
    bypassReads: process.argv.includes('--no-judge-cache'),
    onWarn: (m) => console.warn(`[judge-cache] ${m}`),
  });
  if (process.argv.includes('--no-judge-cache')) {
    console.log('[labelled] --no-judge-cache: re-judging every pair. Grades are still WRITTEN, just not served.');
  }

  const report = await runLabelledPass({
    queries,
    retrieve,
    judge: cached.judge,
    k,
    judgeConcurrency: argInt('--concurrency', 4),
    sampleSeed: seed,
    log: (m) => console.log(new Date().toISOString().slice(11, 19), m),
    onQueryDone: (o: QueryOutcome) => rowStream.write(JSON.stringify(o) + '\n'),
  });

  if (secondary) {
    report.caveats.unshift(
      `⚠ SECONDARY STRATA (${SECONDARY_STRATUM_TOOLS.join(', ')}): long agent-written INTENTS aimed at ` +
        `the memory/recipe backends, NOT queries put to the search stack. D-079 requires these be ` +
        `reported separately and NEVER pooled into the headline number.`,
    );
  }
  report.caveats.push(
    `The judge scored the RESULT AS PRESENTED (200-char excerpt + match-centred headline, ` +
      `capped at ${DOC_CHARS} chars), not the full document. This biases in one direction: a ` +
      `document whose relevance is only visible deeper in its body can be under-scored.`,
    `Corpus = every registered SearchSource (${sources.length}), not search:semantic's 4-surface ` +
      `no-scope default — the sampled queries were issued to six different search tools.`,
  );

  report.caveats.push(`Judge-grade reuse — ${cached.summary()}. Grades persist in harness_shared.search_judge_grades.`);

  rowStream.end();
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log('\n' + formatLabelledReport(report) + '\n');
  console.log(`[labelled] ${cached.summary()}`);
  console.log(`wrote full report: ${out}\nwrote per-query rows as they landed: ${rowsPath}`);
  // The grades themselves are safe in Postgres now; this only concerns the
  // human-readable artifact. Say so, so a reaped file is never again mistaken
  // for lost evidence (EI-20653219342536753).
  if (isReapablePath(out)) {
    console.warn(
      `\n⚠ ${out} is under a reapable temp path and WILL eventually be deleted.\n` +
        `  The judgements are durable regardless (harness_shared.search_judge_grades, run_id=${runId}),\n` +
        `  but copy this report somewhere durable if you intend to cite it later.`,
    );
  }
}

await main();
process.exit(0);
