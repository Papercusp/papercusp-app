#!/usr/bin/env node
/**
 * check-behavioural-strands.mjs — the BEHAVIOURAL cross-workspace strand trap,
 * mechanised (EI-20022235111425919).
 *
 * THE TRAP, MEASURED 2026-08-09/10 (~3 gate reds, ~2h of frozen `main`, three agents
 * diagnosing it independently in parallel):
 *   WI-37582 added a two-stage lexical cascade to `libs/generic/search/src/hybrid.ts` —
 *   when stage 1 under-fills, the engine issues a SECOND `source.lexical()` call. Correct
 *   engine behaviour, tested, shipped. It stranded three
 *   `expect(searchDocs).toHaveBeenCalledTimes(1)` assertions in
 *   `packages/operator-core/lib/agent-tools/docs/__tests__/handlers.test.ts` — a DIFFERENT
 *   workspace, whose mock under-fills every time.
 *
 * WHY EVERY EXISTING GUARD IS STRUCTURALLY BLIND TO IT. The author ran, before landing,
 * the full owning-package suite (161 passed), the owning package's `tsc` (exit 0) and a
 * full operator-core typecheck (no new errors). All three were clean, and none of them
 * COULD have caught it:
 *   - `test:affected` maps CHANGED PATHS to workspaces. A `libs/generic/search` change
 *     never selects an `operator-core` suite. (CLAUDE.md documents the TYPE version of
 *     this; the behavioural version had no analogue.)
 *   - `tsc` cannot see it: a stale `toHaveBeenCalledTimes(N)` is perfectly well-typed.
 *     This is a RUNTIME strand.
 *   - `lint:required-field-strands` covers exactly the type-shaped version of this class
 *     (a new required field on a shared interface) and has no behavioural analogue.
 *   - `lint:di-seam-arity-strands` / `lint:optional-seam-strands` police the SHAPE of a DI
 *     seam at one site; neither compares a seam's CALL COUNT across a change.
 * So the first detector that fires is the shared fleet gate, hours later, blocking
 * everyone — the worst possible discovery point, and precisely the outcome
 * `lint:required-field-strands` exists to prevent for its own narrower class.
 *
 * THE GENERAL SHAPE. A change to a shared lib that alters HOW MANY TIMES it calls an
 * injected collaborator invalidates every downstream call-count / call-order assertion in
 * every OTHER workspace — none of which the selector will run. Adding a call is the common
 * case and a normal, correct thing to do, which is why this recurs and why the ADDITION is
 * never itself the failure. Advisory by default; it cannot false-block the fleet.
 *
 * WHY THIS GUARD IS A TRIGGER, NOT A SECOND ANALYSER (inherited from
 * check-required-field-strands' header, and true here for a different reason): the
 * authoritative detector for a behavioural strand is RUNNING THE DOWNSTREAM TESTS. There is
 * no `tsc` for this class, so this guard's job is to notice from the diff that you just made
 * the kind of edit that strands siblings, resolve the blast radius the workspace selector
 * cannot see, and hand you the exact command — or run it under `--run`.
 *
 * WHY THE BLAST RADIUS IS AN IMPORT GRAPH AND NOT A GREP. In the measured instance the
 * stranded test names neither the changed package nor the changed seam: it mocks
 * `@papercusp/docs-engine`'s `searchDocs`, which production code binds INTO the hybrid
 * engine's `source.lexical` seam two files away. Grepping test files for the seam finds
 * nothing. The link that exists is the import graph — `handlers.test.ts` → `../search` →
 * `@papercusp/search` — so that is what this walks, cross-workspace and through submodules.
 *
 * ⚠ EVERY FAILURE MODE HERE FAILS TOWARD NAMING MORE TESTS. Over-naming costs a glance;
 * under-naming reports a clean bill for a strand that is really there, which is the whole
 * defect this exists to prevent.
 *
 * THE INJECTED-MEMBER TRIGGER (EI-23824032487848760). A second strand shape has NO count or
 * order assertion to anchor on. A function gains a call to an OPTIONAL member of its injected
 * Deps bundle (`(deps.reconcileStrandedLatch ?? fb)(…)`); a test fixture that builds that bundle
 * PARTIALLY never supplies the member, so the new call reaches an uninjected dependency, throws,
 * the catch logs, and vitest-fail-on-console fails the test. The fixture asserts nothing about
 * the new seam, `tsc` is silent (the member is optional), and — the measured instance,
 * 0205cd785c — the stranded files (`standing-goal-boot-arm.test.ts:77`,
 * `goal-liveness-watchdog.test.ts:777`) sit in the SAME workspace as the change, which the
 * cross-workspace band excludes by design. So this trigger has its own band:
 *   - `invokedInjectedMembers` — optional members of a Deps-shaped interface (INJECTED_TYPE_NAME_RE)
 *     whose callee-position invocation count rose (looking through `(x ?? fb)()`, `!`, `as`, `?.`),
 *     plus `receiver.member` seams on an injected PARAMETER. A REQUIRED member is not a trigger:
 *     a fixture that omits one is a type error `lint:tsc` already reports.
 *   - `partialInjectionFixtures` — any reachable test file (changed workspace INCLUDED) holding an
 *     object literal that names >= min(2, siblings) sibling members of the bundle but NOT the new
 *     one. The SIBLING members are the stable join key. It over-names on purpose (a literal that
 *     overrides two members of a `{ ...base }` spread matches too); running the named file is the
 *     detector. An injection-only trigger skips the count-assertion band — naming every reachable
 *     count assertion for it would be pure noise. Do not widen seam detection beyond the `??`/`||`
 *     peel: peers keep filing false positives against this script (EI-24442819396601796,
 *     EI-24305142907074152, EI-24343822128966827, EI-24661855321504237).
 *
 *   node scripts/check-behavioural-strands.mjs                  # advisory: name the trigger, the seam, and the command
 *   node scripts/check-behavioural-strands.mjs --run            # RUN the named tests, exit 1 on real failures
 *   node scripts/check-behavioural-strands.mjs --base "$C"      # pin the pre-edit commit (see below)
 *   node scripts/check-behavioural-strands.mjs --files=a.ts,b.ts
 *   node scripts/check-behavioural-strands.mjs --json
 *   node scripts/check-behavioural-strands.mjs --all            # do not clip the named-test list
 *
 * `--json` carries the injected-member evidence as `triggers[].injections` and the named
 * partial fixtures as `injectionBand`; `--run` runs those files with the rest of the set.
 *
 * ⚠ `--base HEAD` DECAYS WITHIN MINUTES ON THIS TREE. git-sync commits the whole working
 * tree on a schedule, so a few minutes after your edit `working tree == HEAD` and the diff
 * is EMPTY — the guard then reports NOT CHECKED (exit 2), never a false green. Pin the
 * pre-edit sha (`C=$(git rev-parse HEAD)` BEFORE editing) or run it from the PostToolUse
 * nudge, which fires milliseconds after the write while HEAD is still unambiguously the
 * pre-edit content.
 *
 * ⚠ SUBMODULES. `libs/generic/*` and `libs/papercusp` are SUBMODULES, so a superproject
 * `git ls-files` / `git diff` cannot see the very files whose change is the trigger class —
 * the measured instance lives in one. This guard enumerates and diffs each submodule in its
 * OWN repo, and reports the base it actually used per repo (a superproject revision does not
 * name submodule content, so a submodule's base is its own HEAD).
 *
 * Exit codes:
 *   0 — examined a real diff and found no seam-call-count increase, or advisory mode, or
 *       `--run` found no failures
 *   1 — `--run` confirmed failing tests among the named blast radius
 *   2 — EXIT_NOT_CHECKED: nothing was compared (empty diff, or every declared file was
 *       byte-identical to its base), so this run proved nothing; OR a `--files=` path names
 *       nothing in the working tree or at the base, so the verdict cannot cover it
 *
 * Declared mode names every `--files=` path it did not examine, with the reason (not
 * source, a test, a declaration, a generated path, new since the base, deleted, not found).
 * JS (.js/.jsx/.mjs/.cjs) is examined like TS (WI-10004906).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { EXIT_NOT_CHECKED, exitForNoFindings } from './lib/not-checked.mjs';
import { parseImportSpecifiers, resolveSpecifier } from './lib/module-reachability.mjs';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Source files whose changes can strand another workspace's fixtures: TypeScript AND
 * JavaScript. JS was missing until WI-10004906 (2026-10-01): `scripts/*.mjs` and the hook
 * layer hold injected-collaborator seams that TS tests in other workspaces assert on, and
 * `--files=a.mjs,b.ts` dropped the .mjs without a word, so a clean verdict could cover a
 * file that was never read. Every analyser here parses with `ScriptKind.TSX`, which accepts
 * JS as-is.
 */
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;
/** Type declarations (.d.ts / .d.mts / .d.cts) have no call sites, so no seam to count. */
const DECLARATION_RE = /\.d\.[cm]?ts$/;
const EXCLUDED_DIR_RE = /(?:^|\/)(?:dist|build|node_modules|coverage|\.next|\.papercusp)\//;
const EXCLUDED_ROOT_RE = /^(?:papercup-release|papercup-checkpoint)\//;
/**
 * Type names that denote an INJECTED collaborator bundle (`GoalHolderRespawnDeps`,
 * `SearchSource`, …). One definition: it types an injected PARAMETER for the seam walk and it
 * marks a Deps-shaped INTERFACE whose members a partial test fixture may fail to supply
 * (EI-23824032487848760).
 */
const INJECTED_TYPE_NAME_RE =
  /(?:Deps?|Dependencies|Context|Ctx|Ports?|Services?|Source|Embedder|Probe|Runner|Fetcher|Transport|Adapter|Client|Repositories?|Store|Database|Gateway|Logger|Clock|Cache|Queue|Scheduler|Publisher|Reader|Writer|Validator|Authorizer|Provider|Api)$/i;

/**
 * Why a repo-relative path is NOT a candidate for this guard, or `null` when it is.
 * Package manifests are candidates for their scripts.<name> output values; ordinary JSON is not.
 *
 * The ONE definition of the candidate set. The CLI's declared mode and its tree-diff mode
 * both use it, and the PostToolUse nudge hook mirrors it (the hook is installed detached
 * from the repo and must decide before it loads TypeScript). The hook's test asserts the two
 * agree path by path, so a widening made here and not there fails a test instead of
 * silently narrowing the nudge.
 *
 * @param {string} file repo-relative POSIX path
 * @returns {null | 'not-source' | 'declaration' | 'test-file' | 'excluded-path'}
 */
export function candidateSkipReason(file) {
  if (PACKAGE_JSON_RE.test(file)) return keepPath(file) ? null : 'excluded-path';
  if (!SOURCE_RE.test(file)) return 'not-source';
  if (DECLARATION_RE.test(file)) return 'declaration';
  if (TEST_RE.test(file)) return 'test-file';
  if (!keepPath(file)) return 'excluded-path';
  return null;
}

/** Human text for each reason a declared file was not examined. */
const SKIP_REASON_TEXT = {
  'not-source': 'not JS/TS source — no call sites to compare',
  declaration: 'type declaration — no runtime call sites',
  'test-file': 'test file — a consumer of seams, not a shared seam',
  'excluded-path': 'generated/vendored path (dist, build, node_modules, .papercusp, …)',
  'invalid-package-json': 'package.json could not be parsed — script values were not checked',
  'new-file': 'no version at the base — a new file cannot strand an existing assertion',
  deleted: 'deleted since the base — nothing left to compare',
  'not-found': 'NOT FOUND in the working tree or at the base — check the path',
};

/**
 * Skip reasons that mean "this declared file may hold a changed seam, and it was not read".
 * Any one of them makes the run NOT CHECKED: the caller named the file, so a verdict that
 * covered the rest of the set while quietly omitting it would be the false clean bill this
 * guard exists to prevent. The other reasons are outside the guard's domain by design, and
 * are disclosed rather than counted against the run.
 */
const UNEXAMINED_REASONS = new Set(['not-found', 'invalid-package-json']);

/**
 * Exit status for a no-findings run, given the declared files that were not examined.
 * Pure, so it is unit-testable without a git fixture.
 *
 * @param {{ examinedFiles?: string[], identicalFiles?: string[], declared?: boolean,
 *           skipped?: Array<{ file: string, reason: string }> }} [opts]
 * @returns {0 | 2}
 */
export function exitForDeclaredRun({ examinedFiles = [], identicalFiles = [], declared = false, skipped = [] } = {}) {
  if (declared && skipped.some((s) => UNEXAMINED_REASONS.has(s.reason))) return EXIT_NOT_CHECKED;
  return exitForNoFindings({ examinedFiles, identicalFiles, declared });
}

/** One line per skipped declared file, for the text report. */
export function formatSkipped(skipped) {
  return skipped.map((s) => `  - ${s.file}: ${SKIP_REASON_TEXT[s.reason] ?? s.reason}`);
}
/** Anything whose import specifiers are worth indexing. */
const IMPORTABLE_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** A file bigger than this is a generated bundle, not a hand-written importer. */
const MAX_SCAN_BYTES = 512 * 1024;

