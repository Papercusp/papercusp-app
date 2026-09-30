#!/usr/bin/env node
// scripts/merge-coverage.ts — P-009 part (b), plan design-to-code-coverage-seam-2026-09-02.
//
// Aggregate every workspace's `./coverage/lcov.info` (written by a
// `--coverage` run of scripts/affected-tests.mjs) into one repo-root-relative
// `coverage/lcov.info`, which `scripts/patch-coverage.ts` then judges.
//
//   npm run coverage:merge                 # walk the tree, merge, write coverage/lcov.info
//   npm run coverage:merge -- --out <path> # write elsewhere
//   npm run coverage:merge -- --json       # machine-readable summary on stdout
//
// ⛔ REFUSES WHEN IT FINDS NOTHING. Zero inputs exits 1, because writing an
// empty lcov would hand the patch gate a file that looks like a real report and
// silently makes every downstream verdict vacuous. The whole reason this plan
// item had to be re-scoped (D-028) is that a coverage gate fed by an absent
// producer goes GREEN, so every step in the chain says so out loud instead.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatLcov, mergeLcovSources, type LcovSource } from './lib/lcov-merge.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Never descend into these — they hold dependencies and build output, not sources. */
const PRUNE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.papercusp',
  '_retired',
  'target',
]);

/**
 * Every `<dir>/coverage/lcov.info` under `ROOT`, excluding the merged output
 * itself. `<dir>` is the workspace directory the record paths are relative to
 * — Vitest writes `reportsDirectory: './coverage'` relative to its root, which
 * for this repo is always the workspace directory (measured 2026-09-02).
 */
function findWorkspaceLcovFiles(outAbs: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a coverage report
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (PRUNE_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.name === 'coverage') {
        const lcov = join(child, 'lcov.info');
        if (lcov !== outAbs && existsSync(lcov)) found.push(lcov);
        continue; // a coverage dir holds no workspaces
      }
      walk(child);
    }
  };
  walk(ROOT);
  return found.sort();
}

function main(): number {
  const args = process.argv.slice(2);
  const argValue = (flag: string, fallback: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
  };
  const asJson = args.includes('--json');
  const outPath = argValue('--out', join('coverage', 'lcov.info'));
  const outAbs = resolve(ROOT, outPath);

  const lcovFiles = findWorkspaceLcovFiles(outAbs);
  if (lcovFiles.length === 0) {
    console.error(
      'merge-coverage: found NO per-workspace coverage/lcov.info under the repo root.\n' +
        '  Nothing was merged and nothing was written — an empty report would make every\n' +
        '  downstream patch-coverage verdict vacuously green (plan decision D-028).\n' +
        '  Produce coverage first:\n' +
        '    npm run test:affected -- --coverage --changed-paths <your files>',
    );
    return 1;
  }

  const sources: LcovSource[] = lcovFiles.map((file) => ({
    // <ws>/coverage/lcov.info -> <ws>
    workspaceDir: dirname(dirname(file)),
    text: readFileSync(file, 'utf8'),
  }));

  const { records, stats } = mergeLcovSources(sources, { repoRoot: ROOT });
  mkdirSync(dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, formatLcov(records), 'utf8');

  const summary = {
    out: relative(ROOT, outAbs).split(sep).join('/'),
    inputs: lcovFiles.map((f) => relative(ROOT, f).split(sep).join('/')),
    recordsRead: stats.recordsRead,
    filesOut: stats.filesOut,
    droppedOutsideRepo: stats.droppedOutsideRepo,
  };

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `COVERAGE_MERGE inputs=${summary.inputs.length} recordsRead=${stats.recordsRead} ` +
        `files=${stats.filesOut} out=${summary.out}`,
    );
    for (const input of summary.inputs) console.log(`  + ${input}`);
    if (stats.droppedOutsideRepo.length > 0) {
      console.log(
        `  note: dropped ${stats.droppedOutsideRepo.length} record(s) resolving outside the repo root ` +
          `(e.g. ${stats.droppedOutsideRepo[0]})`,
      );
    }
  }

  // A merge that read records but emitted zero files means every SF resolved
  // outside the repo — a silent no-op dressed as success. Fail on it.
  if (stats.filesOut === 0) {
    console.error(
      'merge-coverage: read records but emitted ZERO source files — every SF: path resolved\n' +
        '  outside the repo root. The output would be an empty report; refusing.',
    );
    return 1;
  }
  return 0;
}

process.exit(main());
