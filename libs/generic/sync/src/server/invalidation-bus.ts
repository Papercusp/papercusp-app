/**
 * Invalidation bus — the server-push core of @papercusp/sync.
 *
 * Generic extraction of the operator's `sync-sse.ts`. One process-local
 * bus fans a stream of invalidation/update events out to every connected
 * SSE subscriber, with:
 *   - a monotonic event id + an in-memory ring buffer for `Last-Event-ID`
 *     reconnect replay (`backfillSince`),
 *   - source-side dedupe for explicit notifies, plus source-aware
 *     immediate-first/trailing-latest coalescing for bridged targets so a
 *     periodic reconcile burst cannot fan out a flicker storm or hide its
 *     final state behind a 90-second floor,
 *   - a 32KB payload cap (oversized → drop `data`, client refetches),
 *   - an optional `bridge` that synthesizes extra events (e.g. a raw
 *     PG-trigger `<schema>.<table>.changed` → the camelCase query names
 *     that read that table).
 *
 * Transport is INJECTED, so the lib stays dependency-free:
 *   - `ListenSource.start(onMessage)` feeds raw JSON event strings in
 *     (the host wires this to PG `LISTEN`, a Redis sub, an in-process
 *     emitter — anything).
 *   - `NotifySink.notify(json)` sends an event out to all processes (the
 *     host wires this to `pg_notify`, a Redis pub, etc). In a single
 *     process the notify loops back through the ListenSource.
 *
 * The host's `notifyInvalidate(...)` call publishes via the sink; the sink
 * delivery comes back through the listen source and is what actually fans
 * out to subscribers — so multi-process deployments all see every event.
 */

import {
  decideWake,
  emptyFloorState,
  type Fire,
  type FloorState,
} from '@papercusp/debounce-coalesce';

export interface SyncEvent {
  id: number;
  ts: number;
  name: string;
  args?: Record<string, unknown>;
  /** Optional full payload. Absent when oversized (>limit) or unknown —
   *  client falls back to invalidate-then-refetch. */
  data?: unknown[];
}

/** Inbound transport: deliver raw JSON event strings to `onMessage`. */
export interface ListenSource {
  start(onMessage: (raw: string) => void): Promise<void> | void;
  stop?(): void | Promise<void>;
}

/**
 * A bridged target the `bridge` may synthesize from a raw event. Either:
 *   - a bare query NAME (string) → full-bust (the bridged event carries NO
 *     `args`, so the client invalidates EVERY cache entry under that name); or
 *   - `{ name, args }` → SCOPED invalidate (the bridged event carries those
 *     `args`, so the client invalidates only the matching cache key — e.g.
 *     a single row's entry, built from the source event's row PK).
 *
 * A string and `{ name }` (no args) are equivalent — both full-bust.
 */
export type BridgeTarget =
  | string
  | { name: string; args?: Record<string, unknown> };

/** Outbound transport: publish a JSON payload to all processes. */
export interface NotifySink {
  notify(payloadJson: string): Promise<void>;
}

/** Per-call options for {@link InvalidationBus.notifyInvalidate}. */
export interface NotifyInvalidateOpts {
  /**
   * Override the bus's source-side dedupe window (default {@link CreateInvalidationBusOptions.dedupeWindowMs}
   * = 90s) FOR THIS CALL. Use a SHORT window for a producer that is ALREADY self-debounced
   * (a periodic change-detector polling on a fixed cadence) so its legitimate per-tick fires
   * aren't collapsed into the 90s window meant for chatty per-row triggers. Never RAISE it to
   * fake a faster-than-window cadence without self-debouncing — that reintroduces the storm.
   */
  dedupeWindowMs?: number;
}

export interface SubscribeHandle {
  send: (e: SyncEvent) => void;
  close: () => void;
}

