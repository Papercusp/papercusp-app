/**
 * State channel — per-run snapshot store for stateful surfaces.
 *
 * Plan: apps/operator/docs/plans/bespoke-card-improvements-2026-05-13.md §5
 *
 * Two channels in the tool runtime:
 *
 *   EVENTS channel    — ctx.emit(name, payload)
 *                       ring buffer (T2.2), replay = history
 *
 *   STATE channel     — ctx.askUser, ctx.publishState (PR 2)
 *                       per-run snapshot map, replay = snapshot only
 *
 * This module is the state-channel store. Snapshot shape:
 *
 *   {
 *     openCards: OpenCardSnapshot[]   — populated by card-correlator (PR 1)
 *     toolState: unknown              — populated by publishState     (PR 2)
 *   }
 *
 * Each mutation bumps a monotonic per-run `version`. Subscribers receive
 * the new snapshot; transport adapters serialize it as a `state-snapshot`
 * typed event on the wire.
 *
 * Lifecycle:
 *   - openRun({ workspaceId, runId })       → creates empty snapshot
 *   - setOpenCards(runId, cards[])          → re-emit snapshot
 *   - setToolState(runId, snapshot)         → re-emit snapshot   (PR 2)
 *   - getSnapshot(runId)                    → current snapshot   (for reconnect)
 *   - subscribe(runId, cb) → unsubscribe()  → emit current immediately + on change
 *   - closeRun(runId)                       → drop after retention window (5min)
 *   - dispatchWorkspaceSwitch → drops all snapshots for that workspace
 */

import { pinModuleState } from '@papercusp/module-singleton';
import type { OpenCardSnapshot } from './types';
import { onWorkspaceSwitch } from './workspace-lifecycle';

const STATE_TTL_MS = 5 * 60 * 1000;

export interface StateSnapshot {
  /** Open cards (managed by card-correlator). */
  openCards: OpenCardSnapshot[];
  /** Tool-published state (managed by publishState — PR 2). */
  toolState?: unknown;
}

export interface VersionedSnapshot {
  runId: string;
  /**
   * The workspace this run is scoped to. Carried on the wire so a stateful
   * surface can answer a card (`/card-response` `expectedWorkspaceId`) without
   * out-of-band knowledge of its window's workspace — the desktop chat reads it
   * from a React prop, but headless consumers (the TUI card renderer) have no
   * such source. Optional for back-compat with any older serialized snapshot.
   */
  workspaceId?: string;
  version: number;
  snapshot: StateSnapshot;
}

type Subscriber = (vs: VersionedSnapshot) => void;
type WorkspaceSubscriber = (vs: VersionedSnapshot, workspaceId: string) => void;

interface RunEntry {
  workspaceId: string;
  runId: string;
  version: number;
  snapshot: StateSnapshot;
  subscribers: Set<Subscriber>;
  /** Wall-clock of latest mutation; drives retention sweep. */
  lastMutatedMs: number;
  /** Wall-clock when closeRun was called (start of retention). 0 = open. */
  closedAtMs: number;
}

/**
 * The pin key — also the id this module reports under in
 * `listModuleDuplications()`, so a split here is visible in the REALM-WIDE
 * report rather than only through this module's own accessor. Unchanged from
 * the `Symbol.for(...)` description used before the migration
 * (EI-19479108855357092).
 */
const STATE_KEY = 'papercusp.stateChannelRegistry';

interface StateChannelState {
  runs: Map<string /* runId */, RunEntry>;
  /**
   * Workspace-scoped subscribers — fire on every mutation in any
   * run scoped to the given workspaceId. Used by the chat-surface
   * SSE consumer at /api/operator/state-snapshot to forward every
   * card change without needing to know runIds in advance.
   */
  workspaceSubs: Map<string /* workspaceId */, Set<WorkspaceSubscriber>>;
  gcTimer: ReturnType<typeof setInterval> | null;
  lifecycleSubscribed: boolean;
}

