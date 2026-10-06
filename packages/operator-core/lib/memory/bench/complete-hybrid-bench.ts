/**
 * P-004 / R-3 (mdenseon-adoption-measurements-2026-10-01): the COMPLETE
 * production memory retrieval path for one model arm, in a uniquely owned
 * benchmark schema.
 *
 * Unlike `candidate-hybrid-bench.ts` (a neutral precomputed-vector adapter
 * over `CanonicalVectorStore`, explicitly excluding entity/decay), this runner
 * drives the PRODUCTION objects end to end: the operator memory host
 * (`../configure`) re-pointed at `bench_memory_<pid>`, the production
 * `Mem0Backend` (verbatim `remember` → mem0 add + entity linking; single-scope
 * `search` → mem0 entity-boosted search; multi-scope → canonical vector pulls;
 * scope/recall filters, relevance floor, decay) wrapped exactly as production
 * registers `hybrid-pg`: `HybridBackend(LexicalLegBackend(mem0), mem0)`.
 *
 * The ONLY substitution is the embedder: `resolveEmbedder` returns the arm's
 * document embedder (production memory embeds documents AND queries with the
 * one document embedder). A candidate profile with no production mode binds
 * through `MemoryHost.candidateStorage`, which is honored only inside this
 * isolated schema and fails closed anywhere else. One arm per process:
 * `configureMemory` and the mem0 client are process-global.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import type { Client } from 'pg';

import {
  configureMemory, memoryHost, Mem0Backend, HybridBackend, LexicalLegBackend,
  MEMORY_VECTOR_STORAGE_PROFILES, buildMdenseOnEmbedder, buildGemmaEmbedder, buildHarrierEmbedder,
  shutdownLocalEmbedder, disposeMemoryClient, type MemoryEntry, type ResolvedEmbedder, type EmbedFn,
} from '@papercusp/memory';
import { reciprocalRank } from '@papercusp/memory/bench';
import { isCliEntry } from '../../util/cli-entry';
import { pushSearchFloors } from '../push-search-floors';
import { setupBenchMemoryHost, benchPgClient, ensureBenchSchema, releaseBenchSchema, BENCH_SCHEMA } from './bench-host';
import { candidateProfile } from './measurement-manifest';
import { calibratedFloor, validateHeldout, type HeldoutQuery, type Snapshot } from './candidate-hybrid-bench';

export type ArmModel = 'mdenseon' | 'gemma' | 'harrier';
export type Corpus = 'memory' | 'prose';
export const BENCH_SCOPE = 'bench';
/** Empty second scope: production push recall pulls several scopes at once,
 *  which routes through the canonical vector path instead of mem0's search. */
export const BENCH_SECOND_SCOPE = 'bench-shared';
/** Isolation decoys: copies of answer documents in a scope no route queries. */
export const LEAK_SCOPE = 'bench-leak';
export const LEAK_PREFIX = 'leak:';
export const ROUTES = ['pull', 'push', 'push-calibrated', 'raw'] as const;
export type Route = (typeof ROUTES)[number];

/** Physical layout per arm: mDenseOn is 768-d cosine, so it reuses the gemma
 *  table shape in its OWN schema — never aliased to the gemma profile. */
export function armStorageMode(model: ArmModel): 'gemma' | 'harrier' {
  return model === 'harrier' ? 'harrier' : 'gemma';
}

/** The ResolvedEmbedder the production host would return for this arm, plus
 *  the candidate acceptance it needs (undefined for production profiles). */
export function armBinding(model: ArmModel, schema: string, embed: EmbedFn): {
  resolved: Exclude<ResolvedEmbedder, { mode: 'disabled' }>;
  candidateStorage?: { schema: string; acceptedProfileIds: { gemma?: string[]; harrier?: string[] } };
} {
  const mode = armStorageMode(model);
  const profile = candidateProfile(model);
  const resolved = { mode, dims: profile.targetDims, profile, embed } as const;
  const productionAccepted = (MEMORY_VECTOR_STORAGE_PROFILES[mode].acceptedProfileIds as readonly string[]).includes(profile.profileId);
  return productionAccepted ? { resolved }
    : { resolved, candidateStorage: { schema, acceptedProfileIds: { [mode]: [profile.profileId] } } };
}

/** Production search options per route. `pull` = memory:search defaults;
 *  `push` = injection floors as shipped (calibrated for the production
 *  embedder); `push-calibrated` = the same with this arm's cosine floor;
 *  `raw` = no cosine floor (recall ceiling of the same fused path). */
