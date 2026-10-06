// Targeted-task pass reuse + proof recording — EI-24538088938561684.
//
// scripts/affected-tests.mjs arms two things on every unit vitest task it spawns:
//   • per-file PASS REUSE (armTestPassReuse): a PC_TEST_REUSE_SKIP_LIST naming the files whose
//     clean-run pass proof is still valid at the judged sha, which the workspace's vitest config
//     applies as `exclude` (libs/test-config/src/test-pass-reuse-skip.ts);
//   • the EXECUTED-SOURCE RECORDER (PC_EXECUTED_SOURCE_MAP_WORKSPACE), which writes the pass
//     proofs reuse consumes (libs/test-config/src/executed-source-map-reporter.ts).
//
// The green checkpoint's frozen-repair verification does NOT go through affected-tests. It
// re-runs a failing workspace task (`<ws> :: test:lane-stateful`, ~2,700 tests) directly at the
// repair head (apps/operator/lib/release/green-checkpoint.ts `runGateAtRef`). Before this module
// that re-run armed neither half, so every repair round re-ran every file of the task and threw
// its passes away: the next round, and the promotion run at the SAME repair head, found no proof
// for files just proven green at that exact sha. Measured on frozen candidate 599dbeeb: six
// repair rounds of ~58 min each, and zero test_executed_sources rows recorded by any of them.
//
// This arms the same pair for ONE such task, with the same rule (`selectReusablePasses`, including
// the P-012 audit sample that re-runs a share of reusable files anyway) and the same fail-open
// stance: anything uncertain — a dirty or mismatched checkout, no database, a slow proof read, a
// script that cannot run zero files — yields no skip list, and the task runs every file it would
// have run before. Recording is armed whenever the runner's recording switch is on; the reporter
// itself refuses to persist from a dirty or sha-less checkout.
//
// Deliberately NOT for the rescue reruns (load-flake isolation, `runTestsAtRef`): those run named
// files at single concurrency with a stretched test timeout, which is not the suite's execution
// condition, so their passes must not become proofs (EI-24542010215430349, armRescueRerunCapture).
// A targeted TASK re-run invokes the workspace's own script with the gate's suite env — the same
// command and the same worker budget the suite ran it with — so its passes are suite passes.
//
// Log lines use the TARGETED_ prefix on purpose: the gate's TEST_PASS_REUSE health
// (buildTestPassReuseHealth) is built from the candidate suite's own lines, and a repair round's
// numbers must not be folded into it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EXECUTED_MAP_NO_PERSIST_ENV,
  EXECUTED_MAP_OUT_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  connectExecutedMapPg,
  executedMapRecordingEnabled,
  formatExecutedMapResultLines,
  gitChangedBetween,
  gitInertGlobalChange,
  loadReuseProofs,
  readExecutedMapResults,
} from "./executed-source-map.mjs";
import {
  TEST_REUSE_SKIP_LIST_ENV,
  formatTestReuseLine,
  reuseCandidates,
  reuseRunnerIdentity,
  selectReusablePasses,
  testReuseAuditRate,
  testReuseEnabled,
  testReuseMaxAgeMs,
  writeReuseSkipList,
} from "./test-pass-reuse.mjs";
import { STANDALONE_PACKAGE_DIRS, expandWorkspaceDirs } from "./test-runner-classes.mjs";
import { scriptRunsZeroFilesAsPass } from "./empty-suite-guard.mjs";
import { pathToFileURL } from "node:url";

/** The lane split of a workspace's unit suite. scripts/affected-tests.mjs imports this list. */
export const LANE_SCRIPTS = Object.freeze(["test:lane-pure", "test:lane-stateful"]);

/** A unit vitest task: the workspace `test` script or one of its lanes (the tasks affected-tests
 *  arms recording and reuse on). Integration, el-suite, cargo and guard scripts are not. */
