/**
 * Resource journal for the existing blueprint package lifecycle (portable D-007).
 * Not an executor: install/activation/DBOS callers invoke these replayable steps.
 * Persist intent BEFORE external I/O. A transaction lock serializes dependents and
 * cleanup; external writes survive a rolled-back receipt and are rediscovered by
 * their persisted write key. No assertion of atomicity between PG and a backend.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export interface PackageResourceAddress {
  workspaceId: string;
  memoryScope: string;
  packageKind: string;
  packageRef: string;
  packageVersion: string;
  packageHash: string;
  resourceKind: string;
  itemKey: string;
  installedHash: string;
}

export interface PackageExternalResource {
  /** Exact backend row identifier, never a package-wide deletion selector. */
  id: string;
  /** Backend snapshot fingerprint checked atomically by removeIfUnchanged. */
  fingerprint: string;
  /** False means the exact row predated this package. It participates in the
   * dependency/pin set but automatic compensation must never delete it. */
  owned?: boolean;
  disposition?: 'removed' | 'absent' | 'changed' | 'unowned';
  error?: string;
}

export interface PackageResourceDriver {
  /** Only rows with this exact persisted operation key; no semantic matching.
   * Recover the ORIGINAL write fingerprint, not a fingerprint of a later user edit;
   * flag an edited row with disposition:'changed' so it can never be adopted/deleted. */
  recover(writeKey: string): Promise<PackageExternalResource[]>;
  /** Must stamp writeKey atomically with the external write, including on errors. */
  create(writeKey: string): Promise<PackageExternalResource[]>;
  /** Persist a fence even when recovery is empty. No later create may land. */
  cancel(writeKey: string): Promise<void>;
  /** Must compare AND remove atomically; a get-then-forget adapter is unsafe. */
  removeIfUnchanged(resource: PackageExternalResource): Promise<'removed' | 'absent' | 'changed'>;
}

export interface PackageResourceReceipt {
  resource_key: string;
  write_key: string;
  installed_hash: string;
  phase: 'intent' | 'ready' | 'cleanup_failed' | 'deleted' | 'detached';
  external_refs: PackageExternalResource[];
  error: string | null;
}

type Db = Sql | TransactionSql;

export interface PackageInstallationReceipt {
  owner_id: string;
  specification_revision: string;
  state_revision: string;
  expected_resources: Record<string, string>;
  phase: 'preparing' | 'applied' | 'releasing' | 'released' | 'cleanup_failed';
  error: string | null;
}

export function packageResourceKey(address: PackageResourceAddress): string {
  for (const [key, value] of Object.entries(address)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`package resource requires ${key}`);
  }
  for (const value of [address.packageHash, address.installedHash]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('package resource requires exact SHA-256 hashes');
  }
  return createHash('sha256').update(JSON.stringify([
    address.workspaceId, address.memoryScope, address.packageKind, address.packageRef,
    address.packageVersion, address.packageHash, address.resourceKind, address.itemKey,
  ])).digest('hex');
}

async function lock(sql: TransactionSql, workspaceId: string, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['blueprint-package-resource', workspaceId, key])}, 0))`;
}

export async function readPackageInstallation(sql: Db, workspaceId: string, dependentId: string): Promise<PackageInstallationReceipt | null> {
  const [row] = await sql<PackageInstallationReceipt[]>`SELECT owner_id, specification_revision, state_revision,
      expected_resources, phase, error FROM harness_shared.blueprint_package_installations
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
  return row ?? null;
}

/** Persist the full intended set before any external write, including zero writes.
 * Existing per-resource receipts remain the authority for external IDs/ownership. */
interface PackageInstallationInput {
  workspaceId: string; dependentId: string; ownerId: string;
  specificationRevision: string; stateRevision: string; expectedResources: ReadonlyMap<string, string>;
}

export async function beginPackageInstallation(sql: Sql, input: PackageInstallationInput): Promise<void> {
  await sql.begin((tx) => beginPackageInstallationInTransaction(tx, input));
}

