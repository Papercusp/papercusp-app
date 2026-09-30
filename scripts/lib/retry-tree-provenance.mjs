/**
 * Provenance for the one-shot retry in `scripts/affected-tests.mjs`.
 *
 * A passing retry is only evidence of a flake when both attempts observed the
 * same candidate tree. `HEAD` alone is insufficient on the shared checkout:
 * git-sync and peer agents can edit tracked files, add files, delete files, or
 * change modes without a commit between the two child processes.
 *
 * The snapshot deliberately hashes only the working-tree paths that git says
 * are dirty or untracked. Clean tracked content is represented by HEAD, so a
 * full-repository content hash is unnecessary and would make every retry pay
 * for the whole monorepo. Every read is fail-closed: a race or unreadable git
 * state produces an UNKNOWN comparison rather than a FLAKE.
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

export const RETRY_TREE_PROVENANCE_TOKEN = 'AFFECTED_TESTS_RETRY_PROVENANCE';

/** @typedef {'flake'|'tree-changed'|'provenance-unknown'} RetryProvenanceClass */

function gitBytes(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function asBuffer(value) {
  if (value == null) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
}

/**
 * Parse `git status --porcelain=v1 -z` without relying on quoted filenames.
 * Rename/copy records carry a second NUL-delimited path; retain both names so
 * a rename cannot look unchanged merely because only its destination was read.
 *
 * @param {Buffer|string|null} raw
 * @returns {Array<{status:string,path:string}>|null}
 */
export function parseRetryTreeStatus(raw) {
  const bytes = asBuffer(raw);
  if (bytes == null) return null;
  const tokens = bytes.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== ' ') return null;
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (!path) return null;
    entries.push({ status, path });
    if (status.includes('R') || status.includes('C')) {
      const oldPath = tokens[++index];
      if (!oldPath) return null;
      entries.push({ status: `${status}:source`, path: oldPath });
    }
  }
  return entries;
}

function modeOf(stat) {
  return (stat.mode & 0o7777).toString(8);
}

/**
 * True when `path` is the root of a git repository — a submodule (whose `.git`
 * is a gitdir FILE) or an embedded repository (whose `.git` is a directory).
 * Git status reports such a path as ONE entry, so it reaches the fingerprint
 * as a directory.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isRepositoryRoot(path) {
  try {
    lstatSync(resolve(path, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Fingerprint one changed working-tree path.
 *
 * A dirty submodule or embedded repository is fingerprinted through its OWN
 * git state: its HEAD plus a recursive `snapshotRetryTree` of its own status.
 * That applies the same rule as the superproject — clean content is
 * represented by HEAD and ignored content is not part of the candidate — and
 * never walks the directory. Walking it (EI-24662228809776827) hashed every
 * ignored build artifact under the submodule: 24,911 files / 13 GB for
 * `papercusp-desktop` on the shared tree, 81 s per snapshot, which timed out
 * both the real-repository snapshot test and every `test:affected` start.
 *
 * Only a non-repository directory is still walked. Git's
 * `--untracked-files=all` output expands ordinary untracked directories into
 * files before this function is called, so that fallback is rare.
 *
 * @param {string} path
 * @param {{ git: (root:string,args:string[]) => Buffer|string|null, stack?: Set<string> }} options
 * @returns {string|null}
 */
