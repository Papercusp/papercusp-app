#!/usr/bin/env tsx
/**
 * Check a suite run's leak census against the ENFORCED, SHRINK-ONLY baseline
 * (plan gate-suite-speedup-2026-08-12 D-019 §3; WI-38215).
 *
 * `npm run census:leaks` REPORTS the population and always exits 0. This is the
 * gate half: it exits non-zero when something got worse, and it is the only
 * surface allowed to change `scripts/leak-census-baseline.json`.
 *
 *   npm run leaks:ratchet                          # check the default artifact dir
 *   npm run leaks:ratchet -- --dir /tmp/x          # a run you redirected
 *   npm run leaks:ratchet -- --since-minutes 90    # scope a cumulative dir to one run
 *   npm run leaks:ratchet -- --seed                # bootstrap the baseline (once)
 *   npm run leaks:ratchet -- --update              # ratchet DOWN what this run fixed
 *   npm run leaks:ratchet -- --json                # machine-readable
 *
 * ⚠ THE DEFAULT ARTIFACT DIRECTORY IS NEVER CLEANED. It accumulates every run the
 * detector has ever seen, and the census keeps each file's WORST observation
 * across the pile — so an unscoped read reports leaks at their historical
 * maximum. `--seed` REFUSES such a directory outright; the check path warns.
 *
 * Exit codes are three-valued on purpose, because "nothing was judged" is not a
 * pass and must not share an exit code with one:
 *   0  held      — the run exercised files and nothing is above baseline
 *   1  regressed — a lens on some file, or a post-mortem fire, is above baseline
 *   2  no data   — the run recorded nothing, or --update was refused
 *   3  unadopted — no baseline file exists yet, so nothing could be judged
 *
 * 3 exists for the same reason 2 does, one level up. Comparing a real run against
 * an ABSENT baseline is arithmetically identical to comparing it against an empty
 * one: every leaking file is "not in the baseline", so the honest-looking verdict
 * is `regressed` with one finding per pre-existing leak. That is absence rendered
 * as a verdict — it accuses the run of regressions that predate the baseline and
 * would send whoever wired this in to go fix leaks nobody ever promised were gone.
 * So the file's existence is checked HERE, at the boundary that knows about files;
 * compareToBaseline stays pure and keeps treating an empty baseline as empty.
 *
 * --update lowers numbers and removes entries. It cannot add one and there is no
 * flag that makes it: a newly-leaking file is a regression to fix, not a row to
 * append (see the module header for why that is the whole ratchet).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aggregateCensusDir } from '../libs/test-config/src/leak-census-aggregate.js';
import {
  compareToBaseline,
  describeStaleSpan,
  parseBaseline,
  ratchetDown,
  relativizeReport,
  renderRatchetReport,
  seedBaseline,
  serializeBaseline,
} from '../libs/test-config/src/leak-baseline.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE_PATH = join(REPO_ROOT, 'scripts', 'leak-census-baseline.json');

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

const argv = process.argv.slice(2);
const dir =
  flagValue(argv, '--dir') ??
  process.env.PAPERCUSP_LEAK_REPORT_DIR ??
  join(tmpdir(), 'papercusp-leak-reports');
const baselinePath = flagValue(argv, '--baseline') ?? DEFAULT_BASELINE_PATH;
const json = argv.includes('--json');
const update = argv.includes('--update');
const seed = argv.includes('--seed');
const sinceMinutes = Number(flagValue(argv, '--since-minutes') ?? NaN);

/**
 * A span wider than this means the artifact directory holds more than one run.
 * The default directory is never cleaned, so this is the NORMAL state of it —
 * the warning is the point, not an edge case.
 */
const MAX_SINGLE_RUN_SPAN_MS = 90 * 60_000;

// Relativized before anything is compared or written: the baseline is a
// committed document and must key on repo-relative paths, or it matches nothing
// in the release checkout or CI and every file reads as brand new.
const report = relativizeReport(
  aggregateCensusDir(dir, Number.isFinite(sinceMinutes) ? { modifiedSince: Date.now() - sinceMinutes * 60_000 } : {}),
  REPO_ROOT,
);
const staleSpan = describeStaleSpan(report, MAX_SINGLE_RUN_SPAN_MS);
const baselineExists = existsSync(baselinePath);
const baseline = parseBaseline(baselineExists ? readFileSync(baselinePath, 'utf8') : null);
const result = compareToBaseline(report, baseline);

