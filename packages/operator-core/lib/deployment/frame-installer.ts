/**
 * The PROVIDER-AGNOSTIC half of a cloud driver: `install` + `join`
 * (`cloud-deployment-layer-2026-06-06` P-010/P-018).
 *
 * Once a frame is provisioned, bootstrapping it is identical regardless of who
 * provisioned it — stage the per-frame credentials, run the same
 * `buildFrameBootstrap` script over SSH, then admit it as a peer. So this logic is
 * SHARED by every `DeploymentDriver`; only `provision`/`teardown` are provider-
 * specific. That's the cleanest proof the abstraction isn't Latitude-shaped (P-018):
 * Latitude + Hetzner differ only in how they make/destroy a machine.
 */
import type { DeploymentConfig, DeploymentContext, Frame } from '@papercusp/deployment-driver';
import { buildFrameBootstrap } from './frame-bootstrap';
import { createSshRemoteExec, type RemoteExec, type SshTarget } from './remote-exec';

/** Staging paths live in /tmp — the login user may be non-root (Latitude VMs land
 *  on `ubuntu`; scp can't write /root). scp preserves the local file mode, so the
 *  0600 token stays 0600; the sudo bootstrap then installs to root's home. */
export const REMOTE_CRED_PATH = '/tmp/papercusp-claude-credentials.json';
/** Where the per-frame long-lived OAuth token (`claude setup-token`) is staged. */
export const REMOTE_TOKEN_PATH = '/tmp/papercusp-claude-token';
/** Where the operator-packed runtime tarball is staged (private-repo delivery). */
export const REMOTE_RUNTIME_TARBALL_PATH = '/tmp/papercusp-runtime.tgz';

export interface FrameInstallerDeps {
  /** Build the RemoteExec for a frame. Injected for tests; default = SSH. */
  makeRemoteExec?: (frame: Frame, config: DeploymentConfig) => RemoteExec;
  /** Optional admission hook (P-015). Default: the frame federates via its boot announce. */
  onJoin?: (frame: Frame, config: DeploymentConfig, ctx: DeploymentContext) => Promise<void>;
  /** SSH-readiness probe tuning (tests inject {attempts, delayMs, sleep}). */
  sshWait?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };
}

/** Wait for the frame's sshd to accept connections. The provider's "ready" status
 *  is POWER state, not OS readiness — observed live 2026-06-06 on Latitude metal:
 *  `on` + IP within seconds, but the ubuntu reimage kept sshd "Connection refused"
 *  for many minutes. Default window sized for bare-metal OS installs (~22 min). */
