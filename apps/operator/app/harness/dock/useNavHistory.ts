/**
 * useNavHistory — per-panel browser-style back/forward navigation.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §6
 *
 * Each panel opts in by calling useNavHistory(initial). The hook stores
 * a history stack + cursor in `params.history` so it survives layout
 * save/restore. Panels that don't opt in render no chevrons.
 *
 *   const nav = useNavHistory<{ doc: string }>(
 *     { doc: 'getting-started' },
 *     { params, setParams, capacity: 50 },
 *   );
 *   // nav.current, nav.push(route), nav.back(), nav.forward()
 *
 * History entries are panel-internal route descriptors (the panel's own
 * component interprets them). The hook only manages the stack/cursor.
 *
 * "Open in new panel" creates a fresh panel with its own (empty or
 * single-entry) history — does NOT push on the originating panel.
 */

import { useCallback, useMemo } from 'react';

export interface NavHistoryStorage {
  /** Current params from the dock layout (carries `history` and `current`). */
  params: Record<string, unknown>;
  /** Setter that merges into the panel's params in the layout. */
  setParams: (next: Record<string, unknown>) => void;
  /** Max entries kept. Older drop FIFO when exceeded. Default 50. */
  capacity?: number;
}

export interface NavHistory<T> {
  /** Current route (top of cursor). Falls back to `initial` if uninitialized. */
  current: T;
  /** Whether back() would move. */
  canBack: boolean;
  /** Whether forward() would move. */
  canForward: boolean;
  /** Move cursor back one. No-op if !canBack. */
  back: () => void;
  /** Move cursor forward one. No-op if !canForward. */
  forward: () => void;
  /**
   * Push a new entry. If cursor is not at the end (user went back, then
   * navigated), the forward tail is discarded — browser semantics.
   */
  push: (route: T) => void;
  /** Replace the current entry without growing history. */
  replace: (route: T) => void;
  /** Wipe history; current becomes `route`. */
  reset: (route: T) => void;
}

interface StoredHistory<T> {
  stack: T[];
  cursor: number;
}

const DEFAULT_CAPACITY = 50;

function readHistory<T>(params: Record<string, unknown>, initial: T): StoredHistory<T> {
  const raw = (params as { history?: unknown }).history;
  if (
    raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as { stack?: unknown }).stack) &&
    typeof (raw as { cursor?: unknown }).cursor === 'number'
  ) {
    const h = raw as StoredHistory<T>;
    if (h.stack.length === 0) {
      return { stack: [initial], cursor: 0 };
    }
    const cursor = Math.max(0, Math.min(h.cursor, h.stack.length - 1));
    return { stack: h.stack, cursor };
  }
  return { stack: [initial], cursor: 0 };
}

export function useNavHistory<T>(
  initial: T,
  storage: NavHistoryStorage,
): NavHistory<T> {
  const capacity = storage.capacity ?? DEFAULT_CAPACITY;
  const history = useMemo(() => readHistory(storage.params, initial), [storage.params, initial]);

  const current = history.stack[history.cursor];
  const canBack = history.cursor > 0;
  const canForward = history.cursor < history.stack.length - 1;

  const commit = useCallback(
    (next: StoredHistory<T>) => {
      // Defensive clone — never mutate the previous stack reference.
      storage.setParams({ history: { stack: next.stack.slice(), cursor: next.cursor } });
    },
    [storage],
  );

  const back = useCallback(() => {
    if (!canBack) return;
    commit({ stack: history.stack, cursor: history.cursor - 1 });
  }, [canBack, commit, history.cursor, history.stack]);

  const forward = useCallback(() => {
    if (!canForward) return;
    commit({ stack: history.stack, cursor: history.cursor + 1 });
  }, [canForward, commit, history.cursor, history.stack]);

  const push = useCallback(
    (route: T) => {
      // Truncate forward tail (browser semantics).
      const truncated = history.stack.slice(0, history.cursor + 1);
      truncated.push(route);
      // Enforce capacity: drop oldest entries, adjust cursor.
      let cursor = truncated.length - 1;
      let stack = truncated;
      if (stack.length > capacity) {
        const drop = stack.length - capacity;
        stack = stack.slice(drop);
        cursor -= drop;
      }
      commit({ stack, cursor });
    },
    [capacity, commit, history.cursor, history.stack],
  );

  const replace = useCallback(
    (route: T) => {
      const stack = history.stack.slice();
      stack[history.cursor] = route;
      commit({ stack, cursor: history.cursor });
    },
    [commit, history.cursor, history.stack],
  );

  const reset = useCallback(
    (route: T) => {
      commit({ stack: [route], cursor: 0 });
    },
    [commit],
  );

  return { current, canBack, canForward, back, forward, push, replace, reset };
}
