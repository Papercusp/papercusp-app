/**
 * Shared allocation primitives for the two `db:next-migration` doors
 * (`scripts/next-migration.mjs` and the `db:next-migration` MCP tool).
 *
 * Dependency-free on purpose — node builtins only, no package imports — so both
 * doors can import it unconditionally and a change here cannot split the lock
 * domain or leave the two doors reading the filesystem differently.
 */
import { readdirSync } from 'node:fs';

/**
 * Workspace-global Postgres advisory-lock key for migration-number allocation.
 *
 * Both allocation doors import this zero-dependency module so a key change
 * cannot split the lock domain and let concurrent callers mint collisions.
 */
export const ALLOC_ADVISORY_KEY = 873_135;

/**
 * Suffixes this repo appends to hide an unfinished migration from the runner
 * (`.DRAFT` per EI-19366138707071397, `.PENDING-CODE-DEPLOY` per migration 727).
 * A file wearing one is still WRITTEN work — it just isn't armed yet — so the
 * scan below records it under its eventual armed name.
 */
const RUNNER_HIDING_SUFFIX = /\.(?:DRAFT|PENDING-CODE-DEPLOY)$/i;

/**
 * @typedef {object} MigrationDirScan
 * @property {number} maxNumber        Highest leading `NNN` seen across the dirs (0 if none).
 * @property {Set<string>} filenames   Every `NNN-slug.sql` present on disk, normalised to its
 *   ARMED name so a `.DRAFT` / `.PENDING-CODE-DEPLOY` file matches the `.sql` filename recorded
 *   in `harness_shared.migration_reservations`.
 * @property {Set<number>} numbers     Every leading number occupied on disk, by ANY file — the
 *   number can be taken by a migration other than the one that reserved it.
 */

/**
 * Read the migration sql dirs ONCE and return every filesystem fact allocation
 * needs, so the two doors share one scan instead of each growing their own.
 *
 * Both doors previously carried a private `maxNumberOnDisk`, which was the only
 * thing either read from disk. `filenames` / `numbers` exist because the number
 * being unique is not the same as the WORK being unique: a reservation whose
 * file was never written is the case `judgeRedundantReservation` cannot see from
 * the ledger alone (EI-20300821494280085).
 *
 * A missing dir is skipped, not thrown — an uninitialised submodule or a release
 * checkout without the sidecar mirror is normal, and refusing to allocate over it
 * would wedge the one chokepoint every migration passes through.
 *
 * @param {Iterable<string>} dirs
 * @returns {MigrationDirScan}
 */
export function scanMigrationDirs(dirs) {
  let maxNumber = 0;
  /** @type {Set<string>} */
  const filenames = new Set();
  /** @type {Set<number>} */
  const numbers = new Set();
  for (const dir of dirs ?? []) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const m = /^(\d+)-/.exec(entry);
      if (!m) continue;
      const num = Number.parseInt(m[1], 10);
      if (!Number.isFinite(num)) continue;
      numbers.add(num);
      if (num > maxNumber) maxNumber = num;
      filenames.add(entry.replace(RUNNER_HIDING_SUFFIX, ''));
    }
  }
  return { maxNumber, filenames, numbers };
}
