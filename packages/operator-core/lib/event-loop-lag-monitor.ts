/**
 * event-loop-lag-monitor.ts — cheap, always-on event-loop-lag gauge
 * (EI-79 observability). Booted by the Hono host; also the central SLO
 * instrument of the p2p-perf suite (`lib/sync/hyperbee/perf/`), which is why
 * it lives in operator-core rather than apps/operator
 * (p2p-performance-suite-2026-06-07 P-007 / D-003).
 *
 * EI-79 was a forensic slog precisely because nothing on the host reported the
 * one number that explained it: the event loop was carrying sustained CPU work
 * (a 1Hz full-history hyperbee re-merge), so every `await` hop paid the loop
 * delay and hop-heavy agent-mcp routes degraded to 12-30s while `/api/health`
 * (≈2 hops) stayed fast. A standing lag gauge makes that self-evident next time.
 *
 * Implementation: `perf_hooks.monitorEventLoopDelay()` is a native libuv
 * histogram timer — it samples loop delay in C with negligible JS overhead (far
 * cheaper than a `setInterval` drift probe, which itself competes for the loop).
 * We read + reset it on a slow cadence and log a single structured line ONLY
 * when p95 lag crosses a threshold, so a healthy host is silent.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { SENTINEL_SAB_IDX, SENTINEL_SAB_INT32_LEN } from './event-loop-sentinel';
import { LoopCpuRecorder, type CpuRecording } from './event-loop-cpu-recorder';

export interface LagMonitorOpts {
  /** How often to sample + evaluate the histogram (ms). Default 10_000. */
  intervalMs?: number;
  /** Log a warning when p95 loop lag (ms) over the window exceeds this. Default 100. */
  warnP95Ms?: number;
  /** Sink for the structured warning line. Default console.warn. (Values are
   *  numbers for the lag gauge; the profiler also passes the profile `file` path.) */
  log?: (line: string, detail: Record<string, number | string>) => void;
  /**
   * infra round-3 F1: when a window crosses `profileTriggerP95Ms` OR
   * `profileTriggerMaxMs`, capture a short V8 CPU profile (`.cpuprofile`) so the
   * SYNCHRONOUS culprit eating the loop is identifiable — the histogram says "the
   * loop is blocked", the profile says "by what". Default OFF (the p2p-perf SLO
   * instrument + tests must not be perturbed by a profiler); the production host
   * turns it on. All inspector use is best-effort: any failure degrades silently
   * to today's symptom-only logging.
   *
   * WI-5820: accepts a PREDICATE as well as a boolean. Pass a function (e.g.
   * `() => getFlag(FLAGS.LOOP_STALL_PROFILER, 'operator-host')`) and the gate is
   * read LAZILY on the existing monitor tick —
   * never latched at boot. That matters twice over: `getFlag` is fragile during
   * host-boot (it resolves false before the backend is configured, which is how
   * a boot-latched gate silently stays off forever), and a lazy read means a
   * flip in /admin/features takes effect without restarting the host. The
   * predicate may be async and reads are single-flight. A true gate maintains a
   * 100 Hz recorder so captures do not repeatedly rebuild V8's code map. A false
   * or failed gate stops it, including any capture, on the next completed tick.
   */
  profileOnSaturation?: boolean | (() => boolean | Promise<boolean>);
  /** Dir for `.cpuprofile` artifacts. Default ~/.papercusp/loop-profiles. */
  profileDir?: string;
  /** p95 loop-delay (ms) that triggers a capture. Default = the critical band (600ms). */
  profileTriggerP95Ms?: number;
  /**
   * Single-window maximum loop delay (ms) that triggers a capture even when p95
   * stays below the sustained-pressure threshold. Default 3000ms.
   *
   * WI-2146561: a single 20.4s main-thread block produced six cross-harness stage
   * stalls while p95 was only 171.3ms, so the p95-only trigger recorded the
   * symptom but never attempted attribution. The safety cap below intentionally
   * remains p95-based: once an isolated block has ended and p95 is below the cap,
   * the loop is no longer in the native-abort regime that makes inspector unsafe.
   */
  profileTriggerMaxMs?: number;
  /**
   * WI-5820 SAFETY CAP — the upper edge of the profiling band. A window whose p95
   * is at or above this is TOO SATURATED to profile safely: capture is skipped
   * (and logged), not attempted. Default 3000ms.
   *
   * WHY THIS EXISTS: captureCpuProfile() drives a node:inspector Profiler session
   * whose async post/response must complete over the SAME event loop it is
   * diagnosing. Under a deeply blocked loop the native binding aborts with
   * `Napi::Error` — a native abort, NOT a catchable JS exception, so the try/catch
   * inside captureCpuProfile() cannot save the process. That is exactly how this
   * feature crash-looped the green operator 8x on 2026-07-10 (WI-3797, SIGABRT,
   * 60-90s downtime per crash) and why it was reverted to opt-in and then never
   * re-enabled — the profiler is only dangerous in the regime where it is also
   * least likely to survive long enough to tell us anything.
   *
   * WHY 3000ms: every WI-3797 crash landed with lag p99 in the TENS OF SECONDS
   * during a host-wide CPU crisis (load avg ~1318 on a 128-core box). The band we
   * actually need attributed is the chronic one — measured over 12h on bg-host
   * (2026-07-25, post-WI-5471): 2,937 windows, p95Ms p50 274ms / p99 473ms / max
   * 1143ms, with only 6 windows crossing the 600ms trigger at all. So a 3s cap
   * excludes NOTHING observed in the band we care about while keeping the
   * crash regime structurally unreachable. Raise it only with fresh evidence.
   */
  profileMaxP95Ms?: number;
  /** How long each capture samples (ms). Default 3000. */
  profileDurationMs?: number;
  /** Minimum gap between captures (ms) — rate-limit so a long burst can't profile-storm. Default 300_000 (5 min). */
  minProfileGapMs?: number;
  /** Retain at most this many `.cpuprofile` files (oldest pruned). Default 20. */
  maxProfiles?: number;
  /**
   * bg-host-freeze-eventloop-stall-2026-06-30 P-002: heap-snapshot-on-high-RSS.
   * When true, capture a V8 heap snapshot (.heapsnapshot) whenever process RSS
   * crosses `heapSnapshotRssMb`. Default OFF and no longer enabled by
   * PAPERCUSP_HEAP_SNAPSHOT; only an explicit option or
   * PAPERCUSP_FULL_HEAP_SNAPSHOT=1 turns on the blocking full snapshot path.
   * The production bg-host should normally use heap sampling instead so a growing
   * memory leak self-captures without freezing the live event loop.
   * All inspector use is best-effort: any failure degrades silently.
   */
  heapSnapshotOnHighRss?: boolean;
  /** Dir for `.heapsnapshot` artifacts. Default ~/.papercusp/heap-snapshots. */
  heapSnapshotDir?: string;
  /**
   * RSS threshold in MB that triggers a heap capture. Read from
   * PAPERCUSP_HEAP_SNAPSHOT_RSS_MB if not passed. Default 8192 (8 GB).
   */
  heapSnapshotRssMb?: number;
  /** Minimum gap between heap captures (ms) — rate-limit. Default 600_000 (10 min). */
  minHeapSnapshotGapMs?: number;
  /** Retain at most this many `.heapsnapshot` files (oldest pruned). Default 5. */
  maxHeapSnapshots?: number;
  /**
   * autonomous-loop-prod-audit-2026-07-02 P-006 (SPOF 1h, deferred from
   * WI-4626/AUDIT B): SELF-DISARM the full heap-snapshot capture after its
   * FIRST successful trip for this process's lifetime, rather than re-capturing
   * every `minHeapSnapshotGapMs` for as long as RSS stays above the threshold.
   * A full snapshot already pauses the live loop for tens of seconds on a
   * multi-GB heap (the reason this path is opt-in at all, WI-3255) — repeating
   * that pause every 10 minutes on a SUSTAINED leak turns the diagnostic into
   * its own steady-state incident, when the FIRST retained-object graph
   * already identifies the leak (a second capture rarely adds new information
   * once the pattern is visible). Default true (the recommended posture); set
   * false — or env PAPERCUSP_HEAP_SNAPSHOT_REPEAT=1 — to keep the pre-existing
   * repeating behavior (e.g. for an active leak-hunt session watching the
   * graph evolve over time).
   */
  heapSnapshotSingleShot?: boolean;
  /**
   * WI-1088 leak hunt round 2: SAMPLING heap profiler. A FULL snapshot of a
   * multi-GB heap takes minutes to serialize and the leaking process dies first
   * (three 5-6 GB `.partial`s and zero completed captures on 2026-07-01). The
   * sampling profiler is the tool that CANNOT lose that race: it runs from boot
   * at O(1) overhead and its dump is a few-KB JSON of ALLOCATION STACKS —
   * written instantly at the same RSS trigger, with the top allocation sites
   * logged straight to the journal (self-pinpointing). Defaults to
   * heapSnapshotOnHighRss (same enable, no new knob).
   */
  heapSamplingOnHighRss?: boolean;
  /**
   * RSS threshold in MB for the non-blocking sampling-profile dump. Defaults to
   * `heapSnapshotRssMb`, preserving the existing shared trigger while allowing
   * sampling-only deployments to tune it without enabling full snapshots.
   */
  heapSamplingRssMb?: number;
  /**
   * When the loop is already saturated enough to trigger a CPU profile, also dump
   * the live heap-sampling profile even if RSS has not yet crossed the full
   * heap-snapshot threshold. This closes the "CPU-bound stall below 8 GB leaves no
   * allocation artifact" gap that remained after the main leak flattened (WI-1088).
   * Default = same cadence as CPU profiles (`minProfileGapMs`).
   */
  minHeapSamplingDumpGapMs?: number;
  /**
   * WI-4189: retain at most this many `.heapprofile` files (oldest pruned).
   * Unlike `.heapsnapshot` (pruned via `maxHeapSnapshots`), sampling-profile
   * dumps had NO retention at all — on a host that sustains critical p95 lag
   * for hours (one dump every `minHeapSamplingDumpGapMs`, default 5 min), they
   * accumulate forever. Confirmed root cause of ~854MB / 1300+ stale
   * `.heapprofile` files during the 2026-07-11 root-disk-100% incident.
   * Default 50 (≈4hrs of dumps at the default 5-min gap).
   */
  maxSamplingProfiles?: number;
}

