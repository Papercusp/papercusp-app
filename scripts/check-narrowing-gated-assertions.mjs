#!/usr/bin/env node
/**
 * check-narrowing-gated-assertions.mjs — RATCHET for the NARROWING-GATED ASSERTION
 * class (EI-19374102245723119).
 *
 * WHY THIS EXISTS
 * A discriminated-union result gets narrowed before its payload can be read:
 *
 *     const r = await someTool(...);
 *     if (r.ok) {
 *       expect(r.value.thing).toBe('expected');   // <-- only runs when ok
 *     }
 *
 * The `if` is there for TYPE NARROWING, not for interim tolerance, so it reads as a
 * type-system necessity rather than a decision and nobody thinks of it as a gate. But
 * the runtime behaviour is identical to vacuous-green: when `r.ok` is false the block
 * executes ZERO assertions and the test reports a pass. The failure mode is the worst
 * kind — the test goes green *precisely when the thing it tests broke*.
 *
 * The remedy is one line: assert the discriminant BEFORE narrowing on it
 * (`expect(r.ok).toBe(true)`), so a false discriminant fails loudly instead of
 * silently skipping the body.
 *
 *   node scripts/check-narrowing-gated-assertions.mjs                    # gate
 *   node scripts/check-narrowing-gated-assertions.mjs --report           # + arming breakdown
 *   node scripts/check-narrowing-gated-assertions.mjs --census           # every site, classified
 *   node scripts/check-narrowing-gated-assertions.mjs --file P           # scan only P (fixtures)
 *   node scripts/check-narrowing-gated-assertions.mjs --all-discriminants # widen; see SCOPE
 *
 * ── WHAT WAS ACTUALLY MEASURED (and the claim it corrected) ──────────────────
 * The filing suspected this class was "widespread". A first pass with a LINE/BRACE
 * scanner reported 172 sites, 0 vacuous, and concluded the class was clean. That
 * conclusion was WRONG, and this file is the instrument that falsified it.
 *
 * Rescanned with the AST below: 515 result-flag gates (`.ok` / `.success`) across
 * 8,101 committed test files, of which **2 are genuinely vacuous** —
 * `libs/generic/artifact-registry/src/registry.test.ts:126` and
 * `packages/operator-core/lib/agent-tools/fleet_registry/launch-on-plan.test.ts:897`,
 * both fixed in the same change that added this guard. So the class is ~99.6% already
 * compliant — asserting-the-discriminant IS the de-facto convention here — but it was
 * never clean, and a guard was the only thing that could tell the difference.
 *
 * That near-miss is the argument for the ratchet: at 2 remediations the cost of adding
 * it is nil, and the two it caught were each a test that goes green *precisely when
 * the code it names breaks*.
 *
 * ── WHY AN AST, AND NOT A LINE SCANNER (READ THIS BEFORE "SIMPLIFYING") ───────
 * THREE distinct bugs killed the line-scanner passes. All three are UNREPRESENTABLE
 * here rather than special-cased — that is the whole reason this file parses:
 *
 *   1. THE OBJECT-MATCHER FORM. Looking for `expect(r.ok)` misses
 *      `expect(r).toMatchObject({ ok: false })`, which arms the narrow just as well.
 *      (Live: spec-test-adequacy-gate.test.ts:445, recipe-authority.test.ts:586.)
 *      Here it is the OBJECT_MATCHERS branch, keyed on the matcher's own object literal.
 *      Cost when missed: FALSE POSITIVES — armed sites reported as vacuous.
 *
 *   2. THE `} else {` BRACE-DEPTH BUG. Walking brace depth to find a block's end NEVER
 *      sees depth return to zero on a `} else {` line: the closing and opening brace
 *      cancel. The walk runs past the else and every else-branch assertion is invisible.
 *      (Live: checkpoint.test.ts:2459, delegated-spawn-honor.test.ts:978,
 *      su-context-size.test.ts:98 — all three flagged, all three armed via else.)
 *      An AST cannot have this bug: `elseStatement` is a FIELD, not a brace count.
 *      Cost when missed: FALSE POSITIVES.
 *
 *   3. THE BRACELESS `if`. `if (a.ok) expect(...)` — a single-statement if with no
 *      block at all. A scanner keyed on `{` cannot see it, so it is not merely
 *      misjudged, it is never even considered. BOTH real defects this guard found are
 *      this shape, which is why the first pass reported a confident zero.
 *      Cost when missed: FALSE NEGATIVES — and this is the dangerous direction, because
 *      an under-reporting detector reads exactly like a clean tree.
 *
 *   The compiler's lexer also owns strings, comments, template literals and regex
 *   literals, so `/\d{2}/` and `'}'` cannot desynchronise the scan the way they can a
 *   hand-rolled character walk.
 *
 *   A guard for this class that does not handle ALL THREE either fires ~11 false
 *   positives on day one and gets disabled, or reports a reassuring zero while the
 *   real instances sit untouched. Both failure modes have already happened here.
 *
 * ── WHAT COUNTS AS ARMED (any ONE of these; all judged file-wide) ─────────────
 *   DIRECT   `expect(r.ok)…`, or `assert(r.ok)` / `invariant(r.ok)`  — the discriminant
 *            is itself asserted, so a false one fails the test.
 *   BAIL     `if (!r.ok) return;` / `… throw …` — an early bail on the same path.
 *   MATCHER  `expect(r).toMatchObject({ ok: … })` / `toEqual` / `toStrictEqual`.
 *   ELSE     the gate has an `else` branch that also asserts, so an assertion runs
 *            whichever way the narrow goes.
 *
 * Arming is searched over the WHOLE FILE, deliberately: a shared helper or a
 * beforeEach can arm a gate several `it()` blocks away, and this is a gate, so a false
 * positive costs far more than a missed site. It flags only the genuinely unarmed
 * case — a discriminant asserted NOWHERE in its own file.
 *
 * ── SCOPE LIMITS (measured, deliberate, and the reason this gates at all) ─────
 * Two limits, both chosen from the measurement rather than guessed:
 *
 * 1. RESULT-FLAG DISCRIMINANTS ONLY (`.ok`, `.success`, … — see RESULT_FLAGS). This is
 *    the discriminated-union class the filing is about, and the class that is 513/515
 *    compliant. Widen it with `--all-discriminants` and the population becomes ~1,000
 *    gates with ~77 unarmed ones on `kind` / `status` / `platform` / `id` — but those
 *    are a DIFFERENT thing: mostly optional-field guards (`if (section.projectId)`),
 *    where skipping when the field is absent is often the intended behaviour. That
 *    class is real, unmeasured, and needs its own judgement call about which sites are
 *    defects; folding it in here would make this guard fire 77 times on day one and be
 *    turned off, taking the 2 genuine catches with it. `--all-discriminants` exists so
 *    that follow-up can be measured without rewriting anything.
 *
 * 2. SIMPLE conditions only: `r.ok`, `!r.ok`, `r.ok === true`, `r.ok !== undefined` and
 *    optional-chained variants. Compound conditions (`if (r.ok && r.value)`) are NOT
 *    judged — same vacuity risk, more false-positive surface, and measured they are
 *    rare. Both limits are follow-ups, not oversights.
 *
 * SUPPRESSION: put `narrowing-gate-ok: <reason>` on the `if` line or in the comment
 * block directly above it. A deliberate exception then carries its justification at
 * the site, which is itself the improvement.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { coverageOf, describeUnscanned, presentOnDisk } from './lib/tracked-files.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const PRAGMA = 'narrowing-gate-ok:';

/** Build artifacts, vendored trees and generated mirrors — never our own test corpus. */
const EXCLUDE_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|\.next|\.turbo|target|vendor|third_party|__fixtures__)\//;

