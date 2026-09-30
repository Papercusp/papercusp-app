/**
 * _pg-helpers.ts — shared fixture for the engine *-pg real-Postgres integration
 * tests (P-008). NOT a test file (no `.integration.test.ts` suffix, so the glob
 * never collects it) — it is imported by them.
 *
 * Isolation (a throwaway database on the shared, reused testcontainer + a `drop`
 * that terminates backends first) is now the SHARED primitive `createFreshTestDb`
 * in @papercusp/test-config — the same engine Restart's provisionRestartTestDb /
 * createMigratedTestDb use. This helper only adds the two Papercusp-specific bits:
 *   1. a PRODUCTION-FAITHFUL client — `prepare:false` + BIGINT→number, matching
 *      libs/papercusp/libs/db/src/connection.ts. Using the same client config is
 *      load-bearing: it's what makes a real bug (e.g. the lanes jsonb double-encode)
 *      reproduce here exactly as in production, not a test-only client artifact.
 *   2. the `harness_shared` schema.
 *
 * cleanup() closes the client and drops the throwaway DB but leaves the container
 * up for reuse by the next test file (testcontainers `.withReuse()`), so a serial
 * integration run doesn't pay the ~2s boot per file.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config';

import { stripSqlComments as sharedStripSqlComments } from '../../../scripts/lib/strip-comments-and-strings.mjs';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../libs/papercusp/libs/db/sql');

export interface FreshPgDb {
  /** Connection URL for the freshly-provisioned database. */
  url: string;
  sql: postgres.Sql;
  cleanup: () => Promise<void>;
}

/**
 * Minimal projection of migration 143 for fixtures that exercise the
 * agent_activity-backed holder-liveness reader. Keep only the columns read by
 * activeTurnHolderFragment; callers that need the full activity write path
 * should apply the real migration instead.
 */