if (seed) {
  // The one write that bakes numbers in permanently, so it is the one that
  // REFUSES a multi-run pile rather than warning about it. Everything else can be
  // re-run; a bad seed is a baseline nobody can ever validate.
  if (staleSpan) {
    process.stderr.write(
      `refusing to --seed: ${staleSpan}.\nScope it to one run: --since-minutes <N>, or point --dir at a directory that run wrote alone (PAPERCUSP_LEAK_REPORT_DIR).\n`,
    );
    process.exit(2);
  }
  if (existsSync(baselinePath) && !argv.includes('--force')) {
    process.stderr.write(`refusing to --seed: ${baselinePath} already exists. Use --update to ratchet it down, or --force to replace it.\n`);
    process.exit(2);
  }
  const seeded = seedBaseline(report, new Date().toISOString());
  if (!seeded.ok) {
    process.stderr.write(`${seeded.reason}\n`);
    process.exit(2);
  }
  writeFileSync(baselinePath, serializeBaseline(seeded.baseline));
  process.stdout.write(
    `seeded ${baselinePath} from ${report.denominator.observed} observed file(s): ${Object.keys(seeded.baseline.files).length} leaking file(s), ${Object.keys(seeded.baseline.postMortemFires).length} post-mortem fire(s)\n`,
  );
  process.exit(0);
}

// Everything below judges the run AGAINST the baseline, so an absent baseline
// makes every verdict below meaningless rather than merely empty. --seed is the
// one mode that legitimately runs without one, and it has already returned.
if (!baselineExists) {
  const scope = [
    Number.isFinite(sinceMinutes) ? `--since-minutes ${sinceMinutes}` : null,
    flagValue(argv, '--dir') ? `--dir ${dir}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  if (json) {
    process.stdout.write(`${JSON.stringify({ dir, baselinePath, verdict: 'unadopted', observedFiles: report.denominator.observed }, null, 2)}\n`);
  } else {
    process.stderr.write(
      `no baseline at ${baselinePath}: nothing has been adopted, so this run cannot be judged.\n` +
        `This is NOT a pass and NOT a regression — the ${report.denominator.observed} file(s) observed were compared against nothing.\n` +
        `Adopt one from a run you trust: npm run leaks:ratchet -- ${scope ? `${scope} ` : ''}--seed\n`,
    );
  }
  process.exit(3);
}

if (staleSpan) process.stderr.write(`⚠ ${staleSpan}. Scope with --since-minutes <N> or a dedicated --dir.\n`);

if (update) {
  // Ratchet only from a run that HELD. Lowering the baseline out of a run that
  // also regressed would bank the wins and quietly drop the losses in one write.
  if (result.verdict !== 'held') {
    process.stderr.write(
      `refusing to --update: the run is ${result.verdict}, so this artifact cannot be used to lower the baseline\n`,
    );
    process.stdout.write(`${renderRatchetReport(result)}\n`);
    process.exit(2);
  }
  const next = ratchetDown(baseline, report, new Date().toISOString());
  if (!next.ok) {
    process.stderr.write(`${next.reason}\n`);
    process.exit(2);
  }
  writeFileSync(baselinePath, serializeBaseline(next.baseline));
  process.stdout.write(
    `ratcheted ${baselinePath}: ${next.lowered.length} improvement(s) banked, ${Object.keys(next.baseline.files).length} file(s) remain\n`,
  );
  process.exit(0);
}

if (json) {
  process.stdout.write(`${JSON.stringify({ dir, baselinePath, ...result }, null, 2)}\n`);
} else {
  process.stdout.write(`artifact dir: ${dir}\nbaseline: ${baselinePath}\n`);
  process.stdout.write(`${renderRatchetReport(result)}\n`);
}

process.exit(result.verdict === 'regressed' ? 1 : result.verdict === 'no-data' ? 2 : 0);
