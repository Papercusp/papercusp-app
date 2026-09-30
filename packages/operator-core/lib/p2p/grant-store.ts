/**
 * P2P peer-grant store + the C6 enforcement read
 * (p2p-work-distribution-2026-07-02 P-001, Lane A).
 *
 *   setPeerGrant    — upsert a grant (grantor = the LOCAL user's numeric gh id,
 *                     asserted by the caller from resolveLocalGithubIdentity;
 *                     the receiving side re-verifies via the op author's
 *                     attestation — receiver-enforced, M6/L9).
 *   revokePeerGrant — LWW status='revoked' + grantor EPOCH BUMP (X6). The bump
 *                     re-stamps the grantor's OTHER still-active grants at the
 *                     new epoch in the same txn, so they never spuriously trail
 *                     high-water (a revocation invalidates every older
 *                     spawn-class record until re-asserted — fail-closed
 *                     anti-replay, and the re-stamp IS that re-assertion for
 *                     the grants the grantor did NOT touch).
 *   getPeerGrant / listPeerGrants — reads for the settings surface (P-002).
 *   checkP2pCapability — THE enforcement read (C6): a direct PG SELECT with NO
 *                     cache tier of any kind between a landed revocation and
 *                     this check (WI-1547 class). Spawn-class capabilities
 *                     additionally refuse a grant whose grantor_epoch trails
 *                     the receiver's high-water (X6). Returns a STRUCTURED
 *                     refusal naming the exact missing capability so P-004's
 *                     receipts can carry it verbatim (no silent drops, D-004).
 *
 * C3 (WI-1564 class): every write/read resolves its workspace partition through
 * ONE shared resolver (`resolveP2pGrantWorkspace`) so write, capture, and drain
 * agree. Unlike claim-specs (fail-soft + warning), a GRANT write under the
 * un-federating 'default' partition is REFUSED outright: a grant peers never
 * learn about is dead config, and a revocation that silently fails to federate
 * is a security hole. Loud refusal over silent strand.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import type postgres from 'postgres';
import type { OrgSql } from '../work-items';

/** A plain client OR the TransactionSql sql.begin hands its callback. */
type PgClient = OrgSql | postgres.TransactionSql<Record<string, never>>;
import {
  normalizeCapabilities,
  isP2pGranteeKind,
  SPAWN_CLASS_CAPABILITIES,
  type P2pCapability,
  type P2pGranteeKind,
  type P2pPresetName,
} from './capabilities';

export interface PeerGrant {
  workspaceId: string;
  potSlug: string;
  grantorGithubUserId: number;
  grantorLogin: string | null;
  granteeKind: P2pGranteeKind;
  granteeRef: string;
  capabilities: P2pCapability[];
  preset: string | null;
  status: 'active' | 'revoked';
  grantorEpoch: number;
  wakeRateCapPerHour: number | null;
  excludedDevicePubkeys: string[];
  note: string | null;
}

/**
 * C3 / WI-1564: resolve the workspace partition a grant write/read uses from
 * the CALLER's resolved identity workspace. Mirrors resolveClaimSpecWorkspace
 * (scheduler/claim-spec-store.ts) — the one-helper-shared-by-writer-and-reader
 * invariant. `undefined` = unresolvable (null / '*' / empty / the legacy
 * 'default' partition, which no booted federation drain handle serves — a row
 * captured there strands, WI-1564's 137-stranded-rows failure).
 */
export function resolveP2pGrantWorkspace(
  identWorkspaceId: string | null | undefined,
): string | undefined {
  const ws = identWorkspaceId?.trim();
  return ws && ws !== '*' && ws !== DEFAULT_COORD_WORKSPACE ? ws : undefined;
}

export type GrantWriteResult =
  | { ok: true; grant: PeerGrant }
  | { ok: false; refusal: { code: string; detail: string } };

interface GrantRow {
  workspace_id: string;
  harness_slug: string;
  grantor_github_user_id: string | number;
  grantor_login: string | null;
  grantee_kind: string;
  grantee_ref: string;
  capabilities: string[];
  preset: string | null;
  status: string;
  grantor_epoch: string | number;
  wake_rate_cap_per_hour: number | null;
  excluded_device_pubkeys: string[];
  note: string | null;
}

