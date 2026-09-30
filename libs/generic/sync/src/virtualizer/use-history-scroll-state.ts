'use client';

import { useCallback, useMemo } from 'react';
import { useHistoryState } from './use-history-state';
import type { ScrollHistoryState } from './use-sync-virtualizer';

const DEFAULT_KEY = 'scrollState';

/**
 * Hook that persists virtualizer scroll state in `window.history.state`,
 * so back/forward navigation restores scroll position and pagination state.
 *
 * Pass a custom `key` to scope the state when multiple virtualizers share a page.
 *
 * @example
 * ```tsx
 * const [scrollState, setScrollState] = useHistoryScrollState<MyStartRow>();
 *
 * const {virtualizer, rowAt} = useSyncVirtualizer({
 *   scrollState,
 *   onScrollStateChange: setScrollState,
 *   // ...
 * });
 * ```
 *
 * Ported from https://github.com/rocicorp/zero-virtual (Apache-2.0).
 */
export function useHistoryScrollState<TStartRow, TListContextParams = unknown>(
  key: string = DEFAULT_KEY,
): [
  ScrollHistoryState<TStartRow, TListContextParams> | null,
  (state: ScrollHistoryState<TStartRow, TListContextParams> | null) => void,
] {
  const [state, setState] = useHistoryState();

  const scrollState: ScrollHistoryState<TStartRow, TListContextParams> | null = useMemo(() => {
    if (!state) return null;
    return (state as Record<string, unknown>)[
      key
    ] as ScrollHistoryState<TStartRow, TListContextParams> | null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state && JSON.stringify((state as Record<string, unknown>)[key])]);

  const setScrollState = useCallback(
    (newState: ScrollHistoryState<TStartRow, TListContextParams> | null) => {
      setState({
        ...(state ?? {}),
        [key]: newState,
      });
    },
    [state, key, setState],
  );

  return [scrollState, setScrollState];
}
