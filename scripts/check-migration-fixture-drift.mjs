#!/usr/bin/env node
/**
 * check-migration-fixture-drift.mjs — the integration-test inline-schema-fixture
 * drift trap, mechanised (EI-19359711978838614, sibling of
 * lint:required-field-strands / WI-6814).
 *
 * THE TRAP: many `*.integration.test.ts` files build a `harness_shared.<table>`
 * from an inline `CREATE TABLE` in their own `beforeAll` instead of applying real
 * migrations. When a LATER migration ALTERs that same table to add a column, and
 * production code moves with it (queries the new column unconditionally), a
 * fixture that happened to mirror the schema up to that point goes stale
 * silently — `test:affected` will not select the fixture file (the migration's
 * own change never touches it) and `lint:tsc` cannot see drift in a SQL string.
 * The red then surfaces on whichever unrelated agent next touches that test
 * file, who inherits a failure they did not cause. (First instance:
 * `store.integration.test.ts` red on `column "root_id" does not exist"`, from
 * migration 572, landed weeks after the fixture — EI-19359711978838614.)
 *
 * WHY THIS IS A TRIGGER, NOT A FULL SCHEMA-DIFF LINT:
 *   A large fraction of these fixtures are INTENTIONALLY partial stubs by
 *   design — e.g. the hive-eval fixture hand-writes "only the columns the live
 *   reads query", forever, on purpose. A blanket "every migrated column must
 *   appear in every fixture" check would be close to 100% false-positive on
 *   this tree and could never be wired in as a gate (mirrors the caution in
 *   check-required-field-strands.mjs's own header: the class here is common and
 *   usually intentional). So this only fires on the DIFF a migration itself
 *   introduces: does the column you just added to a table already appear in
 *   some OTHER fixture that constructs that exact table? If so, that fixture
 *   used to be schema-complete for every column it names and just silently
 *   fell one column behind — a precise, low-noise signal, independent of
 *   whether the fixture is a deliberate stub (a deliberate stub was ALREADY
 *   missing unrelated columns before this migration ran, so it never matches:
 *   the table has to already appear with a full column list, sans exactly the
 *   new one).
 *
 * Advisory by default (never blocks); --check exits 1 on any structural gap
 * found. No DB connection required — a fixture literally omitting a column the
 * live migrated schema now has IS the drift; nothing here needs runtime proof.
 *
 * Usage:
 *   node scripts/check-migration-fixture-drift.mjs <migration.sql> [...]
 *   node scripts/check-migration-fixture-drift.mjs --check <migration.sql> [...]
 *   node scripts/check-migration-fixture-drift.mjs --base HEAD    # diff mode: changed/added sql/ files vs base
 *   node scripts/check-migration-fixture-drift.mjs --json
 *
 * Exit codes:
 *   0 — no migrations given / no columns introduced / no fixture matches, or advisory mode
 *   1 — --check found a structural gap (a fixture that builds the exact table, missing the
 *       exact column this migration just introduced)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { presentOnDisk } from './lib/tracked-files.mjs';
import { fileURLToPath } from 'node:url';

import { isRepositoryIndexFault, runGuardWithIndexFaultGuard, withGitIndexFaultRetry } from './lib/git-index-fault.mjs';
import { stripCommentsAndStrings, stripCommentsOnly, stripSqlComments } from './lib/strip-comments-and-strings.mjs';
import { parseExplicitFiles } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SQL_DIR_REL = 'libs/papercusp/libs/db/sql';

// ---------------------------------------------------------------------------
// SQL parsing primitives — comment/string-aware, no dollar-quoting support
// (CREATE TABLE / ALTER TABLE ADD COLUMN bodies in this tree never use it).
// ---------------------------------------------------------------------------

/**
 * From `openParenIdx` (the index of a `(`), walk forward tracking paren depth,
 * skipping `--` line comments and `'...'` string literals, until the matching
 * close. Returns the body between the parens (exclusive) and the index one
 * past the closing paren.
 */
export function extractParenBlock(src, openParenIdx) {
  let i = openParenIdx + 1;
  let depth = 1;
  const n = src.length;
  while (i < n && depth > 0) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    i++;
  }
  return { body: src.slice(openParenIdx + 1, i - 1), endIndex: i };
}

