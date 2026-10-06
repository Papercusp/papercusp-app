/**
 * Codex ChatGPT-OAuth lane adapter for the provider-neutral request kernel.
 *
 * Plan `gateway-kernel-adoption-2026-08-29`, P-004 — the SECOND
 * `GatewayKernelAdapter`, expressing the protocol/transport-owned half of
 * `serveCodexOAuthProxy` (`openai-responses` lane, `oauth-http` transport):
 * account selection, OAuth token resolution and refresh, egress selection,
 * header construction, the upstream call, and retryability normalization.
 *
 * Everything else belongs to `executeGatewayRequestKernel` and is deliberately
 * absent here: abort wiring, the request ceiling, the bounded body read, the
 * TTFB-then-body-idle single-timer ladder, admission, in-flight registration,
 * attempt counting and failover bookkeeping.
 *
 * THREE THINGS THIS LANE DOES THAT THE BEARER LANE (P-002/P-003) DOES NOT:
 *
 *  1. IT RE-ATTEMPTS THE SAME ACCOUNT (D-011). A 401 refreshes the token and
 *     retries the same account; a transport failure or 429 retries the same
 *     account on a sibling egress IP before rotating. Both are expressed as
 *     `selectReattempt` routes, NOT failovers, because the live handler does
 *     not gate either on the hard pin the way it gates account rotation, and
 *     does not count either as a failover. See D-011 for why that needed a
 *     narrow kernel change rather than an adapter-internal retry loop.
 *
 *  2. IT NEVER CALLS `pool.active()` (D-010). `proxyOpenAi` has already spent
 *     this request's one `codexCliPool.active()` call to resolve the account
 *     before this handler is entered (gateway.ts:5948), and `active()` ADVANCES
 *     the round-robin. Rather than wrap the pool in a replay view as the bearer
 *     lane must, this adapter takes the already-resolved account as
 *     `initialAccount` and never selects an initial account at all — the
 *     double-advance is structurally impossible here, not merely avoided.
 *
 *  3. ITS 429 IS NOT UNCONDITIONALLY RETRYABLE-BY-ROTATION. A 401 is retryable
 *     only via refresh: once this account has already refreshed, the live
 *     handler FORWARDS the 401 rather than rotating, so `selectFailover`
 *     declines on a 401 (see `selectFailover` below).
 *
 * SCOPE BOUNDARY: the one-shot `cli-exec` bridge is a DIFFERENT transport on the
 * same lane, selected from the request body BEFORE the kernel is entered
 * (gateway.ts:5451). This adapter is oauth-http only and never substitutes it.
 */
