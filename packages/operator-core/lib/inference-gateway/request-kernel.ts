import type { GatewayLaneDescriptor, GatewayTransportId } from './provider-adapters';
import {
  GatewayRequestTelemetry,
  classifyGatewayTelemetryOutcome,
  type GatewayRequestOutcome,
  type GatewayRequestSpan,
  type GatewayRequestTimeline,
  type GatewayTelemetryProvider,
} from './request-stage-telemetry';

type MaybePromise<T> = T | Promise<T>;

export type GatewayKernelPinMode = 'hard' | 'soft' | 'none';

export interface GatewayKernelAccountPin {
  accountId: string;
  mode: Exclude<GatewayKernelPinMode, 'none'>;
}

export interface GatewayKernelRoute<T> {
  /** Stable identity used to prevent retry cycles. */
  key: string;
  /** Account identity when this is an account-backed route. */
  accountId?: string | null;
  transport: GatewayTransportId;
  value: T;
  /**
   * PACING: wait this long before the first attempt on this route (D-018).
   *
   * Every legacy ladder slept between attempts, and how long depended on WHY it
   * was retrying, not merely on where it was going: a transient-429 rotate paced
   * `TRANSIENT_429_BACKOFF_MS`, a 529 overload `OVERLOAD_529_BACKOFF_MS`, and a
   * usage-cap rotate or a sibling-IP retry paced nothing at all. That makes the
   * pause a ROUTING decision the adapter already owns — so it travels WITH the
   * route as data, and the kernel is the single thing that executes it.
   *
   * Waited outside every stage span, so the pause is never mis-attributed to
   * `auth`, and inside the request's abort scope, so a vanished client stops
   * paying for it. Omitted / 0 ⇒ no wait, which is why adding this changed no
   * existing adapter's behaviour.
   */
  delayMs?: number;
}

/**
 * Resolves the upstream TTFB deadline from the request body (D-007 of plan
 * `gateway-kernel-adoption-2026-08-29`).
 *
 * Every cloud handler picks a SHORT time-to-first-byte deadline for a
 * streaming request and a generous one otherwise, and it decides which by
 * parsing `stream: true` out of the REQUEST body — which is not known until
 * the kernel's own bounded body read has run. A scalar policy therefore
 * cannot express the live behaviour, and the only alternative would be each
 * adapter racing its own stall timer, re-creating the very per-handler ladder
 * this kernel exists to delete.
 *
 * The resolver is called ONCE, after the bounded body read and before the
 * first attempt, so it costs nothing per retry and cannot change mid-request.
 * That is deliberate — a resolver may parse a body of tens of megabytes — and
 * it is why a deadline that must SHRINK across attempts belongs in the separate
 * per-attempt `ttfbCapMs` (D-014) rather than here.
 */
export type GatewayKernelTtfbResolver = (context: {
  body: Buffer;
  lane: GatewayLaneDescriptor;
}) => number;

export interface GatewayKernelPolicy {
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
  requestCeilingMs: number;
  /** A scalar deadline, or a resolver reading the parsed request body. */
  ttfbTimeoutMs: number | GatewayKernelTtfbResolver;
  /**
   * D-014 — an OPTIONAL per-attempt CAP on the TTFB deadline, read from the
   * caller's remaining wall-clock retry budget. Deliberately separate from
   * `ttfbTimeoutMs`, which is a body-derived deadline that is CONSTANT for the
   * request; this is a BUDGET that shrinks as the request ages, so the two
   * cannot share a field without hiding one of them.
   *
   * The effective deadline for each attempt is
   * `Math.max(1, Math.min(ttfbTimeoutMs, cap()))` — the `max(1, …)` floor is
   * load-bearing: a retry started at the deadline gets a brief attempt rather
   * than a 0ms abort (gateway.ts:4144).
   *
   * WHY THE KERNEL NEEDS THIS AT ALL. A lane can carry a wedge-prevention
   * deadline — an instant past which the request must stop retrying and free
   * its admission slot, ahead of a self-heal valve or watchdog reclaiming it.
   * An attempt COUNT is not a substitute for that wall-clock bound: with
   * `maxAttempts` 6 and a 300s headers deadline, a once-resolved TTFB lets one
   * request stall 6× its intended budget under a storm. Lanes that pass no cap
   * are unaffected, and a non-finite return is ignored rather than arming a
   * timer that never fires.
   */
  ttfbCapMs?: () => number;
  bodyIdleTimeoutMs: number;
  downstreamIdleTimeoutMs: number;
  maxAttempts: number;
}

export interface GatewayKernelRequest {
  lane: GatewayLaneDescriptor;
  body: AsyncIterable<Uint8Array | string>;
  ownerId?: string | null;
  correlationId?: string;
  pin?: GatewayKernelAccountPin | null;
  /** Caller/request cancellation. */
  signal?: AbortSignal;
}

export interface GatewayKernelContext {
  requestId: number;
  correlationId: string;
  lane: GatewayLaneDescriptor;
  ownerId: string | null;
  pin: GatewayKernelAccountPin | null;
  signal: AbortSignal;
  startedAt: number;
}

export interface GatewayKernelRouteContext<T, TChunk = unknown, TMetadata = unknown> extends GatewayKernelContext {
  currentRoute: GatewayKernelRoute<T> | null;
  triedRouteKeys: readonly string[];
  attempt: number;
  lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  lastError: GatewayRequestKernelError | null;
}