/** Split a CREATE TABLE body into top-level (paren-depth-0) comma-separated clauses. */
export function splitTopLevelClauses(body) {
  const clauses = [];
  let depth = 0;
  let cur = '';
  const n = body.length;
  for (let i = 0; i < n; i++) {
    const c = body[i];
    if (c === '-' && body[i + 1] === '-') {
      // Skip the comment's TEXT entirely (don't append it to `cur`) — a column
      // declaration on the line right after a `-- comment` would otherwise have
      // the comment text glued onto the front of its clause, so the leading
      // `^"?(\w+)"?\s` identifier match in columnNamesFromClauses fails and the
      // column is silently dropped (measured: store.integration.test.ts's
      // `node_id` column, preceded by 4 comment lines, was missed this way).
      const nl = body.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      i = end - 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n && body[j] !== "'") {
        if (body[j] === '\\') j++;
        j++;
      }
      cur += body.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(') {
      depth++;
      cur += c;
      continue;
    }
    if (c === ')') {
      depth--;
      cur += c;
      continue;
    }
    if (c === ',' && depth === 0) {
      clauses.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) clauses.push(cur);
  return clauses;
}

const TABLE_LEVEL_KEYWORDS = /^(PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT|FOREIGN\s+KEY|EXCLUDE|LIKE)\b/i;

/** Column names declared by top-level clauses, skipping table-level constraint clauses. */
export function columnNamesFromClauses(clauses) {
  const names = [];
  for (const clause of clauses) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    if (TABLE_LEVEL_KEYWORDS.test(trimmed)) continue;
    const m = /^"?(\w+)"?\s/.exec(trimmed);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Every `CREATE TABLE (IF NOT EXISTS)? harness_shared.<table> ( ... )` occurrence
 * in `sqlText`, as `{ table, columns }` — one entry per occurrence (a file may
 * define the same table more than once across describe blocks).
 */
export function findCreateTables(sqlText, schema = 'harness_shared') {
  const out = [];
  const re = new RegExp(
    'CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?' + escapeRe(schema) + '\\.(\\w+)\\s*\\(',
    'gi',
  );
  let m;
  while ((m = re.exec(sqlText))) {
    const openIdx = m.index + m[0].length - 1;
    const { body, endIndex } = extractParenBlock(sqlText, openIdx);
    out.push({ table: m[1], columns: columnNamesFromClauses(splitTopLevelClauses(body)) });
    re.lastIndex = endIndex;
  }
  return out;
}

/**
 * Every `ALTER TABLE (IF EXISTS)? <schema>.<table> ... ADD COLUMN ...` statement
 * (up to its terminating `;`) in `sqlText`, as `{ table, columns }` — a single
 * statement may add several columns comma-separated.
 */
export function findAlterTableAddColumns(sqlText, schema = 'harness_shared') {
  const out = [];
  const re = new RegExp('ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?' + escapeRe(schema) + '\\.(\\w+)', 'gi');
  let m;
  while ((m = re.exec(sqlText))) {
    const table = m[1];
    const stmtStart = m.index;
    const semi = sqlText.indexOf(';', stmtStart);
    const stmtEnd = semi === -1 ? sqlText.length : semi + 1;
    const stmtText = sqlText.slice(stmtStart, stmtEnd);
    const addRe = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
    const columns = [];
    let am;
    while ((am = addRe.exec(stmtText))) columns.push(am[1]);
    if (columns.length) out.push({ table, columns });
    re.lastIndex = stmtEnd;
  }
  return out;
}

/**
 * Every column a migration file INTRODUCES on a `harness_shared` table — from
 * an initial `CREATE TABLE` or a later `ALTER TABLE ... ADD COLUMN`. Returns
 * `{ table, column }` pairs (deduplicated).
 */
export function extractIntroducedColumns(sqlText, schema = 'harness_shared') {
  // Mask SQL comments FIRST — this input is definitionally a migration file, so the
  // dispatch is unconditional (no filename needed). Measured on the real sql/ dir, the
  // unmasked scan was wrong in BOTH directions:
  //   • PHANTOM — `563-memory-federation-capture-triggers.sql` line 18 is a commented-out
  //     `-- ALTER TABLE harness_shared.memory_canonical`, off which the raw scan harvested
  //     5 columns that no migration ever introduced.
  //   • FALSE NEGATIVE (the worse one) — findAlterTableAddColumns ends a statement at the
  //     first `;`, and English prose in an interior comment routinely contains one
  //     ("...the schedule deactivates; the plan is NOT deleted."). That truncates the
  //     statement mid-way, so every ADD COLUMN after the comment is invisible. Measured on
  //     `299-scheduled-plans-schedule-fields.sql`: 7 of its 14 introduced columns were
  //     silently dropped (scheduled_at, expires_at, tzid, template_slug, run_seq, outcome,
  //     result_summary) — i.e. the guard under-reported by half on a live migration.
  // Blanking is length-preserving, so every offset/index below is unaffected.
  sqlText = stripSqlComments(sqlText);
  const seen = new Set();
  const out = [];
  const add = (table, column) => {
    const key = table + '.' + column;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ table, column });
  };
  for (const { table, columns } of findCreateTables(sqlText, schema)) {
    for (const column of columns) add(table, column);
  }
  for (const { table, columns } of findAlterTableAddColumns(sqlText, schema)) {
    for (const column of columns) add(table, column);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Fixture-gap detection
// ---------------------------------------------------------------------------

/** Tracked `*.integration.test.ts` files, repo-root-relative, excluding `_retired/`. */
export function listIntegrationTestFiles(root = ROOT, gitLsFiles = defaultGitLsFiles) {
  return gitLsFiles(root).filter((f) => f.endsWith('.integration.test.ts') && !f.startsWith('_retired/'));
}

/**
 * EI-22703095921400106. This is the POPULATION source for the whole guard, so a failure that
 * flattens to `[]` does not report "no drift found" — it reports "I scanned nothing" wearing
 * the same face. MEASURED 2026-09-08 on this tree with a 0-byte `GIT_INDEX_FILE`: this helper
 * returned 981 files healthy and **0 files, no error thrown** torn, so every fixture-drift
 * finding silently disappears while the guard still exits 0.
 *
 * That is the false-GREEN direction, strictly worse than the false-RED this work-item began
 * from: a crashed guard reds the gate loudly and gets fixed; a guard that scans zero files and
 * passes lets real drift through and nobody ever learns. An unreadable index therefore THROWS
 * (the caller turns it into an explicit NOT CHECKED), while every OTHER failure keeps the quiet
 * `[]` this was written for. stderr is captured so the classifier can see git's own diagnostic
 * and so it stays out of guard output.
 */
function defaultGitLsFiles(root) {
  try {
    const out = withGitIndexFaultRetry(() =>
      execFileSync('git', ['ls-files', '--', '*.integration.test.ts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    return presentOnDisk(out.split('\n').filter(Boolean), root);
  } catch (error) {
    if (isRepositoryIndexFault(error)) throw error;
    return [];
  }
}

/** Find the matching close delimiter, ignoring delimiters inside literals. */
function matchingDelimiter(source, openIndex, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}

/** Top-level argument ranges inside a call, preserving offsets into the source. */
function topLevelArgumentRanges(source, start, end) {
  const ranges = [];
  const stack = [];
  let quote = null;
  let segmentStart = start;
  const closes = new Map([
    [')', '('],
    [']', '['],
    ['}', '{'],
  ]);
  for (let i = start; i < end; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      stack.push(c);
      continue;
    }
    if (closes.has(c)) {
      if (stack.at(-1) === closes.get(c)) stack.pop();
      continue;
    }
    if (c === ',' && stack.length === 0) {
      ranges.push([segmentStart, i]);
      segmentStart = i + 1;
    }
  }
  if (segmentStart < end) ranges.push([segmentStart, end]);
  return ranges;
}

function hasQuotedMigration(source, migrationFile) {
  const filename = migrationFile.split(/[\\/]/).pop();
  if (!filename) return false;
  return new RegExp(`(['"])${escapeRe(filename)}\\1`).test(source);
}

/**
 * Whether a fixture's explicit `applyMigrationsForTest` list contains a migration.
 * Code and string values are read from two same-length masks: the code mask prevents
 * prose/template strings from becoming phantom calls, while the comments-only mask
 * preserves the migration filenames inside the real array literal.
 */
export function listsMigrationInApplyMigrationsForTest(sourceText, migrationFile, fileName) {
  if (!migrationFile) return false;
  const code = stripCommentsAndStrings(sourceText, fileName);
  const readable = stripCommentsOnly(sourceText, fileName);
  const calls = /\bapplyMigrationsForTest\s*\(/g;
  let call;
  while ((call = calls.exec(code))) {
    const open = code.indexOf('(', call.index);
    const close = matchingDelimiter(code, open, '(', ')');
    if (close < 0) continue;
    const args = topLevelArgumentRanges(code, open + 1, close);
    if (args.length < 2) continue;
    const [secondStart, secondEnd] = args[1];
    const second = code.slice(secondStart, secondEnd).trim();
    if (second.startsWith('[')) {
      const arrayOpen = code.indexOf('[', secondStart);
      const arrayClose = matchingDelimiter(code, arrayOpen, '[', ']');
      if (arrayClose >= 0 && hasQuotedMigration(readable.slice(arrayOpen, arrayClose + 1), migrationFile)) return true;
      continue;
    }

    // Several fixtures name a reusable `const migrations = [...]` list instead of
    // spelling the array at the call site. Resolve only a literal array declaration;
    // dynamic builders remain unrecognised and therefore fail safe (the checker may
    // report a finding rather than silently suppressing one).
    const variable = /^([A-Za-z_$][\w$]*)$/.exec(second)?.[1];
    if (!variable) continue;
    const declarations = new RegExp(
      `\\b(?:const|let|var)\\s+${escapeRe(variable)}(?:\\s*:\\s*[^=;\\n]+)?\\s*=\\s*\\[`,
      'g',
    );
    let declaration;
    while ((declaration = declarations.exec(code))) {
      const arrayOpen = code.indexOf('[', declaration.index);
      const arrayClose = matchingDelimiter(code, arrayOpen, '[', ']');
      if (arrayClose >= 0 && hasQuotedMigration(readable.slice(arrayOpen, arrayClose + 1), migrationFile)) return true;
    }
  }
  return false;
}

/**
 * Integration-test files (repo-root-relative) that inline-construct `table`
 * WITHOUT `column` — i.e. their `CREATE TABLE harness_shared.<table>` fixture
 * names other columns but not this one. `deps` is injected by tests.
 */
export function findFixtureGaps(table, column, deps = {}) {
  const { root = ROOT, files = listIntegrationTestFiles(root), readFile = defaultReadFile, migrationFile } = deps;
  const gaps = [];
  for (const relPath of files) {
    const text = readFile(root, relPath);
    if (text === null) continue;
    if (!text.includes(table)) continue; // cheap pre-filter BEFORE the parse below
    if (migrationFile && listsMigrationInApplyMigrationsForTest(text, migrationFile, relPath)) continue;
    // Mask TS comments so a commented-out fixture cannot be read as a live one. Extension
    // dispatch via relPath (.ts) — NOT the SQL path, and NOT stripCommentsAndStrings: these
    // fixtures hold their `CREATE TABLE` INSIDE a template literal, so blanking strings
    // would take the guard 100% inert (measured: 477 live fixture tables found across 267
    // files with comments-only masking; blanking strings finds none).
    // Measured today: 0 of 763 tracked fixtures currently mint a phantom this way, so this
    // is prophylactic rather than a live-bug fix — a false gap here accuses an unrelated
    // agent of drift they did not cause, which is the exact harm this guard exists to stop.
    for (const t of findCreateTables(stripCommentsOnly(text, relPath))) {
      if (t.table !== table) continue;
      if (!t.columns.includes(column)) gaps.push(relPath);
    }
  }
  return [...new Set(gaps)];
}

function defaultReadFile(root, relPath) {
  try {
    return readFileSync(join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

/**
 * The whole check for one migration file's text: every introduced column,
 * cross-referenced against fixture gaps. Returns findings (empty if none).
 */
export function findDrift(sqlText, deps = {}) {
  const introduced = extractIntroducedColumns(sqlText);
  const findings = [];
  for (const { table, column } of introduced) {
    const gapFiles = findFixtureGaps(table, column, deps);
    if (gapFiles.length) findings.push({ table, column, gapFiles });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatReport(migrationFile, findings) {
  if (!findings.length) return `✓ ${migrationFile}: no fixture drift found`;
  const lines = [`⚠ ${migrationFile} — introduces column(s) already relied on by other test fixtures:`];
  for (const { table, column, gapFiles } of findings) {
    lines.push(`  • harness_shared.${table}.${column}`);
    for (const f of gapFiles) lines.push(`      stale fixture: ${f}`);
  }
  lines.push(
    '',
    '  Each listed file builds harness_shared.<table> from an inline CREATE TABLE that',
    '  names other columns but not this new one. If that fixture is meant to track the',
    '  real schema (not a deliberate minimal stub), add the column now — the class this',
    '  guards is documented at EI-19359711978838614: the red otherwise surfaces on an',
    '  unrelated agent, hours or weeks later, with no routine check able to see it coming.',
  );
  return lines.join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const check = argv.includes('--check');
  const baseIdx = argv.indexOf('--base');
  const forwardedFiles = parseExplicitFiles(argv);
  const explicitFiles = forwardedFiles == null
    ? argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--base')
    : [...forwardedFiles];

  let files = explicitFiles;
  if (baseIdx >= 0) {
    const base = argv[baseIdx + 1];
    files = changedSqlFilesSince(base, {
      files: forwardedFiles == null && !explicitFiles.length ? null : explicitFiles,
    });
  }

  if (!files.length) {
    if (!json) console.log('check-migration-fixture-drift: no migration files given — nothing to check');
    process.exit(0);
  }

  const results = [];
  let anyFindings = false;
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const relPath = relative(ROOT, abs).split(sep).join('/');
    const findings = findDrift(text, { migrationFile: relPath });
    if (findings.length) anyFindings = true;
    results.push({ file: relPath, findings });
    if (!json) console.log(formatReport(relPath, findings));
  }

  if (json) {
    console.log(JSON.stringify({ results }, null, 2));
  }

  process.exit(check && anyFindings ? 1 : 0);
}

/**
 * EI-22703095921400106. The `[]` here is LOAD-BEARING for an expected failure — an unresolvable
 * `base` ref (a shallow clone, a base that predates the checkout) legitimately means "no
 * migrations changed", and that must stay quiet. An unreadable `.git/index` is a different
 * answer wearing the same face: it means the diff never ran, so returning `[]` would report
 * "this migration changed no SQL" and skip the drift check entirely.
 *
 * So only the index-fault class is promoted to a throw; every other failure keeps the quiet
 * `[]`. Both git calls are wrapped, because either can be the one that hits the torn index.
 */
export function changedSqlFilesSince(base, { root = ROOT, files = null } = {}) {
  try {
    const git = (args, cwd) => withGitIndexFaultRetry(() => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })).trim();
    // A superproject diff sees the gitlink, not SQL inside it. Ask the actual
    // owning repository and translate the runner's base to its recorded gitlink.
    const sqlDir = resolve(root, SQL_DIR_REL);
    const ownerRoot = git(['rev-parse', '--show-toplevel'], sqlDir);
    const ownerPrefix = relative(root, ownerRoot).split(sep).join('/');
    const ownerBase = ownerPrefix
      ? git(['rev-parse', '--verify', '--end-of-options', `${base}:${ownerPrefix}`], root)
      : base;
    const sqlPrefix = relative(ownerRoot, sqlDir).split(sep).join('/');
    const pathspec = `${sqlPrefix}/*.sql`;
    const out = git(['diff', '--name-only', '--diff-filter=ACM', ownerBase, '--', pathspec], ownerRoot);
    const tracked = out.split('\n').filter(Boolean);
    // Untracked-but-new migration files (the common case right after `db:next-migration`,
    // before git-sync's next commit) don't show up in a base-diff at all — pick them up too.
    const untracked = git(['ls-files', '--others', '--exclude-standard', '--', pathspec], ownerRoot)
      .split('\n')
      .filter(Boolean);
    const candidates = [...new Set([...tracked, ...untracked])]
      .map((file) => ownerPrefix ? `${ownerPrefix}/${file}` : file);
    // Preserve exact forwarded paths; a gitlink path expands to its internal diff.
    return files !== null
      ? candidates.filter((file) => files.some((selected) => file === selected || file.startsWith(`${selected}/`)))
      : candidates;
  } catch (error) {
    if (isRepositoryIndexFault(error)) throw error;
    return [];
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) runGuardWithIndexFaultGuard(main, { guard: 'migration-fixture-drift' });