/**
 * One live read of the current (possibly partial) histogram window.
 *
 * `monitorEventLoopDelay()` resets every monitor tick, while HTTP/perf readers
 * sample at unrelated times. The window metadata lets those readers distinguish
 * a statistically meaningful p95 from the first isolated maximum recorded
 * immediately after a reset without discarding that maximum.
 */
export interface LoopLagSample {
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Native histogram observations accumulated since the last reset. */
  sampleCount: number;
  /** Elapsed wall time since the last reset. */
  windowMs: number;
  /** True when p95 has enough observations, or the entire window elapsed. */
  windowMature: boolean;
}

export interface LagMonitorHandle {
  /** Stop sampling (clears the timer + disables the histogram). */
  stop(): void;
  /** Read the current window's stats without resetting (for an endpoint/test). */
  sample(): LoopLagSample;
}

export type LoopPressure = 'ok' | 'elevated' | 'critical';

// P5-1 (operator-scalability-event-loop-2026-06-16): the running monitor's live
// read fn, published module-globally so the Layer-2 feedback governor (background
// load-shedding + spawn admission) can read loop pressure WITHOUT its own probe.
// Null until the host boots the monitor (e.g. a request-only worker that never
// started one) — callers treat null as 'ok' (no signal ⇒ don't shed).
let _liveRead: (() => LoopLagSample) | null = null;

// Idempotency guard: at most one monitor per process. The host boots it from BOTH
// the request plane (startRequestServers) and the background machinery (runBootstrap),
// so the cluster bg-host PRIMARY — which serves no HTTP and so never ran the request-
// plane monitor — also gets a live gauge. Without it, currentLoopLag() returns null on
// the bg primary and the perf-regression rig's loop_lag_p95 never populates there (the
// "no event-loop-lag monitor on this thread" watchdog note — infra round-4 P-014). A
// repeat call returns the already-running handle instead of spawning a 2nd histogram.
let _runningHandle: LagMonitorHandle | null = null;

