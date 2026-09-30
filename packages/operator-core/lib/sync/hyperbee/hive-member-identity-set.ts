/**
 * hive-member-identity-set — the cached hive-member DEVICE-PUBKEY set for the WI-259
 * membership-aware cross-member content federation (plan shared-hive-member-content-
 * federation-2026-06-20, P-003).
 *
 * The admission gate (P-001) and the projection apply guard (P-002) both answer the
 * same question on the per-op apply path: "is this op's AUTHOR IDENTITY a member of
 * THIS hive?" (D-002 — by identity ∈ the FEDERATED hive_members, not by a per-workspace
 * harness_registry slug lookup). That runs on every applied op, so it must be cheap:
 * this is a per-(workspace, hive-home) in-memory cache over the hive_members device-pubkey
 * set, with
 *   - EXPLICIT invalidation on a hive_members projection change (join/leave) — the fast
 *     path; wire `invalidateHiveMemberDeviceSet` into the onMemberApplied hook (shared
 *     with P-004's PendingMembershipContent drain — su-ee7e9's review refinement #1), and
 *   - a short TTL BACKSTOP so a missed invalidation self-heals instead of going stale
 *     forever (a stale set would silently drop a just-joined member's content, or keep
 *     applying a just-left member's — both correctness bugs).
 *
 * Device-pubkey (base64) is the identity grain: it's what the read-admission D-004 binding
 * check verifies on the wire and what hive_members.device_attestations carries, so the
 * guard can compare an op's verified author device_pubkey against this set directly.
 *
 * Decoupled from the C-001 re-key (which proves its cut at the epoch-KEY level): this is
 * the content-plane membership check, not the crypto cut.
 */
import type { Sql } from 'postgres';
// EI-18777176681958978 (found by the branded-scope typecheck, NOT in the filing's site list):
// this module's `potHomeSlug` comes from a content projection's opts and from the scope-repo
// serve gate, so its provenance is not provable here — resolve rather than certify
// (idempotent on an already-federated scope). Reading a joiner's LOCAL handle yields an
// EMPTY member device set, which the member-content guard reads as "author is not a member".
import { listHiveMembersForLocalPot } from '../../federated-pot-scope';

/** Backstop TTL (ms). The join/leave invalidation is the fast path; this only bounds the
 *  staleness window if an invalidation is ever missed. Kept small — the lookup is cheap. */
export const MEMBER_SET_TTL_MS = 30_000;

interface CacheEntry {
  set: ReadonlySet<string>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(workspaceId: string, potHomeSlug: string): string {
  // NUL separator — neither a workspace id nor a slug can contain it, so no key collision.
  return `${workspaceId}\x00${potHomeSlug}`;
}

/** Every device pubkey (base64) bound to a CURRENT member of the hive, deduped. */
async function loadMemberDeviceSet(
  workspaceId: string,
  potHomeSlug: string,
  sql: Sql | undefined,
  loadMembers: typeof listHiveMembersForLocalPot,
): Promise<Set<string>> {
  const members = await loadMembers(workspaceId, potHomeSlug, sql);
  const set = new Set<string>();
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      if (a && typeof a.device_pubkey === 'string' && a.device_pubkey.length > 0) {
        set.add(a.device_pubkey);
      }
    }
  }
  return set;
}

export interface MemberDeviceSetDeps {
  /** Injectable for hermetic tests (default: the real federated hive_members read). */
  loadMembers?: typeof listHiveMembersForLocalPot;
  /** Injectable clock for deterministic TTL tests (default: Date.now). */
  now?: () => number;
}

/**
 * The current hive-member device-pubkey set for (workspace, hive-home), cached.
 * Returns a ReadonlySet — callers do `set.has(opAuthorDevicePubkey)`.
 */
export async function resolveHiveMemberDeviceSet(
  workspaceId: string,
  potHomeSlug: string,
  sql?: Sql,
  deps: MemberDeviceSetDeps = {},
): Promise<ReadonlySet<string>> {
  const { loadMembers = listHiveMembersForLocalPot, now = Date.now } = deps;
  const key = cacheKey(workspaceId, potHomeSlug);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) return hit.set;

  const set = await loadMemberDeviceSet(workspaceId, potHomeSlug, sql, loadMembers);
  cache.set(key, { set, expiresAt: now() + MEMBER_SET_TTL_MS });
  return set;
}

/**
 * WI-3641: resolve the CURRENT hive member owning `devicePubkey`, or `null` if
 * no current member's `device_attestations` carries it. Uncached (unlike
 * {@link resolveHiveMemberDeviceSet}) — this backs an authorization decision
 * (scope-repo serve gating) that should see a revocation/attestation change
 * immediately, not up to `MEMBER_SET_TTL_MS` stale; call volume is bounded by
 * inbound scope-repo fetch requests, not the hot per-op apply path the cached
 * set exists for.
 */
export async function resolveGithubUserIdForDevicePubkey(
  workspaceId: string,
  potHomeSlug: string,
  devicePubkey: string,
  sql?: Sql,
  deps: Pick<MemberDeviceSetDeps, 'loadMembers'> = {},
): Promise<number | null> {
  const { loadMembers = listHiveMembersForLocalPot } = deps;
  const members = await loadMembers(workspaceId, potHomeSlug, sql);
  for (const m of members) {
    for (const a of m.deviceAttestations ?? []) {
      if (a && typeof a.device_pubkey === 'string' && a.device_pubkey === devicePubkey) {
        return m.githubUserId;
      }
    }
  }
  return null;
}

/**
 * Drop the cached set for a hive. Call this from the onMemberApplied hook on EVERY
 * hive_members projection change (a join/leave) so the next apply re-reads a fresh set.
 * Idempotent + cheap (a Map delete); safe to call on every membership op.
 */
export function invalidateHiveMemberDeviceSet(workspaceId: string, potHomeSlug: string): void {
  cache.delete(cacheKey(workspaceId, potHomeSlug));
}

/** Test seam: wipe the whole cache between cases. NOT for production use. */
export function _clearHiveMemberDeviceSetCacheForTest(): void {
  cache.clear();
}
