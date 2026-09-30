/**
 * Seed the self-improvement-loop routines — plans
 * papercusp-self-improvement-loop-2026-06-04 + close-the-self-improvement-loop-2026-06-05.
 *
 *   - `improvement-watchdog`  (every 15 min): the HARD feed-in (close-loop D-003) —
 *      auto-capture red tests / failing smokes / repeated tool errors / down
 *      services as kind=bug improvements. Capture only (search-first dedup +
 *      per-tick cap); builds nothing.
 *   - `improvement-invalid-args-miner` (weekly): WI-5017 — aggregates
 *      tool_invocations invalid-input rows by (tool, offending key) and files a
 *      recurring pattern as a kind=change improvement (an alias candidate, a
 *      confusing schema field, or an agent-prior drift). Capture only.
 *   - `improvement-tool-rejection-scorecard` (weekly): P-017 — the per-VERB
 *      schema-rejection rate, filed against any verb sustaining >= 10% over >= 3
 *      days. Its sibling above asks WHICH FIELD agents get wrong; this one asks
 *      WHICH VERB is wrong often enough to be a schema defect. Capture only.
 *   - `improvement-implement` (every 30 min): the auto-implement loop (Phase 3).
 *      ADDITIONALLY gated by the `papercusp-improvement-auto-implement` flag
 *      (default OFF) AND a configured PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS (D-006);
 *      until both are set it no-ops.
 *
 * The old `improvement-digest` routine was REMOVED (operator-learning-tab-2026-06-09
 * D-001) — its only job was pushing the triage headline to the human inbox, a
 * dead-end notification. The backlog is now PULLED in the Learning tab instead.
 *
 * SEEDED INACTIVE by default (mirrors seed-release-routines.ts). Flip routines
 * on with `--active` (the watchdog — the safe, capture-only cadence);
 * the implement routine needs the EXPLICIT `--arm-implement` flag on top (it is
 * the autonomous-code-modification path — owner-gated, close-loop D-004; even
 * then it no-ops until the flag + runner env are also set). Idempotent (upsert).
 *
 *   tsx seed-improvement-routines.ts                          # seed all INACTIVE
 *   tsx seed-improvement-routines.ts --active                 # watchdog live; implement stays inactive
 *   tsx seed-improvement-routines.ts --active --arm-implement # both live (owner-confirmed arming)
 */

import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { activeWorkspaceId } from '../../workspace-registry';
import { isCliEntry } from '../../util/cli-entry';
import { operatorHomeHarnessSlug } from '../operator-home-harness';
import { LEARNING_ROUTINE_GROUP } from './loop-control';

