/**
 * Shared real-PostgreSQL fixture for suites that drive `PgAdmissionLedgerQueueStore`
 * (plan `resource-governor-admission-ledger-2026-09-01`, P-006).
 *
 * The fixture is deliberately a CONTROL as much as a scaffold: it applies the
 * ledger migration (1062) on top of the two tables the ledger store still
 * touches — `operator_settings` (the cutover latch) and a MINIMAL `work_items`
 * (the bounded legacy census overlap) — and nothing else. There is no
 * `next_work_item_id()` / `work_item_seq`, so any code path that still tried to
 * allocate a work-item for an admission would throw instead of silently
 * passing. Every suite built on this fixture therefore proves the P-006
 * invariant "governor enqueue never writes or allocates work-items" for free.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FreshPgDb } from './_pg-helpers';

const HERE = dirname(fileURLToPath(import.meta.url));

export const ADMISSION_LEDGER_MIGRATION_PATH = resolve(
  HERE,
  '../../../libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql',
);

/** The substrate the ledger migration expects to find. Nothing more. */
export const ADMISSION_LEDGER_FIXTURE_DDL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS harness_shared;
  CREATE TABLE harness_shared.operator_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    description text,
    updated_at bigint NOT NULL DEFAULT 0,
    workspace_id text
  );
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    feature_id text NOT NULL,
    payload jsonb,
    PRIMARY KEY (workspace_id, feature_id)
  );
`;

/** Every table a ledger-store suite may dirty, in one TRUNCATE. */
export const ADMISSION_LEDGER_FIXTURE_TABLES = [
  'harness_shared.resource_governor_admissions',
  'harness_shared.operator_settings',
  'harness_shared.work_items',
] as const;

export async function applyAdmissionLedgerFixture(sql: FreshPgDb['sql']): Promise<void> {
  await sql.unsafe(ADMISSION_LEDGER_FIXTURE_DDL).simple();
  await sql.unsafe(readFileSync(ADMISSION_LEDGER_MIGRATION_PATH, 'utf8')).simple();
}

export async function truncateAdmissionLedgerFixture(sql: FreshPgDb['sql']): Promise<void> {
  await sql.unsafe(`TRUNCATE ${ADMISSION_LEDGER_FIXTURE_TABLES.join(', ')}`).simple();
}

/**
 * A liveness oracle that reports every lease owner LIVE, so a suite exercising
 * leases never reaches the ambient `liveness-oracle` (and the ambient database
 * behind it). Typed loosely on purpose: the store's `ResolveSessionStates` is a
 * `typeof import(...)` of the real oracle, and a fixture must not depend on
 * its full verdict shape.
 */
export const allSessionsLiveResolver = (async (subjects: readonly { ownerId: string }[]) =>
  new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const }]))) as never;

/** How many work-item rows the workspace holds — the P-006 "never allocates" probe. */
export async function workItemRowCount(sql: FreshPgDb['sql'], workspaceId: string): Promise<number> {
  const rows = await sql<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}`;
  return rows[0]?.count ?? 0;
}