export const AGENT_ACTIVITY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_activity (
    id BIGSERIAL PRIMARY KEY,
    owner_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;

/**
 * Minimal projection of `harness_shared.routines` for fixtures that exercise a
 * `liveHolderFragment`-backed reader.
 *
 * EI-21431501901242395 added an armed-loop UNION leg to `liveHolderFragment`
 * (`work-items-stale-claims.ts`) that reads this table. Every hand-rolled
 * fixture calling a reader built on that fragment — the stuck-item / dead-held
 * metrics, hold-open, the lease reaper, claim-lease cleanup — must now create
 * it, and one that does not fails with `relation "harness_shared.routines" does
 * not exist` on EVERY test in the file, which reads like a broken suite rather
 * than a stale fixture.
 *
 * Measured 2026-08-29: FOUR private hand-rolled copies of this DDL already
 * exist (work-items-hold-open, work-item-claim-lease-issue-cleanup,
 * work-item-lock-reclaim, work-items-stale-claims — each a `const ROUTINES_DDL`
 * local to its own file) and there was NO shared export. Four independent
 * copies of a projection of someone else's table is a drift generator: the next
 * column `liveHolderFragment` starts reading has to be added in four places, and
 * whichever one is missed fails as an entire red suite. Import this instead of
 * adding a fifth.
 *
 * Keep only the columns the fragment reads (`target_owner_id`, `active`,
 * `reschedule_interval_sec`); a fixture that needs the real routines write path
 * should apply the migration instead.
 */
export const LIVE_HOLDER_ROUTINES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.routines (
    id text PRIMARY KEY,
    target_owner_id text,
    reschedule_interval_sec integer,
    active boolean NOT NULL DEFAULT true
  )`;

/**
 * EI-6887 — apply ONE real migration SQL file to a hand-provisioned test DB
 * (e.g. `createFreshPgDb` above) via `sql.unsafe`, which speaks SQL, not psql.
 * Newer migrations (461/462/464/465+) carry `\set ON_ERROR_STOP on` psql
 * meta-commands + a top-level BEGIN;/COMMIT; wrapper per the runner convention
 * — raw `sql.unsafe(readFileSync(file))` on one of these fails TWICE in
 * sequence: first on the `\`-line ("syntax error at or near \"\\\""), then
 * (once that's stripped) on postgres-js's UNSAFE_TRANSACTION guard (raw txn
 * control isn't allowed on a pooled/non-`sql.begin` client). Older migrations
 * (184/185/189) carry neither, so a test written against them silently
 * doesn't transfer to a newer one. This strips both (the wrapper is a
 * production-apply nicety, not a correctness requirement for a hand-applied
 * single-file DDL run — the file's own DDL is idempotent) so any migration,
 * old or new, applies the same way. Lifted from the inline version in
 * `lib/agent-facts/store.integration.test.ts` (the first two call sites —
 * that file and composition-rig.ts — both hand-rolled equivalent filters).
 */
export async function applyMigrationForTest(sql: postgres.Sql, filePath: string): Promise<void> {
  const sqlText = readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('\\') && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()))
    .join('\n');
  await sql.unsafe(sqlText);
}

/**
 * ── EI-18808675015292160: the hand-maintained migration list, made self-checking
 *
 * Fixtures stand their schema up from a hardcoded list of migration filenames.
 * Nothing linked that list to the migrations that actually exist, so when a
 * migration landed on a table a fixture uses, the fixture kept applying the old
 * set and the suite went red with an error naming a COLUMN — never the stale
 * list. That cost 9 red tests across 3 files on 2026-07-27, and the same shape
 * had already burned four separate tickets via `applyPlanItemClaimMigrations`
 * below (EI-9508/9509/9513/9515).
 *
 * `applyMigrationsForTest` applies the list AND proves it is still complete, so
 * the rot fails loudly and names itself instead of surfacing as a column error.
 *
 * ── How completeness is decided (and why not the obvious way) ───────────────
 * Everything is derived FROM THE LIST (plus the explicit `runtimeTables`
 * contract) — there is no second registry to keep in sync, which is what makes
 * this unable to fall behind in turn:
 *   1. parse the listed files for the tables they structurally CREATE/ALTER;
 *   2. scan sql/ for HIGHER-numbered migrations touching those same tables;
 *   3. throw naming the missing file(s) and the table that made each relevant.
 *
 * Two deliberate narrowings, each one a measured counterexample:
 *
 *  - STRUCTURAL statements only (`CREATE TABLE` / `ALTER TABLE`), never a mere
 *    mention. The obvious "scan for the table name" rule pulls in migrations
 *    that only reference the table in passing, and applying those fails
 *    wholesale: 214 attaches triggers to a table list these fixtures have no
 *    tables for (`harness_plans`), which is exactly the trap this replaces.
 *
 *  - A later migration is REQUIRED only when EVERY table it touches is already
 *    in the fixture's own table set. A WIDE migration (488-federated-rls-backstop
 *    touches agent_facts plus 3 unrelated tables) cannot be applied by a fixture
 *    that only builds agent_facts, so demanding it would be an error nobody can
 *    fix. Those are reported separately as advisory context, never as a failure,
 *    UNLESS the migration structurally touches an explicitly declared
 *    `runtimeTables` entry. Runtime tables are a stronger contract: their
 *    creating migration and every later structural migration must be declared,
 *    even when a later migration is wide.
 *
 * A third case the table-overlap heuristic cannot see at all (EI found via
 * WI-35535): a migration can touch ONLY the fixture's declared table by name
 * and still be structurally inapplicable, because it depends on a COLUMN the
 * fixture's deliberately-minimal DDL never built (e.g. an
 * `ADD COLUMN ... GENERATED ALWAYS AS (payload ->> 'x')` when the fixture has
 * no `payload`), or because it `CREATE OR REPLACE`s a view with a column set
 * incompatible with the fixture's own minimal view (Postgres refuses that
 * outright). Turning such a fixture into a near-full schema replica to satisfy
 * the prescription would dilute the narrow guard it exists to provide — so
 * `applyMigrationsForTest` accepts an explicit, per-file, JUSTIFIED opt-out
 * (`knownInapplicable`) instead. Unlike disabling the audit wholesale
 * (`audit: false`), this keeps the audit live for every OTHER migration: a
 * genuinely-missed, actually-applicable gap still throws.
 */

/**
 * PURE — strip SQL comments so a table named only in prose never counts.
 *
 * Delegates to the CANONICAL shared mask (EI-20073035509369492). The private regex pair
 * this replaced was not quote-aware, so a `--` inside a STRING LITERAL blanked the rest of
 * the line:
 *
 *   INSERT INTO t(note) VALUES ('see -- below'); CREATE TABLE harness_shared.hidden_one (id text);
 *
 * `tablesTouchedBySql` then MISSED `harness_shared.hidden_one` entirely — and since a table
 * it cannot see is a table the migration-list audit cannot flag as a gap, the failure mode
 * was a silent false NEGATIVE in an audit whose whole job is to throw on gaps. No migration
 * in the current corpus triggers it (measured: identical table sets across all 661), so this
 * closes a latent hole rather than changing any present verdict.
 *
 * ⚠ COMMENTS-ONLY, not `stripSqlCommentsAndStrings`: sealing `$tag$` bodies would hide a
 * `CREATE TABLE` issued inside a `DO $$ … $$` block.
 */
export function stripSqlComments(sqlText: string): string {
  return sharedStripSqlComments(sqlText);
}

/**
 * PURE — the schema-qualified tables a migration structurally CREATEs or ALTERs.
 * Comment-only and passing references are excluded by construction.
 */
export function tablesTouchedBySql(sqlText: string): Set<string> {
  const body = stripSqlComments(sqlText);
  const out = new Set<string>();
  const re = /\b(?:CREATE|ALTER)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi;
  for (const m of body.matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

/** PURE — the schema-qualified tables a migration actually creates. */
export function tablesCreatedBySql(sqlText: string): Set<string> {
  const body = stripSqlComments(sqlText);
  const out = new Set<string>();
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi;
  for (const m of body.matchAll(re)) out.add(m[1].toLowerCase());
  return out;
}

/** PURE — functions and triggers a migration creates or replaces. */
export function objectsTouchedBySql(sqlText: string): Set<string> {
  const body = stripSqlComments(sqlText);
  const out = new Set<string>();
  const functionRe =
    /\bCREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gi;
  const triggerRe =
    /\bCREATE\s+TRIGGER\s+([a-z_][a-z0-9_]*)\s+(?:BEFORE|AFTER|INSTEAD\s+OF)\b/gi;
  for (const m of body.matchAll(functionRe)) out.add(`function:${m[1].toLowerCase()}`);
  for (const m of body.matchAll(triggerRe)) out.add(`trigger:${m[1].toLowerCase()}`);
  return out;
}

/** PURE — leading migration number (`689-agent-facts-…sql` → 689), else null. */
export function migrationNumber(fileName: string): number | null {
  const m = /^(\d+)-/.exec(fileName);
  return m ? Number(m[1]) : null;
}

export interface MigrationListAudit {
  /** Later migrations that touch ONLY the fixture's own tables — these are real,
   *  actionable gaps and are what `applyMigrationsForTest` throws on. */
  missing: { file: string; tables: string[]; objects?: string[] }[];
  /** Later migrations touching the fixture's tables AND others — not applicable
   *  to a partial fixture, so advisory context only, never a failure. */
  wider: { file: string; tables: string[]; objects?: string[] }[];
  /** The tables the declared list itself builds. */
  tables: string[];
  /** The functions and triggers the declared list itself builds or replaces. */
  objects: string[];
  /** Runtime-used tables whose first creating migration is not declared. */
  runtimeMissing: { table: string; migration: string | null }[];
  /** Runtime-used tables with a later structural migration missing from the list. */
  runtimeStale: { table: string; migration: string }[];
}

/**
 * PURE — audit a fixture's migration list against the real migration directory.
 * `allMigrations` is [fileName, sqlText] for every file in sql/.
 */
export function auditMigrationList(
  declared: string[],
  allMigrations: Iterable<readonly [string, string]>,
  runtimeTables: Iterable<string> = [],
): MigrationListAudit {
  const declaredSet = new Set(declared);
  const byFile = new Map<string, { tables: Set<string>; objects: Set<string>; createdTables: Set<string> }>();
  for (const [file, text] of allMigrations) {
    byFile.set(file, {
      tables: tablesTouchedBySql(text),
      objects: objectsTouchedBySql(text),
      createdTables: tablesCreatedBySql(text),
    });
  }

  const creatingMigration = new Map<string, string>();
  for (const [file, touched] of [...byFile].sort(
    (a, b) => (migrationNumber(a[0]) ?? 0) - (migrationNumber(b[0]) ?? 0),
  )) {
    for (const table of touched.createdTables) {
      if (!creatingMigration.has(table)) creatingMigration.set(table, file);
    }
  }

  const tables = new Set<string>();
  const objects = new Set<string>();
  for (const file of declared) {
    for (const t of byFile.get(file)?.tables ?? []) tables.add(t);
    for (const object of byFile.get(file)?.objects ?? []) objects.add(object);
  }

  // The watermark is PER TABLE, not global. A global "newest declared" hides a
  // real gap behind an unrelated table: a list carrying 693 (agent_facts) and
  // 609 (session_cursor) would silently skip a 650 that alters session_cursor,
  // because 650 < 693. Per table, 650 > 609 and is correctly flagged.
  // Below a table's own watermark, an omission is a deliberate choice, not rot.
  const watermark = new Map<string, number>();
  const objectWatermark = new Map<string, number>();
  for (const file of declared) {
    const n = migrationNumber(file) ?? 0;
    for (const t of byFile.get(file)?.tables ?? []) {
      watermark.set(t, Math.max(watermark.get(t) ?? 0, n));
    }
    for (const object of byFile.get(file)?.objects ?? []) {
      objectWatermark.set(object, Math.max(objectWatermark.get(object) ?? 0, n));
    }
  }

  const missing: { file: string; tables: string[]; objects?: string[] }[] = [];
  const wider: { file: string; tables: string[]; objects?: string[] }[] = [];
  for (const [file, touched] of [...byFile].sort(
    (a, b) => (migrationNumber(a[0]) ?? 0) - (migrationNumber(b[0]) ?? 0),
  )) {
    if (declaredSet.has(file)) continue;
    const n = migrationNumber(file);
    if (n === null) continue;
    const overlapTables = [...touched.tables].filter(
      (t) => tables.has(t) && n > (watermark.get(t) ?? 0),
    );
    const overlapObjects = [...touched.objects].filter(
      (object) => objects.has(object) && n > (objectWatermark.get(object) ?? 0),
    );
    if (!overlapTables.length && !overlapObjects.length) continue;
    const allTouched = touched.tables.size + touched.objects.size;
    const allOverlapping = overlapTables.length + overlapObjects.length;
    const entry = {
      file,
      tables: overlapTables.sort(),
      ...(overlapObjects.length ? { objects: overlapObjects.sort() } : {}),
    };
    if (allTouched === allOverlapping) missing.push(entry);
    else wider.push(entry);
  }
  const runtimeTableNames = [...new Set(
    [...runtimeTables].map((table) => table.trim().toLowerCase()),
  )].sort();
  const orderedMigrations = [...byFile].sort(
    (a, b) => (migrationNumber(a[0]) ?? 0) - (migrationNumber(b[0]) ?? 0),
  );
  const runtimeMissing = runtimeTableNames
    .flatMap((table) => {
      const migration = creatingMigration.get(table) ?? null;
      return migration && declaredSet.has(migration) ? [] : [{ table, migration }];
    });
  const runtimeStale = runtimeTableNames.flatMap((table) => {
    const tableWatermark = watermark.get(table) ?? 0;
    return orderedMigrations.flatMap(([file, touched]) => {
      const n = migrationNumber(file);
      return !declaredSet.has(file) && n !== null && n > tableWatermark && touched.tables.has(table)
        ? [{ table, migration: file }]
        : [];
    });
  });

  return {
    missing,
    wider,
    tables: [...tables].sort(),
    objects: [...objects].sort(),
    runtimeMissing,
    runtimeStale,
  };
}

/** PURE — the self-describing failure text. Names the FILE and the TABLE that
 *  made it relevant, which is precisely what the column-level error never did. */
export function formatStaleMigrationList(audit: MigrationListAudit, label: string): string {
  const lines = [
    `${label}: this fixture's hardcoded migration list is STALE (EI-18808675015292160).`,
    ``,
    `It builds: ${audit.tables.join(', ')}`,
    ``,
  ];
  if (audit.missing.length) {
    lines.push(
      `Migrations landed since that touch ONLY those tables and are NOT in the list —`,
      `add them (in numeric order) to fix this:`,
      ...audit.missing.map(
        (m) =>
          `  + '${m.file}'   (touches ${[...m.tables, ...(m.objects ?? [])].join(', ')})`,
      ),
      ``,
      `IF ADDING ONE FAILS instead of fixing it — typically "cannot drop columns from`,
      `view" / "cannot change name of view column" from a CREATE OR REPLACE VIEW, or a`,
      `"column already exists" / missing-relation error — that migration is STRUCTURALLY`,
      `INAPPLICABLE to this fixture: the canonical DDL already carries its effects at a`,
      `LATER shape, so replaying it re-declares them at their older, narrower one. Do NOT`,
      `widen the fixture's DDL to satisfy it, and do NOT reach for audit:false. Move it`,
      `out of the declared list and acknowledge it instead:`,
      ``,
      `    applyMigrationsForTest(sql, [...], {`,
      `      label: '...',`,
      `      knownInapplicable: [{ file: '<the migration>', reason: '<why it cannot apply>' }],`,
      `    })`,
      ``,
      `That subtracts ONLY that file from this check; every other gap still fails loudly.`,
      `Note this audit throws BEFORE applying anything, so while it is red NO migration in`,
      `the list has run — silencing it can surface a second, older conflict underneath.`,
    );
  }
  if (audit.runtimeMissing.length) {
    lines.push(
      ``,
      `Runtime-used tables are missing their creating migration from this list —`,
      `add the creating migration before exercising the runtime path:`,
      ...audit.runtimeMissing.map(
        (m) =>
          `  ! '${m.table}'   (creating migration ${m.migration ? `'${m.migration}'` : 'not found'})`,
      ),
    );
  }
  if (audit.runtimeStale.length) {
    lines.push(
      ``,
      `Runtime-used tables have later structural migrations missing from this list —`,
      `declare them even when they also touch tables outside this fixture:`,
      ...audit.runtimeStale.map(
        (m) => `  ! '${m.migration}'   (extends runtime-used table '${m.table}')`,
      ),
    );
  }
  if (audit.wider.length) {
    lines.push(
      ``,
      `FYI only — these also touch your tables but touch others too, so a partial`,
      `fixture cannot apply them wholesale. Not a failure; listed for diagnosis:`,
      ...audit.wider.map(
        (m) =>
          `  ~ ${m.file}   (overlaps ${[...m.tables, ...(m.objects ?? [])].join(', ')})`,
      ),
    );
  }
  return lines.join('\n');
}

