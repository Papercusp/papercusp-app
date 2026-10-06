/** P-005 extension of embedder-eval-cli's isolated HTTP route. Synthetic tests
 * qualify this collector; only fresh, manifest-bound real-model cells qualify
 * performance. No timings here are retrieval-quality or adoption evidence. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { channel } from 'node:diagnostics_channel';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { sidecarEmbedBatch, SIDECAR_MAX_TEXT_CHARS, buildGemmaEmbedder, buildHarrierEmbedder, type SidecarEmbedResponse } from '@papercusp/memory';
import type { EmbedderBuilders } from '../embed-sidecar-server';
import { assertMeasuredEmbedResponse, hashJson, validateMeasurementManifest, measurementOwner, fingerprintFile,
  type MeasurementArm, type PreparedMeasurement, type MeasurementManifest, type MeasurementCell } from './measurement-manifest';
import type { runGovernedOperation } from '../../resource-governor/execution';

const request = z.strictObject({ id: z.string().min(1), corpus: z.enum(['memory', 'prose']),
  text: z.string().min(1).max(SIDECAR_MAX_TEXT_CHARS) });
export const performanceInputSchema = z.strictObject({
  formatVersion: z.literal(1), seed: z.string().min(1), blocks: z.number().int().min(5).max(20),
  warmSamples: z.number().int().min(2).max(10000), rounds: z.number().int().min(1).max(100),
  batches: z.array(z.number().int().min(1).max(256)).min(1),
  concurrency: z.array(z.number().int().min(1).max(16)).min(1),
  cachedSamples: z.number().int().min(1).max(100), serverConcurrency: z.number().int().min(1).max(16),
  requests: z.strictObject({ query: z.array(request).min(1), document: z.array(request).min(1) }),
});
export type PerformanceInput = z.infer<typeof performanceInputSchema>;
/** Diagnostic-only observer. It changes neither the pool nor server policy,
 * logs no text/body/auth headers, and joins client sends to server lifecycle
 * by TCP ports. An ECONNRESET alone does not identify which actor closed it. */
export function observeSidecarTransport(server: Server, url: string,
  record: (event: Record<string, unknown>) => void): () => void {
  const origin = new URL(url).origin, port = Number(new URL(url).port);
  let active = true;
  const emit = (event: string, details: Record<string, unknown>) => {
    if (active) record({ at: new Date().toISOString(), event, ...details });
  };
  const sockets = new Map<Socket, { timeout: () => void; close: () => void; error: (error: Error & { code?: string }) => void }>();
  const connection = (socket: Socket) => {
    const ports = { clientPort: socket.remotePort, serverPort: socket.localPort };
    emit('server-connect', ports);
    const timeout = () => emit('server-idle-timeout', { ...ports, socketTimeoutMs: socket.timeout,
      keepAliveTimeoutMs: server.keepAliveTimeout, keepAliveTimeoutBufferMs: server.keepAliveTimeoutBuffer });
    const close = () => { emit('server-close', ports); sockets.delete(socket); };
    const error = (error: Error & { code?: string }) => emit('server-error', { ...ports, code: error.code });
    sockets.set(socket, { timeout, close, error });
    socket.on('timeout', timeout).once('close', close).on('error', error);
  };
  const request = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const ports = { clientPort: req.socket.remotePort, serverPort: req.socket.localPort };
    emit('server-request', { ...ports, method: req.method, path: (req.url ?? '').split('?')[0] });
    res.once('finish', () => emit('server-response', { ...ports, status: res.statusCode }));
  };
  server.on('connection', connection).on('request', request);
  type NativeMessage = { socket?: Socket; request?: { origin?: string | URL; method?: string; path?: string };
    error?: Error & { code?: string; cause?: { code?: string } } };
  // request:error has no socket. Retain the send's ports by request identity
  // so a reset can still be joined to the server's timeout/close events.
  const requestPorts = new WeakMap<NonNullable<NativeMessage['request']>, { clientPort?: number; serverPort?: number }>();
  const listeners = [['undici:client:connected', 'client-connect'], ['undici:client:sendHeaders', 'client-send'],
    ['undici:request:error', 'client-error']].map(([name, event]) => {
    const listener = (message: unknown) => {
      const data = message as NativeMessage;
      if (data.socket ? data.socket.remotePort !== port : String(data.request?.origin ?? '').replace(/\/$/, '') !== origin) return;
      const ports = data.socket ? { clientPort: data.socket.localPort, serverPort: data.socket.remotePort }
        : data.request ? requestPorts.get(data.request) : undefined;
      if (data.request && ports) requestPorts.set(data.request, ports);
      emit(event, { ...ports,
        method: data.request?.method, path: data.request?.path?.split('?')[0],
        errorName: data.error?.name, code: data.error?.code, causeCode: data.error?.cause?.code });
    };
    const source = channel(name); source.subscribe(listener); return { source, listener };
  });
  return () => {
    active = false;
    server.off('connection', connection).off('request', request);
    for (const [socket, handlers] of sockets) {
      socket.off('timeout', handlers.timeout).off('close', handlers.close).off('error', handlers.error);
    }
    sockets.clear();
    for (const { source, listener } of listeners) source.unsubscribe(listener);
  };
}
/** Supplying candidate builders replaces the sidecar defaults. Keep the two
 * shipped incumbents in the same map so the matching route actually admits
 * every scheduled arm. The native seam lets HTTP tests exercise this exact
 * CLI configuration without loading weights. */