// EI-19484853609145439: the reader above is honest about WHY it goes silent on
// a real wedge — it is a JS timer on the very loop it watches, and nothing on
// this thread can fix that. But `event-loop-sentinel.worker.ts` runs on a
// SEPARATE thread and keeps ticking through the block, so the LAST value read
// here (before the block began) is still recoverable if it is published
// somewhere the sentinel can read WITHOUT the main thread's cooperation. A
// `SharedArrayBuffer` + `Atomics.store` is push, not the postMessage round-trip
// `event-loop-sentinel.worker.ts`'s header rules out for exactly this reason.
//
// Late-bound (a setter, not a `startEventLoopLagMonitor` option) because the
// two subsystems are started independently and in whichever order the host
// prefers — `event-loop-sentinel-host.ts`'s own doc requires it be armed AFTER
// the port is bound, which is deliberately later than the lag monitor's boot
// call. Reading `_publishLagSab` fresh on every tick (rather than capturing it
// at start time) means the two can wire up in either order, and a caller with
// no sentinel (e.g. host-bootstrap.ts's bg-host boot, which never starts one)
// simply never sets it — the tick below is then a no-op check, unchanged from
// today's behavior.
let _publishLagSab: SharedArrayBuffer | null = null;
let _publishLagView: Int32Array | null = null;

/**
 * Wire (or clear, with `null`) the SharedArrayBuffer the lag monitor should
 * publish its last-read percentiles into, laid out per `SENTINEL_SAB_IDX`.
 * Typically called with `startEventLoopSentinel()`'s returned `.sab` once both
 * subsystems are up. Safe to call before, after, or never — the monitor's own
 * tick reads this lazily and degrades to "publish nothing" otherwise.
 */
export function setLagPublishTarget(sab: SharedArrayBuffer | null): void {
  if (sab && sab.byteLength < SENTINEL_SAB_INT32_LEN * Int32Array.BYTES_PER_ELEMENT) {
    // Defensive: a mismatched/foreign SAB must never throw inside the tick.
    // Degrade to "not publishing" rather than risk an out-of-bounds Atomics call.
    _publishLagSab = null;
    _publishLagView = null;
    return;
  }
  _publishLagSab = sab;
  _publishLagView = sab ? new Int32Array(sab) : null;
}

/** p95 loop-delay (ms) thresholds for the pressure bands. Env-tunable so a small
 *  host can be stricter. elevated ⇒ start widening cadences; critical ⇒ shed. */
const ELEVATED_P95_MS = Math.max(1, Number(process.env.PAPERCUSP_LOOP_ELEVATED_MS) || 120);
// Exported so readers of a PERSISTED loop-lag sample (test_runs.loop_lag_p95_ms,
// whose column comment defines a saturation-suspect row in terms of this exact
// band) classify against the same tunable value the monitor sheds on, rather
// than re-hardcoding 600 and drifting the moment the env var is set.
export const CRITICAL_P95_MS = Math.max(
  ELEVATED_P95_MS + 1,
  Number(process.env.PAPERCUSP_LOOP_CRITICAL_MS) || 600,
);

/**
 * A single delay this large is operationally catastrophic even when the rest of
 * the 10s window keeps p95 low. It shares the existing profiler's five-minute
 * rate limit, so adding this trigger cannot create a profile storm.
 */
export const DEFAULT_PROFILE_TRIGGER_MAX_MS = 3_000;

/** Pure trigger shared by the CPU and heap-sampling attribution paths. */
export function shouldTriggerLoopProfile(
  sample: Pick<LoopLagSample, 'p95Ms' | 'maxMs'>,
  profileTriggerP95Ms: number = CRITICAL_P95_MS,
  profileTriggerMaxMs: number = DEFAULT_PROFILE_TRIGGER_MAX_MS,
): boolean {
  return (
    (Number.isFinite(sample.p95Ms) && sample.p95Ms >= profileTriggerP95Ms) ||
    (Number.isFinite(sample.maxMs) && sample.maxMs >= profileTriggerMaxMs)
  );
}

/**
 * PURE gate: should THIS tick trigger a full heap-snapshot capture? Extracted from the
 * monitor's tick closure (autonomous-loop-prod-audit-2026-07-02 P-006, SPOF 1h) so the
 * self-disarm invariant — at most once per process lifetime when `heapSnapshotSingleShot`
 * is on — is unit-testable without forking a real V8 snapshot (that capture pauses the
 * live loop for tens of seconds on a multi-GB heap, so exercising it repeatedly in a test
 * is both slow and exactly the cost this gate exists to avoid).
 */
export function shouldTriggerFullHeapSnapshot(
  state: { snapshotting: boolean; fullSnapshotTaken: boolean; lastSnapshotAt: number },
  now: number,
  opts: { heapSnapshotOnHighRss: boolean; heapSnapshotSingleShot: boolean; minHeapSnapshotGapMs: number },
): boolean {
  if (!opts.heapSnapshotOnHighRss) return false;
  if (state.snapshotting) return false; // single-flight
  if (opts.heapSnapshotSingleShot && state.fullSnapshotTaken) return false; // self-disarmed
  return now - state.lastSnapshotAt >= opts.minHeapSnapshotGapMs; // rate-limit
}

/**
 * PURE gate: should THIS tick dump the already-running heap-sampling profile due
 * to high RSS? This gate is deliberately independent of the full-snapshot gate:
 * production normally keeps blocking V8 snapshots off while leaving sampling on,
 * and that safe posture must still produce an allocation-site artifact.
 */
export function shouldTriggerHeapSamplingDump(
  state: { samplingArmed: boolean; samplingDumping: boolean; lastSamplingDumpAt: number },
  now: number,
  rssMb: number,
  opts: { heapSamplingOnHighRss: boolean; heapSamplingRssMb: number; minHeapSamplingDumpGapMs: number },
): boolean {
  if (!opts.heapSamplingOnHighRss) return false;
  if (!state.samplingArmed || state.samplingDumping) return false;
  if (!Number.isFinite(rssMb) || rssMb < opts.heapSamplingRssMb) return false;
  return now - state.lastSamplingDumpAt >= opts.minHeapSamplingDumpGapMs;
}

/**
 * Minimum observations required for a p95 to stop being defined by one
 * isolated maximum. At 20 samples one observation is 5% of the population;
 * below that, p95 can collapse to max and must not be promoted to a critical
 * sustained-pressure verdict.
 */
export const LOOP_LAG_P95_MIN_SAMPLES = 20;

