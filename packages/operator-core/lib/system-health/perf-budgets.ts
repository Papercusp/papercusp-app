/**
 * Per-thread perf-SLO budgets (round-4 Lane F / P-030). The DURABLE budget contract
 * that turns Lane E's `perf-signals-v1` capture (E1, ~/.papercusp/perf-baselines/
 * capture-signals.py) into a standing operator-health verdict — consumed by the
 * `infra` health panel so a per-thread saturation episode reds `overall` (the
 * operator_degraded signal) instead of being discoverable only by tool calls failing.
 *
 * LOAD-BEARING REFRAME (round-4 E5, su-1aa2f): this box has 128 cores, so loadavg
 * 16–22 is a ratio ~0.13 = STABLE, not oversubscription. The constraint is PER-THREAD
 * event-loop saturation (D-002), NOT host capacity. Therefore every budget here is
 * per-thread / per-worker / definitive-wedge — there is deliberately NO loadavg-
 * absolute budget. Budgeting on loadavg would lie on a many-core box.
 */
import type { PanelStatus } from './types';
import { constants as fsConstants } from 'node:fs';
import { readdir, readFile, stat, copyFile, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * One captured cgroup-v2 memory row.
 *
 * The byte fields measure a LEVEL; the event fields measure STALLS. Keeping both
 * on one row is the point: the memory alarm fires on PSI, which is a stall signal,
 * so attributing it from size alone names the biggest cgroup rather than the
 * responsible one (EI-21025158485847408 — 13 consecutive investigations of the
 * WI-5471 recurrence class closed "offender unresolved" on exactly that gap).
 *
 * `*Events` come from `memory.events.local` (this cgroup's OWN events) and
 * `*EventsSubtree` from `memory.events` (INCLUSIVE of descendants). The pair is
 * not redundant: local is what attributes a stall to its true owner instead of
 * smearing it onto every ancestor, while the subtree counter is the only record
 * that survives a short-lived child's exit — which is why per-PID forensics kept
 * finding nothing to blame.
 */
export interface PerfSignalsCgroupRow {
  path: string;
  memoryBytes: number;
  swapBytes: number | null;
  anonBytes?: number | null;
  fileBytes?: number | null;
  shmemBytes?: number | null;
  kernelBytes?: number | null;
  slabBytes?: number | null;
  sockBytes?: number | null;
  directPids: number | null;
  throttledHighEvents?: number | null;
  throttledMaxEvents?: number | null;
  oomEvents?: number | null;
  oomKillEvents?: number | null;
  throttledHighEventsSubtree?: number | null;
  throttledMaxEventsSubtree?: number | null;
  oomKillEventsSubtree?: number | null;
}

/** A bounded cgroup-v2 CPU delta row. Usage is inclusive of descendants, so
 * this is accountable owner context, not an additive workload total. */
export interface PerfSignalsCgroupCpuRow {
  path: string;
  cpuUsageUsecDelta: number;
  cpuPct: number;
  directPids: number | null;
}

/** The subset of Lane E's perf-signals-v1 record the budgets read. The MCP-merged
 *  signals (eventLoopLag, tool p95, pgConns) are null until an agent run keyed to
 *  capturedAt fills them, so they are optional — host-side signals alone yield a
 *  verdict. */
export interface PerfSignalsV1 {
  schemaVersion: string;
  capturedAt: string; // ISO 8601
  hostState: 'stable' | 'wedge-active' | string;
  signals: {
    loadavg?: { l1: number; l5: number; l15: number; cores: number } | null;
    operatorWorkers?: Array<{ pid: number; cpuPct: number; rssKb: number; etimeSec: number }> | null;
    closeWait_3070?: number | null;
    gateway_8788_reachable?: boolean | null;
    operator_3070_reachable?: boolean | null;
    // MCP-merged (null until an agent run fills them) — supported in either spot.
    eventLoopLag?: {
      lag_p95_ms?: number | null;
      lag_p99_ms?: number | null;
      lag_max_ms?: number | null;
      sample_count?: number | null;
      window_ms?: number | null;
      window_mature?: boolean | null;
    } | null;
    _mcp_supplemented?: {
      eventLoopLag?: {
        lag_p95_ms?: number | null;
        lag_p99_ms?: number | null;
        lag_max_ms?: number | null;
        sample_count?: number | null;
        window_ms?: number | null;
        window_mature?: boolean | null;
      } | null;
    } | null;
    /** Kernel Pressure Stall Information — %time tasks starved for the resource.
     *  Ratio-free, so it is the ONE host-saturation signal that does not lie on a
     *  128-core box (the 2026-07-10 fs-watch meltdown ran cpu some avg10=96). */
    psi?: {
      cpu?: { some?: { avg60?: number | null } | null } | null;
      io?: { some?: { avg60?: number | null } | null } | null;
      memory?: {
        some?: { avg60?: number | null } | null;
        /** WI-5471: `full` (%time ALL non-idle tasks stalled) is the meaningful
         *  memory-thrashing signal — captured by capture-signals.py all along,
         *  now also read by the budget evaluator. */
        full?: { avg60?: number | null } | null;
      } | null;
    } | null;
    /** Bounded cgroup-v2 memory attribution captured alongside PSI. `memoryBytes`
     *  is inclusive of descendants, so rows identify ownership hierarchies and
     *  must not be summed. This is forensic context, not presently a budget.
     *  Reclaim-event fields: see {@link PerfSignalsCgroupRow}. */
    cgroupMemory?: {
      accounting: 'cgroup-v2-inclusive-descendants' | string;
      top: PerfSignalsCgroupRow[];
      /** EI-21025158485847408: cgroups ranked by RECLAIM EVENTS rather than size.
       *  `top` is size-ranked, so it answers "who is biggest" — never "who is
       *  stalling", which is the question PSI actually asks. Truncating a
       *  size-ranked list also discards a small-but-thrashing cgroup outright. */
      throttled?: PerfSignalsCgroupRow[];
      throttledCgroups?: number;
      scannedCgroups: number;
      candidateCgroups: number;
      maxScanned: number;
      maxRows: number;
      budgetSec: number;
      partial: boolean;
    } | null;
    /** Bounded two-sample cgroup-v2 CPU ownership attribution. `cpuPct` is a
     * per-core percentage over the capture window; rows are forensic context
     * for PSI CPU pressure, not a second threshold. */
    cgroupCpu?: {
      accounting: 'cgroup-v2-inclusive-descendants' | string;
      top: PerfSignalsCgroupCpuRow[];
      scannedCgroups: number;
      candidateCgroups: number;
      maxScanned: number;
      maxRows: number;
      sampleSec: number;
      budgetSec: number;
      partial: boolean;
    } | null;
    /** Per-uid inotify usage (2026-07-10 meltdown class: a silent watch balloon —
     *  94.5k watches/process × 16 workers — starved the host with no signal). */
    inotify?: {
      totalWatches?: number | null;
      totalInstances?: number | null;
      maxPerProcess?: { pid: number; comm: string; watches: number } | null;
      /** WI-6538: the top watch holders (up to 20), each with its cgroup. Needed because
       *  `maxPerProcess` is the host-wide worst holder regardless of who owns it — on a dev
       *  box that is the editor, so budgeting against it is a permanent false alarm. The
       *  per-process budget is about OUR watchers ballooning, so the evaluator picks the
       *  worst papercusp-owned entry from here instead. */
      topProcs?: Array<{ pid: number; comm: string; watches: number; cgroup?: string | null }> | null;
      limits?: { maxUserWatches?: number | null } | null;
    } | null;
    /** Per-session dir populations (session-db-archive-retire-dirs P-007).
     *  After archive-at-death these are capped ≈ live-session count; a rebound
     *  means the exit-hook/reconciler stopped archiving — the population the
     *  2026-07-10 meltdown grew on. */
    sessionDirs?: {
      claudeOwnerDirs?: number | null;
      codexHomes?: number | null;
    } | null;
  };
}

/**
 * Bounded memory-owner context exposed by the canonical pressure verdict.
 *
 * `memoryBytes` is inclusive of descendants (the cgroup-v2 accounting contract),
 * so these rows are evidence for attribution, not values that may be summed. Keep
 * the projection deliberately smaller than the raw capture: service paths and
 * direct PID counts are enough to identify the likely producer without exposing
 * command-line samples or turning a state read into a process dump.
 */
export interface MemoryPressureCgroupAttribution {
  accounting: 'cgroup-v2-inclusive-descendants' | string;
  partial: boolean;
  /**
   * The denominator used by `memoryShareOfLargestCapturedCgroup`. This is the
   * largest row in the bounded capture, not a host-total measurement. Keeping
   * the path and level beside the fraction prevents a small cgroup's live
   * memory level from being read as a standalone pressure magnitude.
   */
  largestCapturedCgroup: {
    path: string;
    memoryBytes: number;
  } | null;
  top: Array<{
    path: string;
    memoryBytes: number;
    swapBytes: number | null;
    /**
     * Anonymous (non-file-backed) memory — the slice of `memoryBytes` that is
     * NOT already reclaimable by the kernel and would only be released by
     * killing the owning process(es) (or a swap-out). `memoryBytes` also counts
     * reclaimable page cache (`fileBytes`) and kernel slab (`slabBytes`), so a
     * cgroup ranked highest by `memoryBytes` alone is routinely one the kernel
     * can already evict without anyone terminating anything — the ranking
     * defect this field exists to correct (EI-22040979693735878). `null` means
     * the capture predates anon/file/slab accounting.
     */
    anonBytes: number | null;
    /** Reclaimable page cache within `memoryBytes` — already evictable by the
     *  kernel without killing anything, so excluded from "freeable-on-kill"
     *  ranking. `null` means the capture predates anon/file/slab accounting. */
    fileBytes: number | null;
    /** Kernel slab (dentries/inodes/etc.) attributed to this cgroup. `null`
     *  means the capture predates anon/file/slab accounting. */
    slabBytes: number | null;
    directPids: number | null;
    /** Fraction of the explicitly named largest captured cgroup level. */
    memoryShareOfLargestCapturedCgroup: number | null;
  }>;
  /**
   * Cgroups that have recorded reclaim events, ranked by events rather than size.
   * These are monotonic lifetime counters, so they are stronger historical owner
   * context than size-ranked `top`, but they are NOT current-window causal proof.
   *
   * `null` means the capture predates the reclaim-event fields, which is NOT the
   * same as "nothing was throttled" and must never be rendered as an all-clear.
   */
  throttled: Array<{
    path: string;
    memoryBytes: number;
    /** Fraction of the explicitly named largest captured cgroup level. */
    memoryShareOfLargestCapturedCgroup: number | null;
    /** Own events (`memory.events.local`). */
    highEventsCumulative: number | null;
    maxEventsCumulative: number | null;
    oomKillEventsCumulative: number | null;
    /** Inclusive of descendants — retains an exited child's history. */
    subtreeMaxEventsCumulative: number | null;
    subtreeOomKillEventsCumulative: number | null;
    /** True when all own event counters are measured and zero, false when an
     *  own counter is positive, and null when the counters are incomplete. */
    subtreeOnly: boolean | null;
  }> | null;
}

export interface PerfBudgets {
  /** A request worker sustained above this %CPU is HOT (warn). Noisy on a many-core
   *  box, so never crit on its own — the event-loop-lag + reachability + CLOSE_WAIT
   *  signals are the definitive per-thread-saturation crits. */
  workerCpuPctWarn: number;
  /** Worker RSS (KB) warn — the bg-host OOM'd at ~3.2GB (EI-1613); a leak/working-set watch. */
  workerRssKbWarn: number;
  /** :3070 CLOSE_WAIT — a pegged event loop can't run socket close() callbacks, so
   *  sockets pile up (deeb4: 0→470 while pegged, 935 peak). warn then crit. */
  closeWaitWarn: number;
  closeWaitCrit: number;
  /** Event-loop lag p95 (ms) — THE per-thread saturation signal (cpuprofile p95 was
   *  1746ms during the wedge). Only evaluated when an agent run merged it. warn then crit. */
  eventLoopLagP95WarnMs: number;
  eventLoopLagP95CritMs: number;
  /** A single process holding more fs watches than this is ballooning (warn — early
   *  per-offender attention). Grounded live 2026-07-10: healthy max ≈ 5k (biggest
   *  legit holder 4.9k); pre-GC session-dir bloat put an operator at 17.7k (real
   *  signal — dead-session dirs); the meltdown watcher held 94.5k per process.
   *  NOTE: the host-total tiers do NOT catch a per-proc melt (16×94.5k ≈ 38% of the
   *  kernel limit) — this warn + the PSI crit are the meltdown-class catchers. */
  inotifyPerProcWarn: number;
  /** Host-total watches as a FRACTION of fs.inotify.max_user_watches. Crit is
   *  reserved for approaching the hard kernel limit — past it every chokidar/
   *  fs.watch boot fails ENOSPC fleet-wide (the EI-3385 crash-loop class). */
  inotifyLimitWarnFrac: number;
  inotifyLimitCritFrac: number;
  /** PSI cpu `some avg60` (%time ≥1 task starved for CPU over the last minute).
   *  THE ratio-free host-saturation budget — loadavg-absolute lies here (128
   *  cores). Meltdown 2026-07-10: 94.8; healthy: <1. */
  psiCpuSomeWarn: number;
  psiCpuSomeCrit: number;
  /** PSI memory `some avg60` (%time ≥1 task stalled on memory reclaim/swap over the
   *  last minute) — WARN tier: early reclaim pressure, before it graduates to a
   *  full stall. */
  psiMemorySomeWarn: number;
  /** PSI memory `full avg60` (%time ALL non-idle tasks were stalled on memory at
   *  once — true thrashing). Unlike cpu `full` (near-impossible on a 128-core box,
   *  hence not budgeted), memory `full` is routinely nonzero under real reclaim/
   *  swap pressure and is the CRIT tier here. WI-5471 (2026-07-19) traced a chronic
   *  bg-host event-loop-lag / PG-pool-starvation regression (600s scout timeouts,
   *  120s outbox-drain pass-timeouts) to sustained memory PSI full avg60 of
   *  2.6-9.4% while cpu PSI stayed flat at 0 the whole time — this class was
   *  captured (capture-signals.py always reads psi.memory) but silently NEVER
   *  evaluated by this budget, so the actual driver was invisible to the infra
   *  panel and only found via manual /proc/pressure/memory + vmstat forensics. */
  psiMemoryFullCrit: number;
  /** Per-session dir population (either root) above this is a stalled
   *  archive-at-death lifecycle (warn — the reconciler/exit-hook stopped).
   *  Steady state post-backfill ≈ live sessions (~60) + churn; the pre-plan
   *  backlog was 17k+ (session-db-archive-retire-dirs P-007). */
  sessionDirsWarn: number;
  /** A capture older than this (ms) is STALE — don't threshold its numbers (avoid
   *  alarming on a briefly-old snapshot: the capture timer may have skipped a tick). */
  staleMs: number;
  /** A capture older than this (ms) means the producer has DIED, not skipped a tick —
   *  the host SLO monitor is BLIND. Surface as `warn` (never crit — the stale numbers
   *  are untrustworthy) instead of a silent `unknown`, so a dead capture timer
   *  (papercup-perf-signals-capture.timer, WI-324) is visible rather than failing open
   *  forever. MUST be >> staleMs + the capture cadence so a normal gap stays `unknown`. */
  blindMs: number;
}

/** Default per-thread budgets, grounded in the round-4 baseline + live evidence. */
export const PERF_BUDGETS: PerfBudgets = {
  workerCpuPctWarn: 200,
  workerRssKbWarn: 3_000_000,
  closeWaitWarn: 200,
  closeWaitCrit: 500,
  eventLoopLagP95WarnMs: 250,
  eventLoopLagP95CritMs: 1000,
  inotifyPerProcWarn: 10_000,
  inotifyLimitWarnFrac: 0.5,
  inotifyLimitCritFrac: 0.8,
  psiCpuSomeWarn: 40,
  psiCpuSomeCrit: 85,
  psiMemorySomeWarn: 10,
  psiMemoryFullCrit: 5,
  sessionDirsWarn: 2_000,
  staleMs: 10 * 60_000,
  blindMs: 30 * 60_000,
};

/**
 * The memory-only verdict projected by the `host.memoryPressure` state cell.
 *
 * This is deliberately a CHILD of the canonical perf evaluator rather than a
 * second threshold implementation. `evaluatePerfSignals()` consumes this exact
 * object for its infra-panel alarm reasons, while the state-cell resolver exposes
 * it for a fresh pull. One writer, two lenses.
 */
export interface MemoryPressureVerdict {
  /** Null means the capture cannot honestly establish a band. Read `unknown`. */
  pressure: 'ok' | 'warn' | 'crit' | null;
  /** When the underlying perf capture was taken, not when this projection was read. */
  measuredAt: string | null;
  ageMs: number | null;
  stale: boolean;
  /** PSI values are percentages of wall time over the trailing 60-second window. */
  psiMemorySome60: number | null;
  psiMemoryFull60: number | null;
  /** Bounded owner context from the same capture; null when the producer omitted it. */
  cgroupAttribution: MemoryPressureCgroupAttribution | null;
  /** The exact budget source and values used by the infra-liveness writer. */
  thresholds: {
    source: 'PERF_BUDGETS';
    psiMemorySomeWarn: number;
    psiMemoryFullCrit: number;
    staleMs: number;
    blindMs: number;
  };
  reasons: string[];
  /** Missing/stale inputs stay in-band; absence never becomes a reassuring zero. */
  unknown: Array<{
    code:
      | 'capture-absent'
      | 'schema-invalid'
      | 'captured-at-invalid'
      | 'capture-stale'
      | 'psi-memory-some-unmeasured'
      | 'psi-memory-full-unmeasured';
    detail: string;
  }>;
}

export interface PerfVerdict {
  /** ok | warn | crit | unknown (stale, or no usable signals). */
  status: PanelStatus;
  /** Convenience: the standing operator_degraded boolean (status === 'crit'). */
  degraded: boolean;
  /** Human reasons for the worst tier reached (the alarm copy). */
  reasons: string[];
  hostState: string | null;
  worstWorkerCpuPct: number | null;
  worstWorkerRssKb: number | null;
  closeWait: number | null;
  eventLoopLagP95Ms: number | null;
  /** Raw maximum and window metadata remain visible even when p95 is immature. */
  eventLoopLagMaxMs: number | null;
  eventLoopLagSampleCount: number | null;
  eventLoopLagWindowMs: number | null;
  /** Null for legacy captures that predate explicit maturity metadata. */
  eventLoopLagWindowMature: boolean | null;
  operatorReachable: boolean | null;
  /** Host-total inotify watches (per-uid) / the fattest single holder. */
  inotifyTotalWatches: number | null;
  inotifyMaxPerProc: { pid: number; comm: string; watches: number } | null;
  /** PSI cpu `some avg60` — %time ≥1 task starved for CPU. */
  psiCpuSome60: number | null;
  /** Bounded owner context from the same capture for PSI CPU pressure. */
  cgroupCpuAttribution: {
    accounting: 'cgroup-v2-inclusive-descendants' | string;
    partial: boolean;
    top: Array<{
      path: string;
      cpuUsageUsecDelta: number;
      cpuPct: number;
      directPids: number | null;
    }>;
  } | null;
  /** PSI memory `some avg60` — %time ≥1 task stalled on memory reclaim/swap. */
  psiMemorySome60: number | null;
  /** PSI memory `full avg60` — %time ALL non-idle tasks stalled on memory (real
   *  thrashing; WI-5471's actual root-cause signal). */
  psiMemoryFull60: number | null;
  /** The canonical memory-only projection. The infra alarm and state cell share it. */
  memoryPressure: MemoryPressureVerdict;
  /** Per-session dir populations (archive-at-death lifecycle gauge). */
  sessionDirs: { claudeOwnerDirs: number | null; codexHomes: number | null } | null;
  ageMs: number | null;
  stale: boolean;
  /** EI-12302: reasons that WOULD have been `crit` but were downgraded given context
   *  the caller passed in (currently: `deployInProgress` suppresses the
   *  operator-unreachable crit during a known, sanctioned restart window — deploy.ts's
   *  withDrain holds the 'dev-server' resource lock exclusive for the whole
   *  drain→restart→health-probe window, so "currently held" IS the deploy-in-progress
   *  signal). Always present (possibly empty) so a caller can surface "N false-
   *  positive(s) suppressed" instead of the suppression being silently invisible. */
  suppressedReasons: string[];
  /**
   * WI-38449 / D-007 finding 3: the `crit` reasons SPLIT BY ATTRIBUTION, so a deploy
   * gate can hold a release for an operator wedge without holding it for ambient host
   * load. Populated only on a `crit` verdict (both arrays empty otherwise).
   *
   * ⚠ This changes NOTHING about what is REPORTED. `status` is still `crit` and
   * `reasons` still carries every reason, so every existing alarm/panel/state-cell
   * reader is unaffected. It exists solely so `evaluatePerfGate` can decide what
   * BLOCKS — separating "the operator is broken" from "the box is busy".
   *
   * Measured 2026-08-16 on this box: `crit` fired on the single reason `PSI memory
   * full avg60 11.45 ≥ 5`, ambient RAM pressure from ~100 peer agents on a shared
   * dev host, with nothing wrong with any candidate. Arming block-mode against the
   * undifferentiated crit tier would have held EVERY deploy for the entire busy
   * period — the same false-red D-003/D-005 refused for the desktop sibling.
   */
  critAttribution: {
    /** Properties of OUR operator that a release is plausibly responsible for, and
     *  that make deploying unsafe: :3070 unreachable, a captured wedge, event-loop
     *  lag p95 ≥ 1s, CLOSE_WAIT ≥ 500. Meltdown-class by construction — these are
     *  what block-mode exists to catch. */
    operatorDefect: string[];
    /** Multi-tenant host state no candidate caused and no release can fix: CPU/memory
     *  pressure, and host-total inotify exhaustion (per-uid, so routinely a third-party
     *  editor — WI-6538 measured VS Code at 38,937 watches, 3.9x budget). Still crit,
     *  still alarmed, never a reason to hold a deploy. */
    ambientHost: string[];
  };
}

function lagReading(s: PerfSignalsV1['signals']): {
  p95Ms: number | null;
  maxMs: number | null;
  sampleCount: number | null;
  windowMs: number | null;
  windowMature: boolean | null;
} {
  const raw = s.eventLoopLag ?? s._mcp_supplemented?.eventLoopLag ?? null;
  return {
    p95Ms: typeof raw?.lag_p95_ms === 'number' ? raw.lag_p95_ms : null,
    maxMs: typeof raw?.lag_max_ms === 'number' ? raw.lag_max_ms : null,
    sampleCount: typeof raw?.sample_count === 'number' ? raw.sample_count : null,
    windowMs: typeof raw?.window_ms === 'number' ? raw.window_ms : null,
    windowMature: typeof raw?.window_mature === 'boolean' ? raw.window_mature : null,
  };
}

/**
 * The "would actually be freed by killing this cgroup" figure: anon memory when
 * captured, falling back to raw `memoryBytes` for legacy captures that predate
 * anon/file/slab accounting. `memoryBytes` is cgroup-v2 `memory.current`, which
 * also counts reclaimable page cache and kernel slab — memory the kernel can
 * already evict on its own, with no process terminated. Ranking by that inclusive
 * total therefore routinely names the cgroup with the biggest reclaimable cache,
 * not the one actually holding memory pressure hostage (EI-22040979693735878).
 */
function freeableOnKillBytes(row: { memoryBytes: number; anonBytes?: number | null }): number {
  return typeof row.anonBytes === 'number' ? row.anonBytes : row.memoryBytes;
}

/** Project only safe, bounded cgroup owner fields into the current-state verdict. */
function summarizeCgroupMemory(
  cgroup: PerfSignalsV1['signals']['cgroupMemory'],
): MemoryPressureCgroupAttribution | null {
  if (!cgroup || !Array.isArray(cgroup.top)) return null;
  const topRows = [...cgroup.top]
    .filter((row) => typeof row?.path === 'string' && typeof row?.memoryBytes === 'number')
    .sort((a, b) => freeableOnKillBytes(b) - freeableOnKillBytes(a))
    .slice(0, 8)
    .map((row) => ({
      path: row.path,
      memoryBytes: row.memoryBytes,
      swapBytes: typeof row.swapBytes === 'number' ? row.swapBytes : null,
      anonBytes: typeof row.anonBytes === 'number' ? row.anonBytes : null,
      fileBytes: typeof row.fileBytes === 'number' ? row.fileBytes : null,
      slabBytes: typeof row.slabBytes === 'number' ? row.slabBytes : null,
      directPids: typeof row.directPids === 'number' ? row.directPids : null,
    }));
  const largestCapturedCgroup = topRows[0]
    ? { path: topRows[0].path, memoryBytes: topRows[0].memoryBytes }
    : null;
  const memoryShareOfLargestCapturedCgroup = (memoryBytes: number): number | null =>
    largestCapturedCgroup && largestCapturedCgroup.memoryBytes > 0
      ? memoryBytes / largestCapturedCgroup.memoryBytes
      : null;
  const top = topRows.map((row) => ({
    ...row,
    memoryShareOfLargestCapturedCgroup: memoryShareOfLargestCapturedCgroup(row.memoryBytes),
  }));
  // Event fields are cumulative counters, but older captures and partially-read
  // cgroups may omit one or more of them. Preserve that distinction: zero is a
  // measured count, while null means the counter was not measured.
  const nullableNum = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  // A capture predating the reclaim-event fields carries no `throttled` array at
  // all. Project that as null — an empty array would assert "nothing was
  // throttled", turning a MISSING measurement into a false all-clear, which is
  // the same class of error as reading PSI silence as health.
  const throttled = Array.isArray(cgroup.throttled)
    ? cgroup.throttled
        .filter((row) => typeof row?.path === 'string' && typeof row?.memoryBytes === 'number')
        .slice(0, 8)
        .map((row) => {
          const highEvents = nullableNum(row.throttledHighEvents);
          const maxEvents = nullableNum(row.throttledMaxEvents);
          const oomKillEvents = nullableNum(row.oomKillEvents);
          const ownEventsMeasured = highEvents !== null && maxEvents !== null && oomKillEvents !== null;
          return {
            path: row.path,
            memoryBytes: row.memoryBytes,
            memoryShareOfLargestCapturedCgroup: memoryShareOfLargestCapturedCgroup(row.memoryBytes),
            highEventsCumulative: highEvents,
            maxEventsCumulative: maxEvents,
            oomKillEventsCumulative: oomKillEvents,
            subtreeMaxEventsCumulative: nullableNum(row.throttledMaxEventsSubtree),
            subtreeOomKillEventsCumulative: nullableNum(row.oomKillEventsSubtree),
            subtreeOnly: ownEventsMeasured
              ? highEvents === 0 && maxEvents === 0 && oomKillEvents === 0
              : null,
          };
        })
    : null;
  return {
    accounting: cgroup.accounting,
    partial: cgroup.partial === true,
    largestCapturedCgroup,
    top,
    throttled,
  };
}

/** Project only bounded cgroup CPU owner fields into the current verdict. */
function summarizeCgroupCpu(
  cgroup: PerfSignalsV1['signals']['cgroupCpu'],
): PerfVerdict['cgroupCpuAttribution'] {
  if (!cgroup || !Array.isArray(cgroup.top)) return null;
  const top = [...cgroup.top]
    .filter(
      (row) =>
        typeof row?.path === 'string' &&
        typeof row?.cpuUsageUsecDelta === 'number' &&
        Number.isFinite(row.cpuUsageUsecDelta) &&
        typeof row?.cpuPct === 'number' &&
        Number.isFinite(row.cpuPct),
    )
    .sort((a, b) => b.cpuPct - a.cpuPct || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map((row) => ({
      path: row.path,
      cpuUsageUsecDelta: row.cpuUsageUsecDelta,
      cpuPct: row.cpuPct,
      directPids: typeof row.directPids === 'number' ? row.directPids : null,
    }));
  return {
    accounting: cgroup.accounting,
    partial: cgroup.partial === true,
    top,
  };
}

/** Attach measured cgroup CPU ownership to a PSI CPU alarm without claiming
 * that correlation alone proves causality. */
function withCgroupCpuAttribution(
  reason: string,
  attribution: PerfVerdict['cgroupCpuAttribution'],
): string {
  const depth = (path: string): number => path.split('/').filter(Boolean).length;
  const owner = attribution?.top.reduce<NonNullable<PerfVerdict['cgroupCpuAttribution']>['top'][number] | null>(
    (best, row) =>
      !best ||
      depth(row.path) > depth(best.path) ||
      (depth(row.path) === depth(best.path) && row.cpuPct > best.cpuPct)
        ? row
        : best,
    null,
  );
  if (!owner) {
    return `${reason}; cgroup CPU attribution unavailable — pressure owner unconfirmed`;
  }
  const pids = owner.directPids === null ? '' : `, ${owner.directPids} direct pid(s)`;
  // `owner` is only non-null when `attribution` was non-null (it comes from `attribution?.top`),
  // but that implication does not survive the reduce, so narrow explicitly rather than assert.
  const partial = attribution?.partial ? ', partial cgroup scan' : '';
  return `${reason}; top cgroup CPU owner (correlation, not proof of causality): ${owner.path} ` +
    `(${owner.cpuPct.toFixed(1)}% CPU${pids}${partial})`;
}

/**
 * Pick the most specific (deepest) cgroup among the bounded top-N attribution rows,
 * to name as "the responsible cgroup" in a memory-pressure reason.
 *
 * cgroup-v2 memory.current accounting is INCLUSIVE of descendants (see
 * {@link MemoryPressureCgroupAttribution}), so the single LARGEST row in `top` is
 * routinely a coarse ancestor — a user slice, or the cgroup root itself — that
 * contains every other row by construction. Naming that as "the responsible cgroup"
 * tells a reader nothing they can act on (EI-21006730273601832: a live P2P-gate
 * incident had exactly this shape — the alarm reason carried only the raw host PSI
 * number, not which workload owned the memory). The DEEPEST path among the captured
 * rows is the most specific attribution the bounded sample actually reached, which
 * is what a responder needs to go find the real workload. Ties broken by the
 * anon-aware "freeable-on-kill" figure ({@link freeableOnKillBytes}), falling
 * back to raw size for legacy captures — not raw `memoryBytes`, which would
 * re-introduce the same reclaimable-cache ranking defect at the tie-break.
 */
function mostSpecificCgroupOwner(
  attribution: MemoryPressureCgroupAttribution | null,
): MemoryPressureCgroupAttribution['top'][number] | null {
  if (!attribution || attribution.top.length === 0) return null;
  const depth = (path: string): number => path.split('/').filter(Boolean).length;
  let best: MemoryPressureCgroupAttribution['top'][number] | null = null;
  for (const row of attribution.top) {
    if (
      !best ||
      depth(row.path) > depth(best.path) ||
      (depth(row.path) === depth(best.path) && freeableOnKillBytes(row) > freeableOnKillBytes(best))
    ) {
      best = row;
    }
  }
  return best;
}

/** Render a cgroup attribution row into the clause appended to a memory-pressure
 *  reason — the human-actionable half of {@link mostSpecificCgroupOwner}. */
function formatCgroupOwner(row: MemoryPressureCgroupAttribution['top'][number]): string {
  const gb = (row.memoryBytes / 1024 ** 3).toFixed(2);
  const anon = row.anonBytes !== null
    ? `, ${(row.anonBytes / 1024 ** 3).toFixed(2)}GB anon (freeable-on-kill)`
    : '';
  const swap = row.swapBytes !== null ? `, ${(row.swapBytes / 1024 ** 3).toFixed(2)}GB swap` : '';
  const pids = row.directPids !== null ? `, ${row.directPids} direct pid(s)` : '';
  const share = row.memoryShareOfLargestCapturedCgroup === null
    ? ''
    : `, ${(row.memoryShareOfLargestCapturedCgroup * 100).toFixed(2)}% of largest captured cgroup`;
  return `${row.path} (${gb}GB${anon}${swap}${pids}${share})`;
}

/** Append the cgroup-attribution clause to a memory-pressure reason, or an explicit
 *  "unconfirmed" clause when the capture carried no attribution — so a reader always
 *  sees whether mechanism was actually correlated to a cgroup, never a bare PSI
 *  number that INVITES attributing the stall to "low memory" (EI-21006730273601832:
 *  ~51 GiB MemAvailable was live at the very reading that paged full avg60=5.13). */
function withCgroupAttribution(reason: string, attribution: MemoryPressureCgroupAttribution | null): string {
  // PSI measures stalls during the current avg60 window, while memory.events.local
  // is a monotonic lifetime counter. A positive row proves that this cgroup owned
  // SOME reclaim episode, but without a delta it cannot prove that it owns THIS
  // PSI window. Prefer that historical owner lead over a size-only row, but label
  // the temporal mismatch explicitly so responders do not terminate a quiet scope
  // based on an old large counter (EI-22024545594707184).
  const historicalOwner = attribution?.throttled?.find((row) => row.subtreeOnly === false) ?? null;
  if (historicalOwner) {
    const gb = (historicalOwner.memoryBytes / 1024 ** 3).toFixed(2);
    const parts = [
      historicalOwner.highEventsCumulative !== null && historicalOwner.highEventsCumulative > 0
        ? `${historicalOwner.highEventsCumulative} cumulative MemoryHigh throttle(s)`
        : null,
      historicalOwner.maxEventsCumulative !== null && historicalOwner.maxEventsCumulative > 0
        ? `${historicalOwner.maxEventsCumulative} cumulative MemoryMax hit(s)`
        : null,
      historicalOwner.oomKillEventsCumulative !== null && historicalOwner.oomKillEventsCumulative > 0
        ? `${historicalOwner.oomKillEventsCumulative} cumulative oom-kill(s)`
        : null,
    ].filter(Boolean);
    const share = historicalOwner.memoryShareOfLargestCapturedCgroup === null
      ? ''
      : `, ${(historicalOwner.memoryShareOfLargestCapturedCgroup * 100).toFixed(2)}% of largest captured cgroup`;
    return (
      `${reason}; historically reclaim-active cgroup (cumulative counters; current-window owner unconfirmed): ` +
      `${historicalOwner.path} (${gb}GB${share}, ${parts.join(', ')})`
    );
  }
  // No cgroup owns an event, but an ancestor may still carry a subtree record of
  // one whose cgroup has since been removed. That is the ONLY surviving evidence
  // of a short-lived producer, so surface it rather than falling through to size.
  const exited = attribution?.throttled?.find(
    (row) =>
      row.subtreeOnly === true &&
      ((row.subtreeMaxEventsCumulative !== null && row.subtreeMaxEventsCumulative > 0) ||
        (row.subtreeOomKillEventsCumulative !== null && row.subtreeOomKillEventsCumulative > 0)),
  );
  if (exited) {
    const kills = exited.subtreeOomKillEventsCumulative !== null && exited.subtreeOomKillEventsCumulative > 0
      ? `, ${exited.subtreeOomKillEventsCumulative} cumulative oom-kill(s)`
      : '';
    const share = exited.memoryShareOfLargestCapturedCgroup === null
      ? ''
      : ` (${(exited.memoryShareOfLargestCapturedCgroup * 100).toFixed(2)}% of largest captured cgroup)`;
    return (
      `${reason}; no live cgroup owns a reclaim event; historical cgroup ${exited.path} retains ` +
      `${exited.subtreeMaxEventsCumulative} cumulative MemoryMax hit(s)${kills} from descendants that have since exited${share} — ` +
      `attribute there, not to the largest cgroup`
    );
  }
  const owner = mostSpecificCgroupOwner(attribution);
  if (owner) {
    // Explicitly mark this as the WEAK reading so it is not mistaken for cause.
    const basis =
      attribution?.throttled === null
        ? 'capture predates reclaim-event attribution, so stall ownership is UNMEASURED'
        : attribution?.throttled?.some((row) => row.subtreeOnly === null)
          ? 'one or more cgroups have incomplete reclaim-event fields, so stall ownership is UNMEASURED'
          : 'no cgroup recorded a reclaim event';
    return `${reason}; largest cgroup by size (NOT confirmed as the staller — ${basis}): ${formatCgroupOwner(owner)}`;
  }
  return `${reason}; no cgroup memory attribution captured — mechanism unconfirmed, do not attribute to low free RAM`;
}

/**
 * Evaluate ONLY the memory-pressure portion of a perf capture.
 *
 * The full evaluator below calls this and copies its reasons into the infra verdict;
 * the `host.memoryPressure` cell calls the same function. Keeping the threshold
 * branch here is what prevents the pull surface and alert writer from disagreeing.
 */
export function evaluateMemoryPressure(
  signals: PerfSignalsV1 | null | undefined,
  nowMs: number,
  budgets: PerfBudgets = PERF_BUDGETS,
): MemoryPressureVerdict {
  const thresholds: MemoryPressureVerdict['thresholds'] = {
    source: 'PERF_BUDGETS',
    psiMemorySomeWarn: budgets.psiMemorySomeWarn,
    psiMemoryFullCrit: budgets.psiMemoryFullCrit,
    staleMs: budgets.staleMs,
    blindMs: budgets.blindMs,
  };
  const base = {
    pressure: null,
    measuredAt: signals?.capturedAt ?? null,
    ageMs: null,
    stale: false,
    psiMemorySome60: null,
    psiMemoryFull60: null,
    cgroupAttribution: null,
    thresholds,
    reasons: [],
    unknown: [],
  } satisfies MemoryPressureVerdict;

  if (!signals) {
    return {
      ...base,
      unknown: [{ code: 'capture-absent', detail: 'no perf-signals-v1 capture was available' }],
    };
  }
  if (signals.schemaVersion !== 'perf-signals-v1') {
    return {
      ...base,
      unknown: [
        {
          code: 'schema-invalid',
          detail: `expected perf-signals-v1, received ${signals.schemaVersion || 'an empty schema version'}`,
        },
      ],
    };
  }

  const capturedMs = Date.parse(signals.capturedAt);
  if (!Number.isFinite(capturedMs)) {
    return {
      ...base,
      unknown: [{ code: 'captured-at-invalid', detail: `capture timestamp is not parseable: ${signals.capturedAt}` }],
    };
  }

  const ageMs = Math.max(0, nowMs - capturedMs);
  const stale = ageMs > budgets.staleMs;
  const memory = signals.signals?.psi?.memory;
  const psiMemorySome60 = typeof memory?.some?.avg60 === 'number' ? memory.some.avg60 : null;
  const psiMemoryFull60 = typeof memory?.full?.avg60 === 'number' ? memory.full.avg60 : null;
  const cgroupAttribution = summarizeCgroupMemory(signals.signals?.cgroupMemory);
  const unknown: MemoryPressureVerdict['unknown'] = [];
  if (stale) {
    unknown.push({
      code: 'capture-stale',
      detail: `perf capture is ${ageMs}ms old, beyond the ${budgets.staleMs}ms freshness budget`,
    });
  }
  if (psiMemorySome60 === null) {
    unknown.push({
      code: 'psi-memory-some-unmeasured',
      detail: 'PSI memory some avg60 was absent; do not read it as 0%',
    });
  }
  if (psiMemoryFull60 === null) {
    unknown.push({
      code: 'psi-memory-full-unmeasured',
      detail: 'PSI memory full avg60 was absent; do not read it as 0%',
    });
  }

  const common = {
    ...base,
    measuredAt: signals.capturedAt,
    ageMs,
    stale,
    psiMemorySome60,
    psiMemoryFull60,
    cgroupAttribution,
    unknown,
  };
  if (stale) return common;
  if (psiMemoryFull60 !== null && psiMemoryFull60 >= budgets.psiMemoryFullCrit) {
    return {
      ...common,
      pressure: 'crit',
      reasons: [
        withCgroupAttribution(
          `PSI memory full avg60 ${psiMemoryFull60} ≥ ${budgets.psiMemoryFullCrit} — all tasks stalled on memory reclaim/swap (WI-5471 class: real thrashing, not a CPU issue)`,
          cgroupAttribution,
        ),
      ],
    };
  }
  if (psiMemorySome60 !== null && psiMemorySome60 >= budgets.psiMemorySomeWarn) {
    return {
      ...common,
      pressure: 'warn',
      reasons: [
        withCgroupAttribution(
          `PSI memory some avg60 ${psiMemorySome60} ≥ ${budgets.psiMemorySomeWarn} — sustained memory reclaim pressure`,
          cgroupAttribution,
        ),
      ],
    };
  }
  if (psiMemorySome60 !== null && psiMemoryFull60 !== null) {
    return { ...common, pressure: 'ok' };
  }
  return common;
}

/**
 * Decide whether the real-backend acceptance matrix may start a process.
 *
 * This is an admission policy, not a second memory-pressure evaluator: it
 * consumes the same canonical verdict as `host.memoryPressure`. A fresh,
 * complete `ok` or `warn` capture is safe enough to admit, while a fresh,
 * complete `crit` capture means the test instrument must not add another real
 * backend to the pressured host. Missing, stale, or partial evidence is
 * explicitly `not-measured` so an acceptance run can skip without reporting a
 * backend failure from a measurement gap.
 */
export type RealBackendAdmissionDecision = 'admit' | 'block' | 'not-measured';

export interface RealBackendAdmission {
  decision: RealBackendAdmissionDecision;
  pressure: MemoryPressureVerdict['pressure'];
  measuredAt: string | null;
  ageMs: number | null;
  reason: string;
  unknown: MemoryPressureVerdict['unknown'];
}

export function evaluateRealBackendAdmission(
  signals: PerfSignalsV1 | null | undefined,
  nowMs: number,
  budgets: PerfBudgets = PERF_BUDGETS,
): RealBackendAdmission {
  const memory = evaluateMemoryPressure(signals, nowMs, budgets);
  if (!signals || memory.stale || memory.unknown.length > 0 || memory.pressure === null) {
    const detail = memory.unknown.map((entry) => entry.detail).join('; ');
    return {
      decision: 'not-measured',
      pressure: memory.pressure,
      measuredAt: memory.measuredAt,
      ageMs: memory.ageMs,
      reason: detail || 'memory pressure capture was incomplete; real-backend admission is not measured',
      unknown: memory.unknown,
    };
  }
  if (memory.pressure === 'crit') {
    return {
      decision: 'block',
      pressure: memory.pressure,
      measuredAt: memory.measuredAt,
      ageMs: memory.ageMs,
      reason: memory.reasons[0] ?? 'critical host memory pressure blocks real-backend admission',
      unknown: [],
    };
  }
  return {
    decision: 'admit',
    pressure: memory.pressure,
    measuredAt: memory.measuredAt,
    ageMs: memory.ageMs,
    reason: `host memory pressure is ${memory.pressure}; real-backend admission is allowed`,
    unknown: [],
  };
}

/**
 * Evaluate a perf-signals-v1 capture against per-thread budgets. PURE — no IO. A
 * stale capture (older than budgets.staleMs measured from `nowMs`) returns `unknown`
 * so an old snapshot never reds the system. Crit is reserved for DEFINITIVE per-thread
 * wedge signals (operator unreachable, hostState=wedge-active, event-loop-lag, a
 * CLOSE_WAIT storm); worker CPU%/RSS are warn-only (noisy on a many-core box).
 */
/** A watch-holding process, as reported by capture-signals.py's `topProcs`. */
export interface InotifyHolder {
  pid: number;
  comm: string;
  watches: number;
  cgroup?: string | null;
}

/** WI-6538: cgroup substring identifying a process we own. Our services run as
 *  `papercup-*` systemd user units, and the kernel accounts every descendant of those
 *  roots to the same cgroup — so this matches agent- and build-spawned children too,
 *  not just the top-level service. (See the task-manager no-escape-property doc.) */
const PAPERCUSP_CGROUP_MARKER = 'papercup';

/**
 * Result of attributing inotify watches to processes we own.
 *
 * The two negative cases are DELIBERATELY distinct, because they must produce opposite
 * behaviour and conflating them is the easy bug here:
 *   - `attributable: false` — the capture carries no ownership info at all (predates
 *     WI-6538, or a host with unreadable cgroups). The caller must FALL BACK to the
 *     host-wide max, so an old capture keeps checking something rather than silently
 *     reporting green.
 *   - `attributable: true, worst: null` — ownership info IS present and we own nothing.
 *     That is a real, confident "no papercusp process is ballooning": the caller must
 *     NOT fall back, or it would go straight back to warning about the editor.
 */
export type OwnedInotifyAttribution =
  | { attributable: false }
  | { attributable: true; worst: InotifyHolder | null };

/** The worst inotify holder AMONG PROCESSES WE OWN. See {@link OwnedInotifyAttribution}
 *  for why "we can't tell" and "we own none" are different answers. */
export function worstOwnedInotifyHolder(
  topProcs: ReadonlyArray<InotifyHolder> | null | undefined,
): OwnedInotifyAttribution {
  if (!Array.isArray(topProcs) || topProcs.length === 0) return { attributable: false };
  // Not one entry carries a cgroup ⇒ the capture predates ownership tagging.
  if (!topProcs.some((p) => typeof p?.cgroup === 'string' && p.cgroup.length > 0)) {
    return { attributable: false };
  }
  const owned = topProcs.filter(
    (p) => typeof p?.cgroup === 'string' && p.cgroup.includes(PAPERCUSP_CGROUP_MARKER),
  );
  if (owned.length === 0) return { attributable: true, worst: null };
  return { attributable: true, worst: owned.reduce((w, p) => (p.watches > w.watches ? p : w)) };
}

export function evaluatePerfSignals(
  signals: PerfSignalsV1 | null | undefined,
  nowMs: number,
  budgets: PerfBudgets = PERF_BUDGETS,
  /** EI-12302: true when the caller has confirmed a sanctioned deploy restart is
   *  (or was, at capture time) in progress — e.g. the 'dev-server' resource lock is
   *  held exclusive. Suppresses ONLY the `operator :3070 unreachable` crit (a deploy
   *  restart legitimately makes the operator briefly unreachable); every other
   *  per-thread wedge signal (event-loop lag, CLOSE_WAIT, PSI, inotify) is unaffected
   *  — those are never expected during a routine restart, so they still page. */
  deployInProgress = false,
): PerfVerdict {
  const memoryPressure = evaluateMemoryPressure(signals, nowMs, budgets);
  const base: PerfVerdict = {
    status: 'unknown', degraded: false, reasons: [], hostState: null,
    worstWorkerCpuPct: null, worstWorkerRssKb: null, closeWait: null,
    eventLoopLagP95Ms: null, eventLoopLagMaxMs: null,
    eventLoopLagSampleCount: null, eventLoopLagWindowMs: null,
    eventLoopLagWindowMature: null, operatorReachable: null,
    inotifyTotalWatches: null, inotifyMaxPerProc: null, psiCpuSome60: null,
    cgroupCpuAttribution: null,
    psiMemorySome60: null, psiMemoryFull60: null, memoryPressure,
    sessionDirs: null,
    ageMs: null, stale: false, suppressedReasons: [],
    // Empty on every non-crit path; the crit branch below is the only writer.
    critAttribution: { operatorDefect: [], ambientHost: [] },
  };
  if (!signals || signals.schemaVersion !== 'perf-signals-v1') return base;
  const s = signals.signals ?? ({} as PerfSignalsV1['signals']);
  const capMs = Date.parse(signals.capturedAt);
  const ageMs = Number.isNaN(capMs) ? null : Math.max(0, nowMs - capMs);
  const workers = Array.isArray(s.operatorWorkers) ? s.operatorWorkers : [];
  const worstCpu = workers.length ? Math.max(...workers.map((w) => w.cpuPct || 0)) : null;
  const worstRss = workers.length ? Math.max(...workers.map((w) => w.rssKb || 0)) : null;
  const closeWait = typeof s.closeWait_3070 === 'number' ? s.closeWait_3070 : null;
  const loopLag = lagReading(s);
  const lag = loopLag.p95Ms;
  const reachable = typeof s.operator_3070_reachable === 'boolean' ? s.operator_3070_reachable : null;
  const inotifyTotal = typeof s.inotify?.totalWatches === 'number' ? s.inotify.totalWatches : null;
  const inotifyMax = s.inotify?.maxPerProcess ?? null;
  const inotifyOwnedMax = worstOwnedInotifyHolder(s.inotify?.topProcs ?? null);
  const inotifyLimit = typeof s.inotify?.limits?.maxUserWatches === 'number' ? s.inotify.limits.maxUserWatches : null;
  const psiCpu = typeof s.psi?.cpu?.some?.avg60 === 'number' ? s.psi.cpu.some.avg60 : null;
  const cgroupCpuAttribution = summarizeCgroupCpu(s.cgroupCpu);
  const psiMemSome = memoryPressure.psiMemorySome60;
  const psiMemFull = memoryPressure.psiMemoryFull60;
  const sessionDirs = s.sessionDirs
    ? {
        claudeOwnerDirs: typeof s.sessionDirs.claudeOwnerDirs === 'number' ? s.sessionDirs.claudeOwnerDirs : null,
        codexHomes: typeof s.sessionDirs.codexHomes === 'number' ? s.sessionDirs.codexHomes : null,
      }
    : null;
  const v: PerfVerdict = {
    ...base,
    hostState: signals.hostState ?? null,
    worstWorkerCpuPct: worstCpu, worstWorkerRssKb: worstRss, closeWait,
    eventLoopLagP95Ms: lag, eventLoopLagMaxMs: loopLag.maxMs,
    eventLoopLagSampleCount: loopLag.sampleCount, eventLoopLagWindowMs: loopLag.windowMs,
    eventLoopLagWindowMature: loopLag.windowMature, operatorReachable: reachable,
    inotifyTotalWatches: inotifyTotal, inotifyMaxPerProc: inotifyMax, psiCpuSome60: psiCpu,
    cgroupCpuAttribution,
    psiMemorySome60: psiMemSome, psiMemoryFull60: psiMemFull,
    sessionDirs,
    ageMs,
    stale: ageMs !== null && ageMs > budgets.staleMs,
  };
  if (v.stale) {
    // Present-but-stale: distinguish a brief gap (skipped a tick → `unknown`: numbers
    // untrustworthy but not alarming) from a DEAD producer (age past blindMs → the host
    // SLO monitor is blind → `warn`, so a stopped capture timer is visible instead of
    // failing open forever). Never crit — stale numbers must not red the system (the
    // original fail-safe). WI-324 recurrence guard.
    if (ageMs !== null && ageMs > budgets.blindMs) {
      const mins = Math.round(ageMs / 60_000);
      return {
        ...v,
        status: 'warn',
        reasons: [
          `perf-signals capture ${mins}min stale (> ${Math.round(budgets.blindMs / 60_000)}min) — host SLO monitor blind; check papercup-perf-signals-capture.timer`,
        ],
      };
    }
    return { ...v, status: 'unknown' };
  }

  // ── CRIT: definitive per-thread wedge (NOT loadavg — see the file header) ──────
  //
  // WI-38449 / D-007 F3: each crit reason is attributed AS IT IS RAISED, at the only
  // place that knows which signal produced it. Deriving attribution later by matching
  // reason PROSE would be a string-matching guard over text these same lines format —
  // it would silently mis-attribute the moment anyone reworded a message, and fail
  // toward "operator-defect" (i.e. toward blocking deploys), the expensive direction.
  const crit: string[] = [];
  const operatorDefect: string[] = [];
  const ambientHost: string[] = [];
  /** Raise a crit reason under exactly one attribution. */
  const raise = (reason: string, attribution: 'operator-defect' | 'ambient-host'): void => {
    crit.push(reason);
    (attribution === 'operator-defect' ? operatorDefect : ambientHost).push(reason);
  };
  const suppressed: string[] = [];
  if (lag !== null && lag >= budgets.eventLoopLagP95CritMs && loopLag.windowMature === false) {
    suppressed.push(
      `event-loop lag p95 ${lag}ms not promoted to critical: immature partial window (${loopLag.sampleCount ?? '?'} samples over ${loopLag.windowMs ?? '?'}ms; max ${loopLag.maxMs ?? '?'}ms retained)`,
    );
  }
  if (reachable === false) {
    if (deployInProgress) {
      // EI-12302: a sanctioned deploy restart holds 'dev-server' exclusive for the
      // whole drain→restart→health-probe window — the operator is EXPECTED to be
      // briefly unreachable then. Downgrade this one reason instead of paging.
      suppressed.push('operator :3070 unreachable (deploy-in-progress, suppressed)');
    } else {
      // OUR process is not answering. Nothing ambient explains this, and deploying
      // onto an unreachable operator is exactly what block-mode is for.
      raise('operator :3070 unreachable', 'operator-defect');
    }
  }
  if (signals.hostState === 'wedge-active') raise('hostState=wedge-active (live wedge captured)', 'operator-defect');
  // A FULL second of event-loop lag at p95 is our main thread saturated, not the box
  // being shared — ambient CPU contention shows up as PSI, which is classed below.
  // Legacy captures have no maturity field and retain the pre-existing verdict.
  // New captures explicitly set false while the reset window is too small for a
  // single maximum not to define p95; preserve the stall as WARN evidence, but
  // do not page or block a deploy as a sustained operator defect.
  if (lag !== null && lag >= budgets.eventLoopLagP95CritMs && loopLag.windowMature !== false) {
    raise(`event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95CritMs}ms`, 'operator-defect');
  }
  if (closeWait !== null && closeWait >= budgets.closeWaitCrit) raise(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitCrit} (event-loop peg)`, 'operator-defect');
  if (inotifyTotal !== null && inotifyLimit !== null && inotifyTotal >= inotifyLimit * budgets.inotifyLimitCritFrac) {
    // AMBIENT, deliberately — and this one is a judgement call worth stating, because
    // the D-007 note that opened this work provisionally listed it as operator-defect.
    // It is host-TOTAL and the kernel limit is per-UID, so this counts every process
    // the user runs; WI-6538 measured VS Code alone holding 38,937 watches (3.9x the
    // per-proc budget) and rewrote the WARN path for exactly that reason. Blocking a
    // release because the owner's editor is watching files would be a red the
    // candidate's author cannot fix — the "permanently amber for a reason nobody can
    // fix" failure WI-6538 names. It stays crit and stays alarmed; it just never holds
    // a deploy. (The per-process OWNED balloon — our own recursive watcher, the actual
    // 2026-07-10 meltdown class — is budgeted on the warn path above, where ownership
    // information exists to attribute it.)
    raise(`inotify watches ${inotifyTotal} ≥ ${Math.round(budgets.inotifyLimitCritFrac * 100)}% of max_user_watches ${inotifyLimit} — ENOSPC imminent, fs.watch boots will fail fleet-wide`, 'ambient-host');
  }
  if (psiCpu !== null && psiCpu >= budgets.psiCpuSomeCrit) {
    raise(
      withCgroupCpuAttribution(
        `PSI cpu some avg60 ${psiCpu} ≥ ${budgets.psiCpuSomeCrit} — tasks starved for CPU (host saturation)`,
        cgroupCpuAttribution,
      ),
      'ambient-host',
    );
  }
  // Multi-tenant RAM pressure from ~100 peer agents. This is the exact reason D-007 F3
  // exists: measured 2026-08-16 it was the SOLE crit reason on a live capture.
  if (memoryPressure.pressure === 'crit') for (const r of memoryPressure.reasons) raise(r, 'ambient-host');
  if (crit.length) {
    return {
      ...v,
      status: 'crit',
      degraded: true,
      reasons: crit,
      suppressedReasons: suppressed,
      critAttribution: { operatorDefect, ambientHost },
    };
  }

  // ── WARN: hot-but-not-fatal ────────────────────────────────────────────────────
  const warn: string[] = [];
  if (lag !== null && lag >= budgets.eventLoopLagP95WarnMs) {
    warn.push(
      loopLag.windowMature === false
        ? `event-loop lag partial window p95 ${lag}ms / max ${loopLag.maxMs ?? '?'}ms (${loopLag.sampleCount ?? '?'} samples over ${loopLag.windowMs ?? '?'}ms) — insufficient for critical p95 classification`
        : `event-loop lag p95 ${lag}ms ≥ ${budgets.eventLoopLagP95WarnMs}ms`,
    );
  }
  if (closeWait !== null && closeWait >= budgets.closeWaitWarn) warn.push(`:3070 CLOSE_WAIT ${closeWait} ≥ ${budgets.closeWaitWarn}`);
  if (worstCpu !== null && worstCpu >= budgets.workerCpuPctWarn) warn.push(`a worker at ${Math.round(worstCpu)}% CPU ≥ ${budgets.workerCpuPctWarn}% (hot thread)`);
  if (worstRss !== null && worstRss >= budgets.workerRssKbWarn) warn.push(`a worker RSS ${(worstRss / 1048576).toFixed(1)}GB ≥ ${(budgets.workerRssKbWarn / 1048576).toFixed(1)}GB`);
  // WI-6538: budget the worst PAPERCUSP-OWNED holder, not the worst holder host-wide.
  // This check exists to catch OUR watcher ballooning (the 2026-07-10 meltdown was our own
  // workers: a recursive fs.watch × 16 of them). Scored against every process on the box it
  // instead reports whatever third-party tool watches the most — on a dev workstation that
  // is the editor (VS Code measured at 38,937 watches, 3.9x budget), which is neither our
  // bug nor actionable by a release gate. A gate that is permanently amber for a reason
  // nobody can fix is worse than no gate: it trains readers to ignore it.
  // Falls back to the host-wide max when no ownership info is present, so an older capture
  // (or a host where cgroups are unavailable) keeps the pre-WI-6538 behaviour rather than
  // silently checking nothing. Host-TOTAL exhaustion is checked separately below and stays
  // deliberately unscoped — the kernel limit is per-uid, so who caused it does not matter.
  const inotifyWorst = inotifyOwnedMax.attributable ? inotifyOwnedMax.worst : inotifyMax;
  if (inotifyWorst && inotifyWorst.watches >= budgets.inotifyPerProcWarn) {
    warn.push(`${inotifyWorst.comm} (pid ${inotifyWorst.pid}) holds ${inotifyWorst.watches} fs watches ≥ ${budgets.inotifyPerProcWarn} — watch balloon (2026-07-10 meltdown class: find the recursive/unbounded watcher)`);
  }
  if (inotifyTotal !== null && inotifyLimit !== null && inotifyTotal >= inotifyLimit * budgets.inotifyLimitWarnFrac) {
    warn.push(`inotify watches ${inotifyTotal} ≥ ${Math.round(budgets.inotifyLimitWarnFrac * 100)}% of max_user_watches ${inotifyLimit}`);
  }
  if (psiCpu !== null && psiCpu >= budgets.psiCpuSomeWarn) {
    warn.push(
      withCgroupCpuAttribution(
        `PSI cpu some avg60 ${psiCpu} ≥ ${budgets.psiCpuSomeWarn} — sustained CPU starvation pressure`,
        cgroupCpuAttribution,
      ),
    );
  }
  if (memoryPressure.pressure === 'warn') warn.push(...memoryPressure.reasons);
  for (const [label, n] of [
    ['session-claude owner dirs', sessionDirs?.claudeOwnerDirs],
    ['codex per-session homes', sessionDirs?.codexHomes],
  ] as const) {
    if (typeof n === 'number' && n >= budgets.sessionDirsWarn) {
      warn.push(
        `${n} ${label} ≥ ${budgets.sessionDirsWarn} — archive-at-death lifecycle stalled (check the session-archive exit hook + hourly reconciler; session-db-archive-retire-dirs P-007)`,
      );
    }
  }
  if (s.gateway_8788_reachable === false) warn.push('inference gateway :8788 unreachable');
  if (warn.length) return { ...v, status: 'warn', reasons: warn, suppressedReasons: suppressed };
  return { ...v, status: 'ok', reasons: [], suppressedReasons: suppressed };
}

export const PERF_BASELINES_DIR = join(homedir(), '.papercusp', 'perf-baselines');

/**
 * Read the most-recent perf-signals-v1 JSON capture (by mtime) from the perf-baselines
 * dir, or null when none / unreadable / wrong-schema. Fail-soft: a missing dir (no E1
 * cron on this box yet) returns null so the infra panel simply behaves as before.
 */
export async function readLatestPerfSignals(dir: string = PERF_BASELINES_DIR): Promise<PerfSignalsV1 | null> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return null; }
  const jsons = entries.filter((f) => f.endsWith('.json'));
  if (!jsons.length) return null;
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const f of jsons) {
    try {
      const st = await stat(join(dir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: join(dir, f), mtimeMs: st.mtimeMs };
    } catch { /* unreadable entry — skip */ }
  }
  if (!newest) return null;
  try {
    const parsed = JSON.parse(await readFile(newest.path, 'utf8')) as PerfSignalsV1;
    return parsed?.schemaVersion === 'perf-signals-v1' ? parsed : null;
  } catch { return null; }
}

/**
 * Retention window for `*-incident-*.json` forensic snapshots preserved by
 * {@link preserveIncidentCapture} — TIME-bounded, not count-bounded.
 *
 * EI-20985533910345265: the prior policy pruned to a flat newest-N (100) file
 * COUNT regardless of age. EI-12982's stated purpose is to survive "a
 * root-cause pass that may happen days later" — but on a host whose infra
 * panel flaps into `crit` frequently (measured live 2026-08-21: exactly 100
 * incident files present, the OLDEST dated ~13h earlier — the entire 100-file
 * budget consumed in under half a day), that count cap silently evicted
 * evidence within HOURS, defeating the "days later" guarantee the mechanism
 * exists to provide. The filed bug ("the generator/saturation mechanism still
 * needs attribution") was unattributable for exactly this reason: by the time
 * anyone looked, the evidence needed for attribution had already been
 * evicted. Age is now the PRIMARY retention criterion — anything younger than
 * this window survives regardless of count. */
const INCIDENT_CAPTURE_RETENTION_DAYS = 14;

/**
 * Hard ceiling on file COUNT even within the retention window — the
 * defense-in-depth backstop against unbounded disk growth if a host stays
 * pathologically flappy for the WHOLE retention window (a genuinely wedged
 * host repeatedly re-triggering the edge). Sized generously above the
 * observed live churn (100 files / ~13h ⇒ ~185/day ⇒ ~2,600 over 14d), so
 * this is a safety net, not the everyday limiter — the everyday limiter is
 * age, per the constant above.
 */
const INCIDENT_CAPTURE_MAX_FILES = 5000;

/**
 * PURE: decide which incident-capture files to delete, given every
 * candidate's path + mtime and the current time. Age-first — anything older
 * than the retention window is pruned unconditionally — then, ONLY if the
 * survivors still exceed the safety cap, oldest-first among the survivors.
 * Exported so the retention policy is unit-testable without touching the
 * filesystem (the `preserveIncidentCapture` IO wrapper below is the thin
 * caller). Never mutates `entries`.
 */
export function selectIncidentFilesToPrune(
  entries: ReadonlyArray<{ path: string; mtimeMs: number }>,
  nowMs: number,
  opts: { retentionDays?: number; maxFiles?: number } = {},
): string[] {
  const retentionMs = (opts.retentionDays ?? INCIDENT_CAPTURE_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const maxFiles = opts.maxFiles ?? INCIDENT_CAPTURE_MAX_FILES;
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  const toDelete: string[] = [];
  const survivors: { path: string; mtimeMs: number }[] = [];
  for (const e of sorted) {
    if (nowMs - e.mtimeMs > retentionMs) toDelete.push(e.path);
    else survivors.push(e);
  }
  if (survivors.length > maxFiles) {
    for (const e of survivors.slice(maxFiles)) toDelete.push(e.path);
  }
  return toDelete;
}

/**
 * EI-12982: preserve the LATEST perf-signals-v1 capture as a durably-named
 * incident snapshot when the infra panel edge-transitions into `crit` (a
 * "PER-THREAD WEDGE" verdict, or any other infra-crit cause). Root-causing a
 * self-recovered flap is realistically a LATER backlog pass (the watchdog
 * pages, someone files an item, root-cause happens on the next drain) — but
 * `capture-perf-signals.sh`'s routine rotation only retains the newest 15
 * `*-scheduled.json` files (~30 min at the 2-min cadence), so by the time
 * anyone looks the forensic evidence is already gone (confirmed empty for the
 * 2026-07-16 03:33Z/19:45Z flaps this item was filed from). Copying (not
 * moving — the scheduled rotation must stay untouched) the current capture to
 * an `*-incident-<reason>-*.json` file exempts it from that rotation glob, so
 * the NEXT such flap leaves something to root-cause instead of nothing.
 * The destination is keyed by the source capture name and reason, so clustered
 * health workers racing on the same edge preserve one file rather than creating
 * a random-suffix storm. The exclusive copy makes that de-duplication atomic.
 * Fail-soft: never throws (callers run this from a tick's best-effort side
 * effects, same pattern as the ack-sweep / history recording next to it).
 */
export async function preserveIncidentCapture(
  reason: string,
  dir: string = PERF_BASELINES_DIR,
): Promise<{ preserved: boolean; path?: string }> {
  try {
    let entries: string[];
    try { entries = await readdir(dir); } catch { return { preserved: false }; }
    const jsons = entries.filter((f) => f.endsWith('.json') && !f.includes('-incident-'));
    if (!jsons.length) return { preserved: false };
    let newest: { path: string; mtimeMs: number } | null = null;
    for (const f of jsons) {
      try {
        const st = await stat(join(dir, f));
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: join(dir, f), mtimeMs: st.mtimeMs };
      } catch { /* unreadable entry — skip */ }
    }
    if (!newest) return { preserved: false };
    const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '') || 'unlabeled';
    // The source basename is the capture identity. A clustered health tick can
    // run in many workers, all observing the same edge and the same newest
    // capture; COPYFILE_EXCL makes the first writer win and all other workers
    // become harmless no-ops instead of creating duplicate forensic files.
    const sourceId = basename(newest.path, '.json').replace(/[^a-zA-Z0-9_-]/g, '-') || 'capture';
    const dest = join(dir, `${sourceId}-incident-${safeReason}.json`);
    try {
      await copyFile(newest.path, dest, fsConstants.COPYFILE_EXCL);
    } catch {
      // EEXIST is the expected result of a peer worker preserving this same
      // source/reason pair. Other filesystem failures are also fail-soft.
      return { preserved: false };
    }

    // Bound the incident set by AGE (see INCIDENT_CAPTURE_RETENTION_DAYS above),
    // with a count-based safety backstop — never a flat newest-N count alone.
    try {
      const all = await readdir(dir);
      const incidents: { path: string; mtimeMs: number }[] = [];
      for (const f of all) {
        if (!f.endsWith('.json') || !f.includes('-incident-')) continue;
        try {
          const st = await stat(join(dir, f));
          incidents.push({ path: join(dir, f), mtimeMs: st.mtimeMs });
        } catch { /* unreadable — skip */ }
      }
      for (const stale of selectIncidentFilesToPrune(incidents, Date.now())) {
        await unlink(stale).catch(() => {});
      }
    } catch { /* pruning is best-effort — never fail the preserve on it */ }

    return { preserved: true, path: dest };
  } catch {
    return { preserved: false };
  }
}
