/** Isolated candidate evaluation using the production canonical, lexical and
 * fusion implementations. Snapshot and labels are frozen before inference. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from 'pg';
import { isCliEntry } from '../../util/cli-entry';
import {
  CanonicalVectorStore, HybridBackend, LexicalLegBackend,
  MEMORY_VECTOR_STORAGE_PROFILES,
  buildMdenseOnEmbedder, buildGemmaEmbedder, buildHarrierEmbedder,
  shutdownLocalEmbedder, getWorkerState,
  embedExecutionTarget,
  type MemoryVectorStorageProfile, type MemoryBackend, type MemoryEntry,
} from '@papercusp/memory';
import { reciprocalRank, type CorpusEntry } from '@papercusp/memory/bench';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { ensureBenchSchema, releaseBenchSchema } from './bench-host';
import { pickClusters } from './prose-corpus';
import { applyScoreFloor } from '../../../../../libs/generic/memory/src/score-floor';
import { ORT_SESSION_OPTIONS } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { assertCandidateArm, candidateProfile, assertMeasuredExecution,
  prepareMeasurementCell, writeMeasurementCell, failMeasurementCell } from './measurement-manifest';
export { candidateProfile } from './measurement-manifest';

export interface HeldoutQuery {
  id: string; class: string; query: string; expected: string[];
  partition: 'calibration' | 'test'; group: string;
}
export interface Snapshot {
  formatVersion: 1; snapshotAt: string; seed: string;
  suites: Record<'memory' | 'prose', { entries: CorpusEntry[] }>;
}
export interface CandidateSnapshotOptions {
  seed?: string; memoryLimit?: number; proseBudget?: number; maxClusterRows?: number; censusOut?: string; requireMemorySource?: boolean;
}
export function candidateMemoryEntry(row: { id: string; text: string; source_session?: string | null }): CorpusEntry {
  const session = row.source_session?.trim() || null;
  return { key: `memory:${row.id}`, text: row.text, kind: 'fact', metadata: {
    cluster: session ? `session:${session}` : `unattributed-fact:${row.id}`,
    sourceSession: session, sourceAttribution: session ? 'session' : 'unknown',
  } };
}
/** Assign the real source, rather than a query, before any label or inference. */
export function candidateSourcePartition(cluster: string, seed: string): 'calibration' | 'test' {
  if (!cluster.trim() || !seed.trim()) throw new Error('source partition requires cluster and seed');
  return crypto.createHash('sha256').update(`${seed}\0${cluster}`).digest()[0] < 64 ? 'calibration' : 'test';
}
export function selectCandidateSources(population: Snapshot['suites'], options: CandidateSnapshotOptions = {}): Snapshot['suites'] {
  const seed = options.seed ?? 'mdenseon-heldout-2026-10-01';
  const memoryLimit = options.memoryLimit ?? 48, proseBudget = options.proseBudget ?? 48, maxClusterRows = options.maxClusterRows ?? 4;
  for (const n of [memoryLimit, proseBudget, maxClusterRows]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('snapshot budgets must be positive safe integers');
  }
  const annotate = (entry: CorpusEntry): CorpusEntry => {
    const cluster = String(entry.metadata?.cluster ?? '');
    return { ...entry, metadata: { ...entry.metadata, partition: candidateSourcePartition(cluster, seed),
      textSha256: crypto.createHash('sha256').update(entry.text).digest('hex') } };
  };
  for (const corpus of ['memory', 'prose'] as const) {
    if (new Set(population[corpus].entries.map((e) => e.key)).size !== population[corpus].entries.length) throw new Error('duplicate census key');
    // Validate the whole population, including targets outside the first sample.
    for (const entry of population[corpus].entries) annotate(entry);
  }
  const stable = (entries: CorpusEntry[]) => [...entries].sort((a, b) => {
    const hash = (e: CorpusEntry) => crypto.createHash('sha256').update(`${seed}\0${e.key}`).digest('hex');
    return hash(a).localeCompare(hash(b)) || a.key.localeCompare(b.key);
  });
  const groups = new Map<string, CorpusEntry[]>();
  for (const entry of population.prose.entries) {
    const cluster = String(entry.metadata!.cluster); groups.set(cluster, [...(groups.get(cluster) ?? []), entry]);
  }
  const picked = pickClusters([...groups].map(([key, rows]) => ({ key, size: rows.length })), proseBudget, maxClusterRows, seed);
  const memories = options.requireMemorySource ? population.memory.entries.filter((e) => e.metadata?.sourceAttribution === 'session') : population.memory.entries;
  return { memory: { entries: stable(memories).slice(0, memoryLimit).map(annotate) },
    prose: { entries: picked.keys.flatMap((key) => stable(groups.get(key)!).slice(0, maxClusterRows)).map(annotate) } };
}

