import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * _derive-paths — auto-derive `payload.paths` from a work-item's title/summary text
 * when the caller didn't supply any (EI-16028).
 *
 * The scheduler's live self-affinity rank term (`affinity(bee.held_paths,
 * item.paths)` in `scheduler/get-next.ts`) orders a claimable pool by how much a
 * bee's already-open files overlap `payload.paths` — but that field is caller-
 * supplied only, and ~90% of work-items never set it, so the term silently
 * collapses to NEUTRAL for almost the entire pool even though 28+ live claim
 * specs (plus the DEFAULT spec) reference it. Rather than requiring every
 * `work_items:create` caller to remember to pass `payload.paths` explicitly,
 * derive a best-effort candidate set from repo-relative paths already mentioned
 * in the item's own title/summary (the same signal `codeSmellsLikeCode` in
 * `create.ts` already uses to detect "this smells like code work", just
 * extracting the matched paths instead of a boolean).
 *
 * Deliberately NOT wired into `improvements:capture` — that surface's `paths`
 * field also feeds the protected-path classification gate (`classifyImprovement`),
 * a materially different consumer where an over-eager text-derived path could
 * silently change routing/review behavior. This module only feeds the
 * `work_items:create` payload.paths → scheduler-affinity path.
 */

/** Repo-relative path prefixes worth extracting (mirrors `codeSmellsLikeCode`'s net). */
const REPO_PATH_PATTERN = /\b(?:packages|libs|apps|src|scripts|sql)\/[\w./-]+/g;

/** Trailing prose punctuation a path mention commonly picks up ("...in foo/bar.ts.", "(foo/bar.ts)"). */
const TRAILING_PUNCT_RE = /[.,;:'"`)\]]+$/;

export interface DeriveRepoPathsOptions {
  max?: number;
  /**
   * When supplied, only existing paths contained by this repo root are returned.
   * Omitting it preserves the extractor's pure text-only behavior for callers that
   * do not have a tree to validate against.
   */
  repoRoot?: string;
}

/** Injectable filesystem seam for the warn-only explicit-path check. */
export interface ExplicitRepoPathValidationOptions {
  /** The checkout against which repo-relative paths should be judged. */
  repoRoot?: string | null;
  /** Override existence checks in unit tests; filesystem failures stay fail-open. */
  exists?: (absPath: string) => boolean;
}

/** Keep a malformed or adversarial payload from turning create into a tree walk. */
export const MAX_EXPLICIT_REPO_PATHS_PROBED = 60;

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isContainedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Check both lexical containment and the real path of a candidate. The latter
 * closes the symlink variant of the escape: an apparently in-tree path must not
 * resolve to a file outside the repo root.
 */
function isExistingContainedPath(repoRoot: string, candidate: string): boolean {
  const root = realpathOrResolve(repoRoot);
  const resolvedCandidate = resolve(root, candidate);
  if (!isContainedBy(root, resolvedCandidate) || !existsSync(resolvedCandidate)) return false;
  return isContainedBy(root, realpathOrResolve(resolvedCandidate));
}

/**
 * Validate caller-supplied `payload.paths` without changing what gets stored.
 *
 * Explicit paths are an affinity hint, not a create precondition: a caller may be
 * coordinating work in a sibling checkout, naming a deleted file, or passing a glob.
 * We therefore report only cleanly judged, in-tree paths that do not exist. Missing
 * roots, outside-tree paths, globs, malformed entries, and filesystem errors are all
 * treated as "cannot judge" and stay silent. This is deliberately warn-only.
 */
export function validateExplicitRepoPaths(
  paths: readonly unknown[],
  opts: ExplicitRepoPathValidationOptions = {},
): { missing: string[] } | undefined {
  const rawRoot = opts.repoRoot?.trim();
  if (!rawRoot || paths.length === 0) return undefined;

  try {
    const root = realpathOrResolve(rawRoot);
    const exists = opts.exists ?? ((absPath: string) => existsSync(absPath));
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const raw of paths.slice(0, MAX_EXPLICIT_REPO_PATHS_PROBED)) {
      if (typeof raw !== 'string') continue;
      const declared = raw.trim();
      // Globs describe a set of files, not one path whose existence this guard can
      // honestly assert. Keep absolute paths that are inside the selected tree: the
      // caller may have obtained one from a capability result and it is still useful
      // to flag a typo in it.
      if (!declared || declared.includes('*') || declared.includes('?') || seen.has(declared)) continue;
      seen.add(declared);

      let candidate: string;
      try {
        candidate = resolve(root, declared);
      } catch {
        continue;
      }
      if (!isContainedBy(root, candidate)) continue;

      // A symlink can make a lexical in-tree path point outside the checkout. Do not
      // probe or warn about a path the caller may legitimately own elsewhere.
      if (!isContainedBy(root, realpathOrResolve(candidate))) continue;
      try {
        if (!exists(candidate)) missing.push(declared);
      } catch {
        // An fs failure is not evidence of a bad caller path.
      }
    }

    return missing.length > 0 ? { missing } : undefined;
  } catch {
    // The creation must never fail because its advisory filesystem read could not run.
    return undefined;
  }
}

export interface ExplicitRepoPathsWarningContext {
  /** How the repository tree used for the advisory was selected. */
  rootSource?: string;
  /** The concrete tree used for the advisory, when one was selected. */
  root?: string;
}

/** Human-facing, warn-only message for a create that recorded unresolved paths. */
export function explicitRepoPathsWarning(
  missing: readonly string[],
  context: ExplicitRepoPathsWarningContext = {},
): string | undefined {
  if (missing.length === 0) return undefined;
  const noun = missing.length === 1 ? 'path' : 'paths';
  const source = context.rootSource
    ? ` (source: ${context.rootSource}${context.root ? `; root: ${context.root}` : ''})`
    : '';
  return (
    `work_items:create recorded explicit payload.paths ${missing.length} ${noun} that do NOT exist in the ` +
    `selected repository tree${source}: ${missing.join(', ')}. This is an advisory only and does not block creation. ` +
    `If the path was deleted, belongs to a sibling checkout, or is intentionally illustrative, ignore this; ` +
    `otherwise re-read the canonical repository spelling and update the work-item. ` +
    `A common failure is inventing a hyphenated directory when the source uses underscores.`
  );
}

/**
 * Extract a deduped, order-preserving list of repo-relative paths mentioned in
 * `text`. Used at work-item creation time as a fallback ONLY when the caller
 * supplied no explicit `payload.paths`. When `repoRoot` is supplied, guesses are
 * retained only if they exist in that tree and stay inside it.
 */
export function deriveRepoPathsFromText(text: string, opts: DeriveRepoPathsOptions = {}): string[] {
  const max = opts.max ?? 12;
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(REPO_PATH_PATTERN)) {
    let p = m[0].replace(TRAILING_PUNCT_RE, '').replace(/\/+$/, '');
    // Require at least one path separator beyond the prefix dir itself (drop a bare
    // "packages/" match with nothing meaningful after trailing-punct stripping).
    if (!p.includes('/') || p.split('/').some((seg) => seg.length === 0)) continue;
    if (opts.repoRoot && !isExistingContainedPath(opts.repoRoot, p)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
