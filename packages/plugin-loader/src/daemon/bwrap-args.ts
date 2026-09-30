/**
 * Construct bwrap argv for sandboxing a daemon plugin (Batch I3).
 * Mirrors the Rust runtime's compute.exec slice-3 sandbox model so the
 * audit + posture story is identical across runtimes.
 *
 * v1 caveats (same as Rust slice-3 v1):
 *   - No --unshare-net by default (loopback init requires privileges).
 *   - No --unshare-user (nested-userns environments deny uid_map writes).
 *   - When PAPERCUP_PLUGIN_BWRAP_REQUIRED=1 in CI, the supervisor fails
 *     hard if bwrap can't sandbox. Otherwise it falls back to a plain
 *     spawn with $PATH-pinned env (and logs a warning).
 *
 * Capability inputs:
 *   - readPaths: extra read-only host paths the daemon needs to see
 *     (resolved by manifest cap declarations like fs:read:<path>).
 *   - writePaths: read-write bind mounts.
 *   - shareNet: true when manifest declares net:* caps.
 */

export interface BwrapBuildOptions {
  workDir: string;
  bwrapBinary?: string; // default 'bwrap'
  readPaths?: string[];
  writePaths?: string[];
  shareNet?: boolean;
  /** Daemon argv (binary first). */
  cmd: string[];
}

export function buildBwrapArgs(opts: BwrapBuildOptions): { binary: string; argv: string[] } {
  const binary = opts.bwrapBinary ?? 'bwrap';
  const argv: string[] = [
    '--ro-bind', '/', '/',
    '--tmpfs', '/tmp',
    '--bind', opts.workDir, '/work',
    '--chdir', '/work',
    '--proc', '/proc',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--die-with-parent',
    '--clearenv',
  ];
  for (const p of opts.readPaths ?? []) {
    argv.push('--ro-bind-try', p, p);
  }
  for (const p of opts.writePaths ?? []) {
    argv.push('--bind-try', p, p);
  }
  // Net + user namespace deliberately omitted — see file header.
  argv.push('--');
  argv.push(...opts.cmd);
  return { binary, argv };
}
