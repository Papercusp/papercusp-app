/**
 * Summarize a `vm/sample-footprint.py` JSON-lines capture into per-class CPU and memory.
 *
 * Plan agent-capacity-and-cost-gcp-2026-09-30, S7 (WI-10004395): the Papercusp Server's own
 * cost on a cloud VM, so the capacity model can subtract a fixed per-VM overhead before it
 * divides by agents.
 *
 * Two CPU numbers, deliberately kept apart:
 * - `totalCpuPct` comes from the cgroup's `cpu.stat usage_usec`. It is exact and includes
 *   processes that started and exited between two samples (short `git` runs, workers).
 * - per-class `cpuPct` comes from each process's utime+stime delta, and only counts processes
 *   seen at BOTH ends of an interval. The gap between their sum and the total is reported as
 *   `unattributedCpuPct` rather than hidden.
 *
 * CPU percentages are of ONE core (100 = one core busy), the unit `top` uses.
 *
 *   npx tsx scripts/agent-capacity/footprint-summary.ts <capture.jsonl> [--from=<s>] [--to=<s>]
 *
 * `--from` / `--to` are seconds relative to the first sample, so a boot phase and a steady
 * phase can be summarized separately from one capture.
 */
import { readFileSync } from 'node:fs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
  cls: string;
  rss_kb: number;
  anon_kb: number;
  /** P-015: swapped-out anon (VmSwap) and cumulative major faults. Absent in pre-P-015 captures. */
  swap_kb?: number;
  majflt?: number;
  ticks: number;
}
/** Cumulative PSI stall time, microseconds. */
export interface Psi {
  some_us?: number;
  full_us?: number;
}
/** P-015: machine-wide swap/zram/pressure counters (vm/sample-footprint.py `host_sample`). */
export interface HostRow {
  pswpin?: number;
  pswpout?: number;
  pgmajfault?: number;
  MemAvailable_kb?: number;
  SwapTotal_kb?: number;
  SwapFree_kb?: number;
  psi?: Psi;
  zram?: Record<string, { orig: number; compr: number; used: number }>;
}
export interface Sample {
  t: number;
  cg: { mem?: number; anon?: number; file?: number; cpu_usec?: number; swap?: number; pgmajfault?: number; psi?: Psi };
  host?: HostRow;
  procs: ProcRow[];
}
export interface Header {
  host: string;
  label: string;
  cgroup: string;
  clk_tck: number;
  nproc: number;
  mem_total_kb: number;
  interval: number;
  started: number;
}
export interface Capture {
  header: Header;
  samples: Sample[];
}

export interface Stat {
  mean: number;
  p95: number;
  max: number;
}
export interface ClassSummary {
  cls: string;
  /** Distinct pids seen in the window. */
  processes: number;
  cpuPct: Stat;
  rssMb: Stat;
  anonMb: Stat;
  /** Swapped-out memory of the class's processes (VmSwap), MB. */
  swapMb: Stat;
  /**
   * Major faults per second, processes seen at both ends of an interval (same rule as cpuPct).
   * Under swap this is the swap-in the class causes: a Node CLI whose GC walks its heap keeps it
   * above zero while idle, a Rust CLI does not.
   */
  majorFaultsPerSec: Stat;
}
/** P-015 swap lever: present only when the capture carries `host` rows. */
export interface SwapSummary {
  /** Machine swap in use (SwapTotal - SwapFree), MB. zram swap counts the STORED size here. */
  hostSwapUsedMb: Stat;
  cgroupSwapMb: Stat;
  /** Pages per second (4 KiB) swapped in / out, machine-wide. */
  swapInPerSec: Stat;
  swapOutPerSec: Stat;
  hostMajorFaultsPerSec: Stat;
  /** % of wall time some / all non-idle tasks stalled on memory (PSI), machine-wide. */
  hostPsiSomePct: Stat;
  hostPsiFullPct: Stat;
  cgroupPsiFullPct: Stat;
  /** Lowest MemAvailable seen in the window, MB (-1 when never sampled). */
  memAvailableMinMb: number;
  /** RAM the zram devices really hold (mem_used_total), and the uncompressed size they store. */
  zramUsedMb: Stat;
  zramStoredMb: Stat;
}
export interface Summary {
  host: string;
  label: string;
  windowSec: number;
  samples: number;
  totalCpuPct: Stat;
  unattributedCpuPct: number;
  cgroupMemMb: Stat;
  cgroupAnonMb: Stat;
  classes: ClassSummary[];
  swap?: SwapSummary;
}

