/**
 * Install a blueprint FROM the Cupboard
 * (official-blueprints-cupboard-publish-2026-06-05 P-004 / D-001 / D-004).
 *
 * A `kind=blueprint` listing is GitHub-repo-backed (the Cupboard is a
 * git-listing registry, not a tarball store): the listing points at a repo
 * whose `<listing_ref>/blueprint.yaml` (or root `blueprint.yaml` for a
 * single-blueprint repo) is the blueprint. Installing it = git-clone the repo,
 * locate the blueprint dir, VALIDATE it (schema + semantics via the composed
 * local→installed→built-in resolver, so `extends: base` resolves against the
 * bundled floor — D-004), run the import-time DEP-VALIDATION (tools against
 * the host catalog, plugins against installed+Cupboard — the E2a validator),
 * and place the whole dir (blueprint.yaml + any blueprint-local prompts/)
 * under `~/.papercusp/blueprints/<id>/` — the middle tier of the composed
 * `extends` resolution, where it now shadows the built-in of the same id.
 *
 * Abstract parents (e.g. `base` — no workItem/spine, never loaded standalone)
 * are installable too: they skip the full semantic validation (which requires
 * a runnable shape) and are placed as parent-only blueprints.
 *
 * The core is dependency-injected (clone / installed dir / host capability
 * sets) so it's unit-testable without real git, network, or the tool catalog.
 * The route (`cupboard-install-blueprint.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { BlueprintSourceDocumentSchema, blueprintPackageInputs, resolveBlueprintSource, type ResolveExtendsPath } from '@papercusp/orchestrator/blueprint';
import {
  resolveAndValidateBlueprint,
  validateBlueprintDependencies,
  type BlueprintDependencyValidation,
  type DependencyHostSets,
} from '@papercusp/blueprint-distribution';
import { blueprintRegistrySets } from '../blueprint/registry-sets';
import { registerHarnessOpProxies } from '../harness-ops/proxy';
import { resolveBlueprintPackageInputs, type BlueprintPackageResolver } from '../blueprint/compile-packages';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import {
  BlueprintLifecycleError,
  buildBlueprintReleaseArchive,
  commitBlueprintRelease,
  verifyListedBlueprintRelease,
  type BlueprintActivationLayer,
  type BlueprintActivationPreflight,
  type BlueprintReleaseDiff,
  type BlueprintLifecycleOperation,
} from './blueprint-release';
import {
  ClassContractImportError,
  classContractConsentSubject,
  readClassContractSources,
  type ClassContractConsent,
  type ClassContractPayloadEntry,
  type ImportClassContractsInput,
  type ImportClassContractsResult,
} from './class-contract-payload';
import {
  recipeProviderConsentRefusal,
  recipeProviderConsentSubject,
  resolveCapabilityGrants,
  type CapabilityGrantSet,
  type CapabilityGrantResolutionVerdict,
  type CapabilityGrantResolverDeps,
  type CapabilityProviderSelection,
  type RecipeProviderConsent,
  type ResolveCapabilityGrantOptions,
} from './capability-grant-resolver';
import type {
  CapabilityProviderPackageClosureReview,
  CapabilityProviderPackageInstallResult,
} from './capability-provider-package-closure';
import type { IdentityGrantFailure } from '../capability-envelope/blueprint-envelopes';
import type { CupboardReleaseManifest } from './listing-manifest';

export interface InstallBlueprintCoreInput {
  /** The blueprint repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo blueprint discriminator — the subdir to look in first. */
  listingRef?: string;
  /** Optional combined install-and-activate preflight. Installing into the
   *  library is otherwise allowed even when another stored identity fills the
   *  same exclusive slot (D-029). */
  activationStack?: readonly BlueprintActivationLayer[];
  /** Immutable identity pinned on the Cupboard row. A listed release that does
   *  not match the cloned complete closure is refused before any bytes land. */
  expectedRelease?: {
    version?: string | null;
    contentHash?: string | null;
    /** The whole signed release manifest, verbatim from the listing. A present
     *  signature is verified before any bytes land; absent installs unsigned. */
    manifest?: CupboardReleaseManifest | null;
  };
  /** Trusted Cupboard moderation receipt for this exact listed artifact. Direct
   * GitHub URL installs cannot supply one through the public install door. */
  modeApproval?: { listingId: string; approvedArtifactContentHash: string };
  /** Administrator consent for the release's third-party class contracts
   * (P-021), bound to the exact artifact hash and {ref, contractHash} set that
   * a `class_contract_consent_required` refusal returned. */
  classContractConsent?: ClassContractConsent;
  capabilityContext?: {
    workspaceId: string;
    potSlug: string;
    role?: string;
    mode: ResolveCapabilityGrantOptions['mode'];
    selections?: Readonly<Record<string, string>>;
    /** Consent to install the selected provider packages after their complete
     * transitive review set has been returned/approved. */
    installProviderPackages?: boolean;
    /** Administrator decision on the consentSubject a
     * `capability_recipe_provider_consent_required` refusal returned (P-013). */
    recipeProviderConsent?: RecipeProviderConsent;
  };
}

