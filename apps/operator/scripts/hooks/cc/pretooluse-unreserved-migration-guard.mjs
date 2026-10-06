#!/usr/bin/env node
// apps/operator/scripts/hooks/cc/pretooluse-unreserved-migration-guard.mjs
//
// PreToolUse (Edit|Write|MultiEdit + the capability_* MCP twins) BLOCKING guard:
// refuse a write to libs/papercusp/libs/db/sql/<NNN>-*.sql when NNN ≥
// ENFORCED_FROM has no row in harness_shared.migration_reservations — i.e. the
// number was hand-picked instead of allocated through
// `node scripts/next-migration.mjs`. WI-38352.
//
// WHY THIS EXISTS (the class, 3 occurrences in ~24h)
//   An agent writes a migration with a hand-picked NNN. Boot auto-apply applies
//   it within minutes. From that moment the file is IMMUTABLE — it cannot be
//   renumbered — and lint:migrations check 5 fails permanently. Because
//   lint:migrations is a RELEASE-CUT PREFLIGHT, that one file blocks EVERY
//   agent's release cut, not just the author's. Occurrence 3 (migration 815)
//   red-pinned the fleet gate for ~2h and the only available remedy was to
//   allocate a fresh number and write a ceremonial INSERT-only backfill.
//
//   The mistake is free to correct for exactly ONE window: between the file
//   appearing on disk and auto-apply reaching it. Inside that window the fix is
//   a `mv`. After it, the fix is a migration, a review, and a fleet-wide red.
//   So the guard belongs at the WRITE, which is the only seam where the repair
//   is still cheap.
//
// TWO OBVIOUS ALTERNATIVES ARE BOTH WRONG — RULED OUT, DO NOT RE-PROPOSE
//   (a) "Make the migration RUNNER refuse an unreserved ≥494 file." CATASTROPHIC.
//       On a packaged operator's FIRST BOOT harness_shared.migration_reservations
//       is EMPTY, so the runner would refuse every migration ≥494 and the product
//       would not boot. Reservations are dev-box allocator state, not shipped
//       schema state — which is exactly why the existing check lives in a
//       dev-side lint and not in the runner.
//   (b) "Make lint:migrations skip unreserved numbers that are already APPLIED."
//       NEARLY INERT. Auto-apply reaches a new file within minutes, so `applied`
//       is true almost immediately and the check would stop catching anything.
//       That greens the gate by deleting the check.
//
// NO DRIFT WITH THE LINT — THE BOUNDARY IS IMPORTED, NOT COPIED
//   ENFORCED_FROM is read from the repo's own scripts/lint-migrations.mjs (which
//   already exports it) at hook time, so the guard and the lint cannot disagree
//   about which numbers are enforced. Re-baselining the lint re-baselines this.
//   That module is import-safe: its main() is behind an argv[1] check.
//
// REPO ROOT IS DERIVED FROM THE TARGET PATH, NOT WALKED
//   A file only reaches this guard because its path contains the literal segment
//   `libs/papercusp/libs/db/sql/`, so the superproject root IS the prefix — no
//   ancestor walk, and no fourth findRepoRoot implementation in this tree
//   (EI-18824975338252781). If the derived root has no scripts/lint-migrations.mjs
//   (e.g. someone is working inside the libs/papercusp SUBMODULE checkout, where
//   the path is only `libs/db/sql/`), the guard FAILS OPEN rather than guessing.
//
// SCOPE — FAST FEEDBACK, NOT ENFORCEMENT, and the distinction is honest
//   PreToolUse fires on Claude-CLI tool calls only, so `capability:bash` with a
//   heredoc, `sed -i`, or any other process routes around this. That is the SAME
//   deliberate, documented gap the sibling pretooluse-generated-file-edit-guard
//   carries, and the reasoning transfers unchanged: this makes the mistake
//   immediate and legible at the moment it is cheap to fix. lint:migrations
//   remains the structural backstop and is unaffected.
//
//   The MCP twins ARE covered: isFileWritingTool is IMPORTED from that sibling
//   rather than re-listed here, because a name-keyed check that listed only
//   Edit/Write/MultiEdit silently let `mcp__<server>__capability_edit` through —
//   a hole measured in this tree on 2026-08-12. Importing it means that hole
//   cannot be re-opened here by omission.
//
// FAIL-OPEN IS DELIBERATE AND LOUD
//   Any internal error — PG unreachable, missing module, bad JSON, stdin timeout
//   — ALLOWS the write. A guard that hard-denies while the DB is briefly down
//   would block all migration authoring, and the lint still catches the case.
//   But a silently-inert guard is indistinguishable from a passing one, so the
//   fail-open reason is written to STDERR with the marker below (never stdout,
//   which carries the hook protocol).
//
// BYPASS (documented)
//   1. Preferred: DON'T. `node scripts/next-migration.mjs --name <slug>` costs
//      one call and hands back the exact path to write.
//   2. Per-call: write via `capability:bash`. PreToolUse does not see it.
//   3. Session-wide: launch with PAPERCUSP_ALLOW_UNRESERVED_MIGRATION=1.
//
// CONTRACT
//   - Trigger is the PATH + reservation state, NOT the file's prior existence:
//     a Write CREATING a new hand-numbered migration is the primary case.
//   - `.DRAFT` / `.PENDING-CODE-DEPLOY` suffixes are still judged. An allocated
//     draft is reserved by construction so it passes; a hand-numbered draft is
//     caught one step EARLIER than the armed file would be, which is better.
//   - sql/archive/** is out of scope (historical, one directory deeper).
//   - On a hit: permissionDecision "deny" (JSON, exit 0) — the same contract as
//     the secrets-guard / content-lint / generated-file-edit-guard siblings.
//   - `--self-test` runs the embedded pure cases and exits non-zero on failure.
//
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { isFileWritingTool, targetPathsForTool } from './pretooluse-generated-file-edit-guard.mjs';