import { describeFetchError } from '../loopback-fetch';
import type { GatewayTransportId } from './provider-adapters';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { presentedSecretsFromHeaders, scrubbedErrorBody } from './error-body-scrub';
import { isCodexAuthFailure, type CodexCliAccount } from './codex-cli-bridge';
import { rewriteCodexRequestModel, type CodexAuth } from './codex-oauth-proxy';
import {
  CODEX_REFUSAL_BODY_MAX_BYTES,
  codexModelRefusalDetail,
  isCodexModelRefusal,
} from './codex-model-refusals';
import {
  GatewayRequestKernelError,
  withPromiseDeadline,
  type GatewayKernelAdapter,
  type GatewayKernelAttemptContext,
  type GatewayKernelRoute,
  type GatewayKernelRouteContext,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';

const OAUTH_TRANSPORT: GatewayTransportId = 'oauth-http';

/** Why a route exists. Drives token handling in `prepareAttempt` and keeps every
 *  route key distinct, which is what the kernel's route-cycle guard reads. */
export type CodexOAuthRouteReason =
  | 'initial'
  | 'refresh'
  | 'sibling-egress'
  | 'rotate'
  | 'reserve'
  | 'reserve-fallback';

/** An egress binding as this adapter sees it. The entry itself is opaque — it is
 *  handed straight back to `dispatcherFor`, exactly as the live handler passes
 *  `pickedEgress.entry` through to `dispatcherFor(activeCli, entry)`. */
export interface CodexOAuthEgressPick {
  entry: unknown;
  key: string;
}

export interface CodexOAuthRouteValue {
  account: CodexCliAccount;
  egress: CodexOAuthEgressPick;
  reason: CodexOAuthRouteReason;
  /** Public model or the hidden Luna reserve tier used for this attempt. */
  modelMode: 'public' | 'reserve';
}

export type CodexOAuthChunk = Uint8Array;

export interface CodexOAuthResponseMetadata {
  /** Account that actually served the attempt (`x-papercusp-routed-account`). */
  accountId: string;
  /** Upstream response headers, lowercased keys, pre-strip. */
  headers: Record<string, string>;
  /** Set when a SOFT pin yielded to a different account; null otherwise. */
  pinYieldedFrom: string | null;
  /** Egress key that served, so the caller can clear its transport-fail streak. */
  egressKey: string;
  /** Set when this attempt was the backend refusing the request MODEL for this account
   *  (WI-10003306) — the backend's `detail` text. Drives a model-aware failover. */
  modelRefusal?: string | null;
}

export interface CodexOAuthPreparedAttempt {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  accountId: string;
  dispatcher: unknown;
}

/** Structural view of a WHATWG `Response`, so a unit test can drive this adapter
 *  with a plain object and no network. */
export interface CodexOAuthFetchResponse {
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  body: (AsyncIterable<Uint8Array> & { cancel?(): Promise<void> | void }) | null;
}

export interface CodexOAuthFetchInit {
  method: string;
  /** Prepared routing identity for internal telemetry; never an HTTP header. */
  diagnosticAccountId?: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  signal: AbortSignal;
  dispatcher: unknown;
}

export interface CodexOAuthAdapterOptions {
  /**
   * The account `proxyOpenAi` already resolved above the kernel cut. This is the
   * D-010 replay in its strongest form: the adapter has no pool handle for
   * INITIAL selection, so it cannot advance the round-robin a second time.
   */
  initialAccount: CodexCliAccount;
  /** Full subscription list, for mapping a pool rotation back to a `home`. */
  accounts(): readonly CodexCliAccount[];
  /** Rotation pool. Absent ⇒ single-account mode; rotation declines. */
  pool?: AccountPool;
  /** Fully-resolved upstream URL (`codexBackendUrl(url)`). */
  upstreamUrl: string;
  method: string;
  /** Downstream request headers; forwarded minus `stripRequestHeaders`. */
  requestHeaders: Record<string, string | string[] | undefined>;
  stripRequestHeaders: ReadonlySet<string>;
  /**
   * Request-derived streaming flag. Supplied by the caller rather than parsed
   * here because it is decided ABOVE the kernel — it also selects the cli-exec
   * fallback — so parsing it again would be the exact two-parsers drift D-007
   * was raised to correct.
   */
  streaming: boolean;
  /** Hidden upstream model to try after a public Luna 429. */
  reserveModel?: string | null;
  tokenTimeoutMs: number;
  /** Credential-death quarantine, deliberately longer than the ordinary retry backoff. */
  authQuarantineMs: number;
  /** Backoff applied to an account parked without an explicit rate reset. */
  failoverBackoffMs: number;
  /** Cap on a 429-derived IP cooldown. */
  ipCooldownMaxMs: number;
  /** Cooldown applied to an egress IP that failed at the transport layer. */
  transportCooldownMs: number;
  resolveAccessToken(home: string): Promise<CodexAuth>;
  /**
   * Refresh the account's OAuth material through the egress selected for this
   * attempt. The dispatcher is opaque here; the gateway callback owns adapting
   * it to its injected fetch implementation.
   */
  refreshAccessToken(home: string, current: CodexAuth, dispatcher?: unknown): Promise<CodexAuth>;
  buildHeaders(args: {
    base: Record<string, string>;
    accessToken: string;
    accountId: string | null;
  }): Record<string, string>;
  pickEgress(account: ActiveAccount, now: number): CodexOAuthEgressPick;
  siblingEgressAvailable(account: ActiveAccount, now: number, currentKey: string): boolean;
  coolIp(key: string, ms: number): void;
  dispatcherFor(account: ActiveAccount, entry: unknown): unknown | Promise<unknown>;
  fetch(url: string, init: CodexOAuthFetchInit): Promise<CodexOAuthFetchResponse>;
  /** Parses `x-ratelimit-reset*` / `retry-after` into an epoch-ms instant + delay. */
  rateReset(headers: Record<string, string>): { resetAt: number | null; retryAfterMs: number | null };
  /** Per-account upstream ATTEMPT tally (the denominator for egress fail rate). */
  onEgressAttempt?(accountId: string): void;
  /** Per-account transport-FAILURE tally. */
  onEgressFailure?(accountId: string): void;
  /**
   * The request's public model id (WI-10003306). When set, a definitive model refusal
   * (`400 "The '<model>' model is not supported when using Codex with a ChatGPT account."`) is
   * classified, reported through `onModelRefused`, and failed over through `selectAlternate`
   * instead of being forwarded as final. Absent ⇒ legacy behaviour (every such 4xx forwarded).
   */
  model?: string | null;
  /** A public-model attempt was refused for this account. Fire-and-forget bookkeeping. */
  onModelRefused?(info: { accountId: string; model: string; status: number; detail: string }): void;
  /** A public-model attempt got a 2xx on this account — the pair is serviceable again. */
  onModelServed?(info: { accountId: string; model: string }): void;
  /**
   * Pick an account to retry a MODEL-REFUSED request on, skipping `exclude` (accounts already
   * tried) and any account known to refuse the model. Must NOT park anything: a model refusal says
   * nothing about the account's capacity for other models, so `pool.onExhausted` is the wrong
   * tool here. Null ⇒ no account can serve the model; the refusal is forwarded truthfully.
   */
  selectAlternate?(exclude: ReadonlySet<string>): { accountId: string } | null;
  now?(): number;
}

/** Drain at most `max` bytes of an upstream error body so it can be classified, then hand the
 *  kernel an equivalent replayable body. Error bodies are tiny; the cap only bounds a hostile one. */
async function bufferErrorBody(
  body: CodexOAuthFetchResponse['body'],
  max: number,
): Promise<{ text: string; body: CodexOAuthFetchResponse['body'] }> {
  if (!body) return { text: '', body };
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      const buf = Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size >= max) break;
    }
  } catch {
    /* a truncated error body is still forwarded as far as it was read */
  }
  const bytes = Buffer.concat(chunks);
  const replay = {
    async *[Symbol.asyncIterator]() {
      if (bytes.length) yield new Uint8Array(bytes);
    },
    cancel() {
      /* already drained */
    },
  };
  return { text: bytes.toString('utf8'), body: replay };
}

