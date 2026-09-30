#!/usr/bin/env node
/**
 * check-undrained-stdout-exit.mjs — fails when a program writes an UNBOUNDED payload
 * to stdout/stderr and then calls `process.exit()` in the same synchronous path,
 * which SILENTLY TRUNCATES the output whenever the stream is a pipe.
 *
 * ── THE MECHANISM (measured 2026-08-10, EI-20055889379250637) ────────────────
 * Writes to a PIPE are asynchronous in Node; `process.exit()` does not drain them.
 * Only what was flushed synchronously survives. Measured on this box, deterministic
 * across 3 runs each — `node -e "console.log('x'.repeat(N)); process.exit(0)" | wc -c`:
 *
 *     N=4096 -> 4097 (survives)   N=8000 -> 8001 (survives)   N=8192 -> 8192
 *     N=16384 -> 8192   N=32768 -> 8192   N=65536 -> 8192   N=200000 -> 8192
 *
 * Controls, same payload, isolating each ingredient:
 *     no process.exit()            -> 200001  (full — Node stays alive until drained)
 *     process.exit() but `> file`  -> 200001  (full — file writes are synchronous)
 *     fs.writeSync drain + exit    -> 200001  (full)
 *     process.exitCode = N         -> 200001  (full, AND the status is preserved)
 * stderr behaves identically (8192), so `console.error(<big>); process.exit(1)` is in
 * the class too.
 *
 * ⚠ THE BOUNDARY IS NOT 64 KiB, AND NOT A CONSTANT. The filing that prompted this
 * guard recorded "cut at exactly one 64 KiB pipe buffer (65,536)". That is one
 * observation of a timing-dependent quantity, not a threshold. The reader above
 * (`wc -c`) consumes continuously, so the pipe never fills — 8192 is the WRITER
 * stopping after one synchronous chunk, not the pipe buffer filling. What escapes is
 * "whatever drained before exit", so a slower-starting reader lets more through (the
 * filer's `| cat > file` let 65,536 through). Judge sites against ~8 KiB, not 64 KiB:
 * the affected population is ~8x wider than a 64 KiB reading suggests.
 *
 * ── WHY THIS IS A GATE AND NOT A STYLE NOTE ─────────────────────────────────
 * It fails ONLY under a pipe. Every interactive test passes — a TTY is synchronous and
 * a `> file` redirect is synchronous — so it is invisible until someone else composes
 * with the tool. And when the payload is a MEASUREMENT (a census, a count, a findings
 * list), truncation does not error: the prefix parses or greps as FEWER FINDINGS, i.e.
 * it reads as CLEANER. Same false-clean family as `tsc -p .` checking zero files. It is
 * also SIZE-DEPENDENT and therefore arrives with no code change: a consumer that piped
 * the tool was fine yesterday and is silently wrong today because the data grew.
 *
 * ── THE FIX, cheapest first ─────────────────────────────────────────────────
 *   1. `process.exitCode = N` and let the program end naturally. Verified above to
 *      deliver the full payload AND preserve the exit status. Almost always this.
 *   2. Drop the `process.exit()` entirely when the status is 0 and nothing follows.
 *   3. Only if you must exit immediately (a live handle would keep the loop alive):
 *      `writeStdoutSync` from scripts/lib/write-stdout-sync.mjs.
 *
 * ── WHY AN AST AND NOT A REGEX (learned the hard way) ───────────────────────
 * The first cut of this guard reused `maskStringsAndComments` from
 * check-mock-cast-escape.mjs. That helper had no regex-literal handling, so a regex
 * containing a quote (`/^["'`]([^"'`]+)["'`]$/`, real, at mug-kettle-surface-census
 * .mjs:336) opened a phantom string that blanked the rest of the file — which both
 * HIDES real code and desynchronises re-entry so that COMMENT PROSE gets scanned as
 * live code. It reported this very file's explanatory comment as an offender. Filed
 * separately as EI-20059456952698638 and FIXED on 2026-08-10: check-mock-cast-escape
 * .mjs is now an AST walk too and the shared-masker helper is gone, so this paragraph
 * is history, not a live hazard. (That fix also measured the damage: the masker had a
 * second, independent blind spot — an anchored `$` that could not see a cast followed
 * by a trailing comma — and the two together hid 13 real escapes in this repo's test
 * corpus.) Parsing with the TypeScript compiler removes the whole class: strings,
 * templates, comments and regexes are all correct by construction, and a doc-comment
 * example can never be mistaken for code.
 *
 * ── WHAT IS FLAGGED (deliberately narrow) ───────────────────────────────────
 * A write is an offender only when its payload is NOT PROVABLY BOUNDED — the program
 * is emitting a VALUE, not a MESSAGE:
 *   • `JSON.stringify(...)` AS the payload — machine-readable, so it gets piped, and
 *     data-derived, so it is unbounded; or
 *   • a bare identifier (`console.log(out)`) that is not a caught error and not a
 *     module-level string constant — i.e. an accumulated buffer or a loop variable.
 * A diagnostic assembled from literals, or wrapped in a formatter (`red(msg)`), is
 * EXEMPT. That is what keeps this at a few dozen sites rather than the 1052 raw
 * log-then-exit pairs in the tree — most of which are `console.error('usage: …')`.
 *
 * KNOWN, DELIBERATE GAP: a stringify EMBEDDED in a template diagnostic
 * (`console.error(`failed: ${JSON.stringify(x)}`)`) is not flagged. Those are
 * overwhelmingly short error messages, and requiring the dump to BE the payload is
 * what keeps this guard precise enough to stay wired.
 *
 * BASELINE is SHRINK-ONLY: fix a site and delete its entry; adding one needs a stated
 * reason. Falsifiability — that this guard CAN fail, and does not fire on the safe
 * shapes — is proven by fixture controls in
 * packages/operator-core/lib/undrained-stdout-exit-guard.test.ts, which also execs
 * this script over the real tree so the ratchet cannot rot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Sites known to violate the invariant and not yet fixed. SHRINK-ONLY.
 * Keyed `<repo-relative path>` — deliberately NOT line numbers, which churn on every
 * unrelated edit above them and would make this baseline unmaintainable.
 */
