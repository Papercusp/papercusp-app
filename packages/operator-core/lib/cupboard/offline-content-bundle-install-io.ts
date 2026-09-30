/**
 * Offline content-only specialization of the Cupboard bundle installer.
 *
 * This module is intentionally a narrow graph: it fetches the bundle manifest,
 * clones content repositories, and uses the existing template/rubric content
 * cores. It must not import the live bundle IO module, PG, pack-catalog, plugin
 * host, blueprint release ledger, or agent-tool testing code. The pre-service
 * workspace-host bootstrap uses this same installBundleAppFromCupboard seam
 * through this module; the normal operator path remains in bundle-app-install-io.
 */
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  fetchBundleManifest,
  BundleManifestError,
} from './bundle-manifest-io';
import {
  installBundleApp,
  type BundleAppInstallers,
  type BundleAppInstallResult,
  type BundleContentUnit,
  type BundleHostState,
} from './bundle-app-manifest';
import {
  installTemplateFromCupboardCore,
  InstallTemplateError,
} from './install-template-core';
import {
  installRubricFromCupboardCore,
  InstallRubricError,
} from './install-rubric-core';
import { createTextCollector } from '../child-output';
import { cupboardGitDeps } from './install-io';
import type {
  InstallBundleAppInput,
  InstallBundleAppOptions,
  InstallBundleAppOutcome,
} from './bundle-app-install-io';

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}?(?:\.git)?\/?$/;
const SAFE_REF_RE = /^[A-Za-z0-9._-]+$/;
const SAFE_BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const BUNDLE_SOURCE_SIDECAR = '.papercusp-bundle-source.json';

function contentHome(): string {
  const home = process.env.PAPERCUSP_HOME?.trim();
  if (!home || !resolve(home)) {
    throw new Error('PAPERCUSP_HOME is required for offline content bootstrap');
  }
  return resolve(home);
}

function bundleUnitSource(unit: BundleContentUnit): string {
  const url = unit.githubUrl.trim();
  const ref = unit.listingRef?.trim();
  return ref ? `${url}#${ref}` : url;
}

