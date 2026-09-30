// Client-side flag reader. NO PostHog import — never. This module is
// safe to bundle in browser / Tauri webview / mobile clients.
//
// Source of truth is the Papercusp backend's /api/flags/bootstrap endpoint.
// SSR pages may inject the initial payload via window.__PAPERCUSP_FLAGS__.
// Live updates arrive on /api/flags/stream (SSE).

import { useSyncExternalStore } from "react";
import {
  createResilientEventSource,
  type ResilientEventSourceStatus,
} from "@papercusp/sse";
import {
  FLAG_DEFAULTS,
  type FlagKey,
  type FlagPayload,
  type FlagValues,
  resolveWithDefaults,
} from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __PAPERCUSP_FLAGS__: FlagPayload | undefined;
}

type Listener = (flags: FlagValues) => void;

let current: FlagPayload = readInitialPayload();
const listeners = new Set<Listener>();

function readInitialPayload(): FlagPayload {
  if (typeof globalThis !== "undefined" && globalThis.__PAPERCUSP_FLAGS__) {
    const seed = globalThis.__PAPERCUSP_FLAGS__;
    return {
      flags: resolveWithDefaults(seed.flags),
      evaluatedAt: seed.evaluatedAt,
      source: seed.source,
    };
  }
  return {
    flags: { ...FLAG_DEFAULTS },
    evaluatedAt: 0,
    source: "defaults",
  };
}

/**
 * EI-2425 fix A: a REACTIVE flag read. Before this, `useFlag` was a plain
 * function reading the module-level `current` snapshot — it read the value
 * once at render time but never re-rendered a consumer when `setFlagPayload`
 * later updated `current` (a flag flip via flags:set, or an SSE
 * `flag_changed` push once fix B wires the stream). `useSyncExternalStore`
 * over the existing `subscribe`/`current` primitives makes every `useFlag`
 * consumer re-render the instant the flag changes, with no extra wiring per
 * call site. `getServerSnapshot` falls back to FLAG_DEFAULTS — matches
 * `readInitialPayload`'s own no-window fallback, so an SSR/non-browser
 * evaluation never throws for lack of `subscribe`.
 */
export function useFlag(key: FlagKey): boolean {
  return useSyncExternalStore(
    (onStoreChange) => subscribe(() => onStoreChange()),
    () => current.flags[key] ?? FLAG_DEFAULTS[key],
    () => FLAG_DEFAULTS[key],
  );
}

export function getFlagSnapshot(): FlagPayload {
  return current;
}

export async function loadFlags(
  endpoint = "/api/flags/bootstrap",
): Promise<FlagPayload> {
  const res = await fetch(endpoint, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`loadFlags: HTTP ${res.status}`);
  const data = (await res.json()) as FlagPayload;
  setFlagPayload(data);
  return current;
}

export function setFlagPayload(payload: FlagPayload): void {
  current = {
    flags: resolveWithDefaults(payload.flags),
    evaluatedAt: payload.evaluatedAt,
    source: payload.source,
  };
  for (const l of listeners) l(current.flags);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type StreamSubscription = { close(): void };

export interface SubscribeToFlagStreamHooks {
  /** Called when the flag stream proves the origin reachable (SSE opened). */
  onOpen?: () => void;
  /**
   * Called on every resilient-event-source status change, including
   * transient reconnect blips ('failing'). App-level callers use this to
   * feed a shared connectivity signal — kept optional/pass-through so this
   * package stays framework- and app-agnostic.
   */
  onStatusChange?: (status: ResilientEventSourceStatus) => void;
}

/**
 * One shared flag stream per endpoint, ref-counted across callers.
 *
 * WHY (owner incident 2026-07-26/27 — "gym runs never show up"): this function
 * used to open a NEW EventSource per call, and the operator has two independent
 * callers — `FlagStreamSubscriber` (mounted app-wide) and `flag-hooks`' module
 * subscription — so every page held TWO identical `/api/flags/stream` sockets.
 * A browser engine allows only ~6 connections per host and a standing stream
 * holds one for life; the page was measured at 7 standing streams, leaving ZERO
 * slots, so every REST fetch queued forever and data panes sat on "Loading…".
 * Callers are independent by design (neither should have to know about the
 * other), so the dedupe belongs HERE: identical endpoint ⇒ one socket, with each
 * caller's hooks fanned out and the socket released when the last one closes.
 */
const sharedFlagStreams = new Map<
  string,
  { source: StreamSubscription; hooks: Set<SubscribeToFlagStreamHooks> }
>();

/** Test seam — drop shared stream state between cases. */
export function _resetFlagStreamSharing(): void {
  for (const entry of sharedFlagStreams.values()) entry.source.close();
  sharedFlagStreams.clear();
}

export function subscribeToFlagStream(
  endpoint = "/api/flags/stream",
  hooks?: SubscribeToFlagStreamHooks,
): StreamSubscription {
  if (typeof EventSource === "undefined") {
    return { close: () => {} };
  }
  // Fresh identity per call so two callers passing the SAME hooks object (or
  // none) still count as two subscribers.
  const myHooks: SubscribeToFlagStreamHooks = {
    onOpen: hooks?.onOpen,
    onStatusChange: hooks?.onStatusChange,
  };
  let entry = sharedFlagStreams.get(endpoint);
  if (!entry) {
    const hookSet = new Set<SubscribeToFlagStreamHooks>();
    const source = createResilientEventSource({
      url: endpoint,
      withCredentials: true,
      // Fan out to every live subscriber. Read the set at call time so a
      // subscriber that joins after the stream opened still gets its updates.
      onOpen: () => {
        for (const h of [...hookSet]) h.onOpen?.();
      },
      onStatusChange: (status) => {
        for (const h of [...hookSet]) h.onStatusChange?.(status);
      },
      handlers: {
        flag_changed: () => {
          void loadFlags().catch(() => {
            // network errors are non-fatal; we keep using the cached payload
          });
        },
        flags_payload: (data) => {
          try {
            const payload = JSON.parse(data) as FlagPayload;
            setFlagPayload(payload);
          } catch {
            // ignore malformed events
          }
        },
      },
    });
    entry = { source: { close: () => source.close() }, hooks: hookSet };
    sharedFlagStreams.set(endpoint, entry);
  }
  entry.hooks.add(myHooks);
  let closed = false;
  return {
    close: () => {
      if (closed) return; // idempotent — a double close must not free a peer's socket
      closed = true;
      const live = sharedFlagStreams.get(endpoint);
      if (!live) return;
      live.hooks.delete(myHooks);
      if (live.hooks.size === 0) {
        live.source.close();
        sharedFlagStreams.delete(endpoint);
      }
    },
  };
}
