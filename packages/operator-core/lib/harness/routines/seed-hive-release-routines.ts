/**
 * seed-hive-release-routines — seed the per-hive staging→main release routines for a
 * repo-backed CODING hive (per-hive-git-and-release-gate-2026-06-29 P-009, D-008).
 *
 * The operator-home (papercusp) release routines are seeded by the standalone
 * apps/operator/lib/release/seed-release-routines.ts singleton; THIS seeds the SAME
 * `system:green-checkpoint` (+ `system:release-trigger` when a deploy target is declared)
 * for OTHER repo-backed coding hives, keyed on their own install_slug.
 *
 * FLAG-GATED (PER_POT_RELEASE_GATE, default-OFF, D-008) + best-effort. With the flag off
 * this is a no-op, so the live :3070 papercusp pipeline is untouched during rollout. The
 * operator-home slug is explicitly skipped (never double-seed it). Idempotent upsert keyed
 * on (install_slug, name) — the same shape seed-release-routines.ts uses. Returns an undo
 * (so a hive-create rollback removes the rows it added).
 */
import type postgres from 'postgres';
import { greenCheckpointCronForInstall } from '../../release/green-checkpoint-schedule';
import { resolveHiveReleaseEnv } from './hive-release-env';

export interface SeedHiveReleaseResult {
  seeded: boolean;
  /** Why nothing was seeded (flag_off | operator_home | not_found | no_blueprint |
   *  gate_disabled | no_repo). */
  reason?: string;
  /** Names of the routines seeded (green-checkpoint, [release-trigger]). */
  routines?: string[];
  /** Remove the rows this call added (no-op when nothing was seeded). */
  undo: () => Promise<void>;
}

const NOOP_UNDO = async () => {};

/** The per-hive routine set. green-checkpoint always; release-trigger only when the hive
 *  declares a deploy target (leg 3). Crons match the operator-home defaults. */
const RELEASE_TRIGGER = { name: 'release-trigger', target: 'system:release-trigger', cron: '0 */15 * * * *' } as const;

export async function seedHiveReleaseRoutines(opts: {
  sql: postgres.Sql;
  workspaceId: string;
  potSlug: string;
  /** Seed ACTIVE (default true — the gate is the point). Pass false to lay rows down inert. */
  active?: boolean;
}): Promise<SeedHiveReleaseResult> {
  const [{ getFlag }, { FLAGS }] = await Promise.all([
    import('@papercusp/flags/server'),
    import('@papercusp/flags'),
  ]);
  if (!(await getFlag(FLAGS.PER_POT_RELEASE_GATE, 'system'))) {
    return { seeded: false, reason: 'flag_off', undo: NOOP_UNDO };
  }

  const env = await resolveHiveReleaseEnv(opts.potSlug, opts.workspaceId);
  // The operator-home pipeline is owned by seed-release-routines.ts — never double-seed it.
  if (env.isOperatorHome) return { seeded: false, reason: 'operator_home', undo: NOOP_UNDO };
  if (!env.enabled) return { seeded: false, reason: env.reason ?? 'gate_disabled', undo: NOOP_UNDO };

  const active = opts.active ?? true;
  const greenCheckpoint = {
    name: 'green-checkpoint',
    target: 'system:green-checkpoint',
    cron: greenCheckpointCronForInstall(opts.potSlug),
  } as const;
  const routines = env.hasDeploy ? [greenCheckpoint, RELEASE_TRIGGER] : [greenCheckpoint];
  const seededNames: string[] = [];
  for (const r of routines) {
    const id = `rt_${opts.potSlug}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await opts.sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${opts.potSlug}, ${opts.workspaceId}, ${r.name}, 'cron',
              ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${active}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
        -- re-seed must never clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
    seededNames.push(r.name);
  }

  const undo = async () => {
    for (const r of routines) {
      try {
        await opts.sql`DELETE FROM harness_shared.routines WHERE install_slug = ${opts.potSlug} AND name = ${r.name}`;
      } catch {
        /* best-effort rollback */
      }
    }
  };
  return { seeded: true, routines: seededNames, undo };
}
