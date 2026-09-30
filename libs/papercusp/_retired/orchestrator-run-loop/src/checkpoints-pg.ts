/**
 * Postgres-backed checkpoint signaling — Phase 3 of the orchestrator → PG arc.
 *
 * Replaces filesystem semantics:
 *   - `<stateDir>/checkpoint-<name>.md`         → row, granted=false, consumed=false
 *   - `<stateDir>/checkpoint-<name>.md.granted` → UPDATE granted=true
 *   - `<stateDir>/.checkpoint-<name>.fired`     → ANY row's existence (incl. consumed=true)
 *
 * **Schema reconciliation note (2026-05-08):** the operator's `harness-fs-watcher`
 * has been writing to `harness_shared.harness_checkpoints` since the bash
 * run.sh era using a different shape than my original Phase 3 design.
 * To coexist with the watcher (which mirrors disk → PG when run.sh writes
 * checkpoint files), the orchestrator's PG path now uses the existing
 * column names + adds a single boolean column for the consumed sentinel.
 *
 * Schema (existing + Phase 3 ALTER):
 *
 *   harness_shared.harness_checkpoints (
 *     harness_slug      TEXT NOT NULL,
 *     name              TEXT NOT NULL,
 *     content           TEXT NOT NULL DEFAULT '',
 *     waiting_since_ms  BIGINT NOT NULL DEFAULT 0,
 *     granted           BOOLEAN NOT NULL DEFAULT false,
 *     consumed          BOOLEAN NOT NULL DEFAULT false,  -- Phase 3 add
 *     workspace_id      TEXT NOT NULL DEFAULT '',
 *     PRIMARY KEY (harness_slug, name)
 *   );
 *
 * Lifecycle:
 *   pending  (granted=false, consumed=false)  ← INSERT on fire
 *     ↓
 *   granted  (granted=true,  consumed=false)  ← UPDATE on user grant
 *     ↓
 *   consumed (granted=true,  consumed=true)   ← UPDATE on orchestrator clear
 *
 * The "any row exists" predicate (replaces .fired sentinel file) survives
 * consumption because consumed rows are kept, not deleted.
 *
 * The pre-Phase-3 PK is `(harness_slug, name)` not `(workspace_id, harness_slug, name)`
 * — the harness-fs-watcher and run.sh both wrote with that shape. Phase 3
 * accepts that and scopes via the `workspace_id` column predicate in
 * SELECTs/UPDATEs. Workspaces sharing a slug + checkpoint name would
 * collide, but harness slugs are workspace-unique by convention.
 *
 * pg_notify routing (best-effort, row state remains canonical):
 *   The orchestrator emits on the `sync_invalidate` channel using the
 *   operator's existing payload format `{ name: queryName, args: ... }`.
 *   Operator's sync-sse.ts listener (single dedicated `LISTEN
 *   sync_invalidate` connection) picks it up and broadcasts to all
 *   SSE subscribers, which triggers `harnessCheckpoints.byHarness` to
 *   refetch in the UI. Same channel as every other checkpoint event
 *   (operator-side INSERT/UPDATE in harness-fs-watcher); the
 *   orchestrator just plugs into the same bus.
 */
import type { OrchestratorPg } from './invoke';

export interface CheckpointsPgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export const CHECKPOINTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_checkpoints (
    harness_slug      TEXT NOT NULL,
    name              TEXT NOT NULL,
    content           TEXT NOT NULL DEFAULT '',
    waiting_since_ms  BIGINT NOT NULL DEFAULT 0,
    granted           BOOLEAN NOT NULL DEFAULT false,
    consumed          BOOLEAN NOT NULL DEFAULT false,
    workspace_id      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (harness_slug, name)
  );
  -- Idempotent column-add for tables created before the Phase 3 reconciliation.
  ALTER TABLE harness_shared.harness_checkpoints
    ADD COLUMN IF NOT EXISTS consumed BOOLEAN NOT NULL DEFAULT false;
  CREATE INDEX IF NOT EXISTS harness_checkpoints_slug_waiting_idx
    ON harness_shared.harness_checkpoints (harness_slug, waiting_since_ms ASC);
