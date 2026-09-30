// Ported from https://github.com/rocicorp/zero-virtual (Apache-2.0).
// Transport-agnostic: used by useSyncVirtualizer regardless of WS vs polling.

import type { Anchor } from './use-rows';

export type QueryAnchor<TListContextParams, TStartRow> = {
  readonly anchor: Anchor<TStartRow>;
  /**
   * Associates an anchor with list query params to coordinate state during
   * navigation. When list context params change (e.g., filter/sort changes or
   * browser back/forward navigation), the anchor and scroll position must be
   * updated atomically with the new query results.
   */
  readonly listContextParams: TListContextParams;
};

export type PagingState<TListContextParams, TStartRow> = {
  estimatedTotal: number;
  hasReachedStart: boolean;
  hasReachedEnd: boolean;
  queryAnchor: QueryAnchor<TListContextParams, TStartRow>;
  pagingPhase: 'idle' | 'adjusting' | 'skipping';
  pendingScrollAdjustment: number;
};

export type PagingAction<TListContextParams, TStartRow> =
  | { type: 'UPDATE_ESTIMATED_TOTAL'; newTotal: number }
  | { type: 'REACHED_START' }
  | { type: 'REACHED_END' }
  | { type: 'UPDATE_ANCHOR'; anchor: Anchor<TStartRow> }
  | {
      type: 'SHIFT_ANCHOR_DOWN';
      offset: number;
      newAnchor: Anchor<TStartRow>;
    }
  | { type: 'RESET_TO_TOP'; offset: number }
  | { type: 'SCROLL_ADJUSTED' }
  | { type: 'PAGING_COMPLETE' }
  | {
      type: 'RESET_STATE';
      estimatedTotal: number;
      hasReachedStart: boolean;
      hasReachedEnd: boolean;
      anchor: Anchor<TStartRow>;
      listContextParams: TListContextParams;
    };

export function pagingReducer<TListContextParams, TStartRow>(
  state: PagingState<TListContextParams, TStartRow>,
  action: PagingAction<TListContextParams, TStartRow>,
): PagingState<TListContextParams, TStartRow> {
  switch (action.type) {
    case 'UPDATE_ESTIMATED_TOTAL': {
      const newTotal = Math.max(state.estimatedTotal, action.newTotal);
      if (newTotal === state.estimatedTotal) {
        return state;
      }
      return {
        ...state,
        estimatedTotal: newTotal,
      };
    }

    case 'REACHED_START':
      return { ...state, hasReachedStart: true };

    case 'REACHED_END':
      return { ...state, hasReachedEnd: true };

    case 'UPDATE_ANCHOR':
      return {
        ...state,
        queryAnchor: {
          ...state.queryAnchor,
          anchor: action.anchor,
        },
      };

    case 'SHIFT_ANCHOR_DOWN':
      return {
        ...state,
        queryAnchor: {
          ...state.queryAnchor,
          anchor: action.newAnchor,
        },
        pendingScrollAdjustment: action.offset,
        pagingPhase: 'adjusting',
      };

    case 'RESET_TO_TOP':
      return {
        ...state,
        queryAnchor: {
          ...state.queryAnchor,
          anchor: { index: 0, kind: 'forward', startRow: undefined },
        },
        pendingScrollAdjustment: action.offset,
        pagingPhase: 'adjusting',
      };

    case 'SCROLL_ADJUSTED':
      return {
        ...state,
        estimatedTotal: state.estimatedTotal + state.pendingScrollAdjustment,
        pendingScrollAdjustment: 0,
        pagingPhase: 'skipping',
      };

    case 'PAGING_COMPLETE':
      return {
        ...state,
        pagingPhase: 'idle',
      };

    case 'RESET_STATE':
      return {
        ...state,
        estimatedTotal: action.estimatedTotal,
        hasReachedStart: action.hasReachedStart,
        hasReachedEnd: action.hasReachedEnd,
        queryAnchor: {
          listContextParams: action.listContextParams,
          anchor: action.anchor,
        },
        pagingPhase: 'skipping',
      };

    default: {
      action satisfies never;
      return state;
    }
  }
}
