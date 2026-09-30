/**
 * memory-watchdog.ts — bounded-RSS self-recycle for the long-running Hono host.
 *
 * The :3070 operator (`bin/hono-host.ts`, `tsx`, node, `Restart=always`) leaks
 * retained heap under fleet load — observed 2026-06-07 growing ~0.2 GB/min with
 * no plateau (0.76 GB fresh → 4.5 GB in ~30 min). Node has no heap cap here, so
 * V8 lets the heap balloon; past ~4 GB the GC pauses stall the single-threaded
 * event loop for seconds, and THAT is what intermittently broke everything that
 * night — MCP handshakes succeeded-then-dropped, `/api/harness/:slug/invoke`
 * returned empty, spawned-agent MCP mounts raced and failed, even `/api/health`
 * flipped between 10 ms and timeout. The event-loop-lag gauge (EI-79) reports
 * the *symptom*; this bounds the *cause*.
 *
 * Mitigation (not a leak fix — that's a separate profiling task): poll RSS on a
 * slow cadence and, when it crosses a high-water mark for N consecutive samples
 * (debounced against a transient spike), GRACEFULLY recycle — drain in-flight
 * work, then exit; systemd `Restart=always` reboots a fresh low-RSS process in
 * ~5 s. A bounded recycle every ~30 min beats a slow event-loop death. The
 * default high-water mark (3.2 GB) sits comfortably below the ~4 GB stall zone
 * yet high enough to give real uptime between recycles.
 *
 * Standard production pattern (PM2 `max_memory_restart`, k8s memory limits) —
 * here in-process so it can drain HTTP gracefully before exiting.
 *
 * ## The watchdog measures COMMITTED memory (RSS + swap), not RSS (WI-2145659)
 *
 * Every threshold here was calibrated in an era when this box did not swap, so
 * `process.memoryUsage().rss` was an accurate proxy for the process's real memory
 * demand. Under fleet load that proxy BREAKS, and it breaks silently and in the
 * direction that looks healthy: measured 2026-09-05 on :3070, worker 3415868 held
 * 1779 MB resident + 1210 MB swapped = 2989 MB committed — 93% of its 3200 MB
 * recycle limit — while `rss` reported 1779 MB, i.e. 56%. It therefore sat below
 * the 2400 warn line AND below the 1920 proactive-GC trigger, so it emitted no
 * warning, was never GC'd, and could never recycle. `--max-old-space-size=131072`
 * means V8 will not intervene either. A swapped worker was, in effect, unbounded
 * and invisible to the one instrument watching it.
 *
 * RSS is also the wrong QUANTITY on principle: how much of a process's memory is
 * resident versus paged out is the KERNEL's choice, driven by pressure from other
 * processes on the box. Two identical workers can differ 40% in RSS for reasons
 * that have nothing to do with either one. `VmRSS + VmSwap` is the process's own
 * demand, which is what a per-process budget is actually about. So switching the
 * thresholds to committed memory RESTORES the intended behaviour rather than
 * changing it — the numbers mean today what they were always meant to mean.
 *
 * When swap cannot be measured (non-Linux, `/proc` unreadable) the swap term is
 * -1 = UNKNOWN and the watchdog degrades to exactly its previous RSS-only
 * behaviour. It is never treated as zero: reading an unmeasurable value as
 * healthy is the same inversion this whole section is about.
 */

import { readFileSync } from 'node:fs';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { runInNewContext } from 'node:vm';
import { backgroundWorkersEnabled } from './background-workers';
import { parseProcStatusMemory } from './process-memory-pressure';

