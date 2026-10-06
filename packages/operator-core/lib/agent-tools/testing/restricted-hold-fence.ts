/**
 * Restricted-write fence for test runs (WI-10005634 — residue of plan
 * personal-data-reader-set-labels-2026-10-01, BAR R-11, Decision D-012).
 *
 * D-012 removes the network from every process a RESTRICTED session starts (a session that
 * holds an active personal disclosure). It cannot stop code that session WROTE into the shared
 * tree from being executed later by an UNRESTRICTED process that has the network — most
 * directly a peer's `testing:run` over a test file the restricted session edited, or over a
 * test that imports a source it edited. D-011 (R-10) already holds those files from COMMIT;
 * this fence refuses to EXECUTE them locally while that hold stands.
 *
 * The held set is git-sync's own restricted census, so "held from commit" and "refused from
 * execution" cannot disagree (personal-vault/git-sync-hold.ts):
 *   - readRestrictedEditHoldings  — ledgered edits by an agent with an unreleased disclosure;
 *   - readRestrictedWindowHoldings — changed files written inside an active disclosure window
 *     that no unrestricted native edit accounts for (writes with no ledger row).
 *
 * Reach is the mutation-probe fence's import-closure walk (`reachReason`: a held path in the
 * closure, named by a static string, or reachable through test-side filesystem/spawn access).
 * Three further cases matter here and not there, because a mutant there only skews a verdict
 * while a restricted write here would RUN with the network:
 *   1. the requested test file is itself held;
 *   2. a held path is loaded by the runner outside every test's import graph — the test-files
 *      router's own import closure, a vite/vitest config or setup file, or a package.json;
 *   3. a held non-module script (.sh, .py, …) while ANY file in the test's closure can spawn a
 *      process: production code may assemble that script's path at runtime.
 *
 * Fail-closed throughout: a census that cannot be read, or a closure that cannot be
 * established, refuses the run. Zero cost when no disclosure is active (two indexed reads).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  listDirtyFilesRecursive,
  readRestrictedEditHoldings,
  readRestrictedWindowHoldings,
  type HoldRunGit,
  type RestrictedEditHolding,
} from '../../personal-vault/git-sync-hold';
import { CODE_EXTENSIONS, OUT_OF_GRAPH_ACCESS, reachReason, testImportClosures } from './mutation-probe-fence';

export type RestrictedHoldRefusal = {
  error: 'restricted_write_held' | 'restricted_hold_state_unknown';
  hint: string;
};

/** The router `testing:run` spawns. Its own import closure executes on every run. */
export const TEST_ROUTER_PATH = 'scripts/test-files.mjs';

/** Files the runner loads outside any test's import graph (checkout-relative, `/`-separated). */
const RUNNER_LOADED: readonly RegExp[] = [
  /(^|\/)(vite|vitest)[^/]*\.(config|workspace|setup)\.[cm]?[jt]s$/i,
  /(^|\/)[^/]*(global-?setup|setup-?tests?|tests?-?setup)[^/]*\.[cm]?[jt]sx?$/i,
  /(^|\/)package\.json$/,
];

/** Non-module files a spawned process can execute. '' = extensionless (a shebang script). */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['', '.sh', '.bash', '.zsh', '.py', '.rb', '.pl']);

export interface RestrictedHoldFenceDeps {
  /** The restricted census for one checkout (production: git-sync's two restricted halves). */
  holdings?: (realRoot: string) => Promise<RestrictedEditHolding[]>;
  closures?: typeof testImportClosures;
}

/**
 * Per-call bound on the census's git metadata reads. A timed-out call surfaces a non-numeric
 * error code, which maps to exit 1 below, so the census throws and the fence refuses the run
 * (fail-closed) instead of hanging testing:run on a wedged git.
 */
const GIT_TIMEOUT_MS = 60_000;

