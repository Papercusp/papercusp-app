/**
 * Capability-provider package closure (identities-v1 P-017 / D-004).
 *
 * This is the two-phase adapter between class-provider selection and the
 * existing plugin/pack installer. Phase one walks the same recursive
 * dependency graph with a sandbox-vetting callback and returns every package
 * plus its immutable permission/dependency receipt. Phase two installs only
 * that reviewed allow-list. No capability binding or identity release should
 * be committed until phase two returns ok.
 */
import { buildPackCatalogView } from '@papercusp/blueprint-distribution';
import type { CapabilityProviderSelection } from './capability-grant-resolver';
import type { DerivedPackCatalog } from './pack-catalog';
import type { InstallPluginManifestReview } from './install-plugin-core';
import {
  resolveAndInstallDeps,
  type DepSet,
  type InstallableUnitRef,
  type ResolveAndInstallResult,
} from './resolve-and-install';

export interface CapabilityProviderPackageRoot {
  providerPackage: string;
  providerVersion: string;
  classRefs: string[];
  kind: 'plugin' | 'pack';
  status: 'installed' | 'installable';
  listingId: string | null;
}

export interface CapabilityProviderPackageReviewUnit {
  name: string;
  version: string;
  kind: 'plugin' | 'pack';
  listingId: string | null;
  review: InstallPluginManifestReview;
}

export interface CapabilityProviderPackageClosureReview {
  ok: boolean;
  roots: CapabilityProviderPackageRoot[];
  /** Complete installable transitive set, in dependency-walk order. */
  units: CapabilityProviderPackageReviewUnit[];
  stillMissing: DepSet;
  advisory: string[];
  rounds: number;
}

export interface CapabilityProviderPackageInstallResult extends ResolveAndInstallResult {
  /** Actual installer receipts for the reviewed units that landed. */
  receipts: CapabilityProviderPackageReviewUnit[];
}

export interface CapabilityProviderPackageClosureDeps {
  deriveCatalog: () => Promise<DerivedPackCatalog>;
  /** Run the real plugin install core against a disposable destination. */
  reviewUnit: (
    unit: InstallableUnitRef,
    expectedProviderVersion?: string,
  ) => Promise<
    | { ok: true; review: InstallPluginManifestReview }
    | { ok: false; error: string }
  >;
  /** Run the real installer, pinned to the review receipt. */
  installUnit?: (
    unit: InstallableUnitRef,
    expectedReview: InstallPluginManifestReview,
  ) => Promise<
    | { ok: true; review: InstallPluginManifestReview; declaredDeps?: Partial<DepSet> }
    | { ok: false; error: string }
  >;
}

const emptyDeps = (): DepSet => ({ tools: [], packs: [], plugins: [], events: [] });

function providerKey(selection: Pick<CapabilityProviderSelection, 'providerPackage' | 'providerVersion'>): string {
  return selection.providerPackage + '@' + selection.providerVersion;
}