export interface InstallBlueprintCoreResult {
  ok: true;
  /** The installed blueprint's id (from its blueprint.yaml). */
  id: string;
  version: string | null;
  description: string | null;
  /** True for an abstract parent-only blueprint (no workItem/spine — e.g. `base`). */
  abstract: boolean;
  source: string;
  installedTo: string;
  /** The blueprint's declared dependencies, verbatim (tool-distribution D-002:
   *  tools/packs/plugins; blueprint-role-bundling P-007: spawned-blueprint closure). */
  dependencies: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[] };
  /** Import-time validation, including complete source and bundled-content pins. */
  depCheck: BlueprintDependencyValidation | null;
  operation: Extract<BlueprintLifecycleOperation, 'install' | 'update' | 'no-op'>;
  release: { version: string; contentHash: string; packageContentHash: string };
  diff: BlueprintReleaseDiff;
  activationPreflight: BlueprintActivationPreflight;
  capabilityGrants: CapabilityGrantResolutionVerdict | null;
  capabilityProviderReview: CapabilityProviderPackageClosureReview | null;
  capabilityProviderInstalls: CapabilityProviderPackageInstallResult | null;
  /** Consent-bound class-contract import; null when the release carries none. */
  classContracts: ImportClassContractsResult | null;
}

export interface InstallBlueprintCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the installed-blueprints dir (`~/.papercusp/blueprints`). */
  installedBlueprintsDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
  /**
   * The composed `extends` resolver the validation runs under (real:
   * `operatorResolveExtends()` — installed + built-in tiers, so an installed
   * blueprint's `extends: base` resolves against the bundled floor).
   */
  resolveExtends: ResolveExtendsPath;
  /** Existing local bundle stores by default; injectable for an isolated installer. */
  resolvePackage?: BlueprintPackageResolver;
  /**
   * Host capability sets for the import-time dep-validation. Called only when
   * the blueprint declares dependencies; `cupboardReachable:false` downgrades
   * missing PLUGINS to a warning (mirrors harness:create — a transient
   * Cupboard outage must not false-fail an installable plugin). Missing TOOLS
   * always hard-fail (the catalog is in-process, authoritative).
   */
  resolveHostSets: () => Promise<DependencyHostSets & { cupboardReachable: boolean }>;
  capabilityGrantDeps?: CapabilityGrantResolverDeps;
  validateCapabilityGrants?: (
    resolution: CapabilityGrantResolutionVerdict,
    context: NonNullable<InstallBlueprintCoreInput['capabilityContext']>,
  ) => Promise<readonly IdentityGrantFailure[]>;
  reviewCapabilityProviderPackages?: (
    selections: readonly CapabilityProviderSelection[],
  ) => Promise<CapabilityProviderPackageClosureReview>;
  installCapabilityProviderPackages?: (
    review: CapabilityProviderPackageClosureReview,
  ) => Promise<CapabilityProviderPackageInstallResult>;
  commitCapabilitySelections?: (
    selections: readonly CapabilityProviderSelection[],
  ) => Promise<{ rollback: () => Promise<void> }>;
  /** Consent-bound writer into the destination capability-class registry
   * (`importCupboardClassContracts`, scoped to the install's workspace). */
  importClassContracts?: (
    input: Omit<ImportClassContractsInput, 'workspaceId'>,
  ) => Promise<ImportClassContractsResult>;
}

