/**
 * Assemble the generic `FrameBootstrapInput` for a deploy (P-010/P-012): the
 * harness's git remote + its blueprint `environment` spec (P-007) + the per-frame
 * credential bundle named by `deployment.credentialRef` (P-011). Best-effort: a
 * missing piece degrades gracefully (no repo / empty env / no creds) rather than
 * failing the deploy assembly.
 */
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadBlueprintFromFile } from '@papercusp/orchestrator/blueprint';
import type { DeploymentConfig, FrameBootstrapInput } from '@papercusp/deployment-driver';

/** Resolve a credentialRef to the frame-credential channel it names:
 *  - `token:<path>` — a long-lived OAuth token FILE (`claude setup-token` output),
 *    staged on the frame + exported as `CLAUDE_CODE_OAUTH_TOKEN`. The automated
 *    channel: one interactive mint (~1-year validity), no refresh-rotation races.
 *  - `file:<path>` / absolute / `~` — a `.credentials.json` bundle installed to
 *    the frame's `~/.claude/` (the interactive-login channel).
 *  - `env:NAME` / bare names — the provider API key, not a frame credential → {}.
 */
export function resolveCredential(
  ref: string | undefined,
): Pick<FrameBootstrapInput, 'credentialsLocalPath' | 'oauthTokenLocalPath'> {
  if (!ref) return {};
  const expand = (p: string) => (p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p);
  if (ref.startsWith('token:')) return { oauthTokenLocalPath: expand(ref.slice(6)) };
  if (ref.startsWith('file:')) return { credentialsLocalPath: expand(ref.slice(5)) };
  if (ref.startsWith('/') || ref.startsWith('~')) return { credentialsLocalPath: expand(ref) };
  return {};
}

/** Resolve `provider.runtimeTarball` (a local tarball path) for private-repo
 *  runtime delivery — the frame untars it instead of an anonymous clone. */
export function resolveRuntimeTarball(config: DeploymentConfig): string | undefined {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const p = provider.runtimeTarball as string | undefined;
  if (!p) return undefined;
  return p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p;
}

export async function buildDeployBootstrapInput(
  slug: string,
  workspaceId: string,
  config: DeploymentConfig,
): Promise<FrameBootstrapInput> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  const project = reg.projects.find((p) => p.slug === slug);
  const path = project?.path;

  let repoUrl: string | undefined;
  if (path) {
    try {
      repoUrl = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim() || undefined;
    } catch {
      /* no git remote — repo-less or local-only; the frame won't clone */
    }
  }

  let env;
  if (path) {
    try {
      env = loadBlueprintFromFile(join(path, '.papercusp', 'blueprint.yaml')).blueprint.environment;
    } catch {
      /* no/invalid blueprint env spec — nothing extra to stand up */
    }
  }

  // P-008: deliver the harness's per-install instance config to the frame via env
  // (the frame has no local config.json). Assembled from workspace PG (registry),
  // falling back to the local config.json for an un-migrated harness. Migrate FIRST
  // so a deployed harness's instance config is PG-canonical (and federates to the
  // frame's own pg, D-007) rather than left in a file that never reaches the frame.
  let instanceConfigJson: string | undefined;
  try {
    const { migrateConfigJsonToInstance, assembleInstanceConfig } = await import('./instance-config');
    await migrateConfigJsonToInstance(slug, workspaceId).catch(() => undefined);
    const cfg = await assembleInstanceConfig(slug, workspaceId);
    if (Object.keys(cfg).length > 0) instanceConfigJson = JSON.stringify(cfg);
  } catch {
    /* no instance config — the frame runs on blueprint-knob defaults */
  }

  return {
    repoUrl,
    setup: env?.setup,
    install: env?.install,
    build: env?.build,
    run: env?.run,
    services: env?.services,
    ports: env?.ports,
    env: env?.env,
    ...resolveCredential(config.credentialRef),
    // P-019: carry the bound account id to the frame so its rate governor keys
    // per-account (exported as PAPERCUSP_ACCOUNT_ID by the bootstrap).
    accountId: config.accountId,
    runtimeTarballLocalPath: resolveRuntimeTarball(config),
    instanceConfigJson,
  };
}
