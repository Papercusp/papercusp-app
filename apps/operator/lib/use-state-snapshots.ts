/**
 * useStateSnapshots — chat-surface hook that subscribes to
 * /api/operator/state-snapshot and tracks the union of open cards
 * across every active run in the workspace.
 *
 * Plan: bespoke-card-improvements-2026-05-13.md
 *
 * Returns an array of OpenCardSnapshot[] flattened across runs, with
 * the runId attached so /card-response posts can include workspace.
 * Cards disappear when a run's snapshot's openCards no longer
 * contains them (resolve / decline / cancel / run-end).
 *
 * Note: this hook does NOT itself render — it produces the data
 * stream. The renderer (OperatorChat, OracleDock) chooses how to
 * display the queue and which card to show first.
 */

'use client';

import { useEffect, useState, useMemo } from 'react';
import { createResilientEventSource } from '@papercusp/sse';
import { reportSyncReachable, reportSyncUnreachable } from '@papercusp/sync';

import type { OpenCardSnapshot, SnapshotDelta } from '@papercusp/agent-mcp';
import { reduceSnapshotEvent } from './snapshot-reducer';

export interface SnapshotEnvelope {
  runId: string;
  version: number;
  snapshot: {
    openCards: OpenCardSnapshot[];
    toolState?: unknown;
  };
}

export interface OpenCardWithRun extends OpenCardSnapshot {
  /** The runId that owns this card — needed for /card-response. */
  runId: string;
}

function isValidSnapshotEnvelope(data: unknown): data is SnapshotEnvelope {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<SnapshotEnvelope>;
  if (typeof d.runId !== 'string' || d.runId.length === 0) return false;
  if (typeof d.version !== 'number' || !Number.isFinite(d.version)) return false;
  if (!d.snapshot || typeof d.snapshot !== 'object') return false;
  if (!Array.isArray(d.snapshot.openCards)) return false;
  return true;
}

/** Minimal shape guard for a P-009 data-carrying delta (drops malformed deltas
 *  rather than letting a bad apply throw in the React render). */
function isValidSnapshotDelta(data: unknown): data is SnapshotDelta {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<SnapshotDelta>;
  return (
    typeof d.runId === 'string' &&
    d.runId.length > 0 &&
    typeof d.baseVersion === 'number' &&
    typeof d.version === 'number' &&
    Array.isArray(d.cards) &&
    Array.isArray(d.order)
  );
}

/**
 * ONE shared snapshot stream for the whole app, ref-counted across hook callers.
 *
 * WHY (owner incident 2026-07-26/27 — "gym runs never show up"): this hook used
 * to open its own EventSource per calling component, and two components call it
 * (`OperatorConversationProvider` and `PendingCardsBar`), so every page held TWO
 * identical `/api/operator/state-snapshot?delta=1` sockets. A browser engine
 * allows only ~6 connections per host and a standing stream holds one for life;
 * the page measured 7 standing streams — ZERO slots left — so every REST fetch
 * queued forever and data panes (the Gym tab among them) sat on "Loading…".
 *
 * The stream state lives here, module-scope, and the hook just mirrors it into
 * React state. Semantics are unchanged for callers: still "connected once open",
 * still the same reduced card map — but N callers now cost ONE socket, and the
 * socket is released when the last caller unmounts.
 */
type SnapshotStoreListener = () => void;

const snapshotStore: {
  byRun: Map<string, SnapshotEnvelope>;
  connected: boolean;
  listeners: Set<SnapshotStoreListener>;
  refs: number;
  source: { close: () => void } | null;
} = { byRun: new Map(), connected: false, listeners: new Set(), refs: 0, source: null };

function emitSnapshotStore(): void {
  for (const l of [...snapshotStore.listeners]) l();
}

/** Apply a stream event to the shared map, then notify subscribers. */
function applySnapshotEvent(ev: Parameters<typeof reduceSnapshotEvent>[1]): void {
  snapshotStore.byRun = reduceSnapshotEvent(snapshotStore.byRun, ev);
  emitSnapshotStore();
}

/** Test seam — drop shared stream + state between cases. */
export function _resetSnapshotStore(): void {
  snapshotStore.source?.close();
  snapshotStore.source = null;
  snapshotStore.byRun = new Map();
  snapshotStore.connected = false;
  snapshotStore.refs = 0;
  snapshotStore.listeners.clear();
}

