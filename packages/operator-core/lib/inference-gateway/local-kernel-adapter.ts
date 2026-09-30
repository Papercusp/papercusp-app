/**
 * Local-backend lane adapter for the provider-neutral request kernel.
 *
 * Plan `gateway-kernel-adoption-2026-08-29`, P-007 — the FIFTH
 * `GatewayKernelAdapter`, expressing the transport-owned half of `proxyLocal`
 * (`local-openai-chat` lane, `local-http` transport): least-loaded backend
 * selection, the forward to an OpenAI-compatible local process, and the
 * on-demand cold-start rescue.
 *
 * Everything else belongs to `executeGatewayRequestKernel` and is deliberately
 * absent here: abort wiring, the request ceiling, attempt counting, failover
 * bookkeeping, admission, stage spans, and in-flight registration.
 *
 * ── WHAT MAKES THIS LANE DIFFERENT FROM THE FOUR CLOUD LANES ───────────────
 *
 * 1. A ROUTE IS A BACKEND, NOT AN ACCOUNT. The lane declares
 *    `accountPinning: 'none'` and `accountPool: null`, so `validateRoute` only
 *    ever reads `accountId` to enforce the same-account invariant on a
 *    re-attempt. Carrying `accountId = backend.id` is therefore free and gives
 *    that invariant exactly the meaning this lane wants: a re-attempt is the
 *    SAME local process, a failover is a DIFFERENT one.
 *
 * 2. SELECTION IS MODEL-DERIVED, AND THE MODEL COMES FROM THE BODY. The kernel
 *    calls `selectInitial` BEFORE its own bounded body read
 *    (`request-kernel.ts:870` vs `:907`), so an adapter cannot parse the model
 *    out of `context.body` in time to route on it. The caller already reads and
 *    parses the body — it owes a 400 for a bodyless/model-less request and runs
 *    the cold-start pre-flight before admission — so the model arrives here as
 *    `deps.model`, resolved. This mirrors P-006, where `bodyBuf` is likewise
 *    read caller-side and handed in.
 *
 * 3. EVERY UPSTREAM STATUS IS RELAYED. The hand-rolled ladder retried only on a
 *    thrown TRANSPORT failure; a 4xx or 5xx that arrived as a response was
 *    forwarded to the client untouched. `retryable` is therefore `false` for
 *    every response — the ONE exception being the cold-start rescue below,
 *    which is a routing decision rather than a property of the status.
 *
 * ── THE COLD-START RESCUE, AND WHY IT IS A THROW ───────────────────────────
 *
 * A STOPPED on-demand backend behind a sanitizing proxy answers a well-formed
 * 502/503/504 rather than refusing the connection, so `catch` never fires and
 * the pool's health signal lags the stop by up to ~60s. The ladder started the
 * unit and retried THIS request instead of making the caller eat the 502.
 *
 * It expressed that as `tried.delete(backend.id); continue;` — which re-enters
 * `pool.select(...)` with the started backend ELIGIBLE AGAIN. That is the
 * detail an obvious wiring gets wrong: it is not "retry the same backend", it
 * is "re-select with this backend no longer excluded", and least-loaded
 * selection may legitimately return a DIFFERENT one. So the rescue maps onto
 * `selectReattempt` only when the re-selection lands on the same backend, and
 * onto `selectFailover` otherwise. That split is not cosmetic: it reproduces
 * the ladder's failover accounting exactly, because the ladder recorded a
 * failover on `previousBackendId !== backend.id` — i.e. on the backend
 * CHANGING, not on the reason for retrying.
 *
 * The rescue leaves `executeAttempt` as a THROW rather than a retryable
 * response for two measured reasons:
 *
 *  - A retryable RESPONSE that finds no next route is FORWARDED
 *    (`request-kernel.ts:1080-1105` falls through to the relay). The rescue has
 *    already cancelled the upstream body, so that path would relay a bodiless
 *    502 where the ladder synthesized its own JSON 502. A retryable ERROR is
 *    re-thrown instead (`:1064`), which is the ladder's `break`-to-terminal.
 *  - The kernel skips route selection entirely on the final attempt
 *    (`attempt < maxAttempts`), but still runs `executeAttempt`. The ladder
 *    cold-started on its last pass too — the started unit outlives the request
 *    and serves the NEXT one — so keeping the start inside `executeAttempt`
 *    preserves that, where putting it in a selection hook would silently drop
 *    it. Same shape as EI-21618978789879488 on the codex-cli lane.
 *
 * ── D-018: THIS LANE HAS NO INTER-ATTEMPT PAUSE, MEASURED ──────────────────
 *
 * D-018 requires checking explicitly, because a dropped backoff writes nothing
 * and no diff can find it. Measured over the deleted region (gateway.ts
 * 3171-3414 at HEAD cbf5eddddc): `grep -Ei 'sleep|setTimeout|backoff|delay|await
 * new Promise'` → NO MATCHES. The ladder retried immediately. `delayMs` is
 * therefore deliberately omitted from every route this adapter builds; adding
 * one would be an invented behaviour, not a preserved one.
 *
 * ── D-013: NO BODY-DERIVED CLASSIFICATION ON THIS LANE, MEASURED ───────────
 *
 * Every branch here is decided from the STATUS plus ROUTE DATA
 * (`isUpstreamUnreachable(status) && startableOnDemand(backend)`). The ladder
 * never peeked a response body — its only body call on a non-relayed path is
 * `upstream.body?.cancel()`. So D-013's `classifyResponse` seam is satisfied
 * vacuously and is deliberately not implemented.
 */
