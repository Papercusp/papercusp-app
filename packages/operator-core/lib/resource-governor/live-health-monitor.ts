/**
 * Cross-platform, out-of-process live-health sampler.
 *
 * This module owns only observation and freshness. It never decides whether a
 * reading should contract admission; that belongs to the P-005/P-006 controller.
 * Linux-specific probes fail to explicit unknown on every other platform.
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, statfs, unlink, writeFile } from 'node:fs/promises';
import { arch, cpus, freemem, homedir, platform, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getResourceProfile, type ResourceProfile } from '@papercusp/resource-profile';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import {
  LIVE_HEALTH_SCHEMA_VERSION,
  LIVE_HEALTH_SIGNAL_SPECS,
  emptyLiveHealthObservations,
  emptyLiveHealthSignals,
  isLiveHealthFragment,
  isLiveHealthSnapshot,
  liveHealthWindow,
  measuredLiveHealthReading,
  mergeLiveHealthFragments,
  unknownLiveHealthReading,
  type LiveHealthFragment,
  type LiveHealthPlatformProfile,
  type LiveHealthReading,
  type LiveHealthSignalKey,
  type LiveHealthSnapshot,
  type LiveHealthWriter,
} from './live-health';

export const LIVE_HEALTH_DEFAULT_CADENCE_MS = 2_000;
/** A missing or older-than-this atomic snapshot is not current host evidence. */
export const LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS = 15_000;
export const LIVE_HEALTH_FRAGMENT_RETENTION_MS = 24 * 60 * 60_000;
export const LIVE_HEALTH_PAGE_BYTES = 4_096;
export const LIVE_HEALTH_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const LIVE_HEALTH_HISTORY_MAX_SAMPLES = 3_600;
export const LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES = 256 * 1024;

export interface LiveHealthPaths {
  readonly rootDir: string;
  readonly fragmentsDir: string;
  readonly snapshotPath: string;
}

export function resolveLiveHealthPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): LiveHealthPaths {
  const rootDir = env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    ? env.PAPERCUSP_RESOURCE_GOVERNOR_HEALTH_DIR
    : join(home, '.papercusp', 'runtime', 'resource-governor');
  return {
    rootDir,
    fragmentsDir: join(rootDir, 'fragments'),
    snapshotPath: join(rootDir, 'live-health.json'),
  };
}

export function liveHealthFragmentPath(paths: LiveHealthPaths, writerId: string): string {
  const safe = writerId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 180) || 'writer';
  return join(paths.fragmentsDir, `${safe}.json`);
}

/** Atomic same-directory replacement; readers see the old or new whole JSON. */
export async function writeLiveHealthJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