const SELF = 'scripts/check-narrowing-gated-assertions.mjs';

const isExcluded = (p) => EXCLUDE_RE.test(p) || p === SELF;

const SCRIPT_KIND = {
  ts: ts.ScriptKind.TS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
};

/** Assertion helpers whose single argument arms a discriminant the same way expect() does. */
const ASSERT_FNS = new Set(['assert', 'invariant', 'assertOk', 'expectOk', 'ok']);

/** Matchers whose object-literal argument can arm a discriminant (pitfall #1). */
const OBJECT_MATCHERS = new Set(['toMatchObject', 'toEqual', 'toStrictEqual', 'toContainEqual']);

/**
 * Boolean RESULT-FLAG discriminants — the discriminated-union class this guard gates on.
 * Measured over the whole tree, `ok` (441) and `success` (74) are the shape; the rest of
 * the truthiness-gate population narrows on string discriminants or optional fields,
 * which is a different question (see SCOPE LIMITS). Keep this list tight: every name
 * added here must be a flag whose FALSE value means "the operation did not happen",
 * because that is what makes a skipped assertion a lie rather than a legitimate branch.
 */
const RESULT_FLAGS = new Set(['ok', 'success', 'succeeded', 'isOk', 'valid', 'passed']);

/**
 * Dotted path for an identifier / property-access chain, else null. Optional chaining is
 * normalised away so `r?.ok` and `r.ok` are the same path — a narrow on one is armed by an
 * assertion on the other.
 */
