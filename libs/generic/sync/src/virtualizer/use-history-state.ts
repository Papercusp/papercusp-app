'use client';

import { useSyncExternalStore } from 'react';

/**
 * React hook providing access to `window.history.state`.
 *
 * Uses `history.replaceState` for writes and `popstate` for cross-tab/native
 * navigation events. We deliberately avoid the Navigation API (which exists
 * on Chromium but keeps its state in a DIFFERENT store from `history.state`
 * in practice — writes via `navigation.updateCurrentEntry` do not always
 * propagate to `history.state`, breaking cross-framework persistence).
 *
 * Returns `[state, setState]` where setState merges/replaces the current
 * entry's state without triggering a navigation.
 */
export function useHistoryState(): [
  state: unknown,
  setState: (state: unknown) => void,
] {
  const state = useSyncExternalStore(
    subscribeState,
    getSnapshot,
    getServerSnapshot,
  );
  return [state, updateCurrentEntryState];
}

let currentSnapshot: unknown = null;
let currentSnapshotString = 'null';

function getSnapshot(): unknown {
  if (typeof window === 'undefined') return null;
  const newSnapshot = window.history.state;
  const newSnapshotString = JSON.stringify(newSnapshot);
  if (newSnapshotString !== currentSnapshotString) {
    currentSnapshot = newSnapshot;
    currentSnapshotString = newSnapshotString;
  }
  return currentSnapshot;
}

function getServerSnapshot() {
  return null;
}

function updateCurrentEntryState(state: unknown) {
  if (typeof window === 'undefined') return;
  window.history.replaceState(state, '', window.location.href);
  // Notify subscribers — popstate doesn't fire on replaceState, so we dispatch
  // a synthetic event that our subscribe handler listens for.
  window.dispatchEvent(new Event('historystatechange'));
}

function subscribeState(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener('historystatechange', onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener('historystatechange', onStoreChange);
  };
}
