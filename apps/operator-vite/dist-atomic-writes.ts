/**
 * Corruption-free dist writes for the RETAIN regime (gym-tab outage, 2026-07-26).
 *
 * Why this exists
 * ---------------
 * Retention (`emptyOutDir:false`, the default since
 * `dist-chunk-retention-default-2026-07-26`) stopped rebuilds from DELETING the
 * hashed chunks an open webview is pinned to — but a retain-regime build still
 * REWRITES every same-hash asset IN PLACE, and `write()` with `O_TRUNC` is not
 * atomic: a webview fetching `chunk-X.js` while the build is rewriting that very
 * file reads a TRUNCATED module → "Importing a module script failed" → the fatal
 * route error card. With the out-of-tree `papercup-vite-rebuild.timer` running
 * every ~2 min on this box, the write window recurs so often that a long-open
 * desktop window crashed on most tab loads for DAYS (observed live 2026-07-26:
 * two crashes in 15 min, each aligned to a build's asset-write window to the
 * second; the boundary's auto-reload landed MID-BUILD, failed again inside the
 * 60s debounce, and dead-ended on the manual card).
 *
 * The cure
 * --------
 * A content-hashed filename is a contract: same name ⇒ same bytes. So:
 *
 *  1. An emitted hashed asset that ALREADY EXISTS with the same byte length is
 *     never rewritten — it is dropped from the bundle and its mtime is bumped
 *     via `utimes` instead. The mtime bump is an atomic metadata op (no content
 *     window) and is REQUIRED, not cosmetic: `devDistPrunePlugin` ages files by
 *     mtime, so without the bump a chunk that stopped being rewritten would be
 *     pruned 60 min later while still referenced by the CURRENT index.html.
 *  2. Genuinely new hashed assets are written normally by Vite — no live page
 *     references a hash that never existed, so those writes cannot corrupt
 *     anything a window can fetch.
 *  3. `index.html` (the only non-hashed, always-rewritten file in the bundle)
 *     is swapped ATOMICALLY: written to a temp name, then `rename(2)`d over the
 *     target, so a concurrent request sees the old or the new file, never a
 *     partial one. Written in `writeBundle` (after every asset landed), so the
 *     new graph is only ever referenced once it is fully on disk.
 *
 * Non-goals: `publicDir` copies (wordmark.svg etc.) are still plain rewrites —
 * tiny, browser-cached, and not part of the hashed-chunk contract. The
 * clean-empty regime (`PAPERCUSP_RETAIN_DIST_CHUNKS=0`, packaging) already
 * stages + swaps whole bundles via `bin/vite-build-singleflight`; this plugin
 * is a no-op there (an emptied outDir has no existing files to skip).
 */
import type { Plugin } from 'vite';
import { mkdirSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Vite/Rolldown content-hash suffix: `-<8+ base64url chars>` right before the
 *  final extension (plus an optional `.map`). Conservative: a miss just means
 *  the file is written the normal way. */
const HASHED_ASSET_RE = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+(\.map)?$/i;

/** Is this bundle fileName a content-hashed asset under the assets dir? */
export function isHashedAssetPath(fileName: string, assetsDir = 'assets'): boolean {
  return fileName.startsWith(`${assetsDir}/`) && HASHED_ASSET_RE.test(fileName);
}

/** Same hashed name + same byte length ⇒ identical bytes ⇒ rewriting is pure
 *  corruption window. (The length check also refuses to "skip" a truncated
 *  leftover from a crashed pre-fix build — that one gets rewritten.) */
export function shouldSkipRewrite(
  existingByteLength: number | null,
  emittedByteLength: number,
): boolean {
  return existingByteLength !== null && existingByteLength === emittedByteLength;
}

/** Byte length of an emitted bundle item (chunk code or asset source). */
export function emittedByteLength(item: {
  type: 'chunk' | 'asset';
  code?: string;
  source?: string | Uint8Array;
}): number {
  if (item.type === 'chunk') return Buffer.byteLength(item.code ?? '', 'utf8');
  const src = item.source ?? '';
  return typeof src === 'string' ? Buffer.byteLength(src, 'utf8') : src.byteLength;
}

export function distAtomicWritesPlugin(): Plugin {
  let outDir = '';
  let assetsDir = 'assets';
  let stashedHtml: Array<{ fileName: string; bytes: Buffer }> = [];
  return {
    name: 'papercusp-dist-atomic-writes',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      assetsDir = config.build.assetsDir || 'assets';
    },
    buildStart() {
      stashedHtml = [];
    },
    // order:'post' on the HOOK (not just the plugin): vite's own `build-html`
    // plugin emits index.html into the bundle from ITS generateBundle, which
    // runs after user plugins' normal-order handlers — without this the html
    // is not in the bundle yet when we look, and vite writes it in place
    // (verified 2026-07-26: same-inode index.html after a build with the
    // plugin active; with order:'post' the inode changes = rename path).
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
      stashedHtml = [];
      for (const [key, item] of Object.entries(bundle)) {
        const { fileName } = item;
        if (fileName.toLowerCase().endsWith('.html')) {
          const bytes =
            item.type === 'chunk'
              ? Buffer.from(item.code, 'utf8')
              : Buffer.from(item.source as string | Uint8Array);
          stashedHtml.push({ fileName, bytes });
          delete bundle[key];
          continue;
        }
        if (!isHashedAssetPath(fileName, assetsDir)) continue;
        const target = join(outDir, fileName);
        let existing: number | null = null;
        try {
          existing = statSync(target).size;
        } catch {
          existing = null;
        }
        if (shouldSkipRewrite(existing, emittedByteLength(item))) {
          delete bundle[key];
          try {
            const now = new Date();
            utimesSync(target, now, now);
          } catch {
            /* best effort — worst case the prune TTL retires it early */
          }
        }
      }
      },
    },
    // writeBundle (not closeBundle): runs only after every remaining asset was
    // written successfully, so index.html never points at chunks that a failed
    // build didn't produce.
    writeBundle() {
      for (const { fileName, bytes } of stashedHtml) {
        const target = join(outDir, fileName);
        try {
          mkdirSync(dirname(target), { recursive: true });
          const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
          writeFileSync(tmp, bytes);
          renameSync(tmp, target);
        } catch (err) {
          // Never lose index.html entirely — fall back to the plain write the
          // build would have done without this plugin.
          try {
            writeFileSync(target, bytes);
          } catch {
            /* surfaced below */
          }
          // eslint-disable-next-line no-console
          console.warn('[dist-atomic-writes] atomic html swap failed, wrote plainly:', err);
        }
      }
      stashedHtml = [];
    },
  };
}
