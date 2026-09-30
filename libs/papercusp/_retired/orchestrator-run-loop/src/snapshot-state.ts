/**
 * Per-iteration state snapshot. Mirrors bash snapshot_state:
 *
 *   - Copies features.json + validation-contract.md + supervisor-notes.md
 *     + config.json into <stateDir>/snapshots/<ts>-iter-<NNN>/
 *   - Prunes oldest snapshot dirs beyond config.snapshotRetention
 *     (default 50). Logs/, hooks/, escalation.md are NOT snapshotted.
 *
 * As of Phase 7 of the orchestrator → PG arc, when ctx is provided the
 * snapshot becomes a single row in harness_shared.harness_snapshots
 * holding the four artifact bodies as TEXT columns. Same retention
 * semantics, same artifact list. The harness directory's snapshots/
 * folder isn't created.
 *
 * The features body is read from PG when ctx is set (matching Phase 1's
 * features → harness_features cutover); markdown files are still read
 * from disk because text-artifacts.ts is the operator-side PG-canonical
 * path for those, and the orchestrator package can read disk equally
 * well at snapshot time.
 *
 * Used for rollback via the harness UI's snapshot list.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configGet } from './config';
import {
  snapshotStatePg,
  type SnapshotsPgContext,
} from './snapshots-pg';
import { readFeatures, type StateContext } from './state';
import type { HarnessConfig } from './types';
import type { OrchestratorPg } from './invoke';

export interface SnapshotResult {
  /**
   * FS path: snapshot directory (or null if source didn't exist).
   * PG path: snapshot_id of the row that was inserted.
   */
  path: string | null;
  /** Number of older snapshots pruned. */
  pruned: number;
}

export interface SnapshotPgArgs {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export function snapshotState(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
  ctx: StateContext,
): SnapshotResult | Promise<SnapshotResult>;
export function snapshotState(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
  ctx: SnapshotPgArgs,
): Promise<SnapshotResult>;
export function snapshotState(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
  ctx: SnapshotPgArgs | StateContext,
): SnapshotResult | Promise<SnapshotResult> {
  // SnapshotPgArgs carries `harnessSlug` explicitly; StateContext (PG)
  // also has it. Both code paths get unified below.
  if ((ctx as SnapshotPgArgs).harnessSlug !== undefined &&
      (ctx as SnapshotPgArgs).pg !== undefined) {
    return snapshotStateAsync(stateDir, iterationNumber, cfg, ctx as SnapshotPgArgs);
  }
  return snapshotStateFs(stateDir, iterationNumber, cfg, ctx as StateContext);
}

async function snapshotStateAsync(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
  ctx: SnapshotPgArgs,
): Promise<SnapshotResult> {
  const ts = Math.floor(Date.now() / 1000);
  const iterStr = String(iterationNumber).padStart(3, '0');
  const snapshotId = `${ts}-iter-${iterStr}`;

  // Read each source. Features come from harness_features when PG is
  // canonical; markdown files come from disk (the orchestrator already
  // has access via stateDir).
  let featuresJson: string | null = null;
  try {
    const { readFeaturesPg } = await import('./state-pg');
    const features = await readFeaturesPg({ pg: ctx.pg, workspaceId: ctx.workspaceId });
    featuresJson = JSON.stringify({ features });
  } catch {
    // PG read failed — best-effort empty snapshot. There's no FS
    // fallback for features anymore (PG is canonical).
    featuresJson = null;
  }
  const validationMd = readIfExists(join(stateDir, 'validation-contract.md'));
  const notesMd = readIfExists(join(stateDir, 'supervisor-notes.md'));
  const configJson = readIfExists(join(stateDir, 'config.json'));

  const retentionRaw = configGet<unknown>(cfg, 'snapshotRetention', 50);
  const retention =
    typeof retentionRaw === 'number' && retentionRaw > 0
      ? Math.floor(retentionRaw)
      : 50;

  const sCtx: SnapshotsPgContext = {
    pg: ctx.pg,
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.harnessSlug,
  };
  const result = await snapshotStatePg(
    sCtx,
    {
      snapshotId,
      iteration: iterationNumber,
      featuresJson,
      validationMd,
      notesMd,
      configJson,
      takenAt: Date.now(),
    },
    retention,
  );
  return { path: result.snapshotId, pruned: result.pruned };
}

async function snapshotStateFs(
  stateDir: string,
  iterationNumber: number,
  cfg: HarnessConfig,
  ctx: StateContext,
): Promise<SnapshotResult> {
  const ts = Math.floor(Date.now() / 1000);
  const iterStr = String(iterationNumber).padStart(3, '0');
  const snapshotsRoot = join(stateDir, 'snapshots');
  const snapDir = join(snapshotsRoot, `${ts}-iter-${iterStr}`);
  mkdirSync(snapDir, { recursive: true });

  let copiedAny = false;

  // Features come from the state context (memory in tests, PG in prod).
  // They get serialized into a synthetic `features.json` inside the
  // snapshot dir — for archival/portability only, not as a canonical
  // file the orchestrator reads at runtime.
  try {
    const features = await readFeatures(stateDir, ctx);
    if (features.length > 0) {
      writeFileSync(
        join(snapDir, 'features.json'),
        JSON.stringify({ features }, null, 2) + '\n',
      );
      copiedAny = true;
    }
  } catch {
    // ignore — best effort
  }

  // The markdown artifacts still live on disk (text-artifacts.ts is the
  // operator-side PG-canonical path, but orchestrator can read disk).
  for (const name of [
    'validation-contract.md',
    'supervisor-notes.md',
    'config.json',
  ]) {
    const src = join(stateDir, name);
    if (!existsSync(src)) continue;
    try {
      copyFileSync(src, join(snapDir, name));
      copiedAny = true;
    } catch {
      // ignore — best effort
    }
  }

  const snapPath = copiedAny ? snapDir : null;

  // Prune.
  const retentionRaw = configGet<unknown>(cfg, 'snapshotRetention', 50);
  const retention =
    typeof retentionRaw === 'number' && retentionRaw > 0
      ? Math.floor(retentionRaw)
      : 50;
  let dirs: string[];
  try {
    dirs = readdirSync(snapshotsRoot).filter((n) => /^\d+-iter-\d+$/.test(n));
  } catch {
    return { path: snapPath, pruned: 0 };
  }
  dirs.sort(); // ts-prefixed name sort = oldest first
  if (dirs.length <= retention) {
    return { path: snapPath, pruned: 0 };
  }
  const dropCount = dirs.length - retention;
  for (const d of dirs.slice(0, dropCount)) {
    const full = join(snapshotsRoot, d);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
  return { path: snapPath, pruned: dropCount };
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
