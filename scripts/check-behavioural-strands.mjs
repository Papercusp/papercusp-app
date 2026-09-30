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
 *   node scripts/check-behavioural-strands.mjs                  # advisory: name the trigger, the seam, and the command
 *   node scripts/check-behavioural-strands.mjs --run            # RUN the named tests, exit 1 on real failures
 *   node scripts/check-behavioural-strands.mjs --base "$C"      # pin the pre-edit commit (see below)
 *   node scripts/check-behavioural-strands.mjs --files=a.ts,b.ts
 *   node scripts/check-behavioural-strands.mjs --json
 *   node scripts/check-behavioural-strands.mjs --all            # do not clip the named-test list
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
 *       byte-identical to its base), so this run proved nothing
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

/** Repo-relative prefixes whose changes can strand another workspace's fixtures. */
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/;
const TEST_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|mjs|js|jsx)$/;
const EXCLUDED_DIR_RE = /(?:^|\/)(?:dist|build|node_modules|coverage|\.next|\.papercusp)\//;
const EXCLUDED_ROOT_RE = /^(?:papercup-release|papercup-checkpoint)\//;
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
 * Every call in `text` whose callee is rooted at a FUNCTION PARAMETER — i.e. an injected
 * collaborator, the only kind of call a downstream test can mock and count.
 *
 * Keyed by `param.member` (or `param()` for a directly-called parameter) and counted at
 * FILE level rather than per function: a call that merely MOVES between functions in the
 * same file strands nobody, and counting per function would report that move as an
 * increase. Nested closures still count, because the parameter they capture is the same
 * seam the caller injected.
 *
 * @returns {Map<string, number>} seam key -> number of call sites
 */
export function seamCallCounts(text, fileName = 'file.ts') {
  const counts = new Map();
  let source;
  try {
    source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return counts;
  }

  const paramScopes = [];
  const declaresParam = (name) => paramScopes.some((scope) => scope.has(name));

  const collectParamNames = (node, into) => {
    for (const param of node.parameters ?? []) {
      const bind = param.name;
      if (ts.isIdentifier(bind)) {
        into.add(bind.text);
      } else if (ts.isObjectBindingPattern(bind) || ts.isArrayBindingPattern(bind)) {
        // A destructured seam (`{ lexical }`) is injected exactly like a named one.
        for (const el of bind.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) into.add(el.name.text);
        }
      }
    }
  };

  /** `p(...)` -> `p()`; `p.m(...)` / `p?.m(...)` -> `p.m`; anything else -> null. */
  const seamKeyFor = (callee) => {
    if (ts.isIdentifier(callee)) return declaresParam(callee.text) ? `${callee.text}()` : null;
    if (ts.isPropertyAccessExpression(callee)) {
      const root = callee.expression;
      if (ts.isIdentifier(root) && declaresParam(root.text)) return `${root.text}.${callee.name.text}`;
      return null;
    }
    if (ts.isNonNullExpression(callee) || ts.isParenthesizedExpression(callee)) {
      return seamKeyFor(callee.expression);
    }
    return null;
  };

  const visit = (node) => {
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node);

    if (isFunctionLike) {
      const names = new Set();
      collectParamNames(node, names);
      paramScopes.push(names);
    }

    if (ts.isCallExpression(node)) {
      const key = seamKeyFor(node.expression);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    ts.forEachChild(node, visit);
    if (isFunctionLike) paramScopes.pop();
  };

  ts.forEachChild(source, visit);
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

/**
 * Summarise each function that calls an injected collaborator. Nested functions are recorded
 * independently; a captured outer parameter is still a seam in the nested function, while
 * control-flow tokens from the nested body do not contaminate the outer function's identity.
 */
