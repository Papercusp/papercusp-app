/** Frozen contracts shared by the existing candidate SQL and embedder runners.
 * Raw corpora/requests stay private; only bounded, hash-addressed receipts ship.
 * A guard passing qualifies the harness, never the model or measured population. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateEmbedderProfile, EMBEDDER_DIM_SPECS, CANDIDATE_DIM_SPECS, MDENSEON_REVISION,
  gemmaPrompt, harrierPrompt, mdenseOnPrompt, embedRequestedExecution,
  type EmbedderProfileSpec, type SidecarEmbedResponse } from '@papercusp/memory';
import { ORT_SESSION_OPTIONS, validNativeRuntimeSample, type WorkerNativeInferenceTrace }
  from '../../../../../libs/generic/memory/src/local-embedder-worker';
import type { CorpusEntry, GoldQuery } from '@papercusp/memory/bench';

export const MEASUREMENT_BARS = ['relevance', 'reference', 'hybrid', 'performance', 'boundaries', 'reliability', 'answers'] as const;
export const MEASUREMENT_CLASSES = ['exact-identifier', 'lexical-gap', 'session-start-intent', 'hard-negative'] as const;
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const fingerprint = z.strictObject({ path: z.string().min(1), sha256: sha, bytes: z.number().int().nonnegative() });
const profile = z.custom<EmbedderProfileSpec>((value) => {
  try { return validateEmbedderProfile('measurement', value as EmbedderProfileSpec).length === 0; }
  catch { return false; }
}, 'invalid embedding profile');
const armSchema = z.strictObject({
  id, model: z.enum(['mdenseon', 'gemma', 'harrier', 'gemma-corrected']), profile,
  // modelRev is the HTTP wire identity; artifactRevision pins vendor/local bytes.
  modelRev: z.string().min(1), artifactRevision: z.string().min(1),
  artifacts: z.strictObject({ graph: fingerprint, tokenizer: fingerprint, config: fingerprint,
    weightLayout: z.enum(['inline', 'external']), weights: z.array(fingerprint) }),
  prompts: z.strictObject({ query: z.string(), document: z.string() }),
  tokenizer: z.strictObject({ backend: z.string().min(1), version: z.string().min(1) }),
  runtime: z.strictObject({ name: z.string().min(1), version: z.string().min(1), wire: z.string().min(1), source: fingerprint }),
  execution: z.strictObject({ device: z.enum(['cpu', 'cuda']), dtype: z.literal('fp32'),
    intraOpThreads: z.number().int().positive(), interOpThreads: z.number().int().positive(),
    transport: z.enum(['worker', 'local-http-client-worker', 'python-reference']), cache: z.literal('bypass') }),
});

export const measurementManifestSchema = z.strictObject({
  formatVersion: z.literal(1), plan: z.literal('mdenseon-adoption-measurements-2026-10-01'),
  runId: id, ownerId: z.string().min(1), frozenAt: date, seed: z.string().min(1),
  // Provenance anchor; exact loaded bytes are the declared file fingerprints.
  // Unrelated shared-tree git-sync commits must not invalidate a pinned recipe.
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  privateRoot: z.string().min(1), evidencePath: z.string().startsWith('docs/evidence/'),
  contracts: z.strictObject({
    labels: z.literal('independent-blind-before-inference'), sourceSplit: z.literal('source-target'),
    classes: z.tuple([z.literal('exact-identifier'), z.literal('lexical-gap'), z.literal('session-start-intent'), z.literal('hard-negative')]),
    mrrMargin: z.literal(0.03), stop: z.literal('margin-resolved-or-censused-population-exhausted'),
    cosineMin: z.literal(0.99999), maxAbs: z.literal(0.00003), freshProcessBlocks: z.number().int().min(5),
  }),
  inputs: z.record(id, fingerprint), arms: z.array(armSchema).min(3),
  datasets: z.array(z.strictObject({
    corpus: z.enum(['memory', 'prose']), snapshot: id, labels: id, judgments: id, census: id,
    keys: z.array(z.string().min(1)).min(1), queryIds: z.array(z.string().min(1)).min(1),
  })),
  cells: z.array(z.strictObject({
    id, bar: z.enum(MEASUREMENT_BARS), armId: id, inputIds: z.array(id).min(1),
    corpus: z.enum(['memory', 'prose']).optional(),
    parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])),
    output: id,
  })).min(7),
});
export type MeasurementManifest = z.infer<typeof measurementManifestSchema>;
export type MeasurementArm = MeasurementManifest['arms'][number];
export type MeasurementCell = MeasurementManifest['cells'][number];
export const FROZEN_MEASUREMENT_CONTRACTS: MeasurementManifest['contracts'] = {
  labels: 'independent-blind-before-inference', sourceSplit: 'source-target', classes: [...MEASUREMENT_CLASSES],
  mrrMargin: 0.03, stop: 'margin-resolved-or-censused-population-exhausted',
  cosineMin: 0.99999, maxAbs: 0.00003, freshProcessBlocks: 5,
};

/** Streaming avoids holding another multi-GB model beside loaded weights. */
export async function fingerprintFile(file: string): Promise<z.infer<typeof fingerprint>> {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { bytes += chunk.length; hash.update(chunk); }
  return { path: file, sha256: hash.digest('hex'), bytes };
}
export function hashJson(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function measurementPackageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  // Literal loader targets keep the benchmark's import closure inspectable.
  const entry = name === '@huggingface/transformers' ? require.resolve('@huggingface/transformers')
    : name === '@huggingface/tokenizers' ? require.resolve('@huggingface/tokenizers')
    : name === 'tokenizers' ? require.resolve('tokenizers')
    // Resolve (never import) the native addon: a literal import() would put onnxruntime-node in
    // operator-core's bare-import closure, which the desktop sidecar-union test requires every
    // operator-core manifest to declare (WI-10005359).
    : name === 'onnxruntime-node' ? require.resolve('onnxruntime-node') : undefined;
  if (!entry) throw new Error(`undeclared benchmark runtime package ${name}`);
  let dir = path.dirname(entry);
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if (p.name === name) return p.version; }
    const next = path.dirname(dir); if (next === dir) throw new Error(`cannot identify runtime package ${name}`); dir = next;
  }
}
export function measurementOwner(): string { return process.env.PAPERCUSP_SID ?? `local-process-${process.pid}`; }
export function candidateProfile(model: 'mdenseon' | 'gemma' | 'harrier'): EmbedderProfileSpec {
  if (model !== 'mdenseon') return EMBEDDER_DIM_SPECS[model];
  return { ...CANDIDATE_DIM_SPECS.mdenseon, profileId: 'mdenseon-a5fdb000-768@v1', modelRevision: MDENSEON_REVISION,
    revisionPolicy: 'immutable-artifact', distanceMetric: 'cosine', pooling: 'cls',
    normalization: { kind: 'l2', timing: 'pipeline' }, outputDtype: 'float32',
    documentRecipe: 'mdenseon-document-prefix@v1', queryRecipe: 'mdenseon-query-prefix@v1' };
}
/** Identifies the shipped builders/worker before model construction. Shared
 * here so the self-contained embedder evaluator does not import PG host wiring. */
