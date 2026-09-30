'use client';

import { keepPreviousData, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { SyncQueryOptions, SyncQueryResult } from '../../types';
import {
  syncMetrics,
  installSyncMetricsGlobal,
  type SyncQueryTiming,
} from '../../observability/metrics';
import { DEFAULT_MAX_IN_FLIGHT, getQueryFetcher } from './query-fetcher';
import { getQueryClient } from './queryClient';

interface PollingConfig {
  restEndpoint: string;
  defaultPollIntervalMs: number;
  /**
   * When set, appended as `?token=<encoded>` to every sync fetch.
   * Needed for clients that auth via query-string (Tauri WebView mobile
   * cross-origin to a JWT-gated endpoint), since the fetcher uses
   * bare `fetch` and can't carry Authorization headers.
   */
  tokenQueryParam?: string;
  /**
   * Max sync requests in flight against this endpoint at once
   * (default `DEFAULT_MAX_IN_FLIGHT` = 24). Shared by the hook, the prefetch
   * helper and `fetchSyncQuery` — see query-fetcher.ts for why a cap is kept
   * even though desktop IPC has no per-host connection limit.
   */
  maxInFlightFetches?: number;
  /**
   * Query names to exclude from the host's persisted-cache snapshot by
   * default (WI-6656) — threaded down from `SyncProviderProps.persistExcludeQueryNames`.
   * A per-call `persist: true` on `useSyncQuery` overrides this for that one
   * call site.
   */
  persistExcludeQueryNames?: readonly string[];
  /** Exact query names this endpoint admits; absent means unrestricted. */
  queryNameAllowlist?: readonly string[];
}

// Stable singleton empty array so consumers that depend on `data` reference
// equality (useMemo deps, useCallback deps) don't re-run when the query is
// loading. Without this, every render during loading returns a new `[]`,
// which cascades into infinite re-render loops in downstream components.
const EMPTY_ARRAY: readonly unknown[] = Object.freeze([]);

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

// Avoid React's SSR warning while keeping the commit-stage writer in the
// layout-effect phase in a browser. The passive effect is the fallback when no
// browser document exists (tests/SSR), where there is no paint to observe.
const useSyncLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function createUsePollingQuery(config: PollingConfig) {
  // One fetcher (and one shared concurrency gate) per endpoint. Each query is
  // its own `GET /rest-query`: a refetch wave of ~95 finishes faster this way
  // than as one bundle AND paints incrementally, because a slow query occupies
  // one slot instead of holding the whole wave's results hostage
  // (drop-sync-batcher-2026-07-25 D-001). The gate is what keeps that safe on
  // the paths where a per-host connection cap is still real: the desktop's
  // pre-IPC HTTP fallback, and the `:3055` dev browser. ⚠ `PAPERCUSP_IPC_READY`
  // is a sidecar→Rust STDOUT handshake and is NOT observable from the webview;
  // the caller asserts the transport via `endpoint_ipc_status().client` and
  // retunes this gate's cap through `maxInFlightFetches` (D-047 of
  // no-http-anywhere-2026-07-28).
  const fetchQuery = getQueryFetcher(
    config.restEndpoint,
    config.tokenQueryParam,
    config.maxInFlightFetches ?? DEFAULT_MAX_IN_FLIGHT,
  );
  // Built once per adapter mount (config is stable per useMemo at the call
  // site), not per render.
  const persistExcludeSet = config.persistExcludeQueryNames
    ? new Set(config.persistExcludeQueryNames)
    : null;
  const queryNameAllowSet = config.queryNameAllowlist
    ? new Set(config.queryNameAllowlist)
    : null;

  return function usePollingQuery<T = any>(opts: SyncQueryOptions): SyncQueryResult<T> {
    const { queryName, args = {}, pollIntervalMs, enabled = true, staleTime, persist } = opts;
    const queryAllowed = queryNameAllowSet === null || queryNameAllowSet.has(queryName);
    const effectiveEnabled = enabled && queryAllowed;
    const interval = pollIntervalMs ?? config.defaultPollIntervalMs;
    // WI-6656: stamp `meta.persist = false` for a query the provider (or this
    // call) opted out of the persisted-cache snapshot. A per-call `persist`
    // always wins over the provider-level name exclusion.
    const persistFalse = persist === false || (persist === undefined && persistExcludeSet?.has(queryName));
    // Stable string key for the args object — useCallback dep that doesn't
    // churn on every render the way the `{}` default would.
    const argsKey = JSON.stringify(args);

    // Each fetcher invocation = a cache miss (network round-trip). Cache
    // hits (data returned without a fetch) are accounted below.
    //
    // Destructuring `signal` is load-bearing, not decoration: react-query only
    // marks a query as abort-signal-consuming when the queryFn *reads* that
    // getter, and only then does it cancel the in-flight request when the last
    // observer unsubscribes. Reading it here is what makes an unmounted panel
    // stop paying for a fetch nobody will render.
    const queryFn = useCallback(
      ({ signal }: { signal: AbortSignal }) => {
        syncMetrics.cacheMiss();
        return fetchQuery(queryName, JSON.parse(argsKey), { signal });
      },
      [queryName, argsKey],
    );

    const { data, isLoading, isFetching, isPlaceholderData, error, refetch, failureCount, failureReason } = useQuery({
      // The raw args object is safe here: TanStack v5 hashes query keys
      // structurally (sorted keys), so content-equal args from non-memoized
      // callers map to the same query — no refetch churn (pinned by
      // usePollingQuery.test.tsx, audit P-066). Keep it an OBJECT: the
      // SSEAdapter's exact-match setQueryData/invalidateQueries build keys
      // from server-emitted args objects, which match structurally; a
      // JSON.stringify'd string key would be key-order-sensitive and break
      // that cross-source matching.
      queryKey: ['sync', queryName, args],
      queryFn,
      refetchInterval: interval,
      enabled: effectiveEnabled,
      placeholderData: keepPreviousData,
      ...(staleTime !== undefined ? { staleTime } : {}),
      ...(persistFalse ? { meta: { persist: false } } : {}),
    });

    // A successful result carries the trace started by the gated fetcher (or by
    // an SSE update written directly into the cache). These two writers are kept
    // separate deliberately: React commit is before paint, while the next
    // animation frame is the closest honest proxy for "update reached screen".
    // Missing trace metadata means the cache predates this instrument; it is
    // left unknown rather than rendered as a zero-duration stage.
    const timing = (data as { syncTiming?: SyncQueryTiming } | undefined)?.syncTiming;
    const traceId = timing?.traceId;
    useSyncLayoutEffect(() => {
      if (!timing || !traceId) return;
      syncMetrics.recordStage('reactCommit', Math.max(0, nowMs() - timing.parseCacheEndedAtMs), {
        queryName,
        traceId,
      });
    }, [queryName, traceId]);

    useEffect(() => {
      if (!timing || !traceId) return;
      let cancelled = false;
      const record = () => {
        if (cancelled) return;
        syncMetrics.recordStage(
          'updateToScreen',
          Math.max(0, nowMs() - timing.parseCacheEndedAtMs),
          { queryName, traceId },
        );
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        const frame = window.requestAnimationFrame(record);
        return () => {
          cancelled = true;
          if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame);
        };
      }
      // Non-browser hosts have no paint boundary; record the passive-commit
      // observation immediately rather than inventing a timer-based duration.
      record();
      return () => {
        cancelled = true;
      };
    }, [queryName, traceId]);

    // Track cache hits: when the hook returns data on the first render without
    // having gone through queryFn (e.g. another subscriber filled the cache,
    // or staleTime kept the entry fresh across a remount). Latched per mount
    // so we don't repeatedly bump the counter on re-renders.
    const recordedRef = useRef(false);
    if (!recordedRef.current && effectiveEnabled) {
      installSyncMetricsGlobal();
      if (data !== undefined && !isFetching) {
        syncMetrics.cacheHit();
        recordedRef.current = true;
      } else if (!isLoading && !isFetching) {
        // Disabled or no data and not fetching — neither hit nor miss.
        recordedRef.current = true;
      }
    }

    const invalidate = useCallback(() => {
      if (!queryAllowed) return;
      syncMetrics.invalidateFromManual();
      refetch();
    }, [queryAllowed, refetch]);

    return {
      data: ((data as { rows?: T[] } | undefined)?.rows ?? (EMPTY_ARRAY as unknown)) as T[],
      loading: isLoading,
      fetching: isPlaceholderData && isFetching,
      transport: 'POLLING',
      invalidate,
      error: error as Error | null,
      failureCount,
      failureReason: (failureReason ?? null) as Error | null,
    };
  };
}

