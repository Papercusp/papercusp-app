#!/usr/bin/env node
/**
 * check-test-timing-budgets.mjs — fail-loud guard against a NEW test landing with a
 * TIGHT OR INVERTED WALL-CLOCK BUDGET, the undetected gate-red class filed as
 * EI-20290625014691548 and extended after the P-003 gate retry on 2026-09-13.
 *
 * ── THE CLASS ────────────────────────────────────────────────────────────────────
 * A test that asserts `expect(Date.now() - started).toBeLessThan(80)` passes in
 * isolation and fails under parallel load. That is the worst possible signal shape:
 *
 *   1. It PASSES for its author. `testing:run <file>` is green, every time. The
 *      failure needs contention the author never reproduces locally.
 *   2. It fails in the SHARED green-checkpoint run, hours later, attributed to
 *      whatever candidate happened to be cut — so the cost lands on a stranger and
 *      gets triaged as "a gate flake" rather than "a budget that is too tight".
 *   3. Nothing in the repo could SEE a timing budget. `lint:no-raw-setinterval` and
 *      `schedule:inventory` exist for exactly this reason on the SCHEDULING side; the
 *      test-timing side had no equivalent, so a tight budget stayed invisible until
 *      it fired.
 *
 * Measured history behind the floor below (EI-20290625014691548, and the two items it
 * cites): git-sync-checkpoint-resume.test.ts:294 reddened the gate at 80ms/120ms and
 * was widened to 50ms/300ms by WI-38223; its immediate sibling at :340 kept the SAME
 * 50ms emitter with a 120ms budget, reddened the gate AGAIN, and was fixed by WI-38338;
 * the :294 budget was then reported beaten a THIRD time. One defect, one file, three
 * firings — because each fix stopped at its instance and swept neither its neighbour
 * nor the class. This guard is that sweep.
 *
 *   node scripts/check-test-timing-budgets.mjs            # gate (exit 1 on a NEW site)
 *   node scripts/check-test-timing-budgets.mjs --list     # MEASURE the population
 *
 * ── THE FLOOR ────────────────────────────────────────────────────────────────────
 * TIGHT_BUDGET_FLOOR_MS is 500. Derived from the measured instances, not chosen for
 * roundness: the budgets that actually reddened this gate were 80ms and 120ms, and the
 * fixes that held went to 1500ms/15000ms. Under a loaded green-checkpoint run a process
 * routinely loses hundreds of ms to scheduling alone, so a sub-500ms upper bound on
 * elapsed wall-clock is a coin flip, not an assertion. Budgets at or above the floor are
 * left alone — this guard deliberately does NOT police slow tests, only load-fragile
 * ones.
 *
 * ── WHAT CLEARS A FINDING (the remediation IS the better pattern) ────────────────
 * A NAMED-CONSTANT budget is never flagged, only a bare numeric literal. That is the
 * point rather than a loophole: the fix WI-38338 validated is to hoist the budget into
 * named constants and assert their ORDERING in-test —
 *
 *     const GAP_MS = 200; const IDLE_DEADLINE_MS = 1_500;
 *     expect(GAP_MS).toBeLessThan(IDLE_DEADLINE_MS);
 *
 * — which converts a silent load-flake into a loud deterministic failure at the
 * assertion, on the author's own machine. So the two ways to clear this guard are the
 * two ways the class was ever actually fixed: widen the budget past the floor, or name
 * it and assert the ordering. Both are strictly better than the literal.
 *
 * ── DETECTION is TEXTUAL, not an AST parse ───────────────────────────────────────
 * Mirrors check-timer-classification.mjs / check-no-raw-setinterval.mjs. Two shapes are
 * recognised, because both occur in this tree:
 *
 *   DIRECT   expect(Date.now() - started).toBeLessThan(80)
 *   TWO-STEP const elapsed = Date.now() - started; expect(elapsed).toBeLessThan(80)
 *
 * For the two-step shape the file's elapsed-variable names are learned first, so only a
 * variable actually bound to a wall-clock delta is treated as elapsed.
 *
 * The second class is a synchronous child-process budget that is not smaller than its
 * enclosing Vitest test budget. `runGuardScript(..., { timeoutMs: 180_000 })` or
 * `spawnSync(..., { timeout: 180_000 })` inside a
 * test with the shared 60-second default can never exercise its promised timeout: Vitest
 * kills the parent first. The whole-tree undrained-stdout ratchet measured 57.3s current-
 * byte / 69.5s under the affected retry, so this exact inversion produced a false red.
 * Direct literal synchronous-child sites are parsed with TypeScript so comments, fixtures,
 * and nested calls cannot masquerade as live invocations. Give the enclosing `it`/`test`
 * an explicit larger timeout; the parent remains the final bound.
 *
 * The third class is a sub-floor IDLE / no-output-progress window handed to a child process
 * (`execProcess({ command: process.execPath, idleTimeoutMs: 300 })`). The idle clock is armed
 * at spawn, so the child's own interpreter boot is charged to its FIRST window: under the
 * gate's parallel load a `node` boot alone exceeded 300ms, the child was idle-killed before
 * it wrote a byte, and a correct test went red (WI-10004029, git-stdin-sidecar-handoff).
 * Only files that spawn a child are scanned; object-literal keys matching IDLE_WINDOW_KEY_RE
 * are read with TypeScript, and a same-file numeric `const` is RESOLVED, so hoisting the
 * literal into a name does not evade the floor. A test that deliberately wants the window to
 * fire (it asserts the idle kill, or uses the idle tick as a trigger) states so on the site:
 * `// idle-window-ok: <reason>` on the same or the preceding line. That exemption is
 * site-level and reason-carrying on purpose — a file-level baseline would also grandfather
 * a regression of the sites this class exists to protect.
 *
 * KNOWN BOUND, stated rather than implied: an elapsed budget reached through a helper, a struct
 * field (`expect(res.latencyMs).toBeLessThan(400)`), or a cross-file constant is NOT
 * detected. For child-process inversions, calls routed through a helper, aliased direct-call
 * names, or budgets held in
 * identifiers are also not resolved. For idle windows, a window passed through a helper, a
 * spread, a computed key, arithmetic, or a cross-file / non-`const` binding is not resolved.
 * This guard reports what it can see and its --list
 * output is the honest population — it is not a proof that no other tight budget exists.
 * Overstating a guard's reach is how the next reader mistakes silence for safety.
 *
 * GRANULARITY: BASELINE grandfathering is FILE-level, matching the established
 * convention in this directory. A baselined file could in principle grow a second tight
 * budget without tripping the guard; that is the same accepted tradeoff those guards
 * document, and it disappears entirely as the baseline shrinks to empty.
 *
 * ⚠ The BASELINE is SHRINK-ONLY and must be re-seeded from a MEASURING `--list` run,
 * never from a hand-run grep. Fix a file, drop its line.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { DEFAULT_UNIT_TEST_TIMEOUT_MS } from '@papercusp/test-config/vitest-config';
import { stripCommentsOnly } from './lib/strip-comments-and-strings.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Elapsed wall-clock upper bounds below this (ms) are load-fragile. See header. */
export const TIGHT_BUDGET_FLOOR_MS = 500;