export function isUnitVitestTaskScript(script) {
  return script === "test" || LANE_SCRIPTS.includes(script);
}

/** Prefix of every line this module emits — kept apart from the suite's TEST_PASS_REUSE lines. */
export const TARGETED_REUSE_LINE_PREFIX = "TARGETED_";

/** How long the proof read may take before the task simply runs everything. */
export const TARGETED_REUSE_PROOF_READ_TIMEOUT_MS = 15_000;

function readPackage(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg && typeof pkg === "object" ? pkg : null;
  } catch {
    return null;
  }
}

/**
 * Find a workspace package by NAME under `root`: the standalone packages first (they are outside
 * the root npm workspaces), then the root `workspaces` patterns, expanded by the same helper the
 * runner-class enumeration uses. Reads package.json files only, so it answers the same in the
 * gate's checkpoint tree as in any other checkout, whatever node_modules links that tree carries.
 *
 * @param {string} root
 * @param {string} workspace npm package name (or a standalone package's directory)
 * @returns {{ dirRel: string, scripts: Record<string, string> } | null}
 */
export function resolveWorkspacePackage(root, workspace) {
  const hit = (dirRel, pkg) => ({
    dirRel: dirRel.replaceAll("\\", "/"),
    scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {},
  });
  for (const dir of STANDALONE_PACKAGE_DIRS) {
    const pkg = readPackage(path.join(root, dir));
    if (pkg && (pkg.name === workspace || dir === workspace)) return hit(dir, pkg);
  }
  const rootPkg = readPackage(root);
  let dirs = [];
  try {
    dirs = expandWorkspaceDirs(root, Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces : []);
  } catch {
    dirs = [];
  }
  for (const dir of dirs) {
    const pkg = readPackage(path.join(root, dir));
    if (pkg?.name === workspace) return hit(dir, pkg);
  }
  return null;
}