export function isolatedEvaluationBuilders(candidate: EmbedderBuilders[string], native: Pick<EmbedderBuilders, 'gemma' | 'harrier'> = {
  gemma: async (kind) => buildGemmaEmbedder({ kind }), harrier: async (kind) => buildHarrierEmbedder({ kind }),
}): EmbedderBuilders { return { ...native, mdenseon: candidate }; }
export function performanceSchedule(seed: string, blocks: number, arms: string[]) {
  if (!Number.isInteger(blocks) || blocks < 5 || new Set(arms).size !== arms.length || arms.length < 3) {
    throw new Error('performance requires five blocks and distinct candidate/incumbent arms');
  }
  // Seeded hash sorting is independent of measured outcomes and reproducible.
  return Array.from({ length: blocks }, (_, block) => [...arms].sort((a, b) =>
    hashJson([seed, block, a]).localeCompare(hashJson([seed, block, b]))).map((armId, order) =>
    ({ block, order, armId, cellId: `performance-b${block}-${armId}` }))).flat();
}
export function loadPerformanceInput(p: PreparedMeasurement): PerformanceInput {
  const ref = p.cell.parameters.requests;
  if (p.cell.bar !== 'performance' || typeof ref !== 'string' || !p.cell.inputIds.includes(ref)) throw new Error('missing declared performance requests');
  const pin = p.manifest.inputs[ref], bytes = fs.readFileSync(pin.path);
  if (bytes.length !== pin.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('performance input fingerprint mismatch');
  const input = performanceInputSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (input.seed !== p.manifest.seed || input.blocks !== p.manifest.contracts.freshProcessBlocks) throw new Error('performance block/seed contract mismatch');
  for (const ns of [input.batches, input.concurrency]) if (new Set(ns).size !== ns.length) throw new Error('duplicate performance grid value');
  for (const kind of ['query', 'document'] as const) {
    if (new Set(input.requests[kind].map((r) => r.id)).size !== input.requests[kind].length) throw new Error('duplicate performance request id');
  }
  const schedule = performanceSchedule(input.seed, input.blocks, p.manifest.arms.map((a) => a.id));
  const declared = p.manifest.cells.filter((c) => c.bar === 'performance');
  if (declared.length !== schedule.length || schedule.some((s) => !declared.some((c) => c.id === s.cellId
    && c.armId === s.armId && c.parameters.block === s.block && c.parameters.order === s.order && c.parameters.requests === ref))) {
    throw new Error('incomplete/mismatched randomized performance population');
  }
  return input;
}

export function latencySummary(values: number[]) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error('invalid/empty raw latency population');
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { n: values.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
    method: 'nearest-rank', minMs: sorted[0], maxMs: sorted.at(-1)! };
}
type Kind = 'query' | 'document';
export interface PerformanceSample {
  phase: 'cold' | 'warm' | 'batch' | 'cache-prime' | 'cached'; kind: Kind;
  sequence: number; requestIds: string[]; batchSize: number; concurrency: number;
  latencyMs: number; startedAt: string; cache: NonNullable<SidecarEmbedResponse['cache']>;
  runtime: string; modelRev: string; dims: number; vectorsSha256: string;
}
function validateResponse(arm: MeasurementArm, response: SidecarEmbedResponse, n: number, cached: boolean): void {
  if (cached) {
    if (response.cache?.hits !== n || response.cache.coalesced !== 0 || response.cache.inferred !== 0) throw new Error('cached request accounting mismatch');
    // Same vector/space guard; only the separately verified accounting differs.
    assertMeasuredEmbedResponse(arm, { ...response, cache: { hits: 0, coalesced: 0, inferred: n } }, n);
  } else assertMeasuredEmbedResponse(arm, response, n);
}
export async function collectSidecarPerformance(url: string, arm: MeasurementArm, input: PerformanceInput,
  options: { processStartedAtMs: number; onSample?: (sample: PerformanceSample) => void | Promise<void>;
    onPhase?: (phase: string) => void } = { processStartedAtMs: Date.now() }) {
  const samples: PerformanceSample[] = [];
  const rssSamples = [{ at: new Date().toISOString(), bytes: process.memoryUsage().rss }];
  const interval = setInterval(() => rssSamples.push({ at: new Date().toISOString(), bytes: process.memoryUsage().rss }), 100);
  const groups: Array<{ kind: Kind; batchSize: number; concurrency: number; sampleIndices: number[]; wallMs: number; textsPerSecond: number }> = [];
  let sequence = 0;
  const call = async (phase: PerformanceSample['phase'], kind: Kind, offset: number, batchSize: number, concurrency: number) => {
    const rows = Array.from({ length: batchSize }, (_, i) => input.requests[kind][(offset + i) % input.requests[kind].length]);
    const startedAt = new Date().toISOString(), start = performance.now(), seq = sequence++;
    const response = await sidecarEmbedBatch(url, { model: arm.model, kind, texts: rows.map((r) => r.text),
      bypassCache: phase !== 'cached' && phase !== 'cache-prime', timeoutMs: 180000 }).catch((cause: unknown) => {
      throw Object.assign(new Error(`performance request failed: ${phase} ${kind} ${batchSize}x${concurrency} sequence=${seq}`, { cause }),
        { request: { phase, kind, sequence: seq, model: arm.model, requestIds: rows.map((r) => r.id), batchSize, concurrency, startedAt } });
    });
    // HTTP/client latency stops on the full response, before collector hashing.
    const latencyMs = performance.now() - start;
    validateResponse(arm, response, batchSize, phase === 'cached');
    const sample: PerformanceSample = { phase, kind, sequence: seq, requestIds: rows.map((r) => r.id), batchSize, concurrency,
      startedAt, latencyMs, cache: response.cache!, runtime: response.runtime, modelRev: response.modelRev, dims: response.dims,
      vectorsSha256: hashJson(response.vectors) };
    // Retain each response before advancing. Async retention also lets native
    // socket expiry/close callbacks run after slow collector bookkeeping.
    const index = samples.length; samples.push(sample); await options.onSample?.(sample); return index;
  };
  try {
    options.onPhase?.('cold');
    const firstStart = Date.now();
    await call('cold', 'query', 0, 1, 1);
    const processToFirstResponseMs = Date.now() - options.processStartedAtMs;
    await call('cold', 'document', 0, 1, 1);
    const firstRequestStartedAfterProcessMs = firstStart - options.processStartedAtMs;
    for (const kind of ['query', 'document'] as const) {
      options.onPhase?.(`warm-${kind}`);
      for (let i = 0; i < input.warmSamples; i++) await call('warm', kind, i, 1, 1);
      for (const batchSize of input.batches) for (const concurrency of input.concurrency) {
        options.onPhase?.(`batch-${kind}-${batchSize}x${concurrency}`);
        const start = performance.now(), indices: number[] = [];
        for (let round = 0; round < input.rounds; round++) {
          indices.push(...await Promise.all(Array.from({ length: concurrency }, (_, j) =>
            call('batch', kind, (round * concurrency + j) * batchSize, batchSize, concurrency))));
        }
        const wallMs = performance.now() - start;
        groups.push({ kind, batchSize, concurrency, sampleIndices: indices, wallMs,
          textsPerSecond: indices.length * batchSize * 1000 / wallMs });
      }
      options.onPhase?.(`cached-${kind}`);
      await call('cache-prime', kind, 0, 1, 1);
      for (let i = 0; i < input.cachedSamples; i++) await call('cached', kind, 0, 1, 1);
    }
    return { formatVersion: 1, pid: process.pid, transport: 'local-http-client-worker',
      processStartedAt: new Date(options.processStartedAtMs).toISOString(), firstRequestStartedAfterProcessMs, processToFirstResponseMs,
      coldDefinition: 'first query includes lazy worker/model construction; first document is a separate kind; process total includes startup and fingerprint checks',
      warm: Object.fromEntries((['query', 'document'] as const).map((kind) => [kind,
        latencySummary(samples.filter((s) => s.kind === kind && s.phase === 'warm').map((s) => s.latencyMs))])),
      cached: Object.fromEntries((['query', 'document'] as const).map((kind) => [kind,
        latencySummary(samples.filter((s) => s.kind === kind && s.phase === 'cached').map((s) => s.latencyMs))])),
      groups, samples, rssSamples,
      resource: { peakRssMiB: process.resourceUsage().maxRSS / 1024, maxRssUnits: 'Linux KiB converted to MiB; includes JS and ONNX worker in this process',
        gpuMemory: arm.execution.device === 'cpu' ? { status: 'not-applicable', reason: 'declared and verified CPU inference' }
          : { status: 'unmeasured', reason: 'CUDA memory probe required before CUDA performance acceptance' },
        artifactBytes: arm.artifacts.graph.bytes + arm.artifacts.tokenizer.bytes + arm.artifacts.config.bytes
          + arm.artifacts.weights.reduce((n, f) => n + f.bytes, 0), artifactScope: 'pinned graph, tokenizer, config and external weights' },
    };
  } finally { clearInterval(interval); }
}

