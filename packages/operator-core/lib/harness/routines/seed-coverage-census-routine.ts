/**
 * Seed the `coverage-census` routine — the testable-surface census cadence
 * (deterministic-coverage-census-2026-08-17 P-002; handler in `coverage-census-action.ts`,
 * logic in `@papercusp/testing-shell/census`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather than a
 * per-install blueprint `triggers.schedule` entry — the census sweeps the operator HOME harness's
 * own code registries, which is a host-level concern, mirroring `seed-supervision-reconcile-
 * routine.ts` and `hive-git-gc-routine.ts`'s documented reasoning for the same deviation.
 * Ephemeral rows are armed by the per-host ephemeral executor — NOT a bare `setInterval`
 * (`lint:no-raw-setinterval`).
 *
 * WHY 15 MINUTES. The census reads code registries, not traffic, so it only changes when code
 * changes. Its consumers are the green-checkpoint new-surface guard and the gap queue, both of
 * which act on a scale of minutes-to-hours, and the reverse map (changed files -> surfaces) is
 * read per-plan rather than per-request. A tighter cadence would re-derive an identical census
 * dozens of times an hour for nothing.
 *
 * SEEDED ACTIVE by default. "Finished work never ships dark" (root CLAUDE.md) applies to the
 * cadence itself. It is safe-by-construction before P-003 lands any providers: with no provider
 * reporting success, no kind is retirable, so the run cannot retire anything — and its handler
 * IS registered (register-system-actions.ts), so this is a real no-op run, not the silent
 * skip-every-fire state a routine gets when its `system:` action is missing
 * (EI-18741229858124453). Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-coverage-census-routine.ts              # seed ACTIVE (default)
 *   tsx seed-coverage-census-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this dir).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.COVERAGE_CENSUS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'coverage-census';
const TARGET_ROLE = 'system:coverage-census';
const DEFAULT_INTERVAL_SEC = 900;

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = JSON.stringify({ interval_sec: DEFAULT_INTERVAL_SEC });
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at, workspace_id)
    VALUES (
      ${id}, ${SLUG}, ${NAME}, 'cron',
      ${triggerConfig}::text::jsonb, ${TARGET_ROLE},
      'skip', 'skip-old', ${active}, 'ephemeral', NULL, ${ws}
    )
    ON CONFLICT (install_slug, name) DO UPDATE SET
      trigger_kind   = EXCLUDED.trigger_kind,
      trigger_config = EXCLUDED.trigger_config,
      target_role    = EXCLUDED.target_role,
      tier           = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a re-seed must
      -- never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-coverage-census-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — testable-surface census cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
        : 'Cadence seeded DARK — flip active to arm it.'),
  );
  await sql.end({ timeout: 5 });
}

void main().catch((err) => {
  console.error('[seed-coverage-census-routine] failed:', err);
  process.exitCode = 1;
});