export async function assertCandidateArm(arm: MeasurementArm, model: 'mdenseon' | 'gemma' | 'harrier',
  transport: 'worker' | 'local-http-client-worker', httpRuntime?: string): Promise<void> {
  const prompt = model === 'mdenseon' ? mdenseOnPrompt : model === 'gemma' ? gemmaPrompt : harrierPrompt;
  if (arm.model !== model) throw new Error('runner/model identity mismatch');
  assertMeasurementArm(arm, { profile: candidateProfile(model), prompts: { query: prompt('query', ''), document: prompt('document', '') },
    tokenizer: { backend: model === 'mdenseon' ? 'rust' : 'transformers-js',
      version: measurementPackageVersion(model === 'mdenseon' ? 'tokenizers' : '@huggingface/tokenizers') },
    execution: { device: embedRequestedExecution().device, dtype: 'fp32', transport, cache: 'bypass',
      intraOpThreads: ORT_SESSION_OPTIONS.intraOpNumThreads, interOpThreads: ORT_SESSION_OPTIONS.interOpNumThreads } });
  const source = await fingerprintFile(fileURLToPath(new URL('../../../../../libs/generic/memory/src/local-embedder-worker.script.mjs', import.meta.url)));
  if (arm.runtime.name !== 'transformers-js-worker' || arm.runtime.version !== measurementPackageVersion('@huggingface/transformers')
    || arm.runtime.wire !== (transport === 'worker' ? 'worker-in-process' : httpRuntime)
    || source.sha256 !== arm.runtime.source.sha256 || source.bytes !== arm.runtime.source.bytes) throw new Error('actual worker/runtime identity mismatch');
}
function unique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}
export function validateMeasurementManifest(value: unknown): MeasurementManifest {
  const m = measurementManifestSchema.parse(value);
  unique(m.arms.map((a) => a.id), 'arm'); unique(m.cells.map((c) => c.id), 'cell');
  unique(m.cells.map((c) => c.output), 'output'); unique(m.datasets.map((d) => d.corpus), 'dataset');
  for (const model of ['mdenseon', 'gemma', 'harrier']) {
    if (!m.arms.some((a) => a.model === model)) throw new Error(`missing incumbent/candidate ${model}`);
  }
  for (const bar of MEASUREMENT_BARS) if (!m.cells.some((c) => c.bar === bar)) throw new Error(`missing promised bar ${bar}`);
  for (const arm of m.arms) {
    if ((arm.artifacts.weightLayout === 'external') !== (arm.artifacts.weights.length > 0)) throw new Error('external/inline weight identity mismatch');
    unique(arm.artifacts.weights.map((f) => f.path), 'weight file');
    if (arm.profile.targetDims !== arm.profile.nativeDims) throw new Error('adoption measurements require native dimensions');
    if (arm.model === 'gemma-corrected' && m.arms.some((a) => a.model === 'gemma' && a.profile.profileId === arm.profile.profileId)) {
      throw new Error('corrected Gemma must have a separate recipe/profile identity');
    }
  }
  for (const d of m.datasets) {
    unique(d.keys, 'corpus key'); unique(d.queryIds, 'query id');
    for (const ref of [d.snapshot, d.labels, d.judgments, d.census]) if (!m.inputs[ref]) throw new Error(`missing dataset input ${ref}`);
  }
  for (const cell of m.cells) {
    if (!m.arms.some((a) => a.id === cell.armId)) throw new Error(`unknown arm ${cell.armId}`);
    unique(cell.inputIds, 'cell input');
    for (const ref of cell.inputIds) if (!m.inputs[ref]) throw new Error(`unknown input ${ref}`);
    if (['relevance', 'hybrid', 'answers'].includes(cell.bar) && !m.datasets.some((d) => d.corpus === cell.corpus)) {
      throw new Error(`missing independent dataset for ${cell.id}`);
    }
  }
  return m;
}

interface FrozenEntry { key: string; metadata?: Record<string, unknown> }
interface FrozenQuery { id: string; class: string; query: string; group: string; partition: string; expected: string[] }
/** Check ACTUAL source clusters, not the query author's self-reported group. */
export function validateIndependentCohort(entries: FrozenEntry[], queries: FrozenQuery[], receipt: unknown,
  snapshotSha256: string, labelsSha256: string, frozenAt: string): void {
  const proof = z.strictObject({
    formatVersion: z.literal(1), authority: z.literal('independent-blind-transport'),
    candidateRankingsExposed: z.literal(false), frozenAt: date, snapshotSha256: sha, labelsSha256: sha,
    judges: z.array(z.strictObject({ model: z.string().trim().min(1), revision: z.string().trim().min(1),
      transport: z.string().trim().min(1), promptSha256: sha, raw: fingerprint })).min(2),
    queryIds: z.array(z.string()), ambiguous: z.array(z.string()), excluded: z.array(z.string()),
    formatAbstentions: z.array(z.strictObject({ queryId: z.string().min(1), pass: z.number().int().min(1).max(2),
      documentIndices: z.array(z.number().int().nonnegative()).min(1) })).optional(),
    agreement: z.number().min(0).max(1),
  }).parse(receipt);
  for (const abstention of proof.formatAbstentions ?? []) {
    if (proof.queryIds.includes(abstention.queryId) || !proof.ambiguous.includes(abstention.queryId)
      || !proof.excluded.includes(abstention.queryId)) throw new Error('malformed abstention must be excluded from scored queries');
  }
  // Two array entries cannot stand in for two independently transported calls.
  unique(proof.judges.map((j) => j.transport), 'judge transport');
  unique(proof.judges.map((j) => path.resolve(j.raw.path)), 'judge raw artifact');
  if (proof.snapshotSha256 !== snapshotSha256 || proof.labelsSha256 !== labelsSha256 || proof.frozenAt > frozenAt) {
    throw new Error('label receipt fingerprint/time mismatch');
  }
  unique(entries.map((e) => e.key), 'corpus key'); unique(queries.map((q) => q.id), 'query id');
  if (JSON.stringify(proof.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('judged query order mismatch');
  const sources = new Map(entries.map((e) => [e.key, String(e.metadata?.cluster ?? '')]));
  if ([...sources.values()].some((s) => !s)) throw new Error('missing actual source cluster');
  const partitions = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const q of queries) {
    if (!MEASUREMENT_CLASSES.includes(q.class as typeof MEASUREMENT_CLASSES[number]) || !['calibration', 'test'].includes(q.partition)
      || !q.query.trim() || !q.group || !Array.isArray(q.expected)) throw new Error('invalid independent query');
    if ((q.class === 'hard-negative') !== (q.expected.length === 0)) throw new Error('contradictory negative label');
    const groups = new Set([q.group]);
    for (const key of q.expected) {
      if (!sources.has(key)) throw new Error('gold key absent from frozen corpus');
      groups.add(sources.get(key)!);
    }
    for (const group of groups) {
      if (partitions.has(group) && partitions.get(group) !== q.partition) throw new Error('actual source target leaks across partitions');
      partitions.set(group, q.partition);
    }
    const key = `${q.partition}:${q.class}`; counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const partition of ['calibration', 'test']) {
    const ns = MEASUREMENT_CLASSES.map((c) => counts.get(`${partition}:${c}`) ?? 0);
    if (ns.some((n) => n === 0) || new Set(ns).size !== 1) throw new Error(`unbalanced/missing ${partition} query class`);
  }
}

/** Resolve through existing ancestors, including symlinks, before containment checks. */
export function realDestination(file: string): string {
  const tail: string[] = []; let parent = path.resolve(file);
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent);
    if (next === parent) throw new Error('unresolvable output root'); parent = next; }
  return path.join(fs.realpathSync(parent), ...tail);
}
function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file); return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function measurementOutputPaths(m: MeasurementManifest, cell: MeasurementCell, repoRoot: string): { raw: string; summary: string } {
  const repo = fs.realpathSync(repoRoot); const privateRoot = realDestination(m.privateRoot);
  if (!path.isAbsolute(m.privateRoot) || privateRoot === repo || inside(repo, privateRoot)) throw new Error('raw evidence root must be private, outside repository');
  const summary = realDestination(path.resolve(repo, m.evidencePath));
  const evidenceRoot = path.join(repo, 'docs/evidence');
  if (!inside(evidenceRoot, summary) || !inside(repo, realDestination(evidenceRoot))) throw new Error('summary escapes tracked docs/evidence');
  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', path.relative(repo, summary)], { cwd: repo });
  if (ignored.status !== 1) throw new Error('summary is ignored or Git eligibility could not be verified');
  const raw = realDestination(path.join(privateRoot, m.runId, `${cell.output}.json`));
  if (!inside(privateRoot, raw)) throw new Error('output escapes private root');
  if (fs.existsSync(raw)) throw new Error('immutable cell output already exists; use a new run id for replay');
  if (fs.existsSync(`${raw}.running`) || fs.existsSync(`${raw}.failure.json`)) throw new Error('cell attempt already owned/failed; replay with a new run id');
  return { raw, summary };
}

export interface PreparedMeasurement { manifest: MeasurementManifest; manifestSha256: string; cell: MeasurementCell; arm: MeasurementArm; rawOutput: string; claimPath: string }
/** The relevance runner consumes the independently judged files, never the
 * legacy pilot fixtures. Recheck the bytes at load time to reject replacement
 * between preparation and scoring. Versions bind cross-run comparisons to both
 * the corpus and labels, including their exact order. */
