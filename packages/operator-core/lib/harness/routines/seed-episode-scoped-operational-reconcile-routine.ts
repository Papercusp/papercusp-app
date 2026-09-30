/**
 * Seed the cross-harness episode-scoped operational auto-close backstop
 * (silent-intake-central-resolution-2026-09-01 P-009, audit R6).
 *
 * Every 15 minutes at :26, one durable single-flight tick reads the
 * green-checkpoint gate's CURRENT recorded verdict once, then auto-closes any
 * issue-family row whose typed (or title-pattern fallback) blocker names a
 * superseded historical gate episode — via the same `setIssueState(...,
 * { skipCompletionGate: true })` helper `legacy-needs-human-reconcile-action.ts`
 * and `harness/improvements/auto-close.ts` already use.
 *
 * Seeded ACTIVE by default — the 3 dead examples (WI-38439/WI-39939/WI-40150)
 * this closes are exactly the permanent-stale-noise class the audit flagged;
 * shipping this dark would leave that class open.
 *
 *   tsx seed-episode-scoped-operational-reconcile-routine.ts
 *   tsx seed-episode-scoped-operational-reconcile-routine.ts --inactive
 *   tsx seed-episode-scoped-operational-reconcile-routine.ts --cap 50
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP,
  EPISODE_SCOPED_OPERATIONAL_RECONCILE,
  episodeScopedOperationalReconcileCap,
} from './episode-scoped-operational-reconcile-action';

const SLUG = process.env.EPISODE_SCOPED_OPERATIONAL_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = EPISODE_SCOPED_OPERATIONAL_RECONCILE;
const TARGET_ROLE = `system:${NAME}`;
const CRON = '26 */15 * * * *';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const cap = episodeScopedOperationalReconcileCap(
    argValue('--cap') ?? DEFAULT_EPISODE_SCOPED_OPERATIONAL_RECONCILE_CAP,
  );
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
    `[seed-episode-scoped-operational-reconcile-routine] seeded "${NAME}" for "${SLUG}" ` +
      `(ws=${ws}, active=${active}, tier=durable, cron=${CRON}, cap=${cap}).`,
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      '[seed-episode-scoped-operational-reconcile-routine] FAILED:',
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