async function beginPackageInstallationInTransaction(tx: TransactionSql, input: PackageInstallationInput): Promise<void> {
  for (const value of [input.workspaceId, input.dependentId, input.ownerId, input.specificationRevision, input.stateRevision]) {
    if (!value?.trim()) throw new Error('package installation requires exact wearer and revision');
  }
  const expected = Object.fromEntries([...input.expectedResources].sort(([a], [b]) => a.localeCompare(b)));
  if (Object.entries(expected).some(([key, hash]) => !/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('package installation requires exact resource keys and hashes');
  }
  await lock(tx, input.workspaceId, 'dependent:' + input.dependentId);
  await tx`INSERT INTO harness_shared.blueprint_package_installations
    (workspace_id, dependent_id, owner_id, specification_revision, state_revision, expected_resources)
    VALUES (${input.workspaceId}, ${input.dependentId}, ${input.ownerId}, ${input.specificationRevision},
      ${input.stateRevision}, ${tx.json(expected)}) ON CONFLICT (workspace_id, dependent_id) DO NOTHING`;
  const row = (await readPackageInstallation(tx, input.workspaceId, input.dependentId))!;
  if (row.owner_id !== input.ownerId || row.specification_revision !== input.specificationRevision ||
      row.state_revision !== input.stateRevision || Object.keys(row.expected_resources).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, hash]) => row.expected_resources[key] !== hash)) {
    throw new Error('package installation manifest cannot change under an exact revision');
  }
  if (row.phase !== 'preparing' && row.phase !== 'applied') throw new Error('released installation cannot be replayed');
}

/** Mode/control changes can carry an unchanged specification without external
 * writes. The host must select the source from its authoritative applied receipt
 * and call this INSIDE the transaction that publishes the next desired revision.
 * The new ref stays prepared until that revision is acknowledged. */
export async function carryAppliedPackageInstallation(tx: TransactionSql, input: PackageInstallationInput & {
  fromDependentId: string;
}): Promise<void> {
  if (!input.fromDependentId.trim()) throw new Error('package carry requires an applied source');
  for (const id of [...new Set([input.fromDependentId, input.dependentId])].sort()) {
    await lock(tx, input.workspaceId, 'dependent:' + id);
  }
  const source = await readPackageInstallation(tx, input.workspaceId, input.fromDependentId);
  if (!source || source.phase !== 'applied' || source.owner_id !== input.ownerId ||
      source.specification_revision !== input.specificationRevision) {
    throw new Error('package carry requires the same wearer and applied specification');
  }
  // Reuses the locked exact-set validation, including current resource readiness.
  // No target rows are written if the source is incomplete or the pins changed.
  await applyPackageResourceDependent(tx, input.workspaceId, input.fromDependentId, input.expectedResources);
  await beginPackageInstallationInTransaction(tx, input);
  await tx`INSERT INTO harness_shared.blueprint_package_dependents
    (workspace_id, dependent_id, resource_key)
    SELECT workspace_id, ${input.dependentId}, resource_key
    FROM harness_shared.blueprint_package_dependents
    WHERE workspace_id = ${input.workspaceId} AND dependent_id = ${input.fromDependentId}
    ON CONFLICT (workspace_id, dependent_id, resource_key) DO NOTHING`;
}

export interface PackageInstallationReleaseOptions {
  /** Compensating a failed preparation: never fence an installation that applied. */
  onlyUnapplied?: boolean;
  /** Resume a fence that already committed; never start a new release. A caller
   * whose fencing transaction rolled back therefore cannot release anything. */
  onlyReleasing?: boolean;
}

/** Commit the release fence BEFORE external cleanup. All members are ineligible
 * immediately, and a crash can replay the durable dependent addresses. */
export async function beginPackageInstallationRelease(sql: Sql, workspaceId: string, dependentId: string,
  options: PackageInstallationReleaseOptions = {}): Promise<boolean> {
  return sql.begin((tx) => beginPackageInstallationReleaseInTransaction(tx, workspaceId, dependentId, options));
}

/** The same fence inside a caller's transaction, e.g. the activation that
 * supersedes this installation. It commits or rolls back with that caller. */
export async function beginPackageInstallationReleaseInTransaction(tx: TransactionSql, workspaceId: string,
  dependentId: string, options: PackageInstallationReleaseOptions = {}): Promise<boolean> {
  await lock(tx, workspaceId, 'dependent:' + dependentId);
  const row = await readPackageInstallation(tx, workspaceId, dependentId);
  if (options.onlyReleasing && row?.phase !== 'releasing' && row?.phase !== 'cleanup_failed') return false;
  const [applied] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId} AND phase = 'applied' LIMIT 1`;
  if (options.onlyUnapplied && (row?.phase === 'applied' || applied)) return false;
  await tx`UPDATE harness_shared.blueprint_package_installations SET phase = 'releasing', error = NULL, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId} AND phase <> 'released'`;
  await tx`UPDATE harness_shared.blueprint_package_dependents SET phase = 'released', updated_at = now()
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
  return true;
}