function rowToGrant(r: GrantRow): PeerGrant {
  return {
    workspaceId: r.workspace_id,
    potSlug: r.harness_slug,
    grantorGithubUserId: Number(r.grantor_github_user_id),
    grantorLogin: r.grantor_login,
    granteeKind: r.grantee_kind as P2pGranteeKind,
    granteeRef: r.grantee_ref,
    capabilities: (r.capabilities ?? []) as P2pCapability[],
    preset: r.preset,
    status: r.status as PeerGrant['status'],
    grantorEpoch: Number(r.grantor_epoch),
    wakeRateCapPerHour: r.wake_rate_cap_per_hour,
    excludedDevicePubkeys: r.excluded_device_pubkeys ?? [],
    note: r.note,
  };
}

export interface SetPeerGrantArgs {
  /** The caller's RESOLVED identity workspace (C3 — run through resolveP2pGrantWorkspace). */
  workspaceId: string | null | undefined;
  /** The hive HOME slug the grant federates under. */
  potSlug: string;
  /** The LOCAL user's numeric GitHub id (X9) — receivers re-verify via attestation. */
  grantorGithubUserId: number;
  grantorLogin?: string | null;
  granteeKind: P2pGranteeKind | string;
  granteeRef: string;
  capabilities: readonly string[];
  /** Display-only preset label; callers expand presets via expandPreset first. */
  preset?: P2pPresetName | string | null;
  wakeRateCapPerHour?: number | null;
  excludedDevicePubkeys?: readonly string[];
  note?: string | null;
}

/** Upsert a grant. A capability DOWNGRADE of an active grant is revocation-class
 *  (M16) and bumps the grantor epoch exactly like revokePeerGrant. */
export async function setPeerGrant(
  args: SetPeerGrantArgs,
  sqlOverride?: OrgSql,
): Promise<GrantWriteResult> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail:
          `P2P grant write refused: the caller's workspace partition is unresolvable ` +
          `(got ${JSON.stringify(args.workspaceId ?? null)}). A grant captured under the ` +
          `'${DEFAULT_COORD_WORKSPACE}' partition never federates (WI-1564) — thread the ` +
          `caller's identity.workspaceId (resolveP2pGrantWorkspace).`,
      },
    };
  }
  const hive = args.potSlug?.trim();
  if (!hive) {
    return { ok: false, refusal: { code: 'hive_required', detail: 'P2P grants are hive-scoped; pass the hive HOME slug.' } };
  }
  if (!isP2pGranteeKind(args.granteeKind)) {
    return {
      ok: false,
      refusal: { code: 'invalid_grantee_kind', detail: `grantee_kind must be one of fleet|pool (got '${String(args.granteeKind)}').` },
    };
  }
  if (!args.granteeRef?.trim()) {
    return { ok: false, refusal: { code: 'grantee_required', detail: 'granteeRef (fleet slug / pool id) is required.' } };
  }
  if (!Number.isInteger(args.grantorGithubUserId) || args.grantorGithubUserId <= 0) {
    return {
      ok: false,
      refusal: { code: 'invalid_grantor', detail: `grantorGithubUserId must be a positive NUMERIC GitHub user-id (X9); got ${String(args.grantorGithubUserId)}.` },
    };
  }
  const caps = normalizeCapabilities(args.capabilities);
  if (!caps.ok) {
    return {
      ok: false,
      refusal: { code: 'invalid_capabilities', detail: `unknown capabilities: ${caps.invalid.join(', ')}` },
    };
  }

  const sql = sqlOverride ?? getOrgPg().sql;
  const granteeRef = args.granteeRef.trim();

  const rows = (await sql.begin(async (tx) => {
    // M16: shrinking an ACTIVE grant's capability set is revocation-class →
    // epoch bump (the projection-side high-water then fences replays of the
    // wider grant). A pure widen / fresh grant keeps the current epoch.
    const prior = (await tx`
      SELECT capabilities, status, grantor_epoch FROM harness_shared.p2p_peer_grants
       WHERE workspace_id = ${ws} AND harness_slug = ${hive}
         AND grantor_github_user_id = ${args.grantorGithubUserId}
         AND grantee_kind = ${args.granteeKind} AND grantee_ref = ${granteeRef}
       LIMIT 1`) as { capabilities: string[]; status: string; grantor_epoch: string | number }[];
    const priorCaps = new Set(prior[0]?.capabilities ?? []);
    const isDowngrade =
      prior[0]?.status === 'active' &&
      [...priorCaps].some((c) => !caps.capabilities.includes(c as P2pCapability));
    const epoch = isDowngrade
      ? await bumpGrantorEpochTx(tx, ws, hive, args.grantorGithubUserId)
      : Number(prior[0]?.grantor_epoch ?? (await currentGrantorEpochTx(tx, ws, hive, args.grantorGithubUserId)));

    return (await tx`
      INSERT INTO harness_shared.p2p_peer_grants
        (workspace_id, harness_slug, grantor_github_user_id, grantor_login,
         grantee_kind, grantee_ref, capabilities, preset, status, grantor_epoch,
         wake_rate_cap_per_hour, excluded_device_pubkeys, note, updated_at)
      VALUES
        (${ws}, ${hive}, ${args.grantorGithubUserId}, ${args.grantorLogin ?? null},
         ${args.granteeKind}, ${granteeRef}, ${caps.capabilities as string[]},
         ${args.preset ?? null}, 'active', ${epoch},
         ${args.wakeRateCapPerHour ?? null},
         ${(args.excludedDevicePubkeys ?? []) as string[]}, ${args.note ?? null}, now())
      ON CONFLICT (workspace_id, harness_slug, grantor_github_user_id, grantee_kind, grantee_ref)
      DO UPDATE SET
        grantor_login = EXCLUDED.grantor_login,
        capabilities = EXCLUDED.capabilities,
        preset = EXCLUDED.preset,
        status = 'active',
        grantor_epoch = EXCLUDED.grantor_epoch,
        wake_rate_cap_per_hour = EXCLUDED.wake_rate_cap_per_hour,
        excluded_device_pubkeys = EXCLUDED.excluded_device_pubkeys,
        note = EXCLUDED.note,
        origin = 'local',
        updated_at = now()
      RETURNING *`) as unknown as GrantRow[];
  })) as GrantRow[];

  return { ok: true, grant: rowToGrant(rows[0]!) };
}

