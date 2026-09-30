/**
 * p2p/offer-store.ts — PG read/write for harness_shared.p2p_work_offers, the
 * publisher-SIGNED federated offer store (p2p-work-distribution-2026-07-02
 * P-102 store leg, WI-1935; migration 490). D-005 seat-offers
 * (agent-allocation-framework) ride the same table via offer-store-publish.ts.
 *
 * Layering mirrors fleet-directory.ts exactly: this module is the LOCAL
 * read/authoring path (signing is INJECTED — the keychain stays out,
 * identity/sign-with-device-key.ts at the call site); the member-side
 * verify-on-apply lives in sync/hyperbee/projections/work-offers.ts. Rows read
 * here are therefore already-verified for LOCAL trust decisions. V1 delegation
 * consumes the supported seat/spawn_request records through the delegated-spawn
 * admission and honor chain; the retired legacy work-offer puller is not a
 * consumer of this store.
 *
 * C6: every read is a DIRECT PG read per call — no memoization, no TTL — so an
 * offer cancelled one statement ago is refused on the very next claim check.
 *
 * local_disposition (P-106 deferred #2): a HOST-LOCAL refusal on a foreign
 * offer. A host cannot re-sign a foreign record, so its refusal is UNSIGNED and
 * NON-FEDERATED — the column is excluded from capture, from the wire row, from
 * the projection upsert, and from the stamp function's content compare
 * (migration 490). Signed status stays publisher-authoritative.
 */

import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { FleetRecordSigner } from './fleet-directory';
import {
  canonicalWorkOfferRecordJson,
  coerceWorkOfferStoreRecord,
  parseWorkOfferRecordJson,
  workOfferStoreSignedBytes,
  type OfferStoreStatus,
  type WorkOfferStoreRecord,
} from './offer-store-schema';

/** The signer seam — same shape as the fleet-directory author's (one concept,
 *  one keychain edge: identity/sign-with-device-key.ts at the call site). */
export type OfferRecordSigner = FleetRecordSigner;

/** A resolved offer row (the signed record + its envelope + local state). */
export interface StoredWorkOffer {
  workspaceId: string;
  /** The Hive's home_slug (= the `harness_slug` scope column). */
  potHomeSlug: string;
  publisherGithubUserId: number;
  offerId: string;
  /** The typed record (parsed from the canonical `record_json`); null only for
   *  a pre-schema junk row — callers must treat that as a refusal. */
  record: WorkOfferStoreRecord | null;
  /** The canonical signed JSON string (the exact bytes the signature covers). */
  recordJson: string;
  signerDevicePubkey: string;
  signature: string;
  recordVersion: number;
  /** P-001: nullable — a pot-scoped 'seat' offer carries fleetSlug=null instead. */
  fleetSlug: string | null;
  /** P-001: the pot-scoped grantee (mutually exclusive with fleetSlug for kind 'seat'). */
  potSlug: string | null;
  offerKind: string;
  status: string;
  /** HOST-LOCAL refusal (never federated), or null. A non-null disposition means
   *  THIS host will not serve the offer regardless of its signed status. */
  localDisposition: string | null;
  fedHlc: string | null;
  updatedAt: number;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

// author_pubkey/origin/fed_ts/fed_hlc are owned by the stamp + projection layers
// (NOT set by the local author), exactly like p2p_fleet_directory.
const READ_COLS = `workspace_id, harness_slug, publisher_github_user_id, offer_id,
  record_json, signer_device_pubkey, signature, record_version, fleet_slug, pot_slug,
  offer_kind, status, local_disposition, fed_hlc, updated_at`;

interface WorkOfferDbRow {
  workspace_id: string;
  harness_slug: string;
  publisher_github_user_id: string | number;
  offer_id: string;
  record_json: string;
  signer_device_pubkey: string;
  signature: string;
  record_version: string | number;
  fleet_slug: string | null;
  pot_slug: string | null;
  offer_kind: string;
  status: string;
  local_disposition: string | null;
  fed_hlc: string | null;
  updated_at: string | number;
}

function rowToStored(r: WorkOfferDbRow): StoredWorkOffer {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    publisherGithubUserId: Number(r.publisher_github_user_id),
    offerId: r.offer_id,
    record: parseWorkOfferRecordJson(r.record_json),
    recordJson: r.record_json,
    signerDevicePubkey: r.signer_device_pubkey,
    signature: r.signature,
    recordVersion: Number(r.record_version),
    fleetSlug: r.fleet_slug,
    potSlug: r.pot_slug,
    offerKind: r.offer_kind,
    status: r.status,
    localDisposition: r.local_disposition,
    fedHlc: r.fed_hlc,
    updatedAt: Number(r.updated_at),
  };
}

