/**
 * Seed the `plan-item-orphan-reconcile` routine — EI-14693's periodic data-heal
 * (handler in `plan-item-orphan-reconcile-action.ts`; logic in
 * `../../plan-items/reconcile-linked-work-items.ts`'s `reconcileOrphanedPlanItemWorkItems`).
 *
 *   - `plan-item-orphan-reconcile` (every 15 min): find NON-terminal work-items
 *     still linked to an ALREADY-terminal (done/dropped) plan item — the residue
 *     the transition-only reconcile reaction never re-heals — and terminalize them
 *     (feature passed/deprecated, issue resolved/closed). Fail-closed (never flips a
 *     WI whose plan-item terminality it can't confirm), skips independent in-flight
 *     progress + already-terminal items, idempotent (a re-sweep of healed data is a
 *     no-op). SQL + the shared per-item reconciler only; spawns no agent, no LLM,
 *     no network call.
 *
 * NOT flag-gated (same class as gc-plan-runs / telemetry-retention — no
 * owner-authority surface; it only ever mirrors the SAME terminalization the
 * transition reaction already performs automatically, extended to the transition-
 * missed cases + `dropped`, and every flip is reversible). Seeded ACTIVE by default
 * (owner-approved 2026-07-17) — the residue it heals is the recurring EI-13337/
 * 13352/13267 fleet-time cost (drain fleet re-working already-done plan-lane items)
 * + the spurious pot:survey Mug placement wakes EI-14693 was originally filed for.
 * Pass `--inactive` to seed dark instead.
 *
 *   tsx seed-plan-item-orphan-reconcile-routine.ts               # seed ACTIVE (default)
 *   tsx seed-plan-item-orphan-reconcile-routine.ts --inactive     # seed dark
 *   tsx seed-plan-item-orphan-reconcile-routine.ts --candidate-cap 200
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - candidate_cap (default 500, reconcile-linked-work-items.ts's DEFAULT_ORPHAN_SWEEP_CAP)
 *
 * Idempotent upsert on (install_slug, name), same key discipline as every routine
 * in this dir. A re-run does NOT live-arm an already-running host — the routine
 * engine (routinesTick) picks a freshly-seeded cron row up on its next tick.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PLAN_ITEM_ORPHAN_RECONCILE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 15 minutes on the :00 second (6-field: sec min hour dom mon dow). Cheap
 *  (a couple of bounded SELECTs + a handful of state flips); the orphan residue is
 *  not urgent, so a 15-min heal is ample to clear it before it causes survey noise. */
const CRON = '0 */15 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const candidateCap = argNumber('--candidate-cap');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'plan-item-orphan-reconcile';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(candidateCap ? { candidate_cap: candidateCap } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:plan-item-orphan-reconcile', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-plan-item-orphan-reconcile-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `15-min data-heal of NON-terminal work-items linked to already-terminal plan items` +
      (candidateCap ? `, candidate_cap=${candidateCap}` : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-plan-item-orphan-reconcile-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
