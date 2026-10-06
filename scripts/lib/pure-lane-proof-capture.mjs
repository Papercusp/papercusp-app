// Pure-lane proof CAPTURE — gate-test-reuse-yield-2026-10-01 P-006 part 1 (Decision D-005 §1).
//
// The pure lane (packages/operator-core `test:lane-pure`, ~3,715 files, 58% of the workspace)
// runs with isolate:false, so the executed-source recorder writes NOTHING for it: a non-isolated
// file's import record accumulates across the fork and describes the fork, not the file
// (libs/test-config/src/executed-source-map-reporter.ts, measured 2026-09-06). Without a proof a
// file can never be reused, so the whole lane re-ran on every gate round (489s on 599dbeeb).
//
// This module is a post-verdict PHASE of the green-checkpoint run. After the verdict and the
// promotion decision are recorded, it re-runs a bounded slice of pure-lane files ISOLATED (the
// workspace's default config, PC_TEST_LANE unset) in the same clean checkout at the same sha, with
// recording armed exactly as armTargetedTaskReuse arms it. Those runs are clean, in the gate's run
// context (GREEN_CHECKPOINT=1 → run_context green-checkpoint, so D-004 rule 1 is unchanged), and
// isolated, so the recorder writes real per-file proofs the NEXT run's skip list can use.
//
// Why a phase of the gate run rather than its own routine: a proof needs a clean tree at a
// committed sha, installed deps, and the gate's run context, and only the checkpoint tree has all
// three at once (D-005, "Rejected").
//
// Soundness rails (D-005 §3):
//   • never mint a proof over a co-resident fail/error at that sha: such files are excluded;
//   • a file passing co-resident but failing isolated is logged PURE_PROOF_CAPTURE_ISOLATED_FAIL
//     (a hidden neighbour dependency); the recorder itself retires its proof (rule 5);
//   • capture rows are written as source=local under their own run_group_id, so they never pose as
//     source=ci candidate evidence.
//
// Bounds: slices of 250 files (~55s isolated at the gate's worker budget, D-005 input (b)); a
// budget (default 15 min); and before each slice a check that it would not end within 2 min of the
// next scheduled green-checkpoint fire. A kill loses at most one slice. Kill switch:
// PC_PURE_PROOF_CAPTURE=0. Default ON: every failure mode just runs more tests later.
//
// Fail-open: anything uncertain (no database, a dirty or sha-less checkout, a lane that never ran
// at this sha) skips the phase with a reason line. The phase never throws into the gate.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveLaneInclude } from "@papercusp/test-config/lane-split";
import {
  EXECUTED_MAP_NO_PERSIST_ENV,
  EXECUTED_MAP_OUT_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_WORKSPACE_ENV,
  connectExecutedMapPg,
  executedMapRecordingEnabled,
  formatExecutedMapResultLines,
  loadReuseProofs,
  readExecutedMapResults,
} from "./executed-source-map.mjs";
import { runVitestProcess } from "../run-vitest-pure-lane.mjs";
import { defaultRunnerIdentity } from "./targeted-task-reuse.mjs";
import { TEST_REUSE_SKIP_LIST_ENV, testReuseMaxAgeMs } from "./test-pass-reuse.mjs";