/** The one path segment that makes a file a superproject migration. */
export const SQL_DIR_SEGMENT = 'libs/papercusp/libs/db/sql/';

/**
 * Suffix of the typed forward-compat acknowledgement sidecar. Kept in sync with
 * SIDECAR_SUFFIX in scripts/check-migration-forward-compat.mjs, which is the guard
 * that consumes these files.
 */
export const FORWARD_COMPAT_SIDECAR_SUFFIX = '.sql.forward-compat.json';

/** Written to stderr when the guard allows because it could not decide. */
export const INERT_MARKER = 'unreserved-migration-guard: INERT';

const BYPASS_ENV = 'PAPERCUSP_ALLOW_UNRESERVED_MIGRATION';

/**
 * Symlink-robust direct-run detection, same reasoning as the sibling: through
 * this box's papercupai-workspace/papercup -> papercusp symlink a naive string
 * compare is FALSE for a genuine direct run, which would silently disable the
 * guard. An undecidable comparison falls back to RUNNING.
 */
function invokedAsScript() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return resolve(fileURLToPath(import.meta.url)) === resolve(argv1);
  } catch {
    return true;
  }
}

if (invokedAsScript()) main();

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  let inert = null;
  try {
    const hook = JSON.parse(await readStdin(250));
    const tool = hook.tool_name || '';
    if (!isFileWritingTool(tool)) return done();
    const toolInput = hook.tool_input || {};
    const filePaths = targetPathsForTool(tool, toolInput);
    if (filePaths.length === 0) return done();
    if (bypassed()) return done();

    const workspaceRoot = process.env.PAPERCUSP_WORKSPACE_ROOT || process.cwd();
    for (const rawPath of filePaths) {
      // Codex apply_patch commonly supplies checkout-relative paths. Resolve them
      // against the managed workspace root before deriving the same superproject
      // root the Claude Edit/Write path gets from its absolute file_path.
      const filePath = resolve(workspaceRoot, rawPath);
      const target = migrationTargetFrom(filePath);
      if (!target) continue;

      const lint = join(target.repoRoot, 'scripts', 'lint-migrations.mjs');
      if (!existsSync(lint)) {
        inert = `no scripts/lint-migrations.mjs under the derived repo root ${target.repoRoot}`;
        return done(inert);
      }
      const { ENFORCED_FROM } = await import(pathToFileURL(lint).href);
      if (!Number.isInteger(ENFORCED_FROM)) {
        inert = 'lint-migrations.mjs exported no numeric ENFORCED_FROM';
        return done(inert);
      }
      const state = await lookupNumber(target);
      if (!state.ok) {
        inert = `could not read harness_shared.migration_reservations (${state.error})`;
        return done(inert);
      }

      // Filename-keyed history is immutable regardless of whether the allocator
      // recorded a reservation. The runner skips an applied filename, so an edit
      // here would help fresh installs only while silently leaving live databases
      // on the old bytes. This check must precede the reservation/baseline branch:
      // both allocated and grandfathered applied migrations are frozen.
      if (state.applied) return deny(target, tool, ENFORCED_FROM, true, state.reserved);
      if (target.num < ENFORCED_FROM || state.reserved) continue;

      return deny(target, tool, ENFORCED_FROM, false, false);
    }
    return done();
  } catch (e) {
    inert = `internal error (${e?.code ?? e?.message ?? e})`;
  }
  return done(inert);
}

