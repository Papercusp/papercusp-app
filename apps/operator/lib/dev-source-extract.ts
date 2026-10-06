import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';

/**
 * First-boot extraction of the bundled runnable dev/local source tree (WI-3308,
 * plan env-switcher-packaged-all-platforms-2026-07-06 seam 2).
 *
 * The "all-5-buttons" dogfood bundle ships the runnable monorepo as a single
 * compressed resource `sidecar/source.tar.zst` (staged by
 * papercusp-desktop/bin/stage-source-tree.sh). Rust (main.rs seam 1) passes its
 * path as PAPERCUSP_SOURCE_ARCHIVE + a writable target as PAPERCUSP_DEV_SOURCE_DIR
 * (`<shared_state_dir>/dev-source`, distro-local ext4 on Windows). On first boot
 * we extract it there, then set PAPERCUSP_DEV_SOURCE_ROOT — which the launcher's
 * defaultDetectSourceRoot prefers (env-operator-launcher.ts, seam 3, b0fbf) so
 * the dev(:3270)/local(:3055) env operators run from THIS tree with the bundled
 * node's own tsx/vite. We deliberately do NOT touch PAPERCUSP_INTEGRATION_ROOT on
 * the primary operator (the install IS the release; repointing its prompt/tool
 * resolution at a staging tree would be wrong) — the source tree is confined to
 * the dev/local children via PAPERCUSP_DEV_SOURCE_ROOT.
 *
 * zstd is decoded with node's built-in zlib.createZstdDecompress (present on the
 * bundled node v24.15.0; verified decoding the real --long=27 archive) and
 * un-tarred with tar-fs (preserves the node_modules/.bin symlinks the toolchain
 * needs). Both are injectable so the unit test never depends on the host node's
 * zstd support.
 */

/** Markers that identify a runnable papercup tree — mirror detectPapercupRoot
 *  (register-papercusp.ts) so a half-extracted tree is treated as "not ready". */
export function hasPapercupMarkers(root: string): boolean {
  return (
    existsSync(join(root, 'apps', 'operator', 'package.json')) &&
    existsSync(join(root, 'libs', 'papercusp', 'package.json'))
  );
}

export interface ExtractDevSourceDeps {
  /** zstd decompress transform factory (default: node zlib createZstdDecompress). */
  makeDecompress?: () => NodeJS.ReadWriteStream;
  /** tar extract sink factory for a dir (default: tar-fs extract). */
  makeExtract?: (dir: string) => Writable;
  log?: (m: string) => void;
}

/** Minimal shape of the tar-fs entry header the `ignore` predicate needs. */
interface TarLinkHeader {
  type?: string;
  linkname?: string;
}

/**
 * tar-fs `ignore` predicate that SKIPS symlink/hardlink entries whose target
 * escapes the extraction root, instead of letting tar-fs abort the whole stream
 * on the first one (tar-fs index.js:264 `'<name> is not a valid symlink'` — its
 * inCwd() path-traversal guard). The monorepo's node_modules can carry dev-box-
 * local out-of-tree links (a `file:../ExternalProj` dep npm-links into
 * node_modules, e.g. `storewolf-libs -> ../../Storewolf-Libs`) that can NEVER
 * resolve on an install and that nothing in the app imports; without this, one
 * such link aborted the entire 11.75GB first-boot extract, so dev/local fell
 * back to 'no-source-tree' (WI-3308). We mirror tar-fs's own inCwd() check so we
 * skip EXACTLY the entries it would have rejected — every in-tree link (the
 * node_modules/.bin/* + @papercusp/* workspace links the toolchain needs) is
 * kept. Generic by construction: any future stray out-of-tree link is skipped
 * too, not just the known Storewolf ones.
 */
export function escapingLinkIgnore(
  dir: string,
  onSkip?: (name: string, linkname: string) => void,
): (name: string, header?: TarLinkHeader) => boolean {
  const root = resolve(dir);
  return (name: string, header?: TarLinkHeader): boolean => {
    const type = header?.type;
    if (type !== 'symlink' && type !== 'link') return false;
    const linkname = header?.linkname ?? '';
    // symlink target is relative to the link's own directory (tar-fs:263);
    // hardlink target is joined from the extraction root (tar-fs:273).
    const dst =
      type === 'symlink'
        ? resolve(dirname(name), linkname)
        : resolve(root, linkname);
    const inside = dst === root || dst.startsWith(root + sep);
    if (!inside) {
      onSkip?.(name, linkname);
      return true;
    }
    return false;
  };
}

