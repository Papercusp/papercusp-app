/**
 * Git-export hydrate (plan harness-state-storage-unification-2026-06-01, P-003b).
 *
 * The REVERSE of the drainer: git is the sync authority for `sync:'git'` tables,
 * so on boot (and after a `git pull`) the operator rebuilds the PG rows from the
 * committed `.papercusp/state/<dir>/*` files. This is what makes "clone-and-go"
 * work — a fresh checkout has the files but an empty PG.
 *
 * Disables the git-export capture trigger around the load so re-importing a file
 * doesn't bounce straight back into the export outbox (an echo loop). Generic
 * upsert: object/array values → jsonb, everything else → a normal bind param;
 * identifiers (table + columns) come from the trusted registry / PK map.
 */
import type postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stateDirFor, parseFile } from './serialize';
import { derivedColumnsFrom, stripDerivedCols } from './derived-cols';

const CAPTURE_TRG = 'capture_git_export_outbox_trg';

export interface HydrateGitTableOpts {
  sql: postgres.Sql;
  /** Absolute harness root (where `.papercusp/state/` lives). */
  harnessRoot: string;
  /** Bare harness_shared table name. */
  table: string;
  /** The table's FULL primary key (ON CONFLICT target). */
  conflictCols: string[];
  /** This install's workspace id — re-injected (stripped from the git file). */
  workspaceId: string;
  /** This harness's slug — re-injected (stripped from the git file). */
  harnessSlug: string;
}

/** Hydrate one git table from its `.papercusp/state` files into PG. Returns rows upserted. */
export async function hydrateGitTable(opts: HydrateGitTableOpts): Promise<number> {
  const { sql, harnessRoot, table, conflictCols, workspaceId, harnessSlug } = opts;
  const dir = join(harnessRoot, stateDirFor(table));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0; // no dir → nothing committed for this table
  }
  if (files.length === 0) return 0;

  // ── Identifier safety (security) ─────────────────────────────────────
  // `table` is from the trusted registry but is interpolated into raw SQL
  // below; `cols` (Object.keys of a parsed `.papercusp/state` file) are
  // UNTRUSTED file content — in the clone-and-go / shared-harness model a
  // crafted key would inject SQL into the column list. Validate the table
  // name shape, then check every column (and the conflict cols) against the
  // table's REAL schema. Values are already parameterized ($N); only the
  // identifiers needed guarding.
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`hydrate: refusing unsafe table identifier ${JSON.stringify(table)}`);
  }
  const schemaCols = await sql<{ column_name: string; udt_name: string }[]>`
    SELECT column_name, udt_name FROM information_schema.columns
     WHERE table_schema = 'harness_shared' AND table_name = ${table}
  `;
  const allowed = new Set(schemaCols.map((r) => r.column_name));
  if (allowed.size === 0) return 0; // unknown table → nothing to hydrate
  // EI-19900345996596896: derived (vector) columns are never git-synced. A legacy
  // file committed under a different embedding model carries a stale-width vector,
  // and pgvector rejects it (`expected 768 dimensions, not 384`) — which used to
  // abort this whole table and cost the hive its drain loop. Drop them instead;
  // embed-backfill regenerates the real values in PG.
  const derived = derivedColumnsFrom(schemaCols);
  for (const c of conflictCols) {
    if (!allowed.has(c)) {
      throw new Error(`hydrate: ${table} conflict column ${JSON.stringify(c)} is not a real column`);
    }
  }

  let n = 0;
  // EI-19900345996596896: a single unusable file must NOT cost this harness its
  // git-export drain loop. The caller (bootGitExportForHarness) hydrates every table
  // BEFORE calling startGitExportDrain, and catches per HARNESS — so a throw from one
  // file used to skip the drain for that whole hive. Isolate per file, keep going, and
  // report. If EVERY file failed the problem is systemic, so rethrow rather than
  // reporting a silent, empty success.
  const failures: { file: string; message: string }[] = [];
  let firstError: unknown = null;
  // Disable the capture trigger so the hydrate upserts don't re-enqueue exports.
  await sql.unsafe(`ALTER TABLE harness_shared.${table} DISABLE TRIGGER ${CAPTURE_TRG}`);
  try {
    for (const f of files) {
      try {
        const parsed = parseFile(table, await readFile(join(dir, f), 'utf8')) as Record<string, unknown>;
        // Drop derived (vector) columns a legacy file may still carry — see above.
        const row = stripDerivedCols(parsed, derived);
        // Re-inject the context/provenance columns stripped on serialize, from the
        // harness context (origin='remote' — it came from git, not a local edit).
        // Only for columns the table actually has, so it works for tables lacking
        // one of them (e.g. no workspace_id) without a bad-column INSERT.
        if (allowed.has('workspace_id') && row.workspace_id === undefined) row.workspace_id = workspaceId;
        if (allowed.has('harness_slug') && row.harness_slug === undefined) row.harness_slug = harnessSlug;
        if (allowed.has('origin') && row.origin === undefined) row.origin = 'remote';
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        // Reject any column the committed file claims that isn't in the real
        // schema — a crafted key here is the SQL-injection vector.
        for (const c of cols) {
          if (!allowed.has(c)) {
            throw new Error(
              `hydrate: ${table} file ${f} declares unknown column ${JSON.stringify(c)} ` +
                `(possible injection or schema drift) — aborting`,
            );
          }
        }
        const placeholders = cols.map((c, i) =>
          row[c] !== null && typeof row[c] === 'object' ? `$${i + 1}::text::jsonb` : `$${i + 1}`,
        );
        const params = cols.map((c) =>
          row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c],
        );
        const setCols = cols.filter((c) => !conflictCols.includes(c));
        const onConflict = setCols.length
          ? `DO UPDATE SET ${setCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`
          : 'DO NOTHING';
        await sql.unsafe(
          `INSERT INTO harness_shared.${table} (${cols.join(', ')}) ` +
            `VALUES (${placeholders.join(', ')}) ` +
            `ON CONFLICT (${conflictCols.join(', ')}) ${onConflict}`,
          params as never[],
        );
        n += 1;
      } catch (e) {
        if (firstError === null) firstError = e;
        failures.push({ file: f, message: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    await sql.unsafe(`ALTER TABLE harness_shared.${table} ENABLE TRIGGER ${CAPTURE_TRG}`);
  }
  if (failures.length > 0) {
    // EVERY file failed ⇒ the cause is systemic (schema drift, dead connection,
    // wholesale corruption), not one bad document. Surface that as a boot failure
    // rather than reporting a silent, empty success.
    if (n === 0) throw firstError instanceof Error ? firstError : new Error(String(firstError));
    console.warn(
      `[git-export] hydrate ${table}: skipped ${failures.length} of ${files.length} file(s), ` +
        `loaded ${n} — ` +
        failures
          .slice(0, 5)
          .map((x) => `${x.file}: ${x.message}`)
          .join('; ') +
        (failures.length > 5 ? ` (+${failures.length - 5} more)` : ''),
    );
  }
  return n;
}
