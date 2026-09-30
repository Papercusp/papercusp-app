/**
 * backup-workflow — P-011 of `dbos-durable-flows-adoption-2026-06-02` (D-010).
 *
 * Makes the workspace `snapshot()` op durable via a GENERIC, zero-dep seam
 * rather than coupling the borrowable `@papercusp/backup` lib to DBOS:
 *
 *  - `wireBackupStepRunner()` injects a DBOS-backed `StepRunner` into the lib
 *    (`runStep → DBOS.runStep`). The lib's `snapshot()` calls `runStep(name, fn)`
 *    around each side-effectful phase (insert-row, pre-snapshot-hook, kopia
 *    create, record-result), so when the op runs inside this workflow each phase
 *    becomes a checkpointed step and a crash mid-snapshot RESUMES from the last
 *    completed step instead of double-inserting / re-running kopia. The runner is
 *    guarded by `DBOS.isInWorkflow()`, so a `snapshot()` called OUTSIDE a
 *    workflow (the cadence tick — already a step in the timers arc — or a direct
 *    call) is an exact pass-through. The lib never imports DBOS → its borrowable
 *    "zero @papercusp/@restart deps" contract is preserved.
 *
 *  - `backupSnapshotWorkflow` is the durable envelope. The manual
 *    `backup:snapshot_create` op routes through `startBackupSnapshotWorkflow`
 *    when `dbosBackupActive()` + DBOS is launched; otherwise it calls
 *    `snapshot()` directly (A/B + instant revert by un-setting the flag).
 *
 * Testability mirrors `provision-workflow`: the snapshot executor is INJECTABLE
 * (`setBackupSnapshotExecutor`), defaulting to the real per-workspace snapshot.
 * The integration test injects a counting stub so the DBOS durable-result /
 * resume mechanics are proven against a live DBOS WITHOUT a kopia binary.
 *
 * Per D-010, the destructive restore/promote/rollback ops are NOT routed here —
 * they are non-idempotent FS renames and need idempotent decomposition first
 * (P-012, with the user) before a StepRunner buys them resume.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import {
  configureBackupStepRunner,
  workspaceBackupFor,
  type SnapshotResult,
  type SnapshotTriggerReason,
  type WorkspaceBackup,
} from '@papercusp/backup';

export interface BackupSnapshotWorkflowInput {
  workspaceId: string;
  reason: SnapshotTriggerReason;
  context?: Record<string, unknown>;
}

/**
 * Per-request workflow id. Pure (unit-tested): a per-request `nonce` makes each
 * manual snapshot its OWN resumable workflow (DBOS recovery resumes exactly this
 * run; a later snapshot is a fresh workflow). Unlike provision there is no
 * per-target dedup mutex — concurrent manual snapshots keep today's "both run"
 * behavior; this change adds durability, not new concurrency semantics.
 */
export function backupSnapshotWorkflowId(input: BackupSnapshotWorkflowInput, nonce: string): string {
  return `backup-snapshot:${input.workspaceId}:${input.reason}:${nonce}`;
}

/**
 * Install the DBOS-backed durability runner into `@papercusp/backup`. Guarded by
 * `DBOS.isInWorkflow()` (true only when inside a workflow that isn't already in a
 * step), so every `snapshot()` call NOT made through `backupSnapshotWorkflow` is
 * an exact pass-through — including the cadence tick (which already runs inside a
 * timers-arc step) and any direct call. Defensive: if DBOS hasn't launched, treat
 * as "not in a workflow" and pass through.
 */
export function wireBackupStepRunner(): void {
  configureBackupStepRunner({
    runStep: (name, fn) => {
      let inWorkflow = false;
      try {
        inWorkflow = DBOS.isInWorkflow();
      } catch {
        inWorkflow = false;
      }
      return inWorkflow ? DBOS.runStep(fn, { name }) : fn();
    },
  });
}

export type BackupSnapshotExecutor = (
  workspaceId: string,
  reason: SnapshotTriggerReason,
  context: Record<string, unknown> | undefined,
) => Promise<SnapshotResult>;

// Default executor = the real per-workspace snapshot. Tests inject a stub so the
// DBOS mechanics are proven without spawning kopia.
let _executor: BackupSnapshotExecutor | null = null;
export function setBackupSnapshotExecutor(fn: BackupSnapshotExecutor | null): void {
  _executor = fn;
}
async function execute(
  workspaceId: string,
  reason: SnapshotTriggerReason,
  context: Record<string, unknown> | undefined,
): Promise<SnapshotResult> {
  if (_executor) return _executor(workspaceId, reason, context);
  return workspaceBackupFor(workspaceId).snapshot(reason, context);
}

async function backupSnapshotImpl(input: BackupSnapshotWorkflowInput): Promise<SnapshotResult> {
  // The durability comes from snapshot()'s INTERNAL runStep boundaries (via the
  // injected runner), not from wrapping the whole op as one step — so a resume
  // re-enters here and the completed inner steps replay their cached results.
  return execute(input.workspaceId, input.reason, input.context);
}

export const backupSnapshotWorkflow = idempotentRegisterWorkflow('backupSnapshot', () =>
  DBOS.registerWorkflow(backupSnapshotImpl, {
    name: 'backupSnapshot',
    maxRecoveryAttempts: 5,
  }),
);