function defaultGit(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * The identity of the node the task will spawn (npm → PATH node), resolved under the task's env,
 * prefixed with the proof format (reuseRunnerIdentity, P-001) so older-format proofs never match.
 * Also used by pure-lane-proof-capture.mjs, which records proofs under the same identity.
 */
export function defaultRunnerIdentity(root, env) {
  try {
    return reuseRunnerIdentity(
      execFileSync("node", ["-p", "process.version + ' ' + process.platform + ' ' + process.arch"], {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      }),
    );
  } catch {
    return null;
  }
}

const defaultDeps = {
  git: defaultGit,
  runnerIdentity: defaultRunnerIdentity,
  connect: (env) => connectExecutedMapPg({ env }),
  loadProofs: loadReuseProofs,
  changedBetween: (root) => gitChangedBetween({ repoRoot: root, relative: true }),
  // gate-test-reuse-yield-2026-10-01 P-002: the same inert-global seam affected-tests passes.
  inertGlobalChange: (root) => gitInertGlobalChange({ repoRoot: root }),
  // P-003: the same main-process closure affected-tests passes, derived at the judged tree. Loaded
  // from that tree by URL, so the declaration build (tsconfig.declarations.json) never follows it.
  testConfigMainProcess: async (root) => {
    const srcDir = path.join(root, "libs/test-config/src");
    const mod = await import(pathToFileURL(path.join(srcDir, "main-process-closure.ts")).href);
    return mod.testConfigMainProcessFiles({ repoRoot: root, srcDir });
  },
  // P-004 (D-007): the same toolchain tsconfig set affected-tests passes, loaded the same way.
  toolchainTsconfigs: async (root) => {
    const mod = await import(pathToFileURL(path.join(root, "libs/test-config/src/toolchain-tsconfigs.ts")).href);
    return mod.toolchainTsconfigFiles({ repoRoot: root });
  },
  now: () => Date.now(),
  makeTempDir: () => mkdtempSync(path.join(tmpdir(), "pc-targeted-reuse-")),
  removeTempDir: (dir) => rmSync(dir, { recursive: true, force: true }),
};

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

const token = (err) => String((err && err.message) || err).replace(/\s+/g, "_").slice(0, 160);

/**
 * Arm pass reuse and proof recording for ONE unit vitest task about to run at `expectedSha` in the
 * clean checkout `root`. Returns a NEW env (the input is not mutated) plus the log lines that say
 * what was armed; call `finish()` after the task exits to read the recorder's outcome and remove
 * the temporary files (it never throws).
 *
 * Every value a caller's environment might carry for these channels is stripped first, so a skip
 * list, a no-persist flag or a result path can never leak in from an outer run.
 *
 * @param {object} o
 * @param {string} o.root           the checkout the task runs in
 * @param {string} o.workspace      npm workspace name
 * @param {string} o.script         the script about to run (`test`, `test:lane-stateful`, …)
 * @param {string | null} o.expectedSha the commit the caller just materialized; HEAD must equal it
 * @param {Record<string, string | undefined>} o.env the env the task will run with
 * @param {string} [o.scope]        log label for where the run came from (e.g. `repair-head`)
 * @param {Partial<typeof defaultDeps>} [o.deps] injection seams (tests)
 * @returns {Promise<{
 *   env: Record<string, string | undefined>,
 *   lines: string[],
 *   reused: number,
 *   recording: boolean,
 *   finish: () => string[],
 * }>}
 */
export async function armTargetedTaskReuse({ root, workspace, script, expectedSha, env, scope = "targeted", deps = {} }) {
  const d = { ...defaultDeps, ...deps };
  const label = `${workspace}::${script}`;
  const out = { ...env };
  for (const key of [
    TEST_REUSE_SKIP_LIST_ENV,
    EXECUTED_MAP_WORKSPACE_ENV,
    EXECUTED_MAP_NO_PERSIST_ENV,
    EXECUTED_MAP_RESULT_ENV,
    EXECUTED_MAP_OUT_ENV,
  ]) {
    delete out[key];
  }
  const lines = [];
  if (!isUnitVitestTaskScript(script)) {
    return { env: out, lines, reused: 0, recording: false, finish: () => [] };
  }

  let tempDir = null;
  const ensureTempDir = () => (tempDir ??= d.makeTempDir());
  const finishWith = (resultFile) => () => {
    const done = [];
    try {
      if (resultFile) {
        done.push(...formatExecutedMapResultLines(label, readExecutedMapResults(resultFile)).map((l) => TARGETED_REUSE_LINE_PREFIX + l));
      }
    } catch {
      /* the outcome line is diagnostic; never let it cost the caller anything */
    }
    try {
      if (tempDir) d.removeTempDir(tempDir);
    } catch {
      /* a leftover temp dir is harmless */
    }
    tempDir = null;
    return done;
  };

  // Recording: the reporter rails persistence to a clean checkout itself, so arming is unconditional
  // apart from the runner's own switch (AFFECTED_RECORD_EXECUTED_SOURCES).
  const recording = executedMapRecordingEnabled(out);
  let resultFile = null;
  if (recording) {
    out[EXECUTED_MAP_WORKSPACE_ENV] = workspace;
    try {
      resultFile = path.join(ensureTempDir(), "executed-map-result.jsonl");
      out[EXECUTED_MAP_RESULT_ENV] = resultFile;
    } catch {
      resultFile = null;
    }
  }
  const result = (reused) => ({ env: out, lines, reused, recording, finish: finishWith(resultFile) });
  const off = (reason) => {
    lines.push(`${TARGETED_REUSE_LINE_PREFIX}TEST_PASS_REUSE ws=${label} scope=${scope} applied=false reason=${reason}`);
    return result(0);
  };

  const pkg = resolveWorkspacePackage(root, workspace);
  if (!pkg) return off("workspace-unresolved");
  // An all-reused task runs zero files; only a script that treats that as a pass may skip.
  // The pure-lane runner does, without naming the flag (gate-test-reuse-yield P-006, D-005).
  if (!scriptRunsZeroFilesAsPass(pkg.scripts[script] ?? "")) return off("script-cannot-run-zero-files");
  if (!testReuseEnabled(out)) return off("disabled-by-env");
  const head = (d.git(root, ["rev-parse", "HEAD"]) ?? "").trim();
  if (!head) return off("no-judged-sha");
  if (expectedSha && head !== expectedSha) {
    return off(`head-mismatch(${head.slice(0, 12)}!=${String(expectedSha).slice(0, 12)})`);
  }
  // Drift is computed commit-to-commit, so an uncommitted edit would be invisible to it.
  const status = d.git(root, ["status", "--porcelain", "--ignore-submodules=none"]);
  if (status == null) return off("checkout-status-unknown");
  const dirty = status.split("\n").filter((l) => l.trim().length > 0);
  if (dirty.length > 0) return off(`dirty-checkout(${dirty.length})`);
  const runnerIdentity = d.runnerIdentity(root, out);
  if (!runnerIdentity) return off("no-runner-identity");
  const runContext = out.GREEN_CHECKPOINT === "1" ? "green-checkpoint" : "clean-local";

  let client;
  try {
    client = await d.connect(out);
  } catch (err) {
    return off(`pg-unavailable(${token(err)})`);
  }
  let loaded;
  try {
    loaded = await withTimeout(
      d.loadProofs({ client, workspaceName: workspace, runContext }),
      TARGETED_REUSE_PROOF_READ_TIMEOUT_MS,
      "reuse-proof read",
    );
  } catch (err) {
    return off(`proofs-unavailable(${token(err)})`);
  } finally {
    try {
      await client?.end?.();
    } catch {
      /* the read is done; a close failure changes nothing */
    }
  }

  const prefix = pkg.dirRel === "" ? "" : `${pkg.dirRel}/`;
  const { skip, summary } = selectReusablePasses({
    candidates: reuseCandidates({ wsRel: pkg.dirRel, relatedFiles: null, proofFiles: loaded.proofs.keys() }),
    proofs: loaded.proofs,
    judgedSha: head,
    changedBetween: d.changedBetween(root),
    runContext,
    runnerIdentity,
    nowMs: d.now(),
    maxAgeMs: testReuseMaxAgeMs(out),
    auditRate: testReuseAuditRate(out),
    inertGlobalChange: typeof d.inertGlobalChange === "function" ? d.inertGlobalChange(root) : null,
    testConfigMainProcess: await (async () => {
      // Unavailable = null: every test-config source file stays global (the pre-P-003 rule).
      try {
        return typeof d.testConfigMainProcess === "function" ? await d.testConfigMainProcess(root) : null;
      } catch {
        return null;
      }
    })(),
    toolchainTsconfigs: await (async () => {
      // Unavailable = null: every root tsconfig stays global (the pre-P-004 rule).
      try {
        return typeof d.toolchainTsconfigs === "function" ? await d.toolchainTsconfigs(root) : null;
      } catch {
        return null;
      }
    })(),
  });
  let reused = 0;
  if (skip.length > 0) {
    try {
      const list = writeReuseSkipList(ensureTempDir(), {
        // Workspace-relative: vitest resolves `exclude` against the workspace root.
        files: skip.map((f) => f.slice(prefix.length)),
        runContext,
        runnerIdentity,
        judgedSha: head,
      });
      out[TEST_REUSE_SKIP_LIST_ENV] = list.path;
      reused = list.count;
    } catch (err) {
      return off(`skip-list-unwritable(${token(err)})`);
    }
  }
  lines.push(
    TARGETED_REUSE_LINE_PREFIX +
      formatTestReuseLine(label, summary, ` scope=${scope} rows=${loaded.rows} sha=${head.slice(0, 12)}`),
  );
  return result(reused);
}
