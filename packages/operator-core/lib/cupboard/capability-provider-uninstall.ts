/**
 * Dependency-safe capability-provider uninstall review (identities-v1 P-017).
 *
 * Provider packages are ordinary Cupboard plugins/packs, but removing one also
 * invalidates every pot-scoped capability-class binding that points at its exact
 * installed version. This module joins the existing binding reverse edge with
 * the existing installed identity catalog. It owns no new store.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getOrgPg } from '@papercusp/db-org';
import { resolveBlueprintSource } from '@papercusp/orchestrator/blueprint';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import {
  deletePotCapabilityProviderBinding,
  listCapabilityProviderDependents,
  parseCapabilityClassRef,
  type CapabilityProviderDependentRow,
} from '../capability-class-registry-store';
import type { RefusalContract } from '../capability-envelope/identity-refusal-contract';
import { listIdentitySources } from '../agent-identities/source';
import { parseBlueprintSource } from '../agent-tools/blueprint/_resolve';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { activeWorkspaceId } from '../workspace-registry';
import { GLOBAL_PLUGINS_DIR, listPluginsIn } from '../plugin-catalog';
import {
  findCapabilityProviderIdentityDependents,
  type InstalledIdentityGrantView,
} from './capability-grant-resolver';

export interface CapabilityProviderIdentityUninstallDependent {
  potSlug: string;
  identityRef: string;
  classRef: string;
  optional: boolean;
}

/** The runtime-visible consequence of removing one pot/class binding. */
export interface CapabilityUnsatisfiedAfterProviderRemoval {
  code: 'capability_unsatisfied';
  potSlug: string;
  classRef: string;
  providerPackage: string;
  providerVersion: string;
  requiredBy: string[];
  optionalFor: string[];
  routes: ['operator-notify', 'suggest-provider', 'needs_human'];
  detail: string;
  /** WI-10005197: what would lift the unsatisfied state — the same contract the identity gate carries. */
  refusal: RefusalContract;
}

export interface CapabilityProviderUninstallReview {
  providerPackage: string;
  providerVersion: string;
  bindings: CapabilityProviderDependentRow[];
  dependents: CapabilityProviderIdentityUninstallDependent[];
  capabilityUnsatisfied: CapabilityUnsatisfiedAfterProviderRemoval[];
  /** Consent pins the exact reverse-dependency graph shown to the user. */
  reviewToken: string;
}

