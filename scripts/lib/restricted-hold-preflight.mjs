// Restricted-write preflight for the RAW test router (WI-10005713, follow-up of WI-10005634 —
// plan personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
//
// A session holding an active personal disclosure has no network (D-012), but code it WROTE into
// the shared tree can still be executed later by an unrestricted process that has the network.
// `testing:run` refuses that in-process (restricted-hold-fence.ts). A raw `npm run test:file`
// reaches scripts/test-files.mjs without it, so the router calls `runRestrictedHoldPreflight`
// before it starts any test process.
//
// The census and reach walk are NOT re-implemented here: this module spawns the operator-core
// entry (restricted-hold-preflight-cli.ts) that runs the exact `restrictedHoldRefusal` testing:run
// uses. It fails CLOSED: no marker line, bad JSON, a crash or a timeout all refuse.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** stdout marker the CLI prints exactly once, followed by a JSON verdict. */
export const RESTRICTED_HOLD_PREFLIGHT_MARKER = 'RESTRICTED_HOLD_PREFLIGHT';

/** CLI exit codes. Anything else is treated as an unknown state and refuses. */
export const RESTRICTED_HOLD_PREFLIGHT_EXIT = Object.freeze({ admit: 0, misuse: 2, refuse: 3 });

/**
 * Set by `testing:run` on the router it spawns, after its in-process fence admitted the SAME file
 * set. It only skips a duplicate check; it is not a bypass for any path testing:run did not check.
 * A caller that could set it could equally run vitest directly, which no router-side check can
 * stop. The PreToolUse layer is the place for that, not this module.
 */
export const RESTRICTED_HOLD_PREFLIGHT_ENV = 'PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT';
export const RESTRICTED_HOLD_PREFLIGHT_DONE = 'admitted-by-testing-run';
/** Set by the raw router on its own env (inherited by every vitest it starts) after it admitted. */
export const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER = 'admitted-by-test-router';
/** Set by the vitest root preflight (WI-10005724) on vitest's main-process env after it admitted. */
export const RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST = 'admitted-by-vitest-root';
const ADMITTED_MARKERS = new Set([
  RESTRICTED_HOLD_PREFLIGHT_DONE,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST,
]);

/**
 * Absolute path of the operator-core entry the router spawns — resolved from THIS module, never
 * from the checkout being checked, so the census code that runs is always this repo's own.
 */
export const RESTRICTED_HOLD_PREFLIGHT_CLI = fileURLToPath(
  new URL('../../packages/operator-core/lib/agent-tools/testing/restricted-hold-preflight-cli.ts', import.meta.url),
);

const DEFAULT_TIMEOUT_MS = 120_000;

function unknownState(why) {
  return {
    verdict: 'refuse',
    error: 'restricted_hold_state_unknown',
    hint: `could not verify whether a restricted session's writes are held in this checkout; no test process was started (${why})`,
  };
}

/**
 * Parse the CLI's result. Exported so the fail-closed table is unit-testable without a spawn.
 * @param {{ status: number | null, signal?: string | null, stdout?: string | null, stderr?: string | null, error?: Error }} result
 */
