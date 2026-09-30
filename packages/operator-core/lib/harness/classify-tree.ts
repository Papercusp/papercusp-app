/**
 * classify-tree — implementation of the five-rule classifier from
 * `apps/operator/docs/plans/papercusp-dogfood-v5-2026-05-23.md` §2.
 *
 * Given a harness root, walk its subdirectories and classify each one as:
 *
 *   1. `submodule`  — `.git` is a file pointing to `<parent>/.git/modules/<name>`.
 *                     Becomes a sub-harness node sharing the root's queue.
 *                     Slug is path-qualified: `<parentSlug>/<relPath>`.
 *   2. `worktree`   — `.git` is a file pointing to `<parent>/.git/worktrees/<name>`.
 *                     NOT a new harness; skip.
 *   3. `standalone` — `.git` is a directory (not a file). Nested standalone repo;
 *                     becomes its own top-level harness.
 *   4. `plain`      — no `.git`. Just a code directory, part of the parent repo.
 *
 * Rule 5 (path-qualified slugs) is realized as the `qualifiedSlug` field on
 * `SubmoduleNode`, derived from `<parentSlug>/<relPath>`.
 *
 * Used by Phase 1a P-007 of the dogfood plan; consumed by P-010/P-012
 * (create-harness UI Entries 2/3 — sub-harness registration).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type ClassifiedKind = 'submodule' | 'worktree' | 'standalone' | 'plain';

export interface SubmoduleNode {
  kind: 'submodule';
  /** Path relative to the walk root, with forward slashes (e.g. `libs/sync`). */
  relPath: string;
  absPath: string;
  /** Path inside the parent's `.git/modules/` that the `.git` file pointed to. */
  gitDirTarget: string;
  /** `<parentSlug>/<relPath>` — rule 5. */
  qualifiedSlug: string;
}

export interface WorktreeNode {
  kind: 'worktree';
  relPath: string;
  absPath: string;
  /** Name of the worktree (last segment of the path inside `.git/worktrees/`). */
  worktreeName: string;
  /** Raw path stored in the `.git` file. */
  gitDirTarget: string;
}

export interface StandaloneNode {
  kind: 'standalone';
  relPath: string;
  absPath: string;
}

export interface PlainNode {
  kind: 'plain';
  relPath: string;
  absPath: string;
}

export type ClassifiedNode =
  | SubmoduleNode
  | WorktreeNode
  | StandaloneNode
  | PlainNode;

export interface ClassifyTreeOptions {
  /** Parent harness slug used to build sub-harness qualified slugs. */
  parentSlug: string;
  /** How many directory levels to descend. Default 4. */
  maxDepth?: number;
  /** Directory names to skip while walking. */
  skipDirs?: string[];
  /**
   * If true (default), recurse into submodules looking for sub-sub-harnesses.
   * Worktrees are NEVER recursed into (they would loop back to siblings of
   * the parent repo, which would inflate results without adding signal).
   */
  recurseIntoSubmodules?: boolean;
}

const DEFAULT_SKIP_DIRS = [
  'node_modules',
  '.git',
  '.next',
  '.next-prod',
  'dist',
  'build',
  '.turbo',
  '.cache',
  'coverage',
  '.pnpm-store',
  // EI-19464771433863331: the operator's OWN state directory. It holds
  // GENERATED, gitignored content that can contain real git repos — e.g.
  // `npm run gen:lib-api` materialises package checkouts under
  // `.papercusp/lib-api/<pkg>/_media/<pkg>`, each with its own `.git` +
  // `package.json` + `.papercusp/`, which is precisely the shape this
  // classifier admits as a submodule. Live on 2026-08-03: 3 such artifact
  // paths were registered as `harness_kind: 'sub-harness'`, and each
  // registered sub-harness boots a substrate whose replication-liveness
  // detector files `severity: major` EIs — so the artifact count multiplies
  // every peer-log event (42 EIs from 2 log keys in one hour).
  //
  // Safe to skip by NAME: a legitimate sub-harness's own
  // `.papercusp/config.json` is read by explicit path (see
  // routes/harness/projects.ts registerSubs), never by walking, so nothing
  // that depends on that file goes through here.
  //
  // NB this is a name denylist and cannot know about generated content in
  // general; `.gitignore` is the authoritative answer and would fix the
  // class. See the work-item for why that was not done unilaterally.
  '.papercusp',
];

/** Convert OS-native path separators to forward slashes for stable slugs. */
function normalizeRel(rel: string): string {
  if (sep === '/') return rel;
  return rel.split(sep).join('/');
}

