/**
 * Seed the monthly Hive-evaluation cadence routine (hive-run-evaluation-2026-06-13 HE-07, P-050)
 * — the SIBLING of lib/iq-battery/seed-benchmark-routine.ts.
 *
 *   - `pot-eval-battery` (monthly): one budget-capped SCORED Hive-eval generation per new code
 *     SHA, run through the `pot-eval` deterministic blueprint (fired via `system:blueprint-run`,
 *     which detects program-mode and runs the `pot-eval:gen` step inline). The step self-gates
 *     HARD (lib/pot-eval/cadence-tick.ts): no owner-set payload budgetUsd → REFUSE; an
 *     already-measured SHA → skip.
 *
 * SEEDED INACTIVE by default: a whole-Hive generation is real LLM spend (the owner-gated P-051
 * cost) AND the live whole-Hive ports are still the owner-gated leaf (D-011) — so the cadence is
 * armed only when the owner sets a budget AND the live runner is bound. Idempotent (upsert);
 * re-seeding without --budget PRESERVES an owner-set budget.
 *
 *   tsx lib/hive-eval/seed-hive-eval-routine.ts                       # seed INACTIVE, no budget
 *   tsx lib/hive-eval/seed-hive-eval-routine.ts --active --budget=40  # seed live with a $40 cap
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

const SLUG =
  process.env.POT_EVAL_HARNESS ??
  process.env.HIVE_EVAL_HARNESS ?? // legacy env name — dual-accept until callers migrate
  operatorHomeHarnessSlug(); // allow-scope-default: env-overridable operator-home routine install (no env ⇒ home hive, by design)
// Monthly at 06:50:00 on the 1st — :50 is OFFSET from the deploy rhythm (release-trigger
// :00/:15/:30/:45, hourly green-checkpoint ~:30), the gym (:10/:40), and the iq-battery (:20):
// a battery is a long-running in-host job a deploy-restart at a shared boundary would kill.
// Fires the `hive-eval` PROGRAM blueprint via `system:blueprint-run` (deterministic-blueprints
// pattern) — the budget lives under payload_template.payload.budgetUsd.
const ROUTINE = { name: 'pot-eval-battery', target: 'system:blueprint-run', cron: '0 50 6 1 * *' };

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const budgetArg = process.argv.find((a) => a.startsWith('--budget='))?.slice('--budget='.length);
  const budgetUsd = budgetArg !== undefined ? Number(budgetArg) : null;
  if (budgetArg !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd! <= 0)) {
    throw new Error(`--budget must be a positive number of USD, got "${budgetArg}"`);
  }

  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const id = `rt_${SLUG}_${ROUTINE.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  // payload_template carries the blueprint pointer; the owner budget lives under
  // `.payload.budgetUsd` (runScheduledProgram passes `.payload` to the program).
  const blueprintPayload = JSON.stringify(
    budgetUsd != null ? { blueprintId: 'pot-eval', payload: { budgetUsd } } : { blueprintId: 'pot-eval' },
  );
  const budgetPayload = budgetUsd != null ? JSON.stringify({ budgetUsd }) : null;
  // On conflict: ENSURE blueprintId; a re-seed without --budget must NOT wipe the owner-set
  // budget (preserve the existing `.payload`).
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       payload_template, concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${ROUTINE.name}, 'cron',
            ${JSON.stringify({ cron: ROUTINE.cron })}::text::jsonb, ${ROUTINE.target},
            ${blueprintPayload}::text::jsonb,
            'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      payload_template = jsonb_build_object(
        'blueprintId', 'pot-eval',
        'payload', COALESCE(${budgetPayload}::text::jsonb, harness_shared.routines.payload_template->'payload', '{}'::jsonb)
      ),
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-hive-eval-routine] seeded ${ROUTINE.name} for "${SLUG}" (ws=${ws}, active=${active}, ` +
      `budget=${budgetUsd != null ? `$${budgetUsd}` : 'NOT SET — the step will refuse until the owner sets one'}). ` +
      (active
        ? 'LIVE — fires monthly (1st, 06:50); refuses without a budget, skips an already-measured SHA.'
        : 'Inactive — enable with --active or the routines admin AFTER the deploy carries the hive-eval blueprint + the live whole-Hive runner is bound (P-051).'),
  );
  await sql.end({ timeout: 5 });
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-hive-eval-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
