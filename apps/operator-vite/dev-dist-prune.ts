/**
 * Dev-watch dist chunk retention + prune (Option-1 build-churn cure;
 * plan `adv-build-churn-retain-chunks-2026-06-03`).
 *
 * Why this exists
 * ---------------
 * `dev:nohmr` runs `vite build --watch`, and on this shared box every fleet
 * edit triggers a rebuild. With Vite's default `emptyOutDir`, each rebuild
 * DELETES the prior hashed chunks (verified: an incremental rebuild removes the
 * old `lazy-<hash>.js`). A long-open Tauri webview still holds the old build's
 * lazy-import URLs (vditor, code-split routes); when it fetches one,
 * `host-spa.ts` 404s and the pane goes blank.
 *
 * The cure (in `vite.config.ts`) is `emptyOutDir:false` — the DEFAULT regime for
 * every build except an explicit `PAPERCUSP_RETAIN_DIST_CHUNKS=0` opt-out (see
 * `shouldRetainDistChunks` below) — which RETAINS old chunks so the running page
 * keeps resolving the build it loaded.
 * The only cost is that `dist/assets/` then grows without bound — that's what
 * this plugin handles: after each rebuild it deletes asset files that have been
 * sitting untouched longer than a TTL (default 60 min). Files written by the
 * current build have fresh mtimes, so they are never pruned; the TTL is the
 * grace window for an idle webview that hasn't yet loaded one of its chunks
 * (the existing `ChunkReloadPrompt` recovery covers the rare beyond-TTL miss).
 *
 * The age policy is a pure function (`selectStaleChunks`) so it is unit-tested
 * in isolation; the plugin is the thin disk glue around it (verified live).
 */
import type { Plugin } from 'vite';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** A file in `dist/assets/` reduced to what the age policy needs. */
export interface DistFile {
  /** name relative to the assets dir (e.g. `vditor-CfHiDFoY.js`) */
  name: string;
  /** last-modified time in epoch ms */
  mtimeMs: number;
}

const DEFAULT_TTL_MIN = 60;

/**
 * Names of files last modified strictly MORE than `ttlMs` ago — safe to delete.
 * Pure: no disk access, no clock read. A file exactly on the boundary is kept
 * (conservative — we never over-prune a chunk a live page might still need).
 */
export function selectStaleChunks(files: DistFile[], nowMs: number, ttlMs: number): string[] {
  return files.filter((f) => nowMs - f.mtimeMs > ttlMs).map((f) => f.name);
}

/**
 * Resolve the prune TTL (ms) from the environment. `PAPERCUSP_DIST_CHUNK_TTL_MIN`
 * overrides the 60-minute default; a non-numeric or non-positive value falls
 * back to the default rather than disabling/over-aggressive pruning.
 */
export function resolveTtlMs(env: Record<string, string | undefined>): number {
  const raw = env.PAPERCUSP_DIST_CHUNK_TTL_MIN;
  const n = raw === undefined ? NaN : Number(raw);
  const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
  return minutes * 60_000;
}

