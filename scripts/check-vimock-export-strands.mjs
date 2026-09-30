#!/usr/bin/env node
/**
 * check-vimock-export-strands.mjs — the vi.mock export-strand TRIGGER
 * (WI-37445, class item EI-19462958615807409).
 *
 * THE TRAP. Adding a runtime-valued export to a module instantly strands every test that
 * mocks that module with an ENUMERATING `vi.mock` factory — a bare `() => ({ … })` that
 * lists the surface it wants. Vitest replaces the WHOLE module with that literal, so the
 * new export simply does not exist for anything in that test's graph:
 *
 *     Error: [vitest] No "DRAIN_UTIL_STALE_MS" export is defined on the
 *            "../../../deployment/account-pool" mock
 *
 * WHY IT IS WORSE THAN AN ORDINARY BREAK — and why a TRIGGER is the right shape:
 * `npm run test:affected` selects suites BY WORKSPACE, from the paths your diff touched.
 * Your diff touches the SOURCE module; the file that breaks is a TEST that names that
 * module only inside a string literal. Nothing in the changed-path set points at it, so
 * the selection is not merely unlucky — it is STRUCTURALLY incapable of choosing it. The
 * first thing that reliably notices is the fleet green-checkpoint, hours later, where it
 * reds the gate for everyone.
 *
 * So, exactly as scripts/check-required-field-strands.mjs argues for its own class:
 * finding the breakage is not the hard part — vitest already names it perfectly, at the
 * exact export and mock. The hard part is KNOWING TO RUN those tests. This guard does the
 * one thing nothing else does: it notices FROM THE DIFF that you just made the specific
 * kind of edit that strands mockers, and names the small set of files to run. It covers
 * both a newly added runtime export and a newly added runtime import from a workspace
 * package (the latter is how a bare `@papercusp/sync` mock escaped this guard). Re-deriving
 * "would it actually throw" here would be a second, worse vitest — and unnecessary,
 * because RUNNING the named tests is USUALLY the decisive answer.
 *
 * ⚠ USUALLY, NOT ALWAYS — a GREEN run of a named test is not proof (EI-20017608270017874).
 * The strand has two shapes with opposite loudness, and this guard's "just run them" advice
 * is only decisive for the loud one:
 *
 *   LOUD  — the test fails to COLLECT. Unmissable; running it settles the question.
 *   QUIET — the module under test wraps its body in a fail-soft try/catch. The missing-export
 *           error is SWALLOWED, the function returns its empty accumulator, and assertions
 *           then run against `[]` while still reading as tests of real behaviour.
 *
 * Measured 2026-08-09 adding `mugKettleSystemEnabled` to pot/started.ts: watchdog.test.ts took
 * the loud shape, while watchdog-paused-recovery.test.ts took the quiet one — `pausedPotRecoverySweep`
 * caught the error, console.warn'd, and four assertions ran against an empty sweep result. That
 * instance surfaced only incidentally (those assertions happened to expect non-empty output, and
 * vitest-fail-on-console caught one warn). NEITHER is structural: an `expect(result).toEqual([])`
 * — the ordinary shape of a "should not act" / gating test, and the single most likely kind to be
 * vacuously satisfied by a module that errored before acting at all — would have PASSED, silently,
 * testing nothing.
 *
 * So a fail-soft consumer converts this class from a collection failure into a false green, which
 * is why the findings output tells you to check WHAT a passing named test actually asserted rather
 * than stopping at the pass. Detecting the quiet shape mechanically is NOT attempted here: it needs
 * "does this module swallow its own errors", which is a judgement call about fail-soft code, and a
 * wrong guess in either direction is worse than the caveat.
 *
 * That is also why the mere ADDITION is never a failure: adding an export is normal and
 * usually harmless. Advisory by default — it cannot false-block the fleet.
 *
 * ⚠ TYPE-ONLY EXPORTS ARE EXCLUDED, and that exclusion is the whole precision story.
 * `export type` / `export interface` are erased at runtime, so they can never be missing
 * from a mock and belong in no factory. Counting them was measured to inflate this signal
 * by ~14× (43,431 candidate sites vs the real shape) while pointing at nothing — a guard
 * nobody can act on is a guard everybody tunes out.
 *
 *   node scripts/check-vimock-export-strands.mjs                 # advisory
 *   node scripts/check-vimock-export-strands.mjs --files=a.ts,b.ts
 *   node scripts/check-vimock-export-strands.mjs --base origin/main
 *   node scripts/check-vimock-export-strands.mjs --json
 *   node scripts/check-vimock-export-strands.mjs --self-test
 *
 * Exit codes:
 *   0 — advisory verdict after at least one meaningful comparison (see above).
 *   1 — --self-test only: the detector itself is broken.
 *   2 — NOT CHECKED: the requested scope produced no meaningful comparison.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
// REUSED, never re-implemented: this is the SAME factory classifier and specifier
// resolver that lint:full-replacement-mocks enforces with, so the two guards cannot
// disagree about what "enumerating" or "this module" means.
import { analyzeMockCalls, resolveSpec } from './check-full-replacement-mocks.mjs';
// WI-37806: this guard inherited check-required-field-strands' "⚠ NOT CHECKED" PROSE when
// it was ported, but not its exit STATUS — so it printed "This is NOT a clean bill" and
// exited 0, which is what `&& echo PASS` and a CI step actually read.
import { EXIT_NOT_CHECKED, exitForNoFindings, provedNothing } from './lib/not-checked.mjs';
import { parseExplicitFiles } from './lib/tsc-baseline-gate.mjs';
// Reuse the required-field guard's proven gitlink translation and candidate expansion.
// The two guards are launched from the same affected-tests registry and must interpret a
// forwarded submodule root identically; separate implementations already drifted once.
import {
  showAtBase,
  submodulePrefixes,
  typeScriptCandidatesAtBase,
} from './check-required-field-strands.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, { allowFail = false, cwd = ROOT } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/** Read workspace package names from the root npm workspace patterns, including submodule packages. */
function discoverWorkspacePackageNames() {
  const names = new Set();
  let patterns;
  try {
    const rootPackage = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    patterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : rootPackage.workspaces?.packages;
  } catch {
    patterns = [];
  }
  for (const pattern of patterns ?? []) {
    const star = pattern.indexOf('*');
    const base = star === -1 ? pattern : pattern.slice(0, star);
    let candidates = [pattern];
    if (star !== -1) {
      let entries;
      try {
        entries = readdirSync(resolve(ROOT, base), { withFileTypes: true });
      } catch {
        entries = [];
      }
      candidates = entries.filter((entry) => entry.isDirectory()).map((entry) => `${base}${entry.name}`);
    }
    for (const candidate of candidates) {
      const manifest = resolve(ROOT, candidate, 'package.json');
      try {
        const name = JSON.parse(readFileSync(manifest, 'utf8')).name;
        if (typeof name === 'string' && name) names.add(name);
      } catch {
        // An unreadable manifest is outside this advisory's scope; npm/typecheck owns it.
      }
    }
  }
  return names;
}