function bypassed() {
  const v = process.env[BYPASS_ENV];
  return v === '1' || v === 'true';
}

/**
 * { num, repoRoot, sqlName, draft } for a superproject migration write, else
 * null. Exported so a test — or anything asking "would the guard look at this
 * path?" — can decide without spawning the hook or touching PG.
 *
 * Anchored on SQL_DIR_SEGMENT: the prefix IS the repo root (see header), and the
 * remainder must be a bare filename, which is what keeps sql/archive/** out.
 */
export function migrationTargetFrom(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const norm = filePath.replace(/\\/g, '/');
  const at = norm.lastIndexOf(SQL_DIR_SEGMENT);
  if (at === -1) return null;
  const repoRoot = norm.slice(0, at).replace(/\/$/, '');
  if (!repoRoot) return null;
  const base = norm.slice(at + SQL_DIR_SEGMENT.length);
  if (!base || base.includes('/')) return null; // archive/** and deeper: out of scope
  // A typed forward-compat SIDECAR is not a migration artifact. It sits beside an
  // applied migration, the runner never applies it (only *.sql), and it is
  // deliberately MUTABLE — it is the acknowledgement route for a migration whose
  // own bytes can never be edited again.
  //
  // This exclusion is load-bearing, not cosmetic. The suffix group below accepts
  // ANY `.sql.<something>`, so without it this guard matches the sidecar, maps it
  // back to the applied `<NNN>-*.sql`, and refuses the write — which closed the
  // last remaining route through lint:migration-forward-compat and left a
  // gate-blocking lint with no satisfiable fix at all (EI-21539300249506308;
  // ruling stable-candidate-related-gate-2026-08-23#D-092).
  if (base.endsWith(FORWARD_COMPAT_SIDECAR_SUFFIX)) return null;
  // <NNN>-<slug>.sql, optionally suffixed (.DRAFT, .PENDING-CODE-DEPLOY, …).
  const m = /^(\d+)-[^/]*?\.sql(\.[A-Za-z0-9._-]+)?$/.exec(base);
  if (!m) return null;
  const num = Number.parseInt(m[1], 10);
  if (!Number.isInteger(num)) return null;
  return { num, repoRoot, sqlName: base.replace(/\.sql\..*$/, '.sql'), draft: Boolean(m[2]) };
}

/**
 * Is this number reserved, and has this filename already been applied?
 *
 * Both in one round trip because they select different remedies: an UNAPPLIED
 * file is still renumberable with a `mv`, an APPLIED one is frozen and needs a
 * backfill migration. Sending an author to the wrong one is worse than saying
 * nothing.
 *
 * Resolution mirrors the lint exactly — the repo's own scripts/lib/pg-url.mjs
 * (env → .env.local → embedded-pg discovery → native :5432) and the repo's own
 * `postgres` — so the guard reads the SAME database the lint will judge against.
 */