export interface SubscribeOptions {
  /**
   * Optional per-subscriber interest predicate. Return `false` to skip
   * delivering this event to THIS subscriber; every other subscriber is
   * unaffected. Omit it and the subscriber receives every event, which is
   * exactly the pre-filter behaviour.
   *
   * FAILS OPEN, deliberately, and in three separate ways — the failure mode of
   * dropping events is silent staleness, which no test suite reliably catches
   * and which users report as "the UI is wrong sometimes" rather than as a bug:
   *
   *   1. no predicate supplied            -> send (unfiltered, as before);
   *   2. the predicate THROWS             -> send, and other subscribers still
   *                                          get the event (the same guarantee
   *                                          `fanout` already gives a throwing
   *                                          `send`);
   *   3. the predicate returns anything
   *      other than a literal `false`     -> send.
   *
   * (3) is the load-bearing one and is not an accident of implementation: an
   * event is dropped only on POSITIVE knowledge that the subscriber does not
   * want it. A predicate that falls off the end of a branch and implicitly
   * returns `undefined` — the single most common way a JS predicate goes wrong
   * — therefore degrades to today's full fan-out rather than to a silently
   * starved client.
   */
  filter?: (e: SyncEvent) => boolean;
}

export interface CreateInvalidationBusOptions {
  listen: ListenSource;
  notify: NotifySink;
  /** Ring-buffer retention for reconnect replay. Default 60_000. */
  historyWindowMs?: number;
  /** Suppress identical explicit notifies within this window. Default 90_000. */
  dedupeWindowMs?: number;
  /**
   * Maximum age of a suppressed bridged event before the latest target is
   * emitted on the trailing edge. The value is hard-capped at two seconds so
   * a hot source can never leave the final write hidden behind the historical
   * 90-second burst window. Default 2_000.
   */
  bridgeCoalesceWindowMs?: number;
  /** Serialized-payload byte cap; over → drop `data`. Default 32768. */
  payloadSizeLimit?: number;
  /**
   * Synthesize extra invalidation targets from a raw event (e.g. a PG-trigger
   * `<schema>.<table>.changed`). Receives BOTH the event name and its `args`
   * (the trigger payload — `{ workspace_id, op, id }` for the operator) so a
   * target can be SCOPED to the changed row's PK (`args.id`). Returns
   * {@link BridgeTarget}s: a bare string full-busts (back-compat); a
   * `{ name, args }` object scopes the invalidation to those args.
   */
  bridge?: (
    eventName: string,
    eventArgs?: Record<string, unknown>,
  ) => readonly BridgeTarget[];
  /**
   * Optional dedupe-window policy for bridged targets. The callback receives
   * the synthesized query name first and the source event name second; return
   * a window in milliseconds, or `undefined` to keep the bus-wide default.
   * Supplying the source as well as the query is deliberate: a low-volume
   * source may need a short window for a query that is also fed by a hot
   * source, without weakening that hot source's storm guard.
   */
  bridgedDedupeWindowMs?: (
    queryName: string,
    sourceEventName: string,
  ) => number | undefined;
  /** Injectable clock (testing). Default Date.now. */
  now?: () => number;
  /** Injectable timer seams (testing). Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (where: string, err: unknown) => void;
  log?: (msg: string) => void;
}

export interface InvalidationBus {
  /**
   * Register an SSE subscriber. Lazily starts the ListenSource.
   *
   * `opts.filter` narrows delivery to THIS subscriber only, and fails open in
   * every ambiguous case — see {@link SubscribeOptions}.
   */
  subscribe(send: (e: SyncEvent) => void, opts?: SubscribeOptions): Promise<SubscribeHandle>;
  /** Events with id > lastEventId still inside the retention window. */
  backfillSince(lastEventId: number): SyncEvent[];
  /** Publish an invalidation (or data-bearing update) to all processes. */
  notifyInvalidate(
    name: string,
    args?: Record<string, unknown>,
    data?: unknown[],
    notifyOpts?: NotifyInvalidateOpts,
  ): Promise<void>;
  /** Eagerly start the ListenSource (otherwise lazy on first subscribe). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Inspection / tests. The raw ring length: between push-time prunes it can
   * include events up to a quarter window past retention (backfillSince never
   * returns them).
   */
  historySize(): number;
}

