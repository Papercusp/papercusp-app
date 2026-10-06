/**
 * The pot side of a Cupboard blueprint lifecycle (portable identities P-014, D-034).
 *
 * A pot provider binding written for an identity is a P-006 journal resource,
 * owned by a per-pot installation of that blueprint: owner `pot:<potSlug>`,
 * specification revision = the release's root content hash, state revision
 * `blueprint:<id>`. blueprint-release.ts drives this under the blueprint's fs
 * lifecycle lock: recover → prepare → file-tier switch → apply + fence → cleanup.
 * The file-tier release is the applied switch, so a half-install is never
 * applied, and a crash between the binding write and the switch is converged by
 * the next lifecycle call. Not an executor and not a second receipt store.
 *
 * Scope limit (D-034): the file tier is host-local; recovery trusts this host's
 * lifecycle index for which release is active.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { CapabilityProviderKind } from '../capability-class-registry-store';
import {
  applyPackageResourceDependent,
  beginPackageInstallation,
  beginPackageInstallationReleaseInTransaction,
  readPackageInstallation,
  type PackageResourceAddress,
} from '../blueprint/package-resource-receipts';
import { releasePackageInstallation } from '../blueprint/package-knowledge-resources';
import {
  planProviderBindingResource,
  prepareProviderBindingResource,
  providerBindingFromAddress,
  PROVIDER_BINDING_RESOURCE_KIND,
  type PotProviderBinding,
} from '../blueprint/package-provider-binding-resources';
import {
  EVENT_KEY_RESOURCE_KIND,
  packageEventKeyDriver,
  planEventKeyResource,
  prepareEventKeyResource,
  type BundledEventKey,
} from '../blueprint/package-event-key-resources';
import { preparePackageResource } from '../blueprint/package-resource-receipts';
import {
  BlueprintLifecycleError,
  type BlueprintJournalAttempt,
  type BlueprintJournalReport,
  type BlueprintLifecycleJournal,
} from './blueprint-release';

export interface InstallProviderBinding {
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  providerKind: CapabilityProviderKind;
}

export type BlueprintJournalPlan =
  | { operation: 'install'; potSlug: string; bindings: readonly InstallProviderBinding[];
      /** D-042: the release's bundled event keys, claimed for the workspace. */
      eventKeys?: readonly BundledEventKey[] }
  | { operation: 'rollback' }
  | { operation: 'uninstall' };

type PotReport = BlueprintJournalReport['pots'][number];
type ResidueReport = BlueprintJournalReport['residue'];

const OWNER_PREFIX = 'pot:';

export function blueprintInstallOwner(potSlug: string): string {
  return OWNER_PREFIX + potSlug;
}

export function blueprintInstallState(blueprintId: string): string {
  return 'blueprint:' + blueprintId;
}