/** Get one offer record (null = no record). */
export async function getWorkOffer(
  workspaceId: string,
  potHomeSlug: string,
  publisherGithubUserId: number,
  offerId: string,
  sql?: Sql,
): Promise<StoredWorkOffer | null> {
  const rows = (await pg(sql).unsafe(
    `SELECT ${READ_COLS} FROM harness_shared.p2p_work_offers
      WHERE workspace_id = $1 AND harness_slug = $2
        AND publisher_github_user_id = $3 AND offer_id = $4 LIMIT 1`,
    [workspaceId, potHomeSlug, publisherGithubUserId, offerId],
  )) as unknown as WorkOfferDbRow[];
  return rows[0] ? rowToStored(rows[0]) : null;
}

export interface ListWorkOffersFilter {
  fleetSlug?: string;
  /** P-001: restrict to a pot-scoped grantee (mutually exclusive in practice with fleetSlug). */
  potSlug?: string;
  status?: OfferStoreStatus;
  kind?: 'seat' | 'spawn_request';
  publisherGithubUserId?: number;
  /** Default false: rows THIS host refused (local_disposition set) are excluded
   *  — the claimable/board read. Pass true for audit/debug reads. */
  includeLocallyDisposed?: boolean;
}

/**
 * List offers in a Hive, filtered server-side (the fleet board / puller scan).
 *
 * ⚠ GENERIC over `filter.kind` — this lists either supported kind (`seat` |
 * `spawn_request`), not legacy work-offers. It was called `listWorkOffers` until
 * 2026-08-09, and that name cost a real misdiagnosis: a reader saw that
 * a dead `kind:'work'` intake branch existed. The reader took the NAME as evidence
 * that branch was THE pull leg and concluded its zero publishers made the live
 * path unreachable. It did not: v1 delegation runs on SEATS
 * (`request-remote-spawn.ts:175` calls this with `kind:'seat'`). Renamed under
 * `p2p-public-release-remaining-lanes-2026-07-16#D-023`.
 *
 * Two call sites had already aliased the import to `listOffers` locally to make
 * their own code read correctly — independent evidence the old name was wrong.
 */
