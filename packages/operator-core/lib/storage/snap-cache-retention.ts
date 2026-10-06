/**
 * Pressure-triggered cleanup for Snapd's downloads cache.
 *
 * `/var/lib/snapd/cache` is owned by Snapd.  Papercusp may ask Snapd to apply
 * its own cache policy, but must never unlink entries from this directory:
 * Snapd can be downloading or validating an entry while the checkpoint runs.
 * The probe and the action are deliberately separate so a successful
 * `ensure-state-soon` request is not mistaken for reclaimed bytes.  Snapd can
 * coalesce that request behind its in-memory 24-hour ensure guard.
 */
import { spawn } from 'node:child_process';

import { PACKAGE_CACHE_MUTEX_NAME, withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';

export { PACKAGE_CACHE_MUTEX_NAME };

export const DEFAULT_SNAP_CACHE_DIR = '/var/lib/snapd/cache';
/** Snapd's Core default maximum cache size. Classic Snapd has no size ceiling,
 * so this pressure threshold gives the checkpoint a bounded, explicit trigger. */
export const DEFAULT_SNAP_CACHE_MAX_BYTES = 1 * 1024 ** 3;

const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_CHARS = 8_000;

export interface SnapCacheTarget {
  path: string;
  command: string;
  probeArgs: string[];
  cleanupArgs: string[];
}

export interface SnapCacheMeasurement {
  /** Total bytes currently present in Snapd's downloads cache. */
  bytes: number;
  entries?: number;
  candidatesBytes?: number;
  removedBytes?: number;
  remainingBytes?: number;
  output?: string;
}

export interface SnapCacheCommandResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

export type SnapCacheOutcomeStatus =
  | 'below-threshold'
  | 'would-clean'
  | 'cleaned'
  | 'cleanup-noop'
  | 'cleanup-failed'
  | 'unmeasurable'
  | 'mutex-unavailable';

export interface SnapCacheOutcome {
  path: string;
  maxBytes: number;
  beforeBytes: number;
  afterBytes: number;
  reclaimedBytes: number;
  status: SnapCacheOutcomeStatus;
  note?: string;
}

interface SnapCacheTargetOptions {
  env?: NodeJS.ProcessEnv;
}

interface SnapCacheRetentionOptions {
  dryRun?: boolean;
  maxBytes?: number;
  target?: SnapCacheTarget;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  measure?: (target: SnapCacheTarget) => Promise<SnapCacheMeasurement>;
  runCommand?: (target: SnapCacheTarget, cwd: string) => Promise<SnapCacheCommandResult>;
  withMutex?: <T>(
    name: string,
    run: () => Promise<T>,
    options?: Record<string, unknown>,
  ) => Promise<T>;
}

function configuredPath(raw: string | undefined, fallback: string): string {
  return raw?.trim() || fallback;
}

/** Resolve the manager-owned cache path and the only supported Snapd actions. */
export function resolveSnapCacheTarget(options: SnapCacheTargetOptions = {}): SnapCacheTarget {
  const env = options.env ?? process.env;
  const path = configuredPath(env.PAPERCUSP_SNAP_CACHE_DIR, DEFAULT_SNAP_CACHE_DIR);
  const command = configuredPath(env.PAPERCUSP_SNAP_BIN, 'snap');
  return {
    path,
    command,
    // Do not pass --all: the aggregate lines are enough and listing every cache
    // entry would make a large cache an unbounded diagnostic payload.
    probeArgs: ['debug', 'snap-downloads-cache', '--cache', path],
    // This is Snapd's supported manager-owned cleanup trigger. It may return
    // successfully while Snapd coalesces the request; callers must re-probe.
    cleanupArgs: ['debug', 'ensure-state-soon'],
  };
}

function appendBounded(current: string, chunk: unknown): string {
  const combined = current + String(chunk);
  return combined.length <= COMMAND_OUTPUT_CHARS
    ? combined
    : combined.slice(-COMMAND_OUTPUT_CHARS);
}

/** Run one bounded Snapd command. Permission and spawn failures remain typed
 * command failures so the caller can fail closed without throwing. */
export function runSnapCacheCommand(
  target: SnapCacheTarget,
  args: string[] = target.probeArgs,
  cwd = process.cwd(),
): Promise<SnapCacheCommandResult> {
  return new Promise((resolveResult) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolveResult({
        ok: false,
        exitCode: null,
        timedOut: false,
        output: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const finish = (result: SnapCacheCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
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
      finish({
        ok: false,
        exitCode: null,
        timedOut,
        output: appendBounded(output, error.message),
      });
    });
    child.once('close', (code) => {
      finish({ ok: code === 0 && !timedOut, exitCode: code, timedOut, output });
    });

    timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref?.();
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
  });
}

function parseAmount(raw: string): number | undefined {
  const match = raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtpe]?i?b)?$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? 'B').toLowerCase();
  const powers: Record<string, number> = {
    b: 0,
    kb: 1,
    kib: 1,
    mb: 2,
    mib: 2,
    gb: 3,
    gib: 3,
    tb: 4,
    tib: 4,
    pb: 5,
    pib: 5,
    eb: 6,
    eib: 6,
  };
  const power = powers[unit];
  if (power === undefined) return undefined;
  return Math.round(value * 1024 ** power);
}

