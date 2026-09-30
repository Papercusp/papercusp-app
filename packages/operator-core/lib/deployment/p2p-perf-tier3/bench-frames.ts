/**
 * bench-frames.ts — provision a small fleet of Tier-3 bench frames, install the
 * bench runtime on each, and tear them ALL down (DESTROY → ends billing), with a
 * crash-recovery sweeper so a killed run never leaks a billing machine
 * (p2p-performance-suite-2026-06-07 P-010, D-004 cost posture).
 *
 * This rides the deployment layer's DRIVERS (`provision`/`teardown`) directly
 * rather than `deployHarness` — a bench peer is not a harness node (see
 * bench-bootstrap.ts). The provider-agnostic SSH install (scp the operator-packed
 * runtime tarball, run the bench-bootstrap script) is shared across drivers, so
 * the same fleet code runs on Latitude or Hetzner.
 *
 * Anti-billing-leak is belt-and-braces (stronger than persist-before-install):
 *   1. every provisioned frame id is appended to a manifest BEFORE install;
 *   2. `teardownAll()` destroys every frame in a finally and clears the manifest;
 *   3. a provision/install failure destroys whatever already came up, then rethrows;
 *   4. `sweepLeftoverBenchFrames()` (run at fleet start) destroys frames the
 *      manifest still lists from a previously-crashed run.
 * The platform idle-reaper (hive-deploy.ts) is still design-only; until it lands
 * the manifest + the scenario's wall-clock deadline are the cost backstop.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type {
  DeploymentConfig,
  DeploymentContext,
  DeploymentDriver,
  Frame,
  FrameKind,
  LogLevel,
} from '@papercusp/deployment-driver';
import { packRuntimeTarball } from '../runtime-pack';
import {
  createSshRemoteExec,
  type RemoteExec,
  type SshTarget,
} from '../remote-exec';
import { waitForSsh, sshTargetForFrame, REMOTE_RUNTIME_TARBALL_PATH } from '../frame-installer';
import { buildBenchBootstrap } from './bench-bootstrap';

/** One bench frame to stand up. */
export interface BenchFrameSpec {
  /** Stable label (region or role) used in artifacts/reports + the corestore dir. */
  label: string;
  region?: string;
  /** Provider plan/size (Latitude plan slug / Hetzner server_type). Default per-driver. */
  size?: string;
  kind?: FrameKind;
  /** Arm the NAT-like inbound-drop firewall on this frame (P-011 holepunch variant). */
  firewall?: boolean;
  /** Provider-specific extras merged into the deployment config (project id, ssh keys, …). */
  provider?: Record<string, unknown>;
}

export interface BenchFrame {
  spec: BenchFrameSpec;
  frame: Frame;
  target: SshTarget;
  exec: RemoteExec;
  firewall: boolean;
}

export interface BenchFleet {
  frames: BenchFrame[];
  /** DESTROY every frame (ends billing) + clear them from the manifest. Idempotent. */
  teardownAll(): Promise<void>;
}

export interface ProvisionBenchFleetOpts {
  driver: DeploymentDriver;
  specs: BenchFrameSpec[];
  workspaceId?: string;
  /** Repo root to pack into the runtime tarball (sources only; deps re-resolved on the frame). */
  repoRoot: string;
  /** Local private-key path matching the ssh_keys injected at provision. */
  sshIdentityFile?: string;
  /** Install root on each frame (default `/opt/papercusp`). */
  installRoot?: string;
  /** Per-frame provider block defaults (e.g. { project, sshKeys }) merged under spec.provider. */
  providerDefaults?: Record<string, unknown>;
  log: (level: LogLevel, msg: string) => void;
  /** Manifest path override (tests). Default `~/.papercusp/p2p-perf-frames.json`. */
  manifestPath?: string;
  /** SSH-readiness probe tuning (tests). */
  sshWait?: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> };
  /** Build the RemoteExec for a frame. Injected for tests; default = real SSH. */
  makeRemoteExec?: (target: SshTarget) => RemoteExec;
  /** Pack the runtime tarball. Injected for tests; default = real `tar`. */
  packTarball?: (repoRoot: string, outPath: string) => Promise<{ outPath: string; bytes: number }>;
  signal?: AbortSignal;
}

