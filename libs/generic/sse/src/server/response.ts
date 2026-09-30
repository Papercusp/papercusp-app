/**
 * sseResponse — build a spec-compliant SSE Response.
 *
 * Encapsulates the pattern every SSE route in the operator was implementing
 * by hand: ReadableStream + encoder + heartbeat timer + abort wiring +
 * standard headers. Adds:
 *   - Auto-monotonic event ids (so Last-Event-ID reconnect resumes correctly)
 *   - Initial heartbeat on open
 *   - Late-join terminal short-circuit (no client-hangs after channel is done)
 *   - Ring-buffer replay filtered by Last-Event-ID
 *   - Resume-integrity `resync` control event (opt-in via `resumeBounds`): when a
 *     resuming client's id is below the buffer floor (gap) or above the source max
 *     (restart), emit `resync` + skip partial replay → client refetches full
 *   - Single onClose path for all close triggers (cancel, signal abort, done, close)
 *
 * Wire format is fixed (STABILITY CONTRACT — see README). The lifecycle is
 * deterministic; see comments at sseResponse() body for the open-time order.
 */

import { encodeFrame, heartbeatFrame } from '../wire/format';
import { createIdAllocator } from '../wire/ids';
import { RESUME_CURSOR_PARAM } from '../wire/resume-cursor';
import { unrefTimer } from './unref';

export interface SseSink<TEvents extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Emit a named event. Auto-monotonic id unless explicit `id` provided.
   * Data is JSON-stringified. No-op after close.
   */
  event<K extends keyof TEvents & string>(
    name: K,
    data: TEvents[K],
    opts?: { id?: number | string }
  ): void;

  /**
   * Emit a named event with pre-formatted string data (NO JSON.stringify wrap).
   * Use for line-streaming or raw-text protocols (e.g. LLM token deltas).
   * For most cases prefer `event()` — this is the escape hatch.
   */
  eventRaw(
    name: string,
    data: string,
    opts?: { id?: number | string }
  ): void;

  /** Comment line. Use sparingly — prefer `heartbeat()` for keepalive. */
  comment(text: string): void;

  /**
   * Send a heartbeat event NOW (in addition to the timer).
   * Always `event: heartbeat\ndata: {"tsMs":<now>}`. No id.
   */
  heartbeat(): void;

  /**
   * Emit terminal `done` event with optional payload, then close.
   * Idempotent.
   */
  done(payload?: unknown): void;

  /** Force-close without emitting `done`. For error paths. Idempotent. */
  close(): void;

  /**
   * Register cleanup; runs exactly once on the first of:
   *   signal abort | ReadableStream cancel() | sink.done() | sink.close()
   */
  onClose(fn: () => void): void;

  /** True after first of done()/close()/cancel(). */
  readonly closed: boolean;
}

export interface SseResponseOptions<TEvents extends Record<string, unknown>> {
  /** Required — typically `req.signal`. Triggers cleanup on client disconnect. */
  signal: AbortSignal;

  /** Parsed Last-Event-ID. null = no resume. */
  lastEventId?: number | null;

  /**
   * Invoked once after replay completes. Use sink to publish.
   * If this rejects, sink auto-emits `event: error` with the message, then closes.
   */
  setup: (sink: SseSink<TEvents>) => void | Promise<void>;

  /** Heartbeat interval ms; 0 disables. Default 10_000 — P2-3
   *  (operator-scalability-event-loop-2026-06-16): a faster beat means a
   *  momentarily-lagged loop is likelier to still emit one within the client's
   *  (now wider) zombie-grace window, instead of tripping a false reconnect. */
  heartbeatMs?: number;

  /** Send a heartbeat at open to confirm liveness. Default true. */
  initialHeartbeat?: boolean;

