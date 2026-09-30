/**
 * The `harness_gym` experiment store (P-012) — the gym controller's record of
 * tasks, variants, runs, scores, cycles, and the frozen per-run params that make
 * variants comparable (D-016).
 *
 * Schema = migrations only, no runtime DDL (CLAUDE.md / self-contained-migration-
 * baseline-2026-06-02): the DDL lives in `./sql/*.sql` and is applied by the
 * migration runner. This is gym-PG-resident (D-018) — applied ONLY to the dedicated
 * gym Postgres database, never to the live operator DB and never added to the live
 * 000-baseline / sql-NNN sequence (which the strict fresh-migrate test guards). Gym
 * RUN DATA / transcripts / DBOS all stay in the gym PG; the live fleet is untouched.
 *
 * Data model: see the plan's "Data model (new harness_gym PG schema)" table.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
// eslint-disable-next-line import/no-relative-packages -- the real boot-path migration runner
import { applyPendingMigrations } from '../../../../libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directory of the gym-owned schema migrations, applied only to the gym PG. */
export const GYM_SQL_DIR = join(__dirname, 'sql');

/**
 * Apply the gym schema migrations to a client connected to the dedicated gym PG.
 * Idempotent (the runner tracks applied files in harness_shared.schema_migrations).
 */
export async function applyGymSchema(client: Sql, sqlDir: string = GYM_SQL_DIR): Promise<void> {
  await applyPendingMigrations({ client, sqlDir });
}