/* ───────────────────────── manifest (cost-safety) ───────────────────────── */

interface ManifestEntry {
  id: string;
  target: string;
  region?: string;
  label: string;
  createdAt: string;
}

function defaultManifestPath(): string {
  return join(homedir(), '.papercusp', 'p2p-perf-frames.json');
}

function readManifest(path: string): ManifestEntry[] {
  try {
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as ManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(path: string, entries: ManifestEntry[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2));
}

function addToManifest(path: string, entry: ManifestEntry): void {
  const entries = readManifest(path).filter((e) => e.id !== entry.id);
  entries.push(entry);
  writeManifest(path, entries);
}

function removeFromManifest(path: string, id: string): void {
  writeManifest(
    path,
    readManifest(path).filter((e) => e.id !== id),
  );
}

/**
 * Destroy any frames the manifest still lists for this driver's target — the
 * crash-recovery backstop. Best-effort: a destroy that fails is logged and left
 * in the manifest for the next sweep (never throws — a sweep failure must not
 * block a fresh run).
 */
export async function sweepLeftoverBenchFrames(opts: {
  driver: DeploymentDriver;
  workspaceId?: string;
  log: (level: LogLevel, msg: string) => void;
  manifestPath?: string;
}): Promise<number> {
  const path = opts.manifestPath ?? defaultManifestPath();
  const stale = readManifest(path).filter((e) => e.target === opts.driver.target);
  if (!stale.length) return 0;
  opts.log('warn', `[bench-fleet] sweeping ${stale.length} leftover ${opts.driver.target} frame(s) from a prior run`);
  let destroyed = 0;
  for (const e of stale) {
    const frame: Frame = { id: e.id, target: e.target, placement: 'remote', region: e.region };
    const config: DeploymentConfig = { target: e.target, provider: {} };
    const ctx: DeploymentContext = {
      harnessSlug: `p2p-perf-${e.label}`,
      workspaceId: opts.workspaceId ?? 'p2p-perf',
      log: opts.log,
    };
    try {
      await opts.driver.teardown(frame, config, ctx);
      removeFromManifest(path, e.id);
      destroyed++;
      opts.log('info', `[bench-fleet] swept leftover frame ${e.id}`);
    } catch (err) {
      opts.log('error', `[bench-fleet] could NOT sweep ${e.id} (still left in manifest): ${(err as Error).message}`);
    }
  }
  return destroyed;
}

/* ──────────────────────────── provision ──────────────────────────── */

function configForSpec(spec: BenchFrameSpec, opts: ProvisionBenchFleetOpts): DeploymentConfig {
  return {
    target: opts.driver.target,
    region: spec.region,
    size: spec.size,
    kind: spec.kind ?? 'vm', // D-004: VMs by default (cheap + fast vs metal)
    provider: { ...(opts.providerDefaults ?? {}), ...(spec.provider ?? {}) },
  };
}

/**
 * Provision all frames, install the bench runtime on each, and return a fleet
 * whose `teardownAll()` destroys them. Packs the runtime tarball ONCE and stages
 * it to every frame. On any failure, destroys whatever already provisioned.
 */
export async function provisionBenchFleet(opts: ProvisionBenchFleetOpts): Promise<BenchFleet> {
  const manifestPath = opts.manifestPath ?? defaultManifestPath();
  const installRoot = opts.installRoot ?? '/opt/papercusp';
  const workspaceId = opts.workspaceId ?? 'p2p-perf';

  // 1. Sweep any leftovers from a prior crashed run BEFORE we add new ones.
  await sweepLeftoverBenchFrames({
    driver: opts.driver,
    workspaceId,
    log: opts.log,
    manifestPath,
  });

  // 2. Pack the runtime tarball once (sources only; the frame npm-ci's the rest).
  const pack = opts.packTarball ?? packRuntimeTarball;
  const makeExec = opts.makeRemoteExec ?? createSshRemoteExec;
  const tarballPath = join(homedir(), '.papercusp', `p2p-perf-runtime-${Date.now()}.tgz`);
  mkdirSync(join(tarballPath, '..'), { recursive: true });
  opts.log('info', `[bench-fleet] packing runtime tarball from ${opts.repoRoot}`);
  const { bytes } = await pack(opts.repoRoot, tarballPath);
  opts.log('info', `[bench-fleet] runtime tarball ${(bytes / 1024 / 1024).toFixed(0)}MB`);

  const provisioned: BenchFrame[] = [];

  const destroyOne = async (bf: BenchFrame): Promise<void> => {
    try {
      await opts.driver.teardown(bf.frame, configForSpec(bf.spec, opts), {
        harnessSlug: `p2p-perf-${bf.spec.label}`,
        workspaceId,
        log: opts.log,
      });
      removeFromManifest(manifestPath, bf.frame.id);
    } catch (e) {
      opts.log('error', `[bench-fleet] teardown of ${bf.frame.id} FAILED — may still bill: ${(e as Error).message}`);
    }
  };

  try {
    // Provision + install each frame. Sequential keeps log output legible and
    // VM provisions are seconds; the cost is a few frames so parallelism buys
    // little but complicates teardown-on-failure.
    for (const spec of opts.specs) {
      if (opts.signal?.aborted) throw new Error('provisionBenchFleet: aborted');
      const config = configForSpec(spec, opts);
      const ctx: DeploymentContext = {
        harnessSlug: `p2p-perf-${spec.label}`,
        workspaceId,
        log: opts.log,
        signal: opts.signal,
      };
      opts.log('info', `[bench-fleet] provisioning ${spec.label} (${config.target}/${config.region ?? 'auto'}/${config.size ?? 'default'})`);
      const frame = await opts.driver.provision(config, ctx);
      // Record for cost-safety BEFORE install (install can fail; the frame bills regardless).
      addToManifest(manifestPath, {
        id: frame.id,
        target: frame.target,
        region: frame.region,
        label: spec.label,
        createdAt: new Date().toISOString(),
      });
      const target: SshTarget = {
        ...sshTargetForFrame(frame, { ...config, provider: { ...config.provider, sshIdentityFile: opts.sshIdentityFile } }),
      };
      const exec = makeExec(target);
      const bf: BenchFrame = { spec, frame, target, exec, firewall: !!spec.firewall };
      provisioned.push(bf);

      // Install the bench runtime over SSH.
      opts.log('info', `[bench-fleet] ${spec.label}: waiting for sshd @ ${frame.host}`);
      await waitForSsh(exec, (m) => opts.log('info', `[bench-fleet] ${spec.label}: ${m}`), opts.sshWait);
      opts.log('info', `[bench-fleet] ${spec.label}: staging runtime tarball`);
      await exec.runScript(`rm -rf ${REMOTE_RUNTIME_TARBALL_PATH}`);
      await exec.copyFile(tarballPath, REMOTE_RUNTIME_TARBALL_PATH);
      const { script } = buildBenchBootstrap({
        installRoot,
        runtimeTarballRemotePath: REMOTE_RUNTIME_TARBALL_PATH,
        firewall: bf.firewall,
      });
      opts.log('info', `[bench-fleet] ${spec.label}: running bench bootstrap (${script.length} bytes)`);
      await exec.runScript(script);
      opts.log('info', `[bench-fleet] ${spec.label}: ready @ ${frame.host}`);
    }
  } catch (e) {
    // Anything fails → destroy everything we brought up, then rethrow.
    opts.log('error', `[bench-fleet] provision failed (${(e as Error).message}); destroying ${provisioned.length} frame(s)`);
    for (const bf of provisioned) await destroyOne(bf);
    throw e;
  }

  return {
    frames: provisioned,
    async teardownAll() {
      for (const bf of provisioned) {
        opts.log('info', `[bench-fleet] destroying ${bf.spec.label} (${bf.frame.id})`);
        await destroyOne(bf);
      }
    },
  };
}