/** Read every migration in sql/ as [fileName, sqlText]. */
function readAllMigrations(): [string, string][] {
  return readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => [f, readFileSync(resolve(SQL_DIR, f), 'utf8')] as [string, string]);
}

/** One migration a fixture cannot absorb, with a REQUIRED reason (never a bare
 *  filename) — the reason is what makes this an acknowledged, reviewable
 *  narrowing instead of a silent suppression. See the header block above. */
export interface KnownInapplicableMigration {
  file: string;
  /** WHY this fixture cannot apply it — the column/view shape it depends on
   *  that the fixture's deliberately-minimal DDL does not build. */
  reason: string;
}

/**
 * Apply a fixture's declared migration list in the given order, after proving
 * the list has not fallen behind the migrations that actually exist.
 *
 * Drop-in for the `for (const m of [...]) await applyMigrationForTest(...)` loop
 * every fixture hand-rolled. Set `auditOnly:false` to skip the check (there is
 * no good reason; it exists so a fixture mid-repair can still run).
 *
 * `knownInapplicable` acknowledges specific later migrations the audit would
 * otherwise demand, that this fixture structurally cannot apply (see the
 * header block above) — each entry is subtracted from the audit's `missing`
 * and runtime-stale sets before it decides whether to throw. This is narrower than `audit:
 * false`: every OTHER migration the audit finds is still enforced, so a
 * genuinely-missed, actually-applicable gap still fails loudly. Prefer this
 * over widening the fixture's DDL to satisfy an inapplicable prescription —
 * doing that dilutes the narrow guard the fixture exists to provide.
 */