async function writeLiveHealthText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), '.' + process.pid + '-' + randomUUID() + '.tmp');
  try {
    await writeFile(tmp, value, { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

interface LiveHealthHistoryWriterOptions {
  readonly maxBytes?: number;
  readonly maxSamples?: number;
  readonly maxRecordBytes?: number;
}

interface LiveHealthHistoryTail {
  readonly text: string;
  readonly needsRewrite: boolean;
}

/**
 * Append complete snapshots as JSONL while bounding disk use and sample count.
 * The monitor is the sole writer for this path; appends are serialized so an
 * overlapping slow sample cannot race a retention compaction.
 */
export class LiveHealthHistoryWriter {
  readonly path: string;
  readonly maxBytes: number;
  readonly maxSamples: number;
  readonly maxRecordBytes: number;
  private initialized = false;
  private rowCount = 0;
  private byteCount = 0;
  private pending: Promise<void> = Promise.resolve();

  constructor(path: string, options: LiveHealthHistoryWriterOptions = {}) {
    this.path = path;
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? LIVE_HEALTH_HISTORY_MAX_BYTES));
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? LIVE_HEALTH_HISTORY_MAX_SAMPLES));
    this.maxRecordBytes = Math.max(
      1,
      Math.min(this.maxBytes, Math.floor(options.maxRecordBytes ?? LIVE_HEALTH_HISTORY_MAX_RECORD_BYTES)),
    );
  }

  append(snapshot: LiveHealthSnapshot): Promise<boolean> {
    const result = this.pending.then(() => this.appendSerial(snapshot));
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private async readTail(): Promise<LiveHealthHistoryTail> {
    const file = await open(this.path, 'r').catch(() => null);
    if (!file) return { text: '', needsRewrite: false };
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, this.maxBytes);
      if (length === 0) return { text: '', needsRewrite: size > 0 };
      const start = size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      let text = buffer.subarray(0, bytesRead).toString('utf8');
      let needsRewrite = start > 0;
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
      }
      if (text && !text.endsWith('\n')) {
        const lastNewline = text.lastIndexOf('\n');
        text = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1);
        needsRewrite = true;
      }
      return { text, needsRewrite };
    } finally {
      await file.close();
    }
  }

  private validRows(text: string): string[] {
    return text.split(/\r?\n/).filter((line) => {
      if (!line) return false;
      try {
        const value: unknown = JSON.parse(line);
        return value !== null && typeof value === 'object' && !Array.isArray(value);
      } catch {
        return false;
      }
    });
  }

  private async replaceRows(rows: readonly string[], targetRows: number, targetBytes: number): Promise<void> {
    const kept: string[] = [];
    let bytes = 0;
    for (let index = rows.length - 1; index >= 0 && kept.length < targetRows; index -= 1) {
      const row = rows[index]!;
      const rowBytes = Buffer.byteLength(row) + 1;
      if (bytes + rowBytes > targetBytes) break;
      kept.push(row);
      bytes += rowBytes;
    }
    const ordered = kept.reverse();
    await writeLiveHealthText(this.path, ordered.length ? ordered.join('\n') + '\n' : '');
    this.rowCount = ordered.length;
    this.byteCount = bytes;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const tail = await this.readTail();
    const rawRows = tail.text.split(/\r?\n/).filter(Boolean);
    const rows = this.validRows(tail.text);
    this.rowCount = rows.length;
    this.byteCount = rows.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0);
    this.initialized = true;
    if (
      tail.needsRewrite ||
      rows.length !== rawRows.length ||
      this.rowCount > this.maxSamples ||
      this.byteCount > this.maxBytes
    ) {
      await this.replaceRows(rows, this.maxSamples, this.maxBytes);
    }
  }

  private async appendSerial(snapshot: LiveHealthSnapshot): Promise<boolean> {
    const row = JSON.stringify(snapshot) + '\n';
    const rowBytes = Buffer.byteLength(row);
    if (rowBytes > this.maxRecordBytes || rowBytes > this.maxBytes) return false;
    await this.initialize();
    if (this.rowCount + 1 > this.maxSamples || this.byteCount + rowBytes > this.maxBytes) {
      const tail = await this.readTail();
      await this.replaceRows(
        this.validRows(tail.text),
        Math.floor(this.maxSamples / 2),
        Math.floor(this.maxBytes / 2),
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, row, { encoding: 'utf8', mode: 0o600 });
    this.rowCount += 1;
    this.byteCount += rowBytes;
    return true;
  }
}

/**
 * Read the monitor's atomic snapshot only when it is structurally valid and
 * recent enough to describe the current host. A malformed, missing, future, or
 * stale file is an unknown reading rather than a healthy default.
 */
export async function readLiveHealthSnapshot(
  paths: LiveHealthPaths = resolveLiveHealthPaths(),
  nowMs = Date.now(),
  maxAgeMs = LIVE_HEALTH_SNAPSHOT_MAX_AGE_MS,
): Promise<LiveHealthSnapshot | null> {
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;
  try {
    const value: unknown = JSON.parse(await readFile(paths.snapshotPath, 'utf8'));
    if (!isLiveHealthSnapshot(value)) return null;
    const ageMs = nowMs - value.sampledAtMs;
    if (ageMs < 0 || ageMs > maxAgeMs) return null;
    return value;
  } catch {
    return null;
  }
}

export interface PsiSample {
  readonly some60: number | null;
  readonly full60: number | null;
}

export function parsePsi(text: string | null): PsiSample {
  const out: { some60: number | null; full60: number | null } = { some60: null, full60: null };
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const kind = line.startsWith('some ') ? 'some60' : line.startsWith('full ') ? 'full60' : null;
    if (!kind) continue;
    const match = line.match(/\bavg60=([\d.]+)/);
    const value = match ? Number(match[1]) : Number.NaN;
    if (Number.isFinite(value)) out[kind] = value;
  }
  return out;
}

export interface SchedulerSample {
  readonly runnable: number | null;
  readonly blocked: number | null;
}

