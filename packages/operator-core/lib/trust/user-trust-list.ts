/**
 * user-trust-list — the owner's LOCAL trusted-GitHub-user list
 * (shared-hive-trust-admission-2026-06-14 Phase 3 / P-009, D-001). The owner-facing
 * CRUD over `harness_shared.user_trust_list` that the admission gate
 * (work-items-admission.ts {@link autoPickableWhereSql} / {@link isAutoPickable})
 * consults so a VERIFIED trusted author's remote work may auto-run. Backs the
 * `trust:add` / `trust:remove` / `trust:list` tools.
 *
 * EVERY function is EXPLICITLY workspace-scoped (D-004 — SECURITY-CRITICAL): the
 * list is owner/workspace-keyed and these run via the admin handle, which BYPASSES
 * RLS, so the `workspace_id` MUST be in the SQL — never rely on the table's RLS
 * policy (an unscoped query would trust-admit across workspaces). LOCAL-only /
 * owner-scoped / NEVER federated (D-001): no sync/hyperbee projection.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';

export interface TrustedUser {
  githubUserId: number;
  note: string | null;
  /** epoch ms */
  createdTs: number;
}

/** The column is BIGINT — postgres-js may hand it back as a string; coerce to number. */
function asId(raw: string | number): number {
  return typeof raw === 'string' ? Number(raw) : raw;
}

function assertGithubUserId(id: number, verb: string): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`${verb} — githubUserId must be a positive integer (got ${id})`);
  }
}

/** The workspace's trusted GitHub user ids, newest first. Workspace-scoped (D-004). */
export async function listTrustedUsers(workspaceId: string): Promise<TrustedUser[]> {
  if (!workspaceId) return [];
  const { sql } = getOrgPg();
  const rows = await sql<{ trusted_github_user_id: string | number; note: string | null; created_ts: string | number }[]>`
    SELECT trusted_github_user_id, note, created_ts
      FROM harness_shared.user_trust_list
     WHERE workspace_id = ${workspaceId}
     ORDER BY created_ts DESC, trusted_github_user_id ASC`;
  return rows.map((r) => ({ githubUserId: asId(r.trusted_github_user_id), note: r.note, createdTs: Number(r.created_ts) }));
}

export interface AddTrustedUserInput {
  githubUserId: number;
  note?: string | null;
  /** Audit actor + timestamp, injected by the caller (so the store stays pure-ish). */
  actor: string;
  nowMs: number;
}

/**
 * Trust a GitHub user (idempotent on (workspace_id, id) — re-adding updates the note,
 * preserving the original created_ts). Workspace-scoped (D-004) + audited.
 */
export async function addTrustedUser(workspaceId: string, input: AddTrustedUserInput): Promise<TrustedUser> {
  if (!workspaceId) throw new Error('trust:add — no workspace');
  assertGithubUserId(input.githubUserId, 'trust:add');
  const { sql } = getOrgPg();
  const note = input.note ?? null;
  const [row] = await sql<{ trusted_github_user_id: string | number; note: string | null; created_ts: string | number }[]>`
    INSERT INTO harness_shared.user_trust_list (workspace_id, trusted_github_user_id, note, created_ts)
    VALUES (${workspaceId}, ${input.githubUserId}, ${note}, ${input.nowMs})
    ON CONFLICT (workspace_id, trusted_github_user_id) DO UPDATE SET note = EXCLUDED.note
    RETURNING trusted_github_user_id, note, created_ts`;
  await recordTrustAudit(sql, input.actor, 'trust:add', String(input.githubUserId), workspaceId, { note });
  return { githubUserId: asId(row!.trusted_github_user_id), note: row!.note, createdTs: Number(row!.created_ts) };
}

/** Un-trust a GitHub user. Returns whether a row was removed. Workspace-scoped (D-004) + audited. */
export async function removeTrustedUser(
  workspaceId: string,
  githubUserId: number,
  actor: string,
): Promise<{ removed: boolean }> {
  if (!workspaceId) throw new Error('trust:remove — no workspace');
  assertGithubUserId(githubUserId, 'trust:remove');
  const { sql } = getOrgPg();
  const rows = await sql`
    DELETE FROM harness_shared.user_trust_list
     WHERE workspace_id = ${workspaceId} AND trusted_github_user_id = ${githubUserId}
    RETURNING trusted_github_user_id`;
  const removed = rows.length > 0;
  if (removed) await recordTrustAudit(sql, actor, 'trust:remove', String(githubUserId), workspaceId, {});
  return { removed };
}

/**
 * Append an `audit_log` row for a trust-list change (a security grant/revoke). Fire-safe:
 * the write already succeeded; never block it on the audit (mirrors recordAutonomyAudit —
 * full-column shape since audit_log has no defaults for id / workspace_id).
 */
async function recordTrustAudit(
  sql: Sql,
  actor: string,
  action: string,
  subject: string,
  workspaceId: string,
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    const id = `trust-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await sql`
      INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
      VALUES (${id}, ${Date.now()}, ${actor}, ${action}, ${subject},
              ${JSON.stringify(extra)}::text::jsonb, ${workspaceId})`;
  } catch (err) {
    console.warn('[trust] audit write failed:', (err as Error)?.message);
  }
}