const hasExportModifier = (node) =>
  Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

/**
 * Every RUNTIME-VALUED exported name in `sourceText`.
 *
 * Runtime-valued means "a mock factory must provide it or an access throws": functions,
 * classes, enums, variables, re-exported value specifiers, and `default`. Types and
 * interfaces are deliberately absent — see the header's precision note.
 */
export function collectRuntimeExports(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, String(sourceText), ts.ScriptTarget.Latest, true);
  const names = new Set();

  const addBindingName = (name) => {
    if (!name) return;
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    // `export const { a, b } = …` / `export const [x] = …` — each bound name is a real
    // runtime export, so a destructuring declaration contributes all of them.
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingName(el.name);
      }
    }
  };

  for (const stmt of sf.statements) {
    // export function / class / enum — all runtime values.
    if (
      (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)) &&
      hasExportModifier(stmt)
    ) {
      if (stmt.name) names.add(stmt.name.text);
      continue;
    }
    // export const/let/var
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) addBindingName(decl.name);
      continue;
    }
    // export default …
    if (ts.isExportAssignment(stmt)) {
      names.add('default');
      continue;
    }
    // export { a, b } / export { a } from './x'
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue; // `export type { … }` — erased
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const spec of clause.elements) {
          if (spec.isTypeOnly) continue; // `export { type A }` — erased
          names.add(spec.name.text);
        }
      }
      // A bare `export * from './x'` names nothing here. Left out on purpose rather than
      // guessed at: resolving it needs the other module, and a star re-export is not the
      // shape that strands a factory (the factory would already be missing everything).
      continue;
    }
  }
  return names;
}

