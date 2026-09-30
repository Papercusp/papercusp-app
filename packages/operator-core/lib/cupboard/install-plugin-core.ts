/**
 * Install a plugin FROM the Cupboard (revive-cupboard-distribution-2026-06-04
 * D-003 / P2). The Cupboard is a GitHub-repo-backed listing registry — a
 * `kind=plugin` listing points at the plugin's GitHub repo (+ a `listing_ref`
 * discriminator when the repo hosts several). Installing it = git-clone the
 * repo, locate the plugin's `papercusp.json`, place it under global-plugins, and
 * wire the existing capability-gate + install-consent path (D-009): the
 * manifest's declared capabilities are recorded as grants for the target harness
 * when the caller consents.
 *
 * This REPLACES the dead `:3057`/CLI tarball install (D-004) with a git clone —
 * the model the Cupboard already uses for every other listing kind.
 *
 * The core is dependency-injected (clone / global-plugins dir / grant /
 * host-invalidate) so it's unit-testable without real git, network, PG, or the
 * route registry. The route (`install-plugin.ts`) wires the real impls.
 */
import { promises as fs, existsSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import type { PluginTriggerPack } from '@papercusp/plugin-sdk';
import { isCompilableSchema } from '../json-schema-validation';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export interface InstallPluginCoreInput {
  /** The plugin repo's GitHub URL (https://github.com/owner/repo[.git]). */
  githubUrl: string;
  /** Within-repo plugin discriminator — a subdir to look in first, and the slug to match. */
  listingRef?: string;
  /** Optional target harness: when set with `acceptCapabilities`, the manifest's
   *  declared capabilities are granted for this harness (install-consent). */
  harness?: string;
  /** Record the manifest's declared capabilities as grants for `harness`. */
  acceptCapabilities?: boolean;
  /** Optional immutable review receipt from a preceding sandbox vetting pass.
   * The live install refuses before replacing any bytes if the repo now exposes
   * a different package identity, permission set, dependency graph, or trigger
   * surface. Used by capability-provider chaining so consent applies to exactly
   * the complete transitive set the caller reviewed. */
  expectedReview?: InstallPluginManifestReview;
}

export interface InstalledPluginManifest {
  name: string;
  version: string;
  description?: string;
  capabilities?: string[];
  kind?: string;
  configSchema?: Record<string, unknown>;
  oauth?: Array<{ provider: string; scopes?: string[]; fieldName: string }>;
  triggerPack?: PluginTriggerPack;
  [k: string]: unknown;
}

export interface InstalledTriggerPackReceipt {
  targetCount: number;
  bindingCount: number;
  edgeCount: number;
  sourceKinds: string[];
  planTargets: Array<{ id: string; path: string; slug: string }>;
  /** Installation never crosses the autonomy-gated trigger arm boundary. */
  armed: false;
}

export interface InstallPluginCoreResult {
  ok: true;
  name: string;
  version: string;
  /** Manifest distribution kind — 'plugin' (default) or 'pack' (runtime-less code-tool pack). */
  kind: string;
  capabilities: string[];
  source: string;
  installedTo: string;
  /** Capabilities granted for `harness` (only when harness + acceptCapabilities). */
  granted: string[];
  /** Descriptor made discoverable by the post-copy host invalidation. */
  triggerPack?: InstalledTriggerPackReceipt;
  /** Stable install-review material derived before any destination write. */
  review: InstallPluginManifestReview;
  /**
   * Deps this unit declares that are not installed but resolvable from the
   * Cupboard (advisory — tool-distribution-granularity D-003). Empty when the
   * manifest declares no dependencies.
   *
   * This is ALSO the transitive-recursion channel: `resolveAndInstallDeps` folds
   * it back into its working set, so a unit's own installable deps pull their
   * providers in. `events` therefore has to be here — otherwise a unit whose
   * manifest requires an event family provided by another Cupboard pack would
   * install with that pack absent, and its reactions would never fire.
   */
  installableDependencies?: {
    tools: string[];
    packs: string[];
    plugins: string[];
    events?: ManifestEventDep[];
  };
}

export interface InstallPluginDeclaredDependencies {
  tools: string[];
  packs: string[];
  plugins: string[];
  events: ManifestEventDep[];
}

/** The exact security/dependency surface a caller consents to install. */
export interface InstallPluginManifestReview {
  name: string;
  version: string;
  kind: string;
  capabilities: string[];
  dependencies: InstallPluginDeclaredDependencies;
  triggerPack?: InstalledTriggerPackReceipt;
}

/** A manifest-declared event dependency (plugin-SDK `ManifestEventDependency`, D-003). */
export interface ManifestEventDep {
  family: string;
  /** listen-if-present: an unresolvable optional dep never blocks the install. */
  optional?: boolean;
}

function normalizedStrings(value: unknown): string[] {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .filter((item): item is string => typeof item === 'string' && item.length > 0),
  )].sort();
}

