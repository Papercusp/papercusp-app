#!/usr/bin/env node
/**
 * check-drop-database-force.mjs — fail-loud guard against a `DROP DATABASE`
 * issued WITHOUT `WITH (FORCE)` (WI-4311).
 *
 * WHY THIS IS A GUARD AND NOT A STYLE RULE
 * ----------------------------------------
 * `pg_terminate_backend(pid)` only SIGNALS other backends — it returns before they
 * have actually disconnected. A plain `DROP DATABASE` issued right after can then
 * find a not-yet-closed backend and either ERROR ("is being accessed by other
 * users") or, under host I/O contention, sit BLOCKED waiting for that connection to
 * tear down before it can start its own (I/O-heavy) file cleanup. Observed on the
 * shared dev box as ~88 backends parked in `DROP DATABASE` state for 6s-267s+ under
 * heavy fleet load (WI-4311) — each one holding a connection slot against a shared,
 * fleet-hammered container, which is how one test file's teardown becomes every
 * other agent's CONNECT_TIMEOUT.
 *
 * `WITH (FORCE)` (PG13+) makes DROP DATABASE terminate the remaining connections
 * ITSELF, as part of the same statement, closing the race instead of losing it to
 * pg_terminate_backend's async signal.
 *
 * The canonical fix landed in `makeDrop()` (libs/test-config/src/pg-migrate.ts) on
 * 2026-07-12, but four hand-rolled teardown sites kept the old shape and were only
 * found 22 days later. THAT is what this guard exists to prevent: the shared helper
 * being correct is not the same as the CLASS being closed, because nothing stops the
 * next test file from hand-rolling its own teardown.
 *
 *   node scripts/check-drop-database-force.mjs
 *
 * NOTE: unlike most sibling guards, this one deliberately SCANS TEST FILES — every
 * known occurrence of this bug is in an `afterAll` teardown, so excluding tests
 * would exclude the entire bug class.
 *
 * The predicate (findUnforcedDrops) is exported + unit-tested so the "fails on a NEW
 * unforced DROP" property is durably verified, not merely green-on-a-clean-tree.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

import { describeUnscanned, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/**
 * Permanently-allowed individual files.
 *
 * Both entries are allowlisted for the SAME reason the sibling guards allowlist
 * their own definition sites: the file's job is to talk about the banned string, so
 * it necessarily contains it.
 */
export const ALLOWLIST = new Set([
  // This guard itself: its detection regex + console messages contain the pattern.
  'scripts/check-drop-database-force.mjs',
  // This guard's unit test: its fixtures are deliberately-unforced DROP statements
  // (the calibration controls that prove the predicate can FAIL). Without this the
  // guard would flag the very test that proves it works.
  'packages/operator-core/lib/drop-database-force-guard.test.ts',
  // Test FAKES that intercept DROP statements rather than issue them: a stub psql
  // that records what bin/reap-invalid-test-databases.sh drops (that script only
  // drops INVALID databases, which cannot hold connections, so it deliberately
  // omits FORCE), and a fake admin client that classifies pg-migrate's drop query.
  // Their job is to recognise the statement text, so they must contain it.
  'apps/operator/scripts/__tests__/invalid-db-reaper.test.ts',
  'libs/test-config/src/baseline-schema-reuse-generation.test.ts',
]);

/**
 * MUST STAY EMPTY. Every call site in the tree carries `WITH (FORCE)` as of
 * 2026-08-03 (WI-4311 closure: 52 forced sites, 0 unforced). A NEW unforced DROP is
 * a hard guard failure, not a BASELINE addition — there is no migration pending
 * here, so there is nothing to grandfather. If you are reading this because the
 * guard fired: add `WITH (FORCE)`, do not add your file here.
 */
export const BASELINE = new Set([]);

export const isExcluded = (f) =>
  f.startsWith('_retired/') ||
  f.includes('/_retired/') ||
  f.includes('/node_modules/') ||
  f.includes('/dist/') ||
  f.includes('/.next/') ||
  f.includes('/build/') ||
  f.includes('/storybook-static/') ||
  f.includes('/code-server/') ||
  f.includes('/env-sidecars/') || // bundled sidecar BUILD OUTPUT, not source
  f.includes('/spa/assets/') ||
  f.includes('/holepunch-spike/') ||
  !/\.(ts|mts|cts|mjs|cjs)$/.test(f);

