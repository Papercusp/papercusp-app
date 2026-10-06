/** Host independent, task-managed runner for the frozen repair admission pre-check. */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTask } from '../task-manager/store';
import { managedSpawn, type ManagedSpawnResult } from '../task-manager/managed-spawn';
import type { TaskRow } from '../task-manager/types';
import { resolveSidecarSpawnPlan, type SidecarSpawnPlan } from '../process-supervision/sidecar-spawn-shared';
import {
  applyFrozenCandidateRepairQueueTransition,
  readFrozenCandidateRepairQueueState,
} from '../harness/routines/release-actions';
import {
  createCheckpointTreeFixPrecheckRunner,
  evaluateFixPrecheck,
  precheckPopulation,
  type FixPrecheckProgress,
  type FixPrecheckRunResult,
  type FixPrecheckVerdict,
} from './admission-fix-precheck';
import type {
  FrozenCandidateRepairQueue,
  FrozenCandidateRepairQueueRead,
  RepairSignatureEntry,
} from './frozen-candidate-repair-queue';

export const ADMISSION_PRECHECK_WORKER_MODE_ENV = 'PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE';
export const ADMISSION_PRECHECK_WORKER_INPUT_ENV = 'PAPERCUSP_REPAIR_PRECHECK_WORKER_INPUT';

export interface AdmissionPrecheckQueueTarget {
  workspaceId: string;
  installSlug: string;
}

export interface AdmissionPrecheckWorkerInput {
  operationId: string;
  taskId: string;
  queueTarget: AdmissionPrecheckQueueTarget;
  integrationRoot: string;
  checkpointRoot: string;
  expiresAtMs: number;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function buildAdmissionPrecheckSpawnPlan(options: {
  selfPath?: string;
  moduleDirOverride?: string;
  execPath?: string;
  spawnerPid?: number;
} = {}): SidecarSpawnPlan {
  return resolveSidecarSpawnPlan({
    selfPath: options.selfPath ?? fileURLToPath(import.meta.url),
    devScriptPath: join(options.moduleDirOverride ?? moduleDir, 'admission-fix-precheck-worker-bin.ts'),
    bundledModeEnvVar: ADMISSION_PRECHECK_WORKER_MODE_ENV,
    execPath: options.execPath ?? process.execPath,
    spawnerPid: options.spawnerPid ?? process.pid,
  });
}

export async function startAdmissionPrecheckWorker(
  input: AdmissionPrecheckWorkerInput,
  options: { spawnPlan?: SidecarSpawnPlan } = {},
): Promise<ManagedSpawnResult> {
  const plan = options.spawnPlan ?? buildAdmissionPrecheckSpawnPlan();
  const args = [...plan.args];
  const env = {
    ...process.env,
    ...plan.env,
    [ADMISSION_PRECHECK_WORKER_INPUT_ENV]: JSON.stringify(input),
  };
  return managedSpawn(
    plan.cmd,
    args,
    {
      class: 'test-run',
      title: `R6 admission pre-check ${input.operationId}`,
      argv: [plan.cmd, ...args],
      cwd: input.integrationRoot,
      launchedBy: 'release:repair-queue:admission-precheck',
      detail: { operationId: input.operationId, subsystem: 'frozen-repair-admission-precheck' },
      runtimeMaxSec: Math.max(1, Math.ceil((input.expiresAtMs - Date.now()) / 1000)),
    },
    {
      taskId: input.taskId,
      workspaceId: input.queueTarget.workspaceId,
      spawnOptions: { cwd: input.integrationRoot, env, stdio: 'ignore' },
    },
  );
}

export async function persistAdmissionPrecheckProgress(
  queueTarget: AdmissionPrecheckQueueTarget,
  operationId: string,
  progress: FixPrecheckProgress,
): Promise<void> {
  await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) =>
    admissionPrecheckProgressTransition(fresh, operationId, progress));
}

export async function settleAdmissionPrecheck(
  queueTarget: AdmissionPrecheckQueueTarget,
  operationId: string,
  verdict: FixPrecheckVerdict,
): Promise<void> {
  const settledAtMs = Date.now();
  await applyFrozenCandidateRepairQueueTransition(queueTarget, (fresh) =>
    admissionPrecheckSettlementTransition(fresh, operationId, verdict, settledAtMs));
}

export function admissionPrecheckProgressTransition(
  fresh: FrozenCandidateRepairQueue,
  operationId: string,
  progress: FixPrecheckProgress,
): FrozenCandidateRepairQueue {
  const current = fresh.admissionPrecheck;
  if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
  const updatedAtMs = Math.max(fresh.updatedAtMs + 1, progress.heartbeatAtMs);
  return {
    ...fresh,
    updatedAtMs,
    admissionPrecheck: {
      ...current,
      currentFile: progress.currentFile,
      completedCount: progress.completedCount,
      totalCount: progress.totalCount,
      heartbeatAtMs: progress.heartbeatAtMs,
      updatedAtMs,
    },
  };
}

export function admissionPrecheckSettlementTransition(
  fresh: FrozenCandidateRepairQueue,
  operationId: string,
  verdict: FixPrecheckVerdict,
  settledAtMs: number,
): FrozenCandidateRepairQueue {
  const current = fresh.admissionPrecheck;
  if (!current || current.operationId !== operationId || current.status !== 'running') return fresh;
  const { dispatchReservation, ...rest } = fresh;
  return {
    ...rest,
    ...(dispatchReservation?.token === operationId ? {} : { dispatchReservation }),
    admissionPrecheck: {
      ...current,
      status: verdict.ok ? (verdict.ran ? 'passed' : 'deferred') : 'failed',
      verdict,
      updatedAtMs: settledAtMs,
    },
    updatedAtMs: Math.max(fresh.updatedAtMs + 1, settledAtMs),
  };
}

