/**
 * The decision client: transport, deadline, retries and credentials around a
 * pure {@link DecisionProvider} adapter.
 *
 * Contract (fail open, never silently):
 *  - `decide` NEVER throws for an expected failure. No key, a rejected key, a
 *    timeout, a rate limit, a network fault or a malformed body all come back as
 *    `{ kind: 'inconclusive', reason }`, and the consumer falls back to its
 *    pre-model behaviour.
 *  - ONE deadline covers the whole call, retries included. A caller that budgets
 *    400 ms gets an answer or an inconclusive within ~400 ms, never 400 ms per try.
 *  - 429 and 529 are retried with exponential backoff (honouring Retry-After when
 *    it fits the remaining budget); every other status is terminal on first sight.
 *  - 402 (a billing refusal, e.g. no credits) suspends the client: for
 *    `paymentRequiredCooldownMs` every call returns 'payment-required' without
 *    sending anything, then the next call probes the provider again.
 *  - The observer (the host's audit ledger) is fired AFTER the outcome is known
 *    and is never awaited: a slow or failing ledger cannot delay or break a decision.
 *  - Every observed call carries `hostLoad`: how busy the calling thread was while
 *    the call was open, so a timeout can be attributed to the provider or to the host.
 */
import { performance } from 'node:perf_hooks';
import { pinModuleState } from '@papercusp/module-singleton';
import { describeError } from './error-detail.js';
import type {
  DecisionCallRecord,
  DecisionOutcome,
  DecisionProvider,
  DecisionRequest,
  HostLoad,
  InconclusiveReason,
  QuestionMap,
} from './types.js';

/**
 * Starts a host-load measurement when a call begins and returns the function that
 * ends it. The end function returns null when it cannot measure.
 */
export type HostLoadMeter = () => () => HostLoad | null;

/**
 * The default meter: Node's event-loop utilization of the calling thread over the
 * call window. `active` is the time the loop spent outside its idle wait, i.e.
 * running JavaScript or blocked in synchronous native work (a spawn, a sync file
 * read) — exactly the time an arrived answer cannot be read.
 */
export const eventLoopUtilizationMeter: HostLoadMeter = () => {
  const start = performance.eventLoopUtilization();
  return () => {
    const delta = performance.eventLoopUtilization(start);
    const window = delta.active + delta.idle;
    if (!Number.isFinite(delta.active) || delta.active < 0 || !(window > 0)) return null;
    return {
      busyMs: Math.round(delta.active),
      utilization: Math.min(1, Math.max(0, delta.active / window)),
    };
  };
};

/**
 * The call's deadline as seen by a transport: when it expires, and a last-chance
 * hook that runs synchronously when the deadline timer fires, before the abort is
 * dispatched.
 *
 * A transport whose answer can be complete while the calling thread is busy (the
 * worker transport: the answer waits on a MessagePort) registers a hook that drains
 * that answer synchronously. A promise it resolves inside the hook settles before
 * the abort, because the abort is deferred to `setImmediate` (see
 * {@link createDeadline}). Transports that do not need it ignore the field.
 */
export interface DeadlineHook {
  /**
   * When the deadline expires, on the `performance.timeOrigin + performance.now()`
   * clock. That clock is Unix-epoch milliseconds in every thread of the process, so
   * a worker can enforce the same instant on its own loop.
   */
  readonly expiresAt: number;
  /** Run `fn` when the deadline timer fires, before the abort. Returns an unregister function. */
  onExpiring(fn: () => void): () => void;
  /**
   * An off-thread transport reports how far a call got when it did not complete
   * (its own deadline passed, or the caller's did first). The client records the
   * last report on the timeout's ledger row, so a timeout can be attributed to the
   * provider (request sent, no answer) or to the transport (call never started).
   */
  reportIncomplete(timing: TransportTiming): void;
}

/** What an off-thread transport knew about a call that did not complete. */
export interface TransportTiming {
  /** Time the transport spent on the call before it stopped, ms; null when it never replied. */
  readonly elapsedMs: number | null;
  /** Short transport-written description: which deadline fired and how far the request got. */
  readonly detail: string;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    /** Present when the call has a deadline (always, from the client). */
    deadline?: DeadlineHook;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  /**
   * Request-to-complete-response time measured by a transport that runs off the
   * calling thread, so it excludes time the answer waited for this thread. The
   * client records it as `transportLatencyMs`. Absent for in-thread transports.
   */
  transportLatencyMs?: number;
}>;

