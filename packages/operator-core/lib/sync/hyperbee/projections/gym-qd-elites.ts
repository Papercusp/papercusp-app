/**
 * Hyperbee → PG projection for FOREIGN QD elites — the receive side of gym
 * elite federation (federated-scout-gym-learning-2026-07-02 F1-2/F1-5, D-005).
 *
 * SEND side (mig 464): `gym_qd_archive` rows the writer stamps `federatable`
 * (D-002 eligibility: outcome=won OR grade>=4) CDC-capture onto the peer-log,
 * wire-keyed by `niche_key` — so within ONE sender's log the latest elite per
 * niche wins = best-per-source-per-niche on the wire.
 *
 * RECEIVE side (THIS file + mig 465): foreign elites land in their OWN table,
 * `gym_qd_foreign_elites`, provenance in the PK `(ws, hive_home, niche_key,
 * source_hive)`. That makes D-005 STRUCTURAL rather than behavioral:
 *
 *   - The local archive (`gym_qd_archive`) stays canonical-local — a peer's op
 *     can NEVER touch a local elite because peers only ever write THIS table
 *     (the 464 receiver-columns misfit was redesigned away in 465: the archive
 *     PK is one-row-per-niche, so per-source foreign rows could not coexist).
 *   - Best-per-source-per-niche IS the primary key.
 *   - Read-time max = a UNION at query time (the F2-1 map lane) — never a
 *     destructive cross-source merge (fitness scales are incomparable across
 *     hives; keep-higher on untrusted input = data loss + spam reward).
 *   - Revocation cleanup = `purgeRevokedForeignElites` (wired into the
 *     hive-members onMemberApplied hook) — DELETE by source partition.
 *
 * `source_hive` is RECEIVER-STAMPED from `provenance.authorPubkey` (for a
 * remote op that is the immutable sourceLogKeyHex — never a sender-claimed
 * field). LWW applies only WITHIN one (niche × source) partition via the same
 * fed_order_key() guard agent-facts/hive-settings use (EI-1698).
 *
 * `novelty_gift` (D-005): stamped true iff the foreign elite lands in a niche
 * the LOCAL archive has no elite for at apply time — the "a peer explored
 * territory we haven't" signal the F2-1 map lane surfaces. Stamped on first
 * landing only (stable across later updates of the same partition).
 *
 * Epoch-ENCRYPTED content (deliberately NOT in REKEY_PLAINTEXT_TAGS — elite
 * descriptors/rationales are unreadable to non-members on the wire, D-006) and
 * rate-limited as CONTENT ('gym-qd-elites-by-niche' in CONTENT_TABLE_TAGS).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { bumpFederationRefusedOp, type RefusedOpReason } from '../federation-refused-op-counter';
import { isEliteOutcomeRecord, verifyEliteOutcomeForElite } from '../../../gym/qd/elite-outcome-record';

/** Wire-shape of a federated gym_qd_archive row — the subset we apply. */
export interface GymQdEliteWireRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  /** NicheDescriptorV1 key (v1:surface/shape/rN/size) — also the wire key. */
  niche_key: string;
  candidate_id: string;
  scope: string;
  domain: string;
  risk: string;
  fitness: number;
  descriptor: Record<string, unknown>;
  rationale: string | null;
  /** D-002 sender eligibility stamp — receiver re-checks it defensively. */
  federatable: boolean;
  /** Sender's elite-update time (epoch ms). */
  updated_at: number;
  /**
   * F1-6 / P-014 (D-005 hole 3): the device-signed EliteOutcomeRecord for this
   * elite, if the sender produced one. UNTRUSTED wire value (typed `unknown`) —
   * verified receiver-side in writeToPg (verifyEliteOutcomeForElite); it never
   * gates decode ("where verifiable": an absent/invalid record still admits the
   * elite, just outcome-UNVERIFIED).
   */
  outcome_record?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isGymQdEliteWireRow(input: unknown): input is GymQdEliteWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.niche_key) || r.niche_key.length === 0 || r.niche_key.length > 200) return false;
  if (!isString(r.candidate_id) || r.candidate_id.length === 0 || r.candidate_id.length > 200) return false;
  if (!isString(r.scope) || r.scope.length === 0 || r.scope.length > 120) return false;
  if (!isString(r.domain) || r.domain.length === 0 || r.domain.length > 120) return false;
  if (!isString(r.risk) || r.risk.length === 0 || r.risk.length > 40) return false;
  if (typeof r.fitness !== 'number' || !Number.isFinite(r.fitness)) return false;
  if (!r.descriptor || typeof r.descriptor !== 'object' || Array.isArray(r.descriptor)) return false;
  if (!(r.rationale === null || (isString(r.rationale) && r.rationale.length <= 2000))) return false;
  // D-002 defensive re-check: a non-federatable row must never apply, even if a
  // (buggy or hostile) sender's log carries one.
  if (r.federatable !== true) return false;
  if (typeof r.updated_at !== 'number' || !Number.isFinite(r.updated_at)) return false;
  return true;
}