export const PURE_PROOF_CAPTURE_ENV = "PC_PURE_PROOF_CAPTURE";
export const PURE_PROOF_CAPTURE_BUDGET_ENV = "PC_PURE_PROOF_CAPTURE_BUDGET_MS";
export const PURE_PROOF_CAPTURE_SLICE_ENV = "PC_PURE_PROOF_CAPTURE_SLICE";
export const PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT = 15 * 60_000;
export const PURE_PROOF_CAPTURE_SLICE_DEFAULT = 250;
/** Stop before a slice that would end within this margin of the next scheduled gate fire. */
export const PURE_PROOF_CAPTURE_NEXT_FIRE_MARGIN_MS = 2 * 60_000;
/** D-005 input (b): ~0.22 s/file isolated at the gate's worker budget, rounded up. */
export const PURE_PROOF_CAPTURE_EST_MS_PER_FILE = 250;
/** A slice running this many times its estimate (and at least the floor) is killed. */
export const PURE_PROOF_CAPTURE_SLICE_TIMEOUT_FACTOR = 4;
export const PURE_PROOF_CAPTURE_SLICE_TIMEOUT_MIN_MS = 3 * 60_000;
/** Proofs are only consumed from the gate's own run context (D-004 rule 1). */
export const PURE_PROOF_CAPTURE_RUN_CONTEXT = "green-checkpoint";
/** The only workspace with a pure lane (packages/operator-core `test:lane-pure`). */
export const PURE_PROOF_CAPTURE_WORKSPACE = Object.freeze({
  dir: "packages/operator-core",
  name: "@papercusp/operator-core",
});
/** Prefix of every line this phase logs (grep target for the gate log). */
export const PURE_PROOF_CAPTURE_LINE = "PURE_PROOF_CAPTURE";

const OFF = new Set(["0", "false", "off", "no"]);

