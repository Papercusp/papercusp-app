/**
 * The repo's own file census, for guards that must DERIVE their subject
 * population instead of pinning a hand-maintained list
 * (EI-21929043331389136 — "hand-maintained textual guards omit real subjects").
 *
 * Why `git ls-files` and not a directory walk: the tracked set is maintained by
 * the same act that adds the file, so a new subject cannot be forgotten the way
 * a hand-edited array can. It also excludes build scratch, untracked local
 * junk and ignored trees for free, without a second list to keep in sync.
 *
 * Deliberately dependency-free of any particular guard: callers supply the
 * predicate that decides what an offender IS. This module only answers "what
 * files exist to be judged", which is the half every pinned guard was missing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Extensions carrying human-authored or agent-facing text worth judging.
 *
 * `.html` is deliberately ABSENT, and the reason matters because the served
 * docs mirror publishes every page twice. Astro's HTML page and emit-md-twins'
 * Markdown twin are emitted from the same source in the same build, so they
 * cannot drift from each other — only together, from their shared source. The
 * `.md` twin is therefore the covering representative, and it is three orders
 * of magnitude cheaper to scan (measured 2026-08-31: 81 mirror HTML pages alone
 * were 31MB). Scanning both would double the cost to re-measure one fact.
 *
 * That equivalence is a property of the BUILD, not of this list: if the two
 * representations ever stop being generated together, `.html` belongs here.
 */
export const TEXT_EXTENSIONS: readonly string[] = Object.freeze([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.md',
  '.mdx',
]);

/**
 * Paths a text guard should never treat as an authored subject.
 *
 * These are NOT convenience exclusions — each is a surface whose content is
 * machine-written from somewhere else, so a finding here is a report about the
 * generator, not about the file, and pinning it would make legitimate output
 * un-writable:
 *   - `.papercusp/state/**` — operator state artifacts that QUOTE work-item and
 *     report prose verbatim, including historical findings that necessarily
 *     restate the wrong value they were filed about.
 *   - `node_modules/`, `dist/`, `.materialized/` — vendored or built output.
 *
 * The served docs mirror (`apps/operator/public/internal/docs/**`) is
 * deliberately ABSENT: it is build output, but it is also what agents actually
 * READ, and letting it drift unseen is precisely the ten-day `max_agents:3`
 * regression that motivated this module.
 */
export const NON_AUTHORED_PREFIXES: readonly string[] = Object.freeze([
  '.papercusp/state/',
  'node_modules/',
  'dist/',
  '.materialized/',
]);

export interface TrackedTextFileOptions {
  /** Repository root to run `git ls-files` in. */
  root: string;
  /** Include `*.test.ts` / `*.test.tsx`? Default false — fixtures carry violations on purpose. */
  includeTests?: boolean;
  /** Override the extension allowlist. */
  extensions?: readonly string[];
}

const isTestFile = (path: string): boolean => /\.test\.(ts|tsx|js|mjs|cjs)$/.test(path);

const isNonAuthored = (path: string): boolean =>
  NON_AUTHORED_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix) || path.includes(`/${prefix}`));

/**
 * Every tracked text file worth judging, repo-relative, sorted.
 *
 * Throws rather than returning `[]` when git cannot answer: an empty population
 * is the vacuous-pass failure mode a derived guard exists to prevent, so it must
 * never be reachable by accident.
 */
export function trackedTextFiles(options: TrackedTextFileOptions): string[] {
  const extensions = options.extensions ?? TEXT_EXTENSIONS;
  const raw = execFileSync('git', ['ls-files', '-z'], {
    cwd: options.root,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });

  const files = raw
    .split('\0')
    .filter(Boolean)
    .filter((path) => extensions.some((ext) => path.endsWith(ext)))
    .filter((path) => (options.includeTests ? true : !isTestFile(path)))
    .filter((path) => !isNonAuthored(path))
    // WI-10004176: a plain `rm` stays in the index until git-sync commits it — drop those.
    .filter((path) => existsSync(join(options.root, path)))
    .sort();

  if (files.length === 0) {
    throw new Error(
      `trackedTextFiles: git ls-files returned no candidates under ${options.root} — a derived guard cannot judge an empty population`,
    );
  }
  return files;
}

/** Read a tracked file as text; null when it cannot be read (binary, deleted mid-run). */
export function readTrackedText(root: string, relpath: string): string | null {
  try {
    return readFileSync(join(root, relpath), 'utf8');
  } catch {
    return null;
  }
}
