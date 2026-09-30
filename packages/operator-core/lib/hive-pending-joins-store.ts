/**
 * hive-pending-joins-store — PG access to harness_shared.pot_pending_joins, the
 * approval-mode admission queue (Brief EN-3 / P-MEMBER; migration 318).
 *
 * The sibling of hive-membership-store.ts at the same Hive grain. Under
 * `membership: 'approval'` a prospective joiner writes a PENDING request here (its
 * own row, origin='local' → federates to the owner over the hive-home seam); the
 * owner DECIDES (approve → upsertHiveMember + status='approved'; deny →
 * status='denied'), and the decision federates back. A joiner is NOT trust-admitted
 * (never lands in hive_members) until the owner approves — the brief's "stays
 * pending until owner-approved".
 *
 * FEDERATION model (mirrors hive_members revoke's owner-writes-own-row idea, but
 * here LWW-mediated): the REQUEST row is written by the joiner; the DECISION is an
 * update to the SAME (ws, home, github_user_id) key written by the OWNER. Both
 * carry fed_hlc, so the projection's HLC LWW guard orders them — the owner's
 * decision (later HLC) wins over a re-request. Single-column federation key =
 * github_user_id (the generated pending_join_fed_key text column).
 *
 * Crypto-free + PG-only; every fn takes an optional `sql` client so integration
 * tests pass a per-file schema, and carries an explicit `WHERE workspace_id = $1`
 * (RLS is the backstop, D-004).
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { DeviceAttestationEntry } from './harness/contributor-row-types';

export type PendingJoinStatus = 'pending' | 'approved' | 'denied';

/** A pending-join request row. */
export interface PendingJoinRecord {
  workspaceId: string;
  /** The Hive's home_slug (the federation demux scope). */
  potHomeSlug: string;
  githubUserId: number;
  githubUsername: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** The joiner's bound devices, captured at request time (used to upsertHiveMember on approval). */
  deviceAttestations: DeviceAttestationEntry[];
  status: PendingJoinStatus;
  /** Optional owner note (e.g. a deny reason). */
  reason: string | null;
  requestedAt: number;
  decidedAt: number | null;
  decidedByGithubUserId: number | null;
}

export interface RecordPendingJoinInput {
  workspaceId: string;
  potHomeSlug: string;
  githubUserId: number;
  githubUsername: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  deviceAttestations?: DeviceAttestationEntry[];
}

interface PendingJoinPgRow {
  workspace_id: string;
  harness_slug: string;
  github_user_id: string | number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: DeviceAttestationEntry[] | string | null;
  status: string;
  reason: string | null;
  requested_at: string | number;
  decided_at: string | number | null;
  decided_by_github_user_id: string | number | null;
}

function parseAttestations(v: DeviceAttestationEntry[] | string | null): DeviceAttestationEntry[] {
  if (v == null) return [];
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as DeviceAttestationEntry[]) : [];
    } catch {
      return [];
    }
  }
  return v;
}

