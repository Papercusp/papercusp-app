/**
 * Postgres-backed mission state — Phase 2 of the orchestrator → PG arc.
 *
 * One row per (workspace_id, harness_slug) holding the small bag of
 * "what happened during this mission" facts that previously lived as
 * scattered files in <stateDir>/:
 *
 *   - .cost-warn-fired    → cost_warn_fired (BOOLEAN)
 *   - ready-for-prod.flag → ready_for_prod_at (BIGINT epoch ms; null = unset)
 *   - lanes.json          → lanes (JSONB array of LaneRecord)
 *
 * **Schema reconciliation note (2026-05-08):** `escalation.md` is NOT
 * in this row. The operator's harness-fs-watcher already mirrors
 * escalation.md + supervisor-notes.md into `harness_shared.harness_escalations`
 * `(harness_slug, phase, escalation, supervisor_notes, mtime_ms, workspace_id)`,
 * which is also consumed by mobile-intervention-watcher for push
 * notifications. Phase 2 reuses that table via setEscalationPg writing
 * to `harness_escalations.escalation` directly; no schema sprawl.
 *
 * Lanes go in a JSONB column rather than a separate `harness_lanes` table
 * because the orchestrator's lane pool is small (typically <10 entries),
 * per-harness, and gets fully rewritten on every persist — exactly the
 * shape JSONB-document-per-row optimizes for. (The existing harness_lanes
 * table in harness_shared is a separate concern: bash run.sh's per-role
 * lane bookkeeping. They don't overlap.)
 *
 * Schema (apply via the schema bootstrap helper at module bottom or via
 * the operator's existing migration runner):
 *
 *   CREATE TABLE harness_shared.harness_mission_state (
 *     workspace_id      TEXT NOT NULL DEFAULT 'default',
 *     harness_slug      TEXT NOT NULL,
 *     cost_warn_fired   BOOLEAN NOT NULL DEFAULT false,
 *     ready_for_prod_at BIGINT,
 *     lanes             JSONB NOT NULL DEFAULT '[]'::jsonb,
 *     updated_at        BIGINT NOT NULL,
 *     PRIMARY KEY (workspace_id, harness_slug)
 *   );
 */
import { pgJson, type OrchestratorPg } from './invoke';

export interface MissionStatePgContext {
  pg: OrchestratorPg;
  workspaceId: string;
  harnessSlug: string;
}

export interface LaneRecordRow {
  id: number;
  feature_id: string;
  started_at: number;
  finished_at?: number;
}

export interface MissionState {
  costWarnFired: boolean;
  readyForProdAt: number | null;
  lanes: LaneRecordRow[];
}

const EMPTY_STATE: MissionState = {
  costWarnFired: false,
  readyForProdAt: null,
  lanes: [],
};

/** SQL DDL for the mission state table. Idempotent. */
export const MISSION_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_mission_state (
    workspace_id      TEXT NOT NULL DEFAULT 'default',
    harness_slug      TEXT NOT NULL,
    cost_warn_fired   BOOLEAN NOT NULL DEFAULT false,
    ready_for_prod_at BIGINT,
    lanes             JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at        BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug)
  );
  -- Idempotent column-drop for tables created before the Phase 2
  -- reconciliation. escalation_md was migrated into the existing
  -- harness_escalations table.
  ALTER TABLE harness_shared.harness_mission_state
    DROP COLUMN IF EXISTS escalation_md;
