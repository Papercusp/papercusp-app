/**
 * Seed the `acceptance-grading-sweep` routine — the acceptance-grading stall
 * sweep's 600s cadence (acceptance-grading-stall-sweep-2026-08-26 P-004; handler in
 * `acceptance-grading-sweep-action.ts`, orchestration in
 * `../../acceptance-grading-sweep-run.ts`, decision core in
 * `../../acceptance-grading-sweep.ts`).
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`)
 * rather than a per-install blueprint `triggers.schedule` entry — the sweep is an
 * operator-HOME-level substrate concern (ONE bounded sweep serves every workspace's
 * plans), not a per-blueprint-install cadence, mirroring
 * `seed-consult-expiry-routine.ts`'s documented reasoning. Ephemeral rows are armed
 * by the per-host ephemeral executor (`../../dbos/ephemeral-executor.ts`) on boot —
 * NOT a bare `setInterval` (`lint:no-raw-setinterval`).
 *
 * 600s cadence: the decision core's own thresholds are 2h (re-dispatch) and 12h
 * (escalate), so a 10-minute sweep bounds detection overshoot at ~8% of the shortest
 * contract. The cadence is deliberately far below both thresholds so that sweep
 * TIMING can never be the thing that decides an outcome — the thresholds decide, and
 * the sweep merely observes often enough not to matter.
 *
 * SEEDED ACTIVE by default: the sweep is bounded on both axes (a scan cap and an
 * action cap per tick), it can only re-dispatch an idempotent grader resolve or mint
 * one condition-keyed work-item, and "finished work never ships dark" (root
 * CLAUDE.md). It cannot grade, score, record a verdict or alter a refusal code —
 * those capabilities are absent from its dependency interface, not merely unused.
 * Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-acceptance-grading-sweep-routine.ts              # seed ACTIVE (default)
 *   tsx seed-acceptance-grading-sweep-routine.ts --inactive   # seed dark
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine
 * in this dir). A re-run does NOT live-arm a host that's already running (restart
 * papercup-bg-host to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.ACCEPTANCE_GRADING_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'acceptance-grading-sweep';
const TARGET_ROLE = 'system:acceptance-grading-sweep';
const DEFAULT_INTERVAL_SEC = 600;

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
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-acceptance-grading-sweep-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — acceptance-grading stall sweep cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercusp-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(
      '[seed-acceptance-grading-sweep-routine] FAILED:',
      e instanceof Error ? e.message : e,
    );
    process.exit(1);
  });
