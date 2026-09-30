/**
 * Stable PostgreSQL application identities for the two independent backup
 * producers that can run concurrently on the same cluster.
 *
 * Ownership is load-bearing: the host backup reaps only its own abandoned
 * backends, while the per-workspace hook must be allowed to finish. Reusing
 * one identity lets the host cleanup terminate a healthy workspace dump.
 */
export const HOST_BACKUP_APPLICATION_NAME = 'pcbackup';
export const WORKSPACE_BACKUP_APPLICATION_NAME = 'pcbackup-workspace';

/** Every backup identity whose relation locks should defer a migration. */
export const BACKUP_APPLICATION_NAMES = [
  HOST_BACKUP_APPLICATION_NAME,
  WORKSPACE_BACKUP_APPLICATION_NAME,
] as const;

/**
 * Stable key shared by backup snapshots and every migration applier.
 *
 * The lock is deliberately a PostgreSQL advisory lock rather than a relation
 * lock probe: a snapshot must exclude a migration from the instant its
 * metadata row is created, before pg_dump has visited any relation.
 */
export const BACKUP_MIGRATION_ADVISORY_LOCK_KEY = 'papercusp:backup:migration-rendezvous';
