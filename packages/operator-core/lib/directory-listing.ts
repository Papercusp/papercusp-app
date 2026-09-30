/**
 * Directory listing with UTC timestamps and explicit symlink disclosure.
 *
 * Plan `bash-substitution-reachable-ceiling-2026-08-01`, P-012 / D-068. The census
 * re-run on 2026-09-05 measured `ls` at 2,879 atoms across 662 sessions — 85% of the
 * ENTIRE genuine `needs-tool` population, and the only bucket in it with fleet-wide
 * reach. No directory-listing tool existed in the capability:* family.
 *
 * WHY THIS EXISTS, given D-058 measured bash->tool substitution as token-INFLATING:
 * the case is correctness, not tokens.
 *
 *   1. UTC BY CONSTRUCTION. `ls -l`/`stat` render in the host's LOCAL zone (-04:00
 *      here) while every papercusp timestamp is UTC. CLAUDE.md documents the result:
 *      differencing the two "invents a phantom 4h gap that reads as STALE". ~100
 *      corpus atoms already pass `--time-style` by hand to work around it. `mtimeUtc`
 *      is an ISO-8601 Z string with no formatting knob, so the trap is unreachable.
 *
 *   2. SYMLINKS ARE DISCLOSED, NOT SILENTLY FOLLOWED OR SKIPPED. CLAUDE.md documents
 *      bare `find` omitting symlinked sibling hives — output that "looked complete".
 *      Every entry carries its link target and what the target actually is, including
 *      `broken`, so a symlinked directory can never be invisible in a listing.
 *
 *   3. A BOUNDED LISTING CANNOT BE READ AS A COMPLETE ONE. `total` counts what the
 *      directory holds and `truncated` says the rows were cut, so the `| head` class
 *      of false negatives — where an absence is manufactured by the bound — is
 *      visible in the result rather than inferred from its length.
 *
 *   4. AN EMPTY LISTING MEANS EMPTY. A missing path, a non-directory, and a
 *      permission denial each throw a typed error instead of returning `[]`, so the
 *      one reading that is never available is the false absence.
 */

import { readdirSync, lstatSync, statSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Default row cap. Large enough for a repo directory, small enough to bound output. */
export const DIRECTORY_LISTING_DEFAULT_LIMIT = 200;

export type EntryType = 'file' | 'dir' | 'symlink' | 'other';

/** What a symlink's target turned out to be. `broken` means it resolves to nothing. */
export type SymlinkTarget = 'file' | 'dir' | 'broken';

export interface DirectoryEntry {
  name: string;
  /** The entry's OWN type (lstat): a symlink is `symlink`, never its target's type. */
  type: EntryType;
  /** Size in bytes; null when the entry could not be stat'd. */
  bytes: number | null;
  /** Modification time as ISO-8601 UTC (always `Z`). Null when unreadable. */
  mtimeUtc: string | null;
  /** Raw link text for a symlink, else null. */
  symlinkTarget: string | null;
  /** What the link resolves to, else null. `broken` is a real, reportable answer. */
  symlinkResolvesTo: SymlinkTarget | null;
  /** Why this row's metadata is null, when it is. Null means the stat succeeded. */
  statUnreadable: string | null;
}

export interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  /** Rows returned. */
  matched: number;
  /** Entries the directory holds after filtering, BEFORE `limit` was applied. */
  total: number;
  /** True when `limit` cut rows — so a short list is never mistaken for a complete one. */
  truncated: boolean;
  /** Dot-entries excluded because `all` was not set. */
  hiddenExcluded: number;
  /** Entries that are symlinks pointing at a directory — the `find` blind spot. */
  symlinkedDirs: number;
}

export type DirectoryListingErrorCode =
  | 'not_found'
  | 'not_a_directory'
  | 'permission_denied'
  | 'unreadable';

export class DirectoryListingError extends Error {
  readonly code: DirectoryListingErrorCode;
  constructor(code: DirectoryListingErrorCode, message: string) {
    super(message);
    this.name = 'DirectoryListingError';
    this.code = code;
  }
}