import type { GatewayTransportId } from './provider-adapters';
import type { LocalBackend, LocalBackendPool } from './local-backend-pool';
import {
  GatewayRequestKernelError,
  type GatewayKernelAdapter,
  type GatewayKernelAttemptContext,
  type GatewayKernelRoute,
  type GatewayKernelRouteContext,
  type GatewayKernelUpstreamResponse,
} from './request-kernel';

const LOCAL_TRANSPORT: GatewayTransportId = 'local-http';

/** Why a route exists. Keeps every route key distinct, which is what the
 *  kernel's route-cycle guard reads. */
export type LocalRouteReason = 'initial' | 'failover' | 'cold-start-retry';

export interface LocalRouteValue {
  backend: LocalBackend;
  reason: LocalRouteReason;
}

export type LocalChunk = Uint8Array;

export interface LocalResponseMetadata {
  /** Backend that actually served the attempt. */
  backendId: string;
  /** Relayed verbatim; the ladder forwarded exactly this one header. */
  contentType: string;
}

/** The minimal `fetch` response shape this adapter consumes. Declared rather
 *  than reusing the DOM lib's `Response` so a test double needs only these
 *  four members, matching how the other adapters type their transports. */
export interface LocalFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: (AsyncIterable<Uint8Array> & { cancel?: () => Promise<void> }) | null;
}

/** Terminal-rendering state the caller reads once the kernel has given up.
 *  These are the three loop variables the ladder's fall-through 429/502 read,
 *  surfaced verbatim so the caller's terminal branch is unchanged. */
export interface LocalAdapterState {
  /** `tried.size` — zero means selection never yielded a backend at all, which
   *  is the ONLY shape that may render retryable saturation. */
  triedCount: number;
  lastError: string | null;
  coldStartError: string | null;
}

export interface LocalKernelAdapter
  extends GatewayKernelAdapter<LocalRouteValue, LocalRouteValue, LocalChunk, LocalResponseMetadata> {
  state(): LocalAdapterState;
}

