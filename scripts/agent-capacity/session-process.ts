/**
 * How one agent session's process is started and accounted for, shared by the replay driver
 * (`load-driver.ts`) and the real-agent recorder (`record-session.ts`).
 *
 * Plan agent-capacity-and-cost-gcp-2026-09-30, P-004: the calibration compares a real session
 * with its replay, so both sides must be measured by the same code. Each session runs as its own
 * transient user service; a wrapper, still inside that cgroup, records `memory.peak` and
 * `cpu.stat usage_usec` for the CLI and every tool it spawned. (systemd-run's own "Memory peak"
 * summary line is read after the cgroup empties and was measured wrong by >100x on systemd 255,
 * so it is not used.)
 *
 * The copy and remove helpers SPAWN native cp/rm. Both callers run an HTTP server (the replay
 * server, or the recording proxy) on the same event loop as the sessions it serves, so a
 * synchronous copy of a 1.2 GB checkout starves every running agent's model traffic (first
 * load-driver smoke run: zero requests served while a second slot copied), and
 * fs.promises.cp walks the ~300k-file node_modules in JS at ~1.5 MB/s under load.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createTextCollector } from '@papercusp/operator-core/lib/child-output';

export const STATS_MARKER = 'CAPDRV_CGROUP';

export type Isolation = 'systemd' | 'none';

export function runAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const err = createTextCollector(p.stderr);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}: ${err.text().slice(0, 500)}`))));
  });
}

/**
 * Make `dst` an exact copy of `src`. Any existing `dst` is removed first, and `-T` stops `cp` from
 * nesting the copy as `dst/<basename(src)>` when `dst` already exists. Measured 2026-10-01: an
 * aborted run left partial work dirs under the same run id, the relaunch copied each checkout one
 * level too deep, and the replayed tool calls failed on paths that were no longer there.
 */
export async function copyTree(src: string, dst: string): Promise<void> {
  mkdirSync(path.dirname(dst), { recursive: true });
  await removeTree(dst);
  await runAsync('cp', ['-a', '--reflink=auto', '-T', src, dst]);
}

export const removeTree = (p: string): Promise<void> => runAsync('rm', ['-rf', '--', p]);

/**
 * How a replay gets its private, writable checkout.
 *
 * `copy`: a full `cp -a --reflink=auto` of the prepared checkout, removed with `rm -rf` after.
 * `overlay`: an overlayfs mount with the prepared checkout as the read-only lower layer and an
 * empty per-session upper layer, so setup and teardown cost the same at any checkout size and
 * only what the session itself wrote is ever removed.
 *
 * Why `overlay` exists (WI-10004672, measured 2026-10-01 on an e2-standard-32, XFS reflink
 * cache): one copy of the 69k-file excalidraw checkout took 5.7s and four concurrent 9.0s; one
 * `rm -rf` took 2.6s and four concurrent 12.2s, slower than running them serially. With `copy`,
 * every P-005 ramp step therefore held about 12-13 sessions in flight whatever N was asked for,
 * on 8 vCPUs and on 32 alike, so the ramps measured setup throughput instead of the machine. An
 * overlay mount took 0.05s and its umount 0.11s. A long-running real agent pays its checkout
 * once per hours-long session, so setup must not dominate a replay that lasts minutes.
 *
 * `overlay` needs `sudo -n mount` (the capacity VMs' default user has passwordless sudo) and
 * paths free of `,` and `:`, which overlayfs's option string cannot carry.
 *
 * `shared` gives every session the prepared checkout itself, with no private view, the way hosted
 * workspace sessions share one tree (hosted-psu-session.ts runs every session at workspaceRoot).
 * It is what a per-checkout shared service (the tsc-service template units) needs in order to be
 * shared at all. Sessions' edits land in that tree and persist for the rest of the run.
 */
export type WorkdirMode = 'copy' | 'overlay' | 'shared';

/** The overlay's upper and work dirs for a session checkout at `dst`, beside it, never inside. */
export function overlayLayout(src: string, dst: string): { upper: string; work: string; mountArgs: string[] } {
  for (const p of [src, dst]) if (/[,:]/.test(p)) throw new Error(`overlay paths cannot contain ',' or ':': ${p}`);
  const upper = `${dst}.ovl/up`;
  const work = `${dst}.ovl/wk`;
  return { upper, work, mountArgs: ['-n', 'mount', '-t', 'overlay', 'overlay', '-o', `lowerdir=${src},upperdir=${upper},workdir=${work}`, dst] };
}

export interface Workdir {
  /** Unmount (overlay) and, unless `keep`, delete the checkout. `keep` leaves an overlay's upper layer: what the session changed. */
  teardown(keep: boolean): Promise<void>;
}

