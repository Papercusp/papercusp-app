import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';

export interface IgnoredRuntimeEntryWorkspace {
  name: string;
  /** repo-relative package.json path */
  manifest: string;
  /** package-relative ignored bin/main/require/default target */
  target: string;
}

/** Package names built from pinned source by setup-release-checkout block 3c-2. */
export function extractRegisteredRuntimeBuildWorkspaces(scriptSource: string): Set<string> {
  const body = scriptSource.match(/RUNTIME_BUILD_WORKSPACES=\(([\s\S]*?)\)/)?.[1] ?? '';
  return new Set([...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
}

function exportRuntimeTargets(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [condition, target] of Object.entries(value as Record<string, unknown>)) {
    if (condition === 'require' || condition === 'default') {
      if (typeof target === 'string') out.push(target);
      else out.push(...exportRuntimeTargets(target));
      continue;
    }
    // Export subpaths (".", "./react", ...) contain their own condition maps.
    if (condition.startsWith('.')) out.push(...exportRuntimeTargets(target));
  }
  return out;
}

/**
 * Discover workspace packages whose declared boot entry is erased by
 * `git clean -fdqx` and therefore has to be rebuilt in the release checkout.
 *
 * This is shared by the registry-completeness guard and the inverted asset
 * coverage guard so both reason from the same manifests, conditions and git
 * ignore rules.
 */
export function listIgnoredRuntimeEntryWorkspaces(
  repoRoot: string,
): IgnoredRuntimeEntryWorkspace[] {
  const manifests = execFileSync(
    'git',
    ['ls-files', '--recurse-submodules', '--', ':(glob)**/package.json'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').filter(Boolean);

  const hits: IgnoredRuntimeEntryWorkspace[] = [];
  for (const manifest of manifests) {
    const packageDir = dirname(resolve(repoRoot, manifest));
    let parsed: {
      name?: string;
      bin?: unknown;
      main?: unknown;
      exports?: unknown;
    };
    try {
      parsed = JSON.parse(readFileSync(resolve(repoRoot, manifest), 'utf8')) as typeof parsed;
    } catch {
      continue;
    }
    if (!parsed.name?.startsWith('@papercusp/') && !parsed.name?.startsWith('@papercup/')) continue;

    const targets = new Set<string>();
    if (typeof parsed.bin === 'string') targets.add(parsed.bin);
    else if (parsed.bin && typeof parsed.bin === 'object') {
      for (const target of Object.values(parsed.bin as Record<string, unknown>)) {
        if (typeof target === 'string') targets.add(target);
      }
    }
    if (typeof parsed.main === 'string') targets.add(parsed.main);
    for (const target of exportRuntimeTargets(parsed.exports)) targets.add(target);

    for (const rawTarget of targets) {
      const target = rawTarget.replace(/^\.\//, '');
      if (!target || target.includes('*')) continue;
      const ignored = spawnSync('git', ['check-ignore', '-q', '--', target], { cwd: packageDir });
      if (ignored.status === 0) hits.push({ name: parsed.name, manifest, target });
    }
  }
  return hits;
}

/**
 * Repo-relative output roots materialized by registered pinned workspace
 * builds. Only ignored declared boot entries are admitted: registration alone
 * must not turn an entire workspace into an unbounded coverage exemption.
 */
export function runtimeBuildProvisionedRoots(
  scriptSource: string,
  entries: Iterable<IgnoredRuntimeEntryWorkspace>,
): string[] {
  const registered = extractRegisteredRuntimeBuildWorkspaces(scriptSource);
  const roots = new Set<string>();

  for (const { name, manifest, target } of entries) {
    if (!registered.has(name)) continue;
    const packageRoot = posix.dirname(manifest.replaceAll('\\', '/'));
    const normalizedTarget = target.replace(/^\.\//, '').replaceAll('\\', '/');
    const targetDir = posix.dirname(normalizedTarget);
    roots.add(posix.join(packageRoot, targetDir === '.' ? normalizedTarget : targetDir));
  }

  return [...roots];
}
