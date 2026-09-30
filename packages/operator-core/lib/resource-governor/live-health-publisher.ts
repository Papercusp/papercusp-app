/** In-process publisher feeding the out-of-process live-health monitor. */

import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { platform } from 'node:os';
import { PerformanceObserver } from 'node:perf_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { currentLoopLag } from '../event-loop-lag-monitor';
import {
  LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
  liveHealthWindow,
  measuredLiveHealthReading,
  unknownLiveHealthReading,
  type LiveHealthFragment,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthWriter,
  type LiveHealthWriterKind,
} from './live-health';
import {
  LIVE_HEALTH_DEFAULT_CADENCE_MS,
  liveHealthFragmentPath,
  resolveLiveHealthPaths,
  writeLiveHealthJson,
  type LiveHealthPaths,
} from './live-health-monitor';

interface ProcessCounters {
  readonly atMs: number;
  readonly cpuMicros: number;
  readonly rssBytes: number;
  readonly minorFaults: number;
  readonly majorFaults: number;
}

export interface ProcessLiveHealthPublisherOptions {
  readonly paths?: LiveHealthPaths;
  readonly cadenceMs?: number;
  readonly now?: () => number;
  readonly pid?: number;
  readonly readCounters?: () => ProcessCounters;
  readonly readDescriptorCount?: () => Promise<number | null>;
  readonly writeFragment?: typeof writeLiveHealthJson;
  readonly readLoopLag?: typeof currentLoopLag;
  readonly allowTimerInTest?: boolean;
}

function percentile95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)] ?? null;
}

function processCounters(nowMs: number): ProcessCounters {
  const usage = process.resourceUsage();
  return {
    atMs: nowMs,
    cpuMicros: usage.userCPUTime + usage.systemCPUTime,
    rssBytes: process.memoryUsage.rss(),
    minorFaults: usage.minorPageFault,
    majorFaults: usage.majorPageFault,
  };
}

async function descriptorCount(pid = process.pid): Promise<number | null> {
  if (platform() !== 'linux') return null;
  try {
    return (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    return null;
  }
}

function deltaRate(current: number, previous: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || current < previous) return null;
  return ((current - previous) * 1_000) / elapsedMs;
}

function signedDeltaRate(current: number, previous: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0) return null;
  return ((current - previous) * 1_000) / elapsedMs;
}

function reading(
  key: LiveHealthSignalKey,
  writerId: string,
  value: number | null,
  nowMs: number,
  startMs: number,
  windowKind: 'instant' | 'delta' | 'rolling',
  reason: string,
): LiveHealthReading {
  const window = liveHealthWindow(windowKind, startMs, nowMs);
  return value === null
    ? unknownLiveHealthReading({ key, writerId, observedAtMs: nowMs, window, reason })
    : measuredLiveHealthReading({ key, writerId, observedAtMs: nowMs, window, value, confidence: 1 });
}

export class ProcessLiveHealthPublisher {
  readonly paths: LiveHealthPaths;
  readonly cadenceMs: number;
  readonly writer: LiveHealthWriter;
  readonly fragmentPath: string;
  private readonly now: () => number;
  private readonly readCounters: () => ProcessCounters;
  private readonly readDescriptorCount: () => Promise<number | null>;
  private readonly writeFragment: typeof writeLiveHealthJson;
  private readonly readLoopLag: typeof currentLoopLag;
  private readonly allowTimerInTest: boolean;
  private previous: ProcessCounters | null = null;
  private timer: ManagedHandle | null = null;
  private readonly gcDurationsMs: number[] = [];
  private readonly gcObserver: PerformanceObserver;