export function parseProcStat(text: string | null): SchedulerSample {
  const read = (name: string): number | null => {
    const match = text?.match(new RegExp(`(?:^|\\n)${name}\\s+(\\d+)`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  return { runnable: read('procs_running'), blocked: read('procs_blocked') };
}

export interface MemoryKernelSample {
  readonly swapUsedBytes: number | null;
  readonly swapInPages: number | null;
  readonly swapOutPages: number | null;
}

export function parseMemoryKernel(meminfo: string | null, vmstat: string | null): MemoryKernelSample {
  const memKb = (name: string): number | null => {
    const match = meminfo?.match(new RegExp(`(?:^|\\n)${name}:\\s+(\\d+)\\s+kB`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  const vm = (name: string): number | null => {
    const match = vmstat?.match(new RegExp(`(?:^|\\n)${name}\\s+(\\d+)`));
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  };
  const total = memKb('SwapTotal');
  const free = memKb('SwapFree');
  return {
    swapUsedBytes: total === null || free === null ? null : Math.max(0, total - free) * 1_024,
    swapInPages: vm('pswpin'),
    swapOutPages: vm('pswpout'),
  };
}

export interface NetworkCounters {
  readonly rxBytes: number;
  readonly txBytes: number;
}

export function parseNetworkCounters(text: string | null): NetworkCounters | null {
  if (!text) return null;
  let rxBytes = 0;
  let txBytes = 0;
  let rows = 0;
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    if (!name || name === 'lo') continue;
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    if (fields.length < 16 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rxBytes += fields[0]!;
    txBytes += fields[8]!;
    rows++;
  }
  return rows > 0 ? { rxBytes, txBytes } : null;
}

export function parseCloseWaitCount(...tables: Array<string | null>): number | null {
  let readable = 0;
  let count = 0;
  for (const table of tables) {
    if (!table) continue;
    readable++;
    for (const line of table.split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '08') count++;
    }
  }
  return readable > 0 ? count : null;
}

export interface CpuCounters {
  readonly idleMs: number;
  readonly totalMs: number;
}

export function readCpuCounters(rows: ReturnType<typeof cpus>): CpuCounters | null {
  if (rows.length === 0) return null;
  let idleMs = 0;
  let totalMs = 0;
  for (const row of rows) {
    idleMs += row.times.idle;
    totalMs += row.times.user + row.times.nice + row.times.sys + row.times.idle + row.times.irq;
  }
  return totalMs > 0 ? { idleMs, totalMs } : null;
}

export interface HostLiveHealthCounters {
  readonly atMs: number;
  readonly cpu: CpuCounters | null;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly cpuPsi: PsiSample;
  readonly memoryPsi: PsiSample;
  readonly ioPsi: PsiSample;
  readonly scheduler: SchedulerSample;
  readonly memoryKernel: MemoryKernelSample;
  readonly network: NetworkCounters | null;
  readonly closeWaitCount: number | null;
  readonly diskFreeBytes: number | null;
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function collectHostLiveHealthCounters(
  nowMs: number,
  paths: LiveHealthPaths,
  currentPlatform: NodeJS.Platform = platform(),
): Promise<HostLiveHealthCounters> {
  await mkdir(paths.rootDir, { recursive: true });
  const linuxReads =
    currentPlatform === 'linux'
      ? await Promise.all([
          readTextOrNull('/proc/pressure/cpu'),
          readTextOrNull('/proc/pressure/memory'),
          readTextOrNull('/proc/stat'),
          readTextOrNull('/proc/meminfo'),
          readTextOrNull('/proc/vmstat'),
          readTextOrNull('/proc/net/dev'),
          readTextOrNull('/proc/net/tcp'),
          readTextOrNull('/proc/net/tcp6'),
          readTextOrNull('/proc/pressure/io'),
        ])
      : [null, null, null, null, null, null, null, null, null];
  const fs = await statfs(paths.rootDir).catch(() => null);
  const diskFreeBytes = fs ? Number(fs.bavail) * Number(fs.bsize) : null;
  return {
    atMs: nowMs,
    cpu: readCpuCounters(cpus()),
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    cpuPsi: parsePsi(linuxReads[0]),
    memoryPsi: parsePsi(linuxReads[1]),
    ioPsi: parsePsi(linuxReads[8]),
    scheduler: parseProcStat(linuxReads[2]),
    memoryKernel: parseMemoryKernel(linuxReads[3], linuxReads[4]),
    network: parseNetworkCounters(linuxReads[5]),
    closeWaitCount: parseCloseWaitCount(linuxReads[6], linuxReads[7]),
    diskFreeBytes: Number.isFinite(diskFreeBytes) ? diskFreeBytes : null,
  };
}

function platformUnknownReason(currentPlatform: NodeJS.Platform): string {
  return currentPlatform === 'linux' ? 'linux-probe-unavailable' : `unsupported-on-${currentPlatform}`;
}

function monitorReading(
  key: LiveHealthSignalKey,
  writerId: string,
  current: HostLiveHealthCounters,
  value: number | null,
  windowStartMs = current.atMs,
  confidence = 1,
): LiveHealthReading {
  const spec = LIVE_HEALTH_SIGNAL_SPECS[key];
  const window = liveHealthWindow(spec.windowKind, windowStartMs, current.atMs);
  return value === null
    ? unknownLiveHealthReading({
        key,
        writerId,
        observedAtMs: current.atMs,
        window,
        reason: platformUnknownReason(platform()),
      })
    : measuredLiveHealthReading({
        key,
        writerId,
        observedAtMs: current.atMs,
        window,
        value,
        confidence,
      });
}

function rate(current: number | null, previous: number | null, elapsedMs: number, scale = 1): number | null {
  if (current === null || previous === null || elapsedMs <= 0 || current < previous) return null;
  return ((current - previous) * scale * 1_000) / elapsedMs;
}

export function applyHostLiveHealthReadings(
  signals: Record<LiveHealthSignalKey, LiveHealthReading>,
  writerId: string,
  current: HostLiveHealthCounters,
  previous: HostLiveHealthCounters | null,
): void {
  const start = previous?.atMs ?? current.atMs;
  const elapsedMs = Math.max(0, current.atMs - start);
  let cpuPct: number | null = null;
  if (previous?.cpu && current.cpu) {
    const totalDelta = current.cpu.totalMs - previous.cpu.totalMs;
    const idleDelta = current.cpu.idleMs - previous.cpu.idleMs;
    if (totalDelta > 0 && idleDelta >= 0) cpuPct = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  }
  signals['cpu.hostUtilizationPct'] = monitorReading('cpu.hostUtilizationPct', writerId, current, cpuPct, start);
  signals['cpu.psiSomePct'] = monitorReading(
    'cpu.psiSomePct',
    writerId,
    current,
    current.cpuPsi.some60,
    current.atMs - 60_000,
  );
  signals['scheduler.runnableCount'] = monitorReading(
    'scheduler.runnableCount',
    writerId,
    current,
    current.scheduler.runnable,
  );
  signals['scheduler.blockedCount'] = monitorReading(
    'scheduler.blockedCount',
    writerId,
    current,
    current.scheduler.blocked,
  );
  signals['memory.hostUsedBytes'] = monitorReading(
    'memory.hostUsedBytes',
    writerId,
    current,
    Math.max(0, current.totalMemoryBytes - current.freeMemoryBytes),
  );
  signals['memory.psiSomePct'] = monitorReading(
    'memory.psiSomePct',
    writerId,
    current,
    current.memoryPsi.some60,
    current.atMs - 60_000,
  );
  signals['memory.psiFullPct'] = monitorReading(
    'memory.psiFullPct',
    writerId,
    current,
    current.memoryPsi.full60,
    current.atMs - 60_000,
  );
  signals['io.psiSomePct'] = monitorReading(
    'io.psiSomePct',
    writerId,
    current,
    current.ioPsi.some60,
    current.atMs - 60_000,
  );
  signals['io.psiFullPct'] = monitorReading(
    'io.psiFullPct',
    writerId,
    current,
    current.ioPsi.full60,
    current.atMs - 60_000,
  );
  signals['memory.swapUsedBytes'] = monitorReading(
    'memory.swapUsedBytes',
    writerId,
    current,
    current.memoryKernel.swapUsedBytes,
  );
  signals['memory.swapInBytesPerSec'] = monitorReading(
    'memory.swapInBytesPerSec',
    writerId,
    current,
    rate(
      current.memoryKernel.swapInPages,
      previous?.memoryKernel.swapInPages ?? null,
      elapsedMs,
      LIVE_HEALTH_PAGE_BYTES,
    ),
    start,
  );
  signals['memory.swapOutBytesPerSec'] = monitorReading(
    'memory.swapOutBytesPerSec',
    writerId,
    current,
    rate(
      current.memoryKernel.swapOutPages,
      previous?.memoryKernel.swapOutPages ?? null,
      elapsedMs,
      LIVE_HEALTH_PAGE_BYTES,
    ),
    start,
  );
  signals['network.rxBytesPerSec'] = monitorReading(
    'network.rxBytesPerSec',
    writerId,
    current,
    rate(current.network?.rxBytes ?? null, previous?.network?.rxBytes ?? null, elapsedMs),
    start,
  );
  signals['network.txBytesPerSec'] = monitorReading(
    'network.txBytesPerSec',
    writerId,
    current,
    rate(current.network?.txBytes ?? null, previous?.network?.txBytes ?? null, elapsedMs),
    start,
  );
  signals['socket.closeWaitCount'] = monitorReading('socket.closeWaitCount', writerId, current, current.closeWaitCount);
  signals['disk.freeBytes'] = monitorReading('disk.freeBytes', writerId, current, current.diskFreeBytes);
  // Throughput needs a mount/device attribution writer. Do not sum overlapping
  // dm/partition rows from /proc/diskstats and present the double count as truth.
  for (const key of ['disk.readBytesPerSec', 'disk.writeBytesPerSec'] as const) {
    signals[key] = unknownLiveHealthReading({
      key,
      writerId,
      observedAtMs: current.atMs,
      window: liveHealthWindow('delta', start, current.atMs),
      reason: platform() === 'linux' ? 'block-device-attribution-unavailable' : platformUnknownReason(platform()),
    });
  }
}

export async function readLiveHealthFragments(paths: LiveHealthPaths, nowMs: number): Promise<LiveHealthFragment[]> {
  let names: string[];
  try {
    names = (await readdir(paths.fragmentsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  // Independent files are intentionally parallel: a serial fs loop makes sample
  // latency grow linearly with process count. There is no fixed writer ceiling.
  const parsed = await Promise.all(
    names.map(async (name): Promise<LiveHealthFragment | null> => {
      const path = join(paths.fragmentsDir, name);
      try {
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        if (!isLiveHealthFragment(value)) return null;
        if (nowMs - value.publishedAtMs > LIVE_HEALTH_FRAGMENT_RETENTION_MS) {
          await unlink(path).catch(() => {});
          return null;
        }
        return value;
      } catch {
        return null;
      }
    }),
  );
  return parsed.filter((fragment): fragment is LiveHealthFragment => fragment !== null);
}

function liveHealthProfile(resourceProfile: ResourceProfile): LiveHealthPlatformProfile {
  return {
    platform: platform(),
    arch: arch(),
    release: release(),
    effectiveCores: resourceProfile.signals.cores,
    physicalCores: resourceProfile.signals.physicalCores ?? resourceProfile.signals.cores,
    totalMemoryBytes: resourceProfile.signals.totalMemBytes,
    embeddedPg: resourceProfile.signals.embeddedPg,
    hostRole: resourceProfile.signals.hostRole,
    source: '@papercusp/resource-profile',
  };
}

export interface LiveHealthMonitorOptions {
  readonly paths?: LiveHealthPaths;
  readonly cadenceMs?: number;
  readonly now?: () => number;
  readonly resourceProfile?: ResourceProfile;
  readonly collectHost?: typeof collectHostLiveHealthCounters;
  readonly readFragments?: typeof readLiveHealthFragments;
  readonly writeSnapshot?: typeof writeLiveHealthJson;
  readonly writeHistory?: (snapshot: LiveHealthSnapshot) => Promise<void>;
  readonly log?: (message: string) => void;
}

export class LiveHealthMonitor {
  readonly paths: LiveHealthPaths;
  readonly cadenceMs: number;
  readonly writer: LiveHealthWriter;
  readonly profile: LiveHealthPlatformProfile;
  private readonly now: () => number;
  private readonly collectHost: typeof collectHostLiveHealthCounters;
  private readonly readFragments: typeof readLiveHealthFragments;
  private readonly writeSnapshot: typeof writeLiveHealthJson;
  private readonly writeHistory: (snapshot: LiveHealthSnapshot) => Promise<void>;
  private readonly log: (message: string) => void;
  private previous: HostLiveHealthCounters | null = null;
  private sequence = 0;
  private timer: ManagedHandle | null = null;

  constructor(options: LiveHealthMonitorOptions = {}) {
    this.paths = options.paths ?? resolveLiveHealthPaths();
    this.cadenceMs = Math.max(250, options.cadenceMs ?? LIVE_HEALTH_DEFAULT_CADENCE_MS);
    this.now = options.now ?? Date.now;
    this.collectHost = options.collectHost ?? collectHostLiveHealthCounters;
    this.readFragments = options.readFragments ?? readLiveHealthFragments;
    this.writeSnapshot = options.writeSnapshot ?? writeLiveHealthJson;
    this.log = options.log ?? ((message) => console.warn(message));
    const history = new LiveHealthHistoryWriter(join(this.paths.rootDir, 'live-health-history.jsonl'));
    this.writeHistory = options.writeHistory ?? (async (snapshot) => {
      if (!(await history.append(snapshot))) {
        this.log('[resource-governor-health] history row exceeded its configured cap; skipped');
      }
    });
    const startedAtMs = this.now();
    this.writer = {
      id: `monitor.host:${process.pid}`,
      kind: 'monitor',
      instanceId: randomUUID(),
      pid: process.pid,
      platform: platform(),
      startedAtMs,
    };
    this.profile = liveHealthProfile(options.resourceProfile ?? getResourceProfile());
  }

  async sampleOnce(): Promise<LiveHealthSnapshot> {
    const started = performance.now();
    const sampledAtMs = this.now();
    const current = await this.collectHost(sampledAtMs, this.paths, this.profile.platform);
    const signals = emptyLiveHealthSignals(sampledAtMs);
    applyHostLiveHealthReadings(signals, this.writer.id, current, this.previous);
    const observations = emptyLiveHealthObservations();
    for (const [key, reading] of Object.entries(signals) as Array<[LiveHealthSignalKey, LiveHealthReading]>) {
      if (reading.writerId === this.writer.id) observations[key][this.writer.id] = reading;
    }
    const writers: Record<string, LiveHealthWriter> = { [this.writer.id]: this.writer };
    const fragments = await this.readFragments(this.paths, sampledAtMs);
    mergeLiveHealthFragments(signals, writers, fragments, sampledAtMs, observations);
    const collectedAtMs = this.now();
    signals['latency.monitorTickMs'] = measuredLiveHealthReading({
      key: 'latency.monitorTickMs',
      value: Math.max(0, performance.now() - started),
      writerId: this.writer.id,
      observedAtMs: collectedAtMs,
      collectedAtMs,
      window: liveHealthWindow('delta', sampledAtMs, collectedAtMs),
      confidence: 1,
    });
    observations['latency.monitorTickMs'][this.writer.id] = signals['latency.monitorTickMs'];
    const snapshot: LiveHealthSnapshot = {
      schemaVersion: LIVE_HEALTH_SCHEMA_VERSION,
      sequence: ++this.sequence,
      sampledAtMs,
      monitorStartedAtMs: this.writer.startedAtMs,
      cadenceMs: this.cadenceMs,
      profile: this.profile,
      writers,
      observations,
      signals,
    };
    await this.writeSnapshot(this.paths.snapshotPath, snapshot);
    this.previous = current;
    try {
      await this.writeHistory(snapshot);
    } catch (error) {
      this.log(
        '[resource-governor-health] history write failed: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    return snapshot;
  }

  async start(): Promise<LiveHealthSnapshot> {
    if (this.timer) return this.sampleOnce();
    const first = await this.sampleOnce();
    this.timer = managedSetInterval(
      'resource-governor-live-health-monitor',
      this.cadenceMs,
      async () => {
        try {
          await this.sampleOnce();
        } catch (error) {
          this.log(`[resource-governor-health] sample failed: ${error instanceof Error ? error.message : error}`);
        }
      },
      // D-004: must-sample — live host health (loop lag, memory, PSI, pressure) has no
      // event source to subscribe to; the reading only exists once you take it.
      { category: 'watchdog', classification: 'must-sample' },
    );
    return first;
  }

  stop(): void {
    this.timer?.stop();
    this.timer = null;
  }
}
