/**
 * Hyperbee → PG projection for `harness_shared.pot_settings` — per-Hive settings
 * federated as first-class Hive state (shared-hive-federation-2026-06-08 P-005).
 *
 * Mirrors projections/harness-plans.ts (the closest analog: a workspace-owned key
 * riding the peer-log). The federated subset = the Hive home scope (`harness_slug`
 * = the Hive's home_slug), the `setting_key`, and the JSON-text `value`. NOT
 * federated (machine-local): created_at/updated_at. The standard provenance
 * columns (author_pubkey/origin/fed_ts) carry the echo-guard + LWW.
 *
 * The per-harness guard (`row.harness_slug !== opts.harnessSlug`) demuxes: the
 * Hive home harness's projection applies its Hive's settings ops; everyone else
 * drops them. No hard FK to hives (migration 186), so a setting can land before
 * the local hive identity row materializes on a peer (cross-machine join ordering).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of a hive_settings row in Hyperbee — the federated subset. Defensive
 *  on every field: a malformed remote op is dropped (decodeValue → null). */
export interface HiveSettingRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  setting_key: string;
  /** JSON-serialized value (text), or null. */
  value: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

export function isHiveSettingRow(input: unknown): input is HiveSettingRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.setting_key) || r.setting_key.length === 0) return false;
  if (!isStringOrNull(r.value)) return false;
  return true;
}

export interface HiveSettingsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

function composeKey(row: HiveSettingRow): string {
  return row.setting_key;
}

function decodeValue(raw: unknown): HiveSettingRow | null {
  return isHiveSettingRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HiveSettingsProjectionOpts,
  row: HiveSettingRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  // D-001: the op's HLC ordering key — the SAME causal key the merge fold uses.
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  // workspace_id is the LOCAL projection's bound workspace. created_at is set on
  // first insert + preserved on update; only value/provenance/updated_at move.
  await sql`
    INSERT INTO harness_shared.pot_settings
      (workspace_id, harness_slug, setting_key, value, author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.setting_key}, ${row.value},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, setting_key) DO UPDATE SET
      value         = EXCLUDED.value,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_at    = ${now}
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_settings.fed_hlc, harness_shared.pot_settings.fed_ts)
  `;
}

async function deleteFromPg(
  opts: HiveSettingsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_settings
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND setting_key = ${key}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHiveSettingsProjection(
  opts: HiveSettingsProjectionOpts,
): TableProjection<HiveSettingRow> {
  return {
    tableTag: 'hive-settings-by-key',
    // EI-117: CDC-captured table — own-log ops are replays; see TableProjection.skipOwnOps.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = {
  composeKey,
  decodeValue,
  isHiveSettingRow,
};