export interface ExtractDevSourceOpts extends ExtractDevSourceDeps {
  /** Bundled source.tar.zst path (PAPERCUSP_SOURCE_ARCHIVE). undefined ⇒ no-op. */
  archivePath: string | undefined;
  /** Writable extract target (PAPERCUSP_DEV_SOURCE_DIR). Its root becomes the tree. */
  targetDir: string | undefined;
}

/**
 * Identity stamp of the bundled archive an extracted tree came from (WI-5052 /
 * WI-4070 class). Written into the tree root after a successful extract; a tree
 * whose stamp no longer matches the shipped `source.tar.zst` (app was updated)
 * is RE-EXTRACTED instead of reused forever — the "reuse forever" behavior let
 * an operator run week-old code against a DB the newer bundle had already
 * migrated (hives→pots rename), killing federation with nothing but scattered
 * `relation does not exist` errors. Size+mtime is deliberately cheap (no hash
 * of a multi-GB archive on every boot); the installer rewrites the archive on
 * update so both change together.
 */
export const SOURCE_ARCHIVE_STAMP_BASENAME = '.papercusp-source-archive.json';

interface ArchiveStamp {
  size: number;
  mtimeMs: number;
}

async function readArchiveStamp(
  stampPath: string,
): Promise<ArchiveStamp | null> {
  try {
    const parsed = JSON.parse(
      await readFile(stampPath, 'utf8'),
    ) as Partial<ArchiveStamp>;
    if (
      typeof parsed.size === 'number' &&
      Number.isFinite(parsed.size) &&
      parsed.size >= 0 &&
      typeof parsed.mtimeMs === 'number' &&
      Number.isFinite(parsed.mtimeMs) &&
      parsed.mtimeMs >= 0
    ) {
      return { size: parsed.size, mtimeMs: parsed.mtimeMs };
    }
  } catch {
    /* missing or corrupt stamp → treated as unstamped (legacy tree) */
  }
  return null;
}

/**
 * Extract the dev-source tree when a bundle is present and the target either
 * isn't populated yet or came from a DIFFERENT bundle (stamp mismatch — see
 * SOURCE_ARCHIVE_STAMP_BASENAME above; an unstamped pre-WI-5052 tree counts as
 * stale and is upgraded once). A Server-only REINSTALL of the SAME bundle keeps
 * the tree (stamp matches — WI-3244 no-wipe runbook still holds). NEVER throws:
 * on any failure it restores/returns what it safely can (the previous tree on a
 * failed upgrade, null on a failed first extract) and dev/local degrade exactly
 * as before this feature. Returns the tree root on success (the caller sets
 * PAPERCUSP_DEV_SOURCE_ROOT to it) or null when there's nothing to run from.
 */
export async function extractDevSourceTree(
  opts: ExtractDevSourceOpts,
): Promise<string | null> {
  if (!opts.archivePath || !opts.targetDir) return null;
  // Source extraction precedes the operator/DB. Reuse the existing filesystem
  // mutex so concurrent sidecars cannot classify a live extract as abandoned.
  const key = createHash('sha256')
    .update(resolve(opts.targetDir))
    .digest('hex');
  try {
    return await withFsMutex(
      `dev-source-${key}`,
      () => extractDevSourceTreeLocked(opts),
      {
        timeoutMs: 1_000,
        staleMs: 24 * 60 * 60_000,
        onWaiting: () =>
          opts.log?.(
            '[dev-source] another sidecar owns source extraction; dev/local wait for its completed tree',
          ),
      },
    );
  } catch (error) {
    opts.log?.(
      `[dev-source] source extraction unavailable (non-fatal): ${(error as Error)?.message ?? error}`,
    );
    return null;
  }
}