/** Roots scanned for `*.test.ts`. */
const SCAN_ROOTS = ['packages', 'libs', 'apps'];

/**
 * Pre-existing tight budgets, grandfathered. SHRINK-ONLY — re-seed from `--list`.
 * Each entry is a repo-relative file path.
 */
export const BASELINE = new Set([
  // Seeded 2026-09-05 from `--list` (14 tight assertions in these 8 files). The two
  // 500ms sites (prior-attempt-context, gui-readiness/wait-until-ready) are NOT here:
  // 500 is not below the floor, so baselining them would exempt files that already pass.
  'packages/operator-core/lib/__tests__/fs-mutex.test.ts', //                      50ms
  'packages/operator-core/lib/release-checkpoint-launch.test.ts', //               80ms ×2
  'packages/operator-core/lib/agent-tools/harness/__tests__/generate-from-repo.test.ts', // 100ms
  'packages/operator-core/lib/harness-insights/__tests__/load-all.test.ts', //    200ms
  'packages/operator-core/lib/sync/pot-git/peer-dial-registry-dial-gap.test.ts', // 200ms ×3
  'packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts', //          250ms ×2
  'packages/operator-core/lib/code-intelligence/lsp-adapter.test.ts', //           250ms
  'packages/operator-core/lib/memory/corpus-recall-io.test.ts', //            200/400ms ×3
]);