export function routeOptions(route: Route, calibratedCosineFloor: number): {
  scope: string | string[]; limit: number; [k: string]: unknown;
} {
  const push = pushSearchFloors() as unknown as Record<string, unknown>;
  switch (route) {
    case 'pull': return { scope: BENCH_SCOPE, limit: 10 };
    case 'push': return { ...push, scope: [BENCH_SCOPE, BENCH_SECOND_SCOPE], limit: 10 };
    case 'push-calibrated': return { ...push, minScore: calibratedCosineFloor, scope: [BENCH_SCOPE, BENCH_SECOND_SCOPE], limit: 10 };
    // A floor requires an explicit fusion mode (SearchFloorPolicy); floored-union is the pull default.
    case 'raw': return { scope: BENCH_SCOPE, limit: 10, minScore: 0, fusionMode: 'floored-union' };
  }
}

export interface RouteRow {
  rankedKeys: string[]; reciprocalRank: number; hits: number; relevantHits: number;
  precision: number | null; admittedNegative: boolean | null; leakedKeys: string[];
}

/** Per-query outcome on one route. A query with no expected target is a
 *  negative: any admitted hit is a false admission. */
export function scoreRoute(expected: string[], rankedKeys: string[]): RouteRow {
  const leakedKeys = rankedKeys.filter((k) => k.startsWith(LEAK_PREFIX));
  const relevantHits = rankedKeys.filter((k) => expected.includes(k)).length;
  const negative = expected.length === 0;
  return { rankedKeys, reciprocalRank: negative ? 0 : reciprocalRank(expected, rankedKeys), hits: rankedKeys.length,
    relevantHits, precision: rankedKeys.length ? relevantHits / rankedKeys.length : null,
    admittedNegative: negative ? rankedKeys.length > 0 : null, leakedKeys };
}

export function summarizeRoute(rows: RouteRow[]) {
  const positives = rows.filter((r) => r.admittedNegative === null);
  const negatives = rows.filter((r) => r.admittedNegative !== null);
  const withHits = positives.filter((r) => r.precision !== null);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return { queries: rows.length, positives: positives.length, negatives: negatives.length,
    mrr: mean(positives.map((r) => r.reciprocalRank)),
    recallAt10: mean(positives.map((r) => (r.relevantHits > 0 ? 1 : 0))),
    precision: mean(withHits.map((r) => r.precision as number)),
    emptyPositive: positives.length - withHits.length,
    negativeAdmission: negatives.length ? negatives.filter((r) => r.admittedNegative).length / negatives.length : null,
    leakedHits: rows.reduce((n, r) => n + r.leakedKeys.length, 0) };
}

/** Freeze the age-as-of-snapshot of each memory source (created_at is
 *  immutable) so decay is exercised reproducibly: the runner re-stamps each
 *  seeded row at `runStart − age`, keeping every age identical across runs. */
