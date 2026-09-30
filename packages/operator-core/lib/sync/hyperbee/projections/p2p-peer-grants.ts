/**
 * Hyperbee → PG projection for `harness_shared.p2p_peer_grants` — P2P
 * capability grants federated as hive state
 * (p2p-work-distribution-2026-07-02 P-001, mig 463).
 *
 * Mirrors projections/bee-claim-spec.ts (hive-home-scoped key over the
 * peer-log) with a STRICTER apply gate — grants are a SECURITY surface:
 *
 *   RECEIVER-ENFORCED IDENTITY (M6/L9, the item's core invariant): an inbound
 *   REMOTE op applies ONLY when the op's VERIFIED source-log device resolves —
 *   through the receiver's OWN hive_members attestations, never anything
 *   sender-asserted — to the SAME numeric GitHub user the row names as
 *   `grantor_github_user_id`. You can author grants solely AS YOURSELF; a
 *   forged "alice grants my fleet spawn" from bob's device is dropped with a
 *   COUNTER (M15: unauthenticated failure paths get counters, not receipts).
 *
 *   X6 EPOCHS: every applied op advances the receiver's per-grantor high-water
 *   (p2p_grantor_epochs, LOCAL). Stale-epoch rows still APPLY under LWW (the
 *   per-row fed_order_key guard already fences replays); the epoch fence is
 *   enforced at USE time (checkP2pCapability refuses spawn-class on a trailing
 *   epoch) — matching the item text: "spawn-class OPS refuse", not applies.
 *   Wall-clock never gates anything here.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { resolveAuthorCommsTier } from '../comms-tier-gate';
import { advanceGrantorHighWater } from '../../../p2p/grant-store';
import { bumpRefusedOpCounter } from '../../../p2p/receipts';
import { reapForeignSessionsForRevocation } from '../../../p2p/revocation-reaper';

/** Wire-shape of a federated p2p_peer_grants row. Defensive on every field. */
export interface P2pPeerGrantWireRow {
  /** The hive HOME slug — the per-harness projection guard key. */
  harness_slug: string;
  grantor_github_user_id: number;
  grantor_login: string | null;
  grantee_kind: string;
  grantee_ref: string;
  capabilities: string[];
  preset: string | null;
  status: string;
  grantor_epoch: number;
  wake_rate_cap_per_hour: number | null;
  excluded_device_pubkeys: string[];
  note: string | null;
}

export function isP2pPeerGrantWireRow(input: unknown): input is P2pPeerGrantWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (typeof r.harness_slug !== 'string' || r.harness_slug.length === 0) return false;
  if (typeof r.grantor_github_user_id !== 'number' || !Number.isInteger(r.grantor_github_user_id) || r.grantor_github_user_id <= 0) return false;
  if (r.grantor_login !== null && typeof r.grantor_login !== 'string') return false;
  if (r.grantee_kind !== 'fleet' && r.grantee_kind !== 'pool') return false;
  if (typeof r.grantee_ref !== 'string' || r.grantee_ref.length === 0) return false;
  if (!Array.isArray(r.capabilities) || r.capabilities.some((c) => typeof c !== 'string')) return false;
  if (r.preset !== null && typeof r.preset !== 'string') return false;
  if (r.status !== 'active' && r.status !== 'revoked') return false;
  if (typeof r.grantor_epoch !== 'number' || !Number.isFinite(r.grantor_epoch) || r.grantor_epoch < 0) return false;
  if (r.wake_rate_cap_per_hour !== null && typeof r.wake_rate_cap_per_hour !== 'number') return false;
  if (!Array.isArray(r.excluded_device_pubkeys) || r.excluded_device_pubkeys.some((c) => typeof c !== 'string')) return false;
  if (r.note !== null && typeof r.note !== 'string') return false;
  return true;
}

export interface P2pPeerGrantsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** The hive-home slug when this projection is HIVE-BOUND — remote ops are
   *  identity-gated only when set (a non-hive topology has no foreign authors). */
  potHomeSlug?: string;
  /** Test seam: resolve an op's VERIFIED source-log device pubkey from the
   *  provenance authorPubkey (sourceLogKeyHex). Prod wires resolveAuthorDevice. */
  resolveAuthorDevice?: (sourceLogKeyHex: string) => string | null;
  /** Test seam: resolve the author DEVICE's attested identity. Default binds
   *  comms-tier-gate (hive_members attestations → {tier, githubUserId}). */
  resolveAuthorIdentity?: (devicePubkey: string | null) => Promise<{ githubUserId: number | null }>;
  /** M15 counter hook for dropped (unauthenticated) ops; default logs. */
  onRefusedApply?: (reason: 'no_author_device' | 'identity_unresolved' | 'grantor_mismatch', row: P2pPeerGrantWireRow) => void;
}

