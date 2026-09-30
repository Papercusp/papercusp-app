/**
 * kernel-leak-watchdog (host-memory-reduction-2026-09-27 P-010, D-007) — alarm
 * when unreclaimable kernel memory climbs steadily, so a kernel leak surfaces
 * in about a day instead of weeks.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * On 6.17.0-40 an AppArmor path leaks kmalloc-8k slab at ~3 GB/day. It reached
 * 29.9 GiB of SUnreclaim (plus ~1,900 dying memory cgroups) before anyone
 * looked, and it presented as generic "the box is thrashing": the leaked slab
 * silently ate the MemAvailable every admission budget is computed from.
 * Nothing measured kernel memory at all, so neither the climb nor its rate
 * was visible.
 *
 * ── What it measures, and why not the cache itself ─────────────────────────
 * /proc/slabinfo and /sys/kernel/slab/* are root-only, so an unprivileged
 * operator cannot see per-cache counts. And even with root, a cache NAME is
 * the wrong key: CONFIG_RANDOM_KMALLOC_CACHES re-randomises which of
 * kmalloc-8k / kmalloc-rnd-NN-8k a call site lands in on every boot (the same
 * leak lived in kmalloc-rnd-03-8k before the 2026-09-27 reboot and in plain
 * kmalloc-8k after it). SUnreclaim is the world-readable aggregate that
 * contains every one of them. nr_dying_descendants (root cgroup.stat) is the
 * second signal: memory cgroups that were removed but are pinned by charged
 * slab — the leak held ~1,900 of them.
 *
 * ── How it decides ──────────────────────────────────────────────────────────
 * Every tick appends one sample to harness_shared.host_kernel_memory_samples
 * (migration 1234), keyed by (boot_id, 10-minute bucket), so the :3070 and
 * :3170 operators on one host write one row and a reboot starts a new series.
 * It then fits a least-squares slope over the trailing 24 h of THIS boot,
 * skipping the first 6 h (warm-up: SUnreclaim rose 3.3 → 4.8 GB in the first
 * three hours after the 2026-09-27 boot while the leaking cache was still
 * small). See D-007 for the calibration; the thresholds are provisional.
 *
 * Dedup is openEscalation's (dedupKind, subjectSignature), signed per boot and
 * per signal, so a sustained leak holds ONE open escalation per signal.
 */
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { getOrgPg } from '@papercusp/db-org';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

const GIB = 1024 ** 3;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** Sampling cadence, and the width of one series bucket. */
export const KERNEL_LEAK_SAMPLE_INTERVAL_MS = 10 * 60_000;

/** Samples younger than this after boot are warm-up, never evidence of a leak. */
export const KERNEL_LEAK_WARMUP_MS = 6 * HOUR_MS;

/** The trailing window a slope is fitted over. */
export const KERNEL_LEAK_WINDOW_MS = DAY_MS;

/** A slope needs at least this much time span and this many samples to count. */
export const KERNEL_LEAK_MIN_SPAN_MS = 12 * HOUR_MS;
export const KERNEL_LEAK_MIN_SAMPLES = 12;

/** SUnreclaim growth that alarms. The known leak ran at ~2.6-3.5 GB/day. */
export const SUNRECLAIM_SLOPE_ALARM_BYTES_PER_DAY = 1.5 * GIB;

/** SUnreclaim as a share of MemTotal that alarms regardless of slope. */
export const SUNRECLAIM_ABSOLUTE_ALARM_FRACTION = 0.1;

/** Dying cgroups alarm only above this floor AND while still climbing this fast. */
export const DYING_DESCENDANTS_FLOOR = 1000;
export const DYING_DESCENDANTS_SLOPE_ALARM_PER_DAY = 500;

export const KERNEL_LEAK_RETENTION_DAYS = 14;