function normalizedEvents(value: unknown): ManifestEventDep[] {
  const byFamily = new Map<string, ManifestEventDep>();
  for (const item of Array.isArray(value) ? value : []) {
    if (item == null || typeof item !== 'object') continue;
    const { family, optional } = item as Record<string, unknown>;
    if (typeof family !== 'string' || family.length === 0) continue;
    const prior = byFamily.get(family);
    if (prior && prior.optional !== true) continue;
    byFamily.set(family, { family, ...(optional === true ? { optional: true } : {}) });
  }
  return [...byFamily.values()].sort((a, b) => a.family.localeCompare(b.family));
}

function manifestReview(
  manifest: InstalledPluginManifest,
  triggerPack: InstalledTriggerPackReceipt | undefined,
  dependencies: {
    tools?: string[];
    packs?: string[];
    plugins?: string[];
    events?: ManifestEventDep[];
  } | undefined,
): InstallPluginManifestReview {
  return {
    name: manifest.name,
    version: manifest.version,
    kind: typeof manifest.kind === 'string' ? manifest.kind : 'plugin',
    capabilities: normalizedStrings(manifest.capabilities),
    dependencies: {
      tools: normalizedStrings(dependencies?.tools),
      packs: normalizedStrings(dependencies?.packs),
      plugins: normalizedStrings(dependencies?.plugins),
      events: normalizedEvents(dependencies?.events),
    },
    ...(triggerPack ? { triggerPack } : {}),
  };
}

export interface InstallPluginCoreDeps {
  /** Shallow-clone `url` into `dest` (which does not yet exist). Throws on failure. */
  cloneRepo: (url: string, dest: string) => Promise<void>;
  /** Absolute path of the global-plugins dir (install target parent). */
  globalPluginsDir: () => string;
  /** A scratch dir for the clone (real: os.tmpdir()). */
  tmpDir: () => string;
  /** Persist capability grants for a (plugin, version, harness) — install-consent. */
  grant: (args: {
    pluginName: string;
    pluginVersion: string;
    harnessSlug: string;
    capabilities: string[];
  }) => Promise<void>;
  /** Drop the in-memory plugin-host + api-route caches so the new plugin goes live. */
  invalidateHost: () => void | Promise<void>;
  /**
   * Validate the manifest's declared `dependencies.{tools,packs,plugins,events}`
   * against the host's pack catalog BEFORE the unit is copied into place
   * (tool-distribution-granularity D-003 — plugin-to-tool deps, install-time
   * gate; `events` joins the axis per cupboard-public-release D-003 / P-007).
   * Optional: when absent, declared deps are not gated. Return the dep-validator
   * verdict; hard-missing deps abort the install (422), installable ones surface
   * advisorily on the result.
   *
   * An unresolvable REQUIRED event family is hard-missing exactly like a tool; an
   * unresolvable OPTIONAL one (listen-if-present) never blocks and never appears
   * in `missing`.
   */
  validateDependencies?: (deps: {
    tools?: string[];
    packs?: string[];
    plugins?: string[];
    events?: ManifestEventDep[];
  }) => Promise<{
    ok: boolean;
    missing: { tools: string[]; packs: string[]; plugins: string[]; events?: string[] };
    installable: { tools: string[]; packs: string[]; plugins: string[]; events?: ManifestEventDep[] };
    messages: string[];
  }>;
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;

export class InstallPluginError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'InstallPluginError';
  }
}

