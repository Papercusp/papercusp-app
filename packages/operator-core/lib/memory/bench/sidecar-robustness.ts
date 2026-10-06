/** P-007 robustness collector for embedder-eval-cli's isolated HTTP route.
 *
 * Drives a REAL sidecar (createEmbedSidecarServer) through concurrency, queue
 * saturation, cache coalescing/bypass, client timeouts, cancellation, forced
 * embed-worker termination/restart and a bounded soak. Every request's raw
 * outcome is retained so the verdict is RE-DERIVED from samples by
 * summarizeRobustnessReport, never trusted from a saved aggregate.
 *
 * Synthetic integration runs qualify this collector; only a real-weight run
 * qualifies a model. Nothing here is retrieval-quality or adoption evidence.
 *
 * Timers: one setTimeout chain for /healthz sampling (no bare setInterval).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { z } from 'zod';
import { sidecarEmbedBatch, SidecarEmbedHttpError, SIDECAR_MAX_TEXT_CHARS, type SidecarEmbedResponse } from '@papercusp/memory';
import { fingerprintFile, hashJson } from './measurement-manifest';
import { latencySummary } from './sidecar-performance';

const row = z.strictObject({ id: z.string().min(1), text: z.string().min(1).max(SIDECAR_MAX_TEXT_CHARS) });
const ms = z.number().int().positive();
export const robustnessInputSchema = z.strictObject({
  formatVersion: z.literal(1), seed: z.string().min(1),
  serverConcurrency: z.number().int().min(1).max(16),
  /** Client deadline for every request that is not deliberately timed out. */
  requestTimeoutMs: ms,
  requests: z.strictObject({ query: z.array(row).min(2), document: z.array(row).min(2), long: row }),
  concurrency: z.strictObject({ clients: z.number().int().min(2).max(64), rounds: z.number().int().min(1).max(100) }),
  saturation: z.strictObject({ inFlight: z.number().int().min(2).max(256), deadlineMs: ms, drainWithinMs: ms }),
  coalescing: z.strictObject({ duplicates: z.number().int().min(2).max(64) }),
  timeout: z.strictObject({ clientDeadlineMs: ms, recoveryWithinMs: ms }),
  cancellation: z.strictObject({ requests: z.number().int().min(1).max(32), abortAfterMs: ms,
    releaseWithinMs: ms, drainWithinMs: ms }),
  crash: z.strictObject({ cycles: z.number().int().min(1).max(10), inFlight: z.number().int().min(1).max(32),
    startWithinMs: ms, settleWithinMs: ms, recoveryWithinMs: ms }),
  soak: z.strictObject({ durationMs: z.number().int().min(1000), clients: z.number().int().min(1).max(32),
    windowFraction: z.number().min(0.1).max(0.5) }),
  sampling: z.strictObject({ healthzIntervalMs: z.number().int().min(20).max(5000), healthzTimeoutMs: ms }),
  gates: z.strictObject({ cosineMin: z.number().min(0.9).max(1), maxAbs: z.number().min(0).max(0.01) }),
  thresholds: z.strictObject({ healthzP99Ms: ms, eventLoopDelayP99Ms: ms, soakLateP95Ratio: z.number().min(1),
    rssGrowthMiB: z.number().positive(), timeoutSlackMs: ms }),
});
export type RobustnessInput = z.infer<typeof robustnessInputSchema>;

export function parseRobustnessInput(value: unknown): RobustnessInput {
  const input = robustnessInputSchema.parse(value);
  const ids = [...input.requests.query, ...input.requests.document, input.requests.long].map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate robustness request id');
  if (input.timeout.clientDeadlineMs >= input.requestTimeoutMs) throw new Error('timeout phase deadline must be below the ordinary request deadline');
  if (input.cancellation.abortAfterMs >= input.requestTimeoutMs) throw new Error('cancellation must abort before the ordinary request deadline');
  return input;
}

/** The identity every successful response must carry — the requested recipe. */
export interface RobustnessIdentity { model: string; modelRev: string; runtime: string; dims: number }

