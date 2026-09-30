/**
 * Hive deploy orchestration (`cloud-deployment-layer-2026-06-06` P-016/P-017).
 *
 * A **Hive** is a grouping of harnesses + shared settings (the pot-equivalent;
 * owner's D-009/D-010 reframe). It runs LOCALLY or is **deployed to a Swarm** —
 * the cloud fleet of frames its members' execution runs on. Deploying a Hive =
 * deploy each member harness's execution plane to a frame (P-012) + place the
 * Queen (control). All are federated peers (D-004): full-auto Hives run
 * laptop-optional; human-gated items federate to the local control peer and park
 * until acted on (placement is orthogonal to supervision — D-005).
 *
 * Queen placement is a CONFIG OPTION (decision-agnostic — D-008 is still open):
 *   - `local`     — the local app is the Queen; no cloud control frame (cheapest;
 *                   the common human-online case).
 *   - `dedicated` — a small always-on control frame runs the Queen (laptop-optional
 *                   full-auto; decouples supervision from any worker's lifecycle).
 *   - `colocated` — the Queen rides one execution frame (cheaper; couples it).
 *
 * Lifecycle: deploy / pause (destroy-to-stop) / scale / teardown, + cost controls
 * (per-frame budget caps, idle reaper). Deps injected for unit-testability.
 */
import type { DeploymentConfig, DeploymentContext, Frame, LogLevel } from '@papercusp/deployment-driver';
import { resolveDeploymentDriver } from '@papercusp/deployment-driver';

export type QueenPlacement = 'local' | 'dedicated' | 'colocated';

export interface HiveDeploySpec {
  potId: string;
  /** Harness slugs whose execution deploys to the Swarm. */
  members: string[];
  /** The cloud target for the execution frames. */
  swarm: DeploymentConfig;
  queen?: {
    placement: QueenPlacement;
    /** Deployment for the dedicated control frame (defaults to a small `swarm`-like box). */
    deployment?: DeploymentConfig;
  };
  /** Cost controls (P-017). */
  budget?: {
    /** Tear a frame down once it has cost ≥ this (USD). */
    perFrameUsdCap?: number;
    /** Reap a frame idle longer than this (minutes). */
    idleReaperMinutes?: number;
  };
}

export interface HiveDeployDeps {
  /** Set a member harness's deployment config (so it provisions onto the Swarm). */
  setMemberDeployment: (slug: string, workspaceId: string, deployment: DeploymentConfig) => Promise<void>;
  deployHarness: (slug: string, workspaceId: string) => Promise<{ frame: Frame }>;
  teardownHarness: (slug: string, workspaceId: string) => Promise<{ destroyed: boolean }>;
  /** Deploy/teardown the dedicated Queen control frame (only used for `dedicated`). */
  deployControlFrame?: (potId: string, workspaceId: string, deployment: DeploymentConfig) => Promise<Frame>;
  teardownControlFrame?: (potId: string, workspaceId: string) => Promise<{ destroyed: boolean }>;
  /** Persist the actual joined frame identity as the Hive's Queen home. */
  recordQueenHome?: (potId: string, workspaceId: string, devicePubkey: string) => Promise<void>;
  log?: (level: LogLevel, msg: string) => void;
}

export interface HiveMemberResult {
  slug: string;
  frame?: Frame;
  error?: string;
}
export interface HiveDeployResult {
  potId: string;
  members: HiveMemberResult[];
  controlFrame?: Frame;
  queenPlacement: QueenPlacement;
}

const placementOf = (spec: HiveDeploySpec): QueenPlacement => spec.queen?.placement ?? 'local';

/**
 * Pick the frame that owns the Queen for a completed deployment. Colocated has
 * no separate control frame, so the first successfully deployed member in the
 * caller's deterministic order owns the Queen.
 */
export function queenHomeFrameForPlacement(
  placement: QueenPlacement,
  controlFrame: Frame | undefined,
  members: readonly HiveMemberResult[],
): Frame | undefined {
  if (placement === 'dedicated') return controlFrame;
  if (placement === 'colocated') return members.find((member) => member.frame)?.frame;
  return undefined;
}

