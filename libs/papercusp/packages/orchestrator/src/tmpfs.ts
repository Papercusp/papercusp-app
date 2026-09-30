/**
 * Cross-platform RAM-resident scratch space for subprocess inputs.
 *
 * The orchestrator's PG-canonical design keeps mission state in Postgres,
 * but external programs (omp, claude) need a path on disk to read from.
 * This module hands those programs an ephemeral directory that lives in
 * RAM whenever possible:
 *
 *   - Linux:   `/dev/shm` (tmpfs by definition, no setup, always available)
 *   - macOS, Windows, hardened Linux: `os.tmpdir()` (page cache catches
 *     short-lived files; verified zero-physical-disk-write at 5000-iter
 *     scale on a disk-backed `/tmp` — see disk-proof-test.mjs)
 *
 * The `withTmpDir` helper guarantees cleanup via try/finally even if the
 * subprocess crashes. Stale dirs from SIGKILL'd orchestrators are reaped
 * by the OS's normal /tmp cleanup (systemd-tmpfiles on Linux, launchd on
 * macOS, manual on Windows — sweep at orchestrator startup if needed).
 */
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cachedRoot: string | null = null;

/**
 * Return a directory backed by RAM whenever possible. Cached after first
 * call so subsequent spawns don't pay stat overhead.
 */
export function ramTmpRoot(): string {
  if (cachedRoot !== null) return cachedRoot;
  if (process.platform === 'linux') {
    try {
      if (existsSync('/dev/shm') && statSync('/dev/shm').isDirectory()) {
        cachedRoot = '/dev/shm';
        return cachedRoot;
      }
    } catch { /* fall through to tmpdir() */ }
  }
  cachedRoot = tmpdir();
  return cachedRoot;
}

/** Reset the cached root. Test-only — flushes between platform-mock tests. */
export function _resetRamTmpRootCache(): void {
  cachedRoot = null;
}

/**
 * Run `fn` with an ephemeral directory; cleanup runs even on throw.
 *
 * Pattern for spawning external programs that need a path-based input:
 *
 *   await withTmpDir(async (dir) => {
 *     await writeFile(join(dir, 'prompt.md'), promptText);
 *     await writeFile(join(dir, 'mcp.json'), JSON.stringify(mcpConfig));
 *     return await spawnAndWait('omp', ['-p', `@${join(dir, 'prompt.md')}`], {
 *       env: { ...process.env, PI_CODING_AGENT_DIR: dir },
 *     });
 *   });
 *
 * The directory is created under `ramTmpRoot()` with the prefix `papercusp-`,
 * so a /tmp sweeper can identify and clean stale dirs from killed processes.
 */
export async function withTmpDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(ramTmpRoot(), 'papercusp-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort: stale dirs reaped by OS sweepers */
    });
  }
}
