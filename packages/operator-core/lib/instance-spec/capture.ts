/**
 * `captureInstanceSpec(slug)` — produce an `InstanceSpec` from a live instance /
 * harness (`retire-snapshots-instance-spec-2026-06-09` P-002).
 *
 * Reads the four pieces the new layered design already produces:
 *   - **blueprintRef** ← the git-canonical `.papercusp/blueprint.yaml` (+ its resolved
 *     `{ id, version }`, computed the SAME way `harness:create` does so `boot` reproduces it);
 *   - **repoSha**      ← `git rev-parse HEAD` in the harness path (null for a repo-less harness);
 *   - **deploymentConfig** ← the registry ProjectEntry's `deployment` (or `{target:'local'}`);
 *   - **genome**       ← the genome surface read from `.papercusp/genome/` + `configOverrides.genome`.
 *
 * No tarball, no PG dump, no FS walk — just the lightweight descriptor (D-002).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { LOCAL_DEPLOYMENT, type DeploymentConfig } from '@papercusp/deployment-driver';
import { operatorResolveExtends } from '../blueprint/installed-blueprints';
import { resolveAndValidate } from '../agent-tools/blueprint/_resolve';
import { readGenome } from './genome-storage';
import { INSTANCE_SPEC_VERSION, type BlueprintRef, type InstanceSpec } from './types';

export interface CaptureOpts {
  /** Override the workspace (defaults to the active workspace). */
  workspaceId?: string;
}

/** Read + resolve a harness's blueprint into a `BlueprintRef` (git-canonical file → resolved id/version). */
export function captureBlueprintRef(harnessPath: string): BlueprintRef {
  const bpFile = join(harnessPath, '.papercusp', 'blueprint.yaml');
  if (!existsSync(bpFile)) {
    throw new Error(`no blueprint.yaml at ${bpFile} — not an instantiated harness`);
  }
  const childObj = parseYaml(readFileSync(bpFile, 'utf8')) as Record<string, unknown>;
  if (!childObj || typeof childObj !== 'object') {
    throw new Error(`blueprint.yaml at ${bpFile} did not parse to an object`);
  }
  const resolver = operatorResolveExtends({
    localDirs: [join(harnessPath, '.papercusp', 'blueprints')],
  });
  const validation = resolveAndValidate(childObj, resolver);
  const id = (typeof childObj.id === 'string' ? childObj.id : undefined) ?? validation.blueprint?.id;
  if (!id) throw new Error(`blueprint.yaml at ${bpFile} has no id and none could be resolved`);
  return {
    id,
    ...(typeof childObj.extends === 'string' ? { extends: childObj.extends } : {}),
    ...(validation.blueprint?.version ? { version: validation.blueprint.version } : {}),
    blueprint: childObj,
  };
}

/** Read the harness repo's git SHA (full HEAD), or null when it is not a git repo. */
export function captureRepoSha(harnessPath: string): string | null {
  if (!existsSync(join(harnessPath, '.git'))) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: harnessPath, encoding: 'utf8' }).trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Capture an `InstanceSpec` from a live harness. Read-only: parses the
 * blueprint file, reads the git SHA, the persisted deployment config, and the
 * genome surface — projecting nothing to PG.
 */
export async function captureInstanceSpec(slug: string, opts: CaptureOpts = {}): Promise<InstanceSpec> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const { activeWorkspaceId } = await import('../workspace-registry');
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const reg = await loadHarnessRegistry(workspaceId);
  const entry = reg.projects.find((p) => p.slug === slug);
  if (!entry) throw new Error(`harness '${slug}' not found in workspace '${workspaceId}'`);

  const blueprintRef = captureBlueprintRef(entry.path);
  const repoSha = captureRepoSha(entry.path);
  const deploymentConfig: DeploymentConfig = entry.deployment ?? LOCAL_DEPLOYMENT;
  const genome = readGenome(entry.path, entry.configOverrides);

  return {
    specVersion: INSTANCE_SPEC_VERSION,
    blueprintRef,
    repoSha,
    deploymentConfig,
    genome,
  };
}
