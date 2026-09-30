/**
 * testing-domain-glob.ts — minimal dependency-free glob walker for the
 * /api/admin/testing/domains/:id route (P-003).
 *
 * We deliberately don't pull in `fast-glob` / `globby` / `minimatch` to
 * avoid touching `apps/operator/package.json` (another agent commonly
 * holds it during edits). The patterns we need are simple and bounded:
 *
 *   path/literal.test.ts
 *   path/*.test.ts
 *   path/**\/*.test.ts
 *   path/[brace,alt]*.test.ts   (single-level brace expansion)
 *   path/!(except)/**           (negation — NOT supported, error out)
 *
 * Walks under a workspace-relative root, finds files matching each glob,
 * returns {path, sizeBytes, mtimeMs} per file. Implementation:
 *   1. Split the pattern into a literal prefix (everything before the
 *      first metachar) and a remainder regex.
 *   2. Walk fs.readdir recursively from the prefix.
 *   3. Test each file against the remainder regex.
 *
 * Skips node_modules, .git, dist, .next, .turbo, .pnpm at the directory
 * level — never recurse into them.
 */

import { readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  '.svelte-kit',
  '.cache',
]);

export interface FileHit {
  path: string;        // workspace-relative, POSIX
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Throw on brace alternation or extglob (`!()`, `?()`, `@()`) — we don't
 * support them and silently mis-matching would be worse than a clear
 * error at registry-walk time.
 */
function assertSupportedPattern(pat: string): void {
  if (/[!?@+]\(/.test(pat)) {
    throw new Error(`testing-domain-glob: unsupported extglob in "${pat}"`);
  }
  if (pat.includes('{') || pat.includes('}')) {
    throw new Error(`testing-domain-glob: brace alternation not supported in "${pat}"`);
  }
}

/**
 * Split a glob into [literalPrefix, remainder]. The literal prefix is
 * the longest leading subpath that contains no glob metachars; the
 * walker starts here. Remainder is the regex-eligible suffix.
 */
export function splitPrefix(pattern: string): [string, string] {
  // Find first metachar.
  const meta = pattern.search(/[*?[]/);
  if (meta < 0) return [pattern, ''];
  // Back up to the previous path boundary.
  const cut = pattern.lastIndexOf('/', meta);
  if (cut < 0) return ['', pattern];
  return [pattern.slice(0, cut), pattern.slice(cut + 1)];
}

/**
 * Convert a glob remainder (after splitPrefix) to a RegExp anchored to
 * match a path RELATIVE to the prefix dir.
 *
 *   *           → [^/]*
 *   **          → .*
 *   ?           → [^/]
 *   .           → \.
 *   /           → /
 *   anything    → literal
 */
export function remainderToRegex(rem: string): RegExp {
  assertSupportedPattern(rem);
  let out = '^';
  for (let i = 0; i < rem.length; i++) {
    const c = rem[i];
    if (c === '*') {
      if (rem[i + 1] === '*') {
        out += '.*';
        i++;
        if (rem[i + 1] === '/') i++; // consume the `/` after `**/`
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (/[.+^$()|\\[\]]/.test(c)) {
      // Escape regex metachars — INCLUDING `[` and `]` so literal
      // Next.js dynamic-route dirs (`app/users/github/[id]/...`) match
      // as literals instead of being mis-read as a regex char class.
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  out += '$';
  return new RegExp(out);
}

/**
 * Recursively list files under `dir`. Returns paths relative to `dir`
 * with POSIX separators. Skips IGNORE_DIRS at the directory level so
 * we never walk into them.
 */
async function walk(dir: string): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const sub = await walk(join(dir, e.name));
      for (const s of sub) out.push(posix.join(e.name, s));
    } else if (e.isFile()) {
      out.push(e.name);
    }
  }
  return out;
}

/**
 * Resolve all hits for a single glob, anchored at `workspaceRoot`.
 */
export async function expandGlob(
  workspaceRoot: string,
  pattern: string,
): Promise<FileHit[]> {
  assertSupportedPattern(pattern);
  const [prefix, remainder] = splitPrefix(pattern);
  const start = prefix ? join(workspaceRoot, prefix) : workspaceRoot;

  // No remainder = a literal file path.
  if (!remainder) {
    try {
      const s = await stat(start);
      if (!s.isFile()) return [];
      return [
        {
          path: prefix,
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
        },
      ];
    } catch {
      return [];
    }
  }

  const re = remainderToRegex(remainder);
  const rels = await walk(start);
  const hits: FileHit[] = [];
  for (const rel of rels) {
    if (!re.test(rel)) continue;
    const full = join(start, rel);
    try {
      const s = await stat(full);
      hits.push({
        path: prefix ? posix.join(prefix, rel) : rel,
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      });
    } catch {
      // race with concurrent fs change; skip.
    }
  }
  return hits;
}

/**
 * Resolve a list of globs, dedupe hits by path, sort by path ascending.
 */
export async function expandGlobs(
  workspaceRoot: string,
  patterns: string[],
): Promise<FileHit[]> {
  const seen = new Map<string, FileHit>();
  for (const pat of patterns) {
    const hits = await expandGlob(workspaceRoot, pat);
    for (const h of hits) {
      if (!seen.has(h.path)) seen.set(h.path, h);
    }
  }
  return Array.from(seen.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

/**
 * Resolve the workspace root from any path inside the repo. Walks up from
 * `from` and stops at the FIRST ancestor carrying a root marker — either a
 * `pnpm-workspace.yaml` (workspace marker) or a `.git` (repo marker). The
 * Hono host runs with cwd=apps/operator, so trusting `process.cwd()` would
 * land us two levels down from the root and miss every repo-relative glob.
 *
 * NEAREST MARKER WINS (EI-18771273773696439). This used to be two full
 * walks: `pnpm-workspace.yaml` all the way to `/` first, and only then a
 * second walk for `.git`. So a stray `pnpm-workspace.yaml` ANYWHERE above
 * the repo outranked the repo's own `.git` one level up. One walk checking
 * both markers per level is the least-surprising rule and is identical for
 * the ordinary cases (a git repo, a pnpm monorepo whose root carries both).
 *
 * Memoized PER START PATH, never globally (EI-18771273773696439). A single
 * shared operator process serves callers rooted in DIFFERENT trees — the
 * staging checkout and the release checkout — so a process-wide memo let
 * the first caller's root leak to every later caller regardless of the
 * `from` they passed, silently answering about the wrong tree. That is the
 * defect class this function sat at the bottom of; a parameter the function
 * ignores after the first call is not a cache, it is a bug.
 */
const _rootCache = new Map<string, string>();

/**
 * A `.git` entry is not always a repository root marker. Submodules carry a
 * `.git` FILE whose gitdir points into `.git/modules`; stopping there makes
 * every path reported relative to the submodule instead of the superproject.
 * Linked worktrees also carry a `.git` FILE, but their gitdir points into
 * `.git/worktrees` and the worktree itself is a valid root.
 */
function isGitRootMarker(dir: string): boolean {
  try {
    const entry = statSync(join(dir, '.git'));
    if (entry.isDirectory()) return true;
    if (!entry.isFile()) return false;

    const marker = readFileSync(join(dir, '.git'), 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/i.exec(marker);
    if (!match) return false;
    const gitdir = match[1].trim().replace(/\\/g, '/');
    return gitdir.includes('/worktrees/');
  } catch {
    return false;
  }
}

export function inferWorkspaceRoot(from = process.cwd()): string {
  const start = resolve(from);
  const cached = _rootCache.get(start);
  if (cached !== undefined) return cached;

  let dir = start;
  while (true) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) || isGitRootMarker(dir)) {
      _rootCache.set(start, dir);
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _rootCache.set(start, start);
  return start;
}

/** INTERNAL — test-only. Reset the cached workspace roots. */
export function _resetWorkspaceRootCache(): void {
  _rootCache.clear();
}

const VITEST_CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
];

/**
 * Find the nearest `vitest.config.*` walking UP from the directory containing
 * `filePath` (workspace-relative) towards (and including) `workspaceRoot`.
 * Returns `null` when none exists anywhere in that chain (there is no
 * root-level vitest.config.ts in this repo — CLAUDE.md EI-7666).
 *
 * EI-8902: a bare `npx vitest run <file>` invocation with no `--config` runs
 * with ZERO Vite config whenever no root-level config exists — any `@/`-
 * aliased import then false-fails with "Failed to resolve import ... Does the
 * file exist?" even though the file and code are both correct, and (since
 * each app aliases `@/*` to a DIFFERENT directory) a single shared root
 * config can't fix this either — the config must be resolved PER FILE. This
 * generated a whole class of false-positive watchdog red-test signals (every
 * apps/operator-vite test importing via `@/`) before the invocation-vs-code
 * distinction was diagnosed (EI-8883/EI-8902). Any spawn site that runs
 * vitest per-file (not via `npm run test:affected`, which already resolves
 * per-app config) should pass `--config` with this function's result.
 */
export function resolveNearestVitestConfig(filePath: string, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot);
  let dir = dirname(resolve(root, filePath));
  while (true) {
    for (const name of VITEST_CONFIG_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    if (dir === root) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
