/**
 * Versioned live-health contract for the capless resource governor.
 *
 * The contract is deliberately verdict-free: P-004 records observations and
 * their epistemic quality; P-005 decides whether a pattern is degradation.
 * Utilisation, queue depth, or swap residency therefore cannot accidentally
 * become an admission threshold merely by appearing here.
 */

export const LIVE_HEALTH_SCHEMA_VERSION = 'resource-governor-live-health-v1' as const;
export const LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION = 'resource-governor-live-health-fragment-v1' as const;

export type LiveHealthPlatform = NodeJS.Platform;
export type LiveHealthWriterKind = 'monitor' | 'operator' | 'database' | 'service' | 'provider' | 'queue' | 'governor';

export type LiveHealthUnit =
  | 'boolean'
  | 'bytes'
  | 'bytes-per-second'
  | 'connections'
  | 'count'
  | 'count-per-second'
  | 'descriptors'
  | 'milliseconds'
  | 'percent'
  | 'requests-per-second';

export type LiveHealthValue = number | boolean;
export type LiveHealthReadingState = 'measured' | 'unknown' | 'stale';
export type LiveHealthWindowKind = 'instant' | 'delta' | 'rolling';

export interface LiveHealthWindow {
  readonly kind: LiveHealthWindowKind;
  /** Zero only for a genuinely instantaneous observation. */
  readonly durationMs: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface LiveHealthWriter {
  /** Stable within a writer lifetime; multiple operator processes use distinct ids. */
  readonly id: string;
  readonly kind: LiveHealthWriterKind;
  readonly instanceId: string;
  readonly pid: number | null;
  readonly platform: LiveHealthPlatform;
  readonly startedAtMs: number;
}

/**
 * One signal observation. Consumers MUST branch on `state` before `value`.
 * Unknown and stale readings carry null, never a fabricated healthy zero.
 */
export interface LiveHealthReading {
  readonly state: LiveHealthReadingState;
  readonly value: LiveHealthValue | null;
  readonly unit: LiveHealthUnit;
  readonly writerId: string;
  readonly observedAtMs: number;
  readonly collectedAtMs: number;
  readonly window: LiveHealthWindow;
  /** 0..1. Unknown is always 0; stale retains at most the source confidence. */
  readonly confidence: number;
  readonly reason: string | null;
  /** Timestamp of the last real observation when this reading is stale. */
  readonly lastMeasuredAtMs: number | null;
}

export interface LiveHealthSignalSpec {
  readonly unit: LiveHealthUnit;
  readonly writerKind: LiveHealthWriterKind;
  readonly windowKind: LiveHealthWindowKind;
  /** A newer merge turns the reading stale after this interval. */
  readonly freshForMs: number;
  readonly platforms: readonly (LiveHealthPlatform | 'all')[];
  readonly description: string;
}

/**
 * The complete P-004 signal vocabulary. `Object.keys` below derives the key
 * list, so schema enumeration cannot drift from the registry.
 */
export const LIVE_HEALTH_SIGNAL_SPECS = {
  'latency.monitorTickMs': {
    unit: 'milliseconds',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Wall time for the out-of-process monitor to collect and publish one snapshot.',
  },
  'progress.heartbeatLagMs': {
    unit: 'milliseconds',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Lateness of the operator process publisher relative to its declared cadence.',
  },
  'cpu.hostUtilizationPct': {
    unit: 'percent',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Busy CPU time divided by total CPU time over the sample window.',
  },
  'cpu.processUtilizationPct': {
    unit: 'percent',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Target process CPU time divided by wall time over the sample window; 100 is one logical core.',
  },
  'cpu.psiSomePct': {
    unit: 'percent',
    writerKind: 'monitor',
    windowKind: 'rolling',
    freshForMs: 90_000,
    platforms: ['linux'],
    description: 'Linux PSI CPU some avg60: time at least one runnable task waited for CPU.',
  },
  'scheduler.runnableCount': {
    unit: 'count',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Linux /proc/stat procs_running at the sampling instant.',
  },
  'scheduler.blockedCount': {
    unit: 'count',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Linux /proc/stat procs_blocked at the sampling instant.',
  },
  'latency.eventLoopP95Ms': {
    unit: 'milliseconds',
    writerKind: 'operator',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Operator libuv event-loop-delay histogram p95 over its published window.',
  },
  'memory.hostUsedBytes': {
    unit: 'bytes',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Host total memory minus free memory; an observation, never an admission threshold.',
  },
  'memory.workingSetBytes': {
    unit: 'bytes',
    writerKind: 'operator',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Operator process resident working set.',
  },
  'memory.workingSetGrowthBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Change in operator resident working set divided by elapsed sample time.',
  },
  'memory.psiSomePct': {
    unit: 'percent',
    writerKind: 'monitor',
    windowKind: 'rolling',
    freshForMs: 90_000,
    platforms: ['linux'],
    description: 'Linux PSI memory some avg60.',
  },
  'memory.psiFullPct': {
    unit: 'percent',
    writerKind: 'monitor',
    windowKind: 'rolling',
    freshForMs: 90_000,
    platforms: ['linux'],
    description: 'Linux PSI memory full avg60: time all non-idle tasks stalled on reclaim.',
  },
  'memory.gcPauseP95Ms': {
    unit: 'milliseconds',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'P95 duration of V8 GC observations during the publisher window.',
  },
  'memory.minorFaultsPerSec': {
    unit: 'count-per-second',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Process minor page-fault delta per second.',
  },
  'memory.majorFaultsPerSec': {
    unit: 'count-per-second',
    writerKind: 'operator',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['all'],
    description: 'Process major page-fault delta per second.',
  },
  'memory.swapUsedBytes': {
    unit: 'bytes',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Host SwapTotal minus SwapFree from /proc/meminfo.',
  },
  'memory.swapInBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Linux pswpin page delta converted to bytes per second.',
  },
  'memory.swapOutBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Linux pswpout page delta converted to bytes per second.',
  },
  'database.waitP95Ms': {
    unit: 'milliseconds',
    writerKind: 'database',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Database wait/checkout latency p95 supplied by the DB writer.',
  },
  'database.activeConnections': {
    unit: 'connections',
    writerKind: 'database',
    windowKind: 'instant',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Active database connections supplied by the DB writer.',
  },
  'service.waitP95Ms': {
    unit: 'milliseconds',
    writerKind: 'service',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Internal service wait latency p95 supplied by service instrumentation.',
  },
  'descriptor.openCount': {
    unit: 'descriptors',
    writerKind: 'operator',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Open descriptors for the publishing operator process.',
  },
  'socket.closeWaitCount': {
    unit: 'count',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Host TCP sockets in CLOSE_WAIT from procfs.',
  },
  'disk.freeBytes': {
    unit: 'bytes',
    writerKind: 'monitor',
    windowKind: 'instant',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Available bytes on the filesystem containing the monitor snapshot.',
  },
  'disk.readBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Aggregate Linux block-device read-sector delta per second.',
  },
  'disk.writeBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Aggregate Linux block-device write-sector delta per second.',
  },
  'network.rxBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Aggregate non-loopback network receive-byte delta per second.',
  },
  'network.txBytesPerSec': {
    unit: 'bytes-per-second',
    writerKind: 'monitor',
    windowKind: 'delta',
    freshForMs: 15_000,
    platforms: ['linux'],
    description: 'Aggregate non-loopback network transmit-byte delta per second.',
  },
  'provider.waitP95Ms': {
    unit: 'milliseconds',
    writerKind: 'provider',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Provider/account wait latency p95 supplied by inference routing.',
  },
  'provider.rateLimited': {
    unit: 'boolean',
    writerKind: 'provider',
    windowKind: 'instant',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Whether the observed provider/account lane is currently rate-limited.',
  },
  'queue.writerLatencyP95Ms': {
    unit: 'milliseconds',
    writerKind: 'queue',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Canonical durable queue writer latency p95.',
  },
  'queue.writerFailureRate': {
    unit: 'percent',
    writerKind: 'queue',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Canonical durable queue writer failures divided by attempts.',
  },
  'queue.oldestAgeMs': {
    unit: 'milliseconds',
    writerKind: 'queue',
    windowKind: 'instant',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Age of the oldest queued receipt; depth alone is intentionally absent as a verdict.',
  },
  'queue.arrivalRate': {
    unit: 'requests-per-second',
    writerKind: 'queue',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Durable receipt arrival rate over the writer window.',
  },
  'queue.drainRate': {
    unit: 'requests-per-second',
    writerKind: 'queue',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Durable receipt terminal/drain rate over the writer window.',
  },
  'governor.admissionLatencyP95Ms': {
    unit: 'milliseconds',
    writerKind: 'governor',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Governor.admit end-to-end latency p95.',
  },
  'governor.decisionLatencyP95Ms': {
    unit: 'milliseconds',
    writerKind: 'governor',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Controller decision latency p95, excluding durable queue persistence.',
  },
  'governor.persistLatencyP95Ms': {
    unit: 'milliseconds',
    writerKind: 'governor',
    windowKind: 'rolling',
    freshForMs: 30_000,
    platforms: ['all'],
    description: 'Durable queue/receipt persistence latency p95 observed by the governor.',
  },
} as const satisfies Record<string, LiveHealthSignalSpec>;