const WATCHDOG_IDENTITY: AgentIdentity = {
  ownerId: 'kernel-leak-watchdog',
  ownerLabel: 'system · kernel memory leak',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One reading of the host's kernel memory. */
export interface KernelMemorySample {
  bootId: string;
  host: string;
  sampledAtMs: number;
  bootedAtMs: number;
  memTotalBytes: number;
  sUnreclaimBytes: number;
  slabBytes: number;
  /** Null when cgroup v2 is not mounted at /sys/fs/cgroup. */
  dyingDescendants: number | null;
}

export type KernelLeakSignal = 'sunreclaim-growth' | 'sunreclaim-absolute' | 'dying-growth';

export interface KernelLeakAlert {
  signal: KernelLeakSignal;
  sample: KernelMemorySample;
  /** Fitted growth per day, when the signal is a slope. */
  slopePerDay: number | null;
  /** The window the slope was fitted over. */
  windowSamples: number;
  windowSpanMs: number;
}

function meminfoKb(text: string, key: string): number | null {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
  return m ? Number(m[1]) : null;
}

/** PURE — nr_dying_descendants from a cgroup.stat body, or null when absent. */
export function parseDyingDescendants(cgroupStat: string | null): number | null {
  if (!cgroupStat) return null;
  const m = /^nr_dying_descendants\s+(\d+)/m.exec(cgroupStat);
  return m ? Number(m[1]) : null;
}

/**
 * PURE — build a sample from the raw proc files. Null when meminfo lacks a
 * field we need or uptime is unreadable: a half-read sample would poison the
 * slope, so it is dropped rather than stored.
 */
export function buildKernelMemorySample(input: {
  meminfo: string;
  cgroupStat: string | null;
  bootId: string;
  uptime: string;
  host: string;
  nowMs: number;
}): KernelMemorySample | null {
  const memTotalKb = meminfoKb(input.meminfo, 'MemTotal');
  const sUnreclaimKb = meminfoKb(input.meminfo, 'SUnreclaim');
  const slabKb = meminfoKb(input.meminfo, 'Slab');
  const uptimeSec = Number.parseFloat(input.uptime.trim().split(/\s+/)[0] ?? '');
  const bootId = input.bootId.trim();
  if (memTotalKb === null || sUnreclaimKb === null || slabKb === null) return null;
  if (!Number.isFinite(uptimeSec) || !bootId) return null;
  return {
    bootId,
    host: input.host,
    sampledAtMs: input.nowMs,
    bootedAtMs: input.nowMs - Math.round(uptimeSec * 1000),
    memTotalBytes: memTotalKb * 1024,
    sUnreclaimBytes: sUnreclaimKb * 1024,
    slabBytes: slabKb * 1024,
    dyingDescendants: parseDyingDescendants(input.cgroupStat),
  };
}

/** PURE — least-squares slope in units per DAY, or null for fewer than two distinct times. */
export function slopePerDay(points: ReadonlyArray<{ tMs: number; v: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanT = points.reduce((s, p) => s + p.tMs, 0) / n;
  const meanV = points.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.tMs - meanT) * (p.v - meanV);
    den += (p.tMs - meanT) ** 2;
  }
  if (den === 0) return null;
  return (num / den) * DAY_MS;
}

/**
 * PURE — the samples a slope may be fitted over: this boot only, inside the
 * trailing window, and past warm-up.
 */
export function slopeWindow(
  series: readonly KernelMemorySample[],
  current: KernelMemorySample,
): KernelMemorySample[] {
  const from = Math.max(current.sampledAtMs - KERNEL_LEAK_WINDOW_MS, current.bootedAtMs + KERNEL_LEAK_WARMUP_MS);
  return series
    .filter((s) => s.bootId === current.bootId && s.sampledAtMs >= from && s.sampledAtMs <= current.sampledAtMs)
    .sort((a, b) => a.sampledAtMs - b.sampledAtMs);
}

/**
 * PURE — which signals this reading breaches. `series` is the stored history
 * (it may or may not already include `current`; duplicates by time are fine).
 */
export function evaluateKernelLeak(
  series: readonly KernelMemorySample[],
  current: KernelMemorySample,
): KernelLeakAlert[] {
  const alerts: KernelLeakAlert[] = [];
  const window = slopeWindow(series, current);
  const spanMs = window.length ? window[window.length - 1].sampledAtMs - window[0].sampledAtMs : 0;
  const slopeReady = window.length >= KERNEL_LEAK_MIN_SAMPLES && spanMs >= KERNEL_LEAK_MIN_SPAN_MS;
  const base = { sample: current, windowSamples: window.length, windowSpanMs: spanMs };

  if (current.sUnreclaimBytes >= SUNRECLAIM_ABSOLUTE_ALARM_FRACTION * current.memTotalBytes) {
    alerts.push({ signal: 'sunreclaim-absolute', slopePerDay: null, ...base });
  }
  if (slopeReady) {
    const sSlope = slopePerDay(window.map((s) => ({ tMs: s.sampledAtMs, v: s.sUnreclaimBytes })));
    if (sSlope !== null && sSlope >= SUNRECLAIM_SLOPE_ALARM_BYTES_PER_DAY) {
      alerts.push({ signal: 'sunreclaim-growth', slopePerDay: sSlope, ...base });
    }
    const dying = window.filter((s) => s.dyingDescendants !== null);
    if (
      current.dyingDescendants !== null &&
      current.dyingDescendants >= DYING_DESCENDANTS_FLOOR &&
      dying.length >= KERNEL_LEAK_MIN_SAMPLES
    ) {
      const dSlope = slopePerDay(dying.map((s) => ({ tMs: s.sampledAtMs, v: s.dyingDescendants as number })));
      if (dSlope !== null && dSlope >= DYING_DESCENDANTS_SLOPE_ALARM_PER_DAY) {
        alerts.push({ signal: 'dying-growth', slopePerDay: dSlope, ...base });
      }
    }
  }
  return alerts;
}

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

