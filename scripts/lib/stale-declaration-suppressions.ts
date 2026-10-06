/**
 * WI-10005290 — find `@ts-expect-error` suppressions that a published declaration made stale.
 *
 * ## The defect
 *
 * A TypeScript importer of a plain-JS `.mjs` module that has NO declaration file has to
 * suppress TS7016 ("Could not find a declaration file for module"), and the house style is a
 * `// @ts-expect-error -- plain-JS module, no declaration file` directly above the import. Once
 * `gen:declarations` publishes `<module>.d.mts`, that suppression has nothing left to suppress
 * and becomes TS2578 ("Unused '@ts-expect-error' directive"). Nothing in the generator noticed.
 * Measured 2026-10-02: publishing `scripts/lib/fs-mutex.d.mts` and `scripts/npm-install-safe.d.mts`
 * (commit 938e464baf) turned 10 importer sites red, and each surfaced only when somebody next
 * typechecked that importer.
 *
 * ## The rule
 *
 * TypeScript reports TS7016 on the line that holds the module SPECIFIER, and `@ts-expect-error`
 * covers exactly the next line. So a suppression is stale when the line directly above a line
 * whose quoted relative `.mjs` specifier resolves to a declared module is an
 * `// @ts-expect-error` comment. That one rule covers `import … from`, `export … from`, a
 * multi-line import (the specifier line is the one that matters) and a dynamic `import('…')`.
 *
 * `@ts-ignore` is never reported: TypeScript does not check that it is used, so it cannot go
 * stale this way. Bare-package specifiers are out of scope; every enrolled module is a
 * repo-relative script imported by relative path.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** One stale suppression: the importer, the directive's 1-based line, the module it guarded. */
export type StaleSuppression = { file: string; line: number; module: string; directive: string };

const SPECIFIER = /(['"`])(\.{1,2}\/[^'"`\n]+?\.mjs)\1/g;
const EXPECT_ERROR = /^\s*\/\/\s*@ts-expect-error\b/;
/** Files TypeScript can type-check as importers. Declarations themselves import nothing. */
const IMPORTER = /\.(?:[cm]?ts|tsx|[cm]?js)$/;
const DECLARATION = /\.d\.[cm]?ts$/;

/**
 * @param modules repo-relative POSIX paths of modules that now HAVE a declaration
 * @param sources repo-relative POSIX importer path -> file text
 */
export function staleDeclarationSuppressions(
  modules: readonly string[],
  sources: ReadonlyMap<string, string>,
): StaleSuppression[] {
  const declared = new Set(modules.map((module) => posix.normalize(module)));
  const found = new Map<string, StaleSuppression>();
  for (const [file, text] of sources) {
    if (!IMPORTER.test(file) || DECLARATION.test(file)) continue;
    const lines = text.split('\n');
    for (let index = 1; index < lines.length; index += 1) {
      if (!EXPECT_ERROR.test(lines[index - 1])) continue;
      for (const match of lines[index].matchAll(SPECIFIER)) {
        const module = posix.normalize(posix.join(posix.dirname(file), match[2]));
        if (!declared.has(module)) continue;
        // The directive sits on 0-based line index-1, i.e. 1-based line `index`.
        const key = `${file}:${index}`;
        if (!found.has(key)) found.set(key, { file, line: index, module, directive: lines[index - 1].trim() });
      }
    }
  }
  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Read every tracked file that could import one of `modules`, prefiltered by `git grep` on the
 * module basenames so the scan stays cheap on a large tree.
 *
 * Returns `null` when `repoRoot` is not a git checkout (a hermetic test fixture): the caller must
 * treat that as "not measured", never as "no stale suppressions".
 */
export function importerSources(repoRoot: string, modules: readonly string[]): Map<string, string> | null {
  if (modules.length === 0) return new Map();
  const patterns = [...new Set(modules.map((module) => posix.basename(module)))].flatMap((name) => ['-e', name]);
  let listed: string;
  try {
    listed = execFileSync('git', ['-C', repoRoot, 'grep', '-l', '-F', ...patterns, '--', '*.ts', '*.mts', '*.cts', '*.tsx', '*.js', '*.mjs', '*.cjs'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    // git grep exits 1 for "no match" — a real, measured empty result.
    if (status === 1) return new Map();
    return null;
  }
  const sources = new Map<string, string>();
  for (const file of listed.split('\n').filter(Boolean)) {
    if (!IMPORTER.test(file) || DECLARATION.test(file)) continue;
    sources.set(file, readFileSync(join(repoRoot, file), 'utf8'));
  }
  return sources;
}

export function formatStaleSuppressions(problems: readonly StaleSuppression[]): string[] {
  return problems.map(
    (problem) => `${problem.file}:${problem.line}  ${problem.directive}  (guards ${problem.module}, which now has a declaration)`,
  );
}