/** Account against the retained, pre-selection census. A sampled snapshot or
 * finished label cohort cannot establish exhaustion of the accessible sources.
 * Lists stay private; public evidence can publish their counts and file hash. */
export function accountIndependentSources(
  census: { snapshotAt: string; seed: string; population: Snapshot['suites'];
    selectedKeys: Record<'memory' | 'prose', string[]> },
  snapshot: Snapshot,
  authored: Record<'memory' | 'prose', HeldoutQuery[]>,
  accepted: Record<'memory' | 'prose', HeldoutQuery[]>,
) {
  if (census.seed !== snapshot.seed || census.snapshotAt !== snapshot.snapshotAt) throw new Error('source census snapshot identity mismatch');
  const classes = ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'];
  return Object.fromEntries((['memory', 'prose'] as const).map((corpus) => {
    const population = census.population[corpus].entries, selected = snapshot.suites[corpus].entries;
    const byKey = new Map(population.map((e) => [e.key, e]));
    if (byKey.size !== population.length || new Set(selected.map((e) => e.key)).size !== selected.length
      || JSON.stringify(census.selectedKeys[corpus]) !== JSON.stringify(selected.map((e) => e.key))) throw new Error('source census selected keys mismatch/duplicate');
    const groupOf = (e: CorpusEntry): string => {
      const group = e.metadata?.cluster;
      if (typeof group !== 'string' || !group.trim()) throw new Error('source census cluster missing');
      return group;
    };
    const eligible = (e: CorpusEntry): boolean => corpus !== 'memory' || e.metadata?.sourceAttribution === 'session';
    const groups = new Map<string, CorpusEntry[]>();
    for (const e of population) {
      const group = groupOf(e);
      if (!eligible(e)) continue;
      if (corpus === 'memory' && (typeof e.metadata?.sourceSession !== 'string' || !e.metadata.sourceSession.trim()
        || group !== `session:${e.metadata.sourceSession}`)) throw new Error('source census memory provenance mismatch');
      groups.set(group, [...(groups.get(group) ?? []), e]);
    }
    for (const e of selected) {
      const original = byKey.get(e.key);
      if (!original || !eligible(original) || e.text !== original.text || groupOf(e) !== groupOf(original)
        || e.metadata?.partition !== candidateSourcePartition(groupOf(e), snapshot.seed)
        || (corpus === 'memory' && (e.metadata?.sourceSession !== original.metadata?.sourceSession
          || e.metadata?.sourceAttribution !== original.metadata?.sourceAttribution))) throw new Error('source census selected content/provenance mismatch');
    }
    const selectedGroups = new Set(selected.map(groupOf));
    const bundles = (queries: HeldoutQuery[]) => {
      if (new Set(queries.map((q) => q.id)).size !== queries.length) throw new Error('source census duplicate question');
      const result = new Map<string, HeldoutQuery[]>();
      for (const q of queries) {
        if (!selectedGroups.has(q.group) || q.partition !== candidateSourcePartition(q.group, snapshot.seed)) throw new Error('source census foreign question/partition');
        result.set(q.group, [...(result.get(q.group) ?? []), q]);
      }
      for (const qs of result.values()) {
        if (qs.length !== 4 || classes.some((cls) => qs.filter((q) => q.class === cls).length !== 1)) throw new Error('source census unbalanced bundle');
      }
      return result;
    };
    const authoredGroups = bundles(authored[corpus]), acceptedGroups = bundles(accepted[corpus]);
    const authoredById = new Map(authored[corpus].map((q) => [q.id, q]));
    const selectedByKey = new Map(selected.map((e) => [e.key, e]));
    for (const q of accepted[corpus]) {
      const original = authoredById.get(q.id);
      if (!original || ['class', 'query', 'group', 'partition'].some((k) => q[k as keyof HeldoutQuery] !== original[k as keyof HeldoutQuery])
        || new Set(q.expected).size !== q.expected.length || (q.class === 'hard-negative') !== (q.expected.length === 0)
        || q.expected.some((key) => !selectedByKey.has(key) || selectedByKey.get(key)!.metadata?.partition !== q.partition)
        || (q.class !== 'hard-negative' && !q.expected.some((key) => groupOf(selectedByKey.get(key)!) === q.group))) throw new Error('source census accepted label identity mismatch');
    }
    const dispositions = [...groups.keys()].sort().map((group) => ({ group,
      partition: candidateSourcePartition(group, snapshot.seed),
      status: !selectedGroups.has(group) ? 'outside-snapshot' : !authoredGroups.has(group) ? 'unattempted-in-snapshot'
        : !acceptedGroups.has(group) ? 'authored-without-accepted-labels' : 'accepted',
      populationRows: groups.get(group)!.length, snapshotRows: selected.filter((e) => groupOf(e) === group).length,
    }));
    const partitions = Object.fromEntries((['calibration', 'test'] as const).map((partition) => {
      const rows = dispositions.filter((r) => r.partition === partition);
      return [partition, { accessibleSources: rows.length, snapshotSources: rows.filter((r) => r.snapshotRows > 0).length,
        authoredSources: rows.filter((r) => authoredGroups.has(r.group)).length,
        acceptedSources: rows.filter((r) => r.status === 'accepted').length,
        outsideSnapshot: rows.filter((r) => r.status === 'outside-snapshot').length,
        unattemptedInSnapshot: rows.filter((r) => r.status === 'unattempted-in-snapshot').length,
        authoredWithoutAcceptedLabels: rows.filter((r) => r.status === 'authored-without-accepted-labels').length }];
    }));
    return [corpus, { populationRows: population.length, eligibleRows: [...groups.values()].reduce((n, es) => n + es.length, 0),
      provenanceExcludedRows: population.filter((e) => !eligible(e)).length, snapshotRows: selected.length, partitions, dispositions,
      allEligibleRowsInSnapshot: population.filter(eligible).every((e) => selectedByKey.has(e.key)),
      allEligibleSourcesAuthored: dispositions.length > 0 && dispositions.every((r) => authoredGroups.has(r.group)) }];
  })) as Record<'memory' | 'prose', {
    populationRows: number; eligibleRows: number; provenanceExcludedRows: number; snapshotRows: number;
    partitions: Record<'calibration' | 'test', { accessibleSources: number; snapshotSources: number; authoredSources: number;
      acceptedSources: number; outsideSnapshot: number; unattemptedInSnapshot: number; authoredWithoutAcceptedLabels: number }>;
    dispositions: { group: string; partition: 'calibration' | 'test'; status: string; populationRows: number; snapshotRows: number }[];
    allEligibleRowsInSnapshot: boolean; allEligibleSourcesAuthored: boolean;
  }>;
}
export function validateHeldout(entries: CorpusEntry[], queries: HeldoutQuery[]): void {
  const keys = new Set(entries.map((e) => e.key));
  if (keys.size !== entries.length || keys.size === 0) throw new Error('empty or duplicate corpus keys');
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  for (const q of queries) {
    if (ids.has(q.id)) throw new Error('duplicate query id');
    ids.add(q.id);
    if (!q.query.trim() || !q.group) throw new Error('missing query text or group');
    if (q.partition !== 'test' && q.partition !== 'calibration') throw new Error('invalid partition');
    if (groups.has(q.group) && groups.get(q.group) !== q.partition) throw new Error('target group leaks across partitions');
    groups.set(q.group, q.partition);
    if (q.expected.some((key) => !keys.has(key))) throw new Error('gold key absent from frozen corpus');
    if ((q.class === 'hard-negative') !== (q.expected.length === 0)) throw new Error('negative label disagrees with expected keys');
  }
  if (!queries.some((q) => q.partition === 'calibration') || !queries.some((q) => q.partition === 'test')) {
    throw new Error('both independent partitions required');
  }
}