export async function listOffers(
  workspaceId: string,
  potHomeSlug: string,
  filter?: ListWorkOffersFilter,
  sql?: Sql,
): Promise<StoredWorkOffer[]> {
  const conds = ['workspace_id = $1', 'harness_slug = $2'];
  const params: (string | number)[] = [workspaceId, potHomeSlug];
  if (filter?.fleetSlug) {
    params.push(filter.fleetSlug);
    conds.push(`fleet_slug = $${params.length}`);
  }
  if (filter?.potSlug) {
    params.push(filter.potSlug);
    conds.push(`pot_slug = $${params.length}`);
  }
  if (filter?.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  if (filter?.kind) {
    params.push(filter.kind);
    conds.push(`offer_kind = $${params.length}`);
  }
  if (filter?.publisherGithubUserId != null) {
    params.push(filter.publisherGithubUserId);
    conds.push(`publisher_github_user_id = $${params.length}`);
  }
  if (!filter?.includeLocallyDisposed) {
    conds.push('local_disposition IS NULL');
  }
  const rows = (await pg(sql).unsafe(
    `SELECT ${READ_COLS} FROM harness_shared.p2p_work_offers
      WHERE ${conds.join(' AND ')}
      ORDER BY publisher_github_user_id ASC, offer_id ASC`,
    params,
  )) as unknown as WorkOfferDbRow[];
  return rows.map(rowToStored);
}

export interface PutWorkOfferInput {
  workspaceId: string;
  potHomeSlug: string;
  /** The authoring user's PROVEN numeric gh user id (X9) — the caller resolves
   *  it from the session identity, never from the record body. */
  selfGithubUserId: number;
  /** The record to publish (untrusted — validated here). */
  record: unknown;
  /** The author's DEVICE-key signer (identity/sign-with-device-key.ts at the call site). */
  signer: OfferRecordSigner;
  sql?: Sql;
}

export type PutWorkOfferResult =
  | { ok: true; stored: StoredWorkOffer }
  | { ok: false; error: string };

/**
 * Author (create or update) an offer record — publish, pause, cancel are all
 * the same signed write with a bumped recordVersion. Single-publisher gate
 * (mirrors fleet-directory's D-006): only the publisher may author their own
 * offer — `selfGithubUserId` must equal the record's `publisherGithubUserId`,
 * and the PK includes the publisher, so a "different publisher" is a different
 * row by construction. recordVersion must advance monotonically past the stored
 * row (stale author = refusal).
 *
 * The row lands locally with only the signed/federated subset; the
 * stamp_local_federated_write trigger (migration 490) owns fed_ts/fed_hlc/origin
 * so the change federates, and remote projections verify the signature before
 * apply. local_disposition is never touched here (host-local, unsigned).
 */
export async function putWorkOffer(input: PutWorkOfferInput): Promise<PutWorkOfferResult> {
  const coerced = coerceWorkOfferStoreRecord(input.record);
  if (!coerced.ok) return { ok: false, error: coerced.error };
  const record = coerced.record;

  if (input.selfGithubUserId !== record.publisherGithubUserId) {
    return {
      ok: false,
      error: `only the publisher may author their offer record (self=${input.selfGithubUserId}, record publisher=${record.publisherGithubUserId})`,
    };
  }

  const existing = await getWorkOffer(
    input.workspaceId,
    input.potHomeSlug,
    record.publisherGithubUserId,
    record.offerId,
    input.sql,
  );
  if (existing && record.recordVersion <= existing.recordVersion) {
    return {
      ok: false,
      error: `record_version ${record.recordVersion} does not advance past stored ${existing.recordVersion} — re-read and bump`,
    };
  }

  const recordJson = canonicalWorkOfferRecordJson(record);
  const bytes = workOfferStoreSignedBytes({
    workspaceId: input.workspaceId,
    potHomeSlug: input.potHomeSlug,
    recordVersion: record.recordVersion,
    canonicalRecordJson: recordJson,
  });
  const signature = (await input.signer.sign(bytes)).toString('base64');

  const now = Date.now();
  const rows = (await pg(input.sql).unsafe(
    `INSERT INTO harness_shared.p2p_work_offers
       (workspace_id, harness_slug, publisher_github_user_id, offer_id, record_json,
        signer_device_pubkey, signature, record_version, fleet_slug, pot_slug, offer_kind,
        status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     ON CONFLICT (workspace_id, harness_slug, publisher_github_user_id, offer_id) DO UPDATE SET
       record_json          = EXCLUDED.record_json,
       signer_device_pubkey = EXCLUDED.signer_device_pubkey,
       signature            = EXCLUDED.signature,
       record_version       = EXCLUDED.record_version,
       fleet_slug           = EXCLUDED.fleet_slug,
       pot_slug             = EXCLUDED.pot_slug,
       offer_kind           = EXCLUDED.offer_kind,
       status               = EXCLUDED.status,
       updated_at           = $13
     RETURNING ${READ_COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      record.publisherGithubUserId,
      record.offerId,
      recordJson,
      input.signer.pubkey,
      signature,
      record.recordVersion,
      record.fleetSlug,
      record.potSlug,
      record.kind,
      record.status,
      now,
    ],
  )) as unknown as WorkOfferDbRow[];
  return { ok: true, stored: rowToStored(rows[0]!) };
}

/**
 * Per-OFFER host-local disposition write — the P-009 honor path's atomic claim
 * + transition on ONE foreign row (the predicate variant below sweeps classes).
 * Same non-federation contract as setLocalOfferDisposition.
 *
 * Two modes:
 *   expect omitted/null — the CLAIM: set only while the row is still 'open' and
 *     un-disposed. The `IS NULL` guard is what makes two concurrent honor hooks
 *     race-safe: exactly one caller sees `true`.
 *   expect '<value>' — the TRANSITION: move an already-held disposition (e.g.
 *     'honoring' → 'honored' / 'refused:spawn_failed'), regardless of signed
 *     status (an outcome must be recordable even past a publisher cancel).
 * Returns whether THIS call changed the row.
 */
export async function setLocalOfferDispositionForOffer(
  workspaceId: string,
  potHomeSlug: string,
  publisherGithubUserId: number,
  offerId: string,
  disposition: string,
  opts?: { expect?: string | null },
  sql?: Sql,
): Promise<boolean> {
  const expect = opts?.expect ?? null;
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.p2p_work_offers
        SET local_disposition = $5, updated_at = $6
      WHERE workspace_id = $1 AND harness_slug = $2
        AND publisher_github_user_id = $3 AND offer_id = $4
        AND ${expect === null ? "status = 'open' AND local_disposition IS NULL" : 'local_disposition = $7'}
      RETURNING offer_id`,
    expect === null
      ? [workspaceId, potHomeSlug, publisherGithubUserId, offerId, disposition, Date.now()]
      : [workspaceId, potHomeSlug, publisherGithubUserId, offerId, disposition, Date.now(), expect],
  )) as unknown as Array<{ offer_id: string }>;
  return rows.length > 0;
}

/** Which foreign offers a host-local refusal covers — mirrors the reaper's
 *  RevocationTrigger shapes (revocation-reaper.ts P-106 deferred #2). */
export type LocalDispositionPredicate =
  | { fleetSlug: string }
  | { publisherGithubUserId: number };

/**
 * HOST-LOCAL refusal write (P-106 deferred #2): mark every still-OPEN,
 * not-yet-disposed offer the predicate covers so THIS host stops serving it
 * (list reads exclude disposed rows by default; the puller never claims one).
 * UNSIGNED + NON-FEDERATED by design — the publisher's signed status is
 * untouched, no capture fires, and the stamp function masks the column so the
 * row's LWW clock never moves. Idempotent (already-disposed rows are skipped).
 * Returns the number of offers newly refused.
 */
export async function setLocalOfferDisposition(
  workspaceId: string,
  potHomeSlug: string,
  predicate: LocalDispositionPredicate,
  disposition: string,
  sql?: Sql,
): Promise<number> {
  const byFleet = 'fleetSlug' in predicate;
  const rows = (await pg(sql).unsafe(
    `UPDATE harness_shared.p2p_work_offers
        SET local_disposition = $4, updated_at = $5
      WHERE workspace_id = $1 AND harness_slug = $2
        AND ${byFleet ? 'fleet_slug' : 'publisher_github_user_id'} = $3
        AND status = 'open' AND local_disposition IS NULL
      RETURNING offer_id`,
    [
      workspaceId,
      potHomeSlug,
      byFleet ? predicate.fleetSlug : predicate.publisherGithubUserId,
      disposition,
      Date.now(),
    ],
  )) as unknown as Array<{ offer_id: string }>;
  return rows.length;
}
