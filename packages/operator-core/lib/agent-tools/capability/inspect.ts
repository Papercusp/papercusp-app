/**
 * capability:inspect — READ-ONLY code verification (typecheck / test), the
 * sanctioned FOCUSED verify for fleet agents (EI-524, P-035 of
 * `agent-capability-confinement-2026-06-13`).
 *
 * HISTORY + why it still exists: under the original `bee` read-only confinement
 * (`papercusp-fleet-capability-only` cutover) a bee was envelope-denied
 * `capability:bash`, so this was its ONLY way to TYPECHECK or run TESTS before
 * diagnosing — the fix for EI-524's phantom F-FIX escalations (a bee
 * hallucinating a root cause it can't check). The `bee` confinement was LIFTED on
 * 2026-06-14 (bees now have `capability:fs-write` + `capability:bash`), but this
 * tool REMAINS the sanctioned focused verify: it runs a FIXED set of commands
 * (`npx tsc --noEmit`, `npm run test:affected`, `npx vitest run <path>`), never a
 * free-form command — the cheaper, injection-free path for the common "confirm a
 * claim before I report it" case (the verify-before-diagnose DISCIPLINE that
 * survives the capability change). It carries a SEPARATE capability string
 * (`capability:code-inspect`, tier low) distinct from write/exec (D-003).
 *
 * Security: the agent never supplies a command string — it picks a `check` (enum)
 * plus an optional `package` / `path`, both validated against a strict charset
 * (no shell metacharacters, no `..`, must resolve inside the project dir), so the
 * constructed `bash -c` command has no injection or command-chaining surface.
 * Execution reuses the same bash-jobs runner + exec-sandbox as capability:bash.
 */

import { isAbsolute, basename, dirname, relative, resolve } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import {
  DEFAULT_BACKGROUND_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_BACKGROUND_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  runForeground,
  startBackground,
} from './bash-jobs';
import { capabilityExecSandboxPolicy } from './exec-sandbox';
import { resolveCapabilityBaseDir } from './base-dir';
import { TSC_HEAP_MB, tscHeapEnv } from '../tsc-heap';
import { TSC_DECOY_BANNER } from '../../tsc-diagnostics';
import {
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
} from './foreground-transport-cap';
import {
  discoverSiblingTypecheckGates,
  gateCoveringFile,
} from '../../../../../scripts/lib/tsc-baseline-gate.mjs';

/**
 * A repo-relative path token safe to embed literally in a `bash -c` command: a
 * single token (no shell metacharacters, so it can't break out of the command),
 * starting with an alnum/underscore, and no `..` escape. Disallows spaces, `*`,
 * `;`, `|`, `&`, `$`, backticks, quotes, redirects, parens — the whole shell-
 * control surface.
 */
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/;

function validateRelPath(
  p: string,
  baseDir: string,
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  if (!SAFE_PATH.test(p)) {
    return { ok: false, reason: `path "${p}" has illegal characters (allowed: letters, digits, _ . / -)` };
  }
  if (p.split('/').some((seg) => seg === '..')) return { ok: false, reason: `path "${p}" must not contain a ".." segment` };
  if (isAbsolute(p)) return { ok: false, reason: `path "${p}" must be relative to the project dir` };
  const abs = resolve(baseDir, p);
  const rel = relative(baseDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `path "${p}" escapes the project dir` };
  return { ok: true, abs, rel };
}

/**
 * EI-21200682380693689: callers naturally pass the canonical npm WORKSPACE name
 * (`@papercusp/flags` — the spelling package.json and every import use), but npm
 * workspaces materialize packages as filesystem directories. Resolve a SCOPED
 * name through the node_modules symlink npm creates for every workspace and
 * return its repo-relative directory. Containment mirrors validateRelPath: the
 * resolved target must stay inside the project dir and outside node_modules
 * itself, so a vendored dependency can never become an inspect cwd. Scoped
 * names only — an unscoped one is ambiguous with a legitimate relative
 * directory. Returns null when the name does not resolve as a workspace alias;
 * the caller falls through to ordinary path validation (whose SAFE_PATH charset
 * rejects `@`, producing the actionable bad_package message).
 */
