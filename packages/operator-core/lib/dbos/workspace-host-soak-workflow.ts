/**
 * Durable workspace-host soak (D-391, byoc-cloud-workspaces-gcp-aws-azure-2026-08-22).
 *
 * Its OWN workflow and queue, deliberately not the provisioning queue: that queue's dedup id is
 * host-scoped, so a 24h soak there would lock every lifecycle action on the host out for a day.
 * Here the dedup id is `soak:<workspace>:<host>` — one soak per host, lifecycle untouched.
 *
 * The loop is `runWorkspaceHostSoak` over an injected runtime so its schedule, early stop and
 * receipt settlement are testable without DBOS; the registered workflow binds that runtime to
 * `DBOS.runStep` / `DBOS.sleep`, which is what makes a day-long soak survive controller restarts.
 */
import { randomUUID } from 'node:crypto';
import { DBOS, WorkflowQueue } from '@dbos-inc/dbos-sdk';
import {
  evaluateWorkspaceHostSoak,
  pinWorkspaceHostSoakSubject,
  probeWorkspaceHostSoakSample,
  type WorkspaceHostSoakEvaluation,
  type WorkspaceHostSoakInstanceReading,
  type WorkspaceHostSoakPolicy,
  type WorkspaceHostSoakProbe,
  type WorkspaceHostSoakSample,
  type WorkspaceHostSoakSubject,
} from '../workspace-host/soak';
import { readWorkspaceHostSoak, recordWorkspaceHostSoakSample } from '../workspace-host/soak-store';
import { resolveWorkspaceHostSoakSeams } from '../workspace-host/soak-seams';
import type { WorkspaceHostReleaseBinding } from '../workspace-host/release-stage-receipt';
import { beginWorkspaceHostSoakReceipt, settleWorkspaceHostSoakReceipt } from '../workspace-host/soak-receipt';
import { idempotentRegisterWorkflow, idempotentWorkflowQueue } from './idempotent-register-workflow';
import { queueConcurrency } from './queue-concurrency';

/** Registered workflow name AND queue name. */
export const WORKSPACE_HOST_SOAK_WORKFLOW_NAME = 'workspace-host-soak';

const QUEUE_DEDUP_DUPLICATED_CODE = 28;

export interface WorkspaceHostSoakWorkflowInput {
  workspaceId: string;
  hostId: string;
  soakId: string;
  policy: WorkspaceHostSoakPolicy;
  /** Present => the soak settles `acceptance.soak-24h` on this release task. */
  releaseBinding: WorkspaceHostReleaseBinding | null;
  requestedAt: string;
}

export interface WorkspaceHostSoakWorkflowResult {
  soakId: string;
  hostId: string;
  subject: WorkspaceHostSoakSubject;
  evaluation: WorkspaceHostSoakEvaluation;
  receipt: 'committed' | 'refused' | 'none';
}

interface SoakSeams {
  readInstance(): Promise<WorkspaceHostSoakInstanceReading>;
  probeFor(subject: WorkspaceHostSoakSubject): WorkspaceHostSoakProbe;
}

export interface WorkspaceHostSoakRuntime {
  /** A checkpointed step: on replay its recorded result is returned without re-running `fn`. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** A durable sleep that survives a controller restart. */
  sleep(ms: number): Promise<void>;
  /** Wall clock, read ONLY inside steps so a replay sees the recorded value. */
  now(): number;
  resolveSeams(input: { workspaceId: string; hostId: string }): Promise<SoakSeams>;
  recordSample: typeof recordWorkspaceHostSoakSample;
  readSoak: typeof readWorkspaceHostSoak;
  beginReceipt: typeof beginWorkspaceHostSoakReceipt;
  settleReceipt: typeof settleWorkspaceHostSoakReceipt;
}

/** A probe whose every reading fails with the controller-side error that prevented it. */
function unavailableProbe(error: unknown, now: () => number): WorkspaceHostSoakProbe {
  return {
    readInstance: () => Promise.reject(error),
    probeReach: () => Promise.reject(error),
    now: () => new Date(now()),
  };
}