`;

/**
 * Fire (or re-acknowledge) a checkpoint. INSERT ON CONFLICT DO NOTHING —
 * matches the FS-sentinel "skip if any prior row exists" semantic.
 *
 * Returns true when a new row was inserted (the checkpoint actually
 * fired this call), false when the row already existed (no-op).
 */
export async function fireCheckpointPg(
  ctx: CheckpointsPgContext,
  name: string,
  content: string,
): Promise<boolean> {
  const now = Date.now();
  const rows = await ctx.pg<{ inserted: boolean }[]>`
    INSERT INTO harness_shared.harness_checkpoints
      (harness_slug, name, content, waiting_since_ms, granted, consumed, workspace_id)
    VALUES (${ctx.harnessSlug}, ${name}, ${content}, ${now},
            false, false, ${ctx.workspaceId})
    ON CONFLICT (harness_slug, name) DO NOTHING
    RETURNING TRUE AS inserted
  `;
  const inserted = rows.length > 0;
  if (inserted) {
    try {
      await ctx.pg`
        SELECT pg_notify('sync_invalidate',
          ${JSON.stringify({
            name: 'harnessCheckpoints.byHarness',
            args: { harnessSlug: ctx.harnessSlug },
          })})
      `;
    } catch {
      /* best-effort */
    }
  }
  return inserted;
}

/** Pending and granted (not-yet-consumed) checkpoint names for the active harness. */
export interface CheckpointStatus {
  pending: string[];
  granted: string[];
}

export async function listCheckpointsPg(ctx: CheckpointsPgContext): Promise<CheckpointStatus> {
  const rows = await ctx.pg<{ name: string; granted: boolean }[]>`
    SELECT name, granted FROM harness_shared.harness_checkpoints
     WHERE harness_slug = ${ctx.harnessSlug}
       AND workspace_id = ${ctx.workspaceId}
       AND consumed     = false
     ORDER BY waiting_since_ms
  `;
  const pending: string[] = [];
  const granted: string[] = [];
  for (const r of rows) {
    if (r.granted) granted.push(r.name);
    else pending.push(r.name);
  }
  return { pending, granted };
}

/**
 * Mark every granted-but-not-yet-consumed checkpoint as consumed (the
 * orchestrator has acknowledged the grant and is proceeding). Returns
 * the names that were cleared.
 */
export async function clearGrantedCheckpointsPg(
  ctx: CheckpointsPgContext,
): Promise<string[]> {
  const rows = await ctx.pg<{ name: string }[]>`
    UPDATE harness_shared.harness_checkpoints
       SET consumed = true
     WHERE harness_slug = ${ctx.harnessSlug}
       AND workspace_id = ${ctx.workspaceId}
       AND granted      = true
       AND consumed     = false
    RETURNING name
  `;
  return rows.map((r) => r.name);
}

/** Operator-facing helper: mark a specific checkpoint granted. */
export async function grantCheckpointPg(
  ctx: CheckpointsPgContext,
  name: string,
): Promise<boolean> {
  const rows = await ctx.pg<{ updated: boolean }[]>`
    UPDATE harness_shared.harness_checkpoints
       SET granted = true
     WHERE harness_slug = ${ctx.harnessSlug}
       AND workspace_id = ${ctx.workspaceId}
       AND name         = ${name}
       AND granted      = false
       AND consumed     = false
    RETURNING TRUE AS updated
  `;
  if (rows.length > 0) {
    try {
      await ctx.pg`
        SELECT pg_notify('sync_invalidate',
          ${JSON.stringify({
            name: 'harnessCheckpoints.byHarness',
            args: { harnessSlug: ctx.harnessSlug },
          })})
      `;
    } catch {
      /* best-effort */
    }
  }
  return rows.length > 0;
}
