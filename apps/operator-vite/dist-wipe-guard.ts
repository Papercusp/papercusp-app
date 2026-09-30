/**
 * distWipeGuardPlugin — refuse a one-shot `vite build` that would EMPTY the
 * operator-vite dist/ WHILE a live `vite build --watch` singleton
 * (bin/vite-watch-singleton) is serving that same dist/ on :3170.
 *
 * The footgun (2026-06-29 incident): a one-shot `vite build` sets
 * `emptyOutDir:true` (vite.config `!isWatchBuild`) and DELETES the hashed
 * chunks an open WebKitGTK webview is pinned to → 404 lazy imports → blank
 * page. The EI-306 singleton already stops a SECOND *watcher* from corrupting
 * the shared dist; this stops a one-shot *build* from wiping the watcher's
 * LIVE dist out from under open webviews. Same class: protect the shared,
 * live-served dist. See plan `adv-build-churn-retain-chunks-2026-06-03`.
 *
 * Detection reuses the singleton's lock ($VITE_WATCH_LOCK, default
 * /tmp/papercup-operator-vite-watch.lock):
 *   - liveWatcherHoldsLock(): a non-blocking flock. The watcher holds the lock
 *     exclusively for its whole lifetime, so a failure-to-acquire ⇒ a watcher
 *     is live. flock missing/errored (non-Linux) ⇒ unknown ⇒ never block.
 *   - servedDist(): WHICH dist that live watcher serves — line 2 of the lock
 *     (new singletons record it), falling back to /proc/<pid>/cwd + /dist for a
 *     pre-change watcher on Linux. We REFUSE only when the served dist is the
 *     SAME path this build would empty, so a release build in a DIFFERENT
 *     checkout/outDir (the blessed deploy pipeline) is NEVER blocked.
 *
 * Failure direction is SAFE: any uncertainty (no flock, can't tell which dist,
 * path mismatch) fails OPEN → the build proceeds. We only ever block on a
 * positively-confirmed "this empties the live dist" — so the guard can never
 * wedge the deploy pipeline, only stop the specific footgun.
 *
 * Escapes (printed in the refusal):
 *   - just reload — your edits already ride the running watcher (no rebuild).
 *   - throwaway build: `vite build --outDir /tmp/op-vite --emptyOutDir`.
 *   - deliberate clean redeploy, NO webview pinned: VITE_ALLOW_LIVE_DIST_WIPE=1.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export const VITE_WATCH_LOCK_DEFAULT = '/tmp/papercup-operator-vite-watch.lock';

/** Canonical absolute path — realpath when the path exists (resolves symlinks
 *  so a logical `$(pwd)` and a `/proc/<pid>/cwd` readlink compare equal),
 *  falling back to a plain resolve when it doesn't exist yet (a fresh outDir). */
function canon(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** True iff a live process holds the watch singleton's exclusive flock.
 *  flock(1) exits 0 when IT acquired the lock (no live holder) and non-0 when
 *  the lock is already held. flock missing/errored ⇒ can't tell ⇒ false. */
export function liveWatcherHoldsLock(lockPath: string): boolean {
  // No lock file ⇒ no watcher ever ran here. Short-circuit so the probe never
  // CREATES a stray lock file (flock(1) would) and stays fast.
  if (!existsSync(lockPath)) return false;
  const r = spawnSync('flock', ['-n', lockPath, '-c', 'true'], { stdio: 'ignore' });
  if (r.error || typeof r.status !== 'number') return false;
  return r.status !== 0;
}

/** The absolute dist/ the live watcher serves, or null if undeterminable.
 *  Line 2 of the lock (recorded by bin/vite-watch-singleton), else the legacy
 *  Linux fallback: the holder pid's cwd (/proc/<pid>/cwd) + '/dist'. */
export function servedDist(lockPath: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(lockPath, 'utf8').split('\n');
  } catch {
    return null;
  }
  const recorded = lines[1]?.trim();
  if (recorded) return canon(recorded);
  const pid = lines[0]?.trim();
  if (pid && /^\d+$/.test(pid)) {
    try {
      return canon(resolve(readlinkSync(`/proc/${pid}/cwd`), 'dist'));
    } catch {
      return null;
    }
  }
  return null;
}

/** Pure decision — REFUSE this one-shot build? Exported for unit tests.
 *  Refuse only on a positively-confirmed "the live watcher serves the exact
 *  dist we would empty"; everything else (override, no holder, unknown dist,
 *  different dist) proceeds. */
export function shouldRefuseOneShotBuild(args: {
  override: boolean;
  holderLive: boolean;
  served: string | null;
  outDir: string;
}): boolean {
  if (args.override) return false;
  if (!args.holderLive) return false;
  if (args.served === null) return false;
  return canon(args.served) === canon(args.outDir);
}

export function distWipeGuardPlugin(opts?: { lockPath?: string; outDir?: string }): Plugin {
  const lockPath = opts?.lockPath ?? process.env.VITE_WATCH_LOCK ?? VITE_WATCH_LOCK_DEFAULT;
  let outDir = '';
  return {
    name: 'papercusp-dist-wipe-guard',
    apply: 'build',
    enforce: 'pre',
    configResolved(config) {
      // `opts.outDir` — the FINAL dist/ a STAGED build (EI-10539) will be renamed
      // onto. A staged build writes to `dist.next/`, so config.build.outDir is the
      // staging dir and this guard would see a path no watcher serves and wave the
      // build through — but the SWAP still deletes the hashed chunks an open
      // webview is pinned to, which is precisely what this guard exists to refuse.
      // Judge the path the damage actually lands on.
      outDir = opts?.outDir ?? resolve(config.root, config.build.outDir);
    },
    buildStart() {
      // Inert in any watch context (the watcher IS the lock holder — never
      // block it). Defense-in-depth: vite.config only wires this plugin for
      // non-watch builds, but guard here too in case it's ever added eagerly.
      if (process.argv.includes('--watch')) return;
      const refuse = shouldRefuseOneShotBuild({
        override: process.env.VITE_ALLOW_LIVE_DIST_WIPE === '1',
        holderLive: liveWatcherHoldsLock(lockPath),
        served: servedDist(lockPath),
        outDir,
      });
      if (!refuse) return;
      this.error(
        `[dist-wipe-guard] REFUSING a one-shot \`vite build\`: a live \`vite build --watch\` ` +
          `singleton is serving ${outDir} on :3170 (holds ${lockPath}). Emptying it now deletes ` +
          `the hashed chunks open webviews are pinned to → 404 → blank page (the 2026-06-29 incident).\n` +
          `  • Just reload — your edits already ride the running watcher; no rebuild needed.\n` +
          `  • Throwaway build: \`vite build --outDir /tmp/op-vite --emptyOutDir\`.\n` +
          `  • Deliberate clean redeploy with NO webview pinned: \`VITE_ALLOW_LIVE_DIST_WIPE=1\`.`,
      );
    },
  };
}
