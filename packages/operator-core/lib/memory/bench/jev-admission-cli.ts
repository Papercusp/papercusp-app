/**
 * Jev admission bench CLI (plan jev-decision-model-integration-2026-09-29, P-004).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/jev-admission-cli.ts \
 *     [--encoding state|instructions] [--floor-c 0.52] [--thresholds 0.3,0.4,…] \
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
 *   D  A's candidates filtered by a ZeroEntropy rerank score (no new vendor)
 *
 * Every Jev call goes through the process decision client, so it lands in
 * harness_shared.decision_model_calls (consumer `memory-bench`, P-003), and every
 * grade is cached in harness_shared.search_judge_grades so a re-run is free.
 * `--fresh` bypasses cache READS (grades are still written) — use it when the
 * latency budget has to be measured, since a cached grade has no latency.
 *
 * Needs PG, an embedder for the cosine leg, the Jev key (Settings > Memory, or
 * setup:save_integration_key TYPESAFE_API_KEY) and, for arm D, a ZeroEntropy key.
 * Artifacts land under .papercusp/bench-reports/jev-admission-<stamp>.{json,md}.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getOrgPg } from '@papercusp/db-org';
import { JEV_PINNED_MODEL } from '@papercusp/decision-model';
import { runGoldSet, seedCorpus, type CandidateHit, type QueryOutcome } from '@papercusp/memory/bench';
import { rerank, type RerankDegradeReason } from '@papercusp/rerank';

import { readCredentials } from '../../credentials';
import { decisionModelLedgerStats } from '../../decision-model-ledger';
import { activeWorkspaceId } from '../../workspace-registry';
import { pushSearchFloors } from '../injection';
import { ensureJevDecisionClient, JEV_MEMORY_TIMEOUT_MS, readJevApiKey } from '../jev-settings';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import {
  ADMISSION_THRESHOLDS,
  ARM_C_FLOOR,
  admissionRubricVersion,
  buildAdmissionRequest,
  evaluateFilterArm,
  gradeDocId,
  readCachedScores,
  renderAdmissionMarkdown,
  scoresFromDecision,
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

const encoding = (argValue('--encoding') ?? 'state') as AdmissionEncoding;
if (encoding !== 'state' && encoding !== 'instructions') throw new Error(`--encoding must be state|instructions, got ${encoding}`);
const floorC = argValue('--floor-c') ? Number(argValue('--floor-c')) : ARM_C_FLOOR;
const thresholds =
  argValue('--thresholds')?.split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 1) ?? [...ADMISSION_THRESHOLDS];
const fresh = process.argv.includes('--fresh');
const withRerank = !process.argv.includes('--no-rerank');
const concurrency = argValue('--concurrency') ? Math.max(1, Number.parseInt(argValue('--concurrency')!, 10)) : 4;
const keep = process.argv.includes('--keep');
const log = (m: string) => console.log(new Date().toISOString().slice(11, 19), m);

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
const gold = loadGoldSetFixture().queries;
const workspaceId = activeWorkspaceId();
const runId = `jev-admission-${randomUUID()}`;
const sql = getOrgPg().sql as unknown as GradeCacheSql;
const warn = (m: string) => console.warn(`[jev-admission] ${m}`);
const client = ensureJevDecisionClient();

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
    rubricVersion: admissionRubricVersion(encoding, floor),
  };
  return mapPool(outcomes, concurrency, async (o, i) => {
    const cands = o.candidates ?? [];
    if (cands.length === 0) return undefined; // nothing admitted, nothing to judge, no call
    const query = gold[i].query;
    return cachedOr(scope, query, cands, o.queryId, async () => {
      const { request, questionIds } = buildAdmissionRequest(query, cands, encoding);
      const outcome = await client.decide(request, {
        consumer: 'memory-bench',
        subjectIds: cands.map(gradeDocId),
      });
      return scoresFromDecision(outcome, questionIds);
    });
  });
}

async function rerankScores(outcomes: readonly QueryOutcome[], floor: number): Promise<(QueryScores | undefined)[]> {
  const creds = await readCredentials().catch(() => ({}) as { zeroentropy_api_key?: string });
  const apiKey = creds.zeroentropy_api_key ?? process.env.ZEROENTROPY_API_KEY;
  const scope: GradeCacheScope = {
    workspaceId,
    judgeModel: `zeroentropy/${RERANK_MODEL}`,
    rubricVersion: `memory-admission-rerank-v1:floor=${floor.toFixed(2)}`,
  };
  return mapPool(outcomes, concurrency, async (o, i) => {
    const cands = o.candidates ?? [];
    if (cands.length === 0) return undefined;
    if (!apiKey) return { scores: null, failure: 'no-key', latencyMs: null, cached: false, inputTokens: null, costUsd: null };
    const query = gold[i].query;
    return cachedOr(scope, query, cands, o.queryId, async () => {
      let degraded: RerankDegradeReason | undefined;
      const t0 = performance.now();
      const results = await rerank(
        query,
        cands.map((c, idx) => ({ id: `${gradeDocId(c)}#${idx}`, text: c.text, row: idx })),
        {
          engine: 'zeroentropy',
          model: RERANK_MODEL,
          apiKey,
          timeoutMs: JEV_MEMORY_TIMEOUT_MS,
          onDegrade: (r) => {
            degraded = r;
          },
        },
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
  if (seeded.failed.length > 0) {
    throw new Error(
      `seeding failed for ${seeded.failed.length}/${corpus.length} corpus entries (e.g. ${seeded.failed.slice(0, 3).join(', ')}) — ` +
        'refusing to report over a partially seeded store',
    );
  }

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

  log(`arm B: Jev over floor-${floorA} candidates (${encoding} encoding${fresh ? ', fresh' : ''})…`);
  const scoresB = await jevScores(baseline, floorA);
  log(`arm C: Jev over floor-${floorC} candidates…`);
  const scoresC = await jevScores(runC.perQuery, floorC);
  const scoresD = withRerank ? (log('arm D: ZeroEntropy rerank-score threshold…'), await rerankScores(baseline, floorA)) : null;

  const arms = [
    evaluateFilterArm(baseline, { arm: 'B', label: `floor ${floorA} + Jev P(yes) ≥ t`, floor: floorA, outcomes: baseline, scores: scoresB, thresholds }),
    evaluateFilterArm(baseline, { arm: 'C', label: `floor ${floorC} + Jev P(yes) ≥ t`, floor: floorC, outcomes: runC.perQuery, scores: scoresC, thresholds }),
    ...(scoresD
      ? [evaluateFilterArm(baseline, { arm: 'D', label: `floor ${floorA} + ZeroEntropy ${RERANK_MODEL} score ≥ t`, floor: floorA, outcomes: baseline, scores: scoresD, thresholds })]
      : []),
  ];

  // The ledger writer is fire-and-forget by design; give it a bounded moment so
  // the row count this report quotes is the real one.
  const liveJevCalls = [...scoresB, ...scoresC].filter((s) => s && !s.cached).length;
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
      gold: gold.length,
      hardNegatives: gold.filter((q) => q.expected.length === 0).length,
      pushContract: `fusion ${pushFloors.fusionMode}, lexical bar ${pushFloors.minLexScore ?? 'backend default'}`,
      floors: `A/B/D ${floorA}, C ${floorC}`,
      replayLimit: REPLAY_LIMIT,
      jevModel: JEV_PINNED_MODEL,
      encoding,
      filterTimeoutMs: JEV_MEMORY_TIMEOUT_MS,
      thresholds,
      cacheReads: fresh ? 'bypassed (--fresh)' : 'on',
      rerank: withRerank ? `zeroentropy/${RERANK_MODEL}` : 'skipped (--no-rerank)',
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
