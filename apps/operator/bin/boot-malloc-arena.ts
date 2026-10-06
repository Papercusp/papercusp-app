/**
 * Side-effect boot module: cap glibc malloc arenas on EVERY launch path by
 * re-executing this process in place when its launcher did not set the cap
 * (host-memory-reduction-2026-09-27 P-005 follow-up).
 *
 * Unset, glibc creates up to 8 x ncpu malloc arenas, one per contending thread,
 * each a 64 MiB mapping that fragments and is rarely returned. The operator's
 * native allocators (Hypercore/Hyperbee, onnxruntime, libuv) spread across them.
 * MALLOC_ARENA_MAX=2 costs negligible contention for a workload whose hot
 * allocations live in V8's own heap, not glibc malloc.
 *
 * P-005 set the cap per LAUNCHER (systemd drop-ins for :3070, bg-host,
 * staging), and every launcher it missed kept paying. Measured 2026-09-27: the
 * desktop-dev operator on :3270 (dev-operator-ifneeded.sh) held 45 arenas =
 * 1,810 MiB, papercusp-hosted-control-plane.service held 33 = 1,336 MiB, while
 * every capped host held 0; the shipped desktop sidecar spawns serve.mjs with no
 * cap either. glibc reads the variable once, at malloc init, so it must be in
 * the environment BEFORE exec. The only place that sees every launch path is
 * the process itself, hence the re-exec.
 *
 * `process.execve` replaces the process image: same pid (pid files, systemd
 * MainPID, a parent's child handle all stay valid), same argv/execArgv, same
 * inherited fds. It runs before any other module body, so nothing is lost but
 * the module-loading time already spent. Launchers we control should still set
 * the variable themselves so this never fires; the stderr line names the gap.
 *
 * An explicit MALLOC_ARENA_MAX (any value) or a GLIBC_TUNABLES arena_max is
 * respected, which is also the opt-out. Imported FIRST by hono-host.ts and
 * serve.ts; it must stay free of imports that do work at evaluation time.
 */
import { readFileSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { HOST_MALLOC_ARENA_MAX, planMallocArenaReexec, planSelfOnlyPreloadScrub } from './malloc-arena-reexec';

const plan = planMallocArenaReexec({
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  isMainThread,
  hasExecve: typeof process.execve === 'function',
});

if (plan.action === 'reexec') {
  console.error(
    `[boot-malloc-arena] MALLOC_ARENA_MAX unset by this launcher; re-executing pid ${process.pid} ` +
      `with MALLOC_ARENA_MAX=${HOST_MALLOC_ARENA_MAX} after ${process.uptime().toFixed(2)}s of module loading ` +
      '(set it in the launcher to skip this)',
  );
  try {
    process.execve!(plan.file, plan.args, plan.env);
  } catch (err) {
    console.error('[boot-malloc-arena] re-exec failed; continuing without the arena cap:', err);
  }
}

// Self-only allocator preload (WI-10005291): AFTER the re-exec decision, so a
// re-executed image still receives LD_PRELOAD; this runs again in that image.
const scrub = planSelfOnlyPreloadScrub(process.env);
if (scrub) {
  for (const [key, value] of Object.entries(scrub)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let jemalloc = 'unknown';
  try {
    jemalloc = readFileSync('/proc/self/maps', 'utf8').includes('libjemalloc') ? 'active' : 'NOT loaded';
  } catch {
    // Not Linux /proc; the scrub itself still applied.
  }
  if (isMainThread) {
    console.error(
      `[boot-malloc-arena] self-only allocator preload: jemalloc ${jemalloc} in pid ${process.pid}; ` +
        'removed it from the environment child processes inherit',
    );
  }
}
