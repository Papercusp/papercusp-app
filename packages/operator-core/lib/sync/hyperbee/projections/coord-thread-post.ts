/**
 * Hyperbee → PG projection for `harness_shared.coord_thread_posts`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A). A post on a
 * harness-scoped thread federates over the harness's peer-log. The per-harness
 * Hyperbee key is `post_msg_id` (a global newMsgId() the writer mints — the PK
 * `id` is a machine-local bigserial, not federation-safe).
 *
 * Federated fields = the post content (thread_id, author_id, body, created_at).
 * NOT federated: the bigserial `id` (a fresh local id is assigned on apply) and
 * `workspace_id` (the local projection's bound workspace).
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { projectionSql, type TableProjection, type ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

export interface CoordThreadPostRow {
  harness_slug: string;
  post_msg_id: string;
  thread_id: string;
  author_id: string | null;
  body: string;
  created_at: number;            // epoch ms
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isCoordThreadPostRow(input: unknown): input is CoordThreadPostRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.post_msg_id) || r.post_msg_id.length === 0) return false;
  if (!isString(r.thread_id) || r.thread_id.length === 0) return false;
  if (!(r.author_id === null || typeof r.author_id === 'string')) return false;
  if (!isString(r.body)) return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  return true;
}

function decodeValue(raw: unknown): CoordThreadPostRow | null {
  return isCoordThreadPostRow(raw) ? raw : null;
}

export interface CoordThreadPostProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive comms federation): hive-home slug when this harness is a hive
   *  MEMBER — a cross-member coord op is membership-gated only when set. */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from sourceLogKeyHex. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer. */
  pendingMemberContent?: PendingMembershipContent;
}

function composeKey(row: CoordThreadPostRow): string {
  return row.post_msg_id;
}

async function writeToPg(
  opts: CoordThreadPostProjectionOpts,
  row: CoordThreadPostRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 parity (shared-hive comms federation): own-slug applies; a CROSS-member post op applies
  // iff its VERIFIED source-log device ∈ the hive's CURRENT members (the bare slug early-return
  // previously dropped every peer member's post). The post applies under its AUTHORED slug (the
  // INSERT keys on row.harness_slug), matching where the parent coord_threads thread landed.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'coord-thread-posts',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    if (memberDecision === 'drop' && !sourceLogDevice && provenance?.authorPubkey && opts.pendingMemberContent) {
      opts.pendingMemberContent.deferUnresolvedSourceLog(
        {
          sourceLogKey: provenance.authorPubkey,
          tableTag: 'coord-thread-posts',
          rowKey: composeKey(row),
          fedHlc: provenance?.fedHlc ?? null,
          fedTs: provenance?.ts ?? null,
          reapply: () => writeToPg(opts, row, provenance),
        },
        Date.now(),
      );
    }
    return;
  }
  // P-537: the one apply statement runs on the merge's batch transaction when there is one.
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? row.created_at ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.coord_thread_posts
      (workspace_id, thread_id, author_id, body, created_at, post_msg_id, harness_slug, origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.thread_id}, ${row.author_id}, ${row.body},
       to_timestamp(${row.created_at} / 1000.0), ${row.post_msg_id}, ${row.harness_slug}, ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, post_msg_id)
      WHERE harness_slug IS NOT NULL AND post_msg_id IS NOT NULL
    DO UPDATE SET
      thread_id     = EXCLUDED.thread_id,
      author_id     = EXCLUDED.author_id,
      body          = EXCLUDED.body,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(coord_thread_posts.fed_hlc, coord_thread_posts.fed_ts)
  `;
}

async function deleteFromPg(
  opts: CoordThreadPostProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.coord_thread_posts
    WHERE workspace_id = ${opts.workspaceId} AND post_msg_id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildCoordThreadPostProjection(
  opts: CoordThreadPostProjectionOpts,
): TableProjection<CoordThreadPostRow> {
  return {
    tableTag: 'coord-thread-posts',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    // P-537 (D-034 #2): both statements go through projectionSql, none is caught, and no
    // transaction-local state is set, so ops fold inside the batch transaction.
    batchable: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isCoordThreadPostRow };
