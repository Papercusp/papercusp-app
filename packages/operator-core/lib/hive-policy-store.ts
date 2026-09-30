/**
 * hive-policy-store — PG read/write for harness_shared.pot_policy, the owner-signed
 * federated Hive policy record (shared-hive-owner-enforcement-2026-06-19 EN-1;
 * migration 317).
 *
 * A Hive has ONE signed policy document, scoped to its HOME harness slug (the
 * `harness_slug` column = the Hive's home_slug, which carries the Hive identity) so it
 * rides the Hive's peer-log via the existing hive_settings-style federation. This
 * module is the LOCAL read/raw-write path; the OWNER signing orchestration lives in
 * hive-policy-author.ts, and the member-side verify-on-apply lives in
 * sync/hyperbee/projections/hive-policy.ts.
 *
 * {@link getHivePolicy} is the canonical READER the enforcement phases consume (EN-2
 * rate-limit, EN-3 membership/moderation). It returns ALREADY-VERIFIED state: a forged
 * policy is rejected at projection-apply and never lands in PG, so anything this reader
 * returns is owner-signed + trusted — callers do NOT re-verify.
 *
 * Every fn takes an optional `sql` client so integration tests can pass a per-file
 * test schema.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { type HivePolicy, parseHivePolicyJson } from './hive-policy-schema';

/** The resolved, typed, owner-VERIFIED policy for a Hive (what EN-2/EN-3 read). */
export interface ResolvedHivePolicy {
  workspaceId: string;
  /** The Hive's home_slug (= the `harness_slug` scope column). */
  potHomeSlug: string;
  /** The typed policy document (parsed from the canonical `policy_json`). */
  policy: HivePolicy;
  /** Monotone version; bumps each owner author. Higher = newer (fed_hlc is the LWW key). */
  policyVersion: number;
  /** The Hive owner Ed25519 pubkey the policy was signed with (raw-32 base64). */
  ownerPubkey: string;
  /** Base64 Ed25519 signature over the canonical signed bytes. */
  signature: string;
  /** The canonical signed JSON string (the exact bytes the signature covers). */
  policyJson: string;
  /** The D-001 HLC LWW ordering key (null on a pre-314 row). */
  fedHlc: string | null;
  /** Epoch ms of the last local apply/author (machine-local; not federated). */
  updatedAt: number;
}

/** The raw federated columns of a hive_policy row (the signed subset). */
export interface HivePolicyRowInput {
  workspaceId: string;
  potHomeSlug: string;
  /** The canonical policy JSON TEXT (from canonicalizeHivePolicy). */
  policyJson: string;
  ownerPubkey: string;
  signature: string;
  policyVersion: number;
}

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

// The local read/write column set. author_pubkey/origin/fed_ts/fed_hlc are owned by
// the stamp + projection layers (NOT set by the local author), exactly like hive_settings.
const READ_COLS = `workspace_id, harness_slug, policy_json, owner_pubkey, signature, policy_version, fed_hlc, updated_at`;

interface HivePolicyDbRow {
  workspace_id: string;
  harness_slug: string;
  policy_json: string;
  owner_pubkey: string;
  signature: string;
  policy_version: number | string;
  fed_hlc: string | null;
  updated_at: string | number;
}

function rowToResolved(r: HivePolicyDbRow): ResolvedHivePolicy {
  return {
    workspaceId: r.workspace_id,
    potHomeSlug: r.harness_slug,
    policy: parseHivePolicyJson(r.policy_json),
    policyVersion: Number(r.policy_version),
    ownerPubkey: r.owner_pubkey,
    signature: r.signature,
    policyJson: r.policy_json,
    fedHlc: r.fed_hlc,
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Get a Hive's current owner-signed policy (null when no policy is set ⇒ permissive,
 * NO enforcement). The canonical reader for the enforcement phases — returns the typed,
 * already-verified policy via `.policy`. Callers must treat `null` / an absent field as
 * "no enforcement" so existing Hives stay unaffected (EN-1 build step 2).
 */
export async function getHivePolicy(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<ResolvedHivePolicy | null> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `SELECT ${READ_COLS} FROM harness_shared.pot_policy
      WHERE workspace_id = $1 AND harness_slug = $2 LIMIT 1`,
    [workspaceId, potHomeSlug],
  )) as unknown as HivePolicyDbRow[];
  return rows[0] ? rowToResolved(rows[0]) : null;
}

