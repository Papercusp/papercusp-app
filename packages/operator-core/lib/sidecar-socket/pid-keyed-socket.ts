/**
 * Shared mechanics for PID-KEYED unix-domain sidecar sockets
 * (plan spawner-sidecar-cluster-fanout-2026-08-12, P-002/P-003/P-004).
 *
 * Two sidecars in this repo talk to the operator over a tmpdir socket named
 * `papercusp-<kind>-<pid>.sock`: the SUBSTRATE sidecar and the SPAWNER sidecar.
 * The substrate one accumulated three hard-won fixes that the spawner never got,
 * and the spawner then reproduced all three bugs independently:
 *
 *   • WI-1879 — pin the path across a `cluster.fork()` so every WORKER resolves the
 *     SAME socket as the PRIMARY instead of each computing its own pid-keyed path.
 *   • EI-7832 — reap socket FILES left by dead processes; a pid-keyed scheme means
 *     every restart computes a brand-new path, so a server's own `existsSync` guard
 *     can never see an older process's leftover and they accumulate unbounded.
 *   • D-011 — keep the owner pid IN the name, because it is the only record of which
 *     host a sidecar serves and thus the only way an orphan is ever detectable.
 *
 * This module is the ONE implementation, parameterised by `prefix`. It is pure and
 * fully injectable (listDir / isAlive / unlink / connect) so every branch is unit-
 * testable without touching a real filesystem, spawning processes, or opening
 * sockets. Nothing here throws: all of it runs on startup paths where a cleanup
 * failure must never block boot.
 *
 * ⚠ The cluster pin and the reaper interact, and the ORDER matters. Pinning makes N
 * workers share ONE path keyed by the PRIMARY's pid — which is exactly what makes
 * the reaper safe to run from a worker: the shared socket's owner pid is the live
 * primary, so `isAlive` keeps it. Reaping on an UNPINNED path from a worker would
 * be fine too (it only removes DEAD owners), but the pin is what makes "the socket
 * I am about to use" provably not a reap candidate.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** Build the pid-keyed default path for a sidecar kind. */
export function pidKeyedSocketPath(prefix: string, pid: number, tmpdir: string = os.tmpdir()): string {
  return path.join(tmpdir, `papercusp-${prefix}-${pid}.sock`);
}

/**
 * The pid of the host a socket belongs to, or null when the path is not the
 * pid-keyed default (an explicitly-configured socket env override).
 *
 * Null means "not derivable" and MUST be treated as UNKNOWN — never as orphaned.
 * Deleting on a null reading would delete every explicitly-configured socket.
 */
export function ownerPidFromPidKeyedPath(prefix: string, socketPath: string): number | null {
  const re = new RegExp(`^papercusp-${escapeRegExp(prefix)}-(\\d+)\\.sock$`);
  const m = re.exec(path.basename(socketPath));
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `process.kill(pid, 0)` signals liveness without sending a signal: it throws
 * `ESRCH` when the pid is dead. Any OTHER throw (most commonly `EPERM` — alive but
 * owned by another user) is treated as ALIVE: never delete a socket whose owning
 * process we merely lack permission to signal.
 */
export function defaultPidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code !== 'ESRCH';
  }
}

/**
 * Pin the socket path across a true `node:cluster` fork so every forked WORKER
 * resolves the SAME path as the PRIMARY.
 *
 * Call BEFORE `cluster.fork()`, while `process.pid` is still the PRIMARY's: it
 * resolves once (honoring an existing env override, e.g. a systemd-pinned socket)
 * and pins it onto `env`, so the primary's own later resolve is a no-op re-read of
 * the same value. The returned object is the fragment to merge into `workerEnv` so
 * every fork inherits it.
 *
 * No-op ({}) when `clusterWorkers <= 1`: single-process mode has no fork, so
 * cross-process inheritance is not a concern.
 */
