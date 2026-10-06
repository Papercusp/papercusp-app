/**
 * lint-tests.ts — CI guard for the four-framework rule + tab visibility.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-038; extended by the
 * test-framework coverage audit (2026-06-02).
 *
 * D-006 says new tests go in Vitest / Playwright / Cargo / LLM
 * scenarios — never `.mjs` integration scripts or tsx `-smoke.ts`
 * files. This lint enforces FIVE things:
 *
 *   1. No NEW `.mjs` under `apps/operator/__tests__/integration/`
 *      (debt counter `lint-tests-debt.json` accepts pre-existing).
 *   2. No NEW `-smoke.ts` under `apps/operator/scripts/`.
 *   3. COVERAGE: every canonical `*.test.ts(x)` / `*.spec.ts` matches at
 *      least one registry glob (`.papercusp/testing-domains.json`), so it
 *      shows up in the /adv Tests tab. An orphaned test is invisible —
 *      this is the failure the audit fixed (614 of 1168 were orphaned).
 *      Fix by widening a domain in testing-domains-registry.ts, then
 *      `npx tsx scripts/gen-testing-domains-contract.ts`.
 *   4. RUNNABILITY: every registry-visible canonical test resolves to a
 *      Vitest config that includes it, or an explicit Playwright,
 *      WebdriverIO, or Node:test executor (EI-15951).
 *   5. No bash `*.test.sh` / `*.spec.sh` ANYWHERE (EI-1736). No CI runner
 *      globs them (test:affected only globs Vitest `*.test.ts`), so they
 *      masquerade as coverage while silently never running — and the
 *      `set -e` + `((x++))` trap aborts them after Test 1. Use a Vitest
 *      `*.test.ts` that shells out to bash (e.g.
 *      `apps/operator/lib/release/verify-release-paths.test.ts`).
 *
 * The debt JSON only shrinks (removing a migrated entry succeeds; adding
 * one is rejected at review).
 *
 * Exit code:
 *   0 — clean
 *   1 — at least one offender (new ad-hoc file OR an orphaned test)
 *
 * Usage:
 *   tsx apps/operator/scripts/lint-tests.ts
 */

import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findUnrunnableTests } from '@papercusp/operator-core/lib/test-executor-runnability';
import { ADMIN_TEST_SUITE_IDS } from '@papercusp/operator-core/lib/admin-test-suites-shared';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(__dirname);

interface Debt {
  integrationMjs: string[];
  scriptsSmoke: string[];
}

function resolveRepoRoot(from: string): string {
  let dir = resolve(from);
  while (true) {
    // .git is the universal marker — works for any workspace shape.
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

async function loadDebt(): Promise<Debt> {
  const debtPath = join(REPO_ROOT, 'apps/operator/scripts/lint-tests-debt.json');
  const raw = await readFile(debtPath, 'utf8');
  const parsed = JSON.parse(raw) as Partial<Debt>;
  return {
    integrationMjs: parsed.integrationMjs ?? [],
    scriptsSmoke: parsed.scriptsSmoke ?? [],
  };
}

async function listFiles(dir: string, predicate: (name: string) => boolean): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const e of entries) {
    if (e.isFile() && predicate(e.name)) {
      hits.push(e.name);
    }
  }
  return hits;
}

/* ----------------------------------------------------------------- *
 * Coverage check — every canonical test must match a registry glob, so
 * it shows up in the /adv Tests tab. Mirrors the glob walker in
 * @papercusp/testing-shell/glob (kept dependency-free here on purpose).
 * Without this, agents add correctly-named Vitest/Playwright tests in
 * new files that no domain globs and they become invisible in the tab
 * (the failure this audit fixed: 614 of 1168 tests were orphaned).
 * ----------------------------------------------------------------- */