/** PURE — the escalation text for one alert. */
export function formatKernelLeakEscalation(alert: KernelLeakAlert): { summary: string; body: string } {
  const s = alert.sample;
  const uptimeH = ((s.sampledAtMs - s.bootedAtMs) / HOUR_MS).toFixed(1);
  const dying = s.dyingDescendants ?? 'unreadable';
  const window = `${alert.windowSamples} samples over ${(alert.windowSpanMs / HOUR_MS).toFixed(1)} h`;
  let summary: string;
  if (alert.signal === 'sunreclaim-growth') {
    summary = `${s.host}: unreclaimable kernel slab growing ${gib(alert.slopePerDay ?? 0)}/day (now ${gib(s.sUnreclaimBytes)}) — likely a kernel leak`;
  } else if (alert.signal === 'sunreclaim-absolute') {
    summary = `${s.host}: unreclaimable kernel slab at ${gib(s.sUnreclaimBytes)} (≥${SUNRECLAIM_ABSOLUTE_ALARM_FRACTION * 100}% of RAM)`;
  } else {
    summary = `${s.host}: ${dying} dying memory cgroups, growing ${Math.round(alert.slopePerDay ?? 0)}/day — likely pinned by leaked slab`;
  }
  const body =
    `Kernel memory on ${s.host} (boot ${s.bootId}, up ${uptimeH} h): SUnreclaim ${gib(s.sUnreclaimBytes)}, ` +
    `Slab ${gib(s.slabBytes)}, MemTotal ${gib(s.memTotalBytes)}, nr_dying_descendants ${dying}. ` +
    `Slope window: ${window} (warm-up excluded).\n\n` +
    `Unreclaimable slab is memory the kernel will not give back until the leak's owner frees it or the ` +
    `host reboots. It comes straight out of MemAvailable, so every admission budget shrinks with it.\n\n` +
    `Triage:\n` +
    `  1. Which cache is growing (root only). Compare by SIZE, not name — random kmalloc caches ` +
    `re-randomise per boot, so the same leak can be kmalloc-8k on one boot and kmalloc-rnd-03-8k on the next:\n` +
    `     sudo awk 'NR>2 {printf "%.0f MB %s\\n", $3*$4/1048576, $1}' /proc/slabinfo | sort -rn | head\n` +
    `  2. Dying cgroups: cat /sys/fs/cgroup/cgroup.stat\n` +
    `  3. The series: SELECT sampled_at, sunreclaim_bytes, dying_descendants FROM ` +
    `harness_shared.host_kernel_memory_samples WHERE boot_id = '${s.bootId}' ORDER BY sampled_at;\n\n` +
    `Known instance: the 6.17.0-40 AppArmor kmalloc-8k leak (plan host-memory-reduction-2026-09-27, ` +
    `P-001) — the fix is booting 7.0.0-34. A reboot frees the leak; it does not fix it. ` +
    `Thresholds and their calibration: D-007 of that plan.`;
  return { summary, body };
}

