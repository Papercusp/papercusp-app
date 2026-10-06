/**
 * test-run-ledger.ts — record a LIVE llm-test scenario run in `harness_shared.test_runs`.
 *
 * EI-24434635346407728. `llm-test run` executes a scenario against a live model and
 * persists its rich report to `harness_shared.llm_test_runs`, but acceptance BAR
 * clauses bind to the shared test ledger (`test_runs` + `execution_details`). Before
 * this module a live scenario left no `test_runs` row, so a clause whose
 * `requiredTestLayers` includes `llm` had nothing to bind to and was unsatisfiable.
 *
 * The recorded layer is a RUNTIME fact: only the live runner calls this, so it stamps
 * `llm`. Replaying stored model output under the unit Vitest config never reaches here
 * and records `unit` through the ordinary Vitest reporter.
 *
 * Fail-soft like the Vitest/Playwright reporters: a ledger write must never change the
 * scenario verdict or the CLI exit code.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, relative } from 'node:path';

import type { RunReport } from '@papercusp/testing-shell/llm';
import {
  TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
  type TestRunExecutionDetails,
} from '@papercusp/test-config/execution-details';

import { resolveAgentWorkspaceRoot } from '../agent-tools/capability/base-dir';
import { getLongLivedAdminPool } from '../long-lived-admin-pool';
import { sharedUtilityPoolMax } from '../resource-profile';
import { resolveGitContext } from '../testing-branch-resolve';
import { resolveTestRunSource } from '../testing-run-source';
import { captureWorktreeSnapshot, computeWorktreeDirty, type WorktreeGitSnapshot } from '../testing-worktree';

export interface LlmScenarioLedgerRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
  executionDetails: TestRunExecutionDetails;
}

export interface LlmScenarioLedgerContext {
  root: string;
  filePath: string;
  runGroupId: string | null;
  workspaceId: string | null;
  harnessSlug: string | null;
  commitSha: string | null;
  worktreeDirty: boolean;
  /** Fallback clock when the report carries no runs. */
  now?: Date;
}

/** Pure projection of a live scenario report onto one `test_runs` row. */
export function llmScenarioLedgerRow(report: RunReport, ledger: LlmScenarioLedgerContext): LlmScenarioLedgerRow {
  const passed = report.runs.filter((r) => r.status === 'passed').length;
  const failed = report.runs.filter((r) => r.status === 'failed').length;
  const errored = report.runs.filter((r) => r.status === 'errored').length;

  const status: LlmScenarioLedgerRow['status'] =
    report.runs.length === 0 ? 'skip'
      : failed > 0 ? 'fail'
        : errored > 0 ? 'error'
          : 'pass';

  const now = ledger.now ?? new Date();
  const starts = report.runs.map((r) => new Date(r.summary.startedAt).getTime()).filter(Number.isFinite);
  const ends = report.runs.map((r) => new Date(r.summary.finishedAt).getTime()).filter(Number.isFinite);
  const startedAt = starts.length ? new Date(Math.min(...starts)) : now;
  const finishedAt = ends.length ? new Date(Math.max(...ends)) : now;

  const outputTail = status === 'pass' ? null
    : `llm-test ${report.scenarioId} verdict=${report.verdict} runs=${report.runs.length} passed=${passed} failed=${failed} errored=${errored}`;

  return {
    filePath: ledger.filePath,
    status,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    startedAt,
    finishedAt,
    outputTail,
    executionDetails: {
      schemaVersion: TEST_RUN_EXECUTION_DETAILS_SCHEMA_VERSION,
      root: ledger.root,
      filePath: ledger.filePath,
      runGroupId: ledger.runGroupId,
      workspaceId: ledger.workspaceId,
      harnessSlug: ledger.harnessSlug,
      testNamePattern: null,
      scenarioId: report.scenarioId,
      testLayer: 'llm',
      // An errored run measured nothing it could pass; count it against the file.
      passed,
      failed: failed + errored,
      skipped: 0,
      collectionFailed: false,
      mutationPhase: null,
      commitSha: ledger.commitSha,
      worktreeDirty: ledger.worktreeDirty,
    },
  };
}

/**
 * Absolute path of the source file that defines `scenarioId`, or undefined.
 *
 * Neither the id prefix nor the basename follows one convention (`op-S01-…` lives in
 * `operator/S01-….ts`, `sn-S01-…` in `papercup/SN01-….ts`), and ONE file may define
 * many scenarios (`S33-goal-agenda.ts` builds `` `su-S33-agenda-${c}` ``). So the file
 * is found by CONTENT: the non-test source (target dir first, then the whole tree)
 * holding the id as a string literal, else the longest templated prefix of it. A tie
 * or no match returns undefined — never a guessed path, because a wrong path
 * silently drops the ledger row or misattributes the evidence.
 */
