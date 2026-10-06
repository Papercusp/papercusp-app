/**
 * Precision benchmark computation shared by the monitor and its standalone worker.
 *
 * Keep this module independent of monitor persistence, alerting, and work-item filing.
 * The bundled worker imports this file directly so those host orchestration paths do
 * not enter the runtime worker graph.
 */
import {
  aggregateByClass,
  latencyStats,
  runGoldSet,
  seedCorpus,
  seedFailureReason,
  type QueryOutcome,
  type SeedManifest,
} from '@papercusp/memory/bench';
import { pushSearchFloors } from '../push-search-floors';
import {
  JEV_MEMORY_ADMIT_THRESHOLD,
  JEV_MEMORY_ENCODING,
  runJevMemoryGate,
  type JevMemoryGateInput,
  type JevMemoryGateResult,
} from '../jev-memory-gate';
import { ensureJevDecisionClient } from '../jev-settings';
import { withCandidates } from './jev-admission';
import { loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { BENCH_SCOPE, makeHybridBackendCtx } from './precision-hybrid-backend';
import type { MemoryPrecisionMetrics } from './precision-read';

export const PRECISION_BENCH_RESULT_MARKER = 'PAPERCUSP_MEMORY_PRECISION_BENCH_RESULT:';
export const PRECISION_BENCH_JEV_GATE_ENV = 'PAPERCUSP_PRECISION_BENCH_JEV_GATE';
export const PRECISION_BENCH_JEV_CONSUMER = 'memory-bench';
/**
 * A run whose corpus did not FULLY seed measures NOTHING: every gold query then
 * searches an empty (or partial) pool and scores 0. Recording that as a metric is
 * strictly WORSE than not running at all —
 *
 *   (a) it reads as a catastrophic recall collapse (r@10 = 0 trips
 *       RECALL_CRITICAL_FLOOR), so the canary cries wolf on every run, and
 *   (b) it POISONS the rolling baseline the canary judges future runs against:
 *       a zeroed median can never exhibit a 'baseline-drop' again, disarming the
 *       very detector this bench exists to feed.
 *
 * EI-10793 caught this live — `bench_memory.memory_vec_harrier` was missing, all
 * 114/114 seeds failed, and THREE consecutive all-zero runs were recorded as
 * legitimate measurements while nothing alarmed — and explicitly left the detector
 * open: "a run where a backend seeds 0/N should arguably hard-fail". This is that
 * detector.
 *
 * Throwing is the correct LOUD failure: `runMemoryPrecisionMonitor` catches it into
 * `{ ran: false, skipReason: 'failed' }` — no row written, no escalation fired, the
 * error logged — and a bench that stops producing rows is visible to the routine's
 * own liveness check. A silent zero is invisible to both.
 *
 * Strict on PARTIAL seeds too, deliberately: the gold set's expected-hit
 * denominators are keyed to the FULL corpus, so a missing document silently
 * understates r@10 — i.e. it fakes a recall regression. A measuring instrument that
 * quietly measures a different corpus than the one it reports is not usable.
 */
export function assertCorpusSeeded(manifest: SeedManifest, expected: number): void {
  // Shared with every bench; it quotes the first remember() error, not just the
  // count ("114 failed" alone hid a NOT NULL schema fault for four weeks, WI-10004107).
  const reason = seedFailureReason(manifest, expected);
  if (reason === null) return;
  throw new Error(
    reason +
      ` — refusing to record a run. An unseeded corpus scores 0 for INFRASTRUCTURE reasons, not recall ` +
      `reasons; recording it would false-alarm the recall canary and poison its baseline (EI-10793).`,
  );
}

/** What the Jev leg of a gated replay did; stored under `by_class._jev`. */
export interface JevGateReplayStats {
  /** Answering model id(s), sorted and `+`-joined; null when nothing answered. */
  readonly model: string | null;
  readonly threshold: number;
  readonly encoding: string;
  /** Queries with at least one floor-admitted candidate, i.e. calls made. */
  readonly judged: number;
  readonly answered: number;
  /** Fail-open outcomes: the query kept today's set, exactly as production does. */
  readonly inconclusive: number;
  readonly reasons: Readonly<Record<string, number>>;
  /** Candidates removed across answered queries. */
  readonly dropped: number;
  readonly gateLatencyP50Ms: number | null;
}

export type JevGateFn = (input: JevMemoryGateInput) => Promise<JevMemoryGateResult>;

/** The production gate, forced On: the parent already resolved the switch for this run. */
const productionGate: JevGateFn = (input) =>
  runJevMemoryGate(input, { resolve: async () => ({ effective: 'on' }), client: ensureJevDecisionClient });

/**
 * The admission-shape tag for a gated row. The model is part of the shape: a
 * different model is a different admission function, so the recall canary must
 * not judge one against the other's baseline, and a served-model change shows
 * up as a new label on the Learning tab. Parsed back by `parseJevGateShape`.
 */
export function jevGatedShape(fusionMode: string, model: string): string {
  return `fusionMode:${fusionMode};jev:${model}/${JEV_MEMORY_ENCODING}@${JEV_MEMORY_ADMIT_THRESHOLD}`;
}

/**
 * Apply the Jev gate to a floor replay, query by query, the way the injector
 * does (plan jev-decision-model-integration-2026-09-29, P-008): the floor-admitted
 * candidates go to the REAL `runJevMemoryGate`, an answered verdict keeps the
 * candidates with `keep[i]`, and anything inconclusive keeps today's set (fail
 * open, D-002). A query the floor admitted nothing for makes no call.
 */
export async function gateReplayWithJev(
  outcomes: readonly QueryOutcome[],
  queryText: ReadonlyMap<string, string>,
  gate: JevGateFn = productionGate,
  concurrency = 4,
): Promise<{ outcomes: QueryOutcome[]; stats: JevGateReplayStats }> {
  const gated: QueryOutcome[] = [...outcomes];
  const models = new Set<string>();
  const reasons: Record<string, number> = {};
  const latencies: number[] = [];
  let judged = 0;
  let answered = 0;
  let dropped = 0;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < outcomes.length) {
      const i = next++;
      const o = outcomes[i];
      const candidates = o.candidates;
      if (!candidates) throw new Error(`gateReplayWithJev: query ${o.queryId} was replayed without captureCandidates`);
      if (candidates.length === 0) continue;
      const message = queryText.get(o.queryId);
      if (message === undefined) throw new Error(`gateReplayWithJev: no query text for ${o.queryId}`);
      judged += 1;
      const started = Date.now();
      const verdict = await gate({
        message,
        candidates: candidates.map((c) => ({ id: c.id, text: c.text })),
        consumer: PRECISION_BENCH_JEV_CONSUMER,
      });
      latencies.push(Date.now() - started);
      if (verdict.effective === 'on' && verdict.outcome === 'answered') {
        if (verdict.keep.length !== candidates.length) {
          throw new Error(`gateReplayWithJev: ${verdict.keep.length} verdicts for ${candidates.length} candidates on ${o.queryId}`);
        }
        answered += 1;
        models.add(verdict.model);
        const kept = candidates.filter((_, j) => verdict.keep[j]);
        dropped += candidates.length - kept.length;
        gated[i] = withCandidates(o, kept);
      } else {
        const reason = verdict.effective === 'on' && verdict.outcome === 'inconclusive' ? verdict.reason : `effective-${verdict.effective}`;
        reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, outcomes.length)) }, worker));

  return {
    outcomes: gated,
    stats: {
      model: models.size > 0 ? [...models].sort().join('+') : null,
      threshold: JEV_MEMORY_ADMIT_THRESHOLD,
      encoding: JEV_MEMORY_ENCODING,
      judged,
      answered,
      inconclusive: judged - answered,
      reasons,
      dropped,
      gateLatencyP50Ms: latencies.length > 0 ? latencyStats(latencies).p50 : null,
    },
  };
}

