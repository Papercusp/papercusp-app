/**
 * A decision transport whose answer survives a busy calling thread
 * (plan jev-memory-timeouts-to-zero-2026-10-01 P-008, evidence D-003).
 *
 * WHY. An in-thread fetch needs the calling thread's event loop to connect, send,
 * and read the response. When that thread is blocked (a synchronous fs walk, a long
 * callback, a GC), the request may not even be sent before the deadline, and an
 * answer that did arrive sits unread in the socket. Production measured 17 of 21
 * remaining timeouts with the calling thread's event-loop utilization at 0.9 or
 * more. The one-phase abort deferral in `createDeadline` (P-007) rescues only an
 * answer that a single poll phase can read in full.
 *
 * HOW. The HTTP exchange runs on one worker thread per transport. The worker owns a
 * keep-alive agent, sends the request at once, reads the whole response, and posts
 * `{ status, headers, text, transportMs }` on a per-call MessagePort. That is the
 * decisive change: the request goes out and the answer is complete however busy the
 * calling thread is, and handing it over is then ONE event. The calling thread
 * receives it in one of two ways:
 *  - as a 'message' event. After a block, that event is dispatched in the poll phase,
 *    which runs before the client's deferred abort (P-007), so it already wins;
 *  - when the deadline timer fires, by `receiveMessageOnPort`, synchronously, inside
 *    the client's deadline hook. This makes the hand-over independent of the order
 *    in which the loop dispatches the port message and the abort. Measured
 *    2026-10-02 with the hook stripped: the answer was still rescued, so the drain
 *    is a guarantee, not the fix.
 *
 * The worker enforces the same deadline on its own loop, so a provider that is
 * genuinely slow still times out at the deadline, measured where the request runs.
 *
 * The worker source is a CommonJS string evaluated with `eval: true` and uses only
 * Node built-ins. That keeps it free of the two failure classes a worker FILE has in
 * this repo: a host bundle that does not stage the file beside its entry, and a
 * `.ts` entry that the worker cannot load without the parent's loader hooks.
 */
import { performance } from 'node:perf_hooks';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';
import type { FetchLike } from './client.js';
import { describeError, type ErrorFields } from './error-detail.js';

/** Budget used when a caller passes no deadline. The client always passes one. */
const NO_DEADLINE_BUDGET_MS = 30_000;
/** Worker deaths after which the transport stops restarting it and uses the fallback. */
export const WORKER_TRANSPORT_MAX_FAILURES = 3;

const WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');

const idleMs = workerData.keepAliveIdleMs;

// Resolved addresses per host (EI-24748208098755918). A new connection otherwise looks
// its host up with getaddrinfo, which runs on the process-wide libuv threadpool (shared
// with the calling thread's file I/O) and then on the system resolver; either can hold
// the lookup for hundreds of ms while this worker sits idle. A cached answer uses
// neither. An entry is served as is while fresh; once stale it is still served while one
// background lookup refreshes it; past the stale limit the call looks it up again. A
// connect error drops the host's entries.
const DNS_FRESH_MS = 60000;
const DNS_STALE_MS = 600000;
const dnsCache = new Map();

function dnsKey(hostname, options) {
  return hostname + '|' + (options.family || 0) + '|' + (options.hints || 0);
}

function resolveInto(key, hostname, options, done) {
  dns.lookup(hostname, { family: options.family || 0, hints: options.hints || 0, all: true }, (err, addresses) => {
    const found = !err && Array.isArray(addresses) && addresses.length > 0;
    if (found) {
      dnsCache.set(key, { addresses, at: Date.now(), refreshing: false });
    } else {
      const entry = dnsCache.get(key);
      if (entry) entry.refreshing = false;
    }
    if (!done) return;
    if (found) done(null, addresses);
    else done(err || Object.assign(new Error('no address for ' + hostname), { code: 'ENOTFOUND' }));
  });
}