export interface AdmissionPrecheckWorkerDeps {
  getTask: (taskId: string) => Promise<Pick<TaskRow, 'state' | 'confined'> | null>;
  readQueue: (target: AdmissionPrecheckQueueTarget) => Promise<FrozenCandidateRepairQueueRead>;
  transition: (
    target: AdmissionPrecheckQueueTarget,
    update: (fresh: FrozenCandidateRepairQueue) => FrozenCandidateRepairQueue,
  ) => Promise<unknown>;
  createRunner: (options: { integrationRoot: string; checkpointRoot: string }) => (
    input: {
      commit: string;
      files: readonly string[];
      onProgress?: (progress: FixPrecheckProgress) => Promise<void> | void;
    },
  ) => Promise<FixPrecheckRunResult>;
  now?: () => number;
}

export type AdmissionPrecheckWorkerOutcome =
  | { status: 'settled'; verdict: FixPrecheckVerdict }
  | { status: 'ignored'; reason: string };

const defaultWorkerDeps: AdmissionPrecheckWorkerDeps = {
  getTask,
  readQueue: readFrozenCandidateRepairQueueState,
  transition: applyFrozenCandidateRepairQueueTransition,
  createRunner: createCheckpointTreeFixPrecheckRunner,
};

export async function runAdmissionPrecheckWorker(
  input: AdmissionPrecheckWorkerInput,
  deps: AdmissionPrecheckWorkerDeps = defaultWorkerDeps,
): Promise<AdmissionPrecheckWorkerOutcome> {
  const task = await deps.getTask(input.taskId);
  if (!task || !task.confined || (task.state !== 'pending' && task.state !== 'running')) {
    return { status: 'ignored', reason: 'managed task is absent, unconfined, or no longer live' };
  }

  const read = await deps.readQueue(input.queueTarget);
  if (read.status !== 'value') return { status: 'ignored', reason: `repair queue is ${read.status}` };
  const queue = read.queue;
  const operation = queue.admissionPrecheck;
  if (
    !operation || operation.operationId !== input.operationId || operation.runnerTaskId !== input.taskId ||
    operation.status !== 'running'
  ) {
    return { status: 'ignored', reason: 'operationId no longer names the running queue pre-check' };
  }

  const population = precheckPopulation({
    signature: queue.signature as readonly RepairSignatureEntry[],
    admittedPaths: operation.files,
  });
  const runner = deps.createRunner({
    integrationRoot: input.integrationRoot,
    checkpointRoot: input.checkpointRoot,
  });
  let run: FixPrecheckRunResult;
  try {
    run = await runner({
      commit: operation.builtCommit,
      files: operation.files,
      onProgress: async (progress) => {
        await deps.transition(input.queueTarget, (fresh) =>
          admissionPrecheckProgressTransition(fresh, input.operationId, progress));
      },
    });
  } catch (error) {
    run = {
      ran: false,
      reason: 'runner-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const verdict = evaluateFixPrecheck(population, run);
  const settledAtMs = (deps.now ?? Date.now)();
  await deps.transition(input.queueTarget, (fresh) =>
    admissionPrecheckSettlementTransition(fresh, input.operationId, verdict, settledAtMs));
  return { status: 'settled', verdict };
}

export function parseAdmissionPrecheckWorkerInput(raw: string | undefined): AdmissionPrecheckWorkerInput | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const target = row.queueTarget;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    const queueTarget = target as Record<string, unknown>;
    if (
      typeof row.operationId !== 'string' || !row.operationId.trim() ||
      typeof row.taskId !== 'string' || !row.taskId.trim() ||
      typeof queueTarget.workspaceId !== 'string' || !queueTarget.workspaceId.trim() ||
      typeof queueTarget.installSlug !== 'string' || !queueTarget.installSlug.trim() ||
      typeof row.integrationRoot !== 'string' || !row.integrationRoot.trim() ||
      typeof row.checkpointRoot !== 'string' || !row.checkpointRoot.trim() ||
      typeof row.expiresAtMs !== 'number' || !Number.isFinite(row.expiresAtMs) || row.expiresAtMs < 0
    ) return null;
    return {
      operationId: row.operationId,
      taskId: row.taskId,
      queueTarget: { workspaceId: queueTarget.workspaceId, installSlug: queueTarget.installSlug },
      integrationRoot: row.integrationRoot,
      checkpointRoot: row.checkpointRoot,
      expiresAtMs: row.expiresAtMs,
    };
  } catch {
    return null;
  }
}

export async function runAdmissionPrecheckWorkerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const input = parseAdmissionPrecheckWorkerInput(env[ADMISSION_PRECHECK_WORKER_INPUT_ENV]);
  if (!input) {
    console.error('[release:repair-queue] worker input is missing or invalid');
    return 2;
  }
  try {
    const result = await runAdmissionPrecheckWorker(input);
    if (result.status === 'ignored') console.warn(`[release:repair-queue] pre-check ${input.operationId} ignored: ${result.reason}`);
    return 0;
  } catch (error) {
    console.error(`[release:repair-queue] pre-check ${input.operationId} worker failed`, error);
    return 1;
  }
}
