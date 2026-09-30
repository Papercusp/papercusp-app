/**
 * Module-level chaos run store with pub/sub.
 *
 * Why a module store instead of plain useState in ChaosTab: opening a
 * Tauri WebviewWindow during launch() causes the surrounding React
 * tree to be torn down and recreated. setLastSummary references the
 * dead instance and silently no-ops; the new instance never sees the
 * completed run.
 *
 * State here survives remounts. ChaosTab subscribes with
 * useSyncExternalStore so any mount sees the latest snapshot.
 */
import type { RecorderEvent, RunSummary } from './recorder-channel';
import { loadRuns, saveRun } from './recorder-channel';

export type RunState = 'idle' | 'launching' | 'recording' | 'finishing';

export interface ChaosStoreSnapshot {
  runId: string | null;
  runState: RunState;
  progress: { clicks: number; elapsedMs: number };
  liveEvents: RecorderEvent[];
  lastSummary: RunSummary | null;
  history: RunSummary[];
}

let snapshot: ChaosStoreSnapshot = {
  runId: null,
  runState: 'idle',
  progress: { clicks: 0, elapsedMs: 0 },
  liveEvents: [],
  lastSummary: null,
  history: typeof window === 'undefined' ? [] : loadRuns(),
};

const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getChaosSnapshot(): ChaosStoreSnapshot {
  return snapshot;
}

export function subscribeChaos(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function resetForNewRun(runId: string) {
  snapshot = {
    runId,
    runState: 'launching',
    progress: { clicks: 0, elapsedMs: 0 },
    liveEvents: [],
    lastSummary: null,
    history: snapshot.history,
  };
  emit();
}

export function setRunState(runState: RunState) {
  if (snapshot.runState === runState) return;
  snapshot = { ...snapshot, runState };
  emit();
}

export function setProgress(progress: { clicks: number; elapsedMs: number }) {
  snapshot = { ...snapshot, progress };
  emit();
}

export function pushLiveEvent(event: RecorderEvent) {
  snapshot = { ...snapshot, liveEvents: [...snapshot.liveEvents, event] };
  emit();
}

export function finalizeRun(summary: RunSummary) {
  const newHistory = saveRun(summary);
  snapshot = {
    ...snapshot,
    runState: 'idle',
    lastSummary: summary,
    history: newHistory,
  };
  emit();
}

export function idleReset() {
  snapshot = {
    runId: null,
    runState: 'idle',
    progress: { clicks: 0, elapsedMs: 0 },
    liveEvents: [],
    lastSummary: snapshot.lastSummary,
    history: snapshot.history,
  };
  emit();
}

export function clearHistory() {
  snapshot = { ...snapshot, history: [], lastSummary: null };
  emit();
}

export function refreshHistory() {
  snapshot = { ...snapshot, history: loadRuns() };
  emit();
}