type PerformanceReport = Awaited<ReturnType<typeof collectSidecarPerformance>>;
export interface PerformanceReceipt {
  manifestSha256: string; ownerId: string; cellId: string; armId: string; measuredAt: string;
  report: PerformanceReport & { block: number; order: number; execution: { device: string; verified: boolean }; workerState: { alive: boolean; disabled: boolean } };
}
/** Re-derive estimates from the exact raw population; a saved aggregate alone
 * cannot qualify five independent processes or complete grid coverage. */
export function summarizePerformanceReceipts(manifest: MeasurementManifest, manifestSha256: string,
  input: PerformanceInput, receipts: PerformanceReceipt[]) {
  const schedule = performanceSchedule(input.seed, input.blocks, manifest.arms.map((a) => a.id));
  if (receipts.length !== schedule.length || new Set(receipts.map((r) => r.cellId)).size !== schedule.length
    || new Set(receipts.map((r) => r.report.pid)).size !== schedule.length) throw new Error('missing/duplicate/non-fresh performance cell');
  const cells = schedule.map((s) => {
    const receipt = receipts.find((r) => r.cellId === s.cellId), arm = manifest.arms.find((a) => a.id === s.armId)!;
    if (!receipt || receipt.ownerId !== manifest.ownerId || receipt.manifestSha256 !== manifestSha256 || receipt.armId !== arm.id
      || !receipt.measuredAt || receipt.report.block !== s.block || receipt.report.order !== s.order
      || !receipt.report.execution.verified || receipt.report.execution.device !== arm.execution.device
      || !receipt.report.workerState.alive || receipt.report.workerState.disabled) throw new Error('performance receipt identity/execution mismatch');
    const { report } = receipt;
    if (arm.execution.device !== 'cpu' || report.resource.gpuMemory.status !== 'not-applicable') throw new Error('unmeasured GPU performance resources');
    const expectedN = 2 + 2 * (input.warmSamples + input.cachedSamples + 1
      + input.rounds * input.batches.length * input.concurrency.reduce((n, c) => n + c, 0));
    if (report.samples.length !== expectedN || new Set(report.samples.map((r) => r.sequence)).size !== expectedN
      || report.samples.some((r) => r.sequence < 0 || r.sequence >= expectedN || !Number.isInteger(r.sequence)
        || r.modelRev !== arm.modelRev || r.runtime !== arm.runtime.wire || r.dims !== arm.profile.targetDims
        || !/^[a-f0-9]{64}$/.test(r.vectorsSha256) || r.requestIds.length !== r.batchSize
        || (r.phase === 'cached' ? r.cache.hits !== r.batchSize || r.cache.inferred !== 0 || r.cache.coalesced !== 0
          : r.cache.hits !== 0 || r.cache.inferred !== r.batchSize || r.cache.coalesced !== 0))) throw new Error('incomplete/invalid performance raw samples');
    if (report.samples.filter((r) => r.phase === 'cold').length !== 2) throw new Error('missing cold requests');
    for (const kind of ['query', 'document'] as const) {
      for (const [phase, n] of [['cold', 1], ['cache-prime', 1], ['cached', input.cachedSamples]] as const) {
        if (report.samples.filter((r) => r.kind === kind && r.phase === phase).length !== n) throw new Error('missing cold/cache samples');
      }
    }
    const warm = Object.fromEntries((['query', 'document'] as const).map((kind) => {
      const raw = report.samples.filter((r) => r.kind === kind && r.phase === 'warm');
      if (raw.length !== input.warmSamples) throw new Error('missing warm samples');
      return [kind, latencySummary(raw.map((r) => r.latencyMs))];
    }));
    if (hashJson(warm) !== hashJson(report.warm)) throw new Error('warm aggregate disagrees with raw samples');
    const cached = Object.fromEntries((['query', 'document'] as const).map((kind) => [kind,
      latencySummary(report.samples.filter((r) => r.kind === kind && r.phase === 'cached').map((r) => r.latencyMs))]));
    if (hashJson(cached) !== hashJson(report.cached)) throw new Error('cached aggregate disagrees with raw samples');
    if (!Number.isFinite(report.resource.peakRssMiB) || report.resource.peakRssMiB <= 0 || !report.rssSamples.length
      || report.rssSamples.some((r) => !Number.isFinite(r.bytes) || r.bytes <= 0)
      || report.resource.artifactBytes !== arm.artifacts.graph.bytes + arm.artifacts.tokenizer.bytes + arm.artifacts.config.bytes
        + arm.artifacts.weights.reduce((n, f) => n + f.bytes, 0)) throw new Error('missing/mismatched performance resource cost');
    if (report.groups.length !== 2 * input.batches.length * input.concurrency.length) throw new Error('incomplete performance grid');
    const indices = new Set<number>();
    for (const kind of ['query', 'document'] as const) for (const batchSize of input.batches) for (const concurrency of input.concurrency) {
      const groups = report.groups.filter((g) => g.kind === kind && g.batchSize === batchSize && g.concurrency === concurrency);
      if (groups.length !== 1) throw new Error('missing/duplicate performance grid cell');
      const g = groups[0];
      if (g.sampleIndices.length !== input.rounds * concurrency || !Number.isFinite(g.wallMs) || g.wallMs <= 0
        || Math.abs(g.textsPerSecond - g.sampleIndices.length * batchSize * 1000 / g.wallMs) > 1e-8) throw new Error('invalid performance grid throughput');
      for (const i of g.sampleIndices) {
        const raw = report.samples[i];
        if (indices.has(i) || !raw || raw.phase !== 'batch' || raw.kind !== kind || raw.batchSize !== batchSize || raw.concurrency !== concurrency) {
          throw new Error('unbound/duplicate performance group sample');
        }
        indices.add(i);
      }
    }
    if (indices.size !== report.samples.filter((r) => r.phase === 'batch').length) throw new Error('unaccounted batch samples');
    return { ...s, pid: report.pid, warm, cold: report.samples.filter((r) => r.phase === 'cold'),
      processToFirstResponseMs: report.processToFirstResponseMs, groups: report.groups, cached: report.cached, resource: report.resource,
      rawSamples: report.samples.length };
  });
  return { blocks: input.blocks, cells, randomizedSchedule: schedule, percentileMethod: 'nearest-rank',
    resourceScope: 'CPU process peak RSS includes JS/ONNX worker; GPU memory not applicable to verified CPU cells',
    throughputScope: 'group wall time includes client/HTTP/worker plus collector bookkeeping; request latency stops before sample hashing/logging',
    cacheScope: 'warm and grid inference bypass cache; separately primed cached requests require all hits and zero inference',
    performanceComplete: true, modelAdoptionAuthorized: false };
}