/**
 * Matcher names whose meaning depends on HOW MANY TIMES (or IN WHAT ORDER) a collaborator
 * was called. Anchored on the SEMANTIC TOKEN inside the name, never on an exhaustive list
 * of spellings — the item that commissioned this guard names a form-blind detector as the
 * documented failure mode of the last three guards added here. `CalledTimes` therefore
 * matches `toHaveBeenCalledTimes` and `toBeCalledTimes` alike, `callCount` catches the
 * sinon spelling, and `NthCalled`/`LastCalled`/`CalledBefore`/`CalledAfter` catch the
 * order-sensitive family that an inserted call also invalidates.
 */
const COUNT_ORDER_MATCHER_RE =
  /(?:CalledTimes|CalledOnce|CalledTwice|CalledThrice|NthCalled|LastCalled|CalledBefore|CalledAfter|callCount)/;

/**
 * Property paths that read the call log directly — the hand-rolled spelling of the same
 * assertion, which a matcher-name-only detector would miss entirely.
 */
const CALL_LOG_ACCESS_RE = /\.mock\.(?:calls|lastCall|invocationCallOrder)\b/;

/** `expect(x).not.toHaveBeenCalled()` is a call-COUNT assertion (count must stay 0). */
const NEGATED_CALLED_RE = /\.not\s*(?:\.\w+\s*)*\.to(?:Have)?[Bb]eenCalled\s*\(/;

/**
 * Exact invocation-sequence assertions are the hand-rolled form of a call-count/order
 * assertion. The historical miss used `expect(invocations.map(...)).toEqual([...])`: the
 * injected call site stayed at one, but a changed `break`/`continue` path made the sequence
 * two entries long. Keep the receiver vocabulary focused on call/execution logs; treating every
 * `results.map(...).toEqual([...])` as a call-count assertion would flood the blast radius with
 * ordinary result-order tests and train readers to ignore the useful warning.
 */
const INVOCATION_SEQUENCE_ASSERTION_RE =
  /\b(?:invocations?|call(?:s|Log|Records?)|mockCalls|executions?|requests?)\s*\.\s*map\s*\([\s\S]*?\)\s*\.\s*(?:toEqual|toStrictEqual)\s*\(\s*\[/;

function git(args, { cwd = ROOT, allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (allowFail) return null;
    throw err;
  }
}

/**
 * `git diff <revision>` silently reinterprets an unknown revision as a PATHSPEC and returns
 * a working-tree diff with status 0 — after which `git show <revision>:<file>` yields empty
 * text and the guard counts files as examined while comparing against nothing. Validate the
 * base as a revision first. Borrowed verbatim in intent from check-required-field-strands,
 * where the same trap was measured.
 */
function resolvesRevision(revision, cwd = ROOT) {
  if (typeof revision !== 'string' || revision.length === 0) return false;
  return git(['rev-parse', '--verify', '--end-of-options', revision], { cwd, allowFail: true }) !== null;
}

/**
 * Submodule paths, repo-relative, from .gitmodules (never from a plain `git ls-files`).
 *
 * EXPORTED for the PostToolUse nudge hook, which is installed OUTSIDE any repo and must
 * ask each git question of the owning repo exactly as this CLI does. The hook could
 * re-derive this in four lines; it must not. `libs/generic/*` and `libs/papercusp` ARE
 * submodules, so submodule routing is not an edge case here — it is this guard's whole
 * trigger class, and a hook that re-implemented it slightly differently would fail open
 * (no nudge) on precisely the files the guard exists for, silently and forever.
 */
export function submodulePaths() {
  const out = git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], {
    allowFail: true,
  });
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1])
    .filter(Boolean)
    .filter((p) => existsSync(resolve(ROOT, p, '.git')) || existsSync(resolve(ROOT, p)))
    .sort();
}

/**
 * Which repo owns a repo-relative path: the superproject, or the longest matching
 * submodule. Every git question about a file must be asked of its OWNING repo — the
 * documented submodule trap is that the superproject answers "absent" for a file that is
 * committed, which reads exactly like "your change is not there".
 *
 * EXPORTED for the same reason as `submodulePaths` above — see its note.
 */
export function repoForPath(file, submodules) {
  let best = null;
  for (const sub of submodules) {
    if (file === sub || file.startsWith(`${sub}/`)) {
      if (!best || sub.length > best.length) best = sub;
    }
  }
  if (best === null) return { submodule: null, cwd: ROOT, relPath: file };
  return { submodule: best, cwd: resolve(ROOT, best), relPath: file.slice(best.length + 1) };
}

function keepPath(file) {
  return !EXCLUDED_DIR_RE.test(file) && !EXCLUDED_ROOT_RE.test(file);
}

/** Every tracked source/test file in the superproject AND in each submodule. */
function allRepoFiles(submodules) {
  const files = [];
  const push = (list, prefix) => {
    for (const f of list) {
      if (!f) continue;
      const full = prefix ? `${prefix}/${f}` : f;
      if (keepPath(full)) files.push(full);
    }
  };
  push((git(['ls-files']) ?? '').split('\n'), '');
  for (const sub of submodules) {
    const out = git(['ls-files'], { cwd: resolve(ROOT, sub), allowFail: true });
    if (out) push(out.split('\n'), sub);
  }
  return files;
}

/** The `.` entry a manifest declares, as a package-relative path, or null. */
function declaredEntry(pkg) {
  const dot = pkg?.exports?.['.'];
  const fromExports =
    typeof dot === 'string' ? dot : dot?.import ?? dot?.default ?? dot?.types ?? null;
  const entry = fromExports ?? pkg?.module ?? pkg?.main ?? pkg?.types ?? null;
  return typeof entry === 'string' ? entry : null;
}

/**
 * TWO name->dir maps, because one is provably not enough (measured while building this
 * guard, on the very instance it exists to catch).
 *
 * `resolveSpecifier` resolves a bare specifier as `<dir>/<subpath>`, with `index` as the
 * subpath for a bare package name. That is right for `@papercusp/operator-core/lib/x`
 * (dir = the package dir) and WRONG for `@papercusp/search`, whose manifest entry is
 * `./src/index.ts` — there is no `libs/generic/search/index.ts` to find. With only the
 * package-dir map, reverse reachability from `libs/generic/search/src/hybrid.ts` reached
 * SIX files, all inside its own package, and did not name the operator-core test that this
 * change really stranded: a clean-looking green produced by a resolver that silently
 * dropped every cross-package edge into a `src/`-rooted package.
 *
 * So `byDir` handles subpath imports and `byEntryDir` handles bare imports of a package
 * whose entry is nested. Callers try both and take the first hit; a specifier that
 * resolves under neither was genuinely outside the repo.
 */
export function packageMapsByName(files) {
  const byDir = new Map();
  const byEntryDir = new Map();
  for (const f of files) {
    if (!/(?:^|\/)package\.json$/.test(f)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'));
    } catch {
      // A malformed manifest fails open: one unresolvable package name costs edges, never
      // a wrong answer about the ones that did parse.
      continue;
    }
    if (!pkg?.name) continue;
    const dir = f === 'package.json' ? '' : dirname(f);
    byDir.set(pkg.name, dir);
    const entry = declaredEntry(pkg);
    if (entry) {
      const entryDir = dirname(entry.replace(/^\.\//, ''));
      if (entryDir && entryDir !== '.') byEntryDir.set(pkg.name, dir ? `${dir}/${entryDir}` : entryDir);
    }
  }
  return { byDir, byEntryDir };
}

/** Resolve `specifier` against both package maps; first hit wins. */
function resolveAcrossPackages({ specifier, fromFile, fileSet, byDir, byEntryDir }) {
  return (
    resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName: byDir }) ??
    resolveSpecifier({ specifier, fromFile, fileSet, workspaceDirByName: byEntryDir })
  );
}

/** The nearest enclosing package dir for a file — this guard's definition of "workspace". */
function workspaceOf(file, packageDirs) {
  let best = '';
  for (const dir of packageDirs) {
    if (dir === '') continue;
    if (file.startsWith(`${dir}/`) && dir.length > best.length) best = dir;
  }
  return best;
}

// ── the trigger: a seam's call count went up ────────────────────────────────────────────

/**
 * Calls in `text` whose callee resolves to an imported binding or an explicitly injected
 * collaborator parameter. Arbitrary function parameters are often values or callback
 * arguments (`Buffer`, strings, Promise executors, event payloads), not seams a downstream
 * test can mock and count. The parameter-name/type checks below keep those local bindings
 * out while preserving the common deps/context and typed collaborator forms.
 *
 * Keyed by `param.member` (or `param()` for a directly-called parameter) and counted at
 * FILE level rather than per function: a call that merely MOVES between functions in the
 * same file strands nobody, and counting per function would report that move as an
 * increase. Nested closures still count when they capture an injected parameter.
 *
 * @returns {Map<string, number>} seam key -> number of call sites
 */
