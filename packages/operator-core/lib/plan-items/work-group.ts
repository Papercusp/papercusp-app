/**
 * plan work-group membership — the cross-user PULL opt-in (D-005).
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 3).
 *
 * Within your own agents you push-assign (assignItem). ACROSS users it's pull-only:
 * a user joins a shared plan's work-group, which lets their sessions CLAIM unassigned
 * items from the shared pool — nobody push-assigns onto another user's machine
 * (token-burn safety). When NO work-group exists for a plan (the single-user / local
 * case), pulling an unassigned item is open — the gate only bites once a work-group
 * is declared, which is the deliberate cross-user boundary.
 *
 * Table: plan_work_group_members (migration 140).
 */
import { getOrgPg } from '@papercusp/db-org';

export interface WorkGroupMember {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  memberUser: string;
  memberName: string | null;
  joinedAt: string;
}

export async function joinWorkGroup(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  memberUser: string,
  memberName?: string | null,
): Promise<WorkGroupMember> {
  const { sql } = getOrgPg();
  const rows = await sql<WorkGroupDbRow[]>`
    INSERT INTO harness_shared.plan_work_group_members
      (workspace_id, harness_slug, plan_slug, member_user, member_name)
    VALUES (${workspaceId}, ${harnessSlug}, ${planSlug}, ${memberUser}, ${memberName ?? null})
    ON CONFLICT (workspace_id, harness_slug, plan_slug, member_user) DO UPDATE SET
      member_name = EXCLUDED.member_name
    RETURNING workspace_id, harness_slug, plan_slug, member_user, member_name, joined_at
  `;
  return memberFromDb(rows[0]!);
}

export async function leaveWorkGroup(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  memberUser: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ member_user: string }[]>`
    DELETE FROM harness_shared.plan_work_group_members
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND member_user = ${memberUser}
    RETURNING member_user
  `;
  return rows.length > 0;
}

export async function isWorkGroupMember(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
  memberUser: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM harness_shared.plan_work_group_members
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
       AND plan_slug = ${planSlug} AND member_user = ${memberUser}
  `;
  return rows.length > 0;
}

/** Whether a work-group has been DECLARED for this plan (has ≥1 member). */
export async function workGroupExists(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one FROM harness_shared.plan_work_group_members
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
     LIMIT 1
  `;
  return rows.length > 0;
}

export async function listWorkGroup(
  workspaceId: string,
  harnessSlug: string,
  planSlug: string,
): Promise<WorkGroupMember[]> {
  const { sql } = getOrgPg();
  const rows = await sql<WorkGroupDbRow[]>`
    SELECT workspace_id, harness_slug, plan_slug, member_user, member_name, joined_at
      FROM harness_shared.plan_work_group_members
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug} AND plan_slug = ${planSlug}
     ORDER BY joined_at
  `;
  return rows.map(memberFromDb);
}

interface WorkGroupDbRow {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  member_user: string;
  member_name: string | null;
  joined_at: string;
}
function memberFromDb(r: WorkGroupDbRow): WorkGroupMember {
  return {
    workspaceId: r.workspace_id,
    harnessSlug: r.harness_slug,
    planSlug: r.plan_slug,
    memberUser: r.member_user,
    memberName: r.member_name,
    joinedAt: r.joined_at,
  };
}
