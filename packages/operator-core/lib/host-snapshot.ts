/**
 * host-snapshot — the four scalars agents currently shell out for, computed
 * cheaply enough to ride along on a call they already make
 * (plan `bash-to-tool-substitution-2026-07-26`, P-026 + P-027).
 *
 * ── Why this exists (measured, not assumed) ─────────────────────────────────
 * Two plan items measured two unrelated-looking bash families over the 7d
 * corpus and landed on the SAME answer:
 *
 *  • P-026 host resources — 370 atoms / 47 of 86 sessions, the broadest session
 *    coverage in the whole audit. Of that, the load/mem/core half is 283 atoms
 *    across just 26 distinct shapes: `uptime` (106), `cat /proc/loadavg` (64),
 *    `nproc` (43), `free -h` (25). Distinct-per-atom is 5–12% — i.e. the same
 *    handful of zero-argument reads, over and over. `nproc` is the purest case:
 *    27 sessions asked an INVARIANT of the box, 9 of them more than once.
 *  • P-027 clock — 852 atoms / 50 of 86 sessions. 586 of them (69%) are bare
 *    `date` or `date -u` with no format at all.
 *
 * A near-constant answer that is asked repeatedly does not want a VERB — a verb
 * still costs the inference round-trip that is the entire cost being measured.
 * It wants to have already arrived. So this snapshot is folded into
 * `coord:orient` (a call made 1,207 times in the same window) rather than
 * exposed as `dev:host`.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * The other half of each family stays bash, because a tool there would be a
 * passthrough (plan D-034):
 *  • `du`/`df` — 88 atoms across 73 DISTINCT shapes (83% distinct-per-atom),
 *    arbitrary paths and globs. That is ad-hoc exploration, not a repeated
 *    question, and no fixed field answers it.
 *  • `$(date …)` INSIDE another command — 279 atoms. That is string
 *    interpolation into a shell command; no context field can remove it.
 *
 * ── Cost discipline ─────────────────────────────────────────────────────────
 * This rides on EVERY orient, so it must stay near-free and never throw. Load
 * and memory come from `os` (in-process counters, no syscall fan-out); cores
 * come from the already-memoized `@papercusp/resource-profile`; the one file
 * read (`/proc/pressure/memory`) is cached for {@link PSI_CACHE_MS} and is
 * fully optional — every leg fails soft to `undefined` rather than degrading
 * the orient around it.
 */

import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';

/** How long a `/proc/pressure/memory` read is reused. Orient is called often
 *  enough that re-reading per call is pointless; PSI avg10/avg60 cannot move
 *  meaningfully inside this window. */
export const PSI_CACHE_MS = 5_000;

/**
 * How long a `/proc/stat` run-queue read is reused.
 *
 * Deliberately its OWN constant rather than sharing {@link PSI_CACHE_MS}, because
 * the justification is different and the difference is the interesting part. PSI
 * is cached because avg10/avg60 *cannot move* inside the window. `procs_running`
 * very much can — it was measured swinging 39→76 inside five seconds on this box.
 * It is cached anyway, for cost (a full `/proc/stat` read is 16.8 KB / 0.225 ms,
 * ~8x the pressure read, on a path that runs on every orient), and the staleness
 * is acceptable for a specific reason: the number this field exists to
 * disambiguate is a 1-MINUTE EWMA, so even a 5-second-old instantaneous sample is
 * an order of magnitude fresher than the figure it is explaining.
 *
 * That trade is only safe while this is read as a SNAPSHOT. Do not build a trend,
 * a rate, or a saturation verdict out of repeated calls inside this window — they
 * would return the same cached sample and manufacture a stability that was never
 * measured.
 */
export const RUNQ_CACHE_MS = 5_000;

/**
 * The scalars an agent would otherwise shell out for.
 *
 * Every field except `now` is optional: a leg that cannot be read is ABSENT
 * rather than zero, so a consumer never mistakes "unreadable" for "idle". `now`
 * is the only guaranteed field because a clock read cannot fail.
 */
