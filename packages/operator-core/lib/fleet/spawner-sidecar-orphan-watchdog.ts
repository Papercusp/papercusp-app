import { managedSetInterval } from '@papercusp/scheduled-registry';
import { ownerPidFromSocketPath } from './spawner-socket-path';

/** How often to ask whether the host this sidecar serves is still alive. */
export const ORPHAN_CHECK_INTERVAL_MS = 30_000;

export interface SpawnerSidecarOrphanWatchdogDeps {
  isPidAlive?: (pid: number) => boolean;
  schedule?: (
    name: string,
    intervalMs: number,
    callback: () => void,
    options: { category: 'watchdog'; classification: 'must-sample' },
  ) => void;
  logger?: Pick<Console, 'log' | 'warn'>;
}

/**
 * Exit when the host this sidecar serves is gone (P-005, mechanism proved in D-011).
 *
 * A sidecar cannot rely on its spawner to stop it. Parent-side shutdown hooks only
 * cover cooperative exits; SIGKILL skips them. The sidecar therefore watches the
 * owner PID encoded in its pid-keyed socket path and closes its server when that
 * owner disappears.
 *
 * The sidecar is the tail of a host -> npm exec -> sh -c -> node chain. Its direct
 * parent can remain alive after the host dies, so the owner PID from the socket
 * path is the identity to check. PID reuse can make this miss an orphan, but cannot
 * cause it to stop a live sidecar.
 */
export function armSpawnerSidecarOrphanWatchdog(
  socketPath: string,
  shutdown: (reason: string) => void,
  deps: SpawnerSidecarOrphanWatchdogDeps = {},
): void {
  const ownerPid = ownerPidFromSocketPath(socketPath);
  const logger = deps.logger ?? console;
  if (ownerPid === null) {
    // An explicitly-configured socket path carries no owner — UNKNOWN, so do not
    // arm. Guessing here could shut down a healthy sidecar.
    logger.log('[spawner-sidecar] orphan watchdog not armed (socket path names no owner pid)');
    return;
  }

  const isPidAlive = deps.isPidAlive ?? pidAlive;
  const schedule = deps.schedule ?? defaultSchedule;
  schedule(
    'spawner-sidecar-orphan-watchdog',
    ORPHAN_CHECK_INTERVAL_MS,
    () => {
      if (isPidAlive(ownerPid)) return;
      logger.warn(
        '[spawner-sidecar] owner pid ' +
          ownerPid +
          ' is gone — nothing can reach ' +
          socketPath +
          ' again; exiting rather than leaking',
      );
      shutdown('owner-gone');
    },
    { category: 'watchdog', classification: 'must-sample' },
  );
}

function defaultSchedule(
  name: string,
  intervalMs: number,
  callback: () => void,
  options: { category: 'watchdog'; classification: 'must-sample' },
): void {
  // lint:timer-classification matches the literal `classification:` inside the managedSetInterval
  // call text, so thread the declared fields explicitly instead of passing `options` through.
  managedSetInterval(name, intervalMs, callback, {
    category: options.category,
    classification: options.classification,
  });
}

/** kill -0: EPERM means the owner exists but is not ours, which is still ALIVE. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}
