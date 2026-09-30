/**
 * Export-parity between a HAND-WRITTEN `.d.mts` and the `.mjs` it describes
 * (EI-20805816236289594).
 *
 * `scripts/gen-declarations.ts --check` byte-compares the declarations it
 * GENERATES against a fresh emit. That says nothing about a declaration nobody
 * registered: it is never generated, never compared, and never reported. The check
 * printed "51 declaration file(s) up to date" — the 51 registered — while 18
 * hand-written declarations sat beside them unpoliced, one of them
 * (`scripts/lib/typecheck-fanout.d.mts`) already missing `commandFor`, an export its
 * source had grown.
 *
 * WHY NOT JUST REGISTER THEM. That is the obvious remedy and it is measurably
 * wrong for this population. Regenerating all 18 was tried and diffed: it LOSES
 * type information in 16 of them, because these declarations carry generics,
 * literal unions and optionality that the sources' JSDoc does not. The starkest
 * case is `scripts/lib/budgeted-task-scheduler.d.mts`, where
 * `runBudgetedTasks<Task, Value>(tasks: Task[], …): Promise<BudgetedTaskRun<…>>`
 * regenerates as `runBudgetedTasks(tasks: any, options: any): Promise<…>`,
 * `mode: 'parallel' | 'serial'` collapses to `string`, and five optional
 * parameters become REQUIRED. Generation remains the right default for a NEW
 * module — see the header of `tsconfig.declarations.json` — but converting these
 * would trade a precise contract for `any`. So they stay hand-written, and this
 * module gives them the drift-detection the generated ones get for free.
 *
 * This file is `.ts` deliberately: it needs no `.d.mts` of its own (so it cannot
 * become an instance of the very problem it detects), and it has no top-level side
 * effects, so a test can import it — `gen-declarations.ts` cannot be imported,
 * because it calls `generate()` at module scope and would emit declarations into
 * this shared working tree as a side effect of collecting the suite.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

export interface ParityProblem {
  /** Repo-relative path of the declaration file. */
  declaration: string;
  /** Repo-relative path of the `.mjs` it describes. */
  source: string;
  /** Exported by the source, absent from the declaration — TS2305/TS2724 for importers. */
  stranded: string[];
  /** Declared, not exported by the source — typechecks, `undefined` at runtime. */
  phantom: string[];
}

/**
 * The names a module exports as VALUES — functions, consts, classes, and the names
 * introduced by an `export { … }` list.
 *
 * Type-only exports (`type`, `interface`, and `export type { … }`) are excluded ON
 * PURPOSE. A hand-written declaration legitimately names types that appear nowhere
 * in the `.mjs` — that is most of what makes it richer than a generated one — so
 * counting them would fire on nearly every well-written declaration in the repo.
 * Measured: across the 18 hand-written declarations, comparing ALL exports reports
 * 31 differences of which 30 are exactly this false positive; comparing VALUE
 * exports reports the 1 real defect and nothing else.
 *
 * Takes TEXT rather than a path so it is testable without touching the filesystem.
 */
export function valueExports(text: string, fileName = 'input.mts'): Set<string> {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  for (const node of sf.statements) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) continue;

    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (isExported(node) && node.name) names.add(node.name.text);
    } else if (ts.isVariableStatement(node)) {
      if (!isExported(node)) continue;
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    } else if (ts.isExportDeclaration(node) && node.exportClause && !node.isTypeOnly) {
      // `export { a, b as c }` — the EXPORTED name is what an importer writes.
      if (ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          if (!el.isTypeOnly) names.add(el.name.text);
        }
      }
    }
  }
  return names;
}

/** Compare one declaration/source pair. Pure — the unit the tests drive. */
export function comparePair(
  declarationText: string,
  sourceText: string,
): { stranded: string[]; phantom: string[] } {
  const declared = valueExports(declarationText, 'declaration.d.mts');
  const actual = valueExports(sourceText, 'source.mjs');
  return {
    stranded: [...actual].filter((n) => !declared.has(n)),
    phantom: [...declared].filter((n) => !actual.has(n)),
  };
}

/**
 * Paths under `gitRoot` that git reports as UNTRACKED AND IGNORED, relative to
 * `gitRoot` with `/` separators (`--directory` collapses a wholly-ignored directory
 * to one entry). Tracked files are never listed — not even one force-added under an
 * ignore pattern — so pruning by this set cannot hide a declaration git knows about,
 * and an untracked-but-NOT-ignored declaration stays visible, which is the state
 * this guard exists to catch.
 *
 * Empty when `gitRoot` is not a git work tree (a tmpdir fixture, an exported
 * tarball) or git fails or times out; the exact exclusions in `allDeclarations`
 * still apply there. Every failure mode walks MORE, never less — a false red, not
 * a hidden declaration.
 */
