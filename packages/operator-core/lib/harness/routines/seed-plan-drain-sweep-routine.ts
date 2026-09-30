/**
 * Seed the `plan-drain-sweep` routine — P-005 of
 * deterministic-plan-state-derivation-2026-08-31 (handler in
 * `plan-drain-sweep-action.ts`; logic in
 * `../../agent-tools/plans/plan-drain-sweep.ts`'s `sweepDrainedPlanStatuses`).
 *
 *   - `plan-drain-sweep` (every 30 min): find non-archived, non-instance plans
 *     whose stored lifecycle status contradicts their item graph — `ready`/`active`
 *     with every item terminal, or `awaiting-acceptance` with an item live again —
 *     and move the status to match. P-004's reaction rule handles this the moment
 *     an author flips the last item; this catches the population that drained
 *     BEFORE that rule existed and therefore has no future event to fire on
 *     (205 such plans measured, plan D-006 point 1).
 *
 *     Bounded, idempotent, symmetric. Bounded: `cap` plans flipped per tick, so the
 *     accumulated backlog drains over several ticks rather than rewriting 205
 *     historical rows in one pass. Idempotent: a re-sweep of reconciled data is a
 *     no-op, because the decision is re-derived from scratch every time.
 *     Symmetric: it moves the reverse edge too, so reopening an item un-does the
 *     transition and no plan can be stranded in a state its own graph refutes.
 *     Bounded SELECTs + plan-body writes only; spawns no agent, no LLM, no network.
 *
 *     Deliberately does NOT touch `draft` (its difference from `ready` encodes
 *     authorial intent the item graph cannot see — D-005 point 4), `shipped` or
 *     `superseded` (terminal), archived plans, or scheduled-plan INSTANCES
 *     (`reconcile-plan-runs` supersedes those under a literal `AND status='active'`
 *     guard that an `awaiting-acceptance` flip would silently defeat).
 *
 * NOT flag-gated — same class as `plan-item-orphan-reconcile`: no owner-authority
 * surface, no destructive or outward-facing effect, and every flip is reversible by
 * the rule's own reverse edge. It never advances a plan to `shipped`: the ship gate
 * needs a code-truth audit and independent acceptance grading that no item status
 * can evidence, and auto-shipping would forge exactly that evidence (D-005 point 6).
 * Seeded ACTIVE by default; pass `--inactive` to seed dark.
 *
 *   tsx seed-plan-drain-sweep-routine.ts                 # seed ACTIVE (default)
 *   tsx seed-plan-drain-sweep-routine.ts --inactive      # seed dark
 *   tsx seed-plan-drain-sweep-routine.ts --cap 5         # smaller per-tick bound
 *
 * trigger_config knobs (optional, editable via the routines admin):
 *   - cap (default 25, plan-drain-sweep.ts's DEFAULT_PLAN_DRAIN_SWEEP_CAP)
 *
 * Idempotent upsert on (install_slug, name), same key discipline as every routine
 * in this dir. A re-run does NOT live-arm an already-running host — the routine
 * engine (routinesTick) picks a freshly-seeded cron row up on its next tick.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';

const SLUG = process.env.PLAN_DRAIN_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
/** Every 30 minutes on the :00 second (6-field: sec min hour dom mon dow). The
 *  reaction rule already covers the live path, so this is pure residue repair and
 *  never urgent; 30 min drains the measured 205-plan backlog in a few hours and
 *  costs three bounded SELECTs per tick thereafter. */
const CRON = '0 */30 * * * *';

function argNumber(flag: string): number | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

async function main(): Promise<void> {
  const active = !process.argv.includes('--inactive');
  const cap = argNumber('--cap');
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();
  const name = 'plan-drain-sweep';
  const id = `rt_${SLUG}_${name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const triggerConfig = {
    cron: CRON,
    ...(cap ? { cap } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
       concurrency, catchup, active, next_fire_at)
    VALUES (${id}, ${SLUG}, ${ws}, ${name}, 'cron', ${JSON.stringify(triggerConfig)}::text::jsonb,
            'system:plan-drain-sweep', 'skip', 'skip-old', ${active}, now())
    ON CONFLICT (install_slug, name) DO UPDATE SET
      target_role = EXCLUDED.target_role,
      trigger_config = EXCLUDED.trigger_config,
      -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
      -- re-seed must never clobber an operator's runtime pause/resume of this routine.
      workspace_id = EXCLUDED.workspace_id,
      updated_at = now()
  `;
  console.log(
    `[seed-plan-drain-sweep-routine] seeded "${name}" for "${SLUG}" (ws=${ws}, active=${active}) — ` +
      `30-min backstop reconciling stored plan status against a drained item graph` +
      (cap ? `, cap=${cap}` : '') +
      '.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-plan-drain-sweep-routine] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