const BASELINE = new Set([]);

const SCAN_DIRS = ['scripts', 'apps', 'packages', 'libs'];

/** Vendored, generated, or build output — never our source to fix. */
const EXCLUDE_RE =
  /(^|\/)(node_modules|dist|build|out|\.next|target|coverage|\.git|__snapshots__|__fixtures__)(\/|$)|(^|\/)apps\/operator\/public\//;

const SOURCE_RE = /\.(?:[cm]?jsx?|[cm]?tsx?)$/;

/** Caught-error identifiers: `catch (e) { console.error(e); process.exit(1) }` is the
 * largest shape in the tree and is NOT this defect — a stack trace is bounded, it is a
 * diagnostic rather than machine-readable output, and nobody pipes it to a parser. */
const ERROR_IDENT_RE = /^(?:e|e2|err|error|ex|exc|cause|reason)$/;

/** How many statements after the write we still consider "the same exit path". */
const STATEMENT_LOOKAHEAD = 3;

export function walk(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(REPO_ROOT, full);
    if (EXCLUDE_RE.test(rel)) continue;
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile() && SOURCE_RE.test(e.name)) acc.push(full);
  }
  return acc;
}

const isWriteTarget = (expr) => {
  if (!ts.isPropertyAccessExpression(expr)) return false;
  const prop = expr.name.text;
  const obj = expr.expression;
  if (ts.isIdentifier(obj) && obj.text === 'console') {
    return ['log', 'error', 'info', 'warn', 'debug'].includes(prop);
  }
  if (prop === 'write' && ts.isPropertyAccessExpression(obj)) {
    return (
      ts.isIdentifier(obj.expression) &&
      obj.expression.text === 'process' &&
      (obj.name.text === 'stdout' || obj.name.text === 'stderr')
    );
  }
  return false;
};

const isProcessExitCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'process' &&
  node.expression.name.text === 'exit';

const isJsonStringify = (node) =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === 'JSON' &&
  node.expression.name.text === 'stringify';

/**
 * A module-level `const X = '…'` — string, or a template literal with or without
 * interpolation — is STATIC: it is fixed at module load, so it cannot grow with the
 * data and is bounded however long it is. This is the `USAGE`/help-text shape, and
 * `scripts/lint-as-committed.mjs:199` is why interpolating templates are included:
 * usage text routinely interpolates a constant, which does not make it unbounded.
 * A module-level const built by a CALL over collected data is not static — data is not
 * available at module-load time — so `ts.isCallExpression` initialisers are excluded.
 */
function resolvesToStaticString(node, depth = 0) {
  if (!node || depth > 8) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return true;
  if (ts.isParenthesizedExpression(node)) return resolvesToStaticString(node.expression, depth + 1);
  // `cond ? '…' : null` — a GUARDED one-line notice, which is how an optional
  // diagnostic is written. Static iff both branches are (nullish counts: it cannot grow).
  if (ts.isConditionalExpression(node)) {
    const branchOk = (b) => isNullish(b) || resolvesToStaticString(b, depth + 1);
    return branchOk(node.whenTrue) && branchOk(node.whenFalse);
  }
  // `notice(x)` where `notice` is a MODULE-LOCAL function whose every return is a
  // literal/template — the "bounded diagnostic behind a helper" shape. Without this,
  // hoisting a one-line message into a named helper makes it read exactly like an
  // accumulated buffer, which is a false positive on the most idiomatic shape there is.
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const fn = findModuleFunction(ownerSourceFile(node), node.expression.text);
    return fn ? functionReturnsOnlyStatic(fn, depth + 1) : false;
  }
  // `'a' + 'b'` — static iff both sides are.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return resolvesToStaticString(node.left, depth + 1) && resolvesToStaticString(node.right, depth + 1);
  }
  // A string-method chain on a literal receiver: `` `…`.trim() ``, `.replace(…)`, etc.
  // scripts/lint-as-committed.mjs:199 is exactly this shape, and it is what made the
  // first cut of this rule miss `USAGE` — the initialiser is a CallExpression, not a
  // template. Recurse into the RECEIVER, not the arguments.
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return resolvesToStaticString(node.expression.expression, depth + 1);
  }
  return false;
}

/** `null` / `undefined` — a payload that cannot grow, so it never widens a branch. */
const isNullish = (node) =>
  node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');

/** The SourceFile owning `node` — parents are set (createSourceFile(..., true)). */
function ownerSourceFile(node) {
  let cur = node;
  while (cur && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur ?? null;
}

/** A module-local `function f(){}` / `const f = () => …`, by name. Module-local ONLY:
 * an IMPORTED name is deliberately not resolved — we cannot see its body, so treating
 * it as bounded would be an assumption rather than a measurement. */
function findModuleFunction(sf, name) {
  if (!sf) return null;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(d.name) &&
        d.name.text === name &&
        d.initializer &&
        (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
      ) {
        return d.initializer;
      }
    }
  }
  return null;
}

/** EVERY `return` in `fn` yields a static string (or nothing/null). One data-derived
 * return is enough to disqualify the whole function, so a helper that sometimes dumps
 * a buffer still flags. Inner functions are skipped — their returns are not this one's.
 * An arrow with an expression body is its single return. */