/**
 * Run the floored hybrid gold-set ONCE and return the metrics (no DB write).
 * Exported for a CLI / one-off seeding run and for the isolated worker's core.
 * With `jevGate`, the replay then goes through the Jev gate (P-008) and the
 * metrics describe the gated set.
 */
export async function benchMemoryPrecision(
  opts: { jevGate?: boolean; gate?: JevGateFn } = {},
): Promise<MemoryPrecisionMetrics> {
  const corpus = loadCorpusFixture('v1');
  const gold = loadGoldSetFixture('v1');
  const ctx = await makeHybridBackendCtx(false);
  try {
    const manifest = await seedCorpus(ctx.backend, corpus, { scope: BENCH_SCOPE, verbatim: true, concurrency: 8 });
    // The manifest was previously DISCARDED — which is exactly how a total seed
    // failure became "recall = 0" instead of "the bench could not run".
    assertCorpusSeeded(manifest, corpus.length);
    // WI-7179: read all three admission values from pushSearchFloors() — the
    // SAME constructor `buildBlockInner` runs for the live push path — instead
    // of re-declaring them. A copied constant (the old `fusionMode:
    // 'floored-union'` literal below, paired with imported floor constants)
    // cannot notice production has moved on: D-010 flipped the push default to
    // `cosine-gated` and this monitor kept measuring the retired shape, which
    // is precisely the failure mode `pushSearchFloors()`'s own doc comment
    // names this file as the example of. Pattern proven on floor-sweep-cli.ts.
    const f = pushSearchFloors();
    const retrieval = await runGoldSet(ctx.backend, gold.queries, {
      scope: BENCH_SCOPE,
      limit: 10,
      concurrency: 4,
      // Measure the EXACT production push floor — the whole point is monitoring
      // the LIVE injector's precision, not the unfloored raw-recall number.
      minScore: f.minScore,
      minLexScore: f.minLexScore,
      fusionMode: f.fusionMode,
      // The gate needs exactly the set the floor let through (P-008).
      ...(opts.jevGate ? { captureCandidates: true } : {}),
    });

    // P-008: when the workspace's Jev switch is On, the injector filters the
    // floor-admitted set through Jev, so the monitor measures that set. A run in
    // which Jev answered NOTHING measured the floor alone (production failed open
    // on every turn too), so it is recorded under the floor-only shape: a gated
    // label on an ungated measurement would corrupt the gated baseline.
    let byClass = retrieval.byClass;
    let overall = retrieval.overall;
    let shape = `fusionMode:${f.fusionMode}`;
    let jevStats: JevGateReplayStats | null = null;
    if (opts.jevGate) {
      const queryText = new Map(gold.queries.map((q) => [q.id, q.query] as const));
      const gated = await gateReplayWithJev(retrieval.perQuery, queryText, opts.gate);
      jevStats = gated.stats;
      if (gated.stats.answered > 0 && gated.stats.model !== null) {
        ({ byClass, overall } = aggregateByClass(gated.outcomes));
        shape = jevGatedShape(f.fusionMode, gated.stats.model);
      }
    }

    const hardNeg = byClass['hard-negative'];
    return {
      backend: ctx.backend.name,
      corpusVersion: 'v1',
      goldVersion: gold.version,
      corpusN: corpus.length,
      goldN: gold.queries.length,
      floorCosine: f.minScore ?? 0,
      floorLex: f.minLexScore ?? 0,
      fpAt5: hardNeg?.fpAt5 ?? null,
      rAt10: overall.r10,
      pAt5: overall.p5,
      mrr: overall.mrr,
      medianTopScore: overall.medianTopScore ?? null,
      // Retrieval latency only; the gate's own p50 is in by_class._jev.
      latencyP50Ms: retrieval.latency.p50,
      byClass: { ...byClass, ...(jevStats ? { _jev: jevStats } : {}) } as Record<string, unknown>,
      // Embedding cost is not separately metered here (small, no LLM); left null.
      costUsd: null,
      // WI-7179: tag the admission shape onto the row (no schema migration —
      // `notes` already exists). Rows recorded before this fix carry no tag and
      // were measured under `floored-union`; a human (or the recall-drop
      // canary's next reader) comparing across this boundary should expect a
      // real one-time step-change here, not a regression — see WI-7179's
      // completion note for why the pre-fix history isn't a valid baseline.
      // P-008 extends the tag with the Jev operating point on a gated run.
      notes: shape,
    };
  } finally {
    // A cleanup failure (e.g. a held pooled connection) must never lose the run;
    // makeBackendCtx already drops the bench schema. Swallow non-fatally.
    await ctx.cleanup().catch(() => {});
  }
}
