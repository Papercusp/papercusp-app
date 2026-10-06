/**
 * Codex bearer lane adapter for the provider-neutral request kernel.
 *
 * This is the FIRST `GatewayKernelAdapter` implementation (plan
 * `gateway-kernel-adoption-2026-08-29`, P-002). It expresses exactly the
 * protocol/transport-owned half of `proxyOpenAi`'s hand-rolled ladder —
 * account selection, token resolution, header construction, the upstream
 * call, and retryability normalization — and NOTHING else. Every shared
 * request invariant (abort wiring, request ceiling, bounded body read,
 * admission, in-flight registration, the TTFB-then-body-idle single-timer
 * ladder, failover bookkeeping, stage telemetry) belongs to
 * `executeGatewayRequestKernel` and is deliberately absent here.
 *
 * SCOPE BOUNDARY — bearer only. `proxyOpenAi` falls back to the ChatGPT
 * CLI bridge (`cli-exec` / `oauth-http`) when no bearer account resolves.
 * That fallback is a DIFFERENT transport on the same lane and is chosen
 * BEFORE the kernel is entered, exactly as the live handler chooses it
 * before its bearer path. This adapter is therefore only constructed once
 * a bearer account is known to be resolvable; `selectInitial` surfaces a
 * typed error rather than silently substituting a CLI route.
 *
 * TWO INVARIANTS THE KERNEL ALREADY OWNS — do not re-implement them here:
 *  1. Hard-pin failover suppression. `rotateCodex` opens with
 *     `if (hardPin) return false`; the kernel's own failover wrapper
 *     (`request-kernel.ts`) returns null for `pin.mode === 'hard'` before
 *     the adapter is consulted, so this adapter never sees that case.
 *  2. Route-cycle rejection. The kernel THROWS `route-cycle` if a failover
 *     returns an already-tried route key. `rotateCodex` compared only
 *     against the CURRENT account, so an A->B->A rotation was silently
 *     possible there; here `selectFailover` must decline instead, which is
 *     why it consults `triedRouteKeys` rather than just the current id.
 */
import { describeFetchError } from '../loopback-fetch';
import type { GatewayTransportId } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { presentedSecretsFromHeaders, scrubbedErrorBody } from './error-body-scrub';
import {
  GatewayRequestKernelError,
  withPromiseDeadline,
  type GatewayKernelAdapter,
  type GatewayKernelAttemptContext,
  type GatewayKernelRoute,
  type GatewayKernelRouteContext,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';

const BEARER_TRANSPORT: GatewayTransportId = 'bearer-http';

/** Route payload: the resolved bearer account for one attempt. */
export interface CodexBearerRouteValue {
  account: ActiveAccount;
}

export type CodexBearerChunk = Uint8Array;

export interface CodexBearerResponseMetadata {
  /** Account that actually served the attempt (`x-papercusp-routed-account`). */
  accountId: string;
  /** Upstream response headers, lowercased keys, pre-strip. */
  headers: Record<string, string>;
  /**
   * Set when a SOFT pin yielded to a different account, so the caller can
   * emit the pin-yield header and its owner-outcome. Null when the serving
   * account is the pinned one, or when nothing was pinned.
   */
  pinYieldedFrom: string | null;
}

export interface CodexBearerPreparedAttempt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  accountId: string;
  dispatcher: unknown;
}

/**
 * Minimal structural view of a WHATWG `Response`. Structural rather than
 * the DOM type so a unit test can drive the adapter with a plain object and
 * no network, and so the adapter never depends on the gateway's `doFetch`.
 */
export interface CodexBearerFetchResponse {
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  body: (AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void }) | null;
}

export interface CodexBearerFetchInit {
  method: string;
  /** Prepared routing identity for internal telemetry; never an HTTP header. */
  diagnosticAccountId?: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  signal: AbortSignal;
  dispatcher: unknown;
}