export type CodexOAuthKernelAdapter = GatewayKernelAdapter<
  CodexOAuthRouteValue,
  CodexOAuthPreparedAttempt,
  CodexOAuthChunk,
  CodexOAuthResponseMetadata
> & {
  noteRefreshFailure(
    context: GatewayKernelAttemptContext<CodexOAuthRouteValue>,
    error: GatewayRequestKernelError,
  ): { authClass: boolean; parkedAccountId: string | null; nextAccountId: string | null };
};

export type CodexOAuthUpstream = GatewayKernelUpstreamResponse<CodexOAuthChunk, CodexOAuthResponseMetadata>;

function headersToObject(headers: CodexOAuthFetchResponse['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** The read-only account view `pickEgress` / `siblingEgressAvailable` /
 *  `dispatcherFor` consume. Only the egress fields and the id are read, which is
 *  why this can be built before a token has been resolved. */
function egressView(account: CodexCliAccount, token: () => Promise<string>): ActiveAccount {
  return {
    accountId: account.accountId,
    token,
    egress: account.egress,
    egressPool: account.egressPool,
  };
}

export function createCodexOAuthKernelAdapter(opts: CodexOAuthAdapterOptions): CodexOAuthKernelAdapter {
  const now = opts.now ?? (() => Date.now());

  // Which account the caller asked for, so a soft-pin yield can be reported.
  let pinnedAccountId: string | null = null;
  // Cached OAuth material, mirroring the live handler's `auth` / `authAccount`.
  let auth: CodexAuth | undefined;
  let authAccount = '';
  // The live `refreshedAccount` guard, per account: refresh at most ONCE each, so
  // a credential the backend keeps rejecting is forwarded rather than looped.
  const refreshedAccounts = new Set<string>();
  // Accounts already attempted, so rotation cannot cycle back (the kernel throws
  // `route-cycle` on a repeated KEY, and our keys carry a sequence number, so the
  // account-level guard has to be explicit — same reasoning as the bearer adapter).
  const triedAccounts = new Set<string>([opts.initialAccount.accountId]);
  let seq = 0;
  // A public Luna 429 gets one same-account retry on the hidden reserve tier.
  // Once selected, subsequent egress/account retries stay on that tier until a
  // definitive model refusal sends us back to the public model.
  let reserveAttempted = false;
  let hardPinned = false;
  let pendingAuthFailure: { attempt: number; nextAccount: CodexCliAccount | null } | null = null;

  const routeFor = (
    account: CodexCliAccount,
    reason: CodexOAuthRouteReason,
    modelMode: 'public' | 'reserve' = 'public',
  ): GatewayKernelRoute<CodexOAuthRouteValue> => {
    const egress = opts.pickEgress(egressView(account, async () => auth?.accessToken ?? ''), now());
    seq += 1;
    return {
      // Distinct per attempt: a same-account re-attempt MUST present a new key or
      // the kernel's route-cycle guard rejects it (D-011).
      key: `oauth:${account.accountId}:${reason}:${modelMode}:${seq}`,
      accountId: account.accountId,
      transport: OAUTH_TRANSPORT,
      value: { account, egress, reason, modelMode },
    };
  };

  const resolveResetAt = (
    context: GatewayKernelRouteContext<CodexOAuthRouteValue, CodexOAuthChunk, CodexOAuthResponseMetadata>,
  ): number => {
    const headers = context.lastResponse?.metadata?.headers;
    if (headers) {
      const parsed = opts.rateReset(headers);
      if (typeof parsed.resetAt === 'number' && Number.isFinite(parsed.resetAt)) return parsed.resetAt;
    }
    return now() + opts.failoverBackoffMs;
  };

  return {
    noteRefreshFailure(context, error) {
      const { account, reason } = context.route.value;
      if (reason !== 'refresh' || !isCodexAuthFailure(error.message)) {
        return { authClass: false, parkedAccountId: null, nextAccountId: null };
      }

      const park = !hardPinned && Boolean(opts.pool);
      const exhausted = park ? opts.pool!.onExhausted(account.accountId, now() + opts.authQuarantineMs) : null;
      const candidate =
        exhausted && exhausted.accountId !== account.accountId
          ? (opts.accounts().find((item) => item.accountId === exhausted.accountId) ?? null)
          : null;
      const nextAccount = candidate && !triedAccounts.has(candidate.accountId) ? candidate : null;
      pendingAuthFailure = { attempt: context.attempt, nextAccount };
      return {
        authClass: true,
        parkedAccountId: park ? account.accountId : null,
        nextAccountId: nextAccount?.accountId ?? null,
      };
    },

    selectInitial(context) {
      pinnedAccountId = context.pin?.accountId ?? null;
      hardPinned = context.pin?.mode === 'hard';
      // No `pool.active()` — see the header note (D-010).
      return routeFor(opts.initialAccount, 'initial');
    },

    selectReattempt(context) {
      if (pendingAuthFailure?.attempt === context.attempt) return null;
      const currentRoute = context.currentRoute;
      if (!currentRoute) return null;
      const { account, egress, modelMode } = currentRoute.value;
      const status = context.lastResponse?.status ?? null;

      // 401 → refresh this account's token ONCE and retry it. Deliberately not
      // gated on the pin: re-authenticating a hard-pinned account does not leave it.
      if (status === 401) {
        if (refreshedAccounts.has(account.accountId)) return null;
        refreshedAccounts.add(account.accountId);
        return routeFor(account, 'refresh', modelMode);
      }

      // A normal Luna request can be walled on the premium meter while the
      // account still has base-model-inference reserve capacity. Retry once on
      // the backend's hidden reserve model before cooling the egress or rotating
      // the account. This is same-account by construction, so hard pins remain
      // strict.
      if (status === 429 && modelMode === 'public' && opts.reserveModel && !reserveAttempted) {
        reserveAttempted = true;
        return routeFor(account, 'reserve', 'reserve');
      }

      // If the hidden model is not enabled for this subscription, preserve the
      // old public-model behavior after the probe's definitive 4xx refusal.
      // 401/429 are handled by refresh/reserve/rotation below instead.
      if (modelMode === 'reserve' && status !== null && status >= 400 && status < 500 && status !== 401 && status !== 429) {
        return routeFor(account, 'reserve-fallback', 'public');
      }

      // Transport failure (no response) / 429 / retryable 5xx → try a sibling
      // egress IP on the SAME account before parking it, matching the live
      // `siblingEgressAvailable(...) || rotate(...)` order.
      const transportFailure = context.lastResponse === null && context.lastError !== null;
      if (!transportFailure && status !== 429 && !(status !== null && status >= 500)) return null;

      if (status === 429) {
        // The live handler cools the IP before deciding, inside its `canRetry`
        // branch — which is exactly when the kernel consults this hook.
        const reset = opts.rateReset(context.lastResponse?.metadata?.headers ?? {});
        opts.coolIp(egress.key, Math.min(reset.retryAfterMs ?? opts.failoverBackoffMs, opts.ipCooldownMaxMs));
      }
      if (!opts.siblingEgressAvailable(egressView(account, async () => ''), now(), egress.key)) return null;
      return routeFor(account, 'sibling-egress', modelMode);
    },

    selectFailover(context) {
      if (pendingAuthFailure?.attempt === context.attempt) {
        const authFailure = pendingAuthFailure;
        pendingAuthFailure = null;
        const currentRoute = context.currentRoute;
        if (!currentRoute || !authFailure.nextAccount || triedAccounts.has(authFailure.nextAccount.accountId)) {
          return null;
        }
        triedAccounts.add(authFailure.nextAccount.accountId);
        auth = undefined;
        authAccount = '';
        return routeFor(authFailure.nextAccount, 'rotate', currentRoute.value.modelMode);
      }
      // Hard pins never reach here — the kernel declines them before consulting
      // the adapter, and that suppression is unchanged by D-011.
      const currentRoute = context.currentRoute;
      if (!currentRoute) return null;
      // A 401 is recoverable ONLY by refresh. Once refreshed, the live handler
      // forwards it rather than rotating, so decline instead of routing around.
      if (context.lastResponse?.status === 401) return null;

      // WI-10003306: the backend refused the MODEL for this account. Move the SAME request to an
      // account that is not known to refuse it — without parking the current account, which may
      // still serve other models. No candidate ⇒ decline, and the truthful 400 is forwarded.
      if (context.lastResponse?.metadata?.modelRefusal) {
        const next = opts.selectAlternate?.(triedAccounts) ?? null;
        if (!next || triedAccounts.has(next.accountId)) return null;
        const account = opts.accounts().find((candidate) => candidate.accountId === next.accountId);
        if (!account) return null;
        triedAccounts.add(account.accountId);
        auth = undefined;
        authAccount = '';
        return routeFor(account, 'rotate', 'public');
      }

      if (!opts.pool) return null;

      const current = currentRoute.value.account.accountId;
      const next = opts.pool.onExhausted(current, resolveResetAt(context));
      if (!next || next.accountId === current) return null;
      if (triedAccounts.has(next.accountId)) return null;
      const account = opts.accounts().find((candidate) => candidate.accountId === next.accountId);
      if (!account) return null;
      triedAccounts.add(account.accountId);
      // A different account needs its own OAuth material.
      auth = undefined;
      authAccount = '';
      return routeFor(account, 'rotate', currentRoute.value.modelMode);
    },

    async prepareAttempt(
      context: GatewayKernelAttemptContext<CodexOAuthRouteValue>,
    ): Promise<CodexOAuthPreparedAttempt> {
      const { account, egress, reason, modelMode } = context.route.value;
      const active = egressView(account, async () => auth?.accessToken ?? '');
      let dispatcher: unknown;

      if (reason === 'refresh') {
        const currentAuth = auth;
        if (!currentAuth) {
          throw new GatewayRequestKernelError(
            `inference-gateway: codex OAuth refresh requested for '${account.accountId}' with no token in hand`,
            { code: 'gateway-error', outcome: 'gateway-error', status: 500 },
          );
        }
        try {
          dispatcher = await opts.dispatcherFor(active, egress.entry);
          auth = await withPromiseDeadline(
            opts.refreshAccessToken(account.home, currentAuth, dispatcher),
            opts.tokenTimeoutMs,
            `codex oauth refresh '${account.accountId}'`,
          );
          authAccount = account.accountId;
        } catch (error) {
          // The live handler rotates on a failed refresh; `retryable` routes this
          // to the kernel's failover path.
          throw new GatewayRequestKernelError(
            `inference-gateway: codex OAuth token refresh failed: ${(error as Error).message}`,
            { code: 'upstream-error', outcome: 'upstream-error', status: 502, retryable: true },
          );
        }
      } else if (!auth || authAccount !== account.accountId) {
        try {
          auth = await withPromiseDeadline(
            opts.resolveAccessToken(account.home),
            opts.tokenTimeoutMs,
            `codex oauth token '${account.accountId}'`,
          );
          authAccount = account.accountId;
        } catch (error) {
          // Token-resolve failure rotates to another subscription account. 503 is
          // the discriminator the caller uses to classify this as a credential
          // failure rather than a transport one — do not "tidy" it.
          throw new GatewayRequestKernelError(
            `inference-gateway: codex OAuth token unavailable for '${account.accountId}': ${(error as Error).message}`,
            { code: 'upstream-error', outcome: 'upstream-error', status: 503, retryable: true },
          );
        }
      }
      if (reason !== 'refresh') dispatcher = await opts.dispatcherFor(active, egress.entry);

      const base: Record<string, string> = {};
      for (const [key, value] of Object.entries(opts.requestHeaders)) {
        if (value === undefined || opts.stripRequestHeaders.has(key.toLowerCase())) continue;
        base[key] = Array.isArray(value) ? value.join(', ') : value;
      }
      const headers = opts.buildHeaders({
        base,
        accessToken: auth!.accessToken,
        accountId: auth!.accountId,
      });

      return {
        url: opts.upstreamUrl,
        method: opts.method,
        headers,
        body:
          context.body.length && modelMode === 'reserve' && opts.reserveModel
            ? new Uint8Array(rewriteCodexRequestModel(context.body, opts.reserveModel))
            : context.body.length
              ? new Uint8Array(context.body)
              : null,
        accountId: account.accountId,
        dispatcher: dispatcher ?? undefined,
      };
    },

    async executeAttempt(
      prepared: CodexOAuthPreparedAttempt,
      context: GatewayKernelAttemptContext<CodexOAuthRouteValue>,
    ): Promise<CodexOAuthUpstream> {
      const { account, egress, modelMode } = context.route.value;
      opts.onEgressAttempt?.(account.accountId);

      let upstream: CodexOAuthFetchResponse;
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
        // Native fetch can reject with a plain AbortError instead of the
        // kernel's signal reason. Only downstream cancellation clears the
        // egress attribution; a real TTFB deadline still counts as failure.
        const abortReason = context.signal.aborted ? context.signal.reason : null;
        if (abortReason instanceof GatewayRequestKernelError && abortReason.code === 'cancelled') {
          throw abortReason;
        }
        // Local terminal admission decisions must not penalize the egress or
        // turn into a retryable upstream failure.
        if (error instanceof GatewayRequestKernelError && !error.retryable) throw error;
        opts.onEgressFailure?.(account.accountId);
        opts.coolIp(egress.key, opts.transportCooldownMs);
        throw new GatewayRequestKernelError(
          `inference-gateway: codex OAuth upstream failed: ${describeFetchError(error)}`,
          { code: 'upstream-error', outcome: 'upstream-error', status: 502, retryable: true, cause: error },
        );
      }

      const headers = headersToObject(upstream.headers);
      const pinYieldedFrom =
        pinnedAccountId && pinnedAccountId !== account.accountId ? pinnedAccountId : null;

      // WI-10003306: classify a public-model 4xx as a MODEL refusal. Only the non-auth,
      // non-rate-limit 4xx range is read (a few hundred bytes); 2xx streams are never touched.
      let body = upstream.body;
      let modelRefusal: string | null = null;
      const model = opts.model?.trim();
      if (
        model &&
        modelMode === 'public' &&
        upstream.status >= 400 &&
        upstream.status < 500 &&
        upstream.status !== 401 &&
        upstream.status !== 403 &&
        upstream.status !== 429
      ) {
        const buffered = await bufferErrorBody(upstream.body, CODEX_REFUSAL_BODY_MAX_BYTES);
        body = buffered.body;
        if (isCodexModelRefusal(upstream.status, buffered.text)) {
          modelRefusal = codexModelRefusalDetail(buffered.text) || `model '${model}' refused`;
          try {
            opts.onModelRefused?.({ accountId: account.accountId, model, status: upstream.status, detail: modelRefusal });
          } catch {
            /* bookkeeping must never break the request */
          }
        }
      } else if (model && modelMode === 'public' && upstream.status >= 200 && upstream.status < 300) {
        try {
          opts.onModelServed?.({ accountId: account.accountId, model });
        } catch {
          /* bookkeeping must never break the request */
        }
      }

      // WI-10004561: an upstream error body may echo the OAuth token this attempt presented.
      // Wrapped AFTER the refusal read above, so classification still sees the raw text.
      if (upstream.status >= 400 && body) body = scrubbedErrorBody(body, presentedSecretsFromHeaders(prepared.headers));

      return {
        // Request-derived, as the live handler's span is: an error response to a
        // streaming request is still a streaming request.
        streaming: opts.streaming,
        status: upstream.status,
        transport: OAUTH_TRANSPORT,
        metadata: { accountId: account.accountId, headers, pinYieldedFrom, egressKey: egress.key, modelRefusal },
        body,
        // 401 is retryable via REFRESH; 429 and 5xx via a sibling IP or account
        // rotation. A definitive 4xx from the hidden reserve model is also
        // retryable once so the adapter can restore the public Luna request for
        // accounts that do not expose that tier. Other 4xx responses are
        // forwarded unchanged.
        retryable:
          upstream.status === 401 ||
          upstream.status === 429 ||
          upstream.status >= 500 ||
          (modelMode === 'reserve' && upstream.status >= 400 && upstream.status < 500) ||
          // WI-10003306: a model refusal is account-specific — another subscription may serve it.
          modelRefusal !== null,
        discard: body?.cancel ? () => body?.cancel?.() : undefined,
      };
    },
  };
}