const pin = z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().nonnegative() });
const frozenArmsSchema = z.object({ arms: z.array(z.object({
  id: z.string().min(1), model: z.string().min(1), modelRev: z.string().min(1),
  runtime: z.object({ wire: z.string().min(1) }), profile: z.object({ targetDims: z.number().int().positive() }),
  artifacts: z.object({ graph: pin, tokenizer: pin, config: pin, weights: z.array(pin) }),
})).min(1) });
export type RobustnessModel = 'mdenseon' | 'gemma' | 'harrier';
const sha256Of = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Bind a real-weight robustness run to a FROZEN measurement arm. The expected
 * wire identity comes from the frozen arm, never from the server under test,
 * and every pinned artifact must be byte-identical at the path the running
 * tree's builder loads. Incumbent artifacts were pinned inside a frozen
 * runtime-source tree, so they are relocated onto `repoRoot` by their
 * tree-relative path; the candidate must live under `--mdenseon-model`. */
export async function loadRobustnessRun(opts: { inputPath: string; inputSha256: string; armManifestPath: string;
  armManifestSha256: string; model: RobustnessModel; repoRoot: string; mdenseonModelDir?: string; runtime: string }) {
  const inputBytes = fs.readFileSync(opts.inputPath);
  if (sha256Of(inputBytes) !== opts.inputSha256) throw new Error('robustness input fingerprint mismatch');
  const input = parseRobustnessInput(JSON.parse(inputBytes.toString('utf8')));
  const manifestBytes = fs.readFileSync(opts.armManifestPath);
  if (sha256Of(manifestBytes) !== opts.armManifestSha256) throw new Error('frozen arm manifest fingerprint mismatch');
  const arm = frozenArmsSchema.parse(JSON.parse(manifestBytes.toString('utf8'))).arms
    .find((a) => a.id === opts.model && a.model === opts.model);
  if (!arm) throw new Error(`frozen manifest has no ${opts.model} arm`);
  if (arm.runtime.wire !== opts.runtime) throw new Error(`frozen ${opts.model} arm wire ${arm.runtime.wire} is not the server runtime ${opts.runtime}`);
  const candidateDir = opts.model === 'mdenseon'
    ? (opts.mdenseonModelDir ? fs.realpathSync(opts.mdenseonModelDir) : undefined) : undefined;
  if (opts.model === 'mdenseon' && !candidateDir) throw new Error('mdenseon robustness requires the candidate model directory');
  const relocate = (pinned: string) => {
    if (candidateDir) {
      if (!path.resolve(pinned).startsWith(`${candidateDir}${path.sep}`)) throw new Error(`frozen mdenseon artifact ${pinned} is outside ${candidateDir}`);
      return pinned;
    }
    const inTree = /\/runtime-source-v\d+\/tree\/(node_modules\/.+)$/.exec(pinned);
    return inTree ? path.join(opts.repoRoot, inTree[1]) : pinned;
  };
  const named: Array<[string, z.infer<typeof pin>]> = [['graph', arm.artifacts.graph], ['tokenizer', arm.artifacts.tokenizer],
    ['config', arm.artifacts.config], ...arm.artifacts.weights.map((w, i) => [`weights[${i}]`, w] as [string, z.infer<typeof pin>])];
  const artifacts = [];
  for (const [role, frozen] of named) {
    const loadedPath = relocate(frozen.path);
    const actual = await fingerprintFile(loadedPath);
    if (actual.sha256 !== frozen.sha256 || actual.bytes !== frozen.bytes) {
      throw new Error(`${opts.model} ${role} at ${loadedPath} differs from its frozen pin`);
    }
    artifacts.push({ role, pinnedPath: frozen.path, loadedPath, sha256: frozen.sha256, bytes: frozen.bytes });
  }
  const expected: RobustnessIdentity = { model: arm.model, modelRev: arm.modelRev, runtime: arm.runtime.wire, dims: arm.profile.targetDims };
  return { input, expected,
    inputPin: { path: opts.inputPath, sha256: opts.inputSha256, bytes: inputBytes.length },
    armPin: { manifestPath: opts.armManifestPath, manifestSha256: opts.armManifestSha256, armId: arm.id, artifacts } };
}

export const ROBUSTNESS_PHASES = ['reference', 'concurrency', 'saturation', 'coalescing', 'bypass',
  'timeout', 'cancellation', 'crash', 'soak'] as const;
export type RobustnessPhase = (typeof ROBUSTNESS_PHASES)[number];
type Kind = 'query' | 'document';
type Outcome = 'ok' | 'http-error' | 'timeout' | 'aborted' | 'network-error';

