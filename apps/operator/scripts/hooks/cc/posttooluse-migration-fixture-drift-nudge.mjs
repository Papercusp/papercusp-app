#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-migration-fixture-drift-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for the integration-test
// inline-schema-fixture drift trap (EI-19359711978838614, sibling of
// posttooluse-required-field-strand-nudge.mjs / WI-6814).
//
// THE TRAP
//   Many `*.integration.test.ts` files build a `harness_shared.<table>` from an
//   inline `CREATE TABLE` in their own `beforeAll` rather than by applying real
//   migrations. When a NEW migration later ALTERs that table (or a fresh
//   CREATE TABLE happens to share a name with a table some OTHER fixture
//   already stubs), and production code moves with it, a fixture that used to
//   be schema-complete for every column it names quietly falls one column
//   behind. `test:affected` will not select the stale fixture file — the
//   migration's own diff never touches it — and `lint:tsc` cannot see drift in
//   a SQL string, so nothing routine catches it. The red then surfaces on
//   whichever unrelated agent next touches that test file, hours or weeks
//   later (first instance: `store.integration.test.ts`, `column "root_id"
//   does not exist`, from migration 572 — EI-19359711978838614).
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   scripts/check-migration-fixture-drift.mjs already answers this precisely —
//   see its own header for why it is a narrow DIFF-triggered check rather than
//   a blanket "every fixture must mirror the full schema" lint (most fixtures
//   are deliberately partial by design; a blanket lint would be close to
//   100%-false-positive on this tree). Its header names the same gap
//   check-required-field-strands.mjs's does: finding the affected fixtures is
//   not the hard part — grep does that precisely once you know the (table,
//   column) pair — the hard part is KNOWING TO RUN IT, at the one moment a new
//   migration file exists to inspect.
//
//   Running the CLI later does not reliably work on THIS tree either, for the
//   exact reason documented in the required-field-strand hook: git-sync
//   commits the whole shared checkout on a schedule, so a diff-vs-HEAD run a
//   few minutes after the edit can already see the migration as committed
//   history with no informative "before". A PostToolUse hook runs milliseconds
//   after the write, while the file is unambiguously fresh, and reports to the
//   author while it is still their turn to fix it cheaply (add one line to a
//   sibling fixture) instead of an unrelated agent's problem later.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block, and must not try to: adding a
//     column to a migration is normal, correct, and usually has nothing to do
//     with any test fixture. This only fires when a fixture ELSEWHERE already
//     builds the exact same table and is missing the exact new column — a
//     narrow, structural, low-noise signal.
//   - REUSES the detector: `extractIntroducedColumns` / `findFixtureGaps` are
//     dynamically imported from the repo, resolved off the edited file's own
//     path (the hook is installed to ~/.papercusp/hooks/cc/, detached from any
//     repo, so a static import is impossible). The hook stays a thin trigger;
//     the parsing + gap-finding logic stays in ONE place.
//   - A brand-new migration file (no HEAD version) is the COMMON case here —
//     unlike the required-field-strand hook, where a brand-new file has no
//     pre-existing sites to strand, a brand-new MIGRATION is exactly the event
//     this hook exists to catch (new migrations are almost always new files).
//     So "no HEAD version" is treated as an empty `before`, not skipped.
//   - Only genuinely NEW (table, column) introductions (present in `after`,
//     absent from `before`) are checked, so repeated edits to the same
//     in-progress migration file don't re-nudge for parts that were already
//     there on a prior edit.
//   - FAILS OPEN on every internal error — bad JSON, missing file, no git, an
//     unresolvable detector, a parse failure. A bug here must never disturb an
//     edit that already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors posttooluse-required-field-strand-nudge.mjs.
//
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-migration-fixture-drift.mjs');