export interface GatewayKernelAttemptContext<T> extends GatewayKernelContext {
  route: GatewayKernelRoute<T>;
  body: Buffer;
  attempt: number;
  maxAttempts: number;
  triedRouteKeys: readonly string[];
}

export interface GatewayKernelUpstreamResponse<TChunk, TMetadata> {
  status: number;
  streaming: boolean;
  transport: GatewayTransportId;
  metadata: TMetadata;
  body: AsyncIterable<TChunk> | null;
  /** Normalized at the protocol/transport boundary. */
  retryable?: boolean;
  /** Optional standardized override when status alone is insufficient. */
  outcome?: GatewayRequestOutcome;
  /** Release a response body/socket that will not be forwarded because the kernel retries. */
  discard?: () => MaybePromise<void>;
}

export interface GatewayKernelAttemptFeedback<TRoute, TChunk, TMetadata> {
  context: GatewayKernelAttemptContext<TRoute>;
  response: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  error: GatewayRequestKernelError | null;
}

export interface GatewayKernelAdmissionController<TRoute, TChunk, TMetadata> {
  /**
   * Run the admitted lifecycle inside the existing lane gate. Implementations wrap
   * `PriorityAdmissionQueue.run()` (or the local lane's equivalent), so the proven
   * task-settle path remains the sole slot-release authority.
   */
  run<TResult>(
    context: GatewayKernelContext & { route: GatewayKernelRoute<TRoute> },
    task: () => Promise<TResult>,
  ): Promise<TResult>;
  /** AIMD/rate feedback remains lane-specific data, but the kernel guarantees one callback per attempt. */
  observeAttempt?(feedback: GatewayKernelAttemptFeedback<TRoute, TChunk, TMetadata>): MaybePromise<void>;
}

export interface GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata> {
  selectInitial(
    context: GatewayKernelRouteContext<TRoute, TChunk, TMetadata>,
  ): MaybePromise<GatewayKernelRoute<TRoute>>;
  selectFailover(
    context: GatewayKernelRouteContext<TRoute, TChunk, TMetadata>,
  ): MaybePromise<GatewayKernelRoute<TRoute> | null>;
  /**
   * OPTIONAL re-attempt on the SAME account, tried BEFORE `selectFailover`.
   *
   * A failover changes ACCOUNT; a re-attempt keeps the account and changes only how
   * it is reached — a refreshed OAuth token, a sibling egress IP. The live handlers
   * treat those as different things and this hook preserves the distinction:
   *
   *  - it is consulted even under a HARD pin, because a hard pin forbids leaving the
   *    pinned account, not re-attempting it (`rotateCli`/`rotateCodex` open with
   *    `if (hardPin) return false`, but the 401-refresh at gateway.ts:5670 and the
   *    sibling-egress retries at :5638/:5727/:4195/:4535 deliberately do not);
   *  - it is tried FIRST, matching the live `siblingEgressAvailable(...) || rotate(...)`
   *    ordering — exhaust the cheap same-account retry before parking the account;
   *  - it is NOT counted as a failover, matching handlers that increment their
   *    failover counter only inside the account-rotation helper.
   *
   * The returned route MUST carry the same `accountId` as the current route; the
   * kernel throws `invalid-route` otherwise rather than letting a pin be silently
   * escaped. Route-cycle rejection applies exactly as it does to a failover, so a
   * re-attempt must present a NEW key (e.g. `oauth:acct#refresh1`).
   *
   * Adapters that do not implement it keep today's behaviour unchanged.
   */
  selectReattempt?(
    context: GatewayKernelRouteContext<TRoute, TChunk, TMetadata>,
  ): MaybePromise<GatewayKernelRoute<TRoute> | null>;
  /** Protocol/transport-owned parsing, auth, URL, header, model, and cache work. */
  prepareAttempt(context: GatewayKernelAttemptContext<TRoute>): MaybePromise<TPrepared>;
  /** Returns a response whose retryability/outcome has already been normalized at the boundary. */
  executeAttempt(
    prepared: TPrepared,
    context: GatewayKernelAttemptContext<TRoute>,
  ): Promise<GatewayKernelUpstreamResponse<TChunk, TMetadata>>;
}

export interface GatewayKernelDownstream<TChunk, TMetadata> {
  /** Downstream disconnect/backpressure cancellation. */
  signal?: AbortSignal;
  start(response: {
    status: number;
    streaming: boolean;
    transport: GatewayTransportId;
    metadata: TMetadata;
  }): MaybePromise<void>;
  write(chunk: TChunk): MaybePromise<void>;
  end(): MaybePromise<void>;
}

export interface GatewayKernelInFlightEntry {
  requestId: number;
  correlationId: string;
  laneId: GatewayLaneDescriptor['id'];
  provider: GatewayTelemetryProvider;
  startedAt: number;
  isStreaming: () => boolean;
  abort: (reason: string) => void;
}

export interface GatewayKernelInFlightHandle {
  unregister(result: { outcome: GatewayRequestOutcome; status: number | null }): MaybePromise<void>;
}

export interface GatewayKernelInFlightRegistry {
  register(entry: GatewayKernelInFlightEntry): MaybePromise<GatewayKernelInFlightHandle>;
}

