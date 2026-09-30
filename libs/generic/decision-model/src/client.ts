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
 *  - The observer (the host's audit ledger) is fired AFTER the outcome is known
 *    and is never awaited: a slow or failing ledger cannot delay or break a decision.
 */
import { pinModuleState } from '@papercusp/module-singleton';
import type {
  DecisionCallRecord,
  DecisionOutcome,
  DecisionProvider,
  DecisionRequest,
  InconclusiveReason,
  QuestionMap,
} from './types.js';

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

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
  /** Observer for completed calls (the audit ledger). Fire-and-forget. */
  readonly onCall?: (record: DecisionCallRecord) => void | Promise<void>;
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
const DETAIL_MAX_CHARS = 300;

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

  function observe(record: DecisionCallRecord): void {
    if (!options.onCall) return;
    try {
      const p = options.onCall(record);
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    } catch {
      // An observer fault must never reach the decision path.
    }
  }

  async function run(request: DecisionRequest, timeoutMs: number): Promise<DecisionOutcome> {
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

    let key: string | null;
    try {
      key = await options.resolveKey();
    } catch (err) {
      return inconclusive('no-key', `credential lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!key) return inconclusive('no-key');

    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
    const whyAborted = (): InconclusiveReason => (request.signal?.aborted ? 'aborted' : 'timeout');
    const http = provider.buildRequest(request, key);

    for (;;) {
      if (signal.aborted) return inconclusive(whyAborted());
      attempts += 1;
      let status: number;
      let text: string;
      let retryAfter: string | null;
      const abort = untilAborted(signal);
      try {
        const attempt = (async () => {
          const res = await fetchImpl(http.url, { method: 'POST', headers: { ...http.headers }, body: http.body, signal });
          return { status: res.status, retryAfter: res.headers.get('retry-after'), text: await res.text() };
        })();
        attempt.catch(() => {});
        ({ status, retryAfter, text } = await Promise.race([attempt, abort.promise]));
      } catch (err) {
        if (signal.aborted) return inconclusive(whyAborted());
        return inconclusive('network-error', err instanceof Error ? err.message : String(err));
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
      const timeoutMs = Math.max(1, decideOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let outcome: DecisionOutcome;
      try {
        outcome = await run(request, timeoutMs);
      } catch (err) {
        // Defensive: run() is written not to throw; if it ever does, fail open, visibly.
        outcome = {
          kind: 'inconclusive',
          reason: 'network-error',
          detail: truncate(`client fault: ${err instanceof Error ? err.message : String(err)}`),
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
        subjectIds: decideOptions.subjectIds ? [...decideOptions.subjectIds] : [],
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