const DEFAULT_HISTORY_WINDOW_MS = 60_000;
const DEFAULT_DEDUPE_WINDOW_MS = 90_000;
/** The normal-path freshness bound for a suppressed bridged target. */
export const DEFAULT_BRIDGE_COALESCE_WINDOW_MS = 2_000;
const DEFAULT_PAYLOAD_SIZE_LIMIT = 32 * 1024;

/** Keep the normal-path trailing bound an invariant, even if a host supplies a bad value. */
function normalizeBridgeCoalesceWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BRIDGE_COALESCE_WINDOW_MS;
  return Math.min(DEFAULT_BRIDGE_COALESCE_WINDOW_MS, Math.max(0, value));
}

interface BridgeCandidate {
  name: string;
  ts: number;
  args?: Record<string, unknown>;
}

interface BridgeWindow {
  /** Shared floor/coalesce state; pending is kept at length zero or one. */
  floor: FloorState<BridgeCandidate>;
  /** Effective source-side floor for this source/target pair. */
  dedupeWindowMs: number;
  /** A scheduled trailing flush, or null when there is no pending candidate. */
  timer: unknown | null;
}

/** Tiny non-crypto hash (FNV-1a, 32-bit) for the dedupe key's data leg.
 *  The key needs *equality* on the payload, not the payload bytes: storing
 *  full serialized payloads as Map keys retained them in memory for the
 *  whole dedupe window and made every key comparison O(payload size). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function createInvalidationBus(
  opts: CreateInvalidationBusOptions,
): InvalidationBus {
  const historyWindowMs = opts.historyWindowMs ?? DEFAULT_HISTORY_WINDOW_MS;
  const configuredDedupeWindowMs = opts.dedupeWindowMs;
  const dedupeWindowMs =
    configuredDedupeWindowMs === undefined || !Number.isFinite(configuredDedupeWindowMs)
      ? DEFAULT_DEDUPE_WINDOW_MS
      : Math.max(0, configuredDedupeWindowMs);
  const bridgeCoalesceWindowMs = normalizeBridgeCoalesceWindow(opts.bridgeCoalesceWindowMs);
  const payloadSizeLimit = opts.payloadSizeLimit ?? DEFAULT_PAYLOAD_SIZE_LIMIT;
  const bridge = opts.bridge ?? (() => [] as const);
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const onError = opts.onError ?? (() => {});
  const log = opts.log ?? (() => {});

  let nextId = 1;
  const history: SyncEvent[] = [];
  const subscribers = new Set<{
    send: (e: SyncEvent) => void;
    filter?: (e: SyncEvent) => boolean;
  }>();
  const recentNotifies = new Map<string, number>();
  /**
   * Per-(source,target,args) leading/trailing state. The floor state is from
   * the shared debounce primitive, but each entry intentionally keeps only
   * ONE pending fire: the latest target is what matters, and retaining every
   * row in a sustained trigger burst would turn the coalescer into a memory
   * amplifier.
   */
  const bridgeWindows = new Map<string, BridgeWindow>();
  const inflightNotifies = new Set<Promise<unknown>>();

  let startPromise: Promise<void> | null = null;

  /**
   * P-525 (p2p-join-catchup-speed D-013): a push prunes the ring at most once
   * per quarter window. Filtering the whole ring on EVERY push made each event
   * cost O(ring); a bulk fold's per-row trigger events turned that into ~18% of
   * the main thread (measured on the P-007 VM). While events keep arriving the
   * ring holds at most 1.25 windows of them. Replay stays exact: backfillSince
   * prunes in full before it reads.
   */
  const prunePeriodMs = Number.isFinite(historyWindowMs) ? Math.max(0, historyWindowMs / 4) : 0;
  let lastPruneAt = Number.NEGATIVE_INFINITY;

  function maybePruneHistory(): void {
    if (now() - lastPruneAt >= prunePeriodMs) pruneHistory();
  }

  function pruneHistory(): void {
    lastPruneAt = now();
    const cutoff = lastPruneAt - historyWindowMs;
    // A trailing bridge event is intentionally emitted after later raw events
    // may already be in the ring, while retaining the latest source timestamp
    // for freshness measurement. Do not assume `ts` is sorted by insertion
    // order; filter every entry so a delayed old event cannot pin newer history
    // in memory or leak past the replay retention window.
    let write = 0;
    for (const event of history) {
      if (event.ts >= cutoff) history[write++] = event;
    }
    history.length = write;
  }

  function fanout(ev: SyncEvent): void {
    history.push(ev);
    maybePruneHistory();
    for (const s of subscribers) {
      try {
        // Drop ONLY on positive knowledge: a predicate that throws, or that
        // returns anything but a literal `false`, delivers the event. See
        // SubscribeOptions for why every ambiguous case resolves to sending.
        if (s.filter !== undefined) {
          let wanted = true;
          try {
            wanted = s.filter(ev) !== false;
          } catch {
            /* a broken predicate must never starve its own subscriber */
            wanted = true;
          }
          if (!wanted) continue;
        }
        s.send(ev);
      } catch {
        /* best-effort — one bad subscriber must not break the fan-out */
      }
    }
  }

  function cancelBridgeTimer(entry: BridgeWindow): void {
    if (entry.timer === null) return;
    clearTimer(entry.timer);
    entry.timer = null;
  }

  function scheduleBridgeFlush(key: string, entry: BridgeWindow, dueAt: number): void {
    // Keep the timer anchored to the FIRST suppressed fire. Re-arming it from
    // every subsequent event would be a trailing debounce that can postpone a
    // sustained burst forever, which is exactly the stale-final-state failure
    // this coalescer is meant to remove.
    cancelBridgeTimer(entry);
    const delayMs = Math.max(0, dueAt - now());
    const handle = setTimer(() => flushBridge(key), delayMs);
    entry.timer = handle;
    // Node timers should not keep a host alive during shutdown. Browser timer
    // handles do not expose unref, so feature-detect it rather than narrowing
    // the injected timer type.
    const maybeUnref = handle as { unref?: () => void } | null;
    maybeUnref?.unref?.();
  }

  function flushBridge(key: string): void {
    const entry = bridgeWindows.get(key);
    if (!entry) return;
    entry.timer = null;
    const at = now();
    const pending = entry.floor.pending;
    if (pending.length === 0) return;

    const decision = decideWake({
      lastWokenAt: entry.floor.lastWokenAt,
      pending,
      now: at,
      cfg: {
        minSleepMs: entry.dedupeWindowMs,
        maxStalenessMs: bridgeCoalesceWindowMs,
        leadingEdge: true,
      },
    });
    entry.floor = decision.state;
    if (decision.wake) {
      const latest = decision.coalesced.latest.payload;
      fanout({ id: nextId++, name: latest.name, ts: latest.ts, ...(latest.args !== undefined ? { args: latest.args } : {}) });
      return;
    }
    if (decision.dueAt !== null) scheduleBridgeFlush(key, entry, decision.dueAt);
  }

  function emitBridgedTarget(
    key: string,
    candidate: BridgeCandidate,
    effectiveDedupeWindowMs: number,
  ): void {
    let entry = bridgeWindows.get(key);
    if (!entry) {
      entry = {
        floor: emptyFloorState<BridgeCandidate>(),
        dedupeWindowMs: effectiveDedupeWindowMs,
        timer: null,
      };
      bridgeWindows.set(key, entry);
    } else {
      entry.dedupeWindowMs = effectiveDedupeWindowMs;
    }

    // Keep the pending fire's anchor time stable while replacing its payload
    // with the newest target. This gives us trailing-*latest* semantics with a
    // single bounded object instead of an unbounded array of row writes.
    const previous = entry.floor.pending[0];
    const pending: Fire<BridgeCandidate>[] = [
      previous
        ? { at: previous.at, payload: candidate }
        : { at: candidate.ts, payload: candidate },
    ];
    const decision = decideWake({
      lastWokenAt: entry.floor.lastWokenAt,
      pending,
      now: candidate.ts,
      cfg: {
        minSleepMs: effectiveDedupeWindowMs,
        maxStalenessMs: bridgeCoalesceWindowMs,
        leadingEdge: true,
      },
    });
    entry.floor = decision.state;
    if (decision.wake) {
      cancelBridgeTimer(entry);
      const latest = decision.coalesced.latest.payload;
      fanout({ id: nextId++, name: latest.name, ts: latest.ts, ...(latest.args !== undefined ? { args: latest.args } : {}) });
      return;
    }
    if (decision.dueAt !== null) scheduleBridgeFlush(key, entry, decision.dueAt);
  }

  function pruneBridgeWindows(ts: number): void {
    // A quiet source/target pair is retained only for its dedupe floor. The
    // size guard keeps a write storm over many distinct targets from turning
    // this diagnostic map into an unbounded cache.
    if (bridgeWindows.size < 200) return;
    for (const [key, entry] of bridgeWindows) {
      const last = entry.floor.lastWokenAt;
      if (entry.floor.pending.length === 0 && last !== null && ts - last >= entry.dedupeWindowMs) {
        cancelBridgeTimer(entry);
        bridgeWindows.delete(key);
      }
    }
  }

  function onMessage(raw: string): void {
    let parsed: { name?: unknown; args?: unknown; data?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed.name !== 'string') return;
    const ev: SyncEvent = {
      id: nextId++,
      ts: now(),
      name: parsed.name,
      args:
        parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : undefined,
      data: Array.isArray(parsed.data) ? parsed.data : undefined,
    };
    fanout(ev);
    pruneBridgeWindows(ev.ts);

    // Bridge: synthesize additional events from the raw (name, args). A bare
    // string target full-busts (no `args`); a `{ name, args }` target scopes the
    // invalidate to that cache key. Each source/target/args tuple gets a
    // leading immediate event and a bounded trailing-latest event through the
    // shared floor primitive. The source name stays in the key so a hot source
    // cannot hold another source's control-plane update behind its floor.
    for (const target of bridge(parsed.name, ev.args)) {
      const name = typeof target === 'string' ? target : target.name;
      const targetArgs = typeof target === 'string' ? undefined : target.args;
      const key = `bridge:${parsed.name}|${name}|${targetArgs ? JSON.stringify(targetArgs) : ''}|`;
      const targetDedupeWindowMs = opts.bridgedDedupeWindowMs?.(name, parsed.name);
      const effectiveDedupeWindowMs =
        targetDedupeWindowMs === undefined || !Number.isFinite(targetDedupeWindowMs)
          ? dedupeWindowMs
          : Math.max(0, targetDedupeWindowMs);
      emitBridgedTarget(
        key,
        { name, ts: ev.ts, ...(targetArgs !== undefined ? { args: targetArgs } : {}) },
        effectiveDedupeWindowMs,
      );
    }
  }

  function start(): Promise<void> {
    if (!startPromise) {
      startPromise = (async () => {
        await opts.listen.start(onMessage);
        log('[sync] invalidation bus listening');
      })().catch((e) => {
        // Reset so a later subscribe retries (matches the original behavior).
        startPromise = null;
        onError('listen.start', e);
        throw e;
      });
    }
    return startPromise;
  }

  async function subscribe(
    send: (e: SyncEvent) => void,
    opts?: SubscribeOptions,
  ): Promise<SubscribeHandle> {
    await start();
    const filter = opts?.filter;
    const sub = filter !== undefined ? { send, filter } : { send };
    subscribers.add(sub);
    return { send, close: () => void subscribers.delete(sub) };
  }

  function backfillSince(lastEventId: number): SyncEvent[] {
    pruneHistory();
    return history.filter((e) => e.id > lastEventId);
  }

  function pruneNotifyCache(ts: number): void {
    if (recentNotifies.size < 200) return;
    for (const [k, t] of recentNotifies) {
      if (ts - t > dedupeWindowMs) recentNotifies.delete(k);
    }
  }

  /**
   * Source-side dedupe for explicit app-code invalidate/update calls.
   * Bridged targets use `emitBridgedTarget()` above so repeats retain the
   * latest state for a bounded trailing flush rather than disappearing.
   */
  function shouldFanout(key: string, ts: number, windowMs: number): boolean {
    const last = recentNotifies.get(key);
    if (last !== undefined && ts - last < windowMs) return false;
    recentNotifies.set(key, ts);
    pruneNotifyCache(ts);
    return true;
  }

  async function notifyInvalidate(
    name: string,
    args?: Record<string, unknown>,
    data?: unknown[],
    notifyOpts?: NotifyInvalidateOpts,
  ): Promise<void> {
    let payload: Record<string, unknown> = { name };
    if (args !== undefined) payload.args = args;
    if (data !== undefined) {
      payload.data = data;
      if (JSON.stringify(payload).length > payloadSizeLimit) {
        payload = { name };
        if (args !== undefined) payload.args = args;
      }
    }

    // Source-side dedupe. Data-bearing notifies hash the data into the key
    // so a NEW row set still gets through; pure invalidates collapse. Only
    // a short hash goes into the key — never the payload itself.
    const dataKey = data === undefined ? '' : fnv1a(JSON.stringify(data));
    const key = `${name}|${args ? JSON.stringify(args) : ''}|${dataKey}`;
    const ts = now();
    // Per-call dedupe override. A SELF-DEBOUNCED producer — e.g. the append-heavy
    // change-detector that polls max(id) every ~8s — is already rate-limited by its own
    // cadence, so the bus's 90s default (built to collapse a chatty per-row reconcile)
    // would WRONGLY collapse its legitimate per-tick fires to one per 90s. It passes a
    // short window so each detected change gets through, while the window still collapses
    // a same-tick cross-process burst. (Clamped ≥0; falls back to the bus default.)
    const effDedupeMs = Math.max(0, notifyOpts?.dedupeWindowMs ?? dedupeWindowMs);
    if (!shouldFanout(key, ts, effDedupeMs)) return;

    const publish = Promise.resolve(opts.notify.notify(JSON.stringify(payload)));
    inflightNotifies.add(publish);
    try {
      await publish;
    } catch (e) {
      onError('notify', e);
    } finally {
      inflightNotifies.delete(publish);
    }
  }

  /**
   * Stop the bus:
   *   1. Drops all subscribers immediately — no further fan-out.
   *   2. DRAINS in-flight `notifyInvalidate` sink publishes (a stop during
   *      a write burst doesn't silently discard outbound notifies; their
   *      failures still route to `onError`, never to the stop caller).
   *   3. Stops the ListenSource and resets the lazy-start latch.
   * A `notifyInvalidate` made AFTER stop() still attempts to publish
   * (best-effort against a stopped sink); a later subscribe()/start()
   * restarts the listen source.
   */
  async function stop(): Promise<void> {
    subscribers.clear();
    for (const entry of bridgeWindows.values()) cancelBridgeTimer(entry);
    bridgeWindows.clear();
    if (inflightNotifies.size > 0) {
      await Promise.allSettled([...inflightNotifies]);
    }
    if (opts.listen.stop) await opts.listen.stop();
    startPromise = null;
  }

  return {
    subscribe,
    backfillSince,
    notifyInvalidate,
    start,
    stop,
    historySize: () => history.length,
  };
}
