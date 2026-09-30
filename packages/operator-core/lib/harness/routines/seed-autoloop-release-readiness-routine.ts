/**
 * Seed the `autoloop-release-readiness-monitor` routine (WI-5144, follow-up from
 * WI-4964 / plan rubric-system-and-auto-loop-release-profile-2026-07-15 P-011).
 *
 * One routine, `autoloop-release-readiness-monitor` → `system:autoloop-release-
 * readiness-monitor`, hourly at :15 (offset from telemetry-retention 04:00,
 * hive-canary 09:00, and cargo-test's :45 — the offset-scheduling convention this
 * file family follows). Each tick evaluates the public auto-loop release profile
 * (evaluateAutoloopReleaseProfile), records the verdict as a workspace fact, and —
 * only on go:true — emits the `release-pass:autoloop` awaited event.
 *
 * SEEDED INACTIVE by default: the read side is side-effect-free (facts:assert is
 * cheap + harmless), but the event it emits on go:true is a real, awaited signal
 * other automation may act on — arming that is an explicit, owner-confirmed step,
 * same posture as seed-telemetry-retention-routine.ts / seed-session-dir-gc-routine.ts.
 *
 *   tsx seed-autoloop-release-readiness-routine.ts             # seed INACTIVE
 *   tsx seed-autoloop-release-readiness-routine.ts --active    # seed + arm the hourly monitor
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.AUTOLOOP_RELEASE_READINESS_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Hourly at :15 — offset from telemetry-retention (04:00 daily), hive-canary
 *  (09:00 daily), and cargo-test (:45 hourly).
 *
 *  ⚠ DELIBERATELY NOT `GREEN_CHECKPOINT_CRON` (release/green-checkpoint-schedule.ts),
 *  which is the same string. This routine is `autoloop-release-readiness-monitor`, not
 *  the gate; it landed on :15 for its OWN reasons, listed above. Wiring it to the gate's
 *  constant would mean retuning the gate's schedule silently moved an unrelated monitor —
 *  the collision that made WI-39841 expensive, inverted. If the gate's cron moves, this
 *  one stays put unless the reasons above say otherwise. */
const CRON = '0 15 * * * *';

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'autoloop-release-readiness-monitor';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron',
            ${JSON.stringify({ cron: CRON })}::text::jsonb, 'system:autoloop-release-readiness-monitor',
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-autoloop-release-readiness-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `hourly autoloop release-profile evaluation. ` +
      (active ? 'Cadence LIVE.' : 'Inactive — enable with --active or the routines admin.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-autoloop-release-readiness-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