/** Pure maturity rule, exported so the boundary is pinned without real timers. */
export function isLoopLagWindowMature(args: {
  sampleCount: number;
  windowMs: number;
  intervalMs: number;
}): boolean {
  const { sampleCount, windowMs, intervalMs } = args;
  if (!Number.isFinite(sampleCount) || !Number.isFinite(windowMs) || !Number.isFinite(intervalMs)) return false;
  if (sampleCount >= LOOP_LAG_P95_MIN_SAMPLES) return true;
  // A fully elapsed window remains authoritative even when a severe block
  // prevented the native monitor from collecting 20 observations.
  return intervalMs > 0 && windowMs >= intervalMs;
}

/** The live loop-delay sample (current partial window), or null if no monitor. */
export function currentLoopLag(): LoopLagSample | null {
  return _liveRead ? _liveRead() : null;
}

/** Pure band classification from a p95 loop-delay (ms). Exported for tests. */
export function classifyLoopPressure(
  p95Ms: number,
  elevatedMs: number = ELEVATED_P95_MS,
  criticalMs: number = CRITICAL_P95_MS,
): LoopPressure {
  if (!Number.isFinite(p95Ms)) return 'ok';
  if (p95Ms >= criticalMs) return 'critical';
  if (p95Ms >= elevatedMs) return 'elevated';
  return 'ok';
}

/** Current loop pressure band from a mature live p95. A partial window with
 * fewer than 20 observations can make one isolated delay its p95; treating that
 * as sustained critical pressure sheds unrelated MCP requests. */
export function loopPressure(): LoopPressure {
  const s = _liveRead?.();
  if (!s?.windowMature) return 'ok';
  return classifyLoopPressure(s.p95Ms);
}

/** True when the request loop is critically saturated — the most severe band;
 *  kept for callers that specifically distinguish critical from elevated. */
export function isLoopSaturated(): boolean {
  return loopPressure() === 'critical';
}

/** True when the loop is at least ELEVATED (elevated OR critical) — heavy background
 *  ticks should start shedding at this band, before reaching fully critical saturation.
 *  Returns false when no monitor is running (absence of signal must never cause shedding). */
export function isLoopElevated(): boolean {
  return loopPressure() !== 'ok';
}

/** Yield the macrotask queue once so any pending timer/IO callback — most
 *  importantly the routine TICKER — runs before this loop continues. A `setImmediate`
 *  fires after the current poll phase, so the ticker is never starved by a long
 *  synchronous CPU-loop on the main thread. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Cooperative-yield gate for a hot boot/drain LOOP that would otherwise hog the
 * main thread (the EI / event-loop-lag class: "host is CPU-bound on the main
 * thread", routine ticker starved → watchdog restart loop). Call it once per
 * iteration; it yields (lets the ticker + IO run) when EITHER the loop has done
 * `everyN` iterations since the last yield OR loop pressure is already elevated —
 * so a quiet boot pays at most one macrotask hop per `everyN` items, but a
 * saturated one yields aggressively. Returns the running count so callers can keep
 * a single `let n = 0` cursor.
 *
 *   let n = 0;
 *   for (const item of heavy) { await work(item); n = await cooperativeYield(n); }
 */
export async function cooperativeYield(count: number, everyN = 4): Promise<number> {
  const next = count + 1;
  if (next % Math.max(1, everyN) === 0 || loopPressure() !== 'ok') {
    await yieldToEventLoop();
  }
  return next;
}

/**
 * Start the event-loop-lag monitor. Returns a handle; the underlying timer is
 * `unref`'d so it never keeps the process alive on its own. Idempotent enough
 * for one-per-process use — call once at host boot.
 */