export interface RobustnessSample {
  phase: RobustnessPhase; role: 'reference' | 'load' | 'probe'; cycle?: number;
  sequence: number; kind: Kind; requestId: string; bypassCache: boolean; timeoutMs: number;
  /** Milliseconds since collection start (performance clock). */
  startedAtMs: number; settledAtMs: number; latencyMs: number;
  outcome: Outcome; status?: number; error?: string;
  cache?: NonNullable<SidecarEmbedResponse['cache']>;
  modelRev?: string; runtime?: string; dims?: number;
  /** Deviation from the serial reference vector of the same text. */
  cosine?: number; maxAbs?: number; vectorSha256?: string;
}
export interface HealthSample {
  phase: RobustnessPhase; atMs: number; rttMs: number; ok: boolean; status?: number; error?: string;
  queue?: { depth: number; active: number }; embedderWorker?: { alive: boolean; disabled: boolean };
  rssBytes: number;
}
export interface WorkerStateView { alive: boolean; disabled: boolean; pendingCount: number }
export interface RobustnessDeps {
  /** Forcefully terminate the embed worker while inference is in flight. */
  crashWorker: () => Promise<void>;
  workerState: () => WorkerStateView;
  /** Server-side open work requests (EmbedSidecarHandle.activity). */
  activity: () => { inFlight: number };
  onPhase?: (phase: RobustnessPhase, edge: 'start' | 'end') => void;
  onSample?: (sample: RobustnessSample) => void | Promise<void>;
}

const sleep = (msDelay: number) => new Promise<void>((resolve) => { setTimeout(resolve, msDelay); });

function compare(reference: number[], vector: number[]): { cosine: number; maxAbs: number } {
  if (reference.length !== vector.length) return { cosine: -1, maxAbs: Infinity };
  let dot = 0, a = 0, b = 0, maxAbs = 0;
  for (let i = 0; i < vector.length; i++) {
    dot += reference[i] * vector[i]; a += reference[i] ** 2; b += vector[i] ** 2;
    maxAbs = Math.max(maxAbs, Math.abs(reference[i] - vector[i]));
  }
  return { cosine: dot / Math.sqrt(a * b), maxAbs };
}