export interface GymQdElitesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /**
   * F1-6 / P-014 anti-lift seam: resolve the DEVICE pubkey that owns the relaying
   * source log (`sourceLogKeyHex` = provenance.authorPubkey) — boot.ts wires this
   * from `admittedIdentities.get(sourceLogKeyHex).devicePubkey`. When absent (or it
   * returns null), the anti-lift check is skipped and only the signature + D-002 +
   * niche/candidate binding gate `outcome_verified`.
   */
  resolveSignerDevice?: (sourceLogKeyHex: string) => string | null;
  /**
   * F1-6 / P-014 membership seam (mirrors gate-verdicts): true iff the signer
   * device is an admitted hive member. When absent, membership is not required for
   * `outcome_verified` (tier-1 hive-members admission already gates who can write).
   */
  isDeviceAdmitted?: (devicePubkey: string) => boolean;
}

/** Matches mig 464's capture key: the niche_key column. */
function composeKey(row: GymQdEliteWireRow): string {
  return row.niche_key;
}

function decodeValue(raw: unknown): GymQdEliteWireRow | null {
  return isGymQdEliteWireRow(raw) ? raw : null;
}

/**
 * F1-4 / P-012: classify WHY a foreign elite op was refused for the per-source
 * counter. An elite-shaped row whose `federatable` stamp is not `true` is the
 * D-002 anti-spam refusal the defensive re-check exists for (a buggy or hostile
 * sender's log); anything else that fails the wire validator is 'malformed'.
 */
function classifyEliteRefusal(raw: unknown): RefusedOpReason {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    // Shaped like an elite (has a niche_key) but not marked federatable.
    if (typeof r.niche_key === 'string' && r.federatable !== true) return 'not-federatable';
  }
  return 'malformed';
}

/**
 * F1-4 / P-012: record a per-source refused-op counter when a FOREIGN elite op
 * was declined at decode. Only REMOTE ops carry an attributable source and are
 * the anti-poisoning signal D-005 asks for — a local decode failure is a local
 * bug, not a peer's spam, so it is not counted. Fail-soft via the counter fn.
 */
function onRefusedOp(
  opts: GymQdElitesProjectionOpts,
  raw: unknown,
  provenance: ProvenanceContext,
): Promise<void> | void {
  if (provenance.origin !== 'remote') return;
  return bumpFederationRefusedOp(
    {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      sourceHive: provenance.authorPubkey,
      tableTag: 'gym-qd-elites-by-niche',
      reason: classifyEliteRefusal(raw),
    },
    opts.sql,
  );
}