// A plugin name becomes a directory under global-plugins. It is UNTRUSTED (from
// the cloned repo's papercusp.json), so it must be EITHER a safe single-segment
// slug (optional leading `@`), OR a scoped `@scope/name` where BOTH segments are
// safe slugs — the exact on-disk layout the plugin LOADER recurses into
// (`global-plugins/@scope/name/`; see plugin-loader loader.test.ts "recurses into
// @scope/ dirs"). Rejecting scoped names here (as the old single-segment-only
// regex did) made a legitimately-scoped plugin — e.g. `@papercupai/papercusp-worker`
// — uninstallable via the Cupboard even though the loader loads it fine
// (cupboard-public-release-2026-07-12 P-015 fresh-install acceptance). Anything
// else (bare separator, leading dot, `..`, >2 segments) is rejected: an untrusted
// `../evil` or `@a/../evil` must never escape global-plugins (path traversal →
// arbitrary file deletion via the `rm -rf` target).
const SAFE_NAME_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
function isSafePluginName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  // Scoped `@scope/name`: exactly two safe segments.
  if (name.startsWith('@') && name.includes('/')) {
    const parts = name.slice(1).split('/');
    return parts.length === 2 && parts.every((seg) => SAFE_NAME_SEGMENT_RE.test(seg));
  }
  // Unscoped single segment (an optional bare leading `@` is allowed).
  return SAFE_NAME_SEGMENT_RE.test(name.replace(/^@/, ''));
}

/** Throw unless `childPath` resolves to `parentDir` itself or a path inside it. */
function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new InstallPluginError(`unsafe ${label} escapes ${parentDir}`, 400);
  }
}

