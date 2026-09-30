/**
 * install-blueprint-io — the REAL (git + network + resolver) wiring + the
 * dep-closure orchestration for installing a Cupboard blueprint.
 *
 * Extracted (cupboard-agent-tool-coverage-2026-07-14 P-005, D-001 reuse-first)
 * from the inline body of `endpoint-route/routes/cupboard-install-blueprint.ts`
 * so BOTH the loopback HTTP route AND the agent-callable
 * `cupboard:install-blueprint` tool run the exact same logic — no fork.
 *
 * A `kind=blueprint` listing is GitHub-repo-backed; installing it = git-clone the
 * repo, locate `<listing_ref>/blueprint.yaml` (or the root), validate it, and
 * place the dir under `~/.papercusp/blueprints/<id>/`. With `installPlugins:true`
 * the blueprint's declared, Cupboard-resolvable plugin deps auto-install
 * (consent-gated); a blueprint declaring `dependencies.blueprints` pulls each
 * declared work-blueprint that is Cupboard-resolvable and not already present
 * (blueprint-role-bundling P-007 closure). Both closures are best-effort per
 * unit — a failure is reported, not swallowed.
 */
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { parseDepSpec } from '@papercusp/blueprint-distribution';
import { getOrgPg } from '@papercusp/db-org';
import { parse as parseYaml } from 'yaml';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from '../blueprint/installed-blueprints';
import {
  bindCapabilityProviderToPot,
  deletePotCapabilityProviderBinding,
  getPotCapabilityProviderBinding,
  listActiveCapabilityProviderCandidates,
  parseCapabilityClassRef,
  type CapabilityProviderKind,
} from '../capability-class-registry-store';
import { activeWorkspaceId } from '../workspace-registry';
import { potHomeSlugForHarness } from '../hive-federation';
import { resolveCupboardBaseUrl } from './base-url';
import { validateListingManifest, type CupboardReleaseManifest } from './listing-manifest';
import { importCupboardClassContracts, type ClassContractConsent } from './class-contract-payload';
import type { RecipeProviderConsent } from './capability-grant-resolver';
import { derivePackCatalog, depHostSetsFromCatalog } from './pack-catalog';
import {
  installBlueprintFromCupboardCore,
  InstallBlueprintError,
  type InstallBlueprintCoreDeps,
  type InstallBlueprintCoreResult,
} from './install-blueprint-core';
import {
  gitCloneShallow,
  buildInstallPluginDeps,
  installCupboardUnitFromListing,
  reviewCupboardUnitFromListing,
} from './install-io';
import {
  installCapabilityProviderPackageClosure,
  reviewCapabilityProviderPackageClosure,
} from './capability-provider-package-closure';
import {
  BlueprintLifecycleError,
  rollbackBlueprintRelease,
  uninstallBlueprintRelease,
  type BlueprintActivationLayer,
} from './blueprint-release';

/** Install resolves, binds and compensates tool AND inspected recipe providers;
 * recipe selections pass install-core's consent seat first (P-013, D-019). */
const INSTALL_PROVIDER_KINDS: readonly CapabilityProviderKind[] = ['tool', 'recipe'];