export interface CodexBearerAdapterOptions {
  pool: AccountPool;
  /** e.g. `https://api.openai.com` — joined with the request path verbatim. */
  upstreamBase: string;
  /** Request path as received downstream, e.g. `/v1/responses`. */
  urlPath: string;
  method: string;
  /** Downstream request headers; forwarded minus `stripRequestHeaders`. */
  requestHeaders: Record<string, string | string[] | undefined>;
  /** Lowercased hop-by-hop / auth headers the gateway must not forward. */
  stripRequestHeaders: ReadonlySet<string>;
  tokenTimeoutMs: number;
  /** Backoff applied to an account parked without an explicit rate reset. */
  failoverBackoffMs: number;
  fetch(url: string, init: CodexBearerFetchInit): Promise<CodexBearerFetchResponse>;
  /** Per-account upstream egress binding. */
  dispatcherFor?(account: ActiveAccount): unknown | Promise<unknown>;
  /** Parses `x-ratelimit-reset*` into an epoch-ms retry instant. */
  rateResetAt?(headers: Record<string, string>): number | null;
  /**
   * Once-per-request shaping of the buffered body — the gateway wires its
   * prompt-cache policy rewrite here (`rewriteOpenAiCacheBody` + its
   * `recordCachePolicy` / `setCacheRouting` side-effects).
   *
   * Called EXACTLY ONCE per request, on the first `prepareAttempt`, so a
   * failover re-sends the same shaped bytes and the cache-policy counters are
   * not double-counted — matching the live handler, which rewrites `bodyBuf`
   * before its attempt loop rather than inside it.
   *
   * ORDERING NOTE (why this does not need a kernel hook, unlike D-007's TTFB
   * resolver): the kernel resolves the TTFB deadline from its own PRE-shape
   * buffer, before any attempt. That is safe here only because the shaping
   * this seam exists for provably cannot change the fields the deadline is
   * derived from — `applyOpenAiCachePolicy` writes `prompt_cache_retention`,
   * `prompt_cache_options` and `prompt_cache_key` and nothing else, and only
   * when they are unset. A future shaper that touched `stream` WOULD need the
   * kernel-side hook; assert that in a test rather than assuming it.
   */
  shapeRequestBody?(body: Buffer, context: { accountId: string; ownerId: string | null }): Buffer;
  /**
   * Reports the request-derived shape once it is known, so the caller can put
   * it on its telemetry span. The live handler emits `setModel` / `setStreaming`
   * from exactly these values; the kernel emits `setStreaming` itself from the
   * response, and does not emit the model at all.
   */
  onRequestShape?(shape: CodexRequestShape): void;
  now?(): number;
}

/** Request-derived facts the live handler parses out of the body before its loop. */
export interface CodexRequestShape {
  model: string | null;
  streaming: boolean;
}

/**
 * Parse the request-derived shape exactly as `proxyOpenAi` does.
 *
 * EXPORTED because two independent consumers must agree on it: this adapter
 * (which reports `streaming` on the upstream response) and the gateway's D-007
 * `ttfbTimeoutMs` resolver (which picks the short stream deadline). Deriving
 * the same fact twice from two hand-written parsers is precisely the drift
 * D-007 was raised to correct, so they share this one.
 *
 * A non-JSON or unparseable body yields `streaming:false` — the generous
 * non-stream deadline — mirroring the live handler's `catch`.
 */
export function parseCodexRequestShape(body: Buffer): CodexRequestShape {
  if (!body.length) return { model: null, streaming: false };
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { stream?: boolean; model?: string };
    return {
      model: typeof parsed.model === 'string' ? parsed.model : null,
      streaming: parsed.stream === true,
    };
  } catch {
    return { model: null, streaming: false };
  }
}

export type CodexBearerKernelAdapter = GatewayKernelAdapter<
  CodexBearerRouteValue,
  CodexBearerPreparedAttempt,
  CodexBearerChunk,
  CodexBearerResponseMetadata
>;

export type CodexBearerUpstream = GatewayKernelUpstreamResponse<CodexBearerChunk, CodexBearerResponseMetadata>;

function routeFor(account: ActiveAccount): GatewayKernelRoute<CodexBearerRouteValue> {
  return {
    key: `bearer:${account.accountId}`,
    accountId: account.accountId,
    transport: BEARER_TRANSPORT,
    value: { account },
  };
}