/**
 * Pre-existing explicit `spawnSync` child/parent inversions. SHRINK-ONLY and keyed by
 * file + stable test title + budgets so unrelated line movement does not manufacture a
 * finding. Re-seed only from this guard's measured output.
 */
export const SPAWN_SYNC_EXPLICIT_BASELINE = new Set([
  // Seeded 2026-09-26 from the guard's measured output after direct spawnSync
  // coverage landed. Keyed more narrowly than BASELINE so a new test in any of
  // these files is still rejected.
  'packages/operator-core/lib/__tests__/check-explicit-presence.test.ts::spawnSync::runs an end-to-end positive control that forces the real ratchet red even when the corpus has zero candidates::60000::60000',
  'packages/operator-core/lib/__tests__/check-explicit-presence.test.ts::spawnSync::refuses to combine the synthetic positive control with --update::60000::60000',
  'packages/operator-core/lib/__tests__/check-shell-syntax-entrypoint.test.ts::spawnSync::resolves its TypeScript detector import under the pinned Node runtime::30000::30000',
  'packages/operator-core/lib/harness/git-sync/run-git-sync.test.ts::spawnSync::EI-20345390379109755: an orphaned config.lock is cleared before canonical submodule URL sync retries::30000::30000',
  'packages/operator-core/lib/lint-as-committed.test.ts::spawnSync::extracts REAL, committed content for a git-submodule path, not an empty gitlink dir::60000::60000',
  'packages/operator-core/lib/live-federation-gate-certified-source-window.test.ts::spawnSync::banks parseable JSON when GATE_POSTLEGS_* is unset (the set -u / unbound-variable trap)::60000::60000',
  'packages/operator-core/lib/live-federation-gate-singleton-lock-fd-inheritance.test.ts::spawnSync::THE GUARD: a child that outlives the driver does NOT hold the gate lock::60000::60000',
  'packages/operator-core/lib/live-federation-gate-verdict-bank.test.ts::spawnSync::stays valid JSON under hostile leg text, and stays bounded::60000::60000',
  'packages/operator-core/lib/release/identity-gate-archive-expansion.test.ts::spawnSync::FAILS on an identity literal hidden inside a compressed .deb payload::120000::120000',
  'packages/operator-core/lib/release/identity-gate-symlink-targets.test.ts::spawnSync::FAILS CLOSED on a .tar.zst whose zstd stream cannot be read::60000::60000',
]);

const DIRECT_RE =
  /expect\(\s*(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$][\w$]*\s*\)\s*\.toBeLessThan(?:OrEqual)?\(\s*([A-Za-z0-9_$.]+)\s*\)/g;

/** `const elapsed = Date.now() - started` — learns which locals hold a wall-clock delta. */
const ELAPSED_BINDING_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Date|performance)\.now\(\)\s*-\s*[A-Za-z_$][\w$]*/g;

