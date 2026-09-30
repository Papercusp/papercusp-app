/**
 * Durable dispatch for the backup destructive trio (dbos-durable-flows-adoption
 * P-012). One place that decides, per call, whether to run restoreInPlace /
 * promoteRestore / rollbackPromote as a crash-resumable DBOS workflow (when the
 * backup flag is opted-in AND DBOS has launched), refuse an opted-in operation
 * before its executor launches, or call the lib directly when the flag is off.
 * Every operator
 * entry point (the MCP tools + the HTTP routes) goes through these helpers so
 * the A/B decision lives in exactly one place.
 *
 * The DBOS workflow + the lib's idempotent step decomposition are imported
 * lazily so the heavy DBOS graph only loads on the durable path.
 */
import { randomBytes } from 'node:crypto';
import { workspaceBackupFor } from '.';
import { dbosBackupActive } from '../dbos/dbos-flags';
import { dbosStarted } from '../dbos/bootstrap';

const nonce = (): string => Date.now().toString(36) + randomBytes(4).toString('hex');
const durable = (): boolean => {
  if (!dbosBackupActive()) return false;
  if (!dbosStarted()) {
    throw new Error('backup durability enabled, executor unavailable; no backup operation started');
  }
  return true;
};

export async function durableRestoreInPlace(
  workspaceId: string,
  args: { kopiaSnapshotId: string; target?: string; skipSafetySnapshot?: boolean },
) {
  if (durable()) {
    const { startBackupRestoreInPlaceWorkflow } = await import('../dbos/backup-workflow');
    return startBackupRestoreInPlaceWorkflow({ workspaceId, ...args }, nonce());
  }
  return workspaceBackupFor(workspaceId).restoreInPlace(args);
}

export async function durablePromoteRestore(
  workspaceId: string,
  args: { restoredPath: string; liveTarget?: string },
) {
  if (durable()) {
    const { startBackupPromoteWorkflow } = await import('../dbos/backup-workflow');
    return startBackupPromoteWorkflow({ workspaceId, ...args }, nonce());
  }
  return workspaceBackupFor(workspaceId).promoteRestore(args);
}

export async function durableRollbackPromote(workspaceId: string, args: { brokenPath: string }) {
  if (durable()) {
    const { startBackupRollbackWorkflow } = await import('../dbos/backup-workflow');
    return startBackupRollbackWorkflow({ workspaceId, ...args }, nonce());
  }
  return workspaceBackupFor(workspaceId).rollbackPromote(args);
}