/** The parent admits model residency before starting the database-free child.
 * Artifact bytes are the initial estimate; the retained child receipt supplies
 * measured peak RSS when the lease settles. Governor setup stays lazy so merely
 * loading the local CLI never opens an operator database connection. */
export async function runPerformanceChild(input: {
  manifest: MeasurementManifest; manifestSha256: string; cell: MeasurementCell; arm: MeasurementArm;
  manifestFile: string; mdenseonModel: string; rawOutput: string; logFd: number;
}, deps: { governedOperation?: typeof runGovernedOperation; spawnProcess?: typeof spawn; workspaceId?: string } = {}) {
  const { runGovernedOperation, admissionContextFromEnvironment } = await import('../../resource-governor/execution');
  const { activeWorkspaceId } = await import('../../workspace-registry');
  const { manifest, manifestSha256, cell, arm } = input;
  // The declared evaluator can live in an immutable source artifact. Always
  // spawning this module's live sibling defeated that identity when a long
  // matrix crossed a shared-tree edit. Loader/config pins let the artifact
  // carry its own toolchain without inheriting a parent's tsx alias context.
  if (!manifest.inputs.evaluator || !cell.inputIds.includes('evaluator')) {
    throw new Error('performance child requires a declared evaluator');
  }
  const runtimeInput = (parameter: 'runtimeLoader' | 'runtimeTsconfig'): string | undefined => {
    const ref = cell.parameters[parameter];
    if (ref === undefined) return undefined;
    if (typeof ref !== 'string' || !cell.inputIds.includes(ref) || !manifest.inputs[ref]) {
      throw new Error(`undeclared performance ${parameter}`);
    }
    return path.resolve(manifest.inputs[ref].path);
  };
  const evaluator = path.resolve(manifest.inputs.evaluator.path);
  const loader = runtimeInput('runtimeLoader'), tsconfig = runtimeInput('runtimeTsconfig');
  const parent = admissionContextFromEnvironment(process.env.PAPERCUSP_ADMISSION_CONTEXT);
  const memoryBytes = [arm.artifacts.graph, arm.artifacts.tokenizer, arm.artifacts.config, ...arm.artifacts.weights]
    .reduce((n, file) => n + file.bytes, 0);
  const governed = deps.governedOperation ?? runGovernedOperation;
  return governed({ workspaceId: deps.workspaceId ?? activeWorkspaceId(), namespace: 'embedding-performance',
    owner: manifest.ownerId, admissionClass: 'embedding', dedicatedClient: true,
    idempotencyKey: `embedding-performance:${manifestSha256}:${cell.id}`, payloadRef: `${manifest.plan}#P-005`,
    demand: { cpuWeight: arm.execution.intraOpThreads, memoryBytes }, ...(parent ? { parent } : {}),
    metadata: { model: arm.model, cellId: cell.id, device: arm.execution.device, memoryEstimate: 'pinned-artifact-bytes' },
    measureActualDemand: () => {
      const receipt = JSON.parse(fs.readFileSync(input.rawOutput, 'utf8'));
      const peakRssMiB = receipt.report?.resource?.peakRssMiB;
      if (receipt.manifestSha256 !== manifestSha256 || receipt.ownerId !== manifest.ownerId || receipt.cellId !== cell.id
        || receipt.armId !== arm.id || !Number.isFinite(peakRssMiB) || peakRssMiB <= 0) {
        throw new Error('missing/unbound performance child resource receipt');
      }
      return { cpuWeight: arm.execution.intraOpThreads, memoryBytes: Math.ceil(peakRssMiB * 1024 * 1024) };
    },
  }, async (context) => {
    // Admission can queue before spawn. Recheck the complete declared source
    // and input population after that wait and before any child executes it.
    for (const ref of cell.inputIds) {
      const declared = manifest.inputs[ref];
      if (!declared) throw new Error(`undeclared performance input: ${ref}`);
      const actual = await fingerprintFile(path.resolve(declared.path));
      if (actual.sha256 !== declared.sha256 || actual.bytes !== declared.bytes) {
        throw new Error(`performance child input fingerprint mismatch: ${ref}`);
      }
    }
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = (deps.spawnProcess ?? spawn)(process.execPath,
        // The child runs a TS file; parent eval/stdin/Vitest flags are not a
        // valid file launch context. Use the benchmark's existing tsx loader.
        ['--import', loader ? pathToFileURL(loader).href : 'tsx', evaluator,
          '--manifest', input.manifestFile, '--manifest-sha256', manifestSha256, '--cell', cell.id,
          '--legs', `sidecar:${cell.armId}`, '--isolated-sidecar', '--mdenseon-model', input.mdenseonModel,
          ...(cell.parameters.transportTrace === true ? ['--transport-trace'] : []), '--out', input.rawOutput],
        { stdio: ['ignore', input.logFd, input.logFd], env: { ...process.env,
          ...(tsconfig ? { TSX_TSCONFIG_PATH: tsconfig } : {}), PAPERCUSP_FORBID_REAL_PG: '1',
          PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(context) } });
      child.once('error', reject); child.once('exit', resolve);
    });
    if (exitCode !== 0) throw new Error(`performance child failed ${cell.id}: exit ${exitCode}; see immutable cell log`);
    return exitCode;
  });
}

