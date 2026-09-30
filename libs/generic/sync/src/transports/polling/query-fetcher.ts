/**
 * query-fetcher — ONE `GET /rest-query` per sync query, through a bounded gate.
 *
 * Replaced the micro-batcher on 2026-07-26 (drop-sync-batcher-2026-07-25). The
 * batcher coalesced a refetch wave into one `POST /rest-query-batch`; the
 * server resolved that bundle with `Promise.all` and answered only when its
 * SLOWEST member did, so every panel in the wave waited on the worst query in
 * it. That head-of-line coupling is structural — a bundle is indivisible, so no
 * window size could have fixed it — and it is the reason this module exists.
 *
 * The SIZE of the win is transport-dependent, so quote the right number. On the
 * DESKTOP path (webview→sidecar IPC, the one that ships) a 106-query wave costs
 * about the same either way — 2922ms individual at the default gate vs 3000ms
 * bundled — but individual requests paint continuously (p50 395ms) instead of
 * showing nothing until the wall, a ~7.6x better time-to-first-paint at equal
 * total cost. Planning's loopback-HTTP numbers against :3070 (bundle 2676ms vs
 * 1126ms individual) showed a far larger wall win; those do NOT transfer to IPC
 * and must not be used to retune anything — see plan D-003 and the note on
 * `DEFAULT_MAX_IN_FLIGHT` below.
 *
 * What this module keeps from the batcher, deliberately:
 *   - the rows-delta codec round-trip, now per REQUEST rather than per batch
 *     slot (`delta=<cursor>`, `delta=` to opt in cold, refetch-full on a
 *     checksum mismatch — correctness still rides the codec's checksum guard);
 *   - `reportSyncReachable` / `reportSyncUnreachable` connectivity signalling;
 *   - the `{ rows, version }` result shape its callers destructure.
 *
 * What it adds back: per-query `AbortSignal` cancellation, which a bundle
 * structurally could not offer (it is indivisible). An unmounted panel now
 * cancels its in-flight request instead of leaving the server to resolve a
 * query nobody will read — worth having when a wave is ~6MB.
 *
 * NOTE ON `GET`: args ride the query string. Every live sync query's args are
 * small ids/limits, well inside header limits; a resolver that ever needs a
 * large argument object should take a name + a server-side id, not a fatter URL.
 */
import { reportSyncReachable, reportSyncStaleOperator, reportSyncUnreachable } from '../../connectivity';
import { getSyncDeltaCodec, type SyncDeltaMeta } from '../../delta-codec';
import {
  createSyncTraceId,
  syncMetrics,
  type SyncQueryOutcome,
  type SyncQueryTiming,
  type SyncServerTiming,
} from '../../observability/metrics';
import {
  getOriginScheduler,
  peekOriginScheduler,
  _resetOriginSchedulersForTests,
  type OriginScheduler,
  type OriginSchedulerClass,
} from './origin-scheduler';
import type { ConcurrencyGate } from './concurrency-gate';

/** Monotonic-ish clock; `performance` is absent in some non-browser test hosts. */
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Per-request scratch filled by `sendOne` so the gated wrapper can attribute
 * time correctly: without `sentAtMs` there is no way to separate the QUEUE WAIT
 * from the request, and the queue wait is the half that was invisible.
 */
interface RequestMeta {
  traceId: string;
  sentAtMs: number | null;
  responseAtMs: number | null;
  bodyCompleteAtMs: number | null;
  parseCacheMs: number | null;
  resolverMs: number | null;
  bytes: number;
}

export interface QueryResult {
  rows: unknown[];
  version: string;
  changes?: unknown[];
  delta?: SyncDeltaMeta;
  /** Internal trace metadata carried through react-query to the React writers. */
  syncTiming?: SyncQueryTiming;
}

export interface QueryFetchOptions {
  /** react-query's per-query signal. Aborts on unmount/cancel. */
  signal?: AbortSignal;
  /** Admission class in the process-wide origin scheduler. */
  requestClass?: OriginSchedulerClass | string;
  /** Alias accepted by generic callers. */
  class?: OriginSchedulerClass | string;
  /** Supersedes a queued background refresh with the same key. */
  coalesceKey?: string;
  /** Optional per-call total scheduler deadline. */
  timeoutMs?: number;
  /** Age at which queued background work may be shed. */
  staleAfterMs?: number;
}