function lineValue(output: string, label: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.trimStart().toLowerCase().startsWith(`${label.toLowerCase()}:`));
  return line?.slice(line.indexOf(':') + 1).trim();
}

/** Parse the aggregate fields emitted by `snap debug snap-downloads-cache`. */
export function parseSnapCacheMeasurement(output: string): SnapCacheMeasurement {
  const totalRaw = lineValue(output, 'Total size');
  const bytes = totalRaw === undefined ? undefined : parseAmount(totalRaw);
  if (bytes === undefined) {
    throw new Error(`Snapd cache size was not measurable${output ? `: ${output}` : ''}`);
  }
  const entriesRaw = lineValue(output, 'Cache entries');
  const candidatesRaw = lineValue(output, 'Total candidates size');
  const removedRaw = lineValue(output, 'Total removed size');
  const remainingRaw = lineValue(output, 'Remaining size');
  const entries = entriesRaw === undefined ? undefined : Number.parseInt(entriesRaw, 10);
  const candidatesBytes = candidatesRaw === undefined ? undefined : parseAmount(candidatesRaw);
  const removedBytes = removedRaw === undefined ? undefined : parseAmount(removedRaw);
  const remainingBytes = remainingRaw === undefined ? undefined : parseAmount(remainingRaw);
  return {
    bytes,
    entries: Number.isFinite(entries) ? entries : undefined,
    candidatesBytes,
    removedBytes,
    remainingBytes,
    output,
  };
}

async function measureSnapCache(target: SnapCacheTarget): Promise<SnapCacheMeasurement> {
  const result = await runSnapCacheCommand(target, target.probeArgs);
  if (!result.ok) {
    throw new Error(
      result.timedOut
        ? `Snapd cache probe timed out: ${result.output}`
        : `Snapd cache probe exited ${result.exitCode ?? 'without a status'}: ${result.output}`,
    );
  }
  return parseSnapCacheMeasurement(result.output);
}

function pressureBytes(measurement: SnapCacheMeasurement): number {
  // `remainingBytes` is the manager's post-policy residual, not current disk
  // pressure: it can be zero precisely when all candidates are removable. The
  // authoritative pressure signal is the total cache size. Older Snapd
  // versions may omit all candidate details, so never depend on those lines.
  return measurement.bytes;
}

function belowOutcome(
  target: SnapCacheTarget,
  measurement: SnapCacheMeasurement,
  maxBytes: number,
): SnapCacheOutcome {
  return {
    path: target.path,
    maxBytes,
    beforeBytes: measurement.bytes,
    afterBytes: measurement.bytes,
    reclaimedBytes: 0,
    status: 'below-threshold',
  };
}

/**
 * Ask Snapd to apply its native downloads-cache policy when cache pressure is
 * observed. Every destructive-looking result is verified with a second probe;
 * a successful ensure request with unchanged bytes is explicitly a no-op.
 */
