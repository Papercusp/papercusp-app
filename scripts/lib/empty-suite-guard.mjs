// scripts/lib/empty-suite-guard.mjs
//
// EI-11132: guard against the "silent empty suite" release-gate hole.
//
// Several workspaces declare `--passWithNoTests` on their `test` /
// `test:integration` script (tolerating a genuinely test-less package) — but
// the SAME flag makes vitest exit 0 when its include glob stops matching ANY
// real test file (a renamed/moved/deleted-without-noticing regression),
// silently reporting the workspace green having verified nothing.
// affected-tests.mjs's own comment elsewhere in this repo calls a silently-
// green empty run "the worst outcome for a release check" — yet every
// `--passWithNoTests` workspace was exposed to exactly that.
//
// Fix: independent, on-disk discovery, applied per-run (not a one-time edit
// to 20+ package.json files, so it stays correct as workspaces come and go).
// When the workspace's own filesystem genuinely contains matching test
// files, there is no need to keep vitest's zero-match tolerance for THIS
// run — append `--no-passWithNoTests` (a raw cac/mri negation flag, honored
// regardless of whether the script itself already passed
// `--passWithNoTests`; the LAST occurrence on the parsed arg line wins — see
// node_modules/cac/dist/index.js's `mri2`, which vitest's own CLI is built
// on) so a glob that stops matching those real files now fails LOUDLY via
// vitest's own default "No test files found, exiting with code 1" — instead
// of silently passing. A workspace that legitimately has zero tests today
// (nothing found on disk) keeps its lenient default untouched.
//
// Split out (mirrors scripts/lib/quarantine.mjs) so it is unit-testable
// without importing — and thereby executing — affected-tests.mjs's
// side-effecting top-level CLI flow.

import { execSync } from 'node:child_process';

/** Does this exact script string invoke vitest with --passWithNoTests? */
export function scriptUsesPassWithNoTests(scriptText) {
  return /--passWithNoTests\b/.test(scriptText ?? '');
}

// scripts/run-vitest-pure-lane.mjs passes --passWithNoTests on every shard it spawns, and it
// passes an all-reused lane without spawning vitest (via reuseSkipCoversRun below), so a script
// that invokes it runs zero files as a pass although its own text never names the flag.
const PURE_LANE_RUNNER = /(?:^|[\s/])run-vitest-pure-lane\.mjs(?=\s|$)/;

/**
 * May a pass-reuse skip list empty this script's run? True for a script that declares
 * --passWithNoTests, and for the pure-lane runner (gate-test-reuse-yield-2026-10-01 P-006, D-005).
 * This is the REUSE eligibility test only: the EI-11132 guard below still keys on the literal
 * flag (scriptUsesPassWithNoTests), because only a script that declares it can be given
 * --no-passWithNoTests meaningfully.
 */
export function scriptRunsZeroFilesAsPass(scriptText) {
  return scriptUsesPassWithNoTests(scriptText) || PURE_LANE_RUNNER.test(scriptText ?? '');
}

// Mirrors libs/test-config/src/vitest-config.ts's baseExclude — directories
// that are never real test source regardless of workspace.
const PRUNE_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '.papercusp', '_retired'];

/**
 * Best-effort on-disk probe: does `wsAbsDir` contain a file matching the
 * naming convention vitest would pick up for `script`? A `*:integration`
 * script looks for `*.integration.test.*` (this repo's integration-layer
 * convention); a plain `test` script looks for `*.test.*` / `*.spec.*`,
 * EXCLUDING the integration/browser-layer files this repo's shared unit
 * config itself excludes (libs/test-config's `defineVitestConfig({layer:
 * 'unit'})`) — so a package with ONLY integration tests doesn't spuriously
 * look "has unit tests" and trip the guard on its (legitimately
 * zero-matching) unit script.
 *
 * Never throws — a discovery failure (e.g. `find` unavailable) degrades to
 * "nothing found", i.e. today's lenient behavior, never to blocking a run
 * the guard itself can't evaluate.
 *
 * @param {string} wsAbsDir absolute path to the workspace directory
 * @param {string} script the script name being run (e.g. 'test', 'test:integration')
 */