function answerLookup(addresses, options, callback) {
  if (options.all) callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
  else callback(null, addresses[0].address, addresses[0].family);
}

// A lookup() for net.connect that answers from dnsCache and records into conn how it did.
function cachedLookup(conn, started) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    } else {
      options = options || {};
    }
    const key = dnsKey(hostname, options);
    const entry = dnsCache.get(key);
    const age = entry ? Date.now() - entry.at : Infinity;
    if (entry && age < DNS_STALE_MS) {
      conn.dns = age < DNS_FRESH_MS ? 'cache' : 'stale';
      if (age >= DNS_FRESH_MS && !entry.refreshing) {
        entry.refreshing = true;
        resolveInto(key, hostname, options, null);
      }
      const addresses = entry.addresses;
      // Answer on a later turn, as dns.lookup does, so the socket's listeners are attached first.
      setImmediate(() => {
        conn.lookupMs = performance.now() - started;
        answerLookup(addresses, options, callback);
      });
      return;
    }
    conn.dns = 'resolver';
    resolveInto(key, hostname, options, (err, addresses) => {
      conn.lookupMs = performance.now() - started;
      if (err) callback(err);
      else answerLookup(addresses, options, callback);
    });
  };
}

function forgetHost(hostname) {
  for (const key of [...dnsCache.keys()]) {
    if (key.startsWith(hostname + '|')) dnsCache.delete(key);
  }
}

// An attempt is recorded as its address; a failed one gains '!' and its code.
function markAttempt(conn, ip, outcome) {
  for (let i = conn.attempts.length - 1; i >= 0; i -= 1) {
    if (conn.attempts[i] === ip) {
      conn.attempts[i] = ip + '!' + outcome;
      return;
    }
  }
  conn.attempts.push(ip + '!' + outcome);
}
// keepAlive keeps the socket between calls; timeout is the idle limit of a pooled
// socket (the agent destroys a free socket when it fires). A server Keep-Alive hint
// can only shorten it.
const agents = {
  'http:': new http.Agent({ keepAlive: true, timeout: idleMs }),
  'https:': new https.Agent({ keepAlive: true, timeout: idleMs }),
};

function clock() {
  return performance.timeOrigin + performance.now();
}

// Plain fields of a thrown value, so the calling side can describe it (WI-10005372).
// Node reports a connect that failed on every address of a host as an AggregateError
// whose message is EMPTY; the cause is only in code and errors. Mirrors errorFields()
// in error-detail.ts (this source cannot import it); the tests pin the two together.
function errorFields(err, depth) {
  depth = depth || 0;
  if (typeof err !== 'object' || err === null) {
    return { name: 'Error', message: err === undefined ? '' : String(err), code: null, errors: [], cause: null };
  }
  const nested = depth < 3 && Array.isArray(err.errors) ? err.errors.slice(0, 4) : [];
  return {
    name: typeof err.name === 'string' && err.name !== '' ? err.name : 'Error',
    message: typeof err.message === 'string' ? err.message.trim() : '',
    code: typeof err.code === 'string' || typeof err.code === 'number' ? String(err.code) : null,
    errors: nested.map((inner) => errorFields(inner, depth + 1)),
    cause: depth < 3 && err.cause !== undefined && err.cause !== null ? errorFields(err.cause, depth + 1) : null,
  };
}

