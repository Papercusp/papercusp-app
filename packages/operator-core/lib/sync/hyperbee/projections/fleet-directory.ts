/**
 * Hyperbee → PG projection for `harness_shared.p2p_fleet_directory` — the
 * owner-SIGNED fleet directory record (p2p-work-distribution-2026-07-02 P-101,
 * D-006; migration 476).
 *
 * Mirrors projections/hive-policy.ts (the template: an owner-signed record riding
 * the Hive peer-log, verified BEFORE apply) with a different trust anchor: the
 * signer is a DEVICE key that must be ATTESTED to the record's OWNER via the hive
 * membership (hive_members.device_attestations — the WI-1585 gist flow), resolved
 * FRESH per op (NO TTL cache in a security path — comms-tier-gate's deviceToUser
 * caches and must not be reused here). A forged / unattested / wrong-owner /
 * tampered record is DROPPED, never materialized.
 *
 * H10 alternate path: a signature by the HIVE identity pubkey (getHiveBySlug —
 * the hive_policy trust anchor) is honored ONLY when the record sets
 * archived=true — the hive owner force-archiving an orphaned fleet. That
 * authority can never publish or mutate a LIVE record.
 *
 * Registered scoped to the HIVE-HOME slug (register-all.ts `hiveScoped`), so
 * `opts.harnessSlug` is the Hive home — the demux guard, the attestation lookup
 * and the hive trust-anchor all key off it. Fail-closed everywhere: missing
 * membership/identity rows ⇒ drop, never apply-unverified.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { getHiveBySlug } from '../../../hive-store';
import { listHiveMembers, loadRevokedHivePubkeys } from '../../../hive-membership-store';
import { unsafeFederatedPotScope } from '../../../federated-pot-scope';
import { verifyEd25519 } from '../../../identity/ed25519';
import {
  fleetDirectorySignedBytes,
  fleetDirFedKey,
  parseFleetRecordJson,
} from '../../../p2p/fleet-directory-schema';

/** Wire-shape of a p2p_fleet_directory row in Hyperbee — the federated signed
 *  subset. Defensive on every field: a malformed remote op is dropped. */
export interface FleetDirectoryRow {
  /** The Hive's home_slug — the per-harness projection demux key. */
  harness_slug: string;
  owner_github_user_id: number;
  fleet_slug: string;
  /** The canonical signed record JSON (TEXT — the exact bytes the signature covers). */
  record_json: string;
  /** The signing pubkey (raw-32 base64): an owner-attested DEVICE key, or the hive
   *  identity key on the H10 force-archive path. */
  signer_device_pubkey: string;
  /** Base64 Ed25519 signature over the canonical signed bytes. */
  signature: string;
  /** Monotone version; bumps each author. */
  record_version: number;
  /** Filter convenience; MUST match the signed record (verified below). */
  archived: boolean;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isFleetDirectoryRow(input: unknown): input is FleetDirectoryRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (typeof r.owner_github_user_id !== 'number' || !Number.isSafeInteger(r.owner_github_user_id) || r.owner_github_user_id <= 0) return false;
  if (!isString(r.fleet_slug) || r.fleet_slug.length === 0) return false;
  if (!isString(r.record_json) || r.record_json.length === 0) return false;
  if (!isString(r.signer_device_pubkey) || r.signer_device_pubkey.length === 0) return false;
  if (!isString(r.signature) || r.signature.length === 0) return false;
  if (typeof r.record_version !== 'number' || !Number.isFinite(r.record_version)) return false;
  if (typeof r.archived !== 'boolean') return false;
  return true;
}

/**
 * Verify a directory row before apply. True ONLY when (a) the record JSON parses
 * to a valid record whose identity fields MATCH the row's key columns (no cuckoo
 * rows), and (b) the Ed25519 signature over the canonical signed bytes verifies
 * under a signer that is either an owner-attested, non-revoked device (normal
 * path) or the hive identity key with archived=true (H10 force-archive). Fails
 * CLOSED on every edge; never throws.
 */
