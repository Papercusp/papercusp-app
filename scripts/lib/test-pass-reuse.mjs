// Per-test-file PASS reuse — gate-file-level-test-reuse-2026-09-27 P-008 (WI-10003476).
//
// A harness_shared.test_executed_sources row is a per-file pass proof: the reporter
// (libs/test-config/src/executed-source-map-reporter.ts) records it only for a PASSED, isolated
// test file on a CLEAN checkout, together with the modules vitest executed and (P-009) the repo
// paths the file read at runtime. This module decides which selected test files may be SKIPPED
// at a judged sha because such a proof is still valid there (D-004):
//
//   1. the proof is from the same run context, the same runner identity, and younger than
//      maxAgeMs (so every file re-runs at least that often: the P-012 backstop);
//   2. its inputs were captured and it is not opaque;
//   3. drift(recordedSha, judgedSha) is computable and disjoint from: the file, every executed
//      module, every runtime read (a trailing '/' = directory prefix), the package.json and
//      tsconfig*.json of every package directory an executed module lives under (P-004: only a
//      tsconfig the vitest toolchain reads), and the global runner inputs.
//
// Everything else runs. PURE: every input is a value or a seam, so the unit tests pin the rule.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GENERATED_SCHEMA_FILES } from "./schema-symbol-drift.mjs";

const GENERATED_SCHEMA_FILE_SET = new Set(GENERATED_SCHEMA_FILES);

/** Env kill switch: `0`/`false`/`off`/`no` disables reuse entirely (default: ON). */
export const TEST_REUSE_ENV = "AFFECTED_TEST_REUSE";
/** The channel that carries the skip list to vitest-config (a JSON array of repo-relative paths). */
export const TEST_REUSE_SKIP_LIST_ENV = "PC_TEST_REUSE_SKIP_LIST";
/** Maximum proof age; default 24h. */
export const TEST_REUSE_MAX_AGE_ENV = "AFFECTED_TEST_REUSE_MAX_AGE_HOURS";
export const TEST_REUSE_MAX_AGE_MS_DEFAULT = 24 * 3600 * 1000;

/**
 * P-012 soundness audit: the fraction (0..1) of REUSABLE files that run anyway, so a proof the
 * rule trusted is re-tested against reality every run. Default 5%; `0` disables the audit only.
 */
export const TEST_REUSE_AUDIT_RATE_ENV = "AFFECTED_TEST_REUSE_AUDIT_RATE";
export const TEST_REUSE_AUDIT_RATE_DEFAULT = 0.05;

/**
 * Proof format (gate-test-reuse-yield-2026-10-01 P-001, D-002). A `proof-v2` proof carries, in its
 * readPaths, the vitest config that ran the file plus that config's bundled (relative) imports, so a
 * NESTED vitest config is an ordinary per-proof input instead of a global one (isGlobalRunnerInput).
 * It is folded into the runner identity, which rule 1 already compares exactly: an older proof
 * (no config input recorded) then reads `otherRunner` and is never judged under the narrowed rule.
 * PINNED equal to libs/test-config/src/test-pass-reuse-skip.ts REUSE_PROOF_FORMAT (the recorder).
 */
export const REUSE_PROOF_FORMAT = "proof-v2";

/**
 * The cap on vitest's importDurations record, which is where a proof's executedModules come from.
 * A proof that lists this many modules may have been cut short, so it cannot prove it did NOT load
 * a worker-side test-config file (P-003): it is opaque whenever such a file is in the drift.
 * PINNED equal to libs/test-config/src/vitest-config.ts EXECUTED_SOURCE_MAP_IMPORT_LIMIT.
 */
export const EXECUTED_SOURCE_MAP_IMPORT_LIMIT = 1_000_000;

/**
 * The runner identity a selector compares proofs against: the proof format plus the
 * `process.version process.platform process.arch` of the node the task will spawn.
 *
 * @param {string | null | undefined} nodeIdentity
 * @returns {string | null} null when the node probe produced nothing (reuse then switches off)
 */
export function reuseRunnerIdentity(nodeIdentity) {
  const node = typeof nodeIdentity === "string" ? nodeIdentity.trim() : "";
  return node ? `${REUSE_PROOF_FORMAT} ${node}` : null;
}

const OFF = new Set(["0", "false", "off", "no"]);