export function seamControlFlowRecords(text, fileName = 'file.ts') {
  let source;
  try {
    source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  } catch {
    return [];
  }

  const bindingScopes = [];
  const functionStack = [];
  const records = [];
  let anonymousOrdinal = 0;
  const lookupBinding = (name) => {
    for (let index = bindingScopes.length - 1; index >= 0; index -= 1) {
      const binding = bindingScopes[index].get(name);
      if (binding) return binding;
    }
    return null;
  };
  const collectParamBindings = (node, into) => {
    for (const param of node.parameters ?? []) {
      const bind = param.name;
      if (ts.isIdentifier(bind)) into.set(bind.text, bind.text);
      else if (ts.isObjectBindingPattern(bind) || ts.isArrayBindingPattern(bind)) {
        for (const el of bind.elements) {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const property = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            into.set(el.name.text, property);
          }
        }
      }
    }
  };
  const expressionPath = (node) => {
    if (!node) return null;
    if (ts.isIdentifier(node)) return lookupBinding(node.text);
    if (ts.isPropertyAccessExpression(node)) {
      const base = expressionPath(node.expression);
      return base ? `${base}.${node.name.text}` : null;
    }
    if (ts.isElementAccessExpression(node)) {
      const base = expressionPath(node.expression);
      const index = node.argumentExpression;
      if (!base) return null;
      if (ts.isStringLiteral(index) || ts.isNumericLiteral(index)) return `${base}[${index.text}]`;
      return `${base}[*]`;
    }
    if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return expressionPath(node.expression);
    return null;
  };
  const firstDependencyPath = (node) => {
    const direct = expressionPath(node);
    if (direct) return direct;
    let found = null;
    const visit = (current) => {
      if (found) return;
      const path = expressionPath(current);
      if (path) {
        found = path;
        return;
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };
  const bindPattern = (pattern, basePath, into) => {
    if (ts.isIdentifier(pattern)) {
      into.set(pattern.text, basePath);
      return;
    }
    if (ts.isObjectBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
        const property = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
        bindPattern(el.name, `${basePath}.${property}`, into);
      }
    }
  };
  const calleeLabel = (callee, sourceFile) => {
    if (ts.isIdentifier(callee)) return callee.text;
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    return callee.getText(sourceFile);
  };
  const seamKeyFor = (callee) => {
    const path = expressionPath(callee);
    return path ? `${path}()` : null;
  };
  const visit = (node) => {
    const isFunctionLike =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node);
    if (isFunctionLike) {
      const bindings = new Map();
      for (const param of node.parameters ?? []) {
        const bind = param.name;
        if (ts.isIdentifier(bind)) bindings.set(bind.text, bind.text);
        else if (ts.isObjectBindingPattern(bind) || ts.isArrayBindingPattern(bind)) {
          collectParamBindings({ parameters: [param] }, bindings);
        }
      }
      bindingScopes.push(bindings);
      const record = {
        function: callableIdentity(node, source, anonymousOrdinal++),
        seams: [],
        controlFlow: [],
      };
      records.push(record);
      functionStack.push(record);
    }

    const current = functionStack.at(-1);
    if (current) {
      const token = controlFlowToken(node, source, fileName);
      if (token) current.controlFlow.push(token);
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const basePath = expressionPath(node.initializer);
        if (basePath) bindPattern(node.name, basePath, bindingScopes.at(-1));
      }
      if (ts.isCallExpression(node)) {
        const seam = seamKeyFor(node.expression) ??
          (node.arguments.some((argument) => firstDependencyPath(argument))
            ? `${calleeLabel(node.expression, source)}()`
            : null);
        if (seam) current.seams.push(seam);
      }
    }

    ts.forEachChild(node, visit);
    if (isFunctionLike) {
      functionStack.pop();
      bindingScopes.pop();
    }
  };
  ts.forEachChild(source, visit);
  return records.filter((record) => record.seams.length > 0);
}

/**
 * Functions where the dependency call count stayed stable but its control-flow summary did
 * not. This catches a call whose loop eligibility changed (the WI-10001694 shape) without
 * claiming that every arbitrary edit to a function is a strand trigger.
 */