function seamCallSites(text, fileName = 'file.ts', sourceOverride = null) {
  const callSites = [];
  let source = sourceOverride;
  if (!source) {
    try {
      source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    } catch {
      return callSites;
    }
  }

  const BUILTIN_METHODS = new Set([
    'at', 'charAt', 'charCodeAt', 'codePointAt', 'concat', 'endsWith', 'every', 'filter', 'find',
    'findIndex', 'flat', 'flatMap', 'forEach', 'includes', 'indexOf', 'join', 'lastIndexOf', 'map',
    'match', 'matchAll', 'padEnd', 'padStart', 'pop', 'push', 'reduce', 'reduceRight', 'replace',
    'replaceAll', 'reverse', 'search', 'shift', 'slice', 'some', 'sort', 'splice', 'split', 'startsWith',
    'substring', 'substr', 'toLocaleLowerCase', 'toLocaleString', 'toLocaleUpperCase', 'toLowerCase',
    'toString', 'toUpperCase', 'trim', 'trimEnd', 'trimStart', 'unshift', 'valueOf',
  ]);
  const INJECTED_PARAM_NAME_RE =
    /^(?:deps?|dependencies|ctx|context|ports?|services?|source|embedder|probe|runner|fetcher|transport|adapter|client|repositories?|repo|store|storage|database|db|gateway|logger|clock|cache|queue|scheduler|publisher|writer|reader|validator|authorizer|connector|provider|api)$/i;
  const BUILTIN_TYPE_RE =
    /^(?:string|number|boolean|bigint|symbol|String|Number|Boolean|BigInt|Symbol|Buffer|Uint(?:8|8Clamped|16|32|Big64|8|16|32)Array|Int(?:8|16|32|Big64)Array|Float(?:32|64)Array|ArrayBuffer|SharedArrayBuffer|DataView|ReadonlyArray|Array|Date|RegExp|Map|Set|WeakMap|WeakSet|URL|URLSearchParams)(?:\s*<|\s*\[|\s*\||\s*&|$)/i;

  const isFunctionLike = (node) =>
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node);

  const addBindingNames = (name, into, binding) => {
    if (ts.isIdentifier(name)) {
      into.set(name.text, binding);
      return;
    }
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) addBindingNames(element.name, into, binding);
      }
    }
  };

  const imported = new Set();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const clause = statement.importClause;
      if (clause.name) imported.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        imported.add(clause.namedBindings.name.text);
      } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!element.isTypeOnly) imported.add(element.name.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)) {
      imported.add(statement.name.text);
    }
  }

  const directLexicalBindings = (container) => {
    const bindings = new Map();
    const visitDeclarations = (node) => {
      if (node !== container && (isFunctionLike(node) || ts.isBlock(node))) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          bindings.set(node.name.text, { kind: 'local' });
        }
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        const list = node.parent;
        if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0) {
          addBindingNames(node.name, bindings, { kind: 'local' });
        }
      } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
        bindings.set(node.name.text, { kind: 'local' });
      }
      ts.forEachChild(node, visitDeclarations);
    };
    visitDeclarations(container);
    return bindings;
  };

  const functionScopedVars = (node) => {
    const bindings = new Map();
    const visitVars = (current) => {
      if (current !== node && isFunctionLike(current)) return;
      if (ts.isVariableDeclaration(current)) {
        const list = current.parent;
        if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0) {
          addBindingNames(current.name, bindings, { kind: 'local' });
        }
      }
      ts.forEachChild(current, visitVars);
    };
    if (node.body) visitVars(node.body);
    return bindings;
  };

  const isInlineCallback = (node) => {
    let current = node;
    while (current.parent && (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent))) {
      current = current.parent;
    }
    const parent = current.parent;
    return (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      (parent.arguments ?? []).some((argument) => argument === current)
    );
  };

  const typeName = (typeNode) => {
    if (!typeNode) return '';
    if (ts.isTypeReferenceNode(typeNode)) return typeNode.typeName.getText(source);
    return '';
  };

  const isBuiltinType = (typeNode) => {
    if (!typeNode) return false;
    if ([
      ts.SyntaxKind.StringKeyword,
      ts.SyntaxKind.NumberKeyword,
      ts.SyntaxKind.BooleanKeyword,
      ts.SyntaxKind.BigIntKeyword,
      ts.SyntaxKind.SymbolKeyword,
    ].includes(typeNode.kind)) return true;
    if (ts.isUnionTypeNode(typeNode)) {
      const meaningful = typeNode.types.filter(
        (part) => part.kind !== ts.SyntaxKind.UndefinedKeyword && part.kind !== ts.SyntaxKind.NullKeyword,
      );
      return meaningful.length > 0 && meaningful.every(isBuiltinType);
    }
    if (ts.isArrayTypeNode(typeNode)) return true;
    if (ts.isTypeReferenceNode(typeNode)) {
      const name = typeName(typeNode);
      return BUILTIN_TYPE_RE.test(name);
    }
    return false;
  };

  const isInjectedType = (typeNode) => {
    if (!typeNode) return false;
    if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
      return typeNode.types.some(isInjectedType);
    }
    return INJECTED_TYPE_NAME_RE.test(typeName(typeNode));
  };

  const isInjectedParameter = (param, callback) => {
    if (callback || isBuiltinType(param.type)) return false;
    const names = new Map();
    addBindingNames(param.name, names, { kind: 'parameter' });
    return [...names.keys()].some((name) => INJECTED_PARAM_NAME_RE.test(name)) || isInjectedType(param.type);
  };

  const scopes = [{ kind: 'module', bindings: new Map() }];
  for (const name of imported) scopes[0].bindings.set(name, { kind: 'import' });
  for (const [name, binding] of directLexicalBindings(source)) scopes[0].bindings.set(name, binding);

  const resolveBinding = (name) => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      const binding = scopes[index].bindings.get(name);
      if (binding) return binding;
    }
    return null;
  };

  const isSeamBinding = (binding) =>
    Boolean(binding && (binding.kind === 'import' || (binding.kind === 'parameter' && binding.injected)));

  const rootIdentifier = (expression) => {
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    }
    return ts.isIdentifier(current) ? current : null;
  };

  const terminalMember = (expression) => {
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
        (ts.isStringLiteral(expression.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(expression.argumentExpression))) {
      return expression.argumentExpression.text;
    }
    return null;
  };

  /** Imported calls and injected dependency/context parameters are seams; local values are not. */
  const seamDetailsFor = (callee) => {
    if (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee)) {
      return seamDetailsFor(callee.expression);
    }
    // `(deps.optionalSeam ?? fallback)(args)` — the optional-seam-with-a-default idiom. The
    // callee is a BINARY expression, which has no root identifier, so this call was invisible
    // and a NEW such call reported zero added call sites (EI-23824032487848760). Either operand
    // may be the injected one.
    if (
      ts.isBinaryExpression(callee) &&
      (callee.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        callee.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      return seamDetailsFor(callee.left) ?? seamDetailsFor(callee.right);
    }
    const root = rootIdentifier(callee);
    if (!root) return null;
    const binding = resolveBinding(root.text);
    if (!isSeamBinding(binding)) return null;
    if (binding.kind === 'parameter' && binding.builtinReceiver) return null;
    const member = terminalMember(callee);
    if (binding.kind === 'parameter' && member && BUILTIN_METHODS.has(member)) return null;
    return {
      key: ts.isIdentifier(callee) ? `${root.text}()` : callee.getText(source),
      kind: binding.kind,
    };
  };

  const visit = (node) => {
    const pushed = [];
    if (isFunctionLike(node)) {
      const bindings = functionScopedVars(node);
      const callback = isInlineCallback(node);
      if (node.name && ts.isIdentifier(node.name)) bindings.set(node.name.text, { kind: 'local' });
      for (const param of node.parameters ?? []) {
        const injected = isInjectedParameter(param, callback);
        addBindingNames(param.name, bindings, {
          kind: 'parameter',
          injected,
          builtinReceiver: isBuiltinType(param.type),
        });
      }
      scopes.push({ kind: 'function', bindings });
      pushed.push('function');
    }
    if (ts.isBlock(node) || ts.isSourceFile(node)) {
      scopes.push({ kind: 'block', bindings: directLexicalBindings(node) });
      pushed.push('block');
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const bindings = new Map();
      addBindingNames(node.variableDeclaration.name, bindings, { kind: 'local' });
      scopes.push({ kind: 'catch', bindings });
      pushed.push('catch');
    }

    // Preserve a seam's identity through a local alias (`const fetcher = deps.fetcher`).
    // The initializer must resolve to an imported or explicitly injected binding; an
    // arbitrary local value or callback parameter never acquires seam status by its name.
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const root = rootIdentifier(node.initializer);
      const sourceBinding = root ? resolveBinding(root.text) : null;
      if (isSeamBinding(sourceBinding)) {
        const aliasBinding = sourceBinding.kind === 'import'
          ? { kind: 'import' }
          : { kind: 'parameter', injected: true, builtinReceiver: false };
        const aliases = new Map();
        addBindingNames(node.name, aliases, aliasBinding);
        for (const [name, binding] of aliases) {
          for (let index = scopes.length - 1; index >= 0; index -= 1) {
            if (!scopes[index].bindings.has(name)) continue;
            scopes[index].bindings.set(name, binding);
            break;
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const details = seamDetailsFor(node.expression);
      if (details) {
        callSites.push({ start: node.getStart(source), end: node.getEnd(), seam: details.key, kind: details.kind });
      }
    }

    ts.forEachChild(node, visit);
    for (let index = pushed.length - 1; index >= 0; index -= 1) scopes.pop();
  };

  ts.forEachChild(source, visit);
  return callSites;
}

export function seamCallCounts(text, fileName = 'file.ts') {
  const counts = new Map();
  for (const { seam } of seamCallSites(text, fileName)) {
    counts.set(seam, (counts.get(seam) ?? 0) + 1);
  }
  return counts;
}

/**
 * Seams whose call count went UP between `before` and `after`.
 *
 * 0 -> N counts as an increase: a collaborator that was never called cannot have had a
 * `toHaveBeenCalledTimes` assertion pass by accident, but it very commonly has a
 * `expect(x).not.toHaveBeenCalled()` — the same class, same blast radius.
 */
export function increasedSeams(beforeText, afterText, fileName = 'file.ts') {
  const before = seamCallCounts(beforeText, fileName);
  const after = seamCallCounts(afterText, fileName);
  const rows = [];
  for (const [key, count] of after) {
    const was = before.get(key) ?? 0;
    if (count > was) rows.push({ seam: key, before: was, after: count });
  }
  rows.sort((a, b) => b.after - b.before - (a.after - a.before) || a.seam.localeCompare(b.seam));
  return rows;
}

// ── the injected-member trigger: a Deps-shaped member gained an invoker (EI-23824032487848760) ──
//
// The strand this names is NOT a call-count change. A function gains a call to an OPTIONAL
// member of its injected Deps bundle; a test fixture that builds that bundle PARTIALLY never
// supplies the member, the new call reaches an uninjected dependency, throws, and the catch
// logs — which vitest-fail-on-console turns into a failure. The fixture asserts NOTHING about
// the new seam, so no call-count/order anchor can name it, and (the measured instance) it sits
// in the SAME workspace as the change, which the cross-workspace band excludes by design. The
// stable join key is the SIBLING members: the fixture injects the members that were already
// there and lacks the new one.

const parseTsx = (text, fileName) => {
  try {
    return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return null;
  }
};

const memberKeyText = (name) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    ? name.text
    : null;

/**
 * interface/type-literal name -> (member name -> declared OPTIONAL), for Deps-shaped types
 * declared in `source`. Optionality is the point: a REQUIRED member a fixture omits is a type
 * error `lint:tsc` reports, whereas an OPTIONAL one is silently omittable — the strand `tsc`
 * cannot see.
 */
function depsInterfaceMembers(source) {
  const out = new Map();
  for (const statement of source.statements) {
    let name = null;
    let members = null;
    if (ts.isInterfaceDeclaration(statement)) {
      name = statement.name.text;
      members = statement.members;
    } else if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
      name = statement.name.text;
      members = statement.type.members;
    }
    if (!name || !members || !INJECTED_TYPE_NAME_RE.test(name)) continue;
    const names = new Map();
    for (const member of members) {
      const text = (ts.isPropertySignature(member) || ts.isMethodSignature(member)) && memberKeyText(member.name);
      if (text) names.set(text, Boolean(member.questionToken));
    }
    if (names.size > 0) out.set(name, names);
  }
  return out;
}

/** `x.m` / `x['m']` -> `m`. */
function accessedMember(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return memberKeyText(node.argumentExpression);
  return null;
}

/**
 * Is `node` the thing a call invokes, looking through the wrappers that do not change WHICH
 * expression runs: `(x)`, `x!`, `x as T`, and the optional-seam default idiom `(x ?? fb)()`.
 */
function isInvokedThroughWrappers(node) {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (!parent) return false;
    if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
      current = parent;
      continue;
    }
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        parent.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      current = parent;
      continue;
    }
    return ts.isCallExpression(parent) && parent.expression === current;
  }
}