export async function finishPackageInstallationRelease(sql: Sql, workspaceId: string, dependentId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await lock(tx, workspaceId, 'dependent:' + dependentId);
    const row = await readPackageInstallation(tx, workspaceId, dependentId);
    if (!row || row.phase === 'released') return; // pre-manifest compatibility
    if (row.phase !== 'releasing' && row.phase !== 'cleanup_failed') throw new Error('package installation release has not begun');
    const residue = await tx<Array<{ resource_key: string; error: string | null }>>`
      SELECT d.resource_key, r.error FROM harness_shared.blueprint_package_dependents d
      JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
      WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}
        AND (d.phase <> 'released' OR (r.phase NOT IN ('deleted', 'detached') AND NOT EXISTS (
          SELECT 1 FROM harness_shared.blueprint_package_dependents held
          WHERE held.workspace_id = r.workspace_id AND held.resource_key = r.resource_key AND held.phase <> 'released')))`;
    const error = residue.length ? residue.map((r) => r.resource_key + ': ' + (r.error ?? 'cleanup incomplete')).join('; ') : null;
    await tx`UPDATE harness_shared.blueprint_package_installations
      SET phase = ${error ? 'cleanup_failed' : 'released'}, error = ${error}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
  });
}

/** Failures before a per-resource receipt (backend selection, enumeration or
 * finalization) still belong to the durable installation. Never overwrite a
 * concurrently completed release with a stale failure. */
export async function recordPackageInstallationReleaseFailure(
  sql: Sql, workspaceId: string, dependentId: string, error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  await sql.begin(async (tx) => {
    await lock(tx, workspaceId, 'dependent:' + dependentId);
    await tx`UPDATE harness_shared.blueprint_package_installations
      SET phase = 'cleanup_failed', error = ${message}, updated_at = now()
      WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}
        AND phase IN ('releasing', 'cleanup_failed')`;
  });
}

export async function readPackageResourceReceipt(sql: Db, workspaceId: string, key: string): Promise<PackageResourceReceipt | null> {
  const rows = await sql<PackageResourceReceipt[]>`
    SELECT resource_key, write_key, installed_hash, phase, external_refs, error
      FROM harness_shared.blueprint_package_resources
     WHERE workspace_id = ${workspaceId} AND resource_key = ${key}`;
  return rows[0] ?? null;
}

function validateRefs(refs: PackageExternalResource[]): PackageExternalResource[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) =>
    !ref.id?.trim() || !ref.fingerprint?.trim() || ref.disposition || ref.error ||
    (ref.owned !== undefined && typeof ref.owned !== 'boolean')) ||
    new Set(refs.map((ref) => ref.id)).size !== refs.length) {
    throw new Error('package resource write did not return unique exact resource receipts');
  }
  return refs.map(({ id, fingerprint, owned }) => ({ id, fingerprint, ...(owned === false ? { owned } : {}) }));
}

/** Shared same-version resources have one write and a separate ref for each install. */
export async function preparePackageResource(
  sql: Sql, address: PackageResourceAddress, dependentId: string, driver: PackageResourceDriver,
): Promise<PackageResourceReceipt> {
  if (!dependentId.trim()) throw new Error('package resource requires an identity-install dependent');
  const key = packageResourceKey(address);
  // This commit survives process death during the external write below.
  await sql.begin(async (tx) => {
    await lock(tx, address.workspaceId, 'dependent:' + dependentId);
    await lock(tx, address.workspaceId, key);
    const installation = await readPackageInstallation(tx, address.workspaceId, dependentId);
    if (installation) {
      if (installation.phase !== 'preparing' && installation.phase !== 'applied') throw new Error('released installation cannot be replayed');
      if (installation.expected_resources[key] !== address.installedHash) throw new Error('resource is outside the installation manifest');
    }
    // Once applied, this installation describes an immutable complete set.
    // Replaying a member is safe; appending another one requires a new revision.
    const [sealed] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND phase = 'applied'
        AND NOT EXISTS (SELECT 1 FROM harness_shared.blueprint_package_dependents
          WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId}
            AND resource_key = ${key}) LIMIT 1`;
    if (sealed) throw new Error('applied installation cannot prepare additional resources');
    const [conflictingPin] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents d
      JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
      WHERE d.workspace_id = ${address.workspaceId} AND d.dependent_id = ${dependentId}
        AND d.phase <> 'released' AND r.memory_scope = ${address.memoryScope}
        AND r.package_kind = ${address.packageKind} AND r.package_ref = ${address.packageRef}
        AND (r.package_hash <> ${address.packageHash} OR r.package_version <> ${address.packageVersion}) LIMIT 1`;
    if (conflictingPin) throw new Error('package-pin-conflict: installation already pins another exact version');
    await tx`INSERT INTO harness_shared.blueprint_package_resources
      (workspace_id, resource_key, memory_scope, package_kind, package_ref, package_version,
       package_hash, resource_kind, item_key, installed_hash)
      VALUES (${address.workspaceId}, ${key}, ${address.memoryScope}, ${address.packageKind},
        ${address.packageRef}, ${address.packageVersion}, ${address.packageHash},
        ${address.resourceKind}, ${address.itemKey}, ${address.installedHash})
      ON CONFLICT (workspace_id, resource_key) DO NOTHING`;
    const receipt = (await readPackageResourceReceipt(tx, address.workspaceId, key))!;
    if (receipt.installed_hash !== address.installedHash) throw new Error('package resource content changed under an exact pin');
    if (receipt.phase === 'detached') throw new Error('package resource was edited; explicit review is required');
    if (receipt.phase === 'cleanup_failed') throw new Error('package resource needs cleanup recovery before installation');
    if (receipt.phase === 'deleted') {
      // A fresh install starts a new operation; deleted history cannot be replayed as ready.
      await tx`UPDATE harness_shared.blueprint_package_resources
        SET write_key = gen_random_uuid(), phase = 'intent', external_refs = '[]'::jsonb, error = NULL, updated_at = now()
        WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
    }
    await tx`INSERT INTO harness_shared.blueprint_package_dependents (workspace_id, dependent_id, resource_key)
      VALUES (${address.workspaceId}, ${dependentId}, ${key})
      ON CONFLICT (workspace_id, dependent_id, resource_key) DO NOTHING`;
    const [dependent] = await tx<{ phase: string }[]>`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}`;
    if (dependent.phase === 'released') throw new Error('released installation cannot be replayed; use a new dependent id');
  });

  try {
    return await sql.begin(async (tx) => {
      await lock(tx, address.workspaceId, 'dependent:' + dependentId);
      await lock(tx, address.workspaceId, key);
      const [dependent] = await tx<{ phase: string }[]>`SELECT phase FROM harness_shared.blueprint_package_dependents
        WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}`;
      if (dependent.phase === 'released') throw new Error('installation was released before preparation finished');
      const receipt = (await readPackageResourceReceipt(tx, address.workspaceId, key))!;
      if (receipt.phase === 'ready') {
        const current = await driver.recover(receipt.write_key);
        if (current.length !== receipt.external_refs.length || current.some((ref) => ref.disposition || ref.error) ||
            receipt.external_refs.some((ref) => !current.some((row) => row.id === ref.id && row.fingerprint === ref.fingerprint))) {
          throw new Error('prepared package resource changed; explicit review is required');
        }
        return receipt;
      }
      if (receipt.phase !== 'intent') throw new Error('package resource needs cleanup recovery before installation');
      // A failed/ambiguous external response can have committed rows. Recover them
      // before calling create, including after a lost PG commit acknowledgement.
      const recovered = await driver.recover(receipt.write_key);
      const refs = validateRefs(recovered.length ? recovered : await driver.create(receipt.write_key));
      await tx`UPDATE harness_shared.blueprint_package_resources
        SET phase = 'ready', external_refs = ${tx.json(refs.map((ref) => ({ ...ref })))}, error = NULL, updated_at = now()
        WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
      return { ...receipt, phase: 'ready' as const, external_refs: refs, error: null };
    });
  } catch (error) {
    // Preserve ambiguous-outcome diagnostics without overwriting a peer's later
    // successful recovery. The committed intent/write key is still the retry key.
    await sql`UPDATE harness_shared.blueprint_package_resources
      SET error = ${error instanceof Error ? error.message : String(error)}, updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key} AND phase = 'intent'`;
    throw error;
  }
}

/** Invoke in the SAME transaction that promotes the existing applied activation. */
export async function applyPackageResourceDependent(
  tx: TransactionSql, workspaceId: string, dependentId: string,
  expectedResources?: ReadonlyMap<string, string>,
  options: { allowLegacyUnprepared?: boolean } = {},
): Promise<void> {
  let expected = expectedResources ? new Map(expectedResources) : undefined;
  await lock(tx, workspaceId, 'dependent:' + dependentId);
  const installation = await readPackageInstallation(tx, workspaceId, dependentId);
  if (installation) {
    if (installation.phase !== 'preparing' && installation.phase !== 'applied') throw new Error('package installation has been released');
    const manifest = new Map(Object.entries(installation.expected_resources));
    if (expected && (manifest.size !== expected.size || [...manifest].some(([key, hash]) => expected!.get(key) !== hash))) {
      throw new Error('identity package preparation does not match the complete applied pin set');
    }
    expected = manifest;
  }
  const resources = await tx<{ resource_key: string }[]>`SELECT resource_key FROM harness_shared.blueprint_package_dependents
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId} ORDER BY resource_key`;
  if (!resources.length && !installation) {
    if (options.allowLegacyUnprepared) return;
    throw new Error('package resource dependent has not been prepared');
  }
  for (const { resource_key: key } of resources) await lock(tx, workspaceId, key);
  // Read the set and content hashes only after BOTH the dependent and resource
  // locks. A host-side preflight is a stale snapshot once it waits for either.
  if (expected) {
    const prepared = await tx<Array<{ resource_key: string; installed_hash: string }>>`
      SELECT d.resource_key, r.installed_hash FROM harness_shared.blueprint_package_dependents d
      JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
      WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}`;
    if (prepared.length !== expected.size || prepared.some((row) => expected.get(row.resource_key) !== row.installed_hash)) {
      throw new Error('identity package preparation does not match the complete applied pin set');
    }
  }
  const [invalid] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents d
    JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
    WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}
      AND (d.phase = 'released' OR r.phase <> 'ready') LIMIT 1`;
  if (invalid) throw new Error('package resources are not prepared for activation');
  await tx`UPDATE harness_shared.blueprint_package_dependents SET phase = 'applied', updated_at = now()
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
  await tx`UPDATE harness_shared.blueprint_package_installations SET phase = 'applied', error = NULL, updated_at = now()
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
}