export function changedSeamControlFlow(beforeText, afterText, fileName = 'file.ts') {
  const before = seamControlFlowRecords(beforeText, fileName);
  const after = seamControlFlowRecords(afterText, fileName);
  const beforeByFunction = new Map(before.map((record) => [record.function, record]));
  const rows = [];
  for (const record of after) {
    const prior = beforeByFunction.get(record.function);
    if (!prior || prior.controlFlow.join('\u0000') === record.controlFlow.join('\u0000')) continue;
    const beforeCounts = new Map();
    for (const seam of prior.seams) beforeCounts.set(seam, (beforeCounts.get(seam) ?? 0) + 1);
    const afterCounts = new Map();
    for (const seam of record.seams) afterCounts.set(seam, (afterCounts.get(seam) ?? 0) + 1);
    for (const [seam, count] of afterCounts) {
      if (count !== (beforeCounts.get(seam) ?? 0)) continue;
      rows.push({
        function: record.function,
        seam,
        before: prior.controlFlow,
        after: record.controlFlow,
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

function formatFindings({
  triggers,
  tests,
  wider,
  narrow,
  members,
  valueProperties,
  usedWide,
  clipped,
  baseNote,
  ran,
}) {
  const lines = [];
  const hasCallTriggers = triggers.some((t) => (t.seams ?? []).length > 0);
  const hasControlFlowTriggers = triggers.some((t) => (t.controlFlow ?? []).length > 0);
  const hasValueTriggers = triggers.some((t) => (t.values ?? []).length > 0);
  lines.push(
    (hasCallTriggers || hasControlFlowTriggers) && hasValueTriggers
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
  }
  lines.push('');
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
  lines.push('');
  if (tests.length === 0) {
    lines.push('No downstream call-count/order or output-value assertions reachable from this change. Nothing to run.');
  } else {
    lines.push(
      `Reachable test files in other workspaces asserting on call count/order or changed output values: ${wider.length}` +
        (members.length > 0 || valueProperties.length > 0
          ? `; of those, ${narrow.length} also name a relevant anchor (${[...members, ...valueProperties].join(', ')}).`
          : '.'),
    );
    lines.push(
      usedWide
        ? narrow.length === 0
          ? 'No test names a seam member, so the WIDER band is named below — a narrow set is a ranking, never a reason to report less.'
          : 'Naming the WIDER band (--wide).'
        : 'Naming the narrowed set. The wider band is still real — an aliased mock can carry a stale count without naming the seam; --wide names it.',
    );
    lines.push('');
    for (const f of tests.slice(0, clipped ? CLIP : tests.length)) lines.push(`  ${f}`);
    if (clipped && tests.length > CLIP) {
      lines.push(`  … and ${tests.length - CLIP} more (--all to list them, --json for the full set)`);
    }
    lines.push('');
    if (!ran) {
      lines.push('RUN THEM — running them IS the detector for this class; there is no tsc for it:');
      lines.push(`  node scripts/check-behavioural-strands.mjs --run${usedWide ? ' --wide' : ''}`);
      lines.push('or, from an agent, the same set through the router:');
      lines.push(`  testing:run { files: [${tests.slice(0, 3).map((f) => `"${f}"`).join(', ')}${tests.length > 3 ? ', …' : ''}] }`);
    }
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
  let candidates;
  if (declared) {
    candidates = declaredFiles.filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && keepPath(f));
  } else {
    const changed = new Set();
    const superDiff = git(['diff', '--name-only', requestedBase], { allowFail: true }) ?? '';
    for (const f of superDiff.split('\n')) if (f) changed.add(f);
    for (const sub of submodules) {
      const cwd = resolve(ROOT, sub);
      const out = git(['diff', '--name-only', 'HEAD'], { cwd, allowFail: true }) ?? '';
      for (const f of out.split('\n')) if (f) changed.add(`${sub}/${f}`);
    }
    candidates = [...changed].filter((f) => SOURCE_RE.test(f) && !TEST_RE.test(f) && keepPath(f));
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
    if (beforeText === null) continue; // new file: it can strand nothing that already exists
    const abs = resolve(ROOT, file);
    if (!existsSync(abs)) continue;
    const afterText = readFileSync(abs, 'utf8');
    examined.push(file);
    if (afterText === beforeText) {
      identical.push(file);
      continue;
    }
    const seams = increasedSeams(beforeText, afterText, file);
    const controlFlow = changedSeamControlFlow(beforeText, afterText, file);
    const values = diffOutputValues(beforeText, afterText, file);
    if (seams.length > 0 || controlFlow.length > 0 || values.length > 0) {
      triggers.push({ file, seams, controlFlow, values });
    }
  }

  const baseNote =
    usedSubmoduleHead.size > 0
      ? `ⓘ base: superproject compared against '${requestedBase}'; submodule(s) ${[...usedSubmoduleHead].join(', ')} compared against their own HEAD (a superproject revision does not name submodule content).`
      : '';

  if (triggers.length === 0) {
    const exit = exitForNoFindings({ examinedFiles: examined, identicalFiles: identical, declared });
    const notChecked = exit === EXIT_NOT_CHECKED;
    const text = notChecked
      ? `⚠ NOT CHECKED — nothing was compared against '${requestedBase}' (${examined.length} file(s) examined, ${identical.length} identical).\n` +
        '  On this tree git-sync commits the working tree on a schedule, so a few minutes after an\n' +
        '  edit the default --base HEAD diff is EMPTY. Pin the pre-edit sha: --base "$C".\n' +
        '  This is NOT a clean bill.'
      : `✓ no behavioural seam or output value changed (${examined.length} changed source file(s) examined vs '${requestedBase}')`;
    if (wantJson) {
      console.log(
        JSON.stringify(
          { ok: true, notChecked, base: requestedBase, examined, identical, triggers: [], tests: [] },
          null,
          2,
        ),
      );
    } else {
      console.log(text);
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

  const wider = [...reachable]
    .filter((f) => TEST_RE.test(f))
    .filter((f) => !changedWorkspaces.has(workspaceOf(f, packageDirs)))
    .filter(
      (f) =>
        hasCountOrOrderAssertion(readFile(f)) ||
        hasValueAssertion(readFile(f), valueProperties, f),
    )
    .sort();

  const narrow = wider.filter(
    (f) =>
      (members.length > 0 && mentionsSeamMember(readFile(f), members)) ||
      (valueProperties.length > 0 && hasValueAssertion(readFile(f), valueProperties, f)),
  );
  // The narrow set is a ranking, not a filter that may hide work: when it comes out empty
  // the wider band is what gets named, so this can never print "nothing to run" while
  // reachable tests with count assertions exist.
  const usedWide = wantWide || narrow.length === 0;
  const tests = usedWide ? wider : narrow;

  let exit = 0;
  let ran = false;
  let runResult = null;
  if (wantRun && tests.length > 0) {
    ran = true;
    const proc = spawnSync('npm', ['run', 'test:file', '--', ...tests], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: wantJson ? 'pipe' : 'inherit',
      maxBuffer: 256 * 1024 * 1024,
    });
    runResult = { status: proc.status ?? null };
    if (proc.status !== 0) exit = 1;
  }

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          notChecked: false,
          base: requestedBase,
          examined,
          identical,
          triggers,
          seamMembers: members,
          outputProperties: valueProperties,
          tests,
          narrow,
          wider,
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
        members,
        valueProperties,
        usedWide,
        clipped: !wantAll,
        baseNote,
        ran,
      }),
    );
  }
  return exit;
}

if (isCliEntry(import.meta.url)) process.exit(main());

export { main, EXIT_NOT_CHECKED };
