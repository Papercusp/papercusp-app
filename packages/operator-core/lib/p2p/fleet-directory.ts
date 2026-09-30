/**
 * p2p/fleet-directory.ts — PG read/write for harness_shared.p2p_fleet_directory,
 * the owner-SIGNED federated fleet directory (p2p-work-distribution-2026-07-02
 * P-101, D-006; migration 476), and the {@link FleetDirectory} implementation that
 * widens the scope roster to `{owner} ∪ publisher-set` (scope-roster.ts P-101
 * slot-in) plus the {@link PublisherSet} resolver the P-102 offer-authorship chain
 * consumes.
 *
 * Layering mirrors hive-policy: this module is the LOCAL read/authoring path (the
 * signing itself is INJECTED — keychain stays out, identity/sign-with-device-key.ts
 * at the call site); the member-side verify-on-apply lives in
 * sync/hyperbee/projections/fleet-directory.ts. Rows read here are therefore
 * already-verified for LOCAL trust decisions — but {@link resolvePublisherSet}
 * RE-VERIFIES the stored signature anyway (defense in depth: it feeds the P-102
 * authority chain, and the local author path writes without projection verify).
 *
 * C6: every membership/publisher read is a DIRECT PG read per call — no
 * memoization, no TTL — so a directory change that federated one statement ago is
 * enforced on the very next disclose/serve/offer check.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { verifyEd25519 } from '../identity/ed25519';
// EI-18777176681958978: `deps.potSlug` is a LOCAL pot handle (the work-intake tick passes
// `potHomeSlugForHarness(...) ?? installSlug`), so the publisher-set resolve must
// canonicalize before reading membership/revocations — otherwise on a joiner every
// directory record resolves against an empty roster and an empty revocation set.
import {
  listHiveMembersForLocalPot,
  loadRevokedHivePubkeysForLocalPot,
} from '../federated-pot-scope';
import type { ScopeId } from '../sync/pot-git/scope-repo';
import type { FleetDirectory } from './scope-roster';
import type { PublisherSet } from './offer-authorship';
import { resolveP2pGrantWorkspace } from './grant-store';
import {
  type FleetDirectoryRecord,
  canonicalFleetRecordJson,
  coerceFleetDirectoryRecord,
  fleetDirectorySignedBytes,
  parseFleetRecordJson,
} from './fleet-directory-schema';

/** A resolved directory row (the hive-browsable card + its signature envelope). */
export interface StoredFleetRecord {
  workspaceId: string;
  /** The Hive's home_slug (= the `harness_slug` scope column). */
  potHomeSlug: string;
  ownerGithubUserId: number;
  fleetSlug: string;
  /** The typed record (parsed from the canonical `record_json`); null only for a
   *  pre-schema junk row — callers must treat that as a refusal. */
  record: FleetDirectoryRecord | null;
  /** The canonical signed JSON string (the exact bytes the signature covers). */
  recordJson: string;
  signerDevicePubkey: string;
  signature: string;
  recordVersion: number;
  archived: boolean;
  fedHlc: string | null;
  updatedAt: number;
}

/** The signer seam — keychain-bound signing stays OUT of this module. The normal
 *  author signs with their DEVICE key; the H10 force-archive path signs with the
 *  HIVE identity key. */
export interface FleetRecordSigner {
  /** The signing pubkey (raw-32 base64) — stored as signer_device_pubkey. */
  pubkey: string;
  sign(bytes: Buffer): Promise<Buffer>;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

// author_pubkey/origin/fed_ts/fed_hlc are owned by the stamp + projection layers
// (NOT set by the local author), exactly like hive_policy.
const READ_COLS = `workspace_id, harness_slug, owner_github_user_id, fleet_slug,
  record_json, signer_device_pubkey, signature, record_version, archived, fed_hlc, updated_at`;

interface FleetDirectoryDbRow {
  workspace_id: string;
  harness_slug: string;
  owner_github_user_id: string | number;
  fleet_slug: string;
  record_json: string;
  signer_device_pubkey: string;
  signature: string;
  record_version: string | number;
  archived: boolean;
  fed_hlc: string | null;
  updated_at: string | number;
}

function rowToStored(r: FleetDirectoryDbRow): StoredFleetRecord {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    ownerGithubUserId: Number(r.owner_github_user_id),
    fleetSlug: r.fleet_slug,
    record: parseFleetRecordJson(r.record_json),
    recordJson: r.record_json,
    signerDevicePubkey: r.signer_device_pubkey,
    signature: r.signature,
    recordVersion: Number(r.record_version),
    archived: r.archived,
    fedHlc: r.fed_hlc,
    updatedAt: Number(r.updated_at),
  };
}

