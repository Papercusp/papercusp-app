/**
 * Hyperbee → PG projection for `harness_shared.coord_threads`.
 *
 * Plan: distributed-coordination-shared-harness-2026-06-04 (Track A). A
 * harness-scoped thread (the reply timeline of a harness conversation) federates
 * over the harness's peer-log. The per-harness Hyperbee key is the `thread_id`,
 * which is DETERMINISTIC from the parent (`thr-<conversationId>`) so every machine
 * converges on one canonical thread per parent (the coord_threads parent-unique
 * index would otherwise reject a peer's thread under a federation race).
 *
 * Federated fields = the thread header (parent, title, created_by, created_at,
 * last_post_at, post_count). The remote applies federated POSTS via the
 * coord-thread-post projection (which does not bump post_count), so post_count
 * rides this header. NOT federated: workspace_id (local bound).
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { projectionSql, type TableProjection, type ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

export interface CoordThreadRow {
  harness_slug: string;
  thread_id: string;
  parent_kind: string;
  parent_ref: string;
  title: string | null;
  created_by: string | null;
  created_at: number;            // epoch ms
  last_post_at: number | null;   // epoch ms | null
  post_count: number;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isCoordThreadRow(input: unknown): input is CoordThreadRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.thread_id) || r.thread_id.length === 0) return false;
  if (!isString(r.parent_kind) || r.parent_kind.length === 0) return false;
  if (!isString(r.parent_ref) || r.parent_ref.length === 0) return false;
  if (!isStringOrNull(r.title)) return false;
  if (!isStringOrNull(r.created_by)) return false;
  if (typeof r.created_at !== 'number' || !Number.isFinite(r.created_at)) return false;
  if (!(r.last_post_at === null || (typeof r.last_post_at === 'number' && Number.isFinite(r.last_post_at)))) return false;
  if (typeof r.post_count !== 'number' || !Number.isInteger(r.post_count)) return false;
  return true;
}

function decodeValue(raw: unknown): CoordThreadRow | null {
  return isCoordThreadRow(raw) ? raw : null;
}

export interface CoordThreadProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  sql?: postgres.Sql;
  /** WI-259 parity (shared-hive comms federation): hive-home slug when this harness is a hive
   *  MEMBER — a cross-member coord op is membership-gated only when set; undefined for a
   *  non-hive / owned-home harness. Threaded via RegisterAllOpts (same as the content projections). */
  potHomeSlug?: string;
  /** WI-259 parity: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities). */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004 parity: content-before-membership defer buffer — a cross-member op the guard
   *  drops ONLY because the author's hive_members row hasn't federated yet is buffered + re-applied
   *  on the onMemberApplied drain, not lost. */
  pendingMemberContent?: PendingMembershipContent;
}

function composeKey(row: CoordThreadRow): string {
  return row.thread_id;
}

async function writeToPg(
  opts: CoordThreadProjectionOpts,
  row: CoordThreadRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 parity (shared-hive comms federation): own-slug applies; a CROSS-member coord op
  // applies iff its VERIFIED source-log device ∈ the hive's CURRENT members — the SAME membership
  // guard the 6 content + plan-parts projections use (member-content-guard.ts decideMemberContentOp).
  // Previously a bare `row.harness_slug !== opts.harnessSlug` early-return meant harness-scoped coord
  // NEVER federated cross-member (the live member↔member topology): capture/drain/merge/admission all
  // worked, but the projection silently dropped every peer member's thread. The thread row applies
  // under its AUTHORED slug (the INSERT already keys on row.harness_slug), matching where the content
  // projections land cross-member rows.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'coord-threads',
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
          tableTag: 'coord-threads',
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
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.coord_threads
      (workspace_id, thread_id, parent_kind, parent_ref, title, created_by, created_at,
       last_post_at, post_count, harness_slug, origin, author_pubkey, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.thread_id}, ${row.parent_kind}, ${row.parent_ref}, ${row.title},
       ${row.created_by}, to_timestamp(${row.created_at} / 1000.0),
       ${row.last_post_at === null ? null : sql`to_timestamp(${row.last_post_at} / 1000.0)`},
       ${row.post_count}, ${row.harness_slug}, ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, thread_id) DO UPDATE SET
      parent_kind   = EXCLUDED.parent_kind,
      parent_ref    = EXCLUDED.parent_ref,
      title         = EXCLUDED.title,
      created_by    = EXCLUDED.created_by,
      last_post_at  = EXCLUDED.last_post_at,
      post_count    = EXCLUDED.post_count,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(coord_threads.fed_hlc, coord_threads.fed_ts)
  `;
}

async function deleteFromPg(
  opts: CoordThreadProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = await projectionSql(opts.sql ?? getOrgPg().sql);
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.coord_threads
    WHERE workspace_id = ${opts.workspaceId} AND thread_id = ${key}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildCoordThreadProjection(
  opts: CoordThreadProjectionOpts,
): TableProjection<CoordThreadRow> {
  return {
    tableTag: 'coord-threads',
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

export const _testing = { composeKey, decodeValue, isCoordThreadRow };
