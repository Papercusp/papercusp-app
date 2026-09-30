/**
 * Retention sweep for restore-to-clone directories.
 *
 * Restore-to-clone deliberately leaves the result under
 * `<workspace>/.restored/<snapshot>/<slug>` so it can be inspected and
 * promoted later. Unlike recovery debris, these directories do not have a
 * disposable filename suffix, so the sweep must prove both that the clone is
 * old enough and that it is not still live or referenced by a promotion.
 *
 * The filesystem walk is intentionally narrow: only direct
 * `.restored/<snapshot>/<slug>` directories are candidates. Symlinks are
 * never followed. If either the restore-event liveness read or the promotion
 * metadata read cannot complete, the sweep fails closed for that workspace.
 */

import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backupHost } from './config';

/** Keep an unpromoted clone inspectable for at least 30 days by default. */
export const DEFAULT_RESTORED_CLONE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type RestoredCloneKeepReason =
  | 'recent'
  | 'active-restore'
  | 'promotion-reference'
  | 'proof-unavailable'
  | 'changed-before-delete'
  | 'remove-failed';

export interface RestoredCloneProtection {
  path: string;
  reason: RestoredCloneKeepReason;
}

export interface RestoredCloneSweepResult {
  /** Aged clones whose safety proofs passed (or would pass) removal. */
  candidates: string[];
  /** Paths actually removed. Empty in a dry run. */
  removed: string[];
  /** Paths retained for age, proof, or removal reasons. */
  kept: string[];
  /** Why each retained path was protected. */
  protected: RestoredCloneProtection[];
  /** Bytes removed; always zero for a dry run. */
  bytesFreed: number;
  dryRun: boolean;
}

interface ProofResult<T> {
  known: boolean;
  value: T;
}

interface CloneInfo {
  path: string;
  mtimeMs: number;
}

function emptyResult(dryRun: boolean): RestoredCloneSweepResult {
  return {
    candidates: [],
    removed: [],
    kept: [],
    protected: [],
    bytesFreed: 0,
    dryRun,
  };
}

function addProtected(
  result: RestoredCloneSweepResult,
  path: string,
  reason: RestoredCloneKeepReason,
): void {
  result.kept.push(path);
  result.protected.push({ path, reason });
}

/**
 * Read the latest restore event for each target. A latest `started` event is
 * active; `done` and `failed` are terminal. Any SQL/read error is unknown,
 * rather than evidence that no restore is running.
 */
async function activeRestoreTargets(workspaceId: string): Promise<ProofResult<Set<string>>> {
  try {
    const sql = backupHost().getSql();
    const rows = await sql<{ target: string | null; phase: string | null }[]>`
      SELECT DISTINCT ON (payload_json->>'target')
             payload_json->>'target' AS target,
             payload_json->>'phase' AS phase
        FROM harness_shared.backup_events
       WHERE workspace_id = ${workspaceId}
         AND kind = 'restore'
         AND payload_json->>'target' IS NOT NULL
       ORDER BY payload_json->>'target', id DESC
    `;
    const active = new Set<string>();
    for (const row of rows) {
      if (row.phase === 'started' && row.target) active.add(resolve(row.target));
    }
    return { known: true, value: active };
  } catch {
    return { known: false, value: new Set() };
  }
}

/**
 * Read promotion sidecars beside the workspace and at the workspace root.
 * `promoteRestore` writes `<broken-dir>.meta.json` beside the live workspace;
 * the default live target is the workspace root, so its sidecar is a sibling
 * of this workspace directory rather than an entry inside it. `promotedFrom`
 * is the authoritative clone-path reference. A malformed or unreadable
 * generated sidecar invalidates the proof instead of allowing cleanup to guess.
 */
async function promotionReferences(workspaceRoot: string): Promise<ProofResult<Set<string>>> {
  try {
    const refs = new Set<string>();
    // The default live target is the workspace root, making its broken dir
    // (and sidecar) a sibling of that root. Explicit nested live targets put
    // the sidecar inside workspaceRoot. Read both locations to cover both
    // layouts while keeping the scan one level deep.
    for (const sidecarRoot of new Set([workspaceRoot, dirname(workspaceRoot)])) {
      const entries = await readdir(sidecarRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.name.startsWith('.broken-') || !entry.name.endsWith('.meta.json')) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {
          return { known: false, value: new Set() };
        }
        const body = JSON.parse(await readFile(join(sidecarRoot, entry.name), 'utf8')) as {
          promotedFrom?: unknown;
        };
        if (typeof body.promotedFrom !== 'string' || body.promotedFrom.length === 0) {
          return { known: false, value: new Set() };
        }
        refs.add(resolve(body.promotedFrom));
      }
    }
    return { known: true, value: refs };
  } catch {
    return { known: false, value: new Set() };
  }
}