export type LiveHealthSignalKey = keyof typeof LIVE_HEALTH_SIGNAL_SPECS;
export const LIVE_HEALTH_SIGNAL_KEYS = Object.freeze(Object.keys(LIVE_HEALTH_SIGNAL_SPECS) as LiveHealthSignalKey[]);

export interface LiveHealthPlatformProfile {
  readonly platform: LiveHealthPlatform;
  readonly arch: string;
  readonly release: string;
  readonly effectiveCores: number;
  readonly physicalCores: number;
  readonly totalMemoryBytes: number;
  readonly embeddedPg: boolean;
  readonly hostRole: string;
  /** Describes normalization only; it is not a controller limit. */
  readonly source: '@papercusp/resource-profile';
}

export interface LiveHealthSnapshot {
  readonly schemaVersion: typeof LIVE_HEALTH_SCHEMA_VERSION;
  readonly sequence: number;
  readonly sampledAtMs: number;
  readonly monitorStartedAtMs: number;
  readonly cadenceMs: number;
  readonly profile: LiveHealthPlatformProfile;
  readonly writers: Readonly<Record<string, LiveHealthWriter>>;
  /**
   * Every writer-scoped observation. This is the attribution source for P-005;
   * no sibling process/provider lane is discarded by the compact summary.
   */
  readonly observations: Readonly<Record<LiveHealthSignalKey, Readonly<Record<string, LiveHealthReading>>>>;
  /** Newest reading per key for bounded orientation/state summaries. Not a verdict. */
  readonly signals: Readonly<Record<LiveHealthSignalKey, LiveHealthReading>>;
}

