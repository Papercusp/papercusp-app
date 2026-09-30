/**
 * In-process broadcast channel with ring-buffer replay.
 *
 * Replaces the 4 ad-hoc EventEmitter buses that used to live in
 * apps/operator/lib/ (branch-action-bus, harness-log-bus,
 * provision-audit-bus, run-chunk-bus). Same shape, type-parameterized,
 * pinned on globalThis so HMR doesn't drop live subscribers.
 *
 * Ordering: events delivered to each subscriber in publish order.
 * Backpressure: publish never blocks. Each subscriber has its own
 * bounded queue (default 4096); on overflow, oldest is dropped and a
 * `lossy` flag is set on the next yield. Subscribers should reconnect
 * with Last-Event-ID and use `recentSince()` to recover.
 *
 * Channel key convention: prefix with your domain (e.g. `backup:`,
 * `audit:`, `jobs:`). See README.
 */

import { createIdAllocator, type IdAllocator } from '../wire/ids';
import { unrefTimer } from './unref';

// Brand-neutral, package-internal key so the singleton survives HMR
// without colliding with other libs on globalThis. No consuming-app or
// project coupling — any project can borrow this as-is.
const GLOBAL_KEY = '__sse_channel_registry__';

export interface BusChannel<T> {
  /** Publish an event. Assigns auto-id, notifies subscribers. Returns the id. */
  publish(event: T): number;
  /** Mark terminated. Active subscribers' iteration ends. New subscribers see done immediately. Idempotent. */
  done(payload?: unknown): void;
  readonly isDone: boolean;
  readonly donePayload: unknown | undefined;
  /** Last N events (≤ ringSize). Each carries its assigned id. */
  readonly recent: ReadonlyArray<{ id: number; event: T }>;
  /** Items from recent with id > sinceId. Pass null/undefined for the whole buffer. */
  recentSince(sinceId: number | null | undefined): ReadonlyArray<{ id: number; event: T }>;
  /**
   * Subscribe. Yields each future publish in order. Iteration ends on done().
   * Does NOT yield `recent` — use recentSince() if you want backfill.
   */
  subscribe(): AsyncIterable<{ id: number; event: T }>;
  /**
   * Synchronous handler subscription. Called from within publish() before it
   * returns — useful for in-process fan-out where consumers rely on
   * publish-order, same-tick delivery. Returns an unsubscribe function.
   * Handler throws are caught and swallowed.
   * For SSE bridging prefer `subscribe()` + bridgeChannel — async iteration
   * pairs naturally with stream writes.
   */
  onPublish(handler: (item: { id: number; event: T }) => void): () => void;
  /**
   * Synchronous notification when the channel is marked done(). Fires
   * immediately if already done. Returns an unsubscribe function.
   */
  onDone(handler: () => void): () => void;
  readonly subscriberCount: number;
  /** Number of synchronous handlers currently registered via onPublish. */
  readonly syncHandlerCount: number;
}

export interface ChannelOptions {
  /** Ring buffer size. Default 256. */
  ringSize?: number;
  /** Per-subscriber queue size. Overflow drops oldest. Default 4096. */
  subscriberQueueSize?: number;
  /** GC delay after done() AND zero subscribers. Default 60_000. */
  gcDelayMs?: number;
  /**
   * Idle-reap backstop. A channel with ZERO subscribers and no publish/access
   * for this long is dropped even if done() was never called — the safety net
   * for a producer that died WITHOUT terminating its channel (e.g. a crashed
   * subprocess that never sent its final chunk). scheduleGC only handles the
   * normal done()+0-subs case (gcDelayMs); this catches the never-done case,
   * which scheduleGC's `!isDone` guard otherwise skips forever. Default 600_000
   * (10 min).
   */
  idleReapMs?: number;
}

interface Subscriber<T> {
  queue: Array<{ id: number; event: T }>;
  waiting: ((v: IteratorResult<{ id: number; event: T }>) => void) | null;
  done: boolean;
}