function classContractInstallError(error: ClassContractImportError, data: Record<string, unknown> = {}): InstallBlueprintError {
  const consent = error.code === 'consent-required' || error.code === 'consent-rejected' || error.code === 'consent-mismatch';
  return new InstallBlueprintError(error.message, consent ? 409 : 422, `class_contract_${error.code}`, {
    refusals: error.refusals,
    ...data,
  });
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

// A blueprint id becomes a directory under ~/.papercusp/blueprints AND the
// `extends`-resolution key, so it must be a safe SINGLE-SEGMENT slug — never a
// path. It is UNTRUSTED (from the cloned repo's blueprint.yaml).
const SAFE_BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export class InstallBlueprintError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'InstallBlueprintError';
  }
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallBlueprintError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Find the blueprint dir within a freshly-cloned repo. A listing ref may point
 * into any canonical publisher layout: a direct multi-blueprint library,
 * `.papercusp/blueprints`, or the first-party `packages/harness/blueprints`
 * library. Fall back to the repo root for a single-blueprint repo.
 */
function locateBlueprintDir(cloneDir: string, listingRef: string | undefined): string {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    for (const relativeRoot of ['', join('.papercusp', 'blueprints'), join('packages', 'harness', 'blueprints')]) {
      const sub = join(cloneDir, relativeRoot, listingRef);
      assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
      candidates.push(sub);
    }
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'blueprint.yaml'))) return dir;
  }
  throw new InstallBlueprintError(
    'no blueprint.yaml found in the blueprint repo (checked canonical listing_ref layouts + root)',
    422,
  );
}

/**
 * Resolve `extends` parents against the CLONED library first, then the host tiers.
 *
 * The listed release pins the cloned complete closure (D-074), and publish resolves
 * parents from the publisher's own library root
 * (`operatorResolveExtends({ localDirs: [sourceRoot] })`). Resolving them from the
 * host tiers alone made the install-side closure depend on the INSTALLER's copy of
 * each parent, so every pin on a blueprint that extends a shared parent (every
 * identity extends `base`) stopped reproducing the moment the host's `base` drifted
 * from the publisher's — a 422 on listing-resolved install for content that was
 * byte-identical to what was attested (WI-10001750 / identities-v1 R-7).
 *
 * Only a multi-blueprint library (a listing ref resolved to `<library>/<ref>`) has
 * sibling parents to offer; a single-blueprint repo root falls straight through to
 * the host tiers, exactly as before. Parents the library does not ship still come
 * from the host, so a repo cannot be required to vendor the built-in floor.
 */
export function cloneFirstResolveExtends(
  cloneDir: string,
  bpDir: string,
  host: ResolveExtendsPath,
): ResolveExtendsPath {
  const libraryRoot = resolve(bpDir) === resolve(cloneDir) ? null : resolve(bpDir, '..');
  return (id: string): string | null => {
    if (libraryRoot && isSafeListingRef(id) && !id.includes('/')) {
      const candidate = join(libraryRoot, id, 'blueprint.yaml');
      assertInside(cloneDir, candidate, `extends "${id}"`);
      if (existsSync(candidate)) return candidate;
    }
    return host(id);
  };
}