export function startEventLoopLagMonitor(opts: LagMonitorOpts = {}): LagMonitorHandle {
  // One monitor per process (see _runningHandle). A 2nd call — single-process mode
  // boots both the request plane AND the bg machinery — returns the live handle so we
  // never run two histograms/timers (or two profilers) against one event loop.
  if (_runningHandle) return _runningHandle;
  const intervalMs = opts.intervalMs ?? 10_000;
  const warnP95Ms = opts.warnP95Ms ?? 100;
  const log =
    opts.log ??
    ((line, detail) => {
      console.warn(line, detail);
    });

  // resolution: histogram bucket granularity (ms). 20ms is plenty for a
  // "the loop is blocked" gauge and keeps the timer overhead trivial.
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  const ns2ms = (ns: number) => Math.round((ns / 1e6) * 10) / 10;
  let windowStartedAt = Date.now();
  const read = (): LoopLagSample => {
    const sampleCount = h.count;
    const windowMs = Math.max(0, Date.now() - windowStartedAt);
    return {
      p50Ms: ns2ms(h.percentile(50)),
      p95Ms: ns2ms(h.percentile(95)),
      p99Ms: ns2ms(h.percentile(99)),
      maxMs: ns2ms(h.max),
      sampleCount,
      windowMs,
      windowMature: isLoopLagWindowMature({ sampleCount, windowMs, intervalMs }),
    };
  };
  // P5-1: publish the live read so loopPressure()/isLoopSaturated() work fleet-wide.
  _liveRead = read;

  // infra round-3 F1: lag-triggered CPU-profile capture state.
  // WI-5820: normalize boolean | predicate into ONE lazily-read gate. A bare
  // boolean (or the env override, which stays for tests/dev — never as the
  // production feature gate) is wrapped so the trigger site has a single shape.
  const envProfileGate =
    process.env.PAPERCUSP_LOOP_PROFILER === '1' || process.env.PAPERCUSP_LOOP_PROFILER === 'true';
  const profileGate: () => boolean | Promise<boolean> =
    typeof opts.profileOnSaturation === 'function'
      ? opts.profileOnSaturation
      : (() => {
          const fixed = opts.profileOnSaturation ?? envProfileGate;
          return () => fixed;
        })();
  const profileTriggerP95Ms = opts.profileTriggerP95Ms ?? CRITICAL_P95_MS;
  const profileTriggerMaxMs = opts.profileTriggerMaxMs ?? DEFAULT_PROFILE_TRIGGER_MAX_MS;
  // WI-5820: upper edge of the safe profiling band (see profileMaxP95Ms doc).
  const profileMaxP95Ms = opts.profileMaxP95Ms ?? DEFAULT_PROFILE_TRIGGER_MAX_MS;
  const profileDurationMs = opts.profileDurationMs ?? 3000;
  const minProfileGapMs = opts.minProfileGapMs ?? 300_000;
  const maxProfiles = opts.maxProfiles ?? 20;
  const profileDir = opts.profileDir;
  let profiling = false;
  let lastProfileAt = 0;
  let stopped = false;
  const profileLifetime = new AbortController();
  const cpuRecorder = new LoopCpuRecorder(Math.max(1000, intervalMs * 3), log);
  let profileGatePending = false;

  // P-002: heap-snapshot-on-high-RSS state. WI-3255: full V8 heap snapshots
  // pause the live loop while V8 serializes the heap, and on multi-GB bg-hosts
  // that pause is itself a production incident. Keep full snapshots explicit-only;
  // the sampling heap profiler below remains the default diagnostic artifact.
  const heapSnapshotOnHighRss =
    opts.heapSnapshotOnHighRss ??
    (process.env.PAPERCUSP_FULL_HEAP_SNAPSHOT === '1' || process.env.PAPERCUSP_FULL_HEAP_SNAPSHOT === 'true');
  const heapSnapshotRssMb =
    opts.heapSnapshotRssMb ??
    Math.max(1, Number(process.env.PAPERCUSP_HEAP_SNAPSHOT_RSS_MB) || 8192);
  const minHeapSnapshotGapMs = opts.minHeapSnapshotGapMs ?? 600_000;
  const maxHeapSnapshots = opts.maxHeapSnapshots ?? 5;
  const heapSnapshotDir = opts.heapSnapshotDir;
  // SPOF 1h: self-disarm after the first trip by default (see the option's doc).
  const heapSnapshotSingleShot =
    opts.heapSnapshotSingleShot ??
    !(process.env.PAPERCUSP_HEAP_SNAPSHOT_REPEAT === '1' || process.env.PAPERCUSP_HEAP_SNAPSHOT_REPEAT === 'true');
  let snapshotting = false;
  let lastSnapshotAt = 0;
  let fullSnapshotTaken = false;
  // WI-1088 round 2: sampling heap profiler — armed lazily on the first tick so
  // startup cost is off the boot path; dumped at the same RSS trigger.
  const heapSamplingOnHighRss =
    opts.heapSamplingOnHighRss ??
    (heapSnapshotOnHighRss ||
      process.env.PAPERCUSP_HEAP_SNAPSHOT === '1' ||
      process.env.PAPERCUSP_HEAP_SNAPSHOT === 'true');
  const heapSamplingRssMb = opts.heapSamplingRssMb ?? heapSnapshotRssMb;
  const minHeapSamplingDumpGapMs = opts.minHeapSamplingDumpGapMs ?? minProfileGapMs;
  const maxSamplingProfiles = opts.maxSamplingProfiles ?? 50;
  let samplingArmed = false;
  let samplingArming = false;
  let samplingDumping = false;
  let lastSamplingDumpAt = 0;

  const timer = managedSetInterval('event-loop-lag-monitor', intervalMs, () => {
    const s = read();
    // EI-19484853609145439: push the LAST-READ percentiles to the sentinel's
    // shared memory (if wired) BEFORE anything else this tick — so even a
    // block starting mid-tick (after `read()`, before the warn log below)
    // still leaves the sentinel with the freshest possible last-known values.
    if (_publishLagView) {
      Atomics.store(_publishLagView, SENTINEL_SAB_IDX.LAG_P50_MS, Math.round(s.p50Ms));
      Atomics.store(_publishLagView, SENTINEL_SAB_IDX.LAG_P95_MS, Math.round(s.p95Ms));
      Atomics.store(_publishLagView, SENTINEL_SAB_IDX.LAG_P99_MS, Math.round(s.p99Ms));
      Atomics.store(_publishLagView, SENTINEL_SAB_IDX.LAG_MAX_MS, Math.round(s.maxMs));
    }
    if (s.p95Ms >= warnP95Ms) {
      log('[event-loop-lag] high loop delay — host is CPU-bound on the main thread', {
        p50Ms: s.p50Ms,
        p95Ms: s.p95Ms,
        p99Ms: s.p99Ms,
        maxMs: s.maxMs,
        windowMs: intervalMs,
      });
    }
    const profileTriggered = shouldTriggerLoopProfile(s, profileTriggerP95Ms, profileTriggerMaxMs);
    // Maintain the recorder independently of artifact cadence: otherwise flag
    // OFF would leave a sampler running throughout the five-minute capture gap.
    // Revoke immediately on an unsafe tick, even if a flag read is still pending.
    if (s.p95Ms >= profileMaxP95Ms || profileGatePending) void cpuRecorder.update(false, false);
    if (!profileGatePending) {
      profileGatePending = true;
      const gateStartedAt = Date.now();
      void (async () => {
        let on = false;
        try {
          on = await profileGate();
        } catch {
          on = false; // a flag-read failure must never break lag monitoring
        }
        if (stopped || Date.now() - gateStartedAt >= intervalMs) return;
        // A slow predicate may span several windows. Recheck the current window
        // as well as the one that initiated the read before entering inspector.
        const safe = s.p95Ms < profileMaxP95Ms && read().p95Ms < profileMaxP95Ms;
        const ready = await cpuRecorder.update(on, safe);
        if (!on || stopped || profiling || !profileTriggered || Date.now() - lastProfileAt < minProfileGapMs) return;
        lastProfileAt = Date.now();
        // WI-5820 SAFETY CAP — checked here, INSIDE the gate, so a host with the
        // profiler disabled never emits a confusing "skipped" line about work it
        // was never going to do. A window this saturated is the regime where the
        // inspector session natively aborts (WI-3797, 8x crash-loop of :3070), so
        // decline — and SAY so, so the missing attribution is visible rather than
        // silent. This remains a P95 cap on purpose: a historical max spike may be
        // arbitrarily large, but once the timer runs again with a sub-cap p95 the
        // isolated block has ended and inspector is no longer entering an already-
        // wedged loop. Shares the capture rate-limit, so an extreme burst cannot
        // profile-storm or log-storm.
        if (!safe) {
          log('[event-loop-lag] CPU profile SKIPPED — loop too saturated to profile safely', {
            p95Ms: s.p95Ms,
            profileMaxP95Ms,
            reason: 'above-safety-cap',
          });
          return;
        }
        if (!ready) return;
        profiling = true;
        // Artifact sampling has its own single-flight slot. Do not hold the
        // gate slot: future ticks must rotate/revoke during an active capture.
        void captureCpuProfile({
          durationMs: profileDurationMs,
          dir: profileDir,
          maxProfiles,
          trigger: s,
          log,
          signal: profileLifetime.signal,
          record: (durationMs, signal) => cpuRecorder.record(durationMs, signal),
        }).catch(() => {}).finally(() => { profiling = false; });
      })().finally(() => {
        profileGatePending = false;
      });
    }
    // WI-1088 round 2: arm the sampling heap profiler on the first tick (O(1)
    // overhead from here on; allocation stacks accumulate from ~boot).
    if (heapSamplingOnHighRss && !samplingArmed && !samplingArming) {
      samplingArming = true;
      void ensureHeapSampling((line, detail) => log(line, detail ?? {}))
        .then((armed) => {
          if (!stopped) samplingArmed = armed;
        })
        .finally(() => {
          if (!stopped) samplingArming = false;
        });
    }
    // WI-1088 follow-up: a host can be deeply CPU-bound while RSS stays below the
    // full heap-snapshot threshold, which leaves only a CPU profile and no live
    // allocation-site artifact. Dump the sampling profile on sustained saturation
    // too, rate-limited independently from full snapshots.
    if (
      heapSamplingOnHighRss &&
      samplingArmed &&
      !samplingDumping &&
      profileTriggered &&
      Date.now() - lastSamplingDumpAt >= minHeapSamplingDumpGapMs
    ) {
      samplingDumping = true;
      lastSamplingDumpAt = Date.now();
      const rssMb = process.memoryUsage().rss / 1_048_576;
      void dumpHeapSamplingProfile({
        dir: heapSnapshotDir,
        rssMb,
        maxProfiles: maxSamplingProfiles,
        log: (line, detail) => log(line, detail ?? {}),
      })
        .catch(() => {})
        .finally(() => {
          if (!stopped) samplingDumping = false;
        });
    }
    // Sampling-only deployments are the production default: full snapshots are
    // intentionally disabled because they pause a multi-GB process, while the
    // O(1) sampler stays armed. Evaluate RSS independently so this safe posture
    // still emits the allocation-site evidence needed to diagnose a live leak.
    const rssMb = process.memoryUsage().rss / 1_048_576;
    const samplingNow = Date.now();
    if (
      shouldTriggerHeapSamplingDump(
        { samplingArmed, samplingDumping, lastSamplingDumpAt },
        samplingNow,
        rssMb,
        { heapSamplingOnHighRss, heapSamplingRssMb, minHeapSamplingDumpGapMs },
      )
    ) {
      samplingDumping = true;
      lastSamplingDumpAt = samplingNow;
      void dumpHeapSamplingProfile({
        dir: heapSnapshotDir,
        rssMb,
        maxProfiles: maxSamplingProfiles,
        log: (line, detail) => log(line, detail ?? {}),
      })
        .catch(() => {})
        .finally(() => {
          if (!stopped) samplingDumping = false;
        });
    }
    // P-002: when RSS is high, capture a heap snapshot so the leak is identifiable.
    // Checked on each tick (cheap: one memoryUsage() call). Single-flight + rate-limited,
    // and (SPOF 1h, default) single-SHOT — at most once per process lifetime, so a
    // sustained leak doesn't turn the diagnostic pause into its own steady-state cost.
    if (
      shouldTriggerFullHeapSnapshot(
        { snapshotting, fullSnapshotTaken, lastSnapshotAt },
        Date.now(),
        { heapSnapshotOnHighRss, heapSnapshotSingleShot, minHeapSnapshotGapMs },
      )
    ) {
      if (rssMb >= heapSnapshotRssMb) {
        snapshotting = true;
        fullSnapshotTaken = true;
        lastSnapshotAt = Date.now();
        // Dump the sampling profile FIRST — it is instant (KBs) and survives even
        // if the full snapshot below dies mid-serialization (the 2026-07-01 mode).
        if (heapSamplingOnHighRss && !samplingDumping) {
          samplingDumping = true;
          dumpHeapSamplingProfile({ dir: heapSnapshotDir, rssMb, maxProfiles: maxSamplingProfiles, log: (line, detail) => log(line, detail ?? {}) })
            .catch(() => {})
            .finally(() => {
              if (!stopped) samplingDumping = false;
            });
        }
        captureHeapSnapshot({
          dir: heapSnapshotDir,
          maxSnapshots: maxHeapSnapshots,
          rssMb,
          log,
        })
          .catch(() => {})
          .finally(() => {
            if (!stopped) snapshotting = false;
          });
      }
    }
    // Reset so each window is independent (a one-off spike doesn't pin the
    // gauge high forever).
    h.reset();
    windowStartedAt = Date.now();
  }, {
    category: 'watchdog',
    // WI-40842: this monitor is a deliberately-exercised real interval under Vitest —
    // event-loop-lag-monitor.test.ts induces REAL libuv delay and reads the native
    // histogram, so there is nothing to fake and no injected seam to substitute. Without
    // the opt-in the scheduled registry keeps the default backend inert (the guard for
    // EI-21209553211440005) and the tick never runs, which is silent: it returns a no-op
    // handle rather than failing, so 9 tick-dependent assertions in that file go red with
    // no indication of the cause.
    //
    // Scoped by construction: the guard stays fully armed for every OTHER call site, and
    // this monitor is only ever armed by an explicit startEventLoopLagMonitor() call —
    // never as an import side effect — so no test gets a live timer it did not ask for.
    // Inert in production either way: the guard is only evaluated under process.env.VITEST.
    allowInTest: true,
  });

  const handle: LagMonitorHandle = {
    stop() {
      stopped = true;
      profileLifetime.abort();
      cpuRecorder.stop();
      timer.stop();
      h.disable();
      if (_liveRead === read) _liveRead = null;
      if (_runningHandle === handle) _runningHandle = null;
    },
    sample: read,
  };
  _runningHandle = handle;
  return handle;
}