/**
 * Pinned + counted by `@papercusp/module-singleton` rather than hand-rolled on
 * `globalThis[Symbol.for(...)]`. Both fix the split; only this one is VISIBLE to
 * `listModuleDuplications()`, so the realm-wide report stops answering a clean
 * `[]` for a module it cannot see. Must stay at module scope — `evaluations` is
 * a module-RECORD count only if this runs once per evaluation of this body.
 *
 * Only the DATA is eager. Lifecycle subscription and the GC timer stay lazy in
 * `registry()` below: arming a `setInterval` at import time would be a real
 * behaviour change, not a refactor.
 */
const state = pinModuleState<StateChannelState>(STATE_KEY, () => ({
  runs: new Map(),
  workspaceSubs: new Map(),
  gcTimer: null,
  lifecycleSubscribed: false,
}));

function registry() {
  const r = state;
  if (!r.lifecycleSubscribed) {
    onWorkspaceSwitch((wid) => dropStateSnapshotsForWorkspaceSwitch(wid));
    r.lifecycleSubscribed = true;
  }
  if (!r.gcTimer) {
    r.gcTimer = setInterval(() => {
      const now = Date.now();
      for (const [rid, entry] of r.runs) {
        if (entry.closedAtMs > 0 && now - entry.closedAtMs > STATE_TTL_MS) {
          r.runs.delete(rid);
        }
      }
    }, 60 * 1000);
    if (typeof r.gcTimer.unref === 'function') r.gcTimer.unref();
  }
  return r;
}

function emit(entry: RunEntry): void {
  // Defensive copy so a buggy subscriber can't mutate source-of-truth.
  // Shallow-copying the wrapper alone isn't enough — subscribers could
  // still .push() into openCards or mutate toolState properties. We
  // copy the openCards array (cheap, small) and pass toolState by
  // reference (callers serialize via JSON.stringify which doesn't
  // mutate; deep-cloning arbitrary toolState shapes is too expensive).
  const vs: VersionedSnapshot = {
    runId: entry.runId,
    workspaceId: entry.workspaceId,
    version: entry.version,
    snapshot: {
      openCards: [...entry.snapshot.openCards],
      ...(entry.snapshot.toolState !== undefined
        ? { toolState: entry.snapshot.toolState }
        : {}),
    },
  };
  for (const cb of entry.subscribers) {
    try {
      cb(vs);
    } catch (e) {
      console.warn('[state-channel] subscriber threw', { runId: entry.runId, error: e });
    }
  }
  // Fan out to workspace-scoped subscribers (chat surfaces, /dev tab).
  const wsSet = registry().workspaceSubs.get(entry.workspaceId);
  if (wsSet) {
    for (const cb of wsSet) {
      try {
        cb(vs, entry.workspaceId);
      } catch (e) {
        console.warn('[state-channel] workspace subscriber threw', {
          workspaceId: entry.workspaceId,
          error: e,
        });
      }
    }
  }
}

/**
 * Initialize an empty snapshot for a run. Idempotent — safe to call
 * multiple times; returns the existing entry if present.
 */
export function openRun(opts: {
  workspaceId: string;
  runId: string;
}): void {
  const r = registry();
  const existing = r.runs.get(opts.runId);
  if (existing) {
    // Reopen if it was closed (e.g., tool re-entered).
    existing.closedAtMs = 0;
    return;
  }
  r.runs.set(opts.runId, {
    workspaceId: opts.workspaceId,
    runId: opts.runId,
    version: 0,
    snapshot: { openCards: [] },
    subscribers: new Set(),
    lastMutatedMs: Date.now(),
    closedAtMs: 0,
  });
}

/**
 * Replace the openCards field. Bumps version + re-emits to subscribers.
 * No-op if no run entry exists for the runId.
 */
export function setOpenCards(runId: string, openCards: OpenCardSnapshot[]): void {
  const entry = registry().runs.get(runId);
  if (!entry) return;
  entry.version += 1;
  entry.snapshot = { ...entry.snapshot, openCards };
  entry.lastMutatedMs = Date.now();
  emit(entry);
}

/**
 * Replace the toolState field. Bumps version + re-emits.
 * Used by ctx.publishState in PR 2.
 */
export function setToolState(runId: string, toolState: unknown): void {
  const entry = registry().runs.get(runId);
  if (!entry) return;
  entry.version += 1;
  entry.snapshot = { ...entry.snapshot, toolState };
  entry.lastMutatedMs = Date.now();
  emit(entry);
}