export function calibratedFloor(rows: Array<{ partition: string; expected: string[]; topScore: number }>): number {
  const calibration = rows.filter((r) => r.partition === 'calibration');
  const positives = calibration.filter((r) => r.expected.length > 0);
  const negatives = calibration.filter((r) => r.expected.length === 0);
  if (!positives.length || !negatives.length) throw new Error('calibration needs positive and negative queries');
  let best = -1; let floor = 0;
  for (let i = 0; i <= 100; i++) {
    const value = i / 100;
    const balanced = (positives.filter((r) => r.topScore >= value).length / positives.length
      + negatives.filter((r) => r.topScore < value).length / negatives.length) / 2;
    if (balanced > best) { best = balanced; floor = value; }
  }
  return floor;
}

export async function takeCandidateSnapshot(file: string, options: CandidateSnapshotOptions = {}): Promise<Snapshot> {
  const seed = options.seed ?? 'mdenseon-heldout-2026-10-01';
  const outputs = [file, ...(options.censusOut ? [options.censusOut] : [])].map((f) => path.resolve(f));
  if (new Set(outputs).size !== outputs.length || outputs.some((f) => fs.existsSync(f))) throw new Error('snapshot/census output already exists or aliases');
  // Refuse invalid budgets before opening a live database connection.
  selectCandidateSources({ memory: { entries: [] }, prose: { entries: [] } }, options);
  const db = new Client({ connectionString: getHarnessAdminUrl() });
  await db.connect();
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const time = await db.query('SELECT now() AS snapshot_at');
    // Exclude this evaluation's own new memories and synthetic bench scopes.
    const memories = await db.query(`SELECT id, payload->>'data' AS text,
      COALESCE(payload->>'source_session',payload->'metadata'->>'source_session') AS source_session
      FROM harness_shared.memory_canonical WHERE row_kind='memory'
      AND payload->>'user_id'='harness:papercusp' AND invalid_at IS NULL
      AND length(payload->>'data') BETWEEN 100 AND 1600 AND created_at < '2026-09-30T22:18:00Z'
      ORDER BY id`);
    const rows = await db.query(`SELECT source_key, slug, anchor, title, content
      FROM harness_shared.doc_sections WHERE source_key LIKE 'papercusp%'
      AND length(content) BETWEEN 100 AND 2000 ORDER BY source_key, slug, anchor`);
    const docs: CorpusEntry[] = rows.rows.map((row) => ({ key: `doc:${row.source_key}:${row.slug}:${row.anchor}`,
        text: `${row.title ?? ''}\n${row.content}`.slice(0, 2000), kind: 'doc',
        metadata: { cluster: `${row.source_key} ${row.slug}` }, description: row.title ?? undefined }));
    await db.query('COMMIT');
    const population: Snapshot['suites'] = { memory: { entries: memories.rows.map(candidateMemoryEntry) }, prose: { entries: docs } };
    const snapshot: Snapshot = { formatVersion: 1, snapshotAt: time.rows[0].snapshot_at.toISOString(), seed,
      suites: selectCandidateSources(population, options) };
    if (options.censusOut) {
      const census = { formatVersion: 1, snapshotAt: snapshot.snapshotAt, seed,
        selection: { memoryLimit: options.memoryLimit ?? 48, proseBudget: options.proseBudget ?? 48, maxClusterRows: options.maxClusterRows ?? 4,
          requireMemorySource: options.requireMemorySource ?? false },
        eligibility: { memory: "active harness:papercusp memory, 100..1600 chars, created before 2026-09-30T22:18:00Z",
          prose: "papercusp% documentation source, 100..2000 content chars; rendered text capped at 2000" },
        // Full private source bytes allow later power expansion without re-reading a changing live corpus.
        population, excludedMemory: options.requireMemorySource ? population.memory.entries
          .filter((e) => e.metadata?.sourceAttribution !== 'session').map((e) => ({ key: e.key, reason: 'unknown-source-provenance' })) : [],
        selectedKeys: { memory: snapshot.suites.memory.entries.map((e) => e.key), prose: snapshot.suites.prose.entries.map((e) => e.key) } };
      fs.mkdirSync(path.dirname(options.censusOut), { recursive: true });
      fs.writeFileSync(options.censusOut, JSON.stringify(census, null, 2), { flag: 'wx', mode: 0o600 });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
    return snapshot;
  } finally { await db.end(); }
}