export interface ListDirectoryOptions {
  path: string;
  /** Include dot-entries (the `ls -a` shape). Default false. */
  all?: boolean;
  /** Max rows. Default DIRECTORY_LISTING_DEFAULT_LIMIT. */
  limit?: number;
  /** `name` (default) or `mtime` (newest first — the `ls -t` shape). */
  sort?: 'name' | 'mtime';
  /** Case-insensitive substring filter on the entry name. */
  contains?: string;
}

function classify(st: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): EntryType {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

function errnoOf(e: unknown): string | null {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * List one directory.
 *
 * @throws DirectoryListingError when the path is missing, is not a directory, or
 *   cannot be read. It never degrades those into an empty listing, because an empty
 *   array and a failed read are the two readings that must not be confusable.
 */
export function listDirectory(options: ListDirectoryOptions): DirectoryListing {
  const { path, all = false, sort = 'name', contains } = options;
  const limit =
    options.limit === undefined ? DIRECTORY_LISTING_DEFAULT_LIMIT : Math.max(1, Math.floor(options.limit));

  let names: string[];
  try {
    // lstat first: a symlink TO a directory is listable, but readdirSync on a
    // non-directory must not be reported as "empty".
    const st = statSync(path);
    if (!st.isDirectory()) {
      throw new DirectoryListingError('not_a_directory', `${path} exists but is not a directory.`);
    }
    names = readdirSync(path);
  } catch (e) {
    if (e instanceof DirectoryListingError) throw e;
    const code = errnoOf(e);
    if (code === 'ENOENT') throw new DirectoryListingError('not_found', `${path} does not exist.`);
    if (code === 'ENOTDIR') {
      throw new DirectoryListingError('not_a_directory', `${path} exists but is not a directory.`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DirectoryListingError('permission_denied', `${path} is not readable by this user.`);
    }
    throw new DirectoryListingError('unreadable', `${path} could not be read: ${String(e)}`);
  }

  let hiddenExcluded = 0;
  const kept: string[] = [];
  for (const name of names) {
    if (!all && name.startsWith('.')) {
      hiddenExcluded += 1;
      continue;
    }
    if (contains && !name.toLowerCase().includes(contains.toLowerCase())) continue;
    kept.push(name);
  }

  const rows: DirectoryEntry[] = kept.map((name) => {
    const abs = join(path, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch (e) {
      return {
        name,
        type: 'other',
        bytes: null,
        mtimeUtc: null,
        symlinkTarget: null,
        symlinkResolvesTo: null,
        statUnreadable: errnoOf(e) ?? String(e),
      };
    }

    const type = classify(st);
    let symlinkTarget: string | null = null;
    let symlinkResolvesTo: SymlinkTarget | null = null;
    if (type === 'symlink') {
      try {
        symlinkTarget = readlinkSync(abs);
      } catch {
        symlinkTarget = null;
      }
      try {
        const target = statSync(abs); // follows the link
        symlinkResolvesTo = target.isDirectory() ? 'dir' : 'file';
      } catch {
        symlinkResolvesTo = 'broken';
      }
    }

    return {
      name,
      type,
      bytes: st.size,
      // toISOString() is UTC by construction — the whole point (see header note 1).
      mtimeUtc: st.mtime.toISOString(),
      symlinkTarget,
      symlinkResolvesTo,
      statUnreadable: null,
    };
  });

  rows.sort((a, b) => {
    if (sort === 'mtime') {
      // Newest first; rows with an unreadable mtime sort last rather than winning.
      if (a.mtimeUtc === b.mtimeUtc) return a.name.localeCompare(b.name);
      if (a.mtimeUtc === null) return 1;
      if (b.mtimeUtc === null) return -1;
      return a.mtimeUtc < b.mtimeUtc ? 1 : -1;
    }
    return a.name.localeCompare(b.name);
  });

  const total = rows.length;
  const entries = rows.slice(0, limit);

  return {
    path,
    entries,
    matched: entries.length,
    total,
    truncated: total > entries.length,
    hiddenExcluded,
    symlinkedDirs: rows.filter((r) => r.symlinkResolvesTo === 'dir').length,
  };
}
