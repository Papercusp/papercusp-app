#!/usr/bin/env node
/**
 * Copy the host's pgvector extension into the embedded-postgres binaries that
 * `npm ci` installs under node_modules/@embedded-postgres/<platform>/native.
 *
 * Why: the zonky embedded-postgres binaries ship no extensions beyond the
 * contrib set, but the schema declares `vector(N)` columns (e.g. migration
 * 349-code-recipes.sql). A fresh clone that ran only `npm ci` therefore boots
 * its embedded database and then fails the first migration that needs vector:
 * `type "vector" does not exist`. Release builds already copy pgvector into
 * the bundled sidecar (papercusp-desktop/bin/build-desktop-sidecar.sh); this
 * does the same for a development checkout, so the documented from-source
 * path works on a clean machine (open-source-release-2026-09-29 P-008).
 *
 * Runs from the root postinstall. It never fails the install when pgvector is
 * missing on the host: it prints the install command instead, because the
 * typecheck-only CI legs have no database at all. Pass --strict (or set
 * PAPERCUSP_EMBEDDED_PGVECTOR_STRICT=1) to make a missing source an error.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

/** Postgres major of an embedded-postgres package version such as "18.3.0-beta.17". */
export function embeddedPgMajor(version) {
  const match = /^(\d+)\./.exec(String(version ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Where an embedded-postgres native tree expects extension files. Two layouts
 * exist (mirrors build-desktop-sidecar.sh): a flat one (lib/, share/extension)
 * and the Debian-style one (lib/postgresql, share/postgresql/extension).
 */
export function runtimeDirs(nativeDir) {
  if (existsSync(join(nativeDir, 'lib', 'pgcrypto.so')) && existsSync(join(nativeDir, 'share', 'extension'))) {
    return { libDir: join(nativeDir, 'lib'), extDir: join(nativeDir, 'share', 'extension') };
  }
  return {
    libDir: join(nativeDir, 'lib', 'postgresql'),
    extDir: join(nativeDir, 'share', 'postgresql', 'extension'),
  };
}

/** Candidate host locations of pgvector built for Postgres `major`, in preference order. */
export function hostPgvectorCandidates({ platform, major, env = process.env }) {
  const candidates = [];
  if (env.PAPERCUSP_PGVECTOR_LIB && env.PAPERCUSP_PGVECTOR_EXT_DIR) {
    candidates.push({ lib: env.PAPERCUSP_PGVECTOR_LIB, extDir: env.PAPERCUSP_PGVECTOR_EXT_DIR });
  }
  if (platform === 'linux') {
    candidates.push({
      lib: `/usr/lib/postgresql/${major}/lib/vector.so`,
      extDir: `/usr/share/postgresql/${major}/extension`,
    });
  } else if (platform === 'darwin') {
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      candidates.push({
        lib: `${prefix}/lib/postgresql@${major}/vector.dylib`,
        extDir: `${prefix}/share/postgresql@${major}/extension`,
      });
      candidates.push({
        lib: `${prefix}/lib/postgresql/vector.dylib`,
        extDir: `${prefix}/share/postgresql@${major}/extension`,
      });
    }
  }
  return candidates;
}

export function installHint(platform, major) {
  if (platform === 'linux') {
    return `sudo apt install postgresql-${major}-pgvector   (Debian/Ubuntu, from the PostgreSQL apt repository at https://wiki.postgresql.org/wiki/Apt)`;
  }
  if (platform === 'darwin') return `brew install pgvector   (built against postgresql@${major})`;
  return 'no automated pgvector source for this platform; embedding features fall back to in-memory';
}

function nativeTrees(root) {
  const base = join(root, 'node_modules', '@embedded-postgres');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((name) => ({ name, pkgDir: join(base, name), nativeDir: join(base, name, 'native') }))
    .filter((tree) => existsSync(tree.nativeDir));
}

/**
 * Provision pgvector into every embedded-postgres native tree under `root`.
 * Returns a structured report; performs no process exit.
 */
export function installEmbeddedPgvector({ root = process.cwd(), platform = process.platform, env = process.env, log = console.log } = {}) {
  const report = { trees: [], missingSource: [] };
  for (const tree of nativeTrees(root)) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(tree.pkgDir, 'package.json'), 'utf8')).version;
    } catch {
      /* unreadable package.json: major stays null */
    }
    const major = embeddedPgMajor(version);
    const { libDir, extDir } = runtimeDirs(tree.nativeDir);
    const libExt = platform === 'darwin' ? 'dylib' : 'so';
    if (existsSync(join(extDir, 'vector.control')) && existsSync(join(libDir, `vector.${libExt}`))) {
      report.trees.push({ tree: tree.name, status: 'present' });
      continue;
    }
    if (major === null) {
      report.trees.push({ tree: tree.name, status: 'unknown-version' });
      continue;
    }
    const source = hostPgvectorCandidates({ platform, major, env }).find(
      (candidate) => existsSync(candidate.lib) && existsSync(join(candidate.extDir, 'vector.control')),
    );
    if (!source) {
      report.trees.push({ tree: tree.name, status: 'missing-source', major });
      report.missingSource.push({ tree: tree.name, major, hint: installHint(platform, major) });
      continue;
    }
    mkdirSync(libDir, { recursive: true });
    mkdirSync(extDir, { recursive: true });
    copyFileSync(source.lib, join(libDir, `vector.${libExt}`));
    let sqlFiles = 0;
    for (const file of readdirSync(source.extDir)) {
      if (file === 'vector.control' || (file.startsWith('vector') && file.endsWith('.sql'))) {
        copyFileSync(join(source.extDir, file), join(extDir, file));
        if (file.endsWith('.sql')) sqlFiles += 1;
      }
    }
    report.trees.push({ tree: tree.name, status: 'installed', major, from: source.lib, sqlFiles });
    log(`embedded-pgvector: installed pgvector for PG ${major} into @embedded-postgres/${tree.name} from ${source.lib}`);
  }
  return report;
}

function main() {
  const strict = process.argv.includes('--strict') || process.env.PAPERCUSP_EMBEDDED_PGVECTOR_STRICT === '1';
  const report = installEmbeddedPgvector();
  for (const miss of report.missingSource) {
    console.warn(
      `embedded-pgvector: WARNING — pgvector for PostgreSQL ${miss.major} not found on this machine, so @embedded-postgres/${miss.tree} cannot create the "vector" extension and a fresh database will fail its migrations.\n` +
        `  Install it, then re-run: node scripts/install-embedded-pgvector.mjs\n  ${miss.hint}`,
    );
  }
  if (strict && report.missingSource.length > 0) process.exitCode = 1;
}

if (isCliEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`embedded-pgvector: setup failed: ${error instanceof Error ? error.message : String(error)}`);
    if (process.argv.includes('--strict')) process.exitCode = 1;
  }
}