export function loadIndependentMeasurementInputs(prepared: PreparedMeasurement, corpus: 'memory' | 'prose'): {
  entries: CorpusEntry[]; queries: Array<GoldQuery & { group: string; partition: string }>;
  corpusVersion: string; goldVersion: string;
} {
  const { manifest, cell } = prepared;
  if (cell.bar !== 'relevance' || cell.corpus !== corpus) throw new Error('independent relevance corpus/cell mismatch');
  const dataset = manifest.datasets.find((d) => d.corpus === corpus);
  if (!dataset) throw new Error('missing independent relevance dataset');
  const read = (ref: string): unknown => {
    const declared = manifest.inputs[ref];
    const bytes = fs.readFileSync(declared.path);
    if (bytes.length !== declared.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== declared.sha256) {
      throw new Error('independent relevance input changed after preparation');
    }
    return JSON.parse(bytes.toString('utf8'));
  };
  const snapshot = read(dataset.snapshot) as { suites: Record<string, { entries: CorpusEntry[] }> };
  const labels = read(dataset.labels) as Record<string, Array<GoldQuery & { group: string; partition: string }>>;
  const receipt = read(dataset.judgments) as Record<string, unknown>;
  const entries = snapshot.suites[corpus].entries, queries = labels[corpus];
  if (JSON.stringify(dataset.keys) !== JSON.stringify(entries.map((e) => e.key))
    || JSON.stringify(dataset.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('independent relevance order mismatch');
  validateIndependentCohort(entries, queries, receipt[corpus], manifest.inputs[dataset.snapshot].sha256,
    manifest.inputs[dataset.labels].sha256, manifest.frozenAt);
  return { entries, queries, corpusVersion: `independent-${manifest.inputs[dataset.snapshot].sha256}`,
    goldVersion: `independent-${manifest.inputs[dataset.labels].sha256}` };
}

/** Extend the existing raw/vector receipt format, not a second vector cache.
 * Reuse is explicitly frozen on a relevance cell with reuseCellId plus three
 * declared inputs: reuseManifest, reuseCompletion, reuseVectors. A cell may
 * select another declared vector input with reuseVectorsInput; the default
 * remains reuseVectors. Completion
 * binds vectors (which have no arm metadata themselves) to the measured arm.
 * New labels may change relevance, but a reused query's text/source may not. */
export async function loadRetainedRelevanceVectors(prepared: PreparedMeasurement, corpus: 'memory' | 'prose') {
  const donorId = prepared.cell.parameters.reuseCellId;
  const expansion = prepared.cell.parameters.reuseSnapshotExpansion;
  if (expansion !== undefined && expansion !== true && expansion !== false) throw new Error('invalid retained relevance snapshot expansion option');
  if (expansion && donorId === undefined) throw new Error('snapshot expansion requires declared retained relevance reuse');
  if (donorId === undefined) return undefined;
  if (typeof donorId !== 'string' || !donorId || prepared.cell.bar !== 'relevance'
    || prepared.cell.corpus !== corpus || prepared.arm.execution.transport !== 'worker') {
    throw new Error('invalid retained relevance reuse cell');
  }
  const readPinned = async (ref: z.infer<typeof fingerprint>) => {
    fingerprint.parse(ref);
    if (hashJson(await fingerprintFile(ref.path)) !== hashJson(ref)) throw new Error('retained relevance fingerprint mismatch');
    return JSON.parse(fs.readFileSync(ref.path, 'utf8'));
  };
  const vectorsInputId = prepared.cell.parameters.reuseVectorsInput === undefined
    ? 'reuseVectors' : prepared.cell.parameters.reuseVectorsInput;
  if (typeof vectorsInputId !== 'string' || !vectorsInputId.trim()) {
    throw new Error('invalid retained relevance vector input');
  }
  const refs = Object.fromEntries([
    ['reuseManifest', 'reuseManifest'], ['reuseCompletion', 'reuseCompletion'], ['reuseVectors', vectorsInputId],
  ].map(([role, name]) => {
    if (!prepared.cell.inputIds.includes(name) || !Object.hasOwn(prepared.manifest.inputs, name)) {
      throw new Error('retained relevance inputs must be declared on the cell');
    }
    return [role, prepared.manifest.inputs[name]];
  }));
  const donor = validateMeasurementManifest(await readPinned(refs.reuseManifest));
  const cell = donor.cells.find((c) => c.id === donorId), arm = donor.arms.find((a) => a.id === cell?.armId);
  if (!cell || cell.bar !== 'relevance' || cell.corpus !== corpus || !arm
    || donor.ownerId !== prepared.manifest.ownerId || hashJson(arm) !== hashJson(prepared.arm)) {
    throw new Error('retained relevance arm/corpus/owner mismatch');
  }
  const completion = await readPinned(refs.reuseCompletion);
  const completed = Array.isArray(completion.completed) ? completion.completed.filter((c: any) => c.cellId === donorId) : [];
  if (completion.formatVersion !== 1 || completion.status !== 'completed'
    || completion.ownerId !== donor.ownerId || completion.manifestSha256 !== refs.reuseManifest.sha256
    || !Number.isFinite(Date.parse(completion.completedAt))
    || Date.parse(completion.completedAt) > Date.parse(prepared.manifest.frozenAt)
    || completed.length !== 1 || hashJson(completed[0].vectors) !== hashJson(refs.reuseVectors)) {
    throw new Error('retained relevance completed receipt mismatch');
  }
  for (const inputId of cell.inputIds) {
    const ref = donor.inputs[inputId];
    if (hashJson(await fingerprintFile(ref.path)) !== hashJson(ref)) throw new Error('retained relevance donor input changed');
  }
  const oldDataset = donor.datasets.find((d) => d.corpus === corpus)!;
  const dataset = prepared.manifest.datasets.find((d) => d.corpus === corpus)!;
  const oldSnapshot = donor.inputs[oldDataset.snapshot], snapshot = prepared.manifest.inputs[dataset.snapshot];
  if (!expansion && (oldSnapshot.sha256 !== snapshot.sha256 || oldSnapshot.bytes !== snapshot.bytes)) {
    throw new Error('retained relevance snapshot changed');
  }
  if (expansion) {
    const before = await readPinned(oldSnapshot), after = await readPinned(snapshot);
    if (before.formatVersion !== 1 || after.formatVersion !== 1
      || typeof before.seed !== 'string' || !before.seed || before.seed !== after.seed
      || donor.seed !== prepared.manifest.seed
      || !Number.isFinite(Date.parse(before.snapshotAt)) || before.snapshotAt !== after.snapshotAt) {
      throw new Error('retained relevance snapshot expansion frozen identity mismatch');
    }
    const priorEntries = before.suites[corpus].entries as CorpusEntry[];
    const priorKeys = new Set(priorEntries.map((e) => e.key));
    const kept = (after.suites[corpus].entries as CorpusEntry[]).filter((e) => priorKeys.has(e.key));
    if (hashJson(kept) !== hashJson(priorEntries)) throw new Error('retained relevance snapshot expansion source content/provenance/order mismatch');
  }
  const previous = loadIndependentMeasurementInputs({ ...prepared, manifest: donor, cell, arm }, corpus);
  const current = loadIndependentMeasurementInputs(prepared, corpus);
  const raw = await readPinned(completed[0].raw);
  if (raw.formatVersion !== 1 || raw.manifestSha256 !== refs.reuseManifest.sha256
    || raw.cellId !== donorId || raw.armId !== arm.id || raw.ownerId !== donor.ownerId
    || !Number.isFinite(Date.parse(raw.measuredAt)) || Date.parse(raw.measuredAt) < Date.parse(donor.frozenAt)
    || Date.parse(raw.measuredAt) > Date.parse(completion.completedAt)
    || raw.report?.corpus !== corpus || raw.report?.corpusVersion !== previous.corpusVersion
    || raw.report?.goldSetVersion !== previous.goldVersion || !raw.report?.results?.[arm.model]
    || raw.report.labelAuthority !== 'independent-blind-before-inference' || raw.report.scoringPartition !== 'test'
    || raw.report.calibrationReportedSeparately !== true || raw.report.results[arm.model].dims !== arm.profile.nativeDims
    || raw.report.results[arm.model].blocked) throw new Error('retained relevance raw identity mismatch');
  const saved = await readPinned(refs.reuseVectors), vectors = saved.vectors?.[arm.model];
  if (saved.corpus !== corpus || saved.corpusVersion !== previous.corpusVersion
    || hashJson(saved.keys) !== hashJson(previous.entries.map((e) => e.key))
    || hashJson(saved.queryIds) !== hashJson(previous.queries.map((q) => q.id))
    || !vectors || Object.keys(saved.vectors).length !== 1
    || !Array.isArray(vectors.docVectors) || !Array.isArray(vectors.queryVectors)
    || vectors.docVectors.length !== previous.entries.length || vectors.queryVectors.length !== previous.queries.length
    || [...vectors.docVectors, ...vectors.queryVectors].some((v) => !Array.isArray(v)
      || v.length !== arm.profile.nativeDims || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))
      || Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) > 0.001)) {
    throw new Error('retained relevance vector population/order/normalization mismatch');
  }
  const oldIndexes = new Map(previous.queries.map((q, i) => [q.id, i]));
  const { documentVectors, missingDocumentIndexes } = alignRetainedRelevanceDocuments(previous.entries,
    current.entries, vectors.docVectors);
  const queryIdentity = (q: typeof current.queries[number]) => ({ id: q.id, query: q.query, class: q.class,
    group: q.group, partition: q.partition });
  const missingIndexes: number[] = [];
  const queryVectors = current.queries.map((q, index): number[] | undefined => {
    const oldIndex = oldIndexes.get(q.id);
    if (oldIndex === undefined) { missingIndexes.push(index); return undefined; }
    if (hashJson(queryIdentity(q)) !== hashJson(queryIdentity(previous.queries[oldIndex]))) {
      throw new Error('retained relevance query identity changed');
    }
    return vectors.queryVectors[oldIndex];
  });
  return { docVectors: vectors.docVectors as number[][], documentVectors, missingDocumentIndexes,
    queryVectors, missingIndexes, dimensions: arm.profile.nativeDims,
    documentTexts: current.entries.map((e) => e.text), queryTexts: current.queries.map((q) => q.query),
    evidence: { donorCellId: donorId, manifest: refs.reuseManifest, completion: refs.reuseCompletion,
      raw: completed[0].raw, vectors: refs.reuseVectors, vectorsInputId, documentsReused: vectors.docVectors.length,
      reusedQueryIds: current.queries.filter((_, i) => queryVectors[i] !== undefined).map((q) => q.id),
      newQueryIds: missingIndexes.map((i) => current.queries[i].id),
      newDocumentKeys: missingDocumentIndexes.map((i) => current.entries[i].key), snapshotExpansion: expansion === true,
      scope: 'embedding reuse only; independent new labels, scoring and source-power acceptance remain required',
      timingComparableToFullInference: false } };
}

