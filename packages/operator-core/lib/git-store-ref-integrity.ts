/**
 * Git-store ref/log integrity — the pure half of the WI-39371 recurrence guard.
 *
 * Git treats EVERY regular file under a store's `refs/` as a ref and every file
 * under `logs/` as a reflog. Write anything else there and the repo silently
 * becomes unclonable: `git clone` dies with "'refs/remotes/origin/…' has a null
 * OID" and `git fsck` reports "invalid sha1 pointer 0000…". That is not
 * hypothetical here — on 2026-08-15 an ad-hoc pre-push-guard install wrote its
 * 754-byte hook SCRIPT to `<gitdir>/refs/hooks/pre-push` and
 * `<gitdir>/logs/hooks/pre-push` in 16 module stores, and the breakage was only
 * found because it blocked a submodule clone the release gate needed.
 *
 * The invariant is about CONTENT, not filenames: a branch legitimately named
 * `hooks/pre-push` would live at `refs/heads/hooks/pre-push` holding a real sha,
 * so a path-shaped rule would false-positive on it while missing every other way
 * to corrupt a ref.
 */

/** A loose ref holds a bare object id: SHA-1 (40 hex) or SHA-256 (64 hex). */
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A symbolic ref holds `ref: <path>` — e.g. `.git/HEAD` → `ref: refs/heads/staging`. */
const SYMBOLIC_REF = /^ref:\s+\S+/;

export type GitStoreFileKind = 'ref' | 'log';

/**
 * Classify one file's content. `contentHead` may be a PREFIX of the file, in
 * which case pass `truncated: true`.
 *
 * ⚠ `truncated` is load-bearing, not a nicety: a byte-bounded read cuts the last
 * line mid-sha, and validating that stump reports healthy reflogs as corrupt.
 * Caught pre-landing on `logs/HEAD` files just over the read cap — a false
 * positive here reds the release gate for the whole fleet.
 */
export function isValidGitStoreFile(
  kind: GitStoreFileKind,
  contentHead: string,
  opts: { truncated?: boolean } = {},
): boolean {
  if (kind === 'ref') {
    // A ref is a single short line, so a truncated head can only be over-long
    // junk — which is correctly invalid either way.
    const trimmed = contentHead.trim();
    // An EMPTY ref file is precisely the "null OID" corruption, never a valid ref.
    if (!trimmed) return false;
    return OBJECT_ID.test(trimmed) || SYMBOLIC_REF.test(trimmed);
  }
  // A reflog may legitimately be empty; every line it DOES have starts with the
  // old object id: `<old> <new> <who> <when>\t<msg>`. That old id is all-zeroes
  // for the entry that creates a ref, which is valid hex and valid here.
  const lines = contentHead.split('\n');
  if (opts.truncated) lines.pop(); // the final line is a fragment, not evidence
  return lines
    .filter((line) => line.trim())
    .every((line) => OBJECT_ID.test(line.split(' ')[0] ?? ''));
}

/**
 * Which invariant a path inside a git store is subject to, or `null` if none.
 * `logs/refs/…` is a reflog, not a ref, so `log` is tested BEFORE `ref`.
 */
export function gitStoreFileKind(pathInsideStore: string): GitStoreFileKind | null {
  const p = pathInsideStore.replaceAll('\\', '/');
  if (/(^|\/)logs\//.test(p)) return 'log';
  if (/(^|\/)refs\//.test(p)) return 'ref';
  return null;
}