export interface HostSnapshot {
  /** Current instant, ISO-8601 **UTC** with milliseconds. Replaces the 586 bare
   *  `date` / `date -u` reads: every other format the corpus asks for (`+%s`,
   *  `+%H:%M:%SZ`, `+%FT%TZ`, …) is a pure rendering of this same instant.
   *
   *  ⚠ It is UTC, and a bare `date` prints LOCAL — so this field is NOT a
   *  like-for-like swap for the reads it replaces, and the substitution changes
   *  timezone silently. That mismatch has repeatedly manufactured a phantom
   *  staleness gap: every filesystem timestamp an agent compares this against
   *  (`ls -la`, `stat`, journald) renders in LOCAL time, so on this UTC-4 box a
   *  file written one minute ago reads four hours stale, and "the job never
   *  wrote to it" is the natural — and wrong — conclusion. Compare against
   *  {@link nowLocal} instead, which is rendered in the SAME zone those tools
   *  print in. (EI-20086558925351815, filed 6× before the field existed.) */
  now: string;
  /**
   * The same instant rendered in the HOST'S LOCAL zone, in the shape `ls -la` /
   * `stat` print — `2026-08-10 14:05:44 EDT (UTC-04:00)`.
   *
   * This exists so the comparison an agent actually performs is correct BY
   * DEFAULT, rather than correct only if it remembers to convert. The zone
   * abbreviation and explicit offset are both carried because the offset is what
   * makes the arithmetic checkable and the abbreviation is what appears in
   * `date` output.
   *
   * Always present: unlike the other optional legs, this is not a measurement
   * that can be unavailable — it is a rendering of `now`, and the fallback path
   * still yields the offset. An ABSENT local time would leave exactly the
   * ambiguity this field was added to remove.
   */
  nowLocal: string;
  /**
   * The MACHINE's logical core count — the `nproc` answer, and the denominator
   * that makes {@link load} readable.
   *
   * Deliberately `os.cpus().length` and NOT the resource profile's effective
   * (cgroup-quota-aware) core count. Verified live on this box 2026-07-27: the
   * operator runs under a systemd `CPUQuota=` that makes its EFFECTIVE count 12
   * while the machine has 128. An agent typing `nproc` in its own shell sees
   * 128, so reporting 12 here would not be the same answer — and it would make a
   * load average of ~80 read as 6x oversubscription instead of ~60% utilisation,
   * which is the exact wrong conclusion to hand an agent. The effective count is
   * the right number for sizing THIS process's own concurrency caps, which is
   * why `@papercusp/resource-profile` computes it — it is not the right number
   * for "how big is this box".
   */
  cores?: number;
  /** 1/5/15-minute load averages — the `uptime` / `cat /proc/loadavg` answer.
   *  Read against {@link cores}: this is a RUN-QUEUE DEPTH, not a percentage.
   *
   *  ⚠ AND IT IS NOT A CPU MEASUREMENT. Linux loadavg counts tasks in
   *  UNINTERRUPTIBLE sleep (D state — blocked on I/O) alongside runnable ones,
   *  and it is a 1/5/15-minute EWMA, so it TRAILS. Both properties break the
   *  reading this number invites, which is `load > cores ⇒ the box is CPU
   *  oversubscribed`. Measured on this 128-core box 2026-08-16: `load1` sat
   *  frozen at 85.69 across five consecutive seconds while the actual run queue
   *  oscillated between 39 and 76 — i.e. the headline number was neither
   *  instantaneous nor purely CPU.
   *
   *  So do NOT attribute a high load from this field alone. {@link procsRunning}
   *  and {@link procsBlocked} are carried beside it precisely so the two
   *  mechanisms it conflates can be told apart (EI-20495650388693372). */
  load?: [number, number, number];
  /**
   * Tasks RUNNING or runnable at the sampling instant — `/proc/stat`'s
   * `procs_running`. This is the CPU-saturation numerator {@link load} is
   * routinely mistaken for: compare THIS against {@link cores}, not `load`.
   *
   * Instantaneous, not smoothed — so it moves far faster than `load` and a
   * single sample is a snapshot, not a trend (see {@link RUNQ_CACHE_MS}).
   */
  procsRunning?: number;
  /**
   * Tasks in UNINTERRUPTIBLE sleep — `/proc/stat`'s `procs_blocked`, the D-state
   * count. These consume NO CPU yet are counted by {@link load}, which is the
   * single largest reason a load average overshoots what the cores are doing.
   *
   * It is also the wedge signal: a persistently high `procsBlocked` is work stuck
   * in the kernel (storage, NFS, a hung device), which is a different failure —
   * and a different fix — from a transient parallel build burst, where
   * {@link procsRunning} is high and this stays near zero.
   */
  procsBlocked?: number;
  /** Free RAM as a percentage of total, rounded — the `free -h` answer, in the
   *  form the question is actually asked in ("is this box out of memory?"). */
  memFreePct?: number;
  /** Total RAM in GB, rounded — the denominator behind `memFreePct`. */
  memTotalGb?: number;
  /** Linux PSI "some" memory-pressure avg60, when readable. The watchdog already
   *  alarms on this signal (the PER-THREAD WEDGE condition), so surfacing it here
   *  lets an agent see the same number the alarm sees rather than inferring
   *  thrashing from a load average, which cannot distinguish the two. */
  psiMemSome60?: number;
  /**
   * Linux PSI "some" CPU-pressure avg60, when readable — the percentage of the
   * last 60s in which at least one runnable task was waiting for a CPU.
   *
   * WHY THIS LEG EXISTS (EI-20495650388693372). {@link procsRunning} and
   * {@link procsBlocked} say what KIND of load {@link load} is; this says whether
   * anything is actually STARVED by it, which is the falsifier for "the box is
   * overloaded". The two are complementary, not redundant: a run queue can be
   * long while nothing waits meaningfully, and that is the common case here.
   * Measured on this host while the incident's sibling reading was live —
   * `load 56.04` against `cores 128` with CPU `some avg60=0.68` — load and real
   * saturation are decoupled, so `load > cores` on its own can neither be
   * confirmed nor dismissed. That unfalsifiability is what turned one ambient
   * reading into a filed bug; carrying this number is the detector.
   *
   * Note the asymmetry with memory, which is deliberate: only the "some" line is
   * carried, because system-wide `/proc/pressure/cpu` does not track "full" at
   * all (measured on this host: cpu `full total=0` exactly, against memory
   * `full total=6942659778`). A `psiCpuFull60` would therefore ship a hardcoded
   * 0.00 — a fabricated "no pressure", the exact inversion this file avoids
   * everywhere else.
   */
  psiCpuSome60?: number;
}