function numOrNull(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function rowToRecord(r: PendingJoinPgRow): PendingJoinRecord {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    githubUserId: Number(r.github_user_id),
    githubUsername: r.github_username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    deviceAttestations: parseAttestations(r.device_attestations),
    status: (r.status as PendingJoinStatus) ?? 'pending',
    reason: r.reason,
    requestedAt: numOrNull(r.requested_at) ?? 0,
    decidedAt: numOrNull(r.decided_at),
    decidedByGithubUserId: numOrNull(r.decided_by_github_user_id),
  };
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

const COLS = `workspace_id, harness_slug, github_user_id, github_username,
  display_name, avatar_url, device_attestations, status, reason,
  requested_at, decided_at, decided_by_github_user_id`;

/**
 * Record (or refresh) a joiner's PENDING request. Idempotent: a re-request from a
 * still-pending joiner refreshes only the identity/device fields; it does NOT reset
 * a decided (approved/denied) row's status — a denied joiner cannot re-open the
 * queue by re-requesting (the owner's decision is preserved; only the owner moves
 * it via approve/deny). Returns the current row.
 */
export async function recordPendingJoin(
  input: RecordPendingJoinInput,
  sql?: Sql,
): Promise<PendingJoinRecord> {
  const rows = (await pg(sql).unsafe(
    `INSERT INTO harness_shared.pot_pending_joins
       (workspace_id, harness_slug, github_user_id, github_username,
        display_name, avatar_url, device_attestations, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, 'pending')
     ON CONFLICT (workspace_id, harness_slug, github_user_id) DO UPDATE SET
       github_username     = EXCLUDED.github_username,
       display_name        = EXCLUDED.display_name,
       avatar_url          = EXCLUDED.avatar_url,
       device_attestations = EXCLUDED.device_attestations,
       updated_at          = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
       -- NB: status/reason/decided_* are intentionally NOT reset — a prior owner
       -- decision survives a re-request (a denied joiner stays denied).
     RETURNING ${COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      input.githubUserId,
      input.githubUsername,
      input.displayName ?? null,
      input.avatarUrl ?? null,
      JSON.stringify(input.deviceAttestations ?? []),
    ],
  )) as unknown as PendingJoinPgRow[];
  return rowToRecord(rows[0]);
}

/** Get one pending-join row. */
export async function getPendingJoin(
  workspaceId: string,
  potHomeSlug: string,
  githubUserId: number,
  sql?: Sql,
): Promise<PendingJoinRecord | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${COLS} FROM harness_shared.pot_pending_joins
      WHERE workspace_id = $1 AND harness_slug = $2 AND github_user_id = $3 LIMIT 1`,
    [workspaceId, potHomeSlug, githubUserId],
  )) as unknown as PendingJoinPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * List a Hive's pending-join requests, default status='pending' (the owner queue).
 * Pass status=null for the full history (incl. approved/denied).
 */
export async function listPendingJoins(
  workspaceId: string,
  potHomeSlug: string,
  opts: { status?: PendingJoinStatus | null } = {},
  sql?: Sql,
): Promise<PendingJoinRecord[]> {
  const status = opts.status === undefined ? 'pending' : opts.status;
  const rows = (await pg(sql).unsafe(
    status == null
      ? `SELECT ${COLS} FROM harness_shared.pot_pending_joins
           WHERE workspace_id = $1 AND harness_slug = $2
           ORDER BY requested_at ASC`
      : `SELECT ${COLS} FROM harness_shared.pot_pending_joins
           WHERE workspace_id = $1 AND harness_slug = $2 AND status = $3
           ORDER BY requested_at ASC`,
    status == null ? [workspaceId, potHomeSlug] : [workspaceId, potHomeSlug, status],
  )) as unknown as PendingJoinPgRow[];
  return rows.map(rowToRecord);
}

/**
 * Record the owner's DECISION on a pending request (approve/deny). Updates status,
 * decided_at, decided_by, and the optional reason. The owner is the writer (origin=
 * 'local' on the owner) so the decision federates back to the joiner; the LWW guard
 * orders it after the joiner's request. Returns the updated row, or null if absent.
 */
export async function setPendingJoinDecision(
  workspaceId: string,
  potHomeSlug: string,
  githubUserId: number,
  status: Exclude<PendingJoinStatus, 'pending'>,
  decidedByGithubUserId: number,
  reason?: string | null,
  sql?: Sql,
): Promise<PendingJoinRecord | null> {
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.pot_pending_joins
        SET status = $4,
            decided_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint,
            decided_by_github_user_id = $5,
            reason = $6,
            updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
      WHERE workspace_id = $1 AND harness_slug = $2 AND github_user_id = $3
      RETURNING ${COLS}`,
    [workspaceId, potHomeSlug, githubUserId, status, decidedByGithubUserId, reason ?? null],
  )) as unknown as PendingJoinPgRow[];
  return rows[0] ? rowToRecord(rows[0]) : null;
}