/** Get one fleet's directory record (null = no record). */
export async function getFleetRecord(
  workspaceId: string,
  potHomeSlug: string,
  ownerGithubUserId: number,
  fleetSlug: string,
  sql?: Sql,
): Promise<StoredFleetRecord | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${READ_COLS} FROM harness_shared.p2p_fleet_directory
      WHERE workspace_id = $1 AND harness_slug = $2
        AND owner_github_user_id = $3 AND fleet_slug = $4 LIMIT 1`,
    [workspaceId, potHomeSlug, ownerGithubUserId, fleetSlug],
  )) as unknown as FleetDirectoryDbRow[];
  return rows[0] ? rowToStored(rows[0]) : null;
}

/** All directory records in a Hive — the hive-browsable card list. Archived rows
 *  are excluded unless asked for (they remain visible for audit/successor flows). */
export async function listFleetRecords(
  workspaceId: string,
  potHomeSlug: string,
  opts?: { includeArchived?: boolean },
  sql?: Sql,
): Promise<StoredFleetRecord[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${READ_COLS} FROM harness_shared.p2p_fleet_directory
      WHERE workspace_id = $1 AND harness_slug = $2
        ${opts?.includeArchived ? '' : 'AND archived = false'}
      ORDER BY owner_github_user_id ASC, fleet_slug ASC`,
    [workspaceId, potHomeSlug],
  )) as unknown as FleetDirectoryDbRow[];
  return rows.map(rowToStored);
}

export interface PutFleetRecordInput {
  workspaceId: string;
  potHomeSlug: string;
  /** The authoring user's PROVEN numeric gh user id (X9) — the caller resolves it
   *  from the session identity, never from the record body. */
  selfGithubUserId: number;
  /** The record to publish (untrusted — validated here). */
  record: unknown;
  /** The author's DEVICE-key signer (identity/sign-with-device-key.ts at the call site). */
  signer: FleetRecordSigner;
  sql?: Sql;
}

export type PutFleetRecordResult =
  | { ok: true; stored: StoredFleetRecord }
  | { ok: false; error: string };

/**
 * Author (create or update) a fleet directory record. D-006 single-owner gate:
 * only the fleet's OWNER may author — `selfGithubUserId` must equal the record's
 * `ownerGithubUserId`, and an existing row's owner can never be rewritten (the PK
 * includes the owner, so a "new owner" is a different fleet). recordVersion must
 * advance monotonically past the stored row (stale author = refusal).
 *
 * The row lands locally with only the signed/federated subset; the
 * stamp_local_federated_write trigger (migration 476) owns fed_ts/fed_hlc/origin so
 * the change federates, and remote projections verify the signature before apply.
 */
