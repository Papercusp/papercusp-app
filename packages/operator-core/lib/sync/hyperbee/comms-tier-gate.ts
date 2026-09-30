/**
 * comms-tier-gate — resolve a federated coord op's author to their effective
 * COMMS tier, receiver-side (cross-machine-coord-parity-and-trust-2026-07-01
 * P-013, D-003).
 *
 * Identity chain (never envelope fields): the op's provenance authorPubkey is
 * the VERIFIED source-log device → `hive_members` attestation → the stable
 * numeric github_user_id → comms-trust resolution (local override →
 * owner-signed policy default → conservative fallback). Both legs TTL-cached —
 * this sits on the merge hot path.
 *
 * Scope: enforcement only applies when the projection is HIVE-BOUND
 * (potHomeSlug present) — the same scoping as the WI-259 member-content gate.
 * A non-hive topology resolves 'steer' (full passthrough — today's behavior).
 * An un-mapped device (no attestation match — shouldn't survive the member
 * gate) resolves the conservative fallback, never a grant.
 */

// EI-18777176681958978: the gate's `potHomeSlug` arrives from a content projection's opts
// several hops up (coord-message / bee-claim-spec → resolveAuthorCommsTier), so its
// provenance is not provable HERE. Resolve rather than certify: idempotent when it is
// already the federated scope, and the fix when it is a joiner's local handle. Reading the
// wrong scope makes the device→user map EMPTY, which fails every author to
// FALLBACK_COMMS_TIER — silently quarantining legitimate remote coord messages.
import { listHiveMembersForLocalPot } from '../../federated-pot-scope';
import {
  effectiveCommsTier,
  FALLBACK_COMMS_TIER,
  type CommsTier,
} from '../../trust/comms-trust';

const CACHE_TTL_MS = Number(process.env.PAPERCUSP_COMMS_TIER_CACHE_MS) || 30_000;

interface DeviceMapCacheEntry {
  at: number;
  /** device_pubkey → github_user_id */
  map: Map<string, number>;
}
const deviceMaps = new Map<string, DeviceMapCacheEntry>(); // key ws::home

interface TierCacheEntry {
  at: number;
  tier: CommsTier;
}
const tiers = new Map<string, TierCacheEntry>(); // key ws::home::user

export interface CommsTierGateDeps {
  /** Takes a LOCAL pot handle; the default resolves the federated read scope itself. */
  listHiveMembers: typeof listHiveMembersForLocalPot;
  effectiveCommsTier: typeof effectiveCommsTier;
}
let deps: CommsTierGateDeps = {
  listHiveMembers: listHiveMembersForLocalPot,
  effectiveCommsTier,
};

async function deviceToUser(
  workspaceId: string,
  potHomeSlug: string,
  devicePubkey: string,
  now: number,
): Promise<number | null> {
  const key = `${workspaceId}::${potHomeSlug}`;
  let entry = deviceMaps.get(key);
  if (!entry || now - entry.at >= CACHE_TTL_MS) {
    const map = new Map<string, number>();
    const members = await deps.listHiveMembers(workspaceId, potHomeSlug);
    for (const m of members) {
      for (const a of m.deviceAttestations ?? []) {
        if (a?.device_pubkey) map.set(a.device_pubkey, m.githubUserId);
      }
    }
    entry = { at: now, map };
    deviceMaps.set(key, entry);
  }
  return entry.map.get(devicePubkey) ?? null;
}

/**
 * The author device's effective comms tier toward THIS owner. Fail-soft to the
 * conservative fallback — the merge path must never throw on a tier lookup.
 */
export async function resolveAuthorCommsTier(input: {
  workspaceId: string;
  potHomeSlug: string;
  devicePubkey: string;
  nowMs?: number;
}): Promise<{ tier: CommsTier; githubUserId: number | null }> {
  const now = input.nowMs ?? Date.now();
  try {
    const user = await deviceToUser(input.workspaceId, input.potHomeSlug, input.devicePubkey, now);
    if (user == null) return { tier: FALLBACK_COMMS_TIER, githubUserId: null };
    const tkey = `${input.workspaceId}::${input.potHomeSlug}::${user}`;
    const cached = tiers.get(tkey);
    if (cached && now - cached.at < CACHE_TTL_MS) return { tier: cached.tier, githubUserId: user };
    const resolved = await deps.effectiveCommsTier({
      workspaceId: input.workspaceId,
      potHomeSlug: input.potHomeSlug,
      githubUserId: user,
      nowMs: now,
    });
    tiers.set(tkey, { at: now, tier: resolved.tier });
    return { tier: resolved.tier, githubUserId: user };
  } catch {
    return { tier: FALLBACK_COMMS_TIER, githubUserId: null };
  }
}

/** Test seams. */
export function __setCommsTierGateDeps(d: Partial<CommsTierGateDeps>): void {
  deps = { ...deps, ...d };
}
export function __resetCommsTierGate(): void {
  deps = { listHiveMembers: listHiveMembersForLocalPot, effectiveCommsTier };
  deviceMaps.clear();
  tiers.clear();
}
