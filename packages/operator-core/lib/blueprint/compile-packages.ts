/**
 * Operator I/O for the existing composition boundary. Resolution reads the local
 * distribution stores; provisioning uses the existing recipe and memory writers.
 * Nothing here installs another identity, changes a session stack or grants tools.
 */
import type { Sql } from 'postgres';
import { dirname, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import {
  compileAgentSpecification,
  CompositionCompilerError,
  BlueprintSourceDocumentSchema,
  loadBlueprintFromFile,
  pinPackageInput,
  resolveBlueprintSource,
  snapshotPackageDirectory,
  validateAgentInputClosure,
  replayAgentSpecification,
  type LoadedBlueprint,
  type ResolveExtendsPath,
  type CompiledAgentSpecification,
  type CompositionCompilerInput,
  type ResolvedCapabilityProviderInput,
  type ResolvedPackageInput,
} from '@papercusp/orchestrator/blueprint';
import { resolveLocalRecipe } from '../cupboard/recipe-store';
import { INSTALLED_BLUEPRINTS_DIR, operatorResolveExtends } from './installed-blueprints';
import { blueprintRegistrySets } from './registry-sets.js';
import { resolveLocalRubric } from '../cupboard/rubric-store';
import { resolveLocalRule } from '../cupboard/rule-store';
import { resolveInstalledEvent } from '../cupboard/event-store';
import { loadKnowledgePack } from '../knowledge-packs/load-packs';
import { resolveSeedPackKey } from '../knowledge-packs/seed-pack-key';
import { resolvePotSlugsForHarnesses } from '../memory/hive-scope';
import type { KnowledgePackMemoryTarget } from '../knowledge-packs/seed';
import { APPLIES_TO_SHAPES, type AppliesTo } from '../knowledge-packs/pack-format';
import { declaredDomainsFor } from '../knowledge-packs/manage';
import {
  getPotCapabilityProviderBinding,
  parseCapabilityClassRef,
  type ProviderBindingRow,
} from '../capability-class-registry-store';
import { grantProviderToolReach, IDENTITY_GRANT_PROVIDER_KINDS } from '../agent-identities/grant-provider-kinds';
import type { IdentityGrantPolicy } from '../capability-envelope/identity-grants-port';
import {
  resolveIdentityClassProvider,
  type IdentityClassProviderResolution,
} from '../agent-identities/class-provider';
import { compileJsonSchema } from '../json-schema-validation';

type PackageRequest = { kind: string; ref: string; version?: string };
export type BlueprintPackageResolver = (request: PackageRequest) => Promise<ResolvedPackageInput | null>;
export type CapabilityProviderResolver = (
  classRef: string,
  potSlug: string,
) => Promise<ProviderBindingRow | null>;
/** Resolve one portable context capability (class@major + verb) for a pot. */
export type ContextCapabilityResolver = (request: {
  potSlug: string;
  classRef: string;
  verb: string;
}) => Promise<IdentityClassProviderResolution>;

type ContextContributionDeclaration = {
  id: string;
  inputKind: string;
  ref: string;
  verb?: string;
  availability?: 'required' | 'optional';
};

/** The contract owns the output shape, so a context capability can only bind
 * when that schema is a compilable, synchronous JSON Schema. */
function contextOutputSchemaRefusal(schema: Record<string, unknown>): string | null {
  try {
    const validate = compileJsonSchema(schema);
    return '$async' in validate && validate.$async ? 'output-schema-async' : null;
  } catch {
    return 'output-schema-invalid';
  }
}

/** Pin a resolved context capability: the exact class@version and conformed
 * provider, plus the contract verb, output schema and explicit execution kind. */
export function contextCapabilityInput(
  resolution: Extract<IdentityClassProviderResolution, { ok: true }>,
): ResolvedCapabilityProviderInput {
  const { provider } = resolution;
  if (provider.providerKind === 'operation' || provider.latencyClass !== 'sync') {
    throw new CompositionCompilerError('input-invalid',
      'context capability providers must be synchronous tool or recipe bindings', resolution.requestedClassRef);
  }
  return {
    ...capabilityProviderInput({ ...provider, classRef: resolution.classRef }),
    context: {
      requestedRef: resolution.requestedClassRef,
      verb: resolution.verb,
      providerKind: provider.providerKind,
      latencyClass: 'sync',
      outputSchema: resolution.contract.outputSchema,
    },
  };
}

export function capabilityProviderInput(
  binding: ProviderBindingRow,
): ResolvedCapabilityProviderInput {
  return {
    kind: 'capability-provider',
    ref: binding.classRef,
    providerPackage: binding.providerPackage,
    providerVersion: binding.providerVersion,
    conformanceRunId: binding.conformanceRunId,
    registryRevision: binding.registryRevision,
    verbBindings: binding.verbBindings,
  };
}

/** The pot/role ceiling a launch evaluates required grants against (P-012, D-040(d)). */
export type GrantCeilingReader = (input: {
  workspaceId: string;
  harnessSlug: string;
  role?: string;
  classRefs: readonly string[];
}) => Promise<Pick<IdentityGrantPolicy, 'ceilings' | 'tools' | 'protectedAdditions'>>;

/**
 * P-012 / D-040(d): refuse a launch whose REQUIRED grant class reaches a tool
 * the current pot/role ceiling excludes. Otherwise it launches a session whose
 * every call the kernel denies. Same predicate and tool reach as install and the
 * per-call kernel. An unreadable ceiling (unregistered target, ambiguous role)
 * is not a refusal: the per-call kernel still denies what it cannot vouch for.
 * Optional classes are not refused here; one above the ceiling grants nothing.
 */
async function refuseRequiredGrantsAboveCeiling(
  bindings: readonly ProviderBindingRow[],
  options: CompileBlueprintPackagesOptions,
): Promise<void> {
  if (bindings.length === 0 || options.readGrantCeiling === null) return;
  const readCeiling = options.readGrantCeiling ??
    (await import('../capability-envelope/identity-grants-port')).readIdentityGrantPolicy;
  let policy: Awaited<ReturnType<GrantCeilingReader>>;
  try {
    policy = await readCeiling({
      workspaceId: options.workspaceId, harnessSlug: options.harnessSlug,
      ...(options.role ? { role: options.role } : {}), classRefs: bindings.map((binding) => binding.classRef),
    });
  } catch {
    return;
  }
  if (!policy.ceilings.length) return;
  const { identityGrantToolFailure } = await import('../capability-envelope/blueprint-envelopes');
  for (const binding of bindings) {
    for (const toolName of grantProviderToolReach(binding) ?? []) {
      const cause = identityGrantToolFailure({ ...policy, toolName });
      if (cause) {
        throw new CompositionCompilerError('input-invalid',
          `required capability class exceeds the pot/role ceiling: ${toolName} is ${cause}`, binding.classRef);
      }
    }
  }
}

/** Where a blueprint repo vendors its bundled packages (D-037): `<dir>/packages/<kind>/<ref>/`. */
export const VENDORED_PACKAGES_DIR = 'packages';

/** Snapshot one package through the local stores' own readers. `vendoredDir`
 * narrows every reader to that one directory instead of the host roots. */
async function resolveStoredBlueprintPackage(
  request: PackageRequest, vendoredDir?: string,
): Promise<ResolvedPackageInput | null> {
  const only = (kind: string) => vendoredDir ? [{ dir: join(vendoredDir, kind), layer: 'user' as const }] : undefined;
  if (request.kind === 'recipe') {
    const asset = resolveLocalRecipe(request.ref, only('recipe'));
    if (!asset) return null;
    const { dir, layer: _layer, source: _source, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'recipe', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'rubric') {
    const asset = resolveLocalRubric(request.ref, only('rubric'));
    if (!asset) return null;
    const { dir, layer: _layer, source: _source, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'rubric', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'rule') {
    const asset = resolveLocalRule(request.ref, only('rule'));
    if (!asset) return null;
    const { dir, layer: _layer, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'rule', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'event') {
    // A vendored event resolves from <repo>/packages/event/ (D-037, D-042);
    // install claims its key before the async rule that fires on it.
    const asset = resolveInstalledEvent(request.ref, only('event'));
    if (!asset) return null;
    const { dir, source: _source, ...value } = asset;
    return snapshotPackageDirectory({ packageKind: 'event', ref: request.ref, revision: asset.version, dir, value });
  }
  if (request.kind === 'knowledge-pack') {
    const asset = await loadKnowledgePack(request.ref,
      vendoredDir ? { roots: [{ dir: join(vendoredDir, 'knowledge-pack'), source: 'installed' }] } : {});
    if (!asset) return null;
    if (!asset.directory || asset.warnings.length) {
      throw new CompositionCompilerError('package-read-failed', asset.warnings.join('; ') || 'resolved directory missing', request.ref);
    }
    return snapshotPackageDirectory({
      packageKind: 'knowledge-pack', ref: request.ref, revision: asset.pack.manifest.version,
      dir: asset.directory, value: asset.pack,
    });
  }
  throw new CompositionCompilerError('package-missing', 'no installed content resolver for package kind ' + request.kind, request.ref);
}

const satisfies = (pin: ResolvedPackageInput | null, request: PackageRequest) =>
  pin !== null && (!request.version || pin.revision === request.version);

/** Use the existing resolution precedence and snapshot the directory actually
 * selected. When the host stores hold no package of the requested ref/version,
 * the active installed releases' retained closures are the next tier (D-037):
 * a bundled package resolves from the release that shipped it. */
export const resolveLocalBlueprintPackage: BlueprintPackageResolver = async (request) => {
  const local = await resolveStoredBlueprintPackage(request);
  if (satisfies(local, request)) return local;
  const { resolveInstalledReleasePackage } = await import('../cupboard/blueprint-release');
  return (await resolveInstalledReleasePackage(INSTALLED_BLUEPRINTS_DIR(), request)) ?? local;
};

/** Resolve a repo's vendored packages first, then `host` (D-037) — the package
 * half of the clone-first seam publish and install share. */
export function vendoredBlueprintPackageResolver(
  blueprintDir: string, host: BlueprintPackageResolver = resolveLocalBlueprintPackage,
): BlueprintPackageResolver {
  const vendoredDir = join(blueprintDir, VENDORED_PACKAGES_DIR);
  return async (request) => {
    const vendored = await resolveStoredBlueprintPackage(request, vendoredDir);
    return satisfies(vendored, request) ? vendored : host(request);
  };
}

/** Resolve the exact transitive graph once per compile; conflicting demands never overwrite. */
export async function resolveBlueprintPackageInputs(
  requests: readonly PackageRequest[],
  resolvePackage: BlueprintPackageResolver = resolveLocalBlueprintPackage,
): Promise<ResolvedPackageInput[]> {
  const resolved = new Map<string, Promise<ResolvedPackageInput>>();
  const selected = new Map<string, ResolvedPackageInput>();
  const visit = async (request: PackageRequest, ancestors: readonly string[]): Promise<ResolvedPackageInput> => {
    const key = request.kind + ':' + request.ref;
    if (ancestors.includes(key)) throw new CompositionCompilerError('package-pin-conflict', 'cyclic package dependency: ' + [...ancestors, key].join(' -> '), key);
    let pending = resolved.get(key);
    if (!pending) {
      pending = (async () => {
        const pin = await resolvePackage(request);
        if (!pin) throw new CompositionCompilerError('package-missing', 'required package is not installed', key);
        if (pin.packageKind !== request.kind || pin.ref !== request.ref) {
          throw new CompositionCompilerError('package-pin-conflict', 'resolver returned a different package', key);
        }
        selected.set(key, pin);
        return pin;
      })();
      resolved.set(key, pending);
    }
    const pin = await pending;
    if (request.version && request.version !== pin.revision) {
      throw new CompositionCompilerError('package-pin-conflict', 'requires ' + request.version + ', selected ' + pin.revision, key);
    }
    await Promise.all(pin.dependencies.map((dependency) => visit({
      kind: dependency.packageKind, ref: dependency.ref, version: dependency.revision,
    }, [...ancestors, key])));
    return pin;
  };
  await Promise.all(requests.map((request) => visit(request, [])));
  const inputs = [...selected.values()].sort((a, b) => (a.packageKind + ':' + a.ref).localeCompare(b.packageKind + ':' + b.ref));
  validateAgentInputClosure(inputs);
  return inputs;
}

export interface CompileBlueprintPackagesOptions {
  workspaceId: string;
  harnessSlug: string;
  /** Preserve the authored source path and inheritance resolver for abstract identities. */
  sourcePath?: string;
  resolve?: ResolveExtendsPath;
  /** For a not-yet-registered target; existing harnesses resolve through the shared registry. */
  memoryTarget?: KnowledgePackMemoryTarget;
  /** Pin the selection, so replay never consults changing detection or hive settings. */
  knowledgeSelection?: { shapes?: readonly AppliesTo[]; domains?: readonly string[] };
  resolvePackage?: BlueprintPackageResolver;
  /** Exact target pot; inferred from the harness registry when omitted. */
  potSlug?: string;
  resolveCapabilityProvider?: CapabilityProviderResolver;
  /** The worker role the artifact launches as; selects the pot's role ceiling. */
  role?: string;
  /** Current pot/role ceiling for required grants; `null` skips the launch check. */
  readGrantCeiling?: GrantCeilingReader | null;
  /** Context capabilities resolve through the pot's attested class choices by default. */
  resolveContextCapability?: ContextCapabilityResolver;
  /** Prompt, addressed-document and versioned policy inputs belong to this same boundary. */
  input?: Omit<CompositionCompilerInput, 'source' | 'blueprint' | 'loaded' | 'sourcePath'>;
}

export async function compileBlueprintWithPackages(
  loaded: LoadedBlueprint | Record<string, unknown>,
  options: CompileBlueprintPackagesOptions,
): Promise<CompiledAgentSpecification> {
  const isLoaded = 'blueprint' in loaded && 'validation' in loaded && 'layers' in loaded;
  const resolve = options.resolve ?? options.input?.resolve;
  const resolved = isLoaded ? loaded as LoadedBlueprint : resolveBlueprintSource(loaded, {
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(resolve ? { resolve } : {}),
    ...(options.input?.lint ? { lint: options.input.lint } : {}),
  });
  if (!resolved.validation.ok) {
    throw new CompositionCompilerError('source-invalid',
      'package composition source has validation errors', options.sourcePath);
  }
  const blueprint = isLoaded ? (resolved as LoadedBlueprint).blueprint
    : BlueprintSourceDocumentSchema.parse((resolved as ReturnType<typeof resolveBlueprintSource>).merged);
  const requests: PackageRequest[] = [...(blueprint.bundles ?? [])];
  const knowledge = resolveSeedPackKey(blueprint).packId;
  if (knowledge && !requests.some((request) => request.kind === 'knowledge-pack' && request.ref === knowledge)) {
    requests.push({ kind: 'knowledge-pack', ref: knowledge });
  }
  for (const operation of blueprint.operations ?? []) {
    const ref = operation.acceptance.rubric;
    if (!ref || requests.some((request) => request.kind === 'rubric' && request.ref === ref.ref) ||
        options.input?.inputClosure?.some((entry) =>
          entry.kind === 'package' && entry.packageKind === 'rubric' && entry.ref === ref.ref)) continue;
    requests.push({ kind: 'rubric', ref: ref.ref, version: ref.revision });
  }
  const packages = await resolveBlueprintPackageInputs(requests, options.resolvePackage);
  if (packages.some((pin) => pin.packageKind === 'recipe')) {
    // The launch-time journal refuses a malformed recipe; refuse it here first.
    const { recipeValue } = await import('./package-recipe-resources');
    for (const pin of packages) {
      if (pin.packageKind !== 'recipe') continue;
      try { recipeValue(pin); } catch (error) {
        throw new CompositionCompilerError('input-invalid', error instanceof Error ? error.message : String(error), pin.ref);
      }
    }
  }
  const externalProgramPins: ResolvedPackageInput[] = [];
  const selectedProgramRefs = new Map<string, { revision: string; contentHash: string }>();
  const sourcePath = options.sourcePath ?? (isLoaded ? (loaded as LoadedBlueprint).sourcePath : null);
  const fallbackResolve = operatorResolveExtends({
    localDirs: sourcePath ? [join(dirname(sourcePath), 'blueprints')] : [],
  });
  for (const operation of blueprint.operations ?? []) {
    const ref = operation.execution?.kind === 'program' ? operation.execution.blueprint : undefined;
    if (!ref) continue;
    const prior = selectedProgramRefs.get(ref.ref);
    if (prior && (prior.revision !== ref.revision || prior.contentHash !== ref.contentHash)) {
      throw new CompositionCompilerError('package-pin-conflict',
        'operations require different revisions of the same external program', ref.ref);
    }
    if (prior) continue;
    selectedProgramRefs.set(ref.ref, { revision: ref.revision, contentHash: ref.contentHash });
    const packageRef = `operation:${ref.ref}`;
    const supplied = options.input?.inputClosure?.some((entry) =>
      entry.kind === 'package' && entry.packageKind === 'blueprint' && entry.ref === packageRef);
    if (supplied) continue;
    const path = (resolve?.(ref.ref) ?? fallbackResolve(ref.ref));
    if (!path) throw new CompositionCompilerError('package-missing', 'external program blueprint is not installed', ref.ref);
    const external = loadBlueprintFromFile(path, resolve ?? fallbackResolve, blueprintRegistrySets());
    if (external.blueprint.id !== ref.ref || external.blueprint.version !== ref.revision ||
        external.contentHash !== ref.contentHash) {
      throw new CompositionCompilerError('package-pin-conflict',
        'installed external program blueprint differs from its declared version or resolved content hash', ref.ref);
    }
    externalProgramPins.push(pinPackageInput({
      packageKind: 'blueprint', ref: packageRef, revision: ref.revision,
      files: [], dependencies: [], value: external.blueprint,
    }));
  }
  const requiredClasses = new Set(blueprint.grants?.requires ?? []);
  const optionalClasses = (blueprint.grants?.optional ?? [])
    .filter((ref) => !requiredClasses.has(ref));
  const classRefs = [...requiredClasses, ...optionalClasses];
  const contextContributions = ((blueprint as { contributions?: readonly ContextContributionDeclaration[] })
    .contributions ?? []).filter((entry) => entry.inputKind === 'capability-provider' && entry.verb !== undefined);
  // A sync context rule (P-011, D-023) names the same class@major + verb a
  // contribution does, so it binds through the same resolver below.
  const syncContextRules = packages.flatMap((pin) => {
    if (pin.packageKind !== 'rule') return [];
    const value = pin.value as { delivery?: unknown; context?: { ref: string; verb: string } } | null;
    return value?.delivery === 'sync' && value.context ? [{ ref: pin.ref, context: value.context }] : [];
  });
  let resolvedPotSlug = options.potSlug;
  if (!resolvedPotSlug && (classRefs.length > 0 || contextContributions.length > 0 || syncContextRules.length > 0)) {
    const pots = await resolvePotSlugsForHarnesses(options.workspaceId, [options.harnessSlug]);
    resolvedPotSlug = pots[0] ?? options.harnessSlug;
  }
  const resolveCapabilityProvider: CapabilityProviderResolver =
    options.resolveCapabilityProvider ??
    (async (classRef, potSlug) => {
      const parsed = parseCapabilityClassRef(classRef);
      if (!parsed) return null;
      return getPotCapabilityProviderBinding(getOrgPg().sql, {
        workspaceId: options.workspaceId,
        potSlug,
        classId: parsed.id,
        classVersion: parsed.version,
        providerKinds: IDENTITY_GRANT_PROVIDER_KINDS,
      });
    });
  const capabilityProviders: ResolvedCapabilityProviderInput[] = [];
  const requiredBindings: ProviderBindingRow[] = [];
  if (resolvedPotSlug) {
    for (const classRef of classRefs) {
      const binding = await resolveCapabilityProvider(classRef, resolvedPotSlug);
      if (!binding) {
        if (requiredClasses.has(classRef)) {
          throw new CompositionCompilerError(
            'input-invalid',
            'required capability class has no active pot provider binding',
            classRef,
          );
        }
        continue;
      }
      if (requiredClasses.has(classRef)) requiredBindings.push(binding);
      capabilityProviders.push(capabilityProviderInput(binding));
    }
  }
  await refuseRequiredGrantsAboveCeiling(requiredBindings, options);
  // Context capabilities (P-004): each declared class@major + verb resolves to the
  // newest stable version THIS pot selected, its passing conformed provider, and the
  // contract's output schema. Unknown, unbound, unconformed, async or schema-less
  // classes never bind silently: required → compile refusal; optional → an explicit
  // `unavailable` omission receipt naming the resolver code.
  const resolveContextCapability: ContextCapabilityResolver = options.resolveContextCapability ??
    ((request) => resolveIdentityClassProvider(getOrgPg().sql, { workspaceId: options.workspaceId, ...request }));
  const callerOmissions = new Set((options.input?.contributionOmissions ?? []).map((omission) => omission.id));
  const contextOmissions: Array<{ id: string; reason: 'unavailable'; errorRef: string }> = [];
  for (const contribution of contextContributions) {
    if (callerOmissions.has(contribution.id)) continue;
    const resolution: IdentityClassProviderResolution = resolvedPotSlug
      ? await resolveContextCapability({ potSlug: resolvedPotSlug, classRef: contribution.ref, verb: contribution.verb! })
      : { ok: false, requestedClassRef: contribution.ref, code: 'class-unbound' };
    const code = resolution.ok ? contextOutputSchemaRefusal(resolution.contract.outputSchema) : resolution.code;
    if (resolution.ok && !code) {
      capabilityProviders.push(contextCapabilityInput(resolution));
      continue;
    }
    if (contribution.availability === 'optional') {
      contextOmissions.push({ id: contribution.id, reason: 'unavailable', errorRef: `capability-class:${code}` });
      continue;
    }
    throw new CompositionCompilerError('input-invalid',
      `context capability ${contribution.ref}#${contribution.verb} cannot bind: ${code}`, contribution.id);
  }
  // A worn rule has no optional form: an operation, asynchronous, unbound or
  // schema-less provider refuses the bind here instead of omitting on every turn.
  for (const rule of syncContextRules) {
    const resolution: IdentityClassProviderResolution = resolvedPotSlug
      ? await resolveContextCapability({ potSlug: resolvedPotSlug, classRef: rule.context.ref, verb: rule.context.verb })
      : { ok: false, requestedClassRef: rule.context.ref, code: 'class-unbound' };
    const code = resolution.ok ? contextOutputSchemaRefusal(resolution.contract.outputSchema) : resolution.code;
    if (!resolution.ok || code) {
      throw new CompositionCompilerError('input-invalid',
        `sync rule ${rule.ref} context ${rule.context.ref}#${rule.context.verb} cannot bind: ${code}`, rule.ref);
    }
    const input = contextCapabilityInput(resolution);
    // The closure keys a provider pin by class and a pot binds one provider per
    // class, so a class already pinned by a grant or contribution is not re-pinned.
    if (!capabilityProviders.some((entry) => entry.ref === input.ref)) capabilityProviders.push(input);
  }
  let memoryTarget = options.memoryTarget;
  if (!memoryTarget && packages.some((pin) => pin.packageKind === 'knowledge-pack')) {
    const pots = await resolvePotSlugsForHarnesses(options.workspaceId, [options.harnessSlug]);
    memoryTarget = pots[0] ? { kind: 'hive', slug: pots[0] } : { kind: 'harness', slug: options.harnessSlug };
  }
  const scope = { workspaceId: options.workspaceId, harnessSlug: options.harnessSlug,
    ...(memoryTarget ? { memoryTarget } : {}),
    ...(packages.some((pin) => pin.packageKind === 'knowledge-pack') ? {
      knowledgeSelection: {
        shapes: [...new Set(options.knowledgeSelection?.shapes ?? [])].sort(),
        domains: [...new Set(options.knowledgeSelection?.domains ?? (memoryTarget?.kind === 'hive'
          ? await declaredDomainsFor(options.workspaceId, memoryTarget.slug) : undefined) ?? [])].sort(),
      },
    } : {}),
  };
  return compileAgentSpecification({
    ...options.input,
    source: loaded,
    ...(isLoaded ? {} : { sourcePath: options.sourcePath, resolve }),
    inputClosure: [
      ...packages,
      ...capabilityProviders,
      ...externalProgramPins,
      ...(options.input?.inputClosure ?? []),
    ],
    settings: [
      ...(options.input?.settings ?? []),
      { ref: 'bundle-scope', revision: '1', value: scope },
    ],
    ...(contextOmissions.length ? {
      contributionOmissions: [...(options.input?.contributionOmissions ?? []), ...contextOmissions],
    } : {}),
  });
}

export interface BlueprintPackageScope {
  workspaceId: string;
  harnessSlug: string;
  memoryTarget?: KnowledgePackMemoryTarget;
  knowledgeSelection?: { shapes: AppliesTo[]; domains: string[] };
}

export interface BlueprintPackageProvisioners {
  recipe: (pin: ResolvedPackageInput, scope: BlueprintPackageScope) => Promise<void>;
  rubric: (pin: ResolvedPackageInput, scope: BlueprintPackageScope) => Promise<void>;
  knowledge: (pin: ResolvedPackageInput, scope: BlueprintPackageScope) => Promise<void>;
}

/** Provision only explicit bundles, from verified snapshots, before a host applies the artifact. */
export async function provisionBlueprintPackages(
  artifact: CompiledAgentSpecification,
  provisioners: BlueprintPackageProvisioners,
): Promise<void> {
  const specification = replayAgentSpecification(artifact);
  const scopeInput = specification.inputs.find((entry) => entry.kind === 'setting' && entry.ref === 'bundle-scope');
  const scope = scopeInput?.kind === 'setting' ? scopeInput.value as Partial<BlueprintPackageScope> : null;
  if (typeof scope?.workspaceId !== 'string' || !scope.workspaceId.trim() ||
      typeof scope.harnessSlug !== 'string' || !scope.harnessSlug.trim()) {
    throw new CompositionCompilerError('setting-invalid', 'bundle provisioning needs an explicit workspace and harness');
  }
  const target: BlueprintPackageScope = { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
    ...(scope.memoryTarget ? { memoryTarget: scope.memoryTarget } : {}),
    ...(scope.knowledgeSelection ? { knowledgeSelection: scope.knowledgeSelection } : {}) };
  const bundles = specification.configuration.bundles ?? [];
  const packages = validateAgentInputClosure(specification.inputs).filter((entry): entry is ResolvedPackageInput => entry.kind === 'package');
  const byKey = new Map(packages.map((pin) => [pin.packageKind + ':' + pin.ref, pin]));
  const included = new Set<string>();
  const include = (key: string): void => {
    if (included.has(key)) return;
    included.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) include(dependency.packageKind + ':' + dependency.ref);
  };
  for (const bundle of bundles) include(bundle.kind + ':' + bundle.ref);
  const seedPack = resolveSeedPackKey(specification.configuration).packId;
  if (seedPack) {
    const key = 'knowledge-pack:' + seedPack;
    if (!byKey.has(key)) throw new CompositionCompilerError('package-missing', 'declared seed pack has no resolved content', key);
    include(key);
  }
  const pins = packages.filter((pin) => included.has(pin.packageKind + ':' + pin.ref));
  // Fully validate before any side effect. Rubrics are attached as immutable input
  // values; interpreting their criteria does not require rewriting the rubric store.
  for (const pin of pins) {
    if ((pin.packageKind === 'recipe' || pin.packageKind === 'rubric' || pin.packageKind === 'knowledge-pack') &&
        (!pin.value || typeof pin.value !== 'object')) {
      throw new CompositionCompilerError('input-invalid', 'bundle lacks its parsed content', pin.ref);
    }
    if (pin.packageKind === 'knowledge-pack' &&
        (!target.memoryTarget || !['hive', 'harness'].includes(target.memoryTarget.kind) ||
          typeof target.memoryTarget.slug !== 'string' || !target.memoryTarget.slug.trim())) {
      throw new CompositionCompilerError('setting-invalid', 'knowledge provisioning needs its resolved memory target', pin.ref);
    }
    if (pin.packageKind === 'knowledge-pack' &&
        (!target.knowledgeSelection || !Array.isArray(target.knowledgeSelection.shapes) ||
          !target.knowledgeSelection.shapes.every((shape) => APPLIES_TO_SHAPES.includes(shape)) ||
          !Array.isArray(target.knowledgeSelection.domains) ||
          !target.knowledgeSelection.domains.every((domain) => typeof domain === 'string'))) {
      throw new CompositionCompilerError('setting-invalid', 'knowledge provisioning needs its pinned shape/domain selection', pin.ref);
    }
  }
  for (const pin of pins) {
    if (pin.packageKind === 'recipe') await provisioners.recipe(pin, target);
    else if (pin.packageKind === 'rubric') await provisioners.rubric(pin, target);
    else if (pin.packageKind === 'knowledge-pack') await provisioners.knowledge(pin, target);
  }
}

/** Existing stores, with no-clobber registration and the existing reviewed memory install. */
export function blueprintPackageProvisioners(sql: Sql, resourceInstall?: {
  dependentId: string;
}): BlueprintPackageProvisioners {
  return {
    async recipe(pin, scope) {
      if (resourceInstall) {
        // Journaled exact-row ownership: released with the wearer's installation.
        const { prepareRecipePackageResource } = await import('./package-recipe-resources');
        await prepareRecipePackageResource(sql, { pin, workspaceId: scope.workspaceId,
          dependentId: resourceInstall.dependentId });
        return;
      }
      const { getRecipe, upsertRecipe } = await import('../code-recipes-store');
      const value = pin.value as { id: string; title: string; description: string; script: string; toolsUsed: string[]; tags: string[] };
      const current = await getRecipe(sql, value.id);
      if (current) {
        if (current.script !== value.script || current.bindingSchema !== null || current.capabilityManifest !== null) {
          throw new CompositionCompilerError('package-pin-conflict', 'registered recipe differs; explicit migration is required', pin.ref);
        }
        return;
      }
      await upsertRecipe(sql, {
        id: value.id, title: value.title, description: value.description, script: value.script,
        toolsUsed: value.toolsUsed, tags: value.tags, potSlug: null,
        authorRole: 'blueprint-bundle', createdBy: 'blueprint-package:' + pin.contentHash,
        createOnly: true,
      });
    },
    async rubric(pin, scope) {
      const { provisionPinnedRubric } = await import('../rubrics');
      await provisionPinnedRubric(pin.value as import('../cupboard/rubric-store').RubricSeedSource, scope.workspaceId);
    },
    async knowledge(pin, scope) {
      if (resourceInstall) {
        const { prepareKnowledgePackageResources } = await import('./package-knowledge-resources');
        await prepareKnowledgePackageResources(sql, { pin, workspaceId: scope.workspaceId,
          harnessSlug: scope.harnessSlug, memoryTarget: scope.memoryTarget!,
          shapes: scope.knowledgeSelection!.shapes, domains: scope.knowledgeSelection!.domains,
          dependentId: resourceInstall.dependentId });
        return;
      }
      const { classifyPackInstall, applyPackInstall } = await import('../knowledge-packs/manage');
      const pack = pin.value as import('../knowledge-packs/pack-format').KnowledgePack;
      const review = await classifyPackInstall({ potSlug: scope.harnessSlug, pack,
        memoryTarget: scope.memoryTarget, ...scope.knowledgeSelection, requireExactContent: true });
      if (review.conflicts > 0) throw new CompositionCompilerError('package-pin-conflict', 'knowledge pack conflicts with scoped memory; explicit review is required', pin.ref);
      const result = await applyPackInstall({
        ...scope, potSlug: scope.harnessSlug, pack, review, memoryTarget: scope.memoryTarget,
        createdBy: 'blueprint-package:' + pin.contentHash,
      });
      if (!result.ok || result.failed) throw new CompositionCompilerError('package-read-failed', result.error ?? 'knowledge seed failed', pin.ref);
    },
  };
}