/** Runtime-valued exports present in `after` but absent in `before`. */
export function diffAddedRuntimeExports(beforeText, afterText, fileName = 'f.ts') {
  const before = collectRuntimeExports(beforeText, fileName);
  const after = collectRuntimeExports(afterText, fileName);
  return [...after].filter((n) => !before.has(n));
}

/**
 * Every runtime-valued import in `sourceText`, keyed by the raw module specifier.
 *
 * A mock can strand a consumer even when the exporting module did not change in the same
 * commit: importing a new value from a workspace package is enough to make an existing
 * enumerating factory incomplete. Type-only bindings are erased and deliberately omitted,
 * just as they are from collectRuntimeExports.
 */
export function collectRuntimeImports(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, String(sourceText), ts.ScriptTarget.Latest, true);
  const imports = new Map();
  const add = (spec, name) => {
    if (!spec || !name) return;
    if (!imports.has(spec)) imports.set(spec, new Set());
    imports.get(spec).add(name);
  };

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const specifier = ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (!specifier || stmt.importClause.isTypeOnly) continue;

    if (stmt.importClause.name) add(specifier, 'default');
    const bindings = stmt.importClause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) {
      add(specifier, '*');
      continue;
    }
    if (!ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      add(specifier, element.propertyName?.text ?? element.name.text);
    }
  }
  return imports;
}

/** Runtime-valued imports present in `after` but absent from `before`. */
export function diffAddedRuntimeImports(beforeText, afterText, fileName = 'f.ts') {
  const before = collectRuntimeImports(beforeText, fileName);
  const after = collectRuntimeImports(afterText, fileName);
  const added = [];
  for (const [specifier, names] of after) {
    const previous = before.get(specifier) ?? new Set();
    const newNames = [...names].filter((name) => !previous.has(name));
    if (newNames.length) added.push({ specifier, names: newNames });
  }
  return added;
}

/**
 * Test files that mock `modulePath` or one of `moduleSpecifiers` with an ENUMERATING factory.
 *
 * `modulePath` is repo-relative and extensionless, matching resolveSpec's output, while
 * bare package specifiers are compared as raw strings. An optional per-run `cache` keeps
 * repeated triggers from reparsing the same test file.
 */
export function findEnumeratingMockers({ modulePath, moduleSpecifiers = [], testFiles = [], read, cache }) {
  const hits = [];
  const needle = modulePath ? modulePath.split('/').pop() : null;
  const specifiers = new Set(moduleSpecifiers);
  for (const path of testFiles) {
    let entry = cache?.get(path);
    if (!entry) {
      const text = read(path);
      if (text === null || text === undefined) {
        if (cache) cache.set(path, null);
        continue;
      }
      entry = { text, calls: null };
      cache?.set(path, entry);
    }
    if (!entry) continue;
    const { text } = entry;
    // Cheap substring pre-filter before parsing, mirroring collectCandidateFiles in the
    // sibling guard: a test that never mentions the basename/specifier cannot mock it.
    if (needle && !text.includes(needle) && ![...specifiers].some((s) => text.includes(s))) continue;
    if (!entry.calls) entry.calls = analyzeMockCalls(text, path);
    for (const call of entry.calls) {
      if (call.form !== 'full-replacement') continue;
      const relativeMatch = modulePath && resolveSpec(path, call.spec) === modulePath;
      const bareMatch = specifiers.has(call.spec);
      if (!relativeMatch && !bareMatch) continue;
      hits.push({ path, line: call.line, spec: call.spec });
    }
  }
  return hits;
}

/** Repo-relative + extensionless, so a changed source path is comparable to resolveSpec. */
export function moduleKeyFor(file) {
  return String(file).replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/** Workspace package names are the only bare specifiers this trigger should inspect. */
export function isWorkspacePackageSpecifier(specifier, packageNames) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('node:')) return false;
  for (const name of packageNames ?? []) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}

