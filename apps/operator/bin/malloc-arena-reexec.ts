/**
 * Pure planner behind boot-malloc-arena.ts: decide whether this process must
 * re-execute itself to get a glibc malloc arena cap, and with what argv/env.
 * Kept free of side effects so tests can import it without re-executing the
 * test worker; boot-malloc-arena.ts is the side-effect half.
 */
export const HOST_MALLOC_ARENA_MAX = '2';

/**
 * The process must have been LAUNCHED as a host (tsx source, the dist-host
 * bundle, or the packaged sidecar's serve.mjs). Anything that merely imports a
 * host module (a vitest forks worker, a tool) is left alone: re-executing it
 * would restart the importer, not a host.
 */
const HOST_ENTRY_RE = /(?:^|[\\/])(?:hono-host|serve)\.(?:ts|mts|mjs|js)$/;

export type MallocArenaReexec =
  | {
      action: 'none';
      reason: 'not-linux' | 'not-host-entry' | 'already-set' | 'tunable-set' | 'worker-thread' | 'no-execve';
    }
  | { action: 'reexec'; file: string; args: string[]; env: Record<string, string> };

export function planMallocArenaReexec(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  isMainThread: boolean;
  hasExecve: boolean;
}): MallocArenaReexec {
  if (input.platform !== 'linux') return { action: 'none', reason: 'not-linux' };
  if (!HOST_ENTRY_RE.test(input.argv[1] ?? '')) return { action: 'none', reason: 'not-host-entry' };
  if (input.env.MALLOC_ARENA_MAX) return { action: 'none', reason: 'already-set' };
  if (input.env.GLIBC_TUNABLES?.includes('glibc.malloc.arena_max')) {
    return { action: 'none', reason: 'tunable-set' };
  }
  if (!input.isMainThread) return { action: 'none', reason: 'worker-thread' };
  if (!input.hasExecve) return { action: 'none', reason: 'no-execve' };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.MALLOC_ARENA_MAX = HOST_MALLOC_ARENA_MAX;
  return {
    action: 'reexec',
    file: input.execPath,
    args: [input.execPath, ...input.execArgv, ...input.argv.slice(1)],
    env,
  };
}

/**
 * Set to `self` by a launcher that preloads jemalloc for the HOST PROCESS ONLY
 * (apps/operator/scripts/systemd/papercup-bg-host.service.d/41-jemalloc.conf).
 *
 * bg-host's resident memory was glibc keeping freed native memory: one
 * malloc_trim(0) took VmRSS 12.1 -> 3.6 GB (WI-10005291 comment 1155216), with
 * MALLOC_ARENA_MAX=2 already set. jemalloc returns freed pages on a decay timer.
 * Unlike the embed sidecar, bg-host spawns many children (git, agent CLIs, the
 * spawner sidecar), and every one would inherit LD_PRELOAD. ld.so reads
 * LD_PRELOAD at exec and jemalloc reads MALLOC_CONF at its first malloc, so the
 * host can drop both from its own environment once it is running: it keeps
 * jemalloc, and its children start on their normal allocator.
 */
export const ALLOCATOR_PRELOAD_SCOPE_ENV = 'PAPERCUSP_ALLOCATOR_PRELOAD_SCOPE';

const JEMALLOC_PRELOAD_RE = /(?:^|\/)libjemalloc\.so(?:\.\d+)*$/;

/**
 * The environment edits that make a self-only preload stay self-only, or null
 * when the launcher did not ask for it. A value of `undefined` means delete the
 * key. Other LD_PRELOAD entries (ld.so accepts `:` or whitespace separators) are
 * kept, because only the jemalloc entry is ours to remove.
 */
export function planSelfOnlyPreloadScrub(env: NodeJS.ProcessEnv): Record<string, string | undefined> | null {
  if (env[ALLOCATOR_PRELOAD_SCOPE_ENV] !== 'self') return null;
  const kept = (env.LD_PRELOAD ?? '')
    .split(/[:\s]+/)
    .filter((entry) => entry !== '' && !JEMALLOC_PRELOAD_RE.test(entry));
  return {
    LD_PRELOAD: kept.length > 0 ? kept.join(':') : undefined,
    MALLOC_CONF: undefined,
    [ALLOCATOR_PRELOAD_SCOPE_ENV]: undefined,
  };
}
