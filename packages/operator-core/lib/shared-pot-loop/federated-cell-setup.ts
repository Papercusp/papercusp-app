/**
 * federated-cell-setup.ts — per-cell DDL helpers for composition-rig tests that
 * federate surfaces BEYOND the work-item family the rig's base schema carries
 * (`CompositionRigOpts.extraCellSetup`).
 *
 *  - `coordCellSetup` — the coordination message rail: pre-147 coord_event_log
 *    baseline + the REAL federation migration (147 in archive, else its 150
 *    successor: harness_slug/origin/author_pubkey + the capture triggers) +
 *    fed_ts + the coord watermarks table. Extracted from the P-005 two-cell
 *    verb-lifecycle rig (coord-verb-lifecycle-two-cell.integration.test.ts) so
 *    the P-010 supervision rung composes the identical contract.
 *  - `presenceCellSetup` — harness_shared.shared_presence exactly as the live
 *    schema has it: the 000-baseline shape + PK, migration 187's hive_slug, and
 *    the 181-guard fed_ts the presence projection's LWW clause reads.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { ensureCoordWatermarksTable } from '@papercusp/coordination/watermark-store';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../libs/papercusp/libs/db/sql');
const FED_MIGRATION = resolve(SQL_DIR, '150-coord-event-log-federation.sql');
const FED_MIGRATION_147 = resolve(SQL_DIR, 'archive/147-coord-event-log-federation.sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

/** Pre-147 coord_event_log + the real federation migration + fed_ts + watermarks. */
export async function coordCellSetup(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
      id           bigserial   PRIMARY KEY,
      -- A test-rig reproduction of the HISTORICAL pre-147 coord_event_log, whose whole
      -- purpose is to replay the real federation migration on top of the shape that
      -- existed before it. Fidelity to that PAST schema is the point, so it must not
      -- track P-007's forward drop-default change (data-scoping-audit-2026-06-22 D-005).
      -- allow-workspace-default: historical replay fixture; nothing production writes here.
      workspace_id text        NOT NULL DEFAULT 'default',
      surface      text        NOT NULL,
      writer_key   text,
      msg_id       text        NOT NULL,
      body         jsonb       NOT NULL,
      ts           timestamptz NOT NULL DEFAULT now()
    );
  `);
  // The real federation migration (147 in archive, else its 150 successor):
  // harness_slug/origin/author_pubkey columns + the capture triggers.
  let fed: string | null = null;
  for (const p of [FED_MIGRATION_147, FED_MIGRATION]) {
    try {
      fed = readFileSync(p, 'utf8');
      break;
    } catch { /* try the next location */ }
  }
  if (!fed) throw new Error('coord federation migration file not found (147/150)');
  await sql.unsafe(stripMeta(fed));
  await sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
  // D-001 (mig 314): the HLC ordering key the coord-message projection now writes.
  await sql.unsafe(`ALTER TABLE harness_shared.coord_event_log ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  await ensureCoordWatermarksTable(sql);
}

/**
 * harness_shared.shared_presence as the live schema has it (baseline + 187 + 181
 * + 682's `runs_routines`).
 *
 * ⚠ EI-18817201237512691 — this DDL is HAND-ROLLED, and there are NINE such
 * copies across the tree (see the issue for the list). They drift independently:
 * measured 2026-08-02, SEVEN of the nine still lacked `runs_routines` five days
 * after migration 682 added it, and because production `presence.ts` writeToPg
 * writes that column, every one of them made a merge pass throw
 * `column "runs_routines" of relation "shared_presence" does not exist` — an
 * error that names a COLUMN and never the stale fixture, so it reads as a code
 * bug and is not one. All nine now carry it.
 *
 * If you add a column to shared_presence in a migration, you must add it here
 * AND to the other eight. The recurrence fix (one shared fixture builder, or
 * applying the real migration) is still open on that issue.
 */
export async function presenceCellSetup(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
      workspace_id   text        NOT NULL DEFAULT '',
      harness_slug   text        NOT NULL,
      github_user_id bigint      NOT NULL,
      machine_label  text        NOT NULL,
      device_pubkey  text        NOT NULL,
      intent         text,
      current_view   text,
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      runs_routines boolean,
      schema_version bigint      NOT NULL DEFAULT 1,
      pot_slug       text,
      fed_ts         bigint,
      fed_hlc        text,
      author_pubkey  text,
      active_routines text[],
      PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
    );
  `);
}
