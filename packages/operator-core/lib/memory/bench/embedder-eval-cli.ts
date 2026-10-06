/**
 * Embedder-quality gate CLI (shared-embedding-sidecar-and-enrichment-2026-07-10, P-001).
 *
 *   npx tsx packages/operator-core/lib/memory/bench/embedder-eval-cli.ts \
 *     [--legs gemma@512,granite97@384,granite311@384,qwen3@384,local,openai,\
 *             harrier,harrier384,pplx,sidecar[:model],ollama:<model>] \
 *     [--corpus memory|prose] \
 *     [--sidecar http://127.0.0.1:PORT] [--ollama http://127.0.0.1:11434] \
 *     [--dims 384] [--out <path.json>] \
 *     [--baseline <leg>] [--compare-with <prior-run.json>] [--limit <N>]
 *     [--vectors <candidate-vectors.json>]
 *     [--mdenseon-model <validated-local-directory>] [--isolated-sidecar]
 *     [--vectors-out <path.json>] [--warm-trials <N>]
 *     [--robustness <input.json> --robustness-sha256 <sha> --arm-manifest <frozen.json> --arm-manifest-sha256 <sha>]
 *     (P-007: one isolated real-weight arm; see sidecar-robustness.ts)
 *     Performance manifest cells use frozen requests and five randomized
 *     fresh-process blocks; retain cold/warm/batch/cache/resource raw samples.
 *     --transport-trace adds private socket/client lifecycle evidence to a
 *     diagnostic cell only; it changes no request/pool/timeout policy.
 *
 * `--limit N` is a SMOKE pass over the first N docs — use it to prove a newly
 * added leg loads/pools/sizes correctly before paying for a full corpus. Its
 * scores are meaningless by construction and the report is stamped so
 * `--compare-with` refuses it; see the flag's note in `main`.
 *
 * An MRL WIDTH SWEEP is written `--legs gemma@768,gemma@512,gemma@384,gemma@256`:
 * siblings of one family cost ONE forward pass at the widest width, with the
 * narrower widths derived by re-truncation. Beyond the 4x saving, this is what
 * makes the sweep a clean paired comparison — every width sees the identical
 * forward pass, so a delta between widths cannot be inference variance.
 *
 * Scores embedders head-to-head on the FROZEN gold-set fixture (corpus.v1 +
 * gold-set.v1) — same corpus, same queries, same metrics; the ONLY variable is
 * which embedder produced the vectors. This is the permanent quality gate for
 * ANY embedder/runtime/model change (a different runtime, quantization, or
 * model is a DIFFERENT SPACE — see agent-insights/embedding-space-vs-dimension):
 * adopt a candidate only on a win OUTSIDE noise here, never on a leaderboard delta.
 *
 * Self-contained on purpose: no PG, no mem0 seeding, no LLM judge — it isolates
 * EMBEDDING quality from backend/judge variance (contrast: bench-cli.ts / judged-cli.ts,
 * which benchmark whole memory BACKENDS). First measured run 2026-07-10:
 * gemma@384 R@1 .808 / R@3 .942 / MRR .868 vs BGE-local .767/.875/.827 on the
 * 120 answerable queries; OpenAI leg blocked (insufficient_quota).
 *
 * Metrics per leg:
 *  - answerable queries (lexical-gap, exact-identifier, session-start-intent):
 *    recall@1/3/5 + MRR@10, overall and per class.
 *  - hard-negative queries (expected=[], topic grep-verified absent from the
 *    corpus): these are CORRECT-REJECTION probes, so recall is undefined —
 *    reported instead as the REJECTION MARGIN: top1 cosine on hard-negatives
 *    vs top1 cosine on answerable queries (bigger gap = a downstream threshold
 *    can separate "real hit" from "confident-looking noise").
 *  - wall-clock embed throughput (the corpus/doc pass and the query pass).
 *
 * Gemma's asymmetric task prompts are honored via buildGemmaEmbedder's `kind`
 * (document for the corpus, query for the queries) — scoring gemma with one
 * symmetric prompt understates it and voids the comparison.
 *
 * ⚠ THAT TRAP GENERALIZES, AND IT IS NOT ONLY ABOUT PROMPTS. Every family here
 * has its OWN pooling and its OWN prompting, and no two candidates agree:
 *
 *   family      pooling      prompts      native
 *   gemma       mean         asymmetric   768  (MRL 768/512/256/128 — 384 UNTRAINED)
 *   granite97   cls          symmetric    384  (no truncation needed at all)
 *   granite311  cls          symmetric    768  (MRL 768/512/384/256/128 — 384 TRAINED)
 *   qwen3       last_token   asymmetric   1024 (MRL 32..1024)
 *   harrier     last_token   (in-graph)   1024 (no MRL)
 *
 * Applying the wrong pooling never throws — it returns a plausible vector from
 * a subtly wrong space — so the failure mode is a leg that looks like a fair
 * loss and is really a measurement bug. That is why legs route through the
 * SHIPPED builders (`MRL_FAMILIES`) rather than closures defined here: the
 * configuration measured and the configuration shipped are one object. Each
 * builder's docblock cites the model's own `1_Pooling/config.json` and
 * `config_sentence_transformers.json` for these values, not a summary of a card.
 *
 * Per-leg cost (`msPerDoc`, `msPerQuery`, `peakRssMB`) is reported alongside
 * quality because the desktop carries the winner in-process — see `embedAll`
 * for why RSS is only comparable across ONE-family runs.
 *
 * The --sidecar leg speaks the D-004 API (POST {url}/embed { model, kind, texts })
 * so a candidate backend (Node-ONNX sidecar, Ollama, TEI) is measurable behind
 * the exact interface production would call.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  buildGemmaEmbedder,
  buildHarrierEmbedder,
  buildLocalEmbedder,
  buildGraniteEmbedder,
  buildQwen3Embedder,
  gemmaPrompt,
  harrierPrompt,
  mrlTruncate,
  isTrainedDim,
  dimSpecFor,
  GEMMA_TARGET_DIMS,
  embedExecutionTarget,
  buildMdenseOnEmbedder,
  readMdenseOnExport,
  MDENSEON_MODEL,
  MDENSEON_REVISION,
  sidecarEmbedBatch,
  shutdownLocalEmbedder,
  getWorkerState,
} from '@papercusp/memory';
import { createEmbedSidecarServer, embedResponseMeasuredModel, EMBED_SIDECAR_RUNTIME, type EmbedSidecarHandle } from '../embed-sidecar-server';
import { CORPUS_FIXTURE_VERSION, loadCorpusFixture } from './corpus';
import { loadGoldSetFixture } from './gold-set';
import { PROSE_CORPUS_FIXTURE_VERSION, loadProseCorpusFixture } from './prose-corpus';
import { loadProseGoldSetFixture, PROSE_GOLD_SET_VERSION } from './prose-gold-set';
import { compareLegs, compareSourceGroupedLegs, classesDisagree, ALL_ANSWERABLE, type PerQueryRow } from './paired-leg-report';
import { buildPplxBenchmarkEmbedder, loadCandidateVectors, qualifyIncumbentReferences, qualifyMdenseOnBoundaries, summarizeIncumbentReferenceFiles, PPLX_MODEL, PPLX_OUTPUT, PPLX_REVISION } from './candidate-embedders';
import { prepareMeasurementCell, assertMeasuredEmbedResponse, assertMeasuredExecution, writeMeasurementCell,
  assertCandidateArm, failMeasurementCell, loadIndependentMeasurementInputs, loadRetainedRelevanceVectors,
  embedIncrementalRelevanceQueries, embedIncrementalRelevanceDocuments, type MeasurementArm, type PreparedMeasurement } from './measurement-manifest';
import { ORT_SESSION_OPTIONS, getOnnxBindingPin } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { loadPerformanceInput, collectSidecarPerformance, runPerformanceBlocks, isolatedEvaluationBuilders, observeSidecarTransport } from './sidecar-performance';
import { collectSidecarRobustness, loadRobustnessRun, summarizeRobustnessReport, type RobustnessModel } from './sidecar-robustness';

const processStartedAtMs = Date.now() - process.uptime() * 1000;

type EmbedFn = (text: string) => Promise<number[]>;
interface Leg {
  name: string;
  doc: EmbedFn;
  query: EmbedFn;
  metadata?: Record<string, unknown>;
  /**
   * Set on legs that are MRL truncations of a shared base pass. Legs sharing a
   * `family` are embedded ONCE at the family's widest `dims` and the narrower
   * members are derived by re-truncation (`mrlTruncate` is transitive — asserted
   * by gemma-embedder.test.ts "is TRANSITIVE").
   *
   * This is not just a speed-up, though it is a 4x one (one ~16-min prose pass
   * instead of four). Deriving every width from the SAME forward pass removes
   * run-to-run inference variance from the comparison entirely, so a measured
   * delta between two widths cannot be anything BUT the width — which is the
   * only reading a paired statistic (D-002) is entitled to make.
   */
  mrl?: { family: string; dims: number };
}