async function directCloneDirectories(restoredRoot: string): Promise<CloneInfo[]> {
  const clones: CloneInfo[] = [];
  let snapshotEntries;
  try {
    snapshotEntries = await readdir(restoredRoot, { withFileTypes: true });
  } catch {
    return clones;
  }

  for (const snapshotEntry of snapshotEntries) {
    if (!snapshotEntry.isDirectory() || snapshotEntry.isSymbolicLink()) continue;
    const snapshotRoot = join(restoredRoot, snapshotEntry.name);
    let cloneEntries;
    try {
      cloneEntries = await readdir(snapshotRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const cloneEntry of cloneEntries) {
      if (!cloneEntry.isDirectory() || cloneEntry.isSymbolicLink()) continue;
      const path = join(snapshotRoot, cloneEntry.name);
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) continue;
        clones.push({ path, mtimeMs: info.mtimeMs });
      } catch {
        // A concurrent restore/removal is not a reason to widen the scan.
      }
    }
  }
  return clones;
}

/** Best-effort size that never follows a symlink. */
async function directorySize(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      total += await directorySize(join(path, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Preview or remove aged restore clones across all workspaces below
 * `workspacesRoot`.
 *
 * `dryRun` defaults to true because this is a destructive filesystem action.
 * The scheduled retention tick opts into the real pass explicitly; callers of
 * the operator tool must likewise pass `dryRun:false` after reviewing the
 * preview. `maxAgeMs` is an explicit policy input, not a hidden filename rule.
 */
export async function sweepRestoredClones(
  workspacesRoot: string,
  opts: { maxAgeMs?: number; dryRun?: boolean; nowMs?: number } = {},
): Promise<RestoredCloneSweepResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_RESTORED_CLONE_MAX_AGE_MS;
  const dryRun = opts.dryRun ?? true;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError('restored clone maxAgeMs must be a finite positive number');
  }

  const result = emptyResult(dryRun);
  const cutoff = (opts.nowMs ?? Date.now()) - maxAgeMs;
  let workspaceEntries;
  try {
    workspaceEntries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const workspaceEntry of workspaceEntries) {
    if (!workspaceEntry.isDirectory() || workspaceEntry.isSymbolicLink()) continue;
    const workspaceRoot = join(workspacesRoot, workspaceEntry.name);
    const restoredRoot = join(workspaceRoot, '.restored');
    let restoredInfo;
    try {
      restoredInfo = await lstat(restoredRoot);
    } catch {
      continue;
    }
    if (restoredInfo.isSymbolicLink() || !restoredInfo.isDirectory()) continue;

    const [liveness, references] = await Promise.all([
      activeRestoreTargets(workspaceEntry.name),
      promotionReferences(workspaceRoot),
    ]);
    const clones = await directCloneDirectories(restoredRoot);
    for (const clone of clones) {
      if (clone.mtimeMs >= cutoff) {
        addProtected(result, clone.path, 'recent');
        continue;
      }
      if (!liveness.known || !references.known) {
        addProtected(result, clone.path, 'proof-unavailable');
        continue;
      }
      const normalized = resolve(clone.path);
      if (liveness.value.has(normalized)) {
        addProtected(result, clone.path, 'active-restore');
        continue;
      }
      if (references.value.has(normalized)) {
        addProtected(result, clone.path, 'promotion-reference');
        continue;
      }

      result.candidates.push(clone.path);
      if (dryRun) continue;

      // Re-check the candidate's identity immediately before removal. A
      // symlink or a newly-created recent directory is never recursively
      // removed by this sweep.
      try {
        const current = await lstat(clone.path);
        if (current.isSymbolicLink() || !current.isDirectory()) continue;
        if (current.mtimeMs >= cutoff) {
          addProtected(result, clone.path, 'changed-before-delete');
          continue;
        }
        const sizeBefore = await directorySize(clone.path);
        await rm(clone.path, { recursive: true, force: true });
        result.removed.push(clone.path);
        result.bytesFreed += sizeBefore;
      } catch {
        addProtected(result, clone.path, 'remove-failed');
      }
    }
  }

  return result;
}

/** Scheduled host tick: the explicit retention policy runs the real pass. */
export async function sweepRestoredClonesTick(): Promise<RestoredCloneSweepResult> {
  return sweepRestoredClones(backupHost().workspacesRoot(), { dryRun: false });
}