/** Review every not-yet-installed selected provider and its transitive closure. */
export async function reviewCapabilityProviderPackageClosure(
  selections: readonly CapabilityProviderSelection[],
  deps: CapabilityProviderPackageClosureDeps,
): Promise<CapabilityProviderPackageClosureReview> {
  const selected = new Map<string, { version: string; classRefs: Set<string> }>();
  const advisory: string[] = [];
  for (const selection of selections) {
    const existing = selected.get(selection.providerPackage);
    if (existing && existing.version !== selection.providerVersion) {
      advisory.push(
        `provider package "${selection.providerPackage}" was selected at conflicting versions ` +
          `${existing.version} and ${selection.providerVersion}`,
      );
      continue;
    }
    const entry = existing ?? { version: selection.providerVersion, classRefs: new Set<string>() };
    entry.classRefs.add(selection.classRef);
    selected.set(selection.providerPackage, entry);
  }

  const initial = await deps.deriveCatalog();
  const roots: CapabilityProviderPackageRoot[] = [];
  const declared: Partial<DepSet> = { packs: [], plugins: [] };
  for (const [providerPackage, selection] of selected) {
    const descriptor = initial.view.byName.get(providerPackage);
    if (!descriptor) {
      advisory.push(`selected provider ${providerKey({ providerPackage, providerVersion: selection.version })} is not installed or Cupboard-listed`);
      continue;
    }
    if (descriptor.source === 'installed') {
      if (descriptor.version !== selection.version) {
        advisory.push(
          `selected provider ${providerKey({ providerPackage, providerVersion: selection.version })} does not match ` +
            `the installed version ${descriptor.version ?? '(unknown)'}`,
        );
        continue;
      }
      roots.push({
        providerPackage,
        providerVersion: selection.version,
        classRefs: [...selection.classRefs].sort(),
        kind: descriptor.kind,
        status: 'installed',
        listingId: descriptor.listingId ?? null,
      });
      continue;
    }
    roots.push({
      providerPackage,
      providerVersion: selection.version,
      classRefs: [...selection.classRefs].sort(),
      kind: descriptor.kind,
      status: 'installable',
      listingId: descriptor.listingId ?? null,
    });
    (descriptor.kind === 'pack' ? declared.packs! : declared.plugins!).push(providerPackage);
  }

  if (advisory.length > 0 || roots.length !== selected.size) {
    return { ok: false, roots, units: [], stillMissing: emptyDeps(), advisory, rounds: 0 };
  }
  if ((declared.packs?.length ?? 0) === 0 && (declared.plugins?.length ?? 0) === 0) {
    return { ok: true, roots, units: [], stillMissing: emptyDeps(), advisory: [], rounds: 0 };
  }

  const reviewed = new Set<string>();
  const units: CapabilityProviderPackageReviewUnit[] = [];
  const expectedRootVersions = new Map(
    roots.map((root) => [root.providerPackage, root.providerVersion] as const),
  );
  const deriveReviewCatalog = async (): Promise<DerivedPackCatalog> => {
    const catalog = await deps.deriveCatalog();
    if (reviewed.size === 0) return catalog;
    const descriptors = catalog.packs.map((descriptor) =>
      reviewed.has(descriptor.name)
        ? { ...descriptor, source: 'installed' as const }
        : descriptor,
    );
    const view = buildPackCatalogView(descriptors, catalog.builtinTools, catalog.view.builtinEvents);
    return { ...catalog, packs: view.packs, view };
  };

  const resolution = await resolveAndInstallDeps(declared, {
    deriveCatalog: deriveReviewCatalog,
    installUnit: async (unit) => {
      const result = await deps.reviewUnit(unit, expectedRootVersions.get(unit.name));
      if (!result.ok) return result;
      if (result.review.name !== unit.name) {
        return {
          ok: false,
          error: `listing ${unit.listingId ?? unit.name} resolved to ${result.review.name}, not ${unit.name}`,
        };
      }
      const kind = result.review.kind === 'pack' ? 'pack' : 'plugin';
      if (kind !== unit.kind) {
        return { ok: false, error: `reviewed unit ${unit.name} is kind=${kind}, not ${unit.kind}` };
      }
      const expectedVersion = expectedRootVersions.get(unit.name);
      if (expectedVersion && result.review.version !== expectedVersion) {
        return {
          ok: false,
          error: `selected provider ${unit.name}@${expectedVersion} resolved to version ${result.review.version}`,
        };
      }
      reviewed.add(unit.name);
      units.push({
        name: unit.name,
        version: result.review.version,
        kind,
        listingId: unit.listingId,
        review: result.review,
      });
      return { ok: true, declaredDeps: result.review.dependencies };
    },
  });

  return {
    ok: resolution.ok,
    roots,
    units,
    stillMissing: resolution.stillMissing,
    advisory: resolution.advisory,
    rounds: resolution.rounds,
  };
}

/** Install a previously reviewed closure; any newly appearing unit is refused. */
export async function installCapabilityProviderPackageClosure(
  review: CapabilityProviderPackageClosureReview,
  deps: CapabilityProviderPackageClosureDeps,
): Promise<CapabilityProviderPackageInstallResult> {
  if (!review.ok) {
    return {
      ok: false,
      installed: [],
      stillMissing: review.stillMissing,
      advisory: [...review.advisory, 'provider package closure was not reviewable'],
      rounds: 0,
      receipts: [],
    };
  }
  if (!deps.installUnit) {
    return {
      ok: false,
      installed: [],
      stillMissing: emptyDeps(),
      advisory: ['provider package installer is unavailable'],
      rounds: 0,
      receipts: [],
    };
  }
  // A peer may have installed a reviewed root between review and consent. That
  // is fine only when the exact selected version landed; never let the generic
  // dep resolver's name-only "already installed" answer silently satisfy a
  // different version.
  const before = await deps.deriveCatalog();
  const changedRoots = review.roots.filter((root) => {
    if (root.status !== 'installable') return false;
    const current = before.view.byName.get(root.providerPackage);
    return current?.source === 'installed' && current.version !== root.providerVersion;
  });
  if (changedRoots.length > 0) {
    return {
      ok: false,
      installed: [],
      stillMissing: emptyDeps(),
      advisory: changedRoots.map((root) => {
        const current = before.view.byName.get(root.providerPackage);
        return `reviewed provider ${providerKey(root)} changed before install; ` +
          `current installed version is ${current?.version ?? '(unknown)'}`;
      }),
      rounds: 0,
      receipts: [],
    };
  }
  const declared: Partial<DepSet> = { packs: [], plugins: [] };
  for (const root of review.roots) {
    if (root.status !== 'installable') continue;
    (root.kind === 'pack' ? declared.packs! : declared.plugins!).push(root.providerPackage);
  }
  const allowed = new Map(review.units.map((unit) => [unit.name, unit] as const));
  const receipts: CapabilityProviderPackageReviewUnit[] = [];
  const resolution = await resolveAndInstallDeps(declared, {
    deriveCatalog: deps.deriveCatalog,
    installUnit: async (unit) => {
      const expected = allowed.get(unit.name);
      if (!expected) {
        return {
          ok: false,
          error: `transitive unit "${unit.name}" was not present in the consented provider review set`,
        };
      }
      const result = await deps.installUnit!(unit, expected.review);
      if (!result.ok) return result;
      receipts.push({ ...expected, review: result.review });
      return { ok: true, declaredDeps: result.declaredDeps ?? result.review.dependencies };
    },
  });
  return { ...resolution, receipts };
}