  constructor(options: ProcessLiveHealthPublisherOptions = {}) {
    this.paths = options.paths ?? resolveLiveHealthPaths();
    this.cadenceMs = Math.max(250, options.cadenceMs ?? LIVE_HEALTH_DEFAULT_CADENCE_MS);
    this.now = options.now ?? Date.now;
    const pid = options.pid ?? process.pid;
    this.writer = {
      id: `operator.process:${pid}`,
      kind: 'operator',
      instanceId: randomUUID(),
      pid,
      platform: platform(),
      startedAtMs: this.now(),
    };
    this.fragmentPath = liveHealthFragmentPath(this.paths, this.writer.id);
    this.readCounters = options.readCounters ?? (() => processCounters(this.now()));
    this.readDescriptorCount = options.readDescriptorCount ?? (() => descriptorCount(pid));
    this.writeFragment = options.writeFragment ?? writeLiveHealthJson;
    this.readLoopLag = options.readLoopLag ?? currentLoopLag;
    this.allowTimerInTest = options.allowTimerInTest ?? false;
    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (Number.isFinite(entry.duration) && entry.duration >= 0) this.gcDurationsMs.push(entry.duration);
      }
    });
  }

  async publishOnce(): Promise<LiveHealthFragment> {
    const current = this.readCounters();
    const previous = this.previous;
    const startMs = previous?.atMs ?? current.atMs;
    const elapsedMs = Math.max(0, current.atMs - startMs);
    const lag = this.readLoopLag();
    const descriptors = await this.readDescriptorCount();
    const gcP95 = percentile95(this.gcDurationsMs);
    this.gcDurationsMs.length = 0;

    const signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>> = {
      'progress.heartbeatLagMs': reading(
        'progress.heartbeatLagMs',
        this.writer.id,
        previous ? Math.max(0, elapsedMs - this.cadenceMs) : null,
        current.atMs,
        startMs,
        'delta',
        'publisher-warmup',
      ),
      'cpu.processUtilizationPct': reading(
        'cpu.processUtilizationPct',
        this.writer.id,
        previous && elapsedMs > 0
          ? deltaRate(current.cpuMicros, previous.cpuMicros, elapsedMs) === null
            ? null
            : deltaRate(current.cpuMicros, previous.cpuMicros, elapsedMs)! / 10_000
          : null,
        current.atMs,
        startMs,
        'delta',
        'publisher-warmup-or-counter-reset',
      ),
      'latency.eventLoopP95Ms': reading(
        'latency.eventLoopP95Ms',
        this.writer.id,
        lag?.p95Ms ?? null,
        current.atMs,
        lag ? current.atMs - lag.windowMs : current.atMs,
        'rolling',
        'event-loop-monitor-unavailable',
      ),
      'memory.workingSetBytes': reading(
        'memory.workingSetBytes',
        this.writer.id,
        current.rssBytes,
        current.atMs,
        current.atMs,
        'instant',
        'rss-unavailable',
      ),
      'memory.workingSetGrowthBytesPerSec': reading(
        'memory.workingSetGrowthBytesPerSec',
        this.writer.id,
        previous ? signedDeltaRate(current.rssBytes, previous.rssBytes, elapsedMs) : null,
        current.atMs,
        startMs,
        'delta',
        'publisher-warmup-or-working-set-decrease',
      ),
      'memory.gcPauseP95Ms': reading(
        'memory.gcPauseP95Ms',
        this.writer.id,
        gcP95,
        current.atMs,
        startMs,
        'delta',
        'no-gc-observed-in-window',
      ),
      'memory.minorFaultsPerSec': reading(
        'memory.minorFaultsPerSec',
        this.writer.id,
        previous ? deltaRate(current.minorFaults, previous.minorFaults, elapsedMs) : null,
        current.atMs,
        startMs,
        'delta',
        'publisher-warmup-or-counter-reset',
      ),
      'memory.majorFaultsPerSec': reading(
        'memory.majorFaultsPerSec',
        this.writer.id,
        previous ? deltaRate(current.majorFaults, previous.majorFaults, elapsedMs) : null,
        current.atMs,
        startMs,
        'delta',
        'publisher-warmup-or-counter-reset',
      ),
      'descriptor.openCount': reading(
        'descriptor.openCount',
        this.writer.id,
        descriptors,
        current.atMs,
        current.atMs,
        'instant',
        platform() === 'linux' ? 'procfs-descriptors-unavailable' : `unsupported-on-${platform()}`,
      ),
    };
    const fragment: LiveHealthFragment = {
      schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
      publishedAtMs: current.atMs,
      writer: this.writer,
      signals,
    };
    await this.writeFragment(this.fragmentPath, fragment);
    this.previous = current;
    return fragment;
  }

  async start(): Promise<LiveHealthFragment> {
    if (this.timer) return this.publishOnce();
    try {
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
      // Unsupported runtimes retain an explicit unknown GC reading.
    }
    const first = await this.publishOnce();
    // Literal name, NOT a per-pid template. `instanced: true` below is exactly the
    // mechanism for many live timers under one name — it gives each arm a unique
    // internal key and AGGREGATES them into a single inventory row. The pid suffix
    // therefore bought nothing and cost two things: it defeated that aggregation,
    // and a computed name is undeclarable to the recovery-dependency audit, which
    // reads this argument TEXTUALLY (balanced-paren, like
    // scripts/check-timer-classification.mjs) and can only verify a literal.
    // Keep this comment ABOVE the call: anything between `managedSetInterval(` and
    // the name makes that extraction fail the same way a template did.
    this.timer = managedSetInterval(
      'resource-governor-live-health-publisher',
      this.cadenceMs,
      async () => {
        try {
          await this.publishOnce();
        } catch (error) {
          console.warn(
            '[resource-governor-health] process publisher failed:',
            error instanceof Error ? error.message : error,
          );
        }
      },
      // D-004: must-sample — this publishes a MEASURED reading of this process's own
      // health (event-loop lag, GC observations). Nothing emits those; sampling is the
      // only way they come into existence.
      { category: 'watchdog', classification: 'must-sample', instanced: true, allowInTest: this.allowTimerInTest },
    );
    return first;
  }

  async stop(): Promise<void> {
    this.timer?.stop();
    this.timer = null;
    this.gcObserver.disconnect();
    await unlink(this.fragmentPath).catch(() => {});
  }
}