function memberInvocationCounts(source, names) {
  const counts = new Map();
  const visit = (node) => {
    const member = accessedMember(node);
    if (member && names.has(member) && isInvokedThroughWrappers(node)) {
      counts.set(member, (counts.get(member) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
}

/**
 * Members of an injected Deps bundle whose INVOCATION count rose between `before` and `after`.
 *
 * Two sources, merged by member:
 *  - `interface`: members declared by a Deps-shaped interface / type literal IN this file, counted
 *    wherever they are invoked — through a factory-built local (`const deps = makeDeps(o)`, which
 *    the receiver-based seam walk cannot see) and through `(deps.m ?? fb)(…)`.
 *  - `receiver`: `param.member` seams on an injected PARAMETER whose call count rose (the bundle's
 *    interface may live in another file); siblings are the other members called on that receiver.
 *
 * Each row carries `siblings` — the members already on the bundle, which is the join key against
 * partial fixtures. A row with no siblings is dropped: there is nothing to match a fixture on.
 */
export function invokedInjectedMembers(beforeText, afterText, fileName = 'file.ts') {
  const beforeSource = parseTsx(beforeText, fileName);
  const afterSource = parseTsx(afterText, fileName);
  if (!beforeSource || !afterSource) return [];
  const rows = new Map();

  const afterTypes = depsInterfaceMembers(afterSource);
  const names = new Set();
  for (const members of [...depsInterfaceMembers(beforeSource).values(), ...afterTypes.values()]) {
    for (const member of members.keys()) names.add(member);
  }
  if (names.size > 0) {
    const was = memberInvocationCounts(beforeSource, names);
    for (const [member, count] of memberInvocationCounts(afterSource, names)) {
      const before = was.get(member) ?? 0;
      if (count <= before) continue;
      // Only members declared OPTIONAL: a required one a fixture omits is a `lint:tsc` error.
      const owners = [...afterTypes].filter(([, members]) => members.get(member) === true);
      if (owners.length === 0) continue;
      const siblings = [...new Set(owners.flatMap(([, members]) => [...members.keys()]))]
        .filter((m) => m !== member)
        .sort();
      rows.set(member, { member, owner: owners.map(([n]) => n).join('|'), source: 'interface', before, after: count, siblings });
    }
  }

  const receiverCalls = (text, source) => {
    const byKey = new Map();
    for (const site of seamCallSites(text, fileName, source)) {
      if (site.kind !== 'parameter') continue;
      const key = site.seam.replace(/\?\./g, '.').replace(/!/g, '');
      if (!key.includes('.') || key.endsWith(')')) continue;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    return byKey;
  };
  const receiverBefore = receiverCalls(beforeText, beforeSource);
  const receiverAfter = receiverCalls(afterText, afterSource);
  for (const [key, count] of receiverAfter) {
    const before = receiverBefore.get(key) ?? 0;
    if (count <= before) continue;
    const cut = key.lastIndexOf('.');
    const receiver = key.slice(0, cut);
    const member = key.slice(cut + 1);
    if (rows.has(member) || !/^[A-Za-z_$][\w$]*$/.test(member)) continue;
    const siblings = [...receiverAfter.keys()]
      .filter((k) => k.startsWith(`${receiver}.`) && k !== key && !k.slice(receiver.length + 1).includes('.'))
      .map((k) => k.slice(receiver.length + 1))
      .sort();
    rows.set(member, { member, owner: receiver, source: 'receiver', before, after: count, siblings });
  }

  return [...rows.values()].filter((row) => row.siblings.length > 0).sort((a, b) => a.member.localeCompare(b.member));
}

/** Names a fixture object literal supplies: `{ a: 1 }`, `{ a }`, `{ a() {} }`. */
function objectLiteralKeys(literal) {
  const keys = new Set();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) {
      const key = memberKeyText(property.name);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * Test files holding a PARTIAL fixture for an injected member: an object literal that names at
 * least `min(2, siblings)` sibling members of the bundle but NOT the new member. The fixture
 * must also be in a test that directly imports the changed module. Transitive reachability is
 * useful for assertion strands, but it lets generic keys such as `sql`, `workspaceId`, and `log`
 * make unrelated fixtures look like this dependency bundle.
 *
 * Over-names on purpose (a literal that overrides two members of a `{ ...base }` spread matches
 * too): running the named file is the detector, and a clean bill for a real strand is the failure.
 *
 * @returns {{ file: string, hits: { member: string, line: number, present: string[] }[] }[]}
 */
export function partialInjectionFixtures({ tests, readFile, injections, directlyImportsSource }) {
  const usable = injections.filter((inj) => inj.siblings.length > 0);
  if (usable.length === 0) return [];
  const result = [];
  for (const file of tests) {
    const raw = readFile(file);
    if (!raw || raw.length > MAX_SCAN_BYTES) continue;
    const candidates = usable.filter((inj) => {
      if (
        inj.sourceFile &&
        (typeof directlyImportsSource !== 'function' || !directlyImportsSource(file, inj.sourceFile))
      ) {
        return false;
      }
      const need = Math.min(2, inj.siblings.length);
      let seen = 0;
      for (const sibling of inj.siblings) if (raw.includes(sibling) && ++seen >= need) return true;
      return false;
    });
    if (candidates.length === 0) continue;
    const source = parseTsx(raw, file);
    if (!source) continue;
    const best = new Map();
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = objectLiteralKeys(node);
        for (const inj of candidates) {
          if (keys.has(inj.member)) continue;
          const present = inj.siblings.filter((s) => keys.has(s));
          if (present.length < Math.min(2, inj.siblings.length)) continue;
          const hitKey = [inj.sourceFile ?? inj.owner, inj.member].join('\0');
          const prior = best.get(hitKey);
          if (!prior || present.length > prior.present.length) {
            best.set(hitKey, {
              member: inj.member,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              present,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (best.size > 0) result.push({ file, hits: [...best.values()] });
  }
  return result.sort(
    (a, b) =>
      Math.max(...b.hits.map((h) => h.present.length)) - Math.max(...a.hits.map((h) => h.present.length)) ||
      a.file.localeCompare(b.file),
  );
}

// ── the semantic trigger: a dependency-bearing call's control-flow path changed ─────────

/**
 * The control-flow tokens that matter to an injected call's invocation multiplicity. This is
 * deliberately a small AST summary, not a second execution engine: a dependency call inside
 * a function whose break/continue/return/throw/branch structure changed is a prompt to inspect
 * downstream invocation-sequence assertions. The guard is advisory, so naming a few extra
 * tests is safer than trying to prove path equivalence statically.
 */
function controlFlowToken(node, sourceFile, fileName) {
  if (ts.isIfStatement(node)) {
    const condition = normalisedExpressionText(node.expression, sourceFile, fileName);
    return `if:${condition}${node.elseStatement ? ':else' : ''}`;
  }
  if (ts.isForStatement(node)) {
    return `for:${node.condition ? normalisedExpressionText(node.condition, sourceFile, fileName) : '<none>'}`;
  }
  if (ts.isForInStatement(node)) return 'for-in';
  if (ts.isForOfStatement(node)) return 'for-of';
  if (ts.isWhileStatement(node)) {
    return `while:${normalisedExpressionText(node.expression, sourceFile, fileName)}`;
  }
  if (ts.isDoStatement(node)) {
    return `do-while:${normalisedExpressionText(node.expression, sourceFile, fileName)}`;
  }
  if (ts.isSwitchStatement(node)) {
    return `switch:${normalisedExpressionText(node.expression, sourceFile, fileName)}`;
  }
  if (ts.isCaseClause(node)) return `case:${normalisedExpressionText(node.expression, sourceFile, fileName)}`;
  if (ts.isDefaultClause(node)) return 'default';
  if (ts.isBreakStatement(node)) return `break:${node.label?.text ?? ''}`;
  if (ts.isContinueStatement(node)) return `continue:${node.label?.text ?? ''}`;
  if (ts.isReturnStatement(node)) return `return:${node.expression ? 'value' : 'void'}`;
  if (ts.isThrowStatement(node)) return 'throw';
  if (ts.isCatchClause(node)) return 'catch';
  return null;
}

function callableIdentity(node, sourceFile, anonymousOrdinal) {
  if (node.name) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    const name = propertyNameText(parent.name);
    if (name) return name;
  }
  return `<anonymous:${anonymousOrdinal}>`;
}

function callableScopeLabel(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return `variable:${node.name.text}`;
  }
  if (ts.isPropertyAssignment(node)) {
    const name = propertyNameText(node.name);
    if (name) return `property:${name}`;
  }
  if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
    return `class:${node.name.text}`;
  }
  return null;
}

function isLoopStatement(node) {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node)
  );
}

function loopHeaderCallExecutesOnce(callNode, loopNode) {
  if (ts.isForStatement(loopNode)) {
    return Boolean(loopNode.initializer && isWithinNode(callNode, loopNode.initializer));
  }
  if (ts.isForInStatement(loopNode) || ts.isForOfStatement(loopNode)) {
    return isWithinNode(callNode, loopNode.expression);
  }
  return false;
}

function isAbruptFlowNode(node) {
  return (
    ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) ||
    ts.isBreakStatement(node) ||
    ts.isContinueStatement(node)
  );
}

function ifBranchFor(node, ifStatement) {
  if (isWithinNode(node, ifStatement.thenStatement)) return 'then';
  if (ifStatement.elseStatement && isWithinNode(node, ifStatement.elseStatement)) return 'else';
  if (isWithinNode(node, ifStatement.expression)) return 'condition';
  return null;
}

function nearestConstScope(node, functionNode) {
  for (let current = node.parent; current && current !== functionNode; current = current.parent) {
    if (ts.isBlock(current) || ts.isCaseBlock(current) || isLoopStatement(current)) return current;
  }
  return functionNode;
}

function lexicalDistance(node, ancestor) {
  // The cursor is read after the loop, so it must live outside it (WI-10005809: a loop-scoped
  // `let` here threw `ReferenceError: current is not defined` on every const-bound seam argument).
  let distance = 0;
  let current = node;
  for (; current && current !== ancestor; current = current.parent) distance++;
  return current === ancestor ? distance : Number.MAX_SAFE_INTEGER;
}

function visibleConstBinding(identifier, bindings, sourceFile) {
  const start = identifier.getStart(sourceFile);
  return bindings
    .filter(
      (binding) =>
        binding.name === identifier.text &&
        binding.node.getStart(sourceFile) < start &&
        isWithinNode(identifier, binding.scope),
    )
    .sort(
      (a, b) =>
        lexicalDistance(identifier, a.scope) - lexicalDistance(identifier, b.scope) ||
        b.node.getStart(sourceFile) - a.node.getStart(sourceFile),
    )[0];
}

function conjunctionTerms(node, result = []) {
  if (ts.isParenthesizedExpression(node)) return conjunctionTerms(node.expression, result);
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    conjunctionTerms(node.left, result);
    conjunctionTerms(node.right, result);
  } else {
    result.push(node);
  }
  return result;
}

function canonicalFlowExpression(
  node,
  sourceFile,
  fileName,
  bindings,
  knownTruthy = new Set(),
  resolving = new Set(),
) {
  if (ts.isParenthesizedExpression(node)) {
    return canonicalFlowExpression(
      node.expression,
      sourceFile,
      fileName,
      bindings,
      knownTruthy,
      resolving,
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    const truthy = new Set(knownTruthy);
    const prefix = [];
    const terms = conjunctionTerms(node);
    for (const term of terms) {
      const value = canonicalFlowExpression(
        term,
        sourceFile,
        fileName,
        bindings,
        truthy,
        resolving,
      );
      prefix.push(value);
      truthy.add(value);
      truthy.add(prefix.join(' && '));
    }
    return prefix.join(' && ');
  }
  if (ts.isIdentifier(node)) {
    const binding = visibleConstBinding(node, bindings, sourceFile);
    if (binding && !resolving.has(binding.name)) {
      const nextResolving = new Set(resolving);
      nextResolving.add(binding.name);
      return canonicalFlowExpression(
        binding.initializer,
        sourceFile,
        fileName,
        bindings,
        knownTruthy,
        nextResolving,
      );
    }
    return normalisedExpressionText(node, sourceFile, fileName);
  }
  if (ts.isConditionalExpression(node)) {
    const condition = canonicalFlowExpression(
      node.condition,
      sourceFile,
      fileName,
      bindings,
      knownTruthy,
      resolving,
    );
    if (knownTruthy.has(condition)) {
      return canonicalFlowExpression(
        node.whenTrue,
        sourceFile,
        fileName,
        bindings,
        knownTruthy,
        resolving,
      );
    }
    const whenTrue = canonicalFlowExpression(
      node.whenTrue,
      sourceFile,
      fileName,
      bindings,
      new Set([...knownTruthy, condition]),
      resolving,
    );
    const whenFalse = canonicalFlowExpression(
      node.whenFalse,
      sourceFile,
      fileName,
      bindings,
      knownTruthy,
      resolving,
    );
    return '(' + condition + ' ? ' + whenTrue + ' : ' + whenFalse + ')';
  }
  return normalisedExpressionText(node, sourceFile, fileName);
}

function mutuallyExclusiveIfBranches(a, b, functionNode) {
  for (let parent = a.parent; parent && parent !== functionNode; parent = parent.parent) {
    if (!ts.isIfStatement(parent)) continue;
    const aBranch = ifBranchFor(a, parent);
    const bBranch = ifBranchFor(b, parent);
    if (
      aBranch &&
      bBranch &&
      aBranch !== 'condition' &&
      bBranch !== 'condition' &&
      aBranch !== bBranch
    ) {
      return true;
    }
  }
  return false;
}

function abruptFlowTarget(node) {
  const isBreak = ts.isBreakStatement(node);
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (isCallableNode(parent)) return null;
    if (isBreak && ts.isSwitchStatement(parent)) return parent;
    if (isLoopStatement(parent)) return parent;
  }
  return null;
}

function exitAffectsCall(exitNode, callNode, functionNode) {
  if (ts.isReturnStatement(exitNode) || ts.isThrowStatement(exitNode)) {
    return !mutuallyExclusiveIfBranches(exitNode, callNode, functionNode);
  }
  const target = abruptFlowTarget(exitNode);
  return Boolean(
    target &&
      isWithinNode(callNode, target) &&
      !mutuallyExclusiveIfBranches(exitNode, callNode, functionNode),
  );
}

function exitAffectsLoopIterations(exitNode, loopNode) {
  if (ts.isReturnStatement(exitNode) || ts.isThrowStatement(exitNode)) return true;
  return abruptFlowTarget(exitNode) === loopNode;
}

function invocationFlowToken(node, child, sourceFile, fileName, bindings) {
  if (ts.isIfStatement(node)) {
    const condition = canonicalFlowExpression(node.expression, sourceFile, fileName, bindings);
    const branch = ifBranchFor(child, node) ?? 'outside';
    return 'if:' + condition + ':' + branch;
  }
  const token = controlFlowToken(node, sourceFile, fileName);
  if (!token) return null;
  if (isLoopStatement(node)) {
    return token + (isWithinNode(child, node.statement) ? ':body' : ':header');
  }
  return token;
}

function flowPathTokens(node, root, sourceFile, fileName, bindings, callNode = null) {
  const tokens = [];
  let child = node;
  for (let parent = node.parent; parent && parent !== root; parent = parent.parent) {
    const oneShotHeader = callNode && isLoopStatement(parent) && loopHeaderCallExecutesOnce(callNode, parent);
    const token = oneShotHeader
      ? null
      : invocationFlowToken(parent, child, sourceFile, fileName, bindings);
    if (token) tokens.push(token);
    child = parent;
  }
  return tokens.reverse();
}

function seamInvocationContext(callNode, functionNode, flowNodes, sourceFile, fileName, bindings) {
  const callStart = callNode.getStart(sourceFile);
  const context = flowPathTokens(callNode, functionNode, sourceFile, fileName, bindings, callNode).map(
    (token) => 'path:' + token,
  );

  for (const { node, token } of flowNodes) {
    if (
      !isAbruptFlowNode(node) ||
      node.getStart(sourceFile) >= callStart ||
      !exitAffectsCall(node, callNode, functionNode)
    ) {
      continue;
    }
    const path = flowPathTokens(node, functionNode, sourceFile, fileName, bindings);
    context.push('prior-exit:' + [...path, token].join(' > '));
  }

  const enclosingLoops = flowNodes
    .filter(
      ({ node }) =>
        isLoopStatement(node) &&
        isWithinNode(callNode, node) &&
        !loopHeaderCallExecutesOnce(callNode, node),
    )
    .sort((a, b) => a.node.getStart(sourceFile) - b.node.getStart(sourceFile));
  for (const loop of enclosingLoops) {
    for (const exit of flowNodes) {
      if (
        !isAbruptFlowNode(exit.node) ||
        !isWithinNode(exit.node, loop.node.statement) ||
        !exitAffectsLoopIterations(exit.node, loop.node)
      ) {
        continue;
      }
      const relation = exit.node.getStart(sourceFile) < callStart ? 'before' : 'after';
      const path = flowPathTokens(exit.node, loop.node, sourceFile, fileName, bindings);
      context.push(
        'loop-exit:' +
          loop.token +
          ':' +
          relation +
          ':' +
          [...path, exit.token].join(' > '),
      );
    }
  }

  return context;
}

/**
 * Summarise each function that calls an injected collaborator. Nested functions are recorded
 * independently; a captured outer parameter is still a seam in the nested function, while
 * control-flow context from the nested body does not contaminate the outer function's identity.
 */
export function seamControlFlowRecords(text, fileName = 'file.ts') {
  let source;
  try {
    source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return [];
  }

  const seamSites = new Map(
    seamCallSites(text, fileName, source).map(({ start, end, seam }) => [`${start}:${end}`, seam]),
  );
  const functionStack = [];
  const callableScope = [];
  const records = [];
  let anonymousOrdinal = 0;
  const visit = (node) => {
    const isFunctionLike = isCallableNode(node);
    if (isFunctionLike) {
      const name = callableIdentity(node, source, anonymousOrdinal++);
      const record = {
        function: name,
        // A display name alone is not unique: separate injected-search sources all
        // have a `lexical` method. Include stable named containers so a harmless
        // edit cannot compare one sibling's flow against another's.
        identity: [...callableScope, `function:${name}`].join('/'),
        seams: [],
        controlFlow: [],
        seamContexts: [],
        _node: node,
        _parentRecord: functionStack.at(-1) ?? null,
        _flowNodes: [],
        _seamOccurrences: [],
        _constBindings: [],
      };
      records.push(record);
      functionStack.push(record);
      callableScope.push(`function:${name}`);
    }

    const scopeLabel = isFunctionLike ? null : callableScopeLabel(node);
    if (scopeLabel) callableScope.push(scopeLabel);

    const current = functionStack.at(-1);
    if (current) {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        current._constBindings.push({
          name: node.name.text,
          node,
          initializer: node.initializer,
          scope: nearestConstScope(node, current._node),
        });
      }
      const token = controlFlowToken(node, source, fileName);
      if (token) {
        current.controlFlow.push(token);
        current._flowNodes.push({ node, token });
      }
      if (ts.isCallExpression(node)) {
        const seam = seamSites.get(`${node.getStart(source)}:${node.getEnd()}`) ?? null;
        if (seam) {
          current.seams.push(seam);
          current._seamOccurrences.push({ node, seam });
        }
      }
    }

    ts.forEachChild(node, visit);
    if (scopeLabel) callableScope.pop();
    if (isFunctionLike) functionStack.pop();
    if (isFunctionLike) callableScope.pop();
  };
  ts.forEachChild(source, visit);
  return records
    .filter((record) => record.seams.length > 0)
    .map((record) => {
      const bindings = [];
      for (let owner = record; owner; owner = owner._parentRecord) {
        bindings.push(...owner._constBindings);
      }
      return {
        function: record.function,
        identity: record.identity,
        seams: record.seams,
        controlFlow: record.controlFlow,
        seamContexts: record._seamOccurrences.map(({ node, seam }) => ({
          seam,
          context: seamInvocationContext(
            node,
            record._node,
            record._flowNodes,
            source,
            fileName,
            bindings,
          ),
        })),
      };
    });
}

/**
 * Functions where the dependency call count stayed stable but its control-flow summary did
 * not. This catches a call whose loop eligibility changed (the WI-10001694 shape) without
 * claiming that every arbitrary edit to a function is a strand trigger.
 */
export function changedSeamControlFlow(beforeText, afterText, fileName = 'file.ts') {
  const before = seamControlFlowRecords(beforeText, fileName);
  const after = seamControlFlowRecords(afterText, fileName);
  const beforeByFunction = new Map(before.map((record) => [record.identity, record]));
  const rows = [];
  for (const record of after) {
    const prior = beforeByFunction.get(record.identity);
    if (!prior) continue;
    const beforeCounts = new Map();
    for (const seam of prior.seams) beforeCounts.set(seam, (beforeCounts.get(seam) ?? 0) + 1);
    const afterCounts = new Map();
    for (const seam of record.seams) afterCounts.set(seam, (afterCounts.get(seam) ?? 0) + 1);
    for (const [seam, count] of afterCounts) {
      if (count !== (beforeCounts.get(seam) ?? 0)) continue;
      const beforeContexts = prior.seamContexts
        .filter((entry) => entry.seam === seam)
        .map((entry) => entry.context.join('\u0000'));
      const afterContexts = record.seamContexts
        .filter((entry) => entry.seam === seam)
        .map((entry) => entry.context.join('\u0000'));
      if (JSON.stringify(beforeContexts) === JSON.stringify(afterContexts)) continue;
      rows.push({
        function: record.function,
        seam,
        before: beforeContexts,
        after: afterContexts,
        reason: 'control-flow-changed',
      });
    }
  }
  return rows;
}

// ── the second trigger: a writer's output value changed ─────────────────────────────────

/**
 * Identifiers that commonly hold an object which is about to be returned or persisted.
 * This is intentionally a vocabulary, not a claim that a variable named `data` is always
 * durable. The detector is advisory and the downstream assertion/property join below is
 * the precision step; keeping this list broad prevents a new writer spelling from silently
 * becoming an unobserved blind spot.
 */
const OUTPUT_BINDING_TERMS_RE =
  /(?:^|[\s_-])(?:patch|metadata|record|row|snapshot|payload|values|changes|update|output|result|data|state|settings|document|entry|fields|attributes|body)(?:$|[\s_-])/;

/** Function/call names that indicate an object is being written or published. */
const WRITER_TERMS_RE =
  /(?:^|[\s_-])(?:insert|update|upsert|save|write|persist|patch|replace|put|set|values|create|record|store|snapshot|rollup|refresh|commit|publish)(?:$|[\s_-])/;

function normaliseIdentifier(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9_$-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function looksLikeOutputBinding(name) {
  return OUTPUT_BINDING_TERMS_RE.test(normaliseIdentifier(name));
}

function looksLikeWriterName(name) {
  return WRITER_TERMS_RE.test(normaliseIdentifier(name));
}

function terminalCallName(expression, sourceFile) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) return current.name.text;
    if (ts.isStringLiteral(current.argumentExpression)) return current.argumentExpression.text;
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : current.getText(sourceFile);
}

function isWriterCall(call, sourceFile) {
  return looksLikeWriterName(terminalCallName(call.expression, sourceFile));
}

function enclosingCallableName(node, sourceFile) {
  let current = node.parent;
  while (current) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isFunctionExpression(current) ||
        ts.isArrowFunction(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isConstructorDeclaration(current)) &&
      current.name
    ) {
      return current.name.getText(sourceFile);
    }
    current = current.parent;
  }
  return '';
}

