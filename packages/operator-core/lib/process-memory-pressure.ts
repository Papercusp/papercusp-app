/**
 * Per-process memory-pressure signal — "is this process wedged by a CODE BUG, or
 * is it swap-thrashing under box-wide memory pressure?"
 *
 * WI-7329, split out of EI-19406226890070872. Measured 2026-08-03 on the owner's
 * live :3270 desktop dev sidecar: pid 3129329 had a full TCP accept queue
 * (Recv-Q approaching backlog 511), `/api/health` timing out on every probe, the
 * process alive and CPU-hot at ~94% of one core, and 25 threads. Every available
 * signal pointed at a busy loop or an O(n²) bug in `bin/hono-host.ts`. That
 * hypothesis was WRONG. Direct `/proc` evidence:
 *
 *   - `VmSwap: 9,476,472 kB` (~9.5 GB) against only ~4.2 GB `VmRSS` — most of the
 *     process's footprint was paged out.
 *   - `/proc/pressure/memory` `full avg10=15.51` — for >15% of the last 10s EVERY
 *     non-idle task on the box was stalled waiting on memory.
 *   - `majflt` climbing ~4–5/sec — actively touching swapped-out pages and paying
 *     disk latency for each one.
 *
 * A Node event loop stalled on major page faults produces the SAME symptom
 * signature as a hot synchronous JS loop: high CPU, full accept queue, live pid,
 * `systemctl is-active` green, TCP connect succeeding. Nothing in the health
 * surface could tell them apart, so the diagnosis took several manual `/proc`
 * reads. This module is that manual work, done once, in code.
 *
 * ## Why this is diagnostic color and NEVER an alarm
 *
 * Every value here is advisory context attached to a probe that ALREADY failed.
 * It must never flip `up`, `wedged`, or `present`, and must never originate a
 * transition — `service-health.ts` has repeatedly been bitten by diagnostics that
 * became false-positive sources (see its EI-188/EI-276 lessons). A reader gets a
 * better EXPLANATION of a failure that was already detected; they never get a new
 * failure.
 *
 * ## Reading the fields: null means UNDETERMINED, never "fine"
 *
 * Every numeric field is `number | null`, and null means the measurement could not
 * be taken (non-Linux, pid gone, `/proc` unreadable, permission denied). Never read
 * a null as zero and never read it as healthy — that inversion is the exact class of
 * bug this file exists to prevent. The two verdict booleans are deliberately
 * FALSE-when-undetermined and are only ever true on positive evidence, so a caller
 * that ignores nulls degrades to "said nothing" rather than to "said healthy".
 */

/** Kilobyte fields lifted from `/proc/<pid>/status`. Null = the line was absent or unparseable. */
export interface ProcStatusMemory {
  /** `VmRSS` — resident set size, i.e. the part actually in physical RAM. */
  vmRssKb: number | null;
  /** `VmSwap` — how much of this process's memory the kernel has paged out to swap. */
  vmSwapKb: number | null;
}

/**
 * A per-process memory-pressure sample. Attached to a FAILED probe as evidence;
 * carries no verdict about whether the service should be restarted.
 */
export interface ProcessMemoryPressure {
  pid: number;
  vmRssKb: number | null;
  vmSwapKb: number | null;
  /** Cumulative major page faults since process start (`majflt`, `/proc/<pid>/stat` field 12). */
  majorFaults: number | null;
  /**
   * Major faults accrued across `sampleWindowMs`. THE load-bearing field: a
   * cumulative `majorFaults` total is nearly meaningless (a long-lived process
   * legitimately faulted while warming up hours ago), whereas a nonzero delta
   * measured right now means the process is actively paying disk latency for
   * swapped-out pages AT THE MOMENT IT LOOKS WEDGED.
   *
   * Null = the second sample could not be taken (process exited mid-window, or
   * `/proc` became unreadable). Never read null as 0.
   */
  majorFaultDelta: number | null;
  /** Actual elapsed time between the two `majflt` samples; null when only one sample was taken. */
  sampleWindowMs: number | null;
  /**
   * `/proc/pressure/memory`'s **full** avg10 — the share of the last 10s during
   * which EVERY non-idle task on the box was stalled on memory.
   *
   * Deliberately the `full` line, not `some`. `some` (which the existing
   * `host.psiMemSome60` orient fact reports) counts windows where at least one
   * task stalled, which is common and mild on a busy box; `full` means NOTHING
   * could run, which is the severe condition. They are different questions and
   * must not be conflated — 15.51 on `full` was the measured severe case.
   */
  systemPsiMemFullAvg10: number | null;
  /**
   * TRUE only on positive evidence that more of this process lives in swap than
   * in RAM (`vmSwapKb > vmRssKb`, both read). That inversion is the fingerprint
   * of the measured incident (9.5 GB swapped vs 4.2 GB resident) and does not
   * occur on a healthy process.
   *
   * FALSE when undetermined, by construction — see the module note on nulls.
   */
  swapDominant: boolean;
  /**
   * TRUE only on positive evidence that the process is ACTIVELY thrashing right
   * now: it has memory in swap AND took at least one major fault during the
   * sample window. Both legs are required — swap that is merely resident-but-idle
   * (a long-idle process the kernel paged out and nobody has touched since) costs
   * nothing and is not a wedge explanation, while major faults with no swap are
   * ordinary file-backed demand paging (a first read of a large file).
   *
   * FALSE when undetermined, by construction.
   */
  thrashing: boolean;
}