const NPM_SCOPED_NAME = /^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveNpmWorkspaceAlias(
  packageName: string,
  baseDir: string,
  realpath: (p: string) => string = realpathSync,
): string | null {
  if (!NPM_SCOPED_NAME.test(packageName)) return null;
  let abs: string;
  try {
    abs = realpath(resolve(baseDir, 'node_modules', packageName));
  } catch {
    return null;
  }
  const rel = relative(baseDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (rel.split(/[\\/]/).includes('node_modules')) return null;
  return rel;
}

/** Injectable seam so the pure resolver unit tests stay filesystem-free. */
type WorkspaceAliasResolver = (packageName: string, baseDir: string) => string | null;

function defaultResolveWorkspaceAlias(packageName: string, baseDir: string): string | null {
  return resolveNpmWorkspaceAlias(packageName, baseDir);
}

function validatePackageArg(
  p: string,
  baseDir: string,
  resolveWorkspaceAlias: WorkspaceAliasResolver,
): { ok: true; abs: string; rel: string } | { ok: false; reason: string } {
  const aliasRel = resolveWorkspaceAlias(p, baseDir);
  if (aliasRel !== null) {
    const abs = resolve(baseDir, aliasRel);
    return { ok: true, abs, rel: relative(baseDir, abs) };
  }
  return validateRelPath(p, baseDir);
}

function packagePathError(packageValue: string, reason: string): string {
  return `${reason} \`package\` must be a repository-relative directory containing tsconfig.json — ` +
    `for example, \`packages/operator-core\` — or the canonical npm workspace name such as ` +
    `\`@papercusp/operator-core\`. Received: \`${packageValue}\`.`;
}

export interface InspectArgs {
  check: 'typecheck' | 'test';
  package?: string;
  path?: string;
  onlyPaths?: string[];
}

export type InspectResolution =
  | { ok: true; command: string; cwd: string }
  | { ok: false; reason: string; message: string };

const TEST_PATH_CONFLICT_GUIDANCE =
  '`path` and `onlyPaths` cannot be supplied together for check:"test". Use `path` for one test file or directory, ' +
  'or use `onlyPaths` for an exact multi-file run.';

// The default package Vitest config excludes these files. Keep the resolver on
// the repository test router for the same owning-config selection that
// `npm run test:file` and the config's own startup guard enforce.
const LAYERED_TEST_FILE = /\.(integration|browser)\.test\.[cm]?[jt]sx?$/i;

const TSCONFIG_BASENAME = /^tsconfig(\.[\w-]+)?\.json$/;
const NODE_TEST_FILE = /\.[cm]?js$/i;
const SAFE_NPM_SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/;

function normalizeTestPathToken(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseExactNodeTestScript(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length !== 3 || tokens[0] !== 'node' || tokens[1] !== '--test') return null;
  const path = normalizeTestPathToken(tokens[2]);
  return SAFE_PATH.test(path) ? path : null;
}

function isNodeTestScript(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  return tokens.length >= 3 && tokens[0] === 'node' && tokens[1] === '--test';
}

/**
 * Resolve a JavaScript test in a package that declares Node's built-in test
 * runner. Prefer a package script that names exactly this file, then fall back
 * to the fixed direct runner. Packages without a declared node:test script stay
 * on the normal Vitest route.
 */
export function resolveNodeTestCommand(pathArg: string, cwd: string): InspectResolution | null {
  if (!NODE_TEST_FILE.test(pathArg)) return null;

  let scripts: Record<string, unknown>;
  try {
    const packageJson = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')) as {
      scripts?: unknown;
    };
    scripts = packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)
      ? (packageJson.scripts as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }

  const requested = normalizeTestPathToken(pathArg);
  let hasNodeTestScript = false;
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !isNodeTestScript(value)) continue;
    hasNodeTestScript = true;
    const exactPath = parseExactNodeTestScript(value);
    if (exactPath && exactPath === requested && SAFE_NPM_SCRIPT_NAME.test(name)) {
      return { ok: true, command: `npm run ${name}`, cwd };
    }
  }

  return hasNodeTestScript ? { ok: true, command: `node --test ${pathArg}`, cwd } : null;
}

/**
 * Map the validated args to the fixed verification command + cwd, or an error.
 * Exported so the (security-load-bearing) command construction is unit-tested
 * without executing anything: path validation stays charset+containment only,
 * and the npm-workspace alias resolution is INJECTABLE (tests stub it), so the
 * suite stays deterministic. The agent's only inputs are `check` (enum) and the
 * validated `package`/`path`; the command verb is never agent text.
 */
