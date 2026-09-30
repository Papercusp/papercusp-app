/**
 * mutation-calendar.ts — the D-003 advisory view over the behavior-change
 * ledger (self-learning-frontier-2026-06-12 P-004 / FB-02).
 *
 * "One live mutation class at a time" is POLICY, surfaced not enforced: when
 * more than one AUTOMATED mutation class has ledger activity inside the
 * liveness window, the calendar reports the overlap so the owner (and the
 * EKG / ablation schedulers) can serialize — nothing here blocks a mutation.
 *
 * Overlap is computed over the automated classes only ('gym', 'ablation', and
 * any future class this module doesn't know): manual playbook/persona edits
 * ('manual-prompt', 'repo-prompt') are continuous background in a live dev
 * fleet, and an advisory that always fires is an advisory nobody reads. All
 * classes still appear in `classes`/`liveClasses` so attribution reads stay
 * complete.
 *
 * PURE over injected rows (unit-testable without PG), mirroring
 * computeDispatchStats in harness/improvements/dispatch-ledger.ts.
 */

import type { BehaviorChangeRow } from './change-ledger';

/** Classes whose concurrent liveness trips the D-003 advisory (manual edit
 *  classes are excluded — see module doc). Unknown future classes count as
 *  automated: a new mutator should trip the advisory until someone decides
 *  otherwise. */
const MANUAL_CLASSES = new Set(['manual-prompt', 'repo-prompt']);

/** Default liveness window: a class with activity in the trailing 7 days is "live". */
export const DEFAULT_LIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface MutationCalendarClass {
  mutationClass: string;
  count: number;
  /** ISO timestamps of the oldest/newest activity in the considered rows. */
  firstAt: string | null;
  lastAt: string | null;
  /** Activity inside the liveness window. */
  live: boolean;
  /** Counted toward the D-003 overlap advisory (false for manual edit classes). */
  automated: boolean;
}

export interface MutationCalendar {
  liveWindowMs: number;
  /** Every class seen in the rows, most recently active first. */
  classes: MutationCalendarClass[];
  /** Names of all live classes (manual ones included). */
  liveClasses: string[];
  /** More than one AUTOMATED class is live. */
  overlap: boolean;
  /** Human line when overlap is true, else null. */
  advisory: string | null;
}

export interface ComputeMutationCalendarOptions {
  /** Now, in ms — injectable for deterministic tests; callers pass Date.now(). */
  nowMs?: number;
  liveWindowMs?: number;
}

/** Pure rollup over ledger rows. Deterministic given nowMs; no PG, no clock reads. */
export function computeMutationCalendar(
  rows: Pick<BehaviorChangeRow, 'mutationClass' | 'recordedAt'>[],
  opts: ComputeMutationCalendarOptions = {},
): MutationCalendar {
  const nowMs = opts.nowMs ?? Date.now();
  const liveWindowMs = opts.liveWindowMs ?? DEFAULT_LIVE_WINDOW_MS;
  const liveStart = nowMs - liveWindowMs;

  const byClass = new Map<string, { count: number; firstAt: string | null; lastAt: string | null; live: boolean }>();
  for (const r of rows) {
    const c = byClass.get(r.mutationClass) ?? { count: 0, firstAt: null, lastAt: null, live: false };
    c.count += 1;
    if (c.firstAt === null || r.recordedAt < c.firstAt) c.firstAt = r.recordedAt;
    if (c.lastAt === null || r.recordedAt > c.lastAt) c.lastAt = r.recordedAt;
    const ms = Date.parse(r.recordedAt);
    if (!Number.isNaN(ms) && ms >= liveStart && ms <= nowMs) c.live = true;
    byClass.set(r.mutationClass, c);
  }

  const classes: MutationCalendarClass[] = [...byClass.entries()]
    .map(([mutationClass, c]) => ({
      mutationClass,
      count: c.count,
      firstAt: c.firstAt,
      lastAt: c.lastAt,
      live: c.live,
      automated: !MANUAL_CLASSES.has(mutationClass),
    }))
    .sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''));

  const liveClasses = classes.filter((c) => c.live).map((c) => c.mutationClass);
  const liveAutomated = classes.filter((c) => c.live && c.automated).map((c) => c.mutationClass);
  const overlap = liveAutomated.length > 1;
  const days = Math.round((liveWindowMs / 86_400_000) * 10) / 10;

  return {
    liveWindowMs,
    classes,
    liveClasses,
    overlap,
    advisory: overlap
      ? `D-003 advisory: ${liveAutomated.length} automated mutation classes live in the trailing ${days}d ` +
        `(${liveAutomated.join(', ')}) — one live mutation class at a time keeps EKG shifts attributable. ` +
        `Serialize them (policy, not enforcement).`
      : null,
  };
}