/**
 * Should this build RETAIN old hashed chunks (emptyOutDir:false + age-prune)
 * instead of emptying `dist/`? **Retention is the DEFAULT.** Only an explicit
 * `PAPERCUSP_RETAIN_DIST_CHUNKS=0` turns it off, and never for a `--watch`.
 *
 * Why the default is retain (plan `dist-chunk-retention-default-2026-07-26`,
 * D-001): this used to be opt-IN (`=1`), and for weeks **nothing in the repo
 * ever set it** — the mechanism built to stop stale-chunk 404s was never
 * switched on by any caller, so the bug kept firing while the code claimed it
 * was handled. Worse, `green-checkpoint` runs a one-shot SPA build on a timer
 * against the LIVE WORKING TREE, so an automated job was emptying `dist/` and
 * 404-ing the lazy chunks of every open webview on a schedule (owner hit it
 * 2026-07-26). An opt-in that every future caller must remember is exactly the
 * shape that failed; a safe default cannot be forgotten.
 *
 * Why inverting is safe: retention is a **no-op on a clean checkout** — there
 * are no old chunks to retain — so the blast radius is limited to trees that
 * get rebuilt repeatedly, which is precisely where live windows are. Growth is
 * bounded by the TTL prune (`devDistPrunePlugin`), and `index.html` always
 * points at the new chunks, so retained files are only extra.
 *
 * A `--watch` build ALWAYS retains and cannot opt out: emptying outDir under a
 * live watcher is the original bug this whole mechanism exists to prevent.
 *
 * Who opts out (`=0`): a build whose `dist/` is PACKAGED into a shipped
 * artifact — `papercusp-desktop/bin/build-desktop-sidecar.sh` `cp -a`s the whole
 * dist into the desktop bundle, so retained chunks would ship as dead weight.
 * A deploy's release-checkout build deliberately does NOT opt out: that
 * checkout SERVES `:3070` to live windows, so it wants retention too.
 *
 * WHERE THE :3270 REBUILDER LIVES (don't repeat the failed grep): the ~2-min
 * rebuild of the nohmr desktop bundle is `papercup-vite-rebuild.timer` →
 * `~/.local/bin/papercup-vite-rebuild.sh`, which is **OUTSIDE THIS REPO**. It
 * already exported the old opt-in flag, so it was never the broken caller — but
 * because it is out-of-tree, a repo-wide grep for `PAPERCUSP_RETAIN_DIST_CHUNKS`
 * finds only this file and reads as "nothing ever sets it" (that mis-read cost
 * an hour on 2026-07-26). The callers that genuinely lacked it were
 * `green-checkpoint`'s SPA build and any ad-hoc `npm run build` on the shared
 * tree — i.e. an opt-in whose one correct setter was invisible to the tree that
 * defines it. That is the second, independent argument for defaulting to retain.
 *
 * COST: retention is not free. With that 2-min rebuilder and the 60-min TTL,
 * `dist/` was measured at ~748 MB / ~970 files on 2026-07-26 (each build writes
 * ~160 hashed chunks). Bounded and self-pruning, but if disk matters, tune
 * `PAPERCUSP_DIST_CHUNK_TTL_MIN` down rather than switching retention off —
 * the TTL is the grace window for an open webview, so shortening it shortens
 * how long a long-open window stays safe.
 * Pure; exported for tests + reuse by vite.config.
 */
export function shouldRetainDistChunks(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): boolean {
  if (argv.includes('--watch')) return true;
  return env.PAPERCUSP_RETAIN_DIST_CHUNKS !== '0';
}

/**
 * Vite plugin: after each watch rebuild, prune stale chunks from `dist/assets/`.
 * Active only when building in watch mode — a no-op for one-shot/production
 * builds (which empty the dir anyway). Register it from `vite.config.ts` only
 * for the watch build.
 */
export function devDistPrunePlugin(opts: { ttlMs?: number } = {}): Plugin {
  let assetsDir = '';
  let active = false;
  return {
    name: 'papercusp-dev-dist-prune',
    apply: 'build',
    configResolved(config) {
      // Prune whenever we're in a retain regime — a real `--watch`, OR a
      // one-shot build that opted into retention (PAPERCUSP_RETAIN_DIST_CHUNKS);
      // without this the env-gated one-shot retain path would keep old chunks
      // forever (emptyOutDir:false) with nothing to bound the growth.
      active = Boolean(config.build.watch) || shouldRetainDistChunks(process.argv, process.env);
      assetsDir = resolve(config.root, config.build.outDir, config.build.assetsDir || 'assets');
    },
    async writeBundle() {
      if (!active) return;
      const ttlMs = opts.ttlMs ?? resolveTtlMs(process.env);
      const now = Date.now();
      let entries: string[];
      try {
        entries = await readdir(assetsDir);
      } catch {
        return; // assets dir not present yet (first build) — nothing to prune
      }
      const files: DistFile[] = [];
      for (const name of entries) {
        try {
          const s = await stat(join(assetsDir, name));
          if (s.isFile()) files.push({ name, mtimeMs: s.mtimeMs });
        } catch {
          // file vanished between readdir and stat (concurrent rebuild) — skip
        }
      }
      for (const name of selectStaleChunks(files, now, ttlMs)) {
        try {
          await unlink(join(assetsDir, name));
        } catch {
          // already gone / locked — best effort
        }
      }
    },
  };
}
