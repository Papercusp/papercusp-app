/**
 * Hyperbee → PG projection for `harness_shared.feature_working_set`.
 *
 * Plan: papercusp-dogfood-phase6-orchestrator-claim-2026-05-24 P-038
 * (manual "set active") + v5 §0.5 working_users.
 *
 * Per-user "actively working" pointer table. Same key shape as
 * feature_queue (`<github_user_id>/<feature_id>` inside one harness's
 * Hyperbee; PG PK is `(workspace_id, harness_slug, github_user_id,
 * feature_id)`).
 *
 * Soft-delete shape: `cleared_at` flips null → epoch ms when the user
 * stops working. A `put` with `cleared_at != null` is the tombstone;
 * a `del` op is a hard DELETE. Same dual-support as feature_queue.
 *
 * Semantics vs neighbors:
 *   - feature_queue   = "I intend to work on this" (queue membership).
 *   - feature_working_set = "I am working on this NOW" (this table).
 *   - harness_features.claims = orchestrator worker dispatch (machine).
 * The orchestrator's claim-eligibility check excludes any feature with
 * a non-empty working set (P-038b).
 *
 * ── working_users[] reconciliation (Phase 8 P-038) ──
 * This per-(user, feature) pointer table is the DETAIL layer. The
 * CANONICAL "working_users projection" the rest of the app reads is the
 * `harness_features_consolidated.working_users BIGINT[]` array (v5 §0.5 /
 * §7.1 / D-016: `current_worker = working_users[0]` is DERIVED, never
 * stored). That array is what the UI's already-wired
 * `featuresConsolidated.bySlug` SSE query carries — so this projection
 * keeps it in sync: every put/del recomputes the feature's array from the
 * live (non-cleared) pointer rows. Without this the column stays at its
 * `'{}'` default and the "who's working" UI surface reads nothing.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { decideMemberContentOp } from '../member-content-guard';
import type { PendingMembershipContent } from '../pending-membership-content';

export interface FeatureWorkingSetRow {
  harness_slug: string;
  github_user_id: number;
  feature_id: string;
  started_at: number; // epoch ms
  cleared_at: number | null; // null = still active
  schema_version: number;
}

export interface FeatureWorkingSetProjectionOpts {
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

export function composeFeatureWorkingSetKey(
  githubUserId: number,
  featureId: string,
): string {
  return `${githubUserId}/${featureId}`;
}

function composeKey(row: FeatureWorkingSetRow): string {
  return composeFeatureWorkingSetKey(row.github_user_id, row.feature_id);
}

export function isFeatureWorkingSetRow(input: unknown): input is FeatureWorkingSetRow {
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
    typeof r.started_at === 'number' &&
    Number.isFinite(r.started_at) &&
    (r.cleared_at === null ||
      (typeof r.cleared_at === 'number' && Number.isFinite(r.cleared_at))) &&
    typeof r.schema_version === 'number' &&
    Number.isInteger(r.schema_version)
  );
}

function decodeValue(raw: unknown): FeatureWorkingSetRow | null {
  return isFeatureWorkingSetRow(raw) ? raw : null;
}

export interface RecomputeWorkingUsersArgs {
  workspaceId: string;
  harnessSlug: string;
  featureId: string;
}

/**
 * Build the parameterized statement that re-derives a feature's canonical
 * `harness_features_consolidated.working_users` BIGINT[] from the live
 * (non-cleared) pointer rows of `feature_working_set`. Pure (returns
 * `{ query, params }`) so it is unit-testable without a DB and so both the
 * put and del paths share one definition.
 *
 * `working_users[0]` is the earliest worker → `current_worker` per D-016, so
 * the array is ordered by `started_at ASC`. COALESCE keeps the column at the
 * `'{}'` empty-array default (never NULL) when nobody is working.
 *
 * Scoping: `$1` (workspace_id) scopes the pointer sub-select. The UPDATE
 * target matches on `(harness_slug, feature_id)` — the consolidated row's PK —
 * exactly as the sibling `harness-features` projection scopes its writes
 * (harness_slug is globally unique across workspaces today; per-workspace
 * partitioning of the consolidated view is future work).
 */
export function buildRecomputeWorkingUsersQuery(
  args: RecomputeWorkingUsersArgs,
): { query: string; params: unknown[] } {
  const query = `
    UPDATE harness_shared.harness_features_consolidated AS f
    SET working_users = COALESCE(
      (
        SELECT array_agg(w.github_user_id ORDER BY w.started_at ASC, w.github_user_id ASC)
        FROM harness_shared.feature_working_set w
        WHERE w.workspace_id = $1
          AND w.harness_slug = $2
          AND w.feature_id = $3
          AND w.cleared_at IS NULL
      ),
      '{}'::bigint[]
    )
    WHERE f.harness_slug = $2
      AND f.feature_id = $3
  `;
  return { query, params: [args.workspaceId, args.harnessSlug, args.featureId] };
}

async function recomputeWorkingUsers(
  opts: FeatureWorkingSetProjectionOpts,
  featureId: string,
): Promise<void> {
  if (!featureId) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const { query, params } = buildRecomputeWorkingUsersQuery({
    workspaceId: opts.workspaceId,
    harnessSlug: opts.harnessSlug,
    featureId,
  });
  await sql.unsafe(query, params as never);
}

async function writeToPg(
  opts: FeatureWorkingSetProjectionOpts,
  row: FeatureWorkingSetRow,
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
          tableTag: 'working-set',
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
          tableTag: 'working-set',
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
    INSERT INTO harness_shared.feature_working_set
      (workspace_id, harness_slug, github_user_id, feature_id, started_at, cleared_at, schema_version,
       author_pubkey, origin, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.feature_id},
       to_timestamp(${row.started_at} / 1000.0),
       ${row.cleared_at == null ? null : sql`to_timestamp(${row.cleared_at} / 1000.0)`},
       ${row.schema_version}, ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id, feature_id) DO UPDATE SET
      started_at = EXCLUDED.started_at,
      cleared_at = EXCLUDED.cleared_at,
      schema_version = EXCLUDED.schema_version,
      author_pubkey = EXCLUDED.author_pubkey,
      origin = EXCLUDED.origin,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(feature_working_set.fed_hlc, feature_working_set.fed_ts)
  `;
  // Reconcile the canonical working_users[] array (Phase 8 P-038): a put may
  // start work (cleared_at NULL) or tombstone it (cleared_at set), both of
  // which change the live set. Recompute from the pointer rows.
  await recomputeWorkingUsers(opts, row.feature_id);
}

async function deleteFromPg(
  opts: FeatureWorkingSetProjectionOpts,
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
    DELETE FROM harness_shared.feature_working_set
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
  // A hard delete removes a worker → recompute the canonical array (idempotent;
  // safe to run even when the guarded DELETE above matched nothing).
  await recomputeWorkingUsers(opts, featureId);
}

export function buildFeatureWorkingSetProjection(
  opts: FeatureWorkingSetProjectionOpts,
): TableProjection<FeatureWorkingSetRow> {
  return {
    tableTag: 'working-set',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isFeatureWorkingSetRow,
  buildRecomputeWorkingUsersQuery,
};