/** Release one reference; retry the same call to converge after any interrupted cleanup. */
export async function releasePackageResource(
  sql: Sql, address: PackageResourceAddress, dependentId: string, driver: PackageResourceDriver,
): Promise<PackageResourceReceipt | null> {
  const key = packageResourceKey(address);
  return sql.begin(async (tx) => {
    await lock(tx, address.workspaceId, 'dependent:' + dependentId);
    await lock(tx, address.workspaceId, key);
    const receipt = await readPackageResourceReceipt(tx, address.workspaceId, key);
    if (!receipt) return null;
    const released = await tx`UPDATE harness_shared.blueprint_package_dependents
      SET phase = 'released', updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}
      RETURNING dependent_id`;
    if (!released.length) throw new Error('installation does not own this package resource');
    const [held] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key} AND phase <> 'released' LIMIT 1`;
    if (held || receipt.phase === 'deleted' || receipt.phase === 'detached') return receipt;
    // intent can mean process death after an external commit, before the receipt.
    let refs: PackageExternalResource[];
    try {
      await driver.cancel(receipt.write_key);
      refs = receipt.phase === 'intent' || !receipt.external_refs.length
        ? await driver.recover(receipt.write_key) : receipt.external_refs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx`UPDATE harness_shared.blueprint_package_resources
        SET phase = 'cleanup_failed', error = ${message}, updated_at = now()
        WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
      return { ...receipt, phase: 'cleanup_failed' as const, error: message };
    }
    const settled: PackageExternalResource[] = [];
    for (const ref of refs) {
      if (ref.disposition) { settled.push(ref); continue; }
      if (ref.owned === false) {
        settled.push({ id: ref.id, fingerprint: ref.fingerprint, owned: false, disposition: 'unowned' });
        continue;
      }
      try {
        settled.push({ id: ref.id, fingerprint: ref.fingerprint, disposition: await driver.removeIfUnchanged(ref) });
      } catch (error) {
        settled.push({ id: ref.id, fingerprint: ref.fingerprint, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const errors = settled.filter((ref) => ref.error).map((ref) => `${ref.id}: ${ref.error}`);
    const phase = errors.length ? 'cleanup_failed'
      : settled.some((ref) => ref.disposition === 'changed' || ref.disposition === 'unowned') ? 'detached' : 'deleted';
    const error = errors.length ? errors.join('; ') : null;
    await tx`UPDATE harness_shared.blueprint_package_resources
      SET phase = ${phase}, external_refs = ${tx.json(settled.map((ref) => ({ ...ref })))}, error = ${error}, updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
    return { ...receipt, phase, external_refs: settled, error };
  });
}