async function readHealth(url: string, timeoutMs: number) {
  const start = performance.now();
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json() as { queue?: { depth: number; active: number };
      workers?: { embedder?: { alive: boolean; disabled: boolean } } };
    return { rttMs: performance.now() - start, ok: res.ok, status: res.status,
      queue: body.queue ? { depth: body.queue.depth, active: body.queue.active } : undefined,
      embedderWorker: body.workers?.embedder ? { alive: body.workers.embedder.alive, disabled: body.workers.embedder.disabled } : undefined };
  } catch (error) {
    return { rttMs: performance.now() - start, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Poll until the server queue is empty AND nothing is running, within a bound. */
async function waitForDrain(url: string, withinMs: number, healthTimeoutMs: number) {
  const start = performance.now();
  for (;;) {
    const h = await readHealth(url, healthTimeoutMs);
    if (h.queue && h.queue.depth === 0 && h.queue.active === 0) return { drained: true, afterMs: performance.now() - start };
    if (performance.now() - start >= withinMs) return { drained: false, afterMs: performance.now() - start, last: h.queue };
    await sleep(25);
  }
}

export async function collectSidecarRobustness(url: string, expected: RobustnessIdentity, input: RobustnessInput, deps: RobustnessDeps) {
  const t0 = performance.now(), startedAt = new Date().toISOString();
  const now = () => performance.now() - t0;
  const samples: RobustnessSample[] = [], health: HealthSample[] = [];
  const eventLoop: Partial<Record<RobustnessPhase, { p50Ms: number; p99Ms: number; maxMs: number }>> = {};
  const references = new Map<string, number[]>();
  let phase: RobustnessPhase = 'reference', sequence = 0;

  // /healthz sampler: a setTimeout chain so a slow probe never overlaps itself.
  let sampling = true, tickTimer: NodeJS.Timeout | undefined, tickInFlight: Promise<void> | undefined;
  const tick = () => {
    tickInFlight = (async () => {
      const at = now(), h = await readHealth(url, input.sampling.healthzTimeoutMs);
      health.push({ phase, atMs: at, ...h, rssBytes: process.memoryUsage().rss });
    })().finally(() => { if (sampling) tickTimer = setTimeout(tick, input.sampling.healthzIntervalMs); });
  };
  tick();

  const call = async (role: RobustnessSample['role'], kind: Kind, r: { id: string; text: string },
    opts: { bypassCache: boolean; timeoutMs: number; signal?: AbortSignal; cycle?: number; referenceKey?: string }) => {
    const seq = sequence++, start = now();
    const base = { phase, role, ...(opts.cycle === undefined ? {} : { cycle: opts.cycle }), sequence: seq, kind,
      requestId: r.id, bypassCache: opts.bypassCache, timeoutMs: opts.timeoutMs, startedAtMs: start };
    let sample: RobustnessSample;
    try {
      const response = await sidecarEmbedBatch(url, { model: expected.model, kind, texts: [r.text],
        bypassCache: opts.bypassCache, timeoutMs: opts.timeoutMs, signal: opts.signal });
      const settled = now(), vector = response.vectors[0], key = opts.referenceKey ?? `${kind}:${r.id}`;
      if (role === 'reference') references.set(key, vector);
      const reference = references.get(key);
      sample = { ...base, settledAtMs: settled, latencyMs: settled - start, outcome: 'ok', cache: response.cache,
        modelRev: response.modelRev, runtime: response.runtime, dims: response.dims,
        ...(reference ? compare(reference, vector) : {}), vectorSha256: hashJson(vector) };
    } catch (error) {
      const settled = now();
      const outcome: Outcome = opts.signal?.aborted ? 'aborted'
        : error instanceof SidecarEmbedHttpError ? 'http-error'
          : error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? 'timeout' : 'network-error';
      sample = { ...base, settledAtMs: settled, latencyMs: settled - start, outcome,
        ...(error instanceof SidecarEmbedHttpError ? { status: error.status } : {}),
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
    samples.push(sample); await deps.onSample?.(sample);
    return sample;
  };
  const probe = (cycle?: number) => call('probe', 'query', input.requests.query[0],
    { bypassCache: true, timeoutMs: input.requestTimeoutMs, cycle });
  const runPhase = async <T>(name: RobustnessPhase, body: () => Promise<T>): Promise<T> => {
    phase = name; deps.onPhase?.(name, 'start');
    const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
    try { return await body(); } finally {
      histogram.disable();
      eventLoop[name] = { p50Ms: histogram.percentile(50) / 1e6, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 };
      deps.onPhase?.(name, 'end');
    }
  };
  const ordinary = { bypassCache: true, timeoutMs: input.requestTimeoutMs };
  const coalesceRow = { id: `${input.requests.query[1].id}#coalesce`,
    text: `${input.requests.query[1].text} [robustness-coalesce ${input.seed}]` };

  try {
    const reference = await runPhase('reference', async () => {
      for (const kind of ['query', 'document'] as const) {
        for (const r of input.requests[kind]) await call('reference', kind, r, ordinary);
      }
      const long = await call('reference', 'document', input.requests.long, ordinary);
      await call('reference', 'query', coalesceRow, ordinary);
      const failed = samples.filter((s) => s.role === 'reference' && s.outcome !== 'ok');
      if (failed.length) throw new Error(`reference phase failed: ${failed.map((s) => `${s.requestId}:${s.error}`).join('; ')}`);
      return { longLatencyMs: long.latencyMs };
    });

    await runPhase('concurrency', async () => {
      for (let round = 0; round < input.concurrency.rounds; round++) {
        await Promise.all(Array.from({ length: input.concurrency.clients }, (_, j) => {
          const kind: Kind = j % 2 === 0 ? 'query' : 'document', rows = input.requests[kind];
          return call('load', kind, rows[(round * input.concurrency.clients + j) % rows.length], ordinary);
        }));
      }
    });

    const saturation = await runPhase('saturation', async () => {
      const start = now(), rows = input.requests.document;
      await Promise.all(Array.from({ length: input.saturation.inFlight }, (_, i) =>
        call('load', 'document', rows[i % rows.length], { bypassCache: true, timeoutMs: input.saturation.deadlineMs })));
      const burstWallMs = now() - start;
      const drain = await waitForDrain(url, input.saturation.drainWithinMs, input.sampling.healthzTimeoutMs);
      await probe();
      return { burstWallMs, drain };
    });

    await runPhase('coalescing', async () => {
      await Promise.all(Array.from({ length: input.coalescing.duplicates }, () =>
        call('load', 'query', coalesceRow, { bypassCache: false, timeoutMs: input.requestTimeoutMs, referenceKey: `query:${coalesceRow.id}` })));
    });
    await runPhase('bypass', async () => {
      await Promise.all(Array.from({ length: input.coalescing.duplicates }, () =>
        call('load', 'query', coalesceRow, { ...ordinary, referenceKey: `query:${coalesceRow.id}` })));
    });

    const timeout = await runPhase('timeout', async () => {
      await call('load', 'document', input.requests.long, { bypassCache: true, timeoutMs: input.timeout.clientDeadlineMs });
      const recovery = await waitForDrain(url, input.timeout.recoveryWithinMs, input.sampling.healthzTimeoutMs);
      await probe();
      return { referenceLongLatencyMs: reference.longLatencyMs, recovery };
    });

    const cancellation = await runPhase('cancellation', async () => {
      const controllers = Array.from({ length: input.cancellation.requests }, () => new AbortController());
      const pending = controllers.map((c) => call('load', 'document', input.requests.long,
        { ...ordinary, signal: c.signal }));
      await sleep(input.cancellation.abortAfterMs);
      const atAbort = await readHealth(url, input.sampling.healthzTimeoutMs);
      const abortedAtMs = now();
      for (const c of controllers) c.abort();
      await Promise.all(pending);
      let releaseMs: number | null = null;
      while (now() - abortedAtMs < input.cancellation.releaseWithinMs) {
        if (deps.activity().inFlight === 0) { releaseMs = now() - abortedAtMs; break; }
        await sleep(10);
      }
      const drain = await waitForDrain(url, input.cancellation.drainWithinMs, input.sampling.healthzTimeoutMs);
      const workerAfter = deps.workerState();
      await probe();
      return { atAbort: atAbort.queue ?? null, abortedAtMs, releaseMs, drain, workerAfter };
    });

    const crash = await runPhase('crash', async () => {
      const cycles = [];
      for (let cycle = 0; cycle < input.crash.cycles; cycle++) {
        const pending = Array.from({ length: input.crash.inFlight }, () =>
          call('load', 'document', input.requests.long, { ...ordinary, cycle }));
        // Crash only once inference has demonstrably reached the worker; a
        // crash before any work started would prove nothing about recovery.
        const waitStart = now();
        let startedBeforeCrash: { active: number; pending: number } | null = null;
        while (now() - waitStart < input.crash.startWithinMs) {
          const worker = deps.workerState(), h = await readHealth(url, input.sampling.healthzTimeoutMs);
          if (worker.pendingCount > 0 && (h.queue?.active ?? 0) > 0) { startedBeforeCrash = { active: h.queue!.active, pending: worker.pendingCount }; break; }
          await sleep(5);
        }
        const crashAtMs = now();
        await deps.crashWorker();
        const workerAfterCrash = deps.workerState();
        await Promise.all(pending);
        const recoveryProbe = await probe(cycle);
        cycles.push({ cycle, crashAtMs, startedBeforeCrash, workerAfterCrash, recoveryProbeSequence: recoveryProbe.sequence,
          workerAfterRecovery: deps.workerState() });
      }
      return cycles;
    });

    const soak = await runPhase('soak', async () => {
      const startedAtMs = now(), deadline = startedAtMs + input.soak.durationMs;
      await Promise.all(Array.from({ length: input.soak.clients }, async (_, client) => {
        for (let i = 0; now() < deadline; i++) {
          const kind: Kind = (client + i) % 2 === 0 ? 'query' : 'document', rows = input.requests[kind];
          await call('load', kind, rows[(client + i) % rows.length], ordinary);
        }
      }));
      return { startedAtMs, endedAtMs: now() };
    });

    sampling = false; clearTimeout(tickTimer); await tickInFlight;
    // Concurrent requests settle out of order; the report is keyed by issue order.
    samples.sort((a, b) => a.sequence - b.sequence);
    return { formatVersion: 1 as const, pid: process.pid, expected, inputSha256: hashJson(input), startedAt,
      finishedAt: new Date().toISOString(), samples, health, eventLoop,
      phases: { saturation, timeout, cancellation, crash, soak } };
  } finally { sampling = false; clearTimeout(tickTimer); await tickInFlight?.catch(() => {}); }
}
export type RobustnessReport = Awaited<ReturnType<typeof collectSidecarRobustness>>;

const p95 = (values: number[]) => latencySummary(values).p95Ms;
const p99 = (values: number[]) => latencySummary(values).p99Ms;

/** Re-derive the verdict from the raw population. Structural defects (a
 * missing phase, a wrong sample count, a duplicated sequence) THROW: such a
 * report cannot be graded at all. Behavioural defects are returned as named
 * failures so a real run that fails a bar is recorded, not lost. */
export function summarizeRobustnessReport(input: RobustnessInput, expected: RobustnessIdentity, report: RobustnessReport) {
  if (report.formatVersion !== 1 || report.inputSha256 !== hashJson(input) || hashJson(report.expected) !== hashJson(expected)) {
    throw new Error('robustness report input/identity binding mismatch');
  }
  const bySequence = new Map(report.samples.map((s) => [s.sequence, s]));
  if (bySequence.size !== report.samples.length || report.samples.some((_, i) => !bySequence.has(i))) {
    throw new Error('robustness samples are not one complete issue sequence');
  }
  for (const phase of ROBUSTNESS_PHASES) if (!report.eventLoop[phase]) throw new Error(`missing robustness phase ${phase}`);
  const failures: string[] = [];
  const fail = (message: string) => { failures.push(message); };
  const of = (phase: RobustnessPhase, role?: RobustnessSample['role']) =>
    report.samples.filter((s) => s.phase === phase && (role === undefined || s.role === role));
  const expectCount = (phase: RobustnessPhase, role: RobustnessSample['role'], n: number) => {
    if (of(phase, role).length !== n) throw new Error(`robustness ${phase}/${role} has ${of(phase, role).length} samples, expected ${n}`);
  };
  const { requests: rq } = input;
  expectCount('reference', 'reference', rq.query.length + rq.document.length + 2);
  expectCount('concurrency', 'load', input.concurrency.clients * input.concurrency.rounds);
  expectCount('saturation', 'load', input.saturation.inFlight);
  expectCount('coalescing', 'load', input.coalescing.duplicates);
  expectCount('bypass', 'load', input.coalescing.duplicates);
  expectCount('timeout', 'load', 1);
  expectCount('cancellation', 'load', input.cancellation.requests);
  expectCount('crash', 'load', input.crash.cycles * input.crash.inFlight);
  for (const phase of ['saturation', 'timeout', 'cancellation'] as const) expectCount(phase, 'probe', 1);
  expectCount('crash', 'probe', input.crash.cycles);
  if (report.phases.crash.length !== input.crash.cycles) throw new Error('missing crash cycle record');

  // Every successful response, in every phase, must be the requested recipe
  // and match its serial reference within the fixed gates.
  for (const s of report.samples) {
    if (s.outcome !== 'ok') continue;
    if (s.modelRev !== expected.modelRev || s.runtime !== expected.runtime || s.dims !== expected.dims) {
      fail(`identity drift in ${s.phase} seq ${s.sequence}: ${s.modelRev}/${s.runtime}/${s.dims}`);
    }
    if (s.role !== 'reference' && (s.cosine === undefined || s.maxAbs === undefined)) fail(`no reference comparison for ${s.phase} seq ${s.sequence}`);
    else if (s.role !== 'reference' && (s.cosine! < input.gates.cosineMin || s.maxAbs! > input.gates.maxAbs)) {
      fail(`vector drift in ${s.phase} seq ${s.sequence}: cosine ${s.cosine} maxAbs ${s.maxAbs}`);
    }
  }
  const allOk = (phase: RobustnessPhase, role: RobustnessSample['role']) => {
    const bad = of(phase, role).filter((s) => s.outcome !== 'ok');
    if (bad.length) fail(`${phase}/${role}: ${bad.length} non-ok (${[...new Set(bad.map((s) => s.outcome))].join(',')})`);
  };
  for (const phase of ['concurrency', 'saturation', 'coalescing', 'bypass', 'soak'] as const) allOk(phase, 'load');
  for (const phase of ['saturation', 'timeout', 'cancellation', 'crash'] as const) allOk(phase, 'probe');
  for (const s of of('concurrency', 'load')) if (s.outcome === 'ok' && s.cache?.inferred !== 1) fail(`concurrency seq ${s.sequence} did not pay inference`);

  const sat = of('saturation', 'load');
  if (sat.some((s) => s.latencyMs > input.saturation.deadlineMs)) fail('saturation request exceeded its deadline');
  if (!report.phases.saturation.drain.drained) fail('saturation queue did not drain within bound');

  const co = of('coalescing', 'load').filter((s) => s.outcome === 'ok');
  const sum = (key: 'hits' | 'coalesced' | 'inferred') => co.reduce((n, s) => n + (s.cache?.[key] ?? 0), 0);
  if (sum('inferred') !== 1) fail(`coalescing paid ${sum('inferred')} inferences for ${input.coalescing.duplicates} identical texts`);
  if (sum('hits') + sum('coalesced') + sum('inferred') !== input.coalescing.duplicates) fail('coalescing accounting does not partition the requests');
  for (const s of of('bypass', 'load')) {
    if (s.outcome === 'ok' && (s.cache?.inferred !== 1 || s.cache.hits !== 0 || s.cache.coalesced !== 0)) fail(`bypass seq ${s.sequence} was served without inference`);
  }

  const t = of('timeout', 'load')[0], timeout = report.phases.timeout;
  if (timeout.referenceLongLatencyMs <= input.timeout.clientDeadlineMs) fail('timeout phase is vacuous: the long request finishes before the client deadline');
  if (t.outcome !== 'timeout') fail(`timeout request outcome ${t.outcome}, expected timeout`);
  else if (Math.abs(t.latencyMs - input.timeout.clientDeadlineMs) > input.thresholds.timeoutSlackMs) fail(`timeout fired after ${t.latencyMs}ms, deadline ${input.timeout.clientDeadlineMs}ms`);
  if (!timeout.recovery.drained) fail('server did not drain after a client timeout');

  const cancel = report.phases.cancellation;
  const notAborted = of('cancellation', 'load').filter((s) => s.outcome !== 'aborted');
  if (notAborted.length) fail(`${notAborted.length} cancelled request(s) were not aborted (${notAborted.map((s) => s.outcome).join(',')})`);
  if (cancel.releaseMs === null) fail('server did not release cancelled requests within bound');
  if (!cancel.drain.drained) fail('server work did not drain after cancellation');
  if (!cancel.workerAfter.alive || cancel.workerAfter.disabled) fail('worker not alive/enabled after cancellation');

  for (const c of report.phases.crash) {
    if (!c.startedBeforeCrash) fail(`crash cycle ${c.cycle} fired before inference reached the worker (vacuous)`);
    // The crash took effect only if the worker was torn down AND its in-flight
    // work released. In-flight requests may then fail (classified 500) or be
    // rescued by a builder's declared inline fallback (gemma/harrier); a rescued
    // vector is still held to the identity/parity gates above, and its
    // event-loop cost to the per-phase responsiveness bar below.
    if (c.workerAfterCrash.alive || c.workerAfterCrash.pendingCount !== 0) {
      fail(`crash cycle ${c.cycle} did not tear down the worker and release its in-flight work (vacuous)`);
    }
    const load = of('crash', 'load').filter((s) => s.cycle === c.cycle);
    const late = load.filter((s) => s.settledAtMs - c.crashAtMs > input.crash.settleWithinMs);
    if (late.length) fail(`crash cycle ${c.cycle}: ${late.length} in-flight request(s) did not settle within ${input.crash.settleWithinMs}ms`);
    const failed = load.filter((s) => s.outcome !== 'ok');
    if (failed.some((s) => s.outcome !== 'http-error' || s.status !== 500)) fail(`crash cycle ${c.cycle}: an interrupted request failed other than with a classified 500`);
    const probeSample = bySequence.get(c.recoveryProbeSequence);
    if (!probeSample || probeSample.role !== 'probe' || probeSample.phase !== 'crash' || probeSample.cycle !== c.cycle) throw new Error('crash recovery probe is unbound');
    if (probeSample.settledAtMs - c.crashAtMs > input.crash.recoveryWithinMs) fail(`crash cycle ${c.cycle}: recovery took ${probeSample.settledAtMs - c.crashAtMs}ms`);
    if (!c.workerAfterRecovery.alive || c.workerAfterRecovery.disabled) fail(`crash cycle ${c.cycle}: worker not alive/enabled after recovery`);
  }

  const soak = report.phases.soak, soakLoad = of('soak', 'load');
  const window = (soak.endedAtMs - soak.startedAtMs) * input.soak.windowFraction;
  const early = soakLoad.filter((s) => s.startedAtMs < soak.startedAtMs + window && s.outcome === 'ok');
  const lateSoak = soakLoad.filter((s) => s.startedAtMs >= soak.endedAtMs - window && s.outcome === 'ok');
  let soakRatio: number | null = null, rssGrowthMiB: number | null = null;
  if (!early.length || !lateSoak.length) fail('soak windows are empty');
  else {
    soakRatio = p95(lateSoak.map((s) => s.latencyMs)) / p95(early.map((s) => s.latencyMs));
    if (soakRatio > input.thresholds.soakLateP95Ratio) fail(`soak late/early p95 ratio ${soakRatio.toFixed(3)} exceeds ${input.thresholds.soakLateP95Ratio}`);
  }
  const rssIn = (from: number, to: number) => report.health.filter((h) => h.atMs >= from && h.atMs <= to).map((h) => h.rssBytes);
  const rssEarly = rssIn(soak.startedAtMs, soak.startedAtMs + window), rssLate = rssIn(soak.endedAtMs - window, soak.endedAtMs);
  if (!rssEarly.length || !rssLate.length) fail('soak RSS windows are empty');
  else {
    const mean = (v: number[]) => v.reduce((n, x) => n + x, 0) / v.length;
    rssGrowthMiB = (mean(rssLate) - mean(rssEarly)) / (1024 * 1024);
    if (rssGrowthMiB > input.thresholds.rssGrowthMiB) fail(`soak RSS grew ${rssGrowthMiB.toFixed(1)} MiB`);
  }

  if (!report.health.length) fail('no /healthz samples');
  const badHealth = report.health.filter((h) => !h.ok);
  if (badHealth.length) fail(`${badHealth.length} /healthz sample(s) failed`);
  const healthP99 = report.health.length ? p99(report.health.map((h) => h.rttMs)) : null;
  if (healthP99 !== null && healthP99 > input.thresholds.healthzP99Ms) fail(`/healthz p99 ${healthP99.toFixed(1)}ms exceeds ${input.thresholds.healthzP99Ms}ms`);
  for (const phase of ROBUSTNESS_PHASES) {
    if (report.eventLoop[phase]!.p99Ms > input.thresholds.eventLoopDelayP99Ms) fail(`event-loop delay p99 ${report.eventLoop[phase]!.p99Ms.toFixed(1)}ms in ${phase}`);
  }

  const latency = (phase: RobustnessPhase) => {
    const ok = of(phase, 'load').filter((s) => s.outcome === 'ok').map((s) => s.latencyMs);
    return ok.length ? latencySummary(ok) : null;
  };
  return { verdict: failures.length ? 'fail' as const : 'pass' as const, failures,
    expected, samples: report.samples.length, healthSamples: report.health.length, healthzP99Ms: healthP99,
    latency: { concurrency: latency('concurrency'), saturation: latency('saturation'), soak: latency('soak') },
    soak: { lateEarlyP95Ratio: soakRatio, rssGrowthMiB, requests: soakLoad.length },
    crash: report.phases.crash.map((c) => ({ cycle: c.cycle, startedBeforeCrash: c.startedBeforeCrash,
      interrupted: of('crash', 'load').filter((s) => s.cycle === c.cycle && s.outcome !== 'ok').length,
      rescued: of('crash', 'load').filter((s) => s.cycle === c.cycle && s.outcome === 'ok').length,
      workerAfterCrash: c.workerAfterCrash,
      recoveredMs: bySequence.get(c.recoveryProbeSequence)!.settledAtMs - c.crashAtMs })),
    cancellation: { releaseMs: cancel.releaseMs, drainMs: cancel.drain.afterMs, atAbort: cancel.atAbort },
    // Reported, not gated: whole-process RSS by phase (a crash rescue that loads
    // a second, main-thread model copy shows up here, outside the soak window).
    rssMedianMiBByPhase: Object.fromEntries(ROBUSTNESS_PHASES.map((p) => {
      const v = report.health.filter((h) => h.phase === p).map((h) => h.rssBytes).sort((a, b) => a - b);
      return [p, v.length ? Math.round(v[Math.floor(v.length / 2)] / (1024 * 1024)) : null];
    })),
    eventLoop: report.eventLoop, modelAdoptionAuthorized: false as const };
}