/**
 * infra round-3 F1 — capture a short V8 CPU profile and persist it as a
 * `.cpuprofile` (loadable in Chrome DevTools / speedscope). The V8 sampling
 * profiler interrupts even synchronous JS, so unlike a JS timer it captures the
 * frames blocking the loop. Entirely best-effort: any failure (no inspector,
 * an attached debugger, fs error) resolves quietly — the gauge must never break
 * the host it is observing.
 */
export async function captureCpuProfile(args: {
  durationMs: number;
  dir?: string;
  maxProfiles: number;
  trigger: { p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number };
  log: (line: string, detail: Record<string, number | string>) => void;
  /** Owner shutdown cancels setup, sampling and artifact publication. */
  signal?: AbortSignal;
  /** Monitor-owned warm recorder; standalone diagnostics retain a short session. */
  record?: (durationMs: number, signal?: AbortSignal) => Promise<CpuRecording>;
}): Promise<string | null> {
  const { durationMs, maxProfiles, trigger, log, signal } = args;
  try {
    signal?.throwIfAborted();
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const inspector = await import('node:inspector/promises');

    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'loop-profiles');
    await fs.mkdir(dir, { recursive: true });

    const pruneCpuProfiles = async (retain: number): Promise<void> => {
      try {
        const entries = (await fs.readdir(dir))
          .filter((f) => f.endsWith('.cpuprofile'))
          .sort();
        const excess = entries.length - Math.max(0, Math.floor(retain));
        for (let i = 0; i < excess; i++) {
          await fs.rm(path.join(dir, entries[i]), { force: true }).catch(() => {});
        }
      } catch {
        /* prune is best-effort */
      }
    };

    const session = args.record ? null : new inspector.Session();
    signal?.throwIfAborted();
    session?.connect();
    try {
      let profile: unknown;
      let observer: Omit<CpuRecording, 'profile'> | undefined;
      if (args.record) {
        const recording = await args.record(durationMs, signal);
        ({ profile, ...observer } = recording);
      } else {
        await session!.post('Profiler.enable');
        signal?.throwIfAborted();
        await session!.post('Profiler.start');
        await delay(durationMs, undefined, { signal });
        ({ profile } = await session!.post('Profiler.stop') as { profile: unknown });
      }
      signal?.throwIfAborted();
      // Reserve one slot before the write. A post-write-only prune briefly made
      // maxProfiles + 1 artifacts observable and allowed another capture/test to
      // race through that overflow window.
      await pruneCpuProfiles(maxProfiles - 1);
      signal?.throwIfAborted();
      // Timestamp without Date.now-in-name collisions: epoch ms + pid.
      const stamp = `${Date.now()}-pid${process.pid}-p95_${Math.round(trigger.p95Ms)}ms`;
      const file = path.join(dir, `loop-saturation-${stamp}.cpuprofile`);
      try {
        await fs.writeFile(file, JSON.stringify(profile), { signal });
        signal?.throwIfAborted();
      } catch (error) {
        // writeFile cancellation can leave partial bytes. Never publish them as
        // a loadable CPU profile, including abort just after the write resolves.
        await fs.rm(file, { force: true }).catch(() => {});
        throw error;
      }
      log('[event-loop-lag] captured CPU profile of the saturated loop — load in DevTools/speedscope', {
        p95Ms: trigger.p95Ms,
        maxMs: trigger.maxMs,
        durationMs,
        file,
        ...observer,
      });

      // Keep the post-write pass as a defensive bound for concurrent/external
      // writers that may have added artifacts after the reserved-slot prune.
      await pruneCpuProfiles(maxProfiles);
      return file;
    } finally {
      try {
        session?.disconnect();
      } catch {
        /* ignore */
      }
    }
  } catch {
    // No inspector available, a debugger already attached, or an fs error —
    // degrade silently to symptom-only logging.
    return null;
  }
}