export interface InstallBlueprintFromCupboardInput {
  /** Resolve the repo URL + listing_ref from the Cupboard listing. */
  listingId?: string;
  /** OR install a repo directly (listingRef = blueprint subdir). */
  githubUrl?: string;
  listingRef?: string;
  /** Consent to auto-install the blueprint's Cupboard-resolvable plugin deps. */
  installPlugins?: boolean;
  /** Omit for the ordinary latest install. Update installs the latest listed
   *  release; rollback/uninstall operate only on immutable local history. */
  operation?: 'install' | 'update' | 'rollback' | 'uninstall';
  /** Required for rollback/uninstall, where no listing fetch is needed. */
  blueprintId?: string;
  /** Version or package content hash previously installed here. */
  targetVersion?: string;
  /** Combined install-and-activate preflight: ids already chosen for the stack.
   *  The actual desired/applied transition remains the P-040 activation door. */
  activationStack?: string[];
  /** Workspace/pot receiving any capability-class grants declared by the identity. */
  workspaceId?: string;
  potSlug?: string;
  capabilityMode?: 'interactive' | 'agent';
  /** Existing administrator role receiving grants; omit only for a single-role pot. */
  capabilityRole?: string;
  /** Exact class ref to provider package or provider package@version. */
  capabilityProviderSelections?: Readonly<Record<string, string>>;
  /** P-021: consent for the release's class contracts, echoing the exact
   * `consentSubject` a `class_contract_consent_required` refusal returned. */
  classContractConsent?: ClassContractConsent;
  /** P-013: consent to bind selected recipe providers, echoing the exact
   * `consentSubject` a `capability_recipe_provider_consent_required` refusal returned. */
  recipeProviderConsent?: RecipeProviderConsent;
}

export interface InstallBlueprintClosureResult extends InstallBlueprintCoreResult {
  pluginInstalls: Array<{ plugin: string; ok: boolean; error?: string }>;
  blueprintInstalls: Array<{ blueprint: string; ok: boolean; error?: string }>;
}

export type InstallBlueprintFromCupboardResult =
  | { ok: true; result: InstallBlueprintClosureResult | Awaited<ReturnType<typeof rollbackBlueprintRelease>> | Awaited<ReturnType<typeof uninstallBlueprintRelease>> }
  | { ok: false; status: number; error: string; detail?: string; data?: unknown };

/** Resolve a Cupboard listing id → { githubUrl, listingRef }, kind-checked. */
async function resolveBlueprintListing(
  id: string,
): Promise<{
  githubUrl: string;
  listingRef?: string;
  releaseVersion?: string;
  releaseContentHash?: string;
  releaseManifest?: CupboardReleaseManifest;
  moderationApproved: boolean;
} | { error: string; status: number }> {
  const base = resolveCupboardBaseUrl();
  let row: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${base}/listings/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { error: 'listing_not_found_or_unreachable', status: 404 };
    const data = (await res.json()) as Record<string, unknown> | null;
    row =
      (data?.harness as Record<string, unknown> | undefined) ??
      (data?.listing as Record<string, unknown> | undefined) ??
      (data as Record<string, unknown>);
  } catch {
    return { error: 'listing_not_found_or_unreachable', status: 404 };
  }
  if (row?.listing_kind !== 'blueprint') {
    return { error: `listing is kind=${String(row?.listing_kind ?? 'unknown')}, not a blueprint`, status: 422 };
  }
  const githubUrl = typeof row.github_url === 'string' ? row.github_url : '';
  if (!githubUrl) return { error: 'listing has no github_url', status: 422 };
  const listingRef = typeof row.listing_ref === 'string' ? row.listing_ref : undefined;
  const releaseVersion = typeof row.release_version === 'string' ? row.release_version : undefined;
  const releaseContentHash = typeof row.release_content_hash === 'string' ? row.release_content_hash : undefined;
  // Carry the WHOLE signed manifest through to the install gate so the
  // publisher signature can be verified over the bytes it was actually signed
  // over (identities-v1 D-074). Never reconstruct it from the row's other
  // columns: license/publisher/reviewStatus are publisher-supplied, so a
  // second derivation would disagree with publish over valid signatures.
  // A malformed or absent manifest installs unsigned — still refused by the
  // release_content_hash pin — because the bar is a PRESENT signature that
  // fails to verify, not the absence of one (D-073).
  let releaseManifest: CupboardReleaseManifest | undefined;
  const rawManifest = row.release_manifest;
  if (rawManifest != null) {
    let parsed: unknown = rawManifest;
    if (typeof rawManifest === 'string') {
      try {
        parsed = JSON.parse(rawManifest);
      } catch {
        parsed = null;
      }
    }
    const verdict = parsed == null ? null : validateListingManifest(parsed);
    if (verdict?.ok) releaseManifest = verdict.manifest;
  }
  // This is the Cupboard row's moderation status, not the publisher-authored
  // reviewStatus inside the signed release manifest.
  return { githubUrl, listingRef, releaseVersion, releaseContentHash, releaseManifest,
    moderationApproved: row.review_status === 'approved' };
}

