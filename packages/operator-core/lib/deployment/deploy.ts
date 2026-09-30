/**
 * Deploy orchestration (`cloud-deployment-layer-2026-06-06` P-012).
 *
 * Drives one harness's execution onto a cloud frame through the
 * provider-agnostic driver: provision → persist the frame handle → install →
 * join. Once the frame is up it runs its OWN orchestrator loop (D-006) against
 * its OWN embedded-pg federating via the peer-log (D-007), so STATE federates
 * back to the local view automatically — the local app is one more peer. Teardown
 * = DESTROY (not stop) to end billing (P-017 cost control).
 *
 * Dependencies are injected so the whole lifecycle is unit-testable with a mocked
 * driver + in-memory persistence; `defaultDeployDeps()` wires the real registry +
 * blueprint env-spec + git remote.
 */
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
  FrameBootstrapInput,
  LogLevel,
} from '@papercusp/deployment-driver';
import { resolveDeploymentDriver } from '@papercusp/deployment-driver';
import { headlessAdmission } from './configure'; // registers cloud backends + the admission instance
import { revokeFrameOnTeardown } from './headless-peer';

export interface DeployDeps {
  resolveDriver: (config: DeploymentConfig) => DeploymentDriver;
  /** The harness's deployment config (from the registry). */
  getDeploymentConfig: (slug: string, workspaceId: string) => Promise<DeploymentConfig | undefined>;
  /** Assemble the frame bootstrap input — repo + blueprint env spec + credentials. */
  buildBootstrap: (slug: string, workspaceId: string, config: DeploymentConfig) => Promise<FrameBootstrapInput>;
  persistFrame: (slug: string, workspaceId: string, frame: Frame) => Promise<void>;
  loadFrame: (slug: string, workspaceId: string) => Promise<Frame | undefined>;
  clearFrame: (slug: string, workspaceId: string) => Promise<void>;
  /** Revoke a destroyed frame's headless-peer device pubkey (P-015). */
  revokeFrame?: (frame: Frame, slug: string, workspaceId: string) => Promise<void>;
  /**
   * P-020: pick + bind an account from the pool to this deploy, returning the
   * (possibly account-augmented) config. Omit to skip account selection (the config
   * is used as-is — today's behavior). The default deps wire this to the pool's
   * headroom selection + persist the binding onto the registry.
   */
  selectAccount?: (config: DeploymentConfig, slug: string, workspaceId: string) => Promise<DeploymentConfig>;
  log?: (level: LogLevel, msg: string) => void;
}

export interface DeployResult {
  harnessSlug: string;
  frame: Frame;
}

function ctxFor(
  slug: string,
  workspaceId: string,
  bootstrap: FrameBootstrapInput | undefined,
  deps: DeployDeps,
  signal?: AbortSignal,
): DeploymentContext {
  return { harnessSlug: slug, workspaceId, bootstrap, signal, log: deps.log };
}

/**
 * Deploy a harness's execution plane to a cloud frame. Idempotent-ish: the frame
 * handle is persisted BEFORE install so a crash mid-install still leaves a
 * destroyable frame (no leaked billing). Throws if the harness is local-only.
 */
