/**
 * Detached launcher for the scheduled gym cycle (EI-240).
 *
 * A gym cycle can outlive the operator process that scheduled it. Run it in a
 * fixed, per-workspace transient systemd user service so an operator deploy does
 * not reap paid work and concurrent routine fires deduplicate at systemd's unit
 * admission boundary.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { integrationRoot, tsxBin } from '../release-deploy-launch';
import { buildExactEnvPayload, SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS } from '../systemd-scope';

export const GYM_CYCLE_MAX_RUNTIME_SEC = 4 * 60 * 60;
export const GYM_CYCLE_RUNNER_REL = 'packages/operator-core/lib/gym/gym-cycle-run.ts';

export type GymCycleLaunchStatus = 'launched' | 'already_running' | 'unavailable' | 'refused';

export interface LaunchGymCycleResult {
  status: GymCycleLaunchStatus;
  workspaceId: string;
  unit: string;
  argv: string[];
  reason?: string;
}

export interface LaunchGymCycleOpts {
  workspaceId: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type SpawnLike = typeof spawn;

/** Fixed per workspace: the unit name is both the lifecycle boundary and the race-free dedup key. */
export function gymCycleUnitForWorkspace(workspaceId: string): string {
  const digest = createHash('sha256').update(workspaceId).digest('hex').slice(0, 12);
  return `papercup-gym-cycle-${digest}`;
}

/**
 * Build the exact systemd-run argv. The systemd-run CLIENT keeps the operator's
 * host environment so it can reach the user bus; the memory-only fd transport
 * gives the SERVICE payload the operator environment (DB, gateway and feature
 * settings) exactly without putting values in the systemd-run argv or journal.
 */
export function buildGymCycleSystemdArgv(args: {
  workspaceId: string;
  root: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const unit = gymCycleUnitForWorkspace(args.workspaceId);
  const payloadEnv = { ...args.env, PAPERCUSP_INTEGRATION_ROOT: args.root };
  const payload = buildExactEnvPayload(
    [tsxBin(args.root), GYM_CYCLE_RUNNER_REL, '--workspace-id', args.workspaceId],
    payloadEnv,
  );
  return [
    '--user',
    '--no-block',
    ...SYSTEMD_TRANSIENT_UNIT_COLLECTION_ARGS,
    `--unit=${unit}`,
    `--property=RuntimeMaxSec=${GYM_CYCLE_MAX_RUNTIME_SEC}`,
    `--working-directory=${args.root}`,
    ...payload,
  ];
}

function boundedStderr(current: string, chunk: unknown): string {
  if (current.length >= 2_000) return current;
  return (current + String(chunk)).slice(0, 2_000);
}

function classifyNonzero(stderr: string): GymCycleLaunchStatus {
  const text = stderr.toLowerCase();
  if (text.includes('already exists')) return 'already_running';
  // These messages establish that systemd could not reach a user manager, so no
  // service could have been admitted. Inline fallback is therefore safe.
  if (
    text.includes('failed to connect to bus') ||
    text.includes('no medium found') ||
    text.includes('system has not been booted with systemd') ||
    text.includes('host is down')
  ) {
    return 'unavailable';
  }
  // Any other nonzero is ambiguous: the manager may have accepted work before
  // the client failed. Never inline-retry a paid cycle in that state.
  return 'refused';
}

/** Launch once and return after systemd has accepted or refused the service. */
export function launchDetachedGymCycle(
  opts: LaunchGymCycleOpts,
  spawnFn: SpawnLike = spawn,
): Promise<LaunchGymCycleResult> {
  const unit = gymCycleUnitForWorkspace(opts.workspaceId);
  const platform = opts.platform ?? process.platform;
  if (platform !== 'linux') {
    return Promise.resolve({
      status: 'unavailable',
      workspaceId: opts.workspaceId,
      unit,
      argv: [],
      reason: `transient user services are unavailable on ${platform}`,
    });
  }

  const root = opts.root ?? integrationRoot();
  const argv = buildGymCycleSystemdArgv({
    workspaceId: opts.workspaceId,
    root,
    env: opts.env ?? process.env,
  });
  const base = { workspaceId: opts.workspaceId, unit, argv };

  return new Promise<LaunchGymCycleResult>((resolve) => {
    let stderr = '';
    let child: ReturnType<SpawnLike>;
    try {
      child = spawnFn('systemd-run', argv);
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      const status: GymCycleLaunchStatus = e?.code === 'ENOENT' ? 'unavailable' : 'refused';
      resolve({ ...base, status, reason: e instanceof Error ? e.message : String(e) });
      return;
    }

    child.stderr?.on('data', (chunk: unknown) => {
      stderr = boundedStderr(stderr, chunk);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      const status: GymCycleLaunchStatus = error.code === 'ENOENT' ? 'unavailable' : 'refused';
      resolve({ ...base, status, reason: error.message });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ ...base, status: 'launched' });
        return;
      }
      const status = classifyNonzero(stderr);
      resolve({
        ...base,
        status,
        reason: `systemd-run exited ${String(code)}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`,
      });
    });
  });
}