export interface LiveHealthFragment {
  readonly schemaVersion: typeof LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION;
  readonly publishedAtMs: number;
  readonly writer: LiveHealthWriter;
  readonly signals: Partial<Record<LiveHealthSignalKey, LiveHealthReading>>;
}

export function clampLiveHealthConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function liveHealthWindow(kind: LiveHealthWindowKind, startedAtMs: number, endedAtMs: number): LiveHealthWindow {
  const safeEnd = Number.isFinite(endedAtMs) ? endedAtMs : 0;
  const safeStart = Number.isFinite(startedAtMs) ? Math.min(startedAtMs, safeEnd) : safeEnd;
  return Object.freeze({
    kind,
    durationMs: kind === 'instant' ? 0 : Math.max(0, safeEnd - safeStart),
    startedAtMs: kind === 'instant' ? safeEnd : safeStart,
    endedAtMs: safeEnd,
  });
}

export function measuredLiveHealthReading(args: {
  key: LiveHealthSignalKey;
  value: LiveHealthValue;
  writerId: string;
  observedAtMs: number;
  collectedAtMs?: number;
  window: LiveHealthWindow;
  confidence?: number;
}): LiveHealthReading {
  if (typeof args.value === 'number' && !Number.isFinite(args.value)) {
    return unknownLiveHealthReading({
      key: args.key,
      writerId: args.writerId,
      observedAtMs: args.observedAtMs,
      collectedAtMs: args.collectedAtMs,
      window: args.window,
      reason: 'non-finite-observation',
    });
  }
  return Object.freeze({
    state: 'measured',
    value: args.value,
    unit: LIVE_HEALTH_SIGNAL_SPECS[args.key].unit,
    writerId: args.writerId,
    observedAtMs: args.observedAtMs,
    collectedAtMs: args.collectedAtMs ?? args.observedAtMs,
    window: args.window,
    confidence: clampLiveHealthConfidence(args.confidence ?? 1),
    reason: null,
    lastMeasuredAtMs: args.observedAtMs,
  });
}

