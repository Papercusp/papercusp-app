/** Kernel evidence for a lost process:exec reply. Inventory and signal receipts
 * are deliberately not used as exit evidence. Reuses the task-manager scope
 * naming/control seam and the shared /proc parsers. */
import { readFileSync, statSync } from 'node:fs';
import { linuxProcessIdentityFromStat, linuxProcStateFromStat } from '../process-identity';
import { absCgroupDir, CGROUP_ROOT, parseProcCgroup } from '../task-manager/cgroup-read';
import { taskIdFromScopeUnit } from '../task-manager/types';

export const SPAWNER_SCOPE_ENV = 'PAPERCUSP_SPAWNER_SCOPE_UNIT';

export interface SidecarContainment {
  pid: number;
  identity: string;
  scopeUnit: string;
  cgroupPath: string;
  rootIdentity: string;
  cgroupIdentity: string;
}

export interface LifetimeFs {
  read(path: string): string;
  identity(path: string): string;
}

const kernelFs: LifetimeFs = {
  read: (path) => readFileSync(path, 'utf8'),
  identity: (path) => {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  },
};
const bootPath = '/proc/sys/kernel/random/boot_id';
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function validScope(scopeUnit: string, cgroupPath: string): boolean {
  return /^pc-[0-9a-z]{4,64}\.scope$/.test(scopeUnit) && taskIdFromScopeUnit(scopeUnit) !== null &&
    cgroupPath.startsWith('/') && !cgroupPath.includes('\0') &&
    !cgroupPath.split('/').some((part) => part === '..' || part === '.') &&
    cgroupPath.includes('/papercusp.slice/') && cgroupPath.endsWith(`/${scopeUnit}`);
}

/** The spawner supplies the unique scope it asked managedSpawn to create. An
 * unconfined fallback inherits a different scope and cannot advertise recovery. */
export function captureSidecarContainment(
  expectedScope: string | undefined,
  pid = process.pid,
  fs: LifetimeFs = kernelFs,
): SidecarContainment | null {
  if (!expectedScope) return null;
  try {
    const boot = fs.read(bootPath);
    const identity = linuxProcessIdentityFromStat(boot, fs.read(`/proc/${pid}/stat`));
    const cgroupPath = parseProcCgroup(fs.read(`/proc/${pid}/cgroup`));
    if (!identity || !cgroupPath || !validScope(expectedScope, cgroupPath)) return null;
    const rootIdentity = fs.identity(CGROUP_ROOT);
    const cgroupIdentity = fs.identity(absCgroupDir(cgroupPath));
    if (linuxProcessIdentityFromStat(boot, fs.read(`/proc/${pid}/stat`)) !== identity) return null;
    return { pid, identity, scopeUnit: expectedScope, cgroupPath, rootIdentity, cgroupIdentity };
  } catch {
    return null;
  }
}

export type SidecarExitState = 'alive' | 'unknown' | 'populated' | 'exited';

/** Local preflight binds the advertised server to kernel identity and containment
 * BEFORE dispatch. No mutation may start when that containment is unavailable. */
export function sidecarContainmentCurrent(snapshot: SidecarContainment): boolean {
  const current = captureSidecarContainment(snapshot.scopeUnit, snapshot.pid);
  return current !== null && current.identity === snapshot.identity &&
    current.cgroupPath === snapshot.cgroupPath && current.rootIdentity === snapshot.rootIdentity &&
    current.cgroupIdentity === snapshot.cgroupIdentity;
}

/** Read every predicate afresh. Even ENOENT only proves absence after checking
 * the same boot and cgroup mount; EACCES/EIO and malformed data stay unknown. */
export function observeSidecarExit(snapshot: SidecarContainment, fs: LifetimeFs = kernelFs): SidecarExitState {
  if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid <= 0 ||
      !validScope(snapshot.scopeUnit, snapshot.cgroupPath)) return 'unknown';
  try {
    const boot = fs.read(bootPath).trim();
    if (!boot || !snapshot.identity.startsWith(`linux:${boot}:`)) return 'unknown';
    try {
      const stat = fs.read(`/proc/${snapshot.pid}/stat`);
      const current = linuxProcessIdentityFromStat(boot, stat);
      const state = linuxProcStateFromStat(stat);
      if (!current || !state) return 'unknown';
      if (current === snapshot.identity && state !== 'Z' && state !== 'X') return 'alive';
      // A different start time proves the old incarnation has exited. Never
      // signal the recycled PID. A zombie likewise cannot admit/spawn new work.
    } catch (error) {
      if (!missing(error)) return 'unknown';
    }
    if (fs.identity(CGROUP_ROOT) !== snapshot.rootIdentity) return 'unknown';
    const dir = absCgroupDir(snapshot.cgroupPath);
    try {
      if (fs.identity(dir) !== snapshot.cgroupIdentity) return 'unknown';
    } catch (error) {
      return missing(error) ? 'exited' : 'unknown';
    }
    // populated includes ALL descendant cgroups; cgroup.procs does not.
    const lines = fs.read(`${dir}/cgroup.events`).trim().split('\n');
    const values = lines.filter((line) => /^populated\s/.test(line.trim()));
    if (values.length !== 1) return 'unknown';
    const value = /^populated\s+([01])$/.exec(values[0]!.trim())?.[1];
    return value === '0' ? 'exited' : value === '1' ? 'populated' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** How long to keep re-observing a `populated` scope after a signal was sent. The kernel
 * clears `cgroup.events` `populated` (and systemd removes the scope) only AFTER the
 * signalled tasks are torn down and reaped, so the first read after a successful SIGKILL
 * can still say `populated` (measured WI-10004743: `killScopeUnit` reported "verified
 * empty" yet the very next `observeSidecarExit` read `populated`; `exited` came ~50ms
 * later). A single immediate re-read therefore turned an in-progress teardown into
 * "exit unverified". Bounded, so a scope that genuinely cannot die still returns false. */
export const SIDECAR_REAP_SETTLE_MS = 2_000;
const SIDECAR_REAP_POLL_MS = 25;

/** A successful signal is only progress. Resolve true solely on a fresh kernel
 * exit observation, including when a failed kill raced normal scope teardown. The
 * observation is re-read for up to `settleMs` while the scope is still `populated`,
 * because exit lags the signal; `unknown`/`alive` are never waited out. */
export async function reapDeadSidecar(
  snapshot: SidecarContainment,
  deps: {
    fs?: LifetimeFs;
    kill?: (scopeUnit: string) => Promise<unknown>;
    settleMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const state = observeSidecarExit(snapshot, deps.fs);
  if (state === 'exited') return true;
  if (state !== 'populated') return false;
  try {
    if (deps.kill) await deps.kill(snapshot.scopeUnit);
    else {
      const { killScopeUnit } = await import('../task-manager/control');
      await killScopeUnit(snapshot.scopeUnit, { signal: 'SIGKILL' });
    }
  } catch {
    // A failed signal must still be followed by positive observation.
  }
  const settleMs = deps.settleMs ?? SIDECAR_REAP_SETTLE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let observed = observeSidecarExit(snapshot, deps.fs);
  for (let waited = 0; observed === 'populated' && waited < settleMs; waited += SIDECAR_REAP_POLL_MS) {
    await sleep(SIDECAR_REAP_POLL_MS);
    observed = observeSidecarExit(snapshot, deps.fs);
  }
  return observed === 'exited';
}
