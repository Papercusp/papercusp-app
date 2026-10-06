/**
 * Dependency-light effective GOAL-holder authority read.
 *
 * Kept separate from holder.ts because compact control-context construction is
 * on the agent-MCP bootstrap path. Importing the full holder/liveness oracle
 * graph there creates a cycle through agent-mcp goal registration. This module
 * owns only the canonical election SQL and its small value types.
 */
import type { Sql } from 'postgres';
import { GOAL_MODE } from '../modes/goal-session';

/** Upper bound on superseded rows retired per goal per sweep tick. */
export const SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT = 50;

/** Lease-authority residue, including dead predecessors: liveness cannot erase a superseded lease. */
export async function readSupersededGoalHolderModes(sql: Sql, workspaceId: string, goalId: string) {
  return await sql<Array<{ owner_id: string; goal_lease_epoch: string; elected_owner_id: string; elected_epoch: string }>>`
    WITH elected AS (
      SELECT owner_id, goal_lease_epoch, goal_handoff_expires_at
        FROM harness_shared.agent_modes
       WHERE workspace_id = ${workspaceId}
         AND mode = ${GOAL_MODE}
         AND subject = ${goalId}
       ORDER BY goal_lease_epoch DESC NULLS LAST, set_at DESC, owner_id ASC
       LIMIT 1
    )
    SELECT am.owner_id, am.goal_lease_epoch::text AS goal_lease_epoch,
           e.owner_id AS elected_owner_id, e.goal_lease_epoch::text AS elected_epoch
      FROM harness_shared.agent_modes am
      CROSS JOIN elected e
     WHERE am.workspace_id = ${workspaceId}
       AND am.mode = ${GOAL_MODE}
       AND am.subject = ${goalId}
       AND am.owner_id <> e.owner_id
       AND am.goal_lease_epoch IS NOT NULL
       AND e.goal_lease_epoch IS NOT NULL
       AND am.goal_lease_epoch < e.goal_lease_epoch
       AND (e.goal_handoff_expires_at IS NULL OR e.goal_handoff_expires_at <= now())
     ORDER BY am.goal_lease_epoch ASC, am.owner_id ASC
     LIMIT ${SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT}`;
}

/** Historical holder membership with an atomic current-row exclusion, not a staffing read. */
export async function readFormerGoalHolderAwaits(
  sql: Sql, workspaceId: string, goalId: string, coordWorkspaceId: string, keys: string[],
) {
  return await sql<Array<{ subscriber_id: string }>>`
    SELECT DISTINCT a.subscriber_id
      FROM harness_shared.event_awaits a
     WHERE a.workspace_id = ${coordWorkspaceId}
       AND a.event_key = ANY(${sql.array(keys)}::text[])
       AND a.policy <> 'announce'
       AND a.fired_at IS NULL AND a.cancelled_at IS NULL
       AND EXISTS (
         -- Either side proves historical membership, including entries before subject was recorded.
         SELECT 1 FROM harness_shared.agent_mode_changes c
          WHERE c.workspace_id = ${workspaceId} AND c.owner_id = a.subscriber_id
            AND (c.new_mode = ${GOAL_MODE} OR c.old_mode = ${GOAL_MODE})
            AND c.subject = ${goalId})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_modes m
          WHERE m.workspace_id = ${workspaceId} AND m.owner_id = a.subscriber_id
            AND m.mode = ${GOAL_MODE} AND m.subject = ${goalId})`;
}

export type GoalHolderAuthorityStatus = 'none' | 'elected' | 'handoff' | 'superseded';

export interface GoalHolderAuthority {
  status: GoalHolderAuthorityStatus;
  goalId: string | null;
  electedOwnerId: string | null;
  electedEpoch: number | null;
  handoffExpiresAt: string | null;
}

/** Canonical holder-authority read for one session. */
export async function readGoalHolderAuthority(
  sql: Sql,
  workspaceId: string,
  ownerId: string,
): Promise<GoalHolderAuthority> {
  if (!workspaceId || workspaceId === '*' || !ownerId) {
    return {
      status: 'none',
      goalId: null,
      electedOwnerId: null,
      electedEpoch: null,
      handoffExpiresAt: null,
    };
  }
  const rows = await sql<
    Array<{
      subject: string;
      elected_owner_id: string;
      elected_epoch: string | number | null;
      predecessor_owner_id: string | null;
      handoff_expires_at: Date | string | null;
    }>
  >`
    WITH mine AS MATERIALIZED (
      SELECT subject
        FROM harness_shared.agent_modes
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ${ownerId}
         AND mode = ${GOAL_MODE}
         AND subject IS NOT NULL
       LIMIT 1
    ),
    elected AS MATERIALIZED (
      SELECT am.owner_id, am.goal_lease_epoch,
             am.goal_handoff_from_owner_id, am.goal_handoff_expires_at
        FROM harness_shared.agent_modes am
        CROSS JOIN mine
       WHERE am.workspace_id = ${workspaceId}
         AND am.mode = ${GOAL_MODE}
         AND am.subject = mine.subject
       ORDER BY am.goal_lease_epoch DESC NULLS LAST, am.set_at DESC, am.owner_id ASC
       LIMIT 1
    )
    SELECT mine.subject, elected.owner_id AS elected_owner_id,
           elected.goal_lease_epoch AS elected_epoch,
           elected.goal_handoff_from_owner_id AS predecessor_owner_id,
           elected.goal_handoff_expires_at AS handoff_expires_at
      FROM mine
      CROSS JOIN elected`;
  const row = rows[0];
  if (!row) {
    return {
      status: 'none',
      goalId: null,
      electedOwnerId: null,
      electedEpoch: null,
      handoffExpiresAt: null,
    };
  }
  const handoffExpiresAt =
    row.handoff_expires_at == null
      ? null
      : row.handoff_expires_at instanceof Date
        ? row.handoff_expires_at.toISOString()
        : String(row.handoff_expires_at);
  const handoffLive =
    row.predecessor_owner_id === ownerId &&
    handoffExpiresAt != null &&
    Number.isFinite(Date.parse(handoffExpiresAt)) &&
    Date.parse(handoffExpiresAt) > Date.now();
  return {
    status: row.elected_owner_id === ownerId ? 'elected' : handoffLive ? 'handoff' : 'superseded',
    goalId: row.subject,
    electedOwnerId: row.elected_owner_id,
    electedEpoch: row.elected_epoch == null ? null : Number(row.elected_epoch),
    handoffExpiresAt,
  };
}