/** Parsing two versions of a very large file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

// Run the hook ONLY when executed as a binary — never on import (mirrors the
// required-field-strand sibling's own guard + rationale).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'MultiEdit') return done();
    const filePath = (hook.tool_input || {}).file_path || '';
    if (!filePath) return done();

    const msg = await nudgeFor(filePath);
    if (msg) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
        }) + '\n',
      );
    }
  } catch {
    // fail open — see CONTRACT
  }
  return done();
}

/** True for a migration SQL file — not a migration-quarantine/archive path. */
export function isCandidateFile(filePath) {
  const norm = filePath.split(sep).join('/');
  if (!norm.endsWith('.sql')) return false;
  if (!norm.includes('/libs/db/sql/')) return false;
  if (norm.includes('/libs/db/sql/archive/')) return false;
  return true;
}

/**
 * Walk up from the edited file until a directory contains the detector.
 * Returns the repo root, or null. Finding it also PROVES the detector exists.
 */
export function findRepoRoot(filePath, exists = existsSync) {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (exists(join(dir, DETECTOR_REL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The advisory text for a set of findings. Exported so the test asserts the real string. */
export function formatNudge(relPath, findings) {
  const lines = [
    '⚠ NEW MIGRATION COLUMN — another test fixture already builds this exact table and may now be stale.',
    `  ${relPath}`,
  ];
  for (const { table, column, gapFiles } of findings) {
    lines.push(`    • harness_shared.${table}.${column}`);
    for (const f of gapFiles) lines.push(`        stale fixture: ${f}`);
  }
  lines.push(
    '',
    '  Each listed file constructs harness_shared.<table> from an inline CREATE TABLE that',
    '  names other columns but not this new one. If it is meant to track the real schema',
    "  (not a deliberate minimal stub — check the file's own comments), add the column now:",
    '  the class this guards is EI-19359711978838614 — the red otherwise surfaces on an',
    '  unrelated agent, hours or weeks from now, with nothing routine able to see it coming.',
    '',
    '  Confirm with:',
    '    node scripts/check-migration-fixture-drift.mjs --check ' + relPath,
  );
  return lines.join('\n');
}

/**
 * The whole check for one edited migration file. Returns the advisory string, or null.
 * `deps` is injected by the self-test; production passes nothing.
 */
export async function nudgeFor(filePath, deps = {}) {
  const {
    exists = existsSync,
    readFile = (p) => readFileSync(p, 'utf8'),
    sizeOf = (p) => statSync(p).size,
    showHead = defaultShowHead,
    loadDetector = defaultLoadDetector,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  const afterText = readFile(abs);
  // No HEAD version (the common case for a fresh migration) => empty "before",
  // so every column the file introduces counts as new. Unlike the
  // required-field-strand sibling, this is the event we WANT to catch.
  const beforeText = showHead(root, relPath) ?? '';
  if (beforeText === afterText) return null;

  const detector = await loadDetector(root);
  if (!detector) return null;
  const { extractIntroducedColumns, findFixtureGaps } = detector;
  if (typeof extractIntroducedColumns !== 'function' || typeof findFixtureGaps !== 'function') return null;

  const beforeCols = new Set(extractIntroducedColumns(beforeText).map((c) => c.table + '.' + c.column));
  const afterCols = extractIntroducedColumns(afterText);
  const newlyIntroduced = afterCols.filter((c) => !beforeCols.has(c.table + '.' + c.column));
  if (!newlyIntroduced.length) return null;

  const findings = [];
  for (const { table, column } of newlyIntroduced) {
    const gapFiles = findFixtureGaps(table, column, { root });
    if (gapFiles.length) findings.push({ table, column, gapFiles });
  }
  if (!findings.length) return null;
  return formatNudge(relPath, findings);
}

function defaultShowHead(root, relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_BYTES * 4,
    });
  } catch {
    return null; // new file, submodule path, detached/empty repo — all fail open to '' upstream
  }
}

async function defaultLoadDetector(root) {
  try {
    const mod = await import(`file://${join(root, DETECTOR_REL)}`);
    return mod;
  } catch {
    return null;
  }
}

function done() {
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((res) => {
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      res(buf || '{}');
    };
    const t = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

async function selfTest() {
  const failures = [];
  const check = (name, cond) => {
    if (!cond) failures.push(name);
  };

  check('isCandidateFile accepts a sql/ migration path', isCandidateFile('libs/papercusp/libs/db/sql/572-x.sql'));
  check('isCandidateFile rejects archive/', !isCandidateFile('libs/papercusp/libs/db/sql/archive/001-x.sql'));
  check('isCandidateFile rejects a non-sql/ path', !isCandidateFile('libs/papercusp/libs/db/src/schema/generated.ts'));
  check('isCandidateFile rejects a non-.sql file', !isCandidateFile('libs/papercusp/libs/db/sql/README.md'));

  const fakeDetector = {
    extractIntroducedColumns(text) {
      // Minimal stand-in mirroring the real one's shape, driven by markers.
      const out = [];
      if (text.includes('ADD_ROOT_ID')) out.push({ table: 'event_awaits', column: 'root_id' });
      if (text.includes('ADD_OTHER')) out.push({ table: 'event_awaits', column: 'other' });
      return out;
    },
    findFixtureGaps(table, column) {
      if (table === 'event_awaits' && column === 'root_id') return ['packages/x/store.integration.test.ts'];
      return [];
    },
  };
  const base = {
    exists: () => true,
    sizeOf: () => 10,
    loadDetector: async () => fakeDetector,
  };

  // A brand-new migration file (no HEAD version) that introduces a column another
  // fixture already builds the table for => nudge, naming the fixture.
  const brandNew = await nudgeFor('/repo/libs/papercusp/libs/db/sql/572-x.sql', {
    ...base,
    showHead: () => null,
    readFile: () => 'ADD_ROOT_ID',
  });
  check('fires on a brand-new migration with a fixture gap', !!brandNew && brandNew.includes('store.integration.test.ts'));
  check('names the confirm command', !!brandNew && brandNew.includes('check-migration-fixture-drift.mjs --check'));

  // A brand-new migration introducing a column NO fixture cares about => silent.
  const clean = await nudgeFor('/repo/libs/papercusp/libs/db/sql/573-y.sql', {
    ...base,
    showHead: () => null,
    readFile: () => 'ADD_OTHER',
  });
  check('silent when no fixture builds the affected table', clean === null);

  // Editing an in-progress migration: a column already present before this edit
  // must not re-fire even though it still has a gap (only NEW introductions fire).
  const reEdit = await nudgeFor('/repo/libs/papercusp/libs/db/sql/572-x.sql', {
    ...base,
    showHead: () => 'ADD_ROOT_ID',
    readFile: () => 'ADD_ROOT_ID -- comment tweak',
  });
  check('silent on a re-edit that introduces no NEW column', reEdit === null);

  // Unchanged content must never fire.
  const same = await nudgeFor('/repo/libs/papercusp/libs/db/sql/572-x.sql', {
    ...base,
    showHead: () => 'ADD_ROOT_ID',
    readFile: () => 'ADD_ROOT_ID',
  });
  check('silent when content is unchanged', same === null);

  // Non-candidate path short-circuits before any git/detector work.
  const notSql = await nudgeFor('/repo/apps/operator/lib/foo.ts', {
    ...base,
    showHead: () => {
      throw new Error('must not be called');
    },
    readFile: () => '',
  });
  check('skips a non-migration path without touching git', notSql === null);

  // An unresolvable detector must fail OPEN, not throw.
  const noDetector = await nudgeFor('/repo/libs/papercusp/libs/db/sql/572-x.sql', {
    ...base,
    showHead: () => null,
    readFile: () => 'ADD_ROOT_ID',
    loadDetector: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  if (failures.length) {
    console.error(`posttooluse-migration-fixture-drift-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-migration-fixture-drift-nudge --self-test: all cases passed');
  process.exit(0);
}