/**
 * Default COMMITTED-memory high-water mark (MiB), by host ROLE — used when
 * `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` is not set explicitly. Compared against
 * `VmRSS + VmSwap`, not `rss` (WI-2145659). The tier values below were measured
 * as RSS on a non-swapping box, where the two were the same number; they are
 * unchanged because the quantity they were always meant to bound is committed.
 *
 * The original single 3200 default was sized for a request-serving host. The
 * dedicated BACKGROUND primary (the bg-host, `PAPERCUSP_BACKGROUND_WORKERS=1`)
 * is a different animal: it boots the full hyperbee substrate (~25 harnesses)
 * AND drives DBOS catch-up recovery, so its real working set is ~3.8 GB
 * baseline + ~108 MB/harness (observed ~5 GB). 3200 trips within minutes there
 * and the host recycles in a loop — and pre-EI-1613 the exit-0 recycle left it
 * DEAD under `Restart=on-failure`, freezing the whole routine engine (EI-1613;
 * the same class the dev-api host hit in EI-127, patched there with a 12288
 * systemd drop-in). A plain request-only worker (BG=0, e.g. the :3070 cluster
 * workers) does NOT boot the substrate and stays light, so 3200 fits it. The
 * desktop dev operator on :3270 is request-only but not plain: its measured
 * born RSS is ~10.6–11.6 GiB, so it gets a dedicated desktop tier below.
 *
 * ⚠ EI-19484864948547581 (2026-08-09): the :3170 staging operator is BG=0 too,
 * but it is NOT "light" — measured born RSS ~5.5 GB (already 1.7× the 3200
 * REQUEST limit before serving a single request), climbing to 7.3 GB under
 * load. The born-over-budget guard (EI-11522) therefore suppressed the recycle
 * on 10 of 10 observed boots, letting the host run unbounded up to 2.29× the
 * (wrong) limit. :3170 gets its OWN tier, sized with real headroom above the
 * measured ~7.3 GB max — do not fold it back into REQUEST without re-measuring.
 */
export const MEMORY_WATCHDOG_LIMIT_MB_REQUEST = 3200;
export const MEMORY_WATCHDOG_LIMIT_MB_DESKTOP = 16384;
export const MEMORY_WATCHDOG_LIMIT_MB_STAGING = 10240;
export const MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND = 12288;

/**
 * Role-aware proactive-GC thresholds. These intentionally do NOT derive from
 * `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB`: that variable is a recycle backstop
 * override, and raising it must not silently move the cause-side GC trigger
 * out of reach (EI-20237116358190923).
 */
export const MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST = Math.round(MEMORY_WATCHDOG_LIMIT_MB_REQUEST * 0.6);
export const MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP = Math.round(MEMORY_WATCHDOG_LIMIT_MB_DESKTOP * 0.6);
export const MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING = Math.round(MEMORY_WATCHDOG_LIMIT_MB_STAGING * 0.6);
export const MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND = Math.round(MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND * 0.6);

/**
 * The COMMITTED-memory high-water mark (MiB) THIS process should recycle at. An explicit
 * `PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB` always wins; otherwise the default is
 * role-aware (see above), so a FRESH box's bg-host — and the :3170 staging
 * operator — are correct WITHOUT a box-local systemd drop-in (EI-1613 — the
 * durable fix for the 3200-too-low bug that was only ever papered over
 * per-box; EI-19484864948547581 extends the same principle to :3170).
 *
 * Checked in this order: BACKGROUND (boots the substrate) > DESKTOP (the
 * :3270 port specifically — request-only by design but measured at ~10.6–11.6
 * GiB born RSS) > STAGING (the :3170 port specifically — request-only by design
 * but demonstrably heavier than a plain request worker) > REQUEST (everything
 * else, e.g. the :3070 cluster workers).
 */
export function resolveMemoryWatchdogLimitMb(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (backgroundWorkersEnabled(env)) return MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND;
  if (env.PAPERCUSP_HONO_PORT === '3270') return MEMORY_WATCHDOG_LIMIT_MB_DESKTOP;
  if (env.PAPERCUSP_HONO_PORT === '3170') return MEMORY_WATCHDOG_LIMIT_MB_STAGING;
  return MEMORY_WATCHDOG_LIMIT_MB_REQUEST;
}

/**
 * Resolve the proactive-GC trigger independently from the recycle backstop.
 * An explicit proactive-GC override wins; otherwise the process role chooses
 * the threshold. In particular, an explicit recycle-limit override does not
 * change this value, so a high backstop cannot disable the cause-side fix.
 */
