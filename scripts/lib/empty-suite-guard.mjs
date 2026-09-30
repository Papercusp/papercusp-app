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
  const wantsIntegration = /:integration$/.test(script ?? '');
  const nameTest = wantsIntegration
    ? `-iname '*.integration.test.*'`
    : `\\( -iname '*.test.*' -o -iname '*.spec.*' \\) -not -iname '*.integration.test.*' -not -iname '*.browser.test.*'`;
  const pruneArgs = PRUNE_DIRS.map((d) => `-not -path '*/${d}/*'`).join(' ');
  try {
    const out = execSync(`find ${JSON.stringify(wsAbsDir)} -type f ${nameTest} ${pruneArgs} -print -quit`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/**
 * The extra CLI args to append (possibly none) when spawning `script` for a
 * workspace — the composed guard decision affected-tests.mjs threads into
 * every spawn for the task, including flake-absorption retries.
 *
 * @param {{ scriptText: string, wsAbsDir: string, script: string }} input
 * @returns {string[]}
 */
export function emptySuiteGuardArgs({ scriptText, wsAbsDir, script }) {
  if (!scriptUsesPassWithNoTests(scriptText)) return [];
  return hasMatchingTestFilesOnDisk(wsAbsDir, script) ? ['--no-passWithNoTests'] : [];
}