export type VerifyFleetDirectoryFn = (
  opts: FleetDirectoryProjectionOpts,
  row: FleetDirectoryRow,
) => Promise<boolean>;

async function realVerifyFleetDirectory(
  opts: FleetDirectoryProjectionOpts,
  row: FleetDirectoryRow,
): Promise<boolean> {
  try {
    // (c) Structural + no-cuckoo: the signed record must BE this row.
    const record = parseFleetRecordJson(row.record_json);
    if (!record) return false;
    if (record.ownerGithubUserId !== row.owner_github_user_id) return false;
    if (record.fleetSlug !== row.fleet_slug) return false;
    if (record.recordVersion !== row.record_version) return false;
    if (record.archived !== row.archived) return false;

    let sig: Buffer;
    try {
      sig = Buffer.from(row.signature, 'base64');
    } catch {
      return false;
    }
    const bytes = fleetDirectorySignedBytes({
      workspaceId: opts.workspaceId,
      potHomeSlug: opts.harnessSlug,
      recordVersion: row.record_version,
      canonicalRecordJson: row.record_json,
    });

    // (a)+(b) normal path: an owner-attested, non-revoked DEVICE key signed it.
    // Fresh membership read per op — security path, no TTL cache.
    // EI-18777176681958978: certified, not resolved — this projection IS one of the writers.
    // register-all's `hiveScoped` spread sets `harnessSlug` to the federated bind scope
    // (`opts.potHomeSlug`, boot's resolveHiveHomeProjectionSlug → joinerPotHomeSlug →
    // canonicalHiveHomeSlug), so reading under it agrees with the write side by construction.
    const scope = unsafeFederatedPotScope(
      opts.harnessSlug,
      "register-all hiveScoped: this projection's own bind scope IS the federated pot scope",
    );
    const revoked = await loadRevokedHivePubkeys(opts.workspaceId, scope, opts.sql);
    if (!revoked.has(row.signer_device_pubkey)) {
      const members = await listHiveMembers(opts.workspaceId, scope, opts.sql);
      const ownerMember = members.find((m) => m.githubUserId === record.ownerGithubUserId);
      const signerAttestedToOwner = !!ownerMember?.deviceAttestations?.some(
        (a) => a?.device_pubkey === row.signer_device_pubkey,
      );
      if (signerAttestedToOwner && verifyEd25519(bytes, row.signer_device_pubkey, sig)) {
        return true;
      }
    }

    // (d) H10 force-archive: the HIVE identity key may sign ONLY an archived record.
    if (record.archived === true) {
      const hive = await getHiveBySlug(opts.workspaceId, opts.harnessSlug, opts.sql);
      if (hive && row.signer_device_pubkey === hive.pubkeyBase64) {
        return verifyEd25519(bytes, hive.pubkeyBase64, sig);
      }
    }
    return false;
  } catch {
    return false; // any resolution failure ⇒ drop (fail closed)
  }
}

export interface FleetDirectoryProjectionOpts {
  workspaceId: string;
  /** The Hive HOME slug (register-all binds this projection to the hive-home). */
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /**
   * The signature/attestation verifier. Default = realVerifyFleetDirectory (the
   * security gate). Injectable so the teeth test can prove it is LOAD-BEARING:
   * neuter it (→ always true) and a forged record applies = RED.
   */
  verifyRecord?: VerifyFleetDirectoryFn;
}

function composeKey(row: FleetDirectoryRow): string {
  // The per-log key = the migration-476 generated fleet_dir_fed_key column.
  return fleetDirFedKey(row.owner_github_user_id, row.fleet_slug);
}

function decodeValue(raw: unknown): FleetDirectoryRow | null {
  return isFleetDirectoryRow(raw) ? raw : null;
}

