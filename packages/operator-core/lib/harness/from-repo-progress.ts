/**
 * from-repo-progress — REAL per-step progress for the long create
 * (hive-from-repo-hardening-2026-06-11 P-008).
 *
 * The HTTP route transport has no progress projection (checked: define-route
 * carries none), so per the item's fallback design the composition records
 * step transitions HERE — an in-process store — and each write fires
 * `notifySyncInvalidate('hiveFromRepo.progress', { progressId })` so the
 * form's `useSyncQuery` re-fetches over the EXISTING sync channel (SSE-driven,
 * no polling, the house data-sync rule). The client mints the progressId and
 * subscribes BEFORE submitting, so no event is ever missed.
 *
 * In-process by design: the resolver runs in the same Hono host as the route.
 * Rows are transient UX, not state — capped + TTL-swept, never persisted.
 */

import { trackDetached } from '../detached-imports';

// `submodules` is the dogfood clone-on-first-boot's second phase
// (bootstrap-papercusp-hive) — the create-from-URL flow doesn't emit it.
export type FromRepoStep = 'lookup' | 'clone' | 'submodules' | 'detect' | 'create' | 'seed' | 'publish';
export type FromRepoStepStatus = 'running' | 'done' | 'error' | 'skipped';

export interface FromRepoProgressRow {
  step: FromRepoStep;
  status: FromRepoStepStatus;
  ts: number;
  /** 0–100 for a phase with a real byte/object measure (git clone --progress,
   *  submodule N/total). Absent for instantaneous steps. */
  percent?: number;
  /** Short human detail, e.g. "8/27 submodules". Optional. */
  detail?: string;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 200;

// Process-global (the route + resolver share the module instance).
const store = new Map<string, { rows: FromRepoProgressRow[]; touched: number }>();

function sweep(now: number): void {
  if (store.size <= MAX_ENTRIES) {
    for (const [id, e] of store) if (now - e.touched > TTL_MS) store.delete(id);
    return;
  }
  // Over cap: drop oldest first.
  const byAge = [...store.entries()].sort((a, b) => a[1].touched - b[1].touched);
  for (const [id] of byAge.slice(0, store.size - MAX_ENTRIES)) store.delete(id);
}

/** Record a step transition + fire the sync invalidate (best-effort).
 *  `extra.percent` / `extra.detail` carry a measured progress for a long phase
 *  (git clone --progress, submodule N/total). Callers should THROTTLE percent
 *  ticks (e.g. emit every few %) — this still coalesces a `running` stream into
 *  one evolving row so the store never grows per tick. */
export function recordFromRepoStep(
  progressId: string,
  step: FromRepoStep,
  status: FromRepoStepStatus,
  extra?: { percent?: number; detail?: string },
): void {
  if (!progressId) return;
  const now = Date.now();
  sweep(now);
  const entry = store.get(progressId) ?? { rows: [], touched: now };
  const row: FromRepoProgressRow = {
    step,
    status,
    ts: now,
    ...(extra?.percent != null
      ? { percent: Math.max(0, Math.min(100, Math.round(extra.percent))) }
      : {}),
    ...(extra?.detail ? { detail: extra.detail } : {}),
  };
  // Coalesce a same-step `running` progress stream into ONE evolving row (a
  // clone emits ~100 percent ticks); status transitions (running→done) append.
  const last = entry.rows[entry.rows.length - 1];
  if (last && last.step === step && last.status === 'running' && status === 'running') {
    entry.rows[entry.rows.length - 1] = row;
  } else {
    entry.rows.push(row);
  }
  entry.touched = now;
  store.set(progressId, entry);
  // Lazy import avoids a cycle (sync-sse pulls broad operator infra).
  void trackDetached(import('../sync-sse'))
    .then(({ notifySyncInvalidate }) => notifySyncInvalidate('hiveFromRepo.progress', { progressId }))
    .catch(() => {});
}

/** The transitions so far, oldest first (the resolver's rows). */
export function getFromRepoProgress(progressId: string): FromRepoProgressRow[] {
  const entry = store.get(progressId);
  if (!entry) return [];
  entry.touched = Date.now();
  return [...entry.rows];
}

/** Test seam. */
export function __resetFromRepoProgress(): void {
  store.clear();
}
