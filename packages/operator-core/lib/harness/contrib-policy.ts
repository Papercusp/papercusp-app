/**
 * contrib-policy — P-CONTRIB contribution rules on the fork→PR boundary
 * (plan `shared-hive-owner-enforcement-2026-06-19`, Phase EN-4 fast-follow).
 *
 * The CODE plane is already owner-controlled: a non-collaborator never
 * direct-pushes `main`; their work becomes a cross-fork PR (`open-fork-pr.ts`)
 * and the owner's GitHub PR-merge gate is the real authority over what lands.
 * P-CONTRIB lets the claimed owner SET that gate's rules as enforceable policy:
 *
 *   - `editablePaths`  — an allowlist of paths a contributor may touch. A fork-PR
 *                        whose changed files fall OUTSIDE every pattern is
 *                        REJECTED at open time (the strongest teeth — the change
 *                        never reaches a PR). Absent/empty ⇒ no path restriction.
 *   - `requireReview`  — a fork-PR may not auto-merge without a human review.
 *   - `requiredStatusChecks` — named checks that must be green before auto-merge.
 *   - `restrictAutoMerge`    — disallow auto-merge entirely (owner merges by hand).
 *
 * This module is a PURE decider (policy + PR facts → verdict). The fork-PR
 * handler (`fork-pr-on-feature-pass.ts`) consults it: the path verdict gates
 * OPENING the PR; the auto-merge verdict is threaded onto the result for any
 * downstream auto-merge step to honor. Auto-merge is NOT performed in-system
 * today (the owner merges on GitHub), so `restrictAutoMerge`/`requireReview`
 * are advisory-but-recorded until an in-system auto-merge path exists — stated
 * honestly here so no over-claim (Brief G discipline).
 */

/**
 * The typed P-CONTRIB view over EN-1's opaque `policy.contrib` field
 * (`hive-policy-schema.ts` keeps `contrib?: Record<string, unknown>` so older
 * peers round-trip it; EN-4 narrows it here). Pass `policy.contrib as ContribPolicy`
 * — every field is optional + defensively checked, so a malformed value degrades to
 * "no rule", never throws.
 */
export interface ContribPolicy {
  /** Require a human review before a fork-PR may auto-merge. */
  requireReview?: boolean;
  /** Status-check contexts that must be green before auto-merge. */
  requiredStatusChecks?: string[];
  /** Disallow auto-merge entirely (owner merges manually). */
  restrictAutoMerge?: boolean;
  /**
   * Editable-path allowlist (gitignore-style globs). A fork-PR whose changed
   * files fall OUTSIDE every pattern is rejected. Empty/absent ⇒ no restriction.
   */
  editablePaths?: string[];
}

export interface ContribCheckInput {
  /** Repo-relative paths the fork-PR's branch changes (vs the base branch). */
  changedFiles: string[];
}

export interface ContribDecision {
  /** True iff every changed file is within the editable-path allowlist (or no
   *  allowlist is set). When false the fork-PR must NOT be opened. */
  pathsAllowed: boolean;
  /** The changed files that fell outside the allowlist (empty when pathsAllowed). */
  deniedPaths: string[];
  /** True iff the contribution rules permit AUTO-merging this PR without owner
   *  action. False when `requireReview`, `restrictAutoMerge`, or any
   *  `requiredStatusChecks` is set (those demand owner/CI gating first). */
  autoMergeAllowed: boolean;
  /** Human-readable rule ids that blocked auto-merge (for surfacing). */
  autoMergeBlockedBy: string[];
}

/**
 * Match a single repo-relative path against ONE gitignore-style glob.
 * Supported: `**` (any depth incl. `/`), `*` (within a segment, no `/`), `?`
 * (single non-`/` char), a trailing `/` (the directory and everything under it),
 * and a bare directory prefix (`dir` matches `dir/...`). Anchored full-match.
 */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length === 0) return false;
  // A trailing-slash pattern (or a bare dir prefix) matches the dir + its subtree.
  if (pattern.endsWith('/')) {
    const dir = pattern.slice(0, -1);
    return path === dir || path.startsWith(`${dir}/`);
  }
  // No glob metachars: exact file OR directory-prefix match (so `src` covers
  // `src/a.ts`, matching gitignore intuition) — but a partial segment like `sr`
  // must NOT match `src` (hence the `/` boundary).
  if (!/[*?]/.test(pattern)) {
    return path === pattern || path.startsWith(`${pattern}/`);
  }
  // Build an anchored regex. Escape regex specials, then expand the glob tokens.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — any chars including `/`. Consume an optional following `/` so
        // `a/**/b` and `a/**` both behave (the `**/` form spans zero+ segments).
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*'; // `*` — within a path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  try {
    return new RegExp(`^${re}$`).test(path);
  } catch {
    return false;
  }
}

/** Does `path` match ANY of the allowlist patterns? */
export function matchesAnyGlob(patterns: string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}

/**
 * The P-CONTRIB verdict for a fork-PR. Pure; no I/O. A null/absent contrib policy
 * ⇒ fully permissive (paths allowed, auto-merge allowed) — byte-identical to the
 * pre-EN-4 fork-PR flow.
 */
export function checkContribPolicy(
  contrib: ContribPolicy | null | undefined,
  input: ContribCheckInput,
): ContribDecision {
  if (!contrib) {
    return { pathsAllowed: true, deniedPaths: [], autoMergeAllowed: true, autoMergeBlockedBy: [] };
  }

  // Editable-path allowlist: every changed file must match at least one pattern.
  let pathsAllowed = true;
  let deniedPaths: string[] = [];
  const allow = contrib.editablePaths;
  if (Array.isArray(allow) && allow.length > 0) {
    deniedPaths = input.changedFiles.filter((f) => !matchesAnyGlob(allow, f));
    pathsAllowed = deniedPaths.length === 0;
  }

  // Auto-merge gate.
  const autoMergeBlockedBy: string[] = [];
  if (contrib.restrictAutoMerge === true) autoMergeBlockedBy.push('restrictAutoMerge');
  if (contrib.requireReview === true) autoMergeBlockedBy.push('requireReview');
  if (Array.isArray(contrib.requiredStatusChecks) && contrib.requiredStatusChecks.length > 0) {
    autoMergeBlockedBy.push('requiredStatusChecks');
  }

  return {
    pathsAllowed,
    deniedPaths,
    autoMergeAllowed: autoMergeBlockedBy.length === 0,
    autoMergeBlockedBy,
  };
}