export type QueryFetch = (name: string, args: unknown, opts?: QueryFetchOptions) => Promise<QueryResult>;

/**
 * Max sync requests in flight per endpoint.
 *
 * 24, and the number came from the DESKTOP transport rather than from loopback
 * HTTP — that distinction is the whole reason it is not 12. Planning measured
 * this against `:3070` over plain loopback HTTP and found wall time FLAT from
 * concurrency 6 to 24 (1126ms vs 1106ms), which said "pick the low end, it is
 * free, and per-query latency is better there". Re-measured inside a running
 * Tauri shell over the real webview→sidecar IPC path — 106 live sync queries,
 * warmed, 5 interleaved rounds — wall is NOT flat (median ms):
 *
 *     conc=12   4981      p50 212      <- SLOWER than the bundle it replaces
 *     conc=16   3732      p50 307
 *     conc=24   2922      p50 395      <- chosen
 *     one bundle 3000     nothing paints before the wall
 *
 * At 24 the wave finishes as fast as the bundle (2922 vs 3000) AND half the
 * panels have painted by ~395ms instead of every panel waiting ~3000ms — a
 * ~7.6x better time-to-first-paint at equal total cost. At 12 the wall
 * REGRESSES past the bundle, which is the one outcome that would have made
 * dropping the batcher a net loss.
 *
 * The trade is real and deliberate: raising the cap raises per-query p50
 * (212 → 395ms) because parallel resolvers contend for the same PG pool and
 * event loop. It is worth it because the bundle's effective p50 IS its wall.
 *
 * Do not "restore" a lower default from the planning numbers without
 * re-measuring over IPC; loopback-HTTP results do not transfer (plan D-003).
 * The floor still matters for a different reason: on the two paths with a real
 * per-host connection cap (the desktop's pre-`PAPERCUSP_IPC_READY` HTTP
 * fallback and the `:3055` dev browser) the browser grants ~6, and a wave of
 * 106 measured 10.7-11.7s there versus 2-3s over IPC — the gate is what keeps
 * that from starving every other request on the page.
 */
export const DEFAULT_MAX_IN_FLIGHT = 24;

/**
 * Per-request deadline. THIS IS A LIVENESS BOUND ON A GATE SLOT, NOT A GUESS AT
 * USER PATIENCE — do not retune it as if it were the latter.
 *
 * `gate.run` releases its slot in a `finally`, so a slot is held for exactly as
 * long as the request function stays pending. Without a deadline, a transport
 * that never settles owns a slot FOREVER; once `DEFAULT_MAX_IN_FLIGHT` of them
 * are stuck, `acquire()` queues every later caller behind waiters that can never
 * drain, the request function is never invoked, and the caller's promise neither
 * resolves nor rejects — silently, with nothing in the console. That is WI-6559,
 * observed as: click Grade, wait 30s, get an error, while other queries that
 * resolved earlier in the same instance look fine.
 *
 * 20s is chosen to sit UNDER the callers' own ceilings (fetchSyncQuery's
 * PARAMS_TIMEOUT_MS is 30s) so a stuck request surfaces as a real rejection with
 * a real message, instead of the caller timing out against a promise that is
 * still pending. It is far above the measured working range — a 106-query
 * desktop wave completes in ~2.9s at p50 395ms — so it cannot fire on a merely
 * slow query, which is the property that makes it safe.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Max sync requests in flight for a REAL per-host-connection-capped path —
 * i.e. one where `fetch()` opens an actual browser HTTP connection instead of
 * riding the Tauri IPC bridge (which has no such cap; see `DEFAULT_MAX_IN_FLIGHT`
 * above). Two paths are provably always in this bucket: a plain (non-Tauri)
 * browser tab pointed at the dev server, and the desktop's pre-IPC-ready
 * startup window (`installDesktopIpcPolyfills`'s `window.fetch` patch falls
 * back to native HTTP until the sidecar handshake / dev socket connects).
 *
 * WEBKITGTK GRANTS ~6 CONNECTIONS PER HOST. A 24-wide gate on a connection-
 * capped path admits 24 fetches against at most 6 sockets — a wave of 106
 * measured 10.7-11.7s there vs 2-3s over IPC (see `DEFAULT_MAX_IN_FLIGHT`'s
 * doc), and it starves every OTHER request on the page (long-lived SSE
 * streams included) that's competing for the same 6 slots.
 *
 * THIS VALUE IS A SAFE FLOOR, NOT A MEASURED-OPTIMAL NUMBER — do not treat it
 * as tuned. It is deliberately conservative: of the ~6 sockets WebKitGTK
 * grants, this leaves real headroom for the page's own standing streams
 * (sync SSE + the flags stream + — until EI-18758340172989350 /
 * EI-18827862438924553's consolidation lands — a duplicated leader-bridge
 * stream can eat 3-4 of the 6 on its own). Per the `DEFAULT_MAX_IN_FLIGHT`
 * lesson (plan drop-sync-batcher-2026-07-25 D-003), do NOT retune this from
 * loopback-HTTP numbers or by guessing — re-measure inside a real Tauri shell
 * (or a real browser tab) AFTER the standing-stream consolidation lands, and
 * raise it only on a real measurement over the transport that actually ships
 * that path. Follow-up: WI-6460.
 */