  /**
   * Close when the response body remains backpressured for this long. Default
   * 30_000ms; set 0 to disable.
   *
   * A direct Web `Response` consumer can read a few frames and then abandon
   * the reader without calling `cancel()`. In that state neither the request
   * signal nor the stream's cancel hook fires, so a long-lived setup loop
   * otherwise keeps producing forever and the unread body queue grows without
   * bound. Normal HTTP adapters continuously drain this Web stream and apply
   * socket backpressure separately, so sustained `desiredSize <= 0` here means
   * the response itself has no active consumer.
   */
  backpressureTimeoutMs?: number;

  /**
   * Optional ring-buffer replay. Called once at open AFTER lastEventId is
   * resolved; lib filters items whose id <= lastEventId.
   */
  replay?: () => Iterable<{ name: keyof TEvents & string; data: TEvents[keyof TEvents]; id: number }>;

  /**
   * Optional resume-INTEGRITY bounds (the source's current [floorId, maxId] —
   * for a ring buffer: `{ floorId: ch.recent[0].id, maxId: ch.recent.at(-1).id }`).
   * When the client resumes (lastEventId set), the lib checks whether the resume
   * point is still recoverable from replay:
   *   - `lastEventId + 1 < floorId` → the events the client needs were EVICTED
   *     from the buffer (a silent GAP — replay would skip them);
   *   - `lastEventId > maxId`       → the client's id is AHEAD of the source
   *     (the channel/process restarted and ids reset — the client's baseline is
   *     from a dead generation, so future lower ids would be filtered out).
   * In either case the client cannot safely resume, so the lib emits the
   * reserved `resync` control event (`{ reason: 'gap' | 'ahead', fromId, floorId,
   * maxId }`) and SKIPS the partial replay — the client must DISCARD local state
   * and refetch the full snapshot, then resume live. Without it, a resume past the
   * buffer floor (or after a restart) silently diverges — the exact wrong-merge
   * this protocol exists to retire. OPT-IN: omit it (or for append-only streams
   * with no full-refetch fallback) ⇒ no integrity check, legacy replay behaviour.
   */
  resumeBounds?: () => { floorId: number; maxId: number } | null;

  /**
   * If the source is already terminal at open, emit `done` with the returned
   * payload and close immediately. Client doesn't hang waiting for events
   * that will never come.
   */
  terminalShortCircuit?: () => null | { reason: string; payload?: unknown };

  /** Extra response headers (merged over defaults). */
  headers?: HeadersInit;
}

const DEFAULT_HEADERS: HeadersInit = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * Bridge an async iterable into the sink, emitting one event per item.
 *
 * Handles two cleanup paths producers always need but easily forget:
 *   - When sink closes (client disconnect, done, error): we call `.return()`
 *     on the underlying iterator so the producing channel gets unsubscribed.
 *   - When the source iteration ends naturally: we leave the sink open
 *     (it's the caller's choice whether to also call sink.done()).
 *
 * Usage:
 *   setup: (sink) => bridgeChannel(ch.subscribe(), sink, ({ id, event }) =>
 *     ({ name: 'update', data: event, opts: { id } })
 *   ),
 */
export async function bridgeChannel<TItem, TEvents extends Record<string, unknown>>(
  source: AsyncIterable<TItem>,
  sink: SseSink<TEvents>,
  map: (item: TItem) => {
    name: keyof TEvents & string;
    // Mirror the `name` key constraint so `sink.event<K>(name, data)` (whose
    // K extends `keyof TEvents & string`) accepts `data` — `TEvents[keyof TEvents]`
    // and `TEvents[keyof TEvents & string]` are distinct index types to tsc.
    data: TEvents[keyof TEvents & string];
    opts?: { id?: number | string };
  } | null,
): Promise<void> {
  const iter = source[Symbol.asyncIterator]();
  sink.onClose(() => { void iter.return?.(undefined); });
  while (!sink.closed) {
    const { value, done } = await iter.next();
    if (done) return;
    const out = map(value);
    if (out) sink.event(out.name, out.data, out.opts);
  }
}