export function hasMatchingTestFilesOnDisk(wsAbsDir, script) {
  try {
    const out = execSync(`${testFileFindCommand(wsAbsDir, script)} -quit`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * Every file the same probe matches, workspace-relative and '/'-separated.
 * A failed census returns `null` (unknown), never `[]`, so a caller asking
 * "is every file covered?" cannot read a broken probe as a vacuous yes.
 *
 * @param {string} wsAbsDir absolute path to the workspace directory
 * @param {string} script the script name being run
 * @returns {string[] | null}
 */
export function listMatchingTestFilesOnDisk(wsAbsDir, script) {
  try {
    const out = execSync(testFileFindCommand(wsAbsDir, script), {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    const root = `${wsAbsDir.replace(/\/+$/, '')}/`;
    return out
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => normalizeWsRel(line.startsWith(root) ? line.slice(root.length) : line));
  } catch {
    return null;
  }
}

function testFileFindCommand(wsAbsDir, script) {
  const wantsIntegration = /:integration$/.test(script ?? '');
  const nameTest = wantsIntegration
    ? `-iname '*.integration.test.*'`
    : `\\( -iname '*.test.*' -o -iname '*.spec.*' \\) -not -iname '*.integration.test.*' -not -iname '*.browser.test.*'`;
  const pruneArgs = PRUNE_DIRS.map((d) => `-not -path '*/${d}/*'`).join(' ');
  return `find ${JSON.stringify(wsAbsDir)} -type f ${nameTest} ${pruneArgs} -print`;
}

const normalizeWsRel = (f) => String(f).replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * P-008 (gate-file-level-test-reuse-2026-09-27) makes an EMPTY run deliberate:
 * a file with a valid pass proof is excluded via the task's skip list, and
 * reuse arms only scripts that declare --passWithNoTests precisely so that a
 * run with every file reused passes. Appending the guard on top of that turned
 * every fully-reused workspace red with "No test files found" (gate candidate
 * 599dbeeb: @papercusp/plugin-sdk, 5 of 5 files reused, exit 1 on both
 * passes). The guard therefore stands down only when EVERY file the task would
 * run — its related selection when narrowed, else the on-disk census — is on
 * the skip list. A partially-reused run keeps it, so a glob that stops
 * matching the unreused files still fails loudly.
 *
 * @param {{ wsAbsDir: string, script: string, reuseSkipped?: Iterable<string> | null, selectedFiles?: string[] | null }} input
 *   `reuseSkipped` and `selectedFiles` are workspace-relative.
 * @returns {boolean}
 */
export function reuseSkipCoversRun({ wsAbsDir, script, reuseSkipped = null, selectedFiles = null }) {
  const skipped = new Set([...(reuseSkipped ?? [])].map(normalizeWsRel));
  if (skipped.size === 0) return false;
  const runs =
    Array.isArray(selectedFiles) && selectedFiles.length > 0
      ? selectedFiles
      : listMatchingTestFilesOnDisk(wsAbsDir, script);
  if (!runs || runs.length === 0) return false;
  return runs.every((f) => skipped.has(normalizeWsRel(f)));
}

/**
 * The extra CLI args to append (possibly none) when spawning `script` for a
 * workspace — the composed guard decision affected-tests.mjs threads into
 * every spawn for the task, including flake-absorption retries.
 *
 * @param {{ scriptText: string, wsAbsDir: string, script: string, reuseSkipped?: Iterable<string> | null, selectedFiles?: string[] | null }} input
 * @returns {string[]}
 */
export function emptySuiteGuardArgs({ scriptText, wsAbsDir, script, reuseSkipped = null, selectedFiles = null }) {
  if (!scriptUsesPassWithNoTests(scriptText)) return [];
  if (!hasMatchingTestFilesOnDisk(wsAbsDir, script)) return [];
  if (reuseSkipCoversRun({ wsAbsDir, script, reuseSkipped, selectedFiles })) return [];
  return ['--no-passWithNoTests'];
}
