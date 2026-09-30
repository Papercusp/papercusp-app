/**
 * Hyperbee → PG projection for `harness_shared.bee_claim_specs` — the Queen's
 * per-bee claim SPECS federated as hive state
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-016, mig 438).
 *
 * Mirrors projections/hive-settings.ts (the closest analog: a hive-home-scoped
 * key riding the peer-log). Federated subset = harness_slug (the hive HOME
 * slug — the demux/projection guard), bee_id, spec (jsonb), revision,
 * updated_by. NOT federated (machine-local): updated_at. Standard provenance
 * columns carry the echo-guard + fed_order_key()-ordered LWW (EI-1698).
 *
 * Why: get_next reads the spec from LOCAL PG — without federation, a queen on
 * machine A versioning a spec never reaches a bee pulling on machine B. With
 * it, spec authoring is cross-machine steering (the scheduler-usage model the
 * pot-coordination-health rubric grades).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { resolveAuthorCommsTier } from '../comms-tier-gate';
import { commsTierAtLeast, FALLBACK_COMMS_TIER, type CommsTier } from '../../../trust/comms-trust';
import { isIdOnlySelector } from '../../../scheduler/claim-spec';

/** Wire-shape of a federated cup_claim_specs row. Defensive on every field. */
export interface BeeClaimSpecRow {
  /** The hive HOME slug — the per-harness projection guard key. */
  harness_slug: string;
  bee_id: string;
  spec: Record<string, unknown>;
  revision: number;
  updated_by: string | null;
}

export function isBeeClaimSpecRow(input: unknown): input is BeeClaimSpecRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.bee_id !== 'string' || r.bee_id.length === 0) return false;
  if (!r.spec || typeof r.spec !== 'object' || Array.isArray(r.spec)) return false;
  if (typeof r.revision !== 'number' || !Number.isFinite(r.revision)) return false;
  if (r.updated_by !== null && typeof r.updated_by !== 'string') return false;
  return true;
}

export interface BeeClaimSpecProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** M6 (audit D-013): the hive-home slug when this projection is HIVE-BOUND —
   *  a cross-machine claim-spec apply is comms-tier-gated only when set (mirrors
   *  coord-message / the WI-259 member-content guard). */
  potHomeSlug?: string;
  /** M6 test seam: resolve an op's VERIFIED source-log device pubkey from the
   *  provenance authorPubkey (sourceLogKeyHex). Prod wires resolveAuthorDevice. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** M6 test seam: resolve the author DEVICE's effective comms tier. Default binds
   *  comms-tier-gate (hive_members attestations → comms-trust). Only consulted for
   *  a hive-bound projection on a remote op. */
  resolveCommsTier?: (
    devicePubkey: string | null,
  ) => Promise<{ tier: CommsTier; githubUserId: number | null }>;
}

function composeKey(row: BeeClaimSpecRow): string {
  return row.bee_id;
}

function decodeValue(raw: unknown): BeeClaimSpecRow | null {
  return isBeeClaimSpecRow(raw) ? raw : null;
}

async function writeToPg(
  opts: BeeClaimSpecProjectionOpts,
  row: BeeClaimSpecRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;

  // M6 (audit D-013): a federated claim spec is a STEER-class action — it
  // redirects a bee's work selection (get_next reads it). bee_claim_specs federate
  // under the hive-HOME slug, so decideMemberContentOp's own-slug fast path would
  // trivially admit ANY federated spec; the real authorization is the COMMS TIER of
  // the VERIFIED author device. When the projection is HIVE-BOUND and the op is
  // REMOTE, resolve that tier and REQUIRE 'steer': an admitted-but-below-steer
  // member — or a demoted / removed one (the tier is re-resolved at APPLY, not a
  // stale admission flag) — cannot redirect another member's bee. A tier-resolve
  // error falls to FALLBACK_COMMS_TIER ('message' < 'steer') ⇒ NOT applied
  // (fail-CLOSED — correct for a high-privilege action). Local/own writes (the
  // queen on this machine) and non-hive topologies stay full-passthrough.
  if (provenance.origin === 'remote' && opts.potHomeSlug) {
    const sourceLogDevice = provenance.authorPubkey
      ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
      : null;
    const resolveTier =
      opts.resolveCommsTier ??
      (async (device: string | null) =>
        device
          ? resolveAuthorCommsTier({
              workspaceId: opts.workspaceId,
              potHomeSlug: opts.potHomeSlug!,
              devicePubkey: device,
            })
          : { tier: FALLBACK_COMMS_TIER, githubUserId: null });
    let authorTier: CommsTier = FALLBACK_COMMS_TIER;
    try {
      authorTier = (await resolveTier(sourceLogDevice)).tier;
    } catch {
      authorTier = FALLBACK_COMMS_TIER;
    }
    if (!commsTierAtLeast(authorTier, 'steer')) {
      // Below steer — this author's spec does NOT apply. Best-effort drop (no
      // quarantine rail for specs): the authoring queen re-emits on its next
      // version bump, and a bee with no applied spec falls back to DEFAULT_CLAIM_SPEC.
      return;
    }
  }

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  // id_only (mig 389) is a DENORMALIZED observability tripwire the sender's own
  // setClaimSpec computes via isIdOnlySelector(spec) — recompute it here from the
  // federated `spec` itself rather than carrying it on the wire, so a peer's copy
  // is never stale relative to its own spec value (federated-column-completeness
  // integration.test.ts).
  const idOnly = isIdOnlySelector(row.spec as { view?: { filter?: unknown } });
  await sql`
    INSERT INTO harness_shared.cup_claim_specs
      (workspace_id, bee_id, spec, revision, updated_by, harness_slug,
       origin, author_pubkey, fed_ts, fed_hlc, updated_at, id_only)
    VALUES
      (${opts.workspaceId}, ${row.bee_id}, ${JSON.stringify(row.spec)}::text::jsonb,
       ${row.revision}, ${row.updated_by}, ${row.harness_slug},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc}, now(), ${idOnly})
    ON CONFLICT (workspace_id, bee_id) DO UPDATE SET
      spec          = EXCLUDED.spec,
      revision      = EXCLUDED.revision,
      updated_by    = EXCLUDED.updated_by,
      harness_slug  = EXCLUDED.harness_slug,
      origin        = EXCLUDED.origin,
      author_pubkey = EXCLUDED.author_pubkey,
      fed_ts        = EXCLUDED.fed_ts,
      fed_hlc       = EXCLUDED.fed_hlc,
      updated_at    = now(),
      id_only       = EXCLUDED.id_only
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): both sides compared
    -- in ONE order space via fed_order_key() -- an op's real HLC when it has one,
    -- else a derived HLC built from its wall-clock fed_ts (mirrors lwwPick exactly,
    -- so the guard never rejects what the in-process merge fold would pick).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.cup_claim_specs.fed_hlc, harness_shared.cup_claim_specs.fed_ts)
  `;
}

async function deleteFromPg(
  opts: BeeClaimSpecProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  await sql`
    DELETE FROM harness_shared.cup_claim_specs
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND bee_id = ${key}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildBeeClaimSpecProjection(
  opts: BeeClaimSpecProjectionOpts,
): TableProjection<BeeClaimSpecRow> {
  return {
    tableTag: 'bee-claim-specs',
    // EI-117: CDC-captured table — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isBeeClaimSpecRow };
