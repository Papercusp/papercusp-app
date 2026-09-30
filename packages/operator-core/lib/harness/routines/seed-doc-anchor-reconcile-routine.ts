/**
 * Seed the `doc-anchor-reconcile` routine — the periodic FULL doc-anchor reconcile
 * (#5 PART B; design + impl in `docs/sweep-after-sync.ts` → `reconcileAllDocAnchors`,
 * handler in `doc-anchor-reconcile-action.ts`).
 *
 *   - `doc-anchor-reconcile` (daily 05:00): re-derive anchors from CURRENT frontmatter
 *     for ALL anchor-derived (manual/augmented) docs of this harness and rewrite the
 *     denormalised anchor cache where it drifted — the safety net for the git-sync
 *     re-anchor-on-change path (a stale cache that slipped past it). Pure DB/git
 *     maintenance — spawns no agent, makes no LLM call; idempotent (a clean cache is
 *     a no-op). Off-set from telemetry-retention (04:00) + session-dir-gc (04:30).
 *
 * SEEDED INACTIVE by default (mirrors seed-session-dir-gc-routine / seed-telemetry-retention-routine).
 * Bring-up is human-confirmed; idempotent (upsert).
 *
 *   tsx seed-doc-anchor-reconcile-routine.ts             # seed INACTIVE
 *   tsx seed-doc-anchor-reconcile-routine.ts --active     # seed + enable the daily reconcile
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.DOC_ANCHOR_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Daily at 05:00 — off the busy hours; off-set from telemetry-retention (04:00) + session-dir-gc (04:30). */
const CRON = '0 0 5 * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'doc-anchor-reconcile';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:doc-anchor-reconcile', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-doc-anchor-reconcile-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `daily full re-derive of doc anchors from current frontmatter (the re-anchor-on-change safety net). ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-doc-anchor-reconcile-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
