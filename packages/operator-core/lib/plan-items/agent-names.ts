/**
 * agent-names — the stable agent-NAME registry + session adoption.
 *
 * Plan: plan-item-assignment-claim-liveness-2026-06-04 (Phase 0, D-006).
 *
 * Assignment targets a stable agent-NAME (e.g. `builder-1`) owned by a user, NOT
 * a session. Sessions are ephemeral (the `su-<uuid>` ownerId from
 * resolveAgentIdentity); the NAME persists. A session ADOPTS a name once, then
 * `my-items` / `claim` resolve the caller's name from the binding — so "assign
 * builder-1 its items; tell it to go to its items" works across interruptions
 * (the next session running as `builder-1` reads the durable assignment).
 *
 * owner_user is BEST-EFFORT today (userId ?? ownerId from the identity) — per-user
 * identity (distributed-coordination-shared-harness D-006, owned by su-584a8) is
 * unbuilt, so on a single box the owner is the session's own id. It strengthens to
 * a real cross-machine user when that lands; this module reads owner_user, so no
 * change is needed here when it does.
 *
 * Tables (migration 140): agent_names (workspace, agent_name → owner_user),
 * agent_name_sessions (workspace, session_owner_id → agent_name).
 */
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../agent-tools/coordination/identity';
import { resolvePlanScope } from '../agent-tools/plans/source';

export interface AgentNameRow {
  workspaceId: string;
  agentName: string;
  ownerUser: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdoptionRow {
  workspaceId: string;
  sessionOwnerId: string;
  agentName: string;
  ownerUser: string;
  adoptedAt: string;
}

/**
 * The best-effort owning USER for an identity. Per-user identity isn't built yet
 * (not yet scheduled), so we fall back to the stable per-session ownerId — correct
 * on a single box, and forward-compatible (when a real user id arrives in
 * ctx.userId, names mint under it instead).
 */
export function bestEffortOwnerUser(ctx: ResolveIdentityCtx): string {
  const id = resolveAgentIdentity(ctx);
  return id.userId && id.userId.length > 0 ? id.userId : id.ownerId;
}

/** Resolve the workspace a name/assignment lives in from an optional harness arg. */
export async function resolveWorkspace(harnessSlug?: string): Promise<string> {
  const { workspaceId } = await resolvePlanScope({ harnessSlug });
  return workspaceId;
}

/** Register (upsert) a stable agent-name owned by a user. Idempotent. */
export async function registerAgentName(
  workspaceId: string,
  agentName: string,
  ownerUser: string,
): Promise<AgentNameRow> {
  const { sql } = getOrgPg();
  const rows = await sql<AgentNameDbRow[]>`
    INSERT INTO harness_shared.agent_names (workspace_id, agent_name, owner_user)
    VALUES (${workspaceId}, ${agentName}, ${ownerUser})
    ON CONFLICT (workspace_id, agent_name) DO UPDATE SET
      owner_user = EXCLUDED.owner_user,
      updated_at = now()
    RETURNING workspace_id, agent_name, owner_user, created_at, updated_at
  `;
  return nameFromDb(rows[0]!);
}

/**
 * Adopt a name for the calling session: register the name (if new) under the
 * caller's best-effort user, then bind session_owner_id → agent_name. Returns the
 * binding. A session adopting a DIFFERENT name overwrites its prior binding (one
 * name per session).
 */
export async function adoptAgentName(
  workspaceId: string,
  sessionOwnerId: string,
  agentName: string,
  ownerUser: string,
): Promise<AdoptionRow> {
  await registerAgentName(workspaceId, agentName, ownerUser);
  const { sql } = getOrgPg();
  const rows = await sql<AdoptionDbRow[]>`
    INSERT INTO harness_shared.agent_name_sessions
      (workspace_id, session_owner_id, agent_name, owner_user)
    VALUES (${workspaceId}, ${sessionOwnerId}, ${agentName}, ${ownerUser})
    ON CONFLICT (workspace_id, session_owner_id) DO UPDATE SET
      agent_name = EXCLUDED.agent_name,
      owner_user = EXCLUDED.owner_user,
      adopted_at = now()
    RETURNING workspace_id, session_owner_id, agent_name, owner_user, adopted_at
  `;
  return adoptionFromDb(rows[0]!);
}

/** The agent-name this session has adopted, or null. */
export async function resolveAdoptedName(workspaceId: string, sessionOwnerId: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ agent_name: string }[]>`
    SELECT agent_name FROM harness_shared.agent_name_sessions
     WHERE workspace_id = ${workspaceId} AND session_owner_id = ${sessionOwnerId}
  `;
  return rows[0]?.agent_name ?? null;
}