export async function putFleetRecord(input: PutFleetRecordInput): Promise<PutFleetRecordResult> {
  const coerced = coerceFleetDirectoryRecord(input.record);
  if (!coerced.ok) return { ok: false, error: coerced.error };
  const record = coerced.record;

  // D-006: exactly one accountable owner; only the owner authors their fleet.
  if (input.selfGithubUserId !== record.ownerGithubUserId) {
    return {
      ok: false,
      error: `only the fleet owner may author its directory record (self=${input.selfGithubUserId}, record owner=${record.ownerGithubUserId})`,
    };
  }

  const existing = await getFleetRecord(
    input.workspaceId,
    input.potHomeSlug,
    record.ownerGithubUserId,
    record.fleetSlug,
    input.sql,
  );
  if (existing && record.recordVersion <= existing.recordVersion) {
    return {
      ok: false,
      error: `record_version ${record.recordVersion} does not advance past stored ${existing.recordVersion} — re-read and bump`,
    };
  }

  const recordJson = canonicalFleetRecordJson(record);
  const bytes = fleetDirectorySignedBytes({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    recordVersion: record.recordVersion,
    canonicalRecordJson: recordJson,
  });
  const signature = (await input.signer.sign(bytes)).toString('base64');

  const now = Date.now();
  const rows = (await pg(input.sql).unsafe(
    `INSERT INTO harness_shared.p2p_fleet_directory
       (workspace_id, harness_slug, owner_github_user_id, fleet_slug, record_json,
        signer_device_pubkey, signature, record_version, archived, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (workspace_id, harness_slug, owner_github_user_id, fleet_slug) DO UPDATE SET
       record_json          = EXCLUDED.record_json,
       signer_device_pubkey = EXCLUDED.signer_device_pubkey,
       signature            = EXCLUDED.signature,
       record_version       = EXCLUDED.record_version,
       archived             = EXCLUDED.archived,
       updated_at           = $10
     RETURNING ${READ_COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      record.ownerGithubUserId,
      record.fleetSlug,
      recordJson,
      input.signer.pubkey,
      signature,
      record.recordVersion,
      record.archived,
      now,
    ],
  )) as unknown as FleetDirectoryDbRow[];
  return { ok: true, stored: rowToStored(rows[0]!) };
}

/**
 * H10 orphan reaping: the HIVE OWNER force-archives a fleet whose owner is gone
 * (else owner death freezes the publisher set forever). Signs the archived record
 * with the HIVE identity key — the projection's alternate verify honors a
 * hive-key signature ONLY for a record with archived=true, so this authority can
 * never rewrite a live fleet's membership.
 */
export async function forceArchiveFleet(input: {
  workspaceId: string;
  potHomeSlug: string;
  ownerGithubUserId: number;
  fleetSlug: string;
  /** The HIVE identity signer (hive keypair — hive-store/identity edges). */
  hiveSigner: FleetRecordSigner;
  sql?: Sql;
}): Promise<PutFleetRecordResult> {
  const existing = await getFleetRecord(
    input.workspaceId,
    input.potHomeSlug,
    input.ownerGithubUserId,
    input.fleetSlug,
    input.sql,
  );
  if (!existing) return { ok: false, error: 'no directory record for that fleet' };
  if (!existing.record) return { ok: false, error: 'stored record is malformed — cannot derive the archived record' };
  if (existing.archived) return { ok: true, stored: existing };

  const record: FleetDirectoryRecord = {
    ...existing.record,
    archived: true,
    recordVersion: existing.recordVersion + 1,
  };
  const recordJson = canonicalFleetRecordJson(record);
  const bytes = fleetDirectorySignedBytes({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    recordVersion: record.recordVersion,
    canonicalRecordJson: recordJson,
  });
  const signature = (await input.hiveSigner.sign(bytes)).toString('base64');
  const now = Date.now();
  const rows = (await pg(input.sql).unsafe(
    `UPDATE harness_shared.p2p_fleet_directory SET
       record_json          = $5,
       signer_device_pubkey = $6,
       signature            = $7,
       record_version       = $8,
       archived             = true,
       updated_at           = $9
     WHERE workspace_id = $1 AND harness_slug = $2
       AND owner_github_user_id = $3 AND fleet_slug = $4
     RETURNING ${READ_COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      input.ownerGithubUserId,
      input.fleetSlug,
      recordJson,
      input.hiveSigner.pubkey,
      signature,
      record.recordVersion,
      now,
    ],
  )) as unknown as FleetDirectoryDbRow[];
  return { ok: true, stored: rowToStored(rows[0]!) };
}

/* ─────────────────────────────────────────────────────────────────────────
 * The FleetDirectory implementation — the scope-roster P-101 slot-in
 * ───────────────────────────────────────────────────────────────────────── */

export interface PgFleetDirectoryDeps {
  /** The caller's identity workspace (run through resolveP2pGrantWorkspace, C3). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the directory federates under. */
  potSlug: string;
  sqlOverride?: Sql;
}

/** Fail-closed empty publisher set (absent/archived/junk record ⇒ every P-102
 *  verdict refuses: no members, unsigned, unanchored). */
function refusedPublisherSet(ownerGithubUserId: number): PublisherSet {
  return {
    ownerGithubUserId,
    ownerAnchored: false,
    ownerSignatureValid: false,
    memberGithubUserIds: [],
  };
}

/**
 * The PG-backed fleet directory. Every method is a direct, cache-bypassing PG
 * read (C6). Inject into GrantBackedScopeRoster to widen scope membership to
 * `{owner} ∪ publisher-set`, and into the offer path via resolvePublisherSet.
 */
export class PgFleetDirectory implements FleetDirectory {
  private readonly deps: PgFleetDirectoryDeps;

  constructor(deps: PgFleetDirectoryDeps) {
    this.deps = deps;
  }

  private ws(): string | null {
    // resolveP2pGrantWorkspace returns string | undefined; this contract is string | null and every caller
    // treats both as "no workspace" (they guard with `if (!ws)`), so coalesce undefined → null (greens the
    // shared tsc gate; no behavior change).
    return resolveP2pGrantWorkspace(this.deps.workspaceId) ?? null;
  }

