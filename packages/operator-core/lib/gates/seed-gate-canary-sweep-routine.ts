/**
 * Seed the `gate-canary-sweep` routine (WI-5977; handler in
 * gate-canary-sweep-action.ts): periodically runs a KNOWN-GOOD sample through
 * the federation-probe apparatus for ONE harness and reports whether the
 * apparatus itself is trustworthy (see the action's file header for the full
 * design + scope).
 *
 * UNLIKE most seed-*-routine.ts scripts in this directory, this one takes a
 * REQUIRED `--harness=<slug>` — there is no safe default target. Reuse-first
 * check before writing this file (2026-07-26): the harness_registry has no
 * production harness self-registered as a federated hive today (only
 * throwaway test fixtures like `hello-world-hive`/`spoon-knife-hive`), so
 * guessing one here would either be inert forever or (worse) silently
 * canary-check the wrong target. The action itself is defensive either way
 * (a non-federated target reads as 'unknown'/alarm:'none', never a false
 * 'gate-broken' — see the EI-11574 precedent it follows), but the SEED still
 * refuses to guess, per this work-item's own "never manufacture a confident
 * default" thesis.
 *
 * SEEDED INACTIVE regardless of --active (same discipline as every other
 * routine here): the routines engine that fires system actions runs on the
 * GREEN `:3070` operator, which won't know `gate-canary-sweep` until the
 * staging→main deploy carries it. Bring-up after the deploy AND once a real
 * federated harness slug is named:
 *   tsx seed-gate-canary-sweep-routine.ts --harness=<slug> --active
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

const ROUTINE_NAME = 'gate-canary-sweep';
/** Federation-probe apparatus checks are cheap + rare-signal; hourly is ample
 *  (mirrors autonomy-trust-scan's cadence class, not the every-2-min gate-watcher). */
const CRON = '0 0 * * * *';

function harnessArg(): string | null {
  const flag = process.argv.find((a) => a.startsWith('--harness='));
  return flag ? flag.slice('--harness='.length).trim() || null : null;
}

async function main(): Promise<void> {
  const slug = harnessArg();
  if (!slug) {
    console.error(
      '[seed-gate-canary-sweep] --harness=<slug> is required (a real federated hive slug) — refusing to guess one. ' +
        'See this file\'s header for why.',
    );
    process.exit(1);
    return;
  }
  const requestedActive = process.argv.includes('--active');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${slug}_${ROUTINE_NAME}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = { cron: CRON };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${slug}, ${ws}, ${ROUTINE_NAME}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            ${`system:${ROUTINE_NAME}`}, 'skip', 'skip-old', false, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(`[seed-gate-canary-sweep] seeded "${ROUTINE_NAME}" for "${slug}" (ws=${ws}, cron="${CRON}") — INACTIVE`);
  if (requestedActive) {
    console.log('[seed-gate-canary-sweep] --active was passed but this seed ALWAYS lands inactive — activate explicitly after the green deploy carries the handler:');
  } else {
    console.log('[seed-gate-canary-sweep] activate after the green deploy carries the handler:');
  }
  console.log(`  UPDATE harness_shared.routines SET active=true WHERE install_slug='${slug}' AND name='${ROUTINE_NAME}';`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-gate-canary-sweep] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
