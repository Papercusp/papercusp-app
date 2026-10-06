/**
 * Jev admission bench CLI (plan jev-decision-model-integration-2026-09-29, P-004).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/jev-admission-cli.ts \
 *     [--encoding state|instructions] [--variant v1|v2-content|substance|score|pair] \
 *     [--floor-c 0.52] [--thresholds 0.3,0.4,…] \
 *     [--fresh] [--no-rerank] [--concurrency 4] [--keep]
 *
 * Seeds ONE isolated bench store (hybrid-pg, the production backend) with the
 * frozen corpus, replays the frozen gold set at the LIVE push contract (the
 * floor, fusion mode and lexical bar come from `pushSearchFloors()`, never a
 * re-declared constant), then runs four arms over the captured candidates:
 *
 *   A  the production floor alone — the baseline, re-measured here (D-007)
 *   B  A's candidates filtered by Jev P(yes)
 *   C  a 0.52 floor filtered by Jev
 *   D  A's candidates filtered by a rerank score from the engine prose search
 *      resolves on this host (D-010): ZeroEntropy with a key, else the local
 *      cross-encoder. Its own bound (--rerank-timeout-ms, default the prose 4s) at
 *      concurrency 1; the 400 ms latency bar is still judged on its p95.
 *
 * Every Jev call goes through the process decision client, so it lands in
 * harness_shared.decision_model_calls (consumer `memory-bench`, P-003), and every
 * grade is cached in harness_shared.search_judge_grades so a re-run is free.
 * `--fresh` bypasses cache READS (grades are still written) — use it when the
 * latency budget has to be measured, since a cached grade has no latency.
 *
 * Needs PG, an embedder for the cosine leg, the Jev key (Settings > Memory, or
 * setup:save_integration_key TYPESAFE_API_KEY). For a production-faithful arm D on a
 * sidecar host, export PAPERCUSP_EMBED_SIDECAR_URL (the systemd units' value) so the
 * reranker runs warm in the sidecar, not cold in this process.
 * Artifacts land under .papercusp/bench-reports/jev-admission-<stamp>.{json,md}.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getOrgPg } from '@papercusp/db-org';
import { JEV_PINNED_MODEL } from '@papercusp/decision-model';
import { runGoldSet, seedCorpus, seedFailureReason, type CandidateHit, type QueryOutcome } from '@papercusp/memory/bench';
import { rerank, type RerankDegradeReason } from '@papercusp/rerank';

import { PROSE_RERANK_TIMEOUT_MS, resolveProseRerankEngine } from '../../agent-tools/search/rerank';
import { decisionModelLedgerStats } from '../../decision-model-ledger';
import { activeWorkspaceId } from '../../workspace-registry';
import { pushSearchFloors } from '../injection';
import { ensureJevDecisionClient, JEV_MEMORY_TIMEOUT_MS, readJevApiKey } from '../jev-settings';
import { llmCall } from '../../llm-testing/llm-client';
import { DOC_CHARS, JUDGE_AGREEMENT_MODEL, JUDGE_AGREEMENT_RUBRIC_VERSION, judgeRelevance, RELEVANCE_PASS_BAR } from '../../search/bench/judge-agreement';
import { createCachedJudge } from '../../search/bench/judge-cache';
import { loadCorpusFixture } from './corpus';
import { GOLD_SET_FIXTURE_VERSION, GOLD_SET_FIXTURE_VERSIONS, loadGoldSetFixture } from './gold-set';
import {
  ADMISSION_THRESHOLDS,
  ARM_C_FLOOR,
  admissionRubricVersion,
  evaluateFilterArm,
  gradeDocId,
  judgeAdmission,
  negativeJudgePairs,
  parseAdmissionEncoding,
  parseAdmissionVariant,
  readCachedScores,
  renderAdmissionMarkdown,
  scoresFromJudgement,
  summarizeArm,
  writeCachedScores,
  type AdmissionEncoding,
  type AdmissionReport,
  type GradeCacheScope,
  type GradeCacheSql,
  type QueryScores,
} from './jev-admission';
import { BENCH_SCOPE, makeBackendCtx } from './run-bench';

const RERANK_MODEL = 'zerank-2';
const REPLAY_LIMIT = 10;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const encoding: AdmissionEncoding = parseAdmissionEncoding(argValue('--encoding'));
const variant = parseAdmissionVariant(argValue('--variant'));
const floorC = argValue('--floor-c') ? Number(argValue('--floor-c')) : ARM_C_FLOOR;
const thresholds =
  argValue('--thresholds')?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 1) ?? [...ADMISSION_THRESHOLDS];
const fresh = process.argv.includes('--fresh');
const withRerank = !process.argv.includes('--no-rerank');
const concurrency = argValue('--concurrency') ? Math.max(1, Number.parseInt(argValue('--concurrency')!, 10)) : 4;
const keep = process.argv.includes('--keep');
// Which frozen gold set to replay. v2 = v1 + 60 near-miss hard negatives (P-002);
// the default stays v1 so earlier reports remain comparable run-for-run.
const goldVersion = argValue('--gold') ?? GOLD_SET_FIXTURE_VERSION;
if (!(GOLD_SET_FIXTURE_VERSIONS as readonly string[]).includes(goldVersion)) {
  console.error(`--gold ${goldVersion} is not a gold-set fixture version (${GOLD_SET_FIXTURE_VERSIONS.join(', ')})`);
  process.exit(2);
}
// LLM-grade every floor-surviving hard-negative pair with the search-relevance
// rubric, so a mislabeled "off-topic" question is caught before it scores a variant.
const judgeNegatives = process.argv.includes('--judge-negatives');
// Arm D's stage bound. NOT the Jev push budget: run 3 (2026-09-30) passed 400 ms
// to the local scorer and its gate shed all 123 calls, so the arm measured
// nothing. Default to the bound production prose search gives the same engine.
// The 400 ms adoption bar still applies — evaluateFilterArm fails any arm whose
// p95 exceeds it — so a slower engine is judged on latency, not voided.
const rerankTimeoutMs = argValue('--rerank-timeout-ms')
  ? Math.max(1, Number.parseInt(argValue('--rerank-timeout-ms')!, 10))
  : PROSE_RERANK_TIMEOUT_MS;
// The local scorer is ONE serialized resource with flat throughput across
// concurrency (WI-37676), so parallel calls only queue and shed. One at a time
// measures the per-call latency a single push injection would see.
const RERANK_CONCURRENCY = 1;
// Arm D's own threshold grid. The shared grid is scaled to Jev's P(yes), and the
// local cross-encoder scores this corpus far higher: run 4 (2026-09-30) put
// hard-negative candidates at median 0.84 and positive-query candidates at 0.92,
// so a grid capped at 0.8 could not reach arm D's only possible operating point.
// Extend to 0.975 so arm D is judged on its whole range, not on the grid's edge.
const rerankThresholds = [...new Set([...thresholds, 0.85, 0.9, 0.925, 0.95, 0.975])].sort((a, b) => a - b);
// Which transport the local scorer runs over. Production hosts run it warm in the
// embed sidecar; without a URL this process loads the model cold, in-process.
const sidecarUrl = process.env.PAPERCUSP_EMBED_SIDECAR_URL?.trim() || null;
const log =(m: string) => console.log(new Date().toISOString().slice(11, 19), m);

/** Bounded-concurrency map that preserves index alignment. */
async function mapPool<T, R>(items: readonly T[], width: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length || 1) }, worker));
  return out;
}