/** The grantor's current epoch = the receiver-side high-water for THEMSELF
 *  (the grantor's own machine is also a receiver; one counter, one table). */
async function currentGrantorEpochTx(
  tx: PgClient,
  ws: string,
  hive: string,
  grantorId: number,
): Promise<number> {
  const rows = (await tx`
    SELECT high_water_epoch FROM harness_shared.p2p_grantor_epochs
     WHERE workspace_id = ${ws} AND harness_slug = ${hive}
       AND grantor_github_user_id = ${grantorId} LIMIT 1`) as { high_water_epoch: string | number }[];
  return Number(rows[0]?.high_water_epoch ?? 0);
}

async function bumpGrantorEpochTx(
  tx: PgClient,
  ws: string,
  hive: string,
  grantorId: number,
): Promise<number> {
  const rows = (await tx`
    INSERT INTO harness_shared.p2p_grantor_epochs
      (workspace_id, harness_slug, grantor_github_user_id, high_water_epoch, updated_at)
    VALUES (${ws}, ${hive}, ${grantorId}, 1, now())
    ON CONFLICT (workspace_id, harness_slug, grantor_github_user_id)
    DO UPDATE SET high_water_epoch = harness_shared.p2p_grantor_epochs.high_water_epoch + 1,
                  updated_at = now()
    RETURNING high_water_epoch`) as { high_water_epoch: string | number }[];
  return Number(rows[0]!.high_water_epoch);
}

/**
 * Revoke a grant (X6): status='revoked' + grantor epoch BUMP, and RE-STAMP the
 * grantor's other still-active grants at the new epoch (same txn) so they keep
 * passing the spawn-class epoch fence. Every touched row federates (the LWW
 * puts carry the new epoch — M19: the revocation lands on every machine).
 */
export async function revokePeerGrant(
  args: {
    workspaceId: string | null | undefined;
    potSlug: string;
    grantorGithubUserId: number;
    granteeKind: P2pGranteeKind;
    granteeRef: string;
  },
  sqlOverride?: OrgSql,
): Promise<GrantWriteResult> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: {
        code: 'workspace_unresolved',
        detail: 'P2P grant revocation refused: unresolvable workspace partition (WI-1564 — a stranded revocation is a security hole).',
      },
    };
  }
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql.begin(async (tx) => {
    const epoch = await bumpGrantorEpochTx(tx, ws, args.potSlug, args.grantorGithubUserId);
    // Re-stamp the grantor's OTHER active grants at the new epoch (see fn doc).
    await tx`
      UPDATE harness_shared.p2p_peer_grants
         SET grantor_epoch = ${epoch}, updated_at = now()
       WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
         AND grantor_github_user_id = ${args.grantorGithubUserId}
         AND status = 'active'
         AND NOT (grantee_kind = ${args.granteeKind} AND grantee_ref = ${args.granteeRef})`;
    return (await tx`
      UPDATE harness_shared.p2p_peer_grants
         SET status = 'revoked', grantor_epoch = ${epoch}, updated_at = now()
       WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
         AND grantor_github_user_id = ${args.grantorGithubUserId}
         AND grantee_kind = ${args.granteeKind} AND grantee_ref = ${args.granteeRef}
       RETURNING *`) as unknown as GrantRow[];
  })) as GrantRow[];
  if (rows.length === 0) {
    return { ok: false, refusal: { code: 'grant_not_found', detail: 'no such grant to revoke.' } };
  }
  return { ok: true, grant: rowToGrant(rows[0]!) };
}

