import { WorkspaceBackup } from './workspace-backup';

const CACHE = new Map<string, WorkspaceBackup>();

export function workspaceBackupFor(workspaceId: string): WorkspaceBackup {
  let inst = CACHE.get(workspaceId);
  if (!inst) {
    inst = new WorkspaceBackup({ workspaceId });
    CACHE.set(workspaceId, inst);
  }
  return inst;
}