/** The headless join hook stores the runtime identity in Frame.meta. */
export function frameDevicePubkey(frame: Frame | undefined): string | undefined {
  const value = frame?.meta?.devicePubkey;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Deploy a Hive to a Swarm: place the Queen, then deploy each member's execution.
 * Per-member failures are captured (not thrown) so one bad member doesn't strand
 * the rest — the result reports which members are live vs errored.
 */
export async function deployHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<HiveDeployResult> {
  const placement = placementOf(spec);
  deps.log?.('info', `[hive] deploying ${spec.potId} (${spec.members.length} members → ${spec.swarm.target}; queen=${placement})`);

  let controlFrame: Frame | undefined;
  if (placement === 'dedicated') {
    if (!deps.deployControlFrame) throw new Error('deployHive: queen.placement=dedicated requires deps.deployControlFrame');
    const queenDeployment = spec.queen?.deployment ?? spec.swarm;
    controlFrame = await deps.deployControlFrame(spec.potId, workspaceId, queenDeployment);
    deps.log?.('info', `[hive] ${spec.potId} Mug on dedicated control frame ${controlFrame.id}`);
  } else {
    deps.log?.('info', `[hive] ${spec.potId} Mug is ${placement === 'local' ? 'the local control peer' : 'co-located on an execution frame'} — no separate control frame`);
  }

  const members: HiveMemberResult[] = [];
  for (const slug of spec.members) {
    try {
      await deps.setMemberDeployment(slug, workspaceId, spec.swarm);
      const { frame } = await deps.deployHarness(slug, workspaceId);
      members.push({ slug, frame });
    } catch (e) {
      members.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
      deps.log?.('error', `[hive] ${spec.potId} member ${slug} failed: ${members[members.length - 1].error}`);
    }
  }

  const queenFrame = queenHomeFrameForPlacement(placement, controlFrame, members);
  const queenHomePubkey = frameDevicePubkey(queenFrame);
  if (queenFrame && !queenHomePubkey) {
    deps.log?.('warn', `[hive] ${spec.potId} ${placement} Queen frame ${queenFrame.id} joined without a device pubkey; home not recorded`);
  } else if (queenHomePubkey) {
    await deps.recordQueenHome?.(spec.potId, workspaceId, queenHomePubkey);
  }
  return { potId: spec.potId, members, controlFrame, queenPlacement: placement };
}

/**
 * Tear down a Hive — DESTROY every execution frame + the control frame (ends all
 * billing). Best-effort across members; reports each outcome.
 */
export async function teardownHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<{ potId: string; destroyed: string[]; failed: string[] }> {
  const destroyed: string[] = [];
  const failed: string[] = [];
  for (const slug of spec.members) {
    try {
      const r = await deps.teardownHarness(slug, workspaceId);
      if (r.destroyed) destroyed.push(slug);
    } catch {
      failed.push(slug);
    }
  }
  if (placementOf(spec) === 'dedicated' && deps.teardownControlFrame) {
    try {
      const r = await deps.teardownControlFrame(spec.potId, workspaceId);
      if (r.destroyed) destroyed.push(`queen:${spec.potId}`);
    } catch {
      failed.push(`queen:${spec.potId}`);
    }
  }
  deps.log?.('info', `[hive] ${spec.potId} torn down: destroyed ${destroyed.length}, failed ${failed.length}`);
  return { potId: spec.potId, destroyed, failed };
}

/**
 * Pause a Hive = destroy-to-stop its execution frames (the frame model is cattle —
 * there's no "stop", so pause frees billing and redeploy re-provisions). The Hive
 * definition + its federated state persist; only the live compute goes away. The
 * Queen control frame stays up (so the paused Hive is still supervisable) unless
 * `includeQueen`.
 */
export async function pauseHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  deps: HiveDeployDeps,
  opts: { includeQueen?: boolean } = {},
): Promise<{ potId: string; paused: string[] }> {
  const paused: string[] = [];
  for (const slug of spec.members) {
    const r = await deps.teardownHarness(slug, workspaceId).catch(() => ({ destroyed: false }));
    if (r.destroyed) paused.push(slug);
  }
  if (opts.includeQueen && placementOf(spec) === 'dedicated' && deps.teardownControlFrame) {
    await deps.teardownControlFrame(spec.potId, workspaceId).catch(() => undefined);
  }
  deps.log?.('info', `[hive] ${spec.potId} paused (${paused.length} frames destroyed to stop billing)`);
  return { potId: spec.potId, paused };
}

