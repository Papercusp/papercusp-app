import { QueryClient } from '@tanstack/react-query';

let queryClient: QueryClient | null = null;

export function getQueryClient(): QueryClient {
  if (!queryClient) {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 5_000,
          // gcTime: 1 hour. Queries survive subscriber unmount so navigating
          // away and back in polling/SSE mode shows cached data instantly.
          gcTime: 60 * 60 * 1000,
          refetchOnWindowFocus: false,
          structuralSharing: true, // preserves unchanged refs across refetches
          // Skip re-renders triggered by metadata-only flips (dataUpdatedAt,
          // fetchStatus, failureCount, isStale). Consumers care about data,
          // error, and the loading/fetching flags exposed via SyncQueryResult.
          // Without this, a background refetch that returns structurally-equal
          // data still flips dataUpdatedAt and fans out a render to every
          // subscriber. Listed flags must include every property usePollingQuery
          // reads from useQuery's return.
          // `failureCount`/`failureReason` are listed because usePollingQuery
          // now returns them: they are the ONLY signal that separates "loading"
          // from "silently retrying a failing load" (see SyncQueryResult), and
          // omitting them here would leave a consumer subscribed to a value that
          // never re-renders — a stale zero, which is worse than not exposing it.
          notifyOnChangeProps: [
            'data',
            'error',
            'isLoading',
            'isFetching',
            'isPlaceholderData',
            'failureCount',
            'failureReason',
          ],
        },
      },
    });
  }
  return queryClient;
}

/**
 * Immediately cancels all in-flight queries and removes them from cache.
 * (Was called by the now-removed WebSocket transport on mount to drop
 * probe-window polls; currently unused, retained as a cache-reset utility.)
 */
export function clearPollingCache(): void {
  if (!queryClient) return;
  queryClient.cancelQueries();
  queryClient.clear();
}