const COVERAGE_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '.turbo', 'dist', 'build', 'out',
  '.svelte-kit', '.cache', 'target', 'coverage', '_retired',
  // Generated/state artifacts, never canonical test homes. gen:lib-api
  // (TypeDoc) mirrors source test files into .papercusp/lib-api/**/_media/,
  // which otherwise surface here as orphans whenever someone regenerates.
  '.papercusp',
  // Test FIXTURES are seeded sandboxes / test data (e.g. the hive-eval seed-app's
  // own `node --test` suite the throwaway Hive runs against), not operator tests —
  // they belong to the fixture's runtime, never the /adv Tests tab.
  'fixtures',
  // Transient vitest scratch: the test-data-generator seeds temp `.vitest-tmp/tdg-*`
  // test trees that leak into the walk mid-run and surface as phantom orphans. And
  // `scratch/` is the throwaway demo space (dummy-plan-demo/*), never canonical app tests.
  '.vitest-tmp', 'vitest-tmp', 'scratch',
]);

// Repo-root-relative dirs to skip WHOLESALE — matched by FULL POSIX path (not
// basename like COVERAGE_IGNORE_DIRS, which matches at any depth), so ONLY the
// intended dir is skipped. `templates/` is the vendored first-party template
// store (local-first-party-template-bundling-2026-07-07): PORTABLE content copied
// verbatim into a composed downstream app, whose `checks/*.test.ts` are the
// DOWNSTREAM app's tests (they run inside that generated app, never in operator
// CI), so they belong in no operator domain and must not surface in the /adv Tests
// tab. A basename skip would ALSO hide the real operator test at
// packages/operator-core/lib/agent-tools/templates/new-app.test.ts — hence this is
// path-anchored to the top-level store alone.
const COVERAGE_IGNORE_REL = new Set([
  'templates',
  // The Tauri desktop SUBMODULE's build-artifact + own-test trees. The walk starts
  // at the superproject root and descends into papercusp-desktop/ (a SEPARATE
  // project — Rust cargo + node:test, covered by its OWN registry entries), so these
  // leak as phantom operator-test orphans:
  //   • src-tauri/sidecar      — gitignored sidecar BUNDLE (build-desktop-sidecar.sh
  //                              copies harness/ + templates/ in; their *.test.ts are
  //                              bundle COPIES, not operator tests). Exists only after
  //                              a local build; test:affected never runs it (not an
  //                              npm workspace).
  //   • src-tauri/env-sidecars — the WI-3287 STAGED staging-env sidecar: a committed
  //                              snapshot of that same bundle (harness/ + templates/).
  //   • test                   — the submodule's own node:test dir (no test runner in
  //                              its package.json); not an operator test.
  // Nothing is lost: the ORIGINALS are covered elsewhere —
  // libs/papercusp/packages/harness/paths.test.ts runs in the harness workspace, and
  // templates/*/checks/*.test.ts are the downstream-APP's tests (top-level `templates`
  // above). Path-anchored (not a basename skip) so the real operator test at
  // packages/operator-core/lib/agent-tools/templates/new-app.test.ts stays visible.
  'papercusp-desktop/src-tauri/sidecar',
  'papercusp-desktop/src-tauri/env-sidecars',
  'papercusp-desktop/test',
]);

const CANONICAL_TEST_RE = /\.(test|spec)\.(ts|tsx|mts|cts|mjs|js|jsx)$/;

