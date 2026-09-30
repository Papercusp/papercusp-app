/**
 * own-log-supersession — which own-log keys has THIS device retired? (WI-10002600)
 *
 * An own-log fork recovery (own-log-fork-recovery.ts) moves the forked
 * Corestore aside and boots a fresh one, which mints a new own-log key. Peers
 * must then be told the old key is dead, or they keep it admitted with no
 * replicator and read the harness as unhealthy for the rest of their process
 * lifetime (boot.ts only had DEVICE-level drop paths).
 *
 * The retired keys are DERIVED from the filesystem rather than stored: the
 * recovery names the moved-aside store `<store>.forked-<64-hex key>-<stamp>`,
 * and boot reads those sibling directories back. No second copy of the fact
 * exists to drift, and an operator who deletes an aside directory also stops
 * announcing its supersession (peers that already retired the key are
 * unaffected; the key is never announced again either way).
 */

import { readdir as fsReaddir } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

const FORKED_MARK = '.forked-';
const ASIDE_SUFFIX = /^([0-9a-f]{64})-(.+)$/;

/** Where a forked store is moved to. Carries the FULL key: the supersession a
 *  device announces is read back from exactly this name. */
export function forkedStoreAsidePath(storePath: string, keyHex: string, stamp: string): string {
  return `${storePath}${FORKED_MARK}${keyHex.toLowerCase()}-${stamp}`;
}

/**
 * The own-log keys retired beside `storePath`, NEWEST first (the stamp is an
 * ISO timestamp with `:`/`.` replaced, so it sorts lexicographically).
 * `entries` are the names inside `dirname(storePath)`. Names that are not a
 * full-key aside directory (the lock file, a legacy 12-hex aside) are ignored.
 */
export function parseSupersededOwnLogKeys(storePath: string, entries: readonly string[]): string[] {
  const prefix = `${basename(storePath)}${FORKED_MARK}`;
  const found: Array<{ key: string; stamp: string }> = [];
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const m = ASIDE_SUFFIX.exec(name.slice(prefix.length));
    if (m) found.push({ key: m[1]!, stamp: m[2]! });
  }
  found.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  const keys: string[] = [];
  for (const { key } of found) if (!keys.includes(key)) keys.push(key);
  return keys;
}

/** Read the retired own-log keys from disk. A missing parent directory is an
 *  empty list (a harness that never recovered from a fork). */
export async function readSupersededOwnLogKeys(
  storePath: string,
  readdir: (dir: string) => Promise<string[]> = (dir) => fsReaddir(dir),
): Promise<string[]> {
  try {
    return parseSupersededOwnLogKeys(storePath, await readdir(dirname(storePath)));
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return [];
    throw err;
  }
}
