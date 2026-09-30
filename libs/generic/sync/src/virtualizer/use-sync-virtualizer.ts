'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { defaultKeyExtractor, type Virtualizer } from '@tanstack/virtual-core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { assert } from './asserts';
import { pagingReducer, type PagingState } from './paging-reducer';
import {
  useRows,
  type Anchor,
  type GetPageQuery,
  type GetSingleQuery,
} from './use-rows';

// Bigger pageSize = fewer serial round-trips during a long scroll; smaller
// pageSize = faster server-side materialization per query. Must stay even —
// the permalink branch splits each page in half. Hook 4 (prefetch one page
// ahead) gives ~2x effective buffer on top of this number.
const MIN_PAGE_SIZE = 500;
const NUM_ROWS_FOR_LOADING_SKELETON = 1;

/**
 * State object that captures the virtualizer's scroll position and
 * pagination state. Serialize via `useHistoryScrollState` (or equivalent) so
 * back/forward navigation restores scroll position and loaded pages.
 */
export type ScrollHistoryState<
  TStartRow,
  TListContextParams = unknown,
> = Readonly<{
  anchor: Anchor<TStartRow>;
  scrollTop: number;
  estimatedTotal: number;
  hasReachedStart: boolean;
  hasReachedEnd: boolean;
  listContextParams: TListContextParams;
}>;

const TOP_ANCHOR = Object.freeze({
  index: 0,
  kind: 'forward',
  startRow: undefined,
}) satisfies Anchor<unknown>;

// A row key is always a plain string/number/bigint — matching what
// @tanstack/virtual-core's own `getItemKey` accepts. Deliberately NOT React's
// `Key` type: React 19.2 widened it to include `typeof React.optimisticKey`
// (a reconciler-internal branded symbol never returned by real key
// extractors), which then fails to satisfy TanStack's narrower Key when
// passed through to `getItemKey` below.
type RowKey = number | string | bigint;

export type TanstackUseVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = Parameters<typeof useVirtualizer<TScrollElement, TItemElement>>[0];

export type UseSyncVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
  TListContextParams,
  TRow extends { id: string },
  TStartRow,
> = Omit<
  TanstackUseVirtualizerOptions<TScrollElement, TItemElement>,
  'count' | 'initialOffset' | 'horizontal'
> & {
  listContextParams: TListContextParams;
  permalinkID?: string | null | undefined;
  getPageQuery: GetPageQuery<TStartRow>;
  getSingleQuery: GetSingleQuery;
  /** ms the list must stay idle before queries receive `settled: true`. Default 2000. */
  settleTime?: number | undefined;
  toStartRow: (row: TRow) => TStartRow;
  getRowKey?: ((row: TRow) => RowKey) | undefined;
  scrollState?: ScrollHistoryState<TStartRow, TListContextParams> | null | undefined;
  onScrollStateChange?: (
    state: ScrollHistoryState<TStartRow, TListContextParams>,
  ) => void;
  onSettled?: (() => void) | undefined;
  /** When false, keep hook order but disable all backing sync queries. */
  enabled?: boolean | undefined;
};

const createPermalinkAnchor = (id: string) =>
  ({
    id,
    index: NUM_ROWS_FOR_LOADING_SKELETON,
    kind: 'permalink',
  }) as const;

export type SyncVirtualizerResult<
  TScrollElement extends Element,
  TItemElement extends Element,
  TRow extends { id: string },
> = {
  virtualizer: Virtualizer<TScrollElement, TItemElement>;
  rowAt: (index: number) => TRow | undefined;
  complete: boolean;
  rowsEmpty: boolean;
  permalinkNotFound: boolean;
  estimatedTotal: number;
  total: number | undefined;
  settled: boolean;
};