/** @param {Record<string, string | undefined>} [env] */
export function pureProofCaptureEnabled(env = process.env) {
  const raw = env[PURE_PROOF_CAPTURE_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** @param {Record<string, string | undefined>} [env] */
export function pureProofCaptureBudgetMs(env = process.env) {
  return positiveInteger(env[PURE_PROOF_CAPTURE_BUDGET_ENV]) ?? PURE_PROOF_CAPTURE_BUDGET_MS_DEFAULT;
}

/** @param {Record<string, string | undefined>} [env] */
export function pureProofCaptureSliceSize(env = process.env) {
  return positiveInteger(env[PURE_PROOF_CAPTURE_SLICE_ENV]) ?? PURE_PROOF_CAPTURE_SLICE_DEFAULT;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Which pure-lane files to capture, in order (D-005 §1 "Population" and "Order"). PURE.
 *
 * Excluded: files with a fail/error row at the sha (the co-residency rail: capture never mints a
 * proof over a failure), and files already holding a fresh proof AT the sha. Then, by path within
 * each tier:
 *   (i)   ranPassed — passed in this sha's suite (the radius the next candidate most likely shares);
 *   (ii)  unproven  — no usable proof (none, expired, or from another runner identity);
 *   (iii) refresh   — a usable proof at an older sha, oldest first, refreshed before it expires.
 *
 * @param {object} o
 * @param {string[]} o.laneFiles repo-relative pure-lane files
 * @param {Set<string>} o.failedAtSha repo-relative files with a fail/error row at the sha
 * @param {Set<string>} o.passedInSuite repo-relative files with a clean source=ci pass at the sha
 * @param {Map<string, { recordedSha: string, recordedAtMs: number, runnerIdentity?: string | null }>} o.proofs
 * @param {string} o.sha
 * @param {number} o.nowMs
 * @param {number} o.maxAgeMs
 * @param {string | null} [o.runnerIdentity] the runner capture will record under; a proof from
 *   another identity cannot be reused (D-004 rule 1), so it counts as no proof
 */
export function orderCaptureCandidates({
  laneFiles,
  failedAtSha,
  passedInSuite,
  proofs,
  sha,
  nowMs,
  maxAgeMs,
  runnerIdentity = null,
}) {
  const ranPassed = [];
  const unproven = [];
  const refresh = [];
  let failed = 0;
  let proven = 0;
  for (const file of [...new Set(laneFiles)].sort(byPath)) {
    if (failedAtSha.has(file)) {
      failed += 1;
      continue;
    }
    const proof = proofs.get(file);
    const usable =
      proof != null &&
      Number.isFinite(proof.recordedAtMs) &&
      nowMs - proof.recordedAtMs < maxAgeMs &&
      (runnerIdentity == null || proof.runnerIdentity == null || proof.runnerIdentity === runnerIdentity);
    if (usable && proof.recordedSha === sha) {
      proven += 1;
      continue;
    }
    if (passedInSuite.has(file)) ranPassed.push(file);
    else if (!usable) unproven.push(file);
    else refresh.push(file);
  }
  refresh.sort((a, b) => proofs.get(a).recordedAtMs - proofs.get(b).recordedAtMs || byPath(a, b));
  return {
    order: [...ranPassed, ...unproven, ...refresh],
    tiers: { ranPassed: ranPassed.length, unproven: unproven.length, refresh: refresh.length },
    excluded: { failed, proven },
  };
}

/**
 * Whether to start the next slice (D-005 §1 "Before each slice"). PURE.
 *
 * @param {object} o
 * @param {number} o.nowMs
 * @param {number} o.startedAtMs when the phase began
 * @param {number} o.budgetMs
 * @param {number} o.estimateMs the slice's expected wall time
 * @param {number | null} o.nextFireAtMs the next scheduled gate fire; null = unknown (budget only)
 * @param {number} [o.marginMs]
 * @returns {{ go: boolean, reason: "budget" | "next-fire" | null }}
 */
export function decideNextSlice({
  nowMs,
  startedAtMs,
  budgetMs,
  estimateMs,
  nextFireAtMs,
  marginMs = PURE_PROOF_CAPTURE_NEXT_FIRE_MARGIN_MS,
}) {
  if (nowMs - startedAtMs + estimateMs > budgetMs) return { go: false, reason: "budget" };
  if (nextFireAtMs != null && nowMs + estimateMs + marginMs > nextFireAtMs) {
    return { go: false, reason: "next-fire" };
  }
  return { go: true, reason: null };
}

/** The vitest argv for one slice: an explicit file list, and an empty match is an ERROR. */
export function buildCaptureVitestArgs(wsRelFiles) {
  if (wsRelFiles.length === 0) throw new Error("pure-proof-capture: empty slice");
  return ["run", "--no-passWithNoTests", ...wsRelFiles];
}

/**
 * The env one capture slice runs with. Starts from the gate's suite env (GREEN_CHECKPOINT=1, the
 * worker budget), then: the isolated default config (PC_TEST_LANE unset); no reuse skip list (every
 * named file must run); recording armed for the workspace; test_runs rows as source=local under the
 * phase's own run group, stamped with the judged sha. PURE.
 */
export function buildCaptureEnv(env, { resultFile, runGroupId, sha }) {
  const out = { ...env };
  for (const key of [
    "PC_TEST_LANE",
    TEST_REUSE_SKIP_LIST_ENV,
    EXECUTED_MAP_NO_PERSIST_ENV,
    EXECUTED_MAP_OUT_ENV,
    EXECUTED_MAP_RESULT_ENV,
  ]) {
    delete out[key];
  }
  out[EXECUTED_MAP_WORKSPACE_ENV] = PURE_PROOF_CAPTURE_WORKSPACE.name;
  if (resultFile) out[EXECUTED_MAP_RESULT_ENV] = resultFile;
  out.PAPERCUSP_TEST_RUN_SOURCE = "local";
  out.PAPERCUSP_TEST_RUN_GROUP = runGroupId;
  out.PAPERCUSP_TEST_RUN_COMMIT = sha;
  return out;
}

/** The repo-relative pure-lane files of `wsAbsDir`, whatever form the include list uses. */
export function repoRelativeLaneFiles(root, wsAbsDir, include) {
  return (include ?? []).map((f) =>
    path.relative(root, path.resolve(wsAbsDir, String(f))).split(path.sep).join("/"),
  );
}

function defaultGit(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Per-file outcomes at the sha over the lane files. Bounded to 7 days so the
 * (file_path, finished_at) index range stays small (measured 3.4s unbounded over 3,731 files).
 */
async function defaultLoadShaOutcomes({ client, sha, files }) {
  const { rows } = await client.query(
    `SELECT file_path,
            bool_or(status IN ('fail', 'error')) AS failed,
            bool_or(source = 'ci' AND status = 'pass') AS ci_pass,
            bool_or(source = 'ci') AS ci_any
       FROM harness_shared.test_runs
      WHERE commit_sha = $1 AND worktree_dirty = false
        AND file_path = ANY($2::text[])
        AND finished_at > now() - interval '7 days'
      GROUP BY file_path`,
    [sha, files],
  );
  const failed = new Set();
  const passedInSuite = new Set();
  let ranInSuite = 0;
  for (const r of rows) {
    if (r.failed) failed.add(r.file_path);
    if (r.ci_pass) passedInSuite.add(r.file_path);
    if (r.ci_any) ranInSuite += 1;
  }
  return { failed, passedInSuite, ranInSuite };
}

/**
 * The newest commit the gate suite recorded a clean source=ci row at, for any lane file, since
 * `sinceMs` (this gate process's start). Used only to explain a notRun skip: a repair-queue run can
 * judge one head and then move the checkout to a newly admitted head before capture runs, so HEAD
 * no longer names the sha the suite judged (measured 2026-10-01: judged b8eb76cc, HEAD 3f0e22e9).
 */
async function defaultLoadLatestLaneSha({ client, files, sinceMs }) {
  const { rows } = await client.query(
    `SELECT commit_sha FROM harness_shared.test_runs
      WHERE source = 'ci' AND worktree_dirty = false
        AND file_path = ANY($1::text[])
        AND finished_at >= to_timestamp($2::double precision / 1000)
      ORDER BY finished_at DESC
      LIMIT 1`,
    [files, sinceMs],
  );
  return rows[0]?.commit_sha ?? null;
}

async function defaultLoadSliceFailures({ client, runGroupId, files }) {
  const { rows } = await client.query(
    `SELECT DISTINCT file_path FROM harness_shared.test_runs
      WHERE run_group_id = $1 AND status IN ('fail', 'error') AND file_path = ANY($2::text[])`,
    [runGroupId, files],
  );
  return rows.map((r) => r.file_path);
}

/**
 * Read the proofs THIS capture slice actually persisted, with its source=local test row.
 * The proof table is mutable: retain these names now, before another run replaces them.
 * No cap or aggregate may stand in for the named population.
 * @param {{ client: { query: Function }, sha: string, runGroupId: string, files: string[], sinceMs: number }} o
 * @returns {Promise<Array<{ file: string, testRunId: string, recordedAtMs: number,
 *   runnerIdentity: string, runContext: string, runGroupId: string, source: string }> >}
 */
export async function loadCapturedProofRows({ client, sha, runGroupId, files, sinceMs }) {
  const { rows } = await client.query(
    `SELECT p.test_file AS file, t.id::text AS test_run_id, p.recorded_at,
            p.runner_identity, p.run_context, p.run_group_id, t.source
       FROM harness_shared.test_executed_sources p
       JOIN LATERAL (
         SELECT id, source FROM harness_shared.test_runs
          WHERE file_path = p.test_file AND commit_sha = p.recorded_sha
            AND run_group_id = p.run_group_id AND source = 'local'
            AND status = 'pass' AND worktree_dirty = false
            AND finished_at >= to_timestamp($4::double precision / 1000)
          ORDER BY finished_at DESC, id DESC LIMIT 1
       ) t ON true
      WHERE p.workspace_name = $1 AND p.recorded_sha = $2 AND p.run_group_id = $3
        AND p.run_context = 'green-checkpoint' AND p.test_file = ANY($5::text[])
        AND p.recorded_at >= to_timestamp($4::double precision / 1000)
        AND NOT EXISTS (
          SELECT 1 FROM harness_shared.test_runs bad
           WHERE bad.file_path = p.test_file AND bad.commit_sha = p.recorded_sha
             AND bad.run_group_id = p.run_group_id AND bad.status IN ('fail', 'error')
        )
      ORDER BY p.test_file`,
    [PURE_PROOF_CAPTURE_WORKSPACE.name, sha, runGroupId, sinceMs, files],
  );
  return rows.map((r) => ({ file: r.file, testRunId: r.test_run_id,
    recordedAtMs: new Date(r.recorded_at).getTime(), runnerIdentity: r.runner_identity,
    runContext: r.run_context, runGroupId: r.run_group_id, source: r.source }));
}

/**
 * Run one slice through the SAME governed launcher each `test:lane-pure` shard uses
 * (runVitestProcess → runGovernedTestProcess): inside the gate run it forwards the run's inherited
 * process receipt, so capture adds no second admission. The spawn seam adds what that launcher
 * leaves to npm: the workspace cwd, the root vitest binary, output to the capture log, and a kill
 * past `timeoutMs`. Never rejects.
 */
async function defaultRunSlice({ bin, args, cwd, env, timeoutMs, logFile }) {
  let fd = null;
  try {
    fd = logFile ? openSync(logFile, "a") : null;
  } catch {
    fd = null;
  }
  const out = fd ?? "ignore";
  let timedOut = false;
  const spawnProcess = (_command, childArgs, options) => {
    const child = spawn(bin, childArgs, { ...options, cwd, stdio: ["ignore", out, out] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref?.();
    }, timeoutMs);
    child.once("close", () => clearTimeout(timer));
    child.once("error", () => clearTimeout(timer));
    return child;
  };
  try {
    const code = await runVitestProcess(args, { env, spawnProcess, stderr: { write: () => true } });
    return { code, signal: null, timedOut, spawnError: null };
  } catch (error) {
    return { code: null, signal: null, timedOut, spawnError: error };
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

const defaultDeps = {
  git: defaultGit,
  laneInclude: (wsAbsDir) => resolveLaneInclude(wsAbsDir, "pure").include ?? [],
  runnerIdentity: defaultRunnerIdentity,
  connect: (env) => connectExecutedMapPg({ env }),
  loadProofs: loadReuseProofs,
  loadShaOutcomes: defaultLoadShaOutcomes,
  loadLatestLaneSha: defaultLoadLatestLaneSha,
  loadSliceFailures: defaultLoadSliceFailures,
  loadCapturedProofRows,
  readResults: (file) => readExecutedMapResults(file),
  runSlice: defaultRunSlice,
  /** @returns {Promise<number | null>} epoch ms of the next scheduled gate fire, null = unknown */
  readNextFireAtMs: async () => null,
  now: () => Date.now(),
  makeTempDir: () => mkdtempSync(path.join(tmpdir(), "pc-pure-proof-capture-")),
  removeTempDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  log: (line) => console.log(line),
};

const token = (err) => String((err && err.message) || err).replace(/\s+/g, "_").slice(0, 160);

async function withClient(d, env, fn) {
  const client = await d.connect(env);
  try {
    return await fn(client);
  } finally {
    try {
      await client.end?.();
    } catch {
      /* a failed close is harmless */
    }
  }
}

/**
 * Run the capture phase once, in the clean checkpoint checkout `root`, at its HEAD.
 *
 * @param {object} o
 * @param {string} o.root the checkpoint checkout
 * @param {Record<string, string | undefined>} o.env the gate's suite env (buildGreenCheckpointEnv)
 * @param {string} o.runGroupId test_runs group for this phase's rows
 * @param {string | null} [o.logFile] where vitest output goes (appended per slice)
 * @param {number | null} [o.sinceMs] epoch ms the gate run started; lets a notRun skip name the
 *   sha the suite actually judged when the checkout has since moved off it
 * @param {Partial<typeof defaultDeps>} [o.deps]
 * @returns {Promise<{ state: string, reason: string | null, sha: string | null, slices: number,
 *   files: number, rows: number, retired: number, failed: number, isolatedFail: number,
 *   remaining: number, stoppedBy: string | null, evidence: { version: 1, runGroupId: string,
 *   startedAtMs: number, completedAtMs: number, clean: boolean | null,
 *   proofs: Awaited<ReturnType<typeof loadCapturedProofRows>> | null }, lines: string[] }>}
 */
export async function runPureLaneProofCapture({
  root,
  env,
  runGroupId,
  logFile = null,
  sinceMs = null,
  deps = {},
}) {
  const d = { ...defaultDeps, ...deps };
  const lines = [];
  const emit = (text) => {
    const line = `${PURE_PROOF_CAPTURE_LINE}${text}`;
    lines.push(line);
    try {
      d.log(line);
    } catch {
      /* logging is diagnostic */
    }
  };
  const summary = {
    state: "skipped",
    reason: null,
    sha: null,
    slices: 0,
    files: 0,
    rows: 0,
    retired: 0,
    failed: 0,
    isolatedFail: 0,
    remaining: 0,
    stoppedBy: null,
  };
  /** @type {{ version: 1, runGroupId: string, startedAtMs: number, completedAtMs: number,
   *   clean: boolean | null, proofs: Awaited<ReturnType<typeof loadCapturedProofRows>> | null }} */
  const evidence = { version: 1, runGroupId, startedAtMs: d.now(), completedAtMs: d.now(),
    clean: null, proofs: null };
  const finish = () => {
    evidence.completedAtMs = d.now();
    emit(`_RESULT ${JSON.stringify({ ...summary, evidence })}`);
    return { ...summary, evidence, lines };
  };
  const skip = (reason) => {
    summary.reason = reason;
    emit(` state=skipped reason=${reason}`);
    return finish();
  };

  if (!pureProofCaptureEnabled(env)) return skip("disabled-by-env");
  if (env.GREEN_CHECKPOINT !== "1") return skip("not-gate-context");
  if (!executedMapRecordingEnabled(env)) return skip("recording-disabled");

  const sha = (d.git(root, ["rev-parse", "HEAD"]) ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return skip("no-judged-sha");
  summary.sha = sha;
  const status = d.git(root, ["status", "--porcelain", "--ignore-submodules=none"]);
  if (status == null) return skip("checkout-status-unknown");
  const dirty = status.split("\n").filter((l) => l.trim().length > 0).length;
  if (dirty > 0) return skip(`dirty-checkout(${dirty})`);
  evidence.clean = true;

  const wsAbsDir = path.join(root, PURE_PROOF_CAPTURE_WORKSPACE.dir);
  let laneFiles;
  try {
    laneFiles = repoRelativeLaneFiles(root, wsAbsDir, d.laneInclude(wsAbsDir));
  } catch (err) {
    return skip(`lane-unresolved(${token(err)})`);
  }
  if (laneFiles.length === 0) return skip("no-lane-files");

  const nowMs = d.now();
  const runnerIdentity = d.runnerIdentity(root, env) ?? null;
  let plan;
  let passedInSuite;
  try {
    plan = await withClient(d, env, async (client) => {
      const outcomes = await d.loadShaOutcomes({ client, sha, files: laneFiles });
      if (outcomes.ranInSuite === 0) {
        let judgedSha = null;
        if (Number.isFinite(sinceMs)) {
          try {
            judgedSha = await d.loadLatestLaneSha({ client, files: laneFiles, sinceMs });
          } catch {
            judgedSha = null; // diagnostic only: fall back to the plain notRun reason
          }
        }
        return { notRun: true, judgedSha };
      }
      const { proofs } = await d.loadProofs({
        client,
        workspaceName: PURE_PROOF_CAPTURE_WORKSPACE.name,
        runContext: PURE_PROOF_CAPTURE_RUN_CONTEXT,
      });
      passedInSuite = outcomes.passedInSuite;
      return orderCaptureCandidates({
        laneFiles,
        failedAtSha: outcomes.failed,
        passedInSuite: outcomes.passedInSuite,
        proofs,
        sha,
        nowMs,
        maxAgeMs: testReuseMaxAgeMs(env),
        runnerIdentity,
      });
    });
  } catch (err) {
    return skip(`pg-unavailable(${token(err)})`);
  }
  // D-005: capture follows a verdict in which the pure lane executed at this sha. No source=ci row
  // for any lane file here means the suite never ran it at HEAD (an early exit, another tree).
  // A repair-queue run can also judge one head and then move the checkout to a newly admitted
  // head before capture runs; then the suite DID run, at a sha HEAD no longer names. Say so,
  // rather than reporting a lane that never ran. Capture still never mints a proof off-HEAD.
  if (plan.notRun) {
    if (typeof plan.judgedSha === "string" && plan.judgedSha && plan.judgedSha !== sha) {
      return skip(
        `tree-moved-off-judged-sha(judged=${plan.judgedSha.slice(0, 12)},head=${sha.slice(0, 12)})`,
      );
    }
    return skip("pure-lane-not-run-at-sha");
  }

  const budgetMs = pureProofCaptureBudgetMs(env);
  const sliceSize = pureProofCaptureSliceSize(env);
  emit(
    ` state=planned sha=${sha.slice(0, 12)} lane=${laneFiles.length} candidates=${plan.order.length} ` +
      `ranPassed=${plan.tiers.ranPassed} unproven=${plan.tiers.unproven} refresh=${plan.tiers.refresh} ` +
      `excludedFailed=${plan.excluded.failed} excludedProven=${plan.excluded.proven} ` +
      `budgetMs=${budgetMs} slice=${sliceSize} runGroup=${runGroupId}${logFile ? ` log=${logFile}` : ""}`,
  );
  if (plan.order.length === 0) {
    summary.state = "done";
    summary.stoppedBy = "nothing-to-capture";
    emit(` state=done sha=${sha.slice(0, 12)} slices=0 files=0 remaining=0 stoppedBy=nothing-to-capture`);
    return finish();
  }

  evidence.proofs = [];

  const bin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
  const startedAtMs = d.now();
  let msPerFile = PURE_PROOF_CAPTURE_EST_MS_PER_FILE;
  let tempDir = null;
  let next = 0;
  try {
    while (next < plan.order.length) {
      const slice = plan.order.slice(next, next + sliceSize);
      const estimateMs = Math.ceil(slice.length * msPerFile);
      let nextFireAtMs = null;
      try {
        nextFireAtMs = await d.readNextFireAtMs();
      } catch {
        nextFireAtMs = null;
      }
      const decision = decideNextSlice({ nowMs: d.now(), startedAtMs, budgetMs, estimateMs, nextFireAtMs });
      if (!decision.go) {
        summary.stoppedBy = decision.reason;
        break;
      }
      // The run lock keeps the tree still; verify anyway, a proof stamped with the wrong sha is
      // worse than none.
      const headNow = (d.git(root, ["rev-parse", "HEAD"]) ?? "").trim();
      if (headNow !== sha) {
        summary.stoppedBy = `head-moved(${headNow.slice(0, 12) || "unknown"})`;
        break;
      }

      tempDir ??= d.makeTempDir();
      const resultFile = path.join(tempDir, `executed-map-result-${summary.slices + 1}.jsonl`);
      const wsRel = slice.map((f) => path.relative(wsAbsDir, path.join(root, f)).split(path.sep).join("/"));
      const sliceStart = d.now();
      const outcome = await d.runSlice({
        bin,
        args: buildCaptureVitestArgs(wsRel),
        cwd: wsAbsDir,
        env: buildCaptureEnv(env, { resultFile, runGroupId, sha }),
        timeoutMs: Math.max(PURE_PROOF_CAPTURE_SLICE_TIMEOUT_MIN_MS, estimateMs * PURE_PROOF_CAPTURE_SLICE_TIMEOUT_FACTOR),
        logFile,
      });
      const durationMs = Math.max(0, d.now() - sliceStart);
      summary.slices += 1;
      summary.files += slice.length;
      next += slice.length;
      msPerFile = Math.max(msPerFile, durationMs / slice.length);

      const label = `pure-proof-capture#${summary.slices}`;
      let read;
      try {
        read = d.readResults(resultFile);
      } catch {
        read = { status: "no-report", results: [], malformed: 0 };
      }
      for (const r of read.results ?? []) {
        summary.rows += Number(r.rows) || 0;
        summary.retired += Number(r.retired) || 0;
      }
      for (const l of formatExecutedMapResultLines(label, read)) emit(`_${l}`);

      if (evidence.proofs !== null) {
        try {
          const named = await withClient(d, env, (client) => d.loadCapturedProofRows({
            client, sha, runGroupId, files: slice, sinceMs: sliceStart,
          }));
          const written = (read.results ?? []).reduce((n, r) => n + r.rows, 0);
          const seen = new Set(evidence.proofs.map((p) => p.file));
          const qualified = !outcome.timedOut && !outcome.spawnError && !outcome.signal &&
            read.status === "reported" && read.malformed === 0 && read.results.length > 0 &&
            read.results.every((r) => r.outcome === "written" && r.sha === sha && r.dirty === false) &&
            Number.isSafeInteger(written) && written === named.length && named.every((p) => {
              if (seen.has(p.file)) return false;
              seen.add(p.file);
              return slice.includes(p.file) && typeof p.testRunId === "string" && /^\d+$/.test(p.testRunId) &&
                p.source === "local" && p.runContext === PURE_PROOF_CAPTURE_RUN_CONTEXT &&
                p.runGroupId === runGroupId && p.runnerIdentity === runnerIdentity &&
                Number.isSafeInteger(p.recordedAtMs) && p.recordedAtMs >= sliceStart && p.recordedAtMs <= d.now();
            });
          evidence.proofs = qualified ? [...evidence.proofs, ...named] : null;
        } catch {
          evidence.proofs = null;
        }
      }

      let failures = null;
      try {
        failures = await withClient(d, env, (client) => d.loadSliceFailures({ client, runGroupId, files: slice }));
      } catch {
        failures = null;
      }
      for (const f of failures ?? []) {
        summary.failed += 1;
        if (passedInSuite?.has(f)) {
          summary.isolatedFail += 1;
          emit(`_ISOLATED_FAIL file=${f} sha=${sha.slice(0, 12)}`);
        }
      }
      emit(
        ` state=slice n=${summary.slices} files=${slice.length} exitStatus=${outcome.code ?? "null"} ` +
          `signal=${outcome.signal ?? "none"} timedOut=${outcome.timedOut === true} durationMs=${durationMs} ` +
          `failed=${failures == null ? "unknown" : failures.length}`,
      );
      if (outcome.spawnError) {
        summary.stoppedBy = `spawn-error(${token(outcome.spawnError)})`;
        break;
      }
      if (outcome.timedOut) {
        summary.stoppedBy = "slice-timeout";
        break;
      }
    }
  } finally {
    if (tempDir) {
      try {
        d.removeTempDir(tempDir);
      } catch {
        /* a leftover temp dir is harmless */
      }
    }
  }
  summary.state = "done";
  summary.remaining = plan.order.length - next;
  summary.stoppedBy ??= "complete";
  emit(
    ` state=done sha=${sha.slice(0, 12)} slices=${summary.slices} files=${summary.files} rows=${summary.rows} ` +
      `retired=${summary.retired} failed=${summary.failed} isolatedFail=${summary.isolatedFail} ` +
      `remaining=${summary.remaining} stoppedBy=${summary.stoppedBy}`,
  );
  return finish();
}
