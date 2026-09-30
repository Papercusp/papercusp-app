/**
 * Pre-loop checkpoint gate. Mirrors the bash:
 *
 *   for cp in "$STATE_DIR"/checkpoint-*.md; do
 *     if [ -e "${cp}.granted" ]; then
 *       rm -f "$cp" "${cp}.granted"
 *     else
 *       exit 8
 *     fi
 *   done
 *
 * As of Phase 3 of the orchestrator → PG arc, when a CheckpointsPgContext
 * is provided the gate consults `harness_shared.harness_checkpoints`
 * instead of filesystem entries. Granted checkpoints are marked consumed
 * (the PG-equivalent of unlinking both files).
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearGrantedCheckpointsPg,
  listCheckpointsPg,
  type CheckpointsPgContext,
} from './checkpoints-pg';

export type CheckpointAction =
  | { kind: 'no-checkpoints' }
  | { kind: 'granted-cleared'; cleared: string[] }
  | { kind: 'pending'; pending: string[] };

export function checkpointGate(stateDir: string): CheckpointAction;
export function checkpointGate(
  stateDir: string,
  ctx: CheckpointsPgContext,
): Promise<CheckpointAction>;
export function checkpointGate(
  stateDir: string,
  ctx?: CheckpointsPgContext,
): CheckpointAction | Promise<CheckpointAction> {
  if (ctx) return checkpointGatePg(ctx);
  return checkpointGateFs(stateDir);
}

async function checkpointGatePg(ctx: CheckpointsPgContext): Promise<CheckpointAction> {
  const status = await listCheckpointsPg(ctx);
  if (status.pending.length === 0 && status.granted.length === 0) {
    return { kind: 'no-checkpoints' };
  }
  if (status.pending.length > 0) {
    return { kind: 'pending', pending: status.pending };
  }
  // Only granted rows present — clear them and proceed.
  const cleared = await clearGrantedCheckpointsPg(ctx);
  return { kind: 'granted-cleared', cleared };
}

function checkpointGateFs(stateDir: string): CheckpointAction {
  const files = listCheckpointFiles(stateDir);
  if (files.length === 0) return { kind: 'no-checkpoints' };

  const cleared: string[] = [];
  const pending: string[] = [];

  for (const cpName of files) {
    const cpPath = join(stateDir, cpName);
    const grantedPath = `${cpPath}.granted`;
    if (existsLocal(grantedPath)) {
      try { unlinkSync(cpPath); } catch { /* ignore */ }
      try { unlinkSync(grantedPath); } catch { /* ignore */ }
      cleared.push(cpName);
    } else {
      pending.push(cpName);
    }
  }

  if (pending.length > 0) {
    return { kind: 'pending', pending };
  }
  return { kind: 'granted-cleared', cleared };
}

function listCheckpointFiles(stateDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  return entries.filter(
    (name) => name.startsWith('checkpoint-') && name.endsWith('.md'),
  );
}

function existsLocal(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