export function unknownLiveHealthReading(args: {
  key: LiveHealthSignalKey;
  writerId: string;
  observedAtMs: number;
  collectedAtMs?: number;
  window?: LiveHealthWindow;
  reason: string;
}): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[args.key];
  return Object.freeze({
    state: 'unknown',
    value: null,
    unit: spec.unit,
    writerId: args.writerId,
    observedAtMs: args.observedAtMs,
    collectedAtMs: args.collectedAtMs ?? args.observedAtMs,
    window: args.window ?? liveHealthWindow(spec.windowKind, args.observedAtMs, args.observedAtMs),
    confidence: 0,
    reason: args.reason,
    lastMeasuredAtMs: null,
  });
}

export function staleLiveHealthReading(
  key: LiveHealthSignalKey,
  reading: LiveHealthReading,
  collectedAtMs: number,
  reason = 'freshness-window-expired',
): LiveHealthReading {
  return Object.freeze({
    ...reading,
    state: 'stale',
    value: null,
    collectedAtMs,
    confidence: Math.min(reading.confidence, 0.25),
    reason,
    lastMeasuredAtMs: reading.lastMeasuredAtMs ?? reading.observedAtMs,
    unit: LIVE_HEALTH_SIGNAL_SPECS[key].unit,
  });
}

export function emptyLiveHealthSignals(nowMs: number): Record<LiveHealthSignalKey, LiveHealthReading> {
  return Object.fromEntries(
    LIVE_HEALTH_SIGNAL_KEYS.map((key) => [
      key,
      unknownLiveHealthReading({
        key,
        writerId: `${LIVE_HEALTH_SIGNAL_SPECS[key].writerKind}:unobserved`,
        observedAtMs: nowMs,
        reason: 'writer-not-observed',
      }),
    ]),
  ) as Record<LiveHealthSignalKey, LiveHealthReading>;
}

export function emptyLiveHealthObservations(): Record<LiveHealthSignalKey, Record<string, LiveHealthReading>> {
  return Object.fromEntries(LIVE_HEALTH_SIGNAL_KEYS.map((key) => [key, {}])) as Record<
    LiveHealthSignalKey,
    Record<string, LiveHealthReading>
  >;
}

const LIVE_HEALTH_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
]);
const LIVE_HEALTH_WRITER_KINDS = new Set<LiveHealthWriterKind>([
  'monitor',
  'operator',
  'database',
  'service',
  'provider',
  'queue',
  'governor',
]);
const LIVE_HEALTH_READING_STATES = new Set<LiveHealthReadingState>(['measured', 'unknown', 'stale']);
const LIVE_HEALTH_WINDOW_KINDS = new Set<LiveHealthWindowKind>(['instant', 'delta', 'rolling']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isLiveHealthWriter(value: unknown): value is LiveHealthWriter {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.kind === 'string' &&
    LIVE_HEALTH_WRITER_KINDS.has(value.kind as LiveHealthWriterKind) &&
    typeof value.instanceId === 'string' &&
    value.instanceId.length > 0 &&
    (value.pid === null || (finite(value.pid) && Number.isInteger(value.pid) && value.pid >= 0)) &&
    typeof value.platform === 'string' &&
    LIVE_HEALTH_PLATFORMS.has(value.platform as NodeJS.Platform) &&
    finite(value.startedAtMs)
  );
}