/** Adapt the actual SQL store to its neutral retrieval seam. The benchmark
 * supplies vectors explicitly, so extraction-client availability cannot turn
 * a successfully seeded canonical store into an unrelated mem0 outage. */
export function canonicalCandidateBackend(store: Pick<CanonicalVectorStore, 'search' | 'lexicalSearch'>): MemoryBackend {
  const map = (rows: Array<{ id: string; payload: Record<string, unknown>; score?: number }>): MemoryEntry[] =>
    rows.map((row) => ({ id: row.id, text: String(row.payload.data ?? ''), scope: String(row.payload.user_id ?? ''),
      kind: String(row.payload.kind ?? 'fact'), score: row.score,
      metadata: row.payload.metadata as Record<string, unknown> }));
  const unsupported = async (): Promise<never> => { throw new Error('candidate adapter supports precomputed retrieval only'); };
  return { name: 'canonical-candidate', scoreScale: 'cosine', lexicalScoreScale: 'lexical',
    available: async () => ({ ok: true }),
    search: async (_query, opts) => {
      if (!opts.vector || opts.scope !== 'bench') throw new Error('candidate search requires vector and isolated bench scope');
      return applyScoreFloor(map(await store.search(opts.vector, opts.limit ?? 10, { user_id: 'bench' })),
        { minScore: opts.minScore, minScoreRatio: opts.minScoreRatio });
    },
    searchLexical: async (query, opts) => {
      if (opts.scope !== 'bench') throw new Error('candidate lexical search requires isolated bench scope');
      return map(await store.lexicalSearch(query, opts.limit ?? 10, { user_id: 'bench' }));
    },
    remember: unsupported, list: unsupported, get: unsupported, forget: unsupported, update: unsupported,
  };
}