/**
 * The no-findings verdict.
 *
 * Draws the same distinction its sibling does, for the same measured reason: "examined N
 * files, found nothing" is a clean bill, while "examined ZERO files" is not a result at
 * all. On this tree that is the COMMON case rather than an edge one — git-sync commits the
 * whole working tree on a schedule, so minutes after you edit, working-tree == HEAD and the
 * default `--base HEAD` diff is empty. Rendering the two identically is the same false-green
 * class as a `tsc -p .` that typechecked nothing.
 */
export function formatNoFindings(examinedFiles, base, { declared = false, identicalFiles = [] } = {}) {
  const files = Array.isArray(examinedFiles) ? examinedFiles : [];
  if (!files.length) {
    return [
      `⚠ NOT CHECKED — nothing differs from '${base}', so ZERO files were examined.`,
      '  This is NOT a clean bill. On this shared tree it usually means git-sync already',
      '  committed your edit, not that you changed nothing.',
      '',
      '  Re-run against the commit that actually carried your change:',
      "    C=$(git log -1 --format=%H -S'<a string your change introduced>' -- <file>)",
      '    node scripts/check-vimock-export-strands.mjs --base "$C^"',
      '',
      '  (Use -G instead of -S when searching by a name you did not introduce.)',
    ].join('\n');
  }
  // WI-37819: the exit status below already consulted `identicalFiles`, but this headline
  // was a hardcoded ✓ — so an all-identical declared run printed a pass and exited 2, the
  // two disagreeing exactly as they did in this guard's parent before EI-20097325488507587.
  // A reader acts on the headline and a script acts on the status; both must read the SAME
  // predicate or they drift again the next time either is edited.
  const nothingProved = provedNothing({ examinedFiles: files, identicalFiles, declared });
  const lines = [
    nothingProved
      ? `⚠ NOT CHECKED — ${files.length} named file(s) are byte-identical to ${base}, so nothing was compared.`
      : `✓ no runtime exports added to a module that enumerating vi.mock factories replace`,
    ...(nothingProved ? [] : [`  (${files.length} file(s) examined vs ${base})`]),
    ...files.map((f) => `    ${f}`),
  ];
  if (!declared) {
    lines.push(
      '  ⚠ That set is INFERRED from `git diff` — on this shared tree that is EVERY agent’s',
      '    uncommitted edits, not necessarily yours. If the file carrying your change is not',
      '    listed above, this green says NOTHING about it.',
      '      node scripts/check-vimock-export-strands.mjs --files=<your,files>',
    );
  }
  if (identicalFiles.length) {
    lines.push(
      `  ⚠ NOT CHECKED — ${identicalFiles.length} of ${files.length} named file(s) are BYTE-IDENTICAL`,
      `    to ${base}, so this run proves NOTHING about them:`,
      ...identicalFiles.map((f) => `      ${f}`),
    );
  }
  return lines.join('\n');
}

/** `git ls-files` for the test corpus. */
/**
 * The findings verdict.
 *
 * Extracted (like its formatNoFindings sibling) so the ADVICE is unit-testable rather than
 * only reachable by driving the whole script against real git history. The non-vacuous-pass
 * caveat below is the reason that matters: it is the one piece of this output that tells you
 * a GREEN result can still be wrong, so it is exactly the line a future tidy-up would drop
 * as noise. A test now fails if it does.
 */
