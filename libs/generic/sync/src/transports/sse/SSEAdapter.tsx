'use client';

/**
 * SSE Transport — desktop's PRIMARY push transport.
 *
 * Status (2026-05-11): production. The shipping desktop app (Tauri) mounts
 * this adapter via `syncType="SSE"` in HarnessSyncProvider whenever
 * runtime === 'tauri' (detected via `__TAURI_INTERNALS__` +
 * `/api/desktop/version` fingerprint). The server endpoint
 * `apps/operator/app/api/zero-harness/sse/route.ts` emits invalidate /
 * update / heartbeat events backed by PG LISTEN/NOTIFY. Resilience knobs
 * (jitter, zombie watchdog, heartbeat handling, Last-Event-ID-ready) are
 * load-bearing in production.
 *
 * Browser (test / dev) uses this same SSE path. Legacy callers that pass
 * `syncType="WEBSOCKETS"` are normalized by SyncProvider before adapter
 * selection; the webapp is not the production user surface — see /CLAUDE.md
 * "Deployment model".
 *
 * Earlier header for archival: an older doc-comment (2026-05-06) called this
 * adapter "preserved-but-frozen" alongside libs/sync/PASS_2_1_DECISION.md.
 * That stance was reversed 2026-05-07 when desktop committed to SSE as
 * primary; PASS_2_1_DECISION.md now carries a SUPERSEDED banner.
 *
 * Same fetcher as PollingAdapter (react-query against `${endpoint}/rest-query`)
 * plus an EventSource subscribed to `${endpoint}/sse` that pushes invalidation
 * events. When the server posts `invalidate` for a query name + args, we mark
 * the matching react-query cache key stale so it refetches on the next render.
 *
 * Falls back gracefully:
 *   - No EventSource (older runtimes) → behaves identically to polling.
 *   - EventSource open fails / connection drops → polling cadence still
 *     refreshes data; we reconnect with backoff.
 *
 * Server contract:
 *   GET ${endpoint}/sse
 *     event: invalidate
 *     data: { "name": "queryName", "args"?: {...}, "tsMs"?: <Date.now>  }
 *
 *     event: heartbeat                   ← required, every HEARTBEAT_INTERVAL_MS
 *     data: { "tsMs": <Date.now> }
 *
 *   If `args` is absent, every cached entry under `name` invalidates.
 *   `tsMs` (when present on invalidate) is used to populate
 *   syncMetrics.lastEventLatencyMs. Heartbeats reset the client zombie watchdog.
 *
 *   Reconnect-replay: server SHOULD honor the `Last-Event-ID` header on
 *   reconnect by replaying events with id > Last-Event-ID from a per-workspace
 *   ring buffer. Not yet shipped on the client side either — pass 2.3.
 *
 * Why polling cadence is kept: SSE-driven invalidation is best-effort. A
 * dropped connection or a server bug shouldn't freeze panels. Polling acts
 * as the floor; SSE narrows the staleness window from poll-interval to
 * event-latency when both work.
 *
 * Resilience knobs (pass 1.3):
 *   - Reconnect backoff with ±20% jitter — avoids thundering-herd reconnect
 *     when many tabs disconnect simultaneously (e.g. server restart).
 *   - Zombie watchdog — if no event AND no heartbeat for ZOMBIE_TIMEOUT_MS,
 *     the connection is presumed hung and we force-reconnect. EventSource's
 *     native `error` doesn't fire on quietly hung connections.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createCrossTabControlStream, defaultControlChannelKey } from '@papercusp/sse';
import { SyncContext } from '../../SyncContext';
import { getQueryClient } from '../polling/queryClient';
import {
  createUsePollingQuery,
  createPrefetchSync,
} from '../polling/usePollingQuery';
import { getOriginScheduler } from '../polling/origin-scheduler';
import {
  createSyncTraceId,
  syncMetrics,
  installSyncMetricsGlobal,
} from '../../observability/metrics';
import { emitSyncBusEvent, type SyncBusEvent } from '../../bus-tap';
import { classifyInterestNames, withInterestParam } from '../../interest-protocol';
import { createInterestTracker } from './query-interest';

/**
 * The client half of cap-crossing visibility.
 *
 * `withInterestParam` refuses an over-cap declaration and returns the URL
 * unchanged, which is correct (truncating would silently starve whichever
 * names fell off the end) but indistinguishable from never having declared —
 * the tab reverts to full fan-out and nothing says so. Warn on the EDGE only,
 * so a persistently over-cap client logs once rather than on every cache
 * mutation.
 */
