/**
 * event-loop-stall-profile.ts — the PURE half of the sentinel's in-stall CPU
 * profile (WI-10004766, WI-10003454).
 *
 * The event-loop sentinel already says WHAT KIND of stall it saw: `spinning`
 * (the main thread burns CPU), `parked` (low CPU, with `wchan`, the blocked
 * directory and live children providing wait evidence). For a spinning
 * stall it could not say WHICH CODE was spinning. Every R-state stall on :3170
 * and the bg-host therefore ended as "cause unknown": the lag monitor's own
 * profiler runs on the main thread and cannot start during the stall it would
 * need to see.
 *
 * The sentinel worker can. Measured 2026-10-01 (node 25.9): an inspector
 * Session opened in a worker with `connectToMainThread()` gets `Profiler.start`
 * serviced 95-183 ms after asking, WHILE the main thread is blocked, because V8
 * dispatches inspector messages through interrupts. Measured for a named JS spin
 * in a timer callback, an 18 s catastrophic regex, and a JSON.stringify loop;
 * the hot frame was named in all three.
 *
 * This file holds the decisions the worker makes, so they are tested without a
 * worker: WHEN to capture, and how to turn a `.cpuprofile` into a few readable
 * hot stacks for the journal line (the file itself can be pruned later; the
 * journal line survives).
 *
 * Plain, erasable TypeScript with no imports: the worker loads this through
 * Node's native type stripping (see `worker-entry-plain-node-loadable.test.ts`).
 */

/** The CPU verdict the worker already computes (`proc-thread-cpu.ts`). */
export type StallCpuKind = 'spinning' | 'parked' | 'partial' | 'unknown';

export interface StallProfileConfig {
  /** Directory for `stall-*.cpuprofile` artifacts. */
  dir: string;
  /** Start a capture once the heartbeat has been stale this long. */
  afterMs: number;
  /** Sampling window. Short, so it ends inside the stall it is describing. */
  captureMs: number;
  /** At most one capture per process per this window. */
  cooldownMs: number;
  /** Retention: newest N artifacts are kept. */
  maxProfiles: number;
  /**
   * How long to wait for `Profiler.start` to answer (WI-10006344). Optional so
   * older callers keep compiling; the worker falls back to the default below.
   */
  startTimeoutMs?: number;
}

/**
 * Defaults.
 *
 * - `afterMs` 4 s: the sentinel observes every 2 s and warns at 10 s, so the
 *   first observation past 4 s lands at 4-6 s. A capture started there finishes
 *   by ~8.5 s, inside the stalls this targets: :3170's R-state stalls are logged
 *   at 10 s and end before the 20 s kill. Normal loop lag here peaks ~3.5 s
 *   (SENTINEL_DEFAULTS), so 4 s of a stale heartbeat is already abnormal.
 * - `captureMs` 2.5 s: ~2,500 samples at V8's default 1 ms interval, plenty to
 *   rank a spin.
 * - `cooldownMs` 10 min: a host stalling every few minutes gets one profile per
 *   10 min, not a profiler running all the time.
 * - `maxProfiles` 20: ~100-200 KB each.
 */
export const STALL_PROFILE_DEFAULTS = {
  afterMs: 4_000,
  captureMs: 2_500,
  cooldownMs: 10 * 60_000,
  maxProfiles: 20,
  /**
   * `Profiler.start` makes V8 log every compiled code object before sampling,
   * so its cost grows with the heap and the bundle, not with responsiveness.
   * Measured 2026-10-06 (node 25, .papercusp/scratch/p017/profstart-cost.mjs,
   * main thread spinning): 19 ms empty, 1.4 s with 200k functions, 6.3 s with
   * 1M, 3.4 s with 200k functions plus a 20M-object heap; `Profiler.enable`
   * stayed at 0-1 ms throughout. On bg-host (multi-GB heap) a 3 s budget failed
   * with `Profiler.start not answered` while the inspector answered in 6 ms.
   */
  startTimeoutMs: 20_000,
} as const;

export interface StallCaptureInput {
  stalenessMs: number;
  cpuKind: StallCpuKind;
  /** A capture already ran during THIS contiguous stall. */
  capturedThisStall: boolean;
  inFlight: boolean;
  lastCaptureAtMs: number | null;
  nowMs: number;
}