export interface DecisionClientOptions {
  readonly provider: DecisionProvider;
  /**
   * Resolve the provider credential for this call. Return null when none is
   * stored. Resolved per call so a key saved or cleared in settings takes effect
   * without a restart.
   */
  readonly resolveKey: () => Promise<string | null> | string | null;
  /** Deadline for the whole call, retries included. Default 2000 ms. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt, for 429/529 only. Default 2. */
  readonly maxRetries?: number;
  /** First backoff delay; doubles per retry with ±25% jitter. Default 150 ms. */
  readonly backoffBaseMs?: number;
  /**
   * After a 402, how long to send nothing and answer 'payment-required' at once.
   * A billing refusal fails every request until someone adds credits, so sending
   * more only costs latency. Default 60 000 ms; 0 turns the suspension off.
   */
  readonly paymentRequiredCooldownMs?: number;
  /** Observer for completed calls (the audit ledger). Fire-and-forget. */
  readonly onCall?: (record: DecisionCallRecord) => void | Promise<void>;
  /**
   * Measures how busy the calling thread was during each call, recorded on the
   * observed record as `hostLoad`. Defaults to {@link eventLoopUtilizationMeter};
   * pass null to turn the measurement off (records `hostLoad: null`).
   */
  readonly hostLoad?: HostLoadMeter | null;
  /** Injected for tests; defaults to global fetch. */
  readonly fetch?: FetchLike;
  /** Injected for tests; defaults to a timer that stops early on abort. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  readonly random?: () => number;
  /** Injected for tests; defaults to Date.now. */
  readonly now?: () => number;
}

export interface DecideOptions {
  /** Label recorded with the call, e.g. `memory-injection`. */
  readonly consumer?: string;
  /**
   * Where in the host the call was made, e.g. the injection port. Recorded with
   * the call so one consumer's calls can be split by surface; never sent.
   */
  readonly surface?: string;
  /** Per-call deadline override (still bounded by nothing else — keep it small). */
  readonly timeoutMs?: number;
  /**
   * Ids of what `state` was built from (memory ids, doc ids, …). Never sent to
   * the provider; handed to the observer so the ledger can store ids, not text.
   */
  readonly subjectIds?: readonly string[];
}

export interface DecisionClient {
  readonly provider: DecisionProvider;
  decide<QM extends QuestionMap>(request: DecisionRequest<QM>, options?: DecideOptions): Promise<DecisionOutcome<QM>>;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_BASE_MS = 150;
const DEFAULT_PAYMENT_REQUIRED_COOLDOWN_MS = 60_000;
const DETAIL_MAX_CHARS = 300;

/**
 * The call's deadline, measured against the provider rather than against the
 * caller's own event loop.
 *
 * `AbortSignal.timeout` fires in Node's timers phase, which runs BEFORE the poll
 * phase that reads sockets. So when the calling thread is blocked past the
 * deadline (a synchronous fs walk, a long GC, a fork on a large heap), a response
 * that arrived during the block is still unread when the timer fires, and the call
 * is aborted with its answer sitting in the socket buffer. Production measured that
 * shape: timed-out memory-filter calls had the loop busy for 816 of their 838 ms
 * (EI-24748208098755918, plan jev-memory-timeouts-to-zero-2026-10-01 D-002).
 *
 * The abort is therefore deferred to `setImmediate`, which runs after the poll
 * phase of the same loop iteration: whatever already arrived is read first. A
 * provider that genuinely has not answered still loses. The deferral is one loop
 * phase, not a longer budget. Unref'd like `AbortSignal.timeout`, so a pending
 * deadline never keeps the process alive.
 *
 * The deferral only rescues an answer that one poll phase can fully read. An
 * in-thread fetch whose request was not even SENT while the thread was blocked
 * gets nothing from it. The returned {@link DeadlineHook} closes that gap for a
 * transport that runs off-thread: its hooks run inside the timer callback, and a
 * promise they resolve settles in that callback's microtasks, before the
 * deferred abort (P-008).
 */
export function createDeadline(timeoutMs: number): {
  signal: AbortSignal;
  hook: DeadlineHook;
  /** The transport's last {@link DeadlineHook.reportIncomplete} report, if any. */
  incomplete(): TransportTiming | null;
} {
  const controller = new AbortController();
  const hooks = new Set<() => void>();
  let lastIncomplete: TransportTiming | null = null;
  const expiresAt = performance.timeOrigin + performance.now() + timeoutMs;
  const timer = setTimeout(() => {
    for (const fn of [...hooks]) {
      try {
        fn();
      } catch {
        // A faulty transport hook must not cancel the deadline itself.
      }
    }
    hooks.clear();
    setImmediate(() => {
      controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    }).unref();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    hook: {
      expiresAt,
      onExpiring(fn) {
        hooks.add(fn);
        return () => {
          hooks.delete(fn);
        };
      },
      reportIncomplete(timing) {
        lastIncomplete = timing;
      },
    },
    incomplete: () => lastIncomplete,
  };
}

/** A transport's own deadline (the worker transport's) surfaces as a TimeoutError. */
function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Rejects when `signal` aborts (immediately if it already has). Racing an attempt
 * against this makes the deadline hold even for a transport that ignores its
 * signal — the "one deadline" contract must not depend on fetch's good behaviour.
 */
function untilAborted(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {});
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text;
}

/** Retry-After as delay seconds; the HTTP-date form is ignored (backoff applies). */
function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

function statusReason(status: number): InconclusiveReason {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 402) return 'payment-required';
  if (status === 422 || status === 400) return 'rejected';
  if (status === 429) return 'rate-limited';
  if (status === 529 || status === 503) return 'overloaded';
  return 'http-error';
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status === 503;
}