/** Split a glob into [literalPrefix, remainder] — see testing-shell/glob.ts. */
function splitPrefix(pattern: string): [string, string] {
  const meta = pattern.search(/[*?[]/);
  if (meta < 0) return [pattern, ''];
  const cut = pattern.lastIndexOf('/', meta);
  if (cut < 0) return ['', pattern];
  return [pattern.slice(0, cut), pattern.slice(cut + 1)];
}

/** Compile a glob remainder to an anchored RegExp (bracket-safe). */
function remainderToRegex(rem: string): RegExp {
  let out = '^';
  for (let i = 0; i < rem.length; i++) {
    const c = rem[i];
    if (c === '*') {
      if (rem[i + 1] === '*') { out += '.*'; i++; if (rem[i + 1] === '/') i++; }
      else { out += '[^/]*'; }
    } else if (c === '?') { out += '[^/]'; }
    else if (/[.+^$()|\\[\]]/.test(c)) { out += `\\${c}`; }
    else { out += c; }
  }
  return new RegExp(out + '$');
}

interface CompiledGlob { prefix: string; re: RegExp | null; literal: string | null; }
function compileGlob(pattern: string): CompiledGlob {
  const [prefix, remainder] = splitPrefix(pattern);
  if (!remainder) return { prefix, re: null, literal: prefix };
  return { prefix, re: remainderToRegex(remainder), literal: null };
}
function globMatches(g: CompiledGlob, relPath: string): boolean {
  if (g.re === null) return relPath === g.literal;
  if (g.prefix !== '' && !relPath.startsWith(g.prefix + '/')) return false;
  const rel = g.prefix === '' ? relPath : relPath.slice(g.prefix.length + 1);
  return g.re.test(rel);
}

// Transient build dirs carry a pid suffix and leak into the FS walk as phantom
// orphans. `build-desktop-sidecar.sh` produces a PAIR of them per run — it stages
// into `sidecar.tmp.<pid>` and renames the previous bundle aside as
// `sidecar.old.<pid>` — so BOTH suffixes must be skipped. Only `.tmp.` was, which
// left the lint red on pure build litter: 9 `sidecar.old.*` dirs had accumulated
// in the shared tree (one per desktop build since 2026-07-27), contributing all 15
// reported orphans while every genuine test file was correctly covered. Nothing in
// the fix that added `.tmp.` was wrong; it just patched one half of a pair.
//
// These are untracked build output (`git ls-files` returns nothing for them), and
// linting untracked artifacts is wrong by construction: a red gate must describe
// the COMMITTED tree, never whatever a local build happened to leave behind.
//
// ALSO skip every hidden (dot-)dir wholesale: no canonical test home is under one,
// and agent scratch dirs at the repo root (e.g. a `.wi3388-cargo-target/`
// CARGO_TARGET_DIR whose debug/ tree carries sidecar-template *.test.ts COPIES)
// otherwise surface as phantom orphans — this subsumes the
// .git/.next/.papercusp/.vitest-tmp/… entries above and kills the whole
// per-scratch-dir whack-a-mole class.
const COVERAGE_IGNORE_RE = /^\.|\.(?:tmp|old)\.\d+$/;

export interface GitIgnoredPaths {
  /** Ignored directories, without the trailing '/'. */
  dirs: ReadonlySet<string>;
  files: ReadonlySet<string>;
}

/** Untracked paths git ignores under `root`, as POSIX paths relative to it. A clean checkout,
 * which is what the green-checkpoint gate runs in, never contains them. Walking them made the
 * shared-tree verdict differ from the gate's. In WI-10005450 an untracked test under the
 * gitignored /scratchpad satisfied a registry glob here, while the gate failed STALE_GLOB.
 * Returns empty sets when git is unavailable, which falls back to walking everything. */
export function listGitIgnoredPaths(root: string): GitIgnoredPaths {
  const dirs = new Set<string>();
  const files = new Set<string>();
  const r = spawnSync(
    'git',
    ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0 || typeof r.stdout !== 'string') return { dirs, files };
  for (const p of r.stdout.split('\0')) {
    if (!p) continue;
    if (p.endsWith('/')) dirs.add(p.slice(0, -1));
    else files.add(p);
  }
  return { dirs, files };
}

let repoIgnored: GitIgnoredPaths | null = null;
function repoGitIgnored(): GitIgnoredPaths {
  repoIgnored ??= listGitIgnoredPaths(REPO_ROOT);
  return repoIgnored;
}

/** Recursively list every file under `dir` whose basename matches `match`,
 * POSIX-relative, skipping ignore dirs. Defaults to canonical TS/JS tests.
 * `ignored` holds paths relative to `dir` that git ignores. The default applies
 * the repository's ignore set only when the walk starts at REPO_ROOT. */
export async function walkAll(
  dir: string,
  match: RegExp = CANONICAL_TEST_RE,
  base = '',
  ignored: GitIgnoredPaths | null = base === '' && dir === REPO_ROOT ? repoGitIgnored() : null,
): Promise<string[]> {
  let entries: Dirent<string>[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? posix.join(base, e.name) : e.name;
    if (e.isDirectory()) {
      if (COVERAGE_IGNORE_DIRS.has(e.name) || COVERAGE_IGNORE_RE.test(e.name) || COVERAGE_IGNORE_REL.has(rel)) continue;
      if (ignored?.dirs.has(rel)) continue;
      out.push(...await walkAll(join(dir, e.name), match, rel, ignored));
    } else if (e.isFile() && match.test(e.name) && !ignored?.files.has(rel)) {
      out.push(rel);
    }
  }
  return out;
}

/* ----------------------------------------------------------------- *
 * Forbidden #4 — bash `*.test.sh` / `*.spec.sh` (EI-1736). These are
 * invisible to every CI runner (test:affected only globs Vitest
 * `*.test.ts`), so they masquerade as coverage while never running, and
 * the classic `set -e` + `((x++))` shell-arithmetic trap aborts them
 * after the first test. There is NO debt list: zero exist today, and the
 * canonical pattern is a Vitest `*.test.ts` that shells out to bash
 * (e.g. apps/operator/lib/release/verify-release-paths.test.ts).
 * ----------------------------------------------------------------- */
const SHELL_TEST_RE = /\.(test|spec)\.sh$/;
async function findShellTests(): Promise<string[]> {
  return (await walkAll(REPO_ROOT, SHELL_TEST_RE)).sort();
}

export interface ContractRunner {
  kind: string;
  filePath?: string;
  script?: string;
  manifestPath?: string;
  suiteId?: string;
  cmd?: string;
  args?: string[];
  crate?: string;
}

export interface ContractSection {
  id: string;
  globs?: string[];
  runners?: ContractRunner[];
  role?: string;
}

export interface ContractDomain {
  id: string;
  sections?: ContractSection[];
}

/** Load the complete declaration contract (including runner descriptors). */
export async function loadContract(): Promise<{ domains?: ContractDomain[] }> {
  const raw = await readFile(join(REPO_ROOT, '.papercusp/testing-domains.json'), 'utf8');
  return JSON.parse(raw) as { domains?: ContractDomain[] };
}

/** Load every glob declared in the harness testing contract. */
async function loadContractGlobs(): Promise<string[]> {
  const parsed = await loadContract();
  const globs: string[] = [];
  for (const d of parsed.domains ?? []) {
    for (const s of d.sections ?? []) {
      for (const g of s.globs ?? []) globs.push(g);
    }
  }
  return globs;
}

/**
 * Declaration-side semantic attestation.  A registry declaration is a claim
 * about the live tree, so every glob must resolve to at least one canonical
 * test and every explicit runner must point at an executable target.  This
 * closes the stale-declaration direction that the orphan check cannot see.
 */
export interface DeclarationFinding {
  kind: 'stale-glob' | 'empty-section' | 'unresolved-role' | 'invalid-runner' | 'missing-runner-target' | 'unknown-admin-suite';
  domain: string;
  section: string;
  value: string;
  detail: string;
}

export async function attestDeclarations(
  contract: { domains?: ContractDomain[] },
  repoRoot: string,
  files: readonly string[],
  exists: (path: string) => boolean = existsSync,
): Promise<DeclarationFinding[]> {
  const findings: DeclarationFinding[] = [];
  const compiledCache = new Map<string, CompiledGlob>();
  const matches = (glob: string): string[] => {
    let compiled = compiledCache.get(glob);
    if (!compiled) { compiled = compileGlob(glob); compiledCache.set(glob, compiled); }
    return files.filter((file) => globMatches(compiled!, file));
  };
  for (const domain of contract.domains ?? []) {
    for (const section of domain.sections ?? []) {
      const globs = section.globs ?? [];
      const runners = section.runners ?? [];
      if (section.role && globs.length === 0) {
        findings.push({ kind: 'unresolved-role', domain: domain.id, section: section.id, value: section.role,
          detail: 'role binding resolved to no globs' });
      }
      for (const glob of globs) {
        if (matches(glob).length === 0) {
          findings.push({ kind: 'stale-glob', domain: domain.id, section: section.id, value: glob,
            detail: 'glob matches no canonical test file' });
        }
      }
      if (globs.length > 0 && runners.length === 0 && globs.every((glob) => matches(glob).length === 0)) {
        findings.push({ kind: 'empty-section', domain: domain.id, section: section.id, value: section.id,
          detail: 'section declares globs but resolves to no live tests' });
      }
      for (const runner of runners) {
        if (runner.kind === 'admin-suite') {
          if (!runner.suiteId || !ADMIN_TEST_SUITE_IDS.includes(runner.suiteId as never)) {
            findings.push({ kind: 'unknown-admin-suite', domain: domain.id, section: section.id,
              value: runner.suiteId ?? '<missing>', detail: 'suiteId is not registered in ADMIN_TEST_SUITES' });
          }
          continue;
        }
        if ((runner.kind === 'node' || runner.kind === 'shell') && !runner.cmd) {
          findings.push({ kind: 'invalid-runner', domain: domain.id, section: section.id,
            value: runner.kind, detail: `${runner.kind} runner requires cmd` });
        }
        if ((runner.kind === 'vitest' || runner.kind === 'playwright') && !runner.filePath) {
          findings.push({ kind: 'invalid-runner', domain: domain.id, section: section.id,
            value: runner.kind, detail: `${runner.kind} runner requires filePath` });
        }
        if (runner.kind === 'cargo' && !runner.crate) {
          findings.push({ kind: 'invalid-runner', domain: domain.id, section: section.id,
            value: runner.kind, detail: 'cargo runner requires crate' });
        }
        if (runner.kind === 'k6' && !runner.script) {
          findings.push({ kind: 'invalid-runner', domain: domain.id, section: section.id,
            value: runner.kind, detail: 'k6 runner requires script' });
        }
        const targets: string[] = [];
        if (runner.filePath) targets.push(runner.filePath);
        if (runner.manifestPath) targets.push(runner.manifestPath);
        if (runner.script) targets.push(runner.script);
        for (const arg of runner.args ?? []) {
          // Runner args that name a repository file.  Commands/flags and
          // package names are intentionally ignored.
          if (arg.includes('/') || /\.(?:mjs|mts|ts|tsx|js|jsx|sh|json|toml)$/.test(arg)) targets.push(arg);
        }
        for (const target of targets) {
          if (!exists(join(repoRoot, target))) {
            findings.push({ kind: 'missing-runner-target', domain: domain.id, section: section.id,
              value: target, detail: `${runner.kind} runner target does not exist` });
          }
        }
      }
    }
  }
  return findings;
}

/** Return canonical test files matching NO registry glob (invisible in the tab). */
async function findOrphanTests(): Promise<string[]> {
  const compiled = (await loadContractGlobs()).map(compileGlob);
  const tests = await walkAll(REPO_ROOT);
  return tests.filter((t) => !compiled.some((g) => globMatches(g, t))).sort();
}

/**
 * Return registry-visible tests that no real runner executes. Visibility and
 * runnability are separate contracts: a registry glob can make a dead test
 * look covered even when every resolved runner config excludes it.
 */
async function findUnrunnableRegistryTests(): Promise<
  Awaited<ReturnType<typeof findUnrunnableTests>>
> {
  const compiled = (await loadContractGlobs()).map(compileGlob);
  const tests = await walkAll(REPO_ROOT);
  const visible = tests.filter((test) => compiled.some((glob) => globMatches(glob, test)));
  return findUnrunnableTests(visible, REPO_ROOT);
}

async function main(): Promise<void> {
  const debt = await loadDebt();
  const debtMjs = new Set(debt.integrationMjs);
  const debtSmoke = new Set(debt.scriptsSmoke);

  const offenders: string[] = [];

  // Forbidden #1: new .mjs under apps/operator/__tests__/integration/
  const intDir = join(REPO_ROOT, 'apps/operator/__tests__/integration');
  const intFiles = await listFiles(intDir, (n) => n.endsWith('.mjs'));
  for (const name of intFiles) {
    const rel = posix.join('apps/operator/__tests__/integration', name);
    if (!debtMjs.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → .mjs integration scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Forbidden #2: new *-smoke.ts under apps/operator/scripts/
  const scriptsDir = join(REPO_ROOT, 'apps/operator/scripts');
  const smokeFiles = await listFiles(scriptsDir, (n) => n.endsWith('-smoke.ts'));
  for (const name of smokeFiles) {
    const rel = posix.join('apps/operator/scripts', name);
    if (!debtSmoke.has(rel)) {
      offenders.push(`[NEW] ${rel}\n        → tsx -smoke.ts scripts are forbidden (D-006). ` +
        `Use a Vitest *.integration.test.ts instead.`);
    }
  }

  // Forbidden #3: a canonical test that matches no registry glob — it would
  // be invisible in the /adv Tests tab. Fix by widening a domain's globs in
  // testing-domains-registry.ts (then regenerate the contract:
  // `npx tsx scripts/gen-testing-domains-contract.ts`).
  const orphans = await findOrphanTests();
  for (const o of orphans) {
    offenders.push(`[ORPHAN] ${o}\n        → matches no registry glob → invisible in the /adv Tests tab. ` +
      `Widen a domain in packages/operator-core/lib/testing-domains-registry.ts, then ` +
      `regenerate: npx tsx scripts/gen-testing-domains-contract.ts`);
  }

  // Forbidden #3b: registry visibility must resolve to a real executor.
  // Resolve runner configs instead of collecting the suite: collection can
  // fail for unrelated imports/setup and turn thousands of sound paths into a
  // false `matched=0`, while resolved include/exclude is the authoritative,
  // fast contract the runner itself applies.
  const unrunnable = await findUnrunnableRegistryTests();
  for (const finding of unrunnable) {
    offenders.push(`[UNRUNNABLE] ${finding.file}\n        → visible through a registry glob, but no runner executes it: ${finding.reason ?? 'unknown executor gap'}. ` +
      `Fix the owning Vitest include/exclude, Playwright/WebdriverIO executor, or registry declaration.`);
  }

  const contract = await loadContract();
  const declarations = await attestDeclarations(contract, REPO_ROOT, await walkAll(REPO_ROOT));
  for (const finding of declarations) {
    const prefix = finding.kind === 'stale-glob' ? '[STALE_GLOB]' :
      finding.kind === 'empty-section' ? '[EMPTY_SECTION]' :
      finding.kind === 'unresolved-role' ? '[UNRESOLVED_ROLE]' :
      finding.kind === 'invalid-runner' ? '[INVALID_RUNNER]' :
      finding.kind === 'missing-runner-target' ? '[RUNNER_TARGET]' : '[ADMIN_SUITE]';
    offenders.push(`${prefix} ${finding.domain}/${finding.section}: ${finding.value}\n        → ${finding.detail}`);
  }

  // Forbidden #4: bash *.test.sh / *.spec.sh — invisible to every CI runner
  // (test:affected only globs Vitest *.test.ts) AND a known foot-gun (`set -e`
  // + `((x++))` aborts after Test 1, so later assertions silently never run).
  // EI-1736. Use a Vitest *.test.ts that shells out to bash instead.
  const shellTests = await findShellTests();
  for (const s of shellTests) {
    offenders.push(`[NEW] ${s}\n        → bash *.test.sh/*.spec.sh are invisible to CI (no runner globs them) ` +
      `and abort after Test 1 under \`set -e\` + \`((x++))\` (D-006 / EI-1736). Use a Vitest *.test.ts ` +
      `that shells out to bash, e.g. apps/operator/lib/release/verify-release-paths.test.ts.`);
  }

  // Stale debt entries — files in the JSON that no longer exist.
  // Not an error; just a heads-up the JSON should be pruned.
  const stale: string[] = [];
  for (const path of [...debtMjs, ...debtSmoke]) {
    const abs = join(REPO_ROOT, path);
    try {
      await stat(abs);
    } catch {
      stale.push(path);
    }
  }

  if (stale.length > 0) {
    process.stdout.write('Stale debt entries (file deleted; remove from lint-tests-debt.json):\n');
    for (const p of stale) process.stdout.write(`  - ${p}\n`);
  }

  if (offenders.length > 0) {
    process.stderr.write('\n✗ lint-tests: new test-framework offenders found\n\n');
    for (const o of offenders) process.stderr.write(`  ${o}\n\n`);
    process.stderr.write(
      'See apps/operator-docs/src/content/docs/testing/index.mdx §1.0a ' +
      'for the four canonical frameworks.\n',
    );
    process.exit(1);
  }

  process.stdout.write('✓ lint-tests: no new offenders\n');
  process.stdout.write(`  ${debtMjs.size} .mjs + ${debtSmoke.size} -smoke.ts debt entries\n`);
  process.stdout.write('  every canonical test matches a registry glob (visible in the /adv Tests tab)\n');
  process.stdout.write('  every registry-visible canonical test resolves to an executing runner\n');
}

if (isCliEntry(import.meta.url)) void main();
