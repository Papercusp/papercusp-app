/**
 * CI gate — scans apps/operator/docs/plans/ and fails on any lint error.
 *
 * Per agent-plan-tracking-2026-05-20.md P-109. Legacy plans (no
 * frontmatter) are exempt by lintPlan itself, so day-one CI runs
 * green on whatever's already in the tree.
 *
 * Run as: cd apps/operator && npx tsx scripts/lint-plans.ts
 */

import { lintPlan, type PlanLintReport } from '@papercusp/operator-core/lib/agent-tools/plans/lint';
import { listPlanFiles } from '@papercusp/operator-core/lib/agent-tools/plans/source';

async function main(): Promise<void> {
  const entries = await listPlanFiles({ includeArchived: true });
  console.log(`scanning ${entries.length} plans...`);

  let totalErrors = 0;
  let totalWarnings = 0;
  let ok = 0;
  const withIssues: PlanLintReport[] = [];

  for (const e of entries) {
    const r = await lintPlan(e.slug);
    if (!r) continue;
    if (r.errors.length === 0 && r.warnings.length === 0) {
      ok++;
    } else {
      withIssues.push(r);
    }
    totalErrors += r.errors.length;
    totalWarnings += r.warnings.length;
  }

  console.log(`clean: ${ok} / with issues: ${withIssues.length}`);
  console.log(`total errors: ${totalErrors} / total warnings: ${totalWarnings}`);
  console.log();

  for (const r of withIssues) {
    console.log(`--- ${r.slug} ${r.archived ? '(archived)' : ''} ---`);
    for (const e of r.errors) {
      console.log(`  ERR  ${e.code}: ${e.message.slice(0, 160)}`);
    }
    for (const w of r.warnings.slice(0, 3)) {
      console.log(`  warn ${w.code}: ${w.message.slice(0, 160)}`);
    }
    if (r.warnings.length > 3) {
      console.log(`  ...+${r.warnings.length - 3} more warnings`);
    }
  }

  if (totalErrors > 0) process.exit(1);
}

void main();