/**
 * Give `dst` a private writable view of `src` in `mode`. Leftovers of an aborted run at `dst` are
 * cleared first, mounted or not, so a relaunch under the same run id starts clean.
 */
export async function prepareWorkdir(mode: WorkdirMode, src: string, dst: string, run: typeof runAsync = runAsync): Promise<Workdir> {
  if (mode === 'shared') {
    // Nothing to create or remove: the caller runs the session in `src` itself.
    if (path.resolve(src) !== path.resolve(dst)) throw new Error(`shared workdir must be the prepared checkout: ${dst} != ${src}`);
    return { teardown: async () => undefined };
  }
  mkdirSync(path.dirname(dst), { recursive: true });
  if (mode === 'copy') {
    await copyTree(src, dst);
    return { teardown: async (keep) => (keep ? undefined : removeTree(dst)) };
  }
  const { upper, work, mountArgs } = overlayLayout(src, dst);
  const clear = async () => {
    await run('sudo', ['-n', 'umount', dst]).catch(() => undefined);
    // overlayfs creates root-owned entries in the work dir, so removal needs root too.
    await run('sudo', ['-n', 'rm', '-rf', '--', dst, `${dst}.ovl`]);
  };
  await clear();
  mkdirSync(upper, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(dst, { recursive: true });
  await run('sudo', mountArgs);
  return {
    teardown: async (keep) => {
      if (!keep) return clear();
      await run('sudo', ['-n', 'umount', dst]);
    },
  };
}

/** Parse the epilogue line the wrapper appends: `CAPDRV_CGROUP peak=<bytes> usage_usec=<n>`. */
export function parseCgroupStats(text: string): { memPeakBytes: number | null; cpuUsec: number | null } {
  const line = text.split('\n').reverse().find((l) => l.startsWith(STATS_MARKER));
  if (!line) return { memPeakBytes: null, cpuUsec: null };
  const num = (k: string) => {
    const m = new RegExp(`\\b${k}=(\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  return { memPeakBytes: num('peak'), cpuUsec: num('usage_usec') };
}

/**
 * Wrap the CLI so the unit reports its own cgroup's peak memory and CPU before exiting, then
 * exits with the CLI's status. Runs inside `systemd-run`, so `/proc/self/cgroup` is the unit's.
 */
export function wrapperScript(statsFile: string): string {
  return [
    '"$@"',
    'rc=$?',
    'cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)',
    `printf '${STATS_MARKER} peak=%s usage_usec=%s\\n' "$(cat "$cg/memory.peak" 2>/dev/null)" "$(awk '/^usage_usec/{print $2}' "$cg/cpu.stat" 2>/dev/null)" >> "${statsFile}"`,
    'exit $rc',
  ].join('\n');
}

export function systemdRunArgs(unit: string, workDir: string, env: Record<string, string>, statsFile: string, argv: string[], slice = 'capdrv.slice'): string[] {
  const out = ['--user', '--wait', '--pipe', '--collect', '--quiet', `--unit=${unit}`, `--slice=${slice}`, `--working-directory=${workDir}`];
  // A multi-line value (an exported shell function, a pasted key) cannot pass through --setenv.
  for (const [k, v] of Object.entries(env)) if (!/[\n\r]/.test(v) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out.push(`--setenv=${k}=${v}`);
  out.push('bash', '-c', wrapperScript(statsFile), 'capdrv', ...argv);
  return out;
}

export interface SessionSpawn {
  cmd: string;
  args: string[];
  /** The env to hand spawn(): the session env itself, or (under systemd) the caller's, since the unit gets the session env through --setenv. */
  env: NodeJS.ProcessEnv;
  /** How to stop the session on timeout, besides signalling the spawned process group. */
  killArgs: string[] | null;
}

/**
 * The command that starts one session. Under `systemd` it is a transient unit `<unit>.service`
 * in `slice`; under `none` it is the CLI itself (no per-session accounting).
 */
export function sessionSpawn(
  isolation: Isolation,
  unit: string,
  workDir: string,
  env: Record<string, string>,
  statsFile: string,
  argv: string[],
  callerEnv: NodeJS.ProcessEnv,
  slice = 'capdrv.slice',
): SessionSpawn {
  if (isolation === 'systemd') {
    return {
      cmd: 'systemd-run',
      args: systemdRunArgs(unit, workDir, env, statsFile, argv, slice),
      env: callerEnv,
      killArgs: ['--user', 'kill', '--signal=SIGTERM', `${unit}.service`],
    };
  }
  return { cmd: argv[0], args: argv.slice(1), env, killArgs: null };
}