export async function applyMigrationsForTest(
  sql: postgres.Sql,
  declared: string[],
  opts: {
    label?: string;
    audit?: boolean;
    knownInapplicable?: KnownInapplicableMigration[];
    /** Schema-qualified tables the runtime path writes or reads. Their creating
     * migration and every later structural migration must be present in
     * `declared`. */
    runtimeTables?: Iterable<string>;
  } = {},
): Promise<void> {
  if (opts.audit !== false) {
    const audit = auditMigrationList(declared, readAllMigrations(), opts.runtimeTables);
    const acknowledged = new Set((opts.knownInapplicable ?? []).map((k) => k.file));
    const stillMissing = audit.missing.filter((m) => !acknowledged.has(m.file));
    const stillRuntimeStale = audit.runtimeStale.filter((m) => !acknowledged.has(m.migration));
    if (stillMissing.length || audit.runtimeMissing.length || stillRuntimeStale.length) {
      throw new Error(
        formatStaleMigrationList(
          { ...audit, missing: stillMissing, runtimeStale: stillRuntimeStale },
          opts.label ?? 'applyMigrationsForTest',
        ),
      );
    }
  }
  for (const file of declared) {
    await applyMigrationForTest(sql, resolve(SQL_DIR, file));
  }
}

/**
 * Apply the migrations `claims.ts`'s `acquireClaimLocal` path needs against a
 * hand-provisioned test DB: 140 (plan-item assignments), 141 (leased claims),
 * 143 (agent_activity — the EI-8997 holder-activity grace join). Every
 * plan-items integration test that exercises claims.ts used to hand-copy this
 * list itself; when 143 was added as a dependency, at least four files missed
 * it independently and each generated its own watchdog red-test ticket
 * (EI-9508, EI-9509, EI-9513, EI-9515 — see EI-9613). Call this once in
 * `beforeAll` instead of listing the files by hand; a future migration
 * `claims.ts` starts depending on becomes a one-line addition here.
 *
 * GRANT-stripped (unlike `applyMigrationForTest`): 4 of the 5 call sites this
 * replaces (plan-item-claim-two-instance / plan-items / activity-claim-renewal
 * / claim-discipline .integration.test.ts) already hand-filtered GRANT lines
 * out of these exact 3 migrations rather than pre-creating the `harness_app`
 * / `harness_zero` roles the GRANTs target — a fresh testcontainer DB has
 * neither role until some file creates them, and role creation order across a
 * shared/reused container isn't guaranteed. The 5th site
 * (claims.integration.test.ts) instead pre-creates both roles via a DO block;
 * stripping GRANT here makes that block redundant but harmless, and keeps
 * this helper a true behavior-preserving drop-in for every call site (the
 * DDL itself is identical either way — GRANTs never affect table/column
 * shape, only a role's runtime privileges the test's own superuser/owner
 * connection doesn't need).
 */
