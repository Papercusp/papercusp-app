/**
 * P-031 — does SCORE-AWARE fusion beat rank-only RRF on @papercusp/search?
 *
 *   ./node_modules/.bin/tsx packages/operator-core/lib/memory/bench/fusion-score-aware-cli.ts
 *   (run fusion-score-aware-cache.ts first — it writes the vector cache)
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────────
 * `fusion-sweep-cli.ts` / `floor-sweep-cli.ts` next door evaluate the MEMORY
 * backend's mem0+claude-file fusion. Nothing evaluated `@papercusp/search`'s
 * RRF (`rrfCombine`, the bm25 + pgvector fusion behind search:semantic), which
 * is what P-031 is about. This is that instrument.
 *
 * ─── WHAT IS ACTUALLY IN QUESTION (narrower than the plan item assumed) ────
 * Within ONE ranker's list, score order ≡ rank order BY CONSTRUCTION — every
 * source emits `ORDER BY rank DESC` / `ORDER BY <col> <=> qVec` with `score`
 * set to that same quantity. So a per-candidate weight that is a monotone
 * function of that candidate's own score CANNOT reorder within a list; it can
 * only change how much each RANKER's votes weigh against the other's. That is
 * the only mechanism a score-aware variant can exploit here, and it is what
 * the arms below vary. (`rank-order ≡ score-order` is asserted as a property
 * test in fusion-score-aware.test.ts so this premise cannot silently rot.)
 *
 * ─── FAITHFULNESS ─────────────────────────────────────────────────────────
 * Both legs are the real thing, not a re-implementation:
 *   - lexical: PostgreSQL `ts_rank_cd(tsv, plainto_tsquery('english', q))`
 *     with the same `@@` admission and `ORDER BY rank DESC LIMIT` production
 *     uses (agent-tools/search/sources.ts).
 *   - vector: exact cosine over L2-normalised gemma@768 vectors — identical to
 *     pgvector's `1 - (v <=> q)` for normalised inputs — from the SAME
 *     embedder construction the 2026-08-03 bake-off (D-012) measured on.
 * Fusion itself calls the production `rrfCombine` for the baseline arm, so the
 * baseline cannot drift from what search:semantic actually runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { RRF_K_DEFAULT, type RankedItem } from '@papercusp/rrf';
import pg from 'pg';

import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { EMBEDDING_FLOOR_GEMMA } from '../../search/prose-min-score';
import { buildArms, pairedBootstrap, ramp, type Leg } from './fusion-score-aware';
import { loadProseGoldSetFixture } from './prose-gold-set';

const argOf = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const MODEL = argOf('--model') ?? 'gemma768';

/**
 * The embeddings floor to apply, per model.
 *
 * gemma768 uses the SHIPPED constant (`EMBEDDING_FLOOR_GEMMA`, P-001) — never a
 * re-typed literal, so this instrument cannot drift from the path it measures.
 *
 * qwen3768 is NOT shipped and has no measured floor. Applying gemma's 0.45 to
 * it would be precisely the error `search/prose-min-score.ts` documents (cosine
 * offsets are a property of the MODEL), so the value here is derived by P-001's
 * OWN method — ~0.03 below the worst answerable top-1 observed for that model on
 * this gold set (qwen3@768: worst answerable top-1 .3885 → .36) — and is used
 * ONLY to give the qwen3 arm a comparable operating point. It is a bench
 * parameter, not a proposed production constant.
 */
const FLOORS: Record<string, number> = { gemma768: EMBEDDING_FLOOR_GEMMA, qwen3768: 0.36 };
const FLOOR = Number.parseFloat(argOf('--floor') ?? String(FLOORS[MODEL] ?? EMBEDDING_FLOOR_GEMMA));
const CACHE = process.env.FUSION_CACHE_PATH ?? `/tmp/p031-${MODEL}-prose-vectors.json`;
const SCHEMA = `bench_fusion_${process.pid}`;
/** Production over-fetch: SearchContext uses `limit * 3`. */
const LIMIT = 10;
const CANDIDATES = LIMIT * 3;
const MRR_CUTOFF = 10;
const ANSWERABLE = new Set(['lexical-gap', 'session-start-intent', 'exact-identifier']);