export function createDecisionClient(options: DecisionClientOptions): DecisionClient {
  const provider = options.provider;
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const backoffBase = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
  const paymentCooldownMs = Math.max(0, options.paymentRequiredCooldownMs ?? DEFAULT_PAYMENT_REQUIRED_COOLDOWN_MS);
  /** Epoch ms until which a prior 402 suspends sending; 0 = not suspended. */
  let paymentRequiredUntil = 0;
  const hostLoadMeter = options.hostLoad === undefined ? eventLoopUtilizationMeter : options.hostLoad;

  /** Start the host-load measurement. A meter fault yields null, never a thrown decide. */
  function startHostLoad(): () => HostLoad | null {
    if (!hostLoadMeter) return () => null;
    let end: () => HostLoad | null;
    try {
      end = hostLoadMeter();
    } catch {
      return () => null;
    }
    return () => {
      try {
        return end();
      } catch {
        return null;
      }
    };
  }

  function observe(record: DecisionCallRecord): void {
    if (!options.onCall) return;
    try {
      const p = options.onCall(record);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    } catch {
      // An observer fault must never reach the decision path.
    }
  }

  /** Per-call facts `run` learns that the outcome does not carry. */
  interface RunMeta {
    /** From the last attempt that got a response; null when none did or the transport does not measure it. */
    transportLatencyMs: number | null;
  }

  async function run(request: DecisionRequest, timeoutMs: number, meta: RunMeta): Promise<DecisionOutcome> {
    const started = now();
    let attempts = 0;
    const inconclusive = (reason: InconclusiveReason, detail?: string, status?: number): DecisionOutcome => ({
      kind: 'inconclusive',
      reason,
      ...(detail !== undefined ? { detail: truncate(detail) } : {}),
      ...(status !== undefined ? { status } : {}),
      latencyMs: now() - started,
      attempts,
    });

    if (request.signal?.aborted) return inconclusive('aborted');

    const invalid = provider.validate(request);
    if (invalid) return inconclusive('invalid-request', invalid);

    if (now() < paymentRequiredUntil) {
      return inconclusive(
        'payment-required',
        `suspended after a 402 until ${new Date(paymentRequiredUntil).toISOString()}; nothing was sent`,
      );
    }

    let key: string | null;
    try {
      key = await options.resolveKey();
    } catch (err) {
      return inconclusive('no-key', `credential lookup failed: ${describeError(err)}`);
    }
    if (!key) return inconclusive('no-key');

    const deadline = createDeadline(timeoutMs);
    const signal = request.signal ? AbortSignal.any([deadline.signal, request.signal]) : deadline.signal;
    const whyAborted = (): InconclusiveReason => (request.signal?.aborted ? 'aborted' : 'timeout');
    const http = provider.buildRequest(request, key);

    for (;;) {
      if (signal.aborted) return inconclusive(whyAborted());
      attempts += 1;
      let status: number;
      let text: string;
      let retryAfter: string | null;
      let transportMs: number | null;
      const abort = untilAborted(signal);
      try {
        const attempt = (async () => {
          const res = await fetchImpl(http.url, {
            method: 'POST',
            headers: { ...http.headers },
            body: http.body,
            signal,
            deadline: deadline.hook,
          });
          const measured = res.transportLatencyMs;
          return {
            status: res.status,
            retryAfter: res.headers.get('retry-after'),
            text: await res.text(),
            transportMs: typeof measured === 'number' && Number.isFinite(measured) && measured >= 0 ? measured : null,
          };
        })();
        attempt.catch(() => {});
        ({ status, retryAfter, text, transportMs } = await Promise.race([attempt, abort.promise]));
        meta.transportLatencyMs = transportMs;
      } catch (err) {
        if (signal.aborted || isTimeoutError(err)) {
          const why = whyAborted();
          // An off-thread transport says how far the call got; without it a timeout
          // cannot be told apart as a slow provider or a transport that never ran it.
          const timing = why === 'timeout' ? deadline.incomplete() : null;
          if (!timing) return inconclusive(why);
          meta.transportLatencyMs = timing.elapsedMs;
          return inconclusive(why, timing.detail);
        }
        return inconclusive('network-error', describeError(err));
      } finally {
        abort.dispose();
      }

      if (status >= 200 && status < 300) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          return inconclusive('malformed-response', 'response body is not JSON', status);
        }
        const parsed = provider.parseResponse(body, request);
        if (!parsed.ok) return inconclusive('malformed-response', parsed.detail, status);
        return {
          kind: 'answered',
          model: parsed.model,
          answers: parsed.answers,
          usage: parsed.usage,
          latencyMs: now() - started,
          attempts,
        } as DecisionOutcome;
      }

      const reason = statusReason(status);
      if (status === 402 && paymentCooldownMs > 0) paymentRequiredUntil = now() + paymentCooldownMs;
      if (!isRetryable(status) || attempts > maxRetries) return inconclusive(reason, text, status);

      const backoff = backoffBase * 2 ** (attempts - 1) * (0.75 + random() * 0.5);
      const delay = retryAfterMs(retryAfter) ?? backoff;
      const remaining = started + timeoutMs - now();
      // Waiting past the deadline only converts a known 429/529 into a vaguer timeout.
      if (delay >= remaining) return inconclusive(reason, text, status);
      await sleep(delay, signal);
      if (signal.aborted) return inconclusive(whyAborted());
    }
  }

  return {
    provider,
    async decide<QM extends QuestionMap>(request: DecisionRequest<QM>, decideOptions: DecideOptions = {}) {
      const startedAt = new Date(now());
      const endHostLoad = startHostLoad();
      const timeoutMs = Math.max(1, decideOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let outcome: DecisionOutcome;
      const meta: RunMeta = { transportLatencyMs: null };
      try {
        outcome = await run(request, timeoutMs, meta);
      } catch (err) {
        // Defensive: run() is written not to throw; if it ever does, fail open, visibly.
        outcome = {
          kind: 'inconclusive',
          reason: 'network-error',
          detail: truncate(`client fault: ${describeError(err)}`),
          latencyMs: now() - startedAt.getTime(),
          attempts: 0,
        };
      }
      observe({
        provider: provider.id,
        requestedModel: provider.model,
        request,
        outcome,
        startedAt,
        consumer: decideOptions.consumer ?? null,
        surface: decideOptions.surface ?? null,
        subjectIds: decideOptions.subjectIds ? [...decideOptions.subjectIds] : [],
        hostLoad: endHostLoad(),
        transportLatencyMs: meta.transportLatencyMs,
      });
      return outcome as DecisionOutcome<QM>;
    },
  };
}

// ── Host seam ────────────────────────────────────────────────────────────────

const state = pinModuleState('@papercusp/decision-model.state', () => ({
  client: null as DecisionClient | null,
}));

/** Install the process-wide client (host startup). Pass null to remove it. */
export function configureDecisionModel(client: DecisionClient | null): void {
  state.client = client;
}

/** The configured client, or null when the host has not configured one. */
export function getDecisionClient(): DecisionClient | null {
  return state.client;
}

/**
 * Decide through the configured client. With no client configured this returns
 * `inconclusive('not-configured')` — callers never need a null check to fail open.
 */
export async function decide<QM extends QuestionMap>(
  request: DecisionRequest<QM>,
  options?: DecideOptions,
): Promise<DecisionOutcome<QM>> {
  const client = state.client;
  if (!client) return { kind: 'inconclusive', reason: 'not-configured', latencyMs: 0, attempts: 0 };
  return client.decide(request, options);
}