export async function applyPlanItemClaimMigrations(sql: postgres.Sql): Promise<void> {
  for (const f of ['140-plan-item-assignments.sql', '141-plan-item-claims.sql', '143-agent-activity.sql']) {
    const sqlText = readFileSync(resolve(SQL_DIR, f), 'utf8')
      .split('\n')
      .filter(
        (l) => !l.trimStart().startsWith('\\') && !/\bGRANT\b/.test(l) && !/^(BEGIN|COMMIT);\s*$/i.test(l.trim()),
      )
      .join('\n');
    await sql.unsafe(sqlText);
  }
}

/**
 * Federation ordering key (mig-458 / EI-1698). Every hyperbee projection's
 * PG-level LWW guard (ON CONFLICT … WHERE / DELETE WHERE) compares in one order
 * space via harness_shared.fed_order_key(hlc, ts) — the SAME derivation as the
 * in-process lwwPick. Hand-provisioned projection integration tests build only a
 * subset of the schema and never run mig-458, so without seeding this every
 * projection write/delete throws "function fed_order_key(text, bigint) does not
 * exist". It's a pure, table-free, IMMUTABLE fn — safe + idempotent to seed in
 * any fresh test DB after `CREATE SCHEMA harness_shared`. Keep the body
 * word-for-word in sync with
 * libs/papercusp/libs/db/sql/458-fed-order-key-transitivity-fix.sql.
 */