export const CONNECTION_CAPPED_MAX_IN_FLIGHT = 2;

interface Fetcher {
  fetchQuery: QueryFetch;
  gate: OriginScheduler;
}

const fetchers = new Map<string, Fetcher>();

const keyFor = (restEndpoint: string, tokenQueryParam?: string): string =>
  `${restEndpoint}\u0000${tokenQueryParam ?? ''}`;

/** True when `err` is this request's own cancellation rather than a transport failure. */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/** The exact prefix `GET /rest-query` uses for a resolver the SERVER doesn't
 *  know — see rest-query.ts. Matched verbatim, not fuzzily, so this can never
 *  misfire on an unrelated 400 (a malformed-args error, an auth failure, …). */
const UNKNOWN_QUERY_NAME_PREFIX = 'unknown queryName: ';

async function describeHttpError(
  res: Response,
  name: string,
): Promise<{ message: string; unknownQueryName: boolean; staleOperator: boolean }> {
  let detail = '';
  let unknownQueryName = false;
  let staleOperator = false;
  try {
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      staleOperator?: boolean;
    } | null;
    if (body?.error) {
      detail = ` — ${body.error}`;
      unknownQueryName = res.status === 400 && body.error.startsWith(UNKNOWN_QUERY_NAME_PREFIX);
      staleOperator = body.code === 'stale_operator_module_link' || body.staleOperator === true;
    }
  } catch {
    // Non-JSON error body: the status alone is the diagnosis.
  }
  return {
    message: `sync query "${name}" failed: HTTP ${res.status}${detail}`,
    unknownQueryName,
    staleOperator,
  };
}

/**
 * Process-wide single-query fetcher for one endpoint, sharing ONE concurrency
 * gate across the polling hook, the prefetch helper and `fetchSyncQuery` — a
 * per-caller gate would multiply the cap by the number of callers and defeat it.
 *
 * `maxInFlight` on a later call retunes the existing gate in place rather than
 * minting a second fetcher, so the endpoint keeps exactly one cap.
 *
 * ⚠ OMITTING `maxInFlight` means "I have NO OPINION on concurrency", NOT "use
 * the default". It is only a fallback when this call CREATES the gate; against
 * an existing gate it leaves the cap alone. The difference is load-bearing:
 * the gate is shared process-wide, so an opinion-less caller that resolved its
 * own `undefined` to `DEFAULT_MAX_IN_FLIGHT` would call `setLimit(24)` and
 * silently UN-CAP a gate the provider had deliberately capped.
 *
 * That is not hypothetical — measured live 2026-08-03 (P-019/WI-6628): with IPC
 * disabled the provider correctly capped this gate to
 * `CONNECTION_CAPPED_MAX_IN_FLIGHT`, and `fetchSyncQuery` (the dock's imperative
 * layout load, which passes no cap) raised it straight back to 24 on every
 * dock route — `/adv` read 24 while `/settings` read 2, re-arming the WI-6253
 * stampede on the app's primary surfaces. A caller that genuinely wants the
 * IPC-tuned default must pass `DEFAULT_MAX_IN_FLIGHT` explicitly, which is what
 * the provider path does (it always resolves to a concrete number, so raising
 * back to 24 once IPC is proven still works).
 */
