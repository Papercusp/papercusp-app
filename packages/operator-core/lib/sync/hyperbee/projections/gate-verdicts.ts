/**
 * Hyperbee → PG projection for `harness_shared.gate_verdicts` — the distributed
 * test gate's device-signed shard-run verdict facts
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-044 DG-1, mig 442).
 *
 * Mirrors projections/bee-claim-spec.ts (the newest hive-home-scoped CDC
 * federated table). Federated subset = harness_slug (hive HOME demux),
 * verdict_id (content address = the peer-log key), schema_v, repo_key,
 * staging_sha, shard_id, inputs_hash, verdict, duration_ms, device_pubkey,
 * verdict_ts, sig. NOT federated: created_at (machine-local).
 *
 * RECEIVE-SIDE VERIFICATION (the DG-1 acceptance): a REMOTE op is applied only
 * when ALL of
 *   (1) the embedded Ed25519 signature verifies over the domain-tagged payload
 *       (verifyGateVerdict — the fact carries its own proof),
 *   (2) the claimed verdict_id equals the recomputed content address (a
 *       tampered field re-addresses and can never overwrite the honest fact),
 *   (3) the SIGNER device (row.device_pubkey — not the relaying source log)
 *       maps to an ADMITTED hive member (hive_members attestations via the
 *       comms-tier-gate device map; githubUserId null ⇒ unadmitted ⇒ DROP,
 *       fail-CLOSED).
 * Whether an admitted member's verdict COUNTS toward green is DG-4/DG-5's
 * gate-trust decision at aggregation — storage admission ≠ gate trust.
 *
 * Rows are IMMUTABLE FACTS: apply is INSERT … ON CONFLICT DO NOTHING (dedup by
 * content address); there is no LWW because there is no UPDATE.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { resolveAuthorCommsTier } from '../comms-tier-gate';
import {
  type GateVerdict,
  verifyGateVerdictWithId,
} from '../../pot-git/gate/verdicts';
import type { CommsTier } from '../../../trust/comms-trust';

/** Wire-shape of a federated gate_verdicts row. Defensive on every field. */
export interface GateVerdictWireRow {
  /** The hive HOME slug — the per-harness projection guard key. */
  harness_slug: string;
  /** Content address (sha256 hex of the signed payload) — the peer-log key. */
  verdict_id: string;
  schema_v: number;
  repo_key: string;
  staging_sha: string;
  shard_id: string;
  inputs_hash: string;
  verdict: string;
  duration_ms: number;
  device_pubkey: string;
  verdict_ts: number;
  sig: string;
}

export function isGateVerdictWireRow(input: unknown): input is GateVerdictWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.verdict_id !== 'string' || !/^[0-9a-f]{64}$/.test(r.verdict_id)) return false;
  if (typeof r.schema_v !== 'number' || !Number.isFinite(r.schema_v)) return false;
  if (typeof r.repo_key !== 'string' || r.repo_key.length === 0) return false;
  if (typeof r.staging_sha !== 'string' || r.staging_sha.length === 0) return false;
  if (typeof r.shard_id !== 'string' || r.shard_id.length === 0) return false;
  if (typeof r.inputs_hash !== 'string' || r.inputs_hash.length === 0) return false;
  if (r.verdict !== 'pass' && r.verdict !== 'fail') return false;
  if (typeof r.duration_ms !== 'number' || !Number.isFinite(r.duration_ms)) return false;
  if (typeof r.device_pubkey !== 'string' || r.device_pubkey.length === 0) return false;
  if (typeof r.verdict_ts !== 'number' || !Number.isFinite(r.verdict_ts)) return false;
  if (typeof r.sig !== 'string' || r.sig.length === 0) return false;
  return true;
}

/** Reassemble the SIGNED payload shape from the wire row. */
export function gateVerdictFromWireRow(row: GateVerdictWireRow): GateVerdict {
  return {
    v: row.schema_v,
    repo_key: row.repo_key,
    staging_sha: row.staging_sha,
    shard_id: row.shard_id,
    inputs_hash: row.inputs_hash,
    verdict: row.verdict as GateVerdict['verdict'],
    duration_ms: row.duration_ms,
    device_pubkey: row.device_pubkey,
    ts: row.verdict_ts,
    sig: row.sig,
  };
}

export interface GateVerdictProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** The hive-home slug when this projection is HIVE-BOUND — receive-side
   *  verification applies to remote ops only when set (bee-claim-spec M6 scoping). */
  potHomeSlug?: string;
  /** Test seam: resolve the VERDICT SIGNER device's membership (githubUserId
   *  null ⇒ unadmitted). Default binds comms-tier-gate (hive_members attestations). */
  resolveSignerMembership?: (
    devicePubkey: string,
  ) => Promise<{ tier: CommsTier; githubUserId: number | null }>;
}

function composeKey(row: GateVerdictWireRow): string {
  return row.verdict_id;
}

function decodeValue(raw: unknown): GateVerdictWireRow | null {
  return isGateVerdictWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: GateVerdictProjectionOpts,
  row: GateVerdictWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;

  if (provenance.origin === 'remote' && opts.potHomeSlug) {
    // (1)+(2): signature + content-address integrity — self-certifying, no state.
    if (!verifyGateVerdictWithId(gateVerdictFromWireRow(row), row.verdict_id)) return;
    // (3): the SIGNER must be an admitted hive member device. Fail-CLOSED: a
    // resolve error / unknown device drops the op (the runner re-announces and
    // the fact re-federates; a dropped forged fact is the point).
    const resolve =
      opts.resolveSignerMembership ??
      ((device: string) =>
        resolveAuthorCommsTier({
          workspaceId: opts.workspaceId,
          potHomeSlug: opts.potHomeSlug!,
          devicePubkey: device,
        }));
    let member: { githubUserId: number | null };
    try {
      member = await resolve(row.device_pubkey);
    } catch {
      return;
    }
    if (member.githubUserId == null) return;
  }

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // Immutable content-addressed fact: first write wins, replays no-op.
  await sql`
    INSERT INTO harness_shared.gate_verdicts
      (workspace_id, verdict_id, harness_slug, schema_v, repo_key, staging_sha,
       shard_id, inputs_hash, verdict, duration_ms, device_pubkey, verdict_ts,
       sig, origin, author_pubkey, fed_ts, fed_hlc, created_at)
    VALUES
      (${opts.workspaceId}, ${row.verdict_id}, ${row.harness_slug}, ${row.schema_v},
       ${row.repo_key}, ${row.staging_sha}, ${row.shard_id}, ${row.inputs_hash},
       ${row.verdict}, ${row.duration_ms}, ${row.device_pubkey}, ${row.verdict_ts},
       ${row.sig}, ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc}, now())
    ON CONFLICT (workspace_id, verdict_id) DO NOTHING
  `;
}

async function deleteFromPg(opts: GateVerdictProjectionOpts, key: string): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  // GC of an immutable fact — no LWW guard needed: identical id ⇒ identical
  // content, so a late re-insert simply restores the same fact.
  await sql`
    DELETE FROM harness_shared.gate_verdicts
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND verdict_id = ${key}
  `;
}

export function buildGateVerdictProjection(
  opts: GateVerdictProjectionOpts,
): TableProjection<GateVerdictWireRow> {
  return {
    tableTag: 'gate-verdicts',
    // EI-117: CDC-captured table — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key) => deleteFromPg(opts, key),
  };
}

export const _testing = { composeKey, decodeValue, isGateVerdictWireRow, writeToPg };