export const FED_ORDER_KEY_DDL = `
  CREATE OR REPLACE FUNCTION harness_shared.fed_order_key(hlc text, ts bigint)
  RETURNS text LANGUAGE sql IMMUTABLE AS $fed_order_key$
    SELECT COALESCE(hlc, lpad(COALESCE(ts, 0)::text, 15, '0') || ':00000');
  $fed_order_key$;
  -- WI-2923 (mig 504): the apply-guard's tie-break at an equal order key —
  -- writer-pair when both known, else the symmetric content digest (local rows
  -- carry author_pubkey NULL, mig 214 stamps fed_ts only). Keep the body
  -- word-for-word in sync with
  -- libs/papercusp/libs/db/sql/504-fed-apply-writer-tiebreak.sql.
  CREATE OR REPLACE FUNCTION harness_shared.fed_apply_wins(
    excluded_hlc text, excluded_ts bigint, excluded_writer text, excluded_digest text,
    local_hlc    text, local_ts    bigint, local_writer    text, local_digest    text
  ) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fed_apply_wins$
    SELECT CASE
      WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
         > harness_shared.fed_order_key(local_hlc, local_ts) THEN true
      WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
         < harness_shared.fed_order_key(local_hlc, local_ts) THEN false
      WHEN excluded_writer IS NOT NULL AND local_writer IS NOT NULL
           AND excluded_writer <> local_writer THEN excluded_writer > local_writer
      ELSE COALESCE(excluded_digest, '') >= COALESCE(local_digest, '')
    END;
  $fed_apply_wins$;
`;

