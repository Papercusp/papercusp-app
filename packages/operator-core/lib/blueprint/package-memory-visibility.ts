/** P-007 / D-021: recall eligibility for identity-installed pack memories.
 * P-006 writes them archived (invisible to every recall leg). Here a wearer's
 * applied exact-version resource keys re-admit exactly those rows, before
 * ranking and inside the pools the caller already searches. Ordinary memories
 * are never filtered by this module. */
import type { Sql } from 'postgres';
import type { MemoryEntry, SearchOptions } from '@papercusp/memory';
import { PACK_MEMORY_SOURCE } from '../knowledge-packs/pack-format';

/** Payload key P-006 stamps on every package-owned memory row. */
export const IDENTITY_PACKAGE_RESOURCE = 'identity_package_resource';
/** Payload key a reviewed promotion stamps (D-021). */
export const IDENTITY_PACKAGE_PROMOTION = 'identity_package_promotion';
/** Orders the wearer's pinned pack rows above other pack rows. Pack rows keep
 * yielding to organic rows at render time, so this never outranks them. */
export const PINNED_PACK_BOOST = 1.15;

/** The resource keys whose archived rows this wearer may recall: applied
 * installations of this owner, applied dependents, ready memory resources.
 * The key encodes package ref, exact version and content hash, so matching
 * it IS the exact-version selection. */
export async function resolveWearerPackageResources(sql: Sql, input: {
  workspaceId: string; ownerId: string;
}): Promise<ReadonlySet<string>> {
  return new Set(await appliedResourceKeys(sql, input, 'memory'));
}

/** P-009 / D-022: the doc-part keys of this owner's APPLIED installations —
 * its `package:<key>` guide tokens. The same exact-version selection as
 * memory, so a non-wearer holds no token and can reach no part. Sorted. */
export async function resolveWearerPackageDocKeys(sql: Sql, input: {
  workspaceId: string; ownerId: string;
}): Promise<string[]> {
  return appliedResourceKeys(sql, input, 'doc-part');
}

async function appliedResourceKeys(sql: Sql, input: { workspaceId: string; ownerId: string },
  resourceKind: 'memory' | 'doc-part'): Promise<string[]> {
  if (!input.workspaceId.trim() || !input.ownerId.trim()) return [];
  const rows = await sql<Array<{ resource_key: string }>>`
    SELECT DISTINCT d.resource_key
      FROM harness_shared.blueprint_package_installations i
      JOIN harness_shared.blueprint_package_dependents d USING (workspace_id, dependent_id)
      JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
     WHERE i.workspace_id = ${input.workspaceId} AND i.owner_id = ${input.ownerId}
       AND i.phase = 'applied' AND d.phase = 'applied'
       AND r.phase = 'ready' AND r.resource_kind = ${resourceKind}
     ORDER BY d.resource_key`;
  return rows.map((row) => row.resource_key);
}

/** Fail closed: a resolver error makes no pack row eligible and leaves
 * ordinary recall untouched. */