/** A within-repo subdir ref must be relative, charset-safe, and contain no `..`/empty segment. */
function isSafeListingRef(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * Validate a trigger pack before any destination is replaced. Generic plugin
 * installs retain their historical behavior; the new shape is strict from day
 * one because an invalid declaration otherwise installs cleanly and then stays
 * inert behind a later loader error.
 */
async function inspectTriggerPackForInstall(
  manifest: InstalledPluginManifest,
  pluginDir: string,
): Promise<InstalledTriggerPackReceipt | undefined> {
  if (!manifest.triggerPack) return undefined;

  const [{ validateManifest }, { validateTriggerPackDeclaration }, { parsePlan }] = await Promise.all([
    import('@papercusp/plugin-loader/manifest-validate'),
    import('@papercusp/plugin-sdk'),
    import('@papercusp/plan-parser'),
  ]);
  const shape = validateManifest(manifest);
  if (!shape.ok) {
    throw new InstallPluginError(
      `trigger-pack manifest invalid: ${shape.issues.map((issue) => `${issue.path} — ${issue.message}`).join('; ')}`,
      422,
    );
  }
  const semanticIssues = validateTriggerPackDeclaration(manifest);
  if (semanticIssues.length > 0) {
    throw new InstallPluginError(`trigger-pack manifest invalid: ${semanticIssues.join('; ')}`, 422);
  }
  if (!isCompilableSchema(manifest.triggerPack.inputs)) {
    throw new InstallPluginError('trigger-pack manifest invalid: inputs is not compilable JSON Schema', 422);
  }

  const planTargets: InstalledTriggerPackReceipt['planTargets'] = [];
  for (const target of manifest.triggerPack.targets) {
    if (target.kind === 'recipe') {
      if (!isCompilableSchema(target.argsSchema)) {
        throw new InstallPluginError(
          `trigger-pack manifest invalid: recipe target "${target.id}" argsSchema is not compilable JSON Schema`,
          422,
        );
      }
      continue;
    }
    if (!isCompilableSchema(target.inputSchema)) {
      throw new InstallPluginError(
        `trigger-pack manifest invalid: plan target "${target.id}" inputSchema is not compilable JSON Schema`,
        422,
      );
    }

    const planPath = resolve(pluginDir, target.path);
    assertInside(pluginDir, planPath, `triggerPack target "${target.id}" path`);
    let realPlanPath: string;
    let markdown: string;
    try {
      realPlanPath = await fs.realpath(planPath);
      assertInside(pluginDir, realPlanPath, `triggerPack target "${target.id}" symlink target`);
      markdown = await fs.readFile(realPlanPath, 'utf8');
    } catch (error) {
      if (error instanceof InstallPluginError) throw error;
      throw new InstallPluginError(`trigger-pack plan not readable at ${target.path}`, 422);
    }
    const parsed = parsePlan(markdown);
    if (parsed.isLegacy || !parsed.frontmatter.slug) {
      throw new InstallPluginError(
        `trigger-pack plan at ${target.path} is not a structured plan template`,
        422,
      );
    }
    planTargets.push({ id: target.id, path: target.path, slug: parsed.frontmatter.slug });
  }

  return {
    targetCount: manifest.triggerPack.targets.length,
    bindingCount: manifest.triggerPack.bindings.length,
    edgeCount: manifest.triggerPack.edges.length,
    sourceKinds: [...new Set(manifest.triggerPack.bindings.flatMap((binding) =>
      binding.source.kind === 'external' ? [binding.source.sourceKind] : []))].sort(),
    planTargets,
    armed: false,
  };
}

async function readManifest(dir: string): Promise<InstalledPluginManifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(join(dir, 'papercusp.json'), 'utf8')) as InstalledPluginManifest;
    return m?.name && m?.version ? m : null;
  } catch {
    return null;
  }
}

/**
 * Find the plugin within a freshly-cloned repo. Prefers the `listingRef` subdir
 * (a repo hosting several plugins), else the repo root (single-plugin repo).
 */
async function locatePlugin(
  cloneDir: string,
  listingRef: string | undefined,
): Promise<{ dir: string; manifest: InstalledPluginManifest }> {
  const candidates: string[] = [];
  if (listingRef && isSafeListingRef(listingRef)) {
    const sub = join(cloneDir, listingRef);
    assertInside(cloneDir, sub, `listing_ref "${listingRef}"`);
    candidates.push(sub);
  }
  candidates.push(cloneDir);
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const manifest = await readManifest(dir);
    if (manifest) return { dir, manifest };
  }
  throw new InstallPluginError('no papercusp.json found in the plugin repo (checked listing_ref subdir + root)', 422);
}

/** Recursively copy a plugin dir into `target`, excluding the repo's .git. */
async function copyPluginDir(src: string, target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(src, target, {
    recursive: true,
    filter: (s) => !s.split(/[/\\]/).includes('.git'),
  });
}