function isLiveHealthWindowForKey(key: LiveHealthSignalKey, value: unknown): value is LiveHealthWindow {
  if (!isRecord(value)) return false;
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  if (
    typeof value.kind !== 'string' ||
    !LIVE_HEALTH_WINDOW_KINDS.has(value.kind as LiveHealthWindowKind) ||
    value.kind !== spec.windowKind ||
    !finite(value.durationMs) ||
    value.durationMs < 0 ||
    !finite(value.startedAtMs) ||
    !finite(value.endedAtMs) ||
    value.endedAtMs < value.startedAtMs
  ) {
    return false;
  }
  if (value.kind === 'instant') return value.durationMs === 0 && value.startedAtMs === value.endedAtMs;
  return value.durationMs === value.endedAtMs - value.startedAtMs;
}

/** Validate one reading independently of its source container. */
function isLiveHealthReadingForKey(
  key: LiveHealthSignalKey,
  value: unknown,
  expectedWriterId?: string,
): value is LiveHealthReading {
  if (!isRecord(value)) return false;
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  const state = value.state;
  if (typeof state !== 'string' || !LIVE_HEALTH_READING_STATES.has(state as LiveHealthReadingState)) return false;
  if (typeof value.writerId !== 'string' || value.writerId.length === 0) return false;
  if (expectedWriterId !== undefined && value.writerId !== expectedWriterId) return false;
  if (value.unit !== spec.unit || !finite(value.observedAtMs) || !finite(value.collectedAtMs)) return false;
  if (!isLiveHealthWindowForKey(key, value.window)) return false;
  if (!finite(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
  if (state === 'measured') {
    if (value.reason !== null || !finite(value.lastMeasuredAtMs)) return false;
    if (spec.unit === 'boolean') {
      if (typeof value.value !== 'boolean') return false;
    } else if (!finite(value.value)) {
      return false;
    }
  } else {
    if (value.value !== null || typeof value.reason !== 'string' || value.reason.length === 0) return false;
    if (state === 'unknown' ? value.lastMeasuredAtMs !== null : !finite(value.lastMeasuredAtMs)) return false;
  }
  return true;
}

function isCompleteSignalRecord(value: unknown): value is Record<LiveHealthSignalKey, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === LIVE_HEALTH_SIGNAL_KEYS.length && LIVE_HEALTH_SIGNAL_KEYS.every((key) => key in value);
}

function isSyntheticUnknownWriter(key: LiveHealthSignalKey, reading: LiveHealthReading): boolean {
  return reading.state === 'unknown' && reading.writerId === `${LIVE_HEALTH_SIGNAL_SPECS[key].writerKind}:unobserved`;
}

/**
 * Strictly validate the atomic snapshot before any consumer treats it as host
 * evidence. The monitor intentionally emits synthetic `*:unobserved` writers
 * for signal families that have not published yet; those are the only compact
 * readings allowed without a corresponding entry in `writers`.
 */
export function isLiveHealthSnapshot(value: unknown): value is LiveHealthSnapshot {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== LIVE_HEALTH_SCHEMA_VERSION) return false;
  if (!finite(value.sequence) || !Number.isInteger(value.sequence) || value.sequence < 1) return false;
  if (!finite(value.sampledAtMs) || !finite(value.monitorStartedAtMs) || value.monitorStartedAtMs > value.sampledAtMs) {
    return false;
  }
  if (!finite(value.cadenceMs) || value.cadenceMs <= 0) return false;
  if (!isRecord(value.profile)) return false;
  const profile = value.profile;
  if (
    typeof profile.platform !== 'string' ||
    !LIVE_HEALTH_PLATFORMS.has(profile.platform as NodeJS.Platform) ||
    typeof profile.arch !== 'string' ||
    typeof profile.release !== 'string' ||
    !finite(profile.effectiveCores) ||
    profile.effectiveCores <= 0 ||
    !finite(profile.physicalCores) ||
    profile.physicalCores <= 0 ||
    profile.physicalCores < profile.effectiveCores ||
    !finite(profile.totalMemoryBytes) ||
    profile.totalMemoryBytes <= 0 ||
    typeof profile.embeddedPg !== 'boolean' ||
    typeof profile.hostRole !== 'string' ||
    profile.source !== '@papercusp/resource-profile'
  ) {
    return false;
  }
  if (!isRecord(value.writers) || !isCompleteSignalRecord(value.observations) || !isCompleteSignalRecord(value.signals)) {
    return false;
  }

  for (const [writerId, rawWriter] of Object.entries(value.writers)) {
    if (!isLiveHealthWriter(rawWriter) || rawWriter.id !== writerId) return false;
  }
  for (const key of LIVE_HEALTH_SIGNAL_KEYS) {
    const compact = value.signals[key];
    if (!isLiveHealthReadingForKey(key, compact)) return false;
    if (!isSyntheticUnknownWriter(key, compact) && !Object.hasOwn(value.writers, compact.writerId)) return false;

    const rawObservations = value.observations[key];
    if (!isRecord(rawObservations)) return false;
    for (const [writerId, rawReading] of Object.entries(rawObservations)) {
      if (!Object.hasOwn(value.writers, writerId)) return false;
      const writer = value.writers[writerId];
      if (!isLiveHealthWriter(writer) || writer.kind !== LIVE_HEALTH_SIGNAL_SPECS[key].writerKind) return false;
      if (!isLiveHealthReadingForKey(key, rawReading, writerId)) return false;
    }
  }
  return true;
}