function activationLayers(ids: readonly string[] | undefined): BlueprintActivationLayer[] {
  if (!ids?.length) return [];
  const resolver = operatorResolveExtends();
  return [...new Set(ids)].map((id) => {
    const file = resolver(id);
    if (!file) throw new InstallBlueprintError(`activation stack blueprint "${id}" is not installed`, 422);
    const raw = parseYaml(readFileSync(file, 'utf8')) as { slots?: Array<{ slot?: unknown }> } | null;
    const slots = (raw?.slots ?? []).flatMap((entry) => typeof entry.slot === 'string' ? [entry.slot] : []);
    return { id, slots };
  });
}

/** Fetch the set of Cupboard blueprint listing refs — the dep-validator's
 *  `cupboardBlueprints` host set + the spawned-blueprint install closure. Empty
 *  set on any error (offline → conservative). Exported for reuse by other
 *  installers that also drive `installBlueprintFromCupboardCore` (bundle-app
 *  install-io.ts's blueprint leg, D-001 reuse-first). */
export async function fetchCupboardBlueprintIds(): Promise<Set<string>> {
  try {
    const base = resolveCupboardBaseUrl();
    const res = await fetch(`${base}/listings?kind=blueprint&limit=100`, {
      headers: { 'User-Agent': 'papercusp-operator/1' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return new Set(
      (data.results ?? []).map((l) => (typeof l.listing_ref === 'string' ? l.listing_ref : '')).filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Install-core deps (clone + dirs + resolver + host sets), shared by the
 *  top-level install and the recursive spawned-blueprint closure install so both
 *  resolve `dependencies.blueprints` against the same built-in/installed/Cupboard
 *  tiers (blueprint-role-bundling P-007). */
function makeInstallCoreDeps(
  capabilityScope?: { workspaceId: string; potSlug: string },
  registryWorkspaceId?: string,
): InstallBlueprintCoreDeps {
  const classRegistryWorkspace = capabilityScope?.workspaceId ?? registryWorkspaceId;
  return {
    ...(classRegistryWorkspace ? {
      importClassContracts: (input) => importCupboardClassContracts(getOrgPg().sql, {
        ...input,
        workspaceId: classRegistryWorkspace,
        importedBy: 'cupboard:install-blueprint',
      }),
    } : {}),
    cloneRepo: gitCloneShallow,
    installedBlueprintsDir: INSTALLED_BLUEPRINTS_DIR,
    tmpDir: tmpdir,
    resolveExtends: operatorResolveExtends(),
    resolveHostSets: async () => {
      const catalog = await derivePackCatalog({});
      const cupboardBlueprints = await fetchCupboardBlueprintIds();
      return { ...depHostSetsFromCatalog(catalog), cupboardBlueprints, cupboardReachable: catalog.cupboardReachable };
    },
    ...(capabilityScope ? {
      async validateCapabilityGrants(resolution, context) {
        const { validateIdentityInstallGrants } = await import('../capability-envelope/identity-grants-port');
        return validateIdentityInstallGrants({ ...capabilityScope, role: context.role, resolution });
      },
      capabilityGrantDeps: {
        async getPotBinding(classRef: string) {
          const parsed = parseCapabilityClassRef(classRef);
          if (!parsed) return null;
          return getPotCapabilityProviderBinding(getOrgPg().sql, {
            ...capabilityScope,
            classId: parsed.id,
            classVersion: parsed.version,
            providerKinds: INSTALL_PROVIDER_KINDS,
          });
        },
        async listCandidates(classRef: string) {
          const parsed = parseCapabilityClassRef(classRef);
          if (!parsed) return [];
          const rows = await listActiveCapabilityProviderCandidates(
            getOrgPg().sql,
            capabilityScope.workspaceId,
            parsed.id,
            parsed.version,
            { providerKinds: INSTALL_PROVIDER_KINDS },
          );
          return rows.map((row) => ({ ...row, price: null }));
        },
      },
      reviewCapabilityProviderPackages: (selections) =>
        reviewCapabilityProviderPackageClosure(selections, {
          deriveCatalog: () => derivePackCatalog({}),
          reviewUnit: reviewCupboardUnitFromListing,
        }),
      installCapabilityProviderPackages: (review) =>
        installCapabilityProviderPackageClosure(review, {
          deriveCatalog: () => derivePackCatalog({}),
          reviewUnit: reviewCupboardUnitFromListing,
          installUnit: async (unit, expectedReview) => {
            const installed = await installCupboardUnitFromListing(unit, { expectedReview });
            return installed.ok
              ? {
                  ok: true,
                  review: installed.review,
                  declaredDeps: installed.declaredDeps,
                }
              : installed;
          },
        }),
      async commitCapabilitySelections(selections) {
        const sql = getOrgPg().sql;
        const applied = await sql.begin(async (tx) => {
          const changes: Array<{
            classId: string;
            classVersion: string;
            providerPackage: string;
            providerVersion: string;
            previous: Awaited<ReturnType<typeof getPotCapabilityProviderBinding>>;
          }> = [];
          for (const selection of selections) {
            const parsed = parseCapabilityClassRef(selection.classRef);
            if (!parsed) throw new Error('invalid selected class ref ' + selection.classRef);
            const previous = await getPotCapabilityProviderBinding(tx, {
              ...capabilityScope,
              classId: parsed.id,
              classVersion: parsed.version,
              includeInactiveProvider: true,
              providerKinds: INSTALL_PROVIDER_KINDS,
            });
            if (previous?.status === 'active') {
              if (
                previous.providerPackage === selection.providerPackage &&
                previous.providerVersion === selection.providerVersion
              ) {
                continue;
              }
              throw new Error(
                selection.classRef + ' was concurrently bound to ' +
                  previous.providerPackage + '@' + previous.providerVersion,
              );
            }
            await bindCapabilityProviderToPot(tx, {
              ...capabilityScope,
              classId: parsed.id,
              classVersion: parsed.version,
              providerPackage: selection.providerPackage,
              providerVersion: selection.providerVersion,
              boundBy: 'cupboard:install-blueprint',
              providerKind: selection.providerKind,
            });
            changes.push({
              classId: parsed.id,
              classVersion: parsed.version,
              providerPackage: selection.providerPackage,
              providerVersion: selection.providerVersion,
              previous,
            });
          }
          return changes;
        });

        return {
          rollback: async () => {
            await sql.begin(async (tx) => {
              for (const change of [...applied].reverse()) {
                const current = await getPotCapabilityProviderBinding(tx, {
                  ...capabilityScope,
                  classId: change.classId,
                  classVersion: change.classVersion,
                  includeInactiveProvider: true,
                  providerKinds: INSTALL_PROVIDER_KINDS,
                });
                if (
                  !current ||
                  current.providerPackage !== change.providerPackage ||
                  current.providerVersion !== change.providerVersion
                ) {
                  throw new Error(
                    change.classId + '@' + change.classVersion +
                      ' changed after install-time selection; refusing to clobber the newer binding',
                  );
                }
                if (change.previous) {
                  await bindCapabilityProviderToPot(tx, {
                    ...capabilityScope,
                    classId: change.classId,
                    classVersion: change.classVersion,
                    providerPackage: change.previous.providerPackage,
                    providerVersion: change.previous.providerVersion,
                    boundBy: change.previous.boundBy,
                    providerKind: change.previous.providerKind,
                  });
                } else {
                  await deletePotCapabilityProviderBinding(tx, {
                    ...capabilityScope,
                    classId: change.classId,
                    classVersion: change.classVersion,
                    expectedProviderPackage: change.providerPackage,
                    expectedProviderVersion: change.providerVersion,
                  });
                }
              }
            });
          },
        };
      },
    } : {}),
  };
}

/**
 * The ONE orchestrated path that installs a blueprint from the Cupboard by
 * listing id OR direct github url, running the plugin + spawned-blueprint dep
 * closures. Never throws for an expected failure; the caller maps status+error.
 */
export async function installBlueprintFromCupboard(
  input: InstallBlueprintFromCupboardInput,
): Promise<InstallBlueprintFromCupboardResult> {
  const operation = input.operation ?? 'install';
  if (operation === 'rollback' || operation === 'uninstall') {
    const id = input.blueprintId?.trim() ?? '';
    if (!id) return { ok: false, status: 400, error: `blueprintId required for ${operation}` };
    try {
      if (operation === 'uninstall') {
        return { ok: true, result: await uninstallBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id }) };
      }
      const target = input.targetVersion?.trim() ?? '';
      if (!target) return { ok: false, status: 400, error: 'targetVersion required for rollback' };
      return { ok: true, result: await rollbackBlueprintRelease({ installedDir: INSTALLED_BLUEPRINTS_DIR(), id, target }) };
    } catch (error) {
      if (error instanceof BlueprintLifecycleError) return { ok: false, status: error.status, error: error.message };
      return { ok: false, status: 500, error: `${operation} failed`, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
    }
  }

  let githubUrl = typeof input.githubUrl === 'string' ? input.githubUrl.trim() : '';
  let listingRef = typeof input.listingRef === 'string' ? input.listingRef.trim() : undefined;
  let expectedRelease:
    | { version?: string; contentHash?: string; manifest?: CupboardReleaseManifest }
    | undefined;
  let modeApproval: { listingId: string; approvedArtifactContentHash: string } | undefined;

  if (!githubUrl && input.listingId) {
    const resolved = await resolveBlueprintListing(String(input.listingId));
    if ('error' in resolved) return { ok: false, status: resolved.status, error: resolved.error };
    githubUrl = resolved.githubUrl;
    listingRef = listingRef ?? resolved.listingRef;
    expectedRelease = {
      ...(resolved.releaseVersion ? { version: resolved.releaseVersion } : {}),
      ...(resolved.releaseContentHash ? { contentHash: resolved.releaseContentHash } : {}),
      ...(resolved.releaseManifest ? { manifest: resolved.releaseManifest } : {}),
    };
    if (resolved.moderationApproved && resolved.releaseContentHash) {
      modeApproval = { listingId: String(input.listingId), approvedArtifactContentHash: resolved.releaseContentHash };
    }
  }
  if (!githubUrl) return { ok: false, status: 400, error: 'githubUrl or listingId required' };

  const requestedPotSlug = input.potSlug?.trim();
  const workspaceId = input.workspaceId?.trim() || activeWorkspaceId();
  // The storefront's active selection is a HARNESS slug. Capability bindings
  // are pot-scoped, so collapse a member harness to its existing Hive home at
  // the server boundary instead of asking the client to duplicate federation
  // rules or silently binding against the member slug.
  const potSlug = requestedPotSlug
    ? await potHomeSlugForHarness(workspaceId, requestedPotSlug)
    : null;
  // A plain blueprint with no capability grants remains installable outside a
  // pot. If grants are present, the core returns capability_grants_need_pot;
  // that is the accurate failure after the source has actually been parsed.
  const capabilityScope = potSlug
    ? { workspaceId, potSlug }
    : undefined;
  const capabilityContext = capabilityScope
    ? {
        ...capabilityScope,
        mode: input.capabilityMode ?? 'interactive' as const,
        role: input.capabilityRole,
        selections: input.capabilityProviderSelections,
        installProviderPackages: input.installPlugins === true,
        ...(input.recipeProviderConsent ? { recipeProviderConsent: input.recipeProviderConsent } : {}),
      }
    : undefined;

  try {
    const result = await installBlueprintFromCupboardCore({
      githubUrl,
      listingRef,
      activationStack: activationLayers(input.activationStack),
      expectedRelease,
      modeApproval,
      ...(input.classContractConsent ? { classContractConsent: input.classContractConsent } : {}),
      ...(capabilityContext ? { capabilityContext } : {}),
    }, makeInstallCoreDeps(capabilityScope, workspaceId));

    // D-001's consent-gated plugin fetch: with `installPlugins: true`, install
    // each declared plugin resolvable from the Cupboard (not yet installed).
    // Best-effort per plugin — a failed install is reported, not swallowed.
    const pluginInstalls: Array<{ plugin: string; ok: boolean; error?: string }> = [];
    if (input.installPlugins === true && (result.depCheck?.installable.plugins.length ?? 0) > 0) {
      const { installPluginFromCupboardCore } = await import('./install-plugin-core');
      const base = resolveCupboardBaseUrl();
      for (const spec of result.depCheck!.installable.plugins) {
        const { name } = parseDepSpec(spec);
        try {
          const res = await fetch(`${base}/listings?kind=plugin&limit=100`, {
            headers: { 'User-Agent': 'papercusp-operator/1' },
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
          const listing = (data.results ?? []).find((l) => l.listing_ref === name);
          const url = typeof listing?.github_url === 'string' ? listing.github_url : '';
          if (!url) throw new Error('no plugin listing with that ref');
          await installPluginFromCupboardCore({ githubUrl: url, listingRef: name }, buildInstallPluginDeps());
          pluginInstalls.push({ plugin: name, ok: true });
        } catch (e) {
          pluginInstalls.push({ plugin: name, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
    }

    // Spawned-blueprint closure (blueprint-role-bundling P-007): a blueprint
    // declaring `dependencies.blueprints` pulls each declared work-blueprint
    // resolvable from the Cupboard and not already present. Best-effort per unit.
    const blueprintInstalls: Array<{ blueprint: string; ok: boolean; error?: string }> = [];
    const installableBps = result.depCheck?.installable.blueprints ?? [];
    if (installableBps.length > 0) {
      const base = resolveCupboardBaseUrl();
      for (const spec of installableBps) {
        const { name } = parseDepSpec(spec);
        try {
          const res = await fetch(`${base}/listings?kind=blueprint&limit=100`, {
            headers: { 'User-Agent': 'papercusp-operator/1' },
            signal: AbortSignal.timeout(10_000),
          });
          const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
          const listing = (data.results ?? []).find((l) => l.listing_ref === name);
          const url = typeof listing?.github_url === 'string' ? listing.github_url : '';
          if (!url) throw new Error('no blueprint listing with that ref');
          await installBlueprintFromCupboardCore({
            githubUrl: url,
            listingRef: name,
            ...(capabilityContext ? { capabilityContext } : {}),
          }, makeInstallCoreDeps(capabilityScope));
          blueprintInstalls.push({ blueprint: name, ok: true });
        } catch (e) {
          blueprintInstalls.push({ blueprint: name, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
        }
      }
    }

    return { ok: true, result: { ...result, pluginInstalls, blueprintInstalls } };
  } catch (e) {
    if (e instanceof InstallBlueprintError) {
      return {
        ok: false,
        status: e.status,
        error: e.code ?? e.message,
        ...(e.code ? { detail: e.message } : {}),
        ...(e.data === undefined ? {} : { data: e.data }),
      };
    }
    return { ok: false, status: 500, error: 'install failed', detail: e instanceof Error ? e.message.slice(0, 300) : String(e) };
  }
}