export function ignoredUntrackedPaths(gitRoot: string): Set<string> {
  try {
    const out = execFileSync(
      'git',
      ['-C', gitRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30_000,
      },
    );
    return new Set(
      out
        .split('\0')
        .filter(Boolean)
        .map((p) => p.replace(/\/$/, '')),
    );
  } catch {
    return new Set();
  }
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

/** Record `gitRoot`'s untracked+ignored paths in `ignored`, keyed repo-relative. */
function addIgnoredUnder(ignored: Set<string>, repoRoot: string, gitRoot: string): void {
  const prefix = posix(relative(repoRoot, gitRoot));
  for (const p of ignoredUntrackedPaths(gitRoot)) ignored.add(prefix ? `${prefix}/${p}` : p);
}

/**
 * Every `.d.mts` under `repoRoot`, excluding dependency and VCS directories and
 * anything git reports as untracked AND ignored.
 *
 * Deliberately a filesystem walk rather than `git ls-files`: the declarations that
 * most need policing are the ones nobody registered, and an untracked-but-present
 * one is exactly the state this guard exists to catch. What it must NOT walk is
 * gitignored disposable content — scratch snapshots, generated mirrors, frozen
 * worktrees — which can never reach the gate and only false-reds local runs of the
 * shared tree (EI-24553552437295746 / WI-10003807: a peer's gitignored
 * `.papercusp/scratch/source-preview` copy failed every local check). The ignore
 * set is taken from git itself rather than a list of directory names, so a new
 * disposable directory needs no edit here; each nested git root (a submodule)
 * contributes its own ignore rules as the walk enters it.
 */
export function allDeclarations(repoRoot: string): string[] {
  const ignored = new Set<string>();
  addIgnoredUnder(ignored, repoRoot, repoRoot);
  const acc: string[] = [];
  walkDeclarations(repoRoot, repoRoot, ignored, acc);
  return acc;
}

function walkDeclarations(repoRoot: string, dir: string, ignored: Set<string>, acc: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    const repoRelative = relative(repoRoot, abs);
    if (ignored.has(posix(repoRelative))) continue;
    // Non-git fallback (the ignore set is empty outside a work tree): frozen-candidate
    // repair worktrees are complete historical repo snapshots, and generated runtime
    // mirrors under any `.papercusp/tmp*` directory are disposable copies — neither is
    // a declaration surface owned by this checkout. Keep these exclusions exact: the
    // guard must still see untracked declarations in every other directory,
    // including other dot-directories.
    const segments = repoRelative.split(/[\\/]/);
    const parent = segments.length > 1 ? segments[segments.length - 2] : undefined;
    const isRuntimeTemp =
      parent === '.papercusp' &&
      (entry.name === 'tmp' || entry.name.startsWith('tmp-'));
    if (
      entry.isDirectory() &&
      (repoRelative === join('.papercusp', 'worktrees') || isRuntimeTemp)
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      if (existsSync(join(abs, '.git'))) addIgnoredUnder(ignored, repoRoot, abs);
      walkDeclarations(repoRoot, abs, ignored, acc);
    } else if (entry.name.endsWith('.d.mts')) acc.push(repoRelative);
  }
}

/**
 * Every hand-written declaration that disagrees with its source.
 *
 * `registered` is the set of repo-relative `.d.mts` paths that
 * `tsconfig.declarations.json` generates; those are skipped here because the
 * byte-compare in `gen-declarations.ts --check` already holds them to a stricter
 * standard than export parity.
 */
export function exportParityProblems(repoRoot: string, registered: Set<string>): ParityProblem[] {
  const problems: ParityProblem[] = [];

  for (const declaration of allDeclarations(repoRoot).sort()) {
    if (registered.has(declaration)) continue;
    const source = declaration.replace(/\.d\.mts$/, '.mjs');
    if (!existsSync(join(repoRoot, source))) continue; // no source to disagree with

    const { stranded, phantom } = comparePair(
      readFileSync(join(repoRoot, declaration), 'utf8'),
      readFileSync(join(repoRoot, source), 'utf8'),
    );
    if (stranded.length || phantom.length) {
      problems.push({ declaration, source, stranded, phantom });
    }
  }
  return problems;
}

/** One human-readable line per problem, for the `--check` failure block. */
export function formatProblems(problems: ParityProblem[]): string[] {
  const lines: string[] = [];
  for (const p of problems) {
    if (p.stranded.length) {
      lines.push(`${p.declaration}: MISSING ${p.stranded.join(', ')} — exported by ${p.source}, absent here`);
    }
    if (p.phantom.length) {
      lines.push(`${p.declaration}: PHANTOM ${p.phantom.join(', ')} — declared here, not exported by ${p.source}`);
    }
  }
  return lines;
}