/**
 * Parse the client's resume point as a positive integer; null if absent or invalid.
 *
 * Reads the `Last-Event-ID` HEADER first, then falls back to the
 * {@link RESUME_CURSOR_PARAM} query parameter (WI-2141694).
 *
 * The fallback is not redundancy. A browser sets the header only when IT
 * reconnects an EventSource instance it already owns; every deliberate close
 * in `resilient-event-source.ts` (visibility pause, bfcache pagehide, zombie
 * rebuild, backoff, manual `reconnect()`) constructs a NEW EventSource, which
 * sends no header and cannot be given one. Without this, such a resume reads
 * as a fresh subscriber and the stream either re-delivers the whole ring
 * buffer or silently skips whatever was emitted while it was closed.
 *
 * Header WINS when both are present: the browser's own native reconnect knows
 * the true instance cursor, and a stale param left on a URL must never
 * override it.
 */
export function parseLastEventId(req: Request): number | null {
  const header = req.headers.get('Last-Event-ID');
  const raw = header ?? readResumeCursorParam(req);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The query-param half of {@link parseLastEventId}. Never throws on a malformed url. */
function readResumeCursorParam(req: Request): string | null {
  try {
    return new URL(req.url).searchParams.get(RESUME_CURSOR_PARAM);
  } catch {
    return null;
  }
}

export function sseResponse<TEvents extends Record<string, unknown> = Record<string, unknown>>(
  opts: SseResponseOptions<TEvents>
): Response {
  const ids = createIdAllocator(opts.lastEventId ?? 0);
  const heartbeatMs = opts.heartbeatMs ?? 10_000;
  const initialHeartbeat = opts.initialHeartbeat ?? true;
  const backpressureTimeoutMs = Math.max(0, opts.backpressureTimeoutMs ?? 30_000);
  const sinceId = opts.lastEventId ?? 0;

  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let backpressureTimer: ReturnType<typeof setTimeout> | null = null;
  const closeHandlers: Array<() => void> = [];

  const clearBackpressureTimer = (): void => {
    if (!backpressureTimer) return;
    clearTimeout(backpressureTimer);
    backpressureTimer = null;
  };

  const trackBackpressure = (): void => {
    if (closed || !controllerRef || backpressureTimeoutMs === 0) return;
    const desiredSize = controllerRef.desiredSize;
    if (desiredSize == null || desiredSize > 0) {
      clearBackpressureTimer();
      return;
    }
    if (backpressureTimer) return;
    backpressureTimer = setTimeout(() => {
      backpressureTimer = null;
      if (!closed && controllerRef != null && (controllerRef.desiredSize ?? 1) <= 0) {
        runClose();
      }
    }, backpressureTimeoutMs);
    unrefTimer(backpressureTimer);
  };

  const enqueue = (bytes: Uint8Array): void => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(bytes);
      trackBackpressure();
    } catch {
      // Controller already closed by upstream; mark closed and run cleanup.
      runClose();
    }
  };

  const runClose = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearBackpressureTimer();
    // Run handlers in registration order; swallow errors so one bad handler
    // doesn't block the others.
    for (const fn of closeHandlers) {
      try { fn(); } catch { /* ignore */ }
    }
    try { controllerRef?.close(); } catch { /* already closed */ }
    controllerRef = null;
  };

  const sink: SseSink<TEvents> = {
    event(name, data, eventOpts) {
      if (closed) return;
      const id = eventOpts?.id ?? ids.next();
      enqueue(encodeFrame({ id, event: name, data: JSON.stringify(data) }));
    },
    eventRaw(name, data, eventOpts) {
      if (closed) return;
      const id = eventOpts?.id ?? ids.next();
      enqueue(encodeFrame({ id, event: name, data }));
    },
    comment(text) {
      if (closed) return;
      const bytes = new TextEncoder().encode(`: ${text}\n\n`);
      enqueue(bytes);
    },
    heartbeat() {
      if (closed) return;
      enqueue(heartbeatFrame());
    },
    done(payload) {
      if (closed) return;
      enqueue(encodeFrame({ event: 'done', data: JSON.stringify(payload ?? null) }));
      runClose();
    },
    close() {
      runClose();
    },
    onClose(fn) {
      if (closed) {
        try { fn(); } catch { /* ignore */ }
        return;
      }
      closeHandlers.push(fn);
    },
    get closed() { return closed; },
  };

  // Pre-wire the abort signal — fires before/during start() if client
  // disconnects before we even open.
  const onAbort = () => runClose();
  if (opts.signal.aborted) {
    // Client already gone; we still return a response, but it'll close
    // immediately after start() runs.
    queueMicrotask(runClose);
  } else {
    opts.signal.addEventListener('abort', onAbort, { once: true });
    // Register a cleanup to remove the listener once we run close (avoids
    // a lingering listener if close fires for other reasons).
    sink.onClose(() => opts.signal.removeEventListener('abort', onAbort));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      // Lifecycle step 1: terminal short-circuit.
      const term = opts.terminalShortCircuit?.();
      if (term) {
        sink.done(term);
        return;
      }

      // Step 2: initial heartbeat (confirms liveness to the client).
      if (initialHeartbeat) {
        enqueue(heartbeatFrame());
      }

      // Step 2.5: resume-integrity check. If the client is resuming but its
      // resume point is no longer recoverable from the buffer (events evicted →
      // 'gap', or its id is ahead of the source after a restart → 'ahead'), emit
      // the reserved `resync` control event and SKIP partial replay — the client
      // must discard local state + refetch the full snapshot. This is the
      // standardized fallback-to-full that stops a silent post-eviction divergence.
      let resynced = false;
      if (opts.lastEventId != null && opts.lastEventId > 0 && opts.resumeBounds) {
        const b = opts.resumeBounds();
        if (b) {
          const reason =
            opts.lastEventId > b.maxId ? 'ahead' : opts.lastEventId + 1 < b.floorId ? 'gap' : null;
          if (reason) {
            enqueue(
              encodeFrame({
                event: 'resync',
                data: JSON.stringify({ reason, fromId: opts.lastEventId, floorId: b.floorId, maxId: b.maxId }),
              }),
            );
            resynced = true;
          }
        }
      }

      // Step 3: replay backfill, filtered by lastEventId. Skipped after a resync —
      // the client is refetching the full snapshot, so a partial backfill is moot.
      if (opts.replay && !resynced) {
        try {
          for (const item of opts.replay()) {
            if (item.id <= sinceId) continue;
            // Advance id allocator so post-replay events don't collide.
            ids.setFloor(item.id);
            enqueue(encodeFrame({
              id: item.id,
              event: item.name,
              data: JSON.stringify(item.data),
            }));
          }
        } catch (err) {
          enqueue(encodeFrame({
            event: 'error',
            data: JSON.stringify({ phase: 'replay', message: String(err instanceof Error ? err.message : err) }),
          }));
          runClose();
          return;
        }
      }

      // Step 4: heartbeat timer.
      if (heartbeatMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (closed) return;
          enqueue(heartbeatFrame());
        }, heartbeatMs);
        unrefTimer(heartbeatTimer);
      }

      // Step 5: setup. Async — runs concurrently with anything else the
      // caller registers via sink.event / sink.onClose etc.
      Promise.resolve(opts.setup(sink)).catch((err) => {
        if (closed) return;
        enqueue(encodeFrame({
          event: 'error',
          data: JSON.stringify({ phase: 'setup', message: String(err instanceof Error ? err.message : err) }),
        }));
        runClose();
      });
    },
    cancel() {
      runClose();
    },
    pull() {
      // A pull means the consumer is draining again. The next enqueue will
      // re-arm the deadline if it falls behind once more.
      clearBackpressureTimer();
    },
  });

  const headers = new Headers(DEFAULT_HEADERS);
  if (opts.headers) {
    const overrides = new Headers(opts.headers);
    overrides.forEach((value, key) => headers.set(key, value));
  }

  return new Response(stream, { headers });
}