export async function runWorkspaceHostSoak(
  input: WorkspaceHostSoakWorkflowInput,
  runtime: WorkspaceHostSoakRuntime,
): Promise<WorkspaceHostSoakWorkflowResult> {
  const { policy } = input;
  const subject = await runtime.step('soak-pin', async () => {
    const seams = await runtime.resolveSeams(input);
    return pinWorkspaceHostSoakSubject(
      { workspaceId: input.workspaceId, hostId: input.hostId, soakId: input.soakId },
      await seams.readInstance(),
    );
  });
  const receipt = input.releaseBinding
    ? await runtime.step('soak-receipt-begin', () => runtime.beginReceipt(input.releaseBinding!, policy))
    : null;
  const envelope = { policy, releaseTaskId: input.releaseBinding?.taskId ?? null };

  // Bounded turn budget: twice the expected sample count covers any catch-up after downtime.
  const maxSamples = 2 * (Math.floor(policy.durationMs / policy.intervalMs) + 1);
  const samples: WorkspaceHostSoakSample[] = [];
  let firstAtMs: number | null = null;
  for (let sequence = 0; sequence < maxSamples; sequence += 1) {
    const taken = await runtime.step(`soak-sample-${sequence}`, async () => {
      const probe = await runtime.resolveSeams(input).then(
        (seams) => seams.probeFor(subject),
        (error: unknown) => unavailableProbe(error, runtime.now),
      );
      const sample = await probeWorkspaceHostSoakSample(subject, sequence, probe);
      await runtime.recordSample({ workspaceId: input.workspaceId, hostId: input.hostId, sample, envelope });
      return { sample, finishedAtMs: runtime.now() };
    });
    samples.push(taken.sample);
    firstAtMs ??= Date.parse(taken.sample.observedAt);
    if (evaluateWorkspaceHostSoak({ samples, policy }).verdict !== 'running') break;
    // Scheduled against the FIRST sample, not "interval after this one finished": a probe can
    // take ~90s, and interval-after-finish drift would leave a 24h soak short of its coverage.
    const nextAtMs = firstAtMs + (sequence + 1) * policy.intervalMs;
    await runtime.sleep(Math.max(0, nextAtMs - taken.finishedAtMs));
  }

  // The verdict comes from what was PERSISTED, never from the in-memory list above.
  const evaluation = await runtime.step('soak-evaluate', async () => {
    const record = await runtime.readSoak(input.workspaceId, input.hostId, input.soakId);
    return evaluateWorkspaceHostSoak({ samples: record.samples, policy, ended: true });
  });
  if (input.releaseBinding && receipt) {
    await runtime.step('soak-receipt-settle', () =>
      runtime.settleReceipt({
        binding: input.releaseBinding!,
        policy,
        requestIdentity: receipt.requestIdentity,
        subject,
        evaluation,
      }),
    );
  }
  return {
    soakId: input.soakId,
    hostId: input.hostId,
    subject,
    evaluation,
    receipt: receipt ? (evaluation.verdict === 'pass' ? 'committed' : 'refused') : 'none',
  };
}

function dbosRuntime(): WorkspaceHostSoakRuntime {
  return {
    step: (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: true, maxAttempts: 3, intervalSeconds: 5 }),
    sleep: (ms) => DBOS.sleep(ms),
    now: () => Date.now(),
    resolveSeams: (input) => resolveWorkspaceHostSoakSeams(input),
    recordSample: recordWorkspaceHostSoakSample,
    readSoak: readWorkspaceHostSoak,
    beginReceipt: beginWorkspaceHostSoakReceipt,
    settleReceipt: settleWorkspaceHostSoakReceipt,
  };
}

async function workspaceHostSoakWorkflowImpl(
  input: WorkspaceHostSoakWorkflowInput,
): Promise<WorkspaceHostSoakWorkflowResult> {
  return runWorkspaceHostSoak(input, dbosRuntime());
}

export const workspaceHostSoakWorkflow = idempotentRegisterWorkflow(WORKSPACE_HOST_SOAK_WORKFLOW_NAME, () =>
  DBOS.registerWorkflow(workspaceHostSoakWorkflowImpl, {
    name: WORKSPACE_HOST_SOAK_WORKFLOW_NAME,
    maxRecoveryAttempts: 50,
  }),
);

export const workspaceHostSoakQueue = idempotentWorkflowQueue(
  WORKSPACE_HOST_SOAK_WORKFLOW_NAME,
  () => new WorkflowQueue(WORKSPACE_HOST_SOAK_WORKFLOW_NAME, { concurrency: queueConcurrency(2) }),
);

export function workspaceHostSoakWorkflowKeys(input: { workspaceId: string; hostId: string; soakId: string }): {
  workflowId: string;
  deduplicationId: string;
} {
  return {
    workflowId: `${WORKSPACE_HOST_SOAK_WORKFLOW_NAME}:${input.workspaceId}:${input.hostId}:${input.soakId}`,
    deduplicationId: `soak:${input.workspaceId}:${input.hostId}`,
  };
}

export class WorkspaceHostSoakConflictError extends Error {
  constructor(readonly hostId: string) {
    super(`Workspace host '${hostId}' already has a soak in progress`);
    this.name = 'WorkspaceHostSoakConflictError';
  }
}

export interface StartWorkspaceHostSoakInput {
  workspaceId: string;
  hostId: string;
  policy: WorkspaceHostSoakPolicy;
  releaseBinding: WorkspaceHostReleaseBinding | null;
  soakId?: string;
}

/** Durably enqueue and return; a soak's result is read from its samples, never awaited here. */
export async function startWorkspaceHostSoakWorkflow(
  input: StartWorkspaceHostSoakInput,
): Promise<{ status: 'accepted'; soakId: string; workflowId: string; hostId: string }> {
  const soakId = input.soakId ?? randomUUID();
  const keys = workspaceHostSoakWorkflowKeys({ ...input, soakId });
  const workflowInput: WorkspaceHostSoakWorkflowInput = {
    workspaceId: input.workspaceId,
    hostId: input.hostId,
    soakId,
    policy: input.policy,
    releaseBinding: input.releaseBinding,
    requestedAt: new Date().toISOString(),
  };
  try {
    await DBOS.startWorkflow(workspaceHostSoakWorkflow, {
      workflowID: keys.workflowId,
      queueName: workspaceHostSoakQueue.name,
      enqueueOptions: { deduplicationID: keys.deduplicationId },
    })(workflowInput);
  } catch (error) {
    if ((error as { dbosErrorCode?: number } | null)?.dbosErrorCode === QUEUE_DEDUP_DUPLICATED_CODE) {
      throw new WorkspaceHostSoakConflictError(input.hostId);
    }
    throw error;
  }
  return { status: 'accepted', soakId, workflowId: keys.workflowId, hostId: input.hostId };
}