interface ChannelState<T> {
  key: string;
  opts: Required<ChannelOptions>;
  ring: Array<{ id: number; event: T }>;
  ids: IdAllocator;
  subs: Set<Subscriber<T>>;
  syncHandlers: Set<(item: { id: number; event: T }) => void>;
  doneHandlers: Set<() => void>;
  isDone: boolean;
  donePayload: unknown | undefined;
  gcTimer: ReturnType<typeof setTimeout> | null;
  /** Epoch ms of the last publish / getChannel access — drives the idle-reap backstop. */
  lastActivityMs: number;
}

type ChannelRegistry = Map<string, ChannelState<unknown>>;

function registry(): ChannelRegistry {
  const g = globalThis as unknown as { [GLOBAL_KEY]?: ChannelRegistry };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY]!;
}

const DEFAULTS: Required<ChannelOptions> = {
  ringSize: 256,
  subscriberQueueSize: 4096,
  gcDelayMs: 60_000,
  idleReapMs: 600_000,
};

function makeState<T>(key: string, opts: ChannelOptions): ChannelState<T> {
  return {
    key,
    opts: { ...DEFAULTS, ...opts },
    ring: [],
    ids: createIdAllocator(0),
    subs: new Set<Subscriber<T>>(),
    syncHandlers: new Set<(item: { id: number; event: T }) => void>(),
    doneHandlers: new Set<() => void>(),
    isDone: false,
    donePayload: undefined,
    gcTimer: null,
    lastActivityMs: Date.now(),
  };
}

function deliver<T>(state: ChannelState<T>, item: { id: number; event: T }): void {
  // Synchronous handlers fire first, in publish order, before any async
  // subscribers are notified. Handler throws are swallowed so a single bad
  // listener can't break the producer or starve other subscribers.
  for (const handler of state.syncHandlers) {
    try { handler(item); } catch { /* never crash producer */ }
  }
  for (const sub of state.subs) {
    if (sub.done) continue;
    if (sub.waiting) {
      const cb = sub.waiting;
      sub.waiting = null;
      cb({ value: item, done: false });
      continue;
    }
    if (sub.queue.length >= state.opts.subscriberQueueSize) {
      sub.queue.shift(); // drop oldest
    }
    sub.queue.push(item);
  }
}