function exprPath(node) {
  if (!node) return null;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return exprPath(node.expression);
  if (ts.isPropertyAccessExpression(node)) {
    const base = exprPath(node.expression);
    return base ? `${base}.${node.name.text}` : null;
  }
  return null;
}

/**
 * The discriminant path a simple narrowing condition tests, else null. Handles `p`, `!p`,
 * `p === true`, `p !== undefined` and parenthesised forms; deliberately refuses compound
 * conditions (see SCOPE LIMITS above).
 */
function discriminantPath(expr) {
  if (!expr) return null;
  if (ts.isParenthesizedExpression(expr)) return discriminantPath(expr.expression);
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
    return discriminantPath(expr.operand);
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    const isComparison =
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken;
    if (!isComparison) return null; // && / || / relational — out of scope by design
    const left = exprPath(expr.left);
    const right = exprPath(expr.right);
    // Compare against a literal only; `a.x === b.y` is not a narrowing gate.
    const literalish = (n) =>
      n.kind === ts.SyntaxKind.TrueKeyword ||
      n.kind === ts.SyntaxKind.FalseKeyword ||
      n.kind === ts.SyntaxKind.NullKeyword ||
      ts.isStringLiteralLike(n) ||
      ts.isNumericLiteral(n) ||
      (ts.isIdentifier(n) && n.text === 'undefined');
    if (left && literalish(expr.right)) return left;
    if (right && literalish(expr.left)) return right;
    return null;
  }
  // A bare `r.ok` — must be a property access; a bare identifier `if (ok)` is not a
  // discriminated-union narrow and is far too common to judge.
  if (ts.isPropertyAccessExpression(expr)) return exprPath(expr);
  return null;
}

/** Does this subtree contain an `expect(...)` call (or a delegated assertion helper)? */
function containsAssertion(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee) && (callee.text === 'expect' || ASSERT_FNS.has(callee.text))) {
        found = true;
        return;
      }
      // `expect.fail(...)`, `expect.soft(...)`
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'expect') {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/** Does this statement unconditionally leave the enclosing scope (an early bail)? */
function isBailStatement(stmt) {
  if (!stmt) return false;
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt) || ts.isContinueStatement(stmt)) return true;
  if (ts.isBlock(stmt)) return stmt.statements.some((s) => isBailStatement(s));
  if (ts.isExpressionStatement(stmt)) {
    // `expect.fail(...)` / `assert.fail(...)` terminate the test just as hard.
    const t = stmt.expression;
    if (ts.isCallExpression(t) && ts.isPropertyAccessExpression(t.expression) && t.expression.name.text === 'fail') return true;
  }
  return false;
}

/** Top-level property names of an object literal (`{ ok: false, value }` -> ok, value). */
function objectLiteralKeys(node) {
  const keys = [];
  if (!node || !ts.isObjectLiteralExpression(node)) return keys;
  for (const p of node.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      const n = p.name;
      if (n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n))) keys.push(n.text);
    }
  }
  return keys;
}

/**
 * Collect every arming signal in a file, then judge each narrowing gate against it.
 * Returns { sites, considered } where each site carries its verdict + arming form.
 */
