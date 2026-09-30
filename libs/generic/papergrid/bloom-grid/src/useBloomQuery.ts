import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BloomQueryRequest, BloomQueryResponse, Versioned } from './protocol';
import type { RowStore } from './rowStore';

export interface UseBloomQueryOptions<TRow extends Versioned, TFilter> {
  queryKey: readonly unknown[];
  fetcher: (req: BloomQueryRequest<TFilter>) => Promise<BloomQueryResponse<TRow>>;
  /** Optional follow-up fetcher to fill bloom false-positive holes. */
  rowsFetcher?: (ids: string[]) => Promise<TRow[]>;
  filter: TFilter;
  sort?: string;
  pageSize: number;
  offset: number;
  store: RowStore<TRow>;
  enabled?: boolean;
}

export interface UseBloomQueryResult<TRow> {
  rows: TRow[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
}

export function useBloomQuery<TRow extends Versioned, TFilter>(
  opts: UseBloomQueryOptions<TRow, TFilter>,
): UseBloomQueryResult<TRow> {
  const { queryKey, fetcher, rowsFetcher, filter, sort, pageSize, offset, store, enabled } = opts;

  const query = useQuery({
    queryKey: [...queryKey, filter, sort, offset, pageSize],
    queryFn: () =>
      fetcher({
        filter,
        sort,
        limit: pageSize,
        offset,
        bloom: store.bloomJSON(),
      }),
    placeholderData: keepPreviousData,
    enabled: enabled ?? true,
  });

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    store.upsert(data.rows);
    if (!rowsFetcher) return;
    const missing = store.findMissing(data.manifest);
    if (missing.length === 0) return;
    rowsFetcher(missing.map((m) => m.id))
      .then((rows) => {
        store.upsert(rows);
      })
      .catch(() => {
        /* false-positive fallback is best-effort */
      });
  }, [query.data, rowsFetcher, store]);

  const storeVersion = useSyncExternalStore(
    store.subscribe,
    store.getVersion,
    store.getVersion,
  );

  const rows = useMemo(() => {
    const data = query.data;
    if (!data) return [] as TRow[];
    const out: TRow[] = [];
    for (const m of data.manifest) {
      const r = store.get(m.id);
      if (r !== undefined) out.push(r);
    }
    return out;
    // storeVersion is included so the memo recomputes when the store mutates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, storeVersion]);

  return {
    rows,
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: (query.error as Error | null) ?? null,
  };
}