/** Shared document-map preflight, also usable before new labels exist. This
 * only qualifies source/array alignment; the loader still requires independent
 * labels and the full owner/arm/completion/snapshot contract before scoring. */
export function alignRetainedRelevanceDocuments(previous: CorpusEntry[], current: CorpusEntry[], vectors: number[][]) {
  const indexes = new Map(previous.map((e, i) => [e.key, i]));
  if (indexes.size !== previous.length || new Set(current.map((e) => e.key)).size !== current.length
    || vectors.length !== previous.length
    || hashJson(current.filter((e) => indexes.has(e.key))) !== hashJson(previous)) {
    throw new Error('retained relevance document population/content/provenance/order mismatch');
  }
  const missingDocumentIndexes: number[] = [];
  const documentVectors = current.map((e, index): number[] | undefined => {
    const oldIndex = indexes.get(e.key);
    if (oldIndex === undefined) { missingDocumentIndexes.push(index); return undefined; }
    return vectors[oldIndex];
  });
  return { documentVectors, missingDocumentIndexes };
}

/** Merge both vector kinds through the same validated receipt and local index
 * map. The retained arrays stay immutable; only absent vectors are embedded. */
async function embedIncrementalRelevancePopulation(
  retained: NonNullable<Awaited<ReturnType<typeof loadRetainedRelevanceVectors>>>, texts: string[], kind: 'query' | 'document',
  embedMissing: (texts: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  const vectors = kind === 'query' ? retained.queryVectors : retained.documentVectors;
  const indexes = kind === 'query' ? retained.missingIndexes : retained.missingDocumentIndexes;
  const declaredTexts = kind === 'query' ? retained.queryTexts : retained.documentTexts;
  if (texts.length !== vectors.length) throw new Error(`incremental relevance ${kind} population mismatch`);
  if (hashJson(texts) !== hashJson(declaredTexts)) throw new Error(`incremental relevance ${kind} text identity mismatch`);
  if (hashJson(indexes) !== hashJson(vectors.flatMap((v, i) => v === undefined ? [i] : []))) {
    throw new Error(`incremental relevance ${kind} missing-index identity mismatch`);
  }
  const newVectors = indexes.length ? await embedMissing(indexes.map((i) => texts[i])) : [];
  if (newVectors.length !== indexes.length) throw new Error('incremental relevance new vector population mismatch');
  if (newVectors.some((v) => !Array.isArray(v) || v.length !== retained.dimensions
    || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))
    || Math.abs(Math.sqrt(v.reduce((s, x) => s + x * x, 0)) - 1) > 0.001)) {
    throw new Error('incremental relevance new vector dimensions/normalization mismatch');
  }
  const merged = [...vectors];
  indexes.forEach((index, localIndex) => { merged[index] = newVectors[localIndex]; });
  return merged.map((v) => {
    if (!v) throw new Error(`incremental relevance missing ${kind} vector`);
    return v;
  });
}
/** Keep local new-query indices separate from the complete accepted order. */
export async function embedIncrementalRelevanceQueries(
  retained: NonNullable<Awaited<ReturnType<typeof loadRetainedRelevanceVectors>>>, texts: string[],
  embedMissing: (texts: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  return embedIncrementalRelevancePopulation(retained, texts, 'query', embedMissing);
}
/** Document expansion uses the query merge's existing validation, not a cache. */
export async function embedIncrementalRelevanceDocuments(
  retained: NonNullable<Awaited<ReturnType<typeof loadRetainedRelevanceVectors>>>, texts: string[],
  embedMissing: (texts: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  return embedIncrementalRelevancePopulation(retained, texts, 'document', embedMissing);
}
/** No inference or SQL writes happen until every selected identity is verified. */
export async function prepareMeasurementCell(file: string, expectedSha256: string, cellId: string,
  repoRoot: string = process.cwd()): Promise<PreparedMeasurement> {
  const actual = await fingerprintFile(file);
  if (!sha.safeParse(expectedSha256).success || actual.sha256 !== expectedSha256) throw new Error('frozen manifest fingerprint mismatch');
  const m = validateMeasurementManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (m.ownerId !== measurementOwner()) throw new Error('manifest output owner differs from executing session');
  if (m.frozenAt > new Date().toISOString()) throw new Error('manifest frozen in the future');
  const cell = m.cells.find((c) => c.id === cellId); if (!cell) throw new Error(`undeclared cell ${cellId}`);
  const arm = m.arms.find((a) => a.id === cell.armId)!;
  const anchor = spawnSync('git', ['merge-base', '--is-ancestor', m.sourceCommit, 'HEAD'], { cwd: repoRoot });
  if (anchor.status !== 0) throw new Error('measurement source anchor is not in current tree history');
  const dataset = ['relevance', 'hybrid', 'answers'].includes(cell.bar) ? m.datasets.find((d) => d.corpus === cell.corpus) : undefined;
  const inputIds = new Set([...cell.inputIds, ...(dataset ? [dataset.snapshot, dataset.labels, dataset.judgments, dataset.census] : [])]);
  const files = [...inputIds].map((ref) => m.inputs[ref]);
  files.push(arm.artifacts.graph, arm.artifacts.tokenizer, arm.artifacts.config, ...arm.artifacts.weights, arm.runtime.source);
  for (const declared of files) {
    const actual = await fingerprintFile(path.resolve(repoRoot, declared.path));
    if (actual.sha256 !== declared.sha256 || actual.bytes !== declared.bytes) throw new Error(`declared file fingerprint mismatch: ${declared.path}`);
  }
  if (dataset) {
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.snapshot].path), 'utf8'));
    const labels = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.labels].path), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.resolve(repoRoot, m.inputs[dataset.judgments].path), 'utf8'));
    const entries = snapshot.suites[dataset.corpus].entries as FrozenEntry[];
    const queries = labels[dataset.corpus] as FrozenQuery[];
    if (JSON.stringify(dataset.keys) !== JSON.stringify(entries.map((e) => e.key))
      || JSON.stringify(dataset.queryIds) !== JSON.stringify(queries.map((q) => q.id))) throw new Error('frozen corpus/query order mismatch');
    validateIndependentCohort(entries, queries, receipt[dataset.corpus], m.inputs[dataset.snapshot].sha256,
      m.inputs[dataset.labels].sha256, m.frozenAt);
    const judgeRawFiles: string[] = [];
    for (const judge of receipt[dataset.corpus].judges) {
      const actual = await fingerprintFile(path.resolve(repoRoot, judge.raw.path));
      if (actual.sha256 !== judge.raw.sha256 || actual.bytes !== judge.raw.bytes) throw new Error('independent judgment raw fingerprint mismatch');
      judgeRawFiles.push(fs.realpathSync(path.resolve(repoRoot, judge.raw.path)));
    }
    unique(judgeRawFiles, 'judge raw artifact');
  }
  const { raw } = measurementOutputPaths(m, cell, repoRoot);
  fs.mkdirSync(path.dirname(raw), { recursive: true, mode: 0o700 });
  const claimPath = `${raw}.running`;
  fs.writeFileSync(claimPath, JSON.stringify({ ownerId: m.ownerId, pid: process.pid, manifestSha256: expectedSha256, cellId,
    startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  return { manifest: m, manifestSha256: expectedSha256, cell, arm, rawOutput: raw, claimPath };
}

export function assertMeasurementArm(arm: MeasurementArm, actual: Pick<MeasurementArm, 'profile' | 'prompts' | 'tokenizer' | 'execution'>): void {
  for (const key of ['profile', 'prompts', 'tokenizer', 'execution'] as const) {
    if (hashJson(arm[key]) !== hashJson(actual[key])) throw new Error(`measured arm ${key} identity mismatch`);
  }
}
export function assertMeasuredEmbedResponse(arm: MeasurementArm, response: SidecarEmbedResponse, n: number): void {
  if (response.modelRev !== arm.modelRev || response.runtime !== arm.runtime.wire || response.dims !== arm.profile.targetDims
    || response.vectors.length !== n) throw new Error('HTTP model/revision/runtime/dimension identity mismatch');
  if (response.cache?.hits !== 0 || response.cache.coalesced !== 0 || response.cache.inferred !== n) throw new Error('uncached inference accounting mismatch');
  for (const v of response.vectors) {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    if (v.length !== arm.profile.targetDims || v.some((x) => !Number.isFinite(x)) || Math.abs(norm - 1) > 0.001) throw new Error('invalid measured native unit vector');
  }
}
export function assertMeasuredExecution(arm: MeasurementArm, actual: { device: string; dtype: string | null; verified: boolean },
  threads: { intraOpNumThreads: number; interOpNumThreads: number }, worker: { alive: boolean; disabled: boolean }): void {
  // Production records null for default fp32; artifact hashes pin the fp32
  // graph separately. Null is never interpreted as a measured dtype override.
  if (!actual.verified || actual.device !== arm.execution.device || (actual.dtype !== null && actual.dtype !== arm.execution.dtype)
    || threads.intraOpNumThreads !== arm.execution.intraOpThreads || threads.interOpNumThreads !== arm.execution.interOpThreads
    || !worker.alive || worker.disabled) throw new Error('unverified/mismatched device, threads or worker fallback');
}

/** A no-CUDA smoke capture only qualifies file import, not the decoder used by
 * a native CUDA measurement. A saved report may also contain partial events
 * after importer failure. This guard qualifies decoding; PID/sequence binding
 * and model acceptance still require their own retained evidence. */
/** This proves reported CUDA API failures in a native model Run, not an
 * arena limit, allocation sizes, physical pressure or fragmentation. Bind
 * the target PID/library fingerprints and failing request separately. */
export function inspectNativeCudaAllocationFailure(log: string) {
  const reports = log.split(/^========= Program hit /m).slice(1);
  const offsets: string[] = [];
  let allocations = 0, propagatedErrors = 0;
  for (const report of reports) {
    const api = /^cudaErrorMemoryAllocation \(error 2\) due to "out of memory" on CUDA API call to (cudaMalloc|cudaGetLastError)\.\r?\n/.exec(report)?.[1];
    const provider = /Host Frame:.*\[(0x[0-9a-f]+)\] in libonnxruntime_providers_cuda\.so(?:\r?\n|$)/i.exec(report)?.[1];
    if (!api || !provider || !report.includes('Host Frame: InferenceSessionWrap::Run(Napi::CallbackInfo const&)')) {
      throw new Error('CUDA allocation diagnostic lacks the native provider/API backtrace');
    }
    offsets.push(provider);
    if (api === 'cudaMalloc') allocations++; else propagatedErrors++;
  }
  const summaries = [...log.matchAll(/^========= ERROR SUMMARY: (\d+) errors?\s*$/gm)];
  if (!allocations || summaries.length !== 1 || Number(summaries[0][1]) !== reports.length) {
    throw new Error('CUDA allocation diagnostic lacks a complete API-error census');
  }
  return { underlyingApi: 'cudaMalloc' as const, returnCode: 2 as const,
    allocationErrors: allocations, propagatedErrors, cudaProviderOffsets: offsets };
}

export function assertNativeProfilerQualification(importer: { exitCode: number; output: string },
  capture: { databaseIntegrity: string; cudaApiRecords: number; cudaKernelRecords: number }): void {
  const fatalMarkers = ['processeventserror', 'unknown driver api function index:',
    'cannot find string for an exterior index', 'errors occurred while processing the raw events',
    'import failed:', 'fatal error:'];
  if (importer.exitCode !== 0 || typeof importer.output !== 'string'
    || importer.output.split('\n').some((line) => {
      const text = line.trimStart().toLowerCase();
      return text.startsWith('error {') || fatalMarkers.some((marker) => text.includes(marker));
    })) throw new Error('native CUDA profiler import failed; retain capture and repair decoder before inference');
  if (capture.databaseIntegrity !== 'ok'
    || [capture.cudaApiRecords, capture.cudaKernelRecords].some((count) => !Number.isSafeInteger(count) || count <= 0)) {
    throw new Error('native CUDA profiler preflight lacks decoded CUDA activity');
  }
}

export interface NativeProfilerRequestWindow {
  runTag: string; processId: number; nativeThreadId: number; startMonotonicNs: string; endMonotonicNs: string;
}
/** Detect loader activity that maps snapshots can miss, including a complete
 * load/unload between native-call boundaries. The caller retains the complete
 * target stderr from process exec through EOF, its fingerprint and exit receipt.
 * No absence-of-activity result by itself proves a fingerprinted DLL closure:
 * loader paths/namespaces still need to be joined to the pre-inference maps. */
export function inspectNativeLoaderActivity(stderr: string, windows: NativeProfilerRequestWindow[]) {
  if (!stderr || !windows.length) throw new Error('native loader population missing');
  const processId = windows[0].processId, expected = new Map<string, NativeProfilerRequestWindow>();
  for (const w of windows) {
    if (!w.runTag || expected.has(w.runTag) || w.processId !== processId
      || !Number.isSafeInteger(w.processId) || w.processId <= 0
      || !Number.isSafeInteger(w.nativeThreadId) || w.nativeThreadId <= 0
      || typeof w.startMonotonicNs !== 'string' || typeof w.endMonotonicNs !== 'string'
      || !/^[1-9]\d*$/.test(w.startMonotonicNs) || !/^[1-9]\d*$/.test(w.endMonotonicNs)
      || BigInt(w.startMonotonicNs) >= BigInt(w.endMonotonicNs)) throw new Error('invalid native loader request population');
    expected.set(w.runTag, w);
  }
  for (let i=0;i<windows.length;i++) for (let j=i+1;j<windows.length;j++) {
    const a=windows[i],b=windows[j];
    if (a.nativeThreadId===b.nativeThreadId && BigInt(a.startMonotonicNs)<BigInt(b.endMonotonicNs)
      && BigInt(b.startMonotonicNs)<BigInt(a.endMonotonicNs)) throw new Error('overlapping native loader request windows');
  }
  const seen = new Map<string, string[]>(), markers: number[] = [], lines = stderr.split('\n');
  let previousNs = 0n;
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('PC_NATIVE_RUN\t')) continue;
    let marker;
    try { marker = JSON.parse(line.slice('PC_NATIVE_RUN\t'.length)); }
    catch { throw new Error('malformed native loader marker'); }
    if (marker?.processId !== processId) throw new Error('native loader marker process mismatch');
    const w = expected.get(marker.runTag), phases = seen.get(marker.runTag) ?? [];
    if (!w || marker.nativeThreadId !== w.nativeThreadId || phases.length >= 2
      || marker.phase !== (phases.length ? 'end' : 'start')
      || marker.monotonicNs !== (marker.phase === 'start' ? w.startMonotonicNs : w.endMonotonicNs)
      || BigInt(marker.monotonicNs) < previousNs) throw new Error('native loader marker does not bind request window');
    phases.push(marker.phase); seen.set(marker.runTag, phases); markers.push(index);
    previousNs = BigInt(marker.monotonicNs);
  }
  if (seen.size !== expected.size || [...seen.values()].some(phases => phases.length !== 2)) {
    throw new Error('native loader request markers incomplete');
  }
  const first = markers[0], last = markers.at(-1)!, startupLibraries = new Set<string>();
  const activity: Array<{ line: number; operation: string; object: string; namespace: string | null }> = [];
  let startupComplete = false, startupMaps = 0;
  for (const [index, line] of lines.entries()) {
    const row = line.match(/^\s*(\d+):\s*(.*)$/);
    if (!row || Number(row[1]) !== processId) continue;
    const text = row[2];
    if (index < first && text.startsWith('transferring control:')) startupComplete = true;
    if (index < first && /;\s+generating link map$/.test(text)) startupMaps++;
    const initialization = text.match(/^calling init:\s+(.+)$/);
    if (index < first && initialization) startupLibraries.add(initialization[1]);
    if (index <= first || index >= last) continue;
    const map = text.match(/^file=(.+) \[(\d+)\];\s+(generating|destroying) link map$/);
    const call = text.match(/^calling (preinit|init|fini):\s*(.*?)\s*(?:\[(\d+)\])?$/);
    if (map) activity.push({ line: index+1, operation: map[3]+'-map', object: map[1], namespace: map[2] });
    else if (call) activity.push({ line: index+1, operation: call[1], object: call[2], namespace: call[3] ?? null });
    else if (/generating link map|destroying link map|calling (?:preinit|init|fini):|error:|fatal:/i.test(text)) {
      throw new Error('unsupported or failed native loader activity');
    }
  }
  if (!startupComplete || !startupMaps || !startupLibraries.size) throw new Error('native loader startup evidence missing');
  return { processId, runTags: [...expected.keys()], startupLibraries: [...startupLibraries].sort(), activity,
    noLoaderActivityDuringPopulation: activity.length === 0,
    completeBeforeInferenceClosureVerified: false as const,
    scope: 'glibc loader stderr ordering from first native Run start through last Run end' };
}
/** Join every still-loaded, generated glibc link map before the first Run to
 * its recorded file identity, using BOTH actual ELF addresses. glibc's `base`
 * is l_addr (load bias), not necessarily a mapped address for prelinked ELFs.
 * Names alone cannot distinguish duplicate basenames or loader namespaces.
 * This qualifies the generated-object population, not the main executable,
 * interpreter, vDSO, or completeness/EOF of the caller's retained stderr. */