const pushFloors = pushSearchFloors();
const floorA = pushFloors.minScore;
if (floorA === undefined) throw new Error('the live push path has no cosine floor — arm A is undefined, nothing to compare against');

const jevKey = await readJevApiKey();
if (!jevKey) {
  console.error('No Jev key stored (TYPESAFE_API_KEY). Save one in Settings > Memory, then re-run. Arms B and C cannot run.');
  process.exit(2);
}

const corpus = loadCorpusFixture();
const gold = loadGoldSetFixture(goldVersion).queries;
const workspaceId = activeWorkspaceId();
const runId = `jev-admission-${randomUUID()}`;
const sql = getOrgPg().sql as unknown as GradeCacheSql;
const warn = (m: string) => console.warn(`[jev-admission] ${m}`);
const client = ensureJevDecisionClient();
/** Live Jev requests sent (a cached query sends none; a `pair` query sends one per candidate). */
let liveJevCalls = 0;

async function cachedOr(
  scope: GradeCacheScope,
  query: string,
  cands: readonly CandidateHit[],
  pairId: string,
  live: () => Promise<QueryScores>,
): Promise<QueryScores> {
  if (!fresh) {
    const hit = await readCachedScores(sql, scope, query, cands).catch((e: unknown) => {
      warn(`cache read failed (${String(e)}) — judging live`);
      return null;
    });
    if (hit) return hit;
  }
  const result = await live();
  await writeCachedScores(sql, scope, query, cands, result, { pairId, runId }).catch((e: unknown) =>
    warn(`cache write failed: ${String(e)}`),
  );
  return result;
}

