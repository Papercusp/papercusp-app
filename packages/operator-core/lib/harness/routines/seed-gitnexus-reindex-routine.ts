/**
 * Seed the `gitnexus-reindex` routine (WI-6454) — `system:gitnexus-reindex` →
 * `gitnexus-reindex-action.ts`, the refresh owner for the gitnexus code graph that
 * `gitnexus.context` / `gitnexus.query` answer from.
 *
 * Hourly at :35 — clear of green-checkpoint (:15), cargo-test (:45) and the :00/:05
 * cluster, so a ~4-minute indexer never starts in the same tick minute as the gate.
 *
 * The hourly fire is only a CHECK. The action reads the registry, git and loadavg
 * (all cheap) and re-indexes only when the graph is genuinely behind, the box is not
 * oversubscribed, and the interval floor has passed — `analyze` is a full re-index
 * (234s even against a fresh index), so an unconditional hourly run would be
 * unaffordable. Tunables live in trigger_config: `min_commits_behind`,
 * `max_load_per_core`, `min_interval_sec`, `timeout_ms`, `repo_name`.
 *
 * Seeded ACTIVE by default: the action is read-only w.r.t. tracked source (it writes
 * only the gitignored `.gitnexus/` index, and `--skip-agents-md` keeps it off CLAUDE.md
 * / AGENTS.md), it self-gates to the operator-home installSlug, and it is load- and
 * staleness-gated — so an active routine is safe from the moment it exists. Finished
 * work never ships dark (CLAUDE.md). `--inactive` seeds it off for an explicit dark launch.
 *
 *   tsx seed-gitnexus-reindex-routine.ts             # seed ACTIVE
 *   tsx seed-gitnexus-reindex-routine.ts --inactive  # seed off
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import {
  GITNEXUS_REPO_NAME,
  DEFAULT_MIN_COMMITS_BEHIND,
  DEFAULT_MAX_LOAD_PER_CORE,
  DEFAULT_MIN_INTERVAL_SEC,
} from './gitnexus-reindex-action';

const SLUG = process.env.GITNEXUS_REINDEX_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :35 — offset from green-checkpoint (:15) and cargo-test (:45). */
const CRON = '0 35 * * * *';

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'gitnexus-reindex';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    repo_name: GITNEXUS_REPO_NAME,
    min_commits_behind: DEFAULT_MIN_COMMITS_BEHIND,
    max_load_per_core: DEFAULT_MAX_LOAD_PER_CORE,
    min_interval_sec: DEFAULT_MIN_INTERVAL_SEC,
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, tier, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:gitnexus-reindex', 'skip', 'skip-old', ${active}, 'durable', now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      tier = EXCLUDED.tier,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-gitnexus-reindex-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly (:35) staleness/load-gated gitnexus re-index of the "${GITNEXUS_REPO_NAME}" graph. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gitnexus-reindex-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