export function bindNativeLoaderMappedObjects(stderr: string, windows: NativeProfilerRequestWindow[],
  firstRun: WorkerNativeInferenceTrace) {
  const activity = inspectNativeLoaderActivity(stderr, windows);
  const firstWindow = windows.reduce((a,b) => BigInt(a.startMonotonicNs) < BigInt(b.startMonotonicNs) ? a : b);
  if (!validNativeRuntimeSample(firstRun) || firstRun.phase !== 'start'
    || firstRun.processId !== firstWindow.processId || firstRun.nativeThreadId !== firstWindow.nativeThreadId
    || firstRun.runTag !== firstWindow.runTag || firstRun.monotonicNs !== firstWindow.startMonotonicNs) {
    throw new Error('native loader pre-Run map sample does not bind first request');
  }
  const libraries = firstRun.runtime!.libraries;
  const ranges = libraries.flatMap(file => {
    if (!file.mappedRanges?.length) throw new Error('native loader address ranges missing');
    return file.mappedRanges.map(range => ({ file, start: BigInt('0x'+range.startAddress), end: BigInt('0x'+range.endAddress) }));
  }).sort((a,b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  for (let i=1; i<ranges.length; i++) if (ranges[i].start < ranges[i-1].end) {
    throw new Error('native loader map addresses ambiguous');
  }
  type ObjectMap = { object: string; namespace: string; loadBias: string; mappedSize: string;
    dynamicAddress: string; programHeaderAddress: string; line: number };
  // Node probes legacy registration, then Node-API registration/version via
  // dlsym. glibc labels a missing optional symbol '(fatal)' even when Node's
  // supported fallback succeeds. Recognize only these startup probes; bind
  // their exact addon file and recorded Node ABI after the address joins.
  const registrationProbeLookups: Array<{line:number;object:string;symbol:string}> = [];
  const active = new Map<string, ObjectMap>(), retired: ObjectMap[] = [];
  let pending: Partial<ObjectMap> | undefined;
  const lines = stderr.split('\n'), firstMarker = lines.findIndex(line => line.startsWith('PC_NATIVE_RUN\t'));
  for (const [index,line] of lines.entries()) {
    if (index >= firstMarker) break;
    const row = line.match(/^\s*(\d+):\s*(.*)$/);
    if (!row || Number(row[1]) !== firstWindow.processId || !row[2].trim()) continue;
    const text = row[2].trim(), generated = text.match(/^file=(.+) \[(\d+)\];\s+generating link map$/);
    const destroyed = text.match(/^file=(.+) \[(\d+)\];\s+destroying link map$/);
    const dynamic = text.match(/^dynamic:\s+(0x[\da-f]+)\s+base:\s+(0x[\da-f]+)\s+size:\s+(0x[\da-f]+)$/i);
    const phdr = text.match(/^entry:\s+0x[\da-f]+\s+phdr:\s+(0x[\da-f]+)\s+phnum:\s+(\d+)$/i);
    const probe=text.match(/^(\/.+\.node): error: symbol lookup error: undefined symbol: (node_register_module_v[1-9]\d*|napi_register_module_v1|node_api_module_get_api_version_v1) \(fatal\)$/);
    if (generated && !pending) {
      pending = { object: generated[1], namespace: generated[2], line: index+1 };
    } else if (pending && dynamic && pending.dynamicAddress === undefined) {
      if (BigInt(dynamic[1]) === 0n || BigInt(dynamic[3]) === 0n) throw new Error('native loader invalid ELF addresses');
      Object.assign(pending, { dynamicAddress: dynamic[1], loadBias: dynamic[2], mappedSize: dynamic[3] });
    } else if (pending && phdr && pending.dynamicAddress !== undefined) {
      if (BigInt(phdr[1]) === 0n || !/^[1-9]\d*$/.test(phdr[2])) throw new Error('native loader invalid ELF headers');
      const object = { ...pending, programHeaderAddress: phdr[1] } as ObjectMap;
      const key = object.namespace+'\0'+object.object;
      if (active.has(key)) throw new Error('native loader generated object repeated');
      active.set(key, object); pending = undefined;
    } else if (!pending && destroyed) {
      const key = destroyed[2]+'\0'+destroyed[1], object = active.get(key);
      if (!object) throw new Error('native loader destruction does not bind generated object');
      retired.push(object); active.delete(key);
    } else if (!pending && probe) {
      registrationProbeLookups.push({line:index+1,object:probe[1],symbol:probe[2]});
    } else if (pending || /generating link map|destroying link map|^dynamic:|^entry:|error:|fatal:/i.test(text)) {
      throw new Error('native loader incomplete or unsupported object evidence at line '+(index+1)+': '+text);
    }
  }
  if (pending || !active.size) throw new Error('native loader generated object population incomplete');
  const joinedAddresses = new Set<string>();
  const objectMapJoins = [...active.values()].map(object => {
    const dynamic = BigInt(object.dynamicAddress), phdr = BigInt(object.programHeaderAddress);
    const dynamicMaps = ranges.filter(range=>range.start <= dynamic && dynamic < range.end);
    const headerMaps = ranges.filter(range=>range.start <= phdr && phdr < range.end);
    if (dynamicMaps.length !== 1 || headerMaps.length !== 1 || dynamicMaps[0].file !== headerMaps[0].file) {
      throw new Error('native loader ELF addresses do not bind one fingerprinted file');
    }
    const addressKey = dynamic.toString()+':'+phdr.toString();
    if (joinedAddresses.has(addressKey)) throw new Error('native loader namespaces reuse ambiguous ELF addresses');
    joinedAddresses.add(addressKey);
    return { ...object, file: dynamicMaps[0].file };
  });
  const joinedFiles = new Set(objectMapJoins.map(join=>join.file.path));
  for(const probe of registrationProbeLookups) {
    const abi=firstRun.runtime!.loaderProcess?.nodeModuleVersion;
    if (typeof abi!=='string' || !/^[1-9]\d*$/.test(abi)
      || probe.symbol.startsWith('node_register_module_v') && probe.symbol!=='node_register_module_v'+abi
      || !objectMapJoins.some(join=>join.file.path===probe.object)) throw new Error('native loader Node registration probe does not bind loaded addon/ABI');
  }
  return { processId: firstRun.processId, runTag: firstRun.runTag, objectMapJoins, registrationProbeLookups, retiredBeforeFirstRun: retired,
    unjoinedMappedFiles: libraries.filter(file=>!joinedFiles.has(file.path)),
    noLoaderActivityDuringPopulation: activity.noLoaderActivityDuringPopulation,
    completeBeforeInferenceClosureVerified: false as const,
    scope: 'generated glibc objects active before first Run, joined by dynamic and ELF-header addresses to retained maps' };
}

/** The launcher owns this receipt: install the pipe before spawning the target,
 * drain it to EOF, and record its terminal status. A log tail or a successful
 * profiler import is not an exec-to-EOF target stderr receipt. */
export interface NativeLoaderCaptureReceipt {
  source: 'spawn-pipe'; captureStartedBeforeExec: true; eof: true; processId: number;
  exitCode: number; signal: string | null; bytes: number; sha256: string;
}

/** Close the file-backed glibc population, including exec/interpreter objects
 * that `generating link map` need not print. vDSO is separately fingerprinted
 * kernel memory, never described as an on-disk DLL. This does not qualify JIT,
 * arbitrary mmap code, model vectors, CUDA kernels, or GPU device binding. */
export function bindNativeLoaderClosure(stderrBytes: Buffer, windows: NativeProfilerRequestWindow[],
  firstRun: WorkerNativeInferenceTrace, receipt: NativeLoaderCaptureReceipt) {
  if (!Buffer.isBuffer(stderrBytes) || !receipt || receipt.source!=='spawn-pipe'
    || receipt.captureStartedBeforeExec!==true || receipt.eof!==true || receipt.exitCode!==0 || receipt.signal!==null
    || receipt.processId!==firstRun.processId || receipt.bytes!==stderrBytes.length || !stderrBytes.length
    || receipt.sha256!==crypto.createHash('sha256').update(stderrBytes).digest('hex')) {
    throw new Error('native loader complete stderr terminal receipt missing or mismatched');
  }
  const stderr=stderrBytes.toString('utf8');
  if (!Buffer.from(stderr,'utf8').equals(stderrBytes)) throw new Error('native loader stderr encoding unsupported');
  const mapped=bindNativeLoaderMappedObjects(stderr,windows,firstRun);
  if (!mapped.noLoaderActivityDuringPopulation) throw new Error('native loader population changed during selected requests');
  const process=firstRun.runtime!.loaderProcess, files=firstRun.runtime!.libraries;
  const address=(value: unknown) => {
    if (typeof value!=='string' || !/^[\da-f]+$/i.test(value) || BigInt('0x'+value)===0n) {
      throw new Error('native loader process address invalid');
    }
    return BigInt('0x'+value);
  };
  if (!process || !Number.isSafeInteger(process.programHeaderCount) || process.programHeaderCount<1
    || process.programHeaderCount>1024 || process.programHeaderEntryBytes!==56
    || process.executablePath===process.interpreterPath) throw new Error('native loader process census incomplete or unsupported');
  const fileAt=(at: bigint,length: bigint,permission: string) => {
    const matches=files.filter(file=>file.mappedRanges!.some(range=>BigInt('0x'+range.startAddress)<=at
      && at+length<=BigInt('0x'+range.endAddress) && range.permissions.includes(permission)));
    if(matches.length!==1) throw new Error('native loader process address does not bind one fingerprinted file');
    return matches[0];
  };
  const executable=fileAt(address(process.programHeaderAddress),BigInt(process.programHeaderCount*56),'r');
  const entry=fileAt(address(process.entryAddress),1n,'x');
  const interpreter=fileAt(address(process.interpreterBaseAddress),1n,'r');
  if (executable!==entry || executable.path!==process.executablePath || interpreter.path!==process.interpreterPath
    || !interpreter.mappedRanges!.some(range=>address(process.interpreterBaseAddress)===BigInt('0x'+range.startAddress)
      && BigInt('0x'+range.fileOffset)===0n)) throw new Error('native loader executable/interpreter census mismatch');
  const vdso=process.vdso;
  if (!vdso || vdso.origin!=='kernel-auxv-AT_SYSINFO_EHDR' || vdso.permissions!=='r-xp'
    || vdso.fileOffset!=='00000000' && vdso.fileOffset!=='0'
    || !Number.isSafeInteger(vdso.bytes) || vdso.bytes<64 || vdso.bytes>65536
    || typeof vdso.sha256!=='string' || !/^[a-f0-9]{64}$/.test(vdso.sha256)
    || address(vdso.endAddress)-address(vdso.startAddress)!==BigInt(vdso.bytes)
    || files.some(file=>file.mappedRanges!.some(range=>address(vdso.startAddress)<BigInt('0x'+range.endAddress)
      && BigInt('0x'+range.startAddress)<address(vdso.endAddress)))) throw new Error('native loader kernel vDSO census invalid');
  // Init diagnostics print loader names (often symlinks). Resolve aliases by
  // actual inode/device/bytes/hash; neither a basename nor an unverified path
  // substitution may establish a loaded-file identity.
  const resolveFile=(name: string) => {
    const exact=files.find(file=>file.path===name);
    if (exact) return exact;
    if (!path.isAbsolute(name)) throw new Error('native loader initialization path unresolved');
    try {
      const descriptor=fs.openSync(name,'r');
      let file: typeof executable;
      try {
        const stat=fs.fstatSync(descriptor,{bigint:true});
        const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n);
        const minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n);
        const candidates=files.filter(candidate=>{
          const [mappedMajor,mappedMinor]=candidate.mappedDevice.split(':').map(x=>BigInt('0x'+x));
          return stat.ino===BigInt(candidate.mappedInode) && major===mappedMajor && minor===mappedMinor;
        });
        if(candidates.length!==1) throw new Error('ambiguous alias');
        file=candidates[0];
        if(stat.size!==BigInt(file.bytes)
          || fs.realpathSync('/proc/self/fd/'+descriptor)!==fs.realpathSync(file.path)) throw new Error('alias identity changed');
        const hash=crypto.createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024); let length,bytes=0;
        while((length=fs.readSync(descriptor,buffer,0,buffer.length,null))>0) {hash.update(buffer.subarray(0,length));bytes+=length;}
        const after=fs.fstatSync(descriptor,{bigint:true});
        if(bytes!==file.bytes || hash.digest('hex')!==file.sha256 || after.size!==stat.size
          || after.mtimeNs!==stat.mtimeNs || after.ctimeNs!==stat.ctimeNs) throw new Error('alias bytes changed');
      } finally {fs.closeSync(descriptor);}
      return file;
    } catch {throw new Error('native loader initialization alias does not bind retained fingerprint');}
  };
  const firstMarker=stderr.split('\n').findIndex(line=>line.startsWith('PC_NATIVE_RUN\t'));
  const initializationJoins: Array<{line:number;object:string;file:typeof executable;namespaces:string[]}> = [];
  const retiredInitializationPaths: string[]=[]; let transfers=0;
  for(const [index,line] of stderr.split('\n').entries()) {
    const row=line.match(/^\s*(\d+):\s*(.*)$/);
    if(!row || Number(row[1])!==firstRun.processId) continue;
    if(/error:|fatal:/i.test(row[2]) && !mapped.registrationProbeLookups.some(probe=>probe.line===index+1)) {
      throw new Error('native loader failed capture');
    }
    if(index>=firstMarker) continue;
    const init=row[2].match(/^calling (?:preinit|init):\s+(.+)$/), transfer=row[2].match(/^transferring control:\s+(.+)$/);
    if (/calling (?:preinit|init):|transferring control:/i.test(row[2]) && !init && !transfer) {
      throw new Error('native loader startup path evidence malformed');
    }
    if(transfer) {
      if(resolveFile(transfer[1])!==executable) throw new Error('native loader control target differs from executable');
      transfers++;
    }
    if(!init) continue;
    // A destroyed, unmapped pre-Run object is outside the active closure.
    if(mapped.retiredBeforeFirstRun.some(object=>object.object===init[1])
      && !mapped.objectMapJoins.some(object=>object.object===init[1])) {retiredInitializationPaths.push(init[1]);continue;}
    const file=resolveFile(init[1]);
    const namespaces=mapped.objectMapJoins.filter(object=>object.file===file).map(object=>object.namespace);
    if(file!==executable && file!==interpreter && !namespaces.length) throw new Error('native loader init-only file lacks generated object identity');
    initializationJoins.push({line:index+1,object:init[1],file,namespaces:[...new Set(namespaces)]});
  }
  if(transfers!==1) throw new Error('native loader exec control transfer incomplete');
  const covered=new Set([executable.path,interpreter.path,...mapped.objectMapJoins.map(object=>object.file.path)]);
  const unjoinedMappedFiles=files.filter(file=>!covered.has(file.path));
  if(unjoinedMappedFiles.length) throw new Error('native loader mapped file census has residue');
  return {...mapped,executable,interpreter,vdso,initializationJoins,retiredInitializationPaths,unjoinedMappedFiles,
    stderrReceipt:receipt,completeBeforeInferenceClosureVerified:true as const,
    scope:'file-backed glibc ELF/addon closure before first selected Run; unchanged through last selected Run; vDSO separately fingerprinted kernel memory'};
}
export interface NativeProfilerLaunch {
  processId: number; nativeThreadId: number; correlationId: number; startNs: string; endNs: string;
}
export interface NativeProfilerKernel {
  kernelId: string; processId: number; correlationId: number;
}
/** A matched CUDA preflight must establish the exported systemClockNs origin
 * as CLOCK_MONOTONIC (Node hrtime), rather than assuming CLOCK_MONOTONIC_RAW.
 * Use exact ns and the API's launch
 * interval, never kernel execution time: asynchronous kernels can outlive Run.
 * Callers supply the complete selected kernel population and its runtime API
 * rows. Ambiguous/missing correlations or request windows fail qualification. */
