/**
 * Hyperbee → PG projection for `harness_shared.pot_epoch_keys` — the per-member
 * WRAPPED epoch keys of the read-plane re-key (Brief RE-KEY / C-001 / Move 2, P-005).
 * Mirrors projections/hive-settings.ts exactly (a workspace-owned key riding the Hive
 * peer-log, demuxed by the Hive home `harness_slug`), with the same D-001 LWW guard
 * (HLC `fed_hlc` of record, single-order-space `fed_order_key()` derivation from
 * `fed_ts` for pre-314 rows — EI-1698).
 *
 * Federated subset = (harness_slug = Hive home, epoch, member_device_pubkey, wrapped_key
 * [base64 of the sealed blob]). created_at/updated_at are machine-local; author_pubkey/
 * origin/fed_ts/fed_hlc carry the echo-guard + LWW. The per-harness guard
 * (`row.harness_slug !== opts.harnessSlug`) demuxes onto the Hive-home projection (the
 * A-003 (a′) hive-home→joiner seam d2230 landed).
 *
 * DRAIN HOOK (46b7a/J): on a successful apply, fire `onEpochKeyApplied(potHomeSlug,
 * epoch)` so J's pending-epoch-content buffer drains exactly when a key row lands —
 * deferred content for that (hive, epoch) is then re-applied (the remaining member can
 * now decrypt). The removed member never receives a row for its device → its deferred
 * content stays deferred forever = the C-001 cut-off. The callback is idempotent on J's
 * side (drainEpoch re-checks keyForEpoch), so firing per applied row is safe.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of a hive_epoch_keys row — the federated subset. Defensive on every
 *  field: a malformed remote op is dropped (decodeValue → null). */
export interface HiveEpochKeyRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  /** The re-key epoch this key is for. */
  epoch: number;
  /** The remaining member's raw Ed25519 device pubkey (base64). */
  member_device_pubkey: string;
  /** base64 of the epoch key sealed to that device. */
  wrapped_key: string;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

export function isHiveEpochKeyRow(input: unknown): input is HiveEpochKeyRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isNonEmptyString(r.harness_slug)) return false;
  if (typeof r.epoch !== 'number' || !Number.isInteger(r.epoch) || r.epoch < 0) return false;
  if (!isNonEmptyString(r.member_device_pubkey)) return false;
  if (!isNonEmptyString(r.wrapped_key)) return false;
  return true;
}

export interface HiveEpochKeysProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** Fired (potHomeSlug, epoch) after a key row applies — drives J's pending drain. */
  onEpochKeyApplied?: (potHomeSlug: string, epoch: number) => void;
}

/** The peer-log table tag of a wrapped epoch-key row. */
export const HIVE_EPOCH_KEYS_TABLE_TAG = 'hive-epoch-keys';

/** The peer-log key for a row: `${epoch}:${member_device_pubkey}` — matches the
 *  generated `epoch_key_fed_key` column (mig 316; ':' separator, base64 has '/').
 *  Exported so the P-524 key seek matches this device's row by the same key. */
export function epochKeyRowKey(epoch: number, memberDevicePubkey: string): string {
  return `${epoch}:${memberDevicePubkey}`;
}

function composeKey(row: HiveEpochKeyRow): string {
  return epochKeyRowKey(row.epoch, row.member_device_pubkey);
}

function decodeValue(raw: unknown): HiveEpochKeyRow | null {
  return isHiveEpochKeyRow(raw) ? raw : null;
}

async function writeToPg(
  opts: HiveEpochKeysProjectionOpts,
  row: HiveEpochKeyRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return; // demux: only this Hive home's ops
  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null; // D-001 ordering key
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.pot_epoch_keys
      (workspace_id, harness_slug, epoch, member_device_pubkey, wrapped_key,
       author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.epoch}, ${row.member_device_pubkey}, ${row.wrapped_key},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, epoch, member_device_pubkey) DO UPDATE SET
      wrapped_key   = EXCLUDED.wrapped_key,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_at    = ${now}
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.pot_epoch_keys.fed_hlc, harness_shared.pot_epoch_keys.fed_ts)
  `;
  // Drain J's pending-epoch-content buffer for this (hive, epoch).
  opts.onEpochKeyApplied?.(row.harness_slug, row.epoch);
}

async function deleteFromPg(
  opts: HiveEpochKeysProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sep = key.indexOf(':');
  if (sep <= 0) return; // malformed composite key
  const epoch = Number(key.slice(0, sep));
  const memberPubkey = key.slice(sep + 1);
  if (!Number.isInteger(epoch) || !memberPubkey) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.pot_epoch_keys
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND epoch = ${epoch}
      AND member_device_pubkey = ${memberPubkey}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildHiveEpochKeysProjection(
  opts: HiveEpochKeysProjectionOpts,
): TableProjection<HiveEpochKeyRow> {
  return {
    tableTag: HIVE_EPOCH_KEYS_TABLE_TAG,
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
  isHiveEpochKeyRow,
};
