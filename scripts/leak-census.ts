#!/usr/bin/env tsx
/**
 * Report the handle/timer leak CENSUS from a suite run's JSONL artifacts
 * (plan gate-suite-speedup-2026-08-12; WI-38215).
 *
 * The detector (libs/test-config/src/setup-handle-leak-detector.ts) ships enabled
 * and writes one artifact per worker process, so ANY suite run already produces
 * the input for free. This turns that pile into the census that the enforced,
 * shrink-only leak baseline will be ratcheted against.
 *
 *   npm run census:leaks                       # default artifact dir
 *   npm run census:leaks -- --dir /tmp/x       # a run you redirected
 *   npm run census:leaks -- --json             # machine-readable
 *
 * Exit code is 0 whether or not leaks were found: this is a REPORT, not a gate.
 * The gate is a separate, later step that needs the census to exist first — and
 * exiting non-zero on a pre-existing leak population is precisely what D-001
 * forbids this plan from doing on arrival.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aggregateCensusDir, renderCensusReport } from '../libs/test-config/src/leak-census-aggregate.js';

function parseArgs(argv: readonly string[]): { dir: string; json: boolean } {
  const dirFlag = argv.indexOf('--dir');
  return {
    dir:
      dirFlag >= 0 && argv[dirFlag + 1]
        ? (argv[dirFlag + 1] as string)
        : (process.env.PAPERCUSP_LEAK_REPORT_DIR ?? join(tmpdir(), 'papercusp-leak-reports')),
    json: argv.includes('--json'),
  };
}

const { dir, json } = parseArgs(process.argv.slice(2));
const report = aggregateCensusDir(dir);

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`artifact dir: ${dir}\n`);
  process.stdout.write(`${renderCensusReport(report)}\n`);
}