export function formatFindings(findings) {
  const out = [
    '⚠ RUNTIME EXPORT ADDED to a module that tests mock by ENUMERATION.',
    '  `npm run test:affected` CANNOT select these — your diff touches the module,',
    '  while the file that breaks names it only inside a string literal.\n',
  ];
  const toRun = new Set();
  for (const f of findings) {
    out.push(
      f.trigger === 'import'
        ? `  ${f.file}  (new runtime import from '${f.specifier}': +${f.added.join(', ')})`
        : `  ${f.file}  (+${f.added.join(', ')})`,
    );
    for (const m of f.mockers) {
      out.push(`    ↳ ${m.path}:${m.line}  vi.mock('${m.spec}', () => ({ … }))`);
      toRun.add(m.path);
    }
  }
  out.push(
    '\n  Run them now, while it is still your turn:',
    `    npm run test:file -- ${[...toRun].join(' ')}`,
    '\n  ⚠ A GREEN run of these is NOT proof (EI-20017608270017874). If the module under',
    '    test wraps its body in a fail-soft try/catch, the missing-export error is',
    '    SWALLOWED and the function returns an empty result — so assertions still run,',
    '    against nothing, and a "should not act" case like expect(x).toEqual([]) PASSES',
    '    vacuously. Measured: watchdog-paused-recovery.test.ts took exactly that shape.',
    '    For each file above that PASSED, confirm it asserted something non-vacuous —',
    '    a mocked call was actually made, or a non-empty result came back.',
    '\n  If one breaks, prefer the import-actual spread over adding the name by hand:',
    "    vi.mock('<spec>', async (importOriginal) => ({ ...(await importOriginal()), … }))",
    '  ⚠ That conversion is NOT always mechanical — spreading loads the REAL module, so its',
    '    transitive imports load too and can strand a DIFFERENT bare mock in the same file.',
  );
  return out.join('\n');
}

