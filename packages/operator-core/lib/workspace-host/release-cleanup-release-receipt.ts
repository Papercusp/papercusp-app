/** The D-396 `release.cleanup` measurement and journal writer (WI-10002510). */
import { getOrgPg } from '@papercusp/db-org';
import type { WorkspaceHostDesiredSpec } from '@papercusp/deployment-driver';
import { workspaceHostWorkflowKeys } from '@papercusp/deployment-driver';
import type { Sql } from 'postgres';
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import {
  appendTaskReleaseReceipt,
  getTask,
  taskReleaseJournalFromDetail,
  type TaskReleaseJournal,
} from '../task-manager/store';
import { resolveGcpWorkspaceHostInstanceIdentity } from './gcp-provider';
import {
  pruneGcpIapHostKeysForAbsentHost,
  resolveWorkspaceHostInitializationControllerProfile,
  type GcpIapHostKeyPruneInput,
  type GcpIapHostKeyPruneResult,
  type WorkspaceHostInitializationControllerProfile,
} from './initialization-operations-resolver';
import { openWorkspaceHostReleaseRecorder, type WorkspaceHostReleaseStage } from './release-stage-receipt';
import { readWorkspaceHostRuntimeRelease } from './soak-store';

export const WORKSPACE_HOST_RELEASE_CLEANUP_STAGE = 'release.cleanup';
export const WORKSPACE_HOST_RELEASE_CLEANUP_CONTRACT = 'workspace-host-release-cleanup-v1';

const TASK_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface WorkspaceHostReleaseCleanupInput {
  workspaceId: string;
  hostId: string;
  releaseTaskId: string;
  sql?: Sql;
  ledger?: ReleaseTaskLedger;
  readHostRuntimeRelease?: (workspaceId: string, hostId: string) => Promise<unknown>;
  resolveControllerProfile?: () => Pick<WorkspaceHostInitializationControllerProfile, 'knownHostsFile'>;
  pruneControllerPins?: (input: GcpIapHostKeyPruneInput) => Promise<GcpIapHostKeyPruneResult>;
}

export interface WorkspaceHostReleaseCleanupReceipt {
  outcome: 'committed' | 'refused';
  stage: typeof WORKSPACE_HOST_RELEASE_CLEANUP_STAGE;
  releaseTaskId: string;
  hostId: string;
  bundleSha256: string;
  evidenceRefs: string[];
}

export class WorkspaceHostReleaseCleanupError extends Error {
  constructor(readonly reason: 'invalid-input' | 'release-task-not-found' | 'release-journal-missing', detail: string) {
    super(detail);
    this.name = 'WorkspaceHostReleaseCleanupError';
  }
}

interface CleanupHostRow {
  target: string;
  desired_state: string;
  observed_state: string;
  observed_revision: number | string;
  desired_revision: number | string;
  desired_spec: unknown;
}

interface CleanupOperationRow {
  id: string;
  status: string;
}

interface CleanupWorkflowRow {
  workflow_uuid: string;
  status: string;
}

interface CleanupSnapshot {
  host: CleanupHostRow | null;
  operations: CleanupOperationRow[];
  workflows: CleanupWorkflowRow[];
  journal: TaskReleaseJournal | null;
  failures: string[];
}