export function bindNativeProfilerKernelRequests(systemClockNs: string,
  windows: NativeProfilerRequestWindow[], launches: NativeProfilerLaunch[], kernels: NativeProfilerKernel[]) {
  const ns = (value: string): bigint => {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) throw new Error('invalid native profiler nanoseconds');
    return BigInt(value);
  };
  const identity = (value: number) => Number.isSafeInteger(value) && value > 0;
  const origin = ns(systemClockNs);
  if (origin === 0n || !windows.length || !launches.length || !kernels.length) throw new Error('native profiler population missing');
  const tags = new Set<string>();
  const spans = windows.map((window) => {
    const start = ns(window.startMonotonicNs), end = ns(window.endMonotonicNs);
    if (!window.runTag || tags.has(window.runTag) || !identity(window.processId) || !identity(window.nativeThreadId)
      || start >= end) throw new Error('invalid native profiler request window');
    tags.add(window.runTag); return { ...window, start, end };
  });
  for (let i = 0; i < spans.length; i++) for (let j = i+1; j < spans.length; j++) {
    const a = spans[i], b = spans[j];
    if (a.processId === b.processId && a.nativeThreadId === b.nativeThreadId && a.start < b.end && b.start < a.end) {
      throw new Error('overlapping native profiler request windows');
    }
  }
  const apis = new Map<string, { launch: NativeProfilerLaunch; start: bigint; end: bigint }>();
  for (const launch of launches) {
    const start = ns(launch.startNs), end = ns(launch.endNs), key = `${launch.processId}:${launch.correlationId}`;
    if (!identity(launch.processId) || !identity(launch.nativeThreadId) || !identity(launch.correlationId)
      || end < start || apis.has(key)) throw new Error('invalid/ambiguous native profiler API correlation');
    apis.set(key, { launch, start: origin + start, end: origin + end });
  }
  const seen = new Set<string>(), used = new Set<string>();
  const bindings = kernels.map((kernel) => {
    if (!kernel.kernelId || seen.has(kernel.kernelId) || !identity(kernel.processId) || !identity(kernel.correlationId)) {
      throw new Error('invalid native profiler kernel identity');
    }
    seen.add(kernel.kernelId);
    const api = apis.get(`${kernel.processId}:${kernel.correlationId}`);
    if (!api) throw new Error('native profiler kernel lacks launch correlation');
    const matches = spans.filter((window) => window.processId === api.launch.processId
      && window.nativeThreadId === api.launch.nativeThreadId && api.start >= window.start && api.end <= window.end);
    if (matches.length !== 1) throw new Error('native profiler launch lacks unique monotonic request window');
    used.add(matches[0].runTag);
    return { kernelId: kernel.kernelId, runTag: matches[0].runTag };
  });
  if (used.size !== spans.length) throw new Error('native profiler request window lacks compute kernels');
  return bindings;
}