export function resolveMemoryWatchdogProactiveGcMb(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.PAPERCUSP_MEMORY_PROACTIVE_GC_MB);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (backgroundWorkersEnabled(env)) return MEMORY_WATCHDOG_PROACTIVE_GC_MB_BACKGROUND;
  if (env.PAPERCUSP_HONO_PORT === '3270') return MEMORY_WATCHDOG_PROACTIVE_GC_MB_DESKTOP;
  if (env.PAPERCUSP_HONO_PORT === '3170') return MEMORY_WATCHDOG_PROACTIVE_GC_MB_STAGING;
  return MEMORY_WATCHDOG_PROACTIVE_GC_MB_REQUEST;
}

export interface MemoryWatchdogOpts {
  /**
   * COMMITTED-memory high-water mark in MiB — compared against `VmRSS + VmSwap`,
   * NOT against `rss` (WI-2145659; see the committed-memory section at the top of
   * this file). Crossing it for `tripsToRecycle` samples → recycle. Direct-call
   * default 3200; host boot passes a role-aware value.
   *
   * Named `limitMb`, not `rssLimitMb`: it was renamed WITH the measurement it
   * gates. A field called `rss*` holding a committed threshold is the same
   * name-means-one-thing/value-means-another trap that hid the original bug for
   * weeks, and this file has cost enough hours to misread numbers already.
   */
  limitMb?: number;
  /** Soft warn threshold in MiB (committed) — log a structured gauge line above this (observability). Default = 0.75 × limitMb. */
  warnMb?: number;
  /** Sample cadence (ms). Default 30_000. */
  intervalMs?: number;
  /** Consecutive over-limit samples before recycling (debounce). Default 2. */
  tripsToRecycle?: number;
  /**
   * PROACTIVE-GC threshold (MiB) — the ROOT bg-host-freeze fix. When COMMITTED
   * memory crosses this (well BELOW `limitMb`) and `--expose-gc` made `global.gc`
   * available,
   * run ONE forced full GC to reclaim retained heap BEFORE V8's own
   * heap-pressure GC kicks in. Why this matters: `NODE_OPTIONS` here carries
   * `--max-old-space-size=131072` (128 GB — a box-wide setting for the 251 GB
   * host), which DEFEATS V8's heap-limit-paced GC: the old generation grows into
   * the multi-GB regime where a single mark-compact pause stalls the SINGLE event
   * loop for seconds-to-minutes. On the BACKGROUND primary (the routine ticker)
   * that stall IS the "bg-host frozen ~27 min, ticker stops firing, watchdog
   * restarts a healthy host" incident (EI-2186 spawn-reclaim massacre). A cheap
   * forced GC at ~60% of the recycle limit keeps the live heap small enough that
   * V8's pauses stay sub-100ms, so the loop never freezes. Default = 0.6 ×
   * limitMb. Set <= 0 (or unset `global.gc`) to disable. The GC itself is
   * debounced (`gcCooldownMs`) so a host parked above the threshold doesn't GC
   * every tick. This is the cause-side fix; the recycle is the last-resort
   * backstop, the watchdog the last-last-resort.
   */
  proactiveGcMb?: number;
  /** Minimum gap between forced proactive GCs (ms). Default 120_000 (2 min). */
  gcCooldownMs?: number;
  /**
   * BORN-OVER-BUDGET recycle guard (EI-11522). When true (default), the recycle
   * is SUPPRESSED for a process that has NEVER been observed below `warnMb` since
   * the watchdog started — i.e. it booted straight into an over-budget working
   * set (the desktop sidecar warm-boots ~23 plugins to ~3.1 GB the moment it
   * starts) rather than *growing* into the limit over time.
   *
   * Why: a SIGKILL recycle can only shed heap the fresh restart won't immediately
   * re-allocate. A process whose STEADY-STATE working set is already over the cap
   * boots right back into the same footprint, trips again a few minutes later, and
   * recycles again — a hot SIGKILL loop that reclaims ~nothing (observed live:
   * `reclaimedMb: 6` of `rssMbAfter: 3117`, `limitMb: 3200`) and severs every
   * in-flight converse SSE turn each cycle (the user turn persists, the assistant
   * reply is lost). Recycling cannot fix a working set that is genuinely too big
   * for the limit, so looping is strictly harmful. Instead escalate loudly (the
   * limit is misconfigured / the working set must shed) and keep serving — the
   * in-flight turn survives.
   *
   * A process that DID observe a healthy sample (committed < warnMb) before crossing the
   * limit *grew* into it, so its excess heap IS sheddable — that recycles normally
   * (the original 0.2 GB/min-leak case the watchdog exists for is unchanged). Set
   * false to restore the always-recycle behavior.
   */
  suppressBornOverBudgetRecycle?: boolean;
  /** Injectable forced-GC seam (tests). Defaults to `global.gc` when `--expose-gc`. */
  forceGc?: (() => void) | null;
  /**
   * Injectable native-heap trim seam — `malloc_trim(0)` in practice (WI-2145733).
   *
   * WHY THIS EXISTS, and why a forced GC is not enough: V8's GC hands freed bytes
   * back to the ALLOCATOR; glibc's allocator keeps them. Measured 2026-09-05 on a
   * 2.65h-old :3170 worker (pid 1596606) at 1709 MB committed — 1066 MB of that was
   * the glibc `[heap]` arena. A forced full GC freed 13 MB (3.8%); a `malloc_trim(0)`
   * freed 627 MB (`[heap]` Rss 1066.0 -> 421.6), process healthy afterwards. So the
   * proactive-GC rung can run, succeed, and barely move committed memory — after
   * which the watchdog recycles and kills in-flight converse SSE streams (EI-11522).
   *
   * NOT reachable by tuning: `MALLOC_TRIM_THRESHOLD_` / `mallopt(M_TRIM_THRESHOLD)`
   * govern only TOP-of-heap shrinking. In the same measurement `[heap]` Vsz stayed
   * at 1088.8 MB while Rss fell — the brk top never moved, so the release was
   * `MADV_DONTNEED` on INTERIOR free pages, which no threshold can reach.
   *
   * DEFAULT IS null — there is deliberately no in-process binding yet. Calling
   * `malloc_trim` from Node needs a native (N-API) addon or an FFI library; as of
   * 2026-09-05 this repo declares NEITHER (verified: `node-addon-api`,
   * `node-gyp-build` and `bindings` appear in 0 of 71 tracked package.json files,
   * and no `koffi`/`ffi-napi` is installed). Adding one is a real build-surface
   * decision, so it is left to the caller: inject an implementation here and the
   * watchdog starts trimming and reporting reclaim with no further change.
   *
   * Contract for an implementation: synchronous, must not throw (a throw is caught
   * and swallowed — a trim must never crash the watchdog), and a no-op on any
   * platform without glibc.
   */
  trimNativeHeap?: (() => void) | null;
  /** Structured log sink. Default console.warn. */
  log?: (line: string, detail: Record<string, number>) => void;
  /**
   * Exit code the default recycle uses. NON-ZERO (default 75 = EX_TEMPFAIL) so a
   * recycle restarts under BOTH `Restart=always` AND `Restart=on-failure` — a unit
   * that ships `on-failure` (as the bg-host did) must still self-restart, else the
   * recycle exits 0 and the host stays dead (EI-1613, R4-1). Override in tests.
   */
  recycleExitCode?: number;
  /**
   * What to do when the high-water mark trips. Default: log loudly then
   * `process.exit(recycleExitCode)` after a short flush delay (systemd restarts).
   * A real host should inject `gracefulHostRecycle` (host-recycle.ts) so in-flight
   * HTTP drains AND the P2P substrate handles close before exit (audit P-002,
   * EI-127) — hono-host.ts does.
   */
  onTrip?: (detail: {
    /** True resident-set size in MiB — reported for continuity, NOT what tripped. */
    rssMb: number;
    /** Swapped-out MiB, or -1 when swap could not be measured (never read -1 as 0). */
    swapMb: number;
    /** `rssMb + swapMb` — the quantity actually compared against `limitMb`. */
    committedMb: number;
    limitMb: number;
  }) => void;
  /**
   * Injectable swap reader (tests). Defaults to `readSelfSwapMb`. Returning -1
   * simulates a host where swap is unmeasurable, which must degrade to RSS-only
   * behaviour rather than to a falsely-low committed reading.
   *
   * This exists as a seam because the RSS side is already stubbable via
   * `process.memoryUsage()` and the swap side is not: without it a test could set
   * an RSS but not a committed figure, so the very behaviour this change adds
   * would be the one thing untestable.
   */
  readSwapMb?: () => number;
}