let lastInterestOverCap = false;
function reportInterestCapCrossing(names: Iterable<string>): void {
  const { disposition, declaredCount } = classifyInterestNames(names);
  const overCap = disposition === 'over-cap';
  if (overCap && !lastInterestOverCap) {
    console.warn(
      `[sync-sse] interest declaration OVER CAP — ${declaredCount} observed query names; this tab reverts to FULL FAN-OUT`,
    );
  }
  lastInterestOverCap = overCap;
}
import { reportSyncReachable, reportSyncUnreachable } from '../../connectivity';
import type { SyncType } from '../../types';

interface SSEAdapterProps {
  children: ReactNode;
  userId?: string;
  server?: string;
  restEndpoint?: string;
  /**
   * Drift-repair refetch interval. Under SSE, freshness comes from
   * invalidate-driven refetches — this tick only repairs pushes lost to an
   * SSE blip or a table missing its bridge entry, so it defaults LONG
   * (180s). Do not hand it the POLLING transport's fast cadence (EI-278:
   * a shared 5-10s interval made every subscription REST-refetch on that
   * cadence on top of SSE — ~3.2 fetches/s sustained, 16GB webview OOM).
   */
  pollIntervalMs?: number;
  onTransportError?: (error: Error) => void;
  /** ?token=<value> appended to the SSE URL. EventSource can't carry headers. */
  tokenQueryParam?: string;
  /** Override the SSE endpoint path. Default: `${restEndpoint}/sse`. */
  endpointOverride?: string;
  /** Pause EventSource when document hidden >5min. */
  visibilityPause?: boolean;
  /** Max sync requests in flight at once (default 24). See query-fetcher.ts. */
  maxInFlightFetches?: number;
  /** Query names excluded from the host's persisted-cache snapshot (WI-6656). */
  persistExcludeQueryNames?: readonly string[];
  /** Exact query names this endpoint admits; absent means unrestricted. */
  queryNameAllowlist?: readonly string[];
}

const DEFAULT_REST_ENDPOINT = 'http://localhost:3100/zero';
const VISIBILITY_PAUSE_MS = 5 * 60_000;

interface InvalidateEvent {
  name: string;
  args?: Record<string, unknown>;
}

interface UpdateEvent {
  name: string;
  args?: Record<string, unknown>;
  data: unknown[];
}