/**
 * Snapshot the current state for a run. Returns null if no run entry
 * exists (or it has been GC'd past retention).
 */
export function getSnapshot(runId: string): VersionedSnapshot | null {
  const entry = registry().runs.get(runId);
  if (!entry) return null;
  return {
    runId: entry.runId,
    workspaceId: entry.workspaceId,
    version: entry.version,
    snapshot: entry.snapshot,
  };
}

/**
 * Subscribe to snapshot changes. The subscriber is invoked synchronously
 * with the current snapshot, then again on every mutation.
 * Returns an unsubscribe function.
 */
export function subscribe(runId: string, cb: Subscriber): () => void {
  const entry = registry().runs.get(runId);
  if (!entry) {
    // Subscribing to a non-existent run is allowed (e.g., race with openRun);
    // return a no-op until the run is opened. The subscriber simply never fires.
    return () => {};
  }
  entry.subscribers.add(cb);
  // Emit current state immediately so new connections get the snapshot.
  // Isolate throw — see emit() — so a buggy subscriber can't kill the caller.
  try {
    cb({
      runId: entry.runId,
      workspaceId: entry.workspaceId,
      version: entry.version,
      snapshot: entry.snapshot,
    });
  } catch (e) {
    console.warn('[state-channel] subscriber threw on initial emit', { runId: entry.runId, error: e });
  }
  return () => entry.subscribers.delete(cb);
}

/**
 * Mark a run as closed. The entry sticks around for STATE_TTL_MS for
 * late reconnects, then is GC'd. Subscribers are NOT auto-removed —
 * transport adapters should call their own unsubscribe.
 */
export function closeRun(runId: string): void {
  const entry = registry().runs.get(runId);
  if (!entry) return;
  entry.closedAtMs = Date.now();
}

/**
 * Subscribe to ALL snapshot changes within a workspace, irrespective
 * of runId. Used by chat-surface SSE consumers — they don't know
 * which runIds will exist in advance, but they always know their
 * active workspace.
 *
 * The subscriber fires on every mutation in any run scoped to the
 * workspace. It does NOT receive an "initial" snapshot for currently-
 * open runs; the caller should walk getSnapshot(runId) for known
 * runIds if they need that. This API is for live updates only.
 */
export function subscribeWorkspace(
  workspaceId: string,
  cb: WorkspaceSubscriber,
): () => void {
  const r = registry();
  let set = r.workspaceSubs.get(workspaceId);
  if (!set) {
    set = new Set();
    r.workspaceSubs.set(workspaceId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) r.workspaceSubs.delete(workspaceId);
  };
}

/**
 * Snapshot every open run scoped to a workspace. Used by chat-surface
 * SSE consumers right after subscribeWorkspace, so the client sees
 * every currently-open card on stream open.
 */
export function snapshotWorkspace(workspaceId: string): VersionedSnapshot[] {
  const r = registry();
  const out: VersionedSnapshot[] = [];
  for (const entry of r.runs.values()) {
    if (entry.workspaceId === workspaceId) {
      out.push({
        runId: entry.runId,
        workspaceId: entry.workspaceId,
        version: entry.version,
        snapshot: entry.snapshot,
      });
    }
  }
  return out;
}

/**
 * Workspace-switch subscriber. Drops every run scoped to the workspace.
 */
export function dropStateSnapshotsForWorkspaceSwitch(workspaceId: string): void {
  const r = registry();
  for (const [rid, entry] of r.runs) {
    if (entry.workspaceId === workspaceId) {
      r.runs.delete(rid);
    }
  }
  // Drop workspace subscribers too — they're scoped to the old workspace.
  r.workspaceSubs.delete(workspaceId);
}

/** Test-only: clear everything. */
export function _resetStateChannelForTests(): void {
  const r = registry();
  r.runs.clear();
  r.workspaceSubs.clear();
}

/** Test-only stats. */
export function _stateChannelStatsForTests(): {
  runCount: number;
  subscriberCount: number;
} {
  const r = registry();
  let subs = 0;
  for (const entry of r.runs.values()) subs += entry.subscribers.size;
  return { runCount: r.runs.size, subscriberCount: subs };
}