`;

interface MissionStateRow {
  cost_warn_fired: boolean;
  ready_for_prod_at: number | bigint | null;
  lanes: LaneRecordRow[];
}

export async function readMissionState(ctx: MissionStatePgContext): Promise<MissionState> {
  const rows = await ctx.pg<MissionStateRow[]>`
    SELECT cost_warn_fired, ready_for_prod_at, lanes
      FROM harness_shared.harness_mission_state
     WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug}
     LIMIT 1
  `;
  if (rows.length === 0) return { ...EMPTY_STATE };
  const r = rows[0];
  return {
    costWarnFired: r.cost_warn_fired === true,
    readyForProdAt: r.ready_for_prod_at === null ? null : Number(r.ready_for_prod_at),
    lanes: Array.isArray(r.lanes) ? r.lanes : [],
  };
}

/**
 * UPSERT escalation into the existing `harness_shared.harness_escalations`
 * table — same table the operator's harness-fs-watcher mirrors disk
 * escalation.md into, and the same table mobile-intervention-watcher
 * polls for push notifications. Reusing it avoids schema sprawl.
 *
 * `phase` defaults to 'staging' which matches the watcher's default and
 * the typical orchestrator invocation. Pass an explicit phase from
 * InvokeContext.phase for non-default phases.
 */
export async function setEscalationPg(
  ctx: MissionStatePgContext,
  bodyMd: string,
  phase: string = 'staging',
): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_escalations
      (harness_slug, phase, escalation, mtime_ms, workspace_id)
    VALUES (${ctx.harnessSlug}, ${phase}, ${bodyMd}, ${now}, ${ctx.workspaceId})
    ON CONFLICT (harness_slug, phase) DO UPDATE
      SET escalation   = EXCLUDED.escalation,
          mtime_ms     = EXCLUDED.mtime_ms,
          workspace_id = EXCLUDED.workspace_id
  `;
}

/** UPSERT cost_warn_fired = true. Other columns preserved. */
export async function setCostWarnFiredPg(ctx: MissionStatePgContext): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, cost_warn_fired, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, true, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET cost_warn_fired = true,
          updated_at      = EXCLUDED.updated_at
  `;
}

/** True iff cost_warn_fired = true for the active harness. */
export async function readCostWarnFiredPg(ctx: MissionStatePgContext): Promise<boolean> {
  const rows = await ctx.pg<{ cost_warn_fired: boolean }[]>`
    SELECT cost_warn_fired FROM harness_shared.harness_mission_state
     WHERE workspace_id = ${ctx.workspaceId} AND harness_slug = ${ctx.harnessSlug}
     LIMIT 1
  `;
  return rows[0]?.cost_warn_fired === true;
}

/** UPSERT ready_for_prod_at = now-ms. Other columns preserved. */
export async function setReadyForProdPg(ctx: MissionStatePgContext): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, ready_for_prod_at, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET ready_for_prod_at = EXCLUDED.ready_for_prod_at,
          updated_at        = EXCLUDED.updated_at
  `;
}

/**
 * Reset mission-scoped state at the start of a new mission. Clears
 * `cost_warn_fired` and `ready_for_prod_at`; preserves `lanes`
 * (the new mission's persistLanesPg call will overwrite them).
 *
 * Called from `runMainLoopBody` immediately before the iteration loop
 * opens, so each `run.sh` invocation gets fresh sentinels.
 *
 * Background: when this table was introduced (Phase 2 of the
 * orchestrator → PG arc), the file-based sentinels it replaced
 * (`<stateDir>/.cost-warn-fired`, `<stateDir>/ready-for-prod.flag`)
 * lived in <stateDir>/ which got snapshotted but **not cleared between
 * runs**. The `cost_warn_fired` semantic was always "fires once per
 * mission" — a `run.sh` re-invocation was supposed to be a fresh
 * mission and re-fire the warn at the threshold. Without an explicit
 * reset, the PG row persists `true` forever once set.
 */
export async function clearMissionStatePg(ctx: MissionStatePgContext): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, cost_warn_fired, ready_for_prod_at, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, false, NULL, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET cost_warn_fired   = false,
          ready_for_prod_at = NULL,
          updated_at        = EXCLUDED.updated_at
  `;
}

/** UPSERT the entire lanes array. Other columns preserved. */
export async function persistLanesPg(
  ctx: MissionStatePgContext,
  lanes: LaneRecordRow[],
): Promise<void> {
  const now = Date.now();
  await ctx.pg`
    INSERT INTO harness_shared.harness_mission_state
      (workspace_id, harness_slug, lanes, updated_at)
    VALUES (${ctx.workspaceId}, ${ctx.harnessSlug}, ${pgJson(ctx.pg, lanes)}, ${now})
    ON CONFLICT (workspace_id, harness_slug) DO UPDATE
      SET lanes      = EXCLUDED.lanes,
          updated_at = EXCLUDED.updated_at
  `;
}