export function resolveInspectCommand(
  args: InspectArgs,
  baseDir: string,
  resolveWorkspaceAlias: WorkspaceAliasResolver = defaultResolveWorkspaceAlias,
): InspectResolution {
  let cwd = baseDir;
  if (args.package !== undefined) {
    const v = validatePackageArg(args.package, baseDir, resolveWorkspaceAlias);
    if (!v.ok) return { ok: false, reason: 'bad_package', message: packagePathError(args.package, v.reason) };
    cwd = v.abs;
  }

  let pathArg = '';
  if (args.path !== undefined) {
    if (args.check !== 'test') return { ok: false, reason: 'bad_args', message: '`path` is only valid for check:"test".' };
    // Callers frequently copy a repository-relative path from testing:run's
    // diagnostics while also supplying `package`. Interpret that spelling
    // against the repository root, then convert it to the package-relative
    // token the package-local Vitest command expects. Without this branch,
    // `packages/foo` is appended to an already package-local cwd and Vitest
    // reports "No test files found" for an otherwise valid file.
    const packageRel = args.package === undefined ? '' : relative(baseDir, cwd);
    const isRepoRelative =
      Boolean(packageRel) &&
      (args.path === packageRel || args.path.startsWith(`${packageRel}/`));
    const v = validateRelPath(args.path, isRepoRelative ? baseDir : cwd);
    if (!v.ok) return { ok: false, reason: 'bad_path', message: v.reason };
    pathArg = isRepoRelative ? relative(cwd, v.abs) : v.rel;
  }

  if (args.check === 'test' && args.onlyPaths && args.onlyPaths.length > 0) {
    if (args.path !== undefined) {
      return { ok: false, reason: 'bad_args', message: TEST_PATH_CONFLICT_GUIDANCE };
    }

    // `test:file` is the repository's canonical exact-test router: it accepts
    // multiple paths and selects the owning Vitest or Node:test configuration.
    // Callers with a package commonly mix package-relative paths with paths
    // copied from repo-level diagnostics, so accept both spellings and always
    // hand the root router repo-relative tokens.
    const packageRel = args.package === undefined ? '' : relative(baseDir, cwd);
    const repoPaths: string[] = [];
    for (const raw of args.onlyPaths) {
      const normalized = normalizeTestPathToken(raw);
      const isRepoRelative =
        Boolean(packageRel) &&
        (normalized === packageRel || normalized.startsWith(`${packageRel}/`));
      const v = validateRelPath(normalized, isRepoRelative ? baseDir : cwd);
      if (!v.ok) return { ok: false, reason: 'bad_only_path', message: v.reason };
      repoPaths.push(relative(baseDir, v.abs).replace(/\\/g, '/'));
    }

    return { ok: true, command: `npm run test:file -- ${repoPaths.join(' ')}`, cwd: baseDir };
  }

  if (args.check === 'typecheck') {
    if (args.package === undefined) {
      return { ok: false, reason: 'bad_args', message: 'typecheck requires `package` (the dir holding tsconfig.json).' };
    }

    return { ok: true, command: 'npx tsc --noEmit', cwd };
  }

  // check === 'test'
  if (args.package === undefined && !pathArg) return { ok: true, command: 'npm run test:affected', cwd };

  if (pathArg && LAYERED_TEST_FILE.test(pathArg)) {
    // `test:file` owns config discovery and must run from the repository root.
    // Convert the package-relative path back to a root-relative spelling so
    // the router can select the integration/browser Vitest project.
    const repoRelativePath = relative(baseDir, resolve(cwd, pathArg));
    return { ok: true, command: `npm run test:file -- ${repoRelativePath}`, cwd: baseDir };
  }

  const nodeTest = pathArg ? resolveNodeTestCommand(pathArg, cwd) : null;
  if (nodeTest) return nodeTest;

  return { ok: true, command: `npx vitest run${pathArg ? ` ${pathArg}` : ''}`, cwd };
}

interface TypecheckGate {
  npmScript: string;
  prefixes: string[];
}

/**
 * Build the baseline-aware command for an `onlyPaths` typecheck from the gate
 * roster's OWN declared coverage.
 *
 * EI-20475898313139226: `onlyPaths` used to be a foreground-only output filter
 * over raw `npx tsc --noEmit`; the background branch returned before it and
 * silently ignored the scope. Blindly appending `--files=` to the package's
 * `typecheck` script is also unsafe — some workspaces still expose raw `tsc -p`,
 * where `--files` is an unknown compiler option. The root `lint:tsc*` roster is
 * the canonical reusable surface: each gate declares the prefixes it compiles,
 * and `gateCoveringFile` selects the most specific one.
 */
