#!/usr/bin/env -S npx tsx
/**
 * One-time backfill for EI-19389216343173748.
 *
 * `system:plan-run` (packages/operator-core/lib/harness/routines/plan-run-action.ts)
 * used to clone a scheduled plan's markdown VERBATIM into each `<slug>@run-<epochms>`
 * instance, frontmatter included — so the instance's self-declared `slug:` line stayed
 * the PARENT's, a standing `slug_mismatch` per plans/lint.ts. The writer is fixed
 * (it now rewrites `slug:` via setFrontmatterScalar and rehashes); this script repairs
 * the rows minted before that fix.
 *
 * Idempotent: only touches rows where the frontmatter `slug:` line disagrees with the
 * row's own `plan_slug` (the same predicate the bug report's verify query uses). Safe
 * to re-run — a second pass finds nothing left to do.
 *
 * Usage:
 *   npx tsx scripts/backfill-plan-run-snapshot-slugs.mts            # dry run (default)
 *   npx tsx scripts/backfill-plan-run-snapshot-slugs.mts --execute  # apply
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { setFrontmatterScalar } from '../packages/operator-core/lib/agent-tools/plans/transfer-owner';
import { hashPlanContent } from '@papercusp/plan-parser/content-hash';

const EXECUTE = process.argv.includes('--execute');

async function main(): Promise<void> {
  const sql = postgres(getHarnessAdminUrl(), { max: 1 });
  try {
    // Only run-snapshot rows (plan_slug contains the `@run-` marker) whose frontmatter
    // slug disagrees with the canonical plan_slug — the same condition the bug's own
    // verify query used to measure "50 today".
    const rows = await sql<Array<{ workspace_id: string; harness_slug: string; plan_slug: string; content: string }>>`
      SELECT workspace_id, harness_slug, plan_slug, content
        FROM harness_shared.harness_plans
       WHERE archived = false
         AND plan_slug LIKE '%@run-%'
         AND substring(content from 'slug:[ ]*([^\n]*)') IS DISTINCT FROM plan_slug
    `;
    console.log(`found ${rows.length} run-snapshot row(s) with a mismatched frontmatter slug`);

    let fixed = 0;
    let skippedNoFrontmatter = 0;
    for (const row of rows) {
      const before = row.content;
      const after = setFrontmatterScalar(before, 'slug', row.plan_slug);
      if (after === before) {
        // No `---`-delimited frontmatter block (legacy plan) — setFrontmatterScalar is a
        // deliberate no-op there; nothing this script can safely rewrite.
        skippedNoFrontmatter += 1;
        console.log(`  SKIP (no frontmatter block): ${row.harness_slug}/${row.plan_slug}`);
        continue;
      }
      const newHash = hashPlanContent(after);
      console.log(`  ${EXECUTE ? 'FIX' : 'WOULD FIX'}: ${row.harness_slug}/${row.plan_slug}`);
      if (EXECUTE) {
        await sql`
          UPDATE harness_shared.harness_plans
             SET content = ${after}, content_hash = ${newHash}
           WHERE workspace_id = ${row.workspace_id} AND harness_slug = ${row.harness_slug}
             AND plan_slug = ${row.plan_slug}
        `;
      }
      fixed += 1;
    }

    console.log(
      `${EXECUTE ? 'fixed' : 'would fix'} ${fixed} row(s); skipped ${skippedNoFrontmatter} (no frontmatter block)`,
    );
    if (!EXECUTE) console.log('(dry run — pass --execute to apply)');

    // Re-verify against the bug report's own count query.
    const remaining = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.harness_plans
       WHERE archived = false
         AND plan_slug LIKE '%@run-%'
         AND substring(content from 'slug:[ ]*([^\n]*)') IS DISTINCT FROM plan_slug
    `;
    console.log(`remaining mismatched rows: ${remaining[0]?.n ?? 0}`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
