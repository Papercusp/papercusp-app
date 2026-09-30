#!/usr/bin/env tsx
/**
 * measure-launch-cost — the committed baseline instrument for plan
 * `agent-launch-context-cost-2026-09-18` (P-001).
 *
 * Answers ONE question, re-runnably: **what does a Claude session pay in prompt tokens before it
 * does any work, and how is that trending?** Every later item in that plan is graded by re-running
 * this exact command, which is why it is a committed script with tests rather than an ad-hoc
 * `node -e` whose definition of "launch cost" drifts between invocations.
 *
 *   npm run measure:launch-cost
 *   npm run measure:launch-cost -- --owner-prefix su- --since 2026-09-01
 *   npm run measure:launch-cost -- --target 120000 --require-samples   # acceptance gate form
 *   npm run measure:launch-cost -- --json > /tmp/launch-cost.json
 *
 * ⚠ READ THE SKIP CENSUS, NOT JUST THE MEDIAN. `filesScanned` vs `filesMeasured` is printed on
 * every run precisely because a shrinking median and a shrinking *sample set* look identical in
 * the headline number. A median over 3 files is not a fleet measurement.
 *
 * Definitions are documented in `packages/operator-core/lib/launch-cost/launch-cost-metrics.ts`;
 * the streaming requirement (a ~580 KB first line hides the usage row from any bounded read) is
 * documented and tested in `scan-launch-transcripts.ts`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  summarizeByDay,
  summarizeOverall,
  type DayStats,
  type LaunchStats,
} from '../packages/operator-core/lib/launch-cost/launch-cost-metrics';
import {
  scanLaunchTranscripts,
  type ScanOptions,
  type ScanReport,
  type SkipReason,
} from '../packages/operator-core/lib/launch-cost/scan-launch-transcripts';

const USAGE = `measure-launch-cost — per-day median/p10/p90 first-turn prompt tokens for Claude sessions

Options:
  --root <dir>            Transcript root (default ~/.papercusp/session-claude)
  --since <YYYY-MM-DD>    Inclusive UTC lower bound on the measured day
  --until <YYYY-MM-DD>    Inclusive UTC upper bound on the measured day
  --owner-prefix <s>      Keep only owners whose id starts with <s> (e.g. su-)
  --model <substr>        Keep only samples whose model contains <substr> (e.g. opus)
  --min-tokens <n>        Floor below which a usage row is not a launch turn (default 1000)
  --include-sidechains    Count sub-agent turns too (off by default)
  --concurrency <n>       Files read in parallel (default 8)
  --days <n>              Show only the most recent <n> days in the table
  --target <n>            Compare the overall median against <n> and print PASS/FAIL
  --require-samples       Exit non-zero when zero samples were measured
  --json                  Emit machine-readable JSON instead of the table
  --help                  This text

Exit codes: 0 ok · 1 --target missed or --require-samples with no samples · 2 bad usage`;

type Cli = ScanOptions & {
  json: boolean;
  days: number | null;
  target: number | null;
  requireSamples: boolean;
};

function parseArgs(argv: readonly string[]): Cli | 'help' {
  const cli: Cli = {
    root: join(homedir(), '.papercusp', 'session-claude'),
    json: false,
    days: null,
    target: null,
    requireSamples: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--root':
        cli.root = next();
        break;
      case '--since':
        cli.since = next();
        break;
      case '--until':
        cli.until = next();
        break;
      case '--owner-prefix':
        cli.ownerPrefix = next();
        break;
      case '--model':
        cli.modelContains = next();
        break;
      case '--min-tokens':
        cli.minPromptTokens = Number(next());
        break;
      case '--include-sidechains':
        cli.includeSidechains = true;
        break;
      case '--concurrency':
        cli.concurrency = Number(next());
        break;
      case '--days':
        cli.days = Number(next());
        break;
      case '--target':
        cli.target = Number(next());
        break;
      case '--require-samples':
        cli.requireSamples = true;
        break;
      case '--json':
        cli.json = true;
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  for (const [name, value] of [
    ['--min-tokens', cli.minPromptTokens],
    ['--concurrency', cli.concurrency],
    ['--days', cli.days],
    ['--target', cli.target],
  ] as const) {
    if (value !== undefined && value !== null && !Number.isFinite(value)) {
      throw new Error(`${name} must be a number`);
    }
  }
  return cli;
}

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const pad = (text: string, width: number): string => text.padStart(width);

function renderTable(days: readonly DayStats[]): string {
  const header = [
    pad('day', 10),
    pad('n', 5),
    pad('p10', 9),
    pad('median', 9),
    pad('p90', 9),
    pad('med cacheRead', 14),
    pad('med cacheCreate', 16),
  ].join('  ');
  const rows = days.map((d) =>
    [
      pad(d.day, 10),
      pad(String(d.count), 5),
      pad(n(d.p10Total), 9),
      pad(n(d.medianTotal), 9),
      pad(n(d.p90Total), 9),
      pad(n(d.medianCacheRead), 14),
      pad(n(d.medianCacheCreation), 16),
    ].join('  '),
  );
  return [header, '-'.repeat(header.length), ...rows].join('\n');
}

function renderSkipCensus(report: ScanReport): string {
  const entries = (Object.entries(report.skippedByReason) as [SkipReason, number][])
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return entries.length > 0 ? entries.join(' ') : 'none';
}

function renderOverall(stats: LaunchStats): string {
  return [
    `  count            ${n(stats.count)}`,
    `  median total     ${n(stats.medianTotal)}`,
    `  p10 / p90        ${n(stats.p10Total)} / ${n(stats.p90Total)}`,
    `  min / max        ${n(stats.minTotal)} / ${n(stats.maxTotal)}`,
    `  median cacheRead ${n(stats.medianCacheRead)}   (the stable cached prefix: tools)`,
    `  median cacheCrea ${n(stats.medianCacheCreation)}   (freshly written: system prompt + first message)`,
  ].join('\n');
}

async function main(): Promise<number> {
  let cli: Cli | 'help';
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`measure-launch-cost: ${error instanceof Error ? error.message : error}`);
    console.error(USAGE);
    return 2;
  }
  if (cli === 'help') {
    console.log(USAGE);
    return 0;
  }

  const report = await scanLaunchTranscripts(cli);
  const overall = summarizeOverall(report.samples);
  let days = summarizeByDay(report.samples);
  if (cli.days !== null && cli.days > 0) days = days.slice(-cli.days);

  if (cli.json) {
    console.log(
      JSON.stringify(
        {
          root: report.root,
          filters: {
            since: cli.since ?? null,
            until: cli.until ?? null,
            ownerPrefix: cli.ownerPrefix ?? null,
            modelContains: cli.modelContains ?? null,
            minPromptTokens: cli.minPromptTokens ?? null,
            includeSidechains: cli.includeSidechains ?? false,
          },
          filesScanned: report.filesScanned,
          filesMeasured: report.filesMeasured,
          skippedByReason: report.skippedByReason,
          // `overall: null` is deliberate and load-bearing: a consumer must be unable to read a
          // zero where no measurement exists.
          overall,
          days,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`root            ${report.root}`);
    console.log(`files scanned   ${n(report.filesScanned)}`);
    console.log(`files measured  ${n(report.filesMeasured)}`);
    console.log(`skipped         ${renderSkipCensus(report)}`);
    console.log('');
    if (overall === null) {
      // Never print a number here. See the honesty rails in launch-cost-metrics.ts.
      console.log('NO SAMPLES MEASURED — no median is defined. Check --root and the filters above;');
      console.log('a zero-sample run is not a zero-cost fleet.');
    } else {
      console.log(renderTable(days));
      console.log('');
      console.log('overall');
      console.log(renderOverall(overall));
      if (overall.incompleteCount) {
        console.log(`INCOMPLETE USAGE: ${overall.incompleteCount} sample(s); numeric totals are known lower bounds, not complete prompt counts.`);
      }
    }
  }

  if (cli.requireSamples && overall === null) {
    console.error('measure-launch-cost: --require-samples set but zero samples were measured');
    return 1;
  }
  if (cli.target !== null && overall !== null) {
    if (overall.incompleteCount === undefined || overall.incompleteCount > 0) {
      console.error('UNKNOWN target result: incomplete usage counts cannot establish a passing launch-cost target.');
      return 1;
    }
    const pass = overall.medianTotal <= cli.target;
    const line = `${pass ? 'PASS' : 'FAIL'} median ${n(overall.medianTotal)} vs target ${n(cli.target)} (n=${n(overall.count)})`;
    if (cli.json) console.error(line);
    else console.log(`\n${line}`);
    if (!pass) return 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error('measure-launch-cost failed:', error);
    process.exitCode = 2;
  },
);