export function resolveScopedTypecheckCommand(
  args: InspectArgs,
  baseDir: string,
  gates: TypecheckGate[],
  pathExists: (repoRelativePath: string) => boolean = (path) => existsSync(resolve(baseDir, path)),
  resolveWorkspaceAlias: WorkspaceAliasResolver = defaultResolveWorkspaceAlias,
): InspectResolution {
  if (args.check !== 'typecheck' || !args.onlyPaths || args.onlyPaths.length === 0) {
    return {
      ok: false,
      reason: 'bad_args',
      message: 'A scoped typecheck requires check:"typecheck" and non-empty `onlyPaths`.',
    };
  }
  if (args.package === undefined) {
    return { ok: false, reason: 'bad_args', message: 'typecheck requires `package` (the dir holding tsconfig.json).' };
  }

  const pkg = validatePackageArg(args.package, baseDir, resolveWorkspaceAlias);
  if (!pkg.ok) return { ok: false, reason: 'bad_package', message: packagePathError(args.package, pkg.reason) };
  const packageRel = TSCONFIG_BASENAME.test(basename(pkg.rel)) ? dirname(pkg.rel) : pkg.rel;

  const normalized: string[] = [];
  const selectedScripts = new Set<string>();
  for (const raw of args.onlyPaths) {
    const stripped = raw.replace(/^\.\//, '');
    const direct = validateRelPath(stripped, baseDir);
    if (!direct.ok) return { ok: false, reason: 'bad_only_path', message: direct.reason };

    const alreadyPackageRelative = stripped === packageRel || stripped.startsWith(`${packageRel}/`);
    const prefixed = alreadyPackageRelative
      ? direct
      : validateRelPath(`${packageRel}/${stripped}`, baseDir);
    if (!prefixed.ok) return { ok: false, reason: 'bad_only_path', message: prefixed.reason };

    // A literal repo-relative spelling that is covered by a declared gate wins;
    // otherwise interpret the value relative to `package`. This makes both
    // documented forms work and prevents `apps/other/src/x.ts` from becoming
    // the plausible-but-wrong `packages/current/apps/other/src/x.ts`.
    const prefixedGate = pathExists(prefixed.rel) ? gateCoveringFile(gates, prefixed.rel) : null;
    const directGate = alreadyPackageRelative
      ? prefixedGate
      : pathExists(direct.rel)
        ? gateCoveringFile(gates, direct.rel)
        : null;
    const chosen = directGate
      ? { path: direct.rel, gate: directGate }
      : prefixedGate
        ? { path: prefixed.rel, gate: prefixedGate }
        : null;
    if (!chosen) {
      const coveredButMissing =
        gateCoveringFile(gates, prefixed.rel) !== null || gateCoveringFile(gates, direct.rel) !== null;
      return {
        ok: false,
        reason: coveredButMissing ? 'only_path_not_found' : 'no_baseline_gate',
        message: coveredButMissing
          ? `onlyPath "${raw}" does not resolve to an existing repository file (tried "${prefixed.rel}" and "${direct.rel}"). ` +
            'Refusing a scoped green from a file set that was never present.'
          : `No resolvable repository baseline gate covers onlyPath "${raw}" (tried "${prefixed.rel}" and "${direct.rel}"). ` +
            'A scoped verifier cannot honestly judge this file; run the owning project gate or add its coverage declaration.',
      };
    }
    normalized.push(chosen.path);
    selectedScripts.add(chosen.gate.npmScript);
  }

  if (selectedScripts.size !== 1) {
    return {
      ok: false,
      reason: 'mixed_baseline_gates',
      message:
        `onlyPaths span multiple repository typecheck gates (${[...selectedScripts].sort().join(', ')}). ` +
        'Split them into one capability:inspect call per gate so each verdict remains attributable.',
    };
  }

  const npmScript = [...selectedScripts][0];
  return {
    ok: true,
    command: `npm run ${npmScript} -- --files=${normalized.join(',')}`,
    cwd: baseDir,
  };
}

/**
 * EI-19332092038566982 / EI-19331889744736428: `child_process.spawn`'s `cwd` must be a real
 * DIRECTORY — passing it a FILE fails with an opaque `spawn ENOTDIR` (no path, no hint, nothing
 * an agent can act on). The #1 wrong call shape observed live (6 of 6 sampled watchdog failures,
 * plus an independently-filed duplicate) is `package: '<dir>/tsconfig.json'` — the tsconfig PATH
 * where this tool wants its containing directory. `build:typecheck`'s own `project` arg DOES take
 * the tsconfig path, and its timeout hint carried that convention across by mistake (fixed
 * separately), so this is a call shape agents genuinely produce, not a hypothetical.
 *
 * Auto-correct the common case (a `tsconfig*.json` file) rather than erroring on it — the caller's
 * intent is unambiguous. Anything else that isn't a directory fails with an ACTIONABLE message
 * instead of ever reaching spawn. Pure given the caller's own directory-existence probe, so this
 * stays unit-testable without touching the filesystem.
 */
export function resolveTypecheckCwd(
  cwd: string,
  cwdIsDirectory: boolean,
): { ok: true; cwd: string; corrected: boolean } | { ok: false; reason: string; message: string } {
  if (cwdIsDirectory) return { ok: true, cwd, corrected: false };
  if (TSCONFIG_BASENAME.test(basename(cwd))) {
    return { ok: true, cwd: dirname(cwd), corrected: true };
  }
  return {
    ok: false,
    reason: 'bad_package_not_a_directory',
    message:
      `\`package\` must be a directory (the one holding tsconfig.json) — "${cwd}" is not a directory. ` +
      'Pass the containing directory, e.g. `package: "packages/operator-core"` rather than ' +
      '`package: "packages/operator-core/tsconfig.json"`.',
  };
}

/**
 * Parse raw `tsc --noEmit` output and optionally retain diagnostics referencing
 * selected paths. This remains the shared diagnostic counter used by the dead-run
 * guard below.
 *
 * EI-20475898313139226: this is deliberately NO LONGER the implementation of
 * capability:inspect's `onlyPaths` verdict. Post-filtering raw tsc output cannot
 * distinguish an accepted per-file baseline from a new regression, and the
 * background branch never reached the filter at all. The handler now discovers
 * the repository baseline gate whose declared coverage owns each path and
 * carries `onlyPaths` into its `--files=` command for both execution modes.
 *
 * A tsc error line is `path/to/file.ts(line,col): error TS####: msg`; we match the
 * path token before "(" against each onlyPath loosely (either string contains the
 * other) so package-relative and repo-relative spellings both work. Pure +
 * exported so the parser/filter remains unit-tested.
 */
/**
 * Classify a typecheck run that emitted ZERO diagnostics: did it pass, or did it DIE?
 *
 * WHY (EI-20019651513530828 / EI-20013137550825704, both measured 2026-08-09): a
 * `tsc` that OOMs (operator-core is ~9k files and overflows node's default ~4GB
 * old-space) is killed by V8 BEFORE it emits a single diagnostic. Every probe an
 * agent naturally runs on that output then reads as clean:
 *
 *     grep -c "error TS" <log>        -> 0
 *     grep "<my changed file>" <log>  -> (nothing)
 *
 * Both are the SAME output a genuinely clean compile produces, so the natural
 * conclusion is "my change is fine" — reached having verified nothing. One agent
 * got to within one step of recording "operator-core typechecks clean with the new
 * required field", on precisely the question (does a new REQUIRED field strand
 * construction sites in files I never touched?) that this repo flags as the classic
 * silent breaker.
 *
 * Same family as the zero-work false greens already guarded elsewhere (`tsc -p .`
 * checking zero files; `test:affected` selecting zero suites; a `-t` filter matching
 * zero tests) — but reached by a CRASH rather than by selecting nothing, which is
 * why those guards never caught it.
 *
 * Returns null when the run is entitled to be read as clean; otherwise the verdict
 * to surface. Pure + exported so the classification is unit-tested against captured
 * output rather than by inducing a real OOM.
 */
export function deadTypecheckVerdict(run: {
  exitCode: number | null;
  status: string;
  output: string;
  parsedErrors: number;
}): { reason: string; headline: string; advice: string } | null {
  // tsc exits nonzero WITH diagnostics for ordinary type errors — that is a real
  // result, not a dead run. Only silence plus failure is suspect.
  if (run.parsedErrors > 0) return null;
  const clean = run.exitCode === 0 && run.status === 'completed';
  if (clean) return null;

  const out = run.output ?? '';

  // EI-22142032090978471 — no compiler ran at all: `npx` resolved the REGISTRY
  // squatter named `tsc` instead of the local binary.
  //
  // `npx <tool>` does not fail when the tool is missing from node_modules/.bin —
  // it silently downloads and runs whatever package carries that name. For `tsc`
  // that is `tsc@2.0.4` ("A deprecated release of the TypeScript compiler"),
  // whose entire body prints a banner and sets `process.exitCode = 1`.
  //
  // The generic branch below already refuses to call this clean, which is why it
  // was never a false green (measured 2026-09-02: exit 1 in every invocation
  // shape, including a cold npx cache — the filed report's "EXITS 0" does not
  // reproduce). What it got WRONG was the CAUSE: it sent the reader after "a bad
  // --project operand, a missing tsconfig, or a crash", none of which is true and
  // all of which are expensive to rule out. The condition is a missing/half-built
  // `node_modules`, so name it and hand over the one-line repair.
  if (TSC_DECOY_BANNER.test(out)) {
    return {
      reason: 'typecheck_ran_npx_decoy_package',
      headline:
        '🚨 THIS RUN MEASURED NOTHING — no TypeScript compiler ran. `npx tsc` could not find a local ' +
        'tsc binary, so it downloaded and ran the unrelated registry package named `tsc`, which only prints a banner.',
      advice:
        'Your tsconfig and your code are not implicated — `node_modules/.bin/tsc` is missing or half-written ' +
        '(commonly a peer running an install on the shared tree). Run `npm run install:safe`, then re-run this check. ' +
        'Do not read anything about your types from this output.',
    };
  }

  const oom =
    /JavaScript heap out of memory|Ineffective mark-compacts near heap limit|FATAL ERROR:.*heap/i.test(out) ||
    // SIGABRT — how V8 terminates on heap exhaustion once it gives up.
    run.exitCode === 134 ||
    /Aborted \(core dumped\)/i.test(out);

  if (oom) {
    return {
      reason: 'typecheck_died_out_of_memory',
      headline:
        '🚨 THIS RUN MEASURED NOTHING — tsc ran out of heap and was killed before emitting any diagnostics. ' +
        'Zero errors here does NOT mean your code typechecks.',
      advice:
        `Re-run with a larger heap: NODE_OPTIONS=--max-old-space-size=${TSC_HEAP_MB} (or \`npm run lint:tsc -- --files=<your files>\`, ` +
        'which pins it for you). This tool now sets that heap itself, so an OOM here means the target needs more than the current ceiling.',
    };
  }
  if (run.status === 'timed_out') {
    return {
      reason: 'typecheck_timed_out_without_diagnostics',
      headline:
        '🚨 THIS RUN MEASURED NOTHING — the typecheck was killed at its timeout before emitting any diagnostics. ' +
        'Zero errors here does NOT mean your code typechecks.',
      advice: 'Re-run detached: capability:inspect { …same args…, run_in_background: true }, then poll capability:bash_output.',
    };
  }
  return {
    reason: 'typecheck_died_without_diagnostics',
    headline:
      `🚨 THIS RUN MEASURED NOTHING — tsc exited ${run.exitCode ?? 'null'} without emitting any diagnostics. ` +
      'Zero errors here does NOT mean your code typechecks.',
    advice:
      'Read the head of the output for the real cause (a bad --project operand, a missing tsconfig, or a crash). ' +
      'A nonzero exit with no diagnostics is never a pass.',
  };
}

export function filterTscOutputToPaths(
  output: string,
  onlyPaths: string[],
): { matchedErrors: number; totalErrors: number; matchedLines: string[] } {
  const errRe = /\berror TS\d+\b/;
  const needles = onlyPaths.map((p) => p.replace(/^\.\//, '').trim()).filter(Boolean);
  const matchedLines: string[] = [];
  let totalErrors = 0;
  for (const ln of output.split('\n')) {
    if (!errRe.test(ln)) continue;
    totalErrors += 1;
    const pathTok = ln.split('(')[0].trim().replace(/^\.\//, '');
    if (pathTok && needles.some((p) => pathTok.includes(p) || p.includes(pathTok))) matchedLines.push(ln);
  }
  return { matchedErrors: matchedLines.length, totalErrors, matchedLines };
}

// EI-6073's foreground clamp + hint now live in ./foreground-transport-cap, because
// `testing:run`, `build:typecheck` and `capability:bash` all need them and were reaching
// into THIS tool to get them (EI-20645849301780712). See that module's header for why the
// ceiling must never be raised toward the cap.

export default defineTool({
  name: 'capability:inspect',
  description:
    'Run a READ-ONLY code verification (typecheck or test) to confirm a claim about the code before diagnosing. Fixed safe commands only (npx tsc --noEmit, npm run test:affected, package-local npx vitest run, or the repository test:file router for layered tests); never an arbitrary shell command. Use this — not capability:bash — to verify.',
  guidance: {
    when: 'VERIFY a code claim before you report or diagnose: typecheck a package after a suspected type error, or run a package / test-file suite to confirm a failure actually reproduces. This is the sanctioned read-only exec for confined fleet agents (capability:bash is gated for them).',
    notWhen:
      'To READ a file use capability:read; to SEARCH use the Grep tool. To run an arbitrary or mutating command you need capability:bash (gated — escalate if you truly need it). This tool runs ONLY tsc --noEmit / tests, never a free-form command.',
    chaining:
      'capability:read / Grep (inspect) → capability:inspect (typecheck/test to CONFIRM) → report a VERIFIED diagnosis. For a long suite pass run_in_background:true and poll capability:bash_output; the launch response includes bash_id plus durable task_id.',
    seeAlso: [
      'capability:read (raw file content)',
      'capability:bash (arbitrary / mutating command — gated)',
      'capability:bash_output (poll a long suite)',
    ],
  },
  capability: 'capability:code-inspect',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  // Mirror capability:bash: the dispatch wall-clock must exceed the max command timeout.
  timeoutSec: Math.floor(MAX_TIMEOUT_MS / 1000) + 30,
  // EI-18666279107998059: same rationale as capability:bash — this handler awaits
  // the same bash-jobs runner and never reads ctx.tx, so it must not hold the
  // ambient workspace transaction open for the whole run. See
  // ProjectedTool.skipWorkspaceTx.
  skipWorkspaceTx: true,
  events: { output: z.string().describe('text/plain') },
  args: z.object({
    check: z
      .enum(['typecheck', 'test'])
      .describe('typecheck = `npx tsc --noEmit` in the package; test = the package suite (`npx vitest run`), the repository `npm run test:file -- <path…>` router for exact one- or multi-file runs, or, with no package and no paths, the repo `npm run test:affected`.'),
    package: z
      .string()
      .optional()
      .describe(
        'Repository-relative directory path to run in, e.g. "packages/operator-core", or the canonical npm ' +
          'workspace name such as "@papercusp/operator-core" (resolved via its node_modules workspace link). ' +
          'It must contain tsconfig.json for typecheck. For test, omit to run `npm run test:affected` at the repo root.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'test only: one test file/dir to narrow the run (e.g. "lib/foo.test.ts"). When `package` is supplied, ' +
          'the path is package-relative; when omitted, it is repo-relative. Layered `.integration.test.*`/`.browser.test.*` ' +
          'files are routed through the repository `test:file` command automatically. For multiple exact files, use `onlyPaths` instead; do not pass both fields.',
      ),
    onlyPaths: z
      .array(z.string().min(1).max(300))
      .max(50)
      .optional()
      .describe(
        'Exact paths for a focused run. For test, pass one or more package-relative paths (when `package` is supplied) or repo-relative paths (when omitted); they run through the root `npm run test:file -- <paths…>` router. For typecheck, discover the repository baseline gate that covers these package- or repo-relative paths, then scope its verdict via `--files=`. Mixed or uncovered gate scopes are refused rather than guessed.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      // WI-42443: `processes:kill { taskId }`, not capability:bash_kill — that verb is absent
      // from trimmed surfaces (su) and refused for some principals, so naming it here routes
      // the caller to something it cannot invoke (the EI-21543657511391052 defect, third site).
      .describe('Run detached; returns a bash_id immediately. Poll with capability:bash_output, stop with processes:kill { taskId }.'),
    runInBackground: z
      .boolean()
      .optional()
      .describe('Compatibility alias for run_in_background; the snake_case spelling is canonical.'),
    timeout: z
      .number()
      .int()
      .positive()
      .max(MAX_BACKGROUND_TIMEOUT_MS)
      .optional()
      .describe(
        `Wall-clock timeout in ms. FOREGROUND: default ${DEFAULT_TIMEOUT_MS}, clamped to ${FOREGROUND_TIMEOUT_CEILING_MS}ms (below the ~55s MCP transport cap) so it returns a hint instead of an opaque request_timeout. BACKGROUND (run_in_background): default ${DEFAULT_BACKGROUND_TIMEOUT_MS}, max ${MAX_BACKGROUND_TIMEOUT_MS} — not bound by the transport cap, but still terminated at its own deadline.`,
      ),
  }),
  async handler(args, ctx) {
    const baseDir = resolveCapabilityBaseDir(ctx);
    let resolved: InspectResolution;
    if (args.check === 'typecheck' && args.onlyPaths && args.onlyPaths.length > 0) {
      const discovered = await discoverSiblingTypecheckGates(baseDir);
      if (!discovered.rosterReadable) {
        return err(
          'baseline_gate_roster_unreadable',
          'Could not read the repository typecheck-gate roster from package.json, so `onlyPaths` cannot be judged honestly.',
        );
      }
      resolved = resolveScopedTypecheckCommand(args, baseDir, discovered.gates);
      if (!resolved.ok && resolved.reason === 'no_baseline_gate' && discovered.unresolved.length > 0) {
        const unresolved = discovered.unresolved
          .slice(0, 5)
          .map((gate) => `${gate.npmScript}: ${gate.reason}`)
          .join('; ');
        resolved = {
          ...resolved,
          message: `${resolved.message} Unresolved roster entries (coverage UNKNOWN): ${unresolved}`,
        };
      }
    } else {
      resolved = resolveInspectCommand(args, baseDir);
    }
    if (!resolved.ok) return err(resolved.reason, resolved.message);
    const { command } = resolved;
    let cwd = resolved.cwd;

    // EI-19332092038566982 / EI-19331889744736428: `cwd` must be a real directory or spawn fails
    // with an opaque `spawn ENOTDIR`. Validate (and auto-correct the tsconfig-file case) BEFORE
    // ever reaching spawn, foreground or background.
    let cwdCorrectionNote = '';
    let cwdIsDirectory = false;
    try {
      cwdIsDirectory = (await stat(cwd)).isDirectory();
    } catch {
      cwdIsDirectory = false;
    }
    const cwdResolution = resolveTypecheckCwd(cwd, cwdIsDirectory);
    if (!cwdResolution.ok) return err(cwdResolution.reason, cwdResolution.message);
    if (cwdResolution.corrected) {
      cwd = cwdResolution.cwd;
      cwdCorrectionNote = `⚠ \`package\` named a tsconfig.json file, not its directory — auto-corrected to run in ${relative(baseDir, cwd) || '.'}.\n`;
    }

    // WI-6677: mode-dependent default, same as capability:bash. A detached suite is
    // exactly what run_in_background is FOR here, so it must not inherit the short
    // foreground default that exists to stay under the MCP transport cap.
    // Keep the snake_case field canonical while accepting the camelCase spelling emitted by
    // older model-facing surfaces. An explicitly supplied snake_case value wins.
    const runInBackground = args.run_in_background ?? args.runInBackground;
    const requestedTimeoutMs =
      args.timeout ?? (runInBackground ? DEFAULT_BACKGROUND_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // Reuse the actual capability:bash boundary profile. A fixed verification
    // command is still real code execution and must not raw-downgrade for a
    // confined session.
    const sandboxPolicy = await capabilityExecSandboxPolicy(ctx);

    // EI-20019651513530828: pin the tsc child's heap. operator-core overflows node's
    // DEFAULT ~4GB old-space and is killed BEFORE emitting any diagnostics, which reads
    // as a clean compile to every natural probe. Typecheck only — a suite run has its
    // own memory profile and is not the measured failure.
    const execEnv = args.check === 'typecheck' ? tscHeapEnv() : undefined;

    if (runInBackground) {
      // Background is uncapped by the MCP transport (returns a bash_id immediately), so it
      // honors the full requested timeout.
      const job = startBackground({
        command,
        cwd,
        stateDir: ctx.stateDir,
        sandboxEnabled: sandboxPolicy.enabled,
        sandboxRequired: sandboxPolicy.required,
        env: execEnv,
      }, requestedTimeoutMs);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              bash_id: job.id,
              task_id: job.taskId,
              status: 'running',
              check: args.check,
              command,
              cwd,
              log_path: job.logPath,
              // WI-42443: the STOP route must name processes:kill { taskId } — capability:bash_kill
              // is absent from trimmed surfaces (su) and refused for some principals. This is
              // runtime advice handed over at the moment a background job is running, so a route
              // the caller cannot invoke is worse here than in a static seeAlso. Note the
              // identifier changes with the verb: processes:kill takes the durable taskId, not
              // the bash_id. Matches capability:bash's own advice string (bash.ts:462).
              advice: `${cwdCorrectionNote}Verification started. Read output: capability:bash_output { bash_id: "${job.id}" }. Stop: processes:kill { taskId: "${job.taskId}" }.`,
            }),
          },
        ],
      };
    }

    // EI-6073: clamp the foreground timeout below the ~55s MCP transport cap so the tool
    // returns a graceful timeout + hint instead of being hard-killed with an opaque
    // request_timeout (the friction on large packages like operator-core).
    const timeoutMs = clampForegroundTimeoutMs(requestedTimeoutMs);
    const r = await runForeground(
      {
        command,
        cwd,
        stateDir: ctx.stateDir,
        onChunk: (chunk) => ctx.emit('output', chunk),
        sandboxEnabled: sandboxPolicy.enabled,
        sandboxRequired: sandboxPolicy.required,
        env: execEnv,
      },
      ctx.signal,
      timeoutMs,
    );

    // Unfiltered typecheck: the same false green, one step earlier. `(no output)` or a
    // truncated OOM trace reads as "nothing to report" unless the death is NAMED.
    const deadUnfiltered =
      args.check === 'typecheck'
        ? deadTypecheckVerdict({
            exitCode: r.exitCode,
            status: r.status,
            output: r.output,
            parsedErrors: filterTscOutputToPaths(r.output, []).totalErrors,
          })
        : null;

    const header =
      `${args.check} · exit ${r.exitCode ?? 'null'}` +
      (r.status !== 'completed' ? ` (${r.status})` : '') +
      ` · ${(r.durationMs / 1000).toFixed(1)}s · ${command} · cwd ${cwd}` +
      (r.truncated ? ` · output spilled (${r.totalBytes} bytes) → ${r.logPath}` : '');

    const deadBanner = deadUnfiltered
      ? `\n${deadUnfiltered.headline}\n${deadUnfiltered.advice}\nreason: ${deadUnfiltered.reason}`
      : '';

    return {
      content: [
        {
          type: 'text' as const,
          text: `${cwdCorrectionNote}${header}${deadBanner}${foregroundTimeoutHint(r.status, timeoutMs, 'capability:inspect { …same args…, run_in_background: true }')}\n${r.output || '(no output)'}`,
        },
      ],
      // A crash that produced no diagnostics is an ERROR, not a quiet pass. This used to
      // require exitCode === null, so an OOM (exit 134) was not flagged at all.
      isError: deadUnfiltered !== null || (r.status === 'failed' && r.exitCode === null),
    };
  },
});

function err(reason: string, message: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, reason, message }) }],
    isError: true,
  };
}