function gitTestFiles() {
  const patterns = ['*.test.ts', '*.test.tsx', '*.spec.ts', '*.spec.tsx'];
  const files = (git(['ls-files', ...patterns], { allowFail: true }) ?? '')
    .split('\n')
    .filter(Boolean)
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    .filter((file) => existsSync(resolve(ROOT, file)));
  // Root `git ls-files` sees only a submodule's gitlink, never its internal tests. A runtime
  // export added inside a submodule can strand an enumerating mock in that same submodule, so
  // ask each owning repository for its tracked test corpus and restore the superproject prefix.
  for (const prefix of submodulePrefixes()) {
    const submoduleFiles = git(['ls-files', ...patterns], {
      allowFail: true,
      cwd: resolve(ROOT, prefix),
    });
    if (submoduleFiles === null) continue;
    files.push(
      ...submoduleFiles
        .split('\n')
        .filter(Boolean)
        .map((file) => `${prefix}/${file}`)
        .filter((file) => existsSync(resolve(ROOT, file))),
    );
  }
  return [...new Set(files)];
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) process.exit(runSelfTest() ? 0 : 1);

  const json = argv.includes('--json');
  const baseIdx = argv.indexOf('--base');
  const base = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';

  // `--files=` or `--files-from=` DECLARES the set instead of inferring it. Large gate
  // populations already use the shared JSON response-file contract to avoid Linux E2BIG.
  const explicitFiles = parseExplicitFiles(argv);
  const declaredFiles = explicitFiles === null ? null : [...explicitFiles];

  // Includes root files plus submodule-internal files. A declared submodule root is expanded
  // against the gitlink at `base`, which is the only way to recover the real changed files
  // from the path shape affected-tests receives from a superproject diff.
  const candidates = typeScriptCandidatesAtBase(base, declaredFiles);
  if (candidates === null) {
    console.error(`check-vimock-export-strands: cannot diff against '${base}'`);
    // WI-37806: a base we cannot diff against means we examined nothing — the one thing
    // this must never report as a clean bill.
    process.exit(EXIT_NOT_CHECKED);
  }

  // EI-20204650589104743: a broad historical `--base` can enumerate thousands of files, and
  // the work is PROPORTIONAL to that count — one `git show` plus a parse of BOTH versions per
  // candidate. That cost is inherent to comparing two trees, not a stall. But the walk prints
  // nothing until it finishes, so a wide run is indistinguishable from a hang: it gets killed,
  // and the check silently never happens. (Measured: `--base b0af215fe0^` enumerates 6,411
  // files here, ~12.8k parses.) State the scale up front so the wait is an informed choice.
  const WIDE_SCAN_NOTICE_THRESHOLD = 500;
  if (candidates.length >= WIDE_SCAN_NOTICE_THRESHOLD) {
    console.error(
      `check-vimock-export-strands: comparing ${candidates.length} changed TypeScript file(s) against '${base}'.\n` +
        `  Cost scales with that count (a git show + a parse of both versions each), so a broad\n` +
        `  historical base can run for several minutes. This is work, not a stall — let it finish,\n` +
        `  or narrow the run with --files=<your,files>.`,
    );
  }

  const examinedFiles = [];
  const identicalFiles = [];
  const changed = [];
  const changedImporters = [];
  const workspacePackageNames = discoverWorkspacePackageNames();
  for (const { status, file } of candidates) {
    if (!file || status.startsWith('D')) continue;
    if (file.endsWith('.d.ts')) continue;
    // A test file's own exports are not a mocked surface; skip to keep the signal about
    // production modules.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;

    const beforeText = showAtBase(file, base);
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');
    // A present file absent at the comparison base is an addition. Examine it against an
    // empty before-image so JSON/status report a checked addition instead of NOT_CHECKED.
    const before = beforeText ?? '';

    examinedFiles.push(file);
    if (declaredFiles && beforeText !== null && beforeText === afterText) identicalFiles.push(file);
    const added = diffAddedRuntimeExports(before, afterText, file);
    if (added.length) changed.push({ file, added });
    const addedImports = diffAddedRuntimeImports(before, afterText, file).filter(({ specifier }) =>
      isWorkspacePackageSpecifier(specifier, workspacePackageNames),
    );
    if (addedImports.length) changedImporters.push({ file, imports: addedImports });
  }

  // Only walk the test corpus when something actually added an export or importer edge.
  const findings = [];
  if (changed.length || changedImporters.length) {
    const testFiles = gitTestFiles();
    const mockCallCache = new Map();
    const read = (f) => {
      try {
        return readFileSync(resolve(ROOT, f), 'utf8');
      } catch {
        return null;
      }
    };
    for (const c of changed) {
      const mockers = findEnumeratingMockers({ modulePath: moduleKeyFor(c.file), testFiles, read, cache: mockCallCache });
      if (mockers.length) findings.push({ ...c, mockers });
    }
    for (const importer of changedImporters) {
      for (const added of importer.imports) {
        const mockers = findEnumeratingMockers({
          moduleSpecifiers: [added.specifier],
          testFiles,
          read,
          cache: mockCallCache,
        });
        if (mockers.length) {
          findings.push({
            file: importer.file,
            added: added.names,
            specifier: added.specifier,
            trigger: 'import',
            mockers,
          });
        }
      }
    }
  }

  const noFindingsExit = exitForNoFindings({
    examinedFiles,
    identicalFiles,
    declared: Boolean(declaredFiles),
  });

  if (json) {
    console.log(
      JSON.stringify(
        { base, examined: examinedFiles, identical: identicalFiles, changedImporters, findings },
        null,
        2,
      ),
    );
    // NOT process.exit(): it does not drain an async pipe write, so a piped run would
    // report FEWER findings than were found. See scripts/check-undrained-stdout-exit.mjs.
    process.exitCode = findings.length ? 0 : noFindingsExit;
    return;
  }

  if (!findings.length) {
    // Distinguish "no exports added" from "exports added, but nothing enumerates them" —
    // the second is a real clean bill for a real trigger, and collapsing them would hide
    // that the trigger fired at all.
    if (changed.length || changedImporters.length) {
      if (changed.length) {
        console.log(
          `✓ ${changed.length} module(s) gained runtime exports, but no enumerating vi.mock factory targets them:`,
        );
      }
      for (const c of changed) console.log(`    ${c.file}  (+${c.added.join(', ')})`);
      for (const importer of changedImporters) {
        for (const added of importer.imports) {
          console.log(
            `✓ ${importer.file} gained runtime imports from '${added.specifier}', but no enumerating vi.mock factory targets it:`,
          );
          console.log(`    (+${added.names.join(', ')})`);
        }
      }
      // A real clean bill for a real trigger: modules were examined AND changed.
      process.exit(0);
    }
    console.log(formatNoFindings(examinedFiles, base, { declared: Boolean(declaredFiles), identicalFiles }));
    // WI-37806: 0 only when something was genuinely compared. This used to be a hardcoded
    // 0, so a run that examined ZERO files printed the "NOT CHECKED / This is NOT a clean
    // bill" text above and then reported success to every caller that reads a status.
    process.exit(noFindingsExit);
  }

  console.log(formatFindings(findings));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Self-test — teeth proven here, not by a clean run over a green tree. A run
