/** Experimental benchmark adapters; these do not register production models. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { moduleRepoRoot } from '../../module-repo-root';
import os from 'node:os';
import { ORT_SESSION_OPTIONS, validNativeRuntimeSample, type WorkerInputTrace, type WorkerInferenceTrace, type WorkerNativeInferenceTrace } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { gemmaPrompt, harrierPrompt, mrlTruncate, embedViaWorker, embedRequestedExecution,
  shutdownLocalEmbedder, getWorkerState, EMBEDDER_DIM_SPECS, buildMdenseOnEmbedder,
  embedExecutionTarget, MDENSEON_MODEL, MDENSEON_REVISION } from '@papercusp/memory';
import { fingerprintFile, measurementPackageVersion, realDestination } from './measurement-manifest';

/** A frozen source tree has no Git metadata. Qualify the benchmark's source
 * layout rather than inheriting an unrelated ancestor checkout (e.g. home).
 * Exported so launch recipes can reject bad paths before heavy admission. */
export function nativeBenchmarkOutputPaths(outputFile: string, moduleUrl = import.meta.url): { repo: string; output: string } {
  const sourceFiles = ['package.json', 'packages/operator-core/package.json',
    'packages/operator-core/lib/memory/bench/candidate-embedders.ts',
    'libs/generic/memory/src/local-embedder-worker.script.mjs'];
  const hasSourceLayout = (root: string) => sourceFiles.every((file) => fs.existsSync(path.join(root, file)));
  const sourceRoot = moduleRepoRoot(moduleUrl, hasSourceLayout);
  if (!hasSourceLayout(sourceRoot)) throw new Error('native benchmark source layout not found');
  const repo = fs.realpathSync(sourceRoot), output = realDestination(outputFile);
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) {
    throw new Error('raw benchmark output must remain private outside source tree');
  }
  return { repo, output };
}

/** Independent pooling oracle for isolated qualification; production recipes
 * and profiles remain untouched. Padding must not contribute to the mean. */
export function benchmarkMaskedMean(hidden: ArrayLike<number>, mask: number[], dims: number): number[] {
  if (!Number.isInteger(dims) || dims < 1 || hidden.length !== mask.length * dims
    || !mask.every((x) => x === 0 || x === 1) || !mask.some(Boolean)) throw new Error('invalid masked hidden state');
  const sum = new Array<number>(dims).fill(0), count = mask.reduce<number>((a, b) => a + b, 0);
  for (let token = 0; token < mask.length; token++) if (mask[token]) {
    for (let d = 0; d < dims; d++) {
      const value = Number(hidden[token * dims + d]);
      if (!Number.isFinite(value)) throw new Error('nonfinite hidden state');
      sum[d] += value;
    }
  }
  return sum.map((x) => x / count);
}

export const INCUMBENT_REFERENCE_CASES = [
  ['plain', 'search for the pinned reference'], ['newline', 'first line\nsecond line'],
  ['whitespace', ' leading  repeated\tspace\n'], ['unicode', 'résumé 東京 naïve façade عربي'],
  ['normalization', 'café cafe\u0301'], ['code', 'const x = `${value}`;\nreturn x;'],
  ['special-token', '<image> <bos> <eos>'], ['empty', ''],
] as const;

export const CORRECTED_GEMMA_REFERENCE_ID = 'gemma-corrected-rust-768@benchmark-v1';
export const REFERENCE_PARITY_LIMITS = { minimumCosine: 0.99999, maximumAbsoluteError: 3e-5 } as const;

export const MDENSEON_BOUNDARY_IDS = ['short-query', 'short-document', 'unicode', 'code', 'whitespace', 'empty', 'full-8192', 'over-limit'] as const;
export interface NativeBoundaryRequest {
  formatVersion: number; model: string; revision: string; export: string; snapshot: string;
  execution: { dtype: string; intraOpThreads: number; interOpThreads: number; maxLength: number };
  thresholds: { minimumCosine: number; maximumAbsoluteError: number; ranking: string };
  assets: { path: string; sha256: string; bytes: number }[];
  cases: { id: string; kind: 'query' | 'document'; text: string; untruncatedTokens: number }[];
  batches: { id: string; caseIds: string[] }[];
}

/** Consume the same frozen Python boundary inputs without rebinding its old
 * helper source pin to current source. This runner executes the shipped worker. */
export function validateNativeBoundaryRequest(request: NativeBoundaryRequest): void {
  if (request.formatVersion !== 1 || request.model !== MDENSEON_MODEL || request.revision !== MDENSEON_REVISION
    || !path.isAbsolute(request.export) || !path.isAbsolute(request.snapshot)
    || request.execution.dtype !== 'fp32' || request.execution.maxLength !== 8192
    || request.execution.intraOpThreads !== 4 || request.execution.interOpThreads !== 1
    || request.thresholds.minimumCosine !== REFERENCE_PARITY_LIMITS.minimumCosine
    || request.thresholds.maximumAbsoluteError !== REFERENCE_PARITY_LIMITS.maximumAbsoluteError
    || request.thresholds.ranking !== 'exact') throw new Error('native boundary fixed contract mismatch');
  if (JSON.stringify(request.cases.map((c) => c.id)) !== JSON.stringify(MDENSEON_BOUNDARY_IDS)
    || request.cases.some((c) => !['query', 'document'].includes(c.kind) || typeof c.text !== 'string'
      || !Number.isInteger(c.untruncatedTokens) || c.untruncatedTokens < 2)
    || request.cases[6].untruncatedTokens !== 8192 || request.cases[7].untruncatedTokens <= 8192) {
    throw new Error('native boundary input population/token contract mismatch');
  }
  const batches = [{ id: 'padded', caseIds: ['short-query', 'unicode', 'code', 'whitespace', 'empty'] },
    { id: 'mixed-length', caseIds: ['short-query', 'full-8192'] }];
  if (JSON.stringify(request.batches) !== JSON.stringify(batches)) throw new Error('native boundary batch contract mismatch');
  if (!request.assets.length || request.assets.some((a) => !path.isAbsolute(a.path) || !/^[a-f0-9]{64}$/.test(a.sha256)
    || !Number.isInteger(a.bytes) || a.bytes < 1)) throw new Error('native boundary asset pin mismatch');
}

export interface NativeBoundaryRow {
  id: string; inputIds: number[]; referenceInputIds: number[]; vector: number[]; referenceVector: number[];
  execution: { device: string; verified: boolean }; worker: { alive: boolean; disabled: boolean };
  inputTraces?: WorkerInputTrace[];
  inferenceTraces?: WorkerInferenceTrace[];
  nativeInferenceTraces?: WorkerNativeInferenceTrace[];
}
export interface NativeBoundaryBatchRow {
  id: string; submittedCaseIds: string[]; actualInferenceBatchSize: number; vectors: number[][];
  execution: { device: string; verified: boolean }; worker: { alive: boolean; disabled: boolean };
  inputTracesByCase?: { id: string; traces: WorkerInputTrace[] }[];
  inferenceTracesByCase?: { id: string; traces: WorkerInferenceTrace[] }[];
  nativeInferenceTracesByCase?: { id: string; traces: WorkerNativeInferenceTrace[] }[];
}