function headersToObject(headers: CodexBearerFetchResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function createCodexBearerKernelAdapter(opts: CodexBearerAdapterOptions): CodexBearerKernelAdapter {
  const now = opts.now ?? (() => Date.now());
  // Which account the caller asked for, captured at initial selection so a
  // soft-pin yield can be reported on the response metadata.
  let pinnedAccountId: string | null = null;

  // Body shaping + request-derived facts, computed ONCE and reused by every
  // attempt. The live handler does this before its attempt loop; memoizing
  // here reproduces that placement without a kernel-side hook (see
  // `shapeRequestBody`'s ordering note).
  let shaped: { body: Buffer; shape: CodexRequestShape } | null = null;
  const shapeOnce = (context: GatewayKernelAttemptContext<CodexBearerRouteValue>) => {
    if (shaped) return shaped;
    const body = opts.shapeRequestBody
      ? opts.shapeRequestBody(context.body, {
          accountId: context.route.value.account.accountId,
          ownerId: context.ownerId,
        })
      : context.body;
    const shape = parseCodexRequestShape(body);
    shaped = { body, shape };
    opts.onRequestShape?.(shape);
    return shaped;
  };

  const resolveFailoverResetAt = (
    context: GatewayKernelRouteContext<CodexBearerRouteValue, CodexBearerChunk, CodexBearerResponseMetadata>,
  ): number => {
    const headers = context.lastResponse?.metadata?.headers;
    if (headers && opts.rateResetAt) {
      const parsed = opts.rateResetAt(headers);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
    }
    return now() + opts.failoverBackoffMs;
  };

  return {
    selectInitial(context) {
      const pinnedId = context.pin?.accountId;
      const pinned = pinnedId ? (opts.pool.select?.(pinnedId) ?? null) : null;
      pinnedAccountId = pinned?.accountId ?? null;
      let account: ActiveAccount | null = pinned;
      if (!account) {
        try {
          account = opts.pool.active();
        } catch (error) {
          // The live handler falls back to the CLI bridge here. That is a
          // different transport chosen before the kernel is entered, so the
          // kernel surfaces the unavailability instead of substituting.
          throw new GatewayRequestKernelError(
            `inference-gateway: no Codex bearer account available: ${(error as Error).message}`,
            { code: 'invalid-route', outcome: 'gateway-error', status: 503 },
          );
        }
      }
      return routeFor(account);
    },

    selectFailover(context) {
      // Hard pins never reach here — the kernel's failover wrapper declines
      // them before consulting the adapter (see the header note).
      // `currentRoute` is typed nullable because the same context shape is
      // reused for initial selection; failover always carries one.
      const currentRoute = context.currentRoute;
      if (!currentRoute) return null;
      const current = currentRoute.value.account.accountId;
      const next = opts.pool.onExhausted(current, resolveFailoverResetAt(context));
      if (!next || next.accountId === current) return null;
      // The kernel throws `route-cycle` on an already-tried key, so decline
      // instead of handing one back.
      if (context.triedRouteKeys.includes(routeFor(next).key)) return null;
      return routeFor(next);
    },

    async prepareAttempt(
      context: GatewayKernelAttemptContext<CodexBearerRouteValue>,
    ): Promise<CodexBearerPreparedAttempt> {
      const account = context.route.value.account;
      // Shape BEFORE the token read so the cache-policy side-effects fire on
      // the same attempt the live handler fires them on, even if the token
      // read then throws and rotates.
      const body = shapeOnce(context).body;
      let token: string;
      try {
        token = await withPromiseDeadline(account.token(), opts.tokenTimeoutMs, `codex token '${account.accountId}'`);
      } catch (error) {
        // Token-read failure rotates to another account in the live handler;
        // `retryable` is what routes this to the kernel's failover path.
        throw new GatewayRequestKernelError(
          `inference-gateway: Codex token unavailable for '${account.accountId}': ${(error as Error).message}`,
          { code: 'upstream-error', outcome: 'upstream-error', status: 503, retryable: true },
        );
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(opts.requestHeaders)) {
        if (value === undefined || opts.stripRequestHeaders.has(key.toLowerCase())) continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      headers.authorization = `Bearer ${token}`;
      headers['accept-encoding'] = 'identity';

      return {
        url: `${opts.upstreamBase}${opts.urlPath}`,
        method: opts.method,
        headers,
        body: body.length ? new Uint8Array(body) : null,
        accountId: account.accountId,
        dispatcher: (await opts.dispatcherFor?.(account)) ?? undefined,
      };
    },

    async executeAttempt(
      prepared: CodexBearerPreparedAttempt,
      context: GatewayKernelAttemptContext<CodexBearerRouteValue>,
    ): Promise<CodexBearerUpstream> {
      const account = context.route.value.account;
      let upstream: CodexBearerFetchResponse;
      try {
        upstream = await opts.fetch(prepared.url, {
          method: prepared.method,
          diagnosticAccountId: prepared.accountId,
          headers: prepared.headers,
          body: prepared.body,
          signal: context.signal,
          dispatcher: prepared.dispatcher,
        });
      } catch (error) {
        // Transport failure (dead/hanging proxy or network) → route around
        // to another account, mirroring the live handler.
        // A terminal pre-send admission refusal is not a broken credential or
        // network: preserve it before invalidating or selecting another account.
        if (error instanceof GatewayRequestKernelError && !error.retryable) throw error;
        account.invalidateToken?.();
        throw new GatewayRequestKernelError(
          `inference-gateway: Codex upstream failed: ${describeFetchError(error)}`,
          { code: 'upstream-error', outcome: 'upstream-error', status: 502, retryable: true, cause: error },
        );
      }

      const headers = headersToObject(upstream.headers);
      const pinYieldedFrom =
        pinnedAccountId && pinnedAccountId !== account.accountId ? pinnedAccountId : null;

      return {
        status: upstream.status,
        // D-007: request-derived, NOT the response content-type. The live
        // handler parses `stream:true` out of the REQUEST body and uses that
        // one fact for both its TTFB choice and its span; an error response to
        // a streaming request (a JSON 429 body) is therefore still `streaming`
        // there. Deriving it from the response content-type agreed on the happy
        // path and silently disagreed everywhere else — the D-006 overstatement
        // this replaces.
        streaming: shapeOnce(context).shape.streaming,
        transport: BEARER_TRANSPORT,
        metadata: { accountId: account.accountId, headers, pinYieldedFrom },
        // WI-10004561: an upstream error body may echo the bearer this attempt presented.
        body:
          upstream.status >= 400 && upstream.body
            ? scrubbedErrorBody(upstream.body, presentedSecretsFromHeaders(prepared.headers))
            : upstream.body,
        // 429 is the route-around case; everything else is forwarded as-is
        // so the caller's own client sees the real upstream status.
        retryable: upstream.status === 429,
        discard: upstream.body?.cancel ? () => upstream.body?.cancel?.() : undefined,
      };
    },
  };
}