/** Cached `/proc/pressure/*` reads, keyed by file. ONE map rather than a
 *  variable per pressure file so a newly-added leg cannot quietly forget its own
 *  cache, and so {@link resetHostSnapshotCache} clears every leg by
 *  construction rather than by remembering to. */
const psiCaches = new Map<string, { at: number; value: number | undefined }>();

/** The run-queue decomposition of {@link HostSnapshot.load}. Each leg is
 *  independently optional: a `/proc/stat` that yields one key but not the other
 *  reports the one it has rather than discarding both. */
interface RunQueue {
  running?: number;
  blocked?: number;
}

let runqCache: { at: number; value: RunQueue } | undefined;

/**
 * Read the "some" avg60 out of a `/proc/pressure/*` file, cached and fail-soft.
 *
 * Parameterised over the file rather than forked per resource: `memory` and
 * `cpu` have byte-identical formats, so a second copy of this parser would be
 * two places for one regex to drift.
 *
 * `/proc/pressure/*` is Linux-only and absent under some container
 * configurations (and when unprivileged, and when built without
 * `CONFIG_PSI`); in every one of those cases the correct result is `undefined`
 * (the field is omitted), never a fabricated 0 — a zero would read as "no
 * pressure", which is the opposite of "I could not tell".
 */
function readPsiSome60(file: string, now: number): number | undefined {
  const cached = psiCaches.get(file);
  if (cached && now - cached.at < PSI_CACHE_MS) return cached.value;
  let value: number | undefined;
  try {
    // Format: `some avg10=0.00 avg60=0.00 avg300=0.00 total=0`
    const line = readFileSync(file, 'utf8').split('\n')[0] ?? '';
    const m = line.match(/\bavg60=([\d.]+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) value = n;
    }
  } catch {
    /* not Linux, or not permitted — the field is simply absent */
  }
  psiCaches.set(file, { at: now, value });
  return value;
}

/**
 * Read the run-queue decomposition from `/proc/stat`, cached and fail-soft.
 *
 * WHY THIS LEG EXISTS (EI-20495650388693372). A raw observation was filed as a
 * bug — "128 cores, load averages [217.72, 137.62, 122.82]" — and could not be
 * attributed to anything, because the snapshot that produced it carried no way to
 * tell the two mechanisms apart. `load > cores` is consistent with BOTH a genuine
 * CPU oversubscription (a generator worth hunting) and a pile of D-state tasks
 * consuming no CPU at all (a wedge, or merely slow storage). Without this pair
 * the reader can only report the ambient number, which is exactly the
 * "high load as weather" non-diagnosis the repo forbids.
 *
 * Matching {@link readPsiSome60}, an unreadable or unparseable file yields an
 * ABSENT field, never a fabricated 0 — a zero `procsRunning` would read as "the
 * box is idle", which is the strongest possible claim to invent from a failed
 * read, and the exact inversion of "I could not tell".
 */