/**
 * Strip block (including JSDoc) + line comments so PROSE about DROP DATABASE is not
 * flagged. This matters more than usual here: the correct fix is heavily commented
 * at every site, and several files discuss the hazard without issuing the statement
 * (e.g. pg-migrate.ts's own rationale, db-pgss-orphan-stats-reclaim.ts's note that
 * pg_stat_statements has no DROP DATABASE hook).
 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const DROP_RE = /\bDROP\s+DATABASE\b/i;
const FORCE_RE = /\bWITH\s*\(\s*FORCE\s*\)/i;
const SQL_EXECUTOR_NAMES = new Set(['unsafe', 'query', 'execute', 'exec']);
const SQL_TAG_NAMES = new Set(['sql']);

/**
 * Read the name at the end of a call/tag expression (for example `db.unsafe` or `sql`).
 */
function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text.toLowerCase();
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text.toLowerCase();
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text.toLowerCase();
  }
  return null;
}

/**
 * Blank everything except arguments to SQL execution calls and SQL tagged templates.
 * This keeps SQL literals visible to the guard while excluding descriptive data such
 * as DBOS cleanup step names and status tuples.
 */
function executableSqlText(text, fileName) {
  const scriptKind = /\.(?:mjs|cjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const ranges = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && SQL_EXECUTOR_NAMES.has(expressionName(node.expression))) {
      const query = node.arguments[0];
      if (query) ranges.push([query.getStart(sourceFile), query.end]);
    }
    if (ts.isTaggedTemplateExpression(node) && SQL_TAG_NAMES.has(expressionName(node.tag))) {
      ranges.push([node.template.getStart(sourceFile), node.template.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const searchable = text.split('');
  for (let i = 0; i < searchable.length; i++) {
    if (text[i] !== '\n' && text[i] !== '\r') searchable[i] = ' ';
  }
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) searchable[i] = text[i];
  }
  return searchable.join('');
}

/**
 * Find unforced `DROP DATABASE` statements. Returns [{ line, text }].
 *
 * Scans the statement's own line and the FOLLOWING line, because prettier wraps long
 * `.unsafe(...)` calls so the closing `WITH (FORCE)` can land on the next line. That
 * two-line window is why this reads lines rather than whole files: a whole-file
 * "does it contain FORCE anywhere" test would pass a file that gets it right once
 * and wrong twice — which is exactly the shape WI-4311 shipped in.
 *
 * Pure (text -> findings) so it is unit-testable without touching git or the fs.
 */
export function findUnforcedDrops(text, fileName = 'input.ts') {
  if (!DROP_RE.test(text)) return [];
  const lines = executableSqlText(text, fileName).split('\n');
  const originalLines = text.split('\n');
  const findings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!DROP_RE.test(line)) continue;
    const window = line + '\n' + (lines[i + 1] ?? '');
    if (FORCE_RE.test(window)) continue;
    findings.push({ line: i + 1, text: originalLines[i].trim() });
  }
  return findings;
}

/** Scan the tracked tree (recurses into submodules) for offenders. */
export function findOffenders() {
  const { files: tracked, unscanned } = listTrackedFiles(ROOT);

  const offenders = [];
  for (const f of tracked) {
    if (isExcluded(f)) continue;
    if (ALLOWLIST.has(f) || BASELINE.has(f)) continue;
    let text;
    try {
      text = readFileSync(new URL(f, `file://${ROOT}`), 'utf8');
    } catch {
      continue;
    }
    const hits = findUnforcedDrops(text, f);
    if (hits.length > 0) offenders.push({ file: f, hits });
  }
  return { offenders, unscanned };
}

function main() {
  const { offenders, unscanned } = findOffenders();
  if (offenders.length === 0) {
    console.log(
      '✓ every DROP DATABASE carries WITH (FORCE) — no teardown can park backends (WI-4311).' +
        describeUnscanned(unscanned),
    );
    process.exit(0);
  }
  console.error('✗ DROP DATABASE without WITH (FORCE):');
  console.error('  pg_terminate_backend() only SIGNALS — it returns before backends actually close,');
  console.error('  so a plain DROP can block for minutes waiting on them (WI-4311: ~88 parked backends).');
  console.error('  Fix: DROP DATABASE IF EXISTS "..." WITH (FORCE)\n');
  let total = 0;
  for (const o of offenders) {
    for (const h of o.hits) {
      console.error(`    ${o.file}:${h.line}  ${h.text}`);
      total++;
    }
  }
  console.error(`\n  ${total} unforced DROP(s) across ${offenders.length} file(s).`);
  process.exit(1);
}

// Run the scan only when invoked as a CLI — importing the module (for the unit test)
// must NOT exec git / exit the process. Symlink-robust (WI-1443).
const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  main();
}