/** Options for {@link readProcessMemoryPressure}. */
export interface ReadProcessMemoryPressureOptions {
  /**
   * Gap between the two `majflt` samples. Default 500ms.
   *
   * The measured incident faulted at ~4–5/sec, so 500ms yields ~2–3 faults — far
   * enough from zero to be decisive, because the discriminator is nonzero-vs-zero
   * rather than a rate: a warm, healthy process major-faults essentially never.
   * Kept short on purpose. This runs inside a health probe, and a diagnostic that
   * materially slows the probe it rides on would be the same class of bug as a
   * diagnostic that can break it.
   */
  sampleWindowMs?: number;
  /** Injected ONLY so tests can exercise the sampler without a real /proc or real waiting. */
  readFile?: (path: string) => Promise<string>;
  /** Injected ONLY for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAJFLT_SAMPLE_WINDOW_MS = 500;

/**
 * Parse `VmRSS` / `VmSwap` out of a `/proc/<pid>/status` body.
 *
 * Pure and total: any unreadable or absent field comes back null rather than
 * throwing, so one malformed line can never take down the probe carrying it.
 */
export function parseProcStatusMemory(raw: string): ProcStatusMemory {
  const field = (name: string): number | null => {
    // Kernel format: "VmSwap:\t 9476472 kB" — tabs/spaces vary by field width.
    const m = new RegExp(`^${name}:[ \\t]*(\\d+)[ \\t]*kB[ \\t]*$`, 'm').exec(raw);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  };
  return { vmRssKb: field('VmRSS'), vmSwapKb: field('VmSwap') };
}

/**
 * Parse cumulative major page faults (`majflt`) out of a `/proc/<pid>/stat` body.
 *
 * ⚠ The parsing trap this function exists to contain: field 2 is `comm`, the
 * executable name, wrapped in parentheses AND NOT ESCAPED. A process named
 * `(my weird) proc` yields `1234 ((my weird) proc) S 1 ...`, so splitting the line
 * on whitespace — the obvious implementation — silently shifts every subsequent
 * field and returns some unrelated counter as `majflt`. That failure is invisible:
 * it produces a plausible number, not an error. So the fields are located from the
 * LAST `)` in the line, which is unambiguous because `comm` is the only
 * parenthesised field and the kernel truncates it to 15 chars.
 *
 * After that `)`, the space-separated fields begin at field 3 (`state`), so field N
 * sits at index N-3; `majflt` is field 12, hence index 9.
 */
export function parseProcStatMajorFaults(raw: string): number | null {
  const close = raw.lastIndexOf(')');
  if (close === -1) return null;
  const rest = raw.slice(close + 1).trim();
  if (!rest) return null;
  const fields = rest.split(/\s+/);
  const MAJFLT_INDEX_AFTER_COMM = 9; // field 12 − 3
  const raw12 = fields[MAJFLT_INDEX_AFTER_COMM];
  if (raw12 === undefined) return null;
  const n = Number(raw12);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse the **full** avg10 out of a `/proc/pressure/memory` body.
 *
 * Body shape:
 *   some avg10=64.53 avg60=31.41 avg300=18.30 total=34520663414
 *   full avg10=58.58 avg60=26.79 avg300=13.55 total=26331147630
 *
 * Reads the `full` line specifically. Returning the `some` value here would be
 * the silent-wrong-answer failure — `some` runs much higher on any busy box, so
 * it would manufacture severe-pressure verdicts out of ordinary load.
 */
export function parsePsiMemoryFullAvg10(raw: string): number | null {
  const m = /^full\s+avg10=([\d.]+)/m.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Sample a live process's memory pressure. FAIL-SOFT on every leg: a missing
 * `/proc`, a pid that exited mid-sample, a permission error, or a non-Linux host
 * all yield nulls (or `null` outright when nothing at all could be read), never a
 * throw and never a fabricated verdict.
 *
 * Returns null when the host is not Linux or the process's `/proc/<pid>/status`
 * cannot be read at all — i.e. "no measurement", which the caller must render as
 * silence rather than as health.
 */
export async function readProcessMemoryPressure(
  pid: number,
  opts: ReadProcessMemoryPressureOptions = {},
): Promise<ProcessMemoryPressure | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (opts.readFile === undefined && process.platform !== 'linux') return null;

  const sleep = opts.sleep ?? sleepReal;
  const windowMs = opts.sampleWindowMs ?? DEFAULT_MAJFLT_SAMPLE_WINDOW_MS;

  const read =
    opts.readFile ??
    (async (p: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(p, 'utf8');
    });
  const readOrNull = async (p: string): Promise<string | null> => {
    try {
      return await read(p);
    } catch {
      return null;
    }
  };

  const statusRaw = await readOrNull(`/proc/${pid}/status`);
  if (statusRaw === null) return null; // pid gone or /proc unreadable — no measurement at all.
  const { vmRssKb, vmSwapKb } = parseProcStatusMemory(statusRaw);

  // Two majflt samples around a short window. The FIRST is taken before the PSI
  // read so the window brackets as little unrelated work as possible.
  const statRaw1 = await readOrNull(`/proc/${pid}/stat`);
  const t0 = Date.now();
  const majorFaults1 = statRaw1 === null ? null : parseProcStatMajorFaults(statRaw1);

  const psiRaw = await readOrNull('/proc/pressure/memory');
  const systemPsiMemFullAvg10 = psiRaw === null ? null : parsePsiMemoryFullAvg10(psiRaw);

  let majorFaults = majorFaults1;
  let majorFaultDelta: number | null = null;
  let sampleWindowMs: number | null = null;
  if (majorFaults1 !== null && windowMs > 0) {
    await sleep(windowMs);
    const statRaw2 = await readOrNull(`/proc/${pid}/stat`);
    const majorFaults2 = statRaw2 === null ? null : parseProcStatMajorFaults(statRaw2);
    if (majorFaults2 !== null) {
      majorFaults = majorFaults2;
      // Clamped at 0: the counter is monotonic per-process, so a negative delta
      // can only mean the pid was recycled under us. Report "no evidence of
      // faulting" rather than a nonsense negative.
      majorFaultDelta = Math.max(0, majorFaults2 - majorFaults1);
      sampleWindowMs = Date.now() - t0;
    }
  }

  const hasSwap = vmSwapKb !== null && vmSwapKb > 0;
  return {
    pid,
    vmRssKb,
    vmSwapKb,
    majorFaults,
    majorFaultDelta,
    sampleWindowMs,
    systemPsiMemFullAvg10,
    swapDominant: vmSwapKb !== null && vmRssKb !== null && vmSwapKb > vmRssKb,
    thrashing: hasSwap && majorFaultDelta !== null && majorFaultDelta > 0,
  };
}

/** `full avg10` at or above this is treated as severe enough to name in the note.
 *  Calibrated from the measured incident (15.51 was unambiguously severe); the
 *  threshold only controls WORDING, never a verdict or an alarm. */
export const PSI_MEM_FULL_SEVERE_AVG10 = 10;

const gib = (kb: number): string => `${(kb / 1024 / 1024).toFixed(1)} GB`;

/**
 * Render a sample as diagnostic prose for a failed probe's `note`, or null when
 * the sample says nothing worth adding.
 *
 * Returns null unless there is POSITIVE evidence of memory pressure. Staying
 * silent on a healthy sample is deliberate: appending "memory looks fine" to
 * every failed probe would bury the signal in the case it exists to catch, and
 * would also assert health from a measurement that may simply have failed.
 */
export function describeMemoryPressure(p: ProcessMemoryPressure | null): string | null {
  if (!p) return null;
  const severePsi =
    p.systemPsiMemFullAvg10 !== null && p.systemPsiMemFullAvg10 >= PSI_MEM_FULL_SEVERE_AVG10;
  if (!p.thrashing && !p.swapDominant && !severePsi) return null;

  const parts: string[] = [];
  if (p.thrashing || p.swapDominant) {
    const swap = p.vmSwapKb !== null ? gib(p.vmSwapKb) : 'an unread amount';
    const rss = p.vmRssKb !== null ? gib(p.vmRssKb) : 'unread';
    parts.push(
      `pid ${p.pid} has ${swap} swapped out against ${rss} resident` +
        (p.swapDominant ? ' (MORE of it is in swap than in RAM)' : ''),
    );
  }
  if (p.thrashing && p.majorFaultDelta !== null) {
    parts.push(
      `and took ${p.majorFaultDelta} major page fault(s) in ${p.sampleWindowMs ?? '?'}ms — it is actively paying disk latency for swapped-out pages`,
    );
  }
  if (severePsi) {
    parts.push(
      `box-wide memory PSI full avg10=${p.systemPsiMemFullAvg10} (for that share of the last 10s NO task on this host could run)`,
    );
  }
  // The corrective half. A wedge verdict otherwise reads as "the event loop is
  // blocked, find the blocking code" — which is precisely the wrong hypothesis
  // when the loop is stalled on major faults, and is the several-minute
  // misdiagnosis this whole item exists to prevent.
  const corrective =
    p.thrashing || p.swapDominant
      ? ' MEMORY PRESSURE, not necessarily a code bug: a Node event loop stalled on major page faults produces the same signature as a hot synchronous loop (high CPU, full accept queue, live pid, is-active green). Rule out memory before hunting a blocking-code bug; restarting reclaims the swapped pages and will look like a fix without being one.'
      : ' The box is under severe memory pressure, so this failure may be resource-induced rather than a fault in the service itself.';
  return `${parts.join(', ')}.${corrective}`;
}
