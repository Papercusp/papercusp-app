/**
 * Absolute, collision-safe IPC socket path for the SPAWNER sidecar (WI-344 ③,
 * plan spawner-sidecar-offload-2026-06-30).
 *
 * Mirror of `sync/hyperbee/substrate-socket-path.ts`. The spawner sidecar — which
 * owns the agent-spawn fork/exec + `buildInvokeOnce`, offloaded off the bg-host
 * main event loop so it stops saturating routinesTick — talks to the main
 * operator over a Unix-domain socket. The path MUST be absolute: a CWD-relative
 * default does `mkdir '.papercusp'` against `process.cwd()`, which in a PACKAGED
 * deploy is a root-owned install dir → the spawn fails `EACCES` and silently
 * falls back to in-process (the P-006 substrate finding, 2026-06-25).
 *
 * Honour `PAPERCUSP_SPAWNER_IPC_SOCKET` when set — the spawner sets it ONCE before
 * forking so the parent IPC client and the spawned child agree on a single path —
 * otherwise an `os.tmpdir()` path keyed by the MAIN operator pid, so two operators
 * on one box never collide on one socket. Unix socket paths have a ~108-char
 * limit, so the base must stay short (tmpdir), never a deep workspace path.
 */
import {
  ownerPidFromPidKeyedPath,
  pidKeyedSocketPath,
  pinSocketForCluster,
  reapOrphanedPidKeyedSockets,
  type ReapResult,
} from '../sidecar-socket/pid-keyed-socket';

export const SPAWNER_SOCKET_ENV = 'PAPERCUSP_SPAWNER_IPC_SOCKET';

/** The pid-keyed name prefix. One definition, used to BUILD and to READ the path. */
export const SPAWNER_SOCKET_PREFIX = 'spawner';

export function resolveSpawnerSocketPath(): string {
  const fromEnv = process.env[SPAWNER_SOCKET_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return pidKeyedSocketPath(SPAWNER_SOCKET_PREFIX, process.pid);
}

/**
 * Pin the spawner socket across a `cluster.fork()` so N workers share ONE sidecar.
 *
 * The substrate sidecar got this in WI-1879; the spawner did not, and reproduced the
 * bug at a far higher cost. Because `sidecarProcess` is a MODULE-scoped latch it is
 * per PROCESS, so under `PAPERCUSP_CLUSTER=16` each worker independently resolved its
 * OWN pid-keyed path, saw no sidecar of its own, and spawned a full ~450MB
 * `hono-host.mjs`. Measured on this box 2026-08-12: 16 sidecars, 9.5GB, each burning
 * 0.004 cores — i.e. ~8GB to do nothing sixteen times.
 *
 * Keying by the PRIMARY's pid (not a fixed path) is deliberate and preserves D-011:
 * the owner pid stays IN the name, so an orphan is still detectable, and the reaper
 * below still has a real, liveness-checkable pid to test.
 */
export function pinSpawnerSocketForCluster(
  clusterWorkers: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return pinSocketForCluster({
    prefix: SPAWNER_SOCKET_PREFIX,
    envVar: SPAWNER_SOCKET_ENV,
    clusterWorkers,
    env,
  });
}

/**
 * Remove spawner socket files whose owning process is dead (the EI-7832 fix the
 * substrate got and this one did not). Measured 2026-08-12: 206 files in tmpdir,
 * 185 with no live listener, oldest 4 days — growing ~4x/week against WI-7273's
 * count of 52 on 2026-08-03.
 */
export function reapOrphanedSpawnerSockets(
  opts: Omit<Parameters<typeof reapOrphanedPidKeyedSockets>[0], 'prefix'> = {},
): ReapResult {
  return reapOrphanedPidKeyedSockets({ ...opts, prefix: SPAWNER_SOCKET_PREFIX });
}

/**
 * The pid of the host this socket belongs to, or null when the path is not the
 * pid-keyed default (an explicitly-configured `PAPERCUSP_SPAWNER_IPC_SOCKET`).
 *
 * The pid in the name is not decoration — it is the ONLY record of which host a
 * given sidecar serves, and it is what makes an orphan detectable. When the owner
 * dies the socket keeps its name, so the sidecar can read its own path and ask
 * whether the process it exists to serve is still there (D-011: 49 of 50 live
 * sidecars on this box were answering a socket whose owner was long gone, and
 * nothing could ever reach them again).
 *
 * Null means "not derivable" and must be treated as UNKNOWN — never as orphaned.
 */
export function ownerPidFromSocketPath(socketPath: string): number | null {
  return ownerPidFromPidKeyedPath(SPAWNER_SOCKET_PREFIX, socketPath);
}
