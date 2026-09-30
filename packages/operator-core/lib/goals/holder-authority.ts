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