async function lookupNumber({ num, repoRoot, sqlName }) {
  let sql;
  try {
    const { resolveScriptPgUrl } = await import(
      pathToFileURL(join(repoRoot, 'scripts', 'lib', 'pg-url.mjs')).href
    );
    const url = resolveScriptPgUrl({ root: repoRoot }).url;
    const require = createRequire(pathToFileURL(join(repoRoot, 'package.json')).href);
    const postgres = (await import(pathToFileURL(require.resolve('postgres')).href)).default;
    sql = postgres(url, { max: 1, connect_timeout: 5, idle_timeout: 1, onnotice: () => {} });
    const rows = await sql`
      SELECT
        EXISTS (SELECT 1 FROM harness_shared.migration_reservations WHERE num = ${num}) AS reserved,
        EXISTS (SELECT 1 FROM harness_shared.schema_migrations WHERE filename = ${sqlName}) AS applied`;
    return { ok: true, reserved: Boolean(rows[0]?.reserved), applied: Boolean(rows[0]?.applied) };
  } catch (e) {
    return { ok: false, error: e?.code ?? e?.message ?? String(e) };
  } finally {
    if (sql) await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/** The refusal, tailored to whether the number is still repairable. */
export function denyReason({ num, sqlName, draft }, tool, enforcedFrom, applied, reserved = false) {
  const slug = sqlName.replace(/^\d+-/, '').replace(/\.sql$/, '') || 'your-migration';
  const head = applied
    ? `🛑 migration-immutability-guard (WI-38352): ${sqlName} is already recorded in ` +
      `harness_shared.schema_migrations. The migration runner keys its ledger by filename and ` +
      `will skip edits to this file, so its applied history is immutable. Do not edit this file.\n\n` +
      `This is not a style rule: editing it creates a fresh-install/live-database split that ` +
      `can survive every restart. Write the correction as a new allocated migration instead.\n\n` +
      (reserved ? '' :
        `Additionally, migration number ${num} has no row in harness_shared.migration_reservations, ` +
        `so it was hand-picked rather than allocated. lint:migrations check 5 is a RELEASE-CUT ` +
        `PREFLIGHT, and this unreserved history can red-pin the gate for every agent.\n\n`)
    : `🛑 unreserved-migration-guard (WI-38352): migration number ${num} has no row in ` +
      `harness_shared.migration_reservations, so it was hand-picked rather than allocated. ` +
      `Every number ≥${enforcedFrom} must be allocated.\n\n` +
      `This is not a style rule. lint:migrations check 5 fails on an unreserved number, and ` +
      `lint:migrations is a RELEASE-CUT PREFLIGHT — so this one file red-pins the gate for ` +
      `EVERY agent on the fleet, not just you. It has happened three times in ~24h; the last ` +
      `one cost ~2h of fleet-wide release block.\n\n`;
  const remedy = applied
    ? reserved
      ? `⚠ Do not edit ${sqlName}. Allocate a fresh number for the correction:\n\n` +
        `    node scripts/next-migration.mjs --name ${slug}-followup --intent "apply the correction for ${sqlName}"\n\n` +
        `Then put the corrective DDL in that new migration. The old filename remains ` +
        `unchanged; the runner cannot replay edited bytes for an applied filename.\n\n`
      : `⚠ ${sqlName} is ALREADY APPLIED, so this number can no longer be repaired by renaming — ` +
        `the runner keys on filename and applied history is frozen. The remedy is a fresh ` +
        `allocated number plus an INSERT-only backfill of the missing reservation row ` +
        `(precedent: 807-backfill-migration-reservations-*.sql, and use ON CONFLICT (num) DO ` +
        `NOTHING — peers race this repair). Fix the reservation, not this file:\n\n` +
        `    node scripts/next-migration.mjs --name backfill-migration-reservation-${num} ` +
        `--intent "backfill the missing reservation row for ${num}"\n\n` +
        `Check first that no peer has already landed that backfill — a fleet-wide red attracts ` +
        `everyone at once, and four agents applied the SAME repair within 96s on 2026-08-13.\n\n`
    : `✅ Right now this is a ONE-COMMAND fix, because the file is not applied yet:\n\n` +
      `    node scripts/next-migration.mjs --name ${slug} --intent "<what it does>"\n\n` +
      `It reserves the next number atomically under an advisory lock and prints the exact ` +
      `.DRAFT path to write${draft ? '' : ' (write + iterate there; the runner only applies *.sql, so a draft is invisible to auto-apply until you arm it)'}. ` +
      `If ${sqlName} already exists, \`mv\` it to the allocated number.\n\n` +
      `That window is short: boot auto-apply reaches a *.sql file within minutes, and after ` +
      `that the number is IMMUTABLE and the only remedy is a ceremonial backfill migration.\n\n`;
  const tail =
    `If you must proceed anyway (repairing history, or a genuine exception): write via ` +
    `\`capability:bash\` — PreToolUse does not see those — or relaunch with ` +
    `${BYPASS_ENV}=1 to disable this guard for the session. Prefer allocating the number.` +
    `\n(refused ${tool})`;
  return head + remedy + tail;
}

function deny(target, tool, enforcedFrom, applied, reserved) {
  const reason = denyReason(target, tool, enforcedFrom, applied, reserved);
  try {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }) + '\n',
    );
    process.stderr.write(reason + '\n');
  } catch {
    /* ignore */
  }
  process.exit(0);
}

