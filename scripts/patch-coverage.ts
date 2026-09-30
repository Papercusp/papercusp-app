#!/usr/bin/env node
// scripts/patch-coverage.ts — P-009 part (c), plan design-to-code-coverage-seam-2026-09-02.
//
// Patch coverage: of the executable lines this change ADDS, how many does the
// test suite reach? Project-wide coverage stays tracked-and-ungated per
// testing-spec §1.13; only the patch is judged.
//
//   npm run gate:patch-coverage                                # working tree + staged vs HEAD
//   npm run gate:patch-coverage -- --base <ref> --threshold 80
//   npm run gate:patch-coverage -- --diff-file <unified.diff>  # judge a precomputed diff
//   npm run gate:patch-coverage -- --json
//
// The usual sequence:
//   npm run test:affected -- --coverage --changed-paths <your files>
//   npm run coverage:merge
//   npm run gate:patch-coverage -- --base HEAD
//
// EXIT CODES — three-valued on purpose (see ./lib/patch-coverage.ts):
//   0  pass, or no coverable lines in the patch (both stated explicitly)
//   1  fail — measured patch coverage below the threshold
//   2  UNDETERMINED or misuse — no coverage data, or a changed source file that
//      no suite instrumented. Never reported as a pass: plan decision D-028
//      requires that an absent lcov be distinguishable from a covered patch,
//      because otherwise this gate goes green having measured nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexBySourceFile, parseLcov } from './lib/lcov-merge.ts';
import {
  formatVerdictLine,
  judgePatchCoverage,
  parseAddedLines,
} from './lib/patch-coverage.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_THRESHOLD_PCT = 80;

function main(): number {
  const args = process.argv.slice(2);
  const argValue = (flag: string): string | null => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  const asJson = args.includes('--json');
  const lcovPath = resolve(ROOT, argValue('--lcov') ?? 'coverage/lcov.info');
  const diffFile = argValue('--diff-file');
  const base = argValue('--base') ?? 'HEAD';
  const thresholdRaw = argValue('--threshold');
  const thresholdPct = thresholdRaw === null ? DEFAULT_THRESHOLD_PCT : Number(thresholdRaw);

  if (!Number.isFinite(thresholdPct) || thresholdPct < 0 || thresholdPct > 100) {
    console.error(`patch-coverage: --threshold must be 0-100, got "${thresholdRaw}".`);
    return 2;
  }

  // ── the diff ──────────────────────────────────────────────────────────────
  let diffText: string;
  let diffSource: string;
  if (diffFile) {
    const abs = resolve(ROOT, diffFile);
    if (!existsSync(abs)) {
      console.error(`patch-coverage: --diff-file "${diffFile}" does not exist.`);
      return 2;
    }
    diffText = readFileSync(abs, 'utf8');
    diffSource = `file:${diffFile}`;
  } else {
    try {
      // --unified=0 keeps added-line numbers exact with no context to walk past.
      diffText = execFileSync(
        'git',
        ['diff', '--unified=0', '--no-color', '--no-ext-diff', base, '--'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      );
      diffSource = `git-diff:${base}`;
    } catch (error) {
      console.error(
        `patch-coverage: \`git diff ${base}\` failed — ${(error as Error).message}\n` +
          '  Pass an existing ref with --base, or a precomputed diff with --diff-file.',
      );
      return 2;
    }
  }

  const changed = parseAddedLines(diffText);
  if (changed.size === 0) {
    // An empty diff is a real, honest answer — but say which base produced it,
    // so "nothing changed" is never confused with "the base was wrong".
    console.log(
      `PATCH_COVERAGE status=no-coverable-lines percent=n/a covered=0 uncovered=0 ` +
        `files=0 unmeasured=0 threshold=${thresholdPct}%`,
    );
    console.log(`  the diff (${diffSource}) adds no lines — nothing to judge.`);
    return 0;
  }

  // ── the coverage ──────────────────────────────────────────────────────────
  // A MISSING lcov is not an empty one: it means the producer never ran, which
  // is precisely the state that would make this gate vacuous. Refuse, loudly.
  if (!existsSync(lcovPath)) {
    console.error(
      `patch-coverage: no merged coverage report at ${lcovPath}.\n` +
        '  UNDETERMINED, not a pass — with no lcov, "no uncovered changed lines" is\n' +
        '  indistinguishable from "nothing was measured" (plan decision D-028).\n' +
        '  Produce and merge it first:\n' +
        '    npm run test:affected -- --coverage --changed-paths <your files>\n' +
        '    npm run coverage:merge',
    );
    return 2;
  }

  const coverage = indexBySourceFile(parseLcov(readFileSync(lcovPath, 'utf8')));
  const verdict = judgePatchCoverage({ changed, coverage, thresholdPct });

  if (asJson) {
    console.log(JSON.stringify({ diffSource, lcov: lcovPath, ...verdict }, null, 2));
  } else {
    console.log(formatVerdictLine(verdict));
    console.log(`  diff=${diffSource} lcov=${lcovPath}`);
    for (const note of verdict.notes) console.log(`  ${note}`);
    if (verdict.uncovered.length > 0) {
      console.log('  uncovered added lines:');
      for (const { file, line } of verdict.uncovered.slice(0, 100)) {
        console.log(`    ${file}:${line}`);
      }
      if (verdict.uncovered.length > 100) {
        console.log(`    … and ${verdict.uncovered.length - 100} more`);
      }
    }
  }

  if (verdict.status === 'undetermined') return 2;
  if (verdict.status === 'fail') return 1;
  return 0;
}

process.exit(main());