export async function runSnapCacheRetention(
  options: SnapCacheRetentionOptions = {},
): Promise<SnapCacheOutcome> {
  const target = options.target ?? resolveSnapCacheTarget({ env: options.env });
  const maxBytes =
    Number.isFinite(options.maxBytes) && Number(options.maxBytes) > 0
      ? Math.floor(Number(options.maxBytes))
      : Number.isFinite(Number(options.env?.PAPERCUSP_SNAP_CACHE_MAX_BYTES)) &&
          Number(options.env?.PAPERCUSP_SNAP_CACHE_MAX_BYTES) > 0
        ? Math.floor(Number(options.env?.PAPERCUSP_SNAP_CACHE_MAX_BYTES))
        : DEFAULT_SNAP_CACHE_MAX_BYTES;
  const cwd = options.cwd ?? process.cwd();
  const measure = options.measure ?? measureSnapCache;
  const runCommand = options.runCommand ?? ((t: SnapCacheTarget, dir: string) =>
    runSnapCacheCommand(t, t.cleanupArgs, dir));
  const withMutex = options.withMutex ?? withFsMutex;

  let initial: SnapCacheMeasurement;
  try {
    initial = await measure(target);
  } catch (error) {
    return {
      path: target.path,
      maxBytes,
      beforeBytes: 0,
      afterBytes: 0,
      reclaimedBytes: 0,
      status: 'unmeasurable',
      note: error instanceof Error ? error.message : String(error),
    };
  }

  if (pressureBytes(initial) <= maxBytes) return belowOutcome(target, initial, maxBytes);
  if (options.dryRun) {
    return {
      ...belowOutcome(target, initial, maxBytes),
      status: 'would-clean',
      note: `Snapd cache pressure is ${(pressureBytes(initial) / 1024 ** 3).toFixed(2)} GiB`,
    };
  }

  try {
    const result = await withMutex(
      PACKAGE_CACHE_MUTEX_NAME,
      async () => {
        let before: SnapCacheMeasurement;
        try {
          before = await measure(target);
        } catch (error) {
          return {
            ...belowOutcome(target, initial, maxBytes),
            status: 'unmeasurable' as const,
            note: `post-lock Snapd cache probe failed: ${error instanceof Error ? error.message : error}`,
          };
        }
        if (pressureBytes(before) <= maxBytes) {
          return {
            ...belowOutcome(target, before, maxBytes),
            note: 'fell below the pressure threshold while waiting for the cache mutex',
          };
        }

        const command = await runCommand(target, cwd);
        if (!command.ok) {
          return {
            ...belowOutcome(target, before, maxBytes),
            status: 'cleanup-failed' as const,
            note: command.timedOut
              ? `Snapd cleanup request timed out: ${command.output}`
              : `Snapd cleanup request exited ${command.exitCode ?? 'without a status'}: ${command.output}`,
          };
        }

        let after: SnapCacheMeasurement;
        try {
          after = await measure(target);
        } catch (error) {
          return {
            ...belowOutcome(target, before, maxBytes),
            status: 'cleanup-failed' as const,
            note: `Snapd cleanup request succeeded but its result was unmeasurable: ${error instanceof Error ? error.message : error}`,
          };
        }
        const reclaimedBytes = Math.max(0, before.bytes - after.bytes);
        return {
          path: target.path,
          maxBytes,
          beforeBytes: before.bytes,
          afterBytes: after.bytes,
          reclaimedBytes,
          status: reclaimedBytes > 0 ? ('cleaned' as const) : ('cleanup-noop' as const),
          note:
            reclaimedBytes > 0
              ? undefined
              : 'Snapd accepted ensure-state-soon but cache size did not change; the in-memory ensure cadence may have coalesced the request',
        };
      },
      {
        timeoutMs: 300_000,
        staleMs: 10 * 60_000,
        retryMs: 250,
        waitingNoticeIntervalMs: 60_000,
        intent: { operation: 'snap-cache-retention', path: target.path },
      },
    );
    return result;
  } catch (error) {
    return {
      ...belowOutcome(target, initial, maxBytes),
      status: 'mutex-unavailable',
      note: error instanceof Error ? error.message : String(error),
    };
  }
}