export function resolveScenarioSourceFile(
  scenarioId: string,
  target: string,
  scenariosRoot: string,
): string | undefined {
  if (!existsSync(scenariosRoot)) return undefined;
  const files = listScenarioSources(scenariosRoot);
  const targetDir = join(scenariosRoot, target);
  const pools = [
    { files: files.filter((f) => f.startsWith(`${targetDir}/`)), allowRolePrefix: true },
    // The whole-tree fallback ignores a bare role prefix (`` `su-${n}` ``): outside the
    // scenario's own target dir it names any id of that role, so a fixture id builder in
    // a helper file captured su-S37 and misattributed its llm rows (gitnexus P-015).
    { files, allowRolePrefix: false },
  ];
  for (const pool of pools) {
    let best: { file: string; score: number } | null = null;
    let tie = false;
    for (const file of pool.files) {
      const score = idMatchScore(readFileSync(file, 'utf8'), scenarioId, pool.allowRolePrefix);
      if (score === 0) continue;
      if (!best || score > best.score) { best = { file, score }; tie = false; }
      else if (score === best.score) tie = true;
    }
    if (best) return tie ? undefined : best.file;
  }
  return undefined;
}

function listScenarioSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScenarioSources(p));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/**
 * Infinity for an exact quoted id; else the length of the longest `` `prefix${ `` it extends.
 * A role-only prefix (one segment, e.g. `su-`, `sn-`) counts only when `allowRolePrefix`.
 */
function idMatchScore(source: string, id: string, allowRolePrefix: boolean): number {
  for (const q of ["'", '"', '`']) if (source.includes(`${q}${id}${q}`)) return Number.POSITIVE_INFINITY;
  let best = 0;
  for (const m of source.matchAll(/`([A-Za-z0-9_-]+)\$\{/g)) {
    const prefix = m[1]!;
    if (!prefix.includes('-') || !id.startsWith(prefix) || id.length <= prefix.length) continue;
    if (!allowRolePrefix && prefix.split('-').filter(Boolean).length < 2) continue;
    best = Math.max(best, prefix.length);
  }
  return best;
}

/** Workspace-relative POSIX path, or null when the scenario file is not on disk. */
export function scenarioLedgerPath(absPath: string | undefined, root: string): string | null {
  if (!absPath || !existsSync(absPath)) return null;
  const rel = relative(root, absPath);
  if (rel.startsWith('..')) return null;
  return rel.split(/[/\\]/).join(posix.sep);
}

/** Snapshot taken BEFORE the scenario runs, so the row can prove the tree was stable. */
export function beginLlmScenarioLedger(): WorktreeGitSnapshot | null {
  try {
    return captureWorktreeSnapshot();
  } catch {
    return null;
  }
}

/**
 * Insert the ledger row for a finished live scenario. Returns the new `test_runs.id`, or
 * null when it could not be recorded (no scenario file, DB unreachable). Never throws.
 */
export async function recordLlmScenarioTestRun(
  report: RunReport,
  scenarioFilePath: string | undefined,
  before: WorktreeGitSnapshot | null,
): Promise<number | null> {
  try {
    const root = resolveAgentWorkspaceRoot({});
    const filePath = scenarioLedgerPath(scenarioFilePath, root);
    if (!filePath) return null;

    const after = captureWorktreeSnapshot();
    const worktreeDirty = before ? computeWorktreeDirty(before, after) : true;
    const { branch } = await resolveGitContext().catch(() => ({ branch: null as string | null }));
    const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? report.matrixGroupId ?? null;
    const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID ?? null;
    const harnessSlug = process.env.PAPERCUSP_TEST_RUN_HARNESS ?? null;

    const row = llmScenarioLedgerRow(report, {
      root, filePath, runGroupId, workspaceId, harnessSlug,
      commitSha: after.commit ?? null,
      worktreeDirty,
    });

    // Same pool + options as ./storage, so the two writers share one connection budget.
    const sql = getLongLivedAdminPool('llm-testing-storage', { max: sharedUtilityPoolMax(), prepare: false });
    const inserted = (await sql`
      INSERT INTO harness_shared.test_runs
        (file_path, framework, status, duration_ms, started_at, finished_at, output_tail,
         run_group_id, source, branch, commit_sha, harness_slug, workspace_id, worktree_dirty, execution_details)
      VALUES
        (${row.filePath}, 'llm-test', ${row.status}, ${row.durationMs}, ${row.startedAt}, ${row.finishedAt},
         ${row.outputTail}, ${runGroupId}, ${resolveTestRunSource()}, ${branch ?? null}, ${after.commit ?? null},
         ${harnessSlug}, ${workspaceId}, ${worktreeDirty}, ${row.executionDetails as never}::jsonb)
      RETURNING id
    `) as unknown as Array<{ id: string | number }>;
    const id = inserted[0]?.id;
    return id === undefined ? null : Number(id);
  } catch {
    return null;
  }
}