function composeKey(row: P2pPeerGrantWireRow): string {
  return `${row.grantor_github_user_id}:${row.grantee_kind}:${row.grantee_ref}`;
}

function decodeValue(raw: unknown): P2pPeerGrantWireRow | null {
  return isP2pPeerGrantWireRow(raw) ? raw : null;
}

function refuse(
  opts: P2pPeerGrantsProjectionOpts,
  reason: 'no_author_device' | 'identity_unresolved' | 'grantor_mismatch',
  row: P2pPeerGrantWireRow,
): void {
  if (opts.onRefusedApply) {
    opts.onRefusedApply(reason, row);
    return;
  }
  // M15 (P-004): an UNAUTHENTICATED failure path gets a COUNTER + a loud line,
  // not a receipt (there is no verified requester to receipt). p2p:trace reads
  // the counters alongside the receipt timeline.
  console.warn(
    `[p2p-peer-grants] REFUSED inbound grant op (${reason}): grantor=${row.grantor_github_user_id} ` +
      `grantee=${row.grantee_kind}:${row.grantee_ref} hive=${row.harness_slug}`,
  );
  void bumpRefusedOpCounter(
    { workspaceId: opts.workspaceId, potSlug: row.harness_slug, reason: `grant-apply:${reason}` },
    opts.sql as Parameters<typeof bumpRefusedOpCounter>[1],
  ).catch(() => {
    /* counter is advisory; never break the apply loop */
  });
}

