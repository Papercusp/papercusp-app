/**
 * admin-test-runs-reporter.ts — custom Vitest reporter that writes
 * one row per test FILE to harness_shared.test_runs.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-010.
 *
 * Powers the /admin/testing status chip (P-013) without parsing
 * Vitest output — we tap the reporter API directly. Playwright and
 * Cargo get parallel reporters in P-011 and P-012.
 *
 * D-007 fail-soft contract — LOAD-BEARING:
 *   - 1s connect timeout
 *   - swallow every PG / git / fs error
 *   - never throw out of any hook
 *   - never write to stderr/stdout in a way that taints test output
 *   - never affect the process exit code
 *
 * Tests can run with the embedded DB down, with the table missing,
 * offline, in cold contributor checkouts — none of those scenarios
 * change a single test outcome.
 *
 * Vitest 4 API: onTestRunEnd(testModules, unhandledErrors, reason).
 * Older onFinished/onTaskUpdate names from Vitest 1-3 are NOT called.
 */

import type { Reporter, TestModule, Vitest } from 'vitest/node';
import { resolveGitContext } from '@papercusp/operator-core/lib/testing-branch-resolve';
import { resolveAgentWorkspaceRoot } from '@papercusp/operator-core/lib/agent-tools/capability/base-dir';
import { resolveTestRunSource } from '@papercusp/operator-core/lib/testing-run-source';
import { posix, relative } from 'node:path';

interface TestRunRow {
  filePath: string;        // workspace-relative POSIX
  status: 'pass' | 'fail' | 'skip' | 'cancelled' | 'error';
  durationMs: number;
  startedAt: Date;
  finishedAt: Date;
  outputTail: string | null;
}

function captureReporterSaturationSnapshot(): { loopLagP95Ms: number | null; rssMb: number | null } {
  // This reporter is a child process. Its event loop is mostly idle while
  // Vitest workers run, so its histogram cannot measure the operator host
  // loop used by testing:runs' critical-band classifier. Persisting that
  // local value creates a confident-looking but structurally invalid signal.
  let rssMb: number | null = null;
  try {
    rssMb = Math.round((process.memoryUsage().rss / 1_048_576) * 10) / 10;
  } catch {
    rssMb = null;
  }
  return { loopLagP95Ms: null, rssMb };
}

function toWorkspaceRel(absPath: string): string {
  const root = resolveAgentWorkspaceRoot({});
  const rel = relative(root, absPath);
  return rel.split(/[/\\]/).join(posix.sep);
}

/**
 * Roll up per-module status from the Vitest 4 TestModule:
 *   passed → 'pass'
 *   failed → 'fail'
 *   skipped → 'skip'
 *   pending/queued → 'error' (module never finished — treat as error)
 */
function moduleStatus(m: TestModule): TestRunRow['status'] {
  let state: string;
  try {
    state = m.state();
  } catch {
    return 'error';
  }
  switch (state) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'skip';
    default:
      return 'error';
  }
}

type VitestErrorRecord = {
  message?: unknown;
  stack?: unknown;
  stacks?: unknown;
};

function asErrorRecord(value: unknown): VitestErrorRecord | null {
  return value !== null && typeof value === 'object' ? (value as VitestErrorRecord) : null;
}

function normalizedPath(value: string): string {
  return value.replace(/^file:\/\//, '').replace(/\\/g, '/');
}

function isTestFilePath(value: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+:\d+)?(?:\)?$|\?)/.test(value);
}