/**
 * Is this object literal plausibly an output object rather than an unrelated local? The
 * positive contexts are deliberately structural: a returned object, a writer-call
 * argument, an output-shaped binding (`patch`/`metadata`/`row`/…), or a function whose name
 * says it writes. Nested object literals inherit the context from their enclosing object.
 */
function isLikelyOutputObject(objectLiteral, sourceFile) {
  let current = objectLiteral;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent)) return true;
    if (ts.isArrowFunction(parent) && parent.body === current) return true;
    if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === current)) {
      if (isWriterCall(parent, sourceFile)) return true;
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
      if (looksLikeOutputBinding(parent.name.text)) return true;
    }
    current = parent;
  }
  return looksLikeWriterName(enclosingCallableName(objectLiteral, sourceFile));
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)) return expression.text;
  }
  return null;
}

function normalisedExpressionText(node, sourceFile, fileName) {
  const raw = node.getText(sourceFile);
  let normalised = stripCommentsOnly(raw, fileName) || raw;
  const nodeStart = node.getStart(sourceFile);
  const literals = [];
  const visit = (current) => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      literals.push({
        start: current.getStart(sourceFile) - nodeStart,
        end: current.getEnd() - nodeStart,
        value: JSON.stringify(current.text),
      });
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  for (const literal of literals.sort((a, b) => b.start - a.start)) {
    normalised = normalised.slice(0, literal.start) + literal.value + normalised.slice(literal.end);
  }
  return normalised.replace(/\s+/g, ' ').trim();
}

/** Whether `node` is inside `candidate` before reaching `boundary` in the AST. */
function isWithinNode(node, candidate, boundary) {
  let current = node;
  while (current && current !== boundary) {
    if (current === candidate) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Build an identity for one output object that survives insertion of a sibling object.
 *
 * Property-name occurrence is not an identity: two returned objects with the same
 * `status`/`code`/`reason` fields are common, and inserting one shifts every property
 * array in the old implementation. The enclosing callable plus structural boundaries
 * (return/binding/writer and control-flow branch) identify the object without depending
 * on source-order offsets or on the value expression that may legitimately change.
 */
function outputObjectStructuralIdentity(objectLiteral, sourceFile, fileName) {
  const callable = enclosingCallableName(objectLiteral, sourceFile) || '<module>';
  const context = [];
  let current = objectLiteral;
  while (current?.parent) {
    const parent = current.parent;
    if (ts.isReturnStatement(parent) && parent.expression === current) context.push('return');
    if (ts.isArrowFunction(parent) && parent.body === current) context.push('arrow-return');
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name)) {
      context.push(`binding:${parent.name.text}`);
    }
    if (ts.isCallExpression(parent) && parent.arguments.some((arg) => arg === current) && isWriterCall(parent, sourceFile)) {
      context.push(`writer:${terminalCallName(parent.expression, sourceFile)}`);
    }
    if (ts.isIfStatement(parent)) {
      const branch = isWithinNode(current, parent.thenStatement, parent)
        ? 'then'
        : parent.elseStatement && isWithinNode(current, parent.elseStatement, parent)
          ? 'else'
          : null;
      if (branch) context.push(`if:${normalisedExpressionText(parent.expression, sourceFile, fileName)}:${branch}`);
    }
    if (ts.isConditionalExpression(parent)) {
      const branch = isWithinNode(current, parent.whenTrue, parent)
        ? 'true'
        : isWithinNode(current, parent.whenFalse, parent)
          ? 'false'
          : null;
      if (branch) context.push(`conditional:${normalisedExpressionText(parent.condition, sourceFile, fileName)}:${branch}`);
    }
    current = parent;
  }
  const shape = objectLiteral.properties
    .map((property) => {
      if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        return propertyNameText(property.name) ?? '<computed>';
      }
      return '<spread>';
    })
    .join(',');
  return `${callable}|${context.reverse().join('>') || 'root'}|shape:${shape}`;
}

/**
 * Parse once per source text. Both the value collector and the return-topology collector
 * walk the same tree, and `ts.createSourceFile` dominates their cost — parsing per collector
 * measured a 93.5% regression on this file's own CLI path, which runs in an edit-time hook.
 */
function parseOutputSource(sourceText, fileName) {
  try {
    return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return null;
  }
}