/** @param {Record<string, string | undefined>} [env] */
export function testReuseEnabled(env = process.env) {
  const raw = env[TEST_REUSE_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/** @param {Record<string, string | undefined>} [env] */
export function testReuseMaxAgeMs(env = process.env) {
  const h = Number(env[TEST_REUSE_MAX_AGE_ENV]);
  return Number.isFinite(h) && h > 0 ? h * 3600 * 1000 : TEST_REUSE_MAX_AGE_MS_DEFAULT;
}

/** @param {Record<string, string | undefined>} [env] */
export function testReuseAuditRate(env = process.env) {
  const raw = env[TEST_REUSE_AUDIT_RATE_ENV];
  if (raw == null || String(raw).trim() === "") return TEST_REUSE_AUDIT_RATE_DEFAULT;
  const r = Number(raw);
  return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : TEST_REUSE_AUDIT_RATE_DEFAULT;
}

/**
 * Deterministic draw in [0, 1) for one (file, judgedSha): a re-run of the same sha re-derives the
 * same audit sample (so the task-verdict cache identity stays stable), and the sample rotates with
 * every new sha, so over successive runs every reusable file is audited.
 *
 * @param {string} file
 * @param {string} judgedSha
 */
export function auditDraw(file, judgedSha) {
  return createHash("sha256").update(`${judgedSha}\0${file}`).digest().readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Global runner inputs: a drift path matching this invalidates EVERY proof. Kept narrow on
 * purpose (P-007 measured that "any package.json or libs/test-config file" discards 12 of 38
 * hourly pairs): per-package manifests are handled by the per-module ancestor rule instead, and
 * libs/test-config TEST files are ordinary tests, not runner inputs.
 *
 * A NESTED vitest config (`<dir>/vitest*config*`) is NOT global (P-001): a `proof-v2` proof records
 * the config that ran it, and that config's relative imports, in readPaths (REUSE_PROOF_FORMAT), so
 * such a change invalidates exactly the proofs that loaded it. Vite externalizes a config's BARE
 * imports and does not record them; those resolve to node_modules (package-lock.json, global) or to
 * @papercusp/test-config (libs/test-config, global), and a tree guard in test-pass-reuse.test.ts
 * fails if a nested config ever imports anything else. Root `vitest.*` stays global.
 *
 * package-lock.json and patches/ stay global because a proof cannot see node_modules (P-005,
 * verified 2026-10-01: the reporter drops external modules, and 0 of 7,340 recent proofs carry a
 * node_modules path), so a per-package match has nothing to match against. The one narrowing is a
 * lockfile edit that leaves the installed tree identical (packageLockChangeIsInert, asked through
 * the inertGlobalChange seam). A patches/ edit always rewrites an installed package, so it has no
 * inert case.
 *
 * P-003 (D-004): given `testConfigMainProcess` (libs/test-config/src/main-process-closure.ts, the
 * derived set of test-config source files the vitest MAIN process can load), a test-config source
 * file outside it is NOT global: it runs only in workers, where executedModules records it per
 * proof. Its package.json and tsconfig stay global. Omitted or null = every source file is global.
 *
 * P-004 (D-007): given `toolchainTsconfigs` (libs/test-config/src/toolchain-tsconfigs.ts, the
 * derived set of tsconfig/jsconfig files vite and vite-tsconfig-paths read), a root
 * `tsconfig.*.json` outside it is NOT global (tsconfigUnreadByToolchain). Omitted or null = every
 * root tsconfig is global.
 *
 * @param {string} rel
 * @param {ReadonlySet<string> | null} [testConfigMainProcess]
 * @param {ReadonlySet<string> | null} [toolchainTsconfigs]
 */
export function isGlobalRunnerInput(rel, testConfigMainProcess = null, toolchainTsconfigs = null) {
  if (rel === "package-lock.json" || rel === "package.json" || rel === "tsconfig.json") return true;
  if (/^tsconfig\.[^/]*\.json$/.test(rel)) return !tsconfigUnreadByToolchain(rel, toolchainTsconfigs);
  if (/^vitest\.[^/]*$/.test(rel)) return true;
  if (/^libs\/test-config\/(src\/|package\.json|tsconfig)/.test(rel)) {
    if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return false;
    // WI-10003752: fixtures only test-config's own tests read (those tests capture them as
    // per-file inputs), and non-source files under src/ — above all the editor / atomic-write
    // temps git-sync sweeps, e.g. `vitest-config.test.ts.tmp.<pid>.<hash>` — configure no
    // runner. Each used to discard every pass proof fleet-wide.
    if (/^libs\/test-config\/src\/(?:.*\/)?__fixtures__\//.test(rel)) return false;
    if (/^libs\/test-config\/src\//.test(rel) && !/\.(?:[cm]?[jt]sx?|json)$/.test(rel)) return false;
    if (testConfigMainProcess && /^libs\/test-config\/src\//.test(rel)) return testConfigMainProcess.has(rel);
    return true;
  }
  if (/^patches\//.test(rel)) return true;
  return false;
}

/**
 * The npm scripts that affected-tests runs AS a task (`test`, the lane scripts, `test:integration`,
 * `lint:el-tools`, `test:el-suite`). Any `test:lane-*` name counts, so a future lane is covered
 * before it is listed. A guard test pins the lane list against scripts/lib/targeted-task-reuse.mjs.
 */
const TASK_SCRIPT_NAMES = new Set([
  "test",
  "test:integration",
  "test:el-suite",
  "lint:el-tools",
  "test:lane-pure",
  "test:lane-stateful",
]);

/** npm lifecycle scripts that run at install time and can change what lands in node_modules. */
const INSTALL_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepack",
  "postpack",
  "dependencies",
]);

/**
 * Can a change to this npm script change how a recorded proof's file runs? True for a task script,
 * for its `pre`/`post` hook (npm runs `pretest` and `posttest` around `npm run test`), and for an
 * install lifecycle script.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isRunnerAffectingScript(name) {
  if (INSTALL_LIFECYCLE_SCRIPTS.has(name)) return true;
  const isTask = (n) => TASK_SCRIPT_NAMES.has(n) || /^test:lane-/.test(n);
  if (isTask(name)) return true;
  if (name.startsWith("pre") && isTask(name.slice(3))) return true;
  if (name.startsWith("post") && isTask(name.slice(4))) return true;
  return false;
}

/** JSON text with object keys sorted at every level (array order kept), for order-blind equality. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * gate-test-reuse-yield-2026-10-01 P-002: is a change to the ROOT package.json inert for pass
 * proofs? True only when both texts parse to JSON objects, they are equal once `scripts` is
 * removed (key order ignored), and no runner-affecting script (isRunnerAffectingScript) was
 * added, removed or changed. Anything else is false, including a parse failure or a non-object
 * `scripts` (fail closed).
 *
 * Why the remaining `scripts` keys are safe (D-002: narrow only where the proof can see the
 * input): a test that READS package.json records it in readPaths, and selectReusablePasses still
 * invalidates that proof directly; a test that spawns npm is opaque ('child-process') and is never
 * reused; and no workspace task script calls a root script. Every other field (workspaces,
 * dependencies, overrides, type, imports, engines) changes module resolution, so it stays global.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {boolean}
 */
export function rootPackageJsonChangeIsInert(beforeText, afterText) {
  const names = scriptsOnlyChangedNames(beforeText, afterText);
  return names !== null && !names.some(isRunnerAffectingScript);
}

/**
 * The script names a package.json change added, removed or changed, when that is ALL it changed
 * (key order ignored). Null when anything else changed, or when either side is not a JSON object
 * with an object (or absent) `scripts` (fail closed). An empty array means a reorder only.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {string[] | null}
 */
export function scriptsOnlyChangedNames(beforeText, afterText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    return null;
  }
  const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObject(before) || !isObject(after)) return null;
  const beforeScripts = before.scripts ?? {};
  const afterScripts = after.scripts ?? {};
  if (!isObject(beforeScripts) || !isObject(afterScripts)) return null;
  const { scripts: _beforeScripts, ...beforeRest } = before;
  const { scripts: _afterScripts, ...afterRest } = after;
  if (canonicalJson(beforeRest) !== canonicalJson(afterRest)) return null;
  const changed = [];
  for (const name of new Set([...Object.keys(beforeScripts), ...Object.keys(afterScripts)])) {
    if (canonicalJson(beforeScripts[name]) !== canonicalJson(afterScripts[name])) changed.push(name);
  }
  return changed;
}

/**
 * A command that runs npm scripts BY PATTERN (`run-s lint:*`, `npm-run-all --parallel "gen:*"`,
 * `concurrently "npm:watch-*"`): it can invoke a script whose name it never spells out.
 */
const PATTERN_RUN_RE = /(?:\brun-[sp]\b|\bnpm-run-all2?\b|\bconcurrently\b|\bnpm:)[\s\S]*\*/;

/**
 * gate-test-reuse-yield-2026-10-01 D-009 rule 3: the "can any script invoke this name?" judge
 * over every script command in a tree (`commands`: superproject and submodules, see
 * treeScriptCommands in executed-source-map.mjs). The returned judge answers true when `name`
 * occurs as a substring of any command other than its own definition (`definedIn` + `name`),
 * and true for EVERY name when any command runs scripts by pattern. Substring matching
 * over-approximates (`lint` matches `lint:tsc`), which only costs narrowings, never soundness.
 *
 * @param {ReadonlyArray<{ rel: string, name: string, command: string }>} commands
 * @returns {(name: string, definedIn: string) => boolean}
 */
export function scriptInvocationJudge(commands) {
  const patternRun = commands.some((c) => PATTERN_RUN_RE.test(c.command));
  return (name, definedIn) => {
    if (patternRun) return true;
    for (const c of commands) {
      if (c.rel === definedIn && c.name === name) continue;
      if (c.command.includes(name)) return true;
    }
    return false;
  };
}

/**
 * gate-test-reuse-yield-2026-10-01 D-009: is a change to a WORKSPACE (non-root) package.json
 * inert for the proofs beneath its directory? True only when it changed nothing but `scripts`
 * (scriptsOnlyChangedNames), no changed name is runner-affecting (isRunnerAffectingScript), and
 * no changed name can be invoked by another script: `invokable(name)` must answer exactly
 * `false` for the name and, for a `pre<x>` / `post<x>` name, for `<x>` (npm runs the hook around
 * every `npm run <x>`). Any other answer, or a throw, keeps the change a config change.
 *
 * Why invocation matters here and not at the root (P-002): a task script can call a sibling
 * (papercusp-desktop `test` runs `test:config`), or reach another package's scripts
 * (`npm run test --workspaces`). A test that READS the package.json still records it in
 * readPaths and is invalidated directly; one that spawns npm is opaque and never reused.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @param {(name: string) => boolean} invokable
 * @returns {boolean}
 */
export function workspacePackageJsonChangeIsInert(beforeText, afterText, invokable) {
  const names = scriptsOnlyChangedNames(beforeText, afterText);
  if (names === null) return false;
  for (const name of names) {
    if (isRunnerAffectingScript(name)) return false;
    const targets = [name];
    if (name.startsWith("pre") && name.length > 3) targets.push(name.slice(3));
    if (name.startsWith("post") && name.length > 4) targets.push(name.slice(4));
    for (const target of targets) {
      let callable = true;
      try {
        callable = invokable(target) !== false;
      } catch {
        callable = true;
      }
      if (callable) return false;
    }
  }
  return true;
}

/** A package-lock `packages` key describing something INSTALLED: a node_modules entry at any depth. */
const INSTALLED_LOCK_KEY_RE = /(?:^|\/)node_modules\//;

/**
 * The part of a package-lock.json that decides what `npm ci` puts on disk, as one canonical
 * string (gate-test-reuse-yield-2026-10-01 P-005), or null when the text is not a lockfile this
 * can judge (fail closed). Kept: every top-level field except `packages`; every `packages` entry
 * whose key is a node_modules path (version, resolved, integrity, link target, dependencies,
 * install-script flag, at any nesting depth); and, for the non-installed entries (the root `""`
 * and each workspace directory), the two fields that act at install time: `hasInstallScript` and
 * `bin`. Dropped: the rest of a workspace entry (its declared dependencies, version, license,
 * engines), which mirrors that workspace's own package.json and changes nothing installed.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function packageLockInstallView(text) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    return null;
  }
  const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObject(lock) || !isObject(lock.packages)) return null;
  const { packages, ...top } = lock;
  /** @type {Record<string, unknown>} */
  const installed = {};
  /** @type {Record<string, unknown>} */
  const workspaceInstall = {};
  for (const [key, entry] of Object.entries(packages)) {
    if (INSTALLED_LOCK_KEY_RE.test(key)) {
      installed[key] = entry;
      continue;
    }
    if (!isObject(entry)) return null;
    workspaceInstall[key] = { hasInstallScript: entry.hasInstallScript ?? null, bin: entry.bin ?? null };
  }
  return canonicalJson({ top, installed, workspaceInstall });
}

/**
 * Can a package-lock.json change between two shas change how any recorded proof ran (P-005)?
 * True only when both sides parse and their install views (packageLockInstallView) are equal:
 * then `npm ci` lays down the same node_modules tree at both shas, so no module a proof loaded
 * can differ. That is the common "a workspace declared a dependency that was already installed"
 * or "a workspace changed its own version" edit (5 of 17 lockfile commits, 2026-09-24..10-01).
 *
 * Any change to an installed entry stays global, however small, because a proof cannot see
 * node_modules: the executed-source-map reporter records only non-external modules
 * (libs/test-config/src/executed-source-map-reporter.ts drops `external` and node_modules paths),
 * and 0 of 7,340 proofs recorded 2026-09-28..10-01 carry a node_modules path. That includes a
 * brand-new package, which can still change behaviour through an optional `require` probe.
 *
 * @param {string} beforeText
 * @param {string} afterText
 * @returns {boolean}
 */
export function packageLockChangeIsInert(beforeText, afterText) {
  const before = packageLockInstallView(beforeText);
  const after = packageLockInstallView(afterText);
  return before !== null && after !== null && before === after;
}

/** The package.json / tsconfig*.json names that configure every file beneath their directory. */
const CONFIG_BASENAME_RE = /^(package\.json|(?:ts|js)config[^/]*\.json|\.babelrc|babel\.config\.[cm]?js)$/;

/** Any tsconfig / jsconfig file name. */
const TSCONFIG_BASENAME_RE = /^(?:ts|js)config[^/]*\.json$/;
/** The names vite-tsconfig-paths discovers as entries: always read, so never narrowed (a deletion must still invalidate). */
const TOOLCHAIN_ENTRY_BASENAME_RE = /^(?:ts|js)config\.json$/;

/**
 * P-004 (D-007): is `rel` a tsconfig/jsconfig file that neither vite nor vite-tsconfig-paths reads,
 * per the derived `toolchainTsconfigs` set? Such a file configures no test transform, so it is not
 * a global input and does not configure the files beneath its directory. A test that reads it
 * still records it in readPaths (or turns opaque when a child process reads it). Null set = false
 * for every path (nothing is narrowed).
 *
 * @param {string} rel
 * @param {ReadonlySet<string> | null | undefined} toolchainTsconfigs
 */
export function tsconfigUnreadByToolchain(rel, toolchainTsconfigs) {
  if (!toolchainTsconfigs) return false;
  const base = path.posix.basename(rel);
  if (!TSCONFIG_BASENAME_RE.test(base) || TOOLCHAIN_ENTRY_BASENAME_RE.test(base)) return false;
  return !toolchainTsconfigs.has(rel);
}

/**
 * Does a drift path invalidate a proof whose inputs are `modules` + `reads`? `dirs` is the set of
 * directories containing an executed module (and all their ancestors), used for the config rule.
 */
function invalidates(rel, o) {
  if (o.inputs.has(rel)) return true;
  for (const prefix of o.readDirs) if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return true;
  const base = path.posix.basename(rel);
  // P-002: an inert global change (see rootPackageJsonChangeIsInert) still invalidates a proof
  // that read the file itself (above), but it configures nothing beneath its directory. Without
  // this, the root package.json would still reach EVERY proof through the rule below, because
  // "." is an ancestor of every executed module. D-009: the same for an inert WORKSPACE
  // package.json (workspacePackageJsonChangeIsInert), which reaches every proof beneath it.
  if (o.inert.has(rel)) {
    if (o.inertWorkspace.has(rel) && o.dirs.has(path.posix.dirname(rel))) o.inertWorkspaceHit = true;
    return false;
  }
  if (CONFIG_BASENAME_RE.test(base) && o.dirs.has(path.posix.dirname(rel))) {
    // P-004: a tsconfig the toolchain never reads configures nothing beneath its directory.
    // Without this, an unread ROOT tsconfig would still reach every proof here ("." is an
    // ancestor of every executed module), exactly as the inert case above.
    if (tsconfigUnreadByToolchain(rel, o.toolchainTsconfigs)) {
      o.unreadTsconfigHit = true;
      return false;
    }
    return true;
  }
  return false;
}

/**
 * @typedef {object} ReuseProof
 * @property {string}   recordedSha
 * @property {number}   recordedAtMs
 * @property {string[]} executedModules   repo-relative, includes the test file
 * @property {string[]} readPaths         repo-relative; a trailing '/' is a directory read
 * @property {boolean}  inputsCaptured
 * @property {string[]} opaqueReasons
 * @property {string | null} runContext
 * @property {string | null} runnerIdentity
 */

/**
 * @param {object} o
 * @param {string[]}                      o.candidates    repo-relative test files the run would execute
 * @param {Map<string, ReuseProof>}       o.proofs        newest proof per repo-relative test file
 * @param {string}                        o.judgedSha
 * @param {(a: string, b: string) => Set<string> | null} o.changedBetween  repo-RELATIVE drift, null = unknown
 * @param {string}                        o.runContext
 * @param {string}                        o.runnerIdentity
 * @param {number}                        o.nowMs
 * @param {number}                        o.maxAgeMs
 * @param {number}                        [o.auditRate] P-012: fraction of reusable files that
 *        run anyway (deterministic per file+sha, see auditDraw). Default 0 (pure rule).
 * @param {((rel: string, fromSha: string, toSha: string) => boolean) | null} [o.inertGlobalChange]
 *        gate-test-reuse-yield-2026-10-01 P-002: asked for each GLOBAL drift path; returning
 *        exactly `true` says that change touches nothing a proof cannot see, so it is not global
 *        and does not reach proofs through the ancestor-config rule (a proof that read the path
 *        itself is still invalidated). Any other result, or a throw, keeps it global. D-009: also
 *        asked for each WORKSPACE (non-root) package.json drift path; `true` there means it does
 *        not configure the proofs beneath its directory (summary.inertWorkspaceConfig). Omitted =
 *        nothing is narrowed. Implemented over git by gitInertGlobalChange
 *        (scripts/lib/executed-source-map.mjs).
 * @param {ReadonlySet<string> | null} [o.testConfigMainProcess] P-003: the test-config source
 *        files the vitest main process can load (isGlobalRunnerInput). A drift path it narrows to
 *        per-proof is matched against executedModules, so a proof whose executedModules reached
 *        EXECUTED_SOURCE_MAP_IMPORT_LIMIT is opaque for that drift. Omitted = all stay global.
 * @param {ReadonlySet<string> | null} [o.toolchainTsconfigs] P-004 (D-007): the tsconfig/jsconfig
 *        files vite and vite-tsconfig-paths read (libs/test-config/src/toolchain-tsconfigs.ts).
 *        A drift tsconfig outside it is neither global nor an ancestor config; it still
 *        invalidates a proof whose readPaths name it. Omitted = no tsconfig is narrowed.
 * @param {((proof: ReuseProof) => boolean) | null} [o.schemaDriftJudge] P-007 (D-010): asked when
 *        a proof EXECUTED a drifted generated DB schema file (GENERATED_SCHEMA_FILES) without
 *        reading it through fs; returning exactly `true` says no table that changed reaches this
 *        proof, so that drift path does not invalidate it (summary.schemaNarrowed). Any other
 *        result, or a throw, keeps the whole-file rule. Omitted = nothing is narrowed. Implemented
 *        over git by gitSchemaDriftJudge (scripts/lib/schema-symbol-drift.mjs).
 * @returns {{ skip: string[], summary: Record<string, number>, watch: Map<string, "audit" | "expired-clean"> }}
 *        `watch` = files the rule would have skipped but that RUN this time (an audit sample, or
 *        a proof that expired within the last maxAgeMs and is otherwise clean). If one of them
 *        fails, reuse could have hidden that red: reuseSoundnessAlarms turns it into an alarm.
 */
export function selectReusablePasses({
  candidates,
  proofs,
  judgedSha,
  changedBetween,
  runContext,
  runnerIdentity,
  nowMs,
  maxAgeMs,
  auditRate = 0,
  inertGlobalChange = null,
  testConfigMainProcess = null,
  toolchainTsconfigs = null,
  schemaDriftJudge = null,
}) {
  const summary = {
    candidates: 0,
    reused: 0,
    noProof: 0,
    otherContext: 0,
    otherRunner: 0,
    expired: 0,
    notCaptured: 0,
    opaque: 0,
    unknownDrift: 0,
    globalInput: 0,
    inputChanged: 0,
    audited: 0,
    expiredClean: 0,
    // P-002: proofs that got past the global check only because a global drift path was inert.
    // Each would have been counted as globalInput before P-002, whatever its outcome is now.
    inertGlobal: 0,
    // P-003: proofs that got past the global check only because a test-config drift path is
    // outside the main-process closure (it was then matched per proof).
    testConfigNarrowed: 0,
    // P-004: proofs REUSED (or audited / watched) that an unread drift tsconfig would have
    // invalidated before P-004: as a global root tsconfig, or as an ancestor-directory config.
    tsconfigNarrowed: 0,
    // D-009: proofs REUSED (or audited / watched) that an inert workspace package.json drift
    // path would have invalidated before D-009, as an ancestor-directory config.
    inertWorkspaceConfig: 0,
    // P-007 (D-010): proofs REUSED (or audited / watched) that a generated DB schema drift path
    // would have invalidated before P-007, because they executed the regenerated file.
    schemaNarrowed: 0,
  };
  const skip = [];
  /** @type {Map<string, "audit" | "expired-clean">} */
  const watch = new Map();
  /** @type {Map<string, { drift: Set<string> | null, global: boolean, inert: Set<string>, inertWorkspace: Set<string>, narrowed: boolean, tsconfigNarrowed: boolean }>} */
  const driftCache = new Map();
  const askInert = (rel, sha) => {
    if (!inertGlobalChange) return false;
    try {
      return inertGlobalChange(rel, sha, judgedSha) === true;
    } catch {
      return false;
    }
  };
  const driftFor = (sha) => {
    if (!driftCache.has(sha)) {
      let drift = null;
      if (sha === judgedSha) drift = new Set();
      else {
        try {
          const d = changedBetween(sha, judgedSha);
          drift = d == null ? null : new Set(d);
        } catch {
          drift = null;
        }
      }
      let global = false;
      let narrowed = false;
      let tsconfigNarrowed = false;
      const inert = new Set();
      const inertWorkspace = new Set();
      if (drift !== null) {
        for (const rel of drift) {
          if (!isGlobalRunnerInput(rel, testConfigMainProcess, toolchainTsconfigs)) {
            if (isGlobalRunnerInput(rel)) {
              // Separate flags: only the test-config narrowing is matched against executedModules
              // (and so needs the capped-record guard below); an unread tsconfig is matched
              // against readPaths only.
              if (tsconfigUnreadByToolchain(rel, toolchainTsconfigs)) tsconfigNarrowed = true;
              else narrowed = true;
            } else if (path.posix.basename(rel) === "package.json" && askInert(rel, sha)) {
              // D-009: a scripts-only workspace manifest edit no script can reach.
              inert.add(rel);
              inertWorkspace.add(rel);
            }
            continue;
          }
          if (askInert(rel, sha)) inert.add(rel);
          else {
            global = true;
            break;
          }
        }
      }
      driftCache.set(sha, { drift, global, inert, inertWorkspace, narrowed, tsconfigNarrowed });
    }
    return driftCache.get(sha);
  };
  for (const file of new Set(candidates)) {
    summary.candidates += 1;
    const p = proofs.get(file);
    if (!p || typeof p.recordedSha !== "string" || !Array.isArray(p.executedModules)) {
      summary.noProof += 1;
      continue;
    }
    if (!p.executedModules.includes(file)) {
      summary.noProof += 1; // not a run of THIS file
      continue;
    }
    if (p.runContext !== runContext) {
      summary.otherContext += 1;
      continue;
    }
    if (p.runnerIdentity !== runnerIdentity) {
      summary.otherRunner += 1;
      continue;
    }
    // An expired proof is never reused, and it is counted ONLY as expired. A recently-expired one
    // (within one more maxAgeMs) is still evaluated against the rest of the rule, so a file that
    // would otherwise have been reused is watched (P-012); older ones stop here, which bounds the
    // number of distinct recorded shas the drift computation has to diff.
    const finiteAge = Number.isFinite(p.recordedAtMs) && p.recordedAtMs <= nowMs + 60_000;
    const expired = !finiteAge || nowMs - p.recordedAtMs > maxAgeMs;
    if (expired) {
      summary.expired += 1;
      if (!finiteAge || nowMs - p.recordedAtMs > 2 * maxAgeMs) continue;
    }
    /** @param {keyof typeof summary} bucket */
    const reject = (bucket) => {
      if (!expired) summary[bucket] += 1;
    };
    if (p.inputsCaptured !== true) {
      reject("notCaptured");
      continue;
    }
    if (Array.isArray(p.opaqueReasons) && p.opaqueReasons.length > 0) {
      reject("opaque");
      continue;
    }
    const { drift, global, inert, inertWorkspace, narrowed, tsconfigNarrowed } = driftFor(p.recordedSha);
    if (drift === null) {
      reject("unknownDrift");
      continue;
    }
    if (global) {
      reject("globalInput");
      continue;
    }
    if (narrowed && p.executedModules.length >= EXECUTED_SOURCE_MAP_IMPORT_LIMIT) {
      // D-004 guard: a capped record may be missing the worker-side file that changed.
      reject("opaque");
      continue;
    }
    if (inert.size > inertWorkspace.size && !expired) summary.inertGlobal += 1;
    if (narrowed && !expired) summary.testConfigNarrowed += 1;
    const inputs = new Set([file, ...p.executedModules]);
    const readDirs = [];
    for (const r of p.readPaths ?? []) {
      if (r.endsWith("/")) readDirs.push(r);
      else inputs.add(r);
    }
    const dirs = new Set();
    for (const m of p.executedModules) {
      let d = path.posix.dirname(m);
      while (!dirs.has(d)) {
        dirs.add(d);
        if (d === "." || d === "/") break;
        d = path.posix.dirname(d);
      }
    }
    let changed = false;
    const check = {
      inputs,
      readDirs,
      dirs,
      inert,
      inertWorkspace,
      toolchainTsconfigs,
      unreadTsconfigHit: false,
      inertWorkspaceHit: false,
    };
    /** @type {boolean | null} */
    let schemaVerdict = null;
    let schemaHit = false;
    // P-007 (D-010): only an EXECUTED generated schema file is narrowed. A proof that read it
    // through fs (a file read or a read of a directory holding it), or whose record may be capped,
    // keeps the whole-file rule.
    const schemaNarrows = (rel) => {
      if (!schemaDriftJudge || !GENERATED_SCHEMA_FILE_SET.has(rel)) return false;
      if (!p.executedModules.includes(rel) || (p.readPaths ?? []).includes(rel)) return false;
      if (readDirs.some((prefix) => rel.startsWith(prefix))) return false;
      if (p.executedModules.length >= EXECUTED_SOURCE_MAP_IMPORT_LIMIT) return false;
      if (schemaVerdict === null) {
        try {
          schemaVerdict = schemaDriftJudge(p) === true;
        } catch {
          schemaVerdict = false;
        }
      }
      return schemaVerdict;
    };
    for (const rel of drift) {
      if (schemaNarrows(rel)) {
        schemaHit = true;
        continue;
      }
      if (invalidates(rel, check)) {
        changed = true;
        break;
      }
    }
    if (changed) {
      reject("inputChanged");
      continue;
    }
    if ((tsconfigNarrowed || check.unreadTsconfigHit) && !expired) summary.tsconfigNarrowed += 1;
    if (check.inertWorkspaceHit && !expired) summary.inertWorkspaceConfig += 1;
    if (schemaHit && !expired) summary.schemaNarrowed += 1;
    if (expired) {
      summary.expiredClean += 1;
      watch.set(file, "expired-clean");
      continue;
    }
    if (auditRate > 0 && auditDraw(file, judgedSha) < auditRate) {
      summary.audited += 1;
      watch.set(file, "audit");
      continue;
    }
    summary.reused += 1;
    skip.push(file);
  }
  skip.sort();
  return { skip, summary, watch };
}

/**
 * P-012 alarm: the watched files (would-have-been-reused, see selectReusablePasses) that FAILED on
 * this fresh run. Each one is evidence that reuse can hide a red — a flake the proof happened to
 * pass through, or a runtime input the proof did not capture. `failedFiles` are as the runner
 * prints them (workspace-relative); `prefix` ("<wsRel>/" or "") maps them to the repo-relative
 * keys of `watch`.
 *
 * @param {{ failedFiles: Iterable<string> | null | undefined, watch: Map<string, string> | null | undefined, prefix: string }} o
 * @returns {{ file: string, reason: string }[]}
 */
export function reuseSoundnessAlarms({ failedFiles, watch, prefix }) {
  if (!watch || watch.size === 0 || !failedFiles) return [];
  const hits = new Map();
  for (const raw of failedFiles) {
    const f = String(raw).replaceAll("\\", "/").replace(/^\.\//, "");
    const key = watch.has(prefix + f) ? prefix + f : watch.has(f) ? f : null;
    if (key !== null) hits.set(key, watch.get(key));
  }
  return [...hits.keys()].sort().map((file) => ({ file, reason: String(hits.get(file)) }));
}

/**
 * P-013: the test time the skipped files would have cost, from their last CI pass durations. A
 * LOWER bound (per-file test time only); `unmeasured` files had no duration and add nothing.
 *
 * @param {string[]} skip repo-relative
 * @param {Map<string, number>} durations
 * @returns {{ savedMs: number, measured: number, unmeasured: number }}
 */
export function estimateReuseSavings(skip, durations) {
  let savedMs = 0;
  let unmeasured = 0;
  for (const f of skip) {
    const ms = durations.get(f);
    if (ms === undefined) unmeasured += 1;
    else savedMs += ms;
  }
  return { savedMs: Math.round(savedMs), measured: skip.length - unmeasured, unmeasured };
}

/**
 * P-013: one run-level roll-up line over every armed task (sum of the per-task summaries and
 * savings), so the gate log answers "what did reuse do this run" with a single grep.
 *
 * @param {{ tasks: number, summaries: Record<string, number>[], savedMs: number | null, unmeasured: number }} o
 *        `savedMs: null` = the durations could not be read for at least one task
 */
export function formatTestReuseTotalLine({ tasks, summaries, savedMs, unmeasured }) {
  const sum = (k) => summaries.reduce((acc, s) => acc + (Number(s[k]) || 0), 0);
  return (
    `TEST_PASS_REUSE_TOTAL tasks=${tasks} candidates=${sum("candidates")} reused=${sum("reused")} ` +
    `audited=${sum("audited")} expiredClean=${sum("expiredClean")} ` +
    `minSavedTestMs=${savedMs === null ? "unknown" : savedMs} unmeasured=${unmeasured}`
  );
}

/** One greppable line per alarm; `proof=` names why the file ran instead of being reused. */
export function formatReuseAlarmLine(wsName, alarm) {
  return (
    `TEST_PASS_REUSE_ALARM ws=${wsName} file=${alarm.file} proof=${alarm.reason} — reuse would have ` +
    `SKIPPED this file and it failed on a fresh run: a flake, or a runtime input its pass proof did ` +
    `not capture. The workspace's retry verdict below says which; a reproduced red is a capture gap.`
  );
}

/** Schema of the skip-list file; libs/test-config/src/test-pass-reuse-skip.ts refuses any other. */
export const REUSE_SKIP_LIST_SCHEMA = 1;

/**
 * Persist a skip list for one task as a content-addressed JSON file (same shape of channel as
 * related-tests.mjs `writeRelatedFilterList`). Content-addressing keeps the passing-task-verdict
 * identity stable for an identical list, while a different list can never alias another run.
 *
 * @param {string} dir
 * @param {{ files: string[], runContext: string, runnerIdentity: string, judgedSha: string }} o
 *        `files` are WORKSPACE-relative (vitest resolves `exclude` against the workspace root)
 * @returns {{ path: string, digest: string, count: number }}
 */
export function writeReuseSkipList(dir, { files, runContext, runnerIdentity, judgedSha }) {
  const normalized = [...new Set(files.map((f) => f.replaceAll("\\", "/")))].sort();
  const body = JSON.stringify({ schema: REUSE_SKIP_LIST_SCHEMA, files: normalized, runContext, runnerIdentity, judgedSha });
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `reuse-skip-${digest}.json`);
  try {
    writeFileSync(filePath, body, { flag: "wx", mode: 0o600 });
  } catch (err) {
    // Same content => same name: a concurrent writer already landed it.
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== "EEXIST") throw err;
  }
  return { path: filePath, digest, count: normalized.length };
}

/**
 * The candidate test files (repo-relative) a task would execute, for the reuse rule. A narrowed
 * task's selection is authoritative; an un-narrowed one could run any file the workspace holds,
 * so every proof under the workspace directory is a candidate (an exclude entry for a file the
 * task's include never matches is inert).
 *
 * @param {{ wsRel: string, relatedFiles?: string[] | null, proofFiles: Iterable<string> }} o
 * @returns {string[]}
 */
export function reuseCandidates({ wsRel, relatedFiles, proofFiles }) {
  const prefix = wsRel === "" || wsRel === "." ? "" : `${wsRel.replace(/\/+$/, "")}/`;
  if (Array.isArray(relatedFiles) && relatedFiles.length > 0) {
    return relatedFiles.map((f) => prefix + f.replaceAll("\\", "/").replace(/^\.\//, ""));
  }
  return [...proofFiles].filter((f) => f.startsWith(prefix));
}

/**
 * The lane a unit task script runs, or `null` for a task that runs its workspace's whole unit
 * suite (`test`). Lane membership is a property of each file's CONTENTS
 * (libs/test-config/src/lane-split.ts), so the script name only says WHICH lane to keep.
 *
 * @param {string} script
 * @returns {"pure" | "stateful" | null}
 */
export function laneOfTaskScript(script) {
  const m = /^test:lane-(pure|stateful)$/.exec(script);
  return m ? /** @type {"pure" | "stateful"} */ (m[1]) : null;
}

/**
 * A `laneOf` for {@link laneScopedCandidates}, built from libs/test-config/src/lane-split.ts —
 * the SAME classifier each lane's vitest config uses, so a lane task's candidates are exactly
 * the files that lane runs. The module is a seam (the caller imports it) so this file stays free
 * of TypeScript imports; only `wsRelFiles` are read, never the whole workspace.
 *
 * @param {{
 *   isUnitTestFile: (relPath: string) => boolean,
 *   classifyLanes: (rootDir: string, files: readonly string[]) => { stateful: string[] },
 * }} split
 * @param {string} wsRoot absolute workspace directory
 * @param {string[]} wsRelFiles workspace-relative candidate paths
 * @returns {(wsRelPath: string) => "pure" | "stateful" | null}
 */
export function laneOfFromSplit(split, wsRoot, wsRelFiles) {
  const unit = wsRelFiles.filter((f) => split.isUnitTestFile(f));
  const stateful = new Set(split.classifyLanes(wsRoot, unit).stateful);
  return (rel) => (!split.isUnitTestFile(rel) ? null : stateful.has(rel) ? "stateful" : "pure");
}

/**
 * Keep only the candidates a LANE task can actually run (WI-10004617).
 *
 * A lane task's selection is lane-agnostic: both lane tasks get the same related files, and each
 * lane's vitest config intersects them with its own content-classified include at run time. So
 * the other lane's files were counted as THIS task's candidates. The pure lane runs non-isolated
 * and never records a pass proof, so on the 599dbeeb gate run ~1.9k pure-lane files showed up as
 * `noProof` in lane-stateful's line, roughly halving its reported hit rate (367/4041 overall).
 *
 * Dropping a candidate can only shrink the skip list, so a misclassification makes the task run
 * MORE files, never fewer. `laneOf` returns `null` for a path that is in neither lane (not a unit
 * test file); such a path is dropped too, because no lane task runs it.
 *
 * @param {{
 *   candidates: string[],
 *   wsRel: string,
 *   lane: "pure" | "stateful" | null,
 *   laneOf: (wsRelPath: string) => "pure" | "stateful" | null,
 * }} o
 * @returns {{ candidates: string[], otherLane: number }}
 */
export function laneScopedCandidates({ candidates, wsRel, lane, laneOf }) {
  if (lane === null) return { candidates, otherLane: 0 };
  const prefix = wsRel === "" || wsRel === "." ? "" : `${wsRel.replace(/\/+$/, "")}/`;
  /** @type {string[]} */
  const kept = [];
  let otherLane = 0;
  for (const f of candidates) {
    // Outside the workspace there is nothing to classify against; keep it (the safe direction).
    if (prefix !== "" && !f.startsWith(prefix)) {
      kept.push(f);
      continue;
    }
    if (laneOf(f.slice(prefix.length)) === lane) kept.push(f);
    else otherLane += 1;
  }
  return { candidates: kept, otherLane };
}

/**
 * One greppable line per workspace: selected files, counters and original selector identity.
 * @param {string} wsName
 * @param {Record<string, number>} summary
 * @param {string} [extra]
 * @param {{version: 1, judgedSha: string, runnerIdentity: string, runContext: string, runGroupId: string | null, dirty: boolean}} [runtime]
 */
export function formatTestReuseLine(wsName, summary, extra = "", runtime = undefined) {
  const s = summary;
  return (
    `TEST_PASS_REUSE ws=${wsName} candidates=${s.candidates} reused=${s.reused} noProof=${s.noProof} ` +
    `otherContext=${s.otherContext} otherRunner=${s.otherRunner} expired=${s.expired} ` +
    `notCaptured=${s.notCaptured} opaque=${s.opaque} unknownDrift=${s.unknownDrift} ` +
    `globalInput=${s.globalInput} inputChanged=${s.inputChanged} audited=${s.audited ?? 0} ` +
    `expiredClean=${s.expiredClean ?? 0} inertGlobal=${s.inertGlobal ?? 0} ` +
    `testConfigNarrowed=${s.testConfigNarrowed ?? 0} tsconfigNarrowed=${s.tsconfigNarrowed ?? 0} ` +
    `inertWorkspaceConfig=${s.inertWorkspaceConfig ?? 0} schemaNarrowed=${s.schemaNarrowed ?? 0}${extra}` +
    (runtime === undefined ? "" : ` runtime=${encodeURIComponent(JSON.stringify(runtime))}`)
  );
}
