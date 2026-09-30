/**
 * Hyperbee → PG projection for `harness_shared.contributors`.
 *
 * Plan: papercusp-dogfood-phase5a-hyperbee-plumbing-2026-05-24 P-031.
 *
 * Each shared harness's Hyperbee carries one
 * `contributors/<github_user_id>` row per human. The projection
 * consumes Hyperbee writes + upserts the row into the shared PG
 * table; symmetric delete on `del`.
 *
 * The Hyperbee key inside one harness's Hyperbee is just
 * `<github_user_id>` (no namespace prefix needed — Hyperbees are
 * per-harness). The PG primary key is
 * `(workspace_id, harness_slug, github_user_id)`.
 *
 * Workspace_id + harness_slug carry-through: the projection is
 * registered PER-HARNESS at boot; the registration closure binds
 * those values. The substrate's `applyHyperbeeOpToPg` calls the
 * harness-specific projection, which then composes the full PG
 * primary key.
 *
 * `device_attestations` JSONB array stays as JSON in PG; the type
 * spine's `isContributorRow` predicate validates the shape on
 * read. Defensive: dropping malformed rows rather than crashing
 * the projection loop.
 */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { normalizeJsonbInput } from './_jsonb-input';
import type { TableProjection, ProvenanceContext } from '../projection';
import {
  isContributorRow,
  type ContributorRow,
} from '../../../harness/contributor-row-types';

export interface ContributorsProjectionOpts {
  /** Test/multi-peer seam — write to THIS postgres-js client instead of the
   *  process-global `getOrgPg().sql`. Production leaves this undefined. */
  sql?: postgres.Sql;
  workspaceId: string;
  harnessSlug: string;
}

function composeKey(row: ContributorRow): string {
  // Within a per-harness Hyperbee, the key is `<github_user_id>`
  // (the harness is implicit). The full key is composed by the
  // substrate via `HYPERBEE_TAG_TO_PREFIX['contributors']` +
  // composeKey, producing `contributors/<github_user_id>`.
  return String(row.github_user_id);
}

function decodeValue(raw: unknown): ContributorRow | null {
  if (!isContributorRow(raw)) return null;
  return raw;
}

async function writeToPg(
  opts: ContributorsProjectionOpts,
  row: ContributorRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) {
    // Cross-harness write — drop silently. The projection is bound
    // to one harness; an op for a different one is a substrate bug
    // we don't want to compound by writing it through.
    return;
  }
  const sql = opts.sql ?? getOrgPg().sql;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.contributors
      (workspace_id, harness_slug, github_user_id, github_username,
       display_name, avatar_url,
       device_attestations, revoked_pubkeys,
       joined_at, last_seen_at,
       binding_status, channel1_verified_at, channel2_verified_at,
       channel2_branch_ref, binding_last_checked_at,
       schema_version, fed_ts, fed_hlc)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.github_user_id}, ${row.github_username},
       ${row.display_name}, ${row.avatar_url},
       -- jsonb: bind via JSON.stringify(x)::jsonb — sql.json THROWS under getOrgPg (agent-insights/postgres-js-jsonb-binding)
       ${JSON.stringify(normalizeJsonbInput(row.device_attestations) ?? [])}::text::jsonb, ${row.revoked_pubkeys as unknown as string},
       to_timestamp(${row.joined_at} / 1000.0),
       ${row.last_seen_at == null ? null : sql`to_timestamp(${row.last_seen_at} / 1000.0)`},
       ${row.binding_status},
       ${row.channel1_verified_at == null ? null : sql`to_timestamp(${row.channel1_verified_at} / 1000.0)`},
       ${row.channel2_verified_at == null ? null : sql`to_timestamp(${row.channel2_verified_at} / 1000.0)`},
       ${row.channel2_branch_ref},
       ${row.binding_last_checked_at == null ? null : sql`to_timestamp(${row.binding_last_checked_at} / 1000.0)`},
       ${row.schema_version}, ${fedTs}, ${fedHlc})
    ON CONFLICT (workspace_id, harness_slug, github_user_id) DO UPDATE SET
      github_username = EXCLUDED.github_username,
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url,
      device_attestations = EXCLUDED.device_attestations,
      revoked_pubkeys = EXCLUDED.revoked_pubkeys,
      last_seen_at = EXCLUDED.last_seen_at,
      binding_status = EXCLUDED.binding_status,
      channel1_verified_at = EXCLUDED.channel1_verified_at,
      channel2_verified_at = EXCLUDED.channel2_verified_at,
      channel2_branch_ref = EXCLUDED.channel2_branch_ref,
      binding_last_checked_at = EXCLUDED.binding_last_checked_at,
      schema_version = EXCLUDED.schema_version,
      fed_ts = EXCLUDED.fed_ts,
      fed_hlc = EXCLUDED.fed_hlc
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    -- WI-2933 (extends mig 504 fed_apply_wins): the bare ">=" applied unconditionally
    -- on an EXACT clock tie, so two cells writing the same contributor in the same
    -- tick could symmetrically swap values (composition-chaos P-002 class). This
    -- table has no author_pubkey/writer column (contributors never stamped one), so
    -- fed_apply_wins falls straight to its SYMMETRIC content-digest tiebreak, which
    -- both cells compute identically and so converge on the same row in one exchange.
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, NULL::text,
            md5(concat_ws('|', EXCLUDED.github_username, EXCLUDED.display_name, EXCLUDED.avatar_url,
                          EXCLUDED.device_attestations::text, array_to_string(EXCLUDED.revoked_pubkeys, ','),
                          EXCLUDED.last_seen_at::text, EXCLUDED.binding_status, EXCLUDED.channel1_verified_at::text,
                          EXCLUDED.channel2_verified_at::text, EXCLUDED.channel2_branch_ref,
                          EXCLUDED.binding_last_checked_at::text, EXCLUDED.schema_version::text)),
            contributors.fed_hlc, contributors.fed_ts, NULL::text,
            md5(concat_ws('|', contributors.github_username, contributors.display_name, contributors.avatar_url,
                          contributors.device_attestations::text, array_to_string(contributors.revoked_pubkeys, ','),
                          contributors.last_seen_at::text, contributors.binding_status, contributors.channel1_verified_at::text,
                          contributors.channel2_verified_at::text, contributors.channel2_branch_ref,
                          contributors.binding_last_checked_at::text, contributors.schema_version::text)))
  `;
}

async function deleteFromPg(
  opts: ContributorsProjectionOpts,
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
    DELETE FROM harness_shared.contributors
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND github_user_id = ${userId}
      -- EI-79 step 2 + D-001: guard the delete by the SAME fed_order_key() order (EI-1698)
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

/**
 * Build the projection for a specific (workspace, harness). Called
 * once per shared harness at boot.
 */
export function buildContributorsProjection(opts: ContributorsProjectionOpts): TableProjection<ContributorRow> {
  return {
    tableTag: 'contributors',
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

// Pure helpers exported for test reuse.
export const _testing = {
  composeKey,
  decodeValue,
};