async function writeToPg(
  opts: GymQdElitesProjectionOpts,
  row: GymQdEliteWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  // FOREIGN rows only. Unlike agent-facts (whose local echo is a no-op refresh of
  // the NULL partition), the foreign-elites PK requires source_hive NOT NULL — and
  // a local elite's canonical row lives in gym_qd_archive. skipOwnOps already
  // filters own-log replays; this guard is the defensive second layer.
  if (provenance.origin !== 'remote') return;
  const sql = opts.sql ?? getOrgPg().sql;
  // H6: receiver-stamped source partition — the immutable sourceLogKeyHex.
  const sourceHive = provenance.authorPubkey || 'unknown-remote';
  const fedTs = provenance.ts ?? null;
  // F1-6 / P-014 (D-005 hole 3): VERIFY the device-signed outcome record, if the
  // sender carried a well-formed one. "where verifiable" — an absent/invalid record
  // does NOT reject the elite (tier-1 admission already gated who can write); it
  // just leaves outcome_verified=false so the reputation layer weights a
  // device-verified elite above a merely sender-asserted one. The signer device is
  // resolved from the RELAYING log (anti-lift) via the boot-wired seam — NOT the
  // raw sourceLogKeyHex, which is a log key, not a device id.
  const rec = isEliteOutcomeRecord(row.outcome_record) ? row.outcome_record : null;
  const signerDevice = opts.resolveSignerDevice?.(provenance.authorPubkey) ?? undefined;
  const outcomeVerified =
    rec != null &&
    verifyEliteOutcomeForElite(rec, {
      nicheKey: row.niche_key,
      candidateId: row.candidate_id,
      expectedSignerDevice: signerDevice,
      isSignerAdmitted: opts.isDeviceAdmitted,
    });
  const outcomeRecordJson = rec != null ? JSON.stringify(rec) : null;
  await sql`
    INSERT INTO harness_shared.gym_qd_foreign_elites
      (workspace_id, harness_slug, niche_key, source_hive, candidate_id,
       scope, domain, risk, fitness, descriptor, rationale, novelty_gift,
       author_pubkey, fed_ts, updated_at, outcome_record, outcome_verified)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.niche_key}, ${sourceHive},
       ${row.candidate_id}, ${row.scope}, ${row.domain}, ${row.risk}, ${row.fitness},
       ${JSON.stringify(row.descriptor)}::text::jsonb, ${row.rationale},
       (NOT EXISTS (SELECT 1 FROM harness_shared.gym_qd_archive a
          WHERE a.workspace_id = ${opts.workspaceId}
            AND a.harness_slug = ${row.harness_slug}
            AND a.niche_key = ${row.niche_key})),
       ${sourceHive}, ${fedTs}, ${row.updated_at},
       ${outcomeRecordJson}::text::jsonb, ${outcomeVerified})
    ON CONFLICT (workspace_id, harness_slug, niche_key, source_hive)
    DO UPDATE SET
      candidate_id     = EXCLUDED.candidate_id,
      scope            = EXCLUDED.scope,
      domain           = EXCLUDED.domain,
      risk             = EXCLUDED.risk,
      fitness          = EXCLUDED.fitness,
      descriptor       = EXCLUDED.descriptor,
      rationale        = EXCLUDED.rationale,
      author_pubkey    = EXCLUDED.author_pubkey,
      fed_ts           = EXCLUDED.fed_ts,
      updated_at       = EXCLUDED.updated_at,
      outcome_record   = EXCLUDED.outcome_record,
      outcome_verified = EXCLUDED.outcome_verified
      -- novelty_gift deliberately NOT updated: the first-landing stamp is stable.
    WHERE harness_shared.fed_order_key(NULL, EXCLUDED.fed_ts)
      >= harness_shared.fed_order_key(NULL, harness_shared.gym_qd_foreign_elites.fed_ts)
  `;
}

