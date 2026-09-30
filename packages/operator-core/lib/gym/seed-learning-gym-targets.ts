/**
 * Seed the learning-system gym targets — self-learning-frontier-2026-06-12
 * P-048 / FB-23 (the call-site for registerLearningGymTargets; mirrors the other
 * frontier seed scripts, e.g. lib/red-queen/seed-red-queen-routine.ts).
 *
 * Registers the learning system's own roles (the implement worker — the only one
 * with a gym-native prompt-override surface) as a gym AUTOLOOP target judged on
 * drill ground truth (drillResolveRate / drillMttsh, see lib/gym/learning-targets.ts).
 * The triage-classifier (Queen persona, FB-19's lane) and Scout ideators
 * (code-constructed lenses) have no prompt-override surface, so they get NO autoloop
 * row — their champions are reviewed source edits, recorded only in the registry
 * rationale (they are still judged corpus-wide, just not auto-optimized).
 *
 * DARK by construction (D-001): registerLearningGymTargets creates the autoloop row
 * enabled:false + budget null — doubly refused by the gym-cycle tick (disabled AND
 * unbudgeted, the D-004 governor rule). ARMING is the owner's per-lane act AFTER the
 * P-001 gate: enable the row + set its governor budget via the gym control plane.
 * Idempotent — NEVER mutates an existing row, so an owner's enable/budget survives
 * re-seeding.
 *
 * The implement-worker row needs the auto-implement RUNNER harness configured
 * (PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS, plan-implement.ts D-006). Unconfigured ⇒
 * the row is skipped (registration never invents a harness slug); configure the
 * runner first, then re-run this seed.
 *
 *   tsx lib/gym/seed-learning-gym-targets.ts
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import { registerLearningGymTargets } from './learning-targets';

async function main(): Promise<void> {
  const ws = activeWorkspaceId();
  // Same source the auto-implement loop resolves its runner from
  // (improvement-actions.ts) — keep them reading the one config so the gym
  // target and the runner it optimizes can never disagree.
  const implementRunnerSlug = process.env.PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS || null;
  const { sql } = getOrgPg();
  try {
    const result = await registerLearningGymTargets(sql, { workspaceId: ws, implementRunnerSlug });
    console.log(
      `[seed-learning-gym-targets] ws=${ws}, implementRunner=${implementRunnerSlug ?? 'UNCONFIGURED'}. ` +
        `created=[${result.created.join(', ') || '—'}] existing=[${result.existing.join(', ') || '—'}]`,
    );
    for (const s of result.skipped) console.log(`[seed-learning-gym-targets] skipped ${s.key}: ${s.reason}`);
    console.log(
      result.created.length
        ? '[seed-learning-gym-targets] row created DARK (enabled:false, unbudgeted) — arm at P-001: enable + set the governor budget on the gym control plane.'
        : '[seed-learning-gym-targets] no row created — configure PAPERCUSP_IMPROVEMENT_RUNNER_HARNESS (the auto-implement runner) then re-run, or the owner-set rows already exist.',
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[seed-learning-gym-targets] FAILED:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