function flattenHeaders(raw) {
  const out = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

parentPort.on('message', (call) => {
  const port = call.port;
  const started = performance.now();
  // Time the call waited between the calling thread posting it and this worker taking it.
  const queuedMs = typeof call.postedAt === 'number' ? Math.max(0, clock() - call.postedAt) : null;
  const controller = new AbortController();
  let done = false;
  let timer = null;
  let phase = 'started';
  // How this call's connection was made, so a timeout names the leg it stalled in
  // (EI-24748208098755918). Times are ms since the worker took the call; null = not reached.
  const conn = { socket: 'none', secure: false, dns: null, lookupMs: null, connectMs: null, tlsMs: null, attempts: [] };
  function connSnapshot() {
    return {
      socket: conn.socket,
      secure: conn.secure,
      dns: conn.dns,
      lookupMs: conn.lookupMs,
      connectMs: conn.connectMs,
      tlsMs: conn.tlsMs,
      attempts: conn.attempts.slice(0, 6),
    };
  }

  // Tell the calling side how far the request got, so a deadline that passes on the
  // calling side before this worker replies still knows where the call was. Called
  // again within a phase as each connection leg completes.
  function progress(next) {
    if (done) return;
    phase = next;
    try {
      port.postMessage({ progress: next, atMs: performance.now() - started, queuedMs, conn: connSnapshot() });
    } catch {
      // The calling side already closed the port: nobody is waiting.
    }
  }

  function reply(message) {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    message.transportMs = performance.now() - started;
    message.phase = phase;
    message.queuedMs = queuedMs;
    message.conn = connSnapshot();
    try {
      port.postMessage(message);
    } catch {
      // The calling side already closed the port: nobody is waiting.
    }
  }
  progress('started');

  // The calling side closes the port once it has an outcome. If that happened before
  // the response completed (it gave up), stop the request. After a reply there is
  // nothing to stop, and the socket is already back in the pool.
  port.on('close', () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  });

  timer = setTimeout(() => {
    controller.abort();
    reply({ ok: false, timedOut: true, error: 'transport deadline passed before the response completed' });
  }, Math.max(0, call.expiresAt - clock()));

  let url;
  try {
    url = new URL(call.url);
  } catch {
    reply({ ok: false, error: 'invalid url' });
    return;
  }
  const lib = url.protocol === 'https:' ? https : url.protocol === 'http:' ? http : null;
  if (!lib) {
    reply({ ok: false, error: 'unsupported protocol ' + url.protocol });
    return;
  }

  const body = Buffer.from(call.body, 'utf8');
  const headers = {};
  for (const [name, value] of Object.entries(call.headers)) {
    if (name.toLowerCase() !== 'content-length') headers[name] = value;
  }
  headers['content-length'] = String(body.length);

  conn.secure = url.protocol === 'https:';
  const req = lib.request(
    url,
    {
      method: call.method,
      headers,
      agent: agents[url.protocol],
      signal: controller.signal,
      // Used only when the agent opens a new socket for a host name (not an IP literal).
      lookup: cachedLookup(conn, started),
    },
    (res) => {
      progress('headers');
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        reply({
          ok: true,
          status: res.statusCode || 0,
          headers: flattenHeaders(res.headers),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', (err) => reply({ ok: false, error: errorFields(err) }));
      res.on('close', () => {
        if (!res.complete) reply({ ok: false, error: 'response closed before it completed' });
      });
    },
  );
  req.on('socket', (socket) => {
    conn.socket = req.reusedSocket ? 'reused' : 'new';
    if (req.reusedSocket) {
      progress(phase);
      return;
    }
    socket.once('lookup', () => progress(phase));
    socket.on('connectionAttempt', (ip) => conn.attempts.push(ip));
    socket.on('connectionAttemptFailed', (ip, _port, _family, err) => markAttempt(conn, ip, (err && err.code) || 'failed'));
    socket.on('connectionAttemptTimeout', (ip) => markAttempt(conn, ip, 'timeout'));
    socket.once('connect', () => {
      conn.connectMs = performance.now() - started;
      progress(phase);
    });
    socket.once('secureConnect', () => {
      conn.tlsMs = performance.now() - started;
      progress(phase);
    });
  });
  req.on('error', (err) => {
    // A new connection that failed to connect: the cached address may be the cause. Not
    // after a reply or a caller close (done): that error is our own abort of a call that
    // ran out of time, which says nothing about the address.
    if (!done && conn.socket === 'new' && conn.connectMs === null) forgetHost(url.hostname);
    reply({ ok: false, error: errorFields(err) });
  });
  req.on('finish', () => progress('sent'));
  req.end(body);
});
`;

/** Test seam: the worker source, so a test can pin its errorFields() copy to error-detail.ts. */
export const WORKER_SOURCE_FOR_TEST = WORKER_SOURCE;

/** What the worker posts back for one call. */
type WorkerReply = (
  | { ok: true; status: number; headers: Record<string, string>; text: string }
  /** `error` is plain fields for a request/response error, a fixed string for the worker's own refusals. */
  | { ok: false; error: string | ErrorFields; timedOut?: boolean }
) & {
  transportMs: number;
  /** How far the request got: started (not fully sent), sent (no response headers yet), headers. */
  phase: WorkerPhase;
  /** Time the call waited for the worker to take it, ms; null if not measurable. */
  queuedMs: number | null;
  /** How the call's connection was made (absent from a pre-EI-24748208098755918 worker). */
  conn?: ConnTiming;
};

type WorkerPhase = 'started' | 'sent' | 'headers';

/**
 * How the worker made a call's connection, so a timeout in phase=started names the
 * leg it stalled in (EI-24748208098755918). Times are ms since the worker took the
 * call; null = that leg had not completed.
 */
export interface ConnTiming {
  /** 'reused' = an idle pooled socket; 'new' = this call opened one; 'none' = no socket yet. */
  socket: 'none' | 'new' | 'reused';
  /** https: a new socket also needs a TLS handshake. */
  secure: boolean;
  /** Where a new socket's address came from; null = no lookup ran (reused socket or an IP literal). */
  dns: 'cache' | 'stale' | 'resolver' | null;
  lookupMs: number | null;
  connectMs: number | null;
  tlsMs: number | null;
  /** Addresses tried, in order; a failed one is `<address>!<code>`, a timed-out one `<address>!timeout`. */
  attempts: string[];
}

/** Posted by the worker each time a call reaches a new phase or connection leg, before its final reply. */
interface WorkerProgress {
  progress: WorkerPhase;
  atMs: number;
  queuedMs: number | null;
  conn?: ConnTiming;
}

function ms(value: number | null): string {
  return value === null ? 'unknown' : `${Math.round(value)}ms`;
}

function leg(value: number | null): string {
  return value === null ? 'pending' : `${Math.round(value)}ms`;
}

/** The connection part of a timeout detail: empty when the worker sent none. */
export function describeConn(conn: ConnTiming | undefined): string {
  if (!conn) return '';
  if (conn.socket !== 'new') return `, conn=${conn.socket}`;
  const parts = ['new'];
  if (conn.dns) parts.push(`dns=${conn.dns}`, `lookup=${leg(conn.lookupMs)}`);
  parts.push(`connect=${leg(conn.connectMs)}`);
  if (conn.secure) parts.push(`tls=${leg(conn.tlsMs)}`);
  // The address list matters when connecting stalled or an address failed.
  if (conn.attempts.length > 0 && (conn.connectMs === null || conn.attempts.some((a) => a.includes('!')))) {
    parts.push(`attempts=${conn.attempts.join(',')}`);
  }
  return `, conn=${parts.join(' ')}`;
}

/** The ledger detail for a call the worker itself stopped at the deadline. */
export function describeWorkerTimeout(reply: {
  transportMs: number;
  phase: WorkerPhase;
  queuedMs: number | null;
  conn?: ConnTiming;
}): string {
  return `worker deadline at ${ms(reply.transportMs)}: phase=${reply.phase}, queued=${ms(reply.queuedMs)}${describeConn(reply.conn)}`;
}

/** The ledger detail for a call whose deadline passed on the calling side before the worker replied. */
export function describeNoWorkerReply(last: WorkerProgress | null): string {
  return last
    ? `caller deadline, no worker reply: phase=${last.progress} at ${ms(last.atMs)}, queued=${ms(last.queuedMs)}${describeConn(last.conn)}`
    : 'caller deadline, no worker reply: phase=none (the worker had not started the call)';
}

export type WorkerTransportEvent =
  /** The worker died; calls in flight failed. It is restarted on the next call. */
  | { kind: 'worker-lost'; error: string; failures: number }
  /** The worker died too often; every later call goes through the fallback (or fails). */
  | { kind: 'fallback'; reason: string; hasFallback: boolean };

export interface WorkerTransportOptions {
  /** Idle time a pooled socket is kept by the worker's agent. */
  readonly keepAliveIdleMs: number;
  /**
   * Used for every call after the worker died {@link WORKER_TRANSPORT_MAX_FAILURES}
   * times. Without one, those calls fail (the client records network-error).
   */
  readonly fallback?: FetchLike;
  /** Told when the worker dies or the transport switches to the fallback. Never awaited. */
  readonly onEvent?: (event: WorkerTransportEvent) => void;
}

export interface WorkerTransport {
  readonly fetch: FetchLike;
  /** Which path calls take now. */
  mode(): 'worker' | 'fallback' | 'closed';
  /** Stop the worker. Calls in flight fail; later calls fail. */
  close(): Promise<void>;
  /** Test-only: terminate the current worker as a crash would (counts as a failure). */
  __killWorkerForTest(): Promise<void>;
}

function timeoutError(message: string): Error {
  return new DOMException(message, 'TimeoutError');
}

/** Rebuild a thrown value from its posted fields, so `describeError` renders it as the worker saw it. */
function rebuild(fields: ErrorFields): Error {
  const err = new Error(fields.message) as Error & { code?: string; errors?: Error[] };
  err.name = fields.name;
  if (fields.code !== null) err.code = fields.code;
  if (fields.errors.length > 0) err.errors = fields.errors.map(rebuild);
  if (fields.cause) err.cause = rebuild(fields.cause);
  return err;
}

/**
 * The error a failed fallback-mode call rejects with: it names the fallback transport
 * (the calling thread) and carries the original error as its `cause`, so a
 * network-error detail says which transport failed (WI-10005372). Abort and timeout
 * errors pass through unchanged because the client classifies them by name.
 */
function fallbackFailure(err: unknown): unknown {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') return err;
  const tagged = new Error('fallback transport (calling thread) failed', { cause: err });
  tagged.name = 'FallbackTransportError';
  return tagged;
}

/**
 * The error a failed worker call rejects with: it names the transport, how far the
 * request got and when, and carries what the worker caught as its `cause` (WI-10005372).
 */
function workerFailure(reply: { error: string | ErrorFields; transportMs: number; phase: WorkerPhase }): Error {
  const caught = typeof reply.error === 'string' ? new Error(reply.error) : rebuild(reply.error);
  const err = new Error(`phase=${reply.phase} after ${ms(reply.transportMs)}`, { cause: caught });
  err.name = 'WorkerTransportError';
  return err;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

export function createWorkerTransport(options: WorkerTransportOptions): WorkerTransport {
  let worker: Worker | null = null;
  let failures = 0;
  let mode: 'worker' | 'fallback' | 'closed' = 'worker';
  /** Fail functions of calls waiting on the current worker. */
  const pending = new Set<(err: Error) => void>();

  function emit(event: WorkerTransportEvent): void {
    try {
      options.onEvent?.(event);
    } catch {
      // A faulty listener must not reach the call path.
    }
  }

  function failPending(err: Error): void {
    const waiting = [...pending];
    pending.clear();
    for (const fail of waiting) fail(err);
  }

  function lost(w: Worker, err: Error): void {
    if (worker !== w) return; // 'error' and 'exit' both fire for one death.
    worker = null;
    failures += 1;
    failPending(err);
    emit({ kind: 'worker-lost', error: describeError(err), failures });
    if (failures >= WORKER_TRANSPORT_MAX_FAILURES && mode === 'worker') {
      mode = 'fallback';
      emit({ kind: 'fallback', reason: `transport worker died ${failures} times`, hasFallback: Boolean(options.fallback) });
    }
  }

  function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(WORKER_SOURCE, {
      eval: true,
      // The worker needs no loader hooks; inheriting the parent's (tsx) would only slow its start.
      execArgv: [],
      workerData: { keepAliveIdleMs: options.keepAliveIdleMs },
    });
    // An idle transport must not keep the process alive; a call in flight does, through its port.
    w.unref();
    w.on('error', (err) => lost(w, err instanceof Error ? err : new Error(String(err))));
    w.on('exit', (code) => lost(w, new Error(`transport worker exited with code ${code}`)));
    worker = w;
    return w;
  }

  const fetchViaWorker: FetchLike = (url, init) => {
    if (init.signal.aborted) return Promise.reject(abortReason(init.signal));
    const w = ensureWorker();
    const { port1, port2 } = new MessageChannel();
    const expiresAt = init.deadline?.expiresAt ?? performance.timeOrigin + performance.now() + NO_DEADLINE_BUDGET_MS;

    return new Promise((resolve, reject) => {
      let settled = false;
      let unhook: () => void = () => {};

      function settle(finish: () => void): void {
        if (settled) return;
        settled = true;
        unhook();
        init.signal.removeEventListener('abort', onAbort);
        pending.delete(onLost);
        port1.close();
        finish();
      }

      function accept(reply: WorkerReply): void {
        settle(() => {
          if (reply.ok) {
            const headers = reply.headers;
            resolve({
              status: reply.status,
              headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
              text: async () => reply.text,
              transportLatencyMs: reply.transportMs,
            });
          } else {
            if (reply.timedOut) {
              init.deadline?.reportIncomplete({ elapsedMs: reply.transportMs, detail: describeWorkerTimeout(reply) });
            }
            reject(reply.timedOut ? timeoutError(String(reply.error)) : workerFailure(reply));
          }
        });
      }

      let lastProgress: WorkerProgress | null = null;
      function handle(message: WorkerReply | WorkerProgress): void {
        if ('progress' in message) lastProgress = message;
        else accept(message);
      }

      /** Take what the worker already posted, without waiting for this thread's loop. */
      function drain(): void {
        while (!settled) {
          const got = receiveMessageOnPort(port1);
          if (!got) return;
          handle(got.message as WorkerReply | WorkerProgress);
        }
      }

      function onAbort(): void {
        drain();
        if (settled) return;
        init.deadline?.reportIncomplete({ elapsedMs: null, detail: describeNoWorkerReply(lastProgress) });
        settle(() => reject(abortReason(init.signal)));
      }

      function onLost(err: Error): void {
        settle(() => reject(err));
      }

      port1.on('message', (message: WorkerReply | WorkerProgress) => handle(message));
      init.signal.addEventListener('abort', onAbort, { once: true });
      if (init.deadline) unhook = init.deadline.onExpiring(drain);
      pending.add(onLost);
      try {
        w.postMessage(
          {
            url,
            method: init.method,
            headers: init.headers,
            body: init.body,
            expiresAt,
            postedAt: performance.timeOrigin + performance.now(),
            port: port2,
          },
          [port2],
        );
      } catch (err) {
        onLost(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    fetch: (url, init) => {
      if (mode === 'worker') return fetchViaWorker(url, init);
      if (mode === 'fallback' && options.fallback) {
        return options.fallback(url, init).catch((err: unknown) => {
          throw fallbackFailure(err);
        });
      }
      return Promise.reject(new Error(mode === 'closed' ? 'worker transport closed' : 'worker transport unavailable'));
    },
    mode: () => mode,
    async close() {
      mode = 'closed';
      const w = worker;
      worker = null;
      failPending(new Error('worker transport closed'));
      if (w) await w.terminate();
    },
    async __killWorkerForTest() {
      const w = worker;
      if (w) await w.terminate();
    },
  };
}