export function interpretRestrictedHoldPreflight(result) {
  if (result.error) return unknownState(`preflight could not run: ${result.error.message}`);
  if (result.signal) return unknownState(`preflight was killed by ${result.signal}`);
  const line = String(result.stdout ?? '')
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} `));
  if (!line) {
    const tail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' | ');
    return unknownState(`preflight exited ${result.status} without a verdict${tail ? `: ${tail}` : ''}`);
  }
  let payload;
  try {
    payload = JSON.parse(line.slice(RESTRICTED_HOLD_PREFLIGHT_MARKER.length + 1));
  } catch {
    return unknownState('preflight printed an unparseable verdict');
  }
  if (payload?.verdict === 'admit' && result.status === RESTRICTED_HOLD_PREFLIGHT_EXIT.admit) return { verdict: 'admit' };
  if (payload?.verdict === 'refuse' && typeof payload.error === 'string' && typeof payload.hint === 'string') {
    return { verdict: 'refuse', error: payload.error, hint: payload.hint };
  }
  return unknownState(`preflight verdict ${JSON.stringify(payload?.verdict)} does not match exit ${result.status}`);
}

/**
 * Why this router invocation needs no preflight of its own, or null when it does.
 * - testing:run already ran `restrictedHoldRefusal` over the same files in-process.
 * - The router is nested inside a vitest process tree (a test that drives the router). That test
 *   process has already executed everything it loads, so the fence belongs at the ROOT of the run
 *   (testing:run, or this router's own top-level invocation), not at every nested hop. Without
 *   this, each in-test router call would pay a ~2s census spawn and a Postgres dependency.
 * - An enclosing router or vitest root already admitted this process tree (its marker is inherited).
 * - The green-checkpoint gate's isolated checkout cannot hold a restricted write (see isReleaseGate).
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'admitted-upstream' | 'release-gate' | 'nested-in-vitest' | null}
 */
export function restrictedHoldPreflightSkipReason(env) {
  const upstream = admittedUpstream(env);
  if (upstream) return upstream;
  if (isReleaseGate(env)) return 'release-gate';
  if (env.VITEST) return 'nested-in-vitest';
  return null;
}

/**
 * The green-checkpoint gate runs COMMITTED code in its own isolated checkout, and D-011 holds a
 * restricted session's writes out of every commit, so no held restricted write can exist where the
 * gate runs. Without this skip every vitest process the gate starts would pay a census spawn and
 * take a fail-closed Postgres dependency, so one database hiccup would turn the fleet's gate red
 * while fencing nothing. Keyed on BOTH gate markers: GREEN_CHECKPOINT=1 alone is exported by hand
 * to reproduce the gate's skip-set, PC_HEAVY_RELEASE_GATE=1 is set by nothing but the gate (WI-6140),
 * and proc-guard reads the same pair as the gate's identity.
 * @param {NodeJS.ProcessEnv} env
 */
function isReleaseGate(env) {
  return env.PC_HEAVY_RELEASE_GATE === '1' && env.GREEN_CHECKPOINT === '1';
}

/** @param {NodeJS.ProcessEnv} env @returns {'testing-run' | 'admitted-upstream' | null} */
function admittedUpstream(env) {
  const marker = env[RESTRICTED_HOLD_PREFLIGHT_ENV];
  if (marker === RESTRICTED_HOLD_PREFLIGHT_DONE) return 'testing-run';
  if (marker !== undefined && ADMITTED_MARKERS.has(marker)) return 'admitted-upstream';
  return null;
}

/**
 * Why the vitest ROOT preflight (WI-10005724) needs no census of its own, or null when it does.
 *
 * Unlike the router, it can NOT skip on `VITEST`: vitest sets `process.env.VITEST = 'true'` in its
 * own main process (prepareVitest) BEFORE the config or any globalSetup loads, so that signal is
 * present at the root of every run, not only at nested hops. Nested runs are recognised by the
 * admitted marker instead, which the root sets after it admits and every child process inherits.
 * - GitHub Actions runners host no Papercusp operator, so no restricted session and no census exist
 *   there (only `GITHUB_ACTIONS`, never the generic `CI`, which local tooling also sets).
 * - The green-checkpoint gate's isolated checkout cannot hold a restricted write (see isReleaseGate).
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'admitted-upstream' | 'release-gate' | 'github-actions' | null}
 */
export function vitestRootPreflightSkipReason(env) {
  const upstream = admittedUpstream(env);
  if (upstream) return upstream;
  if (isReleaseGate(env)) return 'release-gate';
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions';
  return null;
}

/**
 * @param {{ repoRoot: string, files: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'skipped', reason: 'testing-run' | 'nested-in-vitest' } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runRestrictedHoldPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = restrictedHoldPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  return spawnCensus({ repoRoot, files, env, timeoutMs, spawn });
}

/**
 * The vitest ROOT door (WI-10005724): `npx vitest`, and the per-workspace vitest runs
 * `npm run test:affected` starts, reach no router. libs/test-config's host-preflight globalSetup
 * calls this (through scripts/lib/vitest-host-preflight.mjs) after vitest has resolved the run's
 * files and before any test executes. Same census child, same fail-closed table as the router.
 * On admit it hands back the marker for vitest's main-process env, so every worker and every
 * nested router/vitest a test starts skips a duplicate census.
 * @param {{ repoRoot: string, files: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 */
export function runVitestRootPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = vitestRootPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  const verdict = spawnCensus({ repoRoot, files, env, timeoutMs, spawn });
  if (verdict.verdict !== 'admit') return verdict;
  return { verdict: 'admit', setEnv: { [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST } };
}

/**
 * The host-bundle door (WI-10005745): bg-host's ExecStartPre bundles the LIVE shared tree and runs
 * it with the network. apps/operator/bin/bundle-restricted-hold-gate.mjs writes the bundle's exact
 * inputs (esbuild metafile inputs + verbatim-copied files/dirs) to `inputsFile` and calls this
 * before it lets the fresh bundle stand. No skip reasons: a bundle is never nested in a test run,
 * and the release/staging checkouts simply hold nothing, so their census admits on its own.
 * Same census child and fail-closed table as the router.
 * @param {{ repoRoot: string, inputsFile: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runBundleRestrictedHoldPreflight({ repoRoot, inputsFile, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  // WI-10005770: the census child runs with cwd=repoRoot, but bundle-host.sh hands the gate a
  // snapshot dir relative to apps/operator (the default OUTFILE is dist-host/hono-host.mjs). A
  // relative path crossing that cwd change made every default build fail closed with ENOENT, so
  // resolve it here, in the caller's frame, before the cwd changes.
  return spawnCensus({ repoRoot, files: [], env, timeoutMs, spawn, leading: ['--bundle-inputs', resolve(inputsFile)] });
}

/**
 * Why a TREE door (WI-10005763) needs no census of its own, or null when it does.
 * - An enclosing door already admitted this process tree (testing:run, the router, a vitest root).
 * - The green-checkpoint gate's isolated checkout cannot hold a restricted write (see isReleaseGate).
 * - GitHub Actions runners host no Papercusp operator, so no restricted session and no census exist.
 * - Nested inside a test runner (`VITEST`, or `NODE_TEST_CONTEXT`, which node:test sets on every
 *   test-file process): the papercusp-desktop shell suites drive the REAL tauri-guarded with a
 *   throwaway HOME, where a census could only fail closed. Same root-not-every-hop rule as the
 *   router's nested-in-vitest skip.
 * @param {NodeJS.ProcessEnv} env
 * @returns {'testing-run' | 'admitted-upstream' | 'release-gate' | 'github-actions' | 'nested-in-test-runner' | null}
 */
export function treeDoorPreflightSkipReason(env) {
  const upstream = admittedUpstream(env);
  if (upstream) return upstream;
  if (isReleaseGate(env)) return 'release-gate';
  if (env.GITHUB_ACTIONS === 'true') return 'github-actions';
  if (env.VITEST || env.NODE_TEST_CONTEXT) return 'nested-in-test-runner';
  return null;
}

/**
 * The tree door (WI-10005763): papercusp-desktop/bin/tauri-guarded `dev` (the chokepoint every
 * `npm run dev` / `dev:hmr` / verifier launch passes) and scripts/verify-tauri-headless.sh boot the
 * app FROM the live shared tree with network — cargo build.rs, the operator sidecar, the host
 * bundle — so there is no import graph to walk. Like the routine door, ANY held restricted write
 * under `roots` refuses. Roots are resolved here, in the caller's frame, before the census child's
 * cwd change (the WI-10005770 lesson). Same census child and fail-closed table as the router.
 * @param {{ roots: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number, spawn?: typeof spawnSync }} opts
 * @returns {{ verdict: 'admit' } | { verdict: 'skipped', reason: string } | { verdict: 'refuse', error: string, hint: string }}
 */
export function runTreeRestrictedHoldPreflight({ roots, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  if (!Array.isArray(roots) || roots.length === 0) return unknownState('tree preflight was given no checkout root');
  const skip = treeDoorPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  const absolute = roots.map((root) => resolve(root));
  return spawnCensus({ repoRoot: absolute[0], files: absolute.slice(1), env, timeoutMs, spawn, leading: ['--tree'] });
}

/**
 * The node:test RUNNER door (WI-10005765): `node --test` suites (papercusp-desktop's shell suites,
 * libs/papercusp's cli + orchestrator) never pass the raw router or the vitest-root door, yet they
 * run live-tree code, some of it spawning real scripts. Called once from a `--test-global-setup`
 * module, which node runs in the RUNNER process (an `--import` preload runs only in the test-file
 * children). The census is the router's: the test files' import closure plus their spawn reach.
 * Skips like a tree door; on admit the marker reaches every test child, so nested doors skip.
 * @returns {{ verdict: 'admit', setEnv: Record<string, string> }
 *   | { verdict: 'skipped', reason: string }
 *   | { verdict: 'refuse', error: string, hint: string }}
 */
export function runNodeTestRunnerPreflight({ repoRoot, files, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = spawnSync }) {
  const skip = treeDoorPreflightSkipReason(env);
  if (skip) return { verdict: 'skipped', reason: skip };
  if (!repoRoot) return unknownState('node:test preflight was given no checkout root');
  const result = spawnCensus({ repoRoot, files: files.map((file) => resolve(file)), env, timeoutMs, spawn });
  if (result.verdict !== 'admit') return result;
  return { verdict: 'admit', setEnv: { [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER } };
}

/** The node:test runner door's refusal line (node prints it as the global-setup error, exit 7). */
export function formatNodeTestRestrictedHoldRefusal(refusal) {
  return `NODE_TEST_RESTRICTED_HOLD_REFUSED error=${refusal.error} measured=none ${refusal.hint}`;
}

/**
 * The committed-source loader (WI-10005764). The census's own ~5,600-module closure lives in the
 * shared tree it judges, so it must not run a held restricted write before it can refuse one: the
 * loader makes every ES module of a checkout execute its committed (HEAD) bytes, and refuses new
 * uncommitted modules and checkout CommonJS. It must load BEFORE tsx (tsx's load hook then reads
 * the raw bytes through it).
 */
export const COMMITTED_SOURCE_LOADER = fileURLToPath(new URL('./committed-source-loader.mjs', import.meta.url));

/**
 * The node argv and env every census spawn uses. The loader goes first on the argv, and also into
 * NODE_OPTIONS so a node process the census itself starts — the closure walk forks its worker with
 * `execArgv: []` (mutation-probe-fence) — enforces the same committed-source rule.
 * @param {string[]} args the CLI arguments after the entry path
 * @param {NodeJS.ProcessEnv} env
 */
export function censusSpawnArgs(args, env) {
  const loaderImport = `--import=${pathToFileURL(COMMITTED_SOURCE_LOADER).href}`;
  const inherited = env.NODE_OPTIONS ?? '';
  const nodeOptions = inherited.includes(loaderImport) ? inherited : `${loaderImport} ${inherited}`.trim();
  return {
    argv: ['--import', COMMITTED_SOURCE_LOADER, '--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI, ...args],
    env: { ...env, NODE_OPTIONS: nodeOptions },
  };
}

function spawnCensus({ repoRoot, files, env, timeoutMs, spawn, leading = [] }) {
  const census = censusSpawnArgs([...leading, repoRoot, ...files], env);
  const result = spawn(process.execPath, census.argv, {
    cwd: repoRoot,
    env: census.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return interpretRestrictedHoldPreflight(result);
}

/** One stderr line for a refusal; greppable, and it names the measured state: nothing ran. */
export function formatRestrictedHoldRefusal(refusal) {
  return `TEST_FILE_RESTRICTED_HOLD_REFUSED error=${refusal.error} measured=none ${refusal.hint}`;
}

/** The vitest-root door's refusal line (vitest prints it as the globalSetup error). */
export function formatVitestRestrictedHoldRefusal(refusal) {
  return `VITEST_RESTRICTED_HOLD_REFUSED error=${refusal.error} measured=none ${refusal.hint}`;
}

/** A tree door's refusal line: greppable, names the door, and states that nothing was booted. */
export function formatTreeRestrictedHoldRefusal(door, refusal) {
  return `RESTRICTED_HOLD_REFUSED door=${door} error=${refusal.error} booted=none ${refusal.hint}`;
}

/** The host-bundle door's refusal line (bundle-host.sh prints it, then falls back to last-known-good). */
export function formatBundleRestrictedHoldRefusal(refusal) {
  return `BUNDLE_RESTRICTED_HOLD_REFUSED error=${refusal.error} published=last-known-good ${refusal.hint}`;
}