const K_VALUES = [1, 3, 5] as const;
const MRR_CUTOFF = 10;
const ANSWERABLE = new Set(['lexical-gap', 'exact-identifier', 'session-start-intent']);
let isolatedSidecar: EmbedSidecarHandle | undefined;
let preparedMeasurement: PreparedMeasurement | undefined;

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function l2norm(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * A leg that calls a running sidecar over the D-004 wire shape.
 *
 * EI-19323982006772080: this leg feeds `embedAll`, whose wall-clock seconds are
 * reported as embed throughput — and the corpus is a FIXTURE, so every run
 * after the first sends texts the sidecar's 1024-entry LRU already holds. That
 * read 1ms/doc against a true 353ms/doc, a ~350x overstatement, and nothing in
 * the old response shape could tell the two apart. Two changes make the number
 * honest: ask for the model explicitly, and refuse to time a response that says
 * it came from somewhere else.
 */
function sidecarLeg(url: string, model: string, arm?: MeasurementArm): Leg {
  const call = (kind: 'document' | 'query'): EmbedFn => async (text: string) => {
    const j = await sidecarEmbedBatch(url, { model, kind, texts: [text], bypassCache: true,
      // Cold model construction is recorded by this evaluation too.
      timeoutMs: 180_000 });
    // Verify rather than trust the flag: an older sidecar bundle accepts
    // `bypassCache` as an unknown field, ignores it, and answers 200 from the
    // LRU. That response is indistinguishable from a real one except here.
    const measured = embedResponseMeasuredModel({ cache: j.cache }, 1);
    if (!measured.ok) {
      throw new Error(
        `sidecar_embed_not_measured: ${measured.reason} — the timings from this leg would be a throughput figure for the cache, so the run is stopped instead of reported.`,
      );
    }
    if (arm) assertMeasuredEmbedResponse(arm, j, 1);
    return j.vectors[0];
  };
  return { name: `sidecar:${model}`, doc: call('document'), query: call('query') };
}

/**
 * A leg that calls a local Ollama server's native embed API (GGUF runtime — a
 * DIFFERENT space from the ONNX build of the same weights, so it is its own
 * leg). Prompts + dims mirror what production would do with that model
 * family: gemma gets the asymmetric task prompts + MRL truncate-to-384;
 * harrier gets the instruct query prefix at native dims; anything else is
 * embedded raw at native dims.
 */
function ollamaLeg(url: string, model: string): Leg {
  const family = model.includes('gemma') ? 'gemma' : model.includes('harrier') ? 'harrier' : 'raw';
  const call = (kind: 'document' | 'query'): EmbedFn => async (text: string) => {
    const prompted =
      family === 'gemma' ? gemmaPrompt(kind, text) : family === 'harrier' ? harrierPrompt(kind, text) : text;
    const res = await fetch(`${url.replace(/\/$/, '')}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: prompted }),
    });
    if (!res.ok) throw new Error(`ollama_embed_${res.status}: ${await res.text().catch(() => '')}`);
    const j = (await res.json()) as { embeddings: number[][] };
    return family === 'gemma' ? mrlTruncate(j.embeddings[0], GEMMA_TARGET_DIMS) : j.embeddings[0];
  };
  return { name: `ollama:${model}`, doc: call('document'), query: call('query') };
}

/** `gemma@512` / `granite311@384` — a width of an in-process family. */
const MRL_LEG = /^([a-z][a-z0-9]*)@(\d+)$/;

/**
 * In-process embedder families the sweep can score, by leg prefix.
 *
 * Every entry MUST be the production builder, never a bench-local
 * reimplementation. Each of these models differs from the others in POOLING
 * and PROMPTING — mean/CLS/last-token, symmetric/asymmetric — and getting
 * either wrong does not error: it yields a plausible vector from a subtly
 * wrong space, which this bench would then report as a fair loss for that
 * model. Routing through the shipped builders is what keeps the measured
 * configuration and the shippable configuration the same object.
 */
type FamilyBuilder = (o: { kind: 'document' | 'query'; dims: number }) => EmbedFn;
const MRL_FAMILIES: Record<string, FamilyBuilder> = {
  gemma: ({ kind, dims }) => buildGemmaEmbedder({ kind, dims }),
  harrier: ({ kind, dims }) => buildHarrierEmbedder({ kind, dims }),
  // P-003 candidates for the untrained-384 cut.
  granite97: ({ kind, dims }) => buildGraniteEmbedder({ variant: '97m', kind, dims }),
  granite311: ({ kind, dims }) => buildGraniteEmbedder({ variant: '311m', kind, dims }),
  qwen3: ({ kind, dims }) => buildQwen3Embedder({ kind, dims }),
};

/**
 * Widest requested width per MRL family. Every member of a family embeds at
 * THIS width; narrower members are derived by re-truncation in `main`.
 */
function mrlFamilyWidths(names: string[]): Map<string, number> {
  const widest = new Map<string, number>();
  for (const n of names) {
    const m = MRL_LEG.exec(n);
    if (!m) continue;
    const [, family, dims] = m;
    widest.set(family, Math.max(widest.get(family) ?? 0, Number(dims)));
  }
  return widest;
}

async function buildLegs(
  names: string[],
  sidecarUrl?: string,
  ollamaUrl = 'http://127.0.0.1:11434',
  mdenseonModel?: string,
): Promise<Array<Leg | { name: string; error: string }>> {
  const out: Array<Leg | { name: string; error: string }> = [];
  const familyWidths = mrlFamilyWidths(names);
  for (const name of names) {
    try {
      const mrl = MRL_LEG.exec(name);
      if (mrl && MRL_FAMILIES[mrl[1]]) {
        const family = mrl[1];
        const dims = Number(mrl[2]);
        const build = MRL_FAMILIES[family];
        const spec = dimSpecFor(family);
        if (!spec) {
          // A family with a builder but no declared spec could still be
          // embedded — but nothing could then say whether the requested width
          // is one the model was trained at, which is the whole question this
          // sweep exists to answer. Refuse rather than measure blind (D-001).
          out.push({ name, error: `no declared dim spec for family '${family}' — add one to CANDIDATE_DIM_SPECS` });
          continue;
        }
        // Asking for more dims than the model HAS is not a wider embedding —
        // mrlTruncate would silently hand back the native vector and the leg
        // would be scored under a label claiming a width it never had.
        if (dims > spec.nativeDims) {
          out.push({ name, error: `dims ${dims} exceeds ${family} native ${spec.nativeDims}` });
          continue;
        }
        const at = familyWidths.get(family) ?? dims;
        out.push({
          name,
          doc: build({ kind: 'document', dims: at }),
          query: build({ kind: 'query', dims: at }),
          mrl: { family, dims },
        });
      } else if (name === 'gemma') {
        out.push({
          name,
          doc: buildGemmaEmbedder({ kind: 'document' }),
          query: buildGemmaEmbedder({ kind: 'query' }),
        });
      } else if (name === 'harrier') {
        out.push({
          name,
          doc: buildHarrierEmbedder({ kind: 'document' }),
          query: buildHarrierEmbedder({ kind: 'query' }),
        });
      } else if (name === 'pplx') {
        const fn = buildPplxBenchmarkEmbedder();
        out.push({ name, doc: fn, query: fn, metadata: {
          model: PPLX_MODEL, revision: PPLX_REVISION, output: PPLX_OUTPUT,
          runtime: 'transformers-js-direct-encoder-cpu-fp32', experimental: true,
        } });
      } else if (name === 'mdenseon') {
        if (!mdenseonModel) throw new Error('pass --mdenseon-model <validated-local-directory>');
        const manifest = readMdenseOnExport(mdenseonModel);
        out.push({ name, doc: buildMdenseOnEmbedder({ kind: 'document', model: mdenseonModel }),
          query: buildMdenseOnEmbedder({ kind: 'query', model: mdenseonModel }),
          metadata: { model: MDENSEON_MODEL, revision: MDENSEON_REVISION,
            runtime: 'transformers-js-worker-cpu-fp32', experimental: true,
            graphSha256: manifest.files['onnx/model.onnx'].sha256 } });
      } else if (name === 'harrier384') {
        // Exploratory truncation — harrier has NO documented MRL (P-013).
        out.push({
          name,
          doc: buildHarrierEmbedder({ kind: 'document', dims: 384 }),
          query: buildHarrierEmbedder({ kind: 'query', dims: 384 }),
        });
      } else if (name.startsWith('ollama:')) {
        out.push(ollamaLeg(ollamaUrl, name.slice('ollama:'.length)));
      } else if (name === 'local') {
        const fn = await buildLocalEmbedder();
        out.push({ name, doc: fn, query: fn });
      } else if (name === 'openai') {
        // The operator configuration hydrates its backend from Postgres on
        // import. Local/reference/performance runs must stay database-free.
        const { buildOpenAiEmbedder, resolveOpenAiKey } = await import('../configure');
        const key = await resolveOpenAiKey();
        if (!key) out.push({ name, error: 'no_key' });
        else {
          const fn = buildOpenAiEmbedder(key) as EmbedFn;
          out.push({ name, doc: fn, query: fn });
        }
      } else if (name.startsWith('sidecar')) {
        if (!sidecarUrl) out.push({ name, error: 'pass --sidecar <url>' });
        else {
          const leg = sidecarLeg(sidecarUrl, name.includes(':') ? name.split(':')[1] : 'gemma', preparedMeasurement?.arm);
          if (name === 'sidecar:mdenseon' && mdenseonModel) {
            const manifest = readMdenseOnExport(mdenseonModel);
            leg.metadata = { model: MDENSEON_MODEL, revision: MDENSEON_REVISION,
              runtime: 'native-client-isolated-sidecar-worker-cpu-fp32', experimental: true,
              graphSha256: manifest.files['onnx/model.onnx'].sha256 };
          }
          out.push(leg);
        }
      } else {
        out.push({
          name,
          error:
            `unknown leg '${name}' — in-process families take an explicit width ` +
            `(${Object.keys(MRL_FAMILIES).join('|')})@<dims>`,
        });
      }
    } catch (e) {
      out.push({ name, error: `build_failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

/** Resident set size in MB. Worker threads share the process, so this DOES
 *  include the ONNX model+arena loaded inside the embed worker. */
function rssMB(): number {
  return +(process.memoryUsage().rss / 1024 / 1024).toFixed(1);
}

async function warmTimings(leg: Leg, documents: string[], queries: string[], trials: number) {
  const samples = { document: [] as number[], query: [] as number[] };
  for (let trial = 0; trial < trials; trial++) {
    for (const kind of (trial % 2 ? ['query', 'document'] : ['document', 'query']) as Array<'document' | 'query'>) {
      const texts = kind === 'document' ? documents : queries;
      const fn = kind === 'document' ? leg.doc : leg.query;
      const selected = texts.filter((_, i) => i % Math.max(1, Math.floor(texts.length / 12)) === 0).slice(0, 12);
      for (const text of trial % 2 ? selected.reverse() : selected) {
        const start = performance.now();
        await fn(text);
        samples[kind].push(performance.now() - start);
      }
    }
  }
  return Object.fromEntries(Object.entries(samples).map(([kind, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const quantile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return [kind, { samples: values, n: values.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95) }];
  }));
}

/**
 * Embed every text, timing the pass and tracking peak RSS.
 *
 * Footprint matters here as much as quality: the desktop ships this in-process
 * (P-003), so a model that wins on MRR while costing another GB resident may
 * still lose. RSS is sampled along the way, not just at the end, because the
 * ONNX arena can peak mid-pass on a long document and settle back.
 *
 * ⚠ RSS IS CUMULATIVE PER PROCESS. The embed worker caches one pipeline PER
 * model, so a run scoring several families measures the second family on top
 * of the first's resident weights — the delta is then a marginal cost, not
 * that model's standalone footprint. For a comparable per-model number, score
 * ONE family per process and compare `peakRssMB` across runs (the `--legs
 * none --compare-with a.json,b.json` re-analysis pass exists precisely so
 * splitting a sweep across processes costs nothing).
 */
async function embedAll(
  fn: EmbedFn,
  texts: string[],
  label: string,
): Promise<{ vecs: number[][]; seconds: number; peakRssMB: number }> {
  const vecs: number[][] = [];
  let peakRss = process.memoryUsage().rss;
  const sampleRss = (): void => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  };
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i++) {
    vecs.push(l2norm(await fn(texts[i])));
    if ((i + 1) % 50 === 0) {
      sampleRss();
      console.log(`  [${label}] ${i + 1}/${texts.length}`);
    }
  }
  sampleRss();
  return { vecs, seconds: (Date.now() - t0) / 1000, peakRssMB: +(peakRss / 1024 / 1024).toFixed(1) };
}

interface ClassRow {
  n: number;
  recall_at_1: number;
  recall_at_3: number;
  recall_at_5: number;
  mrr_at_10: number;
}

/**
 * Per-query outcome. Aggregates alone CANNOT support the verdict this bench
 * exists to produce: "is the difference outside noise?" is a PAIRED question
 * (same corpus, same queries, only the embedder varies), so the statistic is a
 * paired bootstrap / McNemar over per-query results — neither of which is
 * computable from class means. Emitting these makes a defensible confidence
 * interval possible downstream instead of eyeballing two rounded numbers.
 */
interface QueryOutcomeRow {
  id: string;
  class: string;
  /** 1-based rank of the first relevant doc; 0 when none was found. */
  firstRelevantRank: number;
  /** Reciprocal rank (0 when missed) — the continuous paired statistic. */
  reciprocalRank: number;
  /** Cosine of the top hit, whatever it was (drives the rejection margin). */
  top1Score: number;
}

function scoreLeg(
  corpusKeys: string[],
  docVecs: number[][],
  queries: Array<{ id: string; class: string; query: string; expected: string[] }>,
  queryVecs: number[][],
): {
  byClass: Record<string, ClassRow>;
  rejection: { answerableTop1Mean: number; hardNegTop1Mean: number; margin: number };
  perQuery: QueryOutcomeRow[];
} {
  const agg = new Map<string, { n: number; r: Record<number, number>; rrSum: number }>();
  const bump = (bucket: string, firstRel: number) => {
    let a = agg.get(bucket);
    if (!a) agg.set(bucket, (a = { n: 0, r: { 1: 0, 3: 0, 5: 0 }, rrSum: 0 }));
    a.n++;
    a.rrSum += firstRel <= MRR_CUTOFF ? 1 / firstRel : 0;
    for (const k of K_VALUES) if (firstRel <= k) a.r[k]++;
  };
  let ansTop1 = 0;
  let ansN = 0;
  let hnTop1 = 0;
  let hnN = 0;
  const perQuery: QueryOutcomeRow[] = [];

  for (let qi = 0; qi < queries.length; qi++) {
    const q = queries[qi];
    const sims = docVecs.map((dv, di) => ({ di, s: dot(queryVecs[qi], dv) })).sort((a, b) => b.s - a.s);
    const top1 = sims[0]?.s ?? 0;
    if (!ANSWERABLE.has(q.class)) {
      hnTop1 += top1;
      hnN++;
      perQuery.push({ id: q.id, class: q.class, firstRelevantRank: 0, reciprocalRank: 0, top1Score: +top1.toFixed(6) });
      continue;
    }
    ansTop1 += top1;
    ansN++;
    const exp = new Set(q.expected);
    let firstRel = Infinity;
    for (let r = 0; r < sims.length; r++) {
      if (exp.has(corpusKeys[sims[r].di])) {
        firstRel = r + 1;
        break;
      }
    }
    bump(q.class, firstRel);
    bump('ALL_ANSWERABLE', firstRel);
    perQuery.push({
      id: q.id,
      class: q.class,
      firstRelevantRank: Number.isFinite(firstRel) ? firstRel : 0,
      reciprocalRank: firstRel <= MRR_CUTOFF ? +(1 / firstRel).toFixed(6) : 0,
      top1Score: +top1.toFixed(6),
    });
  }

  const byClass: Record<string, ClassRow> = {};
  for (const [c, a] of agg) {
    byClass[c] = {
      n: a.n,
      recall_at_1: +(a.r[1] / a.n).toFixed(4),
      recall_at_3: +(a.r[3] / a.n).toFixed(4),
      recall_at_5: +(a.r[5] / a.n).toFixed(4),
      mrr_at_10: +(a.rrSum / a.n).toFixed(4),
    };
  }
  const answerableTop1Mean = +(ansTop1 / Math.max(ansN, 1)).toFixed(4);
  const hardNegTop1Mean = +(hnTop1 / Math.max(hnN, 1)).toFixed(4);
  return {
    byClass,
    rejection: { answerableTop1Mean, hardNegTop1Mean, margin: +(answerableTop1Mean - hardNegTop1Mean).toFixed(4) },
    perQuery,
  };
}

async function main(): Promise<void> {
  if (argValue('--qualify-boundaries')) {
    const output = argValue('--out'), reference = argValue('--boundary-reference');
    if (!output || !reference) throw new Error('--qualify-boundaries requires --boundary-reference and --out');
    await qualifyMdenseOnBoundaries(argValue('--qualify-boundaries')!, argValue('--boundary-sha256') ?? '', reference,
      argValue('--boundary-reference-sha256') ?? '', output, argValue('--boundary-cell'));
    return;
  }
  if (argValue('--run-performance')) {
    const model = argValue('--mdenseon-model'), driver = argValue('--driver-out');
    if (!model || !driver) throw new Error('--run-performance requires --mdenseon-model and --driver-out');
    console.log('performance summary', await runPerformanceBlocks(argValue('--run-performance')!, argValue('--manifest-sha256') ?? '', model, driver));
    process.exit(0);
  }
  if (argValue('--summarize-reference')) {
    const output = argValue('--out'), python = argValue('--python-reference');
    if (!output || !python) throw new Error('--summarize-reference requires --python-reference and --out');
    const summary = summarizeIncumbentReferenceFiles(argValue('--summarize-reference')!, python);
    fs.writeFileSync(output, JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
    return;
  }
  if (argValue('--qualify-reference')) {
    const output = argValue('--out');
    if (!output) throw new Error('--qualify-reference requires --out');
    await qualifyIncumbentReferences(argValue('--qualify-reference')!, argValue('--reference-sha256') ?? '', output);
    return;
  }
  // `--legs none` embeds nothing: a PURE ANALYSIS pass that only re-compares
  // runs already on disk (paired stats are computed from stored per-query rows,
  // so re-deriving a verdict — or comparing two past runs against each other —
  // must not cost another corpus pass).
  const legsArg = argValue('--legs');
  const legNames = legsArg === 'none' ? [] : (legsArg?.split(',').filter(Boolean) ?? ['gemma', 'local']);
  let sidecarUrl = argValue('--sidecar');
  const mdenseonModel = argValue('--mdenseon-model');
  if (argValue('--manifest')) {
    preparedMeasurement = await prepareMeasurementCell(argValue('--manifest')!, argValue('--manifest-sha256') ?? '', argValue('--cell') ?? '');
    const { cell, arm } = preparedMeasurement;
    if (!['performance', 'relevance'].includes(cell.bar) || legNames.length !== 1 || argValue('--vectors') || argValue('--limit')) {
      throw new Error('manifest evaluator requires one matching arm and complete declared inputs');
    }
    const http = legNames[0] === `sidecar:${arm.model}`;
    if (http ? !process.argv.includes('--isolated-sidecar') : (cell.bar !== 'relevance' || legNames[0] !== arm.model
      || process.argv.includes('--isolated-sidecar') || sidecarUrl)) throw new Error('manifest evaluator arm/transport mismatch');
    if (cell.bar === 'relevance' && (process.argv.includes('--timing-only') || Number(argValue('--warm-trials') ?? 0) !== 0)) {
      throw new Error('relevance cannot be a timing-only sample');
    }
    await assertCandidateArm(arm, arm.model as 'mdenseon' | 'gemma' | 'harrier', http ? 'local-http-client-worker' : 'worker', EMBED_SIDECAR_RUNTIME);
  }
  // P-007 robustness: one real-weight arm through the isolated sidecar, bound to
  // a frozen input and a frozen measurement arm (identity + weight bytes).
  let robustness: Awaited<ReturnType<typeof loadRobustnessRun>> | undefined;
  if (argValue('--robustness')) {
    const leg = legNames[0] ?? '', model = leg.startsWith('sidecar:') ? leg.slice('sidecar:'.length) : '';
    if (argValue('--manifest') || legNames.length !== 1 || !['mdenseon', 'gemma', 'harrier'].includes(model)
      || !process.argv.includes('--isolated-sidecar') || argValue('--warm-trials') || process.argv.includes('--timing-only')
      || argValue('--vectors') || argValue('--vectors-out') || argValue('--limit') || !argValue('--out')) {
      throw new Error('--robustness requires --out and exactly one --legs sidecar:<mdenseon|gemma|harrier> on --isolated-sidecar, with no other measurement mode');
    }
    const out = path.resolve(argValue('--out')!);
    if (fs.existsSync(out) || fs.existsSync(`${out}.samples.jsonl`)) throw new Error('robustness output already exists');
    robustness = await loadRobustnessRun({ inputPath: path.resolve(argValue('--robustness')!), inputSha256: argValue('--robustness-sha256') ?? '',
      armManifestPath: path.resolve(argValue('--arm-manifest') ?? ''), armManifestSha256: argValue('--arm-manifest-sha256') ?? '',
      model: model as RobustnessModel, mdenseonModelDir: mdenseonModel, runtime: EMBED_SIDECAR_RUNTIME,
      repoRoot: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..') });
    if (getWorkerState().alive) throw new Error('robustness requires a fresh process with a cold worker');
  }
  const retainedVectors: Record<string, { docVectors: number[][]; queryVectors: number[][] }> = {};
  const performanceInput = preparedMeasurement?.cell.bar === 'performance' ? loadPerformanceInput(preparedMeasurement) : undefined;
  if (performanceInput && (argValue('--warm-trials') || process.argv.includes('--timing-only') || argValue('--vectors-out'))) {
    throw new Error('performance samples must come from the frozen request contract');
  }
  if (performanceInput && getWorkerState().alive) throw new Error('performance cell requires a fresh process with a cold worker');
  const warmTrials = Number(argValue('--warm-trials') ?? 0);
  const timingOnly = process.argv.includes('--timing-only');
  if (timingOnly && warmTrials === 0) throw new Error('--timing-only requires --warm-trials');
  if (!Number.isInteger(warmTrials) || warmTrials < 0 || warmTrials > 20) throw new Error('--warm-trials must be an integer from 0 to 20');
  if (process.argv.includes('--isolated-sidecar')) {
    if (sidecarUrl) throw new Error('--isolated-sidecar cannot target an existing sidecar');
    if (!mdenseonModel) throw new Error('--isolated-sidecar requires --mdenseon-model');
    readMdenseOnExport(mdenseonModel);
    isolatedSidecar = createEmbedSidecarServer({ port: 0, warmAtBoot: false,
      concurrency: performanceInput?.serverConcurrency ?? robustness?.input.serverConcurrency ?? 1,
      builders: isolatedEvaluationBuilders(async (kind) => buildMdenseOnEmbedder({ kind, model: mdenseonModel })),
      modelRevisions: { mdenseon: MDENSEON_REVISION },
      log: (line) => console.log(`[isolated-sidecar] ${line}`),
    });
    sidecarUrl = `http://127.0.0.1:${await isolatedSidecar.listening}`;
  }
  const ollamaUrl = argValue('--ollama') ?? 'http://127.0.0.1:11434';
  const outPath =
    argValue('--out') ??
    path.join(
      path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..'),
      '.papercusp',
      'bench-reports',
      `embedder-eval-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
    );
  if (preparedMeasurement && path.resolve(outPath) !== preparedMeasurement.rawOutput) throw new Error('runner output differs from declared cell');

  if (performanceInput && preparedMeasurement && sidecarUrl) {
    const { arm, cell } = preparedMeasurement;
    const traceFd = process.argv.includes('--transport-trace') ? fs.openSync(`${outPath}.transport.jsonl`, 'wx', 0o600) : undefined;
    const stopTrace = traceFd !== undefined && isolatedSidecar
      ? observeSidecarTransport(isolatedSidecar.server, sidecarUrl, (event) => fs.writeSync(traceFd, `${JSON.stringify(event)}\n`)) : undefined;
    let report: Awaited<ReturnType<typeof collectSidecarPerformance>>;
    try {
      report = await collectSidecarPerformance(sidecarUrl, arm, performanceInput, { processStartedAtMs,
        onPhase: (phase) => console.log(`[performance] ${cell.id} ${phase}`),
        onSample: (sample) => fs.promises.appendFile(`${outPath}.samples.jsonl`, `${JSON.stringify(sample)}\n`, { mode: 0o600 }),
      });
    } finally { stopTrace?.(); if (traceFd !== undefined) fs.closeSync(traceFd); }
    assertMeasuredExecution(arm, embedExecutionTarget(), ORT_SESSION_OPTIONS, getWorkerState());
    writeMeasurementCell(preparedMeasurement, { ...report, block: cell.parameters.block, order: cell.parameters.order,
      execution: embedExecutionTarget(), threads: ORT_SESSION_OPTIONS, workerState: getWorkerState() });
    await isolatedSidecar?.close(); await shutdownLocalEmbedder();
    console.log('wrote', outPath); process.exit(0);
  }

  if (robustness && sidecarUrl && isolatedSidecar) {
    const { input, expected } = robustness, handle = isolatedSidecar;
    const report = await collectSidecarRobustness(sidecarUrl, expected, input, {
      crashWorker: shutdownLocalEmbedder, workerState: getWorkerState, activity: () => handle.activity(),
      onPhase: (phase, edge) => console.log(`[robustness] ${expected.model} ${phase} ${edge} ${new Date().toISOString()}`),
      onSample: (sample) => fs.promises.appendFile(`${outPath}.samples.jsonl`, `${JSON.stringify(sample)}\n`, { mode: 0o600 }),
    });
    // The verdict is re-derived from the raw samples here AND by any later reader.
    const summary = summarizeRobustnessReport(input, expected, report);
    fs.writeFileSync(outPath, JSON.stringify({ ...report, inputPin: robustness.inputPin, armPin: robustness.armPin,
      execution: embedExecutionTarget(), threads: ORT_SESSION_OPTIONS, onnxBindingPin: getOnnxBindingPin(), summary }, null, 2),
    { flag: 'wx', mode: 0o600 });
    await handle.close(); await shutdownLocalEmbedder();
    console.log('wrote', outPath, `verdict=${summary.verdict}`, summary.failures.join(' | '));
    process.exit(summary.verdict === 'pass' ? 0 : 1);
  }

  // Which corpus/gold-set pair to score against. 'memory' (default) keeps the
  // original memory-bench behaviour; 'prose' scores the prose surfaces, whose
  // distribution is different enough that the memory gold set does not
  // transfer (prose-embedding-384-untrained-mrl-fix P-001).
  const corpusChoice = (argValue('--corpus') ?? 'memory') as 'memory' | 'prose';
  if (corpusChoice !== 'memory' && corpusChoice !== 'prose') {
    throw new Error(`unknown --corpus '${corpusChoice}' (expected 'memory' or 'prose')`);
  }
  const independent = preparedMeasurement?.cell.bar === 'relevance' ? loadIndependentMeasurementInputs(preparedMeasurement, corpusChoice) : undefined;
  const fullCorpus = independent?.entries ?? (corpusChoice === 'prose' ? loadProseCorpusFixture() : loadCorpusFixture());
  const gold = independent ? { version: independent.goldVersion, queries: independent.queries }
    : (corpusChoice === 'prose' ? loadProseGoldSetFixture() : loadGoldSetFixture());
  const baseCorpusVersion = independent?.corpusVersion ?? (corpusChoice === 'prose' ? PROSE_CORPUS_FIXTURE_VERSION : CORPUS_FIXTURE_VERSION);

  // `--limit N` — a SMOKE pass over the first N docs, for checking that a
  // newly added leg loads, pools and emits the width it claims BEFORE paying
  // for a full corpus (a 2029-doc pass is ~11-25 min per model). Adding an
  // embedder is the moment its pooling/prompt wiring is most likely wrong, and
  // discovering that 20 minutes in is the expensive way to learn it.
  //
  // ⚠ THE SCORES FROM A LIMITED RUN ARE MEANINGLESS. Most gold-set answers
  // live outside the truncated corpus, so recall collapses for reasons that
  // have nothing to do with the embedder. The danger is not the bad number —
  // it is that the bad number is INDISTINGUISHABLE from a real one once it is
  // sitting in a report file. So the run stamps a POISONED corpus version,
  // which makes the existing fixture-mismatch guard refuse to fold it into any
  // comparison, in either direction, without needing a second guard that could
  // itself drift.
  const limitArg = argValue('--limit');
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit must be a positive integer, got '${limitArg}'`);
  }
  const corpus = limit === undefined ? fullCorpus : fullCorpus.slice(0, limit);
  const corpusVersion = limit === undefined ? baseCorpusVersion : `${baseCorpusVersion}+SMOKE-limit${limit}`;
  if (limit !== undefined) {
    console.log(
      `\n⚠ SMOKE RUN — corpus truncated to ${corpus.length}/${fullCorpus.length} docs.\n` +
        `  Retrieval scores below are NOT valid: the gold set's answers mostly lie outside this subset.\n` +
        `  Use this ONLY to check a leg loads, pools, and emits its claimed width.\n` +
        `  The report is stamped corpusVersion='${corpusVersion}', so --compare-with will refuse it.\n`,
    );
  }

  const corpusKeys = corpus.map((e) => e.key);
  const corpusTexts = corpus.map((e) => e.text);
  const queryTexts = gold.queries.map((q) => q.query);
  const reusedRelevance = preparedMeasurement && independent
    ? await loadRetainedRelevanceVectors(preparedMeasurement, corpusChoice as 'memory' | 'prose') : undefined;
  if (reusedRelevance && !reusedRelevance.missingIndexes.length && !reusedRelevance.missingDocumentIndexes.length) {
    throw new Error('retained relevance has no new queries; use offline scoring rather than starting a worker');
  }
  if (preparedMeasurement && !independent) {
    // Fixture files/order are input identities too; versions alone do not pin bytes.
    const declared = preparedMeasurement.cell.inputIds.map((id) => preparedMeasurement!.manifest.inputs[id]);
    const fixtureRoot = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
    const prefix = corpusChoice === 'prose' ? 'prose-' : '';
    for (const name of [`${prefix}corpus.v1.json`, `${prefix}gold-set.v1.json`]) {
      if (!declared.some((f) => path.resolve(f.path) === path.join(fixtureRoot, name))) throw new Error('fixture absent from frozen cell inputs');
    }
  }
  const vectorsPath = argValue('--vectors');
  const fixturesDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
  const fixturePrefix = corpusChoice === 'prose' ? 'prose-' : '';
  const imported = vectorsPath ? loadCandidateVectors(
    vectorsPath, corpusChoice,
    path.join(fixturesDir, `${fixturePrefix}corpus.v1.json`),
    path.join(fixturesDir, `${fixturePrefix}gold-set.v1.json`),
    corpusKeys, gold.queries.map((q) => q.id),
  ) : undefined;
  console.log(
    `corpus=${corpusChoice}/${corpusVersion} docs=${corpusKeys.length} queries=${gold.queries.length} legs=${legNames.join(',')}`,
  );

  // Validate --compare-with BEFORE embedding anything. Discovering a fixture
  // mismatch after a 20-minute corpus pass would be a pointlessly expensive way
  // to learn it, so this is checked while it is still free.
  type PriorRun = {
    path: string;
    corpus?: string;
    corpusVersion?: string;
    goldSetVersion?: string;
    results?: Record<string, unknown>;
  };
  const comparePaths = (argValue('--compare-with') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const priorRuns: PriorRun[] = [];
  for (const p of comparePaths) {
    const prior = { path: p, ...(JSON.parse(fs.readFileSync(p, 'utf8')) as Omit<PriorRun, 'path'>) };
    // A cross-run comparison is only meaningful on the SAME corpus and the SAME
    // queries. A mismatch would still yield a confident-looking CI computed
    // over queries that are not the same queries — refuse rather than mislead.
    // Checked BEFORE embedding, while it is still free.
    if (
      prior.corpus !== corpusChoice ||
      prior.corpusVersion !== corpusVersion ||
      prior.goldSetVersion !== gold.version
    ) {
      throw new Error(
        `--compare-with REFUSED: fixture mismatch. this run = ${corpusChoice}/${corpusVersion} gold ${gold.version}; ` +
          `${p} = ${prior.corpus}/${prior.corpusVersion} gold ${prior.goldSetVersion}. ` +
          `Comparing legs scored on different queries is not a comparison.`,
      );
    }
    priorRuns.push(prior);
  }

  const results: Record<string, unknown> = {};

  const record = (name: string, docVecs: number[][], queryVecs: number[][], meta: Record<string, unknown>): void => {
    if (preparedMeasurement && (docVecs.length !== corpus.length || queryVecs.length !== gold.queries.length
      || [...docVecs, ...queryVecs].some((v) => v.length !== preparedMeasurement!.arm.profile.nativeDims
        || v.some((x) => !Number.isFinite(x)) || Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) > 0.001))) {
      throw new Error('measured relevance vector population/dimensions/normalization mismatch');
    }
    const testIndexes = independent?.queries.flatMap((q, i) => q.partition === 'test' ? [i] : []);
    const scored = scoreLeg(corpusKeys, docVecs, testIndexes ? testIndexes.map((i) => gold.queries[i]) : gold.queries,
      testIndexes ? testIndexes.map((i) => queryVecs[i]) : queryVecs);
    retainedVectors[name] = { docVectors: docVecs, queryVectors: queryVecs };
    const calibrationIndexes = independent?.queries.flatMap((q, i) => q.partition === 'calibration' ? [i] : []);
    results[name] = { dims: docVecs[0]?.length ?? 0, ...meta, ...scored,
      ...(calibrationIndexes ? { calibration: scoreLeg(corpusKeys, docVecs, calibrationIndexes.map((i) => gold.queries[i]),
        calibrationIndexes.map((i) => queryVecs[i])) } : {}) };
    const a = scored.byClass.ALL_ANSWERABLE;
    console.log(
      `   ${name}: R@1=${a.recall_at_1} R@3=${a.recall_at_3} R@5=${a.recall_at_5} MRR=${a.mrr_at_10} ` +
        `rejection-margin=${scored.rejection.margin}`,
    );
  };

  if (imported) {
    const { manifest, suite } = imported;
    record(manifest.name, suite.docVectors.map(l2norm), suite.queryVectors.map(l2norm), {
      model: manifest.model, revision: manifest.revision, runtime: manifest.runtime,
      experimental: true, vectorSource: vectorsPath, loadSeconds: manifest.loadSeconds,
      assetBytes: manifest.assetBytes, docSeconds: suite.docSeconds, querySeconds: suite.querySeconds,
      msPerDoc: suite.docSeconds * 1000 / corpusTexts.length,
      msPerQuery: suite.querySeconds * 1000 / queryTexts.length, peakRssMB: suite.peakRssMB,
    });
  }

  // Partition: MRL siblings share one forward pass, everything else is its own.
  const built = await buildLegs(legNames, sidecarUrl, ollamaUrl, mdenseonModel);
  const families = new Map<string, Leg[]>();
  const standalone: Leg[] = [];
  for (const leg of built) {
    if ('error' in leg) {
      console.log(`\n== ${leg.name}: BLOCKED (${leg.error})`);
      results[leg.name] = { blocked: leg.error };
    } else if (leg.mrl) {
      const members = families.get(leg.mrl.family) ?? [];
      members.push(leg);
      families.set(leg.mrl.family, members);
    } else {
      standalone.push(leg);
    }
  }

  for (const [family, members] of families) {
    members.sort((a, b) => b.mrl!.dims - a.mrl!.dims);
    const base = members[0];
    const baseDims = base.mrl!.dims;
    const widths = members.map((m) => m.mrl!.dims);
    if (timingOnly) {
      await base.doc(corpusTexts[0]); await base.query(queryTexts[0]);
      const repeatedWarm = await warmTimings(base, corpusTexts, queryTexts, warmTrials);
      for (const member of members) results[member.name] = { ...member.metadata, repeatedWarm,
        execution: embedExecutionTarget(), workerState: getWorkerState(), timingOnly: true };
      continue;
    }
    console.log(`\n== ${family} MRL family ${widths.join('/')}: ONE pass at ${baseDims}, narrower widths derived ==`);
    const rssBeforeMB = rssMB();
    try {
      const doc = await embedAll(base.doc, corpusTexts, `${family}@${baseDims}/doc`);
      const query = await embedAll(base.query, queryTexts, `${family}@${baseDims}/query`);
      const repeatedWarm = warmTrials ? await warmTimings(base, corpusTexts, queryTexts, warmTrials) : undefined;
      const spec = dimSpecFor(family);
      for (const m of members) {
        const d = m.mrl!.dims;
        record(
          m.name,
          d === baseDims ? doc.vecs : doc.vecs.map((v) => mrlTruncate(v, d)),
          d === baseDims ? query.vecs : query.vecs.map((v) => mrlTruncate(v, d)),
          {
            // Whether the model was actually TRAINED at this width — read from
            // the declared spec, never restated here (D-001).
            trainedDim: spec ? isTrainedDim(spec, d) : null,
            repeatedWarm,
            model: spec?.model ?? null,
            sharedPass: `${family}@${baseDims}`,
            derived: d !== baseDims,
            docSeconds: +doc.seconds.toFixed(1),
            querySeconds: +query.seconds.toFixed(1),
            // Cost, which the shared pass makes SHARED: every width of a
            // family is derived from the base pass, so these numbers describe
            // the family's ONE forward pass and are identical across its
            // members by construction — never evidence that a narrower width
            // is cheaper to PRODUCE (it is only cheaper to store).
            msPerDoc: +((doc.seconds * 1000) / Math.max(corpusTexts.length, 1)).toFixed(1),
            msPerQuery: +((query.seconds * 1000) / Math.max(queryTexts.length, 1)).toFixed(1),
            rssBeforeMB,
            peakRssMB: Math.max(doc.peakRssMB, query.peakRssMB),
            rssDeltaMB: +(Math.max(doc.peakRssMB, query.peakRssMB) - rssBeforeMB).toFixed(1),
          },
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`   ${family} family FAILED mid-embed: ${msg.slice(0, 200)}`);
      for (const m of members) results[m.name] = { blocked: `embed_failed: ${msg.slice(0, 200)}` };
    }
  }

  for (const leg of standalone) {
    if (timingOnly) {
      await leg.doc(corpusTexts[0]); await leg.query(queryTexts[0]);
      results[leg.name] = { ...leg.metadata, repeatedWarm: await warmTimings(leg, corpusTexts, queryTexts, warmTrials),
        execution: embedExecutionTarget(), workerState: getWorkerState(), timingOnly: true };
      continue;
    }
    console.log(`\n== ${leg.name}: embedding ==`);
    const rssBeforeMB = rssMB();
    try {
      let newDocumentPass: Awaited<ReturnType<typeof embedAll>> | undefined;
      const doc = reusedRelevance ? {
        vecs: await embedIncrementalRelevanceDocuments(reusedRelevance, corpusTexts, async (texts) => {
          newDocumentPass = await embedAll(leg.doc, texts, `${leg.name}/new-doc`);
          return newDocumentPass.vecs;
        }),
        seconds: newDocumentPass?.seconds ?? 0, peakRssMB: newDocumentPass?.peakRssMB ?? rssBeforeMB,
      } : await embedAll(leg.doc, corpusTexts, `${leg.name}/doc`);
      let newQueryPass: Awaited<ReturnType<typeof embedAll>> | undefined;
      const query = reusedRelevance ? {
        vecs: await embedIncrementalRelevanceQueries(reusedRelevance, queryTexts, async (texts) => {
          newQueryPass = await embedAll(leg.query, texts, `${leg.name}/new-query`);
          return newQueryPass.vecs;
        }),
        seconds: newQueryPass?.seconds ?? 0, peakRssMB: newQueryPass?.peakRssMB ?? rssBeforeMB,
      } : await embedAll(leg.query, queryTexts, `${leg.name}/query`);
      const workerState = getWorkerState();
      if ((leg.name === 'mdenseon' || (leg.name === 'sidecar:mdenseon' && isolatedSidecar)) && (!workerState.alive || workerState.disabled)) {
        throw new Error('mDenseOn validation requires a live worker; inline inference cannot qualify');
      }
      const repeatedWarm = warmTrials ? await warmTimings(leg, corpusTexts, queryTexts, warmTrials) : undefined;
      record(leg.name, doc.vecs, query.vecs, {
        workerState, repeatedWarm,
        ...leg.metadata,
        ...(reusedRelevance ? { retainedRelevance: reusedRelevance.evidence,
          measuredDocumentCount: reusedRelevance.missingDocumentIndexes.length,
          measuredQueryCount: reusedRelevance.missingIndexes.length,
          timingScope: reusedRelevance.missingDocumentIndexes.length
            ? 'new documents and queries only; retained vectors reused' : 'new queries only; documents reused' } : {}),
        docSeconds: +doc.seconds.toFixed(1),
        querySeconds: +query.seconds.toFixed(1),
        msPerDoc: +((doc.seconds * 1000) / Math.max(reusedRelevance?.missingDocumentIndexes.length ?? corpusTexts.length, 1)).toFixed(1),
        msPerQuery: +((query.seconds * 1000) / Math.max(reusedRelevance?.missingIndexes.length ?? queryTexts.length, 1)).toFixed(1),
        rssBeforeMB,
        peakRssMB: Math.max(doc.peakRssMB, query.peakRssMB),
        rssDeltaMB: +(Math.max(doc.peakRssMB, query.peakRssMB) - rssBeforeMB).toFixed(1),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`   ${leg.name} FAILED mid-embed: ${msg.slice(0, 200)}`);
      results[leg.name] = { blocked: `embed_failed: ${msg.slice(0, 200)}` };
    }
  }

  // PAIRED verdicts (D-002). Computed HERE, from the per-query rows, rather
  // than left for a reader to eyeball two class means — which cannot answer
  // "is this outside noise?" at all, and invites reporting a null as
  // equivalence.
  const hasPerQuery = (v: unknown): v is { perQuery: PerQueryRow[] } =>
    typeof v === 'object' && v !== null && Array.isArray((v as { perQuery?: unknown }).perQuery);
  const scoredLegs = Object.entries(results).filter((e): e is [string, { perQuery: PerQueryRow[] }] =>
    hasPerQuery(e[1]),
  );

  // `--compare-with <prior.json>` folds a PREVIOUS run's legs in as extra
  // comparison candidates. Two uses, both real: comparing a new model against
  // a frozen baseline without paying to re-embed it (P-003 measures granite /
  // Qwen against exactly the gemma numbers recorded here), and comparing the
  // SAME width across runtimes — in-process vs the production sidecar — which
  // is the only way to check that a bench verdict transfers to what actually
  // ships.
  for (const prior of priorRuns) {
    const label = path.basename(prior.path).replace(/\.json$/, '');
    for (const [name, leg] of Object.entries(prior.results ?? {})) {
      if (!hasPerQuery(leg)) continue;
      const merged = `${label}:${name}`;
      results[merged] = { ...(leg as object), fromRun: prior.path };
      scoredLegs.push([merged, leg]);
    }
  }
  if (priorRuns.length) console.log(`\nfolded ${scoredLegs.length} legs total (incl. ${priorRuns.length} prior run(s))`);
  const baselineName = argValue('--baseline') ?? scoredLegs[0]?.[0];
  const comparisons: Record<string, unknown> = {};
  const baseline = scoredLegs.find(([n]) => n === baselineName);
  if (baseline && scoredLegs.length > 1) {
    console.log(`\n== PAIRED comparison vs baseline ${baselineName} (D-002: primary verdict) ==`);
    for (const [name, leg] of scoredLegs) {
      if (name === baselineName) continue;
      const cmp = compareLegs(baselineName!, baseline[1].perQuery, name, leg.perQuery);
      comparisons[name] = { ...cmp, classesDisagree: classesDisagree(cmp), ...(independent ? {
        sourceGrouped: compareSourceGroupedLegs(baselineName!, baseline[1].perQuery, name, leg.perQuery,
          independent.entries, independent.queries.filter((q) => q.partition === 'test')) } : {}) };
      console.log(`\n  ${baselineName} -> ${name}`);
      for (const cls of [ALL_ANSWERABLE, 'lexical-gap', 'exact-identifier', 'session-start-intent']) {
        const row = cmp.byClass[cls];
        if (row) console.log(`    ${row.statement}`);
      }
      if (classesDisagree(cmp)) {
        console.log(
          `    ⚠ CLASSES DISAGREE IN SIGN — the pooled ${ALL_ANSWERABLE} number is uninterpretable here (D-002 §5).`,
        );
      }
    }
  } else if (scoredLegs.length > 1) {
    console.log(`\n(no paired comparison: --baseline '${baselineName}' did not match a scored leg)`);
  }

  const report = { generatedAt: new Date().toISOString(), corpus: corpusChoice, corpusVersion,
    goldVersion: gold.version, goldSetVersion: independent ? independent.goldVersion : (corpusChoice === 'prose' ? PROSE_GOLD_SET_VERSION : gold.version),
    ...(independent ? { labelAuthority: 'independent-blind-before-inference', scoringPartition: 'test',
      calibrationReportedSeparately: true, heldoutQueries: independent.queries.filter((q) => q.partition === 'test').map((q) => ({ id: q.id, class: q.class, group: q.group, expected: q.expected })),
      sourceClusters: Object.fromEntries(independent.entries.map((e) => [e.key, String(e.metadata?.cluster)])) } : {}),
    baseline: baselineName, results, comparisons };
  if (preparedMeasurement) {
    assertMeasuredExecution(preparedMeasurement.arm, embedExecutionTarget(), ORT_SESSION_OPTIONS, getWorkerState());
    if (Object.values(results).some((r) => (r as { blocked?: string }).blocked)) throw new Error('failed arm cannot produce an accepted measured receipt');
    writeMeasurementCell(preparedMeasurement, report);
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  }
  console.log('\nwrote', outPath);
  const vectorsOut = argValue('--vectors-out');
  if (vectorsOut) {
    fs.mkdirSync(path.dirname(vectorsOut), { recursive: true });
    fs.writeFileSync(vectorsOut, JSON.stringify({ corpus: corpusChoice, corpusVersion,
      keys: corpus.map((entry) => entry.key), queryIds: gold.queries.map((query) => query.id),
      vectors: retainedVectors }));
  }
  await isolatedSidecar?.close();
  await shutdownLocalEmbedder();
  process.exit(0);
}

void main().catch(async (e) => {
  if (preparedMeasurement) failMeasurementCell(preparedMeasurement, e);
  console.error('embedder-eval failed:', e);
  await isolatedSidecar?.close();
  await shutdownLocalEmbedder();
  process.exit(1);
});