export interface MemoryWatchdogHandle {
  /** Stop sampling (clears the timer). */
  stop(): void;
  /** Current RSS in MiB (for an endpoint/test). Resident only — see `committedMb`. */
  rssMb(): number;
  /**
   * Current COMMITTED memory in MiB (`VmRSS + VmSwap`) — the quantity the
   * thresholds use, and the one to quote when reporting how much memory this
   * process is holding. Falls back to `rssMb()` when swap is unmeasurable.
   */
  committedMb(): number;
}

const bytesToMb = (b: number) => Math.round(b / (1024 * 1024));

/**
 * Swapped-out memory for THIS process, in MiB — the term `process.memoryUsage().rss`
 * structurally cannot see (WI-2145659; see the committed-memory section at the top).
 *
 * Reuses `parseProcStatusMemory` from process-memory-pressure.ts rather than
 * re-deriving the `/proc/<pid>/status` regex: that parser already contains the
 * field-width/tab handling and is covered by its own tests, and a second copy of a
 * kernel-format parser is exactly the kind of drift the derived-truth ladder warns
 * about. What is NOT reused is that module's `readProcessMemoryPressure`: it is
 * async and brackets a 500 ms major-fault sampling window, which is right for
 * explaining an already-failed probe and wrong for a synchronous threshold sample
 * that runs on every watchdog tick.
 *
 * ⚠ Returns -1 for UNKNOWN, never 0. A 0 would silently claim "nothing is swapped"
 * on a host where the measurement simply could not be taken, which is the same
 * read-a-null-as-healthy inversion that made the original bug invisible. Callers
 * add the swap term only when it is >= 0, so an unmeasurable host degrades to the
 * previous RSS-only behaviour instead of to a falsely-low committed figure.
 */