export async function wearerPackageResourcesOrEmpty(
  sql: Sql, input: { workspaceId: string; ownerId: string | null | undefined },
): Promise<ReadonlySet<string>> {
  if (!input.ownerId) return new Set();
  try {
    return await resolveWearerPackageResources(sql, { workspaceId: input.workspaceId, ownerId: input.ownerId });
  } catch (error) {
    console.warn(`[package-visibility] wearer resources unavailable, pack rows stay hidden: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

/** The SearchOptions fragment that admits the wearer's pinned archived rows. */
export function packageRecallEligibility(pinned: ReadonlySet<string>): Pick<SearchOptions, 'archivedEligibility'> {
  return pinned.size > 0 ? { archivedEligibility: { key: IDENTITY_PACKAGE_RESOURCE, values: [...pinned].sort() } } : {};
}

interface PackIdentity { packId: string; packVersion: string | null; itemId: string; resource: string | null }

function packIdentity(hit: MemoryEntry): PackIdentity | null {
  const m = hit.metadata ?? {};
  if (m.source !== PACK_MEMORY_SOURCE || typeof m.pack_id !== 'string' || typeof m.pack_item_id !== 'string') return null;
  return { packId: m.pack_id, itemId: m.pack_item_id,
    packVersion: typeof m.pack_version === 'string' ? m.pack_version : null,
    resource: typeof m[IDENTITY_PACKAGE_RESOURCE] === 'string' ? m[IDENTITY_PACKAGE_RESOURCE] as string : null };
}

/** True for any row an identity package installed (pinned or promoted). */
export function isIdentityPackageHit(hit: MemoryEntry): boolean {
  return typeof hit.metadata?.[IDENTITY_PACKAGE_RESOURCE] === 'string';
}

/**
 * Within eligible hits: dedupe pack rows by (pack_id, pack_item_id), keeping
 * the wearer's pinned exact version over promoted or seeded copies and then
 * the higher score; boost pinned rows; stamp provenance. Rows without pack
 * provenance pass through unchanged, and one hit is kept per ITEM, never per
 * pack. Returns entries re-sorted by score, preserving input order on ties.
 */
export function shapeIdentityPackageHits(hits: readonly MemoryEntry[], pinned: ReadonlySet<string>): MemoryEntry[] {
  const best = new Map<string, { hit: MemoryEntry; pinned: boolean; score: number }>();
  for (const hit of hits) {
    const id = packIdentity(hit);
    if (!id) continue;
    const key = JSON.stringify([id.packId, id.itemId]);
    const isPinned = id.resource !== null && pinned.has(id.resource);
    const score = hit.score ?? 0;
    const prior = best.get(key);
    if (!prior || (isPinned && !prior.pinned) || (isPinned === prior.pinned && score > prior.score)) {
      best.set(key, { hit, pinned: isPinned, score });
    }
  }
  const kept = new Set([...best.values()].map((entry) => entry.hit));
  const shaped = hits.flatMap((hit, index) => {
    const id = packIdentity(hit);
    if (!id) return [{ hit, index }];
    if (!kept.has(hit)) return [];
    const isPinned = id.resource !== null && pinned.has(id.resource);
    return [{ index, hit: { ...hit,
      ...(isPinned && hit.score !== undefined ? { score: hit.score * PINNED_PACK_BOOST } : {}),
      metadata: { ...hit.metadata, identity_package: { pack_id: id.packId, pack_version: id.packVersion,
        pack_item_id: id.itemId, pinned: isPinned } } } }];
  });
  return shaped.sort((a, b) => (b.hit.score ?? 0) - (a.hit.score ?? 0) || a.index - b.index).map(({ hit }) => hit);
}

/**
 * Explicit reviewed promotion to pool-wide visibility (D-021). One UPDATE
 * flips the row active and stamps the review. The payload change means a later
 * uninstall sees the row as changed and detaches it instead of deleting it.
 */
export async function promoteIdentityPackageMemory(sql: Sql, input: {
  memoryId: string; reviewedBy: string; reason: string;
}): Promise<boolean> {
  if (!input.reviewedBy.trim() || !input.reason.trim()) {
    throw new Error('identity package promotion requires a reviewer and a reason');
  }
  const promotion = { reviewed_by: input.reviewedBy, reviewed_at: new Date().toISOString(), reason: input.reason };
  const rows = await sql`
    UPDATE harness_shared.memory_canonical
       SET state = 'active', updated_at = now(),
           payload = payload || jsonb_build_object(${IDENTITY_PACKAGE_PROMOTION}::text, ${sql.json(promotion)}::jsonb)
     WHERE id = ${input.memoryId} AND state = 'archived' AND payload ? ${IDENTITY_PACKAGE_RESOURCE}
     RETURNING id`;
  return rows.length === 1;
}