/**
 * Allow. `inertReason` is set only when the guard could not DECIDE — announcing
 * that on stderr is what keeps a silently-inert guard distinguishable from a
 * passing one (a guard that no-ops quietly is the worse failure).
 */
function done(inertReason) {
  if (inertReason) {
    try {
      process.stderr.write(`${INERT_MARKER} — allowed without judging: ${inertReason}\n`);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function selfTest() {
  const R = '/repo';
  const P = (rel) => `${R}/${SQL_DIR_SEGMENT}${rel}`;
  const cases = [
    // ── must be JUDGED (a migration write) ─────────────────────────────────
    { name: 'plain armed migration', path: P('820-add-foo.sql'), expect: { num: 820, draft: false, sqlName: '820-add-foo.sql' } },
    { name: '.DRAFT (judged one step earlier — see CONTRACT)', path: P('820-add-foo.sql.DRAFT'), expect: { num: 820, draft: true, sqlName: '820-add-foo.sql' } },
    { name: '.PENDING-CODE-DEPLOY', path: P('820-add-foo.sql.PENDING-CODE-DEPLOY'), expect: { num: 820, draft: true, sqlName: '820-add-foo.sql' } },
    { name: 'windows separators', path: `C:\\repo\\${SQL_DIR_SEGMENT.replace(/\//g, '\\')}821-x.sql`, expect: { num: 821, draft: false, sqlName: '821-x.sql' } },
    { name: 'zero-padded number', path: P('0494-x.sql'), expect: { num: 494, draft: false, sqlName: '0494-x.sql' } },
    // ── must NOT be judged ─────────────────────────────────────────────────
    { name: 'sql/archive/** (historical, one dir deeper)', path: P('archive/300-old.sql'), expect: null },
    { name: 'a non-migration file in the repo', path: `${R}/scripts/lint-migrations.mjs`, expect: null },
    { name: 'the sql dir but no numeric prefix', path: P('README.md'), expect: null },
    { name: 'numeric prefix but not .sql', path: P('820-add-foo.md'), expect: null },
    // D-092: the typed sidecar is NOT a migration artifact. Guarding it would
    // refuse the only remaining acknowledgement route for an applied migration.
    { name: 'forward-compat sidecar beside an applied migration', path: P('975-drop-idx.sql.forward-compat.json'), expect: null },
    // …but a look-alike suffix must still be guarded, or the exclusion above
    // becomes a way to smuggle edits past this guard.
    { name: 'look-alike suffix is still a migration artifact', path: P('975-drop-idx.sql.forward-compat.json.bak'), expect: { num: 975, draft: true, sqlName: '975-drop-idx.sql' } },
    { name: 'a same-named dir OUTSIDE the superproject (submodule checkout)', path: '/repo/libs/db/sql/820-x.sql', expect: null },
    { name: 'segment present but nothing before it (no derivable root)', path: `/${SQL_DIR_SEGMENT}820-x.sql`, expect: null },
    { name: 'empty path', path: '', expect: null },
  ];
  let failed = false;
  for (const c of cases) {
    const got = migrationTargetFrom(c.path);
    const ok = c.expect === null
      ? got === null
      : Boolean(got) && got.num === c.expect.num && got.draft === c.expect.draft && got.sqlName === c.expect.sqlName;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — ${c.name}\n`);
  }

  // ── which TOOL NAMES are inspected (imported from the sibling, so the
  //    measured capability_* hole cannot be re-opened here by omission) ──────
  const toolCases = [
    ['native Edit', 'Edit', true],
    ['native Write', 'Write', true],
    ['native MultiEdit', 'MultiEdit', true],
    ['MCP capability:edit', 'mcp__papercusp-su__capability_edit', true],
    ['MCP capability:write', 'mcp__papercusp-su__capability_write', true],
    ['capability:read (does not write bytes)', 'mcp__papercusp-su__capability_read', false],
    ['capability:bash (documented accepted gap)', 'mcp__papercusp-su__capability_bash', false],
    ['empty tool_name', '', false],
  ];
  for (const [name, tool, expect] of toolCases) {
    const ok = isFileWritingTool(tool) === expect;
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — tool: ${name}\n`);
  }

  // ── the refusal must name the REPAIR that actually applies ───────────────
  const t = { num: 815, sqlName: '815-expose-claim.sql', draft: false };
  const unapplied = denyReason(t, 'Write', 494, false);
  const appliedMsg = denyReason(t, 'Edit', 494, true);
  const appliedReservedMsg = denyReason(t, 'Edit', 494, true, true);
  const msgCases = [
    ['unapplied refusal hands back the allocator command', unapplied.includes('node scripts/next-migration.mjs --name expose-claim')],
    ['unapplied refusal offers the cheap fix, not the ceremony', unapplied.includes('ONE-COMMAND fix') && !unapplied.includes('ALREADY APPLIED')],
    ['unapplied refusal says how to salvage an existing file', unapplied.includes('mv')],
    ['applied refusal says the number is unrepairable', appliedMsg.includes('ALREADY APPLIED')],
    ['applied refusal names the backfill precedent + ON CONFLICT', appliedMsg.includes('807-backfill') && appliedMsg.includes('ON CONFLICT')],
    ['applied refusal allocates for the BACKFILL, never renames this file', appliedMsg.includes('--name backfill-migration-reservation-815') && !appliedMsg.includes('mv ')],
    ['applied refusal warns about the repair race', appliedMsg.includes('96s')],
    ['both name the fleet-wide consequence', unapplied.includes('RELEASE-CUT PREFLIGHT') && appliedMsg.includes('RELEASE-CUT PREFLIGHT')],
    ['allocated applied refusal names the immutable ledger', appliedReservedMsg.includes('already recorded in harness_shared.schema_migrations') && !appliedReservedMsg.includes('has no row in harness_shared.migration_reservations')],
    ['allocated applied refusal sends the correction to a new migration', appliedReservedMsg.includes('--name expose-claim-followup') && appliedReservedMsg.includes('Do not edit')],
  ];
  for (const [name, ok] of msgCases) {
    if (!ok) failed = true;
    process.stdout.write(`${ok ? 'ok' : 'FAIL'} — message: ${name}\n`);
  }

  const total = cases.length + toolCases.length + msgCases.length;
  process.stdout.write(failed ? 'SELF-TEST FAILED\n' : `ok — ${total} cases\n`);
  process.exit(failed ? 1 : 0);
}