// reporting "no findings" would pass identically with the predicate inverted.
// ---------------------------------------------------------------------------
function runSelfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  // Runtime shapes are collected …
  const runtime = collectRuntimeExports(
    [
      'export function fn() {}',
      'export const CONST = 1;',
      'export class Klass {}',
      'export enum E { a }',
      'export const { destructured } = obj;',
      "export { reExported } from './x';",
    ].join('\n'),
  );
  for (const n of ['fn', 'CONST', 'Klass', 'E', 'destructured', 'reExported']) {
    check(`collects runtime export ${n}`, runtime.has(n));
  }

  // … and type-only shapes are NOT. This is the precision property: counting these
  // inflated the signal ~14× while pointing at nothing actionable.
  const typeOnly = collectRuntimeExports(
    [
      'export type Alias = string;',
      'export interface Iface { a: string }',
      'export type { OnlyType } from "./x";',
      'export { type InlineType } from "./y";',
    ].join('\n'),
  );
  check('excludes every type-only export', typeOnly.size === 0);

  // The diff reports only what is NEW.
  const added = diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport const b = 2;');
  check('diff names the added export', added.length === 1 && added[0] === 'b');
  check(
    'diff is silent when only a type is added',
    diffAddedRuntimeExports('export const a = 1;', 'export const a = 1;\nexport type T = 2;').length === 0,
  );

  const addedImports = diffAddedRuntimeImports(
    "import { old } from '@papercusp/sync';",
    "import { old, onSyncBusEvent, type SyncBusEvent } from '@papercusp/sync';",
  );
  check(
    'diff names a newly imported runtime value but excludes a type-only value',
    addedImports.length === 1 &&
      addedImports[0].specifier === '@papercusp/sync' &&
      addedImports[0].names.length === 1 &&
      addedImports[0].names[0] === 'onSyncBusEvent',
  );

  // An ENUMERATING factory on the changed module is a hit …
  const testPath = 'packages/x/lib/__tests__/a.test.ts';
  const hits = findEnumeratingMockers({
    modulePath: 'packages/x/lib/subject',
    testFiles: [testPath],
    read: () => "vi.mock('../subject', () => ({ old: 1 }));",
  });
  check('flags an enumerating factory on the changed module', hits.length === 1);

  const bareHits = findEnumeratingMockers({
    moduleSpecifiers: ['@papercusp/sync'],
    testFiles: [testPath],
    read: () => "vi.mock('@papercusp/sync', () => ({ useSyncQuery: vi.fn() }));",
  });
  check('flags an enumerating factory for a bare workspace package specifier', bareHits.length === 1);

  // … while each SAFE form is silent. These are the controls: without them the check
  // above would pass just as well with the classifier stuck at "everything is a hit".
  check(
    'silent for the import-actual spread (the prescribed fix)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../subject', async (io) => ({ ...(await io()), old: 1 }));",
    }).length === 0,
  );
  check(
    'silent for an automock (no factory — vitest synthesises the whole surface)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../subject');",
    }).length === 0,
  );
  check(
    'silent for the SAME bad shape on a DIFFERENT module (precision, not zeal)',
    findEnumeratingMockers({
      modulePath: 'packages/x/lib/subject',
      testFiles: [testPath],
      read: () => "vi.mock('../other-subject', () => ({ old: 1 }));",
    }).length === 0,
  );

  // The zero-files verdict must NOT read as a clean bill (measured false-green class).
  check('zero examined files is reported as NOT CHECKED', formatNoFindings([], 'HEAD').includes('NOT CHECKED'));
  check('a non-empty examined set reads as a pass', formatNoFindings(['a.ts'], 'HEAD').startsWith('✓'));

  if (failures.length) {
    console.error(`check-vimock-export-strands --self-test FAILED:\n  ${failures.map((f) => `✗ ${f}`).join('\n  ')}`);
    return false;
  }
  console.log(`check-vimock-export-strands --self-test: all cases passed`);
  return true;
}

// Only run main() when invoked as a script, so the pure fns above stay unit-testable.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