/**
 * Virtualized list with cursor-based pagination that works across **any**
 * sync transport that plugs into `useSyncQuery` — Zero's WebSocket subscriber
 * *and* our TanStack-Query-backed polling fallback both work here.
 *
 * Structurally this is zero-virtual's `useZeroVirtualizer` rewritten against
 * our transport-agnostic `useSyncQuery`. Features match the upstream:
 *
 *   - Bidirectional infinite scroll
 *   - Permalink (jump to row by id, load rows above + below)
 *   - History-state persistence (back/forward restores scroll + pages)
 *   - Dynamic page size derived from viewport × row-height estimate × 3
 *   - Settle-aware query options (short TTL while scrolling, longer when settled)
 *
 * Ported from https://github.com/rocicorp/zero-virtual (Apache-2.0).
 */
export function useSyncVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
  TListContextParams,
  TRow extends { id: string },
  TStartRow,
>({
  estimateSize,
  overscan = 5,
  getScrollElement,
  getItemKey = defaultKeyExtractor,

  listContextParams,
  permalinkID,
  getPageQuery,
  getSingleQuery,
  settleTime = 2000,
  toStartRow,
  getRowKey,

  scrollState,
  onScrollStateChange,

  onSettled,
  enabled = true,

  ...restVirtualizerOptions
}: UseSyncVirtualizerOptions<
  TScrollElement,
  TItemElement,
  TListContextParams,
  TRow,
  TStartRow
>): SyncVirtualizerResult<TScrollElement, TItemElement, TRow> {
  // Only restore from scrollState if listContextParams match; otherwise the
  // saved anchor/scroll position is stale and we want a clean reset.
  const effectiveScrollState = useMemo(() => {
    if (!scrollState) return null;
    if (
      JSON.stringify(scrollState.listContextParams) !==
      JSON.stringify(listContextParams)
    ) {
      return null;
    }
    return scrollState;
  }, [scrollState, listContextParams]);

  const [settled, setSettled] = useState(false);
  const awaitingScrollSettleRef = useRef(false);
  const scrollOffsetRef = useRef<number | undefined>(undefined);

  const resetSettleTimer = useCallback(() => {
    setSettled(false);
    const timer = setTimeout(() => {
      setSettled(true);
    }, settleTime);
    return () => clearTimeout(timer);
  }, [settleTime]);

  useEffect(() => {
    return resetSettleTimer();
  }, [resetSettleTimer, listContextParams]);

  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    if (settled) {
      onSettledRef.current?.();
    }
  }, [settled]);

  const [
    {
      estimatedTotal,
      hasReachedStart,
      hasReachedEnd,
      queryAnchor,
      pagingPhase,
      pendingScrollAdjustment,
    },
    dispatch,
  ] = useReducer(
    pagingReducer<TListContextParams, TStartRow>,
    undefined,
    (): PagingState<TListContextParams, TStartRow> => {
      const anchor = effectiveScrollState
        ? effectiveScrollState.anchor
        : permalinkID
          ? createPermalinkAnchor(permalinkID)
          : TOP_ANCHOR;
      return {
        estimatedTotal:
          effectiveScrollState?.estimatedTotal ?? NUM_ROWS_FOR_LOADING_SKELETON,
        hasReachedStart: effectiveScrollState?.hasReachedStart ?? false,
        hasReachedEnd: effectiveScrollState?.hasReachedEnd ?? false,
        queryAnchor: {
          anchor,
          listContextParams,
        },
        pagingPhase: 'idle',
        pendingScrollAdjustment: 0,
      };
    },
  );

  const isListContextCurrent = queryAnchor.listContextParams === listContextParams;

  const anchor = useMemo(() => {
    if (isListContextCurrent) {
      return queryAnchor.anchor;
    }
    return permalinkID ? createPermalinkAnchor(permalinkID) : TOP_ANCHOR;
  }, [isListContextCurrent, queryAnchor.anchor, permalinkID]);

  const [pageSize, setPageSize] = useState(MIN_PAGE_SIZE);

  const {
    rowAt,
    rowsLength,
    complete,
    rowsEmpty,
    atStart,
    atEnd,
    firstRowIndex,
    permalinkNotFound,
  } = useRows<TRow, TStartRow>({
    pageSize,
    anchor,
    settled,
    getPageQuery,
    getSingleQuery,
    toStartRow,
    enabled,
  });

  const newEstimatedTotal = firstRowIndex + rowsLength;

  const virtualizer: Virtualizer<TScrollElement, TItemElement> = useVirtualizer({
    ...restVirtualizerOptions,
    // Cap the virtualizer's count at what we can actually serve. The original
    // zero-virtual code uses `Math.max(estimatedTotal, newEstimatedTotal) + 1`,
    // which lets the scrollbar grow monotonically and lets the user scroll into
    // skeleton-row territory beyond what the cursor pagination has loaded.
    // For very fast scrolls that's catastrophic: the user blasts past the
    // anchor's reach, the anchor can only chase one page per round-trip, and
    // the entire viewport sits on shimmer rows for many seconds while the chain
    // of fetches catches up.
    //
    // Capping at `firstRowIndex + rowsLength + small buffer` instead means the
    // scrollbar represents the data we can render NOW. As the anchor advances,
    // the scrollbar grows. The user can scroll a buffer's worth past the
    // current page (which triggers the next fetch) but cannot outrun it.
    count:
      atEnd && atStart && complete
        ? rowsLength
        : newEstimatedTotal + (!atEnd && rowsLength > 0 ? NUM_ROWS_FOR_LOADING_SKELETON : 0),
    estimateSize,
    overscan,
    getScrollElement,
    getItemKey: getRowKey
      ? (index: number) => {
          const row = rowAt(index);
          return row ? getRowKey(row) : getItemKey(index);
        }
      : getItemKey,
    initialOffset: () => {
      if (effectiveScrollState?.scrollTop !== undefined) {
        return effectiveScrollState.scrollTop;
      }
      if (anchor.kind === 'permalink') {
        return anchor.index * estimateSize(0);
      }
      return 0;
    },
    horizontal: false,
  });

  // Reset settle timer on scroll.
  useEffect(() => {
    const offset = virtualizer.scrollOffset;
    const didScroll =
      scrollOffsetRef.current !== undefined &&
      offset !== scrollOffsetRef.current;
    scrollOffsetRef.current = offset ?? undefined;
    if (didScroll) {
      awaitingScrollSettleRef.current = false;
      return resetSettleTimer();
    }
    return undefined;
  }, [virtualizer.scrollOffset, resetSettleTimer]);

  const scrollToOffset = (targetOffset: number) => {
    const currentOffset = virtualizer.scrollOffset ?? 0;
    virtualizer.scrollToOffset(targetOffset);
    if (targetOffset !== currentOffset) {
      awaitingScrollSettleRef.current = true;
    }
  };

  const scrollToIndex = (
    ...args: Parameters<typeof virtualizer.scrollToIndex>
  ) => {
    virtualizer.scrollToIndex(...args);
    awaitingScrollSettleRef.current = true;
  };

  useEffect(() => {
    // Make sure page size is enough to fill the scroll element at least 3 times.
    const newPageSize = virtualizer.scrollRect
      ? Math.max(
          MIN_PAGE_SIZE,
          makeEven(
            Math.ceil(
              virtualizer.scrollRect.height / estimateSize(0),
            ) * 3,
          ),
        )
      : MIN_PAGE_SIZE;
    if (newPageSize > pageSize) {
      setPageSize(newPageSize);
    }
  }, [pageSize, virtualizer.scrollRect, estimateSize]);

  // Persist scroll state (debounced) so back/forward restores position.
  useEffect(() => {
    if (!isListContextCurrent || !onScrollStateChange) {
      return;
    }
    const timeoutId = setTimeout(() => {
      onScrollStateChange({
        anchor,
        scrollTop: virtualizer.scrollOffset ?? 0,
        estimatedTotal,
        hasReachedStart,
        hasReachedEnd,
        listContextParams,
      });
    }, 100);
    return () => clearTimeout(timeoutId);
  }, [
    anchor,
    virtualizer.scrollOffset,
    estimatedTotal,
    hasReachedStart,
    hasReachedEnd,
    isListContextCurrent,
    onScrollStateChange,
    listContextParams,
  ]);

  useEffect(() => {
    if (atStart) dispatch({ type: 'REACHED_START' });
  }, [atStart]);

  useEffect(() => {
    if (atEnd) dispatch({ type: 'REACHED_END' });
  }, [atEnd]);

  useEffect(() => {
    if (complete) {
      if (atStart && atEnd) {
        dispatch({ type: 'UPDATE_ESTIMATED_TOTAL', newTotal: rowsLength });
      } else if (newEstimatedTotal > estimatedTotal) {
        dispatch({
          type: 'UPDATE_ESTIMATED_TOTAL',
          newTotal: newEstimatedTotal,
        });
      }
    }
  }, [estimatedTotal, complete, atStart, atEnd, newEstimatedTotal, rowsLength]);

  // Apply pending scroll adjustment synchronously with layout to prevent jumps.
  useLayoutEffect(() => {
    if (pendingScrollAdjustment !== 0) {
      const targetOffset =
        (virtualizer.scrollOffset ?? 0) +
        pendingScrollAdjustment * estimateSize(0);
      scrollToOffset(targetOffset);
      dispatch({ type: 'SCROLL_ADJUSTED' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingScrollAdjustment, virtualizer]);

  useEffect(() => {
    if (rowsEmpty || !isListContextCurrent) return;

    if (pagingPhase === 'skipping' && pendingScrollAdjustment === 0) {
      dispatch({ type: 'PAGING_COMPLETE' });
      return;
    }

    if (pendingScrollAdjustment !== 0) return;

    // First row is before start of list - need to shift down
    if (firstRowIndex < 0) {
      const placeholderRows = !atStart ? NUM_ROWS_FOR_LOADING_SKELETON : 0;
      const offset = -firstRowIndex + placeholderRows;
      const newAnchor = { ...anchor, index: anchor.index + offset };
      dispatch({ type: 'SHIFT_ANCHOR_DOWN', offset, newAnchor });
      return;
    }

    if (atStart && firstRowIndex > 0) {
      dispatch({ type: 'RESET_TO_TOP', offset: -firstRowIndex });
      return;
    }
  }, [
    firstRowIndex,
    anchor,
    atStart,
    pendingScrollAdjustment,
    pagingPhase,
    rowsEmpty,
    isListContextCurrent,
  ]);

  const appliedScrollStateRef = useRef(effectiveScrollState);

  useLayoutEffect(() => {
    const scrollStateChanged =
      effectiveScrollState !== appliedScrollStateRef.current;
    appliedScrollStateRef.current = effectiveScrollState;

    if (!isListContextCurrent || scrollStateChanged) {
      if (effectiveScrollState) {
        scrollToOffset(effectiveScrollState.scrollTop);
        dispatch({
          type: 'RESET_STATE',
          estimatedTotal: effectiveScrollState.estimatedTotal,
          hasReachedStart: effectiveScrollState.hasReachedStart,
          hasReachedEnd: effectiveScrollState.hasReachedEnd,
          anchor: effectiveScrollState.anchor,
          listContextParams,
        });
      } else if (permalinkID) {
        // If the permalink item is already in virtual items, scroll there.
        const permalinkVirtualItem = getRowKey
          ? virtualizer.getVirtualItems().find((item) => {
              const row = rowAt(item.index);
              return row !== undefined && getRowKey(row) === permalinkID;
            })
          : undefined;

        if (permalinkVirtualItem) {
          scrollToIndex(permalinkVirtualItem.index, { align: 'auto' });
        } else {
          const targetOffset = NUM_ROWS_FOR_LOADING_SKELETON * estimateSize(0);
          scrollToOffset(targetOffset);
          dispatch({
            type: 'RESET_STATE',
            estimatedTotal: NUM_ROWS_FOR_LOADING_SKELETON,
            hasReachedStart: false,
            hasReachedEnd: false,
            anchor: createPermalinkAnchor(permalinkID),
            listContextParams,
          });
        }
      } else {
        scrollToOffset(0);
        dispatch({
          type: 'RESET_STATE',
          estimatedTotal: 0,
          hasReachedStart: true,
          hasReachedEnd: false,
          anchor: TOP_ANCHOR,
          listContextParams,
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isListContextCurrent,
    effectiveScrollState,
    permalinkID,
    virtualizer,
    listContextParams,
  ]);

  const total =
    atStart && atEnd
      ? rowsLength
      : hasReachedStart && hasReachedEnd
        ? estimatedTotal
        : undefined;

  const virtualItems = virtualizer.getVirtualItems();

  // Anchor-shift effect: when the user scrolls near either edge of the current
  // page, shift the anchor so the next batch of rows can load.
  useEffect(() => {
    if (
      !isListContextCurrent ||
      virtualItems.length === 0 ||
      !complete ||
      pagingPhase !== 'idle' ||
      pendingScrollAdjustment !== 0
    ) {
      return;
    }

    if (awaitingScrollSettleRef.current) return;

    if (atStart) {
      if (firstRowIndex !== 0) {
        dispatch({ type: 'UPDATE_ANCHOR', anchor: TOP_ANCHOR });
        return;
      }
    }

    const updateAnchorForEdge = (
      targetIndex: number,
      type: 'forward' | 'backward',
      indexOffset: number,
    ) => {
      const index = toBoundIndex(targetIndex, firstRowIndex, rowsLength);
      const startRow = rowAt(index);
      assert(startRow !== undefined || type === 'forward');
      dispatch({
        type: 'UPDATE_ANCHOR',
        anchor: {
          index: index + indexOffset,
          kind: type,
          startRow,
        } as Anchor<TStartRow>,
      });
    };

    const firstItem = virtualItems[0];
    const lastItem = virtualItems[virtualItems.length - 1];
    const nearPageEdgeThreshold = getNearPageEdgeThreshold(pageSize);

    const distanceFromStart = firstItem.index - firstRowIndex;
    const distanceFromEnd = firstRowIndex + rowsLength - lastItem.index;

    if (!atStart && distanceFromStart <= nearPageEdgeThreshold) {
      updateAnchorForEdge(
        lastItem.index + 2 * nearPageEdgeThreshold,
        'backward',
        0,
      );
      return;
    }

    if (!atEnd && distanceFromEnd <= nearPageEdgeThreshold) {
      updateAnchorForEdge(
        firstItem.index - 2 * nearPageEdgeThreshold,
        'forward',
        1,
      );
      return;
    }
  }, [
    isListContextCurrent,
    virtualItems,
    pagingPhase,
    pendingScrollAdjustment,
    complete,
    pageSize,
    firstRowIndex,
    rowsLength,
    atStart,
    atEnd,
    rowAt,
  ]);

  return {
    virtualizer,
    rowAt,
    complete,
    rowsEmpty,
    permalinkNotFound,
    estimatedTotal,
    total,
    settled,
  };
}

function toBoundIndex(
  targetIndex: number,
  firstRowIndex: number,
  rowsLength: number,
): number {
  if (rowsLength === 0) return firstRowIndex;
  return Math.max(
    firstRowIndex,
    Math.min(firstRowIndex + rowsLength - 1, targetIndex),
  );
}

function getNearPageEdgeThreshold(pageSize: number) {
  // Trigger the anchor shift while the user is still ~25% of the page away
  // from the loaded edge, so the next page's fetch (and prefetch) have plenty
  // of time to arrive before the user's scroll actually reaches unrendered
  // territory. At pageSize=1000 that's 250 rows ≈ 15 000 px of warning —
  // enough that even an aggressive fling settles before hitting skeletons.
  return Math.ceil(pageSize / 4);
}

function makeEven(n: number) {
  return n % 2 === 0 ? n : n + 1;
}
