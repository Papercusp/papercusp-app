/**
 * Postgres-backed mission snapshots — Phase 7 of the orchestrator → PG arc.
 *
 * Replaces directory-copy-per-iteration semantics — previously the
 * orchestrator copied artifact files into per-iteration snapshot dirs;
 * now one row per snapshot in harness_shared.harness_snapshots holds
 * each artifact as a separate TEXT column. Features come from PG;
 * validation-contract / supervisor-notes / config are still text on
 * disk. Same retention semantics (default 50, keep oldest first by
 * taken_at via ROW_NUMBER pruning).
 *
 * Schema:
 *
 *   CREATE TABLE harness_shared.harness_snapshots (
 *     workspace_id   TEXT NOT NULL DEFAULT 'default',
 *     harness_slug   TEXT NOT NULL,
 *     snapshot_id    TEXT NOT NULL,  -- '<ts>-iter-<NNN>'
 *     iteration      INT NOT NULL,
 *     features_json  TEXT,
 *     validation_md  TEXT,
 *     notes_md       TEXT,
 *     config_json    TEXT,
 *     taken_at       BIGINT NOT NULL,
 *     PRIMARY KEY (workspace_id, harness_slug, snapshot_id)
 *   );
 */
import type { OrchestratorPg } from './invoke';

export interface SnapshotsPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export interface SnapshotPayload {
  snapshotId: string;
  iteration: number;
  featuresJson: string | null;
  validationMd: string | null;
  notesMd: string | null;
  configJson: string | null;
  takenAt: number;
}

export const SNAPSHOTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_snapshots (
    workspace_id   TEXT NOT NULL DEFAULT 'default',
    harness_slug   TEXT NOT NULL,
    snapshot_id    TEXT NOT NULL,
    iteration      INT NOT NULL,
    features_json  TEXT,
    validation_md  TEXT,
    notes_md       TEXT,
    config_json    TEXT,
    taken_at       BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, snapshot_id)
  );
  CREATE INDEX IF NOT EXISTS harness_snapshots_recent_idx
    ON harness_shared.harness_snapshots (workspace_id, harness_slug, taken_at DESC);
`;

/**
 * Insert one snapshot row + prune older snapshots beyond `retention`
 * (oldest by taken_at). Returns the count of rows pruned.
 */
export async function snapshotStatePg(
  ctx: SnapshotsPgContext,
  payload: SnapshotPayload,
  retention: number,
): Promise<{ snapshotId: string; pruned: number }> {
  await ctx.pg`
    INSERT INTO harness_shared.harness_snapshots
      (workspace_id, harness_slug, snapshot_id, iteration,
       features_json, validation_md, notes_md, config_json, taken_at)
    VALUES (
      ${ctx.workspaceId}, ${ctx.harnessSlug}, ${payload.snapshotId},
      ${payload.iteration},
      ${payload.featuresJson}, ${payload.validationMd},
      ${payload.notesMd}, ${payload.configJson},
      ${payload.takenAt}
    )
    ON CONFLICT (workspace_id, harness_slug, snapshot_id) DO NOTHING
  `;
  const safe = retention > 0 && Number.isFinite(retention) ? Math.floor(retention) : 50;
  const pruned = await ctx.pg<{ snapshot_id: string }[]>`
    DELETE FROM harness_shared.harness_snapshots
     WHERE (workspace_id, harness_slug, snapshot_id) IN (
       SELECT workspace_id, harness_slug, snapshot_id
         FROM (
           SELECT workspace_id, harness_slug, snapshot_id,
                  ROW_NUMBER() OVER (PARTITION BY workspace_id, harness_slug
                                     ORDER BY taken_at DESC) AS rn
             FROM harness_shared.harness_snapshots
            WHERE workspace_id = ${ctx.workspaceId}
              AND harness_slug = ${ctx.harnessSlug}
         ) ranked
        WHERE rn > ${safe}
     )
    RETURNING snapshot_id
  `;
  return { snapshotId: payload.snapshotId, pruned: pruned.length };
}

export interface SnapshotIndexEntry {
  snapshotId: string;
  iteration: number;
  takenAt: number;
}

export async function listSnapshotsPg(
  ctx: SnapshotsPgContext,
): Promise<SnapshotIndexEntry[]> {
  const rows = await ctx.pg<{
    snapshot_id: string;
    iteration: number;
    taken_at: number | bigint;
  }[]>`
    SELECT snapshot_id, iteration, taken_at
      FROM harness_shared.harness_snapshots
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
     ORDER BY taken_at DESC
  `;
  return rows.map((r) => ({
    snapshotId: r.snapshot_id,
    iteration: r.iteration,
    takenAt: typeof r.taken_at === 'bigint' ? Number(r.taken_at) : r.taken_at,
  }));
}

export async function readSnapshotPg(
  ctx: SnapshotsPgContext,
  snapshotId: string,
): Promise<SnapshotPayload | null> {
  const rows = await ctx.pg<{
    snapshot_id: string;
    iteration: number;
    features_json: string | null;
    validation_md: string | null;
    notes_md: string | null;
    config_json: string | null;
    taken_at: number | bigint;
  }[]>`
    SELECT snapshot_id, iteration, features_json, validation_md,
           notes_md, config_json, taken_at
      FROM harness_shared.harness_snapshots
     WHERE workspace_id = ${ctx.workspaceId}
       AND harness_slug = ${ctx.harnessSlug}
       AND snapshot_id  = ${snapshotId}
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    snapshotId: r.snapshot_id,
    iteration: r.iteration,
    featuresJson: r.features_json,
    validationMd: r.validation_md,
    notesMd: r.notes_md,
    configJson: r.config_json,
    takenAt: typeof r.taken_at === 'bigint' ? Number(r.taken_at) : r.taken_at,
  };
}