/** Open the shared stream on the first subscriber; close it on the last. */
function acquireSnapshotStream(): () => void {
  snapshotStore.refs += 1;
  if (!snapshotStore.source) {
    const source = createResilientEventSource({
      // Always advertise delta-capability; the SERVER decides whether to actually send
      // deltas (gated by the papercusp-state-snapshot-deltas flag, default OFF). The
      // delta handler below applies them; full snapshots remain the fallback.
      url: '/api/operator/state-snapshot?delta=1',
      // WI-2141694: because this stream is always-on and app-wide, it is one of
      // the connections that starves the same-origin pool — embedded :3070
      // iframes (HUD, launched-sessions) hang at readyState=interactive with an
      // empty root when every slot is held. It is safe to step aside because the
      // endpoint emits a FULL per-run snapshot as "the baseline on connect"
      // (routes/operator/state-snapshot.ts), and a resume IS a fresh connect —
      // so the parked interval is repaired by re-baselining, independently of
      // the delta flag (deltas are computed against the last snapshot emitted on
      // THIS connection, so a new connection cannot inherit a stale base).
      // Ranked below the default 0 so user-facing streams (chat, pty,
      // agent-thinking) hold their slots and this one yields first.
      yieldOnContention: true,
      streamPriority: -10,
      // Always-on, app-wide stream (eagerly mounted via OperatorChatSidebar) —
      // feed the same shared connectivity signal @papercusp/sync's own SSE
      // transport reports to, so a down operator surfaces as ONE consolidated
      // "operator connection lost" toast instead of silent reconnect churn.
      onOpen: () => {
        snapshotStore.connected = true;
        reportSyncReachable();
        emitSnapshotStore();
      },
      onError: () => {
        snapshotStore.connected = false;
        reportSyncUnreachable();
        emitSnapshotStore();
      },
      handlers: {
        snapshot: (raw) => {
          // @papercusp/sse hands handlers the raw event data string; parse here.
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            console.warn('[useStateSnapshots] non-JSON snapshot payload', raw);
            return;
          }
          // Defensive validation: any field-level malformation here
          // would crash the React render downstream when it iterates
          // openCards. Drop the event on a shape mismatch — server-side
          // bugs shouldn't take the chat surface offline.
          if (!isValidSnapshotEnvelope(parsed)) {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] dropping malformed snapshot', parsed);
            return;
          }
          applySnapshotEvent({ kind: 'snapshot', env: parsed });
        },
        // P-009 data-carrying delta (received only when the stream is opened with
        // ?delta=1). reduceSnapshotEvent applies it on top of the run's current
        // envelope and keeps the stale entry on any version gap, so a bad/late delta
        // can never corrupt or crash the card map.
        delta: (raw) => {
          let parsed: unknown;
          try { parsed = JSON.parse(raw); }
          catch {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] non-JSON delta payload', raw);
            return;
          }
          if (!isValidSnapshotDelta(parsed)) {
            // eslint-disable-next-line no-console
            console.warn('[useStateSnapshots] dropping malformed delta', parsed);
            return;
          }
          applySnapshotEvent({ kind: 'delta', delta: parsed });
        },
      },
    });
    snapshotStore.source = { close: () => source.close() };
  }
  let released = false;
  return () => {
    if (released) return; // idempotent — never free a peer's socket twice
    released = true;
    snapshotStore.refs -= 1;
    if (snapshotStore.refs <= 0) {
      snapshotStore.refs = 0;
      snapshotStore.source?.close();
      snapshotStore.source = null;
      snapshotStore.connected = false;
      emitSnapshotStore();
    }
  };
}

/**
 * Subscribes to /api/operator/state-snapshot. Returns:
 *   - cards: flattened OpenCardWithRun[] across all runs, ordered by
 *     (runId, createdAt). Empty until the first snapshot arrives.
 *   - connected: true once the EventSource is open.
 *
 * Every caller shares ONE app-wide EventSource (see acquireSnapshotStream);
 * caller controls whether it is mounted at all by gating with a conditional
 * render.
 */
export function useStateSnapshots(): {
  cards: OpenCardWithRun[];
  connected: boolean;
  byRun: Map<string, SnapshotEnvelope>;
} {
  const [byRun, setByRun] = useState<Map<string, SnapshotEnvelope>>(() => snapshotStore.byRun);
  const [connected, setConnected] = useState(() => snapshotStore.connected);

  useEffect(() => {
    const sync = () => {
      setByRun(snapshotStore.byRun);
      setConnected(snapshotStore.connected);
    };
    snapshotStore.listeners.add(sync);
    const release = acquireSnapshotStream();
    sync(); // adopt whatever the shared store already holds
    return () => {
      snapshotStore.listeners.delete(sync);
      release();
    };
  }, []);

  const cards = useMemo<OpenCardWithRun[]>(() => {
    const out: OpenCardWithRun[] = [];
    // Iterate runs in insertion order for determinism; within a run,
    // openCards is already in createdAt order from the correlator.
    for (const env of byRun.values()) {
      for (const c of env.snapshot.openCards) {
        out.push({ ...c, runId: env.runId });
      }
    }
    return out;
  }, [byRun]);

  return { cards, connected, byRun };
}

/**
 * Selector helper: from a useStateSnapshots() result, extract
 * (runId → toolState) for runs that have a published toolState.
 * Pure function (no hook); does not open a second EventSource.
 *
 * Usage:
 *   const snaps = useStateSnapshots();
 *   const states = selectToolStates(snaps.byRun);
 */
export function selectToolStates(
  byRun: Map<string, SnapshotEnvelope>,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const env of byRun.values()) {
    if (env.snapshot.toolState !== undefined) {
      out.set(env.runId, env.snapshot.toolState);
    }
  }
  return out;
}