async function jevScores(outcomes: readonly QueryOutcome[], floor: number): Promise<(QueryScores | undefined)[]> {
  const scope: GradeCacheScope = {
    workspaceId,
    judgeModel: `typesafe/${JEV_PINNED_MODEL}`,
    rubricVersion: admissionRubricVersion(encoding, floor, variant),
  };
  return mapPool(outcomes, concurrency, async (o, i) => {
    const cands = o.candidates ?? [];
    if (cands.length === 0) return undefined; // nothing admitted, nothing to judge, no call
    const query = gold[i].query;
    return cachedOr(scope, query, cands, o.queryId, async () =>
      scoresFromJudgement(
        await judgeAdmission(query, cands, encoding, variant, (request, call) => {
          liveJevCalls += 1;
          return client.decide(request, { consumer: 'memory-bench', subjectIds: call.candidates.map((ci) => gradeDocId(cands[ci])) });
        }),
      ),
    );
  });
}

type RerankEngineD = Awaited<ReturnType<typeof resolveProseRerankEngine>>;

/** Report/cache label for the engine arm D actually ran. */
function rerankEngineLabel(engine: RerankEngineD): string {
  if (engine === null) return 'none';
  return engine.engine === 'zeroentropy' ? `zeroentropy/${RERANK_MODEL}` : 'local/sidecar-reranker';
}

/** Report label: engine, transport, bound and width — what arm D's latency means. */
function rerankRunLabel(engine: RerankEngineD): string {
  const transport =
    engine === null
      ? 'n/a'
      : engine.engine === 'zeroentropy'
        ? 'hosted API'
        : sidecarUrl
          ? `embed sidecar ${sidecarUrl}`
          : 'IN-PROCESS model (no PAPERCUSP_EMBED_SIDECAR_URL; production runs it warm in the sidecar)';
  return `${rerankEngineLabel(engine)} via ${transport}; timeout ${rerankTimeoutMs} ms; concurrency ${RERANK_CONCURRENCY}; thresholds [${rerankThresholds.join(',')}]`;
}

async function rerankScores(
  outcomes: readonly QueryOutcome[],
  floor: number,
  engine: RerankEngineD,
): Promise<(QueryScores | undefined)[]> {
  // Arm D runs the engine prose search resolves on this host (D-010): ZeroEntropy
  // when a key is stored, else the local scorer. With neither, every query fails open.
  const scope: GradeCacheScope = {
    workspaceId,
    judgeModel: rerankEngineLabel(engine),
    rubricVersion: `memory-admission-rerank-v1:floor=${floor.toFixed(2)}`,
  };
  return mapPool(outcomes, RERANK_CONCURRENCY, async (o, i) => {
    const cands = o.candidates ?? [];
    if (cands.length === 0) return undefined;
    if (engine === null) return { scores: null, failure: 'no-key', latencyMs: null, cached: false, inputTokens: null, costUsd: null };
    const query = gold[i].query;
    return cachedOr(scope, query, cands, o.queryId, async () => {
      let degraded: RerankDegradeReason | undefined;
      const onDegrade = (r: RerankDegradeReason) => {
        degraded = r;
      };
      const t0 = performance.now();
      const results = await rerank(
        query,
        cands.map((c, idx) => ({ id: `${gradeDocId(c)}#${idx}`, text: c.text, row: idx })),
        engine.engine === 'zeroentropy'
          ? { engine: 'zeroentropy', model: RERANK_MODEL, apiKey: engine.apiKey, timeoutMs: rerankTimeoutMs, onDegrade }
          : { engine: 'local', scorer: engine.scorer, timeoutMs: rerankTimeoutMs, onDegrade },
      );
      const latencyMs = performance.now() - t0;
      const scores = new Array<number | undefined>(cands.length);
      for (const r of results) if (r.reranked) scores[r.row] = r.score;
      if (degraded !== undefined || scores.some((s) => s === undefined) || results.length !== cands.length) {
        return {
          scores: null,
          failure: degraded ?? 'partial-scores',
          latencyMs,
          cached: false,
          inputTokens: null,
          costUsd: null,
        };
      }
      return { scores: scores as number[], latencyMs, cached: false, inputTokens: null, costUsd: null };
    });
  });
}