function matchesWorkerInput(traces: WorkerInputTrace[] | undefined, model: string, ids: number[], device: string): boolean {
  return !!traces?.length && traces.every((trace) => trace.model === model && trace.device === device
    && Number.isFinite(Date.parse(trace.observedAt)) && JSON.stringify(trace.inputShape) === JSON.stringify([1, ids.length])
    && JSON.stringify(trace.inputIds) === JSON.stringify(ids) && trace.attentionMask.length === ids.length
    && trace.attentionMask.every((n) => n === 1));
}

/** Verify retained graph-call identity before any profiler clock/correlation
 * join. Overlapping graph intervals alone never establish kernel ownership. */
export function nativeInferenceTraceVerified(inputs: WorkerInputTrace[] | undefined,
  events: WorkerInferenceTrace[] | undefined, model: string, ids: number[], device: string): boolean {
  if (!matchesWorkerInput(inputs, model, ids, device) || inputs?.length !== 1 || events?.length !== 2) return false;
  const request = inputs[0].request;
  if (!request || !Number.isSafeInteger(request.requestId) || request.requestId < 0
    || [request.attempt, request.processId, request.workerThreadId]
    .some((n) => !Number.isSafeInteger(n) || n < 1)
    || (request.nativeThreadId !== null && (!Number.isSafeInteger(request.nativeThreadId) || request.nativeThreadId < 1))) return false;
  const [start, end] = events;
  return start.phase === 'start' && start.outcome === undefined && end.phase === 'end' && end.outcome === 'success'
    && events.every((event) => event.model === model && event.device === device && event.clock === 'node-hrtime'
      && Number.isFinite(Date.parse(event.observedAt)) && typeof event.monotonicNs === 'string' && /^[1-9]\d*$/.test(event.monotonicNs)
      && (['requestId', 'attempt', 'processId', 'workerThreadId', 'nativeThreadId'] as const)
        .every((key) => event[key] === request[key]))
    && BigInt(end.monotonicNs) >= BigInt(start.monotonicNs);
}

/** A request's synchronous addon calls must sit inside its outer graph interval.
 * No profiler clock alignment or compute-kernel ownership is inferred here. */
export function nativeRunTraceVerified(inputs: WorkerInputTrace[] | undefined, graph: WorkerInferenceTrace[] | undefined,
  events: WorkerNativeInferenceTrace[] | undefined, model: string, ids: number[], device: string): boolean {
  if (!nativeInferenceTraceVerified(inputs, graph, model, ids, device) || !events?.length || events.length % 2) return false;
  const request = inputs![0].request!, begin = BigInt(graph![0].monotonicNs), end = BigInt(graph![1].monotonicNs);
  let previous = begin;
  for (let i = 0; i < events.length; i += 2) {
    const pair = events.slice(i, i+2), index = i/2+1;
    if (!nativeInferenceTraceVerified(inputs, pair, model, ids, device)
      || pair.some((event) => event.runIndex !== index
        || event.runTag !== `pc-embed:${request.processId}:${request.workerThreadId}:${request.requestId}:${request.attempt}:${index}`)) return false;
    const startNs = BigInt(pair[0].monotonicNs), endNs = BigInt(pair[1].monotonicNs);
    if (startNs < previous || endNs > end) return false;
    previous = endNs;
  }
  return true;
}

export function nativeRawClockTraceVerified(events: WorkerNativeInferenceTrace[] | undefined): boolean {
  if (!events?.length || events.length % 2) return false;
  let previousRaw = 0n, executable = '';
  for (const [index, event] of events.entries()) {
    const clock = event.rawClock;
    if (!clock || event.phase !== (index % 2 ? 'end' : 'start')
      || event.clockProbeError !== undefined || clock.clock !== 'linux-clock-monotonic-raw'
      || [event.monotonicNs, clock.rawNs, clock.monotonicBeforeNs, clock.monotonicAfterNs, clock.nodeBeforeNs, clock.nodeAfterNs]
        .some((n) => typeof n !== 'string' || !/^[1-9]\d*$/.test(n))
      || !clock.executable || typeof clock.executable.path !== 'string' || !Number.isSafeInteger(clock.executable.bytes)
      || clock.executable.bytes < 1 || !/^[a-f0-9]{64}$/.test(clock.executable.sha256)
      || typeof clock.pythonVersion !== 'string' || !clock.pythonVersion
      || BigInt(clock.nodeBeforeNs) > BigInt(clock.monotonicBeforeNs)
      || BigInt(clock.monotonicBeforeNs) > BigInt(clock.monotonicAfterNs)
      || BigInt(clock.monotonicAfterNs) > BigInt(clock.nodeAfterNs)
      || (event.phase === 'start' && BigInt(clock.nodeAfterNs) > BigInt(event.monotonicNs))
      || (event.phase === 'end' && BigInt(clock.nodeBeforeNs) < BigInt(event.monotonicNs))
      || BigInt(clock.rawNs) <= previousRaw) return false;
    const identity = JSON.stringify({ ...clock.executable, pythonVersion: clock.pythonVersion });
    if (executable && executable !== identity) return false;
    executable = identity; previousRaw = BigInt(clock.rawNs);
  }
  return true;
}

export function nativeRuntimeTraceVerified(events: WorkerNativeInferenceTrace[] | undefined): boolean {
  return !!events?.length && events.length % 2 === 0
    && events.every((event,i)=>event.phase === (i%2 ? 'end' : 'start') && validNativeRuntimeSample(event));
}
/** Only the observed maps population is checked. A library loaded and unloaded
 * within Run can evade the snapshots; complete closure needs loader evidence. */
export function nativeObservedLibraryClosureVerified(events: WorkerNativeInferenceTrace[] | undefined): boolean {
  if (!nativeRuntimeTraceVerified(events)) return false;
  for (let i=0;i<events!.length;i+=2) {
    const before = new Map(events![i].runtime!.libraries.map(f=>[f.path,f]));
    if (events![i+1].runtime!.libraries.some(f=> {
      const prior=before.get(f.path); return !prior || prior.bytes!==f.bytes || prior.sha256!==f.sha256
        || prior.mappedDevice!==f.mappedDevice || prior.mappedInode!==f.mappedInode;
    })) return false;
  }
  return true;
}
export function nativeGpuCapacityObserved(events: WorkerNativeInferenceTrace[] | undefined): boolean {
  return nativeRuntimeTraceVerified(events) && events!.every(e=>e.device==='cuda' && e.runtime!.gpuMemory.status==='measured');
}

export function nativeBoundaryPopulation(request: NativeBoundaryRequest, selectedCell?: string) {
  validateNativeBoundaryRequest(request);
  const population = [...request.cases.map((c) => `single-${c.id}`), ...request.batches.map((b) => b.id)];
  if (!selectedCell) return { cases: request.cases, batches: request.batches, diagnosticOnly: false, notChecked: [] as string[] };
  const item = request.cases.find((c) => `single-${c.id}` === selectedCell);
  const batch = request.batches.find((b) => b.id === selectedCell);
  if (!item && !batch) throw new Error('native diagnostic requires one declared single-input cell or request group');
  const cases = item ? [item] : request.cases.filter((c) => batch!.caseIds.includes(c.id));
  const checked = new Set([selectedCell, ...cases.map((c) => `single-${c.id}`)]);
  return { cases, batches: batch ? [batch] : [], diagnosticOnly: true, notChecked: population.filter((id) => !checked.has(id)) };
}