export async function freezeMemoryAges(snapshotFile: string, out: string, db: Client): Promise<Record<string, number>> {
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as Snapshot;
  const ids = snapshot.suites.memory.entries.map((e) => e.key).filter((k) => k.startsWith('memory:')).map((k) => k.slice(7));
  const { rows } = await db.query<{ id: string; created_at: Date }>(
    'SELECT id::text, created_at FROM harness_shared.memory_canonical WHERE id = ANY($1::uuid[])', [ids]);
  const at = new Date(snapshot.snapshotAt).getTime();
  const ages = Object.fromEntries(rows.map((r) => [`memory:${r.id}`, Math.max(0, (at - r.created_at.getTime()) / 86_400_000)]));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify({ snapshotAt: snapshot.snapshotAt, ages }, null, 1)}\n`, { flag: 'wx' });
  return ages;
}

const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const keyOf = (h: MemoryEntry) => String(h.metadata?.corpus_key ?? h.id);

export interface CompleteRunOptions {
  snapshot: string; gold: string; model: ArmModel; corpus: Corpus; out: string;
  modelDirectory?: string; ages?: string; leakSample?: number;
  /** PROTOCOL TESTS ONLY: a synthetic document embedder replacing the arm's
   *  real weights. The report records `binding.syntheticEmbedder: true`, so
   *  such a run can never be read as a model measurement. */
  embed?: EmbedFn;
}

export async function runCompleteHybrid(opts: CompleteRunOptions) {
  const snapshot = JSON.parse(fs.readFileSync(opts.snapshot, 'utf8')) as Snapshot;
  const labels = JSON.parse(fs.readFileSync(opts.gold, 'utf8')) as Record<Corpus, HeldoutQuery[]>;
  const entries = snapshot.suites[opts.corpus].entries;
  const queries = labels[opts.corpus];
  validateHeldout(entries, queries);
  if (opts.model === 'mdenseon' && !opts.modelDirectory && !opts.embed) throw new Error('mDenseOn requires its validated local model');
  if (fs.existsSync(opts.out)) throw new Error(`refusing to overwrite ${opts.out}`);
  const agesFile = opts.ages ? JSON.parse(fs.readFileSync(opts.ages, 'utf8')) as { snapshotAt: string; ages: Record<string, number> } : null;
  if (agesFile && agesFile.snapshotAt !== snapshot.snapshotAt) throw new Error('ages were frozen for a different snapshot');

  const schema = BENCH_SCHEMA;
  const embed: EmbedFn = opts.embed ?? (opts.model === 'mdenseon'
    ? buildMdenseOnEmbedder({ kind: 'document', model: opts.modelDirectory! })
    : opts.model === 'gemma' ? buildGemmaEmbedder({ kind: 'document', dims: 768 }) : buildHarrierEmbedder({ kind: 'document' }));
  let embedCalls = 0;
  const counted: EmbedFn = async (text, signal) => { embedCalls += 1; return embed(text, signal); };
  const { resolved, candidateStorage } = armBinding(opts.model, schema, counted);
  setupBenchMemoryHost(schema);
  configureMemory({ ...memoryHost(), resolveEmbedder: async () => resolved, ...(candidateStorage ? { candidateStorage } : {}) });

  const db = await benchPgClient();
  try {
    await ensureBenchSchema(db, schema);
    const mem0 = new Mem0Backend();
    const hybrid = new HybridBackend(new LexicalLegBackend(mem0), mem0, { name: 'hybrid-pg' });
    const available = await mem0.available();
    if (!available.ok) throw new Error(`production memory client unavailable in ${schema}: ${JSON.stringify(available)}`);
    // Exercise every route on the EMPTY schema first: infrastructure failure must not score as a loss.
    for (const route of ROUTES) await hybrid.search('preflight', routeOptions(route, 0) as never);

    const runStart = Date.now();
    const seedStarted = performance.now();
    for (const e of entries) {
      await mem0.remember(e.text, { scope: BENCH_SCOPE, verbatim: true, kind: e.kind,
        metadata: { ...e.metadata, corpus_key: e.key } });
    }
    const testQueries = queries.filter((q) => q.partition === 'test');
    const leakKeys = [...new Set(testQueries.flatMap((q) => q.expected))].sort().slice(0, opts.leakSample ?? 64);
    const byKey = new Map(entries.map((e) => [e.key, e]));
    for (const k of leakKeys) {
      await mem0.remember(byKey.get(k)!.text, { scope: LEAK_SCOPE, verbatim: true, metadata: { corpus_key: `${LEAK_PREFIX}${k}` } });
    }
    const seedMs = performance.now() - seedStarted;
    const seedEmbedCalls = embedCalls;

    // Decay input: stamp each aged row at runStart − frozen age (payload + columns).
    // mem0 stores caller metadata FLAT in the payload (canonicalRowToEntry reads
    // it back as `payload` minus data/user_id), so corpus_key is top-level.
    // Only BENCH_SCOPE rows are stamped: leak decoys stay decay-neutral.
    let agedRows = 0;
    if (agesFile) {
      const agedKeys = Object.keys(agesFile.ages).filter((k) => byKey.has(k));
      for (const key of agedKeys) {
        const ts = new Date(runStart - agesFile.ages[key] * 86_400_000).toISOString();
        const r = await db.query(
          `UPDATE ${schema}.memory_canonical SET created_at = $2::timestamptz, updated_at = $2::timestamptz,
             payload = payload || jsonb_build_object('createdAt', $2::text, 'updatedAt', $2::text)
           WHERE payload->>'corpus_key' = $1 AND payload->>'user_id' = $3 AND NOT (payload ? 'entityType')`,
          [key, ts, BENCH_SCOPE]);
        agedRows += r.rowCount ?? 0;
      }
      // Fail closed: an age that did not land leaves decay silently inert, and
      // the run would still report numbers labelled "with decay".
      if (agedRows !== agedKeys.length) {
        throw new Error(`decay stamping matched ${agedRows} of ${agedKeys.length} frozen-age documents in ${schema}`);
      }
    }
    const census = (await db.query<{ memories: string; entities: string }>(
      `SELECT count(*) FILTER (WHERE NOT (payload ? 'entityType')) AS memories,
              count(*) FILTER (WHERE payload ? 'entityType') AS entities FROM ${schema}.memory_canonical`)).rows[0];

    // Calibrate this arm's cosine floor on CALIBRATION queries only (source-split before inference).
    const calibration = [];
    for (const q of queries.filter((x) => x.partition === 'calibration')) {
      const top = await mem0.search(q.query, { scope: BENCH_SCOPE, limit: 10, minScore: 0, fusionMode: 'floored-union' });
      calibration.push({ partition: 'calibration', expected: q.expected, topScore: top[0]?.score ?? 0 });
    }
    const floor = calibratedFloor(calibration);

    const positiveControl = leakKeys.length
      ? (await mem0.search(byKey.get(leakKeys[0])!.text, { scope: LEAK_SCOPE, limit: 5, minScore: 0, fusionMode: 'floored-union' })).map(keyOf)
      : [];
    if (leakKeys.length && !positiveControl.some((k) => k.startsWith(LEAK_PREFIX))) {
      throw new Error('scope-isolation positive control failed: the leak scope is not searchable, so the guard would be vacuous');
    }

    const rows: Array<{ id: string; class: string; group: string; expected: string[];
      routes: Partial<Record<Route, RouteRow & { ms: number }>> }> = [];
    for (const q of testQueries) {
      const perRoute: Partial<Record<Route, RouteRow & { ms: number }>> = {};
      for (const route of ROUTES) {
        const t0 = performance.now();
        const hits = await hybrid.search(q.query, routeOptions(route, floor) as never);
        perRoute[route] = { ...scoreRoute(q.expected, hits.map(keyOf)), ms: performance.now() - t0 };
      }
      rows.push({ id: q.id, class: q.class, group: q.group, expected: q.expected, routes: perRoute });
    }
    const leaked = rows.reduce((n, r) => n + ROUTES.reduce((m, rt) => m + (r.routes[rt]?.leakedKeys.length ?? 0), 0), 0);
    const summary = Object.fromEntries(ROUTES.map((rt) => [rt, summarizeRoute(rows.map((r) => r.routes[rt]!))]));
    const byClass = Object.fromEntries([...new Set(rows.map((r) => r.class))].map((c) => [c,
      Object.fromEntries(ROUTES.map((rt) => [rt, summarizeRoute(rows.filter((r) => r.class === c).map((r) => r.routes[rt]!))]))]));
    const report = {
      formatVersion: 1, runner: 'complete-hybrid-bench', model: opts.model, corpus: opts.corpus,
      binding: { schema, mode: resolved.mode, profileId: resolved.profile.profileId,
        table: MEMORY_VECTOR_STORAGE_PROFILES[resolved.mode].table, candidateStorage: candidateStorage ?? null,
        syntheticEmbedder: Boolean(opts.embed) },
      inputs: { snapshot: opts.snapshot, snapshotSha256: sha256(opts.snapshot), snapshotAt: snapshot.snapshotAt,
        gold: opts.gold, goldSha256: sha256(opts.gold), ages: opts.ages ?? null, agesSha256: opts.ages ? sha256(opts.ages) : null },
      seed: { documents: entries.length, leakDecoys: leakKeys.length, seedMs, seedEmbedCalls, memories: Number(census.memories),
        entities: Number(census.entities), agedRows },
      calibration: { queries: calibration.length, calibratedCosineFloor: floor },
      pushFloors: pushSearchFloors(),
      guards: { scopeIsolation: { leakScope: LEAK_SCOPE, decoys: leakKeys.length, positiveControlHits: positiveControl.length, leakedHits: leaked } },
      summary, byClass, rows,
      limitations: [
        'production memory embeds queries with the document embedder (single mem0 embed fn); no asymmetric query prompt',
        'push floors are calibrated for the production embedder; push-calibrated substitutes this arm\'s calibration-partition cosine floor',
        'prose snapshot entries are stored as memory rows through the canonical memory backend (R-3 route), not the prose search surface',
        'decay is exercised only where frozen source ages exist (memory corpus); unknown ages decay-neutral by design',
      ],
    };
    if (leaked > 0) throw Object.assign(new Error(`scope isolation violated: ${leaked} leak-scope hits surfaced`), { report });
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, `${JSON.stringify(report)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ model: opts.model, corpus: opts.corpus, docs: entries.length, test: rows.length,
      entities: report.seed.entities, agedRows, floor, summary: Object.fromEntries(ROUTES.map((rt) => [rt, summary[rt].mrr])), out: opts.out }));
    return report;
  } finally {
    // The mem0 client caches its schema/embedder at construction; dispose it so
    // nothing outlives this arm's schema (and a later run rebuilds from config).
    await disposeMemoryClient().catch(() => {});
    await releaseBenchSchema(db, schema);
    await db.end();
    await shutdownLocalEmbedder();
  }
}

if (isCliEntry(import.meta.url)) {
  const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const run = arg('--freeze-ages')
    ? benchPgClient().then(async (db) => { try { return await freezeMemoryAges(arg('--snapshot')!, arg('--freeze-ages')!, db); } finally { await db.end(); } })
    : runCompleteHybrid({ snapshot: arg('--snapshot')!, gold: arg('--gold')!, model: arg('--model') as ArmModel,
      corpus: arg('--corpus') as Corpus, out: arg('--out')!, modelDirectory: arg('--mdenseon-model'), ages: arg('--ages'),
      leakSample: arg('--leak-sample') ? Number(arg('--leak-sample')) : undefined });
  void run.then(() => process.exit(0)).catch((e) => {
    console.error(e instanceof Error ? e.message : e); process.exit(1);
  });
}