/**
 * Classify a single directory based on its `.git` state.
 *
 * Returns `null` if `absPath` is not a directory at all.
 */
export function classifyDir(
  rootAbsPath: string,
  absPath: string,
  parentSlug: string,
): ClassifiedNode | null {
  let dirStat;
  try {
    dirStat = statSync(absPath);
  } catch {
    return null;
  }
  if (!dirStat.isDirectory()) return null;

  const relPath = normalizeRel(relative(rootAbsPath, absPath));
  const gitPath = join(absPath, '.git');
  const hasGit = existsSync(gitPath);
  if (!hasGit) {
    return { kind: 'plain', relPath, absPath };
  }
  const gitStat = statSync(gitPath);
  if (gitStat.isDirectory()) {
    // Rule 3: standalone repo nested inside.
    return { kind: 'standalone', relPath, absPath };
  }
  if (!gitStat.isFile()) {
    // Unknown (symlink, socket, etc.) — treat as plain rather than throw.
    return { kind: 'plain', relPath, absPath };
  }

  // Rules 1 + 2: parse the .git file.
  const raw = readFileSync(gitPath, 'utf-8');
  const match = raw.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) {
    // Malformed .git file. Conservative: treat as plain.
    return { kind: 'plain', relPath, absPath };
  }
  const target = match[1] ?? '';
  // The path can be relative-to-the-dir or absolute. Use string contains.
  const norm = target.replace(/\\/g, '/');
  if (norm.includes('/.git/modules/')) {
    return {
      kind: 'submodule',
      relPath,
      absPath,
      gitDirTarget: target,
      qualifiedSlug: relPath.length > 0 ? `${parentSlug}/${relPath}` : parentSlug,
    };
  }
  if (norm.includes('/.git/worktrees/')) {
    const worktreeName =
      norm.split('/.git/worktrees/')[1]?.split('/')[0] ?? 'unknown';
    return {
      kind: 'worktree',
      relPath,
      absPath,
      worktreeName,
      gitDirTarget: target,
    };
  }
  // .git file with an unexpected target shape (e.g. bare repo pointer).
  // Conservative: treat as plain (do not register as a new harness).
  return { kind: 'plain', relPath, absPath };
}

/**
 * Walk a harness root and classify every reachable subdirectory.
 *
 * Returns the rootCase classification (always classified) plus one entry per
 * descendant directory that was visited. Walk respects `skipDirs` and stops
 * at `maxDepth`. Worktrees are never descended into; submodules are descended
 * into unless `recurseIntoSubmodules: false`.
 *
 * Does NOT classify the root itself as 'plain'/'standalone' — the root is
 * the harness root and is treated as the implicit starting point. Returned
 * nodes are all *descendants* of the root.
 */
export function walkHarnessTree(
  rootAbsPath: string,
  opts: ClassifyTreeOptions,
): ClassifiedNode[] {
  const maxDepth = opts.maxDepth ?? 4;
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const recurseIntoSubmodules = opts.recurseIntoSubmodules ?? true;
  const out: ClassifiedNode[] = [];

  function walk(absDir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (skipDirs.has(name)) continue;
      const childAbs = join(absDir, name);
      const node = classifyDir(rootAbsPath, childAbs, opts.parentSlug);
      if (!node) continue;
      out.push(node);
      if (node.kind === 'plain') {
        // Recurse into plain dirs to find nested harnesses below.
        walk(childAbs, depth + 1);
      } else if (node.kind === 'submodule' && recurseIntoSubmodules) {
        walk(childAbs, depth + 1);
      }
      // worktree + standalone: do not recurse (would inflate / loop)
    }
  }

  walk(rootAbsPath, 0);
  return out;
}

/**
 * Summarize a classified tree for logging or UI:
 *
 *   {
 *     submodules: 9,
 *     worktrees: 0,
 *     standalone: 0,
 *     plain: 7,
 *     total: 16,
 *   }
 */
export interface ClassifySummary {
  submodules: number;
  worktrees: number;
  standalone: number;
  plain: number;
  total: number;
}

export function summarize(nodes: ClassifiedNode[]): ClassifySummary {
  const s: ClassifySummary = {
    submodules: 0,
    worktrees: 0,
    standalone: 0,
    plain: 0,
    total: nodes.length,
  };
  for (const n of nodes) {
    if (n.kind === 'submodule') s.submodules++;
    else if (n.kind === 'worktree') s.worktrees++;
    else if (n.kind === 'standalone') s.standalone++;
    else if (n.kind === 'plain') s.plain++;
  }
  return s;
}
