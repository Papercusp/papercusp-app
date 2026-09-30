/**
 * armHiveCrossHiveDrainRoutine — arm a hive's OWN periodic cross-Hive
 * outbox-drain routine at pot:create, the per-hive twin of the operator-home
 * seed (seed-cross-hive-drain-routine.ts, which now delegates here).
 *
 * WHY (the bug this closes): pot:create provisioned the per-hive learning loop
 * (gym + scout) but NEVER armed the cross-hive-outbox-drain. A hive still
 * accumulates a `harness_shared.substrate_outbox` — every federated-table write
 * enqueues a row — and with no drain routine under the hive's OWN install_slug
 * those rows are never reconciled/marked drained, so they grow unbounded.
 * papercusp reached 24k undrained (2026-06-19) before this was caught; only the
 * operator-home install (papercup) had ever been seeded, via the manual script.
 *
 * The drain ACTION self-gates (zero published Hive boundaries ⇒ a no-op tick:
 * one registry read), so seeding the routine ACTIVE is safe and it goes live the
 * moment the hive publishes a boundary. Mirrors the seed script's row EXACTLY so
 * the two can't drift; keyed on the hive's OWN install_slug. Returns an `undo`
 * that joins pot:create's rollback stack (same contract as
 * provisionHiveLearningLoop); the matching teardown lives in
 * teardownHiveLearningLoop (pot:dissolve).
 */
import type { Sql } from 'postgres';

/** The routine name (one per install_slug). */
export const CROSS_HIVE_DRAIN_ROUTINE_NAME = 'cross-hive-outbox-drain';
/** The routines target_role the drain ticks. */
export const CROSS_HIVE_DRAIN_TARGET_ROLE = 'system:cross-hive-outbox-drain';
/** Every 2 minutes at second :30 — a 6-field cron OFFSET from git-sync's :00 ticks. */
export const CROSS_HIVE_DRAIN_CRON = '30 */2 * * * *';

/** Sanitize the hive slug into a routines.id (mirrors the seed scripts). */
export function hiveCrossHiveDrainRoutineId(potSlug: string): string {
  return `rt_${potSlug}_cross_hive_outbox_drain`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
}

export interface ArmHiveCrossHiveDrainInput {
  sql: Sql;
  workspaceId: string;
  /** The hive's OWN home install_slug. */
  potSlug: string;
  /** Seed active (default true — the action self-gates to a no-op without peers). */
  active?: boolean;
}

export interface ArmHiveCrossHiveDrainResult {
  routineId: string;
  /** Removes the routine — joins pot:create's undo stack (best-effort, never throws). */
  undo: () => Promise<void>;
}

/**
 * Idempotent upsert of the per-hive cross-Hive outbox-drain routine. Safe to call
 * repeatedly (ON CONFLICT re-affirms trigger_config/target_role/active).
 */
export async function armHiveCrossHiveDrainRoutine(
  input: ArmHiveCrossHiveDrainInput,
): Promise<ArmHiveCrossHiveDrainResult> {
  const { sql, workspaceId, potSlug, active = true } = input;
  const routineId = hiveCrossHiveDrainRoutineId(potSlug);
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${routineId}, ${potSlug}, ${workspaceId}, ${CROSS_HIVE_DRAIN_ROUTINE_NAME}, 'cron',
            ${JSON.stringify({ cron: CROSS_HIVE_DRAIN_CRON })}::text::jsonb, ${CROSS_HIVE_DRAIN_TARGET_ROLE},
            ${JSON.stringify({})}::text::jsonb, 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_config = EXCLUDED.trigger_config,
      target_role = EXCLUDED.target_role,
      active = EXCLUDED.active,
      updated_at = now()`;

  const undo = async (): Promise<void> => {
    // A create-rollback must never throw.
    try {
      await sql`
        DELETE FROM harness_shared.routines
         WHERE workspace_id = ${workspaceId} AND install_slug = ${potSlug} AND name = ${CROSS_HIVE_DRAIN_ROUTINE_NAME}`;
    } catch {
      /* best-effort */
    }
  };

  return { routineId, undo };
}
