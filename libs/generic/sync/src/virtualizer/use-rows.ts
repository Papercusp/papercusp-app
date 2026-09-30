'use client';

import { useCallback } from 'react';
import { useSyncQuery } from '../SyncContext';
import { assert, unreachable } from './asserts';

/**
 * Represents a position in the virtualized list used for pagination.
 *
 * @typeParam TStartRow - The type of data needed to anchor pagination
 */
export type Anchor<TStartRow> =
  | Readonly<{
      index: number;
      kind: 'forward';
      startRow?: TStartRow | undefined;
    }>
  | Readonly<{
      index: number;
      kind: 'backward';
      startRow: TStartRow;
    }>
  | Readonly<{
      index: number;
      kind: 'permalink';
      id: string;
    }>;

/**
 * Transport-neutral query descriptor. What zero-virtual calls a "QueryResult"
 * but framed against our useSyncQuery abstraction — the `queryName` + `args`
 * are resolved by the supported SSE/polling REST path. The legacy WS-shaped
 * descriptor remains source-compatible for older direct contexts.
 */
export type SyncQueryRequest = {
  /** Dot-separated name from the query registry, e.g. 'products.filtered' */
  queryName: string;
  /** Arguments passed to the parameterized query */
  args: Record<string, unknown>;
  /** @deprecated Legacy Zero TTL; retained for compatibility and ignored by supported transports. */
  ttl?: string | number;
  /** Optional polling cadence override (polling-transport only) */
  pollIntervalMs?: number;
};

export type GetPageQueryOptions<TStartRow> = {
  limit: number;
  start: TStartRow | null;
  dir: 'forward' | 'backward';
  settled: boolean;
};

export type GetPageQuery<TStartRow> = (
  options: GetPageQueryOptions<TStartRow>,
) => SyncQueryRequest;

export type GetSingleQueryOptions = {
  id: string;
  settled: boolean;
};

export type GetSingleQuery = (
  options: GetSingleQueryOptions,
) => SyncQueryRequest;

// Stable empty request → keeps `args` object identity stable when we're
// conditionally disabling a query, avoiding churn in useSyncQuery's
// JSON.stringify(args) memo key.
const EMPTY_REQUEST: SyncQueryRequest = Object.freeze({ queryName: '', args: {} });

/**
 * Shared fetching+slicing logic for the virtualizer. Calls exactly **three**
 * useSyncQuery hooks unconditionally (hook rules), toggling `enabled` to
 * effectively skip the ones we don't need:
 *
 *   Hook 1 (singleRow): only active when anchor.kind === 'permalink' (fetches
 *     the pivot row by id).
 *   Hook 2 (rows2): the main forward/backward page, OR the "page before"
 *     anchor in permalink mode.
 *   Hook 3 (rows3): the "page after" anchor in permalink mode only; disabled
 *     for forward/backward modes.
 *
 * Ported from https://github.com/rocicorp/zero-virtual (Apache-2.0), with the
 * Zero-specific `useQuery` calls swapped for our transport-agnostic
 * `useSyncQuery`, and the "complete" / "undefined" signals reinterpreted in
 * terms of `loading` / `data.length` (the rest-query REST transport doesn't
 * expose Zero's `result.type === 'complete'` flag; we infer it from the
 * cursor-paginated row count).
 */