export interface CapabilityProviderUninstallDeps {
  workspaceId: () => string;
  listInstalledProviders: () => Promise<Array<{ name: string; version: string }>>;
  listProviderBindings: (input: {
    workspaceId: string;
    providerPackage: string;
    providerVersion: string;
  }) => Promise<CapabilityProviderDependentRow[]>;
  listInstalledIdentities: () => Promise<InstalledIdentityGrantView[]>;
  deleteBinding: (input: {
    workspaceId: string;
    potSlug: string;
    classId: string;
    classVersion: string;
    expectedProviderPackage: string;
    expectedProviderVersion: string;
  }) => Promise<boolean>;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

/** Read installed-tier identity declarations through the existing identity catalog. */
async function listInstalledIdentityGrants(): Promise<InstalledIdentityGrantView[]> {
  const out: InstalledIdentityGrantView[] = [];
  const resolve = operatorResolveExtends();
  let after: string | undefined;
  do {
    const page = await listIdentitySources({ after, limit: 100 });
    for (const entry of page.identities) {
      if (entry.tier !== 'installed') continue;
      // Reverse dependency follows the COMPOSED identity, not merely the root
      // document: a child that inherits a required class from its parent still
      // loses that capability when the provider disappears.
      let identity: Record<string, unknown>;
      try {
        identity = resolveBlueprintSource(
          parseBlueprintSource(await readFile(entry.sourcePath, 'utf8')),
          { resolve, sourcePath: entry.sourcePath },
        ).merged;
      } catch {
        continue;
      }
      const grants = identity.grants && typeof identity.grants === 'object' && !Array.isArray(identity.grants)
        ? identity.grants as Record<string, unknown>
        : {};
      const id = typeof identity.id === 'string' && identity.id ? identity.id : entry.id;
      const version = typeof identity.version === 'string' && identity.version ? identity.version : null;
      out.push({
        identityRef: version ? `${id}@${version}` : id,
        requires: stringList(grants.requires),
        optional: stringList(grants.optional),
      });
    }
    after = page.nextAfter ?? undefined;
  } while (after);
  return out;
}

function defaultDeps(): CapabilityProviderUninstallDeps {
  const sql = getOrgPg().sql;
  return {
    workspaceId: activeWorkspaceId,
    listInstalledProviders: async () => listPluginsIn(GLOBAL_PLUGINS_DIR(), 'global'),
    listProviderBindings: (input) => listCapabilityProviderDependents(sql, input),
    listInstalledIdentities: listInstalledIdentityGrants,
    deleteBinding: (input) => deletePotCapabilityProviderBinding(sql, input),
  };
}

function reviewToken(review: Omit<CapabilityProviderUninstallReview, 'reviewToken'>): string {
  return createHash('sha256').update(canonicalJson(review)).digest('hex');
}

/** Build the exact provider/binding/identity graph that must be confirmed. */
export async function reviewCapabilityProviderUninstall(
  providerPackage: string,
  deps: CapabilityProviderUninstallDeps = defaultDeps(),
): Promise<CapabilityProviderUninstallReview> {
  const providers = await deps.listInstalledProviders();
  const installed = providers.find((provider) => provider.name === providerPackage);
  if (!installed) throw new Error(`installed provider package "${providerPackage}" was not found`);

  const workspaceId = deps.workspaceId();
  const [bindings, identities] = await Promise.all([
    deps.listProviderBindings({
      workspaceId,
      providerPackage,
      providerVersion: installed.version,
    }),
    deps.listInstalledIdentities(),
  ]);
  const sortedBindings = [...bindings].sort(
    (a, b) => a.potSlug.localeCompare(b.potSlug) || a.classRef.localeCompare(b.classRef),
  );
  const dependents: CapabilityProviderIdentityUninstallDependent[] = [];
  for (const potSlug of [...new Set(sortedBindings.map((binding) => binding.potSlug))].sort()) {
    const pins = sortedBindings
      .filter((binding) => binding.potSlug === potSlug)
      .map((binding) => ({
        classRef: binding.classRef,
        providerPackage: binding.providerPackage,
        providerVersion: binding.providerVersion,
      }));
    dependents.push(
      ...findCapabilityProviderIdentityDependents({
        providerPackage,
        providerVersion: installed.version,
        pins,
        identities,
      }).map((dependent) => ({ potSlug, ...dependent })),
    );
  }

  const capabilityUnsatisfied = sortedBindings.map((binding): CapabilityUnsatisfiedAfterProviderRemoval => {
    const affected = dependents.filter(
      (dependent) => dependent.potSlug === binding.potSlug && dependent.classRef === binding.classRef,
    );
    const requiredBy = affected.filter((item) => !item.optional).map((item) => item.identityRef).sort();
    const optionalFor = affected.filter((item) => item.optional).map((item) => item.identityRef).sort();
    return {
      code: 'capability_unsatisfied',
      potSlug: binding.potSlug,
      classRef: binding.classRef,
      providerPackage,
      providerVersion: installed.version,
      requiredBy,
      optionalFor,
      routes: ['operator-notify', 'suggest-provider', 'needs_human'],
      detail:
        `Capability class ${binding.classRef} becomes unbound in ${binding.potSlug} when ` +
        `${providerPackage}@${installed.version} is removed.`,
      refusal: {
        observed: {
          potSlug: binding.potSlug,
          classRef: binding.classRef,
          provider: `${providerPackage}@${installed.version}`,
          requiredBy: String(requiredBy.length),
          optionalFor: String(optionalFor.length),
        },
        liftsWhen:
          `an active, conformance-passed provider is bound for ${binding.classRef} in ${binding.potSlug} ` +
          `again — keep ${providerPackage}@${installed.version} installed, or bind a replacement provider ` +
          'before removing it. Retrying the removal cannot lift this: it needs a binding decision',
        whoCanMakeItTrue: ['owner'],
      },
    };
  });
  const base = {
    providerPackage,
    providerVersion: installed.version,
    bindings: sortedBindings,
    dependents,
    capabilityUnsatisfied,
  };
  return { ...base, reviewToken: reviewToken(base) };
}

/** Remove only the exact bindings covered by the reviewed provider version. */
export async function removeReviewedCapabilityProviderBindings(
  review: CapabilityProviderUninstallReview,
  deps: CapabilityProviderUninstallDeps = defaultDeps(),
): Promise<{ removed: number; alreadyChanged: number }> {
  const workspaceId = deps.workspaceId();
  let removed = 0;
  let alreadyChanged = 0;
  for (const binding of review.bindings) {
    const parsed = parseCapabilityClassRef(binding.classRef);
    if (!parsed) {
      alreadyChanged += 1;
      continue;
    }
    const didRemove = await deps.deleteBinding({
      workspaceId,
      potSlug: binding.potSlug,
      classId: parsed.id,
      classVersion: parsed.version,
      expectedProviderPackage: review.providerPackage,
      expectedProviderVersion: review.providerVersion,
    });
    if (didRemove) removed += 1;
    else alreadyChanged += 1;
  }
  return { removed, alreadyChanged };
}