export interface LocalKernelAdapterDeps {
  pool: Pick<LocalBackendPool, 'select' | 'recordStart' | 'recordEnd' | 'recordOutcome'>;
  /** Resolved caller-side, because `selectInitial` runs before the body read. */
  model: string;
  /** Slot affinity: the owner's last backend is preferred while eligible, so a
   *  session's KV prefix survives across hops. */
  ownerId: string | null;
  /** Request path, already narrowed to the two OpenAI-compatible surfaces. */
  url: string;
  body: Uint8Array;
  /** Request-derived, exactly as P-006 does it: `stream:true` is parsed once by
   *  the caller and that one fact drives both the span and this field. */
  streaming: boolean;
  /** Per-attempt wall-clock bound, preserving the ladder's `AbortSignal.timeout`. */
  attemptTimeoutMs: number;
  fetchImpl: (url: string, init: Record<string, unknown>) => Promise<LocalFetchResponse>;
  isUpstreamUnreachable: (status: number) => boolean;
  startableOnDemand: (backend: LocalBackend) => boolean;
  /** Starts ONE known-startable backend; returns an error string or null. */
  ensureOnDemandBackend: (backend: LocalBackend) => Promise<string | null>;
  /** The DEAD-END pre-flight's result, which the caller computes before
   *  admission. Seeded here so `state()` is the single terminal-rendering
   *  source and the caller keeps no parallel copy to drift. */
  initialColdStartError: string | null;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export function createLocalKernelAdapter(deps: LocalKernelAdapterDeps): LocalKernelAdapter {
  /** The ladder's own `tried` set. Distinct from the kernel's `triedRouteKeys`:
   *  that one is keyed per SELECTION (so a cold-start retry of the same backend
   *  is a new key) while this one is keyed per BACKEND and is what
   *  `pool.select`'s exclude and the terminal saturation test read. */
  const tried = new Set<string>();
  let lastError: string | null = null;
  let coldStartError: string | null = deps.initialColdStartError;
  /** At most ONE cold start per request (D-014 of the local-backend plan):
   *  a backend still answering 502 after a successful start is a real fault to
   *  report, not a reason to restart it again. */
  let coldStartAttempted = false;
  /** Set by `executeAttempt` when a cold start succeeded, consumed by the
   *  selection pass that immediately follows it. */
  let rescue: { attempt: number; backend: LocalBackend } | null = null;
  /** A re-selection already performed by `selectReattempt` and handed to
   *  `selectFailover` because it landed on a DIFFERENT backend. */
  let deferredFailover: LocalBackend | null = null;

  const selectBackend = (): LocalBackend | null =>
    deps.pool.select(deps.model, tried, deps.ownerId ?? undefined);

  const toRoute = (
    backend: LocalBackend,
    reason: LocalRouteReason,
    attempt: number,
  ): GatewayKernelRoute<LocalRouteValue> => {
    tried.add(backend.id);
    return {
      key: reason === 'initial' ? `local:${backend.id}` : `local:${backend.id}#${reason}${attempt}`,
      accountId: backend.id,
      transport: LOCAL_TRANSPORT,
      value: { backend, reason },
      // D-018: measured absent on this lane — see the file header.
    };
  };

  /** The ladder's `break` out of the attempt loop. `selectInitial` must return a
   *  route, so "no backend at all" can only be expressed as a throw; the caller
   *  renders 429-vs-502 from `state()` exactly as the fall-through did. */
  const noBackend = (): GatewayRequestKernelError =>
    new GatewayRequestKernelError(
      `inference-gateway: no local backend available for model '${deps.model}'`,
      { code: 'upstream-error', outcome: 'upstream-error', status: 502, retryable: false },
    );

  return {
    selectInitial() {
      const backend = selectBackend();
      if (!backend) throw noBackend();
      return toRoute(backend, 'initial', 1);
    },

    selectReattempt(context: GatewayKernelRouteContext<LocalRouteValue, LocalChunk, LocalResponseMetadata>) {
      // Only a cold-start rescue produces a same-backend retry on this lane; an
      // ordinary transport failure always moves on, and re-entering selection
      // for it here would double-select.
      if (!rescue || rescue.attempt !== context.attempt) return null;
      const started = rescue.backend;
      rescue = null;

      // Reproduce `tried.delete(backend.id); continue;` — the started backend
      // becomes eligible again and selection is re-run, so this may legitimately
      // return a different, less-loaded backend.
      tried.delete(started.id);
      const next = selectBackend();
      if (!next) return null;
      if (next.id !== context.currentRoute?.accountId) {
        // A different backend is a FAILOVER, not a re-attempt: returning it here
        // would trip the kernel's same-account guard, and counting it as a
        // re-attempt would under-report a failover the ladder recorded.
        deferredFailover = next;
        return null;
      }
      return toRoute(next, 'cold-start-retry', context.attempt + 1);
    },

    selectFailover(context: GatewayKernelRouteContext<LocalRouteValue, LocalChunk, LocalResponseMetadata>) {
      const deferred = deferredFailover;
      deferredFailover = null;
      if (deferred) return toRoute(deferred, 'cold-start-retry', context.attempt + 1);
      const next = selectBackend();
      return next ? toRoute(next, 'failover', context.attempt + 1) : null;
    },

    prepareAttempt(context: GatewayKernelAttemptContext<LocalRouteValue>) {
      // A local backend is an unauthenticated localhost/LAN process: no token to
      // resolve, no header to build. The URL is a plain concatenation the
      // execute step does inline, so preparation is the route itself.
      return context.route.value;
    },

    async executeAttempt(
      prepared: LocalRouteValue,
      context: GatewayKernelAttemptContext<LocalRouteValue>,
    ): Promise<GatewayKernelUpstreamResponse<LocalChunk, LocalResponseMetadata>> {
      const backend = prepared.backend;
      deps.pool.recordStart(backend.id);
      /** Headers arrived — the ladder's `settled`, which decides whether the
       *  catch below still owes `recordEnd`/`recordOutcome`. */
      let settled = false;
      try {
        const upstream = await deps.fetchImpl(`${backend.baseUrl}${deps.url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: deps.body,
          // Both bounds, exactly as the ladder had them: its own per-attempt
          // timeout AND the kernel's request-scoped cancellation.
          signal: AbortSignal.any([AbortSignal.timeout(deps.attemptTimeoutMs), context.signal]),
        });
        settled = true;
        deps.pool.recordEnd(backend.id);
        // A 4xx is a real answer from a healthy backend, so it counts as a
        // successful outcome; only 5xx and transport failures demote it.
        deps.pool.recordOutcome(backend.id, upstream.ok || (upstream.status >= 400 && upstream.status < 500));

        if (deps.isUpstreamUnreachable(upstream.status) && deps.startableOnDemand(backend) && !coldStartAttempted) {
          coldStartAttempted = true;
          lastError = `upstream ${upstream.status} from ${backend.baseUrl}`;
          deps.log(
            'warn',
            `inference-gateway: local backend '${backend.id}' answered ${upstream.status} (upstream unreachable) — attempting cold start and one retry`,
          );
          // Release the socket: this body is not being relayed, and an
          // un-consumed response body holds the connection open until GC.
          try {
            await upstream.body?.cancel?.();
          } catch {
            /* already torn down */
          }
          coldStartError = await deps.ensureOnDemandBackend(backend);
          if (coldStartError) throw coldStartFailed(coldStartError);
          rescue = { attempt: context.attempt, backend };
          throw new GatewayRequestKernelError(lastError, {
            code: 'upstream-error',
            outcome: 'upstream-error',
            status: upstream.status,
            retryable: true,
          });
        }

        return {
          status: upstream.status,
          streaming: deps.streaming,
          transport: LOCAL_TRANSPORT,
          metadata: {
            backendId: backend.id,
            contentType: upstream.headers.get('content-type') ?? 'application/json',
          },
          body: upstream.body,
          // Relay every status untouched — the ladder never retried a response.
          retryable: false,
          discard: upstream.body?.cancel ? () => upstream.body?.cancel?.() : undefined,
        };
      } catch (error) {
        // Our own control-flow throws have already run the bookkeeping above;
        // re-running it here would double-count one attempt against the pool.
        if (error instanceof GatewayRequestKernelError) throw error;

        if (!settled) {
          deps.pool.recordEnd(backend.id);
          deps.pool.recordOutcome(backend.id, false, (error as Error).message);
        }
        lastError = (error as Error).message ?? String(error);
        deps.log(
          'warn',
          `inference-gateway: local backend '${backend.id}' (${backend.baseUrl}) failed for model '${deps.model}': ${lastError} — trying another candidate`,
        );

        // The same rescue for a genuine TRANSPORT failure — a backend with no
        // proxy in front of it refuses the connection outright instead of
        // answering 502. `!settled` keeps this to CONNECT-time failures: a
        // mid-body error means the backend was alive and already producing, so
        // restarting it would be wrong.
        if (!settled && deps.startableOnDemand(backend) && !coldStartAttempted) {
          coldStartAttempted = true;
          coldStartError = await deps.ensureOnDemandBackend(backend);
          if (coldStartError) throw coldStartFailed(coldStartError);
          rescue = { attempt: context.attempt, backend };
        }

        throw new GatewayRequestKernelError(lastError, {
          code: 'upstream-error',
          outcome: 'upstream-error',
          status: 502,
          retryable: true,
        });
      }
    },

    state(): LocalAdapterState {
      return { triedCount: tried.size, lastError, coldStartError };
    },
  };
}

/** A FAILED cold start is terminal and outranks both generic readings: "we tried
 *  to start the backend serving this model and could not" is a different
 *  operator problem from "none registered / all unhealthy". Non-retryable, so
 *  the kernel stops immediately — the ladder's `break`. */
function coldStartFailed(detail: string): GatewayRequestKernelError {
  return new GatewayRequestKernelError(detail, {
    code: 'upstream-error',
    outcome: 'upstream-error',
    status: 502,
    retryable: false,
  });
}