export interface CellOutcome { cellId: string; manifestSha256: string; status: 'measured' | 'incompatible';
  artifacts: Array<{ path: string; sha256: string; bytes: number }>; defect?: { owner: string; item: string; rootCause: string; guard: string } }
/** Coverage is an exact partition of promised cells. Unknown/skipped is unfinished. */
export function validateMeasurementCoverage(m: MeasurementManifest, manifestSha256: string, outcomes: CellOutcome[]): void {
  unique(outcomes.map((o) => o.cellId), 'outcome');
  const promised = new Set(m.cells.map((c) => c.id));
  for (const o of outcomes) {
    if (!promised.delete(o.cellId) || o.manifestSha256 !== manifestSha256 || !['measured', 'incompatible'].includes(o.status)
      || !o.artifacts.length || o.artifacts.some((a) => !fingerprint.safeParse(a).success)) throw new Error('unknown/unbound/unmeasured coverage outcome');
    if (o.status === 'incompatible' && (!o.defect?.owner || !/^(WI|EI)-\d+$/.test(o.defect.item) || !o.defect.rootCause || !o.defect.guard)) throw new Error('incompatibility lacks owned root diagnosis/guard');
  }
  if (promised.size) throw new Error(`unfinished promised cells: ${[...promised].join(', ')}`);
}