export async function getPeerGrant(
  args: {
    workspaceId: string | null | undefined;
    potSlug: string;
    grantorGithubUserId: number;
    granteeKind: P2pGranteeKind;
    granteeRef: string;
  },
  sqlOverride?: OrgSql,
): Promise<PeerGrant | null> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) return null;
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT * FROM harness_shared.p2p_peer_grants
     WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
       AND grantor_github_user_id = ${args.grantorGithubUserId}
       AND grantee_kind = ${args.granteeKind} AND grantee_ref = ${args.granteeRef}
     LIMIT 1`) as unknown as GrantRow[];
  return rows[0] ? rowToGrant(rows[0]) : null;
}

export async function listPeerGrants(
  args: { workspaceId: string | null | undefined; potSlug: string; includeRevoked?: boolean },
  sqlOverride?: OrgSql,
): Promise<PeerGrant[]> {
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (args.includeRevoked
    ? await sql`
        SELECT * FROM harness_shared.p2p_peer_grants
         WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug}
         ORDER BY grantor_github_user_id, grantee_kind, grantee_ref`
    : await sql`
        SELECT * FROM harness_shared.p2p_peer_grants
         WHERE workspace_id = ${ws} AND harness_slug = ${args.potSlug} AND status = 'active'
         ORDER BY grantor_github_user_id, grantee_kind, grantee_ref`) as unknown as GrantRow[];
  return rows.map(rowToGrant);
}

export type P2pCapabilityCheck =
  | { ok: true; grant: PeerGrant }
  | {
      ok: false;
      /** Structured refusal — P-004's receipts carry this verbatim (no silent drops). */
      refusal: {
        code:
          | 'workspace_unresolved'
          | 'no_grant'
          | 'grant_revoked'
          | 'capability_missing'
          | 'device_excluded'
          | 'epoch_stale';
        /** The exact capability the requester lacks (D-004 receipt content). */
        missing: P2pCapability;
        detail: string;
      };
    };

/**
 * THE enforcement read (C6): does `grantee` hold `capability` from `grantor`
 * on THIS machine, right now?
 *
 * C6 (WI-1547 class): a DIRECT PG read on every call — no in-memory map, no
 * TTL cache, no read-through tier. A revocation that landed via federation one
 * statement ago is enforced on the very next check.
 *
 * X6: spawn-class capabilities (SPAWN_CLASS_CAPABILITIES) additionally refuse
 * a grant whose grantor_epoch trails the receiver's high-water — a replayed
 * pre-revocation grant can never re-authorize execution. Wall-clock is never
 * consulted.
 *
 * m14: pass `localDevicePubkey` (the enforcing device) so a per-device
 * exclusion refuses here, on the excluded device itself.
 */
export async function checkP2pCapability(
  args: {
    workspaceId: string | null | undefined;
    potSlug: string;
    grantorGithubUserId: number;
    granteeKind: P2pGranteeKind;
    granteeRef: string;
    capability: P2pCapability;
    /** The ENFORCING device's pubkey (m14 exclusions). */
    localDevicePubkey?: string | null;
  },
  sqlOverride?: OrgSql,
): Promise<P2pCapabilityCheck> {
  const cap = args.capability;
  const ws = resolveP2pGrantWorkspace(args.workspaceId);
  if (!ws) {
    return {
      ok: false,
      refusal: { code: 'workspace_unresolved', missing: cap, detail: 'unresolvable workspace partition (WI-1564); refusing closed.' },
    };
  }
  const sql = sqlOverride ?? getOrgPg().sql;
  // One round-trip: the grant row + the grantor's high-water, no cache (C6).
  const rows = (await sql`
    SELECT g.*, coalesce(e.high_water_epoch, 0) AS high_water
      FROM harness_shared.p2p_peer_grants g
      LEFT JOIN harness_shared.p2p_grantor_epochs e
        ON e.workspace_id = g.workspace_id AND e.harness_slug = g.harness_slug
       AND e.grantor_github_user_id = g.grantor_github_user_id
     WHERE g.workspace_id = ${ws} AND g.harness_slug = ${args.potSlug}
       AND g.grantor_github_user_id = ${args.grantorGithubUserId}
       AND g.grantee_kind = ${args.granteeKind} AND g.grantee_ref = ${args.granteeRef}
     LIMIT 1`) as unknown as (GrantRow & { high_water: string | number })[];
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      refusal: { code: 'no_grant', missing: cap, detail: `no grant from ${args.grantorGithubUserId} to ${args.granteeKind}:${args.granteeRef} in hive '${args.potSlug}'.` },
    };
  }
  const grant = rowToGrant(row);
  if (grant.status !== 'active') {
    return { ok: false, refusal: { code: 'grant_revoked', missing: cap, detail: `grant is revoked (epoch ${grant.grantorEpoch}).` } };
  }
  if (!grant.capabilities.includes(cap)) {
    return {
      ok: false,
      refusal: { code: 'capability_missing', missing: cap, detail: `grant carries [${grant.capabilities.join(', ')}]; '${cap}' is not among them.` },
    };
  }
  if (
    args.localDevicePubkey &&
    grant.excludedDevicePubkeys.includes(args.localDevicePubkey)
  ) {
    return {
      ok: false,
      refusal: { code: 'device_excluded', missing: cap, detail: 'this device is excluded from the grant (m14).' },
    };
  }
  if (SPAWN_CLASS_CAPABILITIES.has(cap)) {
    const highWater = Number(row.high_water);
    if (grant.grantorEpoch < highWater) {
      return {
        ok: false,
        refusal: {
          code: 'epoch_stale',
          missing: cap,
          detail: `grant epoch ${grant.grantorEpoch} trails the grantor's high-water ${highWater} (X6) — refusing spawn-class authorization.`,
        },
      };
    }
  }
  return { ok: true, grant };
}