function fingerprintPath(path, { git, stack = new Set() }) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    // A deletion is an observable state, not an unreadable snapshot. The
    // status line identifies the path; this sentinel records its absence.
    return 'missing';
  }
  if (stat.isSymbolicLink()) {
    try {
      return `symlink:${modeOf(stat)}:${readlinkSync(path)}`;
    } catch {
      return null;
    }
  }
  if (stat.isFile()) {
    try {
      return `file:${modeOf(stat)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    } catch {
      return null;
    }
  }
  if (!stat.isDirectory()) return `other:${modeOf(stat)}:${stat.size}`;
  if (stack.has(path)) return null;
  if (isRepositoryRoot(path)) {
    stack.add(path);
    try {
      const nested = snapshotRetryTree(path, { git, stack });
      // Fail closed: an unreadable nested repository makes the whole snapshot
      // unknown rather than silently dropping its content from the digest.
      if (!nested.known) return null;
      return `repository:${modeOf(stat)}:${nested.head}:${nested.digest}`;
    } finally {
      stack.delete(path);
    }
  }
  stack.add(path);
  try {
    const children = readdirSync(path, { withFileTypes: true, encoding: 'utf8' })
      .filter((entry) => entry.name !== '.git')
      .sort((a, b) => a.name.localeCompare(b.name));
    const digest = createHash('sha256');
    digest.update(`directory:${modeOf(stat)}\0`);
    for (const child of children) {
      const childPath = resolve(path, child.name);
      const childFingerprint = fingerprintPath(childPath, { git, stack });
      if (childFingerprint == null) return null;
      digest.update(child.name);
      digest.update('\0');
      digest.update(childFingerprint);
      digest.update('\0');
    }
    return `directory:${modeOf(stat)}:${digest.digest('hex')}`;
  } catch {
    return null;
  } finally {
    stack.delete(path);
  }
}

function pathInsideRoot(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  return rel && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)
    ? absolute
    : null;
}

function unknownSnapshot(reason, head = null) {
  return {
    known: false,
    head,
    digest: null,
    changedPaths: [],
    reason,
  };
}

/**
 * Capture the candidate tree relevant to retry provenance.
 *
 * @param {string} root repository root
 * @param {{ git?: (root:string,args:string[]) => Buffer|string|null, stack?: Set<string> }} [options]
 *   `stack` is internal: the repository roots already being snapshotted, so a
 *   nested-repository recursion cannot cycle.
 */
export function snapshotRetryTree(root, { git = gitBytes, stack = new Set() } = {}) {
  const headBytes = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = asBuffer(headBytes)?.toString('utf8').trim() || null;
  if (!head) return unknownSnapshot('head-unreadable');

  const statusBytes = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  const entries = parseRetryTreeStatus(statusBytes);
  if (entries == null) return unknownSnapshot('status-unreadable', head);

  const digest = createHash('sha256');
  // Include the raw status bytes so index-only transitions (e.g. staged vs
  // unstaged content with identical work-tree bytes) remain distinguishable.
  digest.update(asBuffer(statusBytes) ?? Buffer.alloc(0));
  const fingerprints = [];
  for (const entry of [...entries].sort((a, b) =>
    `${a.path}\0${a.status}`.localeCompare(`${b.path}\0${b.status}`),
  )) {
    const path = pathInsideRoot(root, entry.path);
    if (!path) return unknownSnapshot('status-path-unreadable', head);
    const fingerprint = fingerprintPath(path, { git, stack });
    if (fingerprint == null) return unknownSnapshot('working-tree-unreadable', head);
    fingerprints.push({ status: entry.status, path: entry.path, fingerprint });
    digest.update(`${entry.status}\0${entry.path}\0${fingerprint}\0`);
  }
  return {
    known: true,
    head,
    digest: digest.digest('hex'),
    changedPaths: fingerprints.map(({ path }) => path),
    reason: null,
  };
}

function usableSnapshot(snapshot) {
  return (
    snapshot?.known === true &&
    typeof snapshot.head === 'string' &&
    snapshot.head.length > 0 &&
    typeof snapshot.digest === 'string' &&
    snapshot.digest.length > 0
  );
}

/**
 * Compare the two snapshots that bracket a retry. This is deliberately pure
 * so the safety decision is testable without launching a multi-minute suite.
 *
 * @param {ReturnType<typeof snapshotRetryTree>|null} before
 * @param {ReturnType<typeof snapshotRetryTree>|null} retryStart
 * @returns {{classification: RetryProvenanceClass, reason: string}}
 */
export function classifyRetryTreeProvenance(before, retryStart) {
  if (!usableSnapshot(before) || !usableSnapshot(retryStart)) {
    return { classification: 'provenance-unknown', reason: 'snapshot-unreadable' };
  }
  if (before.head !== retryStart.head) {
    return { classification: 'tree-changed', reason: 'head-changed' };
  }
  if (before.digest !== retryStart.digest) {
    return { classification: 'tree-changed', reason: 'working-tree-changed' };
  }
  return { classification: 'flake', reason: 'tree-stable' };
}

/**
 * Stable, greppable disclosure for retry decisions. It is intentionally not
 * part of `AFFECTED_TESTS_RESULT`; this is attribution, not the verdict.
 */
export function formatRetryTreeProvenanceNotice({ workspace, classification, reason } = {}) {
  const safeClass = ['flake', 'tree-changed', 'provenance-unknown'].includes(classification)
    ? classification
    : 'provenance-unknown';
  const safeReason = String(reason || 'unknown');
  return (
    `${RETRY_TREE_PROVENANCE_TOKEN} workspace=${JSON.stringify(String(workspace ?? 'unknown'))} ` +
    `classification=${safeClass} reason=${safeReason}`
  );
}
