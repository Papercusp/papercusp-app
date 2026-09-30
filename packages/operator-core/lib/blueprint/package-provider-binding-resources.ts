/** Pot provider bindings as package resources (portable identities P-014, D-034).
 * The resource journal owns dependency/retry state; this adapter owns only the
 * pot_capability_class_bindings row and never re-points or deletes a binding
 * another owner wrote or changed. */
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  bindCapabilityProviderToPot,
  deletePotCapabilityProviderBinding,
  parseCapabilityClassRef,
  type CapabilityProviderKind,
} from '../capability-class-registry-store';
import { packageResourceKey, preparePackageResource,
  type PackageExternalResource, type PackageResourceAddress, type PackageResourceDriver,
  type PackageResourceReceipt } from './package-resource-receipts';

export const PROVIDER_BINDING_RESOURCE_KIND = 'provider-binding';
const PROVIDER_KINDS: readonly CapabilityProviderKind[] = ['tool', 'recipe', 'operation'];

export interface PotProviderBinding {
  potSlug: string;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  providerKind: CapabilityProviderKind;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactClassRef(classRef: string): { classId: string; classVersion: string; classRef: string } {
  const parsed = parseCapabilityClassRef(classRef);
  if (!parsed) throw new Error('provider binding resource requires an exact class ref: ' + classRef);
  return { classId: parsed.id, classVersion: parsed.version, classRef: parsed.id + '@' + parsed.version };
}

/** The exact binding tuple; the resource's installed hash and every ref's fingerprint. */
export function providerBindingFingerprint(binding: PotProviderBinding): string {
  return sha256({ potSlug: binding.potSlug, classRef: exactClassRef(binding.classRef).classRef,
    providerPackage: binding.providerPackage, providerVersion: binding.providerVersion,
    providerKind: binding.providerKind });
}

/** The operation key the binding row carries in `bound_by`, written in the same INSERT. */
export function providerBindingWriteStamp(writeKey: string): string {
  return 'cupboard:install-blueprint#' + writeKey;
}

export function planProviderBindingResource(workspaceId: string, input: PotProviderBinding): {
  address: PackageResourceAddress;
  binding: PotProviderBinding;
  resourceKey: string;
} {
  if (!workspaceId.trim() || !input.potSlug.trim()) throw new Error('provider binding resource requires a workspace and pot');
  const binding = { ...input, classRef: exactClassRef(input.classRef).classRef };
  // One exact provider package version, whatever class it serves; the same
  // binding needed by two identities in one pot is one resource.
  const address: PackageResourceAddress = {
    workspaceId, memoryScope: binding.potSlug, packageKind: 'capability-provider',
    packageRef: binding.providerPackage, packageVersion: binding.providerVersion,
    packageHash: sha256({ providerPackage: binding.providerPackage, providerVersion: binding.providerVersion }),
    resourceKind: PROVIDER_BINDING_RESOURCE_KIND, itemKey: binding.classRef,
    installedHash: providerBindingFingerprint(binding),
  };
  return { address, binding, resourceKey: packageResourceKey(address) };
}

/** Rebuild the binding a journaled address describes. The kind is not part of
 * the address; the registry key (class, package, version) determines it, and
 * the installed hash proves which one was written. */
export function providerBindingFromAddress(address: PackageResourceAddress): PotProviderBinding {
  for (const providerKind of PROVIDER_KINDS) {
    const binding = { potSlug: address.memoryScope, classRef: address.itemKey,
      providerPackage: address.packageRef, providerVersion: address.packageVersion, providerKind };
    if (providerBindingFingerprint(binding) === address.installedHash) return binding;
  }
  throw new Error('provider binding resource address does not describe an exact binding');
}

type PotBindingRow = {
  provider_package: string; provider_version: string; provider_kind: CapabilityProviderKind; bound_by: string | null;
  /** The bound provider is active and structurally conformant — what the grant resolver can reuse. */
  usable: boolean;
};
type PotBindingScope = { workspaceId: string; potSlug: string; classId: string; classVersion: string };

function bindingScope(address: PackageResourceAddress): PotBindingScope {
  const { classId, classVersion } = exactClassRef(address.itemKey);
  return { workspaceId: address.workspaceId, potSlug: address.memoryScope, classId, classVersion };
}

async function readPotBindingRow(
  db: postgres.Sql | postgres.TransactionSql,
  scope: PotBindingScope,
  lock: boolean,
): Promise<PotBindingRow | null> {
  const rows = await db<PotBindingRow[]>`
    SELECT p.provider_package, p.provider_version, p.provider_kind, p.bound_by,
           EXISTS (
             SELECT 1 FROM harness_shared.capability_class_provider_bindings b
               JOIN harness_shared.capability_class_conformance_runs r ON r.id = b.conformance_run_id
              WHERE b.workspace_id = p.workspace_id AND b.class_id = p.class_id
                AND b.class_version = p.class_version AND b.provider_package = p.provider_package
                AND b.provider_version = p.provider_version AND b.provider_kind = p.provider_kind
                AND b.latency_class = p.latency_class AND b.status = 'active' AND r.structural_passed
           ) AS usable
      FROM harness_shared.pot_capability_class_bindings p
     WHERE p.workspace_id = ${scope.workspaceId} AND p.pot_slug = ${scope.potSlug}
       AND p.class_id = ${scope.classId} AND p.class_version = ${scope.classVersion}
     ${lock ? db`FOR UPDATE OF p` : db``}`;
  return rows[0] ?? null;
}

export function packageProviderBindingConflict(address: PackageResourceAddress): Error {
  return new Error(`package-pin-conflict: pot ${address.memoryScope} binds ${address.itemKey} to a different provider than ` +
    `${address.packageRef}@${address.packageVersion}; an administrator must re-point or remove it first`);
}

/** A pot binding write is one PG statement, so the journal's locked intent is its
 * cancellation fence (the recipe driver's argument). An equal binding this
 * operation did not stamp is depended on as owned:false and never deleted.
 * A null binding is a release-only driver: cleanup replays from the durable
 * address alone and can never write a row. */
export function packageProviderBindingDriver(
  sql: postgres.Sql,
  address: PackageResourceAddress,
  binding: PotProviderBinding | null,
): PackageResourceDriver {
  const scope = bindingScope(address);
  const id = `${address.memoryScope}/${address.itemKey}`;
  const fingerprintOf = (row: PotBindingRow) => providerBindingFingerprint({ potSlug: address.memoryScope,
    classRef: address.itemKey, providerPackage: row.provider_package, providerVersion: row.provider_version,
    providerKind: row.provider_kind });
  const refOf = (row: PotBindingRow, writeKey: string): PackageExternalResource => {
    const fingerprint = fingerprintOf(row);
    return { id, fingerprint,
      ...(row.bound_by === providerBindingWriteStamp(writeKey) ? {} : { owned: false }),
      ...(fingerprint === address.installedHash ? {} : { disposition: 'changed' as const }) };
  };
  const read = async (writeKey: string): Promise<PackageExternalResource[]> => {
    const row = await readPotBindingRow(sql, scope, false);
    return row ? [refOf(row, writeKey)] : [];
  };
  return {
    recover: read,
    async create(writeKey) {
      if (!binding) throw new Error('provider binding release driver cannot create bindings');
      try {
        return await sql.begin(async (tx) => {
          const row = await readPotBindingRow(tx, scope, true);
          if (row && fingerprintOf(row) === address.installedHash) return [refOf(row, writeKey)];
          // D-034 refuses only a different USABLE choice. One whose provider has
          // retired or lost conformance is what the resolver read as absent, so
          // this write replaces it; it is then this install's to clean up.
          if (row?.usable) throw packageProviderBindingConflict(address);
          await bindCapabilityProviderToPot(tx, { ...scope, providerPackage: binding.providerPackage,
            providerVersion: binding.providerVersion, providerKind: binding.providerKind,
            boundBy: providerBindingWriteStamp(writeKey), createOnly: !row });
          return [{ id, fingerprint: address.installedHash }];
        });
      } catch (error) {
        // A concurrent equal binding is safe to depend on but is not ours.
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
        if (!receipt) throw new Error('provider binding ownership receipt is missing');
        // Lock the row through deletion so a concurrent re-point cannot be erased.
        const row = await readPotBindingRow(tx, scope, true);
        if (!row) return 'absent';
        const stamp = providerBindingWriteStamp(receipt.write_key);
        if (fingerprintOf(row) !== resource.fingerprint || row.bound_by !== stamp) return 'changed';
        const removed = await deletePotCapabilityProviderBinding(tx, { ...scope,
          expectedProviderPackage: row.provider_package, expectedProviderVersion: row.provider_version,
          expectedBoundBy: stamp });
        return removed ? 'removed' : 'changed';
      });
    },
  };
}

export async function prepareProviderBindingResource(
  sql: postgres.Sql,
  input: { workspaceId: string; binding: PotProviderBinding; dependentId: string },
): Promise<PackageResourceReceipt> {
  const planned = planProviderBindingResource(input.workspaceId, input.binding);
  const driver = packageProviderBindingDriver(sql, planned.address, planned.binding);
  return preparePackageResource(sql, planned.address, input.dependentId, {
    ...driver,
    // Recovery below refuses any usable foreign choice, so a binding detached
    // by an administrator's re-point can be re-bound once that choice is gone.
    readmitsChanged: true,
    async recover(writeKey) {
      const refs = await driver.recover(writeKey);
      // Admission and cleanup share recovery, but only admission refuses a
      // re-pointed binding. Cleanup still needs its changed disposition to keep it.
      if (!refs.some((ref) => ref.disposition === 'changed')) return refs;
      // An unusable foreign choice is absent to admission: create replaces it.
      const row = await readPotBindingRow(sql, bindingScope(planned.address), false);
      if (row && !row.usable) return [];
      throw packageProviderBindingConflict(planned.address);
    },
  });
}