/**
 * Capture a stale heartbeat with a measured CPU verdict. `parked` alone cannot
 * distinguish an idle main loop whose heartbeat stopped from a native wait.
 * The worker bounds inspector requests and, for parked threads, checks a
 * scheduled main-loop callback: inspector interrupts alone also answer during
 * some native waits. It drops captures whose heartbeat recovers before
 * profiling starts. `unknown` means no trustworthy CPU baseline.
 */
export function shouldCaptureStallProfile(
  input: StallCaptureInput,
  cfg: Pick<StallProfileConfig, 'afterMs' | 'cooldownMs'>,
): boolean {
  if (input.inFlight || input.capturedThisStall) return false;
  if (!(input.stalenessMs >= cfg.afterMs)) return false;
  if (input.cpuKind !== 'spinning' && input.cpuKind !== 'partial' && input.cpuKind !== 'parked') return false;
  if (input.lastCaptureAtMs != null && input.nowMs - input.lastCaptureAtMs < cfg.cooldownMs) {
    return false;
  }
  return true;
}

/** The subset of the DevTools `.cpuprofile` shape this file reads. */
export interface CpuProfileLike {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber?: number };
    children?: number[];
    /** Per-line self ticks inside this function (1-based lines, DevTools protocol). */
    positionTicks?: Array<{ line: number; ticks: number }>;
  }>;
  samples?: number[];
}

export interface HotStack {
  /** Samples whose stack (truncated to `depth`) reads exactly like `stack`. */
  count: number;
  /** Share of all samples, 0-100, one decimal. */
  pct: number;
  /** Leaf first: `fn@file:line:col < caller@file:line:col < …`. */
  stack: string;
}

export interface HotStackSummary {
  samples: number;
  hot: HotStack[];
}

