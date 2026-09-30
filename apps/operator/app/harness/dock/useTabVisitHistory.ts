/**
 * useTabVisitHistory — dock-level back/forward tracking which panels
 * (tabs) the user has focused.
 *
 * Spec: apps/operator/docs/dockview-migration-plan-v4.md §16
 *
 * Distinct from `useNavHistory` (per-panel internal-route history).
 * This hook lives in dock chrome and walks the visit order across all
 * panels in the dock. Tab-visit history is session-only — reload
 * starts fresh.
 *
 * Implementation note: module-singleton store so multiple consumers
 * (DockNavChevrons + useNavShortcuts) share state. The store
 * subscribes to dockview events once via onDockApiBind.
 */

'use client';

import { useEffect, useState } from 'react';
import { onDockApiBind } from './dock-actions';
import type { DockviewApi } from 'dockview';

const CAPACITY = 50;

interface State {
  stack: string[];
  cursor: number;
}

let state: State = { stack: [], cursor: -1 };
let apiRef: DockviewApi | null = null;
let bound = false;
let suppressNext = false;
const subs = new Set<() => void>();
const disposables: Array<{ dispose: () => void }> = [];

function notify(): void {
  for (const fn of subs) fn();
}

function set(next: State): void {
  state = next;
  notify();
}

function pushIfNew(id: string): void {
  if (state.stack[state.cursor] === id) return;
  const truncated = state.stack.slice(0, state.cursor + 1);
  truncated.push(id);
  let cursor = truncated.length - 1;
  let stack = truncated;
  if (stack.length > CAPACITY) {
    const drop = stack.length - CAPACITY;
    stack = stack.slice(drop);
    cursor -= drop;
  }
  set({ stack, cursor });
}

function removePanelId(id: string): void {
  const removedBeforeCursor = state.stack
    .slice(0, state.cursor)
    .filter((x) => x === id).length;
  const stack = state.stack.filter((x) => x !== id);
  let cursor = state.cursor - removedBeforeCursor;
  if (cursor >= stack.length) cursor = stack.length - 1;
  if (cursor < -1) cursor = -1;
  set({ stack, cursor });
}

function ensureBound(): void {
  if (bound) return;
  bound = true;
  onDockApiBind((api) => {
    // Tear down old listeners.
    for (const d of disposables.splice(0)) d.dispose();
    apiRef = api;
    if (!api) {
      set({ stack: [], cursor: -1 });
      return;
    }
    // Seed with active panel.
    const initialId = api.activeGroup?.activePanel?.id;
    set(initialId ? { stack: [initialId], cursor: 0 } : { stack: [], cursor: -1 });
    disposables.push(
      api.onDidActivePanelChange((panel) => {
        const id = panel?.id;
        if (!id) return;
        if (suppressNext) {
          suppressNext = false;
          return;
        }
        pushIfNew(id);
      }),
      api.onDidRemovePanel((panel) => removePanelId(panel.id)),
    );
  });
}

export interface TabVisitHistory {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

function back(): void {
  if (state.cursor <= 0) return;
  const nextCursor = state.cursor - 1;
  const targetId = state.stack[nextCursor];
  const api = apiRef;
  if (api && targetId) {
    const panel = api.getPanel(targetId);
    if (panel) {
      suppressNext = true;
      panel.api.setActive();
    }
  }
  set({ ...state, cursor: nextCursor });
}

function forward(): void {
  if (state.cursor < 0 || state.cursor >= state.stack.length - 1) return;
  const nextCursor = state.cursor + 1;
  const targetId = state.stack[nextCursor];
  const api = apiRef;
  if (api && targetId) {
    const panel = api.getPanel(targetId);
    if (panel) {
      suppressNext = true;
      panel.api.setActive();
    }
  }
  set({ ...state, cursor: nextCursor });
}

/** Synchronous accessor for keyboard handlers + non-React callers. */
export function getTabVisitHistorySync(): TabVisitHistory {
  return {
    canBack: state.cursor > 0,
    canForward: state.cursor >= 0 && state.cursor < state.stack.length - 1,
    back,
    forward,
  };
}

export function useTabVisitHistory(): TabVisitHistory {
  // Bind on first call. Idempotent.
  useEffect(() => {
    ensureBound();
  }, []);
  // Force re-render when store changes.
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  }, []);
  return getTabVisitHistorySync();
}

/** For tests — reset module state. */
export function _resetTabVisitHistoryForTests(): void {
  for (const d of disposables.splice(0)) d.dispose();
  state = { stack: [], cursor: -1 };
  apiRef = null;
  bound = false;
  suppressNext = false;
  subs.clear();
}

/** For tests — drive state directly. */
export const _testHooks = {
  pushIfNew: (id: string) => pushIfNew(id),
  removePanelId,
  getState: () => state,
};