async function deleteFromPg(
  opts: GymQdElitesProjectionOpts,
  key: string,
  delTs?: number,
  _delHlc?: string,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (!key) return;
  // Only a REMOTE delete touches foreign rows — and ONLY its own source
  // partition (a peer retracting ITS elite must not delete another peer's, and
  // structurally cannot touch the local archive). A local delete's canonical
  // effect is on gym_qd_archive, which this projection never writes.
  if (provenance?.origin !== 'remote') return;
  const sql = opts.sql ?? getOrgPg().sql;
  const sourceHive = provenance.authorPubkey || 'unknown-remote';
  const ts = delTs ?? null;
  await sql`
    DELETE FROM harness_shared.gym_qd_foreign_elites
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.harnessSlug}
       AND niche_key = ${key}
       AND source_hive = ${sourceHive}
       AND (${ts}::bigint IS NULL
         OR harness_shared.fed_order_key(NULL, ${ts}::bigint) >= harness_shared.fed_order_key(NULL, fed_ts))`;
}

/**
 * D-005 revocation cleanup: purge every foreign elite contributed by a
 * now-revoked source. Wired into the hive-members onMemberApplied hook (a
 * membership apply carries the revoked_pubkeys blocklist). Two grains, both
 * covered:
 *   - LOG grain: source_hive / author_pubkey directly in the revoked list.
 *   - DEVICE grain: revoked_pubkeys hold DEVICE pubkeys; each row's
 *     source_hive (a source-log key) resolves to its admission-verified device
 *     via `resolveAuthorDevice` — rows whose device is revoked purge too.
 * Best-effort by contract (callers try/catch); returns the purged-row count.
 */
export async function purgeRevokedForeignElites(opts: {
  workspaceId: string;
  potHomeSlug: string;
  revokedPubkeys: readonly string[];
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  sql?: postgres.Sql;
}): Promise<number> {
  if (!opts.revokedPubkeys.length) return 0;
  const sql = opts.sql ?? getOrgPg().sql;
  const revoked = [...opts.revokedPubkeys];
  let purged = 0;
  const direct = (await sql`
    DELETE FROM harness_shared.gym_qd_foreign_elites
     WHERE workspace_id = ${opts.workspaceId}
       AND harness_slug = ${opts.potHomeSlug}
       AND (source_hive = ANY(${revoked}) OR author_pubkey = ANY(${revoked}))
     RETURNING niche_key`) as unknown as unknown[];
  purged += Array.isArray(direct) ? direct.length : 0;
  if (opts.resolveAuthorDevice) {
    const sources = (await sql`
      SELECT DISTINCT source_hive FROM harness_shared.gym_qd_foreign_elites
       WHERE workspace_id = ${opts.workspaceId}
         AND harness_slug = ${opts.potHomeSlug}`) as unknown as Array<{ source_hive: string }>;
    const revokedSet = new Set(revoked);
    const doomed = sources
      .map((s) => s.source_hive)
      .filter((src) => {
        const device = opts.resolveAuthorDevice!(src);
        return device !== null && revokedSet.has(device);
      });
    if (doomed.length) {
      const byDevice = (await sql`
        DELETE FROM harness_shared.gym_qd_foreign_elites
         WHERE workspace_id = ${opts.workspaceId}
           AND harness_slug = ${opts.potHomeSlug}
           AND source_hive = ANY(${doomed})
         RETURNING niche_key`) as unknown as unknown[];
      purged += Array.isArray(byDevice) ? byDevice.length : 0;
    }
  }
  return purged;
}

/** The registered projection (register-all wires this per booted hive harness). */
export function buildGymQdElitesProjection(
  opts: GymQdElitesProjectionOpts,
): TableProjection<GymQdEliteWireRow> {
  return {
    tableTag: 'gym-qd-elites-by-niche',
    // EI-117: CDC-captured table (mig 464 triggers) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    onRefusedOp: (raw, provenance) => onRefusedOp(opts, raw, provenance),
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc, provenance) =>
      deleteFromPg(opts, key, delTs, delHlc, provenance),
  };
}

export const _testing = { composeKey, decodeValue, isGymQdEliteWireRow, classifyEliteRefusal, onRefusedOp };