export async function waitForSsh(
  exec: RemoteExec,
  log: (msg: string) => void,
  opts: FrameInstallerDeps['sshWait'] = {},
): Promise<void> {
  const attempts = opts.attempts ?? 120; // observed live: sshd at minute ~15-22 on metal
  const delayMs = opts.delayMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      await exec.runScript('true');
      return;
    } catch (e) {
      if (i >= attempts) {
        throw new Error(
          `frame ssh not reachable after ${attempts} attempt(s): ${(e as Error).message}`,
        );
      }
      log(`ssh not ready (attempt ${i}/${attempts}); retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
    }
  }
}

/** Resolve the SSH target for a frame (shared by `install` + the frame-VNC
 *  stream leg — identical user/key/sudo resolution either way). */
export function sshTargetForFrame(frame: Frame, config: DeploymentConfig): SshTarget {
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  if (!frame.host) throw new Error('frame has no host/IP to SSH to');
  // The frame can carry its own ssh user (Latitude VMs land on `ubuntu` — root is
  // disabled); an explicit provider.sshUser still overrides. Non-root logins run
  // remote commands under sudo (passwordless on the default images).
  const user =
    (provider.sshUser as string | undefined) ?? (frame.meta?.sshUser as string | undefined) ?? 'root';
  return {
    host: frame.host,
    user,
    identityFile: provider.sshIdentityFile as string | undefined,
    sudo: user !== 'root',
  };
}

export function defaultMakeRemoteExec(frame: Frame, config: DeploymentConfig): RemoteExec {
  return createSshRemoteExec(sshTargetForFrame(frame, config));
}

/**
 * Derive the frame's agent backend from the blueprint env (the env spec is the
 * backend authority — its `AGENT_BACKEND` already overrides the loop's export at
 * runtime). Without this the bootstrap always assumed `omp` and installed +
 * launched an unused Meridian on claude/codex frames (found live 2026-06-09).
 * Values follow the runtime vocabulary: `claude-code`→claude, `codex`→codex,
 * anything else (incl. unset) → the historical `omp` default.
 */
export function deriveAgentBackend(env: Record<string, string> | undefined): 'omp' | 'claude' | 'codex' {
  const v = (env?.AGENT_BACKEND ?? '').trim().toLowerCase();
  if (v === 'claude-code' || v === 'claude') return 'claude';
  if (v === 'codex') return 'codex';
  return 'omp';
}

/** Bootstrap the papercusp runtime on a provisioned frame (own loop + own embedded-pg). */
export async function installFrame(
  frame: Frame,
  config: DeploymentConfig,
  ctx: DeploymentContext,
  deps: FrameInstallerDeps = {},
): Promise<void> {
  const makeRemoteExec = deps.makeRemoteExec ?? defaultMakeRemoteExec;
  const boot = ctx.bootstrap ?? {};
  const exec = makeRemoteExec(frame, config);
  const log = (msg: string) => ctx.log?.('info', `[install] ${msg}`);

  // The API saying "ready" ≠ sshd accepting — wait before any scp/script.
  await waitForSsh(exec, log, deps.sshWait);

  // Staging lives in /tmp (the login user may be non-root and can't write /root).
  // Pre-clean the exact paths AS ROOT so a pre-planted file/symlink at a
  // predictable name can never capture or redirect a staged credential.
  if (boot.credentialsLocalPath || boot.oauthTokenLocalPath || boot.runtimeTarballLocalPath) {
    await exec.runScript(
      `rm -rf ${REMOTE_CRED_PATH} ${REMOTE_TOKEN_PATH} ${REMOTE_RUNTIME_TARBALL_PATH}`,
    );
  }

  // P-011: stage the per-frame Claude subscription (its own rate limits) first —
  // either a credentials bundle, a long-lived OAuth token, or both.
  if (boot.credentialsLocalPath) {
    log(`staging per-frame Claude credentials → ${REMOTE_CRED_PATH}`);
    await exec.copyFile(boot.credentialsLocalPath, REMOTE_CRED_PATH);
  }
  if (boot.oauthTokenLocalPath) {
    log(`staging per-frame Claude OAuth token → ${REMOTE_TOKEN_PATH}`);
    await exec.copyFile(boot.oauthTokenLocalPath, REMOTE_TOKEN_PATH);
  }
  // P-010 private-repo runtime delivery: stage the operator-packed tarball.
  if (boot.runtimeTarballLocalPath) {
    log(`staging runtime tarball → ${REMOTE_RUNTIME_TARBALL_PATH}`);
    await exec.copyFile(boot.runtimeTarballLocalPath, REMOTE_RUNTIME_TARBALL_PATH);
  }
  const { script } = buildFrameBootstrap({
    harnessSlug: ctx.harnessSlug,
    repoUrl: boot.repoUrl,
    repoRef: boot.repoRef,
    environment: {
      setup: boot.setup ?? [],
      install: boot.install ?? [],
      build: boot.build ?? [],
      test: [],
      run: boot.run ?? [],
      services: boot.services ?? [],
      ports: boot.ports ?? [],
      env: boot.env ?? {},
    },
    agentBackend: deriveAgentBackend(boot.env),
    claudeCredentialsRemotePath: boot.credentialsLocalPath ? REMOTE_CRED_PATH : undefined,
    claudeTokenRemotePath: boot.oauthTokenLocalPath ? REMOTE_TOKEN_PATH : undefined,
    accountId: boot.accountId, // P-019: export PAPERCUSP_ACCOUNT_ID so the frame keys rate buckets per-account

    runtimeTarballRemotePath: boot.runtimeTarballLocalPath ? REMOTE_RUNTIME_TARBALL_PATH : undefined,
    embeddedPg: true, // D-007 ratified — frame runs its own embedded-pg
    orchestratorOnFrame: true, // D-006 ratified — frame runs its own loop
    env: boot.env,
    instanceConfigJson: boot.instanceConfigJson, // P-008: frame's instance config via env
    controlNode: boot.controlNode, // P-016: the Queen supervises across frames (unscoped)
    // hive-frame-desktops P-001/P-003: the desktop capability knob rides the
    // deployment config (a frame capability, not a bootstrap input).
    desktop: config.desktop,
  });
  log(`bootstrapping frame ${frame.id} (${script.length} bytes; own loop + own embedded-pg per D-006/D-007)`);
  await exec.runScript(script);
  log(`frame ${frame.id} bootstrapped`);
}

/** Admit the frame as a headless federated peer. */
export async function joinFrame(
  frame: Frame,
  config: DeploymentConfig,
  ctx: DeploymentContext,
  deps: FrameInstallerDeps = {},
): Promise<void> {
  if (deps.onJoin) {
    await deps.onJoin(frame, config, ctx);
    return;
  }
  // The frame admits itself via its boot announce (signed device pubkey →
  // read-admission). Explicit headless-peer admission lands with P-015 (deps.onJoin).
  ctx.log?.('info', `[install] frame ${frame.id} joins as a headless peer via its boot announce (P-014/P-015)`);
}
