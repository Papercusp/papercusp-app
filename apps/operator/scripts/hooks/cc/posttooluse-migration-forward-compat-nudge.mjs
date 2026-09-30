#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs
//
// PostToolUse (Edit|Write|MultiEdit) ADVISORY nudge for destructive migration
// DDL written without a FORWARD-COMPAT acknowledgment.
// Sibling of posttooluse-migration-fixture-drift-nudge.mjs (EI-19359711978838614)
// and posttooluse-required-field-strand-nudge.mjs (WI-6814).
// Implements rung 2 of EI-19462877357083817.
//
// THE TRAP
//   `lint:migration-forward-compat` is a good detector with a correct rule, and
//   it runs in exactly ONE place: green-checkpoint. That is hours after the
//   author wrote the file, and — critically — after `db:migrate` has already
//   applied the destructive DDL to the live database. So the hazard it exists
//   to prevent (dropping something out from under the older release still
//   serving :3070) has already been taken by the time it speaks, and what it
//   actually delivers is a fleet-wide gate red.
//
//   Measured on the 2026-08-03 incident (WI-9591): migrations 750/751/752/754/755
//   dropped 11 indexes. All 11 were already ABSENT from the live DB ~2.5h before
//   the lint said a word. The justification the lint asks for was ALREADY in all
//   five files, and it was rigorous — call-site reading, forced-generic-plan
//   measurements, an enable_seqscan=off proof. The ONLY thing missing was the
//   machine-readable token. That is the shape of this failure: correct reasoning
//   present, one-line token absent, discovered hours later by a gate that
//   red-pins the whole fleet. At least the fourth occurrence — WI-6842
//   (695/696/707/713), EI-19407054630567497 (727), WI-9591 (these five).
//
//   It also lands at the WORST moment. The gate short-circuits at the first
//   failing leg, so this lint only RUNS once every earlier leg passes: it fired
//   zero times in the three preceding verdicts and surfaced only on the first
//   candidate whose tests went green — a fresh red exactly when the fleet
//   believed it was recovering. Layered reds cost a full ~55min cycle each.
//
// WHY A HOOK, WHEN THE DETECTOR ALREADY EXISTS
//   Finding the violation was never the hard part — the lint does that
//   perfectly. The gap is KNOWING TO RUN IT, at the one moment the fix is a
//   single comment line typed by the author who still has the reasoning in
//   their head. A PostToolUse hook runs milliseconds after the write, while it
//   is still their turn.
//
// CONTRACT
//   - ADVISORY ONLY. PostToolUse cannot block and must not try to. Destructive
//     DDL is often correct; the ack is the point, not the abstention.
//   - REUSES the detector: `violationsFor` / `ACK_MARKER` / `isEnforcedMigrationFile`
//     are dynamically imported from scripts/check-migration-forward-compat.mjs,
//     resolved off the edited file's own path (the hook is installed to
//     ~/.papercusp/hooks/cc/, detached from any repo, so a static import is
//     impossible). A hand-copied second regex that silently disagreed would let
//     this stay quiet on a file the gate then reds on — reintroducing the exact
//     cost the hook exists to remove. That module guards its own `main()` behind
//     an invoked-directly check, so importing it here cannot run the repo scan.
//   - COVERS `.DRAFT` (and `.PENDING-CODE-DEPLOY`) files. scripts/next-migration.mjs
//     tells authors to write + iterate at `<NNN>-<slug>.sql.DRAFT`, and the runner
//     only applies `*.sql`, so the draft window IS the authoring window. A nudge
//     that only matched `.sql` would miss the entire period when the advice is
//     cheap to act on.
//   - Fires on the file's CURRENT state, with no HEAD diffing — unlike the
//     fixture-drift sibling. The condition here is "this file will red the gate
//     as it now stands", which stays true and worth repeating across successive
//     edits, and self-clears the instant the ack is added. Diffing would let a
//     violation written in edit 1 go unmentioned in edits 2..N.
//   - FAILS OPEN on every internal error — bad JSON, missing file, unresolvable
//     detector, parse failure. A bug here must never disturb an edit that
//     already succeeded.
//   - `--self-test` runs the embedded cases (no stdin) and exits non-zero on
//     failure; mirrors both siblings.
//
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Detector location, relative to the repo root — also how the root is identified. */
const DETECTOR_REL = join('scripts', 'check-migration-forward-compat.mjs');