export async function installPluginFromCupboardCore(
  input: InstallPluginCoreInput,
  deps: InstallPluginCoreDeps,
): Promise<InstallPluginCoreResult> {
  const url = (input.githubUrl ?? '').trim();
  if (!GITHUB_URL_RE.test(url)) {
    throw new InstallPluginError(`invalid github_url "${url}" — must be https://github.com/<owner>/<repo>`, 400);
  }

  const cloneDir = join(deps.tmpDir(), `cupboard-plugin-${Date.now()}-${Math.floor(performance.now())}`);
  try {
    await deps.cloneRepo(url, cloneDir);
    const { dir: pluginDir, manifest } = await locatePlugin(cloneDir, input.listingRef);
    const triggerPack = await inspectTriggerPackForInstall(manifest, pluginDir);

    // manifest.name is UNTRUSTED (from the cloned repo) and becomes a directory we
    // `rm -rf` + `cp` into — so it must be a safe single-segment slug, never a path.
    // Otherwise a malicious manifest (`"name": "../../.ssh"`) would delete/overwrite
    // files outside global-plugins (path traversal → arbitrary file deletion).
    if (typeof manifest.name !== 'string' || !isSafePluginName(manifest.name)) {
      throw new InstallPluginError(
        `unsafe plugin name ${JSON.stringify(manifest.name)} — must be a single-segment slug or a scoped @scope/name`,
        400,
      );
    }

    // Install-time dependency gate (tool-distribution-granularity D-003): a
    // unit declaring `dependencies` with a hard-missing dep (no provider
    // anywhere) fails BEFORE anything is copied into place. Installable-from-
    // Cupboard deps never block — they surface advisorily on the result.
    const declaredDeps = (
      manifest as {
        dependencies?: { tools?: string[]; packs?: string[]; plugins?: string[]; events?: ManifestEventDep[] };
      }
    ).dependencies;
    let installableDependencies: InstallPluginCoreResult['installableDependencies'];
    // `events` counts here: a unit whose ONLY declared dep is an event family
    // must still be gated. Omitting it from this check would skip the gate
    // entirely for that unit — it installs, resolves nothing, and its reactions
    // silently never fire (the exact failure the event axis exists to prevent).
    const hasDeclaredDeps =
      (declaredDeps?.tools?.length ?? 0) > 0 ||
      (declaredDeps?.packs?.length ?? 0) > 0 ||
      (declaredDeps?.plugins?.length ?? 0) > 0 ||
      (declaredDeps?.events?.length ?? 0) > 0;
    if (hasDeclaredDeps && deps.validateDependencies) {
      const verdict = await deps.validateDependencies(declaredDeps!);
      if (!verdict.ok) {
        throw new InstallPluginError(
          `dependencies unmet: ${verdict.messages.join('; ') || 'unknown'}`,
          422,
        );
      }
      const inst = verdict.installable;
      if (
        inst.tools.length > 0 ||
        inst.packs.length > 0 ||
        inst.plugins.length > 0 ||
        (inst.events?.length ?? 0) > 0
      ) {
        installableDependencies = inst;
      }
    }

    const review = manifestReview(manifest, triggerPack, declaredDeps);
    if (input.expectedReview && canonicalJson(input.expectedReview) !== canonicalJson(review)) {
      throw new InstallPluginError(
        `plugin review changed after consent for ${manifest.name}@${manifest.version}; review the current package closure before installing`,
        409,
      );
    }

    const target = join(deps.globalPluginsDir(), manifest.name);
    assertInside(deps.globalPluginsDir(), target, `plugin name "${manifest.name}"`);
    // mkdir the target's PARENT (not just global-plugins) so a scoped
    // `@scope/name` lands at global-plugins/@scope/name/ — the loader's layout.
    // For an unscoped name this is global-plugins itself (unchanged).
    await fs.mkdir(dirname(target), { recursive: true });
    await copyPluginDir(pluginDir, target);

    const capabilities = review.capabilities;

    // Install-consent (D-009): when a target harness is given and the caller
    // accepted, record the manifest's declared caps as grants for that harness.
    // The runtime then enforces `manifest ∩ granted` (fork-install-consent).
    let granted: string[] = [];
    if (input.harness && input.acceptCapabilities && capabilities.length > 0) {
      await deps.grant({
        pluginName: manifest.name,
        pluginVersion: manifest.version,
        harnessSlug: input.harness,
        capabilities,
      });
      granted = capabilities;
    }

    await deps.invalidateHost();

    return {
      ok: true,
      name: manifest.name,
      version: manifest.version,
      kind: typeof manifest.kind === 'string' ? manifest.kind : 'plugin',
      capabilities,
      source: url,
      installedTo: target,
      granted,
      review,
      ...(triggerPack ? { triggerPack } : {}),
      ...(installableDependencies ? { installableDependencies } : {}),
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}
