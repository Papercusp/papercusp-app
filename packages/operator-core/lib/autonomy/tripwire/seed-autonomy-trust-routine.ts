/**
 * Seed the autonomy trust-scan cadence routine — queen-autonomy-policy-2026-06-13
 * B-16 / P-080, P-081, P-082 (mirrors lib/graduation/seed-graduation-routine.ts).
 *
 *   - `autonomy-trust-scan` (daily): sweep armed tripwires (trip → revert +
 *     demote + notify / clear) and recount per-(category, class) clean passes →
 *     raise graduated_level within the ceiling + file owner graduation-eligible
 *     reports. SQL-only, no LLM spend; the action self-gates on
 *     `papercusp-queen-autonomy-armed` (P-092 owner gate, default OFF).
 *
 * SEEDED INACTIVE by default: the routine ships dark — even once armed, ACTIVATE
 * it (the routines admin or `--active`) for the trust loop to sweep. (The arming
 * function `armTripwireForDecision` still records tripwires whenever the Queen
 * auto-decides; this routine is what evaluates + graduates them.) Idempotent
 * (upsert); re-seeding PRESERVES an owner-tuned payload.
 *
 *   tsx lib/autonomy/tripwire/seed-autonomy-trust-routine.ts            # seed INACTIVE
 *   tsx lib/autonomy/tripwire/seed-autonomy-trust-routine.ts --active   # arm the cadence (P-092 flag still gates)
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';

const SLUG = process.env.AUTONOMY_TRUST_HARNESS ?? operatorHomeHarnessSlug(); // allow-scope-default: env-overridable operator-home routine install (no env ⇒ home hive, by design)
// Daily at 04:15 — OFFSET from the deploy rhythm (release-trigger :00/:15/:30/:45
// is minute-of-hour; this is HOUR 04, minute 15 — and from the other learning
// cadences: graduation 04:05, gym :10/:40, iq-battery/change-ledger :20,
// negative-space :25, neologism :35, EKG/calibration :50, the 03:35 nightly pair.
// Tripwire windows are ≥24h and graduation moves on a 14d decay window — daily is
// generous.
const ROUTINE = { name: 'autonomy-trust-scan', target: 'system:autonomy-trust-scan', cron: '0 15 4 * * *' };
// Owner-tunable knobs (threshold / recurrenceWindowDays / lookbackDays /
// maxReportsPerTick / mineOnly) live under payload_template directly.
const PAYLOAD: Record<string, unknown> = {};

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            ${JSON.stringify(PAYLOAD)}::text::jsonb,
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
    `[seed-autonomy-trust-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}). ` +
      (active
        ? 'LIVE cadence — but the action no-ops until papercusp-queen-autonomy-armed is ON (P-092) ' +
          'AND a category ceiling is lowered (until then nothing auto-decides, so no tripwires arm).'
        : 'Inactive — enable with --active or the routines admin as part of the autonomy go-live.'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-autonomy-trust-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
