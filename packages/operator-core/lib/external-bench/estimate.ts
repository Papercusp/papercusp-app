import { knownTaskSets } from './task-sets';

// Per-task opus cost basis: the m3 real-Queen pass cost $33.98 over 11 tasks
// (~$3.09/task). Round up for a conservative pre-launch estimate.
const PER_TASK_USD = 3.5;
// Rough per-task wall minutes (a SWE-bench Pro task on the hive); time is the
// looser estimate, labelled rough in the UI.
const PER_TASK_WALL_MIN = 18;

export interface BenchLaunchEstimate {
  taskSetId: string;
  taskCount: number;
  cap: number;
  perTaskUsd: number;
  estCostUsd: number;
  estWallMin: number;
  basis: string;
}

export function estimateBenchLaunch({
  taskSetId = '11-task-pilot',
  cap = 5,
}: {
  taskSetId?: string;
  cap?: number;
}): BenchLaunchEstimate {
  const safeCap = Math.max(1, Number(cap) || 5);
  const set = knownTaskSets().find((s) => s.id === taskSetId);
  const taskCount = set?.count ?? (taskSetId === 'swe-bench-pro-full' ? 731 : 11);
  const estCostUsd = Math.round(taskCount * PER_TASK_USD * 100) / 100;
  // Parallel wall ≈ ceil(N/cap) waves × per-task wall (rough).
  const waves = Math.ceil(taskCount / safeCap);
  const estWallMin = waves * PER_TASK_WALL_MIN;
  return {
    taskSetId,
    taskCount,
    cap: safeCap,
    perTaskUsd: PER_TASK_USD,
    estCostUsd,
    estWallMin,
    basis: 'per-task cost from the m3 real-Queen pass ($33.98 / 11 ≈ $3.09/task, opus); time is rough.',
  };
}
