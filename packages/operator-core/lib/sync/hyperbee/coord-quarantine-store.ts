/**
 * coord-quarantine-store — writer/reader for `harness_shared.coord_quarantine`
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-013, mig 436).
 *
 * QUARANTINE, DON'T DROP: a below-tier federated coord message lands here
 * instead of coord_event_log — visible + grantable (the requests surface),
 * never silently vanished. BOUNDED per author device (oldest evicted past the
 * cap) so an untrusted member can't flood PG. Local-only; never federates.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';

/** Per-author-device row cap (oldest evicted). Env-tunable. */
export const DEFAULT_QUARANTINE_PER_AUTHOR_CAP =
  Number(process.env.PAPERCUSP_COORD_QUARANTINE_PER_AUTHOR_CAP) || 200;

export type QuarantineReason = 'below-message-tier' | 'handoff-below-steer' | 'rate-exceeded';

export interface QuarantineCoordMessageInput {
  workspaceId: string;
  msgId: string;
  harnessSlug: string;
  surface: string;
  body: Record<string, unknown>;
  authorGithubUserId: number | null;
  authorDevicePubkey: string;
  reason: QuarantineReason;
  /** The message's own ts (epoch ms). */
  msgTs: number;
  nowMs?: number;
}

/** Insert (idempotent on msg_id) + evict the author's oldest rows past the cap. */
export async function quarantineCoordMessage(
  input: QuarantineCoordMessageInput,
  sqlIn?: postgres.Sql,
): Promise<void> {
  const sql = sqlIn ?? getOrgPg().sql;
  const now = input.nowMs ?? Date.now();
  await sql`
    INSERT INTO harness_shared.coord_quarantine
      (workspace_id, msg_id, harness_slug, surface, body, author_github_user_id,
       author_device_pubkey, reason, msg_ts, created_ts)
    VALUES
      (${input.workspaceId}, ${input.msgId}, ${input.harnessSlug}, ${input.surface},
       ${JSON.stringify(input.body)}::text::jsonb, ${input.authorGithubUserId},
       ${input.authorDevicePubkey}, ${input.reason}, ${input.msgTs}, ${now})
    ON CONFLICT (workspace_id, msg_id) DO NOTHING
  `;
  // Bound: evict the author's oldest rows past the cap (flood containment).
  await sql`
    DELETE FROM harness_shared.coord_quarantine
    WHERE workspace_id = ${input.workspaceId}
      AND author_device_pubkey = ${input.authorDevicePubkey}
      AND msg_id IN (
        SELECT msg_id FROM harness_shared.coord_quarantine
        WHERE workspace_id = ${input.workspaceId}
          AND author_device_pubkey = ${input.authorDevicePubkey}
        ORDER BY created_ts DESC, msg_id
        OFFSET ${DEFAULT_QUARANTINE_PER_AUTHOR_CAP}
      )
  `;
}

export interface QuarantinedCoordMessage {
  msgId: string;
  harnessSlug: string;
  surface: string;
  body: Record<string, unknown>;
  authorGithubUserId: number | null;
  authorDevicePubkey: string;
  reason: QuarantineReason;
  msgTs: number;
  createdTs: number;
}

/** The quarantine queue, newest first — the "X wants to message you" surface. */
export async function listCoordQuarantine(
  opts: { workspaceId: string; authorGithubUserId?: number; limit?: number },
  sqlIn?: postgres.Sql,
): Promise<QuarantinedCoordMessage[]> {
  const sql = sqlIn ?? getOrgPg().sql;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql<
    Array<{
      msg_id: string;
      harness_slug: string;
      surface: string;
      body: Record<string, unknown>;
      author_github_user_id: string | number | null;
      author_device_pubkey: string;
      reason: QuarantineReason;
      msg_ts: string | number;
      created_ts: string | number;
    }>
  >`
    SELECT msg_id, harness_slug, surface, body, author_github_user_id,
           author_device_pubkey, reason, msg_ts, created_ts
    FROM harness_shared.coord_quarantine
    WHERE workspace_id = ${opts.workspaceId}
      ${opts.authorGithubUserId != null ? sql`AND author_github_user_id = ${opts.authorGithubUserId}` : sql``}
    ORDER BY created_ts DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    msgId: r.msg_id,
    harnessSlug: r.harness_slug,
    surface: r.surface,
    body: r.body,
    authorGithubUserId: r.author_github_user_id == null ? null : Number(r.author_github_user_id),
    authorDevicePubkey: r.author_device_pubkey,
    reason: r.reason,
    msgTs: Number(r.msg_ts),
    createdTs: Number(r.created_ts),
  }));
}

/**
 * WI-1455/P-013: clear an author's quarantined backlog — the "grant" half of the
 * requests surface (mirrors the membership approval queue's approve-then-drain).
 * Called right after the owner raises the author's comms tier (trust:comms
 * {action:'grant'}): the backlog is now moot — the sender is trusted going
 * forward, and re-delivering stale quarantined bodies through the live merge
 * path is out of scope (D-007 point 2 already treats quarantine as bounded,
 * evictable buffer, not a durable inbox). Idempotent — clearing an empty
 * backlog is a no-op returning cleared:0.
 */
export async function clearCoordQuarantineForAuthor(
  opts: { workspaceId: string; authorGithubUserId: number },
  sqlIn?: postgres.Sql,
): Promise<{ cleared: number }> {
  const sql = sqlIn ?? getOrgPg().sql;
  const rows = await sql`
    DELETE FROM harness_shared.coord_quarantine
    WHERE workspace_id = ${opts.workspaceId}
      AND author_github_user_id = ${opts.authorGithubUserId}
  `;
  return { cleared: rows.count ?? 0 };
}
