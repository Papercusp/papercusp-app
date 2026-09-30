/**
 * WI-10003357 — prove that pending migrations can apply while a backup still
 * holds the backup↔migration rendezvous.
 *
 * The rendezvous (`BACKUP_MIGRATION_ADVISORY_LOCK_KEY`) is held by a backup
 * producer for its whole dump lifecycle, which on this box includes a ~99 GiB
 * transcript tier that locks only the session-archive tables. Boot-migrate
 * used to wait on it unconditionally whenever any migration was pending, so a
 * request-only operator stayed dark for the entire backup (2026-09-26: 17:21 →
 * 17:46) even though its one pending migration touched a table the running
 * dump no longer held.
 *
 * What the rendezvous protects is real: `pg_dump -j` workers take their table
 * locks with NOWAIT, so a migration's AccessExclusive request on a table the
 * dump is reading fails the dump, and a queued AccessExclusive also stalls
 * every ordinary reader of that table. Both hazards exist only for relations
 * the backup has LOCKED. So the proof is relation-scoped: it reads the
 * relations currently locked by backup backends (the same identity predicate
 * `db:migrate`'s `migrationBackupLockGuardSql` uses), expands them with their
 * inheritance ancestors and index names, and refuses when any pending
 * migration names one — or contains a statement whose lock footprint cannot be
 * read from its text.
 *
 * It is deliberately conservative: a false "conflict" only means boot keeps
 * waiting (the old behaviour), while a false "safe" is the thing to avoid.
 */
import type { Sql } from 'postgres';
import { BACKUP_APPLICATION_NAMES } from '@papercusp/backup/application-names';

export interface PendingMigrationText {
  file: string;
  sqlText: string;
}

export interface MigrationLockConflict {
  file: string;
  /** The locked relation named, or the unprovable construct matched. */
  subject: string;
  reason: 'names-locked-relation' | 'unprovable-statement';
}

/**
 * Statements whose lock footprint reaches relations they do not name, so the
 * text match below cannot prove them safe.
 */
const UNPROVABLE_STATEMENTS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'EXECUTE (dynamic SQL)', re: /\bexecute\b/ },
  { label: 'ALL TABLES IN SCHEMA', re: /\ball\s+tables\s+in\s+schema\b/ },
  { label: 'ALL IN TABLESPACE', re: /\ball\s+in\s+tablespace\b/ },
  { label: 'DROP SCHEMA', re: /\bdrop\s+schema\b/ },
  { label: 'DROP OWNED', re: /\bdrop\s+owned\b/ },
  { label: 'REASSIGN OWNED', re: /\breassign\s+owned\b/ },
  { label: 'VACUUM', re: /\bvacuum\b/ },
  { label: 'CLUSTER', re: /\bcluster\b/ },
  { label: 'REINDEX SCHEMA/DATABASE/SYSTEM', re: /\breindex\s+(?:\([^)]*\)\s*)?(?:schema|database|system)\b/ },
  { label: 'ALTER DOMAIN', re: /\balter\s+domain\b/ },
  { label: 'DROP … CASCADE', re: /\bdrop\b[^;]*\bcascade\b/ },
  { label: 'TRUNCATE … CASCADE', re: /\btruncate\b[^;]*\bcascade\b/ },
];

/**
 * Lowercase, drop double quotes, and blank out comments so a rationale that
 * merely mentions a table cannot create a conflict, while every executable
 * identifier (including ones inside dollar-quoted DO/function bodies) remains
 * visible — those are matched conservatively on purpose.
 */
export function normalizeMigrationSql(sqlText: string): string {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .toLowerCase()
    .replace(/"/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure verdict: which pending migrations touch a relation the backup holds, or
 * cannot be proven not to. An empty result means every pending file is safe to
 * apply without the rendezvous.
 */
export function findBackupLockConflicts(
  pending: ReadonlyArray<PendingMigrationText>,
  lockedRelationNames: ReadonlyArray<string>,
): MigrationLockConflict[] {
  const names = [...new Set(lockedRelationNames.map((name) => name.toLowerCase()).filter(Boolean))];
  const matchers = names.map((name) => ({
    name,
    re: new RegExp(`(^|[^a-z0-9_$])${escapeRegExp(name)}([^a-z0-9_$]|$)`),
  }));
  const conflicts: MigrationLockConflict[] = [];
  for (const { file, sqlText } of pending) {
    const text = normalizeMigrationSql(sqlText);
    for (const { label, re } of UNPROVABLE_STATEMENTS) {
      if (re.test(text)) conflicts.push({ file, subject: label, reason: 'unprovable-statement' });
    }
    for (const { name, re } of matchers) {
      if (re.test(text)) conflicts.push({ file, subject: name, reason: 'names-locked-relation' });
    }
  }
  return conflicts;
}

/**
 * Relation names currently locked in THIS database by a backup backend,
 * expanded with inheritance/partition ancestors (DDL on a parent recurses into
 * a locked child) and the index names of every locked table (DROP/ALTER INDEX
 * locks the table without naming it).
 */
export async function readBackupLockedRelationNames(client: Sql): Promise<string[]> {
  const rows = await client<{ name: string }[]>`
    WITH RECURSIVE locked AS (
      SELECT DISTINCT l.relation AS oid
        FROM pg_locks AS l
        JOIN pg_stat_activity AS a ON a.pid = l.pid
       WHERE l.locktype = 'relation'
         AND l.granted
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND a.application_name = ANY(${client.array([...BACKUP_APPLICATION_NAMES])})
         AND a.pid <> pg_backend_pid()
    ), ancestry AS (
      SELECT oid FROM locked
      UNION
      SELECT i.inhparent FROM pg_inherits AS i JOIN ancestry AS c ON c.oid = i.inhrelid
    ), named AS (
      SELECT oid FROM ancestry
      UNION
      SELECT x.indexrelid FROM pg_index AS x JOIN ancestry AS t ON t.oid = x.indrelid
    )
    SELECT DISTINCT c.relname AS name
      FROM named
      JOIN pg_class AS c ON c.oid = named.oid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg\\_toast%'`;
  return rows.map((row) => row.name);
}

/** One-line summary for boot logs and retryable error messages. */
export function describeConflicts(conflicts: ReadonlyArray<MigrationLockConflict>): string {
  return conflicts
    .map((c) =>
      c.reason === 'names-locked-relation'
        ? `${c.file} names backup-locked relation ${c.subject}`
        : `${c.file} contains ${c.subject}, whose lock footprint cannot be proven`,
    )
    .join('; ');
}