/** Recompute fixed gates and stable all-input rankings from the retained raw
 * arrays. A measured loss is an outcome; a missing/fallback row is not proof. */
export function summarizeNativeBoundaries(request: NativeBoundaryRequest, rows: NativeBoundaryRow[], device: 'cpu' | 'cuda', selectedCell?: string,
  batchRows: NativeBoundaryBatchRow[] = []) {
  const selected = nativeBoundaryPopulation(request, selectedCell);
  if (JSON.stringify(rows.map((r) => r.id)) !== JSON.stringify(selected.cases.map((c) => c.id))) throw new Error('native boundary incomplete population');
  const comparisons = rows.map((row, i) => {
    if (!row.execution.verified || row.execution.device !== device || !row.worker.alive || row.worker.disabled) {
      throw new Error('native boundary unverified device or worker fallback');
    }
    const length = Math.min(8192, selected.cases[i].untruncatedTokens);
    if (row.inputIds.length !== length || row.referenceInputIds.length !== length
      || [...row.inputIds, ...row.referenceInputIds].some((n) => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error('native boundary invalid inferred token length/ids');
    }
    return { id: row.id, tokenLength: length, tokenIdsEqual: JSON.stringify(row.inputIds) === JSON.stringify(row.referenceInputIds),
      workerInputTraceVerified: matchesWorkerInput(row.inputTraces, request.export, row.referenceInputIds, device),
      workerInferenceTraceVerified: nativeInferenceTraceVerified(row.inputTraces, row.inferenceTraces, request.export, row.referenceInputIds, device),
      nativeRunTraceVerified: nativeRunTraceVerified(row.inputTraces, row.inferenceTraces, row.nativeInferenceTraces, request.export, row.referenceInputIds, device),
      nativeRawClockTraceVerified: nativeRawClockTraceVerified(row.nativeInferenceTraces),
      nativeRuntimeTraceVerified: nativeRuntimeTraceVerified(row.nativeInferenceTraces),
      observedLibraryClosureVerified: nativeObservedLibraryClosureVerified(row.nativeInferenceTraces),
      gpuDeviceCapacityObserved: nativeGpuCapacityObserved(row.nativeInferenceTraces),
      ...referenceVectorComparison(row.vector, row.referenceVector, 768) };
  });
  const ranks = (vectors: number[][]) => vectors.map((q) => vectors.map((d, i) => ({ i, score: q.reduce((s, v, j) => s + v * d[j], 0) }))
    .sort((a, b) => b.score - a.score || a.i - b.i).map((d) => d.i));
  const actualRankings = ranks(rows.map((r) => r.vector)), referenceRankings = ranks(rows.map((r) => r.referenceVector));
  const rankingsEqual = selected.diagnosticOnly ? null : JSON.stringify(actualRankings) === JSON.stringify(referenceRankings);
  const workerInputTraceVerified = comparisons.every((c) => c.workerInputTraceVerified);
  const vectorCompatible = comparisons.every((c) => c.passed && c.tokenIdsEqual)
    && rows.every((row, i) => (!row.inputTraces || comparisons[i].workerInputTraceVerified)
      && (!row.inferenceTraces || comparisons[i].workerInferenceTraceVerified));
  const nativeRunCompatible = rows.every((row, i) => !row.nativeInferenceTraces || comparisons[i].nativeRunTraceVerified);
  if ((batchRows.length || (selectedCell && selected.batches.length))
    && JSON.stringify(batchRows.map((b) => b.id)) !== JSON.stringify(selected.batches.map((b) => b.id))) {
    throw new Error('native boundary incomplete request-group population');
  }
  const batchComparisons = batchRows.map((batch, index) => {
    const declared = selected.batches[index];
    if (JSON.stringify(batch.submittedCaseIds) !== JSON.stringify(declared.caseIds)
      || batch.actualInferenceBatchSize !== 1 || batch.vectors.length !== declared.caseIds.length
      || !batch.execution.verified || batch.execution.device !== device || !batch.worker.alive || batch.worker.disabled) {
      throw new Error('native boundary request-group identity or worker mismatch');
    }
    const cases = batch.vectors.map((vector, i) => {
      const single = rows.find((r) => r.id === declared.caseIds[i])!;
      return { id: single.id, single: referenceVectorComparison(vector, single.vector, 768),
        reference: referenceVectorComparison(vector, single.referenceVector, 768) };
    });
    const inputTraceVerified = batch.inputTracesByCase?.length === declared.caseIds.length
      && batch.inputTracesByCase.every((item, i) => item.id === declared.caseIds[i]
        && matchesWorkerInput(item.traces, request.export, rows.find((r) => r.id === item.id)!.referenceInputIds, device));
    const inferenceTraceVerified = batch.inferenceTracesByCase?.length === declared.caseIds.length
      && batch.inferenceTracesByCase.every((item, i) => item.id === declared.caseIds[i]
        && nativeInferenceTraceVerified(batch.inputTracesByCase?.[i]?.traces, item.traces, request.export,
          rows.find((r) => r.id === item.id)!.referenceInputIds, device));
    const nativeTraceVerified = batch.nativeInferenceTracesByCase?.length === declared.caseIds.length
      && batch.nativeInferenceTracesByCase.every((item, i) => item.id === declared.caseIds[i]
        && nativeRunTraceVerified(batch.inputTracesByCase?.[i]?.traces, batch.inferenceTracesByCase?.[i]?.traces,
          item.traces, request.export, rows.find((r) => r.id === item.id)!.referenceInputIds, device));
    return { id: batch.id, cases, inputTraceVerified: inputTraceVerified === true, inferenceTraceVerified: inferenceTraceVerified === true,
      nativeRunTraceVerified: nativeTraceVerified === true,
      nativeRuntimeTraceVerified: batch.nativeInferenceTracesByCase?.every(item=>nativeRuntimeTraceVerified(item.traces)) === true,
      observedLibraryClosureVerified: batch.nativeInferenceTracesByCase?.every(item=>nativeObservedLibraryClosureVerified(item.traces)) === true,
      gpuDeviceCapacityObserved: batch.nativeInferenceTracesByCase?.every(item=>nativeGpuCapacityObserved(item.traces)) === true,
      passed: cases.every((c) => c.single.passed && c.reference.passed) && (!batch.inputTracesByCase || inputTraceVerified)
        && (!batch.inferenceTracesByCase || inferenceTraceVerified) && (!batch.nativeInferenceTracesByCase || nativeTraceVerified) };
  });
  const batchPopulationCompatible = batchRows.length === selected.batches.length && batchComparisons.every((b) => b.passed);
  return { comparisons, actualRankings, referenceRankings, rankingsEqual, diagnosticOnly: selected.diagnosticOnly,
    notCheckedCells: [...selected.notChecked, ...selected.batches.filter((b) => !batchRows.some((r) => r.id === b.id)).map((b) => b.id)],
    batchComparisons, batchPopulationCompatible, workerInputTraceVerified,
    requestGroupInputTraceVerified: batchPopulationCompatible && batchComparisons.every((b) => b.inputTraceVerified),
    workerInferenceTraceVerified: comparisons.every((c) => c.workerInferenceTraceVerified),
    requestGroupInferenceTraceVerified: batchPopulationCompatible && batchComparisons.every((b) => b.inferenceTraceVerified),
    nativeRunTraceVerified: comparisons.every((c) => c.nativeRunTraceVerified),
    requestGroupNativeRunTraceVerified: batchPopulationCompatible && batchComparisons.every((b) => b.nativeRunTraceVerified),
    diagnosticCompatible: selected.diagnosticOnly && vectorCompatible && nativeRunCompatible && batchPopulationCompatible,
    passedFixedVectorGates: comparisons.every((c) => c.passed), tokenIdsEqual: comparisons.every((c) => c.tokenIdsEqual),
    singlePopulationCompatible: !selected.diagnosticOnly && rankingsEqual === true && vectorCompatible && nativeRunCompatible };
}

/** Extend incumbent qualification instead of adding a second executable. The
 * published worker submits one text per inference, including batch requests. */
export async function qualifyMdenseOnBoundaries(requestFile: string, expectedSha: string, referenceDirectory: string,
  referenceSummarySha: string, outputFile: string, selectedCell?: string): Promise<void> {
  const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || hash(requestFile) !== expectedSha) throw new Error('boundary request SHA mismatch');
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8')) as NativeBoundaryRequest;
  const selected = nativeBoundaryPopulation(request, selectedCell);
  const tf32Override = process.env.NVIDIA_TF32_OVERRIDE;
  if (tf32Override !== undefined && tf32Override !== '0') throw new Error('native TF32 diagnostic requires unset or explicit override0');
  const requested = embedRequestedExecution();
  if (!['cpu', 'cuda'].includes(process.env.PAPERCUSP_EMBED_DEVICE ?? '') || requested.source !== 'env'
    || getWorkerState().alive || ORT_SESSION_OPTIONS.intraOpNumThreads !== 4 || ORT_SESSION_OPTIONS.interOpNumThreads !== 1) {
    throw new Error('native boundary requires explicit device and fresh pinned worker');
  }
  const device = process.env.PAPERCUSP_EMBED_DEVICE as 'cpu' | 'cuda';
  if (requested.device !== device) throw new Error('native boundary requested device mismatch');
  const { output, repo } = nativeBenchmarkOutputPaths(outputFile);
  const summaryPath = path.join(referenceDirectory, 'summary.json');
  if (!/^[a-f0-9]{64}$/.test(referenceSummarySha) || hash(summaryPath) !== referenceSummarySha) throw new Error('boundary reference summary SHA mismatch');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const population = [...MDENSEON_BOUNDARY_IDS.map((id) => `single-${id}`), 'padded', 'mixed-length'];
  if (summary.requestSha256 !== expectedSha || summary.diagnosticOnly !== false || summary.fullPopulationCompatible !== true
    || JSON.stringify(summary.cells) !== JSON.stringify(population) || summary.notChecked.length !== 0
    || summary.deviceRecipe !== 'python-ort-cpu-fp32-tf32-default' || hash(summary.profile.path) !== summary.profile.sha256) {
    throw new Error('boundary reference population/identity mismatch');
  }
  const references = request.cases.map((c) => {
    const file = path.join(referenceDirectory, `single-${c.id}.json`), ref = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (ref.requestSha256 !== expectedSha || ref.cell.id !== `single-${c.id}` || JSON.stringify(ref.cell.caseIds) !== JSON.stringify([c.id])
      || ref.referenceVectors.length !== 1 || ref.inputIds.length !== 1 || ref.tokenIdsEqual !== true
      || ref.inputIds[0].length !== Math.min(8192, c.untruncatedTokens)) throw new Error('boundary retained reference cell mismatch');
    assertVector(ref.referenceVectors[0], 768, 'boundary reference');
    return { file, sha256: hash(file), referenceInputIds: ref.inputIds[0] as number[], referenceVector: ref.referenceVectors[0] as number[] };
  });
  const exportAssets = request.assets.filter((a) => a.path.startsWith(`${request.export}${path.sep}`));
  for (const name of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'export-manifest.json', 'onnx/model.onnx']) {
    if (!exportAssets.some((a) => a.path === path.join(request.export, name))) throw new Error('native boundary export pin missing');
  }
  for (const asset of exportAssets) {
    const actual = await fingerprintFile(asset.path);
    if (actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes) throw new Error('native boundary export asset drift');
  }
  const sources = await Promise.all(['packages/operator-core/lib/memory/bench/candidate-embedders.ts',
    'packages/operator-core/lib/memory/bench/embedder-eval-cli.ts', 'libs/generic/memory/src/mdenseon-embedder.ts',
    'libs/generic/memory/src/local-embedder-worker.ts', 'libs/generic/memory/src/local-embedder-worker.script.mjs',
    'libs/generic/memory/src/embed-device.ts', 'packages/operator-core/lib/memory/bench/measurement-manifest.ts']
    .map((file) => fingerprintFile(path.join(repo, file))));
  const identity = { requestSha256: expectedSha, referenceSummarySha256: referenceSummarySha, device, sources, references,
    execution: { dtype: 'fp32', ...ORT_SESSION_OPTIONS }, nativeTransport: 'shipped-worker-single-text',
    selectedCell: selectedCell ?? null, precisionEnvironment: { NVIDIA_TF32_OVERRIDE: tf32Override ?? 'unset' },
    runtimeVersions: { node: process.versions.node, transformers: measurementPackageVersion('@huggingface/transformers'),
      tokenizers: measurementPackageVersion('tokenizers'), onnxruntimeNode: measurementPackageVersion('onnxruntime-node') },
    providerProof: 'worker-session-construction-report', computeKernelProfiling: 'not-exposed-by-shipped-worker',
    tokenIdsProof: 'independent qualification tokenizer and opt-in pre-graph worker tensors',
    actualWorkerTokenTrace: 'private per-cell JSONL, emitted before candidate inference',
    actualWorkerInferenceTrace: 'private graph-call and synchronous native Run start/end JSONL; profiler clock calibration and unique kernel joins remain separate' };
  fs.writeFileSync(`${output}.request.json`, JSON.stringify(identity), { flag: 'wx', mode: 0o600 });
  const rows: NativeBoundaryRow[] = [], batches: NativeBoundaryBatchRow[] = [];
  const collectInput = (cell: string, caseId: string, traces: WorkerInputTrace[]) => (trace: WorkerInputTrace) => {
    fs.appendFileSync(`${output}.inputs.jsonl`, JSON.stringify({ cell, caseId, trace }) + '\n', { mode: 0o600 });
    traces.push(trace);
  };
  const collectInference = (cell: string, caseId: string, traces: WorkerInferenceTrace[]) => (trace: WorkerInferenceTrace) => {
    fs.appendFileSync(`${output}.inference.jsonl`, JSON.stringify({ cell, caseId, trace }) + '\n', { mode: 0o600 });
    traces.push(trace);
  };
  const collectNative = (cell: string, caseId: string, traces: WorkerNativeInferenceTrace[]) => (trace: WorkerNativeInferenceTrace) => {
    fs.appendFileSync(`${output}.native-inference.jsonl`, JSON.stringify({ cell, caseId, trace }) + '\n', { mode: 0o600 });
    traces.push(trace);
  };
  let activeCell = 'tokenizer-load';
  try {
    const { Tokenizer } = await import('tokenizers');
    const tokenizer = Tokenizer.fromFile(path.join(request.export, 'tokenizer.json'));
    tokenizer.setTruncation(8192);
    for (const item of selected.cases) {
      const i = request.cases.findIndex((c) => c.id === item.id); activeCell = `single-${item.id}`;
      const inputIds = (await tokenizer.encode(`${item.kind}: ${item.text}`)).getIds();
      const inputTraces: WorkerInputTrace[] = [];
      const inferenceTraces: WorkerInferenceTrace[] = [];
      const nativeInferenceTraces: WorkerNativeInferenceTrace[] = [];
      const vector = await buildMdenseOnEmbedder({ kind: item.kind, model: request.export,
        onInputTrace: collectInput(activeCell, item.id, inputTraces),
        onInferenceTrace: collectInference(activeCell, item.id, inferenceTraces),
        onNativeInferenceTrace: collectNative(activeCell, item.id, nativeInferenceTraces) })(item.text);
      const row = { id: item.id, inputIds, inputTraces, inferenceTraces, nativeInferenceTraces, vector, ...references[i], execution: embedExecutionTarget(), worker: getWorkerState() };
      rows.push(row);
      fs.writeFileSync(`${output}.${activeCell}.json`, JSON.stringify({ ...identity, ...row }), { flag: 'wx', mode: 0o600 });
      console.log('native boundary cell', activeCell, inputIds.length, row.execution.device);
      if (!row.execution.verified || row.execution.device !== device || !row.worker.alive || row.worker.disabled) throw new Error('native boundary device fallback');
      if (!matchesWorkerInput(inputTraces, request.export, references[i].referenceInputIds, device)) throw new Error('native boundary worker input evidence mismatch');
      if (!nativeInferenceTraceVerified(inputTraces, inferenceTraces, request.export, references[i].referenceInputIds, device)) {
        throw new Error('native boundary worker inference evidence mismatch');
      }
      if (!nativeRunTraceVerified(inputTraces, inferenceTraces, nativeInferenceTraces, request.export, references[i].referenceInputIds, device)) {
        throw new Error('native boundary synchronous Run evidence mismatch');
      }
      if (process.platform === 'linux' && !nativeRawClockTraceVerified(nativeInferenceTraces)) throw new Error('native boundary RAW clock evidence mismatch');
      if (process.platform === 'linux' && !nativeRuntimeTraceVerified(nativeInferenceTraces)) throw new Error('native boundary runtime evidence mismatch');
    }
    for (const batch of selected.batches) {
      activeCell = batch.id;
      // This is the same Promise.all of single-text calls as the HTTP sidecar,
      // not proof of a padded ONNX input tensor. Python retains that separate proof.
      const inputTracesByCase = batch.caseIds.map((id) => ({ id, traces: [] as WorkerInputTrace[] }));
      const inferenceTracesByCase = batch.caseIds.map((id) => ({ id, traces: [] as WorkerInferenceTrace[] }));
      const nativeInferenceTracesByCase = batch.caseIds.map((id) => ({ id, traces: [] as WorkerNativeInferenceTrace[] }));
      const vectors = await Promise.all(batch.caseIds.map((id, i) => {
        const item = request.cases.find((c) => c.id === id)!;
        return buildMdenseOnEmbedder({ kind: item.kind, model: request.export,
          onInputTrace: collectInput(activeCell, id, inputTracesByCase[i].traces),
          onInferenceTrace: collectInference(activeCell, id, inferenceTracesByCase[i].traces),
          onNativeInferenceTrace: collectNative(activeCell, id, nativeInferenceTracesByCase[i].traces) })(item.text);
      }));
      const comparisons = vectors.map((vector, i) => ({ id: batch.caseIds[i],
        ...referenceVectorComparison(vector, rows.find((r) => r.id === batch.caseIds[i])!.vector, 768) }));
      const result = { id: batch.id, submittedCaseIds: batch.caseIds, actualInferenceBatchSize: 1, vectors, comparisons, inputTracesByCase, inferenceTracesByCase, nativeInferenceTracesByCase,
        execution: embedExecutionTarget(), worker: getWorkerState(), passed: comparisons.every((c) => c.passed) };
      if (!result.execution.verified || result.execution.device !== device || !result.worker.alive || result.worker.disabled) throw new Error('native boundary batch fallback');
      if (!inputTracesByCase.every((item) => matchesWorkerInput(item.traces, request.export, rows.find((r) => r.id === item.id)!.referenceInputIds, device))) {
        throw new Error('native boundary request-group input evidence mismatch');
      }
      if (!inferenceTracesByCase.every((item, i) => nativeInferenceTraceVerified(inputTracesByCase[i].traces, item.traces,
        request.export, rows.find((r) => r.id === item.id)!.referenceInputIds, device))) throw new Error('native boundary request-group inference evidence mismatch');
      if (!nativeInferenceTracesByCase.every((item, i) => nativeRunTraceVerified(inputTracesByCase[i].traces,
        inferenceTracesByCase[i].traces, item.traces, request.export, rows.find((r) => r.id === item.id)!.referenceInputIds, device))) {
        throw new Error('native boundary request-group synchronous Run evidence mismatch');
      }
      if (process.platform === 'linux' && !nativeInferenceTracesByCase.every((item) => nativeRawClockTraceVerified(item.traces))) {
        throw new Error('native boundary request-group RAW clock evidence mismatch');
      }
      if (process.platform === 'linux' && !nativeInferenceTracesByCase.every(item=>nativeRuntimeTraceVerified(item.traces))) {
        throw new Error('native boundary request-group runtime evidence mismatch');
      }
      batches.push(result);
      fs.writeFileSync(`${output}.${batch.id}.json`, JSON.stringify({ ...identity, ...result }), { flag: 'wx', mode: 0o600 });
      console.log('native boundary request group', batch.id, 'single-text worker', result.passed);
    }
    const measured = summarizeNativeBoundaries(request, rows, device, selectedCell, batches);
    fs.writeFileSync(output, JSON.stringify({ ...identity, ...measured, batches, notChecked: ['native worker compute-kernel profile',
      'native padded/mixed ONNX tensors: worker accepts one text per call'] }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    fs.writeFileSync(`${output}.failure.json`, JSON.stringify({ ...identity, activeCell, completedSingles: rows.map((r) => r.id),
      completedBatches: batches, error: String(error), execution: embedExecutionTarget(), worker: getWorkerState() }), { flag: 'wx', mode: 0o600 });
    throw error;
  } finally { await shutdownLocalEmbedder(); }
}

type ReferenceCase = { id: string; kind: 'query' | 'document'; text: string; promptedText: string;
  inputIds: number[]; attentionMask: number[]; vector: number[]; shippedVector?: number[] };
type NativeReferenceArm = { model: 'gemma' | 'harrier'; profileId: string; tokenizerBackend: string;
  pooling: string; dimensions: number; cases: ReferenceCase[] };
export type NativeReference = { requestSha256: string; protocolSha256: string;
  identities: { model: 'gemma' | 'harrier'; profile: { profileId: string; nativeDims: number; pooling: string };
    files: { locator: string; sha256: string; bytes: number }[] }[];
  cases: { id: string; kind: 'query' | 'document'; text: string }[]; arms: NativeReferenceArm[] };
export type PythonReference = { nativeSha256: string; requestSha256: string; executionProvider: string;
  versions: Record<string, string>; thresholds: typeof REFERENCE_PARITY_LIMITS;
  arms: { model: string; profileId: string; tokenizerBackend: string;
    cases: { id: string; referenceTokenIds: number[]; referenceVector: number[] }[] }[] };

function referenceVectorComparison(actual: number[], expected: number[], dims: number) {
  for (const vector of [actual, expected]) {
    assertVector(vector, dims, 'reference');
    if (Math.abs(Math.hypot(...vector) - 1) > 2e-5) throw new Error('reference vector must be normalized');
  }
  const cosine = actual.reduce((sum, v, i) => sum + v * expected[i], 0);
  const maximumAbsoluteError = Math.max(...actual.map((v, i) => Math.abs(v - expected[i])));
  return { cosine, maximumAbsoluteError, passed: cosine >= REFERENCE_PARITY_LIMITS.minimumCosine
    && maximumAbsoluteError <= REFERENCE_PARITY_LIMITS.maximumAbsoluteError };
}

function referenceRanks(arm: NativeReferenceArm, vectors: number[][]) {
  const docs = arm.cases.flatMap((c, i) => c.kind === 'document' ? [{ id: c.id, vector: vectors[i] }] : []);
  return arm.cases.flatMap((c, i) => c.kind === 'query' ? [{ queryId: c.id, rankedDocIds: docs.map((d) => ({
    id: d.id, score: vectors[i].reduce((sum, v, j) => sum + v * d.vector[j], 0),
  })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((d) => d.id) }] : []);
}

/** Evidence joins are strict; measured parity failures remain visible outcomes.
 * Recompute comparisons from vectors rather than trusting a producer's PASS. */
export function summarizeIncumbentReferences(native: NativeReference, python: PythonReference) {
  if (native.requestSha256 !== python.requestSha256 || python.executionProvider !== 'CPUExecutionProvider'
    || JSON.stringify(python.thresholds) !== JSON.stringify(REFERENCE_PARITY_LIMITS)) throw new Error('reference execution/request contract mismatch');
  const expectedCases = INCUMBENT_REFERENCE_CASES.flatMap(([id, text]) => ['query', 'document'].map((kind) => ({ id: `${kind}-${id}`, kind, text })));
  if (JSON.stringify(native.cases) !== JSON.stringify(expectedCases)) throw new Error('reference controlled case coverage/order mismatch');
  const expectedArms = [
    { model: 'gemma', profileId: EMBEDDER_DIM_SPECS.gemma.profileId, backend: 'shipped-sdk' },
    { model: 'gemma', profileId: CORRECTED_GEMMA_REFERENCE_ID, backend: 'corrected-rust' },
    { model: 'harrier', profileId: EMBEDDER_DIM_SPECS.harrier.profileId, backend: 'shipped-sdk' },
  ];
  if (native.identities.length !== 2 || new Set(native.identities.map((i) => i.model)).size !== 2) throw new Error('reference model identity coverage mismatch');
  for (const model of ['gemma', 'harrier'] as const) {
    const identity = native.identities.find((i) => i.model === model), spec = EMBEDDER_DIM_SPECS[model];
    if (!identity || identity.profile.profileId !== spec.profileId || identity.profile.nativeDims !== spec.nativeDims
      || identity.profile.pooling !== spec.pooling || !['config.json', 'tokenizer.json', 'onnx/model.onnx'].every((name) => identity.files.some((f) => f.locator.endsWith(`/${name}`)))
      || !identity.files.every((f) => /^cache:(validation|transformers)\//.test(f.locator) && /^[a-f0-9]{64}$/.test(f.sha256) && f.bytes > 0)) throw new Error('reference pinned model asset contract mismatch');
  }
  if (!['numpy', 'onnxruntime', 'tokenizers', 'transformers'].every((name) => typeof python.versions[name] === 'string' && python.versions[name].length > 0)) throw new Error('reference runtime versions missing');
  if (native.arms.length !== 3 || python.arms.length !== 3
    || new Set(native.arms.map((a) => a.profileId)).size !== 3
    || new Set(python.arms.map((a) => a.profileId)).size !== 3) throw new Error('reference recipe identity collision/missing arm');
  const ids = expectedCases.map((c) => c.id);
  const arms = expectedArms.map((expected) => {
    const arm = native.arms.find((a) => a.profileId === expected.profileId);
    const reference = python.arms.find((a) => a.profileId === expected.profileId);
    const spec = EMBEDDER_DIM_SPECS[expected.model as 'gemma' | 'harrier'];
    if (!arm || !reference || arm.model !== expected.model || reference.model !== expected.model
      || arm.tokenizerBackend !== expected.backend || reference.tokenizerBackend !== expected.backend
      || arm.dimensions !== spec.nativeDims || arm.pooling !== spec.pooling) throw new Error('reference arm recipe mismatch');
    if (JSON.stringify(arm.cases.map((c) => c.id)) !== JSON.stringify(ids)
      || JSON.stringify(reference.cases.map((c) => c.id)) !== JSON.stringify(ids)) throw new Error('reference arm case coverage/order mismatch');
    const cases = arm.cases.map((c, i) => {
      const frozen = expectedCases[i], ref = reference.cases[i];
      const prompt = arm.model === 'gemma' ? gemmaPrompt(c.kind, c.text) : harrierPrompt(c.kind, c.text);
      if (c.kind !== frozen.kind || c.text !== frozen.text || c.promptedText !== prompt) throw new Error('reference prompt recipe mismatch');
      for (const tokens of [c.inputIds, ref.referenceTokenIds]) if (!tokens.length || !tokens.every((x) => Number.isInteger(x) && x >= 0)) throw new Error('invalid reference token IDs');
      if (c.attentionMask.length !== c.inputIds.length || !c.attentionMask.every((x) => x === 0 || x === 1)
        || !c.attentionMask.some(Boolean)) throw new Error('invalid reference attention mask');
      if ((expected.backend === 'shipped-sdk') !== Boolean(c.shippedVector)) throw new Error('reference shipped worker coverage mismatch');
      return { id: c.id, tokenIdsEqual: JSON.stringify(c.inputIds) === JSON.stringify(ref.referenceTokenIds),
        nativeParity: referenceVectorComparison(c.vector, ref.referenceVector, spec.nativeDims),
        shippedWorkerParity: c.shippedVector ? referenceVectorComparison(c.shippedVector, c.vector, spec.nativeDims) : null };
    });
    const ranks = referenceRanks(arm, arm.cases.map((c) => c.vector));
    const referenceRankings = referenceRanks(arm, reference.cases.map((c) => c.referenceVector));
    const exactRankAgreements = ranks.filter((r, i) => JSON.stringify(r) === JSON.stringify(referenceRankings[i])).length;
    return { model: expected.model, profileId: expected.profileId, tokenizerBackend: expected.backend,
      pooling: arm.pooling, dimensions: arm.dimensions, caseCount: cases.length,
      tokenMatches: cases.filter((c) => c.tokenIdsEqual).length,
      minimumCosine: Math.min(...cases.map((c) => c.nativeParity.cosine)),
      maximumAbsoluteError: Math.max(...cases.map((c) => c.nativeParity.maximumAbsoluteError)),
      passed: cases.every((c) => c.tokenIdsEqual && c.nativeParity.passed && c.shippedWorkerParity?.passed !== false),
      rankings: { queryCount: ranks.length, exactRankAgreements, native: ranks, reference: referenceRankings }, cases };
  });
  const shipped = native.arms.find((a) => a.profileId === expectedArms[0].profileId)!;
  const corrected = native.arms.find((a) => a.profileId === CORRECTED_GEMMA_REFERENCE_ID)!;
  const effects = shipped.cases.map((c, i) => ({ id: c.id,
    tokensChanged: JSON.stringify(c.inputIds) !== JSON.stringify(corrected.cases[i].inputIds),
    ...referenceVectorComparison(c.vector, corrected.cases[i].vector, 768) }));
  return { formatVersion: 1, protocolSha256: native.protocolSha256, requestSha256: native.requestSha256,
    executionProvider: python.executionProvider, referenceVersions: python.versions, thresholds: REFERENCE_PARITY_LIMITS,
    arms, correctedGemmaEffect: { population: effects.length, changedTokenCases: effects.filter((c) => c.tokensChanged).map((c) => c.id),
      minimumCosine: Math.min(...effects.map((c) => c.cosine)), maximumAbsoluteError: Math.max(...effects.map((c) => c.maximumAbsoluteError)),
      rankingQueriesChanged: arms[0].rankings.native.filter((r, i) => JSON.stringify(r) !== JSON.stringify(arms[1].rankings.native[i])).map((r) => r.queryId), cases: effects },
    limitation: 'Controlled tokenizer/runtime qualification: eight texts in query/document forms. No corpus-wide defect-absence or relevance claim.' };
}

export function summarizeIncumbentReferenceFiles(nativeFile: string, pythonFile: string) {
  const bytes = (p: string) => fs.readFileSync(p), hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
  const nativeBytes = bytes(nativeFile), pythonBytes = bytes(pythonFile), requestBytes = bytes(`${nativeFile}.request.json`);
  const native = JSON.parse(nativeBytes.toString()), python = JSON.parse(pythonBytes.toString()), request = JSON.parse(requestBytes.toString());
  if (hash(nativeBytes) !== python.nativeSha256 || hash(requestBytes) !== native.requestSha256) throw new Error('reference raw artifact fingerprint mismatch');
  for (const key of ['protocolSha256', 'ownerId', 'execution', 'identities', 'cases']) {
    if (JSON.stringify(native[key]) !== JSON.stringify(request[key])) throw new Error('reference frozen request drift');
  }
  if (native.execution.device !== 'cpu' || native.execution.dtype !== 'fp32') throw new Error('reference execution must be explicit CPU/fp32');
  return { ...summarizeIncumbentReferences(native, python), nativeSha256: hash(nativeBytes), pythonSha256: hash(pythonBytes),
    assets: native.identities.map((i: NativeReference['identities'][number]) => ({ model: i.model, profile: i.profile,
      files: i.files.map((f) => ({ locator: f.locator, sha256: f.sha256, bytes: f.bytes })) })) };
}

/** Portable dossier locators resolve only in the declared local caches. */
export function referenceAssetPath(locator: string, repo: string, home = os.homedir()): string {
  const match = /^cache:(validation|transformers)\/(.+)$/.exec(locator);
  if (!match || match[2].split('/').some((part) => !part || part === '.' || part === '..') || match[2].includes('\\')) throw new Error('invalid portable reference asset locator');
  const root = match[1] === 'validation' ? path.join(home, '.cache/papercusp/model-validation')
    : path.join(repo, 'node_modules/@huggingface/transformers/.cache');
  return path.join(root, match[2]);
}

/** Freeze requests/assets before any forward pass, then qualify shipped worker
 * vectors and a distinct corrected Gemma arm. Consumed by the maintained Python
 * ONNX/tokenizer reference mode in mdenseon-vectors.py. No production registration. */
export async function qualifyIncumbentReferences(protocolFile: string, expectedSha: string, outputFile: string): Promise<void> {
  const hash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || hash(protocolFile) !== expectedSha) throw new Error('reference protocol SHA mismatch');
  const protocol = JSON.parse(fs.readFileSync(protocolFile, 'utf8'));
  if (protocol.plan !== 'mdenseon-adoption-measurements-2026-10-01' || protocol.ownerId !== process.env.PAPERCUSP_SID) throw new Error('reference protocol owner/plan mismatch');
  if (embedRequestedExecution().device !== 'cpu') throw new Error('reference qualification requires explicit CPU; no fallback');
  const { output, repo } = nativeBenchmarkOutputPaths(outputFile);
  const identities = ['gemma', 'harrier'].map((model) => {
    const arm = protocol.modelIdentities.find((a: any) => a.model === model);
    if (!arm || arm.profile.nativeDims !== (model === 'gemma' ? 768 : 1024)) throw new Error('reference native profile mismatch');
    const files = arm.files.map((asset: any) => ({ ...asset, locator: asset.path, path: referenceAssetPath(asset.path, repo) }));
    for (const asset of files) if (hash(asset.path) !== asset.sha256 || fs.statSync(asset.path).size !== asset.bytes) throw new Error('reference asset fingerprint mismatch');
    const directory = path.dirname(files.find((a: any) => path.basename(a.path) === 'config.json').path);
    return { ...arm, files, directory };
  });
  const cases = INCUMBENT_REFERENCE_CASES.flatMap(([id, text]) => ['query', 'document'].map((kind) => ({ id: `${kind}-${id}`, kind, text })));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const request = { formatVersion: 1, protocolSha256: expectedSha, frozenAt: new Date().toISOString(), ownerId: process.env.PAPERCUSP_SID,
    execution: { device: 'cpu', dtype: 'fp32', ...ORT_SESSION_OPTIONS }, identities, cases };
  fs.writeFileSync(`${output}.request.json`, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const { AutoTokenizer, PreTrainedModel, Tensor } = await import('@huggingface/transformers');
  const { Tokenizer } = await import('tokenizers');
  const report: any = { ...request, requestSha256: hash(`${output}.request.json`), arms: [] };
  try {
    for (const identity of identities) {
      const tokenizer = await AutoTokenizer.from_pretrained(identity.directory, { local_files_only: true });
      const model = await PreTrainedModel.from_pretrained(identity.directory, { local_files_only: true, device: 'cpu', dtype: 'fp32', session_options: ORT_SESSION_OPTIONS });
      try {
        const rust = await Tokenizer.fromFile(path.join(identity.directory, 'tokenizer.json'));
        const maxLength = Number(tokenizer.model_max_length);
        if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('invalid declared tokenizer limit');
        await rust.setTruncation(maxLength);
        for (const backend of identity.model === 'gemma' ? ['shipped-sdk', 'corrected-rust'] : ['shipped-sdk']) {
          const arm: any = { model: identity.model, profileId: backend === 'corrected-rust' ? CORRECTED_GEMMA_REFERENCE_ID : identity.profile.profileId,
            tokenizerBackend: backend, pooling: identity.profile.pooling, dimensions: identity.profile.nativeDims, cases: [] };
          for (const item of cases) {
            const text = identity.model === 'gemma' ? gemmaPrompt(item.kind as 'query' | 'document', item.text) : harrierPrompt(item.kind as 'query' | 'document', item.text);
            let ids: number[], mask: number[];
            if (backend === 'corrected-rust') {
              const encoded = await rust.encode(text); ids = encoded.getIds(); mask = encoded.getAttentionMask();
            } else {
              const encoded = tokenizer(text, { padding: true, truncation: true });
              ids = Array.from(encoded.input_ids.data, Number); mask = Array.from(encoded.attention_mask.data, Number);
            }
            const inputs = { input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
              attention_mask: new Tensor('int64', BigInt64Array.from(mask, BigInt), [1, mask.length]) };
            const outputs = await model(inputs);
            const vector = identity.model === 'harrier' ? Array.from(outputs.sentence_embedding.data, Number)
              : mrlTruncate(benchmarkMaskedMean(outputs.last_hidden_state.data, mask, 768), 768);
            assertVector(vector, identity.profile.nativeDims, arm.profileId);
            let shippedVector: number[] | undefined;
            if (backend === 'shipped-sdk') {
              const native = await embedViaWorker(text, { model: identity.profile.modelRevision,
                ...(identity.model === 'harrier' ? { output: 'sentence_embedding' } : { pooling: 'mean' as const, normalize: false }) });
              shippedVector = mrlTruncate(native, identity.profile.nativeDims);
              if (!getWorkerState().alive || getWorkerState().disabled) throw new Error('shipped worker not alive');
            }
            arm.cases.push({ ...item, promptedText: text, inputIds: ids, attentionMask: mask, vector, shippedVector });
          }
          report.arms.push(arm);
          fs.writeFileSync(`${output}.${arm.profileId.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`, JSON.stringify(arm), { flag: 'wx', mode: 0o600 });
        }
      } finally { await model.dispose(); await shutdownLocalEmbedder(); }
    }
    fs.writeFileSync(output, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
  } finally { await shutdownLocalEmbedder(); }
}

export const PPLX_MODEL = 'perplexity-ai/pplx-embed-v1-0.6b';
export const PPLX_REVISION = '2c4d510dd4a732063c31a0f70193e35067b51fd8';
export const PPLX_OUTPUT = 'pooler_output_int8';

/** The publisher's graph already performs bidirectional attention and mean pooling.
 * Its documented retrieval output is int8, NOT the token-level first output.
 * PreTrainedModel runs the encoder graph directly, avoiding AutoModel's unsupported
 * custom Python model type without substituting a causal Qwen implementation. */
export function buildPplxBenchmarkEmbedder(): (text: string) => Promise<number[]> {
  const load = async () => {
    const { AutoTokenizer, PreTrainedModel } = await import('@huggingface/transformers');
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(PPLX_MODEL, { revision: PPLX_REVISION }),
      PreTrainedModel.from_pretrained(PPLX_MODEL, {
        revision: PPLX_REVISION, device: 'cpu', dtype: 'fp32',
        session_options: ORT_SESSION_OPTIONS,
      }),
    ]);
    return { tokenizer, model };
  };
  let loaded: ReturnType<typeof load> | undefined;
  return async (text) => {
    const { tokenizer, model } = await (loaded ??= load());
    // The model card uses raw texts for BOTH queries and documents.
    const inputs = tokenizer(text, { padding: true, truncation: true, max_length: 32768 });
    const outputs = await model(inputs);
    const tensor = outputs[PPLX_OUTPUT];
    if (!tensor) throw new Error(`pplx missing ${PPLX_OUTPUT}; outputs: ${Object.keys(outputs).join(', ')}`);
    const vector = Array.from(tensor.data, Number);
    assertVector(vector, 1024, 'pplx');
    return vector;
  };
}

function assertVector(vector: number[], dims: number, label: string): void {
  if (vector.length !== dims || vector.some((x) => !Number.isFinite(x)) || !vector.some((x) => x !== 0)) {
    throw new Error(`${label}: expected a finite, nonzero ${dims}-dimensional vector`);
  }
}

export interface VectorSuite {
  corpusSha256: string;
  goldSha256: string;
  keys: string[];
  queryIds: string[];
  docVectors: number[][];
  queryVectors: number[][];
  docSeconds: number;
  querySeconds: number;
  peakRssMB: number;
}
export interface CandidateVectors {
  name: string;
  model: string;
  revision: string;
  runtime: string;
  dimensions: number;
  loadSeconds: number;
  assetBytes: number;
  suites: Partial<Record<'memory' | 'prose', VectorSuite>>;
}

/** Imported inference is scored by the SAME evaluator as the shipped builders.
 * Bind vectors to exact fixture bytes AND order, and refuse incomplete passes;
 * never time reading these cached vectors as though it were model inference. */
export function loadCandidateVectors(
  file: string,
  corpus: 'memory' | 'prose',
  corpusFile: string,
  goldFile: string,
  keys: string[],
  queryIds: string[],
): { manifest: CandidateVectors; suite: VectorSuite } {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as CandidateVectors;
  const suite = manifest.suites?.[corpus];
  if (!suite) throw new Error(`candidate vectors have no completed ${corpus} suite`);
  const hash = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (suite.corpusSha256 !== hash(corpusFile) || suite.goldSha256 !== hash(goldFile)) {
    throw new Error('candidate vectors fixture fingerprint mismatch');
  }
  if (JSON.stringify(suite.keys) !== JSON.stringify(keys) || JSON.stringify(suite.queryIds) !== JSON.stringify(queryIds)) {
    throw new Error('candidate vectors corpus/query order mismatch');
  }
  if (suite.docVectors.length !== keys.length || suite.queryVectors.length !== queryIds.length) {
    throw new Error('candidate vectors incomplete document/query pass');
  }
  if (!Number.isInteger(manifest.dimensions) || manifest.dimensions < 1) throw new Error('invalid candidate dimensions');
  for (const vector of [...suite.docVectors, ...suite.queryVectors]) assertVector(vector, manifest.dimensions, manifest.name);
  for (const n of [suite.docSeconds, suite.querySeconds, suite.peakRssMB]) {
    if (!Number.isFinite(n) || n <= 0) throw new Error('candidate vectors missing measured inference timing/footprint');
  }
  return { manifest, suite };
}
