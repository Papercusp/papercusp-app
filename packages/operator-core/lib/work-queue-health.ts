/**
 * work-queue-health — the stuck-items metric + reaper-liveness reader
 * (work-queue-stuck-item-recovery-2026-06-17, P-008 / P-009).
 *
 * Two questions a health surface needs to answer about the work queue's recovery
 * layer:
 *   1. Are any items STUCK right now? (P-008)
 *      - freed-but-non-dispatchable feature rows (`taken_by IS NULL` AND a status
 *        that is neither claimable, terminal, nor a deliberate `blocked` park) —
 *        should be ~0 now the reaper requeues mid-flight rows, so any >0 is a real
 *        anomaly (e.g. a status typo dropping an item out of dispatch — GAP 5);
 *      - dead-HELD claims past grace the reaper hasn't freed yet (feature taken_by
 *        / issue assignee with a dead holder) — a backlog the reaper should be
 *        clearing; a growing count means it isn't keeping up (or is wedged);
 *      - dead-assigned open bug/change issues (the issue-family equivalent).
 *   2. Is the reaper itself ALIVE? (P-009)
 *      The stale-claim sweep records its last run in `periodic_sweep_runs`; if that
 *      timestamp is older than the staleness window the DBOS scheduler has likely
 *      wedged (the FB-24 / EI-455 shape) and reaping has silently stopped. Detection
 *      MUST be external to the (possibly wedged) sweep — hence this reader.
 *   3. Did a terminal completion prove settlement but fail to retain its authority?
 *      A proposed terminal row whose settlement manifest has an explicit empty
 *      `residualPaths` array has already proved every declared path against a commit.
 *      If it remains proposed, the authority upgrade was rejected or reverted; an
 *      ordinary proposed row with missing or non-empty residue is still waiting for
 *      git-sync and must not be counted here.
 *
 * Pure data access (takes the sql handle); the liveness predicate is the SHARED
 * `liveHolderFragment` from work-items-stale-claims, so "dead holder" means exactly
 * the same thing here as in the reaper.
 */

import type { Sql, TransactionSql } from 'postgres';
import { liveHolderFragment, STALE_CLAIM_GRACE_MS } from './work-items-stale-claims';
import { STALE_PLAN_ASSIGNMENT_GRACE_MS } from './plan-items/stale-claims';
import { ANY_FAMILY_TERMINAL_STATES, FEATURE_NON_REQUEUE_STATES } from './work-item-dispatch-states';
import { TERMINAL_COMPLETION_EVIDENCE_KEY } from './coord-lifecycle/records';
import { activeWorkspaceId } from './workspace-registry';

type Db = Sql | TransactionSql;

/** The canonical sweep name recorded by the stale-claim reaper tick. */
export const STALE_CLAIM_SWEEP_NAME = 'stale-claim-sweep';

/** How long the reaper's last-run may age before it is presumed wedged. The sweep
 *  runs every 60s, so 5 min (5 missed ticks) is a confident "it stopped" signal
 *  without flapping on a single slow tick. Env-overridable. */
export const SWEEP_STALENESS_MS = (() => {
  const v = Number(process.env.PAPERCUSP_SWEEP_STALENESS_MS ?? 5 * 60 * 1000);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60 * 1000;
})();