export function getQueryFetcher(
  restEndpoint: string,
  tokenQueryParam?: string,
  maxInFlight?: number,
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): QueryFetch {
  const key = keyFor(restEndpoint, tokenQueryParam);
  const existing = fetchers.get(key);
  if (existing) {
    if (maxInFlight !== undefined && existing.gate.limit !== maxInFlight) {
      existing.gate.setLimit(maxInFlight);
    }
    return existing.fetchQuery;
  }

  // One scheduler is pinned to the URL origin, not to this endpoint path or
  // token variant.  An opinion-less later caller must inherit the existing
  // profile; only an explicit cap retunes it (the old gate's contract).
  const existingScheduler = peekOriginScheduler(restEndpoint);
  const gate = existingScheduler
    ? maxInFlight === undefined
      ? existingScheduler
      : getOriginScheduler(restEndpoint, {
          limit: maxInFlight,
          requestTimeoutMs,
          profile: maxInFlight === CONNECTION_CAPPED_MAX_IN_FLIGHT ? 'browser-http' : 'ipc',
        })
    : getOriginScheduler(restEndpoint, {
        limit: maxInFlight ?? DEFAULT_MAX_IN_FLIGHT,
        requestTimeoutMs,
        profile: maxInFlight === CONNECTION_CAPPED_MAX_IN_FLIGHT ? 'browser-http' : 'ipc',
      });
  // P-003(b): publish the gate's LIVE depth. `inFlight`/`queued` have been on
  // the gate interface since it was written and nothing outside tests ever read
  // them, so a saturated gate — the exact condition that makes a user wait —
  // was unobservable from the running app. One probe fixes that for every
  // surface at once (window.__sync_metrics__, and anything that renders it).
  syncMetrics.registerGateProbe(() => ({
    inFlight: gate.inFlight,
    queued: gate.queued,
    limit: gate.limit,
  }));
  syncMetrics.registerSchedulerProbe(() => gate.snapshot());

  const sendOne = async (
    name: string,
    args: unknown,
    delta: string | undefined,
    signal: AbortSignal | undefined,
    meta: RequestMeta,
  ): Promise<QueryResult> => {
    const params = new URLSearchParams({ name, args: JSON.stringify(args ?? {}) });
    // Only a delta-opted query carries `delta`; absent → the server's full path,
    // byte-identical to a pre-delta request.
    if (delta !== undefined) params.set('delta', delta);
    if (tokenQueryParam) params.set('token', tokenQueryParam);

    // The deadline aborts THIS request if the transport stops answering, so the
    // gate slot it holds is always released. See DEFAULT_REQUEST_TIMEOUT_MS: a
    // slot held forever is what starves every later caller (WI-6559). The
    // caller's own signal is chained in, so an unmount still cancels normally.
    const deadline = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // RACED, not merely aborted. Aborting assumes the transport HONOURS
    // `init.signal` — and the transport that actually hangs here is the desktop's
    // IPC-polyfilled `window.fetch`, which is exactly the one we cannot assume
    // that of. If it ignores the abort, an abort-only deadline leaves the promise
    // pending and the gate slot held, i.e. it would not fix the bug at all. The
    // race guarantees this function settles no matter how the transport behaves,
    // which is the property the gate needs. The abort is still fired, so a
    // well-behaved transport also releases its socket.
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        deadline.abort();
        reject(new Error(`sync query "${name}" timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
    });
    const onCallerAbort = (): void => deadline.abort();
    if (signal) {
      if (signal.aborted) deadline.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      let res: Response;
      try {
        meta.sentAtMs = nowMs();
        const inFlight = fetch(`${restEndpoint}/rest-query?${params.toString()}`, { signal: deadline.signal });
        // If the race is won by the deadline, the loser can still reject later;
        // swallow that so it is not an unhandled rejection.
        inFlight.catch(() => {});
        res = await Promise.race([inFlight, expiry]);
        meta.responseAtMs = nowMs();
      } catch (e) {
        // OUR deadline fired: this request is never coming back. Reject loudly
        // rather than leaving the caller to time out against a pending promise —
        // the silent-hang shape is the actual defect being fixed here. Checked
        // BEFORE isAbortError, which would otherwise classify our own abort as
        // the caller's cancellation and swallow it.
        if (timedOut) {
          reportSyncUnreachable();
          throw new Error(`sync query "${name}" timed out after ${requestTimeoutMs}ms`);
        }
        // A request WE cancelled says nothing about whether the origin is up —
        // reporting it as unreachable would flip the whole app offline every time
        // a panel unmounts mid-fetch.
        if (isAbortError(e, signal)) throw e;
        reportSyncUnreachable();
        throw e;
      }
      // ANY HTTP response (error statuses included) proves the origin is up.
      reportSyncReachable();
      if (!res.ok) {
        const { message, unknownQueryName, staleOperator } = await describeHttpError(res, name);
        // WI-5956: this specific shape means the origin is reachable but running
        // OLDER code than this (freshly-rebuilt) client — a version-skew bug, not
        // a per-query fluke. Surface it app-wide (StaleOperatorIndicator) instead
        // of letting it read as one silently-broken panel.
        if (unknownQueryName || staleOperator) reportSyncStaleOperator(name);
        throw new Error(message);
      }
      // text-then-parse rather than res.json(): `json()` decodes to a string
      // internally anyway, so this costs nothing extra and is the only way to
      // learn the payload SIZE over a transport that carries no content-length
      // (the desktop IPC polyfill does not). Payload weight is half of what
      // P-002 had to measure; measuring it from outside the app was the hard way.
      const text = await res.text();
      meta.bodyCompleteAtMs = nowMs();
      meta.bytes = text.length;
      const parseStartedAtMs = meta.bodyCompleteAtMs;
      const json = (text ? JSON.parse(text) : {}) as {
        rows?: unknown[];
        changes?: unknown[];
        version?: string;
        delta?: SyncDeltaMeta;
        timing?: Partial<SyncServerTiming>;
      };
      const parsedAtMs = nowMs();
      meta.parseCacheMs = Math.max(0, parsedAtMs - (parseStartedAtMs ?? parsedAtMs));
      const serverTiming =
        json.timing?.unit === 'ms' &&
        Number.isFinite(json.timing.resolverMs) &&
        Number.isFinite(json.timing.resolverStartedAtMs) &&
        Number.isFinite(json.timing.resolverCompletedAtMs)
          ? (json.timing as SyncServerTiming)
          : undefined;
      meta.resolverMs = serverTiming?.resolverMs ?? null;
      const transferMs =
        meta.responseAtMs === null
          ? 0
          : Math.max(0, (meta.bodyCompleteAtMs ?? parsedAtMs) - meta.responseAtMs);
      return {
        rows: json.rows ?? [],
        version: json.version ?? String(Date.now()),
        changes: json.changes,
        delta: json.delta,
        syncTiming: {
          traceId: meta.traceId,
          resolverMs: serverTiming?.resolverMs,
          transferMs,
          parseCacheMs: meta.parseCacheMs,
          parseCacheEndedAtMs: parsedAtMs,
        },
      };
    } finally {
      // Covers the BODY read too — a hung `res.json()` holds the slot exactly as
      // effectively as a hung `fetch`, so the timer must outlive the response.
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  };

  /**
   * One gated request under a TOTAL deadline — one that starts when the caller
   * asks, so it covers the QUEUE WAIT as well as the request itself.
   *
   * WI-6559, second half. `gate.run(fn)` is `await acquire()` and THEN `fn()`,
   * and `sendOne` arms its deadline INSIDE `fn` — so that deadline bounds only
   * the request, never the wait to be ALLOWED to make one. A caller queued
   * behind a saturated gate was therefore unbounded: no timeout, no rejection,
   * no console output. That is precisely the silent-hang shape the deadline was
   * written to prevent, surviving in the QUEUED position.
   *
   * Measured live (2026-07-28, Tauri webview): a COLD page's Grade click never
   * produced a card at all — 30s, no error — while the SAME click on a warm
   * page answered in 250ms, because warm hit react-query's cache and never
   * touched the gate. The cold page's startup query wave saturates the gate,
   * `rubrics.list` queues, and nothing ever bounds the wait; the caller's own
   * 30s ceiling then fires, which is the owner's verbatim "click Grade, wait
   * 30s, get an error".
   *
   * Aborting `queueDeadline` drops a QUEUED waiter from the queue and rejects
   * it WITHOUT ever invoking `fn` (see concurrency-gate), so an expiry here
   * cannot leak a waiter that later wakes and fires a request nobody awaits.
   * The signal is chained from the caller's, so an unmount still cancels
   * normally at either stage.
   *
   * Deliberately NOT reported as `reportSyncUnreachable`: exhausting our OWN
   * in-process slots says nothing about whether the origin is up, and flipping
   * the whole app offline for local back-pressure would be a false alarm.
   */
  const runGated = async (
    name: string,
    args: unknown,
    delta: string | undefined,
    options: QueryFetchOptions = {},
  ): Promise<QueryResult> => {
    const signal = options.signal;
    const queueDeadline = new AbortController();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCallerAbort = (): void => queueDeadline.abort();
    if (signal) {
      if (signal.aborted) queueDeadline.abort();
      else signal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const startedAtMs = nowMs();
    const meta: RequestMeta = {
      traceId: createSyncTraceId('query'),
      sentAtMs: null,
      responseAtMs: null,
      bodyCompleteAtMs: null,
      parseCacheMs: null,
      resolverMs: null,
      bytes: -1,
    };
    // RACED for the same reason sendOne races: a rejection we control is the
    // only way to guarantee this settles regardless of how the gate or the
    // transport behaves.
    //
    // WI-6569: this timer wraps `gate.run(...)` — acquire AND execute — so it
    // fires for two causally opposite failures, and reporting both as "waiting
    // for a request slot" sent two separate investigations at the gate for a
    // stall that was never in it. `meta.sentAtMs` is exactly the discriminator
    // (null ⇒ sendOne never ran ⇒ never admitted), and the metrics path below
    // already splits waitMs/requestMs on it; only this message did not. Say
    // which deadline actually elapsed, and — when the slot WAS granted — how
    // long each half took, so the next reader is pointed at the transport
    // rather than at a gate that had capacity to spare the whole time.
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        queueDeadline.abort();
        const admittedAtMs = meta.sentAtMs;
        reject(
          new Error(
            admittedAtMs === null
              ? `sync query "${name}" timed out after ${requestTimeoutMs}ms waiting for a request slot`
              : `sync query "${name}" timed out after ${requestTimeoutMs}ms in flight ` +
                `(got a slot after ${Math.round(admittedAtMs - startedAtMs)}ms, then ` +
                `${Math.round(nowMs() - admittedAtMs)}ms awaiting the response — the gate ` +
                `was not the bottleneck)`,
          ),
        );
      }, requestTimeoutMs);
    });
    let outcome: SyncQueryOutcome = 'ok';
    try {
      const running = gate.run(
        (schedulerSignal, schedulerContext) =>
          // A holder can finish on the same timer turn that expires another
          // caller's total deadline. Guard immediately before the wire call so
          // the scheduler's pump cannot admit that already-expired waiter in
          // the tiny ordering window between the two timer callbacks.
          (nowMs() - startedAtMs >= requestTimeoutMs
            ? Promise.reject< QueryResult>(
                new Error(
                  `sync query "${name}" timed out after ${requestTimeoutMs}ms waiting for a request slot`,
                ),
              )
            : sendOne(name, args, delta, schedulerSignal, meta)
          ).then((result) => {
            schedulerContext.recordBytes(meta.bytes);
            return result;
          }),
        {
          signal: queueDeadline.signal,
          class: options.requestClass ?? options.class ?? 'foreground-read',
          coalesceKey: options.coalesceKey,
          staleAfterMs: options.staleAfterMs,
          // `runGated` owns the compatibility deadline and its diagnostic
          // wording (queue wait vs in-flight). Disable the scheduler's own
          // timer here so two same-length timers cannot race and hide that
          // useful distinction; direct scheduler callers still get a total
          // deadline by default.
          timeoutMs: 0,
        },
      );
      // The loser of the race can still reject later; swallow it so it is not
      // an unhandled rejection.
      running.catch(() => {});
      const result = await Promise.race([running, expiry]);
      const admittedAtMs = meta.sentAtMs ?? nowMs();
      const timing = result.syncTiming;
      result.syncTiming = {
        ...(timing ?? {}),
        traceId: meta.traceId,
        schedulerWaitMs: Math.max(0, admittedAtMs - startedAtMs),
        parseCacheEndedAtMs: timing?.parseCacheEndedAtMs ?? nowMs(),
      };
      return result;
    } catch (e) {
      outcome = expired ? 'timeout' : isAbortError(e, signal) ? 'aborted' : 'error';
      // The scheduler observes `queueDeadline.abort()` and may reject its
      // cancellation race a microtask before our expiry promise. Preserve the
      // established, actionable message in that case instead of exposing an
      // implementation-level AbortError.
      if (expired && !signal?.aborted) {
        const admittedAtMs = meta.sentAtMs;
        throw new Error(
          admittedAtMs === null
            ? `sync query "${name}" timed out after ${requestTimeoutMs}ms waiting for a request slot`
            : `sync query "${name}" timed out after ${requestTimeoutMs}ms in flight ` +
              `(got a slot after ${Math.round(admittedAtMs - startedAtMs)}ms, then ` +
              `${Math.round(nowMs() - admittedAtMs)}ms awaiting the response — the gate ` +
              `was not the bottleneck)`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
      // Recorded for EVERY outcome, including the ones that never reached the
      // wire: a request that spent 9s queued and then timed out is precisely the
      // event this instrumentation exists to make visible, and it has no
      // `sentAtMs` — so the whole elapsed time is queue wait, not a lost sample.
      const endedAtMs = nowMs();
      const sentAtMs = meta.sentAtMs ?? endedAtMs;
      const waitMs = Math.max(0, sentAtMs - startedAtMs);
      syncMetrics.queryCompleted({
        name,
        startedAtMs,
        waitMs,
        requestMs: meta.sentAtMs === null ? 0 : endedAtMs - meta.sentAtMs,
        bytes: meta.bytes,
        outcome,
        traceId: meta.traceId,
        stages: {
          schedulerWaitMs: waitMs,
          ...(meta.resolverMs === null ? {} : { resolverMs: meta.resolverMs }),
          ...(meta.responseAtMs === null || meta.bodyCompleteAtMs === null
            ? {}
            : { transferMs: Math.max(0, meta.bodyCompleteAtMs - meta.responseAtMs) }),
          ...(meta.parseCacheMs === null ? {} : { parseCacheMs: meta.parseCacheMs }),
        },
      });
    }
  };

  // Delta-aware wrapper. No codec (the default) or a non-opted-in query → a
  // plain request with NO `delta` param. For a delta query: send the cursor
  // ('' cold), decode into full rows, and on a checksum mismatch / missing base
  // re-request a clean full. A wrong or stale key can only cost a refetch,
  // never a wrong view.
  const fetchQuery: QueryFetch = async (name, args, opts) => {
    const queryOptions = opts ?? {};
    const codec = getSyncDeltaCodec();
    if (!codec?.enabled(name)) return runGated(name, args, undefined, queryOptions);

    const viewKey = codec.viewKey(name, args);
    const cursor = codec.cursorFor(viewKey);
    const raw = await runGated(name, args, cursor ?? '', queryOptions);
    const dec = codec.decodeResult(viewKey, raw);
    if (dec.refetchFull && cursor !== undefined) {
      const full = await runGated(name, args, '', queryOptions);
      const dec2 = codec.decodeResult(viewKey, full);
      return { rows: dec2.rows, version: full.version };
    }
    return { rows: dec.rows, version: raw.version };
  };

  fetchers.set(key, { fetchQuery, gate });
  return fetchQuery;
}

/** The gate backing an endpoint's fetcher — observability and tests. */
export function getFetchGate(restEndpoint: string, tokenQueryParam?: string): ConcurrencyGate | undefined {
  return fetchers.get(keyFor(restEndpoint, tokenQueryParam))?.gate;
}

/** Drop every cached fetcher. Test-only; the map is process-wide by design. */
export function _resetQueryFetchersForTests(): void {
  fetchers.clear();
  // The endpoint fetcher cache and the origin scheduler registry are both
  // process-wide. Keep the test reset symmetrical so a capped scheduler from
  // one test cannot leak into the next endpoint/profile assertion.
  _resetOriginSchedulersForTests();
}