export function createPrefetchSync(config: PollingConfig, queryClient: QueryClient) {
  const fetchQuery = getQueryFetcher(
    config.restEndpoint,
    config.tokenQueryParam,
    config.maxInFlightFetches ?? DEFAULT_MAX_IN_FLIGHT,
  );
  const queryNameAllowSet = config.queryNameAllowlist
    ? new Set(config.queryNameAllowlist)
    : null;
  return function prefetchSync(opts: SyncQueryOptions) {
    const { queryName, args = {} } = opts;
    if (queryNameAllowSet !== null && !queryNameAllowSet.has(queryName)) return;
    let coalesceKey: string | undefined;
    try {
      coalesceKey = `${queryName}:${JSON.stringify(args)}`;
    } catch {
      // TanStack Query will report a useful key error for a non-serializable
      // argument; do not let metrics/coalescing change that behavior.
    }
    void queryClient.prefetchQuery({
      queryKey: ['sync', queryName, args],
      // Prefetches are background work. They share the origin scheduler with
      // foreground reads, leave the interactive reservation intact, and can
      // replace an older queued refresh for the same query key.
      queryFn: ({ signal }) =>
        fetchQuery(queryName, args, {
          signal,
          requestClass: 'background-sync',
          ...(coalesceKey ? { coalesceKey } : {}),
        }),
      staleTime: 30_000,
    });
  };
}

/** Imperative access to the same named-query cache used by useSyncQuery.
 * Useful for async store interfaces (dock layouts) that cannot call hooks.
 *
 * ⚠ `maxInFlightFetches` is passed through UNRESOLVED on purpose — see
 * `getQueryFetcher`. This is an opinion-less caller: it must never resolve its
 * own `undefined` to `DEFAULT_MAX_IN_FLIGHT`, because that would `setLimit(24)`
 * on the SHARED gate and un-cap a provider that deliberately capped it. Doing
 * exactly that made `/adv` run at 24 while `/settings` ran at 2 with IPC
 * disabled (measured live 2026-08-03, P-019/WI-6628). */
export async function fetchSyncQuery<T = unknown>(opts: SyncQueryOptions & {
  restEndpoint?: string;
  tokenQueryParam?: string;
  maxInFlightFetches?: number;
}): Promise<T[]> {
  const {
    queryName,
    args = {},
    staleTime = 30_000,
    restEndpoint = '/api/zero-harness',
    tokenQueryParam,
    maxInFlightFetches,
  } = opts;
  const fetchQuery = getQueryFetcher(restEndpoint, tokenQueryParam, maxInFlightFetches);
  const result = await getQueryClient().fetchQuery({
    queryKey: ['sync', queryName, args],
    queryFn: ({ signal }) => fetchQuery(queryName, args, { signal }),
    staleTime,
  });
  return result.rows as T[];
}
