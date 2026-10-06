#!/usr/bin/env node
/**
 * db:next-migration (CLI) — atomically reserve the next migration number so two
 * agents racing `ls | tail` never pick the same NNN (which, on the native :5432
 * box, silently applies only one colliding file and dark-starts the other).
 *
 * This mirrors the MCP agent-tool
 * `packages/operator-core/lib/agent-tools/db/next_migration.ts`, but as a plain
 * Node CLI so reservation works WITHOUT the harness MCP client (which is
 * periodically dropped — see agent-insights/migration-number-collisions-and-
 * reservation-dx). The shared contract is the LEDGER + advisory lock, not the
 * code, so the two can't functionally diverge.
 *
 * Allocation: under pg advisory lock 873135,
 *   next = GREATEST(max-on-disk across BOTH sql dirs, max-reserved, max-applied) + 1
 * recorded atomically in harness_shared.migration_reservations.
 *
 * Usage:
 *   node scripts/next-migration.mjs --name add-foo-index [--intent "what it does"] [--by label] [--dry-run]
 *   npm run db:next-migration -- --name add-foo-index --intent "..."
 *   npx tsx scripts/next-migration.mjs --arm <path.sql.DRAFT>
 *
 * On success prints the reserved number + a DRAFT path to write the file at:
 *   libs/papercusp/libs/db/sql/<NNN>-<slug>.sql.DRAFT   (NOT the gitignored sidecar mirror)
 * The `.DRAFT` suffix is deliberate (EI-19366138707071397): the migration
 * runner only ever applies files matching `*.sql` (see migration-runner.js /
 * migration-drift.ts's `isRunnerMigration`), so a `.DRAFT`-suffixed file is
 * INVISIBLE to boot auto-apply, db:migrate, and the green-checkpoint preflight
 * — exactly like the pre-existing `.PENDING-CODE-DEPLOY` idiom (see migration
 * 727). This closes the window where editing an unapplied migration on disk
 * (including a deliberate temporary both-ways guard-test mutation) races the
 * operator's boot-time auto-apply and can execute half-finished SQL against
 * the live DB. Write + iterate at the .DRAFT path; arm it with the printed
 * command, which runs the shared pre-apply checks and publishes the linted SQL
 * atomically without overwriting an existing migration.
 *
 * Exits non-zero (without reserving) when PG is unreachable — a number handed out
 * without a ledger row would re-introduce the very race this prevents.
 *
 * WI-38353: the number is unique but the WORK may not be. Before inserting, the
 * recent ledger is checked for a near-identical filename slug (see
 * scripts/lib/migration-slug-dedup.mjs) and the reservation is REFUSED when one
 * was applied recently or reserved moments ago — the signature of several agents
 * racing the same repair after one gate red. `--force` overrides.
 *
 * EI-20300821494280085: a third refusal covers the case neither window can see —
 * the EXACT slug is already reserved, its file was never written, and its number
 * is still free on disk. That is not a stampede (it happens hours or days later),
 * it is one author re-taking a number they already hold; the remedy is to write
 * the file at the number they have. The filesystem facts come from the same
 * single dir scan that computes the allocation max.
 */
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { lstat, open, link, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { resolveScriptPgUrl } from './lib/pg-url.mjs';
import { ALLOC_ADVISORY_KEY, scanMigrationDirs } from './lib/migration-allocation.mjs';
import {
  annotateCandidatesWithDisk,
  fetchRedundancyCandidates,
  formatRedundancyMessage,
  judgeRedundantReservation,
} from './lib/migration-slug-dedup.mjs';

// Keep the key available to contract tests without creating a second source
// of truth. The MCP door re-exports the same binding.
export { ALLOC_ADVISORY_KEY };

// The canonical dir is scanned + written; the sidecar dir is folded into the
// on-disk max only so a stray mirror file can't collide. Write the file to the
// canonical dir.
const CANONICAL_DIR = 'libs/papercusp/libs/db/sql';
const SCAN_DIRS = [CANONICAL_DIR, 'papercusp-desktop/src-tauri/sidecar/db-sql'];
const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const ARM_SQL_DIR = resolvePath(REPO_ROOT, CANONICAL_DIR);

function parseArgs(argv) {
  const args = { dryRun: false, armRequested: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--force') args.force = true;
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--intent') args.intent = argv[++i];
    else if (a === '--by') args.by = argv[++i];
    else if (a === '--arm') {
      args.armRequested = true;
      args.armPath = argv[++i];
    }
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function quotePosixArgument(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

/**
 * Build the shell-safe command for the shared linted CLI arm executor.
 *
 * @param {string} draftPath Repository-relative or absolute .sql.DRAFT path.
 * @returns {string}
 */
export function armCommandFor(draftPath) {
  return 'npx tsx scripts/next-migration.mjs --arm ' + quotePosixArgument(draftPath);
}

function slugify(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || null;
}

/**
 * Lint a DRAFT with the same per-file pre-apply gate used by boot and db:migrate,
 * then atomically publish a separate, no-clobber .sql copy.
 *
 * @param {object} args
 * @param {string} args.draftPath Repository-relative or absolute .sql.DRAFT path.
 * @param {string} [args.sqlDir] SQL directory (default: canonical migrations; tests may use a temp dir).
 * @returns {Promise<{ok: boolean, draft_path: string, arm_path: string, draft_removed: boolean, warning?: string}>}
 */
export async function armMigration({ draftPath, sqlDir = ARM_SQL_DIR }) {
  if (typeof draftPath !== 'string' || draftPath.trim() === '') {
    throw new Error('A .sql.DRAFT path is required.');
  }

  const resolvedSqlDir = resolvePath(REPO_ROOT, sqlDir);
  const resolvedDraft = resolvePath(REPO_ROOT, draftPath);
  if (dirname(resolvedDraft) !== resolvedSqlDir) {
    throw new Error('Refusing to arm a draft outside its SQL directory: ' + resolvedDraft);
  }
  const draftName = basename(resolvedDraft);
  if (!draftName.endsWith('.sql.DRAFT')) {
    throw new Error('Refusing to arm a file that does not end in .sql.DRAFT: ' + draftName);
  }
  const filename = draftName.slice(0, -'.DRAFT'.length);
  if (!/^\d{3,}-[a-z0-9]+(?:-[a-z0-9]+)*\.sql$/.test(filename)) {
    throw new Error('Refusing to arm a migration with an invalid filename: ' + draftName);
  }

  const armPath = join(resolvedSqlDir, filename);
  const originalStat = await lstat(resolvedDraft);
  if (!originalStat.isFile() || originalStat.isSymbolicLink()) {
    throw new Error('Refusing to arm a draft that is not a regular file: ' + resolvedDraft);
  }
  const source = await open(resolvedDraft, 'r');
  let contents;
  try {
    const openedStat = await source.stat();
    if (openedStat.dev !== originalStat.dev || openedStat.ino !== originalStat.ino) {
      throw new Error('The draft path changed before it could be read; retry arming.');
    }
    contents = await source.readFile();
    const readEndStat = await source.stat();
    if (openedStat.size !== readEndStat.size || openedStat.mtimeMs !== readEndStat.mtimeMs) {
      throw new Error('The draft changed while it was being read; retry arming.');
    }
  } finally {
    await source.close();
  }

  const sqlText = contents.toString('utf8');
  if (!Buffer.from(sqlText, 'utf8').equals(contents)) {
    throw new Error('Refusing to arm a draft that is not valid UTF-8 SQL.');
  }
  const { assertMigrationPassesPreApplyLints } =
    await import('../packages/operator-core/lib/migration-preapply-lint.ts');
  assertMigrationPassesPreApplyLints({ filename, sqlText, sqlDir: resolvedSqlDir });

  const tempPath =
    join(resolvedSqlDir, '.' + filename + '.arm-' + process.pid + '-' + randomBytes(8).toString('hex') + '.tmp');
  try {
    const temporary = await open(tempPath, 'wx', originalStat.mode & 0o777);
    try {
      await temporary.writeFile(contents);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(tempPath, armPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Refusing to arm ' + filename + ': target already exists; the draft was left unchanged.');
      }
      throw error;
    }
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }

  let draftRemoved = false;
  let warning;
  try {
    const currentStat = await lstat(resolvedDraft);
    if (
      currentStat.isFile() &&
      !currentStat.isSymbolicLink() &&
      currentStat.dev === originalStat.dev &&
      currentStat.ino === originalStat.ino
    ) {
      const current = await open(resolvedDraft, 'r');
      let currentContents;
      try {
        currentContents = await current.readFile();
      } finally {
        await current.close();
      }
      if (currentContents.equals(contents)) {
        await unlink(resolvedDraft);
        draftRemoved = true;
      } else {
        warning = 'The draft changed during arming; the linted snapshot was armed and the newer draft was preserved.';
      }
    } else {
      warning = 'The draft path changed during arming; the linted snapshot was armed and the newer draft was preserved.';
    }
  } catch (error) {
    if (error?.code === 'ENOENT') draftRemoved = true;
    else warning = 'The arm target was created, but the draft could not be removed: ' + error.message;
  }

  return {
    ok: true,
    draft_path: resolvedDraft,
    arm_path: armPath,
    draft_removed: draftRemoved,
    ...(warning ? { warning } : {}),
  };
}

/**
 * Pure — builds the JSON payload printed on success. Exported and unit tested
 * without a DB so the DRAFT write-target, eventual armed SQL path, and linted
 * no-clobber arm command cannot silently diverge.
 *
 * @param {object} args
 * @param {number} args.next          The reserved migration number.
 * @param {string} args.filename      The eventual armed `<NNN>-<slug>.sql` filename.
 * @param {string} args.reservedBy    Who/what reserved it (for the printed `reserved_by`).
 * @param {boolean} args.dryRun       True when nothing was actually reserved.
 * @param {string} [args.canonicalDir] Override for the sql dir (tests only).
 * @param {string|null} [args.redundancyWarning] WI-38353: a non-blocking "a
 *   near-identical migration already exists" notice, surfaced on the SUCCESS
 *   path so a probable duplicate is visible even when it is not refused.
 */
export function buildAllocationResult({
  next,
  filename,
  reservedBy,
  dryRun,
  canonicalDir = CANONICAL_DIR,
  redundancyWarning = null,
}) {
  const armPath = `${canonicalDir}/${filename}`;
  const draftPath = `${armPath}.DRAFT`;
  const armCommand = armCommandFor(draftPath);
  return {
    ok: true,
    number: next,
    reserved: !dryRun,
    filename,
    path: draftPath,
    arm_path: armPath,
    arm_command: armCommand,
    reserved_by: reservedBy,
    ...(redundancyWarning ? { redundancy_warning: redundancyWarning } : {}),
    // Authoring-time reminder for the forward-compat guard (EI-19462877357083817).
    //
    // ⚠ Deliberately phrased so it does NOT satisfy check-migration-forward-compat's
    // ACK_MARKER (/^[ \t]*--[ \t]*FORWARD-COMPAT:[ \t]*\S/im). That marker matches ANY
    // non-whitespace after the colon, so a seeded placeholder line — `-- FORWARD-COMPAT:
    // TODO`, or `-- FORWARD-COMPAT: <why>` — would RUBBER-STAMP the migration and
    // silence the guard permanently. Hence the format is shown mid-line, never at the
    // start of one. `next-migration-forward-compat-reminder.test.ts` pins this by
    // running the real exported ACK_MARKER against this exact string.
    forward_compat:
      'If this migration contains destructive DDL (DROP INDEX / DROP COLUMN / DROP TABLE / ' +
      'DROP CONSTRAINT / RENAME / SET NOT NULL / a partial UNIQUE INDEX), it needs an ' +
      'acknowledgment line of the form:  -- FORWARD-COMPAT: <why the currently-deployed ' +
      'release does not use this>  — written as a real sentence, not a placeholder. The DB ' +
      'migrates NOW while :3070 keeps serving the older release checkout, so destructive DDL ' +
      'breaks code that is still live. Without it the green gate reds LAST and fleet-wide, ' +
      'hours after the DDL already applied. Prefer expand/contract: EXPAND now, CONTRACT in a ' +
      'later migration. Check with: npm run lint:migration-forward-compat',
    note: dryRun
      ? 'DRY RUN — nothing reserved. Re-run without --dry-run to claim this number.'
      : 'Reserved. Write + iterate the migration at ' + draftPath + ' (a ".DRAFT" suffix — NOT the sidecar mirror). The runner only ever applies files matching *.sql, so this draft is INVISIBLE to boot auto-apply / db:migrate / the green-checkpoint preflight while you edit it (including any deliberate temporary both-ways guard-test mutation). Once it is ready and tested, arm it for auto-apply with: ' + armCommand,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/next-migration.mjs --name <slug> [--intent "..."] [--by <label>] [--dry-run] [--force]\n' +
        '       npx tsx scripts/next-migration.mjs --arm <path.sql.DRAFT>\n' +
        '  --force   reserve even when a near-identical migration was just reserved or already applied (WI-38353).',
    );
    process.exit(0);
  }
  if (args.armRequested) {
    try {
      const result = await armMigration({ draftPath: args.armPath });
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('db:next-migration ARM FAILED — ' + (e?.message ?? e));
      process.exitCode = 1;
    }
    return;
  }
  const slug = slugify(args.name);
  if (!slug) {
    console.error(
      'db:next-migration FAILED — --name is required and must contain at least one letter or digit.',
    );
    process.exitCode = 1;
    return;
  }
  const reservedBy = args.by || process.env.USER || process.env.LOGNAME || 'cli';

  const postgres = (await import('postgres')).default;
  const sql = postgres(resolveScriptPgUrl().url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });

  try {
    const allocated = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ALLOC_ADVISORY_KEY})`;
      // EI-6852: scan the filesystem max INSIDE the advisory lock, immediately
      // before the reservation insert — NOT before acquiring the lock. Reading
      // fsMax outside the lock left a TOCTOU window during which a concurrent
      // agent could write a higher-numbered NNN-*.sql to disk; the stale fsMax
      // then failed to fold it in and the CLI handed out an already-used
      // number. Mirrors the fix in next_migration.ts (the shared contract).
      //
      // ONE scan serves both readers: the allocation max, and the per-candidate
      // written/occupied facts the unwritten-reservation rule needs
      // (EI-20300821494280085). Both must be read under this lock for the same
      // TOCTOU reason.
      const scan = scanMigrationDirs(SCAN_DIRS);
      const fsMax = scan.maxNumber;
      const rows = await tx`
        SELECT GREATEST(
                 ${fsMax},
                 COALESCE((SELECT MAX(num) FROM harness_shared.migration_reservations), 0),
                 COALESCE((SELECT MAX(substring(filename FROM '^([0-9]+)-')::int)
                             FROM harness_shared.schema_migrations
                            WHERE filename ~ '^[0-9]+-'), 0)
               ) + 1 AS next`;
      const next = Number(rows[0].next);
      // The RESERVED filename (recorded in the ledger, used by the fsMax/
      // unreservedNumbers checks) stays the eventual armed `.sql` name — only
      // the path we tell the caller to WRITE TO gets the `.DRAFT` suffix. The
      // reservation and the on-disk armed state are deliberately independent.
      const filename = `${String(next).padStart(3, '0')}-${slug}.sql`;
      // WI-38353: the number is unique, but the WORK may not be. Read the
      // recent ledger under the SAME advisory lock that serialises allocation —
      // reading it outside would leave the exact race window this closes.
      const judgement = judgeRedundantReservation({
        slug,
        candidates: annotateCandidatesWithDisk(await fetchRedundancyCandidates(tx), scan),
        nowMs: Date.now(),
      });
      if (judgement.verdict === 'block' && !args.force) {
        return { next, filename, judgement, blocked: true };
      }
      if (!args.dryRun) {
        await tx`
          INSERT INTO harness_shared.migration_reservations (num, filename, reserved_by, intent)
          VALUES (${next}, ${filename}, ${reservedBy}, ${args.intent ?? null})`;
      }
      return { next, filename, judgement, blocked: false };
    });

    if (allocated.blocked) {
      console.error(
        `${formatRedundancyMessage(allocated.judgement, { slug })}\n\n` +
          `Nothing was reserved (${String(allocated.next).padStart(3, '0')} is still free).`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        buildAllocationResult({
          next: allocated.next,
          filename: allocated.filename,
          reservedBy,
          dryRun: args.dryRun,
          redundancyWarning: formatRedundancyMessage(allocated.judgement, { slug }),
        }),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(
      `db:next-migration FAILED — could not reach the reservation ledger: ${e?.message ?? e}\n` +
        'Refusing to hand out an unreserved number (that re-introduces the race). ' +
        'Start the embedded PG / set DATABASE_URL and retry.',
    );
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

// Guard the CLI entry so a test can `import { buildAllocationResult } from
// './next-migration.mjs'` without triggering a live PG connection + argv
// parse as a side effect of the import. isCliEntry (not a hand-rolled argv
// comparison) because agent-tools/db/next_migration.ts imports armCommandFor
// from here, which puts this file in the bundled operator host graph; isCliEntry
// is always false inside the bundle, so main() never runs at host boot.
//
// NO top-level await here. Because the host bundle imports this file, a
// top-level `await` makes esbuild compile it, and every module that imports
// it, into an async lazy init (`__esm({ async ... })`). When that chain
// crosses an import cycle the init promises wait on each other: the host sits
// idle forever before it listens (2026-10-01: :3170 and every
// verify-tauri-headless rig hung at boot, WI-10004497).
if (isCliEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(e?.stack ?? e);
    process.exitCode = 1;
  });
}
