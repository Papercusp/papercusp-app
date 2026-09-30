/**
 * Grader-liveness observation for `system:acceptance-grading-sweep`.
 * plan: acceptance-grading-stall-sweep-2026-08-26 · EI-21555395534019608
 *
 * WHY THIS IS ITS OWN MODULE. It used to be a closure inside the routine adapter,
 * which made it unreachable from a test: the suite could only pin its SOURCE TEXT.
 * The defect below lived in that blind spot and was invisible to 75 passing tests,
 * so the fix is not only the corrected read — it is moving the read somewhere a
 * test can actually call it.
 *
 * THE DEFECT THIS EXISTS TO PIN. The observation used to read a TOP-LEVEL `task.label`.
 * There is no such field: `task_ledger` has no `label` column, and `toRow` maps none,
 * so the read was `undefined` on every row and the prefix match was false on every
 * row. The probe therefore reported `{ live: false, lastDispatchMs: null }`
 * unconditionally — not merely when a grader fell outside the scan window. Losing
 * `lastDispatchMs` loses the re-dispatch cooling window, so `resolveAcceptanceGrader`
 * was re-invoked on every tick. It stayed SAFE only because that call is
 * idempotency-keyed. The label lives at `detail.label`, which is where
 * `scorecards:emit` reads it when it reaps a finished judge — the two are supposed to
 * share one label algebra, and this is what actually makes them agree.
 */
import type { GraderObservation } from './acceptance-grading-sweep-run';

/**
 * Rows to scan. With the prefix pushed into SQL this bounds MATCHING graders rather
 * than the whole ledger, so it is no longer a cliff a busy box can fall off: this
 * workspace has produced 39 grader tasks in total against 10k+ ledger rows.
 */
export const GRADER_TASK_SCAN_LIMIT = 200;

/** The shape this module needs from a task row — deliberately structural, so the
 *  pure core does not drag in the task-manager store or its database graph. */
export interface GraderTaskLike {
  readonly detail?: unknown;
  readonly startedAt?: unknown;
  readonly endedAt?: unknown;
}

export interface GraderTaskFilter {
  readonly includeEnded: boolean;
  readonly limit: number;
  readonly labelPrefix: string;
  readonly workspaceId?: string;
}

export type GraderTaskLister = (filter: GraderTaskFilter) => Promise<readonly GraderTaskLike[]>;

/**
 * The label of a task, read from the ONE place it is stored.
 *
 * Tolerant of a missing/!object `detail` because a jsonb bag can arrive undecoded
 * across a worker boundary; a non-string label is not a label.
 */
export function graderTaskLabel(task: GraderTaskLike): string {
  const detail = task?.detail;
  if (!detail || typeof detail !== 'object') return '';
  const label = (detail as { label?: unknown }).label;
  return typeof label === 'string' ? label : '';
}

function startedMs(task: GraderTaskLike): number | null {
  const raw = task?.startedAt;
  if (!raw) return null;
  const ms = new Date(raw as string).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Grader liveness from the task ledger.
 *
 * `live` counts only un-ended tasks; `lastDispatchMs` deliberately includes ended
 * ones, because "when did we last try" is what governs the cooling window.
 *
 * The prefix is applied TWICE on purpose — pushed into SQL, then re-checked here.
 * That is not redundancy for its own sake: the two failure directions are
 * asymmetric. Under-matching costs a wasted idempotent re-dispatch, but
 * over-matching would report a stranger's task as this plan's live grader and the
 * stall would never heal. The local re-check makes the dangerous direction
 * impossible even if the pushdown is ever refactored away.
 *
 * A listing error is swallowed to the same safe direction: no observation reads as
 * "no grader", which re-dispatches idempotently rather than declaring a dead grader
 * alive.
 */
export async function observeAcceptanceGrader(
  row: { rubricRef?: string | null; workspaceId?: string | null },
  deps: {
    listTasks: GraderTaskLister;
    labelPrefix: (rubricRef: string) => string;
    limit?: number;
  },
): Promise<GraderObservation> {
  const rubricRef = row.rubricRef;
  if (!rubricRef) return { live: false, lastDispatchMs: null };

  const prefix = deps.labelPrefix(rubricRef);
  const workspaceId = row.workspaceId ?? undefined;

  const tasks = await deps
    .listTasks({
      includeEnded: true,
      limit: deps.limit ?? GRADER_TASK_SCAN_LIMIT,
      labelPrefix: prefix,
      ...(workspaceId ? { workspaceId } : {}),
    })
    .catch(() => [] as readonly GraderTaskLike[]);

  const mine = tasks.filter((task) => graderTaskLabel(task).startsWith(prefix));
  if (mine.length === 0) return { live: false, lastDispatchMs: null };

  const live = mine.some((task) => !task.endedAt);
  const lastDispatchMs = mine.reduce<number | null>((acc, task) => {
    const ms = startedMs(task);
    return ms === null ? acc : acc === null ? ms : Math.max(acc, ms);
  }, null);

  return { live, lastDispatchMs };
}