/**
 * ⚠ THIS DOES NOT RUN REAL MIGRATIONS. It provisions a genuinely EMPTY database
 * (`CREATE SCHEMA harness_shared` + the fed-order-key fns only) — every table your
 * test needs, YOU hand-roll as inline DDL in the calling `*.integration.test.ts`
 * file. There is no schema replay to fall back on.
 *
 * The footgun (EI-9387): when a table/column rename migration lands, a hand-rolled
 * DDL fixture using the OLD name still "successfully" creates a table — just the
 * wrong one — and the test then fails with `relation "harness_shared.<new_name>"
 * does not exist`, which reads EXACTLY like a genuine migration-replay bug. Two
 * agents burned a full session (P-009, 2026-07-09) chasing that theory against
 * migration 557 before finding the fixtures, not the migrations, were stale. If
 * you're hunting a "does not exist" failure from a test that uses this helper,
 * check the inline DDL in the test file FIRST — it is never auto-replayed from
 * `libs/papercusp/libs/db/sql/`.
 *
 * Need real migrations replayed instead? Use `createMigratedTestDb` /
 * `provisionRestartTestDb` (@papercusp/test-config) — those DO apply the actual
 * migration files.
 */
export async function createFreshPgDb(prefix = 'eng'): Promise<FreshPgDb> {
  const db = await createFreshTestDb({ prefix });

  const sql = postgres(db.url, {
    max: 4,
    onnotice: () => {},
    prepare: false,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await sql.unsafe(FED_ORDER_KEY_DDL);

  const cleanup = async () => {
    await sql.end({ timeout: 5 });
    await db.drop();
  };

  return { url: db.url, sql, cleanup };
}