async function writeToPg(
  opts: P2pPeerGrantsProjectionOpts,
  row: P2pPeerGrantWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;

  // RECEIVER-ENFORCED (M6/L9): remote ops must be authored by the grantor
  // themself — the verified source-log device's ATTESTED numeric GitHub
  // user-id (receiver-side hive_members, never sender-asserted) must equal
  // row.grantor_github_user_id. Fail-CLOSED on any resolution failure: a grant
  // (or a forged revocation-suppressing re-grant) from an unverifiable device
  // never applies.
  let sourceLogDevice: string | null = null;
  if (provenance.origin === 'remote' && opts.potHomeSlug) {
    sourceLogDevice = provenance.authorPubkey
      ? (opts.resolveAuthorDevice?.(provenance.authorPubkey) ?? null)
      : null;
    if (!sourceLogDevice) {
      refuse(opts, 'no_author_device', row);
      return;
    }
    const resolveIdentity =
      opts.resolveAuthorIdentity ??
      (async (device: string | null) => {
        if (!device) return { githubUserId: null };
        const r = await resolveAuthorCommsTier({
          workspaceId: opts.workspaceId,
          potHomeSlug: opts.potHomeSlug!,
          devicePubkey: device,
        });
        return { githubUserId: r.githubUserId };
      });
    let authorUserId: number | null = null;
    try {
      authorUserId = (await resolveIdentity(sourceLogDevice)).githubUserId;
    } catch {
      authorUserId = null;
    }
    if (authorUserId == null) {
      refuse(opts, 'identity_unresolved', row);
      return;
    }
    if (authorUserId !== row.grantor_github_user_id) {
      refuse(opts, 'grantor_mismatch', row);
      return;
    }
  }

  const sql = opts.sql ?? getOrgPg().sql;
  const authorPubkey = provenance?.authorPubkey ?? null;
  const origin = provenance.origin;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  const upsertResult = await sql`
    INSERT INTO harness_shared.p2p_peer_grants
      (workspace_id, harness_slug, grantor_github_user_id, grantor_login,
       grantee_kind, grantee_ref, capabilities, preset, status, grantor_epoch,
       wake_rate_cap_per_hour, excluded_device_pubkeys, note,
       origin, author_pubkey, fed_ts, fed_hlc, updated_at)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.grantor_github_user_id},
       ${row.grantor_login}, ${row.grantee_kind}, ${row.grantee_ref},
       ${row.capabilities}, ${row.preset}, ${row.status}, ${row.grantor_epoch},
       ${row.wake_rate_cap_per_hour}, ${row.excluded_device_pubkeys}, ${row.note},
       ${origin}, ${authorPubkey}, ${fedTs}, ${fedHlc}, now())
    ON CONFLICT (workspace_id, harness_slug, grantor_github_user_id, grantee_kind, grantee_ref)
    DO UPDATE SET
      grantor_login           = EXCLUDED.grantor_login,
      capabilities            = EXCLUDED.capabilities,
      preset                  = EXCLUDED.preset,
      status                  = EXCLUDED.status,
      grantor_epoch           = EXCLUDED.grantor_epoch,
      wake_rate_cap_per_hour  = EXCLUDED.wake_rate_cap_per_hour,
      excluded_device_pubkeys = EXCLUDED.excluded_device_pubkeys,
      note                    = EXCLUDED.note,
      origin                  = EXCLUDED.origin,
      author_pubkey           = EXCLUDED.author_pubkey,
      fed_ts                  = EXCLUDED.fed_ts,
      fed_hlc                 = EXCLUDED.fed_hlc,
      updated_at              = now()
    -- PG-level LWW guard (D-001, transitivity-fixed EI-1698): one order space
    -- via fed_order_key(); a replayed pre-revocation grant op orders BELOW the
    -- revocation row and is rejected here (the first X6 fence; the second is
    -- checkP2pCapability's epoch refusal).
    WHERE harness_shared.fed_order_key(EXCLUDED.fed_hlc, EXCLUDED.fed_ts) >= harness_shared.fed_order_key(harness_shared.p2p_peer_grants.fed_hlc, harness_shared.p2p_peer_grants.fed_ts)
  `;

  // X6: an APPLIED (authenticated) op advances the grantor's high-water —
  // monotonic, receiver-derived, never federated.
  await advanceGrantorHighWater(
    {
      workspaceId: opts.workspaceId,
      potSlug: row.harness_slug,
      grantorGithubUserId: row.grantor_github_user_id,
      epoch: row.grantor_epoch,
    },
    sql,
  );

  // P-106 deferred #3 (revocation-reaper.ts): FEDERATED reap. A fleet-grant
  // revocation that LANDED here (upsertResult.count > 0 — the LWW guard above
  // rejects stale replays, and those must never trigger a reap) means a peer
  // withdrew consent for a fleet that THIS host may be running foreign
  // sessions for right now. The LOCAL owner-revoke path (p2p-grant-set.ts)
  // already reaps synchronously on the grantor's OWN host; this hook is what
  // makes that same withdrawal reach every OTHER host in the hive that
  // receives the federated row (revoke on machine A → reap on executor
  // machine B). Only remote-origin ops trigger it — a local op never reaches
  // writeToPg (skipOwnOps), so this only fires for genuinely inbound rows,
  // and only when potHomeSlug gated the RECEIVER-ENFORCED identity check
  // above, so row.grantor_github_user_id is already verified-authentic.
  // Pool grants have no p2p_foreign_workspaces rows (grantee_kind === 'fleet'
  // gate mirrors p2p-grant-set.ts). Best-effort: a reap failure/throw must
  // never unwind the grant write that already landed above (D-004 loud, not
  // silently dropped — surfaced via console.warn).
  if (
    (upsertResult.count ?? 0) > 0 &&
    row.status === 'revoked' &&
    row.grantee_kind === 'fleet' &&
    provenance.origin === 'remote' &&
    opts.potHomeSlug
  ) {
    try {
      const r = await reapForeignSessionsForRevocation(
        {
          workspaceId: opts.workspaceId,
          potSlug: row.harness_slug,
          responderGithubUserId: row.grantor_github_user_id,
          responderDevicePubkey: sourceLogDevice,
          trigger: { kind: 'grant-revoked', fleetSlug: row.grantee_ref },
          actor: `p2p-peer-grants-projection:${row.grantor_github_user_id}`,
          reason: 'federated-revocation',
        },
        sql,
      );
      if (!r.ok) {
        console.warn(
          `[p2p-peer-grants] federated reap refused for revoked fleet grant ` +
            `(grantor=${row.grantor_github_user_id} fleet=${row.grantee_ref}): ${r.refusal.code} — ${r.refusal.detail}`,
        );
      }
    } catch (err) {
      console.warn(
        `[p2p-peer-grants] federated reap threw for revoked fleet grant ` +
          `(grantor=${row.grantor_github_user_id} fleet=${row.grantee_ref}): ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

async function deleteFromPg(
  opts: P2pPeerGrantsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  // Grants revoke via LWW put (status='revoked' carries the epoch); a del op is
  // the admin-cleanup path only. LWW-guarded like bee-claim-spec.
  await sql`
    DELETE FROM harness_shared.p2p_peer_grants
    WHERE workspace_id = ${opts.workspaceId}
      AND harness_slug = ${opts.harnessSlug}
      AND grant_fed_key = ${key}
      AND (
        (${hlc}::text IS NULL AND ${ts}::bigint IS NULL)
        OR harness_shared.fed_order_key(${hlc}::text, ${ts}::bigint) >= harness_shared.fed_order_key(fed_hlc, fed_ts)
      )
  `;
}

export function buildP2pPeerGrantsProjection(
  opts: P2pPeerGrantsProjectionOpts,
): TableProjection<P2pPeerGrantWireRow> {
  return {
    tableTag: 'p2p-peer-grants',
    // EI-117: CDC-captured table — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isP2pPeerGrantWireRow, writeToPg };