export function parseCapture(text: string): Capture {
  let header: Header | null = null;
  const samples: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { header?: Header } & Partial<Sample>;
    if (row.header) {
      // A re-run appends a second header to the same file; keep the first capture only.
      if (header) break;
      header = row.header;
    } else if (typeof row.t === 'number') {
      samples.push({ t: row.t, cg: row.cg ?? {}, ...(row.host ? { host: row.host } : {}), procs: row.procs ?? [] });
    }
  }
  if (!header) throw new Error('capture has no header line');
  return { header, samples };
}

export function stat(values: number[]): Stat {
  if (values.length === 0) return { mean: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  return { mean, p95, max: sorted[sorted.length - 1] };
}

const MB = 1024 * 1024;

/** Per-second rate of a cumulative counter between consecutive samples; a reset (b < a) is skipped. */
function rates(samples: Sample[], get: (s: Sample) => number | undefined, scale = 1): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = get(samples[i - 1]);
    const b = get(samples[i]);
    const dt = samples[i].t - samples[i - 1].t;
    if (a === undefined || b === undefined || dt <= 0 || b < a) continue;
    out.push(((b - a) / dt) * scale);
  }
  return out;
}

function levels(samples: Sample[], get: (s: Sample) => number | undefined): number[] {
  return samples.flatMap((s) => {
    const v = get(s);
    return v === undefined ? [] : [v];
  });
}

function zramSum(s: Sample, key: 'used' | 'orig'): number | undefined {
  const devs = s.host?.zram ? Object.values(s.host.zram) : [];
  return devs.length ? devs.reduce((sum, d) => sum + d[key], 0) / MB : undefined;
}

function swapSummary(samples: Sample[]): SwapSummary | undefined {
  if (!samples.some((s) => s.host)) return undefined;
  // PSI totals are microseconds of stall; per second of wall that is (us / 1e6) * 100 percent.
  const PSI_PCT = 1e-4;
  const available = levels(samples, (s) => (s.host?.MemAvailable_kb === undefined ? undefined : s.host.MemAvailable_kb / 1024));
  return {
    hostSwapUsedMb: stat(
      levels(samples, (s) =>
        s.host?.SwapTotal_kb === undefined || s.host.SwapFree_kb === undefined
          ? undefined
          : (s.host.SwapTotal_kb - s.host.SwapFree_kb) / 1024,
      ),
    ),
    cgroupSwapMb: stat(levels(samples, (s) => (s.cg.swap === undefined ? undefined : s.cg.swap / MB))),
    swapInPerSec: stat(rates(samples, (s) => s.host?.pswpin)),
    swapOutPerSec: stat(rates(samples, (s) => s.host?.pswpout)),
    hostMajorFaultsPerSec: stat(rates(samples, (s) => s.host?.pgmajfault)),
    hostPsiSomePct: stat(rates(samples, (s) => s.host?.psi?.some_us, PSI_PCT)),
    hostPsiFullPct: stat(rates(samples, (s) => s.host?.psi?.full_us, PSI_PCT)),
    cgroupPsiFullPct: stat(rates(samples, (s) => s.cg.psi?.full_us, PSI_PCT)),
    memAvailableMinMb: available.length ? Math.min(...available) : -1,
    zramUsedMb: stat(levels(samples, (s) => zramSum(s, 'used'))),
    zramStoredMb: stat(levels(samples, (s) => zramSum(s, 'orig'))),
  };
}

