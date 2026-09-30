/**
 * admin-test-runs-reporter-playwright.ts — Playwright counterpart to
 * the Vitest reporter (P-010). Writes one row per spec FILE to
 * harness_shared.test_runs with framework='playwright'.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-011.
 *
 * D-007 fail-soft contract — identical to the Vitest reporter:
 *   - 1s connect timeout
 *   - swallow every PG / git / fs error
 *   - never throw out of any hook
 *   - never write to stderr/stdout in a way that taints test output
 *   - never affect the process exit code
 *
 * Wire-up: apps/operator/playwright.config.ts adds this reporter to
 * its `reporter` array. Opt-out via PAPERCUSP_DISABLE_TEST_RUNS_REPORTER=1.
 *
 * Playwright reporter API: implement onBegin/onTestEnd/onEnd. Each
 * spec file's per-test results aggregate into one row (status=fail
 * if any test failed, pass if all passed).
 */

import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { resolveGitContext } from '@papercusp/operator-core/lib/testing-branch-resolve';
import { resolveAgentWorkspaceRoot } from '@papercusp/operator-core/lib/agent-tools/capability/base-dir';
import { resolveTestRunSource } from '@papercusp/operator-core/lib/testing-run-source';
import { posix, relative } from 'node:path';

interface TestRunRow {
  filePath: string;
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // This reporter is a child process. Its event loop is mostly idle while
  // Playwright workers run, so it cannot measure the operator host loop used
  // by testing:runs' critical-band classifier. Persist no false-provenance
  // sample; the reader will expose saturationSuspect as unknown.
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms: null, rssMb };
}

function toWorkspaceRel(absPath: string): string {
  const rel = relative(resolveAgentWorkspaceRoot({}), absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

async function tryGetPg(): Promise<{
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
} | null> {
  try {
    const pg = (await import('postgres')).default;
    const url =
      process.env.HARNESS_ADMIN_DATABASE_URL ??
      process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
      'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
    const sql = pg(url, {
      max: 1,
      connect_timeout: 1,
      idle_timeout: 1,
      max_lifetime: 5,
      onnotice: () => {},
    });
    return { sql } as unknown as {
      sql: (strings: TemplateStringsArray, ...vals: unknown[]) => Promise<unknown[]>;
    };
  } catch {
    return null;
  }
}

async function insertRow(row: TestRunRow): Promise<void> {
  let branch: string | null = null;
  let commit: string | null = null;
  try {
    const ctx = await resolveGitContext();
    branch = ctx.branch;
    commit = ctx.commit;
  } catch { /* fail-soft */ }

  const pg = await tryGetPg();
  if (!pg) return;

  const source = resolveTestRunSource();
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, loop_lag_p95_ms, rss_mb)
        VALUES
          (${row.filePath}, 'playwright', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${loopLagP95Ms}, ${rssMb})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

interface PerFile {
  startedAt: number;
  finishedAt: number;
  anyFail: boolean;
  anyPass: boolean;
  allSkipped: boolean;
  errors: string[];
}

export default class AdminTestRunsPlaywrightReporter implements Reporter {
  private byFile = new Map<string, PerFile>();
  private pending: Promise<void>[] = [];

  onBegin(): void {
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    try {
      if (process.env.PAPERCUSP_DISABLE_TEST_RUNS_REPORTER === '1') return;
      const file = test.location?.file;
      if (!file) return;

      const existing = this.byFile.get(file) ?? {
        startedAt: result.startTime?.getTime() ?? Date.now(),
        finishedAt: 0,
        anyFail: false,
        anyPass: false,
        allSkipped: true,
        errors: [],
      };

      const endMs = (result.startTime?.getTime() ?? Date.now()) + result.duration;
      existing.startedAt = Math.min(existing.startedAt, result.startTime?.getTime() ?? Date.now());
      existing.finishedAt = Math.max(existing.finishedAt, endMs);

      switch (result.status) {
        case 'passed':
          existing.anyPass = true;
          existing.allSkipped = false;
          break;
        case 'failed':
        case 'timedOut':
        case 'interrupted':
          existing.anyFail = true;
          existing.allSkipped = false;
          for (const e of result.errors ?? []) {
            if (e.message) existing.errors.push(e.message);
          }
          break;
        case 'skipped':
          // keep allSkipped flag until something else lands
          break;
      }

      this.byFile.set(file, existing);
    } catch {
      /* swallow — D-007 */
    }
  }

  onEnd(): void {
    try {
      for (const [file, agg] of this.byFile) {
        try {
          const filePath = toWorkspaceRel(file);
          const status: TestRunRow['status'] = agg.anyFail
            ? 'fail'
            : agg.allSkipped
            ? 'skip'
            : 'pass';
          const durationMs = Math.max(0, agg.finishedAt - agg.startedAt);
          const outputTail = agg.errors.length > 0 ? agg.errors.join('\n').slice(-4000) : null;
          this.pending.push(
            insertRow({
              filePath,
              status,
              durationMs,
              startedAt: new Date(agg.startedAt),
              finishedAt: new Date(agg.finishedAt),
              outputTail,
            }),
          );
        } catch {
          /* swallow per-file */
        }
      }
    } catch {
      /* swallow */
    }
  }

  async onExit(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow */
    }
  }
}
