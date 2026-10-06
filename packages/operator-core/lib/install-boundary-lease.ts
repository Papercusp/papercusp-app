/**
 * Install-boundary lease for agent launches (WI-10005137).
 *
 * A headless psu launch resolves its launcher and every module it imports from
 * a shared checkout's node_modules. While `npm run install:safe` is reifying
 * that checkout, those directories are torn down and rewritten for minutes, and
 * a launch in that window dies at boot with ERR_MODULE_NOT_FOUND. Observed
 * 2026-10-01 22:58-22:59Z: four grading-integrity audit dispatches died this way
 * and each then sat in a blind 15-minute dispatch backoff.
 *
 * install:safe already publishes the boundary: it holds a repo-keyed WRITER
 * lock (scripts/lib/fs-mutex.mjs) until the install is VERIFIED complete, and
 * readers (`--exec-under-lock`) wait on it. This module is that reader half for
 * an in-process launch: take a read lease before spawning, hold it across the
 * boot window where module resolution happens, then release it. The lock is
 * writer-preferring, so an install queued behind the lease waits only for the
 * boot window, never for the agent's lifetime.
 *
 * Fail-open by design: a lease that cannot be acquired within the timeout (or a
 * lock-root fault) returns `timed-out` / `error` and the caller launches anyway,
 * exactly as it did before this guard existed.
 */
import { existsSync } from 'node:fs';
import { withFsMutexRead } from '../../../scripts/lib/fs-mutex.mjs';
// @ts-expect-error -- same buildless plain-JS module family, no declaration file.
import { installLockNameForRoot, installMutexIsHeld } from '../../../scripts/lib/install-lock-name.mjs';

/** How long a launch waits for an in-flight install before launching anyway. */
export const INSTALL_BOUNDARY_WAIT_MS = 5 * 60_000;

/**
 * The env keys the psu shim (~/.papercusp/bin/psu, resolve_launcher) consults,
 * in its own precedence order, to pick the checkout it runs the launcher from.
 */
export const LAUNCHER_ROOT_ENV_KEYS = [
  'PAPERCUSP_CANONICAL_TREE',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_RELEASE_ROOT',
] as const;

/**
 * The checkout whose node_modules a launched psu boots from: the first launcher
 * root the shim would consult that exists on disk. `null` when none is set
 * (the shim then falls back to fixed paths; no lease is taken).
 */
export function installBoundaryRoot(
  env: Record<string, string | undefined>,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const key of LAUNCHER_ROOT_ENV_KEYS) {
    const root = env[key]?.trim();
    if (root && exists(root)) return root;
  }
  return null;
}

export type InstallBoundaryOutcome = 'acquired' | 'no-root' | 'nested' | 'timed-out' | 'error';

export interface InstallBoundaryLease {
  outcome: InstallBoundaryOutcome;
  /** Milliseconds spent waiting for the lease (0 when none was attempted). */
  waitedMs: number;
  /** The lock name waited on, when one was derived. */
  lockName?: string;
  /** Why the lease was not held, for `timed-out` / `error`. */
  detail?: string;
  /** Idempotent. Releases the read lease; a no-op when none is held. */
  release: () => void;
}

type ReadLease = <T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { timeoutMs?: number },
) => Promise<T>;

export interface AcquireInstallBoundaryLeaseOpts {
  timeoutMs?: number;
  /** The env of the launching process names the repository locks already held.
   *  For that same repository, taking
   *  another reader would self-deadlock under a writer we are nested in. */
  env?: Record<string, string | undefined>;
  readLease?: ReadLease;
  lockName?: (root: string) => string;
  now?: () => number;
}

const noop = () => {};

export async function acquireInstallBoundaryLease(
  root: string | null,
  opts: AcquireInstallBoundaryLeaseOpts = {},
): Promise<InstallBoundaryLease> {
  if (!root) return { outcome: 'no-root', waitedMs: 0, release: noop };
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  let lockName: string;
  try {
    lockName = (opts.lockName ?? installLockNameForRoot)(root);
  } catch (error) {
    return { outcome: 'error', waitedMs: 0, detail: errorMessage(error), release: noop };
  }
  if (installMutexIsHeld(lockName, env)) {
    return { outcome: 'nested', lockName, waitedMs: 0, release: noop };
  }

  const readLease: ReadLease = opts.readLease ?? (withFsMutexRead as ReadLease);
  const startedAt = now();
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalAcquired: () => void = noop;
  const acquired = new Promise<{ ok: true }>((resolve) => {
    signalAcquired = () => resolve({ ok: true });
  });
  const lease = readLease(
    lockName,
    async () => {
      signalAcquired();
      await released;
    },
    { timeoutMs: opts.timeoutMs ?? INSTALL_BOUNDARY_WAIT_MS },
  );
  const settled = await Promise.race([
    acquired,
    lease.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  // A rejection after acquisition (a release-side fs fault) must not surface as
  // an unhandled rejection in the operator process.
  lease.catch(noop);
  const waitedMs = Math.max(0, now() - startedAt);
  if (settled.ok) return { outcome: 'acquired', waitedMs, lockName, release };
  const detail = errorMessage(settled.error);
  return {
    outcome: /timed? ?out|timeout/i.test(detail) ? 'timed-out' : 'error',
    waitedMs,
    lockName,
    detail,
    release: noop,
  };
}

/**
 * How long a long-running script launch keeps the read lease after spawning.
 * This covers tsx's static import graph resolving from the shared node_modules,
 * with headroom for a heavily loaded host. The lock is writer-preferring, so an
 * install queued behind it waits at most this long.
 */
export const INSTALL_BOUNDARY_BOOT_HOLD_MS = 120_000;

export interface InstallBoundaryBootWindowOpts {
  /** How long to keep the lease after `launch` starts; defaults to INSTALL_BOUNDARY_BOOT_HOLD_MS. */
  holdMs?: number;
  /** Test seam; defaults to acquireInstallBoundaryLease. */
  acquire?: (root: string | null) => Promise<InstallBoundaryLease>;
}

/**
 * Run `launch` (which spawns a child from `root`'s node_modules and resolves when
 * that child finishes) under the install boundary for its BOOT window only.
 *
 * For a script that runs for an hour, such as the green-checkpoint gate, a lease
 * held until completion would block every install for that hour. Module resolution
 * happens at boot, though. That is where an interrupted install killed the gate on
 * 2026-10-03 08:32Z ("Cannot find module '@octokit/rest'", WI-10005925). So the
 * lease is released after `holdMs` or when `launch` settles, whichever is first.
 *
 * Fail-open like acquireInstallBoundaryLease: a `timed-out` / `error` lease still
 * launches; the outcome is returned so the caller can report it.
 */
export async function withInstallBoundaryBootWindow<T>(
  root: string | null,
  launch: () => Promise<T>,
  opts: InstallBoundaryBootWindowOpts = {},
): Promise<{ value: T; lease: InstallBoundaryLease }> {
  const lease = await (opts.acquire ?? ((r) => acquireInstallBoundaryLease(r)))(root);
  const hold = setTimeout(lease.release, opts.holdMs ?? INSTALL_BOUNDARY_BOOT_HOLD_MS);
  hold.unref?.();
  try {
    return { value: await launch(), lease };
  } finally {
    clearTimeout(hold);
    lease.release();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
