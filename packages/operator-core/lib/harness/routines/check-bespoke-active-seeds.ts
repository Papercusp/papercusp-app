/**
 * CLI runner for `bespoke-active-seeds-check.ts` — see that file's header for the WHY
 * (EI-18746253391734322: the recurrence guard for "a seed script says SEEDED ACTIVE by
 * default but nobody ever ran it, so the routines row silently never existed").
 *
 * Usage:
 *   tsx packages/operator-core/lib/harness/routines/check-bespoke-active-seeds.ts
 *
 * Exit codes:
 *   0 — every registered routine has an ACTIVE row for its seed writer's target harness,
 *       and that row is actually EXECUTING
 *   1 — at least one is missing, inactive, or dark (prints the exact `tsx …` command to fix it)
 *   2 — environment problem (DB unreachable, etc.)
 */
import { getOrgPg } from '@papercusp/db-org';
import {
  BESPOKE_ACTIVE_SEEDS,
  DARK_STALE_INTERVAL_MULTIPLE,
  checkBespokeActiveSeeds,
  operatorHomeScope,
} from './bespoke-active-seeds-check';

async function main(): Promise<void> {
  const { installSlug, workspaceId } = operatorHomeScope();
  const { sql } = getOrgPg();
  const result = await checkBespokeActiveSeeds({ sql: sql as unknown as never, installSlug, workspaceId });

  if (result.ok) {
    console.log(
      `[check-bespoke-active-seeds] ok — all ${BESPOKE_ACTIVE_SEEDS.length} always-on bespoke ` +
        `routines have an ACTIVE row in their declared target scope (operator home "${installSlug}" ` +
        `or another explicitly scoped harness; ws=${workspaceId}).`,
    );
    await sql.end({ timeout: 5 });
    return;
  }

  for (const entry of result.missing) {
    console.error(
      `[check-bespoke-active-seeds] MISSING: no "${entry.name}" row for "${entry.installSlug}" — never seeded. Fix: ` +
        `tsx packages/operator-core/lib/harness/routines/${entry.seedScript}`,
    );
  }
  for (const entry of result.inactive) {
    const why = entry.pauseReason ?? 'NONE RECORDED — flipped by a path that bypassed routines:set';
    const held = entry.reviewBy ? ` [re-affirmed until ${entry.reviewBy}]` : '';
    console.error(
      `[check-bespoke-active-seeds] INACTIVE: "${entry.name}" row for "${entry.installSlug}" is seeded but active=false — ` +
        `its own header commits to ACTIVE by default. Pause reason: ${why}${held}. Fix: ` +
        `routines:set { name: "${entry.name}", installSlug: "${entry.installSlug}", active: true }`,
    );
  }
  for (const entry of result.dark) {
    const cadence = entry.intervalSec === null ? 'cron' : `every ${entry.intervalSec}s`;
    const age = `${Math.round(entry.ageSec / 60)}m`;
    console.error(
      entry.neverFired
        ? `[check-bespoke-active-seeds] DARK: "${entry.name}" row for "${entry.installSlug}" is ACTIVE (${cadence}) but has ` +
            `NEVER fired in the ${age} since it was created — nothing is executing it. For the ephemeral tier the ` +
            `executor reads the routine table ONCE at host boot, so a row seeded after that boot never gets a timer.`
        : `[check-bespoke-active-seeds] DARK: "${entry.name}" row for "${entry.installSlug}" is ACTIVE (${cadence}) but last ` +
            `fired ${age} ago — over ${DARK_STALE_INTERVAL_MULTIPLE}× its own declared cadence.`,
    );
  }
  await sql.end({ timeout: 5 });
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('[check-bespoke-active-seeds] FAILED:', e instanceof Error ? e.message : e);
  process.exitCode = 2;
});
