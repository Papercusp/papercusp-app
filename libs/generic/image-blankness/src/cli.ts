/**
 * `check-screenshot <image>…` — did this capture actually render?
 *
 * Exists because the capture tool cannot answer it. `tauri-agent-tools screenshot`
 * writes a valid PNG, prints the path and exits 0 whether or not the window painted,
 * so its exit code carries no information about the thing you care about. This gives
 * you one that does: exit 1 when a capture is confidently blank, so it can gate a
 * script instead of being eyeballed.
 *
 * Run it the moment you take a screenshot you intend to cite as evidence — a blank
 * one caught here costs a re-capture; caught at `work_items:complete` it costs a
 * rejected close, and not caught at all it is a false claim that you verified pixels.
 */

import { readFile } from 'node:fs/promises';

import { analyzeImageBlankness, type BlanknessVerdict } from './index.js';

const VERDICT_MARK: Record<BlanknessVerdict, string> = {
  'has-content': 'RENDERED',
  blank: 'BLANK   ',
  undecodable: 'UNKNOWN ',
  inconclusive: 'UNKNOWN ',
};

async function main(): Promise<number> {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const asJson = process.argv.includes('--json');

  if (paths.length === 0) {
    process.stderr.write('usage: check-screenshot [--json] <image>…\n');
    return 2;
  }

  let anyBlank = false;
  const results: unknown[] = [];

  for (const path of paths) {
    let report;
    try {
      report = analyzeImageBlankness(new Uint8Array(await readFile(path)));
    } catch (e) {
      report = { verdict: 'undecodable' as const, reason: `unreadable: ${(e as Error).message}` };
    }
    if (report.verdict === 'blank') anyBlank = true;
    if (asJson) results.push({ path, ...report });
    else process.stdout.write(`${VERDICT_MARK[report.verdict]}  ${path}\n            ${report.reason}\n`);
  }

  if (asJson) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  if (anyBlank) {
    process.stderr.write(
      '\nAt least one capture is BLANK — the window did not paint (see agent-e2e §15.4: a\n' +
        'GL-less display renders nothing while the DOM stays perfectly healthy). Do not cite it\n' +
        'as evidence. Either fix the display (vglrun / DISPLAY=:0) and re-capture, or assert\n' +
        'against the DOM instead: `tauri-agent-tools check --pid <pid> --eval "<assertion>" --json`,\n' +
        'which exits non-zero when the assertion is false and records what you actually checked.\n',
    );
  }
  return anyBlank ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`check-screenshot failed: ${(e as Error).message}\n`);
    process.exitCode = 2;
  },
);