export async function verifyMeasurementCoverage(m: MeasurementManifest, manifestSha256: string, outcomes: CellOutcome[]): Promise<void> {
  validateMeasurementCoverage(m, manifestSha256, outcomes);
  for (const outcome of outcomes) {
    const cell = m.cells.find((c) => c.id === outcome.cellId)!;
    for (const artifact of outcome.artifacts) {
      const actual = await fingerprintFile(artifact.path);
      if (actual.sha256 !== artifact.sha256 || actual.bytes !== artifact.bytes) throw new Error('cell evidence file fingerprint mismatch');
    }
    const receipt = JSON.parse(fs.readFileSync(outcome.artifacts[0].path, 'utf8'));
    if (receipt.manifestSha256 !== manifestSha256 || receipt.cellId !== cell.id || receipt.armId !== cell.armId
      || receipt.ownerId !== m.ownerId || !receipt.measuredAt || !receipt.report) throw new Error('stored cell receipt identity mismatch');
  }
}

/** Publish complete bytes exclusively, preserving a competing receipt. The
 * blind collector uses the same staging/link protocol; rename would overwrite. */
function writeMeasurementReceipt(file: string, value: unknown): void {
  const pending = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.pending`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(pending, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.linkSync(pending, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(pending, { force: true });
  }
}

export function writeMeasurementCell(prepared: PreparedMeasurement, report: unknown): CellOutcome {
  const { rawOutput, manifestSha256, cell, arm } = prepared;
  const owner = JSON.parse(fs.readFileSync(prepared.claimPath, 'utf8'));
  if (owner.ownerId !== prepared.manifest.ownerId || owner.pid !== process.pid || owner.manifestSha256 !== manifestSha256
    || owner.cellId !== cell.id) throw new Error('cell output claim identity mismatch');
  fs.mkdirSync(path.dirname(rawOutput), { recursive: true });
  writeMeasurementReceipt(rawOutput, { formatVersion: 1, manifestSha256, cellId: cell.id,
    armId: arm.id, ownerId: prepared.manifest.ownerId, measuredAt: new Date().toISOString(), report });
  fs.unlinkSync(prepared.claimPath);
  const bytes = fs.readFileSync(rawOutput);
  return { cellId: cell.id, manifestSha256, status: 'measured', artifacts: [{ path: rawOutput,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }] };
}

/** Failure is retained under this attempt, never converted to a model loss. */
/** Keep non-enumerable Error.cause/code evidence, with bounded depth and cycles.
 * The SQL bulk-operation serializer cannot be imported into this PG-free CLI. */
function measurementFailure(error: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth >= 8) return '[cause chain truncated]';
  if (typeof error === 'string') return error.slice(0, 8000);
  if (typeof error === 'bigint') return String(error);
  if (error === null || typeof error !== 'object') return error;
  if (seen.has(error)) return '[circular cause]';
  seen.add(error);
  if (Array.isArray(error)) return error.slice(0, 256).map((value) => measurementFailure(value, depth + 1, seen));
  const source = error as Record<string, unknown>;
  const keys = error instanceof Error
    ? ['name', 'message', 'stack', 'code', 'status', 'errno', 'syscall', 'address', 'port', 'socket', 'request', 'cause']
    : Object.keys(error).slice(0, 32);
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined)
    .map((key) => [key, measurementFailure(source[key], depth + 1, seen)]));
}

export function failMeasurementCell(prepared: PreparedMeasurement, error: unknown): void {
  if (!fs.existsSync(prepared.claimPath)) return;
  writeMeasurementReceipt(`${prepared.rawOutput}.failure.json`, { formatVersion: 1,
    manifestSha256: prepared.manifestSha256, cellId: prepared.cell.id, ownerId: prepared.manifest.ownerId,
    failedAt: new Date().toISOString(), error: measurementFailure(error) });
  fs.unlinkSync(prepared.claimPath);
}
