/**
 * Jev transport — keep ONE connection to api.typesafe.ai open between decision calls
 * (plan jev-memory-timeouts-to-zero-2026-10-01 P-006, EI-24748208098755918).
 *
 * Why this exists (measured 2026-10-01 21:20-21:35Z):
 *  - Global `fetch` uses undici's default dispatcher, which closes a socket after
 *    4 s idle when the server sends no `Keep-Alive` hint (api.typesafe.ai sends none).
 *  - Each operator process calls Jev roughly every 10 s, so the socket was almost
 *    always gone: a 75 s bpftrace connect() probe counted 48 new TCP connections to
 *    the Jev IPs against ~75 ledger calls.
 *  - A new connection costs a getaddrinfo on the 4-thread libuv pool (queued behind
 *    any async fs work on a busy host) plus TCP and TLS: +30-90 ms after a short idle,
 *    400-1400 ms fully cold — against the 800 ms decision budget. A reused socket
 *    answers the same transport probe in ~107 ms p50.
 *
 * The idle window is a deliberate number below the server's own idle limit: if we
 * keep a socket the server has already closed, the next POST fails (undici never
 * retries a non-idempotent request), which would turn a slow call into a lost one.
 *
 * P-008 (same plan, evidence D-003): the exchange now runs on a worker thread
 * (`createWorkerTransport` in @papercusp/decision-model), which owns its own
 * keep-alive agent with the same idle window. An in-thread fetch needs this thread's
 * event loop to send the request and read the answer, so a busy operator thread
 * turned fast Jev answers into timeouts: 17 of 21 newer-build timeouts had the
 * calling thread at event-loop utilization 0.9 or more. The in-thread keep-alive
 * dispatcher below is kept as the fallback for a worker that keeps dying.
 */
import {
  createWorkerTransport,
  type FetchLike,
  type WorkerTransport,
  type WorkerTransportEvent,
} from '@papercusp/decision-model';
import { pinModuleState } from '@papercusp/module-singleton';
import { Agent } from 'undici';

/**
 * How long an idle Jev socket is kept. api.typesafe.ai (Cloudflare) was measured on
 * 2026-10-01 to reuse one idle HTTP/1.1 connection after 15, 30, 60, 90 and 120 s of
 * idle (.papercusp/scratch/jev-idle-limit.mts), so its limit is at least
 * JEV_SERVER_IDLE_OBSERVED_MS; 90 s keeps a 30 s margin inside that floor.
 */
export const JEV_SERVER_IDLE_OBSERVED_MS = 120_000;
export const JEV_KEEPALIVE_IDLE_MS = 90_000;

export interface JevDispatcherOptions {
  /** Idle time before a pooled socket is closed. Default {@link JEV_KEEPALIVE_IDLE_MS}. */
  readonly keepAliveTimeoutMs?: number;
}

/** A keep-alive undici Agent for decision-model traffic. */
export function createJevDispatcher(options: JevDispatcherOptions = {}): Agent {
  const idleMs = options.keepAliveTimeoutMs ?? JEV_KEEPALIVE_IDLE_MS;
  return new Agent({
    keepAliveTimeout: idleMs,
    // Caps any Keep-Alive hint the server might start sending, so a hint can only
    // shorten our window, never stretch it past the measured server limit.
    keepAliveMaxTimeout: idleMs,
  });
}

const state = pinModuleState('@papercusp/operator-core.jev-transport', () => ({
  dispatcher: null as Agent | null,
  worker: null as WorkerTransport | null,
}));

/** The process-wide in-thread Jev dispatcher (the worker transport's fallback), created on first use. */
export function jevDispatcher(): Agent {
  if (!state.dispatcher) state.dispatcher = createJevDispatcher();
  return state.dispatcher;
}

/**
 * Build a {@link FetchLike} that sends every request through `dispatcher`, on the
 * calling thread. It calls the GLOBAL fetch, resolved per call, so anything that
 * stubs `fetch` still intercepts; Node's bundled undici fetch accepts an npm-undici
 * v7 Agent as its dispatcher (proved by jev-transport.test.ts).
 */
export function fetchVia(dispatcher: Agent): FetchLike {
  // `deadline` is the client's hook for off-thread transports; fetch has no use for it.
  return (url, { deadline: _deadline, ...init }) => globalThis.fetch(url, { ...init, dispatcher } as RequestInit);
}

function reportTransportEvent(event: WorkerTransportEvent): void {
  if (event.kind === 'worker-lost') {
    console.warn(`[jev-transport] transport worker died (${event.failures} so far): ${event.error}`);
  } else {
    console.warn(`[jev-transport] ${event.reason}; Jev calls now run on the calling thread (P-008 fallback)`);
  }
}

/** The process-wide Jev worker transport, started on first use. */
export function jevWorkerTransport(): WorkerTransport {
  if (!state.worker) {
    state.worker = createWorkerTransport({
      keepAliveIdleMs: JEV_KEEPALIVE_IDLE_MS,
      fallback: (url, init) => fetchVia(jevDispatcher())(url, init),
      onEvent: reportTransportEvent,
    });
  }
  return state.worker;
}

/**
 * The fetch the Jev decision client uses: the worker transport. A test that stubs
 * the global fetch does NOT reach it, because the request is made on the worker.
 */
export const jevFetch: FetchLike = (url, init) => jevWorkerTransport().fetch(url, init);

export async function __resetJevTransportForTest(): Promise<void> {
  const d = state.dispatcher;
  const w = state.worker;
  state.dispatcher = null;
  state.worker = null;
  await Promise.all([d?.close(), w?.close()]);
}
