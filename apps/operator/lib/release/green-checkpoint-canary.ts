/**
 * green-checkpoint-canary — the P-011 "known-green test through the
 * checkpoint walker" concrete instance (fleet-reliability-verification-
 * 2026-07-10 P-011, after P-010's federation-probe-canary).
 *
 * Scope (deliberately conservative, mirrors federation-probe-canary.ts):
 * this does NOT spawn the real test suite (expensive, and would race with a
 * live checkpoint run) — it exercises the exact RESULT-PARSING apparatus a
 * real run's output flows through (`stripAnsi` / `extractFailingTests` /
 * `extractFailingTestNames`, the pure helpers `green-checkpoint.ts` already
 * exports) against CANNED, known-good and known-bad sample outputs and
 * asserts they classify correctly. A vitest reporter-format drift or a
 * parsing regression — the class of bug that makes green unreachable-by-
 * construction, cause #10's sibling failure mode on the release side — is
 * caught WITHOUT waiting for a real run to go inexplicably, perpetually red
 * (the WI-2009 stale-verdict class).
 */
import { extractFailingTestNames, extractFailingTests, stripAnsi } from './green-checkpoint';
import type { GateCanaryDef } from '@papercusp/operator-core/lib/gates/canary';

/** A canned KNOWN-GOOD vitest tail — no FAIL/❯-failed lines, no failing case markers. */
const KNOWN_GOOD_OUTPUT = [
  '\x1b[32m RUN \x1b[0m v4.1.8 /repo',
  '',
  ' \x1b[32m✓\x1b[0m packages/foo/lib/bar.test.ts (3 tests) 12ms',
  '',
  ' Test Files  1 passed (1)',
  '      Tests  3 passed (3)',
].join('\n');

/** A canned KNOWN-BAD vitest tail with a stable, named failure — the parser must
 *  name BOTH the failing file (extractFailingTests) and the failing case
 *  (extractFailingTestNames). */
const KNOWN_BAD_OUTPUT = [
  '\x1b[31m FAIL \x1b[0m packages/foo/lib/bar.test.ts [ packages/foo/lib/bar.test.ts ]',
  ' \x1b[31m❯\x1b[0m packages/foo/lib/bar.test.ts (3 tests | 1 failed) 45ms',
  '   \x1b[31m×\x1b[0m does the thing 3ms',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 2 passed (3)',
].join('\n');

/**
 * Feed the two canned samples through the real parser and assert the classic
 * shape a real run would produce. Pure + synchronous — wrapped in an async
 * `run()` only to match `GateCanaryDef`'s contract.
 */
export function checkResultParser(): { ok: boolean; detail: string } {
  const failures: string[] = [];

  const goodFiles = extractFailingTests(KNOWN_GOOD_OUTPUT);
  const goodNames = extractFailingTestNames(KNOWN_GOOD_OUTPUT);
  if (goodFiles.length !== 0) failures.push(`known-good output was misparsed as failing files: ${goodFiles.join(', ')}`);
  if (goodNames.length !== 0) failures.push(`known-good output was misparsed as failing cases: ${goodNames.join(', ')}`);

  const badFiles = extractFailingTests(KNOWN_BAD_OUTPUT);
  const badNames = extractFailingTestNames(KNOWN_BAD_OUTPUT);
  if (!badFiles.includes('packages/foo/lib/bar.test.ts')) {
    failures.push(`known-bad output's failing FILE was not named — extractFailingTests returned [${badFiles.join(', ')}]`);
  }
  if (!badNames.includes('does the thing')) {
    failures.push(`known-bad output's failing CASE was not named — extractFailingTestNames returned [${badNames.join(', ')}]`);
  }

  // stripAnsi itself: the SGR codes above must actually be gone from the cleaned text
  // (a broken strip would silently defeat every line-anchored matcher above it).
  // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of SGR codes.
  if (/\x1b\[[0-9;]*m/.test(stripAnsi(KNOWN_BAD_OUTPUT))) {
    failures.push('stripAnsi left SGR codes in place');
  }

  if (failures.length > 0) {
    return { ok: false, detail: failures.join('; ') };
  }
  return { ok: true, detail: 'known-good classified clean; known-bad named its failing file + case; stripAnsi cleaned SGR codes' };
}

/** Build the GateCanaryDef — pass to `runGateCanary` / `runGateCanaries`. */
export function buildGreenCheckpointParserCanary(): GateCanaryDef {
  return {
    id: 'green-checkpoint:result-parser',
    describe: 'a known-green + known-bad sample through the checkpoint result-parsing apparatus (stripAnsi/extractFailingTests/extractFailingTestNames)',
    run: async () => checkResultParser(),
  };
}
