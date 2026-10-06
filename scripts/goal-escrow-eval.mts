#!/usr/bin/env -S npx tsx
/**
 * READ-ONLY runner for the goal escrow evaluator (WI-10004498, experiment step 1).
 *
 * Builds a snapshot for each goal from existing records (goal row, linked
 * work-items/plans, gate health, scorecards, spend snapshot, owner-report
 * envelopes), runs `evaluateGoalEscrow`, and prints one line per goal plus the
 * sample summary that answers the experiment's falsification question. It issues
 * SELECTs only and writes nothing to goal or orchestration state.
 *
 * Usage:
 *   npx tsx scripts/goal-escrow-eval.mts --goal <goal-id>        # one goal, full detail
 *   npx tsx scripts/goal-escrow-eval.mts --recent 8              # the 8 most recently updated goals
 *   npx tsx scripts/goal-escrow-eval.mts --goals id1,id2,id3     # a hand-picked sample
 *   add --json for machine-readable output; --workspace <id> to override papercusp-workspace
 */
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { listScorecards } from '../packages/operator-core/lib/scorecards';
import {
  evaluateGoalEscrow,
  summarizeGoalEscrowSample,
  type EscrowGrade,
  type GoalEscrowResult,
} from '../packages/operator-core/lib/goals/goal-escrow';
import { listRecentGoalIds, readGoalEscrowSnapshot } from '../packages/operator-core/lib/goals/goal-escrow-snapshot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Bound the per-goal scorecard fan-out: a standing goal can link hundreds of items. */
const MAX_GRADE_SUBJECTS = 60;
const GRADE_BATCH = 8;

async function readGrades(subjectRefs: readonly string[]): Promise<{ grades: EscrowGrade[]; gaps: number }> {
  const all = [...new Set(subjectRefs)];
  const refs = all.slice(0, MAX_GRADE_SUBJECTS);
  const out: EscrowGrade[] = [];
  // Subjects beyond the cap were never read: that is a gap too, not an absence.
  let gaps = all.length - refs.length;
  for (let i = 0; i < refs.length; i += GRADE_BATCH) {
    const batch = refs.slice(i, i + GRADE_BATCH);
    // A read that times out under load is a GAP, never "no grade": count it and go on.
    const pages = await Promise.all(
      batch.map((subjectRef) =>
        listScorecards({ subjectRef, limit: 20 }).catch((): null => {
          gaps += 1;
          return null;
        }),
      ),
    );
    pages.forEach((rows, idx) => {
      for (const row of rows ?? []) {
        out.push({
          id: row.issueId,
          rubricRef: row.rubricRef,
          score10: typeof row.score10 === 'number' ? row.score10 : null,
          // Judge sessions file as `system:judge/<owner-id>`; compare on the owner id.
          gradedBy: row.createdBy ? row.createdBy.replace(/^system:judge\//, '') : null,
          createdAtMs: Date.parse(row.createdAt),
          subjectRef: batch[idx] ?? null,
        });
      }
    });
  }
  return { grades: out, gaps };
}

function line(result: GoalEscrowResult): string {
  const states = result.deposits.map((d) => `${d.key.split('_')[0]}=${d.state}`).join(' ');
  return `${result.goalId.slice(0, 60).padEnd(60)} status=${result.goalStatus.padEnd(8)} verdict=${result.verdict.padEnd(12)} ${result.agreement.padEnd(14)} ${states}`;
}

async function main(): Promise<void> {
  const workspaceId = arg('--workspace') ?? 'papercusp-workspace';
  const json = process.argv.includes('--json');
  const sql = postgres(getHarnessAdminUrl(), { max: 2 });
  try {
    const goalArg = arg('--goal');
    // --goals a,b,c evaluates a hand-picked sample (e.g. a mix of achieved / killed / active goals).
    const goalsArg = arg('--goals');
    const goalIds = goalArg
      ? [goalArg]
      : goalsArg
        ? goalsArg.split(',').map((g) => g.trim()).filter((g) => g.length > 0)
        : await listRecentGoalIds(sql, workspaceId, Number(arg('--recent') ?? 8));
    const results: GoalEscrowResult[] = [];
    const missing: string[] = [];
    for (const goalId of goalIds) {
      const snapshot = await readGoalEscrowSnapshot({ sql, workspaceId, goalId, nowMs: Date.now(), readGrades });
      if (snapshot === null) {
        missing.push(goalId);
        continue;
      }
      results.push(evaluateGoalEscrow(snapshot));
    }
    const summary = summarizeGoalEscrowSample(results);
    if (json) {
      console.log(JSON.stringify({ results, summary, goalsNotFound: missing }, null, 2));
      return;
    }
    for (const result of results) {
      console.log(line(result));
      if (goalArg) {
        for (const d of result.deposits) {
          console.log(`  ${d.key}: ${d.state}${d.noGo ? ' (no-go)' : ''}${d.reasons.length ? ` — ${d.reasons.join('; ')}` : ''}`);
          console.log(`      evidence: ${d.evidence.join(' ')}`);
        }
        console.log(`  verdict: ${result.verdict} — ${result.verdictReasons.join(' | ')}`);
      }
    }
    if (missing.length > 0) console.log(`not found: ${missing.join(', ')}`);
    console.log(
      `SUMMARY goals=${summary.goalsEvaluated} withActionable=${summary.goalsWithActionable} ` +
        `overclaimsClose=${summary.overclaimsClose} matchesWithoutAmbiguity=${summary.matchesWithoutAmbiguity} falsified=${summary.falsified}`,
    );
    console.log(`byAgreement=${JSON.stringify(summary.byAgreement)} byVerdict=${JSON.stringify(summary.byVerdict)}`);
    console.log(`depositFindings=${JSON.stringify(summary.depositFindings)}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