export function pinSocketForCluster(opts: {
  prefix: string;
  envVar: string;
  clusterWorkers: number;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  tmpdir?: string;
}): Record<string, string> {
  const env = opts.env ?? process.env;
  if (opts.clusterWorkers <= 1) return {};
  const fromEnv = env[opts.envVar];
  const pinned =
    fromEnv && fromEnv.trim()
      ? fromEnv.trim()
      : pidKeyedSocketPath(opts.prefix, opts.pid ?? process.pid, opts.tmpdir);
  env[opts.envVar] = pinned;
  return { [opts.envVar]: pinned };
}

export interface ReapResult {
  removed: string[];
  kept: string[];
  errors: Array<{ path: string; error: string }>;
}

/**
 * Remove socket files left behind by DEAD processes, for one sidecar kind.
 *
 * Conservative by construction — a file is removed ONLY when its owner pid is
 * derivable AND provably dead. Anything undetermined is KEPT: an unparseable name
 * (an explicit socket override), our own pid, a live owner, or a liveness check
 * that threw. Best-effort per file and never throws, so a permission error or a
 * benign race (a peer reaper winning first) on ONE file never aborts the sweep.
 */
export function reapOrphanedPidKeyedSockets(opts: {
  prefix: string;
  tmpdir?: string;
  listDir?: (dir: string) => string[];
  isAlive?: (pid: number) => boolean;
  unlink?: (p: string) => void;
  ownPid?: number;
}): ReapResult {
  const dir = opts.tmpdir ?? os.tmpdir();
  const listDir = opts.listDir ?? ((d: string) => fs.readdirSync(d));
  const isAlive = opts.isAlive ?? defaultPidIsAlive;
  const unlink = opts.unlink ?? ((p: string) => fs.unlinkSync(p));
  const ownPid = opts.ownPid ?? process.pid;

  const removed: string[] = [];
  const kept: string[] = [];
  const errors: Array<{ path: string; error: string }> = [];

  let entries: string[];
  try {
    entries = listDir(dir);
  } catch (e) {
    return { removed, kept, errors: [{ path: dir, error: errText(e) }] };
  }

  for (const name of entries) {
    const pid = ownerPidFromPidKeyedPath(opts.prefix, name);
    if (pid === null) continue; // not ours / not pid-keyed — never touch
    const full = path.join(dir, name);
    if (pid === ownPid) {
      kept.push(full); // never touch our own live socket
      continue;
    }
    let alive: boolean;
    try {
      alive = isAlive(pid);
    } catch (e) {
      // Liveness undetermined — err on the side of NOT deleting.
      errors.push({ path: full, error: errText(e) });
      kept.push(full);
      continue;
    }
    if (alive) {
      kept.push(full);
      continue;
    }
    try {
      unlink(full);
      removed.push(full);
    } catch (e) {
      errors.push({ path: full, error: errText(e) });
    }
  }
  return { removed, kept, errors };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Is something ACTUALLY listening on this unix socket right now?
 *
 * The cross-process question no in-process guard can answer. A module-scoped
 * "already spawned" latch is per PROCESS, so under `node:cluster` each of N workers
 * believes it must spawn its own sidecar — which is precisely how one 450MB sidecar
 * became sixteen. This probe is what lets a worker ADOPT a sibling's sidecar.
 *
 * Deliberately a connect probe, not `existsSync`: a stale socket FILE outlives its
 * server (that is the whole reason the reaper above exists), so file presence proves
 * nothing about whether anyone is serving. Connecting is the only honest test.
 *
 * Never throws and never rejects — every failure mode (ENOENT, ECONNREFUSED, a
 * hung accept) resolves `false`, because every caller's next move on a false is the
 * same: spawn one. The socket is destroyed on every path, including timeout, so a
 * probe can never leak a descriptor into the host it is probing.
 */
export function probeUnixSocketAlive(
  socketPath: string,
  opts: { timeoutMs?: number; connect?: typeof net.createConnection } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 250;
  const connect = opts.connect ?? net.createConnection;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let sock: net.Socket | null = null;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.destroy();
      } catch {
        /* destroying a socket must never mask the verdict */
      }
      resolve(alive);
    };
    // The timeout must not out-race a connect that has ALREADY completed. Both
    // callbacks run on THIS process's event loop, and the timers phase runs before
    // the poll phase that delivers a finished connect — so a prober that stalls
    // past `timeoutMs` right after dialling (a busy cluster worker) read a LIVE
    // listener as dead and spawned a second full sidecar, which then took over the
    // socket path. Measured 2026-09-27 (host-memory-reduction P-005): :3070 ran two
    // spawner sidecars, the second spawned by a sibling worker 12 min after the
    // first. Deferring the "dead" verdict by one setImmediate lets that poll phase
    // deliver the completed connect first; a listener that never completes the
    // connect still resolves false.
    const timer = setTimeout(() => setImmediate(() => done(false)), timeoutMs);
    // Do not hold the event loop open on the probe's account — a boot-path probe
    // must never be the reason a short-lived process refuses to exit.
    timer.unref?.();
    try {
      sock = connect(socketPath, () => done(true));
      sock.on('error', () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * Exit code for a sidecar that declines to start because a LIVE sidecar already
 * serves its socket path. The host reads it off the child's `exit` event and adopts
 * the sibling. An exit code, not a stderr line, because Node can deliver a child's
 * `exit` before its last stderr chunk. A host that saw the exit first would book the
 * sibling's healthy sidecar as a crash and respawn into the same refusal. 75 is
 * sysexits' EX_TEMPFAIL, and nothing else in these sidecars exits with it.
 */
export const SIDECAR_EXIT_SOCKET_IN_USE = 75;

/**
 * Bind a unix-socket server WITHOUT taking the path away from a live listener.
 *
 * The sidecars used to `unlinkSync` their path and then listen. On a unix socket
 * that never fails: the unlink detaches a LIVE server's inode from the path, and
 * the new bind gets a fresh inode in its place. The old server keeps its clients
 * but no new client can ever reach it. So a sidecar spawned in error (a host whose
 * adoption probe misread a sibling's sidecar as dead) silently became a SECOND full
 * sidecar instead of failing. Measured 2026-09-27 (host-memory-reduction P-005):
 * two spawner sidecars on :3070, both LISTEN on one path, each ~2 GB.
 *
 * Listen first; only an EADDRINUSE earns a look at the path. A live listener there
 * resolves `'in-use'`: the caller must exit and leave the path alone. A stale file
 * (ECONNREFUSED, or no answer) is unlinked and the bind retried once. A second
 * EADDRINUSE whose probe still finds no listener rejects rather than looping. Any
 * other listen error rejects. Listeners are removed on settle, so the caller's own
 * `error` handler owns everything after the bind.
 */
export function listenUnixSocketExclusive(
  server: net.Server,
  socketPath: string,
  opts: { probe?: (p: string) => Promise<boolean>; unlink?: (p: string) => void } = {},
): Promise<'listening' | 'in-use'> {
  const probe = opts.probe ?? ((p: string) => probeUnixSocketAlive(p));
  const unlink = opts.unlink ?? ((p: string) => fs.rmSync(p, { force: true }));
  return new Promise((resolve, reject) => {
    let reclaimed = false;
    const settle = (fn: () => void) => {
      server.off('listening', onListening);
      server.off('error', onError);
      fn();
    };
    const onListening = () => settle(() => resolve('listening'));
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE') {
        settle(() => reject(err));
        return;
      }
      void probe(socketPath).then((alive) => {
        if (alive) return settle(() => resolve('in-use'));
        if (reclaimed) return settle(() => reject(err));
        reclaimed = true;
        try {
          unlink(socketPath);
        } catch (e) {
          return settle(() => reject(e));
        }
        // Node permits a second listen() after the first one errored.
        server.listen(socketPath);
      });
    };
    server.on('listening', onListening);
    server.on('error', onError);
    server.listen(socketPath);
  });
}