/** D-018's derived attempt ids: attempt 0 has no suffix. */
export function blueprintInstallDependentId(potSlug: string, blueprintId: string, contentHash: string, attempt = 0): string {
  return 'blueprint-install:' + createHash('sha256').update(JSON.stringify([
    blueprintInstallOwner(potSlug), contentHash, blueprintInstallState(blueprintId),
    ...(attempt === 0 ? [] : ['attempt:' + attempt]),
  ])).digest('hex');
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function sameManifest(a: Record<string, string>, b: ReadonlyMap<string, string>): boolean {
  return Object.keys(a).length === b.size && [...b].every(([key, hash]) => a[key] === hash);
}

function bindingLine(binding: PotProviderBinding): string {
  return `${binding.classRef} → ${binding.providerPackage}@${binding.providerVersion}`;
}

interface PlannedPotInstall {
  potSlug: string;
  bindings: PotProviderBinding[];
  /** Claimed through the full driver on install; a rollback re-depends on the live key only. */
  eventKeys: Array<{ key: BundledEventKey } | { address: PackageResourceAddress }>;
  expected: Map<string, string>;
}

export function blueprintInstallJournal(
  scope: { sql: Sql; workspaceId: string; blueprintId: string },
  plan: BlueprintJournalPlan,
): BlueprintLifecycleJournal {
  const { sql, workspaceId, blueprintId } = scope;
  const state = blueprintInstallState(blueprintId);
  const potOf = (ownerId: string) => ownerId.slice(OWNER_PREFIX.length);

  /** Reuse a live attempt with this exact manifest; otherwise the first unused id. */
  async function attemptId(potSlug: string, contentHash: string, expected: ReadonlyMap<string, string>): Promise<string> {
    const rows = await sql<Array<{ dependent_id: string; phase: string; expected_resources: Record<string, string> }>>`
      SELECT dependent_id, phase, expected_resources FROM harness_shared.blueprint_package_installations
       WHERE workspace_id = ${workspaceId} AND owner_id = ${blueprintInstallOwner(potSlug)}
         AND specification_revision = ${contentHash} AND state_revision = ${state}`;
    const byId = new Map(rows.map((row) => [row.dependent_id, row]));
    // At most rows.length ids are taken, so one of rows.length + 1 is free.
    for (let n = 0; n <= rows.length; n++) {
      const id = blueprintInstallDependentId(potSlug, blueprintId, contentHash, n);
      const row = byId.get(id);
      if (!row) return id;
      if ((row.phase === 'preparing' || row.phase === 'applied') && sameManifest(row.expected_resources, expected)) return id;
    }
    throw new Error('blueprint install attempt derivation exhausted its candidates');
  }

  /** The pot's other applied installs of this blueprint; fenced in the applying transaction. */
  async function fencePrior(tx: TransactionSql, potSlug: string, keep: string): Promise<string[]> {
    const rows = await tx<Array<{ dependent_id: string }>>`
      SELECT dependent_id FROM harness_shared.blueprint_package_installations
       WHERE workspace_id = ${workspaceId} AND owner_id = ${blueprintInstallOwner(potSlug)}
         AND state_revision = ${state} AND phase = 'applied' AND dependent_id <> ${keep}
       ORDER BY dependent_id`;
    const fenced: string[] = [];
    for (const { dependent_id: dependentId } of rows) {
      if (await beginPackageInstallationReleaseInTransaction(tx, workspaceId, dependentId)) fenced.push(dependentId);
    }
    return fenced;
  }

  /** External cleanup; residue stays durable on the installation row. */
  async function release(dependentId: string, options: { onlyReleasing?: boolean; onlyUnapplied?: boolean }): Promise<ResidueReport> {
    try {
      await releasePackageInstallation(sql, workspaceId, dependentId, undefined, options);
    } catch (error) {
      return [{ dependentId, error: message(error) }];
    }
    const row = await readPackageInstallation(sql, workspaceId, dependentId);
    return row?.phase === 'cleanup_failed' ? [{ dependentId, error: row.error ?? 'cleanup incomplete' }] : [];
  }

  /** Apply one pot's attempt and fence what it supersedes in ONE transaction (lock
   * order: superseded dependents first, as a concurrent release takes them). */
  async function applyPot(potSlug: string, dependentId: string, expected?: ReadonlyMap<string, string>) {
    const superseded = await sql.begin(async (tx) => {
      const fenced = await fencePrior(tx, potSlug, dependentId);
      await applyPackageResourceDependent(tx, workspaceId, dependentId, expected);
      return fenced;
    });
    const residue: ResidueReport = [];
    for (const fenced of superseded) residue.push(...await release(fenced, { onlyReleasing: true }));
    return { superseded, residue };
  }

  async function prepareAttempts(contentHash: string, installs: readonly PlannedPotInstall[],
    refusal: (error: unknown) => BlueprintLifecycleError): Promise<Array<PlannedPotInstall & { dependentId: string }>> {
    const prepared: Array<PlannedPotInstall & { dependentId: string }> = [];
    const enrolled: string[] = [];
    try {
      for (const install of installs) {
        const dependentId = await attemptId(install.potSlug, contentHash, install.expected);
        await beginPackageInstallation(sql, { workspaceId, dependentId, ownerId: blueprintInstallOwner(install.potSlug),
          specificationRevision: contentHash, stateRevision: state, expectedResources: install.expected });
        enrolled.push(dependentId);
        for (const binding of install.bindings) await prepareProviderBindingResource(sql, { workspaceId, binding, dependentId });
        for (const entry of install.eventKeys) {
          if ('key' in entry) await prepareEventKeyResource(sql, { workspaceId, blueprintId, key: entry.key, dependentId });
          else await preparePackageResource(sql, entry.address, dependentId, packageEventKeyDriver(sql, entry.address, null));
        }
        prepared.push({ ...install, dependentId });
      }
    } catch (error) {
      // Only attempts this call enrolled, and never one that already applied.
      const residue: ResidueReport = [];
      for (const dependentId of enrolled) residue.push(...await release(dependentId, { onlyUnapplied: true }));
      if (residue.length) {
        throw new BlueprintLifecycleError(`${message(error)}; compensation is incomplete (${residue.map((r) => r.error).join('; ')})`,
          500, 'capability_binding_rollback_failed');
      }
      throw refusal(error);
    }
    return prepared;
  }

  function attemptFor(prepared: Array<PlannedPotInstall & { dependentId: string }>, notes: PotReport[]): BlueprintJournalAttempt {
    return {
      async apply() {
        const pots: PotReport[] = [...notes];
        const residue: ResidueReport = [];
        for (const install of prepared) {
          const bindings = install.bindings.map(bindingLine).sort();
          try {
            const applied = await applyPot(install.potSlug, install.dependentId, install.expected);
            pots.push({ potSlug: install.potSlug, dependentId: install.dependentId, applied: true, bindings, superseded: applied.superseded });
            residue.push(...applied.residue);
          } catch (error) {
            pots.push({ potSlug: install.potSlug, dependentId: install.dependentId, applied: false, bindings, superseded: [],
              error: message(error), note: 'the release is active; this install rolls forward at the next lifecycle call' });
          }
        }
        return { pots, residue };
      },
      async compensate(cause) {
        const residue: ResidueReport = [];
        for (const install of prepared) residue.push(...await release(install.dependentId, { onlyUnapplied: true }));
        if (residue.length) {
          throw new BlueprintLifecycleError(`blueprint release failed (${message(cause)}) and binding compensation is incomplete: ` +
            residue.map((r) => `${r.dependentId}: ${r.error}`).join('; '), 500, 'capability_binding_rollback_failed');
        }
      },
    };
  }

  async function prepareInstall(contentHash: string, potSlug: string, input: readonly InstallProviderBinding[],
    keys: readonly BundledEventKey[]) {
    const expected = new Map<string, string>();
    for (const key of keys) {
      const planned = planEventKeyResource(workspaceId, blueprintId, key);
      expected.set(planned.resourceKey, planned.address.installedHash);
    }
    const bindings: PotProviderBinding[] = [];
    for (const entry of input) {
      const planned = planProviderBindingResource(workspaceId, { potSlug, ...entry });
      const prior = expected.get(planned.resourceKey);
      if (prior && prior !== planned.address.installedHash) {
        throw new BlueprintLifecycleError(`${entry.classRef} resolves to two different providers`, 409, 'capability_provider_binding_failed');
      }
      if (!prior) bindings.push(planned.binding);
      expected.set(planned.resourceKey, planned.address.installedHash);
    }
    const eventKeys = keys.map((key) => ({ key }));
    const prepared = await prepareAttempts(contentHash, [{ potSlug, bindings, eventKeys, expected }], (error) =>
      message(error).includes('event-key-held:')
        ? new BlueprintLifecycleError('bundled event key could not be claimed before blueprint install: ' + message(error),
          409, 'event_key_held')
        : new BlueprintLifecycleError('capability provider binding failed before blueprint install: ' + message(error),
          409, 'capability_provider_binding_failed'));
    return attemptFor(prepared, []);
  }

  /** D-034: each pot with an applied install re-prepares the exact resources the
   * target's most recent install receipt there recorded. */
  async function prepareRollback(contentHash: string) {
    const pots = await sql<Array<{ owner_id: string }>>`
      SELECT DISTINCT owner_id FROM harness_shared.blueprint_package_installations
       WHERE workspace_id = ${workspaceId} AND state_revision = ${state}
         AND starts_with(owner_id, ${OWNER_PREFIX}) AND phase = 'applied'
       ORDER BY owner_id`;
    const installs: PlannedPotInstall[] = [];
    const notes: PotReport[] = [];
    for (const { owner_id: ownerId } of pots) {
      const potSlug = potOf(ownerId);
      const [receipt] = await sql<Array<{ expected_resources: Record<string, string> }>>`
        SELECT expected_resources FROM harness_shared.blueprint_package_installations
         WHERE workspace_id = ${workspaceId} AND owner_id = ${ownerId} AND state_revision = ${state}
           AND specification_revision = ${contentHash}
         ORDER BY updated_at DESC LIMIT 1`;
      if (!receipt) {
        notes.push({ potSlug, dependentId: null, applied: false, bindings: [], superseded: [],
          note: 'no install receipt for this release in this pot; its bindings are left as they are' });
        continue;
      }
      const keys = Object.keys(receipt.expected_resources);
      const rows = keys.length ? await sql<Array<{
        resource_key: string; memory_scope: string; package_kind: string; package_ref: string; package_version: string;
        package_hash: string; resource_kind: string; item_key: string; installed_hash: string;
      }>>`SELECT resource_key, memory_scope, package_kind, package_ref, package_version, package_hash,
            resource_kind, item_key, installed_hash
          FROM harness_shared.blueprint_package_resources
         WHERE workspace_id = ${workspaceId} AND resource_key IN ${sql(keys)}` : [];
      const known = [PROVIDER_BINDING_RESOURCE_KIND, EVENT_KEY_RESOURCE_KIND];
      if (rows.length !== keys.length || rows.some((row) => !known.includes(row.resource_kind))) {
        throw new BlueprintLifecycleError(`blueprint ${blueprintId} install receipt in pot ${potSlug} is incomplete`, 409, 'rollback_binding_conflict');
      }
      const addresses = rows.map((row) => ({ workspaceId, memoryScope: row.memory_scope,
        packageKind: row.package_kind, packageRef: row.package_ref, packageVersion: row.package_version,
        packageHash: row.package_hash, resourceKind: row.resource_kind, itemKey: row.item_key,
        installedHash: row.installed_hash } satisfies PackageResourceAddress));
      const bindings = addresses.filter((address) => address.resourceKind === PROVIDER_BINDING_RESOURCE_KIND)
        .map(providerBindingFromAddress);
      // A key the rollback target claimed is re-depended on while it is live; one
      // already released cannot be re-claimed from its address and refuses below.
      const eventKeys = addresses.filter((address) => address.resourceKind === EVENT_KEY_RESOURCE_KIND)
        .map((address) => ({ address }));
      installs.push({ potSlug, bindings, eventKeys, expected: new Map(Object.entries(receipt.expected_resources)) });
    }
    const prepared = await prepareAttempts(contentHash, installs, (error) =>
      new BlueprintLifecycleError(`blueprint ${blueprintId} rollback would restore a binding a later owner changed: ${message(error)}`,
        409, 'rollback_binding_conflict'));
    return attemptFor(prepared, notes);
  }

  /** D-034: after the file tier is gone, every non-released pot install is fenced and cleaned. */
  function uninstallAttempt(): BlueprintJournalAttempt {
    return {
      async apply() {
        const rows = await sql<Array<{ dependent_id: string; owner_id: string }>>`
          SELECT dependent_id, owner_id FROM harness_shared.blueprint_package_installations
           WHERE workspace_id = ${workspaceId} AND state_revision = ${state}
             AND starts_with(owner_id, ${OWNER_PREFIX}) AND phase <> 'released'
           ORDER BY owner_id, dependent_id`;
        const pots = new Map<string, PotReport>();
        const residue: ResidueReport = [];
        for (const row of rows) {
          const potSlug = potOf(row.owner_id);
          const report = pots.get(potSlug) ?? { potSlug, dependentId: null, applied: false, bindings: [], superseded: [] };
          report.superseded.push(row.dependent_id);
          pots.set(potSlug, report);
          residue.push(...await release(row.dependent_id, {}));
        }
        return { pots: [...pots.values()], residue };
      },
      async compensate() {},
    };
  }

  return {
    async recover(activeContentHash) {
      // With no active release, an applied install is one an interrupted
      // uninstall left behind: its file tier is gone, so it is cleaned too.
      const phases = activeContentHash === null
        ? ['preparing', 'releasing', 'cleanup_failed', 'applied'] : ['preparing', 'releasing', 'cleanup_failed'];
      const rows = await sql<Array<{ dependent_id: string; owner_id: string; specification_revision: string; phase: string }>>`
        SELECT dependent_id, owner_id, specification_revision, phase FROM harness_shared.blueprint_package_installations
         WHERE workspace_id = ${workspaceId} AND state_revision = ${state}
           AND starts_with(owner_id, ${OWNER_PREFIX}) AND phase IN ${sql(phases)}
         ORDER BY updated_at, dependent_id`;
      const recovered: BlueprintJournalReport['recovered'] = [];
      for (const row of rows) {
        const potSlug = potOf(row.owner_id);
        const dependentId = row.dependent_id;
        if (row.phase === 'applied') {
          const residue = await release(dependentId, {});
          recovered.push({ dependentId, potSlug, outcome: 'cleaned', ...(residue.length ? { error: residue[0]!.error } : {}) });
          continue;
        }
        if (row.phase !== 'preparing') {
          const residue = await release(dependentId, { onlyReleasing: true });
          recovered.push({ dependentId, potSlug, outcome: 'cleaned', ...(residue.length ? { error: residue[0]!.error } : {}) });
          continue;
        }
        // The switch committed but its apply did not: roll forward. A partial
        // preparation cannot apply, so it is compensated like any other.
        if (row.specification_revision === activeContentHash) {
          try {
            const applied = await applyPot(potSlug, dependentId);
            recovered.push({ dependentId, potSlug, outcome: 'rolled-forward',
              ...(applied.residue.length ? { error: applied.residue.map((r) => r.error).join('; ') } : {}) });
            continue;
          } catch { /* fall through to compensation */ }
        }
        const residue = await release(dependentId, { onlyUnapplied: true });
        recovered.push({ dependentId, potSlug, outcome: 'compensated', ...(residue.length ? { error: residue[0]!.error } : {}) });
      }
      return recovered;
    },
    async prepare(contentHash) {
      if (plan.operation === 'uninstall' || contentHash === null) return uninstallAttempt();
      if (plan.operation === 'rollback') return prepareRollback(contentHash);
      return prepareInstall(contentHash, plan.potSlug, plan.bindings, plan.eventKeys ?? []);
    },
  };
}