/**
 * EI-8685 (p2p-perf `merge.delta-tick` regression — deltaTick1Ms 0.137ms →
 * 33ms, +24340%): a short-TTL in-memory cache in front of {@link getHivePolicy}
 * for TIGHT hot-path callers (the merge pass — `boot.ts`'s `mergeOnePass`).
 *
 * `getHivePolicy` is a raw, uncached PG round-trip. `mergeOnePass` reads it
 * ONCE per non-idle merge pass — correct in isolation (the comment there says
 * "an idle / un-policed harness pays NOTHING", true for an IDLE pass, but a
 * pass with new ops always pays this query, EVEN when un-policed / the result
 * is null) — but a bg-host driving back-to-back ticks (P-013's whole point is
 * O(k) cheap ticks) now pays a full PG round-trip on EVERY one, which is
 * exactly the added-per-pass overhead the perf regression measures.
 *
 * A Hive policy changes RARELY (an explicit owner-signed author op) and
 * already propagates async over federation — federation lag is already
 * seconds+, so a `ttlMs` (default 2s) cache adds a bounded, negligible extra
 * staleness window in exchange for collapsing N merge-pass queries/sec down
 * to ~1 every `ttlMs`. Deliberately NOT applied inside {@link getHivePolicy}
 * itself: several OTHER callers (the policy-authoring write path / admin
 * routes wanting read-your-write) may need the uncached read, and this keeps
 * their behavior byte-for-byte unchanged — only a caller that explicitly asks
 * for the cached variant accepts the staleness tradeoff.
 */
const hivePolicyCache = new Map<string, { at: number; value: ResolvedHivePolicy | null }>();

export async function getHivePolicyCached(
  workspaceId: string,
  potHomeSlug: string,
  opts?: { ttlMs?: number; sql?: Sql },
): Promise<ResolvedHivePolicy | null> {
  const ttlMs = opts?.ttlMs ?? 2000;
  const key = `${workspaceId}::${potHomeSlug}`;
  const cached = hivePolicyCache.get(key);
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) return cached.value;
  const value = await getHivePolicy(workspaceId, potHomeSlug, opts?.sql);
  hivePolicyCache.set(key, { at: now, value });
  return value;
}

/** Test seam — forget every cached policy (and reset the cache entirely). */
export function _resetHivePolicyCacheForTests(): void {
  hivePolicyCache.clear();
}

/**
 * Raw LOCAL upsert of a signed policy row. Sets only the signed/federated subset +
 * created_at/updated_at; the stamp_local_federated_write trigger (migration 317) owns
 * fed_ts/fed_hlc/origin so the change federates. Used by hive-policy-author.ts AFTER
 * it has signed; NOT a public authoring entry point (no gate, no signature here) — the
 * gate + signature live in hive-policy-author.ts / the API route.
 */
export async function upsertHivePolicyRow(
  input: HivePolicyRowInput,
  sql?: Sql,
): Promise<ResolvedHivePolicy> {
  const s = pg(sql);
  const now = Date.now();
  const rows = (await s.unsafe(
    `INSERT INTO harness_shared.pot_policy
       (workspace_id, harness_slug, policy_json, owner_pubkey, signature, policy_version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (workspace_id, harness_slug) DO UPDATE SET
       policy_json    = EXCLUDED.policy_json,
       owner_pubkey   = EXCLUDED.owner_pubkey,
       signature      = EXCLUDED.signature,
       policy_version = EXCLUDED.policy_version,
       updated_at     = $7
     RETURNING ${READ_COLS}`,
    [
      input.workspaceId,
      input.potHomeSlug,
      input.policyJson,
      input.ownerPubkey,
      input.signature,
      input.policyVersion,
      now,
    ],
  )) as unknown as HivePolicyDbRow[];
  return rowToResolved(rows[0]!);
}

/** Delete a Hive's policy (idempotent). The delete federates (capture trigger). */
export async function deleteHivePolicy(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
): Promise<boolean> {
  const s = pg(sql);
  const rows = (await s.unsafe(
    `DELETE FROM harness_shared.pot_policy
      WHERE workspace_id = $1 AND harness_slug = $2 RETURNING harness_slug`,
    [workspaceId, potHomeSlug],
  )) as unknown as Array<{ harness_slug: string }>;
  return rows.length > 0;
}
