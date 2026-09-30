/**
 * stats-proof.ts — print the measured stat block behind the pitch deck.
 *
 *   npm run stats:proof            # human-readable block
 *   npm run stats:proof -- --json  # machine-readable, for a slide generator
 *
 * WHY (WI-35490): the deck claims "every figure is measured from the repository and
 * the live database, and reproducible on request." Nothing delivered that, so the
 * figures were rebuilt by hand each time — and slide 11 shipped
 * `113,527 COORDINATION EVENTS / ALL TIME` over a retention-swept table, which
 * re-measures LOWER. This command is the artifact that makes the promise true, and
 * `lib/stat-proof-block.ts` holds the guard that makes the bad shape
 * unrepresentable rather than merely corrected once.
 *
 * TWO MEASUREMENT DISCIPLINES WORTH KEEPING
 *
 * 1. Lines are counted IN THIS PROCESS, not by shelling to `xargs wc -l`. With
 *    ~11.5k files, xargs splits into several batches and emits one "total" PER
 *    BATCH, so the familiar `| tail -1` reads only the LAST batch's subtotal and
 *    silently under-reports by millions. That mistake produced a wrong line count
 *    during this very investigation, so the fix does not get to depend on it.
 *
 * 2. Retention horizons are IMPORTED from the GC modules that enforce them, never
 *    restated here. Retune retention and this command's output follows; restate it
 *    and the two drift, which is how the bad tile happened.
 *
 * Scope is stated per figure rather than assumed. The deck's work-item figure was
 * harness-scoped, so this keeps that basis — a trend line is only meaningful if the
 * denominator stays put, and quietly widening a scope invites exactly the "did you
 * change the basis to look better?" reading this command exists to prevent.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { NOTIFY_GC_RETENTION_DAYS } from '../packages/operator-core/lib/agent-tools/coordination/notify-gc';
import {
  MESSAGE_GC_RETENTION_DAYS,
  FEDERATED_MESSAGE_GC_RETENTION_DAYS,
} from '../packages/operator-core/lib/agent-tools/coordination/message-log-gc';
import { ESCALATION_GC_RETENTION_DAYS } from '../packages/operator-core/lib/agent-tools/coordination/escalation-log-gc';
import {
  renderStatBlock,
  type LedgerFigure,
} from '../packages/operator-core/lib/stat-proof-block';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every horizon known to sweep coord_event_log, from the GCs that enforce them. */
const COORD_EVENT_LOG_HORIZONS_DAYS = [
  NOTIFY_GC_RETENTION_DAYS,
  FEDERATED_MESSAGE_GC_RETENTION_DAYS,
  ESCALATION_GC_RETENTION_DAYS,
  MESSAGE_GC_RETENTION_DAYS,
];

/** The workspace/harness the published figures describe. */
const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';

/** Trailing window for rate figures. */
const WINDOW_DAYS = 7;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Tracked files matching the given pathspecs, excluding retired code.
 *
 * `--recurse-submodules` IS LOAD-BEARING, not a nicety. This repo has 39
 * submodules holding a large share of the code (all of `libs/generic/*`, all of
 * `libs/papercusp/*`), and a plain `git ls-files` lists a submodule as a single
 * gitlink entry — it silently omits every file inside. Measuring without it
 * undercounts the tree by well over a thousand files and reports 0 migrations and
 * 0 blueprints (both live in submodules), which is exactly the wrong answer with a
 * confident face on it. Verified 2026-08-08: 11,500 files without, 12,729 with.
 */
function trackedFiles(patterns: string[]): string[] {
  return git('ls-files', '--recurse-submodules', '-z', ...patterns)
    .split('\0')
    .filter(
      (f) =>
        f.length > 0 &&
        !f.startsWith('_retired/') &&
        // Vendored third-party forks (tao / wry / tauri-runtime-wry) are carried in
        // tree but are not our work — counting them would overstate authored volume,
        // which is the one direction a proof artifact must never err in.
        !f.includes('/vendor/'),
    )
    // WI-10004176: drop index entries a plain `rm` left behind until git-sync commits it.
    .filter((f) => existsSync(join(REPO_ROOT, f)));
}

/**
 * Superproject-only file listing — what a plain `git ls-files` sees.
 *
 * Kept solely to report basis CONTINUITY: the previously published 2.37M was
 * measured this way (submodule contents invisible). Without stating that, the
 * corrected full-tree figure looks like sudden growth, and "the number jumped after
 * he re-measured it" is exactly the reading this whole command exists to prevent.
 */