export async function deployHarness(
  slug: string,
  workspaceId: string,
  deps: DeployDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<DeployResult> {
  const config0 = await deps.getDeploymentConfig(slug, workspaceId);
  if (!config0 || config0.target === 'local') {
    throw new Error(`deployHarness: harness '${slug}' has no cloud deployment config (target=${config0?.target ?? 'local'})`);
  }
  // Double-deploy guard: a recorded frame means this harness is (or may still be)
  // live on a machine. Provisioning again would OVERWRITE the handle, orphaning the
  // old frame as an untracked billing leak. Frames are cattle — tear down first.
  const existing = await deps.loadFrame(slug, workspaceId);
  if (existing) {
    throw new Error(
      `deployHarness: harness '${slug}' already has a deployed frame recorded ` +
        `(${existing.id}${existing.host ? ` @ ${existing.host}` : ''}) — run deploy:teardown first ` +
        `(re-provisioning would overwrite the handle and orphan the old frame's billing)`,
    );
  }
  // P-020: bind an account from the pool (by rate-limit headroom) before provisioning,
  // unless the config already pins a credentialRef. No-op when no pool/hook is wired.
  const config = deps.selectAccount ? await deps.selectAccount(config0, slug, workspaceId) : config0;
  const driver = deps.resolveDriver(config);
  deps.log?.('info', `[deploy] ${slug} → ${config.target} (region=${config.region ?? 'default'}${config.accountId ? `, account=${config.accountId}` : ''})`);

  const bootstrap = await deps.buildBootstrap(slug, workspaceId, config);
  const ctx = ctxFor(slug, workspaceId, bootstrap, deps, opts.signal);

  const frame = await driver.provision(config, ctx);
  // Persist FIRST — a frame that exists but isn't recorded is an un-destroyable
  // billing leak. Recording it before install means teardown can always find it.
  await deps.persistFrame(slug, workspaceId, frame);
  deps.log?.('info', `[deploy] ${slug} provisioned frame ${frame.id}${frame.host ? ` @ ${frame.host}` : ''}`);

  try {
    await driver.install(frame, config, ctx);
    await driver.join(frame, config, ctx);
    // The headless join hook records the runtime device identity in Frame.meta.
    // Refresh the durable handle after join while retaining the pre-install
    // snapshot above as the billing-leak safety net.
    await deps.persistFrame(slug, workspaceId, frame);
  } catch (err) {
    deps.log?.('error', `[deploy] ${slug} install/join failed — frame ${frame.id} left provisioned for retry/teardown: ${(err as Error).message}`);
    throw err;
  }
  deps.log?.('info', `[deploy] ${slug} live on frame ${frame.id}; state federates to the local peer`);
  return { harnessSlug: slug, frame };
}

/**
 * Tear down a harness's cloud frame — DESTROY (not stop) to end billing. No-op if
 * nothing is deployed. Clears the persisted handle only after a successful
 * teardown so a failed destroy stays retryable (the frame is still recorded).
 */
export async function teardownHarness(
  slug: string,
  workspaceId: string,
  deps: DeployDeps,
  opts: { signal?: AbortSignal } = {},
): Promise<{ destroyed: boolean }> {
  const frame = await deps.loadFrame(slug, workspaceId);
  if (!frame) {
    deps.log?.('info', `[deploy] ${slug} has no deployed frame — nothing to tear down`);
    return { destroyed: false };
  }
  const config = (await deps.getDeploymentConfig(slug, workspaceId)) ?? { target: frame.target };
  const driver = deps.resolveDriver(config);
  const ctx = ctxFor(slug, workspaceId, undefined, deps, opts.signal);
  deps.log?.('info', `[deploy] ${slug} tearing down frame ${frame.id} (DESTROY → ends billing)`);
  await driver.teardown(frame, config, ctx);
  // P-015: revoke the destroyed frame's headless-peer device pubkey so a gone
  // machine can never federate again. Best-effort — a revoke hiccup must not leave
  // the frame recorded (it's already destroyed).
  if (deps.revokeFrame) await deps.revokeFrame(frame, slug, workspaceId).catch(() => undefined);
  await deps.clearFrame(slug, workspaceId);
  deps.log?.('info', `[deploy] ${slug} frame ${frame.id} destroyed + de-registered`);
  return { destroyed: true };
}

/**
 * The real dependency wiring: deployment config + frame handle live on the
 * registry ProjectEntry (workspace PG); the bootstrap input comes from the
 * harness's effective blueprint `environment` spec (P-007) + its git remote +
 * the credential bundle named by `deployment.credentialRef`.
 */
export function defaultDeployDeps(
  log?: (level: LogLevel, msg: string) => void,
): DeployDeps {
  return {
    resolveDriver: (config) => resolveDeploymentDriver(config),
    log,
    revokeFrame: (frame, slug, workspaceId) => revokeFrameOnTeardown(frame, slug, workspaceId, headlessAdmission),
    async selectAccount(config, slug, workspaceId) {
      const { selectAccountForDeploy, defaultDeployAccountDeps } = await import('./account-pool-store');
      const effective = await selectAccountForDeploy(config, slug, workspaceId, defaultDeployAccountDeps(log));
      // Persist the chosen account onto the registry so the frame bootstrap, status, and
      // teardown all see the same credentialRef/accountId across operator restarts.
      if (effective.credentialRef !== config.credentialRef || effective.accountId !== config.accountId) {
        const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
        const reg = await loadHarnessRegistry(workspaceId);
        const p = reg.projects.find((x) => x.slug === slug);
        if (p) {
          p.deployment = effective;
          await saveHarnessRegistry(reg, workspaceId);
        }
      }
      return effective;
    },
    async getDeploymentConfig(slug, workspaceId) {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      return reg.projects.find((p) => p.slug === slug)?.deployment;
    },
    async buildBootstrap(slug, workspaceId, config) {
      const { buildDeployBootstrapInput } = await import('./bootstrap-input');
      return buildDeployBootstrapInput(slug, workspaceId, config);
    },
    async persistFrame(slug, workspaceId, frame) {
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p) {
        p.deploymentFrame = frame;
        await saveHarnessRegistry(reg, workspaceId);
      }
    },
    async loadFrame(slug, workspaceId) {
      const { loadHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      return reg.projects.find((p) => p.slug === slug)?.deploymentFrame;
    },
    async clearFrame(slug, workspaceId) {
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p && p.deploymentFrame) {
        delete p.deploymentFrame;
        await saveHarnessRegistry(reg, workspaceId);
      }
    },
  };
}
