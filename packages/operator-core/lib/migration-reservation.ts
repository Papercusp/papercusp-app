/** Shared runtime guard for the migration-number reservation contract. */

import type postgres from 'postgres';

/** Mirrors scripts/lint-migrations.mjs's reservation-enforcement epoch. */
export const RESERVATION_ENFORCED_FROM = 494;

/** `<NNN>-<slug>.sql` → NNN, or null when the name carries no numeric prefix. */
export function migrationNumberOf(filename: string): number | null {
  const match = /^(\d+)-/.exec(filename);
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

const MIGRATION_SQL_PATH_RE = /(?:^|\/)libs\/db\/sql\/([^/]+\.sql)$/;

/** Return an enforced migration basename for a live `libs/db/sql` path. */
export function armedMigrationFilename(path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  const filename = MIGRATION_SQL_PATH_RE.exec(normalized)?.[1];
  if (!filename) return null;
  const num = migrationNumberOf(filename);
  return num !== null && num >= RESERVATION_ENFORCED_FROM ? filename : null;
}

export interface MigrationReservationRow {
  num: number;
  filename: string | null;
}

export interface MigrationReservationConflict {
  num: number;
  file: string;
  reservedFilename: string | null;
}

/** A migration has a known reservation conflict, distinct from a DB/read failure. */
export class MigrationReservationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationReservationConflictError';
  }
}

export interface DirtyMigrationReservationIssue {
  path: string;
  reason: string;
}

/** Pure filename-equality check used by boot reconciliation diagnostics. */
export function reservationFilenameConflicts(
  migrationFiles: readonly string[],
  reservations: readonly MigrationReservationRow[],
  enforcedFrom = RESERVATION_ENFORCED_FROM,
  activeFilenames?: ReadonlySet<string>,
): MigrationReservationConflict[] {
  const reservedByNumber = new Map(reservations.map((row) => [Number(row.num), row.filename]));
  const conflicts: MigrationReservationConflict[] = [];
  // `schema_migrations` is append-only: a file that was applied before a
  // collision was repaired can remain in history after it is removed from the
  // tree. When the caller supplies the active tree's filenames, compare only
  // rows that still have a runnable file. Otherwise a benign squashed-history
  // row would re-emit a CRITICAL conflict on every boot/checkpoint run.
  const filesToCheck = activeFilenames
    ? migrationFiles.filter((file) => activeFilenames.has(file))
    : migrationFiles;
  for (const file of filesToCheck) {
    const num = migrationNumberOf(file);
    if (num === null || num < enforcedFrom || !reservedByNumber.has(num)) continue;
    const reservedFilename = reservedByNumber.get(num) ?? null;
    // Historical allocator calls without --name recorded NNN-TODO-rename.sql,
    // then authors renamed the file before apply. These inputs are APPLIED
    // filenames, so the placeholder is frozen legacy debt; the pre-apply guard
    // still rejects every NEW/pending placeholder mismatch.
    if (reservedFilename === `${String(num).padStart(3, '0')}-TODO-rename.sql`) continue;
    if (reservedFilename !== file) conflicts.push({ num, file, reservedFilename });
  }
  return conflicts;
}

/**
 * SQL embedded in db:migrate's transaction immediately before `\i`.
 * Checking only that NUM exists is insufficient: an unreserved file can hijack
 * a peer's reserved number, which is exactly how 880-session-turn-parts was
 * applied over the 880-oauth-flow-private-context reservation.
 */
export function migrationReservationGuardSql(filename: string, enforcedFrom = RESERVATION_ENFORCED_FROM): string {
  const num = migrationNumberOf(filename);
  if (num === null || num < enforcedFrom) return '';
  const expected = filename.replace(/'/g, "''");
  return (
    `DO $papercusp_migration_reservation_guard$\n` +
    `DECLARE reserved_filename text;\n` +
    `BEGIN\n` +
    `  SELECT filename INTO reserved_filename\n` +
    `    FROM harness_shared.migration_reservations WHERE num = ${num};\n` +
    `  IF reserved_filename IS NULL THEN\n` +
    `    RAISE EXCEPTION 'migration ${num} has no reservation (expected ${expected})';\n` +
    `  ELSIF reserved_filename <> '${expected}' THEN\n` +
    `    RAISE EXCEPTION 'migration ${num} is reserved for %, not ${expected}', reserved_filename;\n` +
    `  END IF;\n` +
    `END\n` +
    `$papercusp_migration_reservation_guard$;\n`
  );
}

/** Fail closed before native boot/gate-preflight applies a mismatched file. */
export async function assertMigrationReservation(client: postgres.Sql, filename: string): Promise<void> {
  const num = migrationNumberOf(filename);
  if (num === null || num < RESERVATION_ENFORCED_FROM) return;
  const rows = await client<{ filename: string | null }[]>`
    SELECT filename FROM harness_shared.migration_reservations WHERE num = ${num}`;
  const reservedFilename = rows[0]?.filename ?? null;
  if (reservedFilename === filename) return;
  if (reservedFilename === null) {
    throw new MigrationReservationConflictError(`[migration-reservation-guard] ${filename} has no reservation row`);
  }
  throw new MigrationReservationConflictError(
    `[migration-reservation-guard] ${filename} cannot use ${num}; reserved for ${reservedFilename}`,
  );
}

/** Return only known reservation conflicts; database/query failures still throw. */
export async function checkDirtyMigrationReservations(
  client: postgres.Sql,
  dirtyPaths: readonly string[],
): Promise<DirtyMigrationReservationIssue[]> {
  const issues: DirtyMigrationReservationIssue[] = [];
  for (const path of new Set(dirtyPaths)) {
    const filename = armedMigrationFilename(path);
    if (!filename) continue;
    try {
      await assertMigrationReservation(client, filename);
    } catch (error) {
      if (!(error instanceof MigrationReservationConflictError)) throw error;
      issues.push({ path, reason: error.message });
    }
  }
  return issues;
}

/** Check only enforced migrations in a dirty-path census against the shared ledger. */
export async function assertDirtyMigrationReservations(
  client: postgres.Sql,
  dirtyPaths: readonly string[],
): Promise<void> {
  const filenames = [
    ...new Set(dirtyPaths.map(armedMigrationFilename).filter((filename): filename is string => filename !== null)),
  ];
  for (const filename of filenames) await assertMigrationReservation(client, filename);
}
