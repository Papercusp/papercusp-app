/**
 * resilientPostStream — reconnect-safe SSE over a POST request.
 *
 * `EventSource` (and so `createResilientEventSource`) can only GET, but many
 * streams need a request body (a chat turn, a query). This is the POST-capable
 * sibling: it POSTs, reads the response body with {@link parseSseStream}, and —
 * if the connection drops before a terminal event — RESUMES the same logical
 * stream with `Last-Event-ID` + a caller-built resume body, under bounded
 * exponential backoff. The server is expected to keep the turn alive and replay
 * missed events on resume (the prospector reconnect-safe protocol).
 *
 * Yields each JSON-decoded event payload; stops after the first terminal event.
 * Non-JSON `data`, empty `data`, and `skipEvents` (default: heartbeat) are
 * dropped. Generalizes the hand-rolled loop that lived in RecommenderChat.
 */

import { parseSseStream } from './parse-stream';

export interface ResilientPostResume {
  /** Resumable turn id from the response header (see `turnIdHeader`), or null. */
  turnId: string | null;
  /** Highest SSE event id seen so far (sent as Last-Event-ID on resume). */
  lastEventId: number;
}

export interface ResilientPostStreamOptions {
  url: string;
  /** Build the request body. `resume` is null on the first attempt, else the
   *  cursor for a reconnect — return the resume payload (e.g. `{ turnId, lastEventId }`). */
  buildBody: (resume: ResilientPostResume | null) => unknown;
  /** True when a decoded payload is terminal (ends the stream — e.g. `done`/`error`). */
  isTerminal: (data: unknown) => boolean;
  /** Response header carrying the resumable turn id (e.g. `X-Prospector-Turn-Id`). */
  turnIdHeader?: string;
  /** Extra request headers (Content-Type: application/json is always set). */
  headers?: Record<string, string>;
  /** Max resume attempts after the first stream drops. Default 5. */
  maxResumeAttempts?: number;
  /** Backoff ms = min(base * 2^(attempt-1), cap). Defaults: base 400, cap 4000. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** SSE event names to drop (not yielded). Default `['heartbeat']`. */
  skipEvents?: string[];
  /** Abort the stream (and skip pending resumes). */
  signal?: AbortSignal;
  /**
   * Fail the turn when NO SSE frame arrives for this long. Default 0 (off,
   * preserving the historic unbounded behaviour for existing callers).
   *
   * The timer is reset by EVERY parsed frame — heartbeats included, before
   * `skipEvents` drops them — so this measures "the server has gone silent",
   * not "the server has produced no output I wanted to show". Set it above the
   * server's heartbeat interval (10s for @papercusp/sse responses) or a healthy
   * but slow turn will be cut. Also covers a `fetch` that never resolves.
   *
   * An idle expiry is FATAL and skips the resume loop: silence past the
   * heartbeat window means the turn is dead, not that the socket blipped —
   * which is the case the bounded resume budget already handles.
   */
  idleTimeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to setTimeout-based delay. */
  delayImpl?: (ms: number) => Promise<void>;
}

/** Thrown when `idleTimeoutMs` elapses with no SSE frame (heartbeats included). */
export class StreamIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;
  constructor(idleTimeoutMs: number) {
    super(`SSE stream idle for ${idleTimeoutMs}ms`);
    this.name = 'StreamIdleTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

export interface ResilientStreamEvent<T = unknown> {
  /** JSON-decoded `data`. */
  data: T;
  id?: number | string;
  event?: string;
  /** True for the terminal event that ends the stream. */
  terminal: boolean;
}

const defaultDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function* resilientPostStream<T = unknown>(
  opts: ResilientPostStreamOptions,
): AsyncGenerator<ResilientStreamEvent<T>, void, unknown> {
  const {
    url,
    buildBody,
    isTerminal,
    turnIdHeader,
    headers = {},
    maxResumeAttempts = 5,
    backoffBaseMs = 400,
    backoffCapMs = 4000,
    skipEvents = ['heartbeat'],
    signal,
    idleTimeoutMs = 0,
    fetchImpl = fetch,
    delayImpl = defaultDelay,
  } = opts;

  let turnId: string | null = null;
  let lastEventId = 0;
  let completed = false;
  let idleExpired = false;

  async function* openOnce(resume: boolean): AsyncGenerator<ResilientStreamEvent<T>, void, unknown> {
    // The idle guard aborts the request itself, so it unsticks BOTH a fetch that
    // never resolves and a response body that stops producing frames.
    const idle = idleTimeoutMs > 0 ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const rearm = () => {
      if (!idle) return;
      disarm();
      timer = setTimeout(() => { idleExpired = true; idle.abort(); }, idleTimeoutMs);
    };
    const forwardAbort = () => idle?.abort();
    if (idle && signal) {
      if (signal.aborted) idle.abort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
    }
    const requestSignal = idle ? idle.signal : signal;

    let body: ReadableStream<Uint8Array> | null = null;
    try {
      rearm(); // armed BEFORE the fetch: a request that never responds is idle too
      const res = await fetchImpl(url, {
        method: 'POST',
        signal: requestSignal,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(resume && lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
        },
        body: JSON.stringify(buildBody(resume ? { turnId, lastEventId } : null)),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      if (turnIdHeader) turnId = res.headers.get(turnIdHeader) || turnId;
      body = res.body;

      for await (const ev of parseSseStream(res.body)) {
        // Reset on EVERY frame, before skipEvents drops it — a heartbeat is the
        // server proving liveness during a long tool call, so it must count.
        rearm();
        if (ev.event && skipEvents.includes(ev.event)) continue;
        if (ev.id != null && ev.id !== '') lastEventId = Math.max(lastEventId, Number(ev.id));
        if (!ev.data) continue;
        let data: T;
        try { data = JSON.parse(ev.data) as T; } catch { continue; }
        const terminal = isTerminal(data);
        yield { data, id: ev.id, event: ev.event, terminal };
        // Terminal event ends the turn. The reconnect-safe server keeps the SSE
        // connection OPEN after it (so a dropped client can resume), so stop
        // explicitly — else this read loop awaits the next event forever.
        if (terminal) { completed = true; return; }
      }
    } catch (err) {
      // Our own abort surfaces as a generic AbortError; name the real cause.
      if (idleExpired) throw new StreamIdleTimeoutError(idleTimeoutMs);
      throw err;
    } finally {
      disarm();
      signal?.removeEventListener('abort', forwardAbort);
      // Stop reading ⇒ close the still-open connection, else each finished turn
      // leaks an open socket and the per-host pool starves later requests.
      try { await body?.cancel(); } catch { /* already closing */ }
    }
  }

  yield* openOnce(false);

  // Stream ended without a terminal event ⇒ the connection dropped. Resume the
  // same turn from where we left off, with bounded backoff.
  for (let attempt = 1; !completed && !idleExpired && turnId && attempt <= maxResumeAttempts; attempt++) {
    if (signal?.aborted) return;
    await delayImpl(Math.min(backoffBaseMs * 2 ** (attempt - 1), backoffCapMs));
    try {
      yield* openOnce(true);
    } catch (err) {
      // An idle expiry is fatal — resuming into a silent server would multiply
      // the wait by the attempt budget, which is the hang this bounds.
      if (idleExpired) throw err;
      /* else keep retrying until the attempt budget is spent */
    }
  }
}