function SSESubscriber({
  endpoint,
  onError,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
}: {
  endpoint: string;
  onError?: (e: Error) => void;
  tokenQueryParam?: string;
  endpointOverride?: string;
  visibilityPause?: boolean;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    installSyncMetricsGlobal();

    // Build the SSE URL once; both the initial open and reconnects use it.
    const baseUrl = endpointOverride ?? `${endpoint}/sse`;
    const authedUrl = tokenQueryParam
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(tokenQueryParam)}`
      : baseUrl;

    // Per-client invalidation filtering: declare the query names this browser
    // actually observes, so the server skips fanning the rest down this
    // socket. The declaration is the UNION across every tab sharing this
    // stream (query-interest.ts) — one built from the owner tab's cache alone
    // would silently starve the follower tabs, which is a worse bug than the
    // fan-out it fixes and is invisible in the single-webview desktop case
    // where it would most likely be tested (D-003c).
    //
    // `source` is assigned just below; growth can only be reported after the
    // debounce window, but the guard keeps that ordering explicit rather than
    // load-bearing.
    // Pin the control-stream channel key to the URL WITHOUT the declaration.
    //
    // This is load-bearing, and the failure it prevents is silent and
    // expensive: defaultControlChannelKey folds every non-bearer query param
    // into the channel name, and `queries` is not bearer-like. Left to the
    // default, two tabs observing different queries would compute DIFFERENT
    // channel keys, elect themselves separate owners, and each open their own
    // standing socket — multiplying exactly the per-origin sockets
    // WI-2141694 exists to conserve, while making the cross-tab union below
    // meaningless. Keying off `authedUrl` reproduces the pre-declaration key
    // byte-for-byte, so election behaviour is unchanged by this feature.
    const channelKey = defaultControlChannelKey(authedUrl);

    let source: ReturnType<typeof createCrossTabControlStream> | null = null;
    const interest = createInterestTracker({
      queryClient,
      // The SAME key the control stream uses, so "tabs sharing a socket" and
      // "tabs sharing an interest union" are the same set BY CONSTRUCTION
      // rather than by two derivations that could drift apart. It also
      // inherits the workspace marker, so tabs on different workspaces — which
      // deliberately do not share a socket — do not pool declarations either.
      scope: channelKey,
      onGrow: (names) => {
        if (!source) return;
        reportInterestCapCrossing(names);
        // Every tab takes the new URL, so a follower that later wins the
        // election opens with the current union rather than a stale set...
        source.setUrl(withInterestParam(authedUrl, names));
        // ...but only the tab holding the physical socket reconnects onto it.
        // A follower calling reconnect() would force a needless re-election.
        if (source.isOwner) source.reconnect();
      },
    });
    reportInterestCapCrossing(interest.current());
    const sseUrl = withInterestParam(authedUrl, interest.current());

    // Mounting a query is what grows the set; the cache is the one place that
    // sees every mount without useSyncQuery having to declare anything.
    const unsubscribeCache = queryClient.getQueryCache().subscribe(() => interest.refresh());

    // Account for the consolidated control stream in the same per-origin
    // budget as finite requests. Only the elected physical owner holds this
    // lease; follower tabs receive the owner's events over BroadcastChannel
    // and therefore do not spend another origin connection. Extra streams
    // dynamically reduce admission; bulk/media transports use a separate
    // registration and never consume this reservation (D-017/P-018).
    const scheduler = getOriginScheduler(endpoint);
    let controlStream: ReturnType<typeof scheduler.registerStream> | null = null;
    const onPhysicalStreamChange = (active: boolean): void => {
      if (active) {
        if (!controlStream) {
          controlStream = scheduler.registerStream({
            name: 'control-sse',
            kind: 'control',
          });
        }
      } else {
        controlStream?.release();
        controlStream = null;
      }
    };

    // Resilience (jitter, zombie watchdog, backoff, escalation, visibility
    // pause) lives in @papercusp/sse's cross-tab control wrapper, which
    // composes createResilientEventSource. This subscriber only owns the
    // react-query invalidation/setQueryData wiring + syncMetrics calls.
    let firstConnect = true;

    const handlePayload = (data: string, parse: 'update' | 'invalidate') => {
      const receivedAtMs = Date.now();
      try {
        const ev = JSON.parse(data) as (InvalidateEvent | UpdateEvent) & { tsMs?: number };
        if (!ev?.name) {
          syncMetrics.sseEventReceived(data?.length ?? 0);
          return;
        }
        if (parse === 'update' && !Array.isArray((ev as UpdateEvent).data)) {
          syncMetrics.sseEventReceived(data?.length ?? 0);
          return;
        }
        const traceId = createSyncTraceId('sse');
        syncMetrics.sseEventReceived(data?.length ?? 0, ev.tsMs, {
          queryName: ev.name,
          traceId,
          receivedAtMs,
        });
        // EI-19406583179082751: name-tag the counter so `logInvalidationsBySse()` can
        // attribute a push-volume anomaly to specific query names instead of only the
        // aggregate `fromSse` total.
        syncMetrics.invalidateFromSse(ev.name);
        // Fan the raw event out to app-level listeners (bus-tap) so consumers
        // like attention notifiers share THIS stream instead of opening their
        // own EventSource against the same route (each standing stream costs a
        // per-host browser socket).
        emitSyncBusEvent({
          ...(ev as SyncBusEvent),
          traceId,
          receivedAtMs,
          ...(ev.tsMs === undefined ? {} : { tsMs: ev.tsMs }),
        });
        if (parse === 'update') {
          const upd = ev as UpdateEvent;
          const cacheValue = {
            rows: upd.data,
            version: String(Date.now()),
            syncTiming: {
              traceId,
              committedAtMs: ev.tsMs,
              eventReceivedAtMs: receivedAtMs,
              parseCacheMs: 0,
              parseCacheEndedAtMs:
                typeof performance !== 'undefined' ? performance.now() : receivedAtMs,
            },
          };
          if (upd.args) {
            queryClient.setQueryData(['sync', upd.name, upd.args], cacheValue);
          } else {
            queryClient.setQueriesData(
              {
                predicate: (q) =>
                  Array.isArray(q.queryKey) &&
                  q.queryKey[0] === 'sync' &&
                  q.queryKey[1] === upd.name,
              },
              cacheValue,
            );
          }
        } else {
          if (ev.args) {
            queryClient.invalidateQueries({ queryKey: ['sync', ev.name, ev.args] });
          } else {
            queryClient.invalidateQueries({
              predicate: (q) =>
                Array.isArray(q.queryKey) &&
                q.queryKey[0] === 'sync' &&
                q.queryKey[1] === ev.name,
            });
          }
        }
      } catch {
        syncMetrics.sseEventReceived(data?.length ?? 0);
      }
    };

    source = createCrossTabControlStream({
      url: sseUrl,
      channelKey,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      jitter: 0.2,
      // ZOMBIE_TIMEOUT_MS must be > server HEARTBEAT_INTERVAL_MS (15s) by
      // enough margin to absorb network jitter; 30s = one missed-beat grace.
      zombieTimeoutMs: 30_000,
      // After 3 consecutive failures with zero successful opens, escalate
      // via onError so useTransportFallback can move to POLLING.
      maxConsecutiveFailures: 3,
      // A control stream should not remain parked in a hidden tab by default:
      // the wrapper relinquishes the lease and lets a visible peer take over.
      // Callers can explicitly opt out with visibilityPause={false}.
      pauseWhenHidden: visibilityPause ?? true,
      visibilityPauseMs: VISIBILITY_PAUSE_MS,
      // WI-2141694: this stream holds a STANDING per-origin socket, and several
      // same-origin documents (the portal's steering + chat panes, the HUD and
      // launched-sessions iframes) each hold their own. At the browser's ~6
      // connection cap the standing streams starve every short REST fetch on
      // the page — including the ones a newly-framed document needs to boot,
      // which is how an iframe hangs at readyState=interactive with an empty
      // root. Yielding costs at most one poll interval here: the polling
      // cadence above is a permanent floor ("SSE narrows the staleness window
      // from poll-interval to event-latency"), so a parked stream re-baselines
      // by construction rather than accumulating an unrecoverable gap — the
      // precondition resilient-event-source documents for this opt-in.
      //
      // A yield is NOT an error path: yieldForContention closes the socket and
      // sets status 'idle' without invoking onError, so it cannot trip the
      // maxConsecutiveFailures escalation to POLLING above.
      //
      // Priority is left at the default 0 deliberately, which makes the
      // registry's tie-break (oldest-first) do the right thing here: the
      // always-present panes are the oldest streams, so they are the ones that
      // step aside for a just-opened iframe, then resume when it closes.
      yieldOnContention: true,
      handlers: {
        heartbeat: () => { /* watchdog reset is handled inside the wrapper */ },
        invalidate: (data) => handlePayload(data, 'invalidate'),
        update:     (data) => handlePayload(data, 'update'),
      },
      onOpen: () => {
        syncMetrics.sseConnected();
        // The stream opened — the origin is reachable (EI-239 offline store).
        reportSyncReachable();
      },
      onStatusChange: (s) => {
        if (s === 'connecting' && !firstConnect) syncMetrics.sseReconnectAttempt();
        if (s === 'failing' || s === 'closed') syncMetrics.sseDisconnected();
        // Reconnects failing = network-level unreachability candidate. A
        // single blip that reopens resets via onOpen before the offline
        // threshold (2 consecutive) is met.
        if (s === 'failing') reportSyncUnreachable();
        // 'idle' after firstConnect=false means we transitioned from a live
        // connection (visibility-pause); the metric needs to fire so dashboards
        // see the drop. Initial 'idle' (before any connect) is skipped.
        if (s === 'idle' && !firstConnect) syncMetrics.sseDisconnected();
        if (s !== 'idle' && s !== 'closed') firstConnect = false;
      },
      onError,
      onPhysicalStreamChange,
    });

    return () => {
      syncMetrics.sseDisconnected();
      unsubscribeCache();
      interest.close();
      source?.close();
      controlStream?.release();
      controlStream = null;
    };
  }, [endpoint, queryClient, onError, tokenQueryParam, endpointOverride, visibilityPause]);

  return null;
}

/**
 * Default SSE drift-repair interval (EI-278). LONG by design: under SSE the
 * refetch trigger is the invalidation push; this tick only catches pushes
 * lost to a blip or an unbridged table. Anything in the 5-15s range here
 * turns the "push-driven" transport into a fleet-wide poll storm
 * (~3.2 req/s measured on the operator /adv page) — see the pin test.
 */
export const SSE_DRIFT_REPAIR_DEFAULT_MS = 180_000;

export function SSEAdapter({
  children,
  restEndpoint,
  server,
  pollIntervalMs = SSE_DRIFT_REPAIR_DEFAULT_MS,
  onTransportError,
  tokenQueryParam,
  endpointOverride,
  visibilityPause,
  maxInFlightFetches,
  persistExcludeQueryNames,
  queryNameAllowlist,
}: SSEAdapterProps) {
  const endpoint = restEndpoint ?? (server ? `${server}/zero` : DEFAULT_REST_ENDPOINT);
  const queryClient = getQueryClient();

  const useDataImpl = useMemo(
    () =>
      createUsePollingQuery({
        restEndpoint: endpoint,
        defaultPollIntervalMs: pollIntervalMs,
        tokenQueryParam,
        maxInFlightFetches,
        persistExcludeQueryNames,
        queryNameAllowlist,
      }),
    [endpoint, pollIntervalMs, tokenQueryParam, maxInFlightFetches, persistExcludeQueryNames, queryNameAllowlist],
  );

  const prefetch = useMemo(
    () =>
      createPrefetchSync(
        { restEndpoint: endpoint, defaultPollIntervalMs: pollIntervalMs, tokenQueryParam, maxInFlightFetches, queryNameAllowlist },
        queryClient,
      ),
    [endpoint, pollIntervalMs, tokenQueryParam, maxInFlightFetches, queryNameAllowlist, queryClient],
  );

  const ctxValue = useMemo(
    () => ({ transport: 'SSE' as SyncType, useDataImpl, prefetch }),
    [useDataImpl, prefetch],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <SyncContext.Provider value={ctxValue}>
        <SSESubscriber
          endpoint={endpoint}
          onError={onTransportError}
          tokenQueryParam={tokenQueryParam}
          endpointOverride={endpointOverride}
          visibilityPause={visibilityPause}
        />
        {children}
      </SyncContext.Provider>
    </QueryClientProvider>
  );
}
