/**
 * Size-triggered package-manager cache retention (WI-6968).
 *
 * Package caches are disposable, but their layouts are manager-owned. Never
 * unlink internal npm/pnpm/bun files ourselves: measure the configured roots,
 * then use each manager's native cleanup command only after a high-water mark
 * is crossed. The cleanup holds PACKAGE_CACHE_MUTEX_NAME exclusively while
 * install:safe holds the same mutex as a reader, so cache deletion cannot race
 * a safe install in any checkout on this host.
 */
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { dirSizeBytesAsync, type DiskWalkBudget } from './disk';
import { criticalWriteHeadroomBytes, diskPolicyFromEnv, sampleDiskSnapshots } from './disk-space-alarm';

import { PACKAGE_CACHE_MUTEX_NAME, withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

export { PACKAGE_CACHE_MUTEX_NAME };

export const DEFAULT_PACKAGE_CACHE_MAX_BYTES = 8 * 1024 ** 3;
/** Keep small working caches; pressure recovery is not a purge on every fetch. */
export const PRESSURE_PACKAGE_CACHE_MAX_BYTES = 1024 ** 3;
const DEFAULT_MEASURE_BUDGET_MS = 30_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_MEASURED_FILES = 2_000_000;
const COMMAND_OUTPUT_CHARS = 4_000;

export type PackageCacheManager = 'npm' | 'bun' | 'pnpm';

export interface PackageCacheTarget {
  manager: PackageCacheManager;
  path: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface PackageCacheMeasurement {
  bytes: number;
  /** A bounded walk stopped before exhausting the tree. Actual bytes are >= bytes. */
  truncated: boolean;
}

export interface PackageCacheCommandResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type PackageCacheOutcomeStatus =
  | 'below-threshold'
  | 'would-prune'
  | 'pruned'
  | 'prune-failed'
  | 'pressure-ineligible'
  | 'mutex-unavailable';

export interface PackageCacheOutcome {
  manager: PackageCacheManager;
  path: string;
  maxBytes: number;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  measurementTruncated: boolean;
  status: PackageCacheOutcomeStatus;
  note?: string;
}

interface PackageCacheTargetOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

interface PackageCacheRetentionOptions {
  dryRun?: boolean;
  maxBytes?: number;
  targets?: readonly PackageCacheTarget[];
  repoRoot?: string;
  /** Lower the cache floor only when this exact filesystem is at its write reserve. */
  pressurePath?: string;
  sampleDisk?: typeof sampleDiskSnapshots;
  sameFilesystem?: (a: string, b: string) => Promise<boolean>;
  measure?: (path: string) => Promise<PackageCacheMeasurement>;
  runCommand?: (target: PackageCacheTarget, cwd: string) => Promise<PackageCacheCommandResult>;
  withMutex?: <T>(name: string, run: () => Promise<T>, options?: Record<string, unknown>) => Promise<T>;
}

async function sameFilesystem(a: string, b: string): Promise<boolean> {
  const [first, second] = await Promise.all([stat(a), stat(b)]);
  return first.dev === second.dev;
}

function configuredPath(raw: string | undefined, fallback: string, homeDir: string, cwd: string): string {
  if (!raw) return fallback;
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/')) return join(homeDir, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** Resolve manager-owned cache roots without invoking a package manager. */
export function resolvePackageCacheTargets(options: PackageCacheTargetOptions = {}): PackageCacheTarget[] {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;

  const npmPath = configuredPath(env.NPM_CONFIG_CACHE, join(homeDir, '.npm'), homeDir, cwd);
  const bunPath = configuredPath(
    env.BUN_INSTALL_CACHE_DIR,
    join(configuredPath(env.BUN_INSTALL, join(homeDir, '.bun'), homeDir, cwd), 'install', 'cache'),
    homeDir,
    cwd,
  );
  const pnpmDefault =
    platform === 'darwin'
      ? join(homeDir, 'Library', 'pnpm', 'store')
      : platform === 'win32'
        ? join(env.LOCALAPPDATA ?? homeDir, 'pnpm', 'store')
        : join(configuredPath(env.XDG_DATA_HOME, join(homeDir, '.local', 'share'), homeDir, cwd), 'pnpm', 'store');
  const pnpmPath = configuredPath(env.PNPM_STORE_DIR, pnpmDefault, homeDir, cwd);

  return [
    {
      manager: 'npm',
      path: npmPath,
      command: env.PAPERCUSP_NPM_BIN ?? 'npm',
      // npm's cache is opaque/cacache-owned. `clean --force` is its supported
      // disk-reclaim command; the explicit path keeps measurement and cleanup
      // on the same configured cache.
      args: ['--cache', npmPath, 'cache', 'clean', '--force'],
    },
    {
      manager: 'bun',
      path: bunPath,
      command: env.PAPERCUSP_BUN_BIN ?? 'bun',
      args: ['pm', 'cache', 'rm'],
      env: { BUN_INSTALL_CACHE_DIR: bunPath },
    },
    {
      manager: 'pnpm',
      path: pnpmPath,
      command: env.PAPERCUSP_PNPM_BIN ?? 'pnpm',
      // `store prune` removes only packages unreferenced by any registered
      // project; unlike deleting the store, it preserves live hardlink users.
      args: ['--store-dir', pnpmPath, 'store', 'prune'],
    },
  ];
}

export async function measurePackageCache(path: string): Promise<PackageCacheMeasurement> {
  const budget: DiskWalkBudget = { deadlineMs: Date.now() + DEFAULT_MEASURE_BUDGET_MS };
  const bytes = await dirSizeBytesAsync(path, MAX_MEASURED_FILES, budget);
  return { bytes, truncated: Boolean(budget.truncated) };
}

function appendBounded(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length <= COMMAND_OUTPUT_CHARS ? combined : combined.slice(-COMMAND_OUTPUT_CHARS);
}

/** Run one manager-native cleanup with bounded output and a hard timeout. */
export function runPackageCacheCommand(
  target: PackageCacheTarget,
  cwd = process.cwd(),
): Promise<PackageCacheCommandResult> {
  return new Promise((resolveResult) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const child = spawn(target.command, target.args, {
      cwd,
      env: { ...process.env, ...(target.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: PackageCacheCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolveResult(result);
    };
    child.stdout?.on('data', (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      output = appendBounded(output, chunk);
    });
    child.once('error', (error) => {
      finish({ ok: false, exitCode: null, timedOut, output: appendBounded(output, error.message) });
    });
    child.once('close', (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code, timedOut, output });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref?.();
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function overHighWater(measurement: PackageCacheMeasurement, maxBytes: number): boolean {
  // A partial size is a lower bound. Cleanup is cache-only + manager-native, so
  // an inconclusive large walk should reclaim rather than silently bless an
  // unbounded tree as small.
  return measurement.truncated || measurement.bytes > maxBytes;
}

function belowOutcome(
  target: PackageCacheTarget,
  measurement: PackageCacheMeasurement,
  maxBytes: number,
): PackageCacheOutcome {
  return {
    manager: target.manager,
    path: target.path,
    maxBytes,
    beforeBytes: measurement.bytes,
    afterBytes: measurement.bytes,
    reclaimedBytes: 0,
    measurementTruncated: measurement.truncated,
    status: 'below-threshold',
  };
}

/**
 * Measure every known cache and prune above its high-water mark. Critical
 * pressure lowers the floor only for caches on the affected filesystem.
 * Re-checks pressure and cache size under the writer lease so peer recovery
 * while we waited cannot trigger a stale destructive command.
 */
export async function runPackageCacheRetention(
  options: PackageCacheRetentionOptions = {},
): Promise<PackageCacheOutcome[]> {
  const dryRun = options.dryRun === true;
  const maxBytes =
    Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : DEFAULT_PACKAGE_CACHE_MAX_BYTES;
  const targets = [...(options.targets ?? resolvePackageCacheTargets())];
  const repoRoot = options.repoRoot ?? process.cwd();
  const measure = options.measure ?? measurePackageCache;
  const runCommand = options.runCommand ?? runPackageCacheCommand;
  const withMutex = options.withMutex ?? withFsMutex;
  const sampleDisk = options.sampleDisk ?? sampleDiskSnapshots;
  const sharesFilesystem = options.sameFilesystem ?? sameFilesystem;
  async function threshold(target: PackageCacheTarget): Promise<number | null> {
    if (!options.pressurePath) return maxBytes;
    try {
      if (!(await sharesFilesystem(options.pressurePath, target.path))) return null;
      const snapshot = (await sampleDisk([options.pressurePath]))[0];
      if (snapshot && Number.isFinite(snapshot.totalBytes) && snapshot.totalBytes > 0 &&
          Number.isFinite(snapshot.freeBytes) && snapshot.freeBytes >= 0 &&
          snapshot.freeBytes <= criticalWriteHeadroomBytes(snapshot.totalBytes, diskPolicyFromEnv())) {
        return Math.min(maxBytes, PRESSURE_PACKAGE_CACHE_MAX_BYTES);
      }
    } catch (error) {
      console.warn(`[package-cache-retention] pressure eligibility unmeasured: ${String(error)}`);
      return null;
    }
    // Unknown pressure never authorizes a more aggressive cleanup.
    return maxBytes;
  }
  function unchanged(target: PackageCacheTarget, measurement: PackageCacheMeasurement, limit: number | null): PackageCacheOutcome {
    return limit === null
      ? { ...belowOutcome(target, measurement, maxBytes), status: 'pressure-ineligible',
        note: 'cache filesystem differs from the pressure path or its identity is unmeasured' }
      : belowOutcome(target, measurement, limit);
  }

  const initial = new Map<PackageCacheManager, PackageCacheMeasurement>();
  const thresholds = new Map<PackageCacheManager, number | null>();
  for (const target of targets) {
    initial.set(target.manager, await measure(target.path));
    thresholds.set(target.manager, await threshold(target));
  }

  const eligible = targets.filter((target) => {
    const limit = thresholds.get(target.manager)!;
    return limit !== null && overHighWater(initial.get(target.manager)!, limit);
  });
  if (dryRun) {
    return targets.map((target) => {
      const measurement = initial.get(target.manager)!;
      const limit = thresholds.get(target.manager)!;
      if (limit === null || !overHighWater(measurement, limit)) return unchanged(target, measurement, limit);
      return {
        ...belowOutcome(target, measurement, limit),
        status: 'would-prune',
        note: measurement.truncated
          ? 'size scan truncated; actual bytes are at least the measured lower bound'
          : undefined,
      };
    });
  }
  if (eligible.length === 0) {
    return targets.map((target) => unchanged(target, initial.get(target.manager)!, thresholds.get(target.manager)!));
  }

  try {
    const changed = await withMutex(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        const outcomes = new Map<PackageCacheManager, PackageCacheOutcome>();
        for (const target of eligible) {
          const limit = await threshold(target);
          const before = await measure(target.path);
          if (limit === null || !overHighWater(before, limit)) {
            outcomes.set(target.manager, {
              ...unchanged(target, before, limit),
              note: limit === null ? 'cache filesystem eligibility changed while waiting for the cache mutex'
                : 'fell below the high-water mark while waiting for the cache mutex',
            });
            continue;
          }

          const command = await runCommand(target, repoRoot);
          if (!command.ok) {
            outcomes.set(target.manager, {
              ...belowOutcome(target, before, limit),
              status: 'prune-failed',
              note: command.timedOut
                ? `native cleanup timed out: ${command.output}`
                : `native cleanup exited ${command.exitCode ?? 'without a status'}: ${command.output}`,
            });
            continue;
          }

          const after = await measure(target.path);
          outcomes.set(target.manager, {
            manager: target.manager,
            path: target.path,
            maxBytes: limit,
            beforeBytes: before.bytes,
            afterBytes: after.bytes,
            reclaimedBytes: Math.max(0, before.bytes - after.bytes),
            measurementTruncated: before.truncated || after.truncated,
            status: 'pruned',
            note: overHighWater(after, limit)
              ? 'native cleanup completed, but the cache still measures above the high-water mark'
              : undefined,
          });
        }
        return outcomes;
      },
      {
        timeoutMs: 300_000,
        staleMs: 10 * 60_000,
        retryMs: 250,
        waitingNoticeIntervalMs: 60_000,
        intent: { operation: 'package-cache-retention', managers: eligible.map((t) => t.manager).join(',') },
      },
    );

    return targets.map(
      (target) => changed.get(target.manager) ?? unchanged(target, initial.get(target.manager)!, thresholds.get(target.manager)!),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const eligibleManagers = new Set(eligible.map((target) => target.manager));
    return targets.map((target) => {
      const measurement = initial.get(target.manager)!;
      const limit = thresholds.get(target.manager)!;
      if (!eligibleManagers.has(target.manager)) return unchanged(target, measurement, limit);
      return {
        ...unchanged(target, measurement, limit),
        status: 'mutex-unavailable',
        note: message,
      };
    });
  }
}