/**
 * Start a snapshot as a durable workflow and await its result, keeping the
 * caller's synchronous request→result contract.
 */
export async function startBackupSnapshotWorkflow(
  input: BackupSnapshotWorkflowInput,
  nonce: string,
): Promise<SnapshotResult> {
  const handle = await DBOS.startWorkflow(backupSnapshotWorkflow, {
    workflowID: backupSnapshotWorkflowId(input, nonce),
  })(input);
  return handle.getResult();
}

// ---------------------------------------------------------------------------
// The destructive trio (P-012) — restoreInPlace / promoteRestore / rollback.
//
// Same shape as the snapshot workflow: a durable envelope with an injectable
// executor (tests inject a stub so the DBOS mechanics are proven without real
// kopia / FS moves). The crash-resume value comes from the LIB methods, which
// now run their phases through the injected StepRunner and (for promote /
// rollback) derive deterministic `.broken-/.rolled-back-` names from an `opId`.
// We pass the per-request `nonce` as BOTH the workflowID suffix AND the `opId`,
// so a DBOS resume re-runs with the same input → the same deterministic paths →
// the lib's idempotent swap completes from wherever the crash left off.
// ---------------------------------------------------------------------------

type RestoreInPlaceResult = Awaited<ReturnType<WorkspaceBackup['restoreInPlace']>>;
type PromoteResult = Awaited<ReturnType<WorkspaceBackup['promoteRestore']>>;
type RollbackResult = Awaited<ReturnType<WorkspaceBackup['rollbackPromote']>>;

export interface BackupRestoreInPlaceInput {
  workspaceId: string;
  kopiaSnapshotId: string;
  target?: string;
  skipSafetySnapshot?: boolean;
}
export interface BackupPromoteInput {
  workspaceId: string;
  restoredPath: string;
  liveTarget?: string;
  /** Stable per-request id (= the workflow nonce) → deterministic broken-dir name. */
  opId: string;
}
export interface BackupRollbackInput {
  workspaceId: string;
  brokenPath: string;
  /** Stable per-request id (= the workflow nonce) → deterministic stash-dir name. */
  opId: string;
}

/**
 * Register one destructive-op workflow: a default executor (the real lib
 * method), a test-injectable override, and a `start(input, nonce)` that keys
 * the workflow by a per-request id so a crash resumes exactly that op.
 */
function registerBackupOp<I extends { workspaceId: string }, R>(
  name: string,
  defaultRun: (input: I) => Promise<R>,
) {
  let exec: ((input: I) => Promise<R>) | null = null;
  const impl = async (input: I): Promise<R> => (exec ? exec(input) : defaultRun(input));
  const workflow = idempotentRegisterWorkflow(name, () =>
    DBOS.registerWorkflow(impl, { name, maxRecoveryAttempts: 5 }),
  );
  return {
    setExecutor: (fn: ((input: I) => Promise<R>) | null): void => {
      exec = fn;
    },
    start: async (input: I, nonce: string): Promise<R> => {
      const handle = await DBOS.startWorkflow(workflow, {
        workflowID: `${name}:${input.workspaceId}:${nonce}`,
      })(input);
      return handle.getResult();
    },
  };
}

const restoreInPlaceOp = registerBackupOp<BackupRestoreInPlaceInput, RestoreInPlaceResult>(
  'backup-restore-in-place',
  (i) =>
    workspaceBackupFor(i.workspaceId).restoreInPlace({
      kopiaSnapshotId: i.kopiaSnapshotId,
      target: i.target,
      skipSafetySnapshot: i.skipSafetySnapshot,
    }),
);
const promoteOp = registerBackupOp<BackupPromoteInput, PromoteResult>(
  'backup-promote',
  (i) =>
    workspaceBackupFor(i.workspaceId).promoteRestore({
      restoredPath: i.restoredPath,
      liveTarget: i.liveTarget,
      opId: i.opId,
    }),
);
const rollbackOp = registerBackupOp<BackupRollbackInput, RollbackResult>(
  'backup-rollback',
  (i) => workspaceBackupFor(i.workspaceId).rollbackPromote({ brokenPath: i.brokenPath, opId: i.opId }),
);

export const setRestoreInPlaceExecutor = restoreInPlaceOp.setExecutor;
export const setPromoteExecutor = promoteOp.setExecutor;
export const setRollbackExecutor = rollbackOp.setExecutor;

export function startBackupRestoreInPlaceWorkflow(
  input: BackupRestoreInPlaceInput,
  nonce: string,
): Promise<RestoreInPlaceResult> {
  return restoreInPlaceOp.start(input, nonce);
}
export function startBackupPromoteWorkflow(
  input: Omit<BackupPromoteInput, 'opId'>,
  nonce: string,
): Promise<PromoteResult> {
  return promoteOp.start({ ...input, opId: nonce }, nonce);
}
export function startBackupRollbackWorkflow(
  input: Omit<BackupRollbackInput, 'opId'>,
  nonce: string,
): Promise<RollbackResult> {
  return rollbackOp.start({ ...input, opId: nonce }, nonce);
}