export function readSelfSwapMb(): number {
  try {
    const { vmSwapKb } = parseProcStatusMemory(readFileSync('/proc/self/status', 'utf8'));
    if (vmSwapKb === null || !Number.isFinite(vmSwapKb) || vmSwapKb < 0) return -1;
    return Math.round(vmSwapKb / 1024);
  } catch {
    return -1;
  }
}

/**
 * V8 heap decomposition for the structured watchdog lines.
 *
 * WHY: RSS alone says HOW MUCH a worker holds and never WHAT. That single gap is
 * what left the :3070 ~2 GB/worker growth un-diagnosable across weeks of
 * investigation (WI-38221) — the only instrument on the hot path reported one
 * scalar, so every question about composition needed a bespoke probe or a heap
 * snapshot of a multi-GB production process. The watchdog already writes ~1300
 * structured records per 14h on every worker; emitting the split *beside* the RSS
 * gauge turns that existing stream into a decomposition over time, retroactively
 * answerable with a log query instead of new instrumentation.
 *
 * `detachedContexts` is the highest-signal field: a detached context count that
 * climbs and never returns to baseline is a textbook retainer (a context whose
 * global is unreachable but still referenced from somewhere live).
 *
 * Cost is bounded deliberately: this is computed ONLY at the two log sites, never
 * on every sample, so a healthy process below the warn line pays nothing.
 * Instrumentation must never break the thing it instruments — on any failure this
 * returns `{}` and the line is written exactly as it was before.
 */