export async function runCandidateHybrid(opts: { snapshot: string; gold: string; model: 'mdenseon' | 'gemma' | 'harrier';
  modelDirectory?: string; corpus: 'memory' | 'prose'; out: string;
  manifest?: string; manifestSha256?: string; cell?: string }) {
  const prepared = opts.manifest ? await prepareMeasurementCell(opts.manifest, opts.manifestSha256 ?? '', opts.cell ?? '') : undefined;
  try {
  if (prepared) {
    if (prepared.cell.bar !== 'hybrid' || prepared.cell.corpus !== opts.corpus
      || prepared.cell.parameters.route !== 'canonical-lexical-hybrid') throw new Error('runner/cell retrieval route mismatch (entity/decay complete route is a separate measurement)');
    const dataset = prepared.manifest.datasets.find((d) => d.corpus === opts.corpus)!;
    if (path.resolve(opts.snapshot) !== path.resolve(prepared.manifest.inputs[dataset.snapshot].path)
      || path.resolve(opts.gold) !== path.resolve(prepared.manifest.inputs[dataset.labels].path)
      || path.resolve(opts.out) !== prepared.rawOutput) throw new Error('runner input/output differs from declared cell');
    await assertCandidateArm(prepared.arm, opts.model, 'worker');
    if (opts.model === 'mdenseon' && path.resolve(opts.modelDirectory ?? '', 'onnx/model.onnx') !== path.resolve(prepared.arm.artifacts.graph.path)) throw new Error('runner graph directory identity mismatch');
  }
  const snapshot = JSON.parse(fs.readFileSync(opts.snapshot, 'utf8')) as Snapshot;
  const labels = JSON.parse(fs.readFileSync(opts.gold, 'utf8')) as Record<'memory' | 'prose', HeldoutQuery[]>;
  const entries = snapshot.suites[opts.corpus].entries;
  const queries = labels[opts.corpus];
  validateHeldout(entries, queries);
  const profile = candidateProfile(opts.model);
  const build = (kind: 'document' | 'query') => opts.model === 'mdenseon'
    ? buildMdenseOnEmbedder({ kind, model: opts.modelDirectory! })
    : opts.model === 'gemma' ? buildGemmaEmbedder({ kind, dims: 768 }) : buildHarrierEmbedder({ kind });
  if (opts.model === 'mdenseon' && !opts.modelDirectory) throw new Error('mDenseOn requires its validated local model');
  const doc = build('document'); const query = build('query');
  const schema = `bench_memory_${process.pid}`;
  const admin = new URL(getHarnessAdminUrl());
  const db = new Client({ connectionString: admin.href });
  await db.connect();
  let store: CanonicalVectorStore | undefined;
  try {
    await ensureBenchSchema(db, schema);
    // Reuse a physical layout ONLY in this candidate-owned schema. Its explicit
    // accepted profile remains mDenseOn; equal width never aliases it to Gemma.
    const layout = opts.model === 'harrier' ? MEMORY_VECTOR_STORAGE_PROFILES.harrier : MEMORY_VECTOR_STORAGE_PROFILES.gemma;
    const storage: MemoryVectorStorageProfile = { ...layout, acceptedProfileIds: [profile.profileId] };
    store = new CanonicalVectorStore({ host: admin.hostname, port: Number(admin.port), user: decodeURIComponent(admin.username),
      password: decodeURIComponent(admin.password), dbname: admin.pathname.slice(1), schema,
      vecTable: storage.table, embeddingModelDims: profile.targetDims, embeddingProfile: profile, storageProfile: storage });
    const cosine = canonicalCandidateBackend(store);
    const hybrid = new HybridBackend(new LexicalLegBackend(cosine), cosine, { name: 'hybrid-pg' });
    // Exercise the complete real SQL/fusion route on the empty owned schema
    // before paying for inference; infrastructure failures must not score as a loss.
    const preflightVector = new Array(profile.targetDims).fill(0); preflightVector[0] = 1;
    await hybrid.search('preflight', { scope: 'bench', limit: 1, vector: preflightVector });
    const vectors: number[][] = [];
    const started = performance.now();
    for (const entry of entries) vectors.push(await doc(entry.text));
    const documentMs = performance.now() - started;
    const ids = entries.map((e) => {
      const hash = crypto.createHash('sha256').update(e.key).digest('hex').slice(0, 32);
      return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
    });
    await store.insert(vectors, ids, entries.map((e) => ({ data: e.text, name: e.description ?? e.key,
      user_id: 'bench', metadata: { ...e.metadata, corpus_key: e.key }, createdAt: new Date().toISOString() })));
    const embedded = [];
    for (const q of queries) {
      const t0 = performance.now(); const vector = await query(q.query); const embeddingMs = performance.now() - t0;
      const raw = await store.search(vector, 10, { user_id: 'bench' });
      embedded.push({ ...q, vector, embeddingMs, topScore: raw[0]?.score ?? 0 });
    }
    if (prepared) assertMeasuredExecution(prepared.arm, embedExecutionTarget(), ORT_SESSION_OPTIONS, getWorkerState());
    const floor = calibratedFloor(embedded);
    const rows = [];
    for (const q of embedded.filter((q) => q.partition === 'test')) {
      const t0 = performance.now();
      const hits = await hybrid.search(q.query, { scope: 'bench', limit: 10, vector: q.vector,
        minScore: floor, minLexScore: 0.04, fusionMode: 'floored-union' });
      const unfloored = await hybrid.search(q.query, { scope: 'bench', limit: 10, vector: q.vector,
        minScore: 0, minLexScore: 0.04, fusionMode: 'floored-union' });
      const keys = hits.map((h) => String(h.metadata?.corpus_key ?? h.id));
      const rawKeys = unfloored.map((h) => String(h.metadata?.corpus_key ?? h.id));
      rows.push({ id: q.id, class: q.class, expected: q.expected, rankedKeys: keys, rawRankedKeys: rawKeys,
        reciprocalRank: reciprocalRank(q.expected, keys), rawReciprocalRank: reciprocalRank(q.expected, rawKeys),
        rawHits: hits.length, embeddingMs: q.embeddingMs, sqlAndFusionMs: (performance.now() - t0) / 2 });
    }
    const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const report = { model: opts.model, profile, storage: { schema, ...storage }, corpus: opts.corpus,
      snapshotAt: snapshot.snapshotAt, snapshotSha256: hash(opts.snapshot), goldSha256: hash(opts.gold),
      documents: entries.length, calibrationQueries: embedded.filter((q) => q.partition === 'calibration').length,
      calibratedCosineFloor: floor, lexicalFloor: 0.04, documentMs, worker: getWorkerState(), rows,
      limitations: ['small structurally sampled corpus', 'agent-authored labels frozen before inference',
        'calibration and test split by source target', 'SQL timing uses precomputed vectors and averages two fusion calls',
        'neutral adapter excludes extraction, entity graph and decay; production canonical SQL, lexical and hybrid fusion retained'] };
    if (prepared) writeMeasurementCell(prepared, report);
    else {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify({ model: opts.model, corpus: opts.corpus, docs: entries.length, heldout: rows.length, floor, out: opts.out }));
    return report;
  } finally {
    await store?.dispose();
    await releaseBenchSchema(db, schema);
    await db.end();
    await shutdownLocalEmbedder();
  }
  } catch (error) {
    if (prepared) failMeasurementCell(prepared, error);
    throw error;
  }
}