function sameModulePath(candidate: string, moduleId: string): boolean {
  const left = normalizedPath(candidate);
  const right = normalizedPath(moduleId);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function structuredErrorLocation(
  record: VitestErrorRecord | null,
  moduleId: string,
  displayPath: string,
): string | null {
  if (!Array.isArray(record?.stacks)) return null;
  const frames = record.stacks.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object');
  const usable = frames.filter(
    (entry) =>
      typeof entry.file === 'string' &&
      typeof entry.line === 'number' &&
      Number.isFinite(entry.line) &&
      typeof entry.column === 'number' &&
      Number.isFinite(entry.column),
  );
  const chosen =
    usable.find((entry) => sameModulePath(String(entry.file), moduleId)) ??
    usable.find((entry) => isTestFilePath(String(entry.file))) ??
    usable[0];
  if (!chosen) return null;
  const file = sameModulePath(String(chosen.file), moduleId) ? displayPath : String(chosen.file);
  return `❯ ${file}:${chosen.line}:${chosen.column}`;
}

function textualErrorLocation(
  record: VitestErrorRecord | null,
  error: unknown,
  moduleId: string,
  displayPath: string,
): string | null {
  const stack =
    typeof record?.stack === 'string'
      ? record.stack
      : error instanceof Error && typeof error.stack === 'string'
        ? error.stack
        : null;
  if (!stack) return null;
  const lines = stack
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const moduleLine = lines.find((line) => normalizedPath(line).includes(normalizedPath(moduleId)));
  const chosen = moduleLine ?? lines.find((line) => isTestFilePath(line));
  if (!chosen) return null;
  const withoutPrefix = chosen.replace(/^(?:at|❯)\s+/, '');
  const displayed = moduleLine ? withoutPrefix.replace(moduleId, displayPath) : withoutPrefix;
  return `❯ ${displayed}`;
}

/**
 * Preserve the two diagnostic facts a red-test investigator needs: the assertion
 * message and the first frame pointing back into the failing test module. Vitest 4
 * hands reporters serialized errors, so `instanceof Error` alone is insufficient.
 */
export function formatVitestErrorForOutput(
  error: unknown,
  moduleId: string,
  displayPath = moduleId,
): string {
  try {
    const record = asErrorRecord(error);
    const message =
      error instanceof Error
        ? error.message
        : typeof record?.message === 'string'
          ? record.message
          : String(error);
    const location =
      structuredErrorLocation(record, moduleId, displayPath) ??
      textualErrorLocation(record, error, moduleId, displayPath);
    if (!location || message.includes(location.replace(/^❯\s+/, ''))) return message;
    return `${message}\n${location}`;
  } catch {
    return '[unreadable Vitest error]';
  }
}

/** Module collection errors plus failed assertion errors, without trusting either one alone. */
export function collectVitestModuleErrors(testModule: TestModule): unknown[] {
  const errors: unknown[] = [];
  try {
    errors.push(...(testModule.errors?.() ?? []));
  } catch {
    /* fail-soft — D-007 */
  }
  try {
    for (const test of testModule.children.allTests()) {
      try {
        const result = test.result();
        if (result.state === 'failed') errors.push(...result.errors);
      } catch {
        /* one malformed test result must not suppress the other failures */
      }
    }
  } catch {
    /* fail-soft — D-007 */
  }
  return errors;
}

export function formatVitestOutputTail(
  errors: readonly unknown[],
  moduleId: string,
  displayPath = moduleId,
): string | null {
  const snippets: string[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const snippet = formatVitestErrorForOutput(error, moduleId, displayPath);
    if (!snippet || seen.has(snippet)) continue;
    seen.add(snippet);
    snippets.push(snippet);
  }
  return snippets.length > 0 ? snippets.join('\n').slice(-4000) : null;
}

type PgSql = ((strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>) & {
  end(opts?: { timeout?: number }): Promise<unknown>;
};
type PgHandle = { sql: PgSql } | null;

// ONE shared pg client reused for EVERY per-file insert across the whole run,
// memoized as a PROMISE so the fire-and-forget per-file inserts (onTestModuleEnd)
// can't race into creating multiple clients. The original design opened a fresh
// short-lived client per file; at scale that exhausted PG's connection slots —
// operator-core runs ~950 files, and on a box near max_connections a DB-touching
// test (adv-roster's listPendingWorkbenchLaunches) then hit "no connection slots",
// which logged a warn that vitest-fail-on-console turned into a failure. Closed in
// onTestRunEnd/onExit.
let _pgPromise: Promise<PgHandle> | undefined;

function tryGetPg(): Promise<PgHandle> {
  if (_pgPromise) return _pgPromise;
  _pgPromise = (async (): Promise<PgHandle> => {
    try {
      const mod = (await import('postgres')) as { default?: unknown };
      const pg = (mod.default ?? mod) as (url: string, opts: Record<string, unknown>) => PgSql;
      const url =
        process.env.HARNESS_ADMIN_DATABASE_URL ??
        process.env.PAPERCUSP_TEST_RUNS_DB_URL ??
        'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
      // Tiny long-lived pool (≤2 conns) reused for the run. 1s connect timeout
      // per D-007 fail-soft. No idle/lifetime churn — closed explicitly at end.
      const sql = pg(url, {
        max: 2,
        connect_timeout: 1,
        onnotice: () => {},
        // Silence postgres internal warnings — the reporter MUST stay quiet.
      });
      return { sql };
    } catch (e) {
      if (process.env.PAPERCUSP_DEBUG_REPORTER) {
        const fs = await import('node:fs');
        fs.appendFileSync('/tmp/_rep_dbg', `${new Date().toISOString()} tryGetPg-fail: ${e instanceof Error ? e.message : String(e)}\n`);
      }
      return null;
    }
  })();
  return _pgPromise;
}

async function closeSharedPg(): Promise<void> {
  const p = _pgPromise;
  _pgPromise = undefined;
  if (!p) return;
  try {
    const handle = await p;
    if (handle?.sql) await handle.sql.end({ timeout: 2 });
  } catch {
    /* swallow — D-007 */
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

  const source = resolveTestRunSource(process.env, row.filePath);
  const runGroupId = process.env.PAPERCUSP_TEST_RUN_GROUP ?? null;
  // P-007: when the dogfood run is harness-scoped (env stamped by the operator),
  // carry harness_slug/workspace_id so its rows stay consistent with the new
  // per-hive ingestion columns. NULL for a plain operator self-test run.
  const harnessSlug = process.env.PAPERCUSP_TEST_RUN_HARNESS || null;
  const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID || null;
  const { loopLagP95Ms, rssMb } = captureReporterSaturationSnapshot();

  try {
    await Promise.race([
      pg.sql`
        INSERT INTO harness_shared.test_runs
          (file_path, framework, status, duration_ms, started_at, finished_at, output_tail, run_group_id, source, branch, commit_sha, harness_slug, workspace_id, loop_lag_p95_ms, rss_mb)
        VALUES
          (${row.filePath}, 'vitest', ${row.status}, ${row.durationMs}, ${row.startedAt},
           ${row.finishedAt}, ${row.outputTail}, ${runGroupId}, ${source}, ${branch}, ${commit}, ${harnessSlug}, ${workspaceId}, ${loopLagP95Ms}, ${rssMb})
      `,
      new Promise((_, reject) => setTimeout(() => reject(new Error('pg_insert_timeout')), 1000)),
    ]).catch(() => {
      /* swallow — D-007 */
    });
  } catch {
    /* swallow — D-007 */
  }
}

export default class AdminTestRunsReporter implements Reporter {
  private pending: Promise<void>[] = [];

  onInit(_ctx: Vitest): void {
    void _ctx;
  }

  /**
   * Per-module hook — fires as each test file finishes. We fire-and-
   * forget the insert and stash the promise on `pending` so onTestRunEnd
   * can wait for all of them before letting the process exit.
   */
  onTestModuleEnd(testModule: TestModule): void {
    try {
      const filePath = toWorkspaceRel(testModule.moduleId);
      const status = moduleStatus(testModule);
      let durationMsRaw = 0;
      try {
        durationMsRaw = testModule.diagnostic().duration ?? 0;
      } catch { /* fail-soft */ }
      const finishedAt = new Date();
      const durationMs = Math.round(durationMsRaw);
      const startedAt = new Date(finishedAt.getTime() - durationMs);

      // Best-effort tail of collection errors AND failed assertions. Preserve the
      // first test-file frame: two identical assertion messages on different lines
      // point at different root causes, and message-only storage erases that fact.
      let outputTail: string | null = null;
      try {
        outputTail = formatVitestOutputTail(
          collectVitestModuleErrors(testModule),
          testModule.moduleId,
          filePath,
        );
      } catch { /* fail-soft */ }

      this.pending.push(
        insertRow({ filePath, status, durationMs, startedAt, finishedAt, outputTail }),
      );
    } catch {
      /* swallow — D-007 */
    }
  }

  async onTestRunEnd(): Promise<void> {
    try {
      // Don't block forever — give inserts up to 5s total.
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }

  async onExit(): Promise<void> {
    try {
      await Promise.race([
        Promise.allSettled(this.pending),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* swallow — D-007 */
    } finally {
      await closeSharedPg();
    }
  }
}

// All inserts share ONE pg client (see tryGetPg), closed in onTestRunEnd/onExit
// after the pending inserts settle.