async function extractDevSourceTreeLocked(
  opts: ExtractDevSourceOpts,
): Promise<string | null> {
  const { archivePath, targetDir, log = () => {} } = opts;
  if (!archivePath || !targetDir) return null;
  const archiveStat = await stat(archivePath).catch(() => null);
  if (!archiveStat) {
    log(
      `[dev-source] no bundle at ${archivePath} — dev/local run from source only on a source-bundled build`,
    );
    return null;
  }
  const wanted: ArchiveStamp = {
    size: archiveStat.size,
    mtimeMs: Math.floor(archiveStat.mtimeMs),
  };
  const stampPath = join(targetDir, SOURCE_ARCHIVE_STAMP_BASENAME);

  // A source checkout is never a disposable extraction cache, with or without
  // orphan backups or a completion stamp. .git may be a directory or a gitfile.
  if (existsSync(join(targetDir, '.git'))) {
    log(
      `[dev-source] source checkout at ${targetDir} needs manual upgrade; preserving its work`,
    );
    return hasPapercupMarkers(targetDir) ? targetDir : null;
  }

  // A killed upgrade can leave the old tree renamed and the new tree only
  // partly unpacked. Markers alone are insufficient: they can be early tar
  // entries. Only a final archive stamp identifies a completed rollback tree.
  const prefix = `${basename(targetDir)}.stale-`;
  const entries = await readdir(dirname(targetDir), {
    withFileTypes: true,
  }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const abandoned = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(prefix) &&
        /^\d+$/.test(entry.name.slice(prefix.length)),
    )
    .map((entry) => join(dirname(targetDir), entry.name))
    .filter((path) => !existsSync(join(path, '.git')))
    .sort(
      (a, b) =>
        Number(b.slice(b.lastIndexOf('.stale-') + 7)) -
        Number(a.slice(a.lastIndexOf('.stale-') + 7)),
    );
  const cleanup = async (path: string): Promise<void> => {
    await rm(path, { recursive: true, force: true }).catch((error) => {
      log(
        `[dev-source] cache cleanup failed; startup will retry: ${path} — ${(error as Error)?.message ?? error}`,
      );
    });
  };
  if (abandoned.length) {
    const completed =
      hasPapercupMarkers(targetDir) && (await readArchiveStamp(stampPath));
    if (!completed) {
      let rollback: string | undefined;
      for (const path of abandoned) {
        if (
          hasPapercupMarkers(path) &&
          (await readArchiveStamp(join(path, SOURCE_ARCHIVE_STAMP_BASENAME)))
        ) {
          rollback = path;
          break;
        }
      }
      await rm(targetDir, { recursive: true, force: true });
      if (rollback) {
        await rename(rollback, targetDir);
        log(
          `[dev-source] recovered completed tree from interrupted upgrade: ${rollback}`,
        );
      } else {
        log(
          '[dev-source] interrupted upgrade has no completed rollback tree; discarding incomplete caches before retry',
        );
      }
    }
    for (const path of abandoned) await cleanup(path);
  }

  const doExtract = async (label: string): Promise<string | null> => {
    let completed = false;
    try {
      await mkdir(targetDir, { recursive: true });
      const makeDecompress = opts.makeDecompress ?? (await defaultDecompress());
      const makeExtract = opts.makeExtract ?? (await defaultExtract(log));
      // ETA derived from the REAL archive size, not a constant. The old hardcoded "~2 min"
      // was ~15x optimistic on a slow disk (measured ~2.9MB/s on mac-vm, ~30min for a 5.3G
      // tree), so a healthy extract looked like a hang and argued for re-cutting a good
      // bundle. Observed throughput spans ~3MB/s (loaded VM) to ~40MB/s (warm SSD) — quote
      // the BAND and say what is unavailable meanwhile (EI-19442842364710969).
      const archiveMB = Math.max(1, Math.round(archiveStat.size / 1_048_576));
      const etaFastMin = Math.max(1, Math.round(archiveMB / 40 / 60));
      const etaSlowMin = Math.max(
        etaFastMin + 1,
        Math.round(archiveMB / 3 / 60),
      );
      log(
        `[dev-source] extracting ${archivePath} → ${targetDir} (${label}; ${archiveMB}MB compressed, ` +
          `~${etaFastMin}-${etaSlowMin} min depending on disk — dev/local stay absent until it completes)`,
      );
      await pipeline(
        createReadStream(archivePath),
        makeDecompress(),
        makeExtract(targetDir),
      );
      if (!hasPapercupMarkers(targetDir)) {
        log(
          `[dev-source] extract finished but markers missing at ${targetDir} — treating as failed (dev/local skip)`,
        );
        return null;
      }
      await writeFile(stampPath, JSON.stringify(wanted), 'utf8');
      completed = true;
      log(`[dev-source] tree extracted → ${targetDir}`);
      return targetDir;
    } catch (e) {
      log(
        `[dev-source] extract failed (non-fatal; dev/local skip): ${(e as Error)?.message ?? e}`,
      );
      return null;
    } finally {
      if (!completed) await cleanup(targetDir);
    }
  };

  if (!hasPapercupMarkers(targetDir)) return doExtract('first boot');

  const current = await readArchiveStamp(stampPath);
  if (
    current &&
    current.size === wanted.size &&
    current.mtimeMs === wanted.mtimeMs
  ) {
    log(
      `[dev-source] tree already present at ${targetDir} (stamp matches bundle; reusing)`,
    );
    return targetDir;
  }

  // Stale tree: it was extracted from an older bundle (or predates stamping).
  // Move it aside, extract fresh, and only then drop the old tree — a failed
  // extract (e.g. ENOSPC with the .stale copy still held) restores the previous
  // tree so dev/local keep whatever worked before, with a LOUD log.
  log(
    `[dev-source] tree at ${targetDir} came from a ${
      current ? 'different' : 'pre-stamp (legacy)'
    } bundle — re-extracting the shipped source (WI-5052 stale-tree upgrade)`,
  );
  const staleDir = `${targetDir}.stale-${Date.now()}`;
  try {
    await rename(targetDir, staleDir);
  } catch (e) {
    log(
      `[dev-source] LOUD: could not move the stale tree aside (${(e as Error)?.message ?? e}) — REUSING the OUTDATED tree at ${targetDir}; dev/local run week-old code until this is resolved`,
    );
    return targetDir;
  }
  const extracted = await doExtract('stale-tree upgrade');
  if (extracted) {
    await cleanup(staleDir);
    return extracted;
  }
  // Fresh extract failed — restore the previous tree rather than leaving nothing.
  await rm(targetDir, { recursive: true, force: true }).catch(() => {});
  try {
    await rename(staleDir, targetDir);
    log(
      `[dev-source] LOUD: upgrade extract FAILED — restored the previous (OUTDATED) tree at ${targetDir}; dev/local run stale code until the next successful upgrade`,
    );
    return hasPapercupMarkers(targetDir) ? targetDir : null;
  } catch (e) {
    log(
      `[dev-source] upgrade extract failed AND restore failed (${(e as Error)?.message ?? e}) — dev/local skip 'no-source-tree'`,
    );
    return null;
  }
}

async function defaultDecompress(): Promise<() => NodeJS.ReadWriteStream> {
  const zlib = await import('node:zlib');
  const make = (
    zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream }
  ).createZstdDecompress;
  if (typeof make !== 'function') {
    throw new Error(
      'node zlib lacks createZstdDecompress (needs node ≥22.15/24) — the bundled runtime has it',
    );
  }
  return () => make();
}

type TarfsExtract = (
  dir: string,
  opts?: { ignore?: (name: string, header?: TarLinkHeader) => boolean },
) => Writable;

async function defaultExtract(
  log: (m: string) => void,
): Promise<(dir: string) => Writable> {
  const tarfs = (await import('tar-fs')) as unknown as {
    extract?: TarfsExtract;
    default?: { extract?: TarfsExtract };
  };
  const extract = tarfs.extract ?? tarfs.default?.extract;
  if (typeof extract !== 'function')
    throw new Error('tar-fs extract unavailable');
  return (dir: string) =>
    extract(dir, {
      ignore: escapingLinkIgnore(dir, (name, linkname) =>
        log(
          `[dev-source] skipping out-of-tree link ${name} → ${linkname} (unportable; omitted)`,
        ),
      ),
    });
}