export interface ExecuteGatewayRequestKernelOptions<TRoute, TPrepared, TChunk, TMetadata> {
  request: GatewayKernelRequest;
  policy: GatewayKernelPolicy;
  telemetry: GatewayRequestTelemetry;
  /**
   * Adopt the caller's EXISTING request span instead of beginning a new one.
   *
   * Required when the kernel runs inside a handler whose surrounding gateway
   * already opened a span for the same HTTP request (the legacy proxy entries
   * do — `beginRequestTelemetry` opens one per request and finishes it from
   * `res` finish/close). Without this the kernel would `telemetry.begin()` a
   * SECOND span for one request, double-counting it in the stage telemetry.
   *
   * Finishing stays safe either way: `GatewayRequestSpan.finish` is idempotent,
   * so whichever of the kernel or the surrounding `res` handler settles first
   * wins and the other is a no-op. When adopted, `requestId`, `ownerId` and
   * `startedAt` come from the caller's span, which is what keeps one request
   * reporting under one id.
  */
  span?: GatewayRequestSpan;
  /**
   * Keep an adopted span open when this kernel pass fails before the caller can
   * decide whether to re-enter recovery. The successful terminal pass still
   * finalizes the span, so a caller-level retry does not publish an intermediate
   * 500 while a missing caller span cannot leak an active telemetry request.
   */
  deferSpanFinalization?: boolean;
  admission: GatewayKernelAdmissionController<TRoute, TChunk, TMetadata>;
  adapter: GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata>;
  downstream: GatewayKernelDownstream<TChunk, TMetadata>;
  inFlight: GatewayKernelInFlightRegistry;
}

// P-008 / D-028: `executeGatewayLegacyLane` — the strangler bridge's callback-scoped lane
// admission seam — is DELETED. Every gateway lane now takes its admission at its own entry
// handler (P-011 / D-027), so nothing resolves a synthetic legacy route to admit through any
// more. `executeGatewayRequestKernel`'s own `admission.run` seam (below) is unaffected: it is
// per-kernel-call by construction and remains what a single-kernel-call handler uses.

export interface GatewayKernelExecutionResult<TRoute> {
  requestId: number;
  correlationId: string;
  laneId: GatewayLaneDescriptor['id'];
  status: number;
  outcome: GatewayRequestOutcome;
  attempts: number;
  failovers: number;
  finalRoute: GatewayKernelRoute<TRoute>;
  timeline: GatewayRequestTimeline;
}

export type GatewayRequestKernelErrorCode =
  | 'invalid-policy'
  | 'invalid-pin'
  | 'invalid-route'
  | 'route-cycle'
  | 'body-too-large'
  | 'body-read-timeout'
  | 'request-ceiling'
  | 'ttfb-timeout'
  | 'upstream-body-idle'
  | 'downstream-idle'
  | 'cancelled'
  | 'upstream-error'
  | 'gateway-error';

export class GatewayRequestKernelError extends Error {
  readonly code: GatewayRequestKernelErrorCode;
  readonly outcome: GatewayRequestOutcome;
  readonly status: number | null;
  readonly retryable: boolean;
  timeline?: GatewayRequestTimeline;