/** Collect output values with an object identity in addition to the legacy property map. */
export function collectOutputPropertyRecords(sourceText, fileName = 'file.ts', parsed = undefined) {
  const sourceFile = parsed ?? parseOutputSource(sourceText, fileName);
  if (!sourceFile) return [];

  const records = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node) && isLikelyOutputObject(node, sourceFile)) {
      const properties = [...node.properties].filter(
        (property) => ts.isPropertyAssignment(property) && propertyNameText(property.name),
      );
      const objectIdentity = outputObjectStructuralIdentity(node, sourceFile, fileName);
      for (const [index, property] of properties.entries()) {
        const name = propertyNameText(property.name);
        if (!name) continue;
        const occurrence = properties.slice(0, index).filter((candidate) => propertyNameText(candidate.name) === name).length;
        records.push({
          property: name,
          value: normalisedExpressionText(property.initializer, sourceFile, fileName),
          identity: `${objectIdentity}|property:${name}|occurrence:${occurrence}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return records;
}

/**
 * Collect output-object property values as `property -> values in source order`.
 *
 * The property name is the stable join key: the writer's expression can be completely
 * rewritten (`rollup.potCents` -> a conditional) while a downstream test still reads
 * `spentCents`. Shorthand properties are omitted because there is no expression in the
 * object literal to diff; a later explicit assignment is still detected.
 */
export function collectOutputPropertyValues(sourceText, fileName = 'file.ts') {
  const values = new Map();
  for (const { property, value } of collectOutputPropertyRecords(sourceText, fileName)) {
    const list = values.get(property) ?? [];
    list.push(value);
    values.set(property, list);
  }
  return values;
}

/**
 * Name a callable stably enough to pair it across two versions of one file.
 *
 * Source position is deliberately NOT part of the key: an inserted branch shifts every
 * offset below it, which is exactly the drift this pairing has to survive.
 */
function namedCallableKey(node, sourceFile) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.getText(sourceFile);
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.getText(sourceFile);
  }
  if (parent && ts.isPropertyAssignment(parent)) return propertyNameText(parent.name);
  return null;
}

function isCallableNode(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The `if`/`case` that gates this return, or null when the return is reached unconditionally. */
function gatingBranchText(returnStatement, body, sourceFile, fileName) {
  let current = returnStatement.parent;
  while (current && current !== body) {
    if (ts.isIfStatement(current)) {
      const branch = isWithinNode(returnStatement, current.thenStatement, current) ? 'then' : 'else';
      return `if:${normalisedExpressionText(current.expression, sourceFile, fileName)}:${branch}`;
    }
    if (ts.isCaseClause(current)) {
      return `case:${normalisedExpressionText(current.expression, sourceFile, fileName)}`;
    }
    if (ts.isDefaultClause(current)) return 'case:<default>';
    if (
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current) ||
      ts.isTryStatement(current) ||
      ts.isCatchClause(current)
    ) {
      // Not a predicate we can pair across versions. Naming it conservatively means a new
      // return inside a loop/try is treated as pre-existing rather than as an interception.
      return 'gated:loop-or-try';
    }
    current = current.parent;
  }
  return null;
}

/**
 * Per callable: its unconditional fallthrough return, plus every return with its gate.
 *
 * This is the discriminator the value diff cannot supply. An inserted guarded return is
 * HARMLESS when unmatched inputs previously fell off the end of the callable — nothing
 * observable changed for them, which is precisely why `diffOutputValues` drops unpaired
 * insertions. It is a BEHAVIOURAL CHANGE when the callable ends in an unconditional return,
 * because the inputs the new predicate matches used to reach THAT return. Both shapes present
 * to the value diff identically ("the group grew by one"), so only the enclosing callable's
 * return topology separates them.
 */
function callableReturnTopology(sourceText, fileName = 'file.ts', parsed = undefined) {
  const sourceFile = parsed ?? parseOutputSource(sourceText, fileName);
  if (!sourceFile) return new Map();

  const topology = new Map();
  const record = (node) => {
    if (!isCallableNode(node) || !node.body || !ts.isBlock(node.body)) return;
    const key = namedCallableKey(node, sourceFile);
    if (!key) return;
    if (topology.has(key)) {
      // Two callables share this name, so pairing them across versions would be a guess.
      topology.set(key, null);
      return;
    }
    const body = node.body;
    const returns = [];
    const collect = (current) => {
      if (isCallableNode(current)) return; // a nested callable owns its own returns
      if (ts.isReturnStatement(current) && current.expression) {
        const objectLiteral = ts.isObjectLiteralExpression(current.expression) ? current.expression : null;
        returns.push({
          gate: gatingBranchText(current, body, sourceFile, fileName),
          pos: current.getStart(sourceFile),
          expressionText: normalisedExpressionText(current.expression, sourceFile, fileName),
          properties: objectLiteral
            ? new Map(
                objectLiteral.properties
                  .filter((property) => ts.isPropertyAssignment(property) && propertyNameText(property.name))
                  .map((property) => [
                    propertyNameText(property.name),
                    normalisedExpressionText(property.initializer, sourceFile, fileName),
                  ]),
              )
            : null,
        });
      }
      ts.forEachChild(current, collect);
    };
    ts.forEachChild(body, collect);

    const fallthrough = [...returns].reverse().find((entry) => entry.gate === null) ?? null;
    topology.set(key, { fallthrough, returns });
  };

  const visit = (node) => {
    record(node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return topology;
}

/**
 * Output properties whose value changed for inputs that ALREADY EXISTED, because a guarded
 * return was inserted above the callable's unconditional fallthrough return.
 *
 * Reported separately from `value-changed` because nothing was rewritten: every pre-existing
 * expression is still present, and the strand comes from traffic being re-routed away from
 * the fallthrough. The stranded tests are the ones asserting the fallthrough's values for an
 * input the new predicate now intercepts.
 */
function interceptingBranchChanges(beforeText, afterText, fileName = 'file.ts', parsedBefore = undefined, parsedAfter = undefined) {
  const before = callableReturnTopology(beforeText, fileName, parsedBefore);
  const after = callableReturnTopology(afterText, fileName, parsedAfter);
  const changes = [];

  for (const [key, afterEntry] of after) {
    const beforeEntry = before.get(key);
    if (!afterEntry || !beforeEntry) continue;

    // BOTH versions must end in an unconditional return. Absent in BEFORE, unmatched inputs
    // returned undefined and the new branch is genuinely additive. Absent in AFTER, the
    // callable lost its fallthrough — a larger change than an interception.
    const fallthrough = beforeEntry.fallthrough;
    if (!fallthrough || !afterEntry.fallthrough) continue;

    const existingGates = new Set(beforeEntry.returns.map((entry) => entry.gate).filter(Boolean));
    for (const candidate of afterEntry.returns) {
      if (!candidate.gate || !candidate.properties) continue;
      if (existingGates.has(candidate.gate)) continue; // the predicate already existed
      if (candidate.pos > afterEntry.fallthrough.pos) continue; // below the fallthrough: unreachable

      for (const [property, afterValue] of candidate.properties) {
        // An opaque fallthrough (a helper call) hides its own per-property values, so the
        // whole expression is the honest "before": a reader used to get whatever it returned.
        const beforeValue = fallthrough.properties ? fallthrough.properties.get(property) : fallthrough.expressionText;
        if (beforeValue === undefined) continue; // the fallthrough never emitted this property
        if (beforeValue === afterValue) continue;
        changes.push({ property, before: beforeValue, after: afterValue, reason: 'branch-intercepts-fallthrough' });
      }
    }
  }
  return changes;
}

/**
 * Output properties whose value expression changed between two versions of a writer.
 * Only properties present in both versions are reported: a newly-added property has no
 * pre-existing reader that could be stranded by this edit (the required-field guard owns
 * the separate "new shape" case).
 */
export function diffOutputValues(beforeText, afterText, fileName = 'file.ts') {
  // Parse each side ONCE and share the tree with both collectors below.
  const parsedBefore = parseOutputSource(beforeText, fileName);
  const parsedAfter = parseOutputSource(afterText, fileName);
  const beforeRecords = collectOutputPropertyRecords(beforeText, fileName, parsedBefore);
  const afterRecords = collectOutputPropertyRecords(afterText, fileName, parsedAfter);
  const beforeByIdentity = new Map();
  const afterByIdentity = new Map();
  for (const record of beforeRecords) {
    const list = beforeByIdentity.get(record.identity) ?? [];
    list.push(record);
    beforeByIdentity.set(record.identity, list);
  }
  for (const record of afterRecords) {
    const list = afterByIdentity.get(record.identity) ?? [];
    list.push(record);
    afterByIdentity.set(record.identity, list);
  }

  const changes = [];
  for (const [identity, afterGroup] of afterByIdentity) {
    const beforeGroup = beforeByIdentity.get(identity) ?? [];
    if (beforeGroup.length === 0) continue;

    // First consume exact values as anchors. This makes an inserted object harmless even
    // when it shares the same structural group: unchanged siblings pair with themselves,
    // while the unmatched insertion is never interpreted as a rewrite.
    const unmatchedBefore = [...beforeGroup];
    const unmatchedAfter = [];
    for (const after of afterGroup) {
      const exact = unmatchedBefore.findIndex((before) => before.value === after.value);
      if (exact >= 0) unmatchedBefore.splice(exact, 1);
      else unmatchedAfter.push(after);
    }

    // A structural identity is safe to pair directly when it is unique, or when the
    // before/after group cardinality is unchanged. If cardinality changed, the residue
    // may contain an insertion/deletion and positional pairing would recreate the bug.
    if (beforeGroup.length !== afterGroup.length) continue;
    const shared = Math.min(unmatchedBefore.length, unmatchedAfter.length);
    for (let i = 0; i < shared; i += 1) {
      const before = unmatchedBefore[i];
      const after = unmatchedAfter[i];
      if (before.value !== after.value) {
        changes.push({ property: after.property, before: before.value, after: after.value, reason: 'value-changed' });
      }
    }
  }
  // An inserted branch is never an unpaired "rewrite", so the loop above deliberately drops
  // it. Recover the harmful subset of those insertions from the callable's return topology.
  for (const intercepting of interceptingBranchChanges(beforeText, afterText, fileName, parsedBefore, parsedAfter)) {
    const alreadyReported = changes.some(
      (existing) => existing.property === intercepting.property && existing.after === intercepting.after,
    );
    if (!alreadyReported) changes.push(intercepting);
  }

  return changes.sort((a, b) => a.property.localeCompare(b.property) || a.before.localeCompare(b.before));
}

// Descriptive aliases keep the trigger vocabulary useful to callers without making the
// CLI's implementation depend on one particular name.
export const changedOutputValues = diffOutputValues;
export const diffPersistedOutputValues = diffOutputValues;

/**
 * Changed package-manager script values are observable contracts too: tests may pin the
 * command string even though package.json is not an importable JS/TS seam.
 * Returns null when either manifest is invalid, so the CLI can report NOT CHECKED.
 */
export function diffPackageScriptValues(beforeText, afterText) {
  const readScripts = (text) => {
    let manifest;
    try {
      manifest = JSON.parse(String(text));
    } catch {
      return null;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
    if (manifest.scripts === undefined || manifest.scripts === null) return new Map();
    if (typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)) return null;
    return new Map(Object.entries(manifest.scripts));
  };

  const before = readScripts(beforeText);
  const after = readScripts(afterText);
  if (!before || !after) return null;
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  return names.flatMap((property) => {
    const hasBefore = before.has(property);
    const hasAfter = after.has(property);
    const beforeValue = hasBefore ? JSON.stringify(before.get(property)) : '<missing>';
    const afterValue = hasAfter ? JSON.stringify(after.get(property)) : '<missing>';
    return beforeValue === afterValue ? [] : [{ property, before: beforeValue, after: afterValue }];
  });
}

/** Does an AST node contain a property read/fixture key matching one of the changed outputs? */
function nodeMentionsOutputProperty(node, wanted, sourceFile) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(current) && wanted.has(current.name.text)) {
      found = true;
      return;
    }
    if (
      ts.isElementAccessExpression(current) &&
      (ts.isStringLiteral(current.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(current.argumentExpression)) &&
      wanted.has(current.argumentExpression.text)
    ) {
      found = true;
      return;
    }
    if (ts.isPropertyAssignment(current) || ts.isShorthandPropertyAssignment(current)) {
      const property = propertyNameText(current.name);
      if (property && wanted.has(property)) {
        found = true;
        return;
      }
    }
    // `toHaveProperty('spentCents')` and similar matcher forms carry the join key as a
    // string rather than a property node. This is scoped to an assertion call below, so a
    // fixture's ordinary prose cannot make the whole test look relevant.
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      if (wanted.has(current.text)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function containsExpectCall(node) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === 'expect') {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function isAssertionCall(node, sourceFile) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression) && node.expression.text === 'expect') return true;
  if (containsExpectCall(node.expression)) return true;
  const name = node.expression.getText(sourceFile);
  return /(?:^|[.$])assert(?:$|[.$])/.test(name);
}

/**
 * Does a test assert on one of the changed output properties? Covers property reads,
 * element access, object-matchers, `toHaveProperty`, and assert.* calls while ignoring
 * comments and setup-only fixture objects. A value assertion need not use any one matcher;
 * the property join is the signal.
 */
export function hasValueAssertion(text, properties, fileName = 'test.ts') {
  const wanted = new Set((properties ?? []).filter((property) => typeof property === 'string' && property.length > 0));
  if (wanted.size === 0) return false;
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(fileName, String(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return false;
  }
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (isAssertionCall(node, sourceFile) && nodeMentionsOutputProperty(node, wanted, sourceFile)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

export const hasOutputValueAssertion = hasValueAssertion;

function isScriptsObject(node) {
  if (ts.isIdentifier(node)) return node.text === 'scripts';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'scripts';
  return (
    ts.isElementAccessExpression(node) &&
    (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
    node.argumentExpression.text === 'scripts'
  );
}

function packageScriptAccessName(node) {
  if (ts.isPropertyAccessExpression(node) && isScriptsObject(node.expression)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    isScriptsObject(node.expression) &&
    (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return null;
}

function nodeMentionsPackageScript(node, wanted) {
  let found = false;
  const visit = (current) => {
    if (found) return;
    const name = packageScriptAccessName(current);
    if (name !== null && wanted.has(name)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Does an assertion read one of the changed scripts.<name> values? */
export function hasPackageScriptAssertion(text, scriptNames, fileName = 'test.ts') {
  const wanted = new Set((scriptNames ?? []).filter((name) => typeof name === 'string' && name.length > 0));
  if (wanted.size === 0 || !String(text).includes('scripts')) return false;
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(fileName, String(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return false;
  }
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (isAssertionCall(node, sourceFile) && nodeMentionsPackageScript(node, wanted)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

// ── the blast radius: downstream assertions in OTHER workspaces ─────────────────────────

/**
 * Does this test file contain an assertion whose truth depends on a call COUNT or ORDER?
 *
 * Four independent forms, because each is a real spelling in this tree and a detector
 * that knew only the first would be exactly the form-blind guard the commissioning item
 * warns against: a count/order MATCHER name, a direct read of the call LOG, a negated
 * "was never called" (an assertion that the count stays 0), and an exact sequence assertion
 * over a mapped invocation log.
 */
export function hasCountOrOrderAssertion(text) {
  const stripped = stripCommentsOnly(String(text)) || String(text);
  return (
    COUNT_ORDER_MATCHER_RE.test(stripped) ||
    CALL_LOG_ACCESS_RE.test(stripped) ||
    NEGATED_CALLED_RE.test(stripped) ||
    INVOCATION_SEQUENCE_ASSERTION_RE.test(stripped)
  );
}

/**
 * Reverse-reachable files from `seeds` over the import graph.
 *
 * Forward edges are built once for the whole tree (submodules included) and inverted;
 * an unresolvable specifier drops an edge, which under-names tests, so package-name
 * resolution is given every manifest in the tree rather than only root workspaces.
 */
export function reverseReachable({ seeds, files, readFile, byDir, byEntryDir }) {
  const fileSet = new Set(files);
  const indexOf = new Map(files.map((f, i) => [f, i]));
  /** @type {Map<number, number[]>} target index -> importer indices */
  const importers = new Map();

  for (const file of files) {
    if (!IMPORTABLE_RE.test(file)) continue;
    // The specifier scan runs on RAW text, deliberately. The shared comment stripper is a
    // full TypeScript scan per file; over this population (18.5k source files, ~320MB) that
    // exhausted a 2GB heap outright, while the raw regex completes in ~2.5s at ~80MB. The
    // only cost is that a COMMENTED-OUT import contributes an edge — which can only name
    // MORE downstream tests, the one direction this guard is allowed to be wrong in.
    const raw = readFile(file);
    if (!raw || raw.length > MAX_SCAN_BYTES) continue;
    const from = indexOf.get(file);
    for (const spec of parseImportSpecifiers(raw)) {
      const target = resolveAcrossPackages({ specifier: spec, fromFile: file, fileSet, byDir, byEntryDir });
      if (target === null || target === file) continue;
      const to = indexOf.get(target);
      if (to === undefined) continue;
      let arr = importers.get(to);
      if (!arr) {
        arr = [];
        importers.set(to, arr);
      }
      arr.push(from);
    }
  }

  const seen = new Set();
  const frontier = [];
  for (const seed of seeds) {
    const i = indexOf.get(seed);
    if (i !== undefined) frontier.push(i);
  }
  while (frontier.length > 0) {
    const current = frontier.pop();
    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      frontier.push(importer);
    }
  }
  return new Set([...seen].map((i) => files[i]));
}

/**
 * The MEMBER names of the seams that grew — `source.lexical` -> `lexical`, `run()` -> `run`.
 *
 * Used to narrow the reachable set, because raw reachability is too blunt to act on and a
 * list nobody runs is worth nothing. MEASURED on the real instance: 4,182 reachable
 * other-workspace tests -> 1,567 carrying a count/order assertion -> 47 that also name a
 * seam member, with the genuinely-stranded file surviving all three filters (it mentions
 * `lexical` nine times). 47 is a 15-second check; 1,567 is a suite run nobody performs.
 *
 * The narrowing is a RANKING, never a silence: an aliased mock could carry a stale count
 * assertion without naming the seam, so the wider band is always reported, is runnable with
 * --wide, and is what gets named when the narrow set comes out empty.
 */
export function seamMemberNames(triggers) {
  const names = new Set();
  for (const t of triggers) {
    for (const s of [...(t.seams ?? []), ...(t.controlFlow ?? [])]) {
      const member = s.seam.includes('.') ? s.seam.slice(s.seam.indexOf('.') + 1) : s.seam.replace(/\(\)$/, '');
      if (member && /^[A-Za-z_$][\w$]*$/.test(member)) names.add(member);
    }
  }
  return [...names];
}

/** The stable property-name anchors for writer output changes. */
export function outputPropertyNames(triggers) {
  return [
    ...new Set(
      triggers.flatMap((trigger) => (trigger.values ?? []).map((value) => value.property)),
    ),
  ];
}

/** Does `text` name any of `members` as a whole word? */
export function mentionsSeamMember(text, members) {
  if (members.length === 0) return false;
  const escaped = members.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`).test(String(text));
}

// ── reporting ───────────────────────────────────────────────────────────────────────────

const CLIP = 25;

function packageScriptAccess(property) {
  return `scripts[${JSON.stringify(property)}]`;
}

function formatFindings({
  triggers,
  tests,
  wider,
  narrow,
  injectionBand = [],
  members,
  valueProperties,
  scriptProperties = [],
  usedWide,
  clipped,
  baseNote,
  ran,
}) {
  const lines = [];
  const hasCallTriggers = triggers.some((t) => (t.seams ?? []).length > 0);
  const hasControlFlowTriggers = triggers.some((t) => (t.controlFlow ?? []).length > 0);
  const hasValueTriggers = triggers.some((t) => (t.values ?? []).length > 0);
  const hasScriptTriggers = triggers.some((t) => (t.scriptValues ?? []).length > 0);
  const hasInjectionTriggers = triggers.some((t) => (t.injections ?? []).length > 0);
  const scriptOnly =
    hasScriptTriggers && !hasCallTriggers && !hasControlFlowTriggers && !hasValueTriggers && !hasInjectionTriggers;
  lines.push(
    scriptOnly
      ? '⚠ PACKAGE-SCRIPT STRAND RISK — a package.json scripts.<name> value changed.'
      : hasInjectionTriggers && !hasCallTriggers && !hasControlFlowTriggers && !hasValueTriggers && !hasScriptTriggers
      ? '⚠ INJECTED-MEMBER STRAND RISK — an injected dependency member gained an invoker.'
      : (hasCallTriggers || hasControlFlowTriggers) && hasValueTriggers
      ? '⚠ BEHAVIOURAL STRAND RISK — a shared seam invocation contract and a writer output value changed.'
      : hasCallTriggers && hasControlFlowTriggers
        ? '⚠ BEHAVIOURAL STRAND RISK — a shared seam gained call sites and its invocation eligibility changed.'
        : hasControlFlowTriggers
          ? '⚠ CONTROL-FLOW STRAND RISK — a dependency call’s invocation eligibility changed.'
      : hasValueTriggers
        ? '⚠ OUTPUT-VALUE STRAND RISK — a writer changed a persisted output value.'
        : '⚠ BEHAVIOURAL STRAND RISK — a shared seam gained call sites.',
  );
  lines.push('');
  for (const t of triggers) {
    lines.push(`  ${t.file}`);
    for (const s of t.seams ?? []) {
      lines.push(`    seam ${s.seam}: ${s.before} call site(s) -> ${s.after}`);
    }
    for (const change of t.controlFlow ?? []) {
      lines.push(`    control-flow ${change.seam} in ${change.function}: dependency invocation eligibility changed`);
    }
    for (const v of t.values ?? []) {
      lines.push(`    output ${v.property}: ${v.before} -> ${v.after}`);
    }
    for (const value of t.scriptValues ?? []) {
      lines.push(`    package script ${packageScriptAccess(value.property)}: ${value.before} -> ${value.after}`);
    }
    for (const inj of t.injections ?? []) {
      lines.push(
        `    injected ${inj.owner}.${inj.member}: ${inj.before} invocation(s) -> ${inj.after} (${inj.siblings.length} sibling member(s) a partial fixture may supply)`,
      );
    }
  }
  lines.push('');
  if (hasInjectionTriggers) {
    lines.push(
      'A test fixture that builds that injected bundle PARTIALLY never supplies the new member, so the first run',
      'that reaches the new call hits an UNINJECTED dependency. The failure channel is often NOT an assertion about',
      'the call: a throw swallowed into console.warn trips vitest-fail-on-console, so the fixture asserts nothing',
      'about the seam and no call-count anchor names it (EI-23824032487848760). The proxy is a fixture object',
      'that supplies SIBLING members of the bundle but NOT the new one — in ANY workspace, the changed one included.',
      '',
    );
  }
  if (hasCallTriggers || hasControlFlowTriggers) {
    lines.push(
      'A downstream test in ANOTHER workspace that mocks this seam and asserts on its call count,',
      'exact invocation sequence, or invocation eligibility may now be stale. `test:affected` cannot select',
    );
    lines.push('those files (it maps changed paths to workspaces) and `tsc` cannot see this runtime contract.');
  }
  if (hasValueTriggers) {
    lines.push(
      'A downstream test in ANOTHER workspace that asserts on the changed output property',
    );
    lines.push(
      'may still encode the old value. The property name is the stable join key; `tsc` and',
    );
    lines.push('`test:affected` cannot prove that a runtime value contract stayed compatible.');
  }
  if (hasScriptTriggers) {
    lines.push(
      'A test may pin a package command through scripts["<name>"] or scripts.<name>.',
      'Changed script keys are joined to assertions that read those values, including same-workspace tests.',
    );
  }
  lines.push('');
  const runList = [...new Set([...tests, ...injectionBand.map((entry) => entry.file)])];
  if (tests.length === 0) {
    const noTests = hasScriptTriggers
      ? 'No tracked test assertion reads a changed package script key.'
      : 'No downstream call-count/order or output-value assertions reachable from this change.';
    lines.push(
      runList.length === 0
        ? `${noTests} Nothing to run.`
        : noTests,
    );
  } else {
    const anchorNames = [
      ...members,
      ...valueProperties,
      ...scriptProperties.map((property) => packageScriptAccess(property)),
    ];
    const bandDescription = hasScriptTriggers
      ? `Test files selected for changed package-script assertions and other matched behavioral contracts: ${wider.length}`
      : `Reachable test files in other workspaces asserting on call count/order or changed output values: ${wider.length}`;
    lines.push(
      bandDescription +
        (anchorNames.length > 0
          ? `; of those, ${narrow.length} also name a relevant anchor (${anchorNames.join(', ')}).`
          : '.'),
    );
    lines.push(
      usedWide
        ? narrow.length === 0
          ? hasScriptTriggers
            ? 'No test names a changed script key or other focused anchor, so the WIDER band is named below — a narrow set is a ranking, never a reason to report less.'
            : 'No test names a seam member, so the WIDER band is named below — a narrow set is a ranking, never a reason to report less.'
          : 'Naming the WIDER band (--wide).'
        : 'Naming the narrowed set. The wider band is still real — an aliased mock can carry a stale count without naming the seam; --wide names it.',
    );
    lines.push('');
    for (const f of tests.slice(0, clipped ? CLIP : tests.length)) lines.push(`  ${f}`);
    if (clipped && tests.length > CLIP) {
      lines.push(`  … and ${tests.length - CLIP} more (--all to list them, --json for the full set)`);
    }
    lines.push('');
  }
  if (injectionBand.length > 0) {
    lines.push(
      `Partial-injection fixtures (an object literal supplying sibling member(s) of the injected bundle but NOT the new member; any workspace): ${injectionBand.length}`,
    );
    for (const entry of injectionBand.slice(0, clipped ? CLIP : injectionBand.length)) {
      const hit = entry.hits.reduce((a, b) => (b.present.length > a.present.length ? b : a));
      lines.push(
        `  ${entry.file}:${hit.line}  (lacks ${hit.member}; supplies ${hit.present.slice(0, 3).join(', ')}${hit.present.length > 3 ? ', …' : ''})`,
      );
    }
    if (clipped && injectionBand.length > CLIP) {
      lines.push(`  … and ${injectionBand.length - CLIP} more (--all to list them, --json for the full set)`);
    }
    lines.push('');
  }
  if (runList.length > 0 && !ran) {
    lines.push('RUN THEM — running them IS the detector for this class; there is no tsc for it:');
    lines.push(`  node scripts/check-behavioural-strands.mjs --run${usedWide ? ' --wide' : ''}`);
    lines.push('or, from an agent, the same set through the router:');
    lines.push(`  testing:run { files: [${runList.slice(0, 3).map((f) => `"${f}"`).join(', ')}${runList.length > 3 ? ', …' : ''}] }`);
  }
  if (baseNote) {
    lines.push('');
    lines.push(baseNote);
  }
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const wantRun = argv.includes('--run');
  const wantAll = argv.includes('--all');
  const wantWide = argv.includes('--wide');
  const baseIdx = argv.indexOf('--base');
  const requestedBase = baseIdx >= 0 ? argv[baseIdx + 1] : 'HEAD';
  const filesArg = argv.find((a) => a.startsWith('--files='));
  const declared = Boolean(filesArg);
  const declaredFiles = filesArg
    ? filesArg
        .slice('--files='.length)
        .split(',')
        .map((f) => f.trim())
        .filter(Boolean)
    : [];

  const submodules = submodulePaths();

  // The base must resolve as a REVISION in at least one repo of this tree — otherwise
  // `git diff <base>` reinterprets it as a pathspec, returns a working-tree diff with
  // status 0, and every later `git show <base>:<file>` yields empty text: the guard then
  // counts files as examined while having compared against nothing. A submodule-only
  // revision is legitimate (that is where this guard's trigger class lives), so accept it
  // here and let the per-file routing pick the repo it actually resolves in.
  const baseRepos = [
    resolvesRevision(requestedBase) ? 'superproject' : null,
    ...submodules.filter((s) => resolvesRevision(requestedBase, resolve(ROOT, s))),
  ].filter(Boolean);
  if (baseRepos.length === 0) {
    const msg = `--base '${requestedBase}' does not resolve to a revision in the superproject or any submodule; refusing to compare against a pathspec.`;
    if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    return EXIT_NOT_CHECKED;
  }

  // Which files to examine. Declared mode fixes WHICH files, never WHETHER they differ.
  // Every declared file that is not examined is recorded with its reason — never dropped
  // silently (WI-10004906) — and an unexamined in-domain file makes the run NOT CHECKED.
  let candidates;
  const skipped = [];
  if (declared) {
    candidates = [];
    for (const f of declaredFiles) {
      const reason = candidateSkipReason(f);
      if (reason === null) candidates.push(f);
      else skipped.push({ file: f, reason });
    }
  } else {
    const changed = new Set();
    const superDiff = git(['diff', '--name-only', requestedBase], { allowFail: true }) ?? '';
    for (const f of superDiff.split('\n')) if (f) changed.add(f);
    for (const sub of submodules) {
      const cwd = resolve(ROOT, sub);
      const out = git(['diff', '--name-only', 'HEAD'], { cwd, allowFail: true }) ?? '';
      for (const f of out.split('\n')) if (f) changed.add(`${sub}/${f}`);
    }
    candidates = [...changed].filter((f) => candidateSkipReason(f) === null);
  }

  // Compare each candidate against its OWNING repo's base.
  const triggers = [];
  const examined = [];
  const identical = [];
  const usedSubmoduleHead = new Set();
  for (const file of candidates) {
    const { submodule, cwd, relPath } = repoForPath(file, submodules);
    // A superproject revision does not name submodule content, so `--base <sha>` is only
    // meaningful inside a submodule when that same expression also resolves THERE. Try it,
    // and disclose the fallback rather than silently comparing against a different base
    // than the caller asked for.
    let base = requestedBase;
    if (submodule !== null && !resolvesRevision(requestedBase, cwd)) {
      base = 'HEAD';
      if (requestedBase !== 'HEAD') usedSubmoduleHead.add(submodule);
    }
    const beforeText = git(['show', `${base}:${relPath}`], { cwd, allowFail: true });
    const abs = resolve(ROOT, file);
    const present = existsSync(abs);
    if (beforeText === null || !present) {
      // No base version: a new file can strand nothing that already exists. No working copy:
      // a deletion. Neither at all: a path that names nothing — most often a typo, which in
      // declared mode must not pass as part of a clean verdict.
      if (declared) {
        skipped.push({ file, reason: beforeText === null ? (present ? 'new-file' : 'not-found') : 'deleted' });
      }
      continue;
    }
    const afterText = readFileSync(abs, 'utf8');
    examined.push(file);
    if (afterText === beforeText) {
      identical.push(file);
      continue;
    }
    const isPackageManifest = PACKAGE_JSON_RE.test(file);
    const scriptValues = isPackageManifest ? diffPackageScriptValues(beforeText, afterText) : [];
    if (scriptValues === null) {
      skipped.push({ file, reason: 'invalid-package-json' });
      continue;
    }
    const seams = isPackageManifest ? [] : increasedSeams(beforeText, afterText, file);
    const controlFlow = isPackageManifest ? [] : changedSeamControlFlow(beforeText, afterText, file);
    const values = isPackageManifest ? [] : diffOutputValues(beforeText, afterText, file);
    const injections = isPackageManifest ? [] : invokedInjectedMembers(beforeText, afterText, file);
    if (seams.length > 0 || controlFlow.length > 0 || values.length > 0 || injections.length > 0 || scriptValues.length > 0) {
      triggers.push({ file, seams, controlFlow, values, injections, scriptValues });
    }
  }

  const baseNote =
    usedSubmoduleHead.size > 0
      ? `ⓘ base: superproject compared against '${requestedBase}'; submodule(s) ${[...usedSubmoduleHead].join(', ')} compared against their own HEAD (a superproject revision does not name submodule content).`
      : '';

  const unexamined = skipped.filter((s) => UNEXAMINED_REASONS.has(s.reason));
  const skippedNote =
    skipped.length > 0
      ? [`ⓘ ${skipped.length} declared file(s) not examined:`, ...formatSkipped(skipped)].join('\n')
      : '';

  if (triggers.length === 0) {
    const exit = unexamined.length > 0
      ? EXIT_NOT_CHECKED
      : exitForDeclaredRun({ examinedFiles: examined, identicalFiles: identical, declared, skipped });
    const notChecked = exit === EXIT_NOT_CHECKED;
    const text = !notChecked
      ? `✓ no behavioural seam or output value changed (${examined.length} changed source file(s) examined vs '${requestedBase}')`
      : unexamined.length > 0
        ? `⚠ NOT CHECKED — ${unexamined.length} declared file(s) could not be examined: ${unexamined.map((s) => s.file).join(', ')}.\n` +
          `  ${examined.length} other file(s) examined vs '${requestedBase}', ${identical.length} identical. A verdict that\n` +
          '  silently omits a file you named is not a verdict on that file. This is NOT a clean bill.'
        : `⚠ NOT CHECKED — nothing was compared against '${requestedBase}' (${examined.length} file(s) examined, ${identical.length} identical).\n` +
          '  On this tree git-sync commits the working tree on a schedule, so a few minutes after an\n' +
          '  edit the default --base HEAD diff is EMPTY. Pin the pre-edit sha: --base "$C".\n' +
          '  This is NOT a clean bill.';
    if (wantJson) {
      console.log(
        JSON.stringify(
          { ok: true, notChecked, base: requestedBase, examined, identical, skipped, triggers: [], tests: [] },
          null,
          2,
        ),
      );
    } else {
      console.log(text);
      if (skippedNote) console.log(skippedNote);
      if (baseNote) console.log(baseNote);
    }
    return exit;
  }

  // Blast radius. Seeds are the changed files themselves; reachability is inverted over the
  // whole tree's import graph so a test that names neither the package nor the seam — the
  // measured instance — is still found.
  const allFiles = allRepoFiles(submodules);
  const { byDir, byEntryDir } = packageMapsByName(allFiles);
  const packageDirs = [...byDir.values()].filter(Boolean);
  const readFile = (f) => {
    try {
      return readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      return '';
    }
  };

  const seeds = triggers.map((t) => t.file);
  const reachable = reverseReachable({ seeds, files: allFiles, readFile, byDir, byEntryDir });
  const changedWorkspaces = new Set(seeds.map((f) => workspaceOf(f, packageDirs)));
  const members = seamMemberNames(triggers);
  const valueProperties = outputPropertyNames(triggers);
  const scriptProperties = [...new Set(triggers.flatMap((t) => (t.scriptValues ?? []).map((value) => value.property)))];

  // An injection-only trigger (a new invoked Deps member, no call-count/order/value change) has
  // no count-assertion band: naming every reachable count assertion for it would be pure noise.
  const needsCountBand = triggers.some(
    (t) =>
      (t.seams?.length ?? 0) +
        (t.controlFlow?.length ?? 0) +
        (t.values?.length ?? 0) +
        (t.scriptValues?.length ?? 0) >
      0,
  );
  const reachableTests = needsCountBand
    ? [...reachable]
        .filter((f) => TEST_RE.test(f))
        .filter((f) => !changedWorkspaces.has(workspaceOf(f, packageDirs)))
        .filter(
          (f) =>
            hasCountOrOrderAssertion(readFile(f)) ||
            hasValueAssertion(readFile(f), valueProperties, f),
        )
        .sort()
    : [];
  const scriptTests =
    scriptProperties.length > 0
      ? allFiles
          .filter((f) => TEST_RE.test(f))
          .filter((f) => hasPackageScriptAssertion(readFile(f), scriptProperties, f))
      : [];
  const wider = [...new Set([...reachableTests, ...scriptTests])].sort();
  // Candidate tests come from the reachability walk, then each injection is joined only to its
  // changed module's direct importers.
  const injections = triggers.flatMap((t) =>
    (t.injections ?? []).map((injection) => ({ ...injection, sourceFile: t.file })),
  );
  const injectionFileSet = new Set(allFiles);
  const directImportTargetsByTest = new Map();
  const directlyImportsSource = (fromFile, sourceFile) => {
    let targets = directImportTargetsByTest.get(fromFile);
    if (!targets) {
      targets = new Set();
      const raw = readFile(fromFile);
      if (raw && raw.length <= MAX_SCAN_BYTES) {
        const text = stripCommentsOnly(raw);
        for (const specifier of parseImportSpecifiers(text)) {
          const target = resolveAcrossPackages({
            specifier,
            fromFile,
            fileSet: injectionFileSet,
            byDir,
            byEntryDir,
          });
          if (target) targets.add(target);
        }
      }
      directImportTargetsByTest.set(fromFile, targets);
    }
    return targets.has(sourceFile);
  };
  const injectionBand = partialInjectionFixtures({
    tests: [...reachable].filter((f) => TEST_RE.test(f)).sort(),
    readFile,
    injections,
    directlyImportsSource,
  });
  const injectionFiles = injectionBand.map((entry) => entry.file);

  const narrow = wider.filter(
    (f) =>
      (members.length > 0 && mentionsSeamMember(readFile(f), members)) ||
      (valueProperties.length > 0 && hasValueAssertion(readFile(f), valueProperties, f)) ||
      (scriptProperties.length > 0 && hasPackageScriptAssertion(readFile(f), scriptProperties, f)),
  );
  // The narrow set is a ranking, not a filter that may hide work: when it comes out empty
  // the wider band is what gets named, so this can never print "nothing to run" while
  // reachable tests with count assertions exist.
  const usedWide = wantWide || narrow.length === 0;
  const tests = usedWide ? wider : narrow;

  let exit = 0;
  let ran = false;
  let runResult = null;
  const runSet = [...new Set([...tests, ...injectionFiles])];
  if (wantRun && runSet.length > 0) {
    ran = true;
    const proc = spawnSync('npm', ['run', 'test:file', '--', ...runSet], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: wantJson ? 'pipe' : 'inherit',
      maxBuffer: 256 * 1024 * 1024,
    });
    runResult = { status: proc.status ?? null };
    if (proc.status !== 0) exit = 1;
  }
  // Findings for the files that WERE read do not cover a declared file that was not: a 0
  // here would vouch for it. Real failures (1) still outrank it.
  if (exit === 0 && unexamined.length > 0) exit = EXIT_NOT_CHECKED;

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          notChecked: exit === EXIT_NOT_CHECKED,
          base: requestedBase,
          examined,
          identical,
          skipped,
          triggers,
          seamMembers: members,
          outputProperties: valueProperties,
          packageScriptProperties: scriptProperties,
          tests,
          narrow,
          wider,
          injectionBand,
          usedWide,
          ran,
          runResult,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      formatFindings({
        triggers,
        tests,
        wider,
        narrow,
        injectionBand,
        members,
        valueProperties,
        scriptProperties,
        usedWide,
        clipped: !wantAll,
        baseNote: [skippedNote, baseNote].filter(Boolean).join('\n'),
        ran,
      }),
    );
    if (exit === EXIT_NOT_CHECKED) {
      console.log(
        `⚠ NOT CHECKED — declared file(s) could not be examined: ${unexamined.map((s) => s.file).join(', ')}. The findings above do not cover them.`,
      );
    }
  }
  return exit;
}

/**
 * Run the detector and map an INTERNAL error to EXIT_NOT_CHECKED (WI-10005809). An uncaught throw
 * otherwise exits 1, the code this script reserves for "strands named", so a crashed detector read
 * as a finding. A crash measured nothing, which is exactly what exit 2 means.
 */
export function runCli(run = main, { writeError = (line) => console.error(line) } = {}) {
  try {
    return run();
  } catch (err) {
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    writeError(`⚠ NOT CHECKED — check-behavioural-strands crashed before it could compare anything:\n${detail}`);
    return EXIT_NOT_CHECKED;
  }
}

if (isCliEntry(import.meta.url)) process.exit(runCli());

export { main, EXIT_NOT_CHECKED };