function defaultLedger(): ReleaseTaskLedger {
  return { getTask, taskReleaseJournalFromDetail, appendTaskReleaseReceipt };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function workspaceHostReleaseCleanupStage(bundleSha256: string): WorkspaceHostReleaseStage {
  return {
    stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
    identity: {
      bundleSha256,
      cleanupContract: WORKSPACE_HOST_RELEASE_CLEANUP_CONTRACT,
    },
  };
}

function lifecycleWorkflowPrefix(workspaceId: string, hostId: string): string {
  const example = workspaceHostWorkflowKeys({ workspaceId, hostId, operationId: 'release-cleanup-probe' }).workflowId;
  const separator = ':operation:';
  const offset = example.lastIndexOf(separator);
  return offset < 0 ? example : example.slice(0, offset + separator.length);
}

function soakWorkflowPrefix(workspaceId: string, hostId: string): string {
  // workspaceHostSoakWorkflowKeys uses this exact identity in dbos/workspace-host-soak-workflow.ts.
  return `workspace-host-soak:${encodeURIComponent(workspaceId)}:${encodeURIComponent(hostId)}:`;
}

function unresolvedOtherStageIntents(journal: TaskReleaseJournal): TaskReleaseJournal['receipts'] {
  const latestByRequest = new Map<string, TaskReleaseJournal['receipts'][number]>();
  for (const receipt of journal.receipts) {
    latestByRequest.set(`${receipt.stage}\0${receipt.requestIdentity}`, receipt);
  }
  return [...latestByRequest.values()].filter(
    (receipt) => receipt.stage !== WORKSPACE_HOST_RELEASE_CLEANUP_STAGE && receipt.state === 'intent',
  );
}

async function readCleanupSnapshot(input: {
  workspaceId: string;
  hostId: string;
  releaseTaskId: string;
  sql: Sql;
  ledger: ReleaseTaskLedger;
}): Promise<CleanupSnapshot> {
  const { workspaceId, hostId, releaseTaskId, sql, ledger } = input;
  const operationPrefix = lifecycleWorkflowPrefix(workspaceId, hostId);
  const soakPrefix = soakWorkflowPrefix(workspaceId, hostId);
  const reads = await Promise.allSettled([
    sql<CleanupHostRow[]>`
      SELECT target, desired_state, observed_state, observed_revision, desired_revision, desired_spec
        FROM harness_shared.workspace_hosts
       WHERE workspace_id = ${workspaceId} AND id = ${hostId}
       LIMIT 1
    `,
    sql<CleanupOperationRow[]>`
      SELECT id, status
        FROM harness_shared.workspace_host_operations
       WHERE workspace_id = ${workspaceId}
         AND host_id = ${hostId}
         AND status IN ('queued', 'running')
       ORDER BY id
       LIMIT 100
    `,
    sql<CleanupWorkflowRow[]>`
      SELECT workflow_uuid, status
        FROM dbos.workflow_status
       WHERE status IN ('PENDING', 'ENQUEUED')
         AND (
           left(workflow_uuid, char_length(${operationPrefix})) = ${operationPrefix}
           OR left(workflow_uuid, char_length(${soakPrefix})) = ${soakPrefix}
         )
       ORDER BY workflow_uuid
       LIMIT 100
    `,
    ledger.getTask(releaseTaskId).then((task) => ({ task, journal: task ? ledger.taskReleaseJournalFromDetail(task.detail) : null })),
  ]);

  const failures: string[] = [];
  const host = reads[0].status === 'fulfilled' ? reads[0].value[0] ?? null : null;
  if (reads[0].status === 'rejected') failures.push(`host-state-read-failed:${errorName(reads[0].reason)}`);
  else if (!host) failures.push('workspace-host-row-missing');
  else if (
    host.target !== 'gcp' ||
    host.desired_state !== 'absent' ||
    host.observed_state !== 'absent' ||
    Number(host.observed_revision) !== Number(host.desired_revision)
  ) {
    failures.push(
      `host-not-absent:${host.target}:${host.desired_state}:${host.observed_state}:${host.observed_revision}/${host.desired_revision}`,
    );
  }

  const operations = reads[1].status === 'fulfilled' ? reads[1].value : [];
  if (reads[1].status === 'rejected') failures.push(`operation-read-failed:${errorName(reads[1].reason)}`);
  else if (operations.length > 0) failures.push(`live-operations:${operations.map(({ id }) => id).join(',')}`);

  const workflows = reads[2].status === 'fulfilled' ? reads[2].value : [];
  if (reads[2].status === 'rejected') failures.push(`workflow-status-read-failed:${errorName(reads[2].reason)}`);
  else if (workflows.length > 0) {
    failures.push(`live-workflows:${workflows.map(({ workflow_uuid }) => workflow_uuid).join(',')}`);
  }

  let journal: TaskReleaseJournal | null = null;
  if (reads[3].status === 'rejected') {
    failures.push(`release-journal-read-failed:${errorName(reads[3].reason)}`);
  } else if (!reads[3].value.task) {
    failures.push('release-task-not-found');
  } else if (!reads[3].value.journal) {
    failures.push('release-journal-missing');
  } else {
    journal = reads[3].value.journal;
    const unsettled = unresolvedOtherStageIntents(journal);
    if (unsettled.length > 0) {
      failures.push(`other-stage-intents:${unsettled.map(({ stage }) => stage).join(',')}`);
    }
    const billing = journal.receipts.find(
      (receipt) => receipt.stage === 'billing.closure' && receipt.state === 'committed',
    );
    if (!billing) failures.push('billing-closure-not-committed');
  }

  return { host, operations, workflows, journal, failures };
}

function snapshotEvidence(snapshot: CleanupSnapshot): string[] {
  const unsettled = snapshot.journal ? unresolvedOtherStageIntents(snapshot.journal) : [];
  return [
    ...(snapshot.host
      ? [
          `cleanup-host:${snapshot.host.target}:${snapshot.host.desired_state}:${snapshot.host.observed_state}`,
          `cleanup-revisions:${snapshot.host.observed_revision}/${snapshot.host.desired_revision}`,
        ]
      : ['cleanup-host:missing']),
    ...(snapshot.operations.length > 0
      ? snapshot.operations.map(({ id, status }) => `cleanup-operation:${id}:${status}`)
      : ['cleanup-live-operations:none']),
    ...(snapshot.workflows.length > 0
      ? snapshot.workflows.map(({ workflow_uuid, status }) => `cleanup-workflow:${workflow_uuid}:${status}`)
      : ['cleanup-live-workflows:none']),
    ...(snapshot.journal
      ? snapshot.journal.receipts
          .filter((receipt) => receipt.stage === 'billing.closure' && receipt.state === 'committed')
          .map((receipt) => `cleanup-billing-closure:sequence-${receipt.sequence}`)
      : []),
    ...(unsettled.length > 0
      ? unsettled.map(({ stage }) => `cleanup-other-stage-intent:${stage}`)
      : ['cleanup-other-stage-intents:none']),
    ...snapshot.failures.map((failure) => `cleanup-failed:${failure}`),
  ].slice(0, 60);
}

function isAbsentHost(host: CleanupHostRow | null): host is CleanupHostRow {
  return Boolean(
    host &&
      host.target === 'gcp' &&
      host.desired_state === 'absent' &&
      host.observed_state === 'absent' &&
      Number(host.observed_revision) === Number(host.desired_revision),
  );
}

/**
 * D-396's explicit, non-provider cleanup verification. The only file mutation is pruning stale SSH
 * pins for the already-absent host, under the enrollment mutex; every other condition is read-only.
 */
export async function recordWorkspaceHostReleaseCleanup(
  input: WorkspaceHostReleaseCleanupInput,
): Promise<WorkspaceHostReleaseCleanupReceipt> {
  const { workspaceId, hostId, releaseTaskId } = input;
  if (!workspaceId.trim() || !hostId.trim() || !TASK_ID.test(releaseTaskId)) {
    throw new WorkspaceHostReleaseCleanupError(
      'invalid-input',
      'release cleanup requires workspaceId, hostId, and a valid releaseTaskId',
    );
  }
  const sql = input.sql ?? getOrgPg().sql;
  const ledger = input.ledger ?? defaultLedger();
  const readRuntime = input.readHostRuntimeRelease ?? readWorkspaceHostRuntimeRelease;
  const runtime = await readRuntime(workspaceId, hostId);
  const runtimeRelease = asRecord(runtime);
  const bundleSha256 = typeof runtimeRelease?.bundleSha256 === 'string' ? runtimeRelease.bundleSha256 : '';
  const stage = workspaceHostReleaseCleanupStage(bundleSha256);
  const runRef = `release-cleanup-verification:${hostId}`;

  const priorTask = await ledger.getTask(releaseTaskId);
  if (!priorTask) {
    throw new WorkspaceHostReleaseCleanupError('release-task-not-found', 'release cleanup task not found');
  }
  const priorJournal = ledger.taskReleaseJournalFromDetail(priorTask.detail);
  if (!priorJournal) {
    throw new WorkspaceHostReleaseCleanupError('release-journal-missing', 'release cleanup journal missing');
  }
  const priorCommitted = priorJournal.receipts.find(
    (receipt) =>
      receipt.stage === WORKSPACE_HOST_RELEASE_CLEANUP_STAGE &&
      receipt.state === 'committed' &&
      receipt.evidenceRefs.includes(runRef),
  );
  const recorder = await openWorkspaceHostReleaseRecorder({
    releaseTaskId,
    workspaceId,
    hostId,
    stages: { cleanup: stage },
    runRef,
    ledger,
    readHostRuntimeRelease: async () => runtime,
  });
  if (priorCommitted) {
    return {
      outcome: 'committed',
      stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
      releaseTaskId,
      hostId,
      bundleSha256: recorder.binding.bundleSha256,
      evidenceRefs: priorCommitted.evidenceRefs,
    };
  }
  await recorder.begin('cleanup');

  const finish = async (
    outcome: 'committed' | 'refused',
    evidenceRefs: string[],
  ): Promise<WorkspaceHostReleaseCleanupReceipt> => {
    await recorder.settle('cleanup', outcome, evidenceRefs);
    return {
      outcome,
      stage: WORKSPACE_HOST_RELEASE_CLEANUP_STAGE,
      releaseTaskId,
      hostId,
      bundleSha256: recorder.binding.bundleSha256,
      evidenceRefs: [runRef, ...evidenceRefs],
    };
  };

  const checks = { workspaceId, hostId, releaseTaskId, sql, ledger };
  const before = await readCleanupSnapshot(checks);
  if (before.failures.length > 0) return finish('refused', snapshotEvidence(before));
  if (!isAbsentHost(before.host)) return finish('refused', ['cleanup-failed:host-not-absent']);
  const desired = asRecord(before.host.desired_spec) as WorkspaceHostDesiredSpec | null;
  if (!desired) return finish('refused', ['cleanup-failed:host-desired-spec-missing']);

  let pinResult: GcpIapHostKeyPruneResult;
  try {
    const controller = (input.resolveControllerProfile ?? resolveWorkspaceHostInitializationControllerProfile)();
    const prune = input.pruneControllerPins ?? pruneGcpIapHostKeysForAbsentHost;
    pinResult = await prune({
      identity: resolveGcpWorkspaceHostInstanceIdentity(desired),
      knownHostsFile: controller.knownHostsFile,
      confirmHostAbsent: async () => {
        const latest = await sql<Array<{
          desired_state: string;
          observed_state: string;
          observed_revision: number | string;
          desired_revision: number | string;
        }>>`
          SELECT desired_state, observed_state, observed_revision, desired_revision
            FROM harness_shared.workspace_hosts
           WHERE workspace_id = ${workspaceId} AND id = ${hostId}
           LIMIT 1
        `;
        const host = latest[0];
        return Boolean(
          host &&
            host.desired_state === 'absent' &&
            host.observed_state === 'absent' &&
            Number(host.observed_revision) === Number(host.desired_revision),
        );
      },
    });
  } catch (error) {
    const failed = [...snapshotEvidence(before), `cleanup-failed:controller-pins:${errorName(error)}`];
    return finish('refused', failed.slice(0, 60));
  }
  if (pinResult.remainingEntries > 0) {
    return finish('refused', [
      ...snapshotEvidence(before),
      `cleanup-failed:controller-pins-remain:${pinResult.remainingEntries}`,
      `cleanup-controller-pin-family:${pinResult.aliasFamily}`,
    ].slice(0, 60));
  }

  const after = await readCleanupSnapshot(checks);
  const evidence = [
    ...snapshotEvidence(after),
    `cleanup-controller-pin-family:${pinResult.aliasFamily}`,
    `cleanup-controller-pins-removed:${pinResult.removedEntries}`,
    `cleanup-controller-pins-remaining:${pinResult.remainingEntries}`,
  ].slice(0, 60);
  if (after.failures.length > 0 || !isAbsentHost(after.host)) return finish('refused', evidence);
  return finish('committed', evidence);
}
