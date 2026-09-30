/**
 * Seed the release-gating routines — plan release-gate-ready-branch-2026-06-04;
 * staging→main AUTO-SERVE posture since staging-branch-pipeline-2026-06-06.
 *
 *   - `green-checkpoint` (hourly): advance the green pin — the **`main` branch**
 *     — to the latest green `staging` commit (FF-only + a broadcast). ACTIVE by
 *     default. Hourly (not every 10 min) respects the shared box; tune the cron
 *     here if fresher mains are wanted.
 *   - `release-trigger` (every 15 min): when green `main` is ahead of the
 *     running release checkout, run the SCRIPTED `deploy-cli --execute` (drain →
 *     swap → migrate → restart → health-check, auto-rollback). ACTIVE by default
 *     — the auto-serve decision (D-002): the green gate IS the go/no-go; no
 *     human/agent in the routine loop.
 *
 * The per-routine defaults above ARE the decided posture. `--active` forces both
 * on; `--inactive` forces both off (reverting to deliberate deploys). Idempotent
 * (upsert).
 *
 *   tsx seed-release-routines.ts             # seed the decided posture
 *   tsx seed-release-routines.ts --active    # force both ON
 *   tsx seed-release-routines.ts --inactive  # force both OFF
 *   tsx seed-release-routines.ts --only nightly-release-cut # seed one routine without touching gate rows
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '@papercusp/operator-core/lib/workspace-registry';
import { operatorHomeHarnessSlug } from '@papercusp/operator-core/lib/harness/operator-home-harness';
import { greenCheckpointCronForInstall } from '@papercusp/operator-core/lib/release/green-checkpoint-schedule';

const SLUG = process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const ROUTINES = [
  // Hourly at :15 — offset from git-sync's every-10-min ticks. The gate's run budget is
  // phased against this period (WI-39841), so the cron is imported, never re-typed.
  { name: 'green-checkpoint', target: 'system:green-checkpoint', cron: greenCheckpointCronForInstall(SLUG), activeDefault: true },
  // ACTIVE: auto-serve (staging-branch-pipeline-2026-06-06 D-002).
  { name: 'release-trigger', target: 'system:release-trigger', cron: '0 */15 * * * *', activeDefault: true },
  // Daily at 03:00 local. The action itself requires PAPERCUSP_NIGHTLY_RELEASE_ROOT
  // (a dedicated checkout) and PAPERCUSP_RELEASE_OWNER_NAME; absent either it logs a
  // fail-soft skip rather than mutating the canonical or live release trees.
  {
    name: 'nightly-release-cut',
    target: 'system:nightly-release-cut',
    cron: '0 0 3 * * *',
    activeDefault: true,
    triggerConfig: {
      cron: '0 0 3 * * *',
      channel: 'nightly',
      platform: 'linux',
      roles: 'gui',
    },
  },
] as const;

async function main(): Promise<void> {
  const forceActive = process.argv.includes('--active');
  const forceInactive = process.argv.includes('--inactive');
  // Narrow repair path for a missing bespoke routine. This must not require
  // re-seeding the LIVE_GATE_OPS rows (green-checkpoint / release-trigger),
  // whose runtime state is owned by the gate operator.
  const onlyIndex = process.argv.findIndex((arg) => arg === '--only' || arg.startsWith('--only='));
  const only = onlyIndex < 0
    ? undefined
    : process.argv[onlyIndex].startsWith('--only=')
      ? process.argv[onlyIndex].slice('--only='.length)
      : process.argv[onlyIndex + 1];
  if (only !== undefined && !ROUTINES.some((r) => r.name === only)) {
    throw new Error(`unknown routine for --only: ${only}`);
  }
  const routines = only ? ROUTINES.filter((r) => r.name === only) : ROUTINES;
  const ws = activeWorkspaceId();
  // Admin connection (bypasses RLS) + explicit workspace_id — this is operator
  // infra config, the same path migrations/cross-workspace tooling use. We set
  // workspace_id ourselves rather than depending on the fill-trigger.
  const { sql } = getOrgPg();
  const states: string[] = [];
  for (const r of routines) {
    const active = forceActive ? true : forceInactive ? false : r.activeDefault;
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    // WI-5018 routines grouping: seed group_slug='release' + auto-create the group row
    // (blank metadata; a steward fills it in via routines:group-set) so a FRESH seed
    // lands pre-grouped. group_slug is deliberately NOT in the ON CONFLICT SET list — a
    // re-seed must never clobber a manual routines:set{group} reassignment.
    const triggerConfig = 'triggerConfig' in r && r.triggerConfig ? r.triggerConfig : { cron: r.cron };
    await sql`
      INSERT INTO harness_shared.routine_groups (workspace_id, slug)
      VALUES (${ws}, 'release')
      ON CONFLICT (workspace_id, slug) DO NOTHING
    `;
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at, group_slug)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${active}, now(), 'release')
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        active = EXCLUDED.active,
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
    states.push(`${r.name}=${active ? 'ACTIVE' : 'inactive'}`);
  }
  console.log(
    `[seed-release-routines] seeded for "${SLUG}" (ws=${ws}): ${states.join(', ')}. ` +
      'Defaults encode the AUTO-SERVE posture (green-checkpoint FFs green `main` from `staging`; release-trigger auto-deploys it to the release checkout).',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-release-routines] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