const ctx = await makeBackendCtx('hybrid-pg', keep);
let exitCode = 0;
try {
  log(`[hybrid-pg] seeding ${corpus.length} corpus entries…`);
  const seeded = await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
  // INSTRUMENT GUARDS. Measured 2026-09-30: seeding returned no ids for all 114
  // entries and every query then retrieved nothing; the bench still printed a
  // verdict. A report over a store that was never populated is not a measurement.
  const seedFailure = seedFailureReason(seeded, corpus.length);
  if (seedFailure) throw new Error(`${seedFailure} — refusing to report over a partially seeded store`);

  const replay = (floor: number) =>
    runGoldSet(ctx.backend, gold, {
      scope: BENCH_SCOPE,
      limit: REPLAY_LIMIT,
      concurrency,
      minScore: floor,
      fusionMode: pushFloors.fusionMode,
      ...(pushFloors.minLexScore !== undefined ? { minLexScore: pushFloors.minLexScore } : {}),
      captureCandidates: true,
    });

  log(`replaying ${gold.length} gold queries at floor A=${floorA} and C=${floorC} (fusion ${pushFloors.fusionMode})…`);
  const runA = await replay(floorA);
  const runC = await replay(floorC);
  const baseline = runA.perQuery;
  if (!baseline.some((o) => o.expected.length > 0 && o.rawHits > 0)) {
    throw new Error('arm A retrieved nothing for every positive query — the replay is broken, refusing to report');
  }

  let negativeJudge = 'skipped (pass --judge-negatives)';
  const negativeGrades: { queryId: string; docId: string; relevance: number }[] = [];
  if (judgeNegatives) {
    const pairs = negativeJudgePairs([baseline, runC.perQuery]);
    const queryText = new Map(gold.map((q) => [q.id, q.query]));
    const cache = createCachedJudge({
      sql: getOrgPg().sql as unknown as Parameters<typeof createCachedJudge>[0]['sql'],
      workspaceId,
      judgeModel: JUDGE_AGREEMENT_MODEL,
      rubricVersion: JUDGE_AGREEMENT_RUBRIC_VERSION,
      runId,
      inner: (input) => judgeRelevance(input, llmCall, JUDGE_AGREEMENT_MODEL),
      onWarn: (m) => console.warn(`[jev-admission] ${m}`),
    });
    log(`LLM judge (${JUDGE_AGREEMENT_MODEL}) over ${pairs.length} floor-surviving hard-negative pairs…`);
    let failed = 0;
    let firstError: string | null = null;
    await mapPool(pairs, concurrency, async (p) => {
      try {
        const v = await cache.judge({ pairId: `${p.queryId}|${p.docId}`, query: queryText.get(p.queryId) ?? '', docId: p.docId, docText: p.text.slice(0, DOC_CHARS) });
        negativeGrades.push({ queryId: p.queryId, docId: p.docId, relevance: v.relevance });
      } catch (e) {
        failed += 1;
        firstError ??= e instanceof Error ? e.message : String(e);
      }
    });
    const relevant = negativeGrades.filter((g) => g.relevance >= RELEVANCE_PASS_BAR);
    negativeJudge =
      `${JUDGE_AGREEMENT_MODEL}, rubric ${JUDGE_AGREEMENT_RUBRIC_VERSION}, pass bar ${RELEVANCE_PASS_BAR}; ` +
      `${negativeGrades.length}/${pairs.length} graded, ${relevant.length} judged relevant` +
      (relevant.length > 0 ? ` (MISLABELED: ${relevant.map((g) => `${g.queryId}→${g.docId}=${g.relevance}`).join(', ')})` : '') +
      (failed > 0 ? `; ${failed} FAILED (first: ${firstError})` : '') +
      `; ${cache.summary()}`;
    log(`negative judge: ${negativeJudge}`);
  }

  log(`arm B: Jev over floor-${floorA} candidates (${encoding} encoding${fresh ? ', fresh' : ''})…`);
  const scoresB = await jevScores(baseline, floorA);
  log(`arm C: Jev over floor-${floorC} candidates…`);
  const scoresC = await jevScores(runC.perQuery, floorC);
  const engineD: RerankEngineD = withRerank ? await resolveProseRerankEngine().catch(() => null) : null;
  const engineDName =
    engineD === null ? 'no rerank engine' : engineD.engine === 'zeroentropy' ? `ZeroEntropy ${RERANK_MODEL}` : 'local reranker';
  const scoresD = withRerank ? (log(`arm D: ${engineDName} rerank-score threshold…`), await rerankScores(baseline, floorA, engineD)) : null;

  const arms = [
    evaluateFilterArm(baseline, { arm: 'B', label: `floor ${floorA} + Jev P(yes) ≥ t`, floor: floorA, outcomes: baseline, scores: scoresB, thresholds }),
    evaluateFilterArm(baseline, { arm: 'C', label: `floor ${floorC} + Jev P(yes) ≥ t`, floor: floorC, outcomes: runC.perQuery, scores: scoresC, thresholds }),
    ...(scoresD
      ? [
          evaluateFilterArm(baseline, {
            arm: 'D',
            label: `floor ${floorA} + ${engineDName} score ≥ t`,
            floor: floorA,
            outcomes: baseline,
            scores: scoresD,
            thresholds: rerankThresholds,
          }),
        ]
      : []),
  ];

  // The ledger writer is fire-and-forget by design; give it a bounded moment so
  // the row count this report quotes is the real one. `liveJevCalls` counts requests,
  // not queries: a `pair` query writes one ledger row per candidate.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const st = decisionModelLedgerStats();
    if (st.written + st.failed >= liveJevCalls) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const ledger = decisionModelLedgerStats();

  const generatedAt = new Date().toISOString();
  const report: AdmissionReport = {
    generatedAt,
    params: {
      runId,
      backend: 'hybrid-pg (isolated bench schema)',
      corpus: corpus.length,
      gold: `${gold.length} (gold-set.${goldVersion})`,
      hardNegatives: gold.filter((q) => q.expected.length === 0).length,
      negativeJudge,
      pushContract: `fusion ${pushFloors.fusionMode}, lexical bar ${pushFloors.minLexScore ?? 'backend default'}`,
      floors: `A/B/D ${floorA}, C ${floorC}`,
      replayLimit: REPLAY_LIMIT,
      jevModel: JEV_PINNED_MODEL,
      encoding,
      variant,
      filterTimeoutMs: JEV_MEMORY_TIMEOUT_MS,
      thresholds,
      cacheReads: fresh ? 'bypassed (--fresh)' : 'on',
      rerank: withRerank ? `${rerankRunLabel(engineD)} (the engine prose search resolves on this host, D-010)` : 'skipped (--no-rerank)',
      decisionLedger: `${ledger.written} rows written, ${ledger.failed} failed${ledger.lastError ? ` (last error: ${ledger.lastError})` : ''}; ${liveJevCalls} live Jev calls`,
      pricing: `Jev at the vendor list price $0.042/M input tokens, output free`,
    },
    baseline: summarizeArm('A', floorA, null, baseline),
    arms,
  };

  const perQuery = (label: string, outcomes: readonly QueryOutcome[], scores: readonly (QueryScores | undefined)[]) =>
    outcomes.map((o, i) => ({
      arm: label,
      queryId: o.queryId,
      class: o.class,
      candidates: (o.candidates ?? []).map((c, j) => ({ key: gradeDocId(c), cosine: c.score ?? null, score: scores[i]?.scores?.[j] ?? null })),
      failure: scores[i]?.failure ?? null,
      cached: scores[i]?.cached ?? null,
      latencyMs: scores[i]?.latencyMs ?? null,
    }));

  const md = renderAdmissionMarkdown(report);
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(dir, `jev-admission-${stamp}.json`);
  const mdPath = path.join(dir, `jev-admission-${stamp}.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        report,
        negativeGrades,
        perQuery: [
          ...perQuery('B', baseline, scoresB),
          ...perQuery('C', runC.perQuery, scoresC),
          ...(scoresD ? perQuery('D', baseline, scoresD) : []),
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  fs.writeFileSync(mdPath, md + '\n', 'utf8');
  console.log('\n' + md + '\n');
  console.log('wrote', jsonPath);
  console.log('wrote', mdPath);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  await ctx.cleanup();
}
process.exit(exitCode);