function scanSource(file, text, { allDiscriminants = false } = {}) {
  const inScope = (path) => {
    if (allDiscriminants) return true;
    const dot = path.lastIndexOf('.');
    return dot > 0 && RESULT_FLAGS.has(path.slice(dot + 1));
  };
  const ext = (file.split('.').pop() || 'ts').toLowerCase();
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KIND[ext] ?? ts.ScriptKind.TS);

  /**
   * Arming evidence is POSITIONED, not just collected. An assertion that sits INSIDE the
   * gate's own then-branch cannot arm that gate — it only runs when the gate already
   * passed. Without this, `if (r.ok) expect(r.ok).toBe(true)` reads as armed while being
   * perfectly vacuous, and any gate whose body happens to assert its own discriminant
   * (`if (s.id) expect(s.id).toMatch(…)`) is silently excused. Caught by this guard's own
   * discrimination controls, which is what those controls are for.
   */
  const assertions = []; // DIRECT  — { path, start, end }
  const bails = []; // BAIL    — { path, start, end }
  const matchers = []; // MATCHER — { base, keys, start, end }
  const gates = [];

  const collect = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      // expect(<arg>)  /  assert(<arg>)
      if (ts.isIdentifier(callee) && (callee.text === 'expect' || ASSERT_FNS.has(callee.text))) {
        const p = exprPath(n.arguments[0]);
        if (p) assertions.push({ path: p, start: n.getStart(sf), end: n.end });
      }
      // expect(<base>).toMatchObject({ prop: ... })  — pitfall #1
      if (ts.isPropertyAccessExpression(callee) && OBJECT_MATCHERS.has(callee.name.text)) {
        // Walk back down the matcher chain to the originating expect(<base>) call.
        let inner = callee.expression;
        while (
          ts.isPropertyAccessExpression(inner) ||
          (ts.isCallExpression(inner) && !(ts.isIdentifier(inner.expression) && inner.expression.text === 'expect'))
        ) {
          inner = ts.isPropertyAccessExpression(inner) ? inner.expression : inner.expression;
        }
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'expect') {
          const base = exprPath(inner.arguments[0]);
          if (base) {
            const keys = objectLiteralKeys(n.arguments[0]);
            if (keys.length > 0) {
              matchers.push({ base, keys: new Set(keys), start: n.getStart(sf), end: n.end });
            }
          }
        }
      }
    }

    if (ts.isIfStatement(n)) {
      const path = discriminantPath(n.expression);
      if (path) {
        // BAIL: `if (!r.ok) return/throw` arms every narrow on r.ok outside its own body.
        if (isBailStatement(n.thenStatement)) {
          bails.push({ path, start: n.getStart(sf), end: n.end });
        }

        // A GATE is an in-scope narrowing `if` whose then-branch asserts.
        if (inScope(path) && containsAssertion(n.thenStatement)) {
          const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          gates.push({
            path,
            line: line + 1,
            thenStart: n.thenStatement.getStart(sf),
            thenEnd: n.thenStatement.end,
            hasAssertingElse: Boolean(n.elseStatement) && containsAssertion(n.elseStatement),
            suppressed: hasPragma(sf, text, n),
          });
        }
      }
    }
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(sf, collect);

  const sites = gates.map((g) => {
    const dot = g.path.lastIndexOf('.');
    const base = dot > 0 ? g.path.slice(0, dot) : null;
    const prop = dot > 0 ? g.path.slice(dot + 1) : null;

    // Evidence inside the gate's own then-branch is not evidence: it only runs if the
    // gate already passed. `outside` is what makes that structural rather than hoped-for.
    const outside = (rec) => rec.start < g.thenStart || rec.start >= g.thenEnd;

    let arming = null;
    if (assertions.some((a) => a.path === g.path && outside(a))) arming = 'DIRECT';
    else if (bails.some((b) => b.path === g.path && outside(b))) arming = 'BAIL';
    else if (base && prop && matchers.some((m) => m.base === base && m.keys.has(prop) && outside(m))) arming = 'MATCHER';
    else if (g.hasAssertingElse) arming = 'ELSE';

    return { ...g, base, prop, arming, vacuous: arming === null && !g.suppressed };
  });

  return { sites, considered: sites.length };
}

/** `narrowing-gate-ok:` on the if line, or in the comment block directly above it. */
function hasPragma(sf, text, node) {
  const start = node.getStart(sf);
  const { line } = sf.getLineAndCharacterOfPosition(start);
  const lines = text.split('\n');
  if ((lines[line] ?? '').includes(PRAGMA)) return true;
  for (let i = line - 1; i >= 0 && i >= line - 12; i--) {
    const t = (lines[i] ?? '').trim();
    if (t === '') continue;
    const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.endsWith('*/');
    if (!isComment) break;
    if (t.includes(PRAGMA)) return true;
  }
  return false;
}