function readRunQueue(now: number): RunQueue {
  if (runqCache && now - runqCache.at < RUNQ_CACHE_MS) return runqCache.value;
  const value: RunQueue = {};
  try {
    // Format (near the end, after the per-core and `intr` lines):
    //   procs_running 61
    //   procs_blocked 0
    const text = readFileSync('/proc/stat', 'utf8');
    const running = text.match(/^procs_running (\d+)$/m);
    const blocked = text.match(/^procs_blocked (\d+)$/m);
    if (running) {
      const n = Number(running[1]);
      if (Number.isFinite(n)) value.running = n;
    }
    if (blocked) {
      const n = Number(blocked[1]);
      if (Number.isFinite(n)) value.blocked = n;
    }
  } catch {
    /* not Linux, or not permitted — both fields are simply absent */
  }
  runqCache = { at: now, value };
  return value;
}

/** Test seam: drop the cached `/proc` reads so a test can control what the next
 *  read sees. Clears EVERY cached leg — a seam that reset only some of them would
 *  leak one test's fixture into the next. */
export function resetHostSnapshotCache(): void {
  psiCaches.clear();
  runqCache = undefined;
}

/**
 * Build the snapshot. Never throws: every leg is independently guarded, so the
 * worst case is a result carrying `now` alone.
 */
export function getHostSnapshot(): HostSnapshot {
  const nowMs = Date.now();
  const snap: HostSnapshot = {
    now: new Date(nowMs).toISOString(),
    nowLocal: renderLocalNow(nowMs),
  };

  try {
    const n = cpus().length;
    if (n > 0) snap.cores = n;
  } catch {
    /* absent */
  }

  try {
    const [a, b, c] = loadavg();
    // Darwin/Linux both provide this; a all-zero triple on an unsupported
    // platform is indistinguishable from a genuinely idle box, so keep it —
    // the field means "what loadavg() reports", which is what `uptime` prints.
    if (Number.isFinite(a)) snap.load = [round2(a), round2(b), round2(c)];
  } catch {
    /* absent */
  }

  try {
    const total = totalmem();
    const free = freemem();
    if (total > 0) {
      snap.memFreePct = Math.round((free / total) * 100);
      snap.memTotalGb = Math.round(total / 1024 ** 3);
    }
  } catch {
    /* absent */
  }

  const psi = readPsiSome60('/proc/pressure/memory', nowMs);
  if (psi !== undefined) snap.psiMemSome60 = psi;

  const psiCpu = readPsiSome60('/proc/pressure/cpu', nowMs);
  if (psiCpu !== undefined) snap.psiCpuSome60 = psiCpu;

  const runq = readRunQueue(nowMs);
  if (runq.running !== undefined) snap.procsRunning = runq.running;
  if (runq.blocked !== undefined) snap.procsBlocked = runq.blocked;

  return snap;
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Render `nowMs` in the host's local zone, in the shape the filesystem tools an
 * agent compares against actually print: `2026-08-10 14:05:44 EDT (UTC-04:00)`.
 *
 * Deliberately built from the local getters (`getHours()` &c.) rather than
 * `toISOString()`, whose every field is UTC — reusing it here would reproduce the
 * exact bug this renders around.
 *
 * Never throws. Only the zone ABBREVIATION can fail (it needs full-ICU); the
 * numeric offset comes from `getTimezoneOffset()`, which cannot. So the degraded
 * result still carries the offset — the part that makes the arithmetic checkable
 * — and merely omits the name.
 */
function renderLocalNow(nowMs: number): string {
  const d = new Date(nowMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const wall =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // getTimezoneOffset() is minutes to ADD to local to reach UTC, i.e. the sign is
  // inverted from the ±HH:MM convention every tool prints. UTC-4 reports +240.
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const absMin = Math.abs(offsetMin);
  const offset = `UTC${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;

  let zone: string | undefined;
  try {
    zone = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    /* no full-ICU — the offset below still carries the checkable part */
  }

  return `${wall}${zone ? ` ${zone}` : ''} (${offset})`;
}
