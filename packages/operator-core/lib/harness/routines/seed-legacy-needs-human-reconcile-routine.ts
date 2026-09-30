/**
 * Seed the cross-harness legacy `payload.needsHuman` reconciliation backstop
 * (autonomous-inbox-resolution-2026-08-31 P-004).
 *
 * Every 15 minutes at :11, one durable single-flight tick removes at most `cap`
 * stale presentation markers after re-checking the row's live lifecycle and typed
 * blocker state. It is payload-only, cross-harness within the workspace, makes no
 * model call, and leaves every real owner/capability gate intact.
 *
 * Seeded ACTIVE by default. This is the recurring guard that migration 1020 could
 * not provide; shipping it dark would leave replay/federation residue permanent.
 *
 *   tsx seed-legacy-needs-human-reconcile-routine.ts
 *   tsx seed-legacy-needs-human-reconcile-routine.ts --inactive
 *   tsx seed-legacy-needs-human-reconcile-routine.ts --cap 50
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP,
  LEGACY_NEEDS_HUMAN_RECONCILE,
  legacyNeedsHumanReconcileCap,
} from './legacy-needs-human-reconcile-action';

const SLUG = process.env.LEGACY_NEEDS_HUMAN_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = LEGACY_NEEDS_HUMAN_RECONCILE;
const TARGET_ROLE = `system:${NAME}`;
const CRON = '11 */15 * * * *';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const cap = legacyNeedsHumanReconcileCap(argValue('--cap') ?? DEFAULT_LEGACY_NEEDS_HUMAN_RECONCILE_CAP);
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON, cap };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${NAME}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            ${TARGET_ROLE}, 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict: a re-seed must never
      -- clobber an operator's runtime pause/resume.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-legacy-needs-human-reconcile-routine] seeded "${NAME}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${cap}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-legacy-needs-human-reconcile-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