export interface KernelLeakDeps {
  readSample: () => Promise<KernelMemorySample | null>;
  store: (sample: KernelMemorySample) => Promise<void>;
  loadSeries: (bootId: string, sinceMs: number) => Promise<KernelMemorySample[]>;
  prune: () => Promise<void>;
  escalate: (alert: KernelLeakAlert) => Promise<void>;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function defaultReadSample(): Promise<KernelMemorySample | null> {
  if (process.platform !== 'linux') return null;
  const [meminfo, cgroupStat, bootId, uptime] = await Promise.all([
    readOptional('/proc/meminfo'),
    readOptional('/sys/fs/cgroup/cgroup.stat'),
    readOptional('/proc/sys/kernel/random/boot_id'),
    readOptional('/proc/uptime'),
  ]);
  if (meminfo === null || bootId === null || uptime === null) return null;
  return buildKernelMemorySample({ meminfo, cgroupStat, bootId, uptime, host: hostname(), nowMs: Date.now() });
}

// NB: the org pool rejects Date params — timestamps go in as ISO strings (see
// system-health/history.ts), and bigint columns come back as strings.
async function defaultStore(sample: KernelMemorySample): Promise<void> {
  const { sql } = getOrgPg();
  const bucketMs = Math.floor(sample.sampledAtMs / KERNEL_LEAK_SAMPLE_INTERVAL_MS) * KERNEL_LEAK_SAMPLE_INTERVAL_MS;
  await sql`
    INSERT INTO harness_shared.host_kernel_memory_samples
      (boot_id, bucket_at, sampled_at, host, booted_at, mem_total_bytes, sunreclaim_bytes, slab_bytes, dying_descendants)
    VALUES (${sample.bootId}, ${new Date(bucketMs).toISOString()}, ${new Date(sample.sampledAtMs).toISOString()},
            ${sample.host}, ${new Date(sample.bootedAtMs).toISOString()}, ${sample.memTotalBytes},
            ${sample.sUnreclaimBytes}, ${sample.slabBytes}, ${sample.dyingDescendants})
    ON CONFLICT (boot_id, bucket_at) DO NOTHING`;
}

async function defaultLoadSeries(bootId: string, sinceMs: number): Promise<KernelMemorySample[]> {
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT boot_id, host, sampled_at, booted_at, mem_total_bytes, sunreclaim_bytes, slab_bytes, dying_descendants
      FROM harness_shared.host_kernel_memory_samples
     WHERE boot_id = ${bootId} AND sampled_at >= ${new Date(sinceMs).toISOString()}
     ORDER BY sampled_at`) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    bootId: String(r.boot_id),
    host: String(r.host),
    sampledAtMs: Date.parse(String(r.sampled_at)),
    bootedAtMs: Date.parse(String(r.booted_at)),
    memTotalBytes: Number(r.mem_total_bytes),
    sUnreclaimBytes: Number(r.sunreclaim_bytes),
    slabBytes: Number(r.slab_bytes),
    dyingDescendants: r.dying_descendants === null ? null : Number(r.dying_descendants),
  }));
}

async function defaultPrune(): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.host_kernel_memory_samples
             WHERE sampled_at < now() - make_interval(days => ${KERNEL_LEAK_RETENTION_DAYS})`;
}

async function defaultEscalate(alert: KernelLeakAlert): Promise<void> {
  const { summary, body } = formatKernelLeakEscalation(alert);
  await openEscalation(WATCHDOG_IDENTITY, {
    severity: 'advisory',
    summary,
    body,
    meta: {
      dedupKind: 'kernel-memory-leak',
      subjectSignature: `${alert.sample.host}:${alert.sample.bootId}:${alert.signal}`,
      signal: alert.signal,
      bootId: alert.sample.bootId,
      sUnreclaimBytes: alert.sample.sUnreclaimBytes,
      dyingDescendants: alert.sample.dyingDescendants,
      slopePerDay: alert.slopePerDay,
    },
  });
}

export interface KernelLeakCheckResult {
  skipped: boolean;
  sample: KernelMemorySample | null;
  alerts: KernelLeakAlert[];
}

/**
 * One tick: read, store, evaluate, escalate. Never throws — a failed store or
 * escalation is logged and the next tick retries. Exported for tests.
 */
export async function runKernelLeakCheckOnce(overrides: Partial<KernelLeakDeps> = {}): Promise<KernelLeakCheckResult> {
  const deps: KernelLeakDeps = {
    readSample: defaultReadSample,
    store: defaultStore,
    loadSeries: defaultLoadSeries,
    prune: defaultPrune,
    escalate: defaultEscalate,
    ...overrides,
  };
  const warn = (what: string, err: unknown): void =>
    console.warn(`[kernel-leak-watchdog] ${what} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);

  let sample: KernelMemorySample | null;
  try {
    sample = await deps.readSample();
  } catch (err) {
    warn('read', err);
    return { skipped: true, sample: null, alerts: [] };
  }
  if (!sample) return { skipped: true, sample: null, alerts: [] };

  try {
    await deps.store(sample);
    await deps.prune();
  } catch (err) {
    warn('store', err);
  }

  let series: KernelMemorySample[] = [];
  try {
    series = await deps.loadSeries(sample.bootId, sample.sampledAtMs - KERNEL_LEAK_WINDOW_MS);
  } catch (err) {
    // The absolute signal still works without history.
    warn('load', err);
  }

  const alerts = evaluateKernelLeak([...series, sample], sample);
  for (const alert of alerts) {
    try {
      await deps.escalate(alert);
    } catch (err) {
      warn(`escalate ${alert.signal}`, err);
    }
  }
  return { skipped: false, sample, alerts };
}
