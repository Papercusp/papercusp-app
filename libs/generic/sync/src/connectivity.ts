'use client';

/**
 * Sync connectivity store — "can this page reach its data origin right now?"
 *
 * The transport adapters already see every outcome that matters: an SSE
 * stream opening, a reconnect attempt failing, a REST batch fetch throwing.
 * This module folds those reports into one boolean an app shell can render
 * as an offline banner (the gap behind EI-239: the operator died and the UI
 * looked healthy-but-empty with every action silently failing).
 *
 * Semantics:
 * - Only NETWORK-LEVEL failures count toward offline (fetch/stream could not
 *   connect). An HTTP error response proves the origin is reachable — a 500
 *   is a server bug, not connectivity loss — so adapters report it as
 *   reachable.
 * - Offline flips on after `OFFLINE_AFTER_CONSECUTIVE` consecutive
 *   unreachable reports (a single blip that recovers on the next attempt
 *   never shows the banner) and clears on the first reachable report.
 *
 * Same module-scope listener-registry idiom as `bus-tap.ts`: one store, many
 * subscribers, render-only state.
 */

import { useSyncExternalStore } from 'react';

export interface SyncConnectivity {
  offline: boolean;
  /** Epoch ms when the current offline stretch started; 0 while online. */
  offlineSinceMs: number;
}

const OFFLINE_AFTER_CONSECUTIVE = 2;

const ONLINE: SyncConnectivity = { offline: false, offlineSinceMs: 0 };

let consecutiveFailures = 0;
let state: SyncConnectivity = ONLINE;
const listeners = new Set<() => void>();

function setState(next: SyncConnectivity): void {
  state = next;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a throwing subscriber never blocks the store */
    }
  }
}

/**
 * Transport-side: a network-level failure — fetch threw, or the stream's
 * reconnect attempts are failing. HTTP error responses do NOT belong here.
 */
export function reportSyncUnreachable(): void {
  consecutiveFailures += 1;
  if (!state.offline && consecutiveFailures >= OFFLINE_AFTER_CONSECUTIVE) {
    setState({ offline: true, offlineSinceMs: Date.now() });
  }
}

/**
 * Transport-side: any proof the origin answered — a stream opened, or a
 * fetch resolved to ANY HTTP response (including error statuses).
 */
export function reportSyncReachable(): void {
  consecutiveFailures = 0;
  if (state.offline) setState(ONLINE);
}

export function getSyncConnectivity(): SyncConnectivity {
  return state;
}

/** Subscribe to connectivity flips. Returns an unsubscribe function. */
export function onSyncConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** React hook — re-renders on offline/online flips. SSR snapshot is online. */
export function useSyncConnectivity(): SyncConnectivity {
  return useSyncExternalStore(onSyncConnectivity, getSyncConnectivity, () => ONLINE);
}

/** Test seam — clears failures, listeners stay registered. */
export function _resetSyncConnectivityForTests(): void {
  consecutiveFailures = 0;
  state = ONLINE;
}

/**
 * Stale-operator store (WI-5956) — "is this client's build newer than the
 * server it's talking to?" A DIFFERENT failure mode from connectivity above:
 * the origin is fully reachable and answers every request, but a query the
 * client's (freshly-rebuilt) code knows about doesn't exist yet in the
 * (long-lived, unrestarted) server process — the desktop dev operator's
 * defect this file exists for. The server already signals this precisely
 * (`rest-query`'s `unknown queryName: <name>` 400) — this store is the
 * missing consumer: it turns that per-query 400 into an app-wide, persistent
 * "restart your operator" signal instead of one silently-broken panel.
 *
 * Unlike connectivity, this NEVER auto-clears on its own — a version skew
 * doesn't self-heal by retrying (the server process is what's stale, not the
 * request), so the only real fix is an operator restart. `_resetSyncStale...`
 * exists for tests only.
 */
export interface SyncStaleOperator {
  stale: boolean;
  /** Every distinct queryName that has 404'd as unknown so far (small set in
   *  practice — one per resolver added since the operator last restarted). */
  queryNames: string[];
}

const NOT_STALE: SyncStaleOperator = { stale: false, queryNames: [] };

let staleState: SyncStaleOperator = NOT_STALE;
const staleListeners = new Set<() => void>();

function setStaleState(next: SyncStaleOperator): void {
  staleState = next;
  for (const fn of staleListeners) {
    try {
      fn();
    } catch {
      /* a throwing subscriber never blocks the store */
    }
  }
}

/**
 * Transport-side: a query failed with the server's `unknown queryName: X`
 * shape — proof this client's code is newer than the server it's talking to.
 * Idempotent per queryName (a flapping panel that keeps re-requesting the
 * same missing query notifies subscribers once, not on every retry).
 */
export function reportSyncStaleOperator(queryName: string): void {
  if (staleState.queryNames.includes(queryName)) return;
  setStaleState({ stale: true, queryNames: [...staleState.queryNames, queryName] });
}

export function getSyncStaleOperator(): SyncStaleOperator {
  return staleState;
}

/** Subscribe to stale-operator flips. Returns an unsubscribe function. */
export function onSyncStaleOperator(fn: () => void): () => void {
  staleListeners.add(fn);
  return () => {
    staleListeners.delete(fn);
  };
}

/** React hook — re-renders when a new unknown-queryName is reported. SSR snapshot is not-stale. */
export function useSyncStaleOperator(): SyncStaleOperator {
  return useSyncExternalStore(onSyncStaleOperator, getSyncStaleOperator, () => NOT_STALE);
}

/** Test seam. */
export function _resetSyncStaleOperatorForTests(): void {
  staleState = NOT_STALE;
}
