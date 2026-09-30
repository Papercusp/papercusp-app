/**
 * Repo-relative POSIX path validation + canonicalization for the
 * SU-locks substrate (file-locking #1).
 *
 * Extracted from su-lock-store.ts so the rules live in one named
 * module (file-locking #2 follow-up). This is the **server-side
 * source of truth** for what a lock path may look like.
 *
 * NOTE on the OMP hook: `scripts/hooks/omp/coord-hook.ts` ships as a
 * single self-contained file copied into `~/.omp/agent/extensions/`,
 * so it CANNOT import this module at runtime. It deliberately mirrors
 * these rules in its own `extractPathsFromToolInput`; the consistency
 * is asserted by a test in `coord-hook.test.ts`. If you change the
 * rules here, update the hook to match.
 *
 * Canonical form: repo-relative, POSIX forward slashes, no leading
 * `./`, no `//`, no trailing `/`, no `..` segments, no backslashes,
 * no absolute paths, no NUL bytes.
 */

export class InvalidPathError extends Error {
  constructor(p: string, reason: string) {
    super(`InvalidPathError: ${reason}: ${p}`);
    this.name = 'InvalidPathError';
  }
}

export const MAX_PATH_LEN = 4096;

/**
 * Reject a raw (pre-canonicalization) path that isn't a legal
 * repo-relative POSIX file path. Throws `InvalidPathError`.
 */
export function validatePath(p: string): void {
  if (!p || p === '') throw new InvalidPathError(p, 'empty');
  if (p.startsWith('/')) throw new InvalidPathError(p, 'absolute');
  if (p === '..' || p.startsWith('../') || p.endsWith('/..') || p.includes('/../')) {
    throw new InvalidPathError(p, 'traversal');
  }
  // POSIX forward slashes only — a backslash is either a Windows path
  // separator (wrong repo-relative form) or a literal in a filename we
  // refuse to reason about. Reject rather than guess (file-locking #1).
  if (p.includes('\\')) throw new InvalidPathError(p, 'backslash');
  if (p.length > MAX_PATH_LEN) throw new InvalidPathError(p, 'too long');
  // PG's text type rejects NULL bytes; catch them client-side so the
  // caller gets a clean InvalidPathError instead of a raw
  // PostgresError on insert (bug #15).
  if (p.includes('\0')) throw new InvalidPathError(p, 'null byte');
}

/**
 * Canonicalize a path to the repo-relative POSIX form the lock key
 * hashes on (file-locking #1). Splitting on '/' and dropping empty +
 * '.' segments collapses every accepted non-canonical spelling —
 * `./apps/foo`, `apps//foo`, `apps/./foo`, `apps/foo/` — onto one
 * string, so two agents naming the same file the same way always
 * contend. '..' segments are NOT dropped: they survive so the raw-path
 * validatePath check rejects them.
 *
 * Canonicalization runs AFTER validatePath, on the already-validated
 * raw path — so it can never rewrite an absolute path into a relative
 * one and thereby slip past the absolute-path rejection.
 */
export function canonicalizePath(p: string): string {
  return p
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/**
 * Validate + canonicalize + sort + dedupe a path set. Throws
 * `InvalidPathError` on the first malformed path. The sort is for
 * FIFO determinism and stable indexing; the dedupe collapses paths
 * that were distinct strings but canonicalize to the same key.
 */
export function normalizePaths(paths: string[]): string[] {
  // Validate the RAW path first — absolute / '..' / backslash / null
  // byte must be caught before canonicalization could mask them.
  for (const p of paths) validatePath(p);
  const canon = paths.map((p, i) => {
    const c = canonicalizePath(p);
    // A path that canonicalizes to nothing ('.', './', '/') was never
    // a real repo-relative file path.
    if (c === '') throw new InvalidPathError(paths[i], 'empty after canonicalization');
    return c;
  });
  return Array.from(new Set(canon)).sort();
}