if (isCliEntry(import.meta.url)) {
  const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const run = process.argv.includes('--snapshot-out') ? takeCandidateSnapshot(arg('--snapshot-out'), {
    ...(process.argv.includes('--seed') ? { seed: arg('--seed') } : {}),
    ...(process.argv.includes('--memory-limit') ? { memoryLimit: Number(arg('--memory-limit')) } : {}),
    ...(process.argv.includes('--prose-budget') ? { proseBudget: Number(arg('--prose-budget')) } : {}),
    ...(process.argv.includes('--max-cluster-rows') ? { maxClusterRows: Number(arg('--max-cluster-rows')) } : {}),
    ...(process.argv.includes('--census-out') ? { censusOut: arg('--census-out') } : {}),
    requireMemorySource: process.argv.includes('--require-memory-source'),
  })
    : runCandidateHybrid({ snapshot: arg('--snapshot'), gold: arg('--gold'), model: arg('--model') as 'mdenseon',
      modelDirectory: arg('--mdenseon-model'), corpus: arg('--corpus') as 'memory', out: arg('--out'),
      manifest: process.argv.includes('--manifest') ? arg('--manifest') : undefined,
      manifestSha256: process.argv.includes('--manifest-sha256') ? arg('--manifest-sha256') : undefined,
      cell: process.argv.includes('--cell') ? arg('--cell') : undefined });
  void run.then(() => process.exit(0)).catch((e) => {
    console.error(e instanceof Error ? e.message : e); process.exit(1);
  });
}