function superprojectOnlyFiles(patterns: string[]): string[] {
  return git('ls-files', '-z', ...patterns)
    .split('\0')
    .filter((f) => f.length > 0 && !f.startsWith('_retired/') && !f.includes('/vendor/'))
    .filter((f) => existsSync(join(REPO_ROOT, f)));
}

/**
 * Total newline count across `files` — matching `wc -l` semantics exactly (it
 * counts newline BYTES, so a file with no trailing newline reports one fewer line
 * than it has visually). Counted here rather than shelled out; see header note 1.
 */
function countLines(files: string[]): number {
  let total = 0;
  for (const rel of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(REPO_ROOT, rel));
    } catch {
      continue; // tracked but absent (submodule gitlink, sparse checkout)
    }
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) total++;
  }
  return total;
}

/**
 * The repository's root commit, as both an instant (for arithmetic) and the date as
 * it reads in the AUTHOR'S timezone (for display).
 *
 * The two differ here and it matters: the root commit is 2026-04-06T21:58:03-04:00,
 * so a UTC render prints 2026-04-07 and contradicts every deck and bio that says
 * 6 April — over four minutes of timezone offset.
 */
function firstCommit(): { at: Date; label: string } {
  const out = git('log', '--reverse', '--format=%aI', '--max-parents=0').trim();
  const first = out.split('\n')[0]?.trim();
  if (!first) throw new Error('could not resolve the repository first-commit date');
  return { at: new Date(first), label: first.slice(0, 10) };
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const measuredAt = new Date();

  // ---- repository figures -------------------------------------------------
  const tsFiles = trackedFiles(['*.ts', '*.tsx']);
  const testFiles = trackedFiles(['*.test.ts', '*.test.tsx', '*.spec.ts']);
  const rustFiles = trackedFiles(['*.rs']).filter((f) => !f.includes('vendor'));

  const totalLines = countLines(tsFiles);
  const testLines = countLines(testFiles);
  const rustLines = countLines(rustFiles);

  // Basis-continuity comparison only — see superprojectOnlyFiles().
  const superprojectTs = superprojectOnlyFiles(['*.ts', '*.tsx']);
  const superprojectFiles = superprojectTs.length;
  const superprojectLines = countLines(superprojectTs);
  // LIVE numbered migrations only. Two traps here, both of which inflate the figure:
  // the directory holds non-migration helper SQL, and `sql/archive/` holds 117
  // RETIRED migrations under the same `NNN-slug.sql` naming. Anchoring on `/sql/`
  // immediately followed by digits admits the direct children and excludes the
  // archive — 630, matching the working tree, against 747 for a looser match.
  const migrations = trackedFiles(['libs/papercusp/libs/db/sql/*.sql']).filter((f) =>
    /\/sql\/\d{3,}-[^/]*\.sql$/.test(f),
  ).length;
  const blueprints = new Set(
    trackedFiles(['libs/papercusp/packages/harness/blueprints/*'])
      .map((f) => f.split('/')[5])
      .filter(Boolean),
  ).size;

  const catalog = JSON.parse(
    readFileSync(join(REPO_ROOT, '.papercusp/tool-catalog.json'), 'utf8'),
  ) as { count?: number; tools: Array<{ name: string }> };
  const tools = catalog.count ?? catalog.tools.length;
  const toolGroups = new Set(catalog.tools.map((t) => t.name.split(':')[0])).size;

  // ---- live ledger figures ------------------------------------------------
  const sql = postgres(getHarnessAdminUrl(), { max: 1, idle_timeout: 5 });
  let ledger: LedgerFigure[];
  try {
    const [row] = await sql<
      Array<{
        tool_calls: string;
        agents: string;
        coord_events: string;
        work_items: string;
        work_items_terminal: string;
        work_items_oldest: Date | null;
        harnesses: string;
      }>
    >`
      SELECT
        (SELECT count(*) FROM harness_shared.tool_invocations
          WHERE workspace_id = ${WORKSPACE}
            AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
            AND invoked_at > now() - make_interval(days => ${WINDOW_DAYS})) AS tool_calls,
        (SELECT count(DISTINCT coord_owner_id) FROM harness_shared.tool_invocations
          WHERE workspace_id = ${WORKSPACE}
            AND harness_shared.is_agent_coord_owner_id(coord_owner_id, role)
            AND invoked_at > now() - make_interval(days => ${WINDOW_DAYS})) AS agents,
        (SELECT count(*) FROM harness_shared.coord_event_log
          WHERE workspace_id = ${WORKSPACE}
            AND ts > now() - make_interval(days => ${WINDOW_DAYS})) AS coord_events,
        (SELECT count(*) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}) AS work_items,
        (SELECT count(*) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
            AND status IN ('done','resolved','passed','closed')) AS work_items_terminal,
        (SELECT to_timestamp(min(created_ts) / 1000.0) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
            AND created_ts > 0) AS work_items_oldest,
        (SELECT count(DISTINCT harness_slug) FROM harness_shared.work_items
          WHERE workspace_id = ${WORKSPACE}) AS harnesses
    `;

    const fc = firstCommit();
    const wiOldest = row.work_items_oldest ?? fc.at;

    ledger = [
      {
        id: 'tool-calls',
        label: 'AGENT TOOL CALLS',
        value: Number(row.tool_calls),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.tool_invocations (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [], // not swept
      },
      {
        id: 'distinct-agents',
        label: 'DISTINCT AGENTS',
        value: Number(row.agents),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.tool_invocations (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [],
      },
      {
        id: 'work-items',
        label: 'WORK ITEMS IN THE LEDGER',
        value: Number(row.work_items),
        window: {
          kind: 'since-observed',
          oldestRow: wiOldest,
          // Tolerance: the ledger cannot predate the repo, so "reaches first
          // commit" means its oldest row is at/near the first commit.
          reachesProjectStart: wiOldest.getTime() - fc.at.getTime() < 14 * 86_400_000,
        },
        sourceTable: `harness_shared.work_items (harness=${HARNESS})`,
        retentionHorizonsDays: [],
      },
      {
        id: 'work-items-terminal',
        label: 'WORK ITEMS DRIVEN TO DONE',
        value: Number(row.work_items_terminal),
        window: {
          kind: 'since-observed',
          oldestRow: wiOldest,
          reachesProjectStart: wiOldest.getTime() - fc.at.getTime() < 14 * 86_400_000,
        },
        sourceTable: `harness_shared.work_items (harness=${HARNESS})`,
        retentionHorizonsDays: [],
      },
      {
        // The figure that was published wrong. It is a swept table, so the guard
        // forces a trailing window; wider than the 3d notify horizon, so a FLOOR.
        id: 'coord-events',
        label: 'COORDINATION EVENTS',
        value: Number(row.coord_events),
        window: { kind: 'trailing', days: WINDOW_DAYS },
        sourceTable: `harness_shared.coord_event_log (workspace=${WORKSPACE})`,
        retentionHorizonsDays: COORD_EVENT_LOG_HORIZONS_DAYS,
      },
      {
        id: 'harnesses',
        label: 'DISTINCT WORK CONTEXTS',
        value: Number(row.harnesses),
        window: { kind: 'repo-snapshot' },
        sourceTable: `harness_shared.work_items (workspace=${WORKSPACE})`,
        retentionHorizonsDays: [],
      },
    ];

    const out = renderStatBlock({
      measuredAt,
      firstCommit: fc.at,
      firstCommitLabel: fc.label,
      repo: {
        totalLines,
        totalFiles: tsFiles.length,
        testLines,
        testFiles: testFiles.length,
        rustLines,
        migrations,
        tools,
        toolGroups,
        blueprints,
        basis:
          `git-tracked TypeScript across the superproject AND all 39 submodules, ` +
          `excluding _retired/ and vendored forks (git ls-files --recurse-submodules; ` +
          `newlines counted in-process). ` +
          `For continuity with previously published figures: the superproject alone ` +
          `(what a plain git ls-files sees, submodule contents invisible) is ` +
          `${superprojectLines.toLocaleString('en-US')} lines across ` +
          `${superprojectFiles.toLocaleString('en-US')} files — the earlier 2.37M was ` +
          `measured on THAT basis, so the difference is a corrected denominator, not growth`,
      },
      ledger,
    });

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            measuredAt: measuredAt.toISOString(),
            firstCommit: fc.at.toISOString(),
            firstCommitLabel: fc.label,
            repo: {
              totalLines,
              totalFiles: tsFiles.length,
              testLines,
              testFiles: testFiles.length,
              rustLines,
              migrations,
              tools,
              toolGroups,
              blueprints,
            },
            figures: out.figures,
            warnings: out.warnings,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(out.text);
      if (out.warnings.length > 0) {
        console.log('NOTES');
        console.log('-'.repeat(72));
        for (const w of out.warnings) console.log(`  ${w}`);
        console.log('');
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  // A guard failure must fail the COMMAND — a bad figure never reaches a slide.
  console.error(`\nstats:proof FAILED\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
