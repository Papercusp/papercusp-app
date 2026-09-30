/**
 * Deploy-migration policy (live-configurability-audit-2026-06-20 P-003).
 *
 * The deploy-time migration runner (apps/operator/lib/release/migrate.ts) opens its dedicated
 * client with a `lock_timeout` — a hardcoded 15s, the exact value implicated in TWO multi-hour
 * deploy outages (too-long wedged a table behind a queued ACCESS EXCLUSIVE; too-short tripped the
 * deploy). This module makes that knob (+ an optional statement_timeout) runtime-settable via the
 * db:migrate-policy tool, stored in the `operator_migrate_policy` operator-state row (migration
 * 337) and read FAIL-SAFE by the runner (defaults on any read error — the table may not exist yet
 * on a fresh DB / in the CLI path).
 *
 * NOTE the keep-hardcoded boundary (plan D-002): the BOOT migration lock_timeout runs before any
 * config tool can read PG, so it stays an env/code default — this concern governs the DEPLOY
 * runner only.
 *
 * Registers as a runtime-config override concern so config:list-overrides / config:reset-overrides
 * surface + revert it.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';

export interface MigratePolicy {
  /** DDL lock_timeout in ms for the deploy-migration client. */
  lockTimeoutMs: number;
  /** Optional statement_timeout in ms (null = unset — the current behavior). */
  statementTimeoutMs: number | null;
}

export const MIGRATE_POLICY_DEFAULTS: MigratePolicy = { lockTimeoutMs: 15_000, statementTimeoutMs: null };

/** Effective policy = stored override merged over baked defaults. */
export async function readMigratePolicy(): Promise<MigratePolicy> {
  const stored = await readOperatorState<Partial<MigratePolicy>>('operator_migrate_policy');
  return { ...MIGRATE_POLICY_DEFAULTS, ...(stored ?? {}) };
}

/** Merge a patch over the current policy and persist it; returns the new effective policy. */
export async function writeMigratePolicy(patch: Partial<MigratePolicy>): Promise<MigratePolicy> {
  const next = { ...(await readMigratePolicy()), ...patch };
  await writeOperatorState<MigratePolicy>('operator_migrate_policy', next);
  return next;
}

/** Reset to baked defaults (clears the override). */
export async function resetMigratePolicy(): Promise<MigratePolicy> {
  await writeOperatorState<MigratePolicy>('operator_migrate_policy', MIGRATE_POLICY_DEFAULTS);
  return MIGRATE_POLICY_DEFAULTS;
}

// Self-register as a runtime-config override concern (P-024 registry) at module load.
registerOverrideConcern({
  name: 'migrate-policy',
  description: 'deploy-migration lock_timeout / statement_timeout (operator_migrate_policy)',
  auditAction: 'db:migrate-policy',
  diff: async () => {
    const pol = await readMigratePolicy();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(MIGRATE_POLICY_DEFAULTS) as (keyof MigratePolicy)[]) {
      if (pol[k] !== MIGRATE_POLICY_DEFAULTS[k]) {
        entries.push({ key: k, effective: pol[k], default: MIGRATE_POLICY_DEFAULTS[k], layer: 'pg-settings' });
      }
    }
    return entries;
  },
  capture: () => readMigratePolicy(),
  reset: () => resetMigratePolicy(),
  restore: (snap) => writeMigratePolicy(snap as MigratePolicy).then(() => {}),
});