export function useRows<TRow extends { id: string }, TStartRow>({
  pageSize,
  anchor,
  settled,
  getPageQuery,
  getSingleQuery,
  toStartRow,
  enabled = true,
}: {
  pageSize: number;
  anchor: Anchor<TStartRow>;
  settled: boolean;
  getPageQuery: GetPageQuery<TStartRow>;
  getSingleQuery: GetSingleQuery;
  toStartRow: (row: TRow) => TStartRow;
  enabled?: boolean;
}): {
  rowAt: (index: number) => TRow | undefined;
  rowsLength: number;
  complete: boolean;
  rowsEmpty: boolean;
  atStart: boolean;
  atEnd: boolean;
  firstRowIndex: number;
  permalinkNotFound: boolean;
} {
  const { kind, index: anchorIndex } = anchor;
  const isPermalink = kind === 'permalink';
  assert(!isPermalink || pageSize % 2 === 0);
  const halfPageSize = pageSize / 2;

  // ── Hook 1: single row by id (permalink only) ───────────────────────────
  const singleReq: SyncQueryRequest = enabled && isPermalink
    ? getSingleQuery({
        id: (anchor as Extract<Anchor<TStartRow>, { kind: 'permalink' }>).id,
        settled,
      })
    : EMPTY_REQUEST;
  const {
    data: singleData,
    loading: singleLoading,
    fetching: singleFetching,
  } = useSyncQuery<TRow>({
    queryName: singleReq.queryName || 'noop',
    args: singleReq.args,
    ttl: singleReq.ttl,
    pollIntervalMs: singleReq.pollIntervalMs,
    enabled: enabled && isPermalink && !!singleReq.queryName,
  });
  const typedSingleRow: TRow | undefined = isPermalink
    ? (singleData[0] as TRow | undefined)
    : undefined;
  const completeRow = isPermalink && !singleLoading && !singleFetching;
  const permalinkNotFound = isPermalink && completeRow && typedSingleRow === undefined;

  const singleStart = typedSingleRow ? toStartRow(typedSingleRow) : null;
  const pageStart = !isPermalink
    ? (
        (anchor as Extract<Anchor<TStartRow>, { kind: 'forward' | 'backward' }>)
          .startRow ?? null
      )
    : null;

  // ── Hook 2: main page (or page-before anchor in permalink mode) ─────────
  let req2: SyncQueryRequest;
  let hook2Enabled: boolean;
  if (!enabled) {
    req2 = EMPTY_REQUEST;
    hook2Enabled = false;
  } else if (isPermalink) {
    if (!permalinkNotFound && singleStart) {
      req2 = getPageQuery({
        limit: halfPageSize + 1,
        start: singleStart,
        dir: 'backward',
        settled,
      });
      hook2Enabled = true;
    } else {
      req2 = EMPTY_REQUEST;
      hook2Enabled = false;
    }
  } else {
    req2 = getPageQuery({
      limit: pageSize + 1,
      start: pageStart,
      dir: kind as 'forward' | 'backward',
      settled,
    });
    hook2Enabled = true;
  }
  const {
    data: rows2,
    loading: loading2,
    fetching: fetching2,
  } = useSyncQuery<TRow>({
    queryName: req2.queryName || 'noop',
    args: req2.args,
    ttl: req2.ttl,
    pollIntervalMs: req2.pollIntervalMs,
    enabled: hook2Enabled && !!req2.queryName,
  });
  // In our abstraction, loading=false ∧ data.length < limit means "this batch
  // is everything". That's our "complete" flag — equivalent to Zero's
  // result.type === 'complete' for this cursor-based window.
  const limit2Requested = isPermalink ? halfPageSize + 1 : pageSize + 1;
  const complete2 = hook2Enabled && !loading2 && !fetching2;

  // ── Hook 3: page-after anchor (permalink only) ──────────────────────────
  let req3: SyncQueryRequest;
  let hook3Enabled: boolean;
  if (enabled && isPermalink && !permalinkNotFound && singleStart) {
    req3 = getPageQuery({
      limit: halfPageSize,
      start: singleStart,
      dir: 'forward',
      settled,
    });
    hook3Enabled = true;
  } else {
    req3 = EMPTY_REQUEST;
    hook3Enabled = false;
  }
  const {
    data: rows3,
    loading: loading3,
    fetching: fetching3,
  } = useSyncQuery<TRow>({
    queryName: req3.queryName || 'noop',
    args: req3.args,
    ttl: req3.ttl,
    pollIntervalMs: req3.pollIntervalMs,
    enabled: hook3Enabled && !!req3.queryName,
  });
  const complete3 = hook3Enabled && !loading3 && !fetching3;

  // ── Hook 4: prefetch next page (forward / backward modes) ───────────────
  //
  // Subscribes to the page RIGHT AFTER the current one, using the last row of
  // the current page as the cursor. The rows are not consumed by rowAt — the
  // subscription just pre-warms the supported adapter's query cache so that
  // when the user scrolls past and the anchor shifts, those rows are already
  // available and delivery is effectively instant.
  //
  // Without this hook, a fast scroll can hit skeletons during the fetch window
  // between anchor shift and the supported adapter's query-cache fill. With
  // it, the new hook-2 query can satisfy from local cache while the fetcher
  // reconciles in the background.
  //
  // Rationale for only firing in forward/backward modes: permalink already
  // has its own dual-window (hooks 2 + 3) centered on the pivot.
  const lastRenderedRow =
    !isPermalink && (rows2 as TRow[] | undefined)?.length
      ? ((rows2 as TRow[])[Math.min((rows2 as TRow[]).length - 1, pageSize - 1)] as TRow)
      : null;
  let prefetchReq: SyncQueryRequest;
  let prefetchEnabled: boolean;
  if (enabled && !isPermalink && lastRenderedRow !== null && complete2) {
    prefetchReq = getPageQuery({
      limit: pageSize + 1,
      start: toStartRow(lastRenderedRow),
      dir: kind as 'forward' | 'backward',
      settled,
    });
    prefetchEnabled = true;
  } else {
    prefetchReq = EMPTY_REQUEST;
    prefetchEnabled = false;
  }
  useSyncQuery<TRow>({
    queryName: prefetchReq.queryName || 'noop',
    args: prefetchReq.args,
    ttl: prefetchReq.ttl,
    pollIntervalMs: prefetchReq.pollIntervalMs,
    enabled: prefetchEnabled && !!prefetchReq.queryName,
  });

  // Derived sizing
  const rowsBeforeLength = rows2?.length ?? 0;
  const rowsAfterLength = rows3?.length ?? 0;
  const rowsBeforeSize = Math.min(rowsBeforeLength, halfPageSize);
  const rowsAfterSize = Math.min(rowsAfterLength, halfPageSize - 1);

  const typedPageRows = (rows2 ?? []) as TRow[];
  const hasMoreRows = !isPermalink && typedPageRows.length > pageSize;
  const paginatedRowsLength = hasMoreRows ? pageSize : typedPageRows.length;
  // Reference kept for parity with the original (not consumed by rowAt).
  void limit2Requested;

  const rowAt = useCallback(
    (index: number): TRow | undefined => {
      switch (kind) {
        case 'permalink': {
          if (index === anchorIndex) return typedSingleRow;
          if (index > anchorIndex) {
            // Polling + loading: rows3.length is 0 while fetching — treat as "not yet".
            if (!hook3Enabled) return undefined;
            if (loading3 && rowsAfterLength === 0) return undefined;
            const i = index - anchorIndex - 1;
            return i < rowsAfterSize ? (rows3 as TRow[])[i] : undefined;
          }
          if (!hook2Enabled) return undefined;
          if (loading2 && rowsBeforeLength === 0) return undefined;
          const i = anchorIndex - index - 1;
          return i < rowsBeforeSize ? (rows2 as TRow[])[i] : undefined;
        }
        case 'forward': {
          if (loading2 && typedPageRows.length === 0) return undefined;
          const i = index - anchorIndex;
          return i >= 0 && i < paginatedRowsLength ? typedPageRows[i] : undefined;
        }
        case 'backward': {
          if (loading2 && typedPageRows.length === 0) return undefined;
          const i = anchorIndex - index - 1;
          return i >= 0 && i < paginatedRowsLength ? typedPageRows[i] : undefined;
        }
        default:
          unreachable(kind);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      kind,
      anchorIndex,
      typedSingleRow,
      rows2,
      rows3,
      rowsBeforeSize,
      rowsAfterSize,
      typedPageRows,
      paginatedRowsLength,
      hook2Enabled,
      hook3Enabled,
      loading2,
      loading3,
      rowsBeforeLength,
      rowsAfterLength,
    ],
  );

  if (!enabled) {
    return {
      rowAt,
      rowsLength: 0,
      complete: true,
      rowsEmpty: true,
      atStart: true,
      atEnd: true,
      firstRowIndex: 0,
      permalinkNotFound: false,
    };
  }

  if (isPermalink) {
    return {
      rowAt,
      rowsLength: permalinkNotFound
        ? 0
        : rowsBeforeSize + rowsAfterSize + (typedSingleRow ? 1 : 0),
      complete: completeRow && (permalinkNotFound || (complete2 && complete3)),
      rowsEmpty:
        permalinkNotFound ||
        typedSingleRow === undefined ||
        (rowsBeforeSize === 0 && rowsAfterSize === 0),
      atStart:
        permalinkNotFound || (complete2 && rowsBeforeLength <= halfPageSize),
      atEnd:
        permalinkNotFound || (complete3 && rowsAfterLength <= halfPageSize - 1),
      firstRowIndex: permalinkNotFound ? anchorIndex : anchorIndex - rowsBeforeSize,
      permalinkNotFound,
    };
  }

  if (kind === 'forward') {
    return {
      rowAt,
      rowsLength: paginatedRowsLength,
      complete: complete2,
      rowsEmpty: typedPageRows.length === 0,
      atStart: pageStart === null || anchorIndex === 0,
      atEnd: complete2 && !hasMoreRows,
      firstRowIndex: anchorIndex,
      permalinkNotFound,
    };
  }

  kind satisfies 'backward';
  assert(pageStart !== null);

  return {
    rowAt,
    rowsLength: paginatedRowsLength,
    complete: complete2,
    rowsEmpty: typedPageRows.length === 0,
    atStart: complete2 && !hasMoreRows,
    atEnd: false,
    firstRowIndex: anchorIndex - paginatedRowsLength,
    permalinkNotFound,
  };
}