/**
 * H9 production seam (WI-1937): the PUBLIC, non-transaction counterpart to
 * `currentGrantorEpochTx` — the offer-executor's epoch-fence read
 * (`OfferExecutorDeps.currentGrantorEpoch`). Mirrors the internal tx helper
 * exactly (same table, same fail-closed-to-0-when-never-bumped semantics);
 * kept as a thin wrapper rather than exporting the tx fn directly so callers
 * outside this module never need to thread a transaction just to READ the
 * epoch. `workspaceId` is resolved via the same one-helper invariant every
 * other grant-store read/write uses (`resolveP2pGrantWorkspace`) — an
 * unresolvable workspace throws (fail-closed: a silent 0 here would let a
 * stale/replayed claim slip the H9 fence rather than refuse it).
 */
export async function currentGrantorEpoch(
  workspaceId: string | null | undefined,
  potSlug: string,
  grantorGithubUserId: number,
  sqlOverride?: OrgSql,
): Promise<number> {
  const ws = resolveP2pGrantWorkspace(workspaceId);
  if (!ws) {
    throw new Error(
      "currentGrantorEpoch refused: unresolvable workspace partition (WI-1564) — the H9 epoch fence must fail-closed, never silently read epoch 0.",
    );
  }
  const hive = potSlug?.trim();
  if (!hive) {
    throw new Error('currentGrantorEpoch refused: potSlug (hive) is required.');
  }
  const sql = sqlOverride ?? getOrgPg().sql;
  return currentGrantorEpochTx(sql, ws, hive, grantorGithubUserId);
}

/**
 * X6 receiver side: advance the high-water epoch for a grantor after APPLYING
 * a federated grant op. Monotonic (GREATEST) — never lowers. Called by the
 * projection (projections/p2p-peer-grants.ts) with the op's verified epoch.
 */
export async function advanceGrantorHighWater(
  args: { workspaceId: string; potSlug: string; grantorGithubUserId: number; epoch: number },
  sqlOverride?: OrgSql,
): Promise<void> {
  if (!Number.isFinite(args.epoch) || args.epoch <= 0) return;
  const sql = sqlOverride ?? getOrgPg().sql;
  await sql`
    INSERT INTO harness_shared.p2p_grantor_epochs
      (workspace_id, harness_slug, grantor_github_user_id, high_water_epoch, updated_at)
    VALUES (${args.workspaceId}, ${args.potSlug}, ${args.grantorGithubUserId}, ${args.epoch}, now())
    ON CONFLICT (workspace_id, harness_slug, grantor_github_user_id)
    DO UPDATE SET high_water_epoch = GREATEST(harness_shared.p2p_grantor_epochs.high_water_epoch, EXCLUDED.high_water_epoch),
                  updated_at = now()`;
}