export function summarize(capture: Capture, opts: { from?: number; to?: number } = {}): Summary {
  const { header } = capture;
  const t0 = capture.samples[0]?.t ?? 0;
  const samples = capture.samples.filter((s) => {
    const rel = s.t - t0;
    return (opts.from === undefined || rel >= opts.from) && (opts.to === undefined || rel <= opts.to);
  });
  const hz = header.clk_tck || 100;

  const totalCpu: number[] = [];
  const perClassCpu = new Map<string, number[]>();
  const perClassFaults = new Map<string, number[]>();
  let attributedSum = 0;
  let totalSum = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue;
    const intervalCpu = new Map<string, number>();
    const intervalFaults = new Map<string, number>();
    const before = new Map(a.procs.map((p) => [p.pid, p]));
    for (const p of b.procs) {
      const prev = before.get(p.pid);
      // A recycled pid (different comm, or ticks going backwards) is a different process.
      if (!prev || prev.comm !== p.comm || p.ticks < prev.ticks) continue;
      const pct = ((p.ticks - prev.ticks) / hz / dt) * 100;
      intervalCpu.set(p.cls, (intervalCpu.get(p.cls) ?? 0) + pct);
      if (p.majflt !== undefined && prev.majflt !== undefined && p.majflt >= prev.majflt) {
        intervalFaults.set(p.cls, (intervalFaults.get(p.cls) ?? 0) + (p.majflt - prev.majflt) / dt);
      }
    }
    for (const [cls, rate] of intervalFaults) {
      const list = perClassFaults.get(cls) ?? [];
      list.push(rate);
      perClassFaults.set(cls, list);
    }
    const attributed = [...intervalCpu.values()].reduce((s, v) => s + v, 0);
    if (a.cg.cpu_usec !== undefined && b.cg.cpu_usec !== undefined) {
      const total = ((b.cg.cpu_usec - a.cg.cpu_usec) / 1e6 / dt) * 100;
      totalCpu.push(total);
      totalSum += total;
      attributedSum += attributed;
    }
    for (const [cls, pct] of intervalCpu) {
      const list = perClassCpu.get(cls) ?? [];
      list.push(pct);
      perClassCpu.set(cls, list);
    }
  }
  const intervals = Math.max(0, samples.length - 1);

  const classes = new Map<string, { pids: Set<number>; rss: number[]; anon: number[]; swap: number[] }>();
  for (const s of samples) {
    const tick = new Map<string, { rss: number; anon: number; swap: number }>();
    for (const p of s.procs) {
      const cur = tick.get(p.cls) ?? { rss: 0, anon: 0, swap: 0 };
      cur.rss += p.rss_kb;
      cur.anon += p.anon_kb;
      cur.swap += p.swap_kb ?? 0;
      tick.set(p.cls, cur);
      const c = classes.get(p.cls) ?? { pids: new Set<number>(), rss: [], anon: [], swap: [] };
      c.pids.add(p.pid);
      classes.set(p.cls, c);
    }
    // A class absent from this sample contributes 0 MB, so short-lived classes average low.
    for (const [cls, c] of classes) {
      const cur = tick.get(cls) ?? { rss: 0, anon: 0, swap: 0 };
      c.rss.push(cur.rss / 1024);
      c.anon.push(cur.anon / 1024);
      c.swap.push(cur.swap / 1024);
    }
  }

  const classSummaries: ClassSummary[] = [...classes.entries()].map(([cls, c]) => {
    // Pad with zeros for intervals where the class used no measurable CPU / took no major fault.
    const cpu = [...(perClassCpu.get(cls) ?? [])];
    while (cpu.length < intervals) cpu.push(0);
    const faults = [...(perClassFaults.get(cls) ?? [])];
    while (faults.length < intervals) faults.push(0);
    return {
      cls,
      processes: c.pids.size,
      cpuPct: stat(cpu),
      rssMb: stat(c.rss),
      anonMb: stat(c.anon),
      swapMb: stat(c.swap),
      majorFaultsPerSec: stat(faults),
    };
  });
  classSummaries.sort((x, y) => y.rssMb.mean - x.rssMb.mean);

  return {
    host: header.host,
    label: header.label,
    windowSec: samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0,
    samples: samples.length,
    totalCpuPct: stat(totalCpu),
    unattributedCpuPct: totalCpu.length ? (totalSum - attributedSum) / totalCpu.length : 0,
    cgroupMemMb: stat(samples.flatMap((s) => (s.cg.mem === undefined ? [] : [s.cg.mem / MB]))),
    cgroupAnonMb: stat(samples.flatMap((s) => (s.cg.anon === undefined ? [] : [s.cg.anon / MB]))),
    classes: classSummaries,
    ...(swapSummaryOf(samples)),
  };
}