/** Record (upsert) a periodic sweep's last successful run + how many rows it freed. */
export async function recordSweepRun(sql: Db, sweepName: string, released: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.periodic_sweep_runs (sweep_name, last_run_at, last_released, updated_at, workspace_id)
    VALUES (${sweepName}, now(), ${released}, now(), ${activeWorkspaceId()})
    ON CONFLICT (sweep_name)
      DO UPDATE SET last_run_at = now(), last_released = ${released}, updated_at = now()`;
}

export interface SweepRun {
  lastRunMs: number;
  lastReleased: number;
}

/** Read a sweep's recorded last-run (ms epoch) + last released count, or null if it
 *  has never run (or the row is absent). */
export async function readSweepRun(sql: Db, sweepName: string): Promise<SweepRun | null> {
  const rows = await sql<{ last_run_ms: string | number; last_released: number }[]>`
    SELECT extract(epoch from last_run_at) * 1000 AS last_run_ms, last_released
      FROM harness_shared.periodic_sweep_runs WHERE sweep_name = ${sweepName}`;
  if (!rows[0]) return null;
  return { lastRunMs: Number(rows[0].last_run_ms), lastReleased: Number(rows[0].last_released) };
}

export interface WorkQueueHealth {
  /** Freed (taken_by NULL) feature rows in a non-dispatchable, non-terminal,
   *  non-blocked status — should be ~0; any >0 is a real stuck anomaly. */
  stuckFeatures: number;
  /** Feature claims past grace still held by a dead holder (reaper backlog). */
  deadHeldFeatures: number;
  /** Open bug/change issues past grace still assigned to a dead holder. */
  deadAssignedIssues: number;
  /** Active plan-item ASSIGNMENTS past grace still reserved by a dead (name-aware)
   *  holder — the reservation analog the assignment reaper clears (EI-2535). A
   *  growing count means the assignment reaper isn't keeping up (or is wedged). */
  deadHeldAssignments: number;
  /** When the stale-claim reaper last ran (ms epoch), or null if never recorded. */
  reaperLastRunMs: number | null;
  /** Age of the reaper's last run in ms, or null if never recorded. */
  reaperAgeMs: number | null;
  /** True when the reaper hasn't run within SWEEP_STALENESS_MS (likely wedged), OR
   *  has never recorded a run. */
  reaperStale: boolean;
  /** Rows freed on the reaper's most recent run. */
  reaperLastReleased: number | null;
  /** Terminal proposed completions whose settlement manifest proves zero residue.
   *  This is the read-side signature of a failed/reverted proposed -> committed
   *  authority upgrade, not ordinary pre-commit settlement work. */
  settlementAuthorityFailures: number;
}

/**
 * Read the stuck-items metric + reaper liveness. Counts are scoped to `workspaceId`
 * when given (the health panel is per-workspace); the reaper heartbeat is global
 * (the sweep is workspace-agnostic). `nowMs` is injectable for deterministic tests.
 */
export async function readWorkQueueHealth(
  sql: Db,
  opts: {
    workspaceId?: string;
    graceMs?: number;
    assignmentGraceMs?: number;
    stalenessMs?: number;
    nowMs?: number;
  } = {},
): Promise<WorkQueueHealth> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const asgGraceSec = Math.max(
    1,
    Math.round((opts.assignmentGraceMs ?? STALE_PLAN_ASSIGNMENT_GRACE_MS) / 1000),
  );
  const stalenessMs = opts.stalenessMs ?? SWEEP_STALENESS_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const ws = opts.workspaceId ?? null;
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];

  const [counts] = await sql<
    {
      stuck_features: number;
      dead_held_features: number;
      dead_assigned_issues: number;
      dead_held_assignments: number;
      settlement_authority_failures: number;
    }[]
  >`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
         live_holder_asg AS (${liveHolderFragment(sql, asgGraceSec)})
    SELECT
      (SELECT count(*) FROM harness_shared.harness_features_consolidated f
         WHERE (${ws}::text IS NULL OR f.workspace_id = ${ws})
           AND f.taken_by IS NULL
           AND f.status IS NOT NULL
           AND f.status <> ALL(${nonRequeue}::text[]))::int AS stuck_features,
      (SELECT count(*) FROM harness_shared.harness_features_consolidated f
         WHERE (${ws}::text IS NULL OR f.workspace_id = ${ws})
           AND f.taken_by IS NOT NULL AND f.taken_by <> ''
           -- A NULL taken_at counts as past grace (the dead-holder signal alone
           -- governs), matching the reaper's DEAD leg + the fleet_assignment
           -- view's orphaned state so the alarm SEES the EI-2534 strand class.
           AND (f.taken_at IS NULL OR (now() - f.taken_at) > make_interval(secs => ${graceSec}))
           AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by))::int AS dead_held_features,
      (SELECT count(*) FROM harness_shared.engineer_issues e
         WHERE (${ws}::text IS NULL OR e.workspace_id = ${ws})
           AND e.state = 'open' AND e.kind IN ('bug', 'change')
           AND e.assignee IS NOT NULL AND e.assignee <> ''
           AND e.assigned_at IS NOT NULL
           AND (now() - e.assigned_at) > make_interval(secs => ${graceSec})
           AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = e.assignee))::int AS dead_assigned_issues,
      -- The assignment analog (EI-2535): active reservations past the ASSIGNMENT
      -- grace whose name-aware holder is dead (neither the name nor any adopting
      -- session is a live alias). Mirrors reclaimStaleDeadHolderPlanItemAssignments.
      (SELECT count(*) FROM harness_shared.plan_item_assignments asg
         WHERE (${ws}::text IS NULL OR asg.workspace_id = ${ws})
           AND asg.released_ts IS NULL
           AND asg.assignee_name IS NOT NULL AND asg.assignee_name <> ''
           AND asg.assigned_ts IS NOT NULL
           AND (now() - asg.assigned_ts) > make_interval(secs => ${asgGraceSec})
           AND NOT EXISTS (SELECT 1 FROM live_holder_asg h WHERE h.alias = asg.assignee_name)
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.agent_name_sessions s
               JOIN live_holder_asg h ON h.alias = s.session_owner_id
              WHERE s.workspace_id = asg.workspace_id AND s.agent_name = asg.assignee_name
           ))::int AS dead_held_assignments,
      -- WI-1338072: an explicit empty residualPaths array is a settlement proof.
      -- Keep this distinct from ordinary proposed rows: missing or non-empty
      -- residualPaths means the close is still waiting for git-sync, while a
      -- terminal proposed row with [] means the authority upgrade failed/reverted.
      (SELECT count(*) FROM harness_shared.work_items wi
         WHERE (${ws}::text IS NULL OR wi.workspace_id = ${ws})
           AND wi.status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])
           AND wi.authority = 'proposed'
           AND wi.payload #> ${[
             TERMINAL_COMPLETION_EVIDENCE_KEY,
             'settlementManifest',
             'residualPaths',
           ]}::text[] = '[]'::jsonb)::int AS settlement_authority_failures`;

  const run = await readSweepRun(sql, STALE_CLAIM_SWEEP_NAME);
  const reaperLastRunMs = run?.lastRunMs ?? null;
  const reaperAgeMs = reaperLastRunMs == null ? null : Math.max(0, nowMs - reaperLastRunMs);
  const reaperStale = reaperAgeMs == null ? true : reaperAgeMs > stalenessMs;

  return {
    stuckFeatures: Number(counts?.stuck_features ?? 0),
    deadHeldFeatures: Number(counts?.dead_held_features ?? 0),
    deadAssignedIssues: Number(counts?.dead_assigned_issues ?? 0),
    deadHeldAssignments: Number(counts?.dead_held_assignments ?? 0),
    settlementAuthorityFailures: Number(counts?.settlement_authority_failures ?? 0),
    reaperLastRunMs,
    reaperAgeMs,
    reaperStale,
    reaperLastReleased: run?.lastReleased ?? null,
  };
}

/**
 * Per-harness stuck-feature counts for `harness:health` (P-008) — the freed-but-
 * non-dispatchable + dead-held feature rows for ONE harness in a workspace. The
 * reaper metric is workspace-global; this is the per-harness slice. Uses the SAME
 * dispatch-state set + liveness rule as the reaper.
 */
export async function readHarnessStuckFeatures(
  sql: Db,
  workspaceId: string,
  harnessSlug: string,
  opts: { graceMs?: number } = {},
): Promise<{ stuckFeatures: number; deadHeldFeatures: number }> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const nonRequeue = [...FEATURE_NON_REQUEUE_STATES];
  const [row] = await sql<{ stuck_features: number; dead_held_features: number }[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)})
    SELECT
      (SELECT count(*) FROM harness_shared.harness_features_consolidated f
         WHERE f.workspace_id = ${workspaceId} AND f.harness_slug = ${harnessSlug}
           AND f.taken_by IS NULL
           AND f.status IS NOT NULL
           AND f.status <> ALL(${nonRequeue}::text[]))::int AS stuck_features,
      (SELECT count(*) FROM harness_shared.harness_features_consolidated f
         WHERE f.workspace_id = ${workspaceId} AND f.harness_slug = ${harnessSlug}
           AND f.taken_by IS NOT NULL AND f.taken_by <> ''
           -- NULL taken_at counts as past grace (parity with the reaper + the
           -- fleet_assignment view's orphaned state, EI-2534).
           AND (f.taken_at IS NULL OR (now() - f.taken_at) > make_interval(secs => ${graceSec}))
           AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by))::int AS dead_held_features`;
  return {
    stuckFeatures: Number(row?.stuck_features ?? 0),
    deadHeldFeatures: Number(row?.dead_held_features ?? 0),
  };
}
