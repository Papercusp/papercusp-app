/**
 * Leading+trailing coalescing for push-on-write health-panel refreshes
 * (WI-6980).
 *
 * THE PROBLEM. `refreshHealthPanel` is called FIRE-AND-FORGET from every
 * improvements write path — `capture-core.ts`, `triage-core.ts`, `decay.ts`,
 * `hygiene.ts` — so that a panel reflects a write immediately instead of
 * waiting up to ~30s for the next full health tick. It had NO debounce, so a
 * burst of writes produced a burst of refreshes, and each refresh is
 * expensive: `collectObservations` issues a `listIssues` + `countIssues` pair
 * whose cost is dominated by a `coord_links` topic-EXISTS probe re-run once
 * per candidate row (measured 2026-08-03: Seq Scan 16,811 rows -> Index Only
 * Scan loops=16,811, 50,919 of 67,270 buffers = 76%).
 *
 * Measured on the live box before this change: the list+count pair ran at
 * 18.7 / 18.6 calls-per-minute — ~11.3% of one CPU core, continuously, to
 * re-derive a panel that renders "N open observations".
 *
 * ⚠ Do NOT "fix" this by trimming the SELECT list. That was the obvious
 * theory and it is FALSIFIED by measurement, three times independently: the
 * body-omit seam (`ISSUE_COLS_BODYLESS`) saves 0.00%, and dropping `payload`
 * plus all seven payload-derived columns saves 1.04%. The cost is the
 * predicate, not the projection, so the only lever with real headroom is CALL
 * COUNT — which is what this module reduces.
 *
 * THE FIX. A leading+trailing debounce per (workspaceId, panel): the FIRST
 * refresh after a quiet period runs IMMEDIATELY (so a single write still
 * shows up promptly, preserving the whole point of push-on-write), and
 * further refreshes within `windowMs` are COALESCED into one trailing refresh
 * at the window end. Under sustained write traffic this collapses an
 * unbounded storm into at most one refresh per window, and the panel is at
 * most ~`windowMs` staler than before — still far fresher than the ~30s full
 * tick this mechanism exists to beat.
 *
 * This is deliberately the SAME shape as `cache/debounced-invalidate.ts`'s
 * `TagBumpDebouncer` (leading edge + coalesced trailing edge, keyed, with an
 * injectable scheduler seam). Kept separate rather than shared because that
 * one is bound to `Cache.invalidateByTags`; if a third caller ever wants this,
 * extract the common core then rather than generalising on spec.
 */

import { pinModuleState } from '@papercusp/module-singleton';

/** Injectable scheduler seam (tests use a manual driver / fake timers). */
export interface RefreshScheduler {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realScheduler: RefreshScheduler = {
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // Never hold the process open for a panel refresh.
    (t as unknown as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Coalescing window. 4s matches `DEFAULT_DEBOUNCE_WINDOW_MS` in
 * `cache/debounced-invalidate.ts` — chosen there for the same reason: long
 * enough to collapse a write storm, short enough that the extra staleness is
 * imperceptible next to the ~30s tick.
 */
export const DEFAULT_REFRESH_WINDOW_MS = 4_000;

const SEP = "\x00";

interface Window {
  /** a refresh was requested during the open window */
  trailing: boolean;
  timer: unknown;
}

/**
 * Leading+trailing debouncer for an async, idempotent, fire-and-forget refresh
 * keyed by (workspaceId, panel).
 *
 * Holds no reference to the refresh implementation — the caller passes it on
 * each request, so the singleton stays swappable under tests and this module
 * never imports `compute.ts` (which imports plenty).
 */
export class PanelRefreshCoalescer {
  private readonly windowMs: number;
  private readonly sched: RefreshScheduler;
  private readonly windows = new Map<string, Window>();
  /** key -> the refresh currently executing, so a trailing edge never overlaps a run. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(opts: { windowMs?: number; scheduler?: RefreshScheduler } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_REFRESH_WINDOW_MS;
    this.sched = opts.scheduler ?? realScheduler;
  }

  /**
   * Request a refresh of ONE (workspaceId, panel). The leading edge runs
   * `run` immediately; requests inside the open window are coalesced into a
   * single trailing run.
   *
   * Returns the promise for the LEADING run only (so a caller that wants to
   * await the immediate refresh still can); a coalesced request resolves
   * immediately, because its work is deliberately deferred to the trailing
   * edge. Never rejects — `run` is a fire-and-forget path.
   */
  request(workspaceId: string, panel: string, run: () => Promise<void>): Promise<void> {
    const key = workspaceId + SEP + panel;
    const w = this.windows.get(key);
    if (!w) {
      const entry: Window = { trailing: false, timer: null };
      entry.timer = this.sched.setTimer(() => this.onWindowEnd(key, run), this.windowMs);
      this.windows.set(key, entry);
      return this.execute(key, run);
    }
    // Inside the window: coalesce. Remember that a write happened so the
    // trailing edge fires and the panel ends up reflecting the LAST write.
    w.trailing = true;
    return Promise.resolve();
  }

  /**
   * Run `run`, serialising per key. If a run is already in flight for this
   * key, mark a trailing refresh instead of running concurrently — two
   * concurrent refreshes of the same panel would double the very cost this
   * exists to remove, and the later one's result would win anyway.
   */
  private execute(key: string, run: () => Promise<void>): Promise<void> {
    const running = this.inFlight.get(key);
    if (running) {
      const w = this.windows.get(key);
      if (w) w.trailing = true;
      return running;
    }
    let p: Promise<void>;
    try {
      p = Promise.resolve(run());
    } catch {
      // A synchronous throw from `run` — same fail-soft contract as async.
      return Promise.resolve();
    }
    const guarded = p.catch(() => {
      /* fire-and-forget from a write path — never throw */
    }).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, guarded);
    return guarded;
  }

  private onWindowEnd(key: string, run: () => Promise<void>): void {
    const w = this.windows.get(key);
    if (!w) return;
    if (w.trailing) {
      // Activity during the window -> trailing refresh, and keep the window
      // open because the caller is evidently still busy.
      w.trailing = false;
      w.timer = this.sched.setTimer(() => this.onWindowEnd(key, run), this.windowMs);
      void this.execute(key, run);
    } else {
      // Quiet window -> close it. The next request starts fresh on a leading edge.
      this.windows.delete(key);
    }
  }

  /** Test-only: cancel every pending window. */
  resetForTests(): void {
    for (const w of this.windows.values()) this.sched.clearTimer(w.timer);
    this.windows.clear();
    this.inFlight.clear();
  }
}

// Process-wide singleton, realm-pinned so the tsx runtime and a vitest module
// graph share one coalescer — same rationale (and same hazard) as the tag-bump
// debouncer's pinning, and pinned the same way: through
// @papercusp/module-singleton rather than a hand-rolled `globalThis[key]` pair,
// so the pin stays visible to listModuleDuplications() (EI-19479108855357092).
const __state = pinModuleState<{ coalescer: PanelRefreshCoalescer | null }>(
  '@papercusp/operator-core.panelRefreshCoalescer',
  () => ({ coalescer: null }),
);

export function getPanelRefreshCoalescer(): PanelRefreshCoalescer {
  if (!__state.coalescer) __state.coalescer = new PanelRefreshCoalescer();
  return __state.coalescer;
}

/** Test seam: install a coalescer (e.g. with a fake scheduler / short window). */
export function setPanelRefreshCoalescerForTests(c: PanelRefreshCoalescer | null): void {
  __state.coalescer = c;
}