function swapSummaryOf(samples: Sample[]): { swap?: SwapSummary } {
  const swap = swapSummary(samples);
  return swap ? { swap } : {};
}

function fmt(s: Stat, digits = 1): string {
  return `${s.mean.toFixed(digits)} / ${s.p95.toFixed(digits)} / ${s.max.toFixed(digits)}`;
}

export function renderTable(s: Summary): string {
  const lines = [
    `host=${s.host} label=${s.label} window=${Math.round(s.windowSec)}s samples=${s.samples}`,
    `total CPU % of one core (mean / p95 / max): ${fmt(s.totalCpuPct)}  unattributed mean: ${s.unattributedCpuPct.toFixed(1)}`,
    `cgroup memory MB: ${fmt(s.cgroupMemMb, 0)}  of which anon: ${fmt(s.cgroupAnonMb, 0)}`,
  ];
  const w = s.swap;
  if (w) {
    lines.push(
      `swap MB host / cgroup (mean / p95 / max): ${fmt(w.hostSwapUsedMb, 0)}  /  ${fmt(w.cgroupSwapMb, 0)}`,
      `swap pages/s in / out: ${fmt(w.swapInPerSec)}  /  ${fmt(w.swapOutPerSec)}  host major faults/s: ${fmt(w.hostMajorFaultsPerSec)}`,
      `memory PSI % host some / full: ${fmt(w.hostPsiSomePct, 2)}  /  ${fmt(w.hostPsiFullPct, 2)}  cgroup full: ${fmt(w.cgroupPsiFullPct, 2)}`,
      `MemAvailable min MB: ${Math.round(w.memAvailableMinMb)}  zram RAM / stored MB: ${fmt(w.zramUsedMb, 0)}  /  ${fmt(w.zramStoredMb, 0)}`,
    );
  }
  lines.push(
    '',
    'class | procs | CPU % (mean/p95/max) | RSS MB (mean/p95/max) | anon MB (mean/p95/max) | swap MB (mean/p95/max) | majflt/s (mean/p95/max)',
    ...s.classes.map(
      (c) =>
        `${c.cls} | ${c.processes} | ${fmt(c.cpuPct)} | ${fmt(c.rssMb, 0)} | ${fmt(c.anonMb, 0)} | ${fmt(c.swapMb, 0)} | ${fmt(c.majorFaultsPerSec)}`,
    ),
  );
  return lines.join('\n');
}

function num(argv: string[], name: string): number | undefined {
  const raw = argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  return raw === undefined ? undefined : Number(raw);
}

if (isCliEntry(import.meta.url)) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error('usage: footprint-summary.ts <capture.jsonl> [--from=<s>] [--to=<s>] [--json]');
    process.exit(2);
  }
  const summary = summarize(parseCapture(readFileSync(file, 'utf8')), { from: num(rest, 'from'), to: num(rest, 'to') });
  console.log(rest.includes('--json') ? JSON.stringify(summary, null, 2) : renderTable(summary));
}