async function writeToPg(
  opts: FleetDirectoryProjectionOpts,
  row: FleetDirectoryRow,
  provenance: ProvenanceContext,
): Promise<void> {
  // Demux: this projection only applies its own Hive's directory ops.
  if (row.harness_slug !== opts.harnessSlug) return;

  // SECURITY GATE: verify signature + attestation before applying. Forged → drop.
  const verify = opts.verifyRecord ?? realVerifyFleetDirectory;
  if (!(await verify(opts, row))) return;

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  const now = Date.now();
  await sql`
    INSERT INTO harness_shared.p2p_fleet_directory
      (workspace_id, harness_slug, owner_github_user_id, fleet_slug, record_json,
       signer_device_pubkey, signature, record_version, archived,
       author_pubkey, origin, fed_ts, fed_hlc, created_at, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.owner_github_user_id},
       ${row.fleet_slug}, ${row.record_json}, ${row.signer_device_pubkey},
       ${row.signature}, ${row.record_version}, ${row.archived},
       ${authorPubkey}, ${origin}, ${fedTs}, ${fedHlc}, ${now}, ${now})
    ON CONFLICT (workspace_id, harness_slug, owner_github_user_id, fleet_slug) DO UPDATE SET
      record_json          = EXCLUDED.record_json,
      signer_device_pubkey = EXCLUDED.signer_device_pubkey,
      signature            = EXCLUDED.signature,
      record_version       = EXCLUDED.record_version,
      archived             = EXCLUDED.archived,
      author_pubkey        = EXCLUDED.author_pubkey,
      origin               = EXCLUDED.origin,
      fed_ts               = EXCLUDED.fed_ts,
      fed_hlc              = EXCLUDED.fed_hlc,
      updated_at           = ${now}
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() (mirrors lwwPick exactly).
    -- WI-2933 (extends mig 504 fed_apply_wins): the bare ">=" applied unconditionally
    -- on an EXACT clock tie (two cells signing/publishing the same fleet record in
    -- the same tick), so both cells could apply the OTHER's write and swap
    -- (composition-chaos P-002 class). fed_apply_wins breaks the tie by writer
    -- pubkey when both sides carry one and differ, else by the SYMMETRIC content
    -- digest — both cells compute it identically, converging in one exchange.
    WHERE harness_shared.fed_apply_wins(
            EXCLUDED.fed_hlc, EXCLUDED.fed_ts, EXCLUDED.author_pubkey,
            md5(concat_ws('|', EXCLUDED.record_json, EXCLUDED.signer_device_pubkey,
                          EXCLUDED.signature, EXCLUDED.record_version::text, EXCLUDED.archived::text)),
            harness_shared.p2p_fleet_directory.fed_hlc, harness_shared.p2p_fleet_directory.fed_ts,
            harness_shared.p2p_fleet_directory.author_pubkey,
            md5(concat_ws('|', harness_shared.p2p_fleet_directory.record_json,
                          harness_shared.p2p_fleet_directory.signer_device_pubkey,
                          harness_shared.p2p_fleet_directory.signature,
                          harness_shared.p2p_fleet_directory.record_version::text,
                          harness_shared.p2p_fleet_directory.archived::text)))
  `;
}

async function deleteFromPg(
  opts: FleetDirectoryProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  // Key = `<owner-uid>/<fleet-slug>` (the generated fed key). Parse defensively.
  const slash = key.indexOf('/');
  if (slash <= 0) return;
  const owner = Number(key.slice(0, slash));
  const fleetSlug = key.slice(slash + 1);
  if (!Number.isSafeInteger(owner) || owner <= 0 || fleetSlug.length === 0) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.p2p_fleet_directory
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND owner_github_user_id = ${owner}
      AND fleet_slug = ${fleetSlug}
      -- guard the delete by the SAME fed_order_key() order as the put guard (EI-1698).
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildFleetDirectoryProjection(
  opts: FleetDirectoryProjectionOpts,
): TableProjection<FleetDirectoryRow> {
  return {
    tableTag: 'p2p-fleet-directory',
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
  isFleetDirectoryRow,
  realVerifyFleetDirectory,
};