/**
 * bg-host-freeze-eventloop-stall-2026-06-30 P-002 — capture a V8 heap snapshot
 * and persist it as a `.heapsnapshot` (loadable in Chrome DevTools Memory tab or
 * via `node scripts/analyze-heap-snapshots.mjs`). The snapshot records every live
 * JS object with its class, self_size, and retainer chain — the authoritative tool
 * for tracing a memory leak when RSS is growing uncontrollably.
 *
 * Entirely best-effort: any failure (no inspector, an attached debugger, OOM
 * during the snapshot itself, fs error) resolves to null quietly — the gauge must
 * never break the host it is observing.
 *
 * ⚠ Taking a heap snapshot pauses V8 for the duration of the capture. On a large
 * heap (several GB) this pause can be tens of seconds. This is acceptable only
 * when the host is already in a degraded state (RSS well above the threshold) and
 * the tradeoff of a transient pause versus a self-diagnosing artifact is worth it.
 */
export async function captureHeapSnapshot(args: {
  dir?: string;
  maxSnapshots: number;
  rssMb: number;
  log: (line: string, detail: Record<string, number | string>) => void;
}): Promise<string | null> {
  const { maxSnapshots, rssMb, log } = args;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    // Use the callback-based inspector so we can set up the chunk listener BEFORE
    // posting the takeHeapSnapshot command — the promise-based Session inherits
    // EventEmitter, but the chunk events arrive synchronously within the post() call
    // and must be wired before the command is sent.
    const inspector = await import('node:inspector');

    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'heap-snapshots');
    await fs.mkdir(dir, { recursive: true });

    const session = new inspector.Session();
    session.connect();
    // Stream snapshot chunks STRAIGHT TO DISK — V8 emits them as
    // HeapProfiler.addHeapSnapshotChunk events as it serializes the heap. The
    // original implementation buffered every chunk in a string[] and joined at
    // the end: on the multi-GB heap this tool exists to diagnose, that buffer
    // ~doubles RSS mid-capture and OOM-kills the process BEFORE the write — the
    // capture itself accelerated the 2026-07-01 bg-host cgroup OOM and left the
    // snapshot dir empty (WI-1088). Writing each chunk as it arrives keeps the
    // capture's JS-side memory O(chunk), so it survives on the heaps that matter.
    // The `.partial` name keeps a half-written file invisible to the analyzer
    // (and to the pruner) until the rename marks it complete.
    const stamp = `${Date.now()}-pid${process.pid}-rss_${Math.round(rssMb)}mb`;
    const file = path.join(dir, `heap-${stamp}.heapsnapshot`);
    const partial = `${file}.partial`;
    const fsSync = await import('node:fs');
    const out = fsSync.createWriteStream(partial);
    const outFailed = new Promise<never>((_, reject) => out.once('error', reject));
    session.on(
      'HeapProfiler.addHeapSnapshotChunk',
      (message: { params: { chunk: string } }) => {
        out.write(message.params.chunk);
      },
    );
    try {
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          session.post('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
        outFailed,
      ]);
      await Promise.race([
        new Promise<void>((resolve) => out.end(resolve)),
        outFailed,
      ]);
      await fs.rename(partial, file);
      log(
        '[heap-snapshot] captured heap snapshot on high RSS — load in Chrome DevTools Memory tab or run analyze-heap-snapshots.mjs',
        { rssMb: Math.round(rssMb), file },
      );

      // Prune to maxSnapshots oldest-first to bound disk use.
      try {
        const entries = (await fs.readdir(dir))
          .filter((f) => f.endsWith('.heapsnapshot'))
          .sort();
        const excess = entries.length - maxSnapshots;
        for (let i = 0; i < excess; i++) {
          await fs.rm(path.join(dir, entries[i]), { force: true }).catch(() => {});
        }
      } catch {
        /* prune is best-effort */
      }
      return file;
    } finally {
      try {
        session.disconnect();
      } catch {
        /* ignore */
      }
      // On any failure path the .partial is left behind — destroy the stream and
      // sweep it so a dead capture can't masquerade as progress (best-effort; a
      // hard crash mid-capture still leaves the .partial as visible evidence,
      // which the analyzer + pruner both ignore by extension).
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      await fs.rm(partial, { force: true }).catch(() => {});
    }
  } catch {
    // No inspector, an attached debugger, OOM during snapshot, or fs error —
    // degrade silently; the host must never crash because of a capture attempt.
    return null;
  }
}