/** `file:///a/b/hono-host.mjs` → `hono-host.mjs`; '' for a native frame. */
function frameFile(url: string): string {
  if (!url) return '';
  const cut = url.split(/[?#]/)[0];
  const parts = cut.split('/');
  return parts[parts.length - 1] || cut;
}

/** One frame, 1-based line:col as editors show them (cpuprofile is 0-based). */
export function formatFrame(callFrame: CpuProfileLike['nodes'][number]['callFrame']): string {
  const name = callFrame.functionName || '(anonymous)';
  const file = frameFile(callFrame.url);
  if (!file) return name;
  const line = callFrame.lineNumber >= 0 ? `:${callFrame.lineNumber + 1}` : '';
  const col =
    line && callFrame.columnNumber != null && callFrame.columnNumber >= 0
      ? `:${callFrame.columnNumber + 1}`
      : '';
  return `${name}@${file}${line}${col}`;
}

function hottestLine(ticks: Array<{ line: number; ticks: number }> | undefined): number | null {
  if (!Array.isArray(ticks) || ticks.length === 0) return null;
  let best: { line: number; ticks: number } | null = null;
  for (const t of ticks) {
    if (typeof t?.line !== 'number' || typeof t?.ticks !== 'number') continue;
    if (!best || t.ticks > best.ticks) best = t;
  }
  return best ? best.line : null;
}

/**
 * Rank the stacks the main thread spent its samples in.
 *
 * Self-time per leaf node, then the leaf's ancestor chain (leaf first, up to
 * `depth` frames, the synthetic `(root)` dropped). Stacks that read the same
 * after truncation are merged, so two native leaves under one JS caller (say
 * `now` and `sqrt` inside the same loop) rank as one stack once `depth` cuts
 * above them. Never throws on a malformed profile: a diagnostic must not take
 * down the sentinel, so a shape it cannot read yields zero samples.
 */
export function summarizeHotStacks(
  profile: CpuProfileLike,
  opts: { top?: number; depth?: number } = {},
): HotStackSummary {
  const top = opts.top ?? 3;
  const depth = opts.depth ?? 6;
  const samples = Array.isArray(profile?.samples) ? profile.samples : [];
  const nodes = Array.isArray(profile?.nodes) ? profile.nodes : [];
  if (samples.length === 0 || nodes.length === 0) return { samples: 0, hot: [] };

  const byId = new Map<number, CpuProfileLike['nodes'][number]>();
  const parentOf = new Map<number, number>();
  for (const node of nodes) {
    byId.set(node.id, node);
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }

  const selfCount = new Map<number, number>();
  for (const id of samples) selfCount.set(id, (selfCount.get(id) ?? 0) + 1);

  const byStack = new Map<string, number>();
  for (const [leafId, count] of selfCount) {
    const frames: string[] = [];
    let cur: number | undefined = leafId;
    // `seen` bounds a corrupt cyclic parent map; real profiles are trees.
    const seen = new Set<number>();
    while (cur != null && frames.length < depth && !seen.has(cur)) {
      seen.add(cur);
      const node = byId.get(cur);
      if (!node) break;
      if (node.callFrame.functionName !== '(root)') {
        // The leaf's hottest LINE. A callee V8 inlined has no node of its own
        // (measured: the probe's spin function vanished into its caller), so
        // the function's start line alone would not say where the time went.
        const hot = frames.length === 0 ? hottestLine(node.positionTicks) : null;
        frames.push(formatFrame(node.callFrame) + (hot != null ? `#L${hot}` : ''));
      }
      cur = parentOf.get(cur);
    }
    const key = frames.length ? frames.join(' < ') : '(unknown)';
    byStack.set(key, (byStack.get(key) ?? 0) + count);
  }

  const total = samples.length;
  const hot = [...byStack.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([stack, count]) => ({
      count,
      pct: Math.round((count / total) * 1000) / 10,
      stack,
    }));
  return { samples: total, hot };
}

/**
 * The journal fields for a summary: `hot1`..`hotN` as
 * `"63.1% (708) fn@file:1:2 < caller@…"`, each clipped so one profile line
 * stays readable in `journalctl`.
 */
export function hotStackFields(
  summary: HotStackSummary,
  maxChars = 400,
): Record<string, string | number> {
  const out: Record<string, string | number> = { samples: summary.samples };
  summary.hot.forEach((h, i) => {
    const text = `${h.pct}% (${h.count}) ${h.stack}`;
    out[`hot${i + 1}`] = text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  });
  return out;
}

/** Synchronous child-process primitives: a frame named one of these is a spawn block. */
const SYNC_SPAWN_FRAME_NAMES: ReadonlySet<string> = new Set(['spawnSync', 'execFileSync', 'execSync']);

/** A hot stack that blocked the main thread inside a synchronous child-process call. */
export interface SyncSpawnProducer {
  /** `fn@file` of the first named caller above the primitive: the code to fix. */
  producer: string;
  /** The producer's function name alone: stable across builds, so it is the dedupe identity. */
  producerFn: string;
  pct: number;
  stack: string;
}

function frameName(frame: string): string {
  const at = frame.indexOf('@');
  return (at >= 0 ? frame.slice(0, at) : frame).trim();
}

/** `fn@file:12:3#L12` → `file`; '' for a native frame with no location. */
function frameFileOf(frame: string): string {
  const at = frame.indexOf('@');
  if (at < 0) return '';
  return frame.slice(at + 1).replace(/#L\d+$/, '').replace(/(?::\d+){1,2}$/, '');
}

/**
 * Node's own frames: `node:child_process`, and `child_process` (what `formatFrame` leaves of
 * `node:internal/child_process`). A frame with no location is native. None of these is a
 * producer anyone can fix.
 */
function isNodeInternalFrame(frame: string): boolean {
  const file = frameFileOf(frame);
  return file === '' || file.startsWith('node:') || file === 'child_process';
}

/**
 * The hottest stack (at or above `minPct` of samples) that sits in a synchronous child-process
 * call, and the code that made the call (WI-10005253).
 *
 * The producer is the first frame above the OUTERMOST primitive, skipping Node internals and
 * `(anonymous)` callbacks, so `spawnSync < execFileSync < defaultWorktreeStatus < resolveCutRoot`
 * names `defaultWorktreeStatus`. Line and column are dropped because they move with every bundle
 * build; the function name is what stays put. When the profile depth cut the stack off above the
 * primitive, the producer reads `(above profile depth)` rather than guessing.
 */
export function syncSpawnProducer(summary: HotStackSummary, minPct = 10): SyncSpawnProducer | null {
  for (const h of summary.hot) {
    if (h.pct < minPct) continue;
    const frames = h.stack.split(' < ');
    let outermost = -1;
    frames.forEach((f, i) => {
      if (SYNC_SPAWN_FRAME_NAMES.has(frameName(f))) outermost = i;
    });
    if (outermost < 0) continue;
    const callers = frames.slice(outermost + 1).filter((f) => !isNodeInternalFrame(f));
    const caller = callers.find((f) => frameName(f) !== '(anonymous)') ?? callers[0];
    const producer = caller ? `${frameName(caller)}@${frameFileOf(caller)}` : '(above profile depth)';
    return { producer, producerFn: caller ? frameName(caller) : producer, pct: h.pct, stack: h.stack };
  }
  return null;
}