/**
 * Scale a Hive: deploy newly-added members + tear down removed ones. Returns the
 * delta. The caller updates `spec.members` to the new set.
 */
export async function scaleHive(
  spec: HiveDeploySpec,
  workspaceId: string,
  change: { add?: string[]; remove?: string[] },
  deps: HiveDeployDeps,
): Promise<{ added: HiveMemberResult[]; removed: string[] }> {
  const added: HiveMemberResult[] = [];
  for (const slug of change.add ?? []) {
    try {
      await deps.setMemberDeployment(slug, workspaceId, spec.swarm);
      const { frame } = await deps.deployHarness(slug, workspaceId);
      added.push({ slug, frame });
    } catch (e) {
      added.push({ slug, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  const removed: string[] = [];
  for (const slug of change.remove ?? []) {
    const r = await deps.teardownHarness(slug, workspaceId).catch(() => ({ destroyed: false }));
    if (r.destroyed) removed.push(slug);
  }
  deps.log?.('info', `[hive] ${spec.potId} scaled: +${added.length} / -${removed.length}`);
  return { added, removed };
}

// ── Cost controls (P-017) ───────────────────────────────────────────────────

export interface FrameCostState {
  slug: string;
  /** Accrued cost for this frame (USD). */
  costUsd?: number;
  /** Epoch-ms of last activity on this frame. */
  lastActivityMs?: number;
}

/**
 * Decide which frames to reap NOW (pure): a frame is reaped if it's over its
 * per-frame budget cap, OR idle longer than the idle-reaper window. `nowMs` is
 * passed in (no ambient clock) so this is deterministic + testable.
 */
export function computeFramesToReap(
  spec: HiveDeploySpec,
  frames: FrameCostState[],
  nowMs: number,
): { slug: string; reason: 'budget' | 'idle' }[] {
  const out: { slug: string; reason: 'budget' | 'idle' }[] = [];
  const cap = spec.budget?.perFrameUsdCap;
  const idleMs = spec.budget?.idleReaperMinutes != null ? spec.budget.idleReaperMinutes * 60_000 : undefined;
  for (const f of frames) {
    if (cap != null && f.costUsd != null && f.costUsd >= cap) {
      out.push({ slug: f.slug, reason: 'budget' });
    } else if (idleMs != null && f.lastActivityMs != null && nowMs - f.lastActivityMs >= idleMs) {
      out.push({ slug: f.slug, reason: 'idle' });
    }
  }
  return out;
}

/** Reap (destroy-to-stop) the frames `computeFramesToReap` selects. */
export async function reapHiveFrames(
  spec: HiveDeploySpec,
  frames: FrameCostState[],
  nowMs: number,
  workspaceId: string,
  deps: HiveDeployDeps,
): Promise<{ slug: string; reason: 'budget' | 'idle' }[]> {
  const toReap = computeFramesToReap(spec, frames, nowMs);
  for (const { slug, reason } of toReap) {
    deps.log?.('info', `[hive] ${spec.potId} reaping ${slug} (${reason}) — destroy-to-stop`);
    await deps.teardownHarness(slug, workspaceId).catch(() => undefined);
  }
  return toReap;
}

// ── Real dependency wiring ───────────────────────────────────────────────────

/**
 * Wire the Hive deps to the real deploy orchestration + registry: members deploy
 * via `deployHarness` (their `deployment` is set to the Swarm first); the dedicated
 * Queen control frame is provisioned + bootstrapped as a control node (supervises
 * across frames) and its handle persisted in operator_state so teardown finds it.
 */
export function defaultHiveDeployDeps(log?: (level: LogLevel, msg: string) => void): HiveDeployDeps {
  const ctxFor = (potId: string, ws: string): DeploymentContext => ({
    harnessSlug: `hive-queen-${potId}`,
    workspaceId: ws,
    log,
  });

  return {
    log,
    async setMemberDeployment(slug, workspaceId, deployment) {
      const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
      const reg = await loadHarnessRegistry(workspaceId);
      const p = reg.projects.find((x) => x.slug === slug);
      if (p) {
        p.deployment = deployment;
        await saveHarnessRegistry(reg, workspaceId);
      }
    },
    async deployHarness(slug, workspaceId) {
      const { deployHarness, defaultDeployDeps } = await import('./deploy');
      return deployHarness(slug, workspaceId, defaultDeployDeps(log));
    },
    async teardownHarness(slug, workspaceId) {
      const { teardownHarness, defaultDeployDeps } = await import('./deploy');
      return teardownHarness(slug, workspaceId, defaultDeployDeps(log));
    },
    async deployControlFrame(potId, workspaceId, deployment) {
      const { resolveCredential } = await import('./bootstrap-input');
      const driver = resolveDeploymentDriver(deployment);
      const ctx: DeploymentContext = {
        ...ctxFor(potId, workspaceId),
        bootstrap: { controlNode: true, ...resolveCredential(deployment.credentialRef) },
      };
      const frame = await driver.provision(deployment, ctx);
      await persistControlFrame(potId, workspaceId, frame);
      await driver.install(frame, deployment, ctx);
      await driver.join(frame, deployment, ctx);
      // join hooks mint the frame's runtime device identity in Frame.meta. Refresh
      // the durable handle after join so teardown/restart retains that identity.
      await persistControlFrame(potId, workspaceId, frame);
      return frame;
    },
    async teardownControlFrame(potId, workspaceId) {
      const frame = await loadControlFrame(potId, workspaceId);
      if (!frame) return { destroyed: false };
      const config: DeploymentConfig = { target: frame.target };
      const driver = resolveDeploymentDriver(config);
      await driver.teardown(frame, config, ctxFor(potId, workspaceId));
      await clearControlFrame(potId, workspaceId);
      return { destroyed: true };
    },
    async recordQueenHome(potId, workspaceId, devicePubkey) {
      const { setQueenHomePubkey } = await import('../hive-settings-store');
      await setQueenHomePubkey(workspaceId, potId, devicePubkey);
      log?.('info', `[hive] ${potId} Queen home recorded (${devicePubkey.slice(0, 12)}…)`);
    },
  };
}

// Queen control-frame handles persist in the existing `harness_registry` blob
// (workspace PG) under `hiveControlFrames` — no new table/migration, alongside the
// per-harness `deploymentFrame` handles.
async function loadControlFrame(potId: string, workspaceId: string): Promise<Frame | undefined> {
  const { loadHarnessRegistry } = await import('../harness-registry');
  return (await loadHarnessRegistry(workspaceId)).hiveControlFrames?.[potId];
}
async function persistControlFrame(potId: string, workspaceId: string, frame: Frame): Promise<void> {
  const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  reg.hiveControlFrames = { ...(reg.hiveControlFrames ?? {}), [potId]: frame };
  await saveHarnessRegistry(reg, workspaceId);
}
async function clearControlFrame(potId: string, workspaceId: string): Promise<void> {
  const { loadHarnessRegistry, saveHarnessRegistry } = await import('../harness-registry');
  const reg = await loadHarnessRegistry(workspaceId);
  if (reg.hiveControlFrames) {
    delete reg.hiveControlFrames[potId];
    await saveHarnessRegistry(reg, workspaceId);
  }
}
