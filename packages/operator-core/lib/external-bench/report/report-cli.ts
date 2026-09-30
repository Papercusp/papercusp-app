/**
 * CLI: emit a portable `report-<runId>.html` for ANY recorded benchmark run (plan
 * benchmark-report-portable-trace-2026-06-17, P-001). The auto-emit hook in
 * `recordRunCompletion` covers runs that finish through the L2 bench-run path; this gives an
 * on-demand path for any run that has `benchmark_run_result` rows (e.g. a suite runner that only
 * writes L1 results). Builds from the live store via {@link emitReport} — no run re-execution.
 *
 *   npx tsx packages/operator-core/lib/external-bench/report/report-cli.ts <runId> \
 *     [--out <dir>] [--workspace <slug>] [--attribution] [--control <arm>]
 *
 * With no <runId>, lists the most-recent run ids in the result table so you can pick one.
 *
 * `--attribution` ALSO writes a `attribution-<runId>.md` — the per-capability "which capability lifted
 * which suite/task, at what cost" headline (plan P-011; vanilla-vs-+memory/+coord/ours over the stored
 * rows). `--control <arm>` overrides the default `vanilla` control. Suites without the control arm are
 * listed as skipped, not silently dropped.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { emitReport } from './report-builder-pg';
import { buildRunCapabilityAttribution, formatRunAttributionMarkdown } from './capability-attribution-report';
import { resolveDb } from '../reproducibility/db';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function listRecent(workspace?: string): Promise<void> {
  const { sql } = resolveDb(workspace ? { workspace } : {});
  const rows = (await sql`
    SELECT run_id, suite, count(*)::int n, max(created_at) last
    FROM harness_shared.benchmark_run_result
    GROUP BY run_id, suite ORDER BY max(created_at) DESC LIMIT 20`) as Array<{
    run_id: string;
    suite: string;
    n: number;
    last: Date | string;
  }>;
  if (!rows.length) {
    console.error('no runs found in harness_shared.benchmark_run_result');
    return;
  }
  console.error('recent runs (pass one as <runId>):');
  for (const r of rows) {
    const last = (r.last as Date)?.toISOString?.() ?? String(r.last);
    console.error(`  ${r.run_id}  suite=${r.suite}  rows=${r.n}  last=${last}`);
  }
}

const runId = process.argv.slice(2).find((a) => !a.startsWith('--') && a !== process.argv[1]);
const workspace = arg('workspace');
const outDir = arg('out');

if (!runId) {
  await listRecent(workspace);
  process.exit(1);
}

const path = await emitReport(runId, { workspace, outDir });
if (path) {
  console.log(`wrote ${path}`);
} else {
  console.error(`no benchmark_run_result rows for run "${runId}" — nothing to report`);
  process.exit(2);
}

// --attribution: also write the per-capability attribution headline as markdown.
if (process.argv.includes('--attribution')) {
  const control = arg('control');
  const run = await buildRunCapabilityAttribution(runId, {
    workspace,
    ...(control ? { attribution: { control } } : {}),
  });
  if (!run) {
    console.error(`no rows for run "${runId}" — no attribution`);
    process.exit(2);
  }
  const dir = outDir ?? join(homedir(), '.papercusp', 'bench-results', 'reports');
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, `attribution-${runId}.md`);
  writeFileSync(mdPath, formatRunAttributionMarkdown(run), 'utf8');
  console.log(`wrote ${mdPath}`);
}

process.exit(0);
