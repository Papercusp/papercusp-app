/**
 * Hyperbee → PG projection for `harness_shared.feature_queue`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Per-user feature-queue pointer table. The Hyperbee key inside one
 * harness's Hyperbee is `<github_user_id>/<feature_id>` (the harness
 * is implicit per-Hyperbee). PG primary key is
 * `(workspace_id, harness_slug, github_user_id, feature_id)`.
 *
 * Soft-delete shape: `removed_at` flips from null → epoch ms when a
 * user dequeues. The projection treats `del` ops as hard-deletes
 * (full DELETE), while a `put` with `removed_at != null` is the
 * soft-delete tombstone shape — both supported per the v5 spec.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

export interface FeatureQueueRow {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  queued_at: number;            // epoch ms
  removed_at: number | null;    // null = still queued
  schema_version: number;
}

export interface FeatureQueueProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
  /** WI-259 P-002: hive-home slug when this harness is a hive MEMBER (cross-member content is
   *  membership-gated only when set); undefined for a non-hive / owned-home harness. */
  potHomeSlug?: string;
  /** WI-259 P-002: resolve an op's VERIFIED source-log device pubkey from its receiver-stamped
   *  sourceLogKeyHex (boot's admittedIdentities); threaded via RegisterAllOpts. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** WI-259 P-004: the content-before-membership defer buffer. When the membership guard would
   *  DROP a cross-member op ONLY because the author's hive_members row hasn't federated yet, the
   *  op is buffered here (keyed on the author device) + re-applied when that member joins — not
   *  lost. Undefined ⇒ today's drop (no buffer wired). Threaded via RegisterAllOpts. */
  pendingMemberContent?: PendingMembershipContent;
}

export function composeFeatureQueueKey(githubUserId: number, featureId: string): string {
  return `${githubUserId}/${featureId}`;
}

function composeKey(row: FeatureQueueRow): string {
  return composeFeatureQueueKey(row.github_user_id, row.feature_id);
}

export function isFeatureQueueRow(input: unknown): input is FeatureQueueRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  return (
    typeof r.harness_slug === 'string' &&
    r.harness_slug.length > 0 &&
    typeof r.github_user_id === 'number' &&
    Number.isInteger(r.github_user_id) &&
    r.github_user_id > 0 &&
    typeof r.feature_id === 'string' &&
    r.feature_id.length > 0 &&
    typeof r.queued_at === 'number' &&
    Number.isFinite(r.queued_at) &&
    (r.removed_at === null || (typeof r.removed_at === 'number' && Number.isFinite(r.removed_at))) &&
    typeof r.schema_version === 'number' &&
    Number.isInteger(r.schema_version)
  );
}

function decodeValue(raw: unknown): FeatureQueueRow | null {
  return isFeatureQueueRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FeatureQueueProjectionOpts,
  row: FeatureQueueRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // WI-259 P-002 membership guard (see member-content-guard.ts): own-slug applies; a cross-member
  // op applies iff its VERIFIED source-log device ∈ the hive's CURRENT members. resolveAuthorDevice
  // maps the immutable sourceLogKeyHex (provenance.authorPubkey for a remote op) → the admit-verified device.
  const sourceLogDevice = provenance?.authorPubkey
    ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
    : null;
  const memberDecision = await decideMemberContentOp(row.harness_slug, opts, sourceLogDevice);
  if (memberDecision !== 'apply') {
    // WI-259 P-004: a cross-member op the guard drops ONLY because the author's hive_members row
    // hasn't federated to this peer yet (decision 'defer', author device known) is BUFFERED + re-
    // applied when that member joins (the onMemberApplied drain), instead of lost to the advancing
    // merge cursor. A genuine non-member's op also defers, but the buffer's TTL evicts it (D-007).
    if (memberDecision === 'defer' && sourceLogDevice && opts.pendingMemberContent) {
      opts.pendingMemberContent.defer(
        {
          authorDevice: sourceLogDevice,
          tableTag: 'queue',
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
          tableTag: 'queue',
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
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.feature_queue
      (workspace_id, harness_slug, github_user_id, feature_id, queued_at, removed_at, schema_version,
       author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.feature_id},
       to_timestamp(${row.queued_at} / 1000.0),
       ${row.removed_at == null ? null : sql`to_timestamp(${row.removed_at} / 1000.0)`},
       ${row.schema_version}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, feature_id) DO UPDATE SET
      queued_at = EXCLUDED.queued_at,
      removed_at = EXCLUDED.removed_at,
      schema_version = EXCLUDED.schema_version,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(feature_queue.fed_hlc, feature_queue.fed_ts)
  `;
}

async function deleteFromPg(
  opts: FeatureQueueProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  // key shape: `<github_user_id>/<feature_id>`
  const sepIdx = key.indexOf('/');
  if (sepIdx <= 0) return;
  const userIdStr = key.slice(0, sepIdx);
  const featureId = key.slice(sepIdx + 1);
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId <= 0 || !featureId) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.feature_queue
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      AND feature_id = ${featureId}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildFeatureQueueProjection(
  opts: FeatureQueueProjectionOpts,
): TableProjection<FeatureQueueRow> {
  return {
    tableTag: 'queue',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFeatureQueueRow,
};