/** A bare numeric literal budget (`80`, `1_500`) as opposed to a named constant. */
function literalMs(arg) {
  if (!/^[0-9][0-9_]*$/.test(arg)) return null;
  const n = Number.parseInt(arg.replace(/_/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/**
 * True when `index` falls inside a quoted string on its own line.
 *
 * Found by running this guard against its OWN test: the fixtures there are the tight
 * budgets, written as string literals, and a textual scanner cannot tell a fixture from
 * live code. Any file that DOCUMENTS or TESTS this pattern hits the same thing, so the
 * fix belongs here rather than in a BASELINE entry — baselining the guard's own test
 * would have exempted that file permanently and hidden every real budget later added
 * to it.
 *
 * Counts unescaped quotes before the match on the same line: an odd count for any
 * quote style means the match sits inside one. Line-scoped on purpose — a budget
 * assertion is a single line, so this cannot be confused by a multi-line template
 * elsewhere in the file.
 */
function insideStringLiteral(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const prefix = text.slice(lineStart, index);
  for (const q of ["'", '"', '`']) {
    let count = 0;
    for (let i = 0; i < prefix.length; i += 1) {
      if (prefix[i] === q && (i === 0 || prefix[i - 1] !== '\\')) count += 1;
    }
    if (count % 2 === 1) return true;
  }
  return false;
}

/**
 * Every elapsed-wall-clock upper bound in `text`, literal or named.
 * Returns `{ line, budgetMs, raw, named }`; `budgetMs` is null for a named constant.
 */
export function findWallClockBudgets(text) {
  const found = [];

  for (const m of text.matchAll(DIRECT_RE)) {
    if (insideStringLiteral(text, m.index ?? 0)) continue;
    const ms = literalMs(m[1]);
    found.push({ line: lineOf(text, m.index ?? 0), budgetMs: ms, raw: m[1], named: ms === null });
  }

  const elapsedNames = new Set();
  for (const m of text.matchAll(ELAPSED_BINDING_RE)) elapsedNames.add(m[1]);
  if (elapsedNames.size > 0) {
    const names = [...elapsedNames].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const twoStep = new RegExp(
      `expect\\(\\s*(?:${names})\\s*\\)\\s*\\.toBeLessThan(?:OrEqual)?\\(\\s*([A-Za-z0-9_$.]+)\\s*\\)`,
      'g',
    );
    for (const m of text.matchAll(twoStep)) {
      if (insideStringLiteral(text, m.index ?? 0)) continue;
      const ms = literalMs(m[1]);
      found.push({ line: lineOf(text, m.index ?? 0), budgetMs: ms, raw: m[1], named: ms === null });
    }
  }

  return found;
}

/**
 * True when `text` contains a TIGHT LITERAL elapsed budget (< the floor).
 * A named-constant budget is never tight by this predicate — see the header.
 */
export function hasTightLiteralBudget(text, floorMs = TIGHT_BUDGET_FLOOR_MS) {
  return findWallClockBudgets(text).some((b) => b.budgetMs !== null && b.budgetMs < floorMs);
}

function numericLiteralMs(node) {
  if (!node || !ts.isNumericLiteral(node)) return null;
  const value = Number.parseInt(node.text.replaceAll('_', ''), 10);
  return Number.isFinite(value) ? value : null;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function isTestCallExpression(expression) {
  if (ts.isIdentifier(expression)) return expression.text === 'it' || expression.text === 'test';
  if (!ts.isPropertyAccessExpression(expression)) return false;
  let base = expression.expression;
  while (ts.isPropertyAccessExpression(base)) base = base.expression;
  return ts.isIdentifier(base) && (base.text === 'it' || base.text === 'test');
}

/**
 * Direct synchronous child-process budgets that can outlive their enclosing Vitest parent.
 * Literal-only by design: a symbolic budget is not guessed, and a helper invocation has
 * no enclosing test ancestor at the call site. Both bounds are documented above.
 */
export function findNestedChildBudgetInversions(
  text,
  fileName = 'fixture.test.ts',
  defaultParentMs = DEFAULT_UNIT_TEST_TIMEOUT_MS,
) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const inversions = [];

  const directChildBudget = (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return null;
    const call = node.expression.text;
    const shape = call === 'runGuardScript'
      ? { optionsIndex: 2, timeoutKey: 'timeoutMs' }
      : call === 'spawnSync'
        ? { optionsIndex: 2, timeoutKey: 'timeout' }
        : null;
    if (!shape || node.arguments.length <= shape.optionsIndex) return null;
    const options = node.arguments[shape.optionsIndex];
    if (!ts.isObjectLiteralExpression(options)) return null;
    const timeoutProperty = options.properties.find(
      (property) => ts.isPropertyAssignment(property) && propertyNameText(property.name) === shape.timeoutKey,
    );
    const timeoutMs = timeoutProperty && ts.isPropertyAssignment(timeoutProperty)
      ? numericLiteralMs(timeoutProperty.initializer)
      : null;
    return timeoutMs === null ? null : { call, timeoutMs };
  };

  const visit = (node) => {
    const childBudget = directChildBudget(node);
    if (childBudget) {
      const childTimeoutMs = childBudget.timeoutMs;
      let ancestor = node.parent;
      while (ancestor) {
        if (ts.isCallExpression(ancestor) && isTestCallExpression(ancestor.expression)) {
          const explicitParentMs = numericLiteralMs(ancestor.arguments[2]);
          const parentTimeoutMs = explicitParentMs ?? defaultParentMs;
          const titleNode = ancestor.arguments[0];
          const testName = titleNode && ts.isStringLiteralLike(titleNode) ? titleNode.text : '<dynamic-test-title>';
          // There are dozens of legacy direct spawnSync calls relying on the shared
          // default. Gate the explicit contradiction class that produced WI-10003256;
          // implicit direct-spawn coverage is a documented detector bound.
          if (
            childTimeoutMs >= parentTimeoutMs &&
            !(childBudget.call === 'spawnSync' && explicitParentMs === null)
          ) {
            inversions.push({
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              childCall: childBudget.call,
              testName,
              childTimeoutMs,
              parentTimeoutMs,
              parentSource: explicitParentMs === null ? 'implicit-default' : 'explicit',
            });
          }
          break;
        }
        ancestor = ancestor.parent;
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return inversions;
}

/**
 * Idle / no-output-progress windows handed to a child process below this (ms) race the
 * child's own boot. 1000ms: a `node` boot under the gate's stateful lane measured 300ms+,
 * and the WI-10004029 fix settled on 1500ms. TIGHT_BUDGET_FLOOR_MS (500) bounds an elapsed
 * assertion and is too low for a window that also contains interpreter start-up.
 */
export const IDLE_WINDOW_FLOOR_MS = 1000;

/** Option keys that arm an idle / no-progress window. `progressIntervalMs` is NOT one. */
export const IDLE_WINDOW_KEY_RE =
  /^(?:idle|noOutput|noProgress|progress|stall|inactivity)(?:Timeout|TimeoutMs|WindowMs|DeadlineMs|Ms)$/i;

/** A file is eligible only when it spawns a child (tested on comment-stripped text). */
export const SPAWNS_CHILD_RE =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork|execProcess|managedSpawn|execa)\s*\(|\bprocess\.execPath\b/;

/** Site-level, reason-carrying exemption for a deliberately short window. See header. */
export const IDLE_WINDOW_EXEMPTION_RE = /idle-window-ok:\s*\S/;

/**
 * Pre-existing sub-floor idle windows, grandfathered by FILE. SHRINK-ONLY — re-seed only
 * from a measuring `--list` run. Empty at introduction: every measured site was either
 * fixed or carries an `idle-window-ok:` exemption.
 */
export const IDLE_WINDOW_BASELINE = new Set([]);

/**
 * Literal and same-file-`const` idle windows in object literals. Non-positive values are
 * invalid-policy fixtures, not windows, and are skipped. A binding declared more than once
 * with different values (or also as `let`/`var`) is ambiguous and is not resolved.
 */
export function findChildIdleWindowBudgets(text, fileName = 'fixture.test.ts') {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const bindings = new Map();
  const record = (name, value) => {
    const prev = bindings.has(name) ? bindings.get(name) : undefined;
    bindings.set(name, prev === undefined || prev === value ? value : null);
  };
  const collect = (node) => {
    if (ts.isVariableDeclarationList(node)) {
      const isConst = (node.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        record(declaration.name.text, isConst ? numericLiteralMs(declaration.initializer) : null);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const lines = text.split('\n');
  const found = [];
  const visit = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        let key = null;
        let valueNode = null;
        if (ts.isPropertyAssignment(property)) {
          key = propertyNameText(property.name);
          valueNode = property.initializer;
        } else if (ts.isShorthandPropertyAssignment(property)) {
          key = property.name.text;
          valueNode = property.name;
        }
        if (!key || !IDLE_WINDOW_KEY_RE.test(key)) continue;
        let budgetMs = numericLiteralMs(valueNode);
        let via = 'literal';
        if (budgetMs === null && valueNode && ts.isIdentifier(valueNode)) {
          const resolved = bindings.get(valueNode.text);
          if (typeof resolved === 'number') {
            budgetMs = resolved;
            via = `const ${valueNode.text}`;
          }
        }
        if (budgetMs === null || budgetMs <= 0) continue;
        const line = source.getLineAndCharacterOfPosition(property.getStart(source)).line + 1;
        const exempt =
          IDLE_WINDOW_EXEMPTION_RE.test(lines[line - 1] ?? '') ||
          IDLE_WINDOW_EXEMPTION_RE.test(lines[line - 2] ?? '');
        found.push({ line, key, budgetMs, via, exempt });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function walkTestFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkTestFiles(p, out);
    else if (e.isFile() && p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function nestedInversionKey(rel, inversion) {
  return [
    rel,
    inversion.childCall,
    inversion.testName,
    inversion.childTimeoutMs,
    inversion.parentTimeoutMs,
  ].join('::');
}

function main() {
  const listMode = process.argv.includes('--list');
  const files = [];
  for (const root of SCAN_ROOTS) {
    try {
      if (statSync(join(REPO_ROOT, root)).isDirectory()) walkTestFiles(join(REPO_ROOT, root), files);
    } catch {
      /* root absent — skip */
    }
  }

  const offenders = [];
  const measured = [];
  const nestedInversions = [];
  const idleMeasured = [];
  const idleOffenders = [];
  for (const abs of files) {
    let rawText;
    let text;
    try {
      rawText = readFileSync(abs, 'utf8');
      // Mask comments before matching (guard-string-literal-blindness): a `// budget: 50ms`
      // note or a doc comment quoting `toBeLessThan(5)` must not mint a phantom tight budget.
      // Ranges are blanked in place, so `lineOf` still reports the original line.
      text = stripCommentsOnly(rawText, abs);
    } catch {
      continue;
    }
    const rel = relative(REPO_ROOT, abs);
    if (rawText.includes('runGuardScript') || rawText.includes('spawnSync')) {
      for (const inversion of findNestedChildBudgetInversions(rawText, abs)) {
        const baselineKey = nestedInversionKey(rel, inversion);
        if (inversion.childCall === 'spawnSync' && SPAWN_SYNC_EXPLICIT_BASELINE.has(baselineKey)) continue;
        nestedInversions.push({ rel, baselineKey, ...inversion });
      }
    }
    if (SPAWNS_CHILD_RE.test(text)) {
      for (const window of findChildIdleWindowBudgets(rawText, abs)) {
        idleMeasured.push({ rel, ...window });
        if (window.budgetMs < IDLE_WINDOW_FLOOR_MS && !window.exempt && !IDLE_WINDOW_BASELINE.has(rel)) {
          idleOffenders.push({ rel, ...window });
        }
      }
    }
    if (text.includes('.now()')) {
      for (const b of findWallClockBudgets(text)) {
        if (b.budgetMs === null) continue;
        measured.push({ rel, ...b });
        if (b.budgetMs < TIGHT_BUDGET_FLOOR_MS && !BASELINE.has(rel)) offenders.push({ rel, ...b });
      }
    }
  }

  if (listMode) {
    measured.sort((a, b) => a.budgetMs - b.budgetMs || a.rel.localeCompare(b.rel));
    for (const m of measured) {
      const mark = m.budgetMs < TIGHT_BUDGET_FLOOR_MS ? (BASELINE.has(m.rel) ? 'BASELINE' : 'TIGHT   ') : 'ok      ';
      console.log(`${mark} ${String(m.budgetMs).padStart(6)}ms  ${m.rel}:${m.line}`);
    }
    const tight = measured.filter((m) => m.budgetMs < TIGHT_BUDGET_FLOOR_MS);
    console.log(
      `\n${measured.length} literal wall-clock budget(s) in ${new Set(measured.map((m) => m.rel)).size} file(s); ` +
        `${tight.length} below the ${TIGHT_BUDGET_FLOOR_MS}ms floor, in ${new Set(tight.map((m) => m.rel)).size} file(s).`,
    );
    console.log(`${nestedInversions.length} direct synchronous child/parent timeout inversion(s).`);
    idleMeasured.sort((a, b) => a.budgetMs - b.budgetMs || a.rel.localeCompare(b.rel));
    for (const w of idleMeasured) {
      const mark = w.budgetMs >= IDLE_WINDOW_FLOOR_MS
        ? 'ok      '
        : w.exempt ? 'EXEMPT  ' : IDLE_WINDOW_BASELINE.has(w.rel) ? 'BASELINE' : 'TIGHT   ';
      console.log(`IDLE-WIN ${mark} ${String(w.budgetMs).padStart(6)}ms  ${w.rel}:${w.line}  ${w.key} (${w.via})`);
    }
    console.log(
      `${idleMeasured.length} child idle window(s); ` +
        `${idleMeasured.filter((w) => w.budgetMs < IDLE_WINDOW_FLOOR_MS).length} below the ${IDLE_WINDOW_FLOOR_MS}ms floor ` +
        `(${idleMeasured.filter((w) => w.budgetMs < IDLE_WINDOW_FLOOR_MS && w.exempt).length} exempted on-site).`,
    );
    console.log('Re-seed BASELINE from the TIGHT/BASELINE paths above — never from a hand-run grep.');
    return;
  }

  if (idleOffenders.length > 0) {
    console.error(
      `\n✖ ${idleOffenders.length} child idle window(s) below the ${IDLE_WINDOW_FLOOR_MS}ms floor ` +
        '(not exempted, not in IDLE_WINDOW_BASELINE):\n',
    );
    for (const o of idleOffenders) console.error(`   ${o.rel}:${o.line}  ${o.key} ${o.budgetMs}ms (${o.via})`);
    console.error(
      "\nThe idle clock is armed at spawn, so the child's interpreter boot is charged to its FIRST\n" +
        'window; under the gate\'s parallel load a node boot alone exceeds 300ms and a correct test\n' +
        `is idle-killed before it writes a byte. Use a window of at least ${IDLE_WINDOW_FLOOR_MS}ms (a named\n` +
        'const plus an in-test ordering assertion). If the test WANTS the window to fire, say so on\n' +
        'the site: `// idle-window-ok: <reason>` on the same or the preceding line.\n',
    );
    if (offenders.length === 0 && nestedInversions.length === 0) process.exit(1);
  }

  if (offenders.length > 0 || nestedInversions.length > 0) {
    if (nestedInversions.length > 0) {
      console.error(`\n✖ ${nestedInversions.length} synchronous child/parent timeout inversion(s):\n`);
      for (const o of nestedInversions) {
        console.error(
          `   ${o.rel}:${o.line}  ${o.childCall} child ${o.childTimeoutMs}ms >= ` +
            `${o.parentSource} parent ${o.parentTimeoutMs}ms\n` +
            `      baseline key: ${o.baselineKey}`,
        );
      }
      console.error(
        '\nGive the enclosing it()/test() an explicit timeout larger than the child budget.\n' +
          'A child timeout that outlives its parent is unreachable: Vitest kills the test first,\n' +
          'manufacturing a timeout red while the guarded subprocess is still validly running.\n',
      );
    }
    if (offenders.length === 0) process.exit(1);
    console.error(
      `\n✖ ${offenders.length} NEW tight wall-clock timing budget(s) — below the ` +
        `${TIGHT_BUDGET_FLOOR_MS}ms floor and not in the BASELINE:\n`,
    );
    for (const o of offenders) console.error(`   ${o.rel}:${o.line}  budget ${o.budgetMs}ms`);
    console.error(
      '\nA sub-floor budget on elapsed wall-clock passes in isolation and fails under the\n' +
        'parallel load of the shared green-checkpoint run — reddening the gate for a stranger,\n' +
        'hours later, where it reads as a flake. Two ways to clear this, both better than the\n' +
        'literal:\n' +
        `  1. Widen the budget past ${TIGHT_BUDGET_FLOOR_MS}ms if the test is really timing an operation.\n` +
        '  2. Hoist it into named constants and assert their ORDERING in-test\n' +
        '     (expect(GAP_MS).toBeLessThan(IDLE_DEADLINE_MS)) — this turns a silent load-flake\n' +
        "     into a loud deterministic failure on the author's own machine. Named budgets are\n" +
        '     never flagged.\n' +
        'Grandfathering a genuinely-justified site means adding it to BASELINE with a reason —\n' +
        'the set is SHRINK-ONLY, so prefer fixing it.\n',
    );
    process.exit(1);
  }

  console.log(
    `✓ no NEW tight wall-clock timing budgets (floor ${TIGHT_BUDGET_FLOOR_MS}ms, ` +
      `${BASELINE.size} file(s) baselined), direct synchronous child/parent timeout inversions, ` +
      `or sub-${IDLE_WINDOW_FLOOR_MS}ms child idle windows. ` +
      '--list to measure the population.',
  );
}

if (isCliEntry(import.meta.url)) main();
