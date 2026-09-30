/**
 * Seed the p2p-perf bench routines — p2p-performance-suite-2026-06-07 P-014.
 *
 *   - `p2p-perf-tier1` (NIGHTLY 02:30): the Tier-1 loopback bench matrix
 *     (ci profile) vs the committed baseline. ACTIVE by default — owner
 *     ratified the cadence with the plan; the run is local, advisory (D-005),
 *     and findings auto-file to the improvements backlog.
 *   - `p2p-perf-tier2` (WEEKLY Sunday 03:30): the netem WAN matrix. ACTIVE by
 *     default; skips cleanly on hosts without unprivileged userns.
 *
 * Tier 3 (real Latitude/Hetzner frames) is DELIBERATELY not seeded — D-004:
 * on-demand only, no cron until the owner says so.
 *
 *   npx tsx packages/operator-core/lib/harness/routines/seed-p2p-perf-routines.ts
 *   npx tsx … --inactive   # seed but leave off
 *
 * Idempotent (upsert on (install_slug, name)).
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.P2P_PERF_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
const ROUTINES = [
  // Nightly 02:30 local — clear of the hourly green-checkpoint (:15) and the
  // daily GC jobs (03:00/04:00 UTC), so bench numbers aren't polluted by
  // concurrent suite runs on the shared box.
  { name: 'p2p-perf-tier1', target: 'system:p2p-perf-tier1', cron: '0 30 2 * * *' },
  // Weekly, Sunday 03:30 local.
  { name: 'p2p-perf-tier2', target: 'system:p2p-perf-tier2', cron: '0 30 3 * * 0' },
] as const;

async function main(): Promise<void> {
  // WI-2141683: both rows are always active by default (owner-ratified — see the file
  // header). Standardized to the same single `const active = ...` idiom every other
  // always-on bespoke seed script uses (e.g. seed-gc-dead-loops-routine.ts), so
  // bespoke-active-seeds-check.test.ts's ACTIVE_BY_DEFAULT regex can classify this file
  // automatically instead of needing a hand-maintained EXEMPT_SEED_SCRIPTS entry. Both rows
  // share one flag rather than a per-row `activeDefault` — behavior-preserving today since
  // both were already `activeDefault: true`. The previously-undocumented `--active` flag
  // (redundant with the default; never referenced elsewhere in the repo) is dropped along
  // with it.
  const active = !process.argv.includes('--inactive');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const states: string[] = [];
  for (const r of ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${active}, now())
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
        -- re-seed must never clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        updated_at = now()
    `;
    states.push(`${r.name}=${active ? 'ACTIVE' : 'inactive'}`);
  }
  console.log(
    `[seed-p2p-perf-routines] seeded for "${SLUG}" (ws=${ws}): ${states.join(', ')}. ` +
      'Nightly Tier-1 + weekly Tier-2, advisory (D-005); Tier 3 stays on-demand (D-004).',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-p2p-perf-routines] failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