  constructor(
    message: string,
    opts: {
      code: GatewayRequestKernelErrorCode;
      outcome: GatewayRequestOutcome;
      status: number | null;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'GatewayRequestKernelError';
    this.code = opts.code;
    this.outcome = opts.outcome;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
  }
}

function telemetryProviderForLane(lane: GatewayLaneDescriptor): GatewayTelemetryProvider {
  if (lane.observability.provider === 'anthropic') return 'claude';
  if (lane.observability.provider === 'openai') return 'codex';
  return 'local';
}

function boundedCorrelationId(value: string | undefined, fallback: string): string {
  const bounded = value
    ?.trim()
    .replace(/[^A-Za-z0-9._:@/+\-]/g, '?')
    .slice(0, 160);
  return bounded || fallback;
}

/**
 * Validates a TTFB deadline. Applied to a scalar policy up front, and to a
 * resolver's RETURN value after the body read — a resolver that computes a
 * nonsense deadline must fail the same way a nonsense literal does, rather
 * than arming a timer that never fires.
 */
function assertPositiveTtfb(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new GatewayRequestKernelError('gateway request kernel policy ttfbTimeoutMs must be positive', {
      code: 'invalid-policy',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return value;
}

function validatePolicy(policy: GatewayKernelPolicy): void {
  // `ttfbTimeoutMs` is excluded here because it may be a resolver; a scalar is
  // checked below, and a resolver's result is checked after the body read.
  // `ttfbCapMs` (D-014) is always a callback and is evaluated per attempt, so
  // its VALUE cannot be validated here either — a non-finite return is ignored
  // at the call site rather than failing a request that has a usable deadline.
  const positive: Array<Exclude<keyof GatewayKernelPolicy, 'ttfbTimeoutMs' | 'ttfbCapMs'>> = [
    'maxBodyBytes',
    'bodyReadTimeoutMs',
    'requestCeilingMs',
    'bodyIdleTimeoutMs',
    'downstreamIdleTimeoutMs',
    'maxAttempts',
  ];
  for (const key of positive) {
    if (!Number.isFinite(policy[key]) || policy[key] <= 0) {
      throw new GatewayRequestKernelError(`gateway request kernel policy ${key} must be positive`, {
        code: 'invalid-policy',
        outcome: 'gateway-error',
        status: 500,
      });
    }
  }
  if (!Number.isInteger(policy.maxAttempts)) {
    throw new GatewayRequestKernelError('gateway request kernel maxAttempts must be an integer', {
      code: 'invalid-policy',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  if (typeof policy.ttfbTimeoutMs !== 'function') assertPositiveTtfb(policy.ttfbTimeoutMs);
}

function cancellationError(message = 'gateway request cancelled'): GatewayRequestKernelError {
  return new GatewayRequestKernelError(message, {
    code: 'cancelled',
    outcome: 'cancelled',
    status: null,
  });
}

function abortReason(signal: AbortSignal): GatewayRequestKernelError {
  return signal.reason instanceof GatewayRequestKernelError
    ? signal.reason
    : cancellationError(signal.reason instanceof Error ? signal.reason.message : undefined);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The route-level pre-attempt pause (`GatewayKernelRoute.delayMs`). Unref'd, so a
 * pending backoff can never hold the process open — the same `t.unref?.()` the
 * legacy ladders used — and abort-aware, so a client that vanishes mid-backoff
 * stops paying for it instead of sleeping out the full pace.
 */
async function delayBeforeAttempt(ms: number, signal: AbortSignal): Promise<void> {
  if (!(ms > 0)) return;
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const settleAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', settleAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener('abort', settleAbort, { once: true });
  });
}

/**
 * Bound a deadline-less promise: reject with `<label> timed out after <ms>ms` if it
 * has not settled within `ms`.
 *
 * Distinct from the abort-based `withDeadline` below, which cancels work through an
 * `AbortSignal`. This one is for awaits that have no signal to plumb — an OAuth token
 * refresh, a bearer token read, a request-body drain — where the only lever is to stop
 * waiting. Callers get the first settlement either way.
 *
 * ONE implementation on purpose. This helper previously existed as four byte-identical
 * copies (three adapters plus gateway.ts), which is exactly the duplication this module
 * exists to hold once: changing the timeout semantics meant editing four files, and the
 * copies had already drifted in shape. Independent acceptance grading of
 * gateway-kernel-adoption-2026-08-29 caught it (scorecard EI-21895157688674407).
 *
 * The timer is unref'd so a pending deadline never holds the event loop open, and it is
 * cleared the moment `promise` settles. Note the handlers are ATTACHED to `promise`
 * rather than racing it: if the deadline fires first and `promise` rejects later, that
 * late rejection is still observed here instead of surfacing as an unhandledRejection.
 */
export function withPromiseDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function withDeadline<T>(opts: {
  parent: AbortSignal;
  timeoutMs: number;
  error: () => GatewayRequestKernelError;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(abortReason(opts.parent));
  if (opts.parent.aborted) forwardAbort();
  else opts.parent.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(opts.error()), opts.timeoutMs);
  timer.unref?.();
  try {
    return await abortable(opts.run(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    opts.parent.removeEventListener('abort', forwardAbort);
  }
}

export async function readBoundedGatewayRequestBody(opts: {
  source: AsyncIterable<Uint8Array | string>;
  maxBytes: number;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<Buffer> {
  return withDeadline({
    parent: opts.signal,
    timeoutMs: opts.timeoutMs,
    error: () =>
      new GatewayRequestKernelError(`gateway request body read exceeded ${opts.timeoutMs}ms`, {
        code: 'body-read-timeout',
        outcome: 'client-error',
        status: 408,
      }),
    run: async (signal) => {
      const iterator = opts.source[Symbol.asyncIterator]();
      const chunks: Buffer[] = [];
      let total = 0;
      let completed = false;
      try {
        for (;;) {
          const next = await abortable(Promise.resolve(iterator.next()), signal);
          if (next.done) {
            completed = true;
            return Buffer.concat(chunks, total);
          }
          const chunk = typeof next.value === 'string' ? Buffer.from(next.value) : Buffer.from(next.value);
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            throw new GatewayRequestKernelError(`gateway request body exceeded ${opts.maxBytes} bytes`, {
              code: 'body-too-large',
              outcome: 'client-error',
              status: 413,
            });
          }
          chunks.push(chunk);
        }
      } finally {
        if (!completed) await iterator.return?.().catch(() => undefined);
      }
    },
  });
}

function normalizeError(error: unknown, signal: AbortSignal): GatewayRequestKernelError {
  if (error instanceof GatewayRequestKernelError) return error;
  if (signal.aborted) return abortReason(signal);
  return new GatewayRequestKernelError(error instanceof Error ? error.message : String(error), {
    code: 'gateway-error',
    outcome: 'gateway-error',
    status: 500,
    cause: error,
  });
}

function validateRoute<TRoute>(
  lane: GatewayLaneDescriptor,
  route: GatewayKernelRoute<TRoute>,
  pin: GatewayKernelAccountPin | null,
  initial: boolean,
): void {
  if (!route.key.trim()) {
    throw new GatewayRequestKernelError('gateway route key must be non-empty', {
      code: 'invalid-route',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  if (!lane.transports.some((transport) => transport.id === route.transport)) {
    throw new GatewayRequestKernelError(`gateway lane ${lane.id} does not support transport ${route.transport}`, {
      code: 'invalid-route',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  if (lane.capabilities.accountPinning === 'none' && pin) {
    throw new GatewayRequestKernelError(`gateway lane ${lane.id} does not support account pinning`, {
      code: 'invalid-pin',
      outcome: 'client-error',
      status: 400,
    });
  }
  if (initial && pin?.mode === 'hard' && route.accountId !== pin.accountId) {
    throw new GatewayRequestKernelError(
      `hard-pinned account ${pin.accountId} is unavailable on gateway lane ${lane.id}`,
      { code: 'invalid-pin', outcome: 'client-error', status: 409 },
    );
  }
}

/**
 * Same-account re-attempt selection. Unlike `selectFailover` this is NOT suppressed
 * by a hard pin: the pin forbids changing account, and this cannot change it — the
 * same-account check below is what enforces that, so the guarantee is preserved by
 * construction rather than by refusing to ask.
 */
async function selectReattempt<TRoute, TPrepared, TChunk, TMetadata>(opts: {
  adapter: GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata>;
  base: GatewayKernelContext;
  currentRoute: GatewayKernelRoute<TRoute>;
  triedRouteKeys: Set<string>;
  attempt: number;
  pin: GatewayKernelAccountPin | null;
  lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  lastError: GatewayRequestKernelError | null;
}): Promise<GatewayKernelRoute<TRoute> | null> {
  if (!opts.adapter.selectReattempt) return null;
  const next = await abortable(
    Promise.resolve(
      opts.adapter.selectReattempt({
        ...opts.base,
        currentRoute: opts.currentRoute,
        triedRouteKeys: [...opts.triedRouteKeys],
        attempt: opts.attempt,
        lastResponse: opts.lastResponse,
        lastError: opts.lastError,
      }),
    ),
    opts.base.signal,
  );
  if (!next) return null;
  if (next.accountId !== opts.currentRoute.accountId) {
    // An adapter bug, and the one that would silently escape a pin — fail loudly.
    throw new GatewayRequestKernelError(
      `gateway re-attempt must stay on account ${opts.currentRoute.accountId ?? '(none)'}, got ${next.accountId ?? '(none)'}`,
      { code: 'invalid-route', outcome: 'gateway-error', status: 500 },
    );
  }
  validateRoute(opts.base.lane, next, opts.pin, false);
  if (opts.triedRouteKeys.has(next.key)) {
    throw new GatewayRequestKernelError(`gateway re-attempt selected already-tried route ${next.key}`, {
      code: 'route-cycle',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return next;
}

async function selectFailover<TRoute, TPrepared, TChunk, TMetadata>(opts: {
  adapter: GatewayKernelAdapter<TRoute, TPrepared, TChunk, TMetadata>;
  base: GatewayKernelContext;
  currentRoute: GatewayKernelRoute<TRoute>;
  triedRouteKeys: Set<string>;
  attempt: number;
  pin: GatewayKernelAccountPin | null;
  lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
  lastError: GatewayRequestKernelError | null;
}): Promise<GatewayKernelRoute<TRoute> | null> {
  if (opts.pin?.mode === 'hard') return null;
  const next = await abortable(
    Promise.resolve(
      opts.adapter.selectFailover({
        ...opts.base,
        currentRoute: opts.currentRoute,
        triedRouteKeys: [...opts.triedRouteKeys],
        attempt: opts.attempt,
        lastResponse: opts.lastResponse,
        lastError: opts.lastError,
      }),
    ),
    opts.base.signal,
  );
  if (!next) return null;
  validateRoute(opts.base.lane, next, opts.pin, false);
  if (opts.triedRouteKeys.has(next.key)) {
    throw new GatewayRequestKernelError(`gateway failover selected already-tried route ${next.key}`, {
      code: 'route-cycle',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return next;
}

async function pumpResponse<TChunk, TMetadata>(opts: {
  response: GatewayKernelUpstreamResponse<TChunk, TMetadata>;
  downstream: GatewayKernelDownstream<TChunk, TMetadata>;
  signal: AbortSignal;
  bodyIdleTimeoutMs: number;
  downstreamIdleTimeoutMs: number;
  /**
   * Tear down the upstream transport for the attempt being relayed. Called FIRST on
   * any relay failure, before the cooperative cleanup that would otherwise wait on a
   * stalled stream. Optional so a caller relaying an already-terminal response need
   * not supply one.
   */
  abortUpstream?: (reason: unknown) => void;
}): Promise<void> {
  let iterator: AsyncIterator<TChunk> | undefined;
  let bodyCompleted = false;
  try {
    await withDeadline({
      parent: opts.signal,
      timeoutMs: opts.downstreamIdleTimeoutMs,
      error: () =>
        new GatewayRequestKernelError(`gateway downstream start exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
          code: 'downstream-idle',
          outcome: 'cancelled',
          status: null,
        }),
      run: () =>
        Promise.resolve(
          opts.downstream.start({
            status: opts.response.status,
            streaming: opts.response.streaming,
            transport: opts.response.transport,
            metadata: opts.response.metadata,
          }),
        ),
    });
    iterator = opts.response.body?.[Symbol.asyncIterator]();
    bodyCompleted = !iterator;
    while (iterator) {
      const activeIterator = iterator;
      const next = await withDeadline({
        parent: opts.signal,
        timeoutMs: opts.bodyIdleTimeoutMs,
        error: () =>
          new GatewayRequestKernelError(`gateway upstream body idle exceeded ${opts.bodyIdleTimeoutMs}ms`, {
            code: 'upstream-body-idle',
            outcome: 'upstream-error',
            status: 504,
          }),
        run: (signal) => abortable(Promise.resolve(activeIterator.next()), signal),
      });
      if (next.done) {
        bodyCompleted = true;
        break;
      }
      await withDeadline({
        parent: opts.signal,
        timeoutMs: opts.downstreamIdleTimeoutMs,
        error: () =>
          new GatewayRequestKernelError(`gateway downstream write exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
            code: 'downstream-idle',
            outcome: 'cancelled',
            status: null,
          }),
        run: () => Promise.resolve(opts.downstream.write(next.value)),
      });
    }
    await withDeadline({
      parent: opts.signal,
      timeoutMs: opts.downstreamIdleTimeoutMs,
      error: () =>
        new GatewayRequestKernelError(`gateway downstream end exceeded ${opts.downstreamIdleTimeoutMs}ms`, {
          code: 'downstream-idle',
          outcome: 'cancelled',
          status: null,
        }),
      run: () => Promise.resolve(opts.downstream.end()),
    });
  } catch (error) {
    // TEAR THE UPSTREAM DOWN FIRST. Everything below is COOPERATIVE cleanup —
    // `iterator.return()` cancels the stream, `discard()` cancels the body — and a
    // stalled upstream is precisely the case where cooperation cannot complete: both
    // wait on the stream that has stopped producing. Aborting first turns those into
    // prompt rejections instead of an unbounded wait, which is what keeps a
    // mid-stream stall from wedging the request and holding its admission slot.
    opts.abortUpstream?.(error);
    const cleanupErrors: unknown[] = [];
    if (!bodyCompleted) {
      try {
        await iterator?.return?.();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await opts.response.discard?.();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], 'gateway response forwarding and cleanup both failed');
    }
    throw error;
  }
}

export async function executeGatewayRequestKernel<TRoute, TPrepared, TChunk, TMetadata>(
  opts: ExecuteGatewayRequestKernelOptions<TRoute, TPrepared, TChunk, TMetadata>,
): Promise<GatewayKernelExecutionResult<TRoute>> {
  validatePolicy(opts.policy);
  const provider = telemetryProviderForLane(opts.request.lane);
  const span =
    opts.span ??
    opts.telemetry.begin({
      ownerId: opts.request.ownerId,
      provider,
      protocol: opts.request.lane.protocol,
    });
  const correlationId = boundedCorrelationId(opts.request.correlationId, `gateway-${span.requestId}`);
  const pin = opts.request.pin ?? null;
  const requestController = new AbortController();
  const cancel = (source: AbortSignal) =>
    requestController.abort(
      source.reason instanceof GatewayRequestKernelError
        ? source.reason
        : cancellationError(source.reason instanceof Error ? source.reason.message : undefined),
    );
  const onCallerAbort = () => cancel(opts.request.signal!);
  const onDownstreamAbort = () => cancel(opts.downstream.signal!);
  if (opts.request.signal?.aborted) onCallerAbort();
  else opts.request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (opts.downstream.signal?.aborted) onDownstreamAbort();
  else opts.downstream.signal?.addEventListener('abort', onDownstreamAbort, { once: true });
  const ceilingTimer = setTimeout(
    () =>
      requestController.abort(
        new GatewayRequestKernelError(`gateway request exceeded ${opts.policy.requestCeilingMs}ms ceiling`, {
          code: 'request-ceiling',
          outcome: 'gateway-error',
          status: 504,
        }),
      ),
    opts.policy.requestCeilingMs,
  );
  ceilingTimer.unref?.();

  const base: GatewayKernelContext = {
    requestId: span.requestId,
    correlationId,
    lane: opts.request.lane,
    ownerId: span.ownerId,
    pin,
    signal: requestController.signal,
    startedAt: span.startedAt,
  };
  const triedRouteKeys = new Set<string>();
  /**
   * Pick the next route after a retryable failure. A SAME-account re-attempt is tried
   * first (a refreshed token, a sibling egress IP), mirroring the live handlers'
   * `siblingEgressAvailable(...) || rotate(...)` ordering — exhaust the cheap retry
   * before parking the account. Only the account-changing branch is a `failover`, so
   * the caller can keep counting the two apart the way the legacy ladders did.
   */
  const chooseNextRoute = async (args: {
    currentRoute: GatewayKernelRoute<TRoute>;
    attempt: number;
    lastResponse: GatewayKernelUpstreamResponse<TChunk, TMetadata> | null;
    lastError: GatewayRequestKernelError | null;
  }): Promise<{ route: GatewayKernelRoute<TRoute>; kind: 'reattempt' | 'failover' } | null> => {
    span.beginStage('routeSelection');
    try {
      const selection = {
        adapter: opts.adapter,
        base,
        currentRoute: args.currentRoute,
        triedRouteKeys,
        attempt: args.attempt,
        pin,
        lastResponse: args.lastResponse,
        lastError: args.lastError,
      };
      const reattempt = await selectReattempt(selection);
      if (reattempt) return { route: reattempt, kind: 'reattempt' };
      const failover = await selectFailover(selection);
      return failover ? { route: failover, kind: 'failover' } : null;
    } finally {
      span.endStage('routeSelection');
    }
  };

  /** Adopt a chosen route; a re-attempt deliberately does not count as a failover. */
  const adoptRoute = (chosen: { route: GatewayKernelRoute<TRoute>; kind: 'reattempt' | 'failover' }) => {
    triedRouteKeys.add(chosen.route.key);
    if (chosen.kind === 'failover') {
      span.recordFailover();
      failovers++;
    }
    return chosen.route;
  };
  let route: GatewayKernelRoute<TRoute> | null = null;
  let streaming = false;
  let attempts = 0;
  let failovers = 0;
  let finalStatus: number | null = null;
  let finalOutcome: GatewayRequestOutcome = 'unclassified';
  let failure: GatewayRequestKernelError | null = null;
  let timeline: GatewayRequestTimeline | null = null;

  try {
    route = await abortable(
      Promise.resolve(
        opts.adapter.selectInitial({
          ...base,
          currentRoute: null,
          triedRouteKeys: [],
          attempt: 0,
          lastResponse: null,
          lastError: null,
        }),
      ),
      requestController.signal,
    );
    validateRoute(opts.request.lane, route, pin, true);
    triedRouteKeys.add(route.key);
    span.setTransport(route.transport);
    span.routeSelected();
    let currentRoute: GatewayKernelRoute<TRoute> = route;

    await opts.admission.run({ ...base, route: currentRoute }, async () => {
      span.admitted();
      let inFlight: GatewayKernelInFlightHandle | null = null;
      let lifecycleFailure: GatewayRequestKernelError | null = null;
      try {
        inFlight = await abortable(
          Promise.resolve(
            opts.inFlight.register({
              requestId: base.requestId,
              correlationId,
              laneId: opts.request.lane.id,
              provider,
              startedAt: base.startedAt,
              isStreaming: () => streaming,
              abort: (reason) => requestController.abort(cancellationError(reason)),
            }),
          ),
          requestController.signal,
        );

        span.beginStage('bodyRead');
        let body: Buffer;
        try {
          body = await readBoundedGatewayRequestBody({
            source: opts.request.body,
            maxBytes: opts.policy.maxBodyBytes,
            timeoutMs: opts.policy.bodyReadTimeoutMs,
            signal: requestController.signal,
          });
        } finally {
          span.endStage('bodyRead');
        }

        // D-007: resolve the TTFB deadline ONCE, now that the body is known,
        // so a lane can pick its streaming deadline without its own timer.
        const ttfbTimeoutMs = assertPositiveTtfb(
          typeof opts.policy.ttfbTimeoutMs === 'function'
            ? opts.policy.ttfbTimeoutMs({ body, lane: opts.request.lane })
            : opts.policy.ttfbTimeoutMs,
        );

        for (let attempt = 1; attempt <= opts.policy.maxAttempts; attempt++) {
          attempts = attempt;
          // D-018: the route's own pre-attempt pace, BEFORE the attempt context is
          // used and outside every stage span. The legacy ladders slept here — after
          // deciding to proceed, before re-entering the loop — so a rotate onto a
          // fresh account did not land inside the throttle window it was fleeing.
          // `selectInitial` carries no delay, so the first attempt never waits.
          await delayBeforeAttempt(currentRoute.delayMs ?? 0, requestController.signal);
          const attemptContext: GatewayKernelAttemptContext<TRoute> = {
            ...base,
            route: currentRoute,
            body,
            attempt,
            maxAttempts: opts.policy.maxAttempts,
            triedRouteKeys: [...triedRouteKeys],
          };
          span.setTransport(currentRoute.transport);
          const measureAuth = provider !== 'local';
          if (measureAuth) span.beginStage('auth');
          let prepared!: TPrepared;
          let preparationFailure: GatewayRequestKernelError | null = null;
          try {
            prepared = await abortable(
              Promise.resolve(opts.adapter.prepareAttempt(attemptContext)),
              requestController.signal,
            );
          } catch (error) {
            preparationFailure = normalizeError(error, requestController.signal);
          } finally {
            if (measureAuth) span.endStage('auth');
          }
          if (preparationFailure) {
            await opts.admission.observeAttempt?.({
              context: attemptContext,
              response: null,
              error: preparationFailure,
            });
            if (preparationFailure.retryable && attempt < opts.policy.maxAttempts) {
              const next = await chooseNextRoute({
                currentRoute,
                attempt,
                lastResponse: null,
                lastError: preparationFailure,
              });
              if (next) {
                route = currentRoute = adoptRoute(next);
                continue;
              }
            }
            throw preparationFailure;
          }

          span.recordAttempt();
          span.beginStage('upstreamTtfb');
          // D-014: the body-derived deadline above is constant for the request;
          // a lane's wedge-prevention BUDGET is not, so re-read the cap here —
          // inside the loop — and give this attempt only what is left of it.
          // A cap that is absent or non-finite leaves the deadline untouched.
          const cap = opts.policy.ttfbCapMs?.();
          const attemptTtfbMs =
            typeof cap === 'number' && Number.isFinite(cap)
              ? Math.max(1, Math.min(ttfbTimeoutMs, Math.floor(cap)))
              : ttfbTimeoutMs;
          let response!: GatewayKernelUpstreamResponse<TChunk, TMetadata>;
          let attemptFailure: GatewayRequestKernelError | null = null;
          /**
           * The abort handle for THIS attempt's upstream call, and it must outlive the
           * TTFB window.
           *
           * `withDeadline` owns a controller scoped to the wait it is bounding: when the
           * wait settles, its `finally` clears the timer AND unsubscribes from the
           * parent. Handing that short-lived signal to `executeAttempt` therefore left
           * the upstream request UN-ABORTABLE the instant headers arrived — the body
           * phase had no live path from `requestController` to the socket, so a
           * mid-stream body-idle deadline could stop AWAITING the body but never tear it
           * down. The cooperative cleanup then waits on the very stream that has stopped
           * producing, and the request wedges holding its admission slot. The
           * pre-kernel ladder never had this gap: its stall timer aborted the same
           * signal the upstream fetch was created with.
           *
           * So the attempt gets its own controller, linked to the request for the whole
           * attempt, aborted by the TTFB deadline, and abortable again during relay.
           */
          const attemptController = new AbortController();
          const forwardRequestAbort = () => attemptController.abort(abortReason(requestController.signal));
          if (requestController.signal.aborted) forwardRequestAbort();
          else requestController.signal.addEventListener('abort', forwardRequestAbort, { once: true });
          const abortUpstream = (reason: unknown) => attemptController.abort(reason);
          try {
            response = await withDeadline({
              parent: requestController.signal,
              timeoutMs: attemptTtfbMs,
              error: () =>
                new GatewayRequestKernelError(`gateway upstream TTFB exceeded ${attemptTtfbMs}ms`, {
                  code: 'ttfb-timeout',
                  outcome: 'upstream-error',
                  status: 504,
                  retryable: true,
                }),
              run: (signal) => {
                // Propagate the TTFB deadline onto the attempt so a timed-out attempt
                // still destroys its socket rather than merely being un-awaited.
                if (signal.aborted) attemptController.abort(abortReason(signal));
                else
                  signal.addEventListener('abort', () => attemptController.abort(abortReason(signal)), {
                    once: true,
                  });
                return opts.adapter.executeAttempt(prepared, {
                  ...attemptContext,
                  signal: attemptController.signal,
                });
              },
            });
          } catch (error) {
            attemptFailure = normalizeError(error, requestController.signal);
          } finally {
            span.endStage('upstreamTtfb');
          }
          if (attemptFailure) {
            await opts.admission.observeAttempt?.({
              context: attemptContext,
              response: null,
              error: attemptFailure,
            });
            if (attemptFailure.retryable && attempt < opts.policy.maxAttempts) {
              const next = await chooseNextRoute({
                currentRoute,
                attempt,
                lastResponse: null,
                lastError: attemptFailure,
              });
              if (next) {
                route = currentRoute = adoptRoute(next);
                continue;
              }
            }
            throw attemptFailure;
          }

          validateRoute(opts.request.lane, { ...currentRoute, transport: response.transport }, pin, false);
          span.setTransport(response.transport);
          try {
            await opts.admission.observeAttempt?.({ context: attemptContext, response, error: null });
          } catch (error) {
            try {
              await response.discard?.();
            } catch (discardError) {
              throw new AggregateError(
                [error, discardError],
                'gateway attempt observation and response cleanup both failed',
              );
            }
            throw error;
          }
          if (response.retryable && attempt < opts.policy.maxAttempts) {
            let next: { route: GatewayKernelRoute<TRoute>; kind: 'reattempt' | 'failover' } | null;
            try {
              next = await chooseNextRoute({
                currentRoute,
                attempt,
                lastResponse: response,
                lastError: null,
              });
            } catch (error) {
              try {
                await response.discard?.();
              } catch (discardError) {
                throw new AggregateError(
                  [error, discardError],
                  'gateway failover selection and response cleanup both failed',
                );
              }
              throw error;
            }
            if (next) {
              await response.discard?.();
              route = currentRoute = adoptRoute(next);
              continue;
            }
          }

          streaming = response.streaming;
          span.setStreaming(streaming);
          if (streaming) span.beginStage('stream');
          try {
            await pumpResponse({
              response,
              downstream: opts.downstream,
              signal: requestController.signal,
              bodyIdleTimeoutMs: opts.policy.bodyIdleTimeoutMs,
              downstreamIdleTimeoutMs: opts.policy.downstreamIdleTimeoutMs,
              abortUpstream,
            });
          } finally {
            if (streaming) span.endStage('stream');
          }
          finalStatus = response.status;
          finalOutcome = response.outcome ?? classifyGatewayTelemetryOutcome(response.status);
          break;
        }

        if (finalStatus === null || !route) {
          throw new GatewayRequestKernelError('gateway request exhausted its attempt budget without a response', {
            code: 'upstream-error',
            outcome: 'upstream-error',
            status: 502,
          });
        }
      } catch (error) {
        lifecycleFailure = normalizeError(error, requestController.signal);
        finalOutcome = lifecycleFailure.outcome;
        finalStatus = lifecycleFailure.status;
      }

      let unregisterFailure: unknown;
      if (inFlight) {
        try {
          await inFlight.unregister({ outcome: finalOutcome, status: finalStatus });
        } catch (error) {
          unregisterFailure = error;
        }
      }
      if (unregisterFailure !== undefined) {
        throw new GatewayRequestKernelError('gateway in-flight unregister failed before slot release', {
          code: 'gateway-error',
          outcome: 'gateway-error',
          status: 500,
          cause: lifecycleFailure ? new AggregateError([lifecycleFailure, unregisterFailure]) : unregisterFailure,
        });
      }
      if (lifecycleFailure) throw lifecycleFailure;
    });
  } catch (error) {
    failure = normalizeError(error, requestController.signal);
    finalOutcome = failure.outcome;
    finalStatus = failure.status;
  } finally {
    clearTimeout(ceilingTimer);
    opts.request.signal?.removeEventListener('abort', onCallerAbort);
    opts.downstream.signal?.removeEventListener('abort', onDownstreamAbort);
    if (!opts.deferSpanFinalization || failure === null) {
      timeline = span.finish(finalOutcome, finalStatus);
    }
  }

  if (failure) {
    failure.timeline = timeline ?? undefined;
    throw failure;
  }
  if (!route || finalStatus === null || !timeline) {
    throw new GatewayRequestKernelError('gateway request kernel failed to produce a terminal result', {
      code: 'gateway-error',
      outcome: 'gateway-error',
      status: 500,
    });
  }
  return {
    requestId: span.requestId,
    correlationId,
    laneId: opts.request.lane.id,
    status: finalStatus,
    outcome: finalOutcome,
    attempts,
    failovers,
    finalRoute: route,
    timeline,
  };
}