function bindChannel<T>(state: ChannelState<T>): BusChannel<T> {
  return {
    publish(event: T): number {
      if (state.isDone) {
        throw new Error(`channel ${state.key}: publish after done()`);
      }
      state.lastActivityMs = Date.now();
      const id = state.ids.next();
      const item = { id, event };
      // Ring buffer write
      state.ring.push(item);
      if (state.ring.length > state.opts.ringSize) state.ring.shift();
      deliver(state, item);
      return id;
    },

    done(payload?: unknown): void {
      if (state.isDone) return;
      state.isDone = true;
      state.donePayload = payload;
      // Notify all subscribers — iteration ends.
      for (const sub of state.subs) {
        sub.done = true;
        if (sub.waiting) {
          const cb = sub.waiting;
          sub.waiting = null;
          cb({ value: undefined as never, done: true });
        }
      }
      // Fire sync done handlers AFTER async-subscriber teardown so handlers
      // observing isDone see a quiesced channel.
      for (const handler of state.doneHandlers) {
        try { handler(); } catch { /* never crash producer */ }
      }
      scheduleGC(state);
    },

    onPublish(handler) {
      state.syncHandlers.add(handler);
      return () => { state.syncHandlers.delete(handler); };
    },

    onDone(handler) {
      if (state.isDone) {
        try { handler(); } catch { /* swallow */ }
        return () => {};
      }
      state.doneHandlers.add(handler);
      return () => { state.doneHandlers.delete(handler); };
    },

    get isDone() { return state.isDone; },
    get donePayload() { return state.donePayload; },
    get recent() { return state.ring as ReadonlyArray<{ id: number; event: T }>; },

    recentSince(sinceId: number | null | undefined) {
      const since = sinceId ?? 0;
      return state.ring.filter((e) => e.id > since);
    },

    subscribe(): AsyncIterable<{ id: number; event: T }> {
      if (state.gcTimer) {
        clearTimeout(state.gcTimer);
        state.gcTimer = null;
      }
      const sub: Subscriber<T> = { queue: [], waiting: null, done: false };
      state.subs.add(sub);

      // If channel is already done, the subscriber sees an immediately-ended iteration
      if (state.isDone) sub.done = true;

      return {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<{ id: number; event: T }>> {
              if (sub.queue.length > 0) {
                return Promise.resolve({ value: sub.queue.shift()!, done: false });
              }
              if (sub.done) {
                state.subs.delete(sub);
                scheduleGC(state);
                return Promise.resolve({ value: undefined as never, done: true });
              }
              return new Promise((resolve) => {
                sub.waiting = resolve;
              });
            },
            return(): Promise<IteratorResult<{ id: number; event: T }>> {
              // Caller bailed (break, throw). Unhook the subscriber.
              sub.done = true;
              if (sub.waiting) {
                const cb = sub.waiting;
                sub.waiting = null;
                cb({ value: undefined as never, done: true });
              }
              state.subs.delete(sub);
              scheduleGC(state);
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },

    get subscriberCount() { return state.subs.size; },
    get syncHandlerCount() { return state.syncHandlers.size; },
  };
}

// ── idle-reap backstop ────────────────────────────────────────────────────────
// scheduleGC only reaps a channel that called done() and has zero subscribers.
// A producer that dies WITHOUT done() (e.g. a crashed orchestrator subprocess
// that never POSTs its terminal chunk) leaves a channel that is never isDone, so
// scheduleGC's `!state.isDone` guard skips it forever — an unbounded
// per-producer leak (EI-127, cluster #5). This process-wide sweep is the
// backstop: drop any channel with zero subscribers idle past its idleReapMs,
// regardless of isDone. Cheap (one O(N) pass/min, N = live channels), unref'd so
// it never holds the process open.
const REAPER_SWEEP_MS = 60_000;
let reaperTimer: ReturnType<typeof setInterval> | null = null;

function ensureReaper(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    const reg = registry();
    for (const [key, state] of reg) {
      if (state.subs.size === 0 && now - state.lastActivityMs > state.opts.idleReapMs) {
        if (state.gcTimer) clearTimeout(state.gcTimer);
        reg.delete(key);
      }
    }
  }, REAPER_SWEEP_MS);
  unrefTimer(reaperTimer);
}

function scheduleGC<T>(state: ChannelState<T>): void {
  if (!state.isDone || state.subs.size > 0) return;
  if (state.gcTimer) clearTimeout(state.gcTimer);
  state.gcTimer = setTimeout(() => {
    if (state.isDone && state.subs.size === 0) {
      registry().delete(state.key);
    }
  }, state.opts.gcDelayMs);
  unrefTimer(state.gcTimer);
}

export function getChannel<T>(key: string, opts: ChannelOptions = {}): BusChannel<T> {
  ensureReaper();
  const reg = registry();
  let state = reg.get(key) as ChannelState<T> | undefined;
  if (!state) {
    state = makeState<T>(key, opts);
    reg.set(key, state as ChannelState<unknown>);
  } else {
    state.lastActivityMs = Date.now();
    if (state.gcTimer) {
      // GC was scheduled; cancel it because someone wants this channel.
      clearTimeout(state.gcTimer);
      state.gcTimer = null;
      state.isDone = false;
      state.donePayload = undefined;
    }
  }
  return bindChannel(state);
}

export function dropChannel(key: string): boolean {
  const reg = registry();
  const state = reg.get(key);
  if (!state) return false;
  if (state.gcTimer) clearTimeout(state.gcTimer);
  reg.delete(key);
  return true;
}

export function listChannels(): Array<{
  key: string;
  subscribers: number;
  syncHandlers: number;
  isDone: boolean;
  recentCount: number;
}> {
  return Array.from(registry().values()).map((s) => ({
    key: s.key,
    subscribers: s.subs.size,
    syncHandlers: s.syncHandlers.size,
    isDone: s.isDone,
    recentCount: s.ring.length,
  }));
}

/** Test-only. Clears the global registry so each test starts clean. */
export function _resetChannelsForTest(): void {
  for (const state of registry().values()) {
    if (state.gcTimer) clearTimeout(state.gcTimer);
  }
  registry().clear();
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
  }
}