function heapBreakdown(): Record<string, number> {
  try {
    const mu = process.memoryUsage();
    // number_of_detached_contexts / number_of_native_contexts are present in V8's
    // HeapInfo but not in every @types/node revision — read them defensively.
    const hs = getHeapStatistics() as ReturnType<typeof getHeapStatistics> & {
      number_of_detached_contexts?: number;
      number_of_native_contexts?: number;
    };
    return {
      heapUsedMb: bytesToMb(mu.heapUsed),
      heapTotalMb: bytesToMb(mu.heapTotal),
      externalMb: bytesToMb(mu.external),
      arrayBuffersMb: bytesToMb(mu.arrayBuffers ?? 0),
      detachedContexts: hs.number_of_detached_contexts ?? -1,
      nativeContexts: hs.number_of_native_contexts ?? -1,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve a forced full-GC hook for the proactive-GC freeze fix, WITHOUT requiring
 * `--expose-gc` in NODE_OPTIONS. Order: an already-exposed `global.gc`, else
 * runtime-enable it via `v8.setFlagsFromString('--expose-gc')` and grab the `gc`
 * binding through a fresh VM context. Returns null if neither works (never throws).
 * Cached null/fn is fine — the binding is stable for the process lifetime.
 */
export function resolveForceGc(): (() => void) | null {
  const exposed = (globalThis as { gc?: () => void }).gc;
  if (typeof exposed === 'function') return exposed;
  try {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    return typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

/**
 * Start the memory watchdog. Returns a handle; the timer is `unref`'d so it
 * never keeps the process alive on its own. Call once at host boot.
 */
export function startMemoryWatchdog(opts: MemoryWatchdogOpts = {}): MemoryWatchdogHandle {
  const limitMb = opts.limitMb ?? 3200;
  const warnMb = opts.warnMb ?? Math.round(limitMb * 0.75);
  const intervalMs = opts.intervalMs ?? 30_000;
  const tripsToRecycle = Math.max(1, opts.tripsToRecycle ?? 2);
  // Proactive-GC config (the root bg-host-freeze fix). Default threshold = 60% of
  // the recycle limit so a controlled GC runs in the safe band, long before the
  // GC-stall zone or the recycle. Disabled if the threshold is non-positive OR no
  // forced-GC hook is available (no `--expose-gc`).
  const proactiveGcMb = opts.proactiveGcMb ?? Math.round(limitMb * 0.6);
  const gcCooldownMs = Math.max(0, opts.gcCooldownMs ?? 120_000);
  const suppressBornOverBudgetRecycle = opts.suppressBornOverBudgetRecycle ?? true;
  // Resolve a forced-GC hook, fresh-box-correct (no dependency on `--expose-gc`
  // being in NODE_OPTIONS): prefer an injected seam, else `global.gc` if exposed,
  // else RUNTIME-enable it via `v8.setFlagsFromString('--expose-gc')` +
  // `vm.runInNewContext('gc')`. The runtime path makes the freeze fix durable on
  // any box (the production box happens to carry `--expose-gc` in a box-wide
  // ~/.profile, but a fresh deploy must not silently lose proactive GC).
  const forceGc = opts.forceGc !== undefined ? opts.forceGc : resolveForceGc();
  // Native-heap trim seam (WI-2145733). Unlike `forceGc` there is no resolver to
  // fall back to: no in-process `malloc_trim` binding exists in this repo yet, so
  // the default is null (disabled) and the rung below is skipped entirely. This is
  // the seam, not the binding — see `MemoryWatchdogOpts.trimNativeHeap`.
  const trimNativeHeap = opts.trimNativeHeap ?? null;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  const recycleExitCode = opts.recycleExitCode ?? 75;
  const onTrip =
    opts.onTrip ??
    ((detail) => {
      log(
        '[memory-watchdog] committed-memory high-water mark tripped — recycling host (systemd will restart)',
        {
          committedMb: detail.committedMb,
          rssMb: detail.rssMb,
          swapMb: detail.swapMb,
          limitMb: detail.limitMb,
          recycleExitCode,
        },
      );
      // Let the log line flush, then exit NON-ZERO so systemd restarts under
      // Restart=on-failure as well as Restart=always (EI-1613, R4-1) — RestartSec
      // (~5 s) brings up a fresh low-RSS process.
      setTimeout(() => process.exit(recycleExitCode), 250).unref?.();
    });

  let overCount = 0;
  let recycled = false;
  let lastGcAt = 0;
  // EI-11522: has this process EVER been observed below the soft-warn line since
  // boot? A process that never has booted straight into an over-budget working
  // set — a SIGKILL recycle can't shed that, it just loops. One that has, grew
  // into the limit and its excess is sheddable, so it recycles normally.
  let sawHealthySample = false;
  let bornOverBudgetLogged = false;

  const rssMb = () => bytesToMb(process.memoryUsage().rss);
  const readSwapMb = opts.readSwapMb ?? readSelfSwapMb;
  /**
   * One coherent memory sample. `swapMb` is -1 when unmeasurable, and `committedMb`
   * then falls back to `rssMb` — so a non-Linux host or an unreadable `/proc` gets
   * exactly the pre-WI-2145659 behaviour, never a committed figure that silently
   * pretends nothing is swapped.
   */
  const sample = (): { rssMb: number; swapMb: number; committedMb: number } => {
    const rss = rssMb();
    const swap = readSwapMb();
    const usable = Number.isFinite(swap) && swap >= 0 ? swap : -1;
    return { rssMb: rss, swapMb: usable, committedMb: usable >= 0 ? rss + usable : rss };
  };
  const committedMb = () => sample().committedMb;

  const timer = managedSetInterval('memory-watchdog', intervalMs, () => {
    if (recycled) return;
    const mem = sample();
    // EVERY threshold below compares COMMITTED memory, not RSS (WI-2145659). On a
    // swapping box RSS understates the process's real demand by 13-40%, which
    // silently held a worker at 93% of its limit below all three lines.
    const committed = mem.committedMb;
    if (committed < warnMb) sawHealthySample = true;
    if (committed >= warnMb) {
      log('[memory-watchdog] committed memory above soft threshold', {
        committedMb: committed,
        rssMb: mem.rssMb,
        swapMb: mem.swapMb,
        warnMb,
        limitMb,
        overCount,
        ...heapBreakdown(),
      });
    }
    // PROACTIVE GC (root freeze fix) — runs in the SAFE band (≥ proactiveGcMb, <
    // limitMb) on a cooldown. A forced full GC here keeps the live heap out of
    // the multi-GB old-gen regime where a mark-compact pause freezes the event
    // loop (the bg-host ticker freeze). Cheap relative to a stall: a sub-second GC
    // every few minutes vs a multi-minute loop freeze + watchdog restart storm.
    // Skipped once over the recycle limit (the recycle owns that case) and when
    // disabled (no `--expose-gc`, or proactiveGcMb <= 0).
    if (
      forceGc &&
      proactiveGcMb > 0 &&
      committed >= proactiveGcMb &&
      committed < limitMb &&
      Date.now() - lastGcAt >= gcCooldownMs
    ) {
      lastGcAt = Date.now();
      const before = mem.rssMb;
      const committedBefore = committed;
      try {
        forceGc();
      } catch {
        /* a forced GC must never crash the watchdog */
      }
      const post = sample();
      const after = post.rssMb;
      log('[memory-watchdog] proactive GC (heap kept out of the stall zone)', {
        // rssMbBefore/rssMbAfter/reclaimedMb keep their pre-WI-2145659 RSS meaning
        // ON PURPOSE: ~1300 of these records exist per worker per 14h and the
        // WI-38221 analysis reads them as a time series, so silently re-basing an
        // existing field would corrupt history rather than correct it. The
        // committed* trio beside them is the honest quantity, added not swapped in.
        rssMbBefore: before,
        rssMbAfter: after,
        reclaimedMb: Math.max(0, before - after),
        committedMbBefore: committedBefore,
        committedMbAfter: post.committedMb,
        reclaimedCommittedMb: Math.max(0, committedBefore - post.committedMb),
        swapMbAfter: post.swapMb,
        proactiveGcMb,
        limitMb,
        // POST-GC decomposition. Sampled AFTER the forced full GC, so these are
        // SURVIVORS — objects a full mark-compact could not collect. That makes
        // this the single most diagnostic line the process emits: growth here is
        // growth in the genuinely-live set, which is precisely the distinction
        // between a retention bug and a GC-tuning problem (WI-38221).
        ...heapBreakdown(),
      });
      // NATIVE HEAP TRIM (WI-2145733) — deliberately AFTER the forced GC, so the
      // bytes that GC just handed back to the allocator are included in the trim,
      // and deliberately AFTER the log above rather than before the `sample()` that
      // feeds it. That ordering is load-bearing: folding the trim into the existing
      // record would silently re-base `committedMbAfter`/`reclaimedCommittedMb`
      // from "after GC" to "after GC + trim", corrupting the ~1300-records-per-
      // worker-per-14h time series the WI-38221 analysis reads, exactly as the
      // comment above warns. The trim therefore reports its OWN reclaim, so GC
      // reclaim and allocator reclaim stay separately attributable — the whole
      // point being that the first was measured at 3.8% and the second at 627 MB.
      if (trimNativeHeap) {
        const committedBeforeTrim = post.committedMb;
        try {
          trimNativeHeap();
        } catch {
          /* a heap trim must never crash the watchdog (same rule as forceGc) */
        }
        const postTrim = sample();
        log('[memory-watchdog] native heap trim (allocator arena returned to the OS)', {
          committedMbBeforeTrim: committedBeforeTrim,
          committedMbAfterTrim: postTrim.committedMb,
          // The measurable this rung exists for. A near-zero value here is a REAL
          // finding, not a broken trim: it means committed memory is genuinely live
          // rather than parked in the allocator, which is the case where a recycle
          // is the correct response rather than an avoidable one.
          reclaimedCommittedMb: Math.max(0, committedBeforeTrim - postTrim.committedMb),
          rssMbAfterTrim: postTrim.rssMb,
          swapMbAfterTrim: postTrim.swapMb,
          proactiveGcMb,
          limitMb,
        });
      }
    }
    if (committed >= limitMb) {
      overCount += 1;
      if (overCount >= tripsToRecycle) {
        // BORN-OVER-BUDGET guard (EI-11522): if this process was never observed
        // below warnMb, its steady-state working set is already over the cap. A
        // SIGKILL recycle would boot a fresh process into the same footprint and
        // trip again — a hot loop that reclaims ~nothing and kills every in-flight
        // converse SSE turn each cycle. Suppress the futile recycle and escalate
        // loudly instead; the limit is misconfigured / the working set must shed.
        if (suppressBornOverBudgetRecycle && !sawHealthySample) {
          if (!bornOverBudgetLogged) {
            bornOverBudgetLogged = true;
            log(
              '[memory-watchdog] committed memory over the recycle limit since boot — SUPPRESSING the recycle to avoid a SIGKILL loop that reclaims ~nothing and severs in-flight turns. The working set is over budget from startup (a restart would boot straight back into it); raise PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB or shed the working set.',
              { committedMb: committed, rssMb: mem.rssMb, swapMb: mem.swapMb, limitMb, warnMb },
            );
          }
          return;
        }
        recycled = true;
        onTrip({ rssMb: mem.rssMb, swapMb: mem.swapMb, committedMb: committed, limitMb });
      }
    } else {
      // Reset the debounce on any sample back under the limit (a transient
      // spike shouldn't recycle a host that GC'd back down).
      overCount = 0;
    }
  }, { category: 'watchdog' });

  return {
    stop() {
      timer.stop();
    },
    rssMb,
    committedMb,
  };
}
