#!/usr/bin/env -S npx tsx
/**
 * One-time backfill for WI-10005040.
 *
 * Two raw-SQL writers (`reconcile-plan-runs.ts`, `plan-run-action.ts`
 * `recordScheduledFireFailure`) used to retire a scheduled-run instance plan
 * (`<template>@run-<token>`) by flipping ONLY `harness_plans.status` to `superseded`,
 * leaving its never-promoted `plan_items` open forever (28 phantom-open items on 10
 * superseded instances, measured 2026-10-01). Both writers now go through
 * `retireRunInstancePlan`; this script re-runs the ALREADY-superseded instances through
 * that same path (`onlyIfStatus: 'superseded'`) so content, `items` jsonb and the derived
 * `plan_items` index are closed together — never `plan_items` alone.
 *
 * The note on each dropped item names the run's REAL settled outcome, read from the
 * `plan_runs` ledger by `instance_plan_slug`. An instance with no ledger row is SKIPPED:
 * this script will not invent an outcome.
 *
 * Idempotent: only instances still carrying a non-terminal `plan_items` row are selected,
 * so a second pass finds nothing. Only `superseded` instances are touched — an `active` or
 * `ready` instance is a live plan, not a retired one.
 *
 * Usage:
 *   npx tsx scripts/backfill-retired-run-instance-items.mts            # dry run (default)
 *   npx tsx scripts/backfill-retired-run-instance-items.mts --execute  # apply
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import {
  retireRunInstancePlan,
  type RetiredRunOutcome,
} from '../packages/operator-core/lib/harness/routines/retire-run-instance-plan';

const EXECUTE = process.argv.includes('--execute');

interface Candidate {
  workspace_id: string;
  harness_slug: string;
  plan_slug: string;
  template_slug: string;
  open_items: number;
}

const OPEN_INSTANCE_ITEMS = (sql: postgres.Sql) => sql<Candidate[]>`
  SELECT p.workspace_id, p.harness_slug, p.plan_slug, p.template_slug,
         count(*)::int AS open_items
    FROM harness_shared.harness_plans p
    JOIN harness_shared.plan_items i
      ON i.workspace_id = p.workspace_id AND i.harness_slug = p.harness_slug AND i.plan_slug = p.plan_slug
   WHERE p.status = 'superseded'
     AND p.template_slug IS NOT NULL
     AND p.plan_slug LIKE '%@run-%'
     AND i.status NOT IN ('done', 'dropped')
   GROUP BY 1, 2, 3, 4
   ORDER BY p.plan_slug
`;

async function main(): Promise<void> {
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    const candidates = await OPEN_INSTANCE_ITEMS(sql);
    console.log(
      `found ${candidates.length} superseded run instance(s) holding ${candidates.reduce((n, c) => n + c.open_items, 0)} open item(s)`,
    );

    let closed = 0;
    let skipped = 0;
    for (const c of candidates) {
      const [run] = await sql<Array<{ outcome: string | null }>>`
        SELECT outcome FROM harness_shared.plan_runs
         WHERE instance_plan_slug = ${c.plan_slug} AND outcome IN ('success', 'partial', 'failed')
         ORDER BY id DESC LIMIT 1`;
      if (!run?.outcome) {
        skipped += 1;
        console.log(`  SKIP (no settled plan_runs row, will not invent an outcome): ${c.harness_slug}/${c.plan_slug}`);
        continue;
      }
      const outcome = run.outcome as RetiredRunOutcome;
      console.log(
        `  ${EXECUTE ? 'CLOSE' : 'WOULD CLOSE'} ${c.open_items} item(s) [run ${outcome}]: ${c.harness_slug}/${c.plan_slug}`,
      );
      if (!EXECUTE) continue;
      // `harness_plans.harness_slug` IS the storage slug already (read straight off the row).
      const result = await retireRunInstancePlan(sql, {
        workspaceId: c.workspace_id,
        planStorageSlug: c.harness_slug,
        instanceSlug: c.plan_slug,
        templateSlug: c.template_slug,
        outcome,
        onlyIfStatus: 'superseded',
      });
      closed += result.itemsClosed;
    }

    console.log(`${EXECUTE ? 'closed' : 'would close'} ${EXECUTE ? closed : candidates.length - skipped} ${EXECUTE ? 'item(s)' : 'instance(s)'}; skipped ${skipped}`);
    if (!EXECUTE) console.log('(dry run — pass --execute to apply)');

    const remaining = await OPEN_INSTANCE_ITEMS(sql);
    console.log(
      `remaining open items on superseded run instances: ${remaining.reduce((n, c) => n + c.open_items, 0)}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