function functionReturnsOnlyStatic(fn, depth) {
  if (!fn.body) return false;
  if (!ts.isBlock(fn.body)) return isNullish(fn.body) || resolvesToStaticString(fn.body, depth + 1);
  let ok = true;
  let sawReturn = false;
  const visit = (n) => {
    if (!ok) return;
    if (isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      sawReturn = true;
      if (n.expression && !isNullish(n.expression) && !resolvesToStaticString(n.expression, depth + 1)) {
        ok = false;
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return ok && sawReturn;
}

/**
 * Walk OUT from the write site for `const <name> = <init>`, nearest scope first.
 *
 * ⚠ `const` ONLY, and that restriction is load-bearing rather than stylistic: the
 * guard's single biggest target is `let out = ''; for (…) out += row;
 * console.log(out); process.exit(0)`. That initialiser IS a static string, so
 * resolving `let` here would mark the archetypal accumulated buffer BOUNDED and
 * silently retire the rule. `const` cannot be reassigned, so the initialiser is the
 * final value; a mutated `const rows = []` is unaffected (an array literal is not a
 * static string). Scope-correct by construction — a same-named local in a SIBLING
 * function is never reached, which a flat name Set would wrongly conflate.
 */
function findConstInitializer(fromNode, name) {
  for (let cur = fromNode; cur; cur = cur.parent) {
    const list =
      ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)
        ? cur.statements
        : null;
    if (!list) continue;
    for (const stmt of list) {
      if (!ts.isVariableStatement(stmt)) continue;
      if ((stmt.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl.initializer ?? null;
      }
    }
  }
  return null;
}

function collectStaticStringConsts(sourceFile) {
  const statics = new Set();
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (resolvesToStaticString(decl.initializer)) statics.add(decl.name.text);
    }
  }
  return statics;
}

export function classifyPayload(arg, staticConsts) {
  if (!arg) return { unbounded: false, why: 'no argument' };
  if (isJsonStringify(arg)) {
    return {
      unbounded: true,
      why: 'the payload is a JSON.stringify dump — machine-readable, so it gets piped, and data-derived, so it is unbounded',
    };
  }
  if (ts.isIdentifier(arg)) {
    const name = arg.text;
    if (ERROR_IDENT_RE.test(name)) return { unbounded: false, why: 'a caught error — a bounded diagnostic' };
    if (staticConsts.has(name)) return { unbounded: false, why: `\`${name}\` is a static string constant — cannot grow with the data` };
    // A LOCAL `const` holding a literal/template — or a guarded call to a local helper
    // that only returns one. Same boundedness argument as the module-level set above;
    // the only difference is where the author happened to put it.
    const localInit = arg.parent ? findConstInitializer(arg, name) : null;
    if (localInit && resolvesToStaticString(localInit)) {
      return { unbounded: false, why: `\`${name}\` is a local const holding a static diagnostic — cannot grow with the data` };
    }
    return { unbounded: true, why: `the payload is the value \`${name}\` — an accumulated buffer or loop variable, unbounded as the data grows` };
  }
  return { unbounded: false, why: 'built from literals or a formatter call — a diagnostic message' };
}

/** The nearest enclosing function-ish body, or the SourceFile. Crossing one means the
 * exit is NOT in this synchronous path. */
const isFunctionLike = (n) =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isConstructorDeclaration(n) ||
  ts.isGetAccessor(n) ||
  ts.isSetAccessor(n);

function enclosingFunction(node) {
  let cur = node.parent;
  while (cur && !isFunctionLike(cur) && !ts.isSourceFile(cur)) cur = cur.parent;
  return cur;
}

/** The top-level statement, within its containing statement list, that holds `node`. */
function statementInList(node) {
  let cur = node;
  while (cur.parent && !((ts.isBlock(cur.parent) || ts.isSourceFile(cur.parent) || ts.isCaseClause(cur.parent) || ts.isDefaultClause(cur.parent)) && ts.isStatement(cur))) {
    cur = cur.parent;
  }
  if (!cur.parent) return null;
  const list = ts.isSourceFile(cur.parent) ? cur.parent.statements : cur.parent.statements;
  return { stmt: cur, list };
}

function containsAwait(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isAwaitExpression(n)) {
      found = true;
      return;
    }
    if (isFunctionLike(n)) return; // an inner function's await is not ours
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function findExitAfter(writeNode) {
  const located = statementInList(writeNode);
  if (!located) return null;
  const { stmt, list } = located;
  const idx = list.indexOf(stmt);
  if (idx < 0) return null;
  const writeFn = enclosingFunction(writeNode);

  // The exit may sit inside the SAME statement (`if (x) { log(a); exit(0) }` puts both
  // in one block, so `stmt` is that block's statement) or in a following one.
  const candidates = list.slice(idx, idx + 1 + STATEMENT_LOOKAHEAD);
  for (const cand of candidates) {
    let hit = null;
    const visit = (n) => {
      if (hit) return;
      if (isProcessExitCall(n)) {
        // Must be the same synchronous path: no function boundary between.
        if (enclosingFunction(n) === writeFn && n.pos > writeNode.pos) hit = n;
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(cand);
    if (hit) {
      // An await between write and exit yields to the loop, which drains stdout.
      if (cand !== stmt && containsAwait(cand)) return null;
      return hit;
    }
    if (containsAwait(cand)) return null;
  }
  return null;
}

export function findOffendersInSource(fileName, src) {
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, kind);
  const staticConsts = collectStaticStringConsts(sf);
  const out = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isWriteTarget(node.expression)) {
      const arg = node.arguments[0];
      const cls = classifyPayload(arg, staticConsts);
      if (cls.unbounded && findExitAfter(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        out.push({ line: line + 1, why: cls.why });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const wantJson = argv.includes('--json');
  const wantReport = argv.includes('--report');

  const files = SCAN_DIRS.flatMap((d) => walk(path.join(REPO_ROOT, d)));

  // A scan that measured NOTHING is a false green — fail loudly instead.
  if (files.length === 0) {
    console.error('✗ check-undrained-stdout-exit: ZERO files walked — the scan measured nothing.');
    process.exitCode = 1;
    return;
  }

  const offenders = [];
  for (const f of files) {
    let src;
    try {
      src = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    if (!src.includes('process.exit')) continue; // cheap prefilter; the AST decides
    const rel = path.relative(REPO_ROOT, f);
    let hits;
    try {
      hits = findOffendersInSource(f, src);
    } catch {
      continue; // unparseable (not ours to police here)
    }
    for (const hit of hits) offenders.push({ file: rel, line: hit.line, why: hit.why });
  }

  const unbaselined = offenders.filter((o) => !BASELINE.has(o.file));
  const staleBaseline = [...BASELINE].filter((b) => !offenders.some((o) => o.file === b));

  if (wantJson) {
    // NOTE: this guard's own --json path must not commit the defect it polices —
    // `process.exitCode` + natural exit drains stdout in full. See the header.
    console.log(JSON.stringify({ filesScanned: files.length, offenders, unbaselined, staleBaseline }, null, 2));
    process.exitCode = unbaselined.length ? 1 : 0;
    return;
  }

  if (wantReport) {
    for (const o of offenders) console.log(`  ${o.file}:${o.line}  ${o.why}`);
    console.log(`(${offenders.length} site(s) across ${files.length} files scanned)`);
    return;
  }

  if (staleBaseline.length) {
    console.log(
      `note: ${staleBaseline.length} BASELINE entr(ies) no longer match any site — delete them:\n  ${staleBaseline.join('\n  ')}`,
    );
  }

  if (unbaselined.length) {
    console.error(
      `\n✗ lint:no-undrained-stdout-exit — ${unbaselined.length} site(s) write an unbounded payload and then call process.exit(), which truncates through a pipe:\n`,
    );
    for (const o of unbaselined) console.error(`  ${o.file}:${o.line}\n      ${o.why}`);
    console.error(
      '\n  Fix (cheapest first):\n' +
        '    1. `process.exitCode = N` and let the program end naturally — full output, status preserved.\n' +
        '    2. Drop the process.exit() entirely when the status is 0 and nothing follows.\n' +
        '    3. Must exit immediately? Use writeStdoutSync from scripts/lib/write-stdout-sync.mjs.\n',
    );
    process.exitCode = 1;
    return;
  }

  console.log(`lint:no-undrained-stdout-exit: clean — ${files.length} files scanned, no undrained write-then-exit.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { REPO_ROOT, SCAN_DIRS, BASELINE };