  /** scope-roster contract: member ids, or null when the directory has no live
   *  record of the scope (⇒ owner-only fallback in GrantBackedScopeRoster). */
  async scopeMembers(scope: ScopeId): Promise<number[] | null> {
    const ws = this.ws();
    if (!ws) return null;
    const row = await getFleetRecord(ws, this.deps.potSlug, scope.ownerGithubUserId, scope.slug, this.deps.sqlOverride);
    if (!row || row.archived || !row.record) return null;
    const pubs = row.record.publisherGithubUserIds;
    return pubs.includes(scope.ownerGithubUserId) ? [...pubs] : [scope.ownerGithubUserId, ...pubs];
  }

  /**
   * Resolve the P-102 {@link PublisherSet} for a scope — the offer-authorship
   * chain's set input. RE-VERIFIES the stored signature (Ed25519 over the exact
   * stored bytes) + the signing device's attestation to the owner (fresh
   * listHiveMembers read — NO TTL cache in a security path, unlike
   * comms-tier-gate's display-grade deviceToUser). `ownerAnchored` = the owner has
   * at least one non-revoked attested device in the hive membership (the WI-1585
   * GitHub-anchored flow is what put it there). Fail-closed on every edge.
   */
  async resolvePublisherSet(scope: ScopeId): Promise<PublisherSet> {
    const owner = scope.ownerGithubUserId;
    const ws = this.ws();
    if (!ws) return refusedPublisherSet(owner);
    let row: StoredFleetRecord | null;
    let members;
    let revoked: Set<string>;
    try {
      row = await getFleetRecord(ws, this.deps.potSlug, owner, scope.slug, this.deps.sqlOverride);
      members = await listHiveMembersForLocalPot(ws, this.deps.potSlug, this.deps.sqlOverride);
      revoked = await loadRevokedHivePubkeysForLocalPot(ws, this.deps.potSlug, this.deps.sqlOverride);
    } catch {
      return refusedPublisherSet(owner); // PG edge failure ⇒ refuse, never guess
    }
    if (!row || row.archived || !row.record || row.record.ownerGithubUserId !== owner) {
      return refusedPublisherSet(owner);
    }

    // Owner anchoring: at least one live (non-revoked) attested device.
    const ownerMember = members.find((m) => m.githubUserId === owner);
    const ownerAnchored = !!ownerMember?.deviceAttestations?.some(
      (a) => a?.device_pubkey && !revoked.has(a.device_pubkey),
    );

    // Signature validity: the exact stored bytes verify under the signer device,
    // AND that device is attested to the owner (a valid signature by a random
    // attested member is NOT an owner signature).
    let ownerSignatureValid = false;
    if (!revoked.has(row.signerDevicePubkey)) {
      const signerAttestedToOwner = !!ownerMember?.deviceAttestations?.some(
        (a) => a?.device_pubkey === row!.signerDevicePubkey,
      );
      if (signerAttestedToOwner) {
        try {
          const bytes = fleetDirectorySignedBytes({
            workspaceId: ws,
            potHomeSlug: this.deps.potSlug,
            recordVersion: row.recordVersion,
            canonicalRecordJson: row.recordJson,
          });
          ownerSignatureValid = verifyEd25519(bytes, row.signerDevicePubkey, Buffer.from(row.signature, 'base64'));
        } catch {
          ownerSignatureValid = false;
        }
      }
    }

    const pubs = row.record.publisherGithubUserIds;
    return {
      ownerGithubUserId: owner,
      ownerAnchored,
      ownerSignatureValid,
      memberGithubUserIds: pubs.includes(owner) ? [...pubs] : [owner, ...pubs],
    };
  }

  /**
   * The scopes `selfGithubUserId` participates in (owner or publisher, live only)
   * — the boot.ts production driver of handle.ensureScopeParticipation.
   */
  async listParticipatingScopes(selfGithubUserId: number): Promise<ScopeId[]> {
    const ws = this.ws();
    if (!ws) return [];
    const rows = await listFleetRecords(ws, this.deps.potSlug, undefined, this.deps.sqlOverride);
    const out: ScopeId[] = [];
    for (const r of rows) {
      if (!r.record) continue;
      const isOwner = r.ownerGithubUserId === selfGithubUserId;
      const isPublisher = r.record.publisherGithubUserIds.includes(selfGithubUserId);
      if (isOwner || isPublisher) {
        out.push({ kind: 'fleet', ownerGithubUserId: r.ownerGithubUserId, slug: r.fleetSlug });
      }
    }
    return out;
  }
}