/**
 * The blueprint a listing SERVES: where `listingRef` lives inside a clone of the
 * listing's repo, and the resolver that closure is computed with. The ONE seam
 * shared by listing-resolved install and by publish
 * (`POST /cupboard/publish-blueprint`), so the release hash a publisher signs is
 * the hash an installer recomputes BY CONSTRUCTION — both read the same bytes
 * through the same locate + clone-first resolution.
 *
 * Publish used to pin the publisher's LOCAL installed→built-in copy instead. For
 * the official library that copy is not what the public repo serves (its sync
 * projects `apps/operator/prompts` into `base/prompts`), so every identity pin
 * failed to reproduce on install (WI-10001750 / EI-23992492696259433).
 */
export function servedBlueprintSource(
  cloneDir: string,
  listingRef: string | undefined,
  host: ResolveExtendsPath,
): { bpDir: string; blueprintFile: string; resolveExtends: ResolveExtendsPath } {
  const bpDir = locateBlueprintDir(cloneDir, listingRef);
  return {
    bpDir,
    blueprintFile: join(bpDir, 'blueprint.yaml'),
    resolveExtends: cloneFirstResolveExtends(cloneDir, bpDir, host),
  };
}

export async function installBlueprintFromCupboardCore(
  input: InstallBlueprintCoreInput,
  deps: InstallBlueprintCoreDeps,
): Promise<InstallBlueprintCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallBlueprintError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-blueprint-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const { bpDir, resolveExtends } = servedBlueprintSource(cloneDir, input.listingRef, deps.resolveExtends);

    let raw: Record<string, unknown>;
    try {
      const parsed = parseYaml(await fs.readFile(join(bpDir, 'blueprint.yaml'), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a mapping');
      raw = parsed as Record<string, unknown>;
    } catch (e) {
      throw new InstallBlueprintError(
        `blueprint.yaml failed to parse: ${e instanceof Error ? e.message : String(e)}`,
        422,
      );
    }

    // The id is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into, plus the resolution key — single-segment slug only.
    const id = typeof raw.id === 'string' ? raw.id : '';
    if (!SAFE_BLUEPRINT_ID_RE.test(id)) {
      throw new InstallBlueprintError(`unsafe blueprint id ${JSON.stringify(raw.id)} — must be a single-segment slug`, 400);
    }
    const modePolicyRef = (raw.mode as { policyRef?: unknown } | undefined)?.policyRef;
    if (typeof modePolicyRef === 'string' &&
        (!input.modeApproval || !input.expectedRelease?.contentHash ||
         input.modeApproval.approvedArtifactContentHash.toLowerCase() !== input.expectedRelease.contentHash.toLowerCase())) {
      throw new InstallBlueprintError(
        `mode identity "${id}" needs an approved Cupboard listing pinned to its exact release`, 422,
      );
    }

    // Abstract parent-only blueprint (no workItem/spine — `base`): skip the
    // full semantic validation (it requires a runnable shape); it only ever
    // appears as an `extends` parent.
    const abstract = raw.workItem == null && raw.spine == null;
    let dependencies: { tools: string[]; packs: string[]; plugins: string[]; blueprints: string[] } = {
      tools: [],
      packs: [],
      plugins: [],
      blueprints: [],
    };
    let declaredCapabilityGrants: CapabilityGrantSet = {};
    if (!abstract) {
      // P-002: register a PROXY CoordOp per harness-provided op this blueprint
      // declares (`ops:` manifest), BEFORE the resolve+validate snapshots the op
      // registry — so an installed blueprint that ships its own harness ops
      // validates clean (the op name resolves) instead of failing `unknown-op`.
      // Ops are declared on the blueprint that ships them, so the raw manifest is
      // authoritative here. Default-inert when absent.
      const rawOps = (raw as { ops?: unknown }).ops;
      if (Array.isArray(rawOps)) registerHarnessOpProxies(rawOps as Parameters<typeof registerHarnessOpProxies>[0]);
      // P-001: validate the installed blueprint's ops/roles against THIS host's
      // live registries — a marketplace blueprint that names an op the host hasn't
      // registered fails the import with a clear `unknown-op` (422), not a runtime
      // throw after it lands in the installed tier.
      const res = resolveAndValidateBlueprint(raw, resolveExtends, blueprintRegistrySets());
      if (res.parseError) {
        throw new InstallBlueprintError(`blueprint "${id}" failed to resolve: ${res.parseError}`, 422);
      }
      if (!res.ok) {
        const errs = (res.validation?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join('; ');
        throw new InstallBlueprintError(`blueprint "${id}" is invalid: ${errs}`, 422);
      }
      const d = res.blueprint!.dependencies as
        | { tools?: string[]; packs?: string[]; plugins?: string[]; blueprints?: string[] }
        | undefined;
      dependencies = {
        tools: d?.tools ?? [],
        packs: d?.packs ?? [],
        plugins: d?.plugins ?? [],
        blueprints: d?.blueprints ?? [],
      };
    }

    // Source fragments use the same layer walk without inventing runnable fields.
    // Snapshot before copying: the returned existing depCheck pin record retains
    // every consumed parent, prompt file and bundle even after the clone is removed.
    let closure: NonNullable<Parameters<typeof validateBlueprintDependencies>[2]>;
    try {
      const source = resolveBlueprintSource(raw, {
        resolve: resolveExtends,
        sourcePath: join(bpDir, 'blueprint.yaml'),
        lint: { approvedModePolicyRefs: typeof modePolicyRef === 'string' ? [modePolicyRef] : [] },
      });
      if (!source.validation.ok) throw new Error(source.validation.errors.map((error) => error.message).join('; '));
      const resolved = BlueprintSourceDocumentSchema.parse(source.merged);
      // Identities are frequently abstract source fragments. Authority
      // declarations belong to the resolved source, not only runnable spines.
      declaredCapabilityGrants = {
        requires: resolved.grants?.requires ?? [],
        optional: resolved.grants?.optional ?? [],
        suggestedProviders: resolved.grants?.suggestedProviders ?? {},
      };
      const bundles = resolved.bundles ?? [];
      const requests: Array<{ kind: string; ref: string; version?: string }> = [...bundles];
      const knowledge = resolveSeedPackKey(resolved).packId;
      if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
        requests.push({ kind: 'knowledge-pack', ref: knowledge });
      }
      const packages = await resolveBlueprintPackageInputs(requests, deps.resolvePackage);
      closure = { bundles: requests, inputs: [...packages, ...blueprintPackageInputs(source, packages)] };
    } catch (error) {
      throw new InstallBlueprintError(`blueprint "${id}" package resolution failed: ${error instanceof Error ? error.message : String(error)}`, 422);
    }

    // Import-time dep-validation (E2a / D-001): fail upfront with an actionable
    // "needs tool/pack/plugin X", before the blueprint lands in the installed
    // tier. Tools with NO known provider hard-fail (installable-advisory tools
    // are excluded from `missing` by the provider-aware validator); packs/
    // plugins hard-fail only when the Cupboard was actually reachable.
    let depCheck: BlueprintDependencyValidation;
    if (
      dependencies.tools.length > 0 ||
      dependencies.packs.length > 0 ||
      dependencies.plugins.length > 0 ||
      dependencies.blueprints.length > 0
    ) {
      const host = await deps.resolveHostSets();
      depCheck = validateBlueprintDependencies(dependencies, host, closure);
      if (depCheck.missing.tools.length > 0) {
        throw new InstallBlueprintError(
          `blueprint "${id}" tool dependencies unmet: ${depCheck.missing.tools.join(', ')}`,
          422,
        );
      }
      // pack/plugin/blueprint deps hard-fail only when the Cupboard was actually
      // reachable — an installable dep the install path could still pull is not a
      // hard miss, and an offline run can't prove a unit unavailable.
      const missingUnits = [...depCheck.missing.packs, ...depCheck.missing.plugins, ...depCheck.missing.blueprints];
      if (host.cupboardReachable && missingUnits.length > 0) {
        throw new InstallBlueprintError(
          `blueprint "${id}" pack/plugin/blueprint dependencies unmet: ${missingUnits.join(', ')}`,
          422,
        );
      }
    } else {
      depCheck = validateBlueprintDependencies(dependencies, { availableTools: new Set(), installedPlugins: new Set() }, closure);
    }
    if (!depCheck.pins?.length) {
      throw new InstallBlueprintError(`blueprint "${id}" package pins invalid: ${depCheck.messages.join('; ')}`, 422);
    }
    const version = typeof raw.version === 'string'
      ? raw.version
      : depCheck.pins.find((pin) => pin.packageKind === 'blueprint' && pin.ref === id)?.revision ?? 'unversioned';

    // P-021 / D-015: third-party class contracts ride in the signed closure.
    // They enter the destination registry only after the listed release has
    // verified (hash pin + publisher signature) and only with administrator
    // consent bound to this exact artifact and contract set — before grant
    // resolution, so a grant on a novel class resolves against the registry.
    let classContracts: ClassContractPayloadEntry[] = [];
    try {
      classContracts = await readClassContractSources(bpDir);
    } catch (error) {
      if (error instanceof ClassContractImportError) throw classContractInstallError(error);
      throw error;
    }
    let classContractImport: ImportClassContractsResult | null = null;
    if (classContracts.length > 0) {
      let verifiedPublisherLogin: string | null;
      let artifactContentHash: string;
      let closurePins: Array<{ packageKind: string; ref: string }>;
      try {
        const archive = buildBlueprintReleaseArchive(depCheck.pins, id, classContracts);
        ({ verifiedPublisherLogin } = verifyListedBlueprintRelease({
          id, version, archive, expectedRelease: input.expectedRelease,
        }));
        artifactContentHash = archive.package.rootHash;
        closurePins = archive.pins.map((pin) => ({ packageKind: pin.packageKind, ref: pin.ref }));
      } catch (error) {
        if (error instanceof ClassContractImportError) throw classContractInstallError(error);
        if (error instanceof BlueprintLifecycleError) throw new InstallBlueprintError(error.message, error.status);
        throw error;
      }
      const consentSubject = classContractConsentSubject(artifactContentHash, classContracts);
      const review = { consentSubject, contracts: classContracts };
      if (!verifiedPublisherLogin) {
        throw new InstallBlueprintError(
          `blueprint "${id}" carries class contracts but no verified publisher signature; ` +
            'contracts are importable only from a signed Cupboard release',
          422,
          'class_contract_unsigned-publisher',
          review,
        );
      }
      if (!input.classContractConsent) {
        throw new InstallBlueprintError(
          `blueprint "${id}" carries ${classContracts.length} class contract(s) that need administrator consent ` +
            'for this exact artifact before they enter the capability-class registry',
          409,
          'class_contract_consent_required',
          review,
        );
      }
      if (!deps.importClassContracts) {
        throw new InstallBlueprintError(
          'class-contract importer is not configured for this install path',
          500,
          'class_contract_importer_unavailable',
          review,
        );
      }
      try {
        classContractImport = await deps.importClassContracts({
          artifactContentHash,
          publisherLogin: verifiedPublisherLogin,
          entries: classContracts,
          closurePins,
          consent: input.classContractConsent,
          listingRef: input.listingRef ?? id,
        });
      } catch (error) {
        if (error instanceof ClassContractImportError) throw classContractInstallError(error, review);
        throw error;
      }
    }

    let capabilityGrantResolution: CapabilityGrantResolutionVerdict | null = null;
    let capabilityProviderReview: CapabilityProviderPackageClosureReview | null = null;
    let capabilityProviderInstalls: CapabilityProviderPackageInstallResult | null = null;
    const grantCount =
      (declaredCapabilityGrants.requires?.length ?? 0) +
      (declaredCapabilityGrants.optional?.length ?? 0);
    if (grantCount > 0) {
      if (!input.capabilityContext?.workspaceId || !input.capabilityContext.potSlug) {
        throw new InstallBlueprintError(
          'blueprint "' + id + '" declares capability-class grants; workspaceId and potSlug are required for install-time resolution',
          409,
          'capability_grants_need_pot',
        );
      }
      if (!deps.capabilityGrantDeps) {
        throw new InstallBlueprintError(
          'capability grant resolver is not configured for this install path',
          500,
          'capability_grant_resolver_unavailable',
        );
      }
      capabilityGrantResolution = await resolveCapabilityGrants(
        declaredCapabilityGrants,
        deps.capabilityGrantDeps,
        {
          mode: input.capabilityContext.mode,
          selections: input.capabilityContext.selections,
        },
      );
      if (!capabilityGrantResolution.ok) {
        const absent = capabilityGrantResolution.missingRequired;
        const choices = capabilityGrantResolution.requiresChoice;
        const code = absent.length > 0
          ? 'required_capability_provider_absent'
          : 'capability_provider_choice_required';
        const detail = absent.length > 0
          ? 'required capability class provider absent: ' + absent.join(', ')
          : 'provider choice required for capability class: ' + choices.join(', ');
        throw new InstallBlueprintError(detail, 409, code, capabilityGrantResolution);
      }

      // Conformance/authenticity do not grant administrator authority. This
      // seat precedes package installs, binding writes and the release commit.
      if (!deps.validateCapabilityGrants) {
        throw new InstallBlueprintError('capability ceiling validator unavailable', 503, 'capability_policy_unavailable');
      }
      const ceilingFailures = await deps.validateCapabilityGrants(capabilityGrantResolution, input.capabilityContext);
      if (ceilingFailures.length) {
        throw new InstallBlueprintError(
          `capability class ${ceilingFailures[0].classRef ?? '(unknown)'}: ${ceilingFailures[0].cause}`,
          403, 'capability_unsatisfied', { failures: ceilingFailures },
        );
      }

      // A recipe provider runs third-party scripts under the wearer's narrowed
      // principal, so binding one needs consent to its exact pins (D-019).
      const recipeConsentSubject = recipeProviderConsentSubject(
        input.capabilityContext,
        capabilityGrantResolution.selected,
      );
      if (recipeConsentSubject) {
        const refusal = recipeProviderConsentRefusal(
          input.capabilityContext.recipeProviderConsent,
          recipeConsentSubject,
        );
        if (refusal) {
          throw new InstallBlueprintError(
            refusal.detail,
            409,
            'capability_recipe_provider_' + refusal.code,
            { capabilityGrants: capabilityGrantResolution, consentSubject: recipeConsentSubject },
          );
        }
      }

      if (capabilityGrantResolution.selected.length > 0) {
        if (!deps.reviewCapabilityProviderPackages) {
          throw new InstallBlueprintError(
            'capability provider package review is not configured for this install path',
            500,
            'capability_provider_package_reviewer_unavailable',
            capabilityGrantResolution,
          );
        }
        capabilityProviderReview = await deps.reviewCapabilityProviderPackages(
          capabilityGrantResolution.selected,
        );
        if (!capabilityProviderReview.ok) {
          throw new InstallBlueprintError(
            'selected capability provider package closure could not be fully vetted',
            409,
            'capability_provider_package_unavailable',
            { capabilityGrants: capabilityGrantResolution, capabilityProviderReview },
          );
        }
        if (
          capabilityProviderReview.units.length > 0 &&
          input.capabilityContext.installProviderPackages !== true
        ) {
          throw new InstallBlueprintError(
            'selected capability provider packages require install consent after transitive review',
            409,
            'capability_provider_install_consent_required',
            { capabilityGrants: capabilityGrantResolution, capabilityProviderReview },
          );
        }
        if (capabilityProviderReview.units.length > 0) {
          if (!deps.installCapabilityProviderPackages) {
            throw new InstallBlueprintError(
              'capability provider package installer is not configured for this install path',
              500,
              'capability_provider_package_installer_unavailable',
              { capabilityGrants: capabilityGrantResolution, capabilityProviderReview },
            );
          }
          capabilityProviderInstalls = await deps.installCapabilityProviderPackages(
            capabilityProviderReview,
          );
          if (!capabilityProviderInstalls.ok) {
            throw new InstallBlueprintError(
              'selected capability provider package closure failed to install',
              422,
              'capability_provider_package_install_failed',
              {
                capabilityGrants: capabilityGrantResolution,
                capabilityProviderReview,
                capabilityProviderInstalls,
              },
            );
          }
        }
      }
    }

    let rollbackCapabilitySelections: (() => Promise<void>) | null = null;
    if ((capabilityGrantResolution?.selected.length ?? 0) > 0) {
      if (!deps.commitCapabilitySelections) {
        throw new InstallBlueprintError(
          'capability provider choices resolved but this install path cannot persist pot bindings',
          500,
          'capability_binding_writer_unavailable',
          capabilityGrantResolution,
        );
      }
      try {
        rollbackCapabilitySelections = (
          await deps.commitCapabilitySelections(capabilityGrantResolution!.selected)
        ).rollback;
      } catch (error) {
        throw new InstallBlueprintError(
          'capability provider binding failed before blueprint install: ' +
            (error instanceof Error ? error.message : String(error)),
          409,
          'capability_provider_binding_failed',
          capabilityGrantResolution,
        );
      }
    }

    let lifecycle: Awaited<ReturnType<typeof commitBlueprintRelease>>;
    try {
      lifecycle = await commitBlueprintRelease({
        installedDir: deps.installedBlueprintsDir(),
        sourceDir: bpDir,
        id,
        version,
        source: url,
        pins: depCheck.pins ?? [],
        classContracts,
        activationStack: input.activationStack,
        expectedRelease: input.expectedRelease,
        modeApproval: typeof modePolicyRef === 'string' ? {
          listingId: input.modeApproval!.listingId,
          policyRef: modePolicyRef,
          approvedArtifactContentHash: input.modeApproval!.approvedArtifactContentHash,
        } : undefined,
      });
    } catch (error) {
      let rollbackFailure: unknown;
      if (rollbackCapabilitySelections) {
        try {
          await rollbackCapabilitySelections();
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
      }
      if (rollbackFailure) {
        throw new InstallBlueprintError(
          'blueprint release failed and capability binding rollback also failed: ' +
            (rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)),
          500,
          'capability_binding_rollback_failed',
          { releaseError: error, capabilityGrants: capabilityGrantResolution },
        );
      }
      if (error instanceof BlueprintLifecycleError) {
        throw new InstallBlueprintError(error.message, error.status);
      }
      throw error;
    }

    return {
      ok: true,
      id,
      version: typeof raw.version === 'string' ? raw.version : null,
      description: typeof raw.description === 'string' ? raw.description : null,
      abstract,
      source: url,
      installedTo: lifecycle.installedTo,
      dependencies,
      depCheck,
      operation: lifecycle.operation,
      release: {
        version: lifecycle.record.version,
        contentHash: lifecycle.record.artifactContentHash,
        packageContentHash: lifecycle.record.contentHash,
      },
      diff: lifecycle.diff,
      activationPreflight: lifecycle.activationPreflight,
      capabilityGrants: capabilityGrantResolution,
      capabilityProviderReview,
      capabilityProviderInstalls,
      classContracts: classContractImport,
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
