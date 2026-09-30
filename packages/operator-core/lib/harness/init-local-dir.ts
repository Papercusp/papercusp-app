/**
 * Initialize a new local directory for the create-harness "Entry 1"
 * flow (papercusp-dogfood-v5 Phase 1a P-010, Entry 1 of §3).
 *
 * Flow:
 *   1. Validate `parentDir` exists + is writable.
 *   2. Validate `folderName` is not path-traversal-shaped.
 *   3. `mkdir <parentDir>/<folderName>` (errors if it already exists
 *      as a non-directory).
 *   4. `git init` in the new dir (shell-less via execFile).
 *   5. Return the absolute path.
 *
 * Idempotent: if `<parentDir>/<folderName>` already exists with a
 * `.git/` subdirectory, the function returns the path unchanged
 * without re-running `git init` (which would be a safe no-op anyway,
 * but skipping the subprocess is faster + clearer).
 *
 * Security: `git init` is invoked via `execFile` (shell-less,
 * argv-quoted). The folderName is validated against a strict regex
 * (alphanum + hyphen + underscore + dot, no leading dot, no slashes,
 * no `..`). The parentDir is resolved to an absolute path; we don't
 * normalize away `..` because a parent dir of `/home/x/../y` is the
 * caller's call (it's their filesystem). What we *do* check is that
 * the join doesn't traverse: `resolve(parentDir, folderName)` must
 * have `parentDir` as a prefix.
 *
 * No new deps. Pure node:fs + node:child_process.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Strict folder-name rule:
 *   - 1-100 chars
 *   - alphanum, hyphen, underscore, dot
 *   - cannot start with dot (no hidden dirs by default)
 *   - cannot contain slash, backslash, or `..`
 *   - cannot be `.` or `..`
 */
const FOLDER_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

export interface InitLocalDirInput {
  parentDir: string;
  folderName: string;
}

export interface InitLocalDirResult {
  path: string;
  /**
   * Whether `git init` was actually invoked. False on idempotent re-init
   * (the dir already had a .git/).
   */
  initialized: boolean;
}

export type InitLocalDirErrorCode =
  | 'invalid_path'
  | 'parent_missing'
  | 'dest_exists'
  | 'git_missing'
  | 'unknown';

export class InitLocalDirError extends Error {
  code: InitLocalDirErrorCode;
  detail?: string;
  constructor(code: InitLocalDirErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'InitLocalDirError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Validate a folder name in isolation. Exported for the route layer
 * to give a clear error before the full flow runs.
 */
export function isValidFolderName(name: string): boolean {
  if (!name || typeof name !== 'string') return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.startsWith('.')) return false;
  return FOLDER_NAME_RE.test(name);
}

/**
 * Validate a `(parentDir, folderName)` pair resolves to a path
 * strictly inside parentDir. Exported for testing.
 */
export function isPathInside(parentDir: string, folderName: string): boolean {
  if (!isValidFolderName(folderName)) return false;
  const parentAbs = resolve(parentDir);
  const candidateAbs = resolve(parentAbs, folderName);
  const parentWithSep = parentAbs.endsWith(sep) ? parentAbs : parentAbs + sep;
  return candidateAbs.startsWith(parentWithSep);
}

/**
 * Initialize a new local dir + run `git init`. Returns the absolute
 * path on success. Idempotent — second call with the same input
 * returns `{ path, initialized: false }` instead of erroring.
 */
export async function initLocalHarnessDir(
  input: InitLocalDirInput,
): Promise<InitLocalDirResult> {
  const { parentDir, folderName } = input;

  if (!isValidFolderName(folderName)) {
    throw new InitLocalDirError(
      'invalid_path',
      'Folder name is invalid: must be alphanumeric (with -._), 1-100 chars, no leading dot, no slashes.',
      folderName,
    );
  }
  if (!isPathInside(parentDir, folderName)) {
    throw new InitLocalDirError(
      'invalid_path',
      'Resolved path would escape parentDir.',
      parentDir + ' / ' + folderName,
    );
  }

  const parentAbs = resolve(parentDir);
  if (!existsSync(parentAbs)) {
    throw new InitLocalDirError(
      'parent_missing',
      'Parent directory does not exist: ' + parentAbs,
      parentAbs,
    );
  }
  const parentStat = statSync(parentAbs);
  if (!parentStat.isDirectory()) {
    throw new InitLocalDirError(
      'parent_missing',
      'Parent path exists but is not a directory: ' + parentAbs,
      parentAbs,
    );
  }

  const destAbs = join(parentAbs, folderName);

  // Idempotent: dir already exists with a .git/ → no-op success.
  if (existsSync(destAbs)) {
    const destStat = statSync(destAbs);
    if (!destStat.isDirectory()) {
      throw new InitLocalDirError(
        'dest_exists',
        'Destination path exists but is not a directory: ' + destAbs,
        destAbs,
      );
    }
    const gitDir = join(destAbs, '.git');
    if (existsSync(gitDir)) {
      return { path: destAbs, initialized: false };
    }
    // Dir exists but no .git/ — fall through to git init in-place.
  } else {
    try {
      await mkdir(destAbs, { recursive: false });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        throw new InitLocalDirError(
          'dest_exists',
          'Destination already exists: ' + destAbs,
          destAbs,
        );
      }
      throw new InitLocalDirError(
        'unknown',
        'mkdir failed: ' + (err as Error).message,
        destAbs,
      );
    }
  }

  try {
    await execFileP('git', ['-C', destAbs, 'init', '--quiet'], {
      timeout: 10_000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|command not found/i.test(msg)) {
      throw new InitLocalDirError(
        'git_missing',
        'git binary not found in PATH; install git or restore PATH.',
        msg,
      );
    }
    throw new InitLocalDirError(
      'unknown',
      'git init failed: ' + msg,
      destAbs,
    );
  }

  return { path: destAbs, initialized: true };
}
