/**
 * Seed the `telemetry-retention` routine — the periodic janitor for the unbounded
 * high-volume diagnostic tables (`route_invocations`, `tool_invocations`, …) the
 * 2026-06-18 infra audit found growing without bound (R2; handler in
 * `telemetry-retention-action.ts`, prune logic in `storage/prune.ts`).
 *
 *   - `telemetry-retention` (daily 04:00): prune the canonical five retention
 *     targets via the shared storage prune (chunked + VACUUM), then trim any
 *     npm/bun/pnpm cache above its high-water mark. Pure local maintenance —
 *     spawns no agent and makes no network call.
 *
 * SEEDED INACTIVE by default (mirrors seed-session-dir-gc-routine). Bring-up is
 * human-confirmed; idempotent (upsert). After deploy:
 *
 *   tsx seed-telemetry-retention-routine.ts             # seed INACTIVE
 *   tsx seed-telemetry-retention-routine.ts --active     # seed + enable the daily prune
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - targets   — [{ category, retention_days }]; MUST be kept in sync with
 *                 `DEFAULT_RETENTION_TARGETS` (telemetry-retention-action.ts) —
 *                 `resolveTargets()` prefers this STORED array whenever it's
 *                 non-empty, so a code-only default change has ZERO effect on
 *                 any existing install until this seed is re-run. The array is
 *                 generated from the same canonical defaults used by the action
 *                 so the two directions cannot drift silently.
 *   - dry_run   — plan + log, delete nothing.
 *   - package_cache_enabled   — default true; false disables cache cleanup.
 *   - package_cache_max_bytes — per-cache high-water mark; default 8 GiB.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { DEFAULT_RETENTION_TARGETS } from './telemetry-retention-targets';
import { DEFAULT_PACKAGE_CACHE_MAX_BYTES } from '../../storage/package-cache-retention';

const SLUG = process.env.TELEMETRY_RETENTION_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 04:00 — off the busy hours; off-set from session-dir-gc (04:30). */
const CRON = '0 0 4 * * *';

/** Build the persisted config from the same defaults the runtime action uses. */
export function buildTelemetryRetentionTriggerConfig(): {
  cron: string;
  targets: Array<{ category: string; retention_days: number }>;
  package_cache_enabled: boolean;
  package_cache_max_bytes: number;
} {
  return {
    cron: CRON,
    targets: DEFAULT_RETENTION_TARGETS.map((target) => ({ ...target })),
    package_cache_enabled: true,
    package_cache_max_bytes: DEFAULT_PACKAGE_CACHE_MAX_BYTES,
  };
}

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'telemetry-retention';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = buildTelemetryRetentionTriggerConfig();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:telemetry-retention', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-telemetry-retention-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily prune of ${triggerConfig.targets.length} canonical retention targets plus ` +
      `package caches above ${triggerConfig.package_cache_max_bytes} bytes. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[seed-telemetry-retention-routine] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
