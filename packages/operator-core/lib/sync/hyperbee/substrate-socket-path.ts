/**
 * Absolute, collision-safe IPC socket path for the substrate sidecar (P-006).
 *
 * The relocation's sidecar talks to the main operator over a Unix-domain socket.
 * The path MUST be absolute. The previous CWD-relative `.papercusp/substrate.sock`
 * default did `mkdir '.papercusp'` against `process.cwd()`, which in a PACKAGED
 * deploy is the root-owned install dir (e.g. /usr/lib/Papercusp/sidecar) → the
 * spawn failed `EACCES: permission denied, mkdir '.papercusp'` and silently fell
 * back to in-process, so the relocation never engaged off a dev tree. (Caught by
 * the P-006 live 2-machine rig verify, 2026-06-25.)
 *
 * Resolution: honour PAPERCUSP_SUBSTRATE_IPC_SOCKET when set — the spawner sets it
 * ONCE so the parent IPC client and the spawned child agree on a single path —
 * otherwise an os.tmpdir() path keyed by the MAIN operator pid, so two operators
 * on one box (the packaged two-instance federation smoke) never collide on one
 * socket. Unix socket paths have a ~108-char limit, so the base must stay short
 * (tmpdir), never a deep workspace path.
 */
import {
  pidKeyedSocketPath,
  pinSocketForCluster,
  reapOrphanedPidKeyedSockets,
  type ReapResult,
} from '../../sidecar-socket/pid-keyed-socket';

export const SUBSTRATE_SOCKET_ENV = 'PAPERCUSP_SUBSTRATE_IPC_SOCKET';

/** The pid-keyed name prefix for this sidecar kind. */
export const SUBSTRATE_SOCKET_PREFIX = 'substrate';

export function resolveSubstrateSocketPath(): string {
  const fromEnv = process.env[SUBSTRATE_SOCKET_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return pidKeyedSocketPath(SUBSTRATE_SOCKET_PREFIX, process.pid);
}

/**
 * WI-1879: pin the socket path across a true `node:cluster` fork, so every forked
 * WORKER resolves the SAME path as the PRIMARY instead of each computing its own
 * (wrong) pid-keyed fallback independently.
 *
 * The bug this closes: the substrate boots asynchronously deep inside the
 * PRIMARY's background-machinery bootstrap (substrate-boot-wrapper → spawnSubstrateSidecar),
 * which is what actually pins `process.env[SUBSTRATE_SOCKET_ENV]` — but `cluster.fork()`
 * for the request WORKERS happens synchronously, BEFORE that async chain runs. Every
 * worker therefore forks off an env that does NOT yet have the socket path set, so each
 * worker's OWN later `resolveSubstrateSocketPath()` call (e.g. the
 * dogfood-substrate-boot-history admin route proxying to the sidecar) falls back to a
 * tmpdir path keyed by ITS OWN pid — a socket that was never created (only the
 * primary's real sidecar socket, keyed by the PRIMARY's pid, exists) — so the IPC dial
 * always fails and the route always degrades to `source:'main-fallback'` with an empty
 * ring on every clustered host (found during P-059 / WI-1837).
 *
 * Call this BEFORE `cluster.fork()` (i.e. before any worker exists), while `process.pid`
 * is still the PRIMARY's own pid: it resolves the path once (honoring an existing env
 * override, e.g. a systemd-pinned socket) and pins it onto `env` so the primary's own
 * later `resolveSubstrateSocketPath()` call is a no-op re-read of the SAME value. The
 * returned object is the exact fragment to merge into `workerEnv` so every fork inherits
 * it too. No-op ({}) when `clusterWorkers<=1` — single-process mode has no fork, so
 * cross-process env inheritance isn't a concern (spawner + client stay in one process).
 *
 * `env` defaults to `process.env`; injectable for tests so this stays pure otherwise.
 */
/**
 * EI-7832: at every sidecar boot, remove socket files left behind by DEAD
 * processes. The path scheme in `resolveSubstrateSocketPath` is PID-keyed, so
 * every process restart computes a brand-new, never-before-seen path — which
 * means `substrate-sidecar-server.ts`'s own `existsSync(socketPath)` guard
 * (written for the case of restarting into the SAME path) can never fire
 * against an OLDER process's leftover file, since that older file lives at a
 * different (dead) pid's path. With no shutdown-time cleanup either (fixed
 * separately in substrate-sidecar-server.ts's `exit` handler) and no reaper,
 * these accumulate unbounded in `os.tmpdir()` — 60+ observed since 2026-07-03.
 *
 * Pure + fully injectable (listDir / isAlive / unlink) so the pid-liveness
 * sweep logic is unit-testable without touching the real filesystem or
 * spawning/killing real processes. Best-effort per file and never throws:
 * this runs at sidecar boot before anything else, and cleanup must never
 * block or fail startup. A permission error or a benign race (the file
 * disappearing between list and unlink, e.g. a peer reaper winning first) on
 * ONE file is recorded in `errors` but never aborts the sweep of the rest.
 */
export function reapOrphanedSubstrateSockets(
  opts: {
    tmpdir?: string;
    listDir?: (dir: string) => string[];
    isAlive?: (pid: number) => boolean;
    unlink?: (p: string) => void;
    ownPid?: number;
  } = {},
): ReapResult {
  return reapOrphanedPidKeyedSockets({ ...opts, prefix: SUBSTRATE_SOCKET_PREFIX });
}

export function pinSubstrateSocketForCluster(
  clusterWorkers: number,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return pinSocketForCluster({
    prefix: SUBSTRATE_SOCKET_PREFIX,
    envVar: SUBSTRATE_SOCKET_ENV,
    clusterWorkers,
    env,
  });
}
