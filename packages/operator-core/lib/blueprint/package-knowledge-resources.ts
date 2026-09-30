/** Resource preparation/compensation for the existing blueprint provisioner.
 * This is not an activation host: callers promote in their existing transaction. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { ResolvedPackageInput } from '@papercusp/orchestrator/blueprint';
import { getMemoryBackend, type MemoryBackend } from '../memory/backend';
import { filterByDomains, filterByShapes, type AppliesTo } from '../knowledge-packs/pack-format';
import { knowledgePackFromPin, packageDocDriver, prepareKnowledgeDocResources } from './package-doc-resources';
import { packItemMemoryWrite, knowledgePackMemoryScope, type KnowledgePackMemoryTarget } from '../knowledge-packs/seed';
import { packageMemoryDriver } from './package-memory-driver';
import { packageRecipeDriver } from './package-recipe-resources';
import { packageProviderBindingDriver, PROVIDER_BINDING_RESOURCE_KIND } from './package-provider-binding-resources';
import { packageResourceKey, preparePackageResource, releasePackageResource,
  beginPackageInstallationRelease, finishPackageInstallationRelease,
  recordPackageInstallationReleaseFailure, type PackageInstallationReleaseOptions,
  type PackageResourceAddress, type PackageResourceReceipt } from './package-resource-receipts';

export interface KnowledgePackageResourceInput {
  pin: ResolvedPackageInput;
  workspaceId: string;
  harnessSlug: string;
  memoryTarget: KnowledgePackMemoryTarget;
  shapes: readonly AppliesTo[];
  domains: readonly string[];
}

/** Pure expected write set, reused at the atomic activation boundary. */
export function planKnowledgePackageResources(input: KnowledgePackageResourceInput) {
  const contentHash = input.pin.contentHash;
  const pack = knowledgePackFromPin(input.pin);
  const scope = knowledgePackMemoryScope(input.memoryTarget);
  const selected = filterByDomains(filterByShapes(pack.items, input.shapes), input.domains);
  return selected.map((item) => {
    const write = packItemMemoryWrite({ workspaceId: input.workspaceId, potSlug: input.harnessSlug,
      memoryTarget: input.memoryTarget, pack, item, createdBy: 'blueprint-package:' + contentHash });
    const address: PackageResourceAddress = { workspaceId: input.workspaceId, memoryScope: scope,
      packageKind: input.pin.packageKind, packageRef: input.pin.ref, packageVersion: input.pin.revision,
      packageHash: contentHash, resourceKind: 'memory', itemKey: item.id,
      installedHash: createHash('sha256').update(write.text).digest('hex') };
    const resourceKey = packageResourceKey(address);
    return { address, resourceKey, text: write.text, options: { ...write.options,
      metadata: { ...write.options.metadata, identity_package_resource: resourceKey,
        identity_package_hash: contentHash } } };
  });
}

export async function prepareKnowledgePackageResources(sql: Sql, input: KnowledgePackageResourceInput & {
  dependentId: string;
}, backend: MemoryBackend = getMemoryBackend()): Promise<PackageResourceReceipt[]> {
  const writes = planKnowledgePackageResources(input);
  // Refuse an unsupported backend before writing even the first ownership row.
  if (!backend.managedWrites) throw new Error(`memory backend ${backend.name} does not support fenced package resources`);
  const receipts: PackageResourceReceipt[] = [];
  // Bounded sequential preparation; every completed or uncertain step is already
  // journaled. On a failure the lifecycle caller compensates the whole dependent.
  for (const { address, text, options } of writes) {
    receipts.push(await preparePackageResource(sql, address, input.dependentId, packageMemoryDriver(backend, text, options)));
  }
  // P-009 / D-022: the same pin's doc items, as package-addressed doc parts.
  receipts.push(...await prepareKnowledgeDocResources(sql, { pin: input.pin, workspaceId: input.workspaceId,
    harnessSlug: input.harnessSlug, dependentId: input.dependentId }));
  return receipts;
}

/** Replays from durable addresses, not today's pack contents or the current
 * filesystem release. Cleanup can therefore resume after upgrade/restart.
 * Covers every journaled kind (memory and code-recipe); a member of any other
 * kind stays held, and the installation records it as cleanup residue. */
export async function releasePackageInstallation(
  sql: Sql, workspaceId: string, dependentId: string, backend?: MemoryBackend,
  options: PackageInstallationReleaseOptions = {},
): Promise<PackageResourceReceipt[]> {
  if (!await beginPackageInstallationRelease(sql, workspaceId, dependentId, options)) return [];
  try {
    const rows = await sql<Array<{
      memory_scope: string; package_kind: string; package_ref: string; package_version: string;
      package_hash: string; resource_kind: string; item_key: string; installed_hash: string;
    }>>`SELECT r.memory_scope, r.package_kind, r.package_ref, r.package_version,
        r.package_hash, r.resource_kind, r.item_key, r.installed_hash
      FROM harness_shared.blueprint_package_resources r
      JOIN harness_shared.blueprint_package_dependents d USING (workspace_id, resource_key)
      WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}
        AND r.resource_kind IN ('memory', 'code-recipe', 'doc-part', ${PROVIDER_BINDING_RESOURCE_KIND})
      ORDER BY r.resource_key`;
    const receipts: PackageResourceReceipt[] = [];
    for (const row of rows) {
      const address: PackageResourceAddress = { workspaceId, memoryScope: row.memory_scope,
        packageKind: row.package_kind, packageRef: row.package_ref, packageVersion: row.package_version,
        packageHash: row.package_hash, resourceKind: row.resource_kind, itemKey: row.item_key,
        installedHash: row.installed_hash };
      if (row.resource_kind === 'code-recipe') {
        const receipt = await releasePackageResource(sql, address, dependentId, packageRecipeDriver(sql, address, null));
        if (receipt) receipts.push(receipt);
        continue;
      }
      if (row.resource_kind === PROVIDER_BINDING_RESOURCE_KIND) {
        // P-014: a re-pointed or foreign pot binding is preserved, never deleted.
        const receipt = await releasePackageResource(sql, address, dependentId, packageProviderBindingDriver(sql, address, null));
        if (receipt) receipts.push(receipt);
        continue;
      }
      if (row.resource_kind === 'doc-part') {
        // An edited part is re-owned and preserved by the driver, never deleted.
        const receipt = await releasePackageResource(sql, address, dependentId, packageDocDriver(sql, address, null));
        if (receipt) receipts.push(receipt);
        continue;
      }
      // Backend initialization can throw too. Keep it after the release fence
      // and inside the durable error boundary; empty installs need no backend.
      backend ??= getMemoryBackend();
      const receipt = await releasePackageResource(sql, address, dependentId,
        packageMemoryDriver(backend, '', { scope: row.memory_scope }));
      if (receipt) receipts.push(receipt);
    }
    await finishPackageInstallationRelease(sql, workspaceId, dependentId);
    return receipts;
  } catch (error) {
    try { await recordPackageInstallationReleaseFailure(sql, workspaceId, dependentId, error); }
    catch (recordError) {
      throw new AggregateError([error, recordError], 'package cleanup failed and its diagnostic could not be persisted', { cause: error });
    }
    throw error;
  }
}
