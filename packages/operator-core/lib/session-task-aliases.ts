/**
 * Whole-list model-family facades over the canonical session task engine.
 *
 * Claude's TodoWrite and Codex's update_plan both replace an ordered snapshot.
 * This adapter keeps those familiar producer shapes without introducing a
 * second store: status-only snapshots become canonical transition ops, while
 * structural edits and otherwise-unrepresentable transitions use canonical
 * init with stable ids preserved for exact surviving entries.
 */
import type { Sql, TransactionSql } from 'postgres';
import {
  acquireSessionTaskLock,
  applySessionTaskOp,
  reduceSessionTasks,
  type SessionTask,
  type SessionTaskBridge,
  type SessionTaskOpArgs,
  type SessionTaskResult,
  type SessionTaskSeed,
} from './session-tasks';

type SqlLike = Sql | TransactionSql;

export const MODEL_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type ModelTaskStatus = (typeof MODEL_TASK_STATUSES)[number];

export interface ModelTaskSnapshotEntry {
  content: string;
  activeForm?: string;
  status: ModelTaskStatus;
}

export interface SessionTaskSnapshotPlan {
  strategy: 'noop' | 'ops' | 'init';
  ops: SessionTaskOpArgs[];
  initTasks: SessionTaskSeed[] | null;
}

export interface SessionTaskSnapshotResult {
  strategy: SessionTaskSnapshotPlan['strategy'];
  mutations: SessionTaskResult[];
  tasks: SessionTask[];
}

interface SnapshotApplyArgs {
  workspaceId: string;
  sessionId: string;
  tasks: ModelTaskSnapshotEntry[];
  explanation?: string;
  idFactory: () => string;
  now?: string;
  bridge?: SessionTaskBridge;
}

type ApplyOp = typeof applySessionTaskOp;

function entryKey(entry: Pick<SessionTask, 'content' | 'activeForm'>): string {
  return JSON.stringify([entry.content, entry.activeForm]);
}

function sameSnapshotShape(current: readonly SessionTask[], desired: readonly SessionTask[]): boolean {
  return current.length === desired.length && current.every((task, index) => {
    const next = desired[index];
    return next !== undefined && task.content === next.content && task.activeForm === next.activeForm;
  });
}

function sameSnapshotState(current: readonly SessionTask[], desired: readonly SessionTask[]): boolean {
  return sameSnapshotShape(current, desired) && current.every((task, index) => {
    const next = desired[index];
    return next !== undefined && task.status === next.status && task.blockerRef === null;
  });
}

function normalizedDesired(
  tasks: readonly ModelTaskSnapshotEntry[],
  explanation: string | undefined,
): SessionTask[] {
  let nextId = 0;
  return reduceSessionTasks([], {
    op: 'init',
    explanation,
    tasks: tasks.map((task) => ({
      content: task.content,
      activeForm: task.activeForm,
      status: task.status,
    })),
  }, {
    now: '1970-01-01T00:00:00.000Z',
    idFactory: () => `snapshot-${nextId++}`,
  }).tasks;
}

function initSeedsPreservingIds(
  current: readonly SessionTask[],
  desired: readonly SessionTask[],
): SessionTaskSeed[] {
  const currentByEntry = new Map<string, SessionTask[]>();
  for (const task of current) {
    const key = entryKey(task);
    const matches = currentByEntry.get(key) ?? [];
    matches.push(task);
    currentByEntry.set(key, matches);
  }

  return desired.map((task) => {
    const matches = currentByEntry.get(entryKey(task));
    const surviving = matches?.shift();
    return {
      ...(surviving ? { id: surviving.id } : {}),
      content: task.content,
      activeForm: task.activeForm,
      status: task.status,
    };
  });
}

/** Pure planner used by focused tests and the transaction-bound executor. */
export function planSessionTaskSnapshot(
  current: readonly SessionTask[],
  snapshot: readonly ModelTaskSnapshotEntry[],
  explanation?: string,
): SessionTaskSnapshotPlan {
  const desired = normalizedDesired(snapshot, explanation);
  const initTasks = () => initSeedsPreservingIds(current, desired);

  if (!sameSnapshotShape(current, desired)) {
    return { strategy: 'init', ops: [], initTasks: initTasks() };
  }

  const ops: SessionTaskOpArgs[] = [];
  for (let index = 0; index < desired.length; index += 1) {
    const before = current[index]!;
    const after = desired[index]!;
    if (after.status === 'completed' && before.status !== 'completed') {
      ops.push({ op: 'done', taskId: before.id, explanation });
    }
  }
  for (let index = 0; index < desired.length; index += 1) {
    const before = current[index]!;
    const after = desired[index]!;
    if (after.status === 'pending' && before.status === 'blocked') {
      ops.push({ op: 'unblock', taskId: before.id, explanation });
    }
  }
  const desiredActiveIndex = desired.findIndex((task) => task.status === 'in_progress');
  if (desiredActiveIndex >= 0 && current[desiredActiveIndex]!.status !== 'in_progress') {
    ops.push({ op: 'start', taskId: current[desiredActiveIndex]!.id, explanation });
  }

  let simulated = current.map((task) => ({ ...task }));
  try {
    for (let index = 0; index < ops.length; index += 1) {
      simulated = reduceSessionTasks(simulated, ops[index]!, {
        now: `1970-01-01T00:00:0${index + 1}.000Z`,
        idFactory: () => 'unused',
      }).tasks;
    }
  } catch {
    return { strategy: 'init', ops: [], initTasks: initTasks() };
  }

  if (!sameSnapshotState(simulated, desired)) {
    return { strategy: 'init', ops: [], initTasks: initTasks() };
  }

  // update_plan's explanation is a real canonical update even when the list is
  // unchanged; init is the only canonical op that can attach it without lying
  // about a task transition.
  if (ops.length === 0 && explanation !== undefined) {
    return { strategy: 'init', ops: [], initTasks: initTasks() };
  }

  return {
    strategy: ops.length === 0 ? 'noop' : 'ops',
    ops,
    initTasks: null,
  };
}

/** Execute a model-native snapshot exclusively through applySessionTaskOp. */
export async function applySessionTaskSnapshot(
  sql: SqlLike,
  args: SnapshotApplyArgs,
  applyOp: ApplyOp = applySessionTaskOp,
): Promise<SessionTaskSnapshotResult> {
  await acquireSessionTaskLock(sql, args.workspaceId, args.sessionId);
  const viewed = await applyOp(sql, {
    workspaceId: args.workspaceId,
    sessionId: args.sessionId,
    op: 'view',
    bridge: args.bridge,
    idFactory: args.idFactory,
  });
  const plan = planSessionTaskSnapshot(viewed.tasks, args.tasks, args.explanation);
  if (plan.strategy === 'noop') {
    return { strategy: plan.strategy, mutations: [], tasks: viewed.tasks };
  }

  const mutations: SessionTaskResult[] = [];
  if (plan.strategy === 'init') {
    mutations.push(await applyOp(sql, {
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      op: 'init',
      tasks: plan.initTasks!,
      explanation: args.explanation,
      idFactory: args.idFactory,
      now: args.now,
      bridge: args.bridge,
    }));
  } else {
    for (const op of plan.ops) {
      mutations.push(await applyOp(sql, {
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        ...op,
        idFactory: args.idFactory,
        now: args.now,
        bridge: args.bridge,
      }));
    }
  }

  return {
    strategy: plan.strategy,
    mutations,
    tasks: mutations.at(-1)!.tasks,
  };
}