const log = (m: string): void => console.log(new Date().toISOString().slice(11, 19), m);

interface Cache {
  model: string;
  corpusKeys: string[];
  corpusTexts: string[];
  docVecs: number[][];
  queryVecs: number[][];
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * The embeddings ramp. `EMB_LO` is the model's floor — where P-001 already cuts
 * as a STEP — so the ramp is the CONTINUOUS generalisation of the step function
 * already shipped, which is precisely the comparison P-031 reduces to.
 * (`bm25`'s `ts_rank_cd` is unbounded, so arms that weight it normalise within
 * the query's own list instead; see `buildArms`.)
 */
const EMB_LO = FLOOR;
/** Top of the ramp: just above the highest top-1 cosine observed for the model
 *  across the whole gold set (gemma@768 .7553, qwen3@768 .7810). */
const EMB_HI = Number.parseFloat(argOf('--rampHi') ?? (MODEL === 'qwen3768' ? '0.78' : '0.75'));

const ARMS = buildArms(EMB_LO, EMB_HI);

const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Cache;
const gold = loadProseGoldSetFixture();
log(`cache model=${cache.model} docs=${cache.corpusKeys.length} queries=${gold.queries.length}`);
if (cache.queryVecs.length !== gold.queries.length) {
  throw new Error(`cache/gold mismatch: ${cache.queryVecs.length} vs ${gold.queries.length}`);
}

const client = new pg.Client({ connectionString: getHarnessAdminUrl() });
await client.connect();

try {
  log(`creating ${SCHEMA} and loading ${cache.corpusKeys.length} docs…`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await client.query(
    `CREATE TABLE ${SCHEMA}.docs (
       key text PRIMARY KEY,
       body text NOT NULL,
       body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
     )`,
  );
  // Batch insert.
  const B = 200;
  for (let i = 0; i < cache.corpusKeys.length; i += B) {
    const keys = cache.corpusKeys.slice(i, i + B);
    const texts = cache.corpusTexts.slice(i, i + B);
    const values = keys.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(',');
    const params = keys.flatMap((k, j) => [k, texts[j]!]);
    await client.query(`INSERT INTO ${SCHEMA}.docs (key, body) VALUES ${values}`, params);
  }
  await client.query(`CREATE INDEX ON ${SCHEMA}.docs USING GIN (body_tsv)`);
  log('corpus loaded + indexed');

  const keyIndex = new Map(cache.corpusKeys.map((k, i) => [k, i]));
  void keyIndex;

  // Per-arm per-query reciprocal rank, and the hard-negative top-1 behaviour.
  const rrByArm = new Map<string, number[]>();
  for (const a of ARMS) rrByArm.set(a.label, []);
  let answerableN = 0;
  const baselineLabel = ARMS[0]!.label;
  /** qi → the baseline's top-10 key sequence, for the ordering-change count. */
  const baselineTop = new Map<number, string>();
  const orderChanged = new Map<string, number>();
  const diag = {
    overlap: [] as number[],
    bmN: [] as number[],
    embN: [] as number[],
    embFloored: [] as number[],
    weights: [] as number[],
    topBoth: 0,
    topBmOnly: 0,
    topEmbOnly: 0,
  };

  for (let qi = 0; qi < gold.queries.length; qi++) {
    const q = gold.queries[qi]!;
    if (!ANSWERABLE.has(q.class)) continue;
    answerableN++;

    // --- lexical leg: real ts_rank_cd, production's admission + ordering ---
    const bm = await client.query<{ key: string; rank: number }>(
      `SELECT key, ts_rank_cd(body_tsv, plainto_tsquery('english', $1)) AS rank
         FROM ${SCHEMA}.docs
        WHERE body_tsv @@ plainto_tsquery('english', $1)
        ORDER BY rank DESC LIMIT $2`,
      [q.query, CANDIDATES],
    );
    const bm25: Array<RankedItem<string>> = bm.rows.map((r) => ({
      key: r.key,
      score: Number(r.rank),
      row: r.key,
    }));

    // --- vector leg: exact cosine, then the SHIPPED P-001 floor ---
    const qv = cache.queryVecs[qi]!;
    const simsRaw = cache.docVecs
      .map((dv, di) => ({ key: cache.corpusKeys[di]!, score: dot(qv, dv) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, CANDIDATES);
    const rawEmbCount = simsRaw.length;
    const sims = simsRaw.filter((c) => c.score >= FLOOR);
    const embeddings: Array<RankedItem<string>> = sims.map((c) => ({
      key: c.key,
      score: c.score,
      row: c.key,
    }));

    const legs: Leg[] = [
      { name: 'bm25', list: bm25 },
      { name: 'embeddings', list: embeddings },
    ];

    // ─── MECHANISM DIAGNOSTICS ─────────────────────────────────────────────
    // Why an arm did or did not move anything is the actual finding here, so
    // measure the structure of the pool rather than inferring it afterwards.
    const bmKeys = new Set(bm25.map((e) => e.key));
    const embKeys = new Set(embeddings.map((e) => e.key));
    const overlap = [...embKeys].filter((k) => bmKeys.has(k)).length;
    diag.overlap.push(overlap);
    diag.bmN.push(bm25.length);
    diag.embN.push(embeddings.length);
    diag.embFloored.push(rawEmbCount - embeddings.length);
    for (const e of embeddings) diag.weights.push(ramp(e.score, EMB_LO, EMB_HI));
    // Composition of the BASELINE top-10: which leg each slot came from.
    const baseTop = ARMS[0]!.fuse(legs).slice(0, LIMIT);
    for (const k of baseTop) {
      if (bmKeys.has(k) && embKeys.has(k)) diag.topBoth++;
      else if (bmKeys.has(k)) diag.topBmOnly++;
      else diag.topEmbOnly++;
    }

    const expected = new Set(q.expected);
    for (const arm of ARMS) {
      const fused = arm.fuse(legs);
      let rr = 0;
      for (let r = 0; r < Math.min(fused.length, MRR_CUTOFF); r++) {
        if (expected.has(fused[r]!)) {
          rr = 1 / (r + 1);
          break;
        }
      }
      rrByArm.get(arm.label)!.push(rr);
      // Track ORDERING change separately from QUALITY change. An arm can
      // reshuffle the top-10 without moving the first relevant hit, and — the
      // case that actually bit here — it can also leave the order untouched
      // entirely. Reporting only ΔMRR cannot tell "made no difference to
      // quality" apart from "did literally nothing", and those have opposite
      // engineering meanings.
      const top = fused.slice(0, LIMIT).join('|');
      if (arm.label === baselineLabel) baselineTop.set(qi, top);
      else if (baselineTop.get(qi) !== top) orderChanged.set(arm.label, (orderChanged.get(arm.label) ?? 0) + 1);
    }
    if (answerableN % 20 === 0) log(`  ${answerableN} answerable queries replayed`);
  }

  log(`replayed ${answerableN} answerable queries across ${ARMS.length} arms`);

  const baseline = ARMS[0]!.label;
  const base = rrByArm.get(baseline)!;
  const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;

  const rows: string[] = [];
  rows.push('| arm | MRR@10 | Δ vs baseline | 95% CI (paired bootstrap) | top-10 order changed | verdict |');
  rows.push('| --- | --- | --- | --- | --- | --- |');
  for (const arm of ARMS) {
    const v = rrByArm.get(arm.label)!;
    if (arm.label === baseline) {
      rows.push(`| ${arm.label} | ${mean(v).toFixed(4)} | — | — | — | baseline |`);
      continue;
    }
    const diffs = v.map((x, i) => x - base[i]!);
    const { mean: d, lo, hi } = pairedBootstrap(diffs);
    const rrChanged = diffs.filter((x) => x !== 0).length;
    const ordChanged = orderChanged.get(arm.label) ?? 0;
    // NO-OP is a strictly stronger claim than "no measured difference": the arm
    // produced a byte-identical ranking, so no gold set of any size could ever
    // separate it from the baseline.
    const verdict =
      ordChanged === 0 ? 'NO-OP (byte-identical ranking)' : lo > 0 ? 'BETTER' : hi < 0 ? 'WORSE' : 'no difference';
    rows.push(
      `| ${arm.label} | ${mean(v).toFixed(4)} | ${d >= 0 ? '+' : ''}${d.toFixed(4)} | [${lo.toFixed(4)}, ${hi.toFixed(4)}] | ${ordChanged}/${v.length} | ${verdict} (RR moved on ${rrChanged}) |`,
    );
  }

  const avg = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const pct = (a: number[], p: number): number => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  };
  const topTotal = diag.topBoth + diag.topBmOnly + diag.topEmbOnly;
  const diagMd =
    `## Why the arms behave that way (pool structure, measured)\n\n` +
    `Per query, mean over ${answerableN} queries:\n\n` +
    `- bm25 candidates ${avg(diag.bmN).toFixed(1)} · embeddings candidates ${avg(diag.embN).toFixed(1)} ` +
    `(floor dropped ${avg(diag.embFloored).toFixed(1)} of ${CANDIDATES})\n` +
    `- **keys present in BOTH legs: ${avg(diag.overlap).toFixed(2)}** ` +
    `(median ${pct(diag.overlap, 0.5)}, p90 ${pct(diag.overlap, 0.9)})\n` +
    `- embeddings score→weight after ramp [${EMB_LO}, ${EMB_HI}]: ` +
    `mean ${avg(diag.weights).toFixed(3)}, p10 ${pct(diag.weights, 0.1).toFixed(3)}, ` +
    `p50 ${pct(diag.weights, 0.5).toFixed(3)}, p90 ${pct(diag.weights, 0.9).toFixed(3)}\n` +
    `- baseline top-${LIMIT} slot provenance: ` +
    `both-legs ${((diag.topBoth / topTotal) * 100).toFixed(1)}% · ` +
    `bm25-only ${((diag.topBmOnly / topTotal) * 100).toFixed(1)}% · ` +
    `embeddings-only ${((diag.topEmbOnly / topTotal) * 100).toFixed(1)}%\n\n`;

  const md =
    `# P-031 score-aware fusion vs rank-only RRF — ${new Date().toISOString()}\n\n` +
    `corpus ${cache.corpusKeys.length} docs · ${answerableN} answerable gold queries · ` +
    `${cache.model} · embeddings floor ${FLOOR}` +
    `${MODEL === 'gemma768' ? ' (P-001, SHIPPED)' : ' (derived by P-001 method, bench-only)'} · ` +
    `ramp [${EMB_LO}, ${EMB_HI}] · k=${RRF_K_DEFAULT}\n\n` +
    rows.join('\n') +
    '\n\n' +
    diagMd;
  console.log('\n' + md);

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..', '..');
  const dir = path.join(repoRoot, '.papercusp', 'bench-reports');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(dir, `fusion-score-aware-${MODEL}-${stamp}.md`), md, 'utf8');
  fs.writeFileSync(
    path.join(dir, `fusion-score-aware-${MODEL}-${stamp}.json`),
    JSON.stringify(
      { model: cache.model, floor: FLOOR, rampHi: EMB_HI, answerableN, perArm: Object.fromEntries(rrByArm) },
      null,
      2,
    ),
    'utf8',
  );
  log(`wrote .papercusp/bench-reports/fusion-score-aware-${MODEL}-${stamp}.{md,json}`);
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.end();
}
process.exit(0);
