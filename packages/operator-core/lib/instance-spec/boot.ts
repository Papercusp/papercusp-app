/**
 * `bootInstanceSpec(spec, target)` — instantiate an identical instance from a spec
 * (`retire-snapshots-instance-spec-2026-06-09` P-003; reconciliation D-003: deploy = boot(spec)).
 *
 * REUSES `harness:create` — the spec's `blueprintRef` + `deploymentConfig` + `genome`
 * map straight onto `harness:create({ blueprint, deployment, instance })`, so booting
 * a spec is exactly creating a harness with that recipe (no second creation path). The
 * harness's git SHA is recorded for provenance and, when the booted repo already
 * contains it, checked out (best-effort) — the common same-origin clone shares the
 * current HEAD, so this is a no-op there; a cloud boot threads `repoSha` through the
 * deployment driver's bootstrap instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import createHarnessTool from '../agent-tools/harness/create';
import type { InstanceSpec } from './types';

export interface BootTarget {
  /** The new harness slug. */
  slug: string;
  /** An existing dir to instantiate into … */
  path?: string;
  /** … OR a parent dir + folder name to create a new harness dir. */
  parentDir?: string;
  folderName?: string;
  /** Pass through to harness:create — install Cupboard-installable deps before the gate. */
  autoInstallDeps?: boolean;
}

export interface BootResult {
  ok: boolean;
  slug?: string;
  path?: string;
  blueprint?: { id: string; version?: string };
  deployment?: unknown;
  /** The spec's repoSha if it was checked out into the booted repo, else null. */
  repoShaCheckedOut?: string | null;
  error?: string;
  raw?: unknown;
}

/** Best-effort: detached-checkout `sha` in `path` when it is a git repo that already has it. */
function tryCheckoutSha(path: string, sha: string): boolean {
  if (!existsSync(`${path}/.git`)) return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: path, stdio: 'ignore' });
    execFileSync('git', ['checkout', '--quiet', '--detach', sha], { cwd: path, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot a new instance from a spec by delegating to `harness:create`, then applying
 * the spec's repo SHA (best-effort checkout) for an identical local instance.
 */
export async function bootInstanceSpec(spec: InstanceSpec, target: BootTarget): Promise<BootResult> {
  if (target.path == null && (target.parentDir == null || target.folderName == null)) {
    return { ok: false, error: 'pass `path`, or both `parentDir` and `folderName`' };
  }

  const createArgs = {
    slug: target.slug,
    ...(target.path != null ? { path: target.path } : { parentDir: target.parentDir!, folderName: target.folderName! }),
    // Reproduce the exact authored blueprint; fall back to {id, extends} when the
    // captured spec carried no inline object.
    blueprint: spec.blueprintRef.blueprint ?? {
      id: spec.blueprintRef.id,
      ...(spec.blueprintRef.extends ? { extends: spec.blueprintRef.extends } : {}),
    },
    deployment: spec.deploymentConfig,
    instance: { genome: spec.genome },
    ...(target.autoInstallDeps != null ? { autoInstallDeps: target.autoInstallDeps } : {}),
  };

  // The create handler ignores its ctx (it acts on args only); call it with the
  // args alone via a loose cast (the role-gated signature declares ctx required).
  const runCreate = createHarnessTool.handler as (a: unknown, c?: unknown) => Promise<unknown>;
  const res = await runCreate(createArgs);
  const text = (res as { content?: { text?: string }[] })?.content?.[0]?.text ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'harness:create returned unparseable output', raw: text };
  }
  if (parsed.ok !== true) {
    return { ok: false, error: String(parsed.error ?? 'harness:create failed'), raw: parsed };
  }

  const path = String(parsed.path ?? '');
  let repoShaCheckedOut: string | null = null;
  if (spec.repoSha && path) {
    repoShaCheckedOut = tryCheckoutSha(path, spec.repoSha) ? spec.repoSha : null;
  }

  return {
    ok: true,
    slug: String(parsed.slug ?? target.slug),
    path,
    blueprint: parsed.blueprint as { id: string; version?: string } | undefined,
    deployment: parsed.deployment,
    repoShaCheckedOut,
    raw: parsed,
  };
}
