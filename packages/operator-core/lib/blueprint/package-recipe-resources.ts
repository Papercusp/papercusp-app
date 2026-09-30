/** Exact recipe-row ownership for portable identity package installs.
 * The existing resource journal owns dependency/retry state; this adapter owns
 * only the code_recipes row and never overwrites an organic or edited recipe. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { packageContentHash, type ResolvedPackageInput } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { getRecipe, upsertRecipe, type CodeRecipeRow } from '../code-recipes-store';
import { packageResourceKey, preparePackageResource,
  type PackageExternalResource, type PackageResourceAddress, type PackageResourceDriver,
  type PackageResourceReceipt } from './package-resource-receipts';

type RecipePackageValue = {
  id: string;
  title: string;
  description: string;
  script: string;
  toolsUsed: string[];
  tags: string[];
};

function recipeMaterial(value: RecipePackageValue | CodeRecipeRow): Record<string, unknown> {
  return {
    id: value.id, title: value.title, description: value.description, script: value.script,
    toolsUsed: [...value.toolsUsed].sort(), tags: [...value.tags].sort(),
    ...('bindingSchema' in value ? {
      bindingSchema: value.bindingSchema, capabilityManifest: value.capabilityManifest,
      status: value.status, promotedTool: value.promotedTool, mergedInto: value.mergedInto,
    } : {
      bindingSchema: null, capabilityManifest: null,
      status: 'active', promotedTool: null, mergedInto: null,
    }),
  };
}

export function recipePackageInstalledHash(value: RecipePackageValue | CodeRecipeRow): string {
  return createHash('sha256').update(canonicalJson(recipeMaterial(value))).digest('hex');
}

/** The shape readRecipeDir emits: description may be empty, toolsUsed and tags
 * are always arrays. Compile runs this too, so a malformed pin is refused at
 * preflight instead of at the wearer's launch. */
export function recipeValue(pin: ResolvedPackageInput): RecipePackageValue {
  const value = pin.value as Partial<RecipePackageValue> | null;
  if (pin.packageKind !== 'recipe' || !value ||
      ![value.id, value.title, value.script].every((entry) => typeof entry === 'string' && entry.trim()) ||
      typeof value.description !== 'string' ||
      !Array.isArray(value.toolsUsed) || !value.toolsUsed.every((entry) => typeof entry === 'string') ||
      !Array.isArray(value.tags) || !value.tags.every((entry) => typeof entry === 'string')) {
    throw new Error('recipe resource requires an exact parsed recipe package');
  }
  const { contentHash, ...content } = pin;
  if (packageContentHash(content) !== contentHash || value.id !== pin.ref) {
    throw new Error('package-hash-mismatch: recipe resource pin is not intact');
  }
  return value as RecipePackageValue;
}

export function planRecipePackageResource(pin: ResolvedPackageInput, workspaceId: string): {
  address: PackageResourceAddress;
  value: RecipePackageValue;
  resourceKey: string;
} {
  if (!workspaceId.trim()) throw new Error('recipe resource requires a workspace');
  const value = recipeValue(pin);
  const address: PackageResourceAddress = {
    workspaceId, memoryScope: 'global:code-recipes', packageKind: pin.packageKind,
    packageRef: pin.ref, packageVersion: pin.revision, packageHash: pin.contentHash,
    resourceKind: 'code-recipe', itemKey: value.id, installedHash: recipePackageInstalledHash(value),
  };
  return { address, value, resourceKey: packageResourceKey(address) };
}

/** A code_recipes write is one PG transaction, so the journal's locked intent
 * is its cancellation fence. There is no deferred backend job after create()
 * returns; a crash leaves either no row or a row recoverable by created_by.
 * A null value is a release-only driver: cleanup replays from the durable
 * address alone and can never create a row. */
export function packageRecipeDriver(
  sql: postgres.Sql,
  address: PackageResourceAddress,
  value: RecipePackageValue | null,
): PackageResourceDriver {
  const expected = address.installedHash;
  const read = async (writeKey: string): Promise<PackageExternalResource[]> => {
    const row = await getRecipe(sql, address.itemKey);
    if (!row) return [];
    const fingerprint = recipePackageInstalledHash(row);
    const owner = `blueprint-package-resource:${writeKey}`;
    return [{ id: row.id, fingerprint,
      ...(row.createdBy === owner ? {} : { owned: false }),
      ...(fingerprint === expected ? {} : { disposition: 'changed' as const }) }];
  };
  return {
    recover: read,
    async create(writeKey) {
      if (!value) throw new Error('recipe release driver cannot create package resources');
      const prior = await read(writeKey);
      if (prior.length) {
        if (prior[0]!.disposition) throw new Error('package-pin-conflict: registered recipe differs; explicit migration is required');
        return prior;
      }
      const createdBy = `blueprint-package-resource:${writeKey}`;
      try {
        const row = await upsertRecipe(sql, { ...value, potSlug: null, authorRole: 'blueprint-bundle',
          bindingSchema: null, capabilityManifest: null, createdBy, createOnly: true });
        return [{ id: row.id, fingerprint: recipePackageInstalledHash(row) }];
      } catch (error) {
        // A concurrent exact insert is safe to depend on but is not ours.
        const concurrent = await read(writeKey);
        if (concurrent.length && !concurrent[0]!.disposition) return concurrent;
        throw error;
      }
    },
    async cancel() {},
    async removeIfUnchanged(resource) {
      return sql.begin(async (tx) => {
        const [receipt] = await tx<{ write_key: string }[]>`SELECT write_key
          FROM harness_shared.blueprint_package_resources
          WHERE workspace_id = ${address.workspaceId} AND resource_key = ${packageResourceKey(address)}`;
        if (!receipt) throw new Error('recipe package ownership receipt is missing');
        // Recheck the committed row after any in-flight editor finishes, and
        // keep it locked through deletion so a later edit cannot be erased.
        await tx`SELECT id FROM harness_shared.code_recipes WHERE id = ${resource.id} FOR UPDATE`;
        const row = await getRecipe(tx as unknown as postgres.Sql, resource.id);
        if (!row) return 'absent';
        if (recipePackageInstalledHash(row) !== resource.fingerprint ||
            row.createdBy !== `blueprint-package-resource:${receipt.write_key}`) return 'changed';
        const removed = await tx`DELETE FROM harness_shared.code_recipes
          WHERE id = ${resource.id} AND created_by = ${row.createdBy} RETURNING id`;
        return removed.length ? 'removed' : 'changed';
      });
    },
  };
}

export async function prepareRecipePackageResource(
  sql: postgres.Sql,
  input: { pin: ResolvedPackageInput; workspaceId: string; dependentId: string },
): Promise<PackageResourceReceipt> {
  const planned = planRecipePackageResource(input.pin, input.workspaceId);
  const driver = packageRecipeDriver(sql, planned.address, planned.value);
  return preparePackageResource(sql, planned.address, input.dependentId, {
    ...driver,
    async recover(writeKey) {
      const refs = await driver.recover(writeKey);
      // Admission and cleanup share recovery, but only admission refuses an
      // edited row. Cleanup still needs its changed disposition to preserve it.
      if (refs.some((ref) => ref.disposition === 'changed')) {
        throw new Error('package-pin-conflict: registered recipe differs; explicit migration is required');
      }
      return refs;
    },
  });
}