const SLUG = process.env.IMPROVEMENT_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
export const IMPROVEMENT_ROUTINES = [
  {
    name: 'improvement-watchdog',
    target: 'system:improvement-watchdog',
    cron: '0 */15 * * * *',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // every 15 min
  // The scheduled triage pass (learning-system-audit P-011): persists the
  // deterministic type-route on untriaged open items — routing metadata only
  // (never rejects, never dispatches), so it arms with the safe tier.
  {
    name: 'improvement-triage',
    target: 'system:improvement-triage',
    cron: '0 0 */6 * * *',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // every 6 h
  // WI-5017: aggregates tool_invocations invalid-input rows into (tool, offending
  // key) recurrence signals — capture only (kind=change), so it arms with the
  // safe tier like the watchdog/triage passes. Weekly: the signal is a slow
  // cross-agent DX pattern, not something sub-hour freshness would help.
  {
    name: 'improvement-invalid-args-miner',
    target: 'system:improvement-invalid-args-miner',
    cron: '0 0 4 * * 0',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // weekly, Sun 04:00
  // P-017 (coordination-spec-adoption-2026-08-03): the per-verb schema-rejection
  // scorecard — files against any verb sustaining >= 10% rejection over >= 3 days.
  // Capture only (kind=change) ⇒ safe tier, like the miner beside it. Weekly at
  // 04:30 rather than daily: the tick scans ~3.4M rows, and "sustained over 3
  // days" cannot be answered faster than that anyway. The :30 offset keeps it off
  // the same minute as the invalid-args miner's own heavy tool_invocations scan.
  {
    name: 'improvement-tool-rejection-scorecard',
    target: 'system:improvement-tool-rejection-scorecard',
    cron: '0 30 4 * * 0',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // weekly, Sun 04:30
  // P-019 (coordination-spec-adoption-2026-08-03): D-104's endgame — has any
  // auto-correction stopped decaying, i.e. become a permanent repair for a schema
  // nobody intends to fix? Capture only (kind=change) ⇒ safe tier, like its two
  // neighbours. DAILY rather than weekly, unlike them: this tick is also the only
  // writer of the per-day snapshot the check's baseline depends on, and
  // `tool_invocations` retains ~14 days — a weekly tick that misses two fires in a
  // row would lose days permanently. 05:00 keeps it off both heavier scans above.
  {
    name: 'improvement-correction-decay',
    target: 'system:improvement-correction-decay',
    cron: '0 0 5 * * *',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // daily 05:00
  // knowledge-pack-loop-integrity-2026-07-19 P-006/P-008 (registered in
  // routines/knowledge-pack-actions.ts): the fleet-lessons last-mile delivery
  // pass (bounded, D-003-preserving — clashes always skip) and the
  // knowledge-hygiene cleanup (stale-item re-review + contradiction sweep +
  // dismissed-candidate prune). Both conservative-by-construction ⇒ safe tier.
  {
    name: 'knowledge-pack-delivery',
    target: 'system:knowledge-pack-delivery',
    cron: '0 30 */6 * * *',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // every 6 h at :30 (offset from triage)
  {
    name: 'knowledge-pack-hygiene',
    target: 'system:knowledge-pack-hygiene',
    cron: '0 0 5 * * *',
    arm: 'safe',
    group: LEARNING_ROUTINE_GROUP,
  }, // daily 05:00
  {
    name: 'improvement-implement',
    target: 'system:improvement-implement',
    cron: '0 */30 * * * *',
    arm: 'owner',
    group: LEARNING_ROUTINE_GROUP,
  }, // every 30 min
] as const;

/**
 * Resolve whether ROUTINE `r` should be seeded ACTIVE — the gate logic, PURE +
 * unit-testable. `active`/`armImplement` are the CLI levers; `platformLoopsOn` is
 * the P-070 deployment-mode knob: the improvement-watchdog/triage/implement set are
 * LAYER-3 platform-improvement (Class-C) loops, so when platform mode is OFF (a
 * public release before the user opts in) they are FORCED inactive regardless of
 * the CLI flags — registration-only gate, no routine logic changes.
 */
export function resolveImprovementRoutineActive(
  r: { arm: 'safe' | 'owner' },
  opts: { active: boolean; armImplement: boolean; platformLoopsOn: boolean },
): boolean {
  // P-070: platform mode OFF ⇒ the whole Class-C improvement set ships dark.
  if (!opts.platformLoopsOn) return false;
  // The implement routine is the autonomous-code-modification path — it only goes
  // active with the EXPLICIT --arm-implement (owner-gated, close-loop D-004).
  return r.arm === 'owner' ? opts.active && opts.armImplement : opts.active;
}

async function main(): Promise<void> {
  const active = process.argv.includes('--active');
  const armImplement = process.argv.includes('--arm-implement');
  const ws = activeWorkspaceId();
  // P-070 deployment-mode gate: the improvement-watchdog/triage/implement loops are
  // LAYER-3 platform-improvement (Class-C) loops. When the PLATFORM_IMPROVEMENT_LOOPS
  // knob is OFF (release / non-platform mode) they seed INACTIVE regardless of --active.
  const platformLoopsOn = await getFlag(FLAGS.PLATFORM_IMPROVEMENT_LOOPS, 'platform-improvement-loops');
  // Admin connection (bypasses RLS) + explicit workspace_id — operator infra config,
  // the same path migrations/cross-workspace tooling use (mirrors seed-release-routines).
  const { sql } = getOrgPg();
  // Keep the seed's group row present before the composite FK is used below. This
  // also makes a fresh install self-healing when the seed runs after migration 617.
  await sql`
    INSERT INTO harness_shared.routine_groups (workspace_id, slug)
    VALUES (${ws}, ${LEARNING_ROUTINE_GROUP})
    ON CONFLICT (workspace_id, slug) DO NOTHING
  `;
  for (const r of IMPROVEMENT_ROUTINES) {
    const id = `rt_${SLUG}_${r.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const rowActive = resolveImprovementRoutineActive(r, { active, armImplement, platformLoopsOn });
    await sql`
      INSERT INTO harness_shared.routines
        (id, install_slug, workspace_id, name, trigger_kind, trigger_config, target_role,
         concurrency, catchup, active, next_fire_at, group_slug)
      VALUES (${id}, ${SLUG}, ${ws}, ${r.name}, 'cron', ${JSON.stringify({ cron: r.cron })}::text::jsonb, ${r.target},
              'skip', 'skip-old', ${rowActive}, now(), ${r.group})
      ON CONFLICT (install_slug, name) DO UPDATE SET
        target_role = EXCLUDED.target_role,
        trigger_config = EXCLUDED.trigger_config,
        -- active intentionally NOT re-applied on conflict (EI-19301170070808928): a
        -- re-seed must never clobber an operator's runtime pause/resume of this routine.
        workspace_id = EXCLUDED.workspace_id,
        -- Membership is part of the Learning tab's control contract: repair a
        -- pre-617 row that was seeded ungrouped or under health on every seed.
        group_slug = EXCLUDED.group_slug,
        updated_at = now()
    `;
  }
  console.log(
    `[seed-improvement-routines] seeded ${IMPROVEMENT_ROUTINES.map((r) => r.name).join(' + ')} for "${SLUG}" (ws=${ws}, active=${active}, armImplement=${armImplement}, platformLoopsOn=${platformLoopsOn}). ` +
      (!platformLoopsOn
        ? 'Held INACTIVE — platform-improvement loops are OFF (PLATFORM_IMPROVEMENT_LOOPS / PAPERCUSP_PLATFORM_MODE=off). Opt into platform mode to arm (P-070).'
        : active
          ? armImplement
            ? 'Both LIVE — implement still no-ops until the papercusp-improvement-auto-implement flag + PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS are set.'
            : 'Watchdog LIVE; implement stays INACTIVE (owner-gated — re-run with --arm-implement after owner confirm).'
          : 'Inactive — enable with --active or the routines admin.'),
  );
}

// Only run as a CLI (not when imported by a test, and NEVER when bundled into
// the desktop sidecar — see isCliEntry / EI-650).
if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('[seed-improvement-routines] FAILED:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