async function readBundleSource(dir: string, manifestFile: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(join(dir, BUNDLE_SOURCE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as { source?: unknown };
    return typeof parsed.source === 'string' && parsed.source ? parsed.source : null;
  } catch {
    try {
      await fs.access(join(dir, manifestFile));
      return 'unknown (not installed via a bundle app)';
    } catch {
      return null;
    }
  }
}

async function writeBundleSource(dir: string, unit: BundleContentUnit): Promise<void> {
  await fs.writeFile(
    join(dir, BUNDLE_SOURCE_SIDECAR),
    JSON.stringify({
      source: bundleUnitSource(unit),
      githubUrl: unit.githubUrl,
      ...(unit.listingRef ? { listingRef: unit.listingRef } : {}),
      installedAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

function gitCloneShallow(url: string, dest: string): Promise<void> {
  return new Promise((resolveClone, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const error = createTextCollector(child.stderr);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolveClone()
        : reject(new Error(`git clone failed (exit ${code}): ${error.text().slice(0, 300)}`)),
    );
  });
}

function assertInside(parentDir: string, childPath: string, label: string): void {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  if (child !== parent && !child.startsWith(parent + sep)) {
    throw new Error(`unsafe ${label} escapes ${parentDir}`);
  }
}

function safeListingRef(ref: string | undefined): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('/')) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return false;
  return ref.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function installOfflineBlueprint(unit: BundleContentUnit): Promise<{ ok: true } | { ok: false; error: string }> {
  const url = unit.githubUrl.trim();
  if (!GITHUB_URL_RE.test(url)) return { ok: false, error: `invalid github_url "${url}"` };
  if (!SAFE_BLUEPRINT_ID_RE.test(unit.id)) return { ok: false, error: `unsafe blueprint id "${unit.id}"` };

  const root = join(contentHome(), 'blueprints');
  const target = join(root, unit.id);
  assertInside(root, target, `blueprint id "${unit.id}"`);
  const source = bundleUnitSource(unit);
  const existing = await readBundleSource(target, 'blueprint.yaml');
  if (existing === source) return { ok: true };
  if (existsSync(target)) {
    return {
      ok: false,
      error: existing
        ? `blueprint "${unit.id}" is already installed from ${existing}`
        : `blueprint "${unit.id}" already exists with unknown provenance`,
    };
  }

  const cloneDir = join(tmpdir(), `cupboard-blueprint-offline-${process.pid}-${Date.now()}`);
  try {
    await gitCloneShallow(url, cloneDir);
    const candidates = [
      ...(safeListingRef(unit.listingRef) ? [join(cloneDir, unit.listingRef!)] : []),
      cloneDir,
    ];
    const sourceDir = candidates.find((candidate) => {
      assertInside(cloneDir, candidate, 'blueprint listing_ref');
      return existsSync(join(candidate, 'blueprint.yaml'));
    });
    if (!sourceDir) return { ok: false, error: 'no blueprint.yaml found in the bundle repository' };

    let raw: unknown;
    try {
      raw = parseYaml(await fs.readFile(join(sourceDir, 'blueprint.yaml'), 'utf8'));
    } catch (error) {
      return { ok: false, error: `blueprint.yaml failed to parse: ${error instanceof Error ? error.message : String(error)}` };
    }
    const declaredId = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).id
      : undefined;
    if (declaredId !== unit.id) {
      return { ok: false, error: `bundle declared blueprint id "${unit.id}" but the repo declares "${String(declaredId ?? '')}"` };
    }

    await fs.mkdir(root, { recursive: true });
    const incoming = `${target}.incoming-${process.pid}-${Date.now()}`;
    try {
      await fs.cp(sourceDir, incoming, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (entry) => !entry.split(/[/\\]/).includes('.git'),
      });
      await writeBundleSource(incoming, unit);
      await fs.rename(incoming, target);
    } finally {
      await fs.rm(incoming, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => {});
  }
}

function emptyCatalog(): Awaited<ReturnType<BundleHostState['deriveCatalog']>> {
  return {
    view: { byName: new Map() },
    packs: [],
    builtinTools: new Set(),
    cupboardReachable: false,
  } as unknown as Awaited<ReturnType<BundleHostState['deriveCatalog']>>;
}

function contentPath(kind: 'templates' | 'rubrics', unit: BundleContentUnit): string {
  const ref = unit.listingRef ?? unit.id;
  if (!SAFE_REF_RE.test(ref)) throw new Error(`unsafe ${kind} ref "${ref}"`);
  const root = join(contentHome(), kind);
  const target = join(root, ref);
  assertInside(root, target, `${kind} ref "${ref}"`);
  return target;
}

function makeOfflineInstallers(): BundleAppInstallers {
  // Offline bundle units carry NO content pin (they are addressed by the bundle's own
  // manifest, not a Cupboard listing), so the self-describing core takes the unpinned
  // `cloneRepo` path and never reaches fetchAtSha / listTreeBlobs — but the deps contract
  // is total (P-002), so the real git-backed implementations are supplied rather than a
  // stub that would silently mis-verify if a pinned unit ever arrived here.
  const cloneDeps = { ...cupboardGitDeps(), cloneRepo: gitCloneShallow };
  return {
    resolveAndInstallDeps: async (declared) => ({
      ok: (declared.packs?.length ?? 0) === 0 && (declared.plugins?.length ?? 0) === 0,
      installed: [],
      stillMissing: { tools: [], packs: declared.packs ?? [], plugins: declared.plugins ?? [], events: [] },
      advisory: ['offline content bootstrap refuses pack/plugin installation'],
      rounds: 0,
    }),
    installDatatype: async (id) => ({ ok: false, error: `offline content bootstrap refuses datatype "${id}"` }),
    installBlueprint: installOfflineBlueprint,
    installTemplate: async (unit) => {
      const target = contentPath('templates', unit);
      const existing = await readBundleSource(target, 'template.yaml');
      if (existing === bundleUnitSource(unit)) return { ok: true };
      if (existsSync(target)) {
        return { ok: false, error: existing ? `template "${unit.id}" is already installed from ${existing}` : `template "${unit.id}" already exists with unknown provenance` };
      }
      try {
        const result = await installTemplateFromCupboardCore(
          { githubUrl: unit.githubUrl, listingRef: unit.listingRef ?? unit.id },
          { ...cloneDeps, userTemplatesDir: () => join(contentHome(), 'templates') },
        );
        await writeBundleSource(result.installedTo, unit);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof InstallTemplateError ? error.message : error instanceof Error ? error.message : String(error) };
      }
    },
    installRubric: async (unit) => {
      const target = contentPath('rubrics', unit);
      const existing = await readBundleSource(target, 'rubric.json');
      if (existing === bundleUnitSource(unit)) return { ok: true };
      if (existsSync(target)) {
        return { ok: false, error: existing ? `rubric "${unit.id}" is already installed from ${existing}` : `rubric "${unit.id}" already exists with unknown provenance` };
      }
      try {
        const result = await installRubricFromCupboardCore(
          { githubUrl: unit.githubUrl, listingRef: unit.listingRef ?? unit.id },
          cloneDeps,
        );
        await writeBundleSource(result.installedTo, unit);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof InstallRubricError ? error.message : error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Internal implementation used by the existing public bundle-install seam. */
export async function installOfflineContentBundleAppFromCupboard(
  input: InstallBundleAppInput,
  opts: InstallBundleAppOptions,
): Promise<InstallBundleAppOutcome> {
  if (!opts.offlineContentOnly) {
    return { ok: false, status: 400, error: 'offline content installer requires offlineContentOnly' };
  }
  if (!input.githubUrl) {
    return { ok: false, status: 400, error: 'offline content bootstrap requires githubUrl' };
  }

  let manifest;
  try {
    manifest = await fetchBundleManifest(
      { githubUrl: input.githubUrl, listingRef: input.listingRef },
      { cloneRepo: gitCloneShallow, tmpDir: tmpdir },
    );
  } catch (error) {
    if (error instanceof BundleManifestError) return { ok: false, status: error.status, error: error.message };
    return { ok: false, status: 500, error: 'manifest fetch failed', detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }

  if ((manifest.datatypes?.length ?? 0) > 0 || (manifest.packs?.length ?? 0) > 0 || (manifest.plugins?.length ?? 0) > 0) {
    return { ok: false, status: 422, error: 'offline content bootstrap accepts only blueprints, templates, and rubrics' };
  }

  const host: BundleHostState = {
    hasDatatype: async () => false,
    deriveCatalog: async () => emptyCatalog(),
    installedBlueprintSource: (unit) => readBundleSource(join(contentHome(), 'blueprints', unit.id), 'blueprint.yaml'),
    installedTemplateSource: (unit) => readBundleSource(contentPath('templates', unit), 'template.yaml'),
    installedRubricSource: (unit) => readBundleSource(contentPath('rubrics', unit), 'rubric.json'),
  };

  try {
    const result: BundleAppInstallResult = await installBundleApp(
      manifest,
      host,
      makeOfflineInstallers(),
      { allowConflicts: input.allowConflicts === true },
    );
    return { ok: true, manifest, result };
  } catch (error) {
    return { ok: false, status: 500, error: 'offline content install failed', detail: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}

/** The pre-PG entrypoint keeps the same Cupboard seam and options contract. */
export const installBundleAppFromCupboard = installOfflineContentBundleAppFromCupboard;