/**
 * Every session that currently adopts a stable agent-name, newest adoption
 * first. Liveness is deliberately resolved by the caller: this registry is the
 * durable name→session binding, not a second presence oracle.
 */
export async function listSessionsForAgentName(workspaceId: string, agentName: string): Promise<AdoptionRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<AdoptionDbRow[]>`
    SELECT workspace_id, session_owner_id, agent_name, owner_user, adopted_at
      FROM harness_shared.agent_name_sessions
     WHERE workspace_id = ${workspaceId} AND agent_name = ${agentName}
     ORDER BY adopted_at DESC, session_owner_id
  `;
  return rows.map(adoptionFromDb);
}

/**
 * The agent-name to act AS for a call: an explicit override if given (and
 * registered/owned), else the session's adopted name. Throws if neither resolves —
 * a named operation must know who it is acting as.
 */
export async function requireActingName(
  ctx: ResolveIdentityCtx,
  workspaceId: string,
  explicit?: string,
): Promise<string> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const id = resolveAgentIdentity(ctx);
  const adopted = await resolveAdoptedName(workspaceId, id.ownerId);
  if (adopted) return adopted;
  throw new Error(
    'no agent-name: adopt one with plan_items:adopt_name { name } (or pass agent_name explicitly) — ' +
      'assignment is keyed on a stable agent-NAME a session adopts, not the session id',
  );
}

/** The owning user of a registered name, or null if the name is unknown. */
export async function agentNameOwner(workspaceId: string, agentName: string): Promise<string | null> {
  const { sql } = getOrgPg();
  const rows = await sql<{ owner_user: string }[]>`
    SELECT owner_user FROM harness_shared.agent_names
     WHERE workspace_id = ${workspaceId} AND agent_name = ${agentName}
  `;
  return rows[0]?.owner_user ?? null;
}

/** All names owned by a user in a workspace. */
export async function listNamesForOwner(workspaceId: string, ownerUser: string): Promise<AgentNameRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<AgentNameDbRow[]>`
    SELECT workspace_id, agent_name, owner_user, created_at, updated_at
      FROM harness_shared.agent_names
     WHERE workspace_id = ${workspaceId} AND owner_user = ${ownerUser}
     ORDER BY agent_name
  `;
  return rows.map(nameFromDb);
}

interface AgentNameDbRow {
  workspace_id: string;
  agent_name: string;
  owner_user: string;
  created_at: string;
  updated_at: string;
}
interface AdoptionDbRow {
  workspace_id: string;
  session_owner_id: string;
  agent_name: string;
  owner_user: string;
  adopted_at: string;
}
function nameFromDb(r: AgentNameDbRow): AgentNameRow {
  return {
    workspaceId: r.workspace_id,
    agentName: r.agent_name,
    ownerUser: r.owner_user,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function adoptionFromDb(r: AdoptionDbRow): AdoptionRow {
  return {
    workspaceId: r.workspace_id,
    sessionOwnerId: r.session_owner_id,
    agentName: r.agent_name,
    ownerUser: r.owner_user,
    adoptedAt: r.adopted_at,
  };
}
