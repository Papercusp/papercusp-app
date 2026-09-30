/**
 * Seed the `frozen-candidate-drift-sweep` routine — the 900s cadence for
 * frozen-candidate-compliance-enforcement-2026-08-30 P-008's ATTESTATION leg
 * (handler in `frozen-candidate-drift-sweep-action.ts`, pure detection in
 * `../../release/frozen-candidate-drift-sweep.ts`).
 *
 * WHY THIS FILE EXISTS AT ALL — REGISTERED IS NOT SCHEDULED. The action was
 * registered (`register-system-actions.ts` imports it) and guarded by a good
 * registration test (`release-actions.test.ts:999`, with a positive control and a
 * PROBE_REGISTRAR_PATH override), and it still never ran once: a whole-tree search for
 * `frozen-candidate-drift-sweep` outside the action module, the registrar and the tests
 * returned zero hits — no `triggers.schedule`, no interval, and no
 * `harness_shared.routines` row with target_role `system:frozen-candidate-drift-sweep`
 * (absence confirmed against a passing positive control that DID return the
 * dream-cycle-manual / `system:dream-cycle` pair). Independent acceptance grading of that
 * plan rated this criterion DEGRADED for exactly that reason: the criterion's outcome is
 * "runs on its own", the registration guard is one hop too shallow to see the missing
 * schedule, and every OTHER item in the plan prevents the failure while this is the only
 * one that says whether prevention worked. A prevention plan whose attestation leg never
 * ticks cannot report its own success.
 *
 * A bespoke `tier:'ephemeral'` seed (interval_sec, NO cron, `next_fire_at = NULL`) rather
 * than a per-install blueprint `triggers.schedule` entry, mirroring
 * `seed-consult-expiry-routine.ts`: the frozen repair queue is a release-gate substrate
 * concern with ONE marker per host, so one bounded sweep serves the box — it is not a
 * per-blueprint-install cadence. Ephemeral rows are armed by the per-host ephemeral
 * executor (`../../dbos/ephemeral-executor.ts`) on boot, NOT a bare `setInterval`
 * (`lint:no-raw-setinterval`).
 *
 * 900s cadence, chosen against the GATE's clock rather than a round number:
 * green-checkpoint runs hourly, and the drift this detects (a fix committed onto
 * `staging` above the frozen candidate, which the judged sha therefore cannot contain) is
 * only actionable BEFORE the next run re-judges that candidate and re-fails on a bug that
 * is already fixed at tip. Four samples per gate cycle put the finding in front of the
 * author well inside the window where converging it still helps. Faster buys nothing —
 * the freeze persists across runs, so the signal does not decay in seconds; slower risks
 * reporting drift only after the run it would have explained.
 *
 * COSTS NOTHING IN THE COMMON CASE. The action returns on a missing frozen-repair marker
 * before touching git or PG, so an unfrozen box pays one failed file read per tick. When
 * frozen it is one bounded `git log` and a report-only `captureImprovement` whose failure
 * is deliberately swallowed. It is silent when nothing is frozen, when git cannot be read,
 * and when the failing set is empty — it never reports a zero it did not measure.
 *
 * SEEDED ACTIVE by default: it is read-only with respect to the queue and the gate (it
 * files a finding and nothing else), it holds no owner-authority surface, and "finished
 * work never ships dark" (root CLAUDE.md). Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-frozen-candidate-drift-sweep-routine.ts              # seed ACTIVE (default)
 *   tsx seed-frozen-candidate-drift-sweep-routine.ts --inactive   # seed dark
 *
 * Registered in `BESPOKE_ACTIVE_SEEDS` (bespoke-active-seeds-check.ts) in the SAME change
 * that landed this file — that registry is what makes "the seed script nobody ever ran"
 * detectable, and it is the precise failure this routine was already an instance of.
 *
 * Idempotent (upsert on (install_slug, name), same key discipline as every routine in this
 * dir). A re-run does NOT live-arm a host that's already running (restart papercup-bg-host
 * to pick up a freshly-seeded row live).
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.FROZEN_CANDIDATE_DRIFT_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const NAME = 'frozen-candidate-drift-sweep';
const TARGET_ROLE = 'system:frozen-candidate-drift-sweep';
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
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id   = EXCLUDED.workspace_id,
      updated_at     = now()
  `;
  console.log(
    `[seed-frozen-candidate-drift-sweep-routine] seeded "${NAME}" for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `tier=ephemeral, interval=${DEFAULT_INTERVAL_SEC}s) — frozen-candidate drift attestation cadence. ` +
      (active
        ? 'Cadence seeded ACTIVE — restart papercup-bg-host to live-arm on a host that was already up.'
        : 'Inactive — enable via the routines admin or re-run without --inactive.'),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-frozen-candidate-drift-sweep-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