/** Validate the parts that would otherwise let malformed fragments lie healthy. */
export function isLiveHealthFragment(value: unknown): value is LiveHealthFragment {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as Partial<LiveHealthFragment>;
  if (fragment.schemaVersion !== LIVE_HEALTH_FRAGMENT_SCHEMA_VERSION) return false;
  if (!fragment.writer || typeof fragment.writer.id !== 'string' || typeof fragment.writer.kind !== 'string')
    return false;
  if (!Number.isFinite(fragment.publishedAtMs)) return false;
  if (!fragment.signals || typeof fragment.signals !== 'object') return false;
  for (const [rawKey, rawReading] of Object.entries(fragment.signals)) {
    if (!(rawKey in LIVE_HEALTH_SIGNAL_SPECS) || !rawReading || typeof rawReading !== 'object') return false;
    const key = rawKey as LiveHealthSignalKey;
    const reading = rawReading as LiveHealthReading;
    const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
    if (spec.writerKind !== fragment.writer.kind) return false;
    if (reading.writerId !== fragment.writer.id || reading.unit !== spec.unit) return false;
    if (!['measured', 'unknown', 'stale'].includes(reading.state)) return false;
    if (!Number.isFinite(reading.observedAtMs) || !Number.isFinite(reading.collectedAtMs)) return false;
    if (!Number.isFinite(reading.confidence) || reading.confidence < 0 || reading.confidence > 1) return false;
    if (reading.state !== 'measured' && reading.value !== null) return false;
    if (typeof reading.value === 'number' && !Number.isFinite(reading.value)) return false;
  }
  return true;
}

/**
 * Merge valid fragments newest-first. Expired evidence is represented as stale;
 * absent evidence remains unknown. A fragment can never override another writer
 * kind's signal.
 */
export function mergeLiveHealthFragments(
  signals: Record<LiveHealthSignalKey, LiveHealthReading>,
  writers: Record<string, LiveHealthWriter>,
  fragments: readonly LiveHealthFragment[],
  nowMs: number,
  observations?: Record<LiveHealthSignalKey, Record<string, LiveHealthReading>>,
): void {
  const ordered = [...fragments].sort((a, b) => b.publishedAtMs - a.publishedAtMs);
  const selected = new Set<LiveHealthSignalKey>();
  for (const fragment of ordered) {
    writers[fragment.writer.id] = fragment.writer;
    for (const [rawKey, reading] of Object.entries(fragment.signals)) {
      const key = rawKey as LiveHealthSignalKey;
      if (!reading) continue;
      const ageMs = Math.max(0, nowMs - reading.observedAtMs);
      const normalized =
        ageMs > LIVE_HEALTH_SIGNAL_SPECS[key].freshForMs ? staleLiveHealthReading(key, reading, nowMs) : reading;
      if (observations) observations[key][reading.writerId] = normalized;
      if (selected.has(key)) continue;
      selected.add(key);
      signals[key] = normalized;
    }
  }
}
