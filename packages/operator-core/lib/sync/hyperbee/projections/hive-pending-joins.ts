/**
 * Hyperbee → PG projection for `harness_shared.pot_pending_joins` — the approval-mode
 * admission queue federated across a Hive's peers (Brief EN-3 / P-MEMBER; migration 318).
 *
 * Mirrors projections/hive-settings.ts (the freshest per-Hive template — scope column
 * `harness_slug` = the Hive home_slug, the stock capture). Bidirectional on the hive-home
 * seam: a JOINER writes a pending REQUEST (origin='local' → federates to the owner's home
 * projection), and the OWNER writes the DECISION (status='approved'/'denied') to the same
 * key → federates back to the joiner. The HLC LWW guard orders request-vs-decision so the
 * owner's later decision wins.
 *
 * The per-projection guard (`row.harness_slug !== opts.harnessSlug`) demuxes by Hive home.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import type { DeviceAttestationEntry } from '../../../harness/contributor-row-types';

/** Wire-shape of a hive_pending_joins row — the federated subset. Defensive: a
 *  malformed remote op is dropped (decodeValue → null). */
export interface PendingJoinWireRow {
  /** The Hive's home_slug — the per-projection demux key. */
  harness_slug: string;
  github_user_id: number;
  github_username: string;
  display_name: string | null;
  avatar_url: string | null;
  device_attestations: DeviceAttestationEntry[];
  status: string;
  reason: string | null;
  requested_at: number;
  decided_at: number | null;
  decided_by_github_user_id: number | null;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isNumOrNull(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isPendingJoinWireRow(input: unknown): input is PendingJoinWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (!isPosInt(r.github_user_id)) return false;
  if (typeof r.github_username !== 'string' || r.github_username.length === 0) return false;
  if (!isStrOrNull(r.display_name)) return false;
  if (!isStrOrNull(r.avatar_url)) return false;
  if (!Array.isArray(r.device_attestations)) return false;
  if (typeof r.status !== 'string' || r.status.length === 0) return false;
  if (!isStrOrNull(r.reason)) return false;
  if (typeof r.requested_at !== 'number') return false;
  if (!isNumOrNull(r.decided_at)) return false;
  if (!isNumOrNull(r.decided_by_github_user_id)) return false;
  return true;
}

export interface HivePendingJoinsProjectionOpts {
  workspaceId: string;
  /** The registered Hive HOME harness slug — the demux scope. */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

/** The peer-log key for a pending-join row == the joiner's github_user_id (matches the
 *  generated `pending_join_fed_key` column + the store). */
function composeKey(row: PendingJoinWireRow): string {
  return String(row.github_user_id);
}

function decodeValue(raw: unknown): PendingJoinWireRow | null {
  return isPendingJoinWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HivePendingJoinsProjectionOpts,
  row: PendingJoinWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return; // cross-Hive op — drop
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.pot_pending_joins
      (workspace_id, harness_slug, github_user_id, github_username, display_name, avatar_url,
       device_attestations, status, reason, requested_at, decided_at, decided_by_github_user_id,
       author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.github_username},
       ${row.display_name}, ${row.avatar_url},
       ${JSON.stringify(row.device_attestations ?? [])}::text::jsonb,
       ${row.status}, ${row.reason}, ${row.requested_at}, ${row.decided_at},
       ${row.decided_by_github_user_id}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id) DO UPDATE SET
      github_username           = EXCLUDED.github_username,
      display_name              = EXCLUDED.display_name,
      avatar_url                = EXCLUDED.avatar_url,
      device_attestations       = EXCLUDED.device_attestations,
      status                    = EXCLUDED.status,
      reason                    = EXCLUDED.reason,
      decided_at                = EXCLUDED.decided_at,
      decided_by_github_user_id = EXCLUDED.decided_by_github_user_id,
      author_pubkey             = EXCLUDED.author_pubkey,
      origin                    = EXCLUDED.origin,
      fed_ts                    = EXCLUDED.fed_ts,
      fed_hlc                   = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_pending_joins.fed_hlc, harness_shared.pot_pending_joins.fed_ts)
  `;
}

async function deleteFromPg(
  opts: HivePendingJoinsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  const userId = Number(key);
  if (!Number.isFinite(userId) || userId <= 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_pending_joins
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHivePendingJoinsProjection(
  opts: HivePendingJoinsProjectionOpts,
): TableProjection<PendingJoinWireRow> {
  return {
    tableTag: 'hive-pending-joins',
    // CDC-captured table (mig 318) — own-log ops are replays (EI-117).
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isPendingJoinWireRow };