const runGit: HoldRunGit = (args, cwd) =>
  new Promise((done) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** git-sync's restricted census halves, the window half scoped to this checkout. Throws on any read failure. */
export async function restrictedHoldingsFor(realRoot: string): Promise<RestrictedEditHolding[]> {
  const [edits, window] = await Promise.all([
    readRestrictedEditHoldings(),
    readRestrictedWindowHoldings({ listDirtyFiles: () => listDirtyFilesRecursive(runGit, realRoot) }),
  ]);
  return [...edits, ...window];
}

/** Absolute, symlink-resolved held paths inside `realRoot` (including its submodules). */
export async function heldPathsUnder(realRoot: string, holdings: readonly RestrictedEditHolding[]): Promise<string[]> {
  const out = new Set<string>();
  for (const holding of holdings) {
    const domain = holding.coordinationDomain
      ? await realpath(holding.coordinationDomain).catch(() => holding.coordinationDomain!)
      : realRoot;
    const abs = isAbsolute(holding.path) ? holding.path : resolve(domain, holding.path);
    const real = await realpath(abs).catch(() => abs);
    if (real === realRoot || real.startsWith(realRoot + sep)) out.add(real);
  }
  return [...out];
}

async function firstSpawner(closure: Iterable<string>): Promise<string | null> {
  for (const file of closure) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue;
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null || OUT_OF_GRAPH_ACCESS.test(text)) return file;
  }
  return null;
}

/**
 * The restricted-write preflight for one checkout, or null when the run may proceed. Like
 * `mutationProbeRefusal`, it is called BEFORE anything durable is written for the run.
 */