/** Existing CLI owns the only entry point. Each scheduled arm is a fresh child
 * process; immutable receipts/logs prevent replaying a completed/failed cell. */
export async function runPerformanceBlocks(manifestFile: string, expectedSha: string, mdenseonModel: string, driverFile: string) {
  const bytes = fs.readFileSync(manifestFile);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedSha) throw new Error('performance manifest fingerprint mismatch');
  const m = validateMeasurementManifest(JSON.parse(bytes.toString('utf8')));
  if (m.ownerId !== measurementOwner()) throw new Error('performance driver owner mismatch');
  const first = m.cells.find((c) => c.bar === 'performance');
  if (!first) throw new Error('no performance cells');
  const input = loadPerformanceInput({ manifest: m, cell: first } as PreparedMeasurement);
  // Admit the complete route population before the first expensive process.
  const admitted = new Set(Object.keys(isolatedEvaluationBuilders(async () => async () => [])));
  if (m.arms.some((a) => !admitted.has(a.model))) throw new Error('performance arm has no isolated HTTP builder');
  const schedule = performanceSchedule(input.seed, input.blocks, m.arms.map((a) => a.id));
  const root = path.join(fs.realpathSync(m.privateRoot), m.runId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (path.dirname(path.resolve(driverFile)) !== fs.realpathSync(root)) throw new Error('driver receipt must be inside the private run root');
  const startedAt = new Date().toISOString();
  const state = { manifestSha256: expectedSha, ownerId: m.ownerId, pid: process.pid, startedAt, status: 'running', current: '', completed: [] as string[] };
  fs.writeFileSync(driverFile, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
  const update = () => fs.writeFileSync(driverFile, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const receipts: PerformanceReceipt[] = [], rawArtifacts = [];
  try {
    for (const s of schedule) {
      const cell = m.cells.find((c) => c.id === s.cellId)!, raw = path.join(root, `${cell.output}.json`);
      if (!fs.existsSync(raw)) {
        if (fs.existsSync(`${raw}.running`) || fs.existsSync(`${raw}.failure.json`)) throw new Error(`attempt already started/failed: ${cell.id}`);
        state.current = cell.id; update();
        const log = fs.openSync(`${raw}.log`, 'wx', 0o600);
        try {
          await runPerformanceChild({ manifest: m, manifestSha256: expectedSha, cell,
            arm: m.arms.find((a) => a.id === cell.armId)!, manifestFile, mdenseonModel, rawOutput: raw, logFd: log });
        } finally { fs.closeSync(log); }
      }
      const receipt = JSON.parse(fs.readFileSync(raw, 'utf8')) as PerformanceReceipt;
      receipts.push(receipt); rawArtifacts.push(await fingerprintFile(raw));
      state.completed.push(cell.id); state.current = ''; update();
      console.log(`[performance-block] ${cell.id} complete (${state.completed.length}/${schedule.length})`);
    }
    const summary = summarizePerformanceReceipts(m, expectedSha, input, receipts);
    const output = path.join(root, 'performance-summary.json');
    fs.writeFileSync(output, JSON.stringify({ formatVersion: 1, ownerId: m.ownerId, manifestSha256: expectedSha,
      measuredAt: new Date().toISOString(), rawArtifacts, summary }, null, 2), { flag: 'wx', mode: 0o600 });
    state.status = 'completed'; update(); return output;
  } catch (e) { state.status = 'failed'; update(); throw e; }
}

/** A queued/running snapshot is never a prerequisite for another model matrix.
 * Re-read terminal state and bind the saved summary to every immutable raw
 * receipt before permitting the next launch. This performs no inference. */
export async function verifyCompletedPerformanceRun(manifestFile: string, expectedSha: string) {
  if ((await fingerprintFile(manifestFile)).sha256 !== expectedSha) throw new Error('predecessor manifest fingerprint mismatch');
  const manifest = validateMeasurementManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  if (manifest.ownerId !== measurementOwner()) throw new Error('predecessor owner mismatch');
  const first = manifest.cells.find((cell) => cell.bar === 'performance');
  if (!first) throw new Error('predecessor has no performance cells');
  const input = loadPerformanceInput({ manifest, cell: first } as PreparedMeasurement);
  const schedule = performanceSchedule(input.seed, input.blocks, manifest.arms.map((arm) => arm.id));
  const root = path.join(fs.realpathSync(manifest.privateRoot), manifest.runId);
  const driverFile = path.join(root, 'driver.json'), summaryFile = path.join(root, 'performance-summary.json');
  const driver = JSON.parse(fs.readFileSync(driverFile, 'utf8'));
  if (driver.status !== 'completed' || driver.current || driver.ownerId !== manifest.ownerId
    || driver.manifestSha256 !== expectedSha || hashJson(driver.completed) !== hashJson(schedule.map((cell) => cell.cellId))) {
    throw new Error('predecessor performance matrix is not complete');
  }
  const saved = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  if (saved.ownerId !== manifest.ownerId || saved.manifestSha256 !== expectedSha
    || !Array.isArray(saved.rawArtifacts) || saved.rawArtifacts.length !== schedule.length) {
    throw new Error('predecessor summary identity/population mismatch');
  }
  const receipts: PerformanceReceipt[] = [];
  for (const scheduled of schedule) {
    const cell = manifest.cells.find((candidate) => candidate.id === scheduled.cellId)!;
    const raw = path.join(root, `${cell.output}.json`);
    const pin = saved.rawArtifacts.find((candidate: { path: string }) => candidate.path === raw);
    if (!pin || hashJson(pin) !== hashJson(await fingerprintFile(raw))) throw new Error('predecessor raw receipt fingerprint mismatch');
    receipts.push(JSON.parse(fs.readFileSync(raw, 'utf8')) as PerformanceReceipt);
  }
  const derived = summarizePerformanceReceipts(manifest, expectedSha, input, receipts);
  if (hashJson(derived) !== hashJson(saved.summary)) throw new Error('predecessor summary disagrees with raw receipts');
  return { manifestSha256: expectedSha, driver: await fingerprintFile(driverFile), summary: await fingerprintFile(summaryFile),
    cells: schedule.length, inferencePerformed: false };
}