// ── WI-1088 round 2: the SAMPLING heap profiler (the capture that can't lose the race) ──

/** The one long-lived sampling session (armed once per process; never re-armed). */
let _samplingSession: import('node:inspector').Session | null = null;

/**
 * Start the V8 sampling heap profiler once for this process. O(1) overhead
 * (default 256 KiB sampling interval); allocation stacks accumulate from here.
 * Best-effort: any failure logs once and degrades silently — the gauge must
 * never break the host it observes.
 */
export async function ensureHeapSampling(
  log: (line: string, detail?: Record<string, number | string>) => void = () => {},
): Promise<boolean> {
  if (_samplingSession) return true;
  try {
    const inspector = await import('node:inspector');
    const session = new inspector.Session();
    session.connect();
    await new Promise<void>((resolve, reject) => {
      session.post('HeapProfiler.startSampling', { samplingInterval: 262_144 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    _samplingSession = session;
    log('[heap-sampling] sampling heap profiler armed (256KiB interval) — allocation stacks accumulate from now');
    return true;
  } catch (e) {
    log(`[heap-sampling] failed to arm (degrading silently): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** One node of the V8 sampling-profile tree. */
interface SamplingNode {
  callFrame: { functionName?: string; url?: string; lineNumber?: number };
  selfSize: number;
  children?: SamplingNode[];
}

/** Flatten the sampling tree to the top-N allocation SITES by live self size.
 *  Exported for tests. */
export function topAllocationSites(
  head: SamplingNode,
  topN = 8,
): Array<{ site: string; mb: number }> {
  const bySite = new Map<string, number>();
  const walk = (n: SamplingNode) => {
    if (n.selfSize > 0) {
      const f = n.callFrame ?? {};
      const site = `${f.functionName || '(anonymous)'} @ ${(f.url || '(unknown)').replace(/^file:\/\//, '')}:${(f.lineNumber ?? -1) + 1}`;
      bySite.set(site, (bySite.get(site) ?? 0) + n.selfSize);
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(head);
  return [...bySite.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([site, bytes]) => ({ site, mb: Math.round((bytes / 1_048_576) * 10) / 10 }));
}

/**
 * Dump the accumulated sampling profile: a few-KB `.heapprofile` JSON (Chrome
 * DevTools-loadable) written INSTANTLY at the RSS trigger, plus the top
 * allocation sites logged to the journal — the leak names itself with no
 * external analysis, even if the process dies seconds later. Sampling keeps
 * running so later dumps show growth.
 */
export async function dumpHeapSamplingProfile(args: {
  dir?: string;
  rssMb: number;
  /** Retain at most this many `.heapprofile` files (oldest pruned). Default 50.
   *  WI-4189: unbounded before this — 1300+ files / 854MB accumulated on a host
   *  that sustained critical p95 lag for hours (one dump per rate-limit gap). */
  maxProfiles?: number;
  log: (line: string, detail?: Record<string, number | string>) => void;
}): Promise<string | null> {
  const { rssMb, log, maxProfiles = 50 } = args;
  if (!_samplingSession) return null;
  try {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dir = args.dir ?? path.join(os.homedir(), '.papercusp', 'heap-snapshots');
    await fs.mkdir(dir, { recursive: true });
    const profile = await new Promise<{ head: SamplingNode }>((resolve, reject) => {
      _samplingSession!.post('HeapProfiler.getSamplingProfile', (err, r) =>
        err ? reject(err) : resolve((r as { profile: { head: SamplingNode } }).profile),
      );
    });
    const file = path.join(dir, `heap-sampling-${Date.now()}-pid${process.pid}-rss_${Math.round(rssMb)}mb.heapprofile`);
    await fs.writeFile(file, JSON.stringify(profile));
    const top = topAllocationSites(profile.head);
    log('[heap-sampling] profile dumped on high RSS — top live allocation sites:', { rssMb: Math.round(rssMb), file });
    for (const t of top) log(`[heap-sampling]   ${t.mb} MB  ${t.site}`);

    // Prune to maxProfiles oldest-first to bound disk use (WI-4189 — this was
    // the missing counterpart to captureHeapSnapshot's own pruning below;
    // .heapprofile files had no retention at all before this).
    try {
      const entries = (await fs.readdir(dir))
        .filter((f) => f.endsWith('.heapprofile'))
        .sort();
      const excess = entries.length - maxProfiles;
      for (let i = 0; i < excess; i++) {
        await fs.rm(path.join(dir, entries[i]), { force: true }).catch(() => {});
      }
    } catch {
      /* prune is best-effort */
    }
    return file;
  } catch (e) {
    log(`[heap-sampling] dump failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
