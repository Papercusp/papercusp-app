/**
 * An in-memory release journal behind the real `ReleaseTaskLedger` seam, for tests of the
 * workspace-host release-stage writers. It enforces the two ledger rules the writers rely on:
 * compare-and-swap on the cursor, and intent -> settle transitions per request identity.
 */
import type { ReleaseTaskLedger } from '../../../../scripts/lib/release-task-journal.mjs';
import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
} from '../task-manager/store';

export const TASK_ID = 'release-task-1';
export const OPERATION_ID = 'release-operation-1';
export const SOURCE_SHA = 'a'.repeat(40);
export const GITLINKS = { 'papercusp-desktop': 'b'.repeat(40) };
export const BUNDLE = 'c'.repeat(64);
export const OTHER_BUNDLE = 'd'.repeat(64);

export function receipt(
  stage: string,
  state: TaskReleaseReceipt['state'],
  evidenceRefs: string[],
  sequence: number,
): TaskReleaseReceipt {
  return {
    sequence,
    operationId: OPERATION_ID,
    requestIdentity: `request-${sequence}`,
    stage,
    state,
    inputHash: 'e'.repeat(64),
    inputIdentity: null,
    evidenceRefs,
    credentialGeneration: null,
    credentialExpiresAt: null,
    reuseSource: null,
    lookupElapsedMs: null,
    queueWaitMs: null,
    preparationElapsedMs: null,
    reuseExpiresAt: null,
    recordedAt: new Date(0).toISOString(),
  };
}

/** A publication-only task (how r37 was published): the digest is pinned in the artifact identity. */
export function digestJournal(receipts: TaskReleaseReceipt[] = []): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { ...GITLINKS } },
    artifactIdentity: { bundleSha256: BUNDLE },
    cursor: receipts.length,
    currentStage: receipts.at(-1)?.stage ?? null,
    currentState: receipts.at(-1)?.state ?? null,
    spentOperationIds: receipts.filter((entry) => entry.state === 'intent').map((entry) => entry.requestIdentity),
    receipts,
  };
}

/** A managed cut (D-394): seeded with a LABEL identity before its build; the build receipt names the digest. */
export function labelJournal(receipts: TaskReleaseReceipt[]): TaskReleaseJournal {
  return {
    ...digestJournal(receipts),
    artifactIdentity: {
      kind: 'papercusp-workspace-host-release',
      sourceSha: SOURCE_SHA,
      version: '0.0.21-p318',
      channel: 'workspace-host-stable',
    },
  };
}

/** A committed managed build naming BUNDLE. */
export function builtReceipts(): TaskReleaseReceipt[] {
  return [
    receipt('release.build.workspace-host-linux-x86_64', 'intent', [], 0),
    receipt('release.build.workspace-host-linux-x86_64', 'committed', [`bundle:sha256:${BUNDLE}`], 1),
  ];
}

export function memoryReleaseLedger(initial: TaskReleaseJournal): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
  const state = { journal: initial };
  return {
    get journal() {
      return state.journal;
    },
    async getTask(taskId) {
      return taskId === TASK_ID ? { detail: { release: state.journal } } : null;
    },
    taskReleaseJournalFromDetail(detail) {
      return detail?.release === state.journal ? state.journal : null;
    },
    async appendTaskReleaseReceipt(taskId, expectedCursor, input): Promise<AppendTaskReleaseReceiptResult> {
      if (taskId !== TASK_ID) return { ok: false, reason: 'task_not_found', journal: null };
      if (state.journal.cursor !== expectedCursor) return { ok: false, reason: 'cursor_mismatch', journal: state.journal };
      const prior = state.journal.receipts.filter((entry) => entry.requestIdentity === input.requestIdentity).at(-1);
      const valid = input.state === 'intent' ? !prior : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state.journal };
      const appended: TaskReleaseReceipt = {
        ...receipt(input.stage, input.state, [...(input.evidenceRefs ?? [])], state.journal.cursor),
        requestIdentity: input.requestIdentity,
        inputHash: input.inputHash,
        inputIdentity: input.inputIdentity ?? null,
      };
      state.journal.receipts.push(appended);
      state.journal.cursor += 1;
      state.journal.currentStage = appended.stage;
      state.journal.currentState = appended.state;
      if (appended.state === 'intent') state.journal.spentOperationIds.push(appended.requestIdentity);
      return { ok: true, journal: state.journal, receipt: appended };
    },
  };
}