export async function restrictedHoldRefusal(
  root: string,
  files: string[],
  deps: RestrictedHoldFenceDeps = {},
): Promise<RestrictedHoldRefusal | null> {
  if (!existsSync(root)) return null;
  let realRoot: string;
  let held: string[];
  try {
    realRoot = await realpath(root);
    held = await heldPathsUnder(realRoot, await (deps.holdings ?? restrictedHoldingsFor)(realRoot));
  } catch (error) {
    return {
      error: 'restricted_hold_state_unknown',
      hint: `could not verify whether a restricted session's writes are held in this checkout; no test process was started (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (held.length === 0) return null;

  const shown = (abs: string): string => (abs.startsWith(realRoot + sep) ? abs.slice(realRoot.length + 1) : abs);
  const refuse = (why: string): RestrictedHoldRefusal => ({
    error: 'restricted_write_held',
    hint:
      `no test process was started: ${why}. A session holding an active personal disclosure wrote it, ` +
      `and running it from an unrestricted session would execute that code with network access (D-012). ` +
      `Retry after the disclosure is released, or run it inside the restricted session (its processes have no network)`,
  });

  const runnerLoaded = held.find((abs) => RUNNER_LOADED.some((re) => re.test(shown(abs).split(sep).join('/'))));
  if (runnerLoaded) return refuse(`${shown(runnerLoaded)} is loaded by the test runner itself and is a held restricted write`);

  const tests: string[] = [];
  for (const file of files) {
    const absolute = resolve(realRoot, file);
    if (!existsSync(absolute)) return refuse(`${file} could not be resolved for an import-closure check while restricted writes are held`);
    tests.push(await realpath(absolute));
  }
  const heldSet = new Set(held);
  const direct = tests.find((test) => heldSet.has(test));
  if (direct) return refuse(`${shown(direct)} is itself a held restricted write`);

  const router = join(realRoot, TEST_ROUTER_PATH);
  const withRouter = existsSync(router);
  const closure = await (deps.closures ?? testImportClosures)(realRoot, withRouter ? [...tests, router] : tests);
  if (closure.status === 'incomplete') return refuse(`the import closure could not be established (${closure.reason})`);

  if (withRouter) {
    const routerClosure = closure.files.get(router);
    const hit = routerClosure ? held.find((abs) => routerClosure.has(abs)) : undefined;
    if (hit) return refuse(`the test runner imports ${shown(hit)}, a held restricted write`);
  }

  const scripts = held.filter((abs) => !CODE_EXTENSIONS.has(extname(abs)) && SCRIPT_EXTENSIONS.has(extname(abs)));
  for (const test of tests) {
    const testClosure = closure.files.get(test) ?? new Set([test]);
    const reason = await reachReason(testClosure, test, held, closure.unfollowable);
    if (reason) return refuse(`${shown(test)} may execute a held restricted write: ${reason}`);
    if (scripts.length > 0) {
      const spawner = await firstSpawner(testClosure);
      if (spawner) return refuse(`${shown(spawner)} can spawn a process and ${shown(scripts[0])} is a held restricted script`);
    }
  }
  return null;
}

/**
 * The routine door (WI-10005745): a system action that spawns a process executing code FROM the
 * tree (a tsx/node script, a CLI bin, `cargo test`, a test runner) has no import graph this fence
 * can walk — cargo compiles build.rs, a CLI reaches anything — so the rule is coarse on purpose:
 * any held restricted write under any of `roots` skips the fire. Fail-closed like the others.
 */
export async function restrictedTreeHoldRefusal(
  roots: readonly string[],
  deps: Pick<RestrictedHoldFenceDeps, 'holdings'> = {},
): Promise<RestrictedHoldRefusal | null> {
  const seen = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let realRoot: string;
    let held: string[];
    try {
      realRoot = await realpath(root);
      if (seen.has(realRoot)) continue;
      seen.add(realRoot);
      held = await heldPathsUnder(realRoot, await (deps.holdings ?? restrictedHoldingsFor)(realRoot));
    } catch (error) {
      return {
        error: 'restricted_hold_state_unknown',
        hint: `could not verify whether a restricted session's writes are held in ${root}; the action was not run (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (held.length === 0) continue;
    const shown = held.slice(0, 3).map((abs) => (abs.startsWith(realRoot + sep) ? abs.slice(realRoot.length + 1) : abs));
    return {
      error: 'restricted_write_held',
      hint:
        `${held.length} held restricted write(s) in ${realRoot} (${shown.join(', ')}${held.length > shown.length ? ', …' : ''}). ` +
        `This action executes code from that tree with network access (D-012); it runs on its next fire after the disclosure is released`,
    };
  }
  return null;
}

/**
 * What a host bundle consumed (WI-10005745): every input file esbuild recorded in a metafile, and
 * every file or directory the bundler copied verbatim. Absolute paths.
 */
export interface BundleInputs {
  files: readonly string[];
  dirs: readonly string[];
}

/**
 * The bundle door (WI-10005745). bg-host's ExecStartPre esbuild-bundles the LIVE shared tree and
 * every in-process routine then runs that bundle with the network, so a held restricted write in
 * the bundle's inputs would execute exactly as D-012 forbids. Unlike a test run there is no
 * closure to approximate: esbuild's metafile is the exact input set, so this is a plain
 * intersection of held paths with what was actually bundled or copied. Fail-closed like
 * `restrictedHoldRefusal`: a census that cannot be read refuses.
 */
export async function restrictedHoldBundleRefusal(
  root: string,
  inputs: BundleInputs,
  deps: Pick<RestrictedHoldFenceDeps, 'holdings'> = {},
): Promise<RestrictedHoldRefusal | null> {
  if (!existsSync(root)) return null;
  let realRoot: string;
  let held: string[];
  try {
    realRoot = await realpath(root);
    held = await heldPathsUnder(realRoot, await (deps.holdings ?? restrictedHoldingsFor)(realRoot));
  } catch (error) {
    return {
      error: 'restricted_hold_state_unknown',
      hint: `could not verify whether a restricted session's writes are held in this checkout; the host bundle was not published (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (held.length === 0) return null;
  const real = async (abs: string): Promise<string> => realpath(abs).catch(() => resolve(abs));
  const files = new Set(await Promise.all(inputs.files.map(real)));
  const dirs = await Promise.all(inputs.dirs.map(real));
  const hit = held.find((abs) => files.has(abs) || dirs.some((dir) => abs === dir || abs.startsWith(dir + sep)));
  if (!hit) return null;
  const shown = hit.startsWith(realRoot + sep) ? hit.slice(realRoot.length + 1) : hit;
  return {
    error: 'restricted_write_held',
    hint:
      `the host bundle was not published: ${shown} is a bundle input and a held restricted write. A session holding an ` +
      `active personal disclosure wrote it, and the host would execute it with network access (D-012). The last-known-good ` +
      `bundle stays in place; restart the host after the disclosure is released`,
  };
}
