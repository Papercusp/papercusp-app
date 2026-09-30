/**
 * Sync-bus tap — a domain-free listener registry for the raw push events the
 * sync transport receives (`invalidate` / `update`, payload `{ name, args,
 * data? }`).
 *
 * Why this exists: app-level consumers (e.g. an attention notifier) used to
 * open their OWN EventSource against the same SSE route the sync transport
 * already holds. In the browser (HTTP/1.1) every standing stream costs one of
 * Chromium's ~6 per-host sockets, and the duplicate pushed the app to the
 * limit — starving ordinary fetches (route loaders queued forever). One
 * transport connection, many listeners.
 *
 * The transport adapters call `emitSyncBusEvent` for every well-formed push
 * event; consumers subscribe with `onSyncBusEvent` and filter by `name`.
 * Listeners are isolated — one throwing listener never blocks the others or
 * the cache wiring.
 */

import { pinModuleState } from '@papercusp/module-singleton';

export interface SyncBusEvent {
  name: string;
  args?: unknown;
  data?: unknown[];
  /** Server event commit timestamp, preserved from the SSE `tsMs` payload. */
  tsMs?: number;
  /** Client-local correlation id for freshness stage telemetry. */
  traceId?: string;
  /** Client epoch timestamp at which the push callback received the event. */
  receivedAtMs?: number;
}

type SyncBusListener = (ev: SyncBusEvent) => void;

interface SyncBusState {
  listeners: Set<SyncBusListener>;
}

// A module-local Set is not a page-wide bus. The packaged desktop can evaluate
// this module twice when the sync transport reaches it by a relative import
// while an app bridge reaches it through the package export. In that shape the
// SSE adapter emits into one Set and DesktopConsoleLaunchBridge subscribes to a
// different Set: the stream stays healthy, but the bridge sees zero events.
//
// Keep the original realm key, but register it through the shared primitive so
// duplicate evaluations remain observable through listModuleDuplications().
// One pinned object holds all mutable state owned by this module.
const state = pinModuleState<SyncBusState>('papercusp.sync.bus-tap.listeners', () => ({
  listeners: new Set<SyncBusListener>(),
}));

function listeners(): Set<SyncBusListener> {
  return state.listeners;
}

/** Subscribe to every sync push event. Returns an unsubscribe function. */
export function onSyncBusEvent(fn: SyncBusListener): () => void {
  const registry = listeners();
  registry.add(fn);
  return () => {
    registry.delete(fn);
  };
}

/** Transport-side: fan a push event out to all listeners (error-isolated). */
export function emitSyncBusEvent(ev: SyncBusEvent): void {
  for (const fn of listeners()) {
    try {
      fn(ev);
    } catch {
      /* listener errors never block the bus or the cache wiring */
    }
  }
}
