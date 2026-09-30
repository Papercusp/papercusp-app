import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { BloomQueryRequest, BloomQueryResponse, Versioned } from './protocol';
import type { RowStore } from './rowStore';

export interface UseInfiniteBloomQueryOptions<TRow extends Versioned, TFilter> {
  queryKey: readonly unknown[];
  fetcher: (req: BloomQueryRequest<TFilter>) => Promise<BloomQueryResponse<TRow>>;
  /** Optional follow-up fetcher to fill bloom false-positive holes. */
  rowsFetcher?: (ids: string[]) => Promise<TRow[]>;
  filter: TFilter;
  sort?: string;
  pageSize: number;
  store: RowStore<TRow>;
  enabled?: boolean;
}

export interface UseInfiniteBloomQueryResult<TRow> {
  rows: TRow[];
  total: number;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
}

/**
 * Infinite-scroll variant of useBloomQuery. Accumulates rows across pages
 * in manifest order; the bloom sent with each page is always derived from
 * the full rowStore, so a row delivered on page 1 is never re-sent when
 * page 2 is fetched (and vice versa if items shift between pages).
 */
export function useInfiniteBloomQuery<TRow extends Versioned, TFilter>(
  opts: UseInfiniteBloomQueryOptions<TRow, TFilter>,
): UseInfiniteBloomQueryResult<TRow> {
  const { queryKey, fetcher, rowsFetcher, filter, sort, pageSize, store, enabled } = opts;

  const query = useInfiniteQuery({
    queryKey: [...queryKey, filter, sort, pageSize],
    queryFn: ({ pageParam }) =>
      fetcher({
        filter,
        sort,
        limit: pageSize,
        offset: pageParam as number,
        bloom: store.bloomJSON(),
      }),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.length * pageSize;
      return loaded < last.total ? loaded : undefined;
    },
    enabled: enabled ?? true,
  });

  // Track how many pages we've already processed so we don't re-upsert old
  // pages' rows on every render.
  const processedPagesRef = useRef(0);

  useEffect(() => {
    const pages = query.data?.pages;
    if (!pages) return;
    // Reset bookkeeping when the query was reset (filter change → pages shrinks).
    if (pages.length < processedPagesRef.current) processedPagesRef.current = 0;

    for (let i = processedPagesRef.current; i < pages.length; i++) {
      const page = pages[i];
      store.upsert(page.rows);
      if (rowsFetcher) {
        const missing = store.findMissing(page.manifest);
        if (missing.length) {
          rowsFetcher(missing.map((m) => m.id))
            .then((rows) => store.upsert(rows))
            .catch(() => {
              /* best-effort */
            });
        }
      }
    }
    processedPagesRef.current = pages.length;
  }, [query.data, rowsFetcher, store]);

  const storeVersion = useSyncExternalStore(
    store.subscribe,
    store.getVersion,
    store.getVersion,
  );

  const rows = useMemo(() => {
    const out: TRow[] = [];
    const pages = query.data?.pages;
    if (!pages) return out;
    // Seen set protects against duplicate entries if the same id lands on
    // two pages (rare, but possible under concurrent writes).
    const seen = new Set<string>();
    for (const page of pages) {
      for (const m of page.manifest) {
        if (seen.has(m.id)) continue;
        const r = store.get(m.id);
        if (r !== undefined) {
          out.push(r);
          seen.add(m.id);
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, storeVersion]);

  return {
    rows,
    total: query.data?.pages[0]?.total ?? 0,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) {
        query.fetchNextPage();
      }
    },
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: (query.error as Error | null) ?? null,
  };
}