/** Reading a pathological file is not worth an edit-time nudge. */
const MAX_BYTES = 400_000;

/** Suffixes the migration workflow uses for a not-yet-armed migration. */
const PARKED_SUFFIXES = ['.DRAFT', '.PENDING-CODE-DEPLOY'];

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

/**
 * Strip the not-yet-armed suffix so a `.DRAFT` is judged as the migration it
 * will become. Returns the effective filename.
 */
export function effectiveMigrationName(filePath) {
  let name = basename(filePath.split(sep).join('/'));
  for (const suffix of PARKED_SUFFIXES) {
    if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  }
  return name;
}

/**
 * True for a migration SQL file under a db/sql dir — including a `.DRAFT` /
 * `.PENDING-CODE-DEPLOY` one — and not an archived path.
 * The ENFORCE_FROM cutoff is applied separately, via the detector's own export.
 */
export function isCandidateFile(filePath) {
  const norm = filePath.split(sep).join('/');
  if (!norm.includes('/libs/db/sql/')) return false;
  if (norm.includes('/libs/db/sql/archive/')) return false;
  return effectiveMigrationName(norm).endsWith('.sql');
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

/** The advisory text. Exported so the test asserts the real string. */
export function formatNudge(relPath, hits) {
  const lines = [
    '⚠ DESTRUCTIVE MIGRATION DDL with no FORWARD-COMPAT acknowledgment.',
    `  ${relPath}`,
  ];
  for (const h of hits) lines.push(`    • [${h.id}] ${h.why}`);
  lines.push(
    '',
    '  The database migrates NOW, but :3070 keeps serving the OLDER release checkout',
    '  until the next commit -> green-checkpoint -> deploy cycle finishes. Destructive',
    '  DDL therefore breaks code that is still live, and the gate leg that catches this',
    '  runs LAST — so left unacknowledged it surfaces hours from now as a fleet-wide',
    '  red, long after the DDL already applied.',
    '',
    '  If the deployed release genuinely does not touch it, record WHY, in the migration:',
    '    -- FORWARD-COMPAT: <why the currently-deployed release does not use this>',
    '',
    '  Otherwise split it expand/contract: EXPAND now (add + deploy the code that uses',
    '  it), CONTRACT in a LATER migration once no deployed release references it.',
    '',
    '  Confirm with:',
    '    npm run lint:migration-forward-compat',
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
    loadDetector = defaultLoadDetector,
  } = deps;

  if (!isCandidateFile(filePath)) return null;
  const abs = resolve(filePath);
  if (!exists(abs)) return null;
  if (sizeOf(abs) > MAX_BYTES) return null;

  const root = findRepoRoot(abs, exists);
  if (!root) return null;

  const detector = await loadDetector(root);
  if (!detector) return null;
  const { violationsFor, ACK_MARKER, isEnforcedMigrationFile } = detector;
  if (typeof violationsFor !== 'function') return null;
  if (!ACK_MARKER || typeof ACK_MARKER.test !== 'function') return null;

  // Historical migrations are immutable once applied and can never be fixed, so
  // the gate does not enforce on them and neither do we.
  if (typeof isEnforcedMigrationFile === 'function') {
    if (!isEnforcedMigrationFile(effectiveMigrationName(filePath))) return null;
  }

  const text = readFile(abs);
  const hits = violationsFor(text);
  if (!hits.length) return null;
  if (ACK_MARKER.test(text)) return null;

  const relPath = relative(root, abs).split(sep).join('/');
  return formatNudge(
    relPath,
    hits.map((h) => ({ id: h.id, why: h.why })),
  );
}

async function defaultLoadDetector(root) {
  try {
    return await import(`file://${join(root, DETECTOR_REL)}`);
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

  check('accepts a sql/ migration path', isCandidateFile('libs/papercusp/libs/db/sql/750-x.sql'));
  check('accepts a .DRAFT migration path', isCandidateFile('libs/papercusp/libs/db/sql/750-x.sql.DRAFT'));
  check(
    'accepts a .PENDING-CODE-DEPLOY migration path',
    isCandidateFile('libs/papercusp/libs/db/sql/750-x.sql.PENDING-CODE-DEPLOY'),
  );
  check('rejects archive/', !isCandidateFile('libs/papercusp/libs/db/sql/archive/001-x.sql'));
  check('rejects a non-sql/ path', !isCandidateFile('libs/papercusp/libs/db/src/schema/generated.ts'));
  check('rejects a non-.sql file', !isCandidateFile('libs/papercusp/libs/db/sql/README.md'));
  check('strips .DRAFT for naming', effectiveMigrationName('/a/b/750-x.sql.DRAFT') === '750-x.sql');
  check('leaves a plain .sql name alone', effectiveMigrationName('/a/b/750-x.sql') === '750-x.sql');

  // A stand-in detector mirroring the real module's exported shape.
  const fakeDetector = {
    ACK_MARKER: /^[ \t]*--[ \t]*FORWARD-COMPAT:[ \t]*\S/im,
    isEnforcedMigrationFile: (f) => Number.parseInt(f, 10) >= 693,
    violationsFor: (text) =>
      /\bDROP\s+INDEX\b/i.test(text.replace(/--[^\n]*/g, '\n'))
        ? [{ id: 'drop-index', why: 'drops an index the deployed release may rely on' }]
        : [],
  };
  const base = { exists: () => true, sizeOf: () => 10, loadDetector: async () => fakeDetector };

  const fires = await nudgeFor('/repo/libs/papercusp/libs/db/sql/750-x.sql', {
    ...base,
    readFile: () => 'DROP INDEX harness_shared.foo;',
  });
  check('fires on unacknowledged DROP INDEX', !!fires && fires.includes('[drop-index]'));
  check('names the ack format', !!fires && fires.includes('-- FORWARD-COMPAT:'));

  const acked = await nudgeFor('/repo/libs/papercusp/libs/db/sql/750-x.sql', {
    ...base,
    readFile: () => '-- FORWARD-COMPAT: deployed release never reads it\nDROP INDEX harness_shared.foo;',
  });
  check('silent once acknowledged', acked === null);

  const draft = await nudgeFor('/repo/libs/papercusp/libs/db/sql/750-x.sql.DRAFT', {
    ...base,
    readFile: () => 'DROP INDEX harness_shared.foo;',
  });
  check('fires on a .DRAFT (the authoring window)', !!draft && draft.includes('[drop-index]'));

  const benign = await nudgeFor('/repo/libs/papercusp/libs/db/sql/750-x.sql', {
    ...base,
    readFile: () => 'CREATE TABLE harness_shared.x (id text);',
  });
  check('silent on non-destructive DDL', benign === null);

  const historical = await nudgeFor('/repo/libs/papercusp/libs/db/sql/500-x.sql', {
    ...base,
    readFile: () => 'DROP INDEX harness_shared.foo;',
  });
  check('silent on a pre-ENFORCE_FROM historical migration', historical === null);

  const notSql = await nudgeFor('/repo/apps/operator/lib/foo.ts', {
    ...base,
    readFile: () => {
      throw new Error('must not be called');
    },
  });
  check('skips a non-migration path without reading it', notSql === null);

  const noDetector = await nudgeFor('/repo/libs/papercusp/libs/db/sql/750-x.sql', {
    ...base,
    readFile: () => 'DROP INDEX harness_shared.foo;',
    loadDetector: async () => null,
  });
  check('fails open when the detector cannot be loaded', noDetector === null);

  if (failures.length) {
    console.error(`posttooluse-migration-forward-compat-nudge --self-test FAILED:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('posttooluse-migration-forward-compat-nudge --self-test: all cases passed');
  process.exit(0);
}
