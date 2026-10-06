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

/**
 * System directories an interpreter needs to exec and dynamically link.
 * `-try` because merged-/usr hosts make some of these symlinks or absent.
 * `/etc` is deliberately NOT here: node runs without it (measured
 * 2026-10-05), and it holds host identity and config a provider must not see.
 */
export const PROVIDER_SYSTEM_RO_DIRS = ['/usr', '/lib', '/lib64', '/bin', '/sbin'] as const;

export interface ProviderBwrapOptions {
  /** Plugin directory: bound READ-ONLY at its own path and used as cwd. */
  pluginDir: string;
  /**
   * Install prefixes the daemon's interpreter needs (e.g. node's prefix when
   * it lives outside /usr). Bound read-only; a missing one fails the spawn.
   */
  runtimeDirs?: string[];
  bwrapBinary?: string;
  /** Daemon argv (binary first). */
  cmd: string[];
}

/**
 * The provider sandbox profile (D-006): a third-party provider gets no
 * network namespace of its own (`--unshare-net` leaves only an isolated
 * loopback), no host filesystem beyond the system dirs, its runtime and its
 * own read-only plugin dir, a private /tmp, and a scrubbed environment. Every
 * outbound request must go through the host's `host.fetch`.
 *
 * Unlike {@link buildBwrapArgs} there are no caller-supplied read/write paths
 * and no network opt-in: the profile is fixed so a manifest cannot widen it.
 */
export function buildProviderBwrapArgs(opts: ProviderBwrapOptions): { binary: string; argv: string[] } {
  const binary = opts.bwrapBinary ?? 'bwrap';
  const argv: string[] = [];
  for (const dir of PROVIDER_SYSTEM_RO_DIRS) argv.push('--ro-bind-try', dir, dir);
  // /tmp before the plugin/runtime binds: a plugin dir under /tmp must be
  // bound ON TOP of the private tmpfs, not shadowed by it.
  argv.push('--tmpfs', '/tmp');
  for (const dir of opts.runtimeDirs ?? []) argv.push('--ro-bind', dir, dir);
  argv.push(
    '--ro-bind', opts.pluginDir, opts.pluginDir,
    '--proc', '/proc',
    '--dev', '/dev',
    '--chdir', opts.pluginDir,
    '--unshare-net',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--new-session',
    '--die-with-parent',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'HOME', '/tmp',
    '--',
    ...opts.cmd,
  );
  return { binary, argv };
}