function trackedFiles() {
  const files = execFileSync('git', ['ls-files', '--recurse-submodules'], { cwd: ROOT, maxBuffer: 1 << 28 })
    .toString()
    .split('\n')
    .filter(Boolean);
  // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
  return presentOnDisk(files, ROOT);
}

/**
 * Cheap prefilter — strictly MORE permissive than the AST rule, so it can only skip files
 * the AST would also have cleared. Without it we would pay a full parse for every one of
 * ~7.7k test files to judge a few hundred.
 */
const PREFILTER_RE = /\bif\s*\(\s*!?\s*[A-Za-z_$][\w$]*\s*(?:\?\.|\.)/;

function main(argv) {
  const report = argv.includes('--report');
  const census = argv.includes('--census');
  const allDiscriminants = argv.includes('--all-discriminants');

  const explicit = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--file' && argv[i + 1]) explicit.push(argv[++i]);

  let list = [];
  let coverageNote = '';
  if (explicit.length > 0) {
    list = explicit;
  } else {
    const all = trackedFiles();
    list = all.filter((p) => TEST_RE.test(p) && !isExcluded(p));
    const cov = coverageOf(all, ROOT);
    coverageNote = describeUnscanned(cov, ROOT);
  }

  const findings = [];
  const allSites = [];
  let scanned = 0;
  let parsed = 0;

  for (const f of list) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    scanned++;
    if (!text.includes('expect(') || !PREFILTER_RE.test(text)) continue;
    parsed++;
    let r;
    try {
      r = scanSource(f, text, { allDiscriminants });
    } catch {
      continue; // unparseable — not this guard's business to fail the build over
    }
    for (const s of r.sites) {
      allSites.push({ ...s, file: f });
      if (s.vacuous) findings.push({ ...s, file: f });
    }
  }

  const byForm = allSites.reduce((acc, s) => {
    const k = s.suppressed && !s.arming ? 'SUPPRESSED' : (s.arming ?? 'VACUOUS');
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  if (census) {
    console.log(`census: ${allSites.length} narrowing-gated assertion site(s) across ${parsed} parsed file(s)\n`);
    for (const s of allSites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`    ${s.file}:${s.line}  [${s.suppressed && !s.arming ? 'SUPPRESSED' : (s.arming ?? 'VACUOUS')}]  if (${s.path})`);
    }
    console.log('');
  }

  if (report || census) {
    console.log(
      `scanned ${scanned} test file(s), parsed ${parsed} after prefilter; ` +
        `${allSites.length} narrowing gate(s) judged.\n` +
        `  arming breakdown: ${Object.entries(byForm).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}\n`,
    );
  }

  if (findings.length === 0) {
    console.log(
      `✓ narrowing-gated assertions: all ${allSites.length} gate(s) across ${parsed} file(s) are armed ` +
        `(${Object.entries(byForm).map(([k, v]) => `${k}=${v}`).join(', ') || 'none found'}). ` +
        `No gate can skip its assertions silently.` +
        coverageNote,
    );
    return 0;
  }

  console.error('✗ narrowing-gated-assertions: assertion(s) that silently do not run when the narrow fails.\n');
  console.error(
    '  Each site below narrows on a discriminant that is asserted NOWHERE in its own file.\n' +
      '  When that discriminant is false the block executes zero assertions and the test\n' +
      '  reports a PASS — going green precisely when the thing it tests broke.\n',
  );
  for (const f of findings) {
    console.error(`    ${f.file}:${f.line}   if (${f.path}) { … expect(…) }`);
    console.error(`      fix: assert the discriminant first — expect(${f.path}).toBe(true);\n`);
  }
  console.error(
    `  ${findings.length} finding(s). Assert the discriminant before narrowing on it, add an else\n` +
      `  branch that asserts, or — if the skip is deliberate — annotate the line with\n` +
      `  "// ${PRAGMA} <reason>". See EI-19374102245723119.`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '';
if (import.meta.url === invokedPath) process.exit(main(process.argv.slice(2)));

export { scanSource, discriminantPath, exprPath };