interface PublisherSingletonState {
  publisher: ProcessLiveHealthPublisher | null;
  starting: Promise<ProcessLiveHealthPublisher> | null;
}

const singleton = pinModuleState(
  '@papercusp/operator-core.resource-governor-live-health-publisher',
  () =>
    ({
      publisher: null,
      starting: null,
    }) as PublisherSingletonState,
);

/** Idempotent across duplicate ESM/CJS module records. */
export function startProcessLiveHealthPublisher(
  options: ProcessLiveHealthPublisherOptions = {},
): Promise<ProcessLiveHealthPublisher> {
  if (singleton.publisher) return Promise.resolve(singleton.publisher);
  if (singleton.starting) return singleton.starting;
  const publisher = new ProcessLiveHealthPublisher(options);
  singleton.starting = publisher
    .start()
    .then(() => {
      singleton.publisher = publisher;
      return publisher;
    })
    .finally(() => {
      singleton.starting = null;
    });
  return singleton.starting;
}

export async function stopProcessLiveHealthPublisher(): Promise<void> {
  const publisher = singleton.publisher;
  singleton.publisher = null;
  singleton.starting = null;
  await publisher?.stop();
}

/** Shared typed writer seam for DB/provider/queue/governor instrumentation. */
export async function publishLiveHealthFragment(args: {
  writerId: string;
  writerKind: Exclude<LiveHealthWriterKind, 'monitor' | 'operator'>;
  signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>>;
  paths?: LiveHealthPaths;
  nowMs?: number;
  instanceId?: string;
}): Promise<LiveHealthFragment> {
  const nowMs = args.nowMs ?? Date.now();
  const writer: LiveHealthWriter = {
    id: args.writerId,
    kind: args.writerKind,
    instanceId: args.instanceId ?? args.writerId,
    pid: process.pid,
    platform: platform(),
    startedAtMs: nowMs,
  };
  const fragment: LiveHealthFragment = {
    schemaVersion: LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION,
    publishedAtMs: nowMs,
    writer,
    signals: args.signals,
  };
  const paths = args.paths ?? resolveLiveHealthPaths();
  await writeLiveHealthJson(liveHealthFragmentPath(paths, writer.id), fragment);
  return fragment;
}

export function _resetProcessLiveHealthPublisherForTests(): void {
  singleton.publisher = null;
  singleton.starting = null;
}
