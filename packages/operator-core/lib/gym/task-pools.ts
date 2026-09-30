/**
 * Task-pool partitioning + filtering (P-007, D-013).
 *
 * Pools serve different jobs and must not be conflated: `train` drives the
 * proposer; a FROZEN `dev-anchor` is held fixed for the whole run so the champion
 * comparison + circuit-breaker are apples-to-apples; a fresh `monitor` set is
 * regenerated each cycle and never feeds an accept decision (overfitting alarm);
 * `probe` carries planted bugs; `real-anchor` is the falsifiability check (D-014).
 *
 * Pure: partition a tagged batch, drop tasks the baseline can't even attempt, and
 * deterministically freeze a dev-anchor subset.
 */
import type { GymRunOutcome } from './pipeline-status';
import type { GymTaskPool } from './task-generator';

export function partitionByPool<T extends { pool: GymTaskPool }>(tasks: readonly T[]): Record<GymTaskPool, T[]> {
  const groups: Record<GymTaskPool, T[]> = {
    train: [],
    'dev-anchor': [],
    monitor: [],
    probe: [],
    'real-anchor': [],
  };
  for (const t of tasks) groups[t.pool].push(t);
  return groups;
}

/** A baseline that errored or timed out never engaged the task — it can't be evaluated. */
export function isAttemptable(outcome: GymRunOutcome): boolean {
  return outcome !== 'errored' && outcome !== 'timeout';
}

/**
 * Keep only tasks the baseline provably attempted (a known, engaged outcome).
 * Unknown (no baseline outcome) is dropped — we freeze only tasks we trust.
 */
export function filterAttemptableTasks<T extends { taskId: string }>(
  tasks: readonly T[],
  outcomeByTaskId: Readonly<Record<string, GymRunOutcome>>,
): T[] {
  return tasks.filter((t) => {
    const o = outcomeByTaskId[t.taskId];
    return o !== undefined && isAttemptable(o);
  });
}

/** Deterministically select n tasks (sorted by id) to freeze as the dev-anchor — reproducible. */
export function selectFrozenDevAnchor<T extends { taskId: string }>(pool: readonly T[], n: number): T[] {
  return [...pool].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0)).slice(0, n);
}
