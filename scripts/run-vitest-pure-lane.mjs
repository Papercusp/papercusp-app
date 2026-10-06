#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { isCliEntry } from "@papercusp/operator-core/lib/util/cli-entry";
import { resolveLaneInclude } from "@papercusp/test-config/lane-split";
import { resolveReuseSkipFiles } from "@papercusp/test-config/test-pass-reuse-skip";
import { reuseSkipCoversRun } from "./lib/empty-suite-guard.mjs";
import {
  buildGovernedProcessDemand,
  classifyGovernedTestProcessOutcome,
  createGovernedProcessDemandSampler,
  governedProcessIdempotencyKey,
  runGovernedTestProcess as runGovernedTestProcessDefault,
} from "./lib/governed-test-process.mjs";

/**
 * A non-isolated Vitest invocation retains coordinator and reporter state for every file it
 * runs, even when those files are distributed across several worker forks. The suite died with
 * one coordinator spanning 4,490 files, so bound the complete invocation population and derive
 * shard count from the live lane census. Adding workers may increase concurrency inside one
 * shard, but must never collapse several fresh coordinators back into one OOM-prone process.
 */
export const PURE_LANE_MAX_FILES_PER_FRESH_FORK = 750;

const WORKER_ENV_KEYS = [
  "VITEST_MAX_WORKERS",
  "VITEST_MAX_FORKS",
  "VITEST_MAX_THREADS",
];

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Split the lane into sequential, fresh Vitest coordinators. The worker cap deliberately does
 * not reduce this count: workers bound concurrency, while shards bound the coordinator's total
 * retained file graph. Shards run one after another through the same admitted pc-heavy scope.
 */
export function resolvePureLaneShardCount(
  _env = process.env,
  pureFileCount = 0,
) {
  if (!Number.isInteger(pureFileCount) || pureFileCount < 0) {
    throw new Error(`invalid pure-lane file count ${pureFileCount}`);
  }
  return Math.max(
    1,
    Math.ceil(pureFileCount / PURE_LANE_MAX_FILES_PER_FRESH_FORK),
  );
}

export function buildPureLaneShardArgs(shard, shardCount, forwardedArgs = []) {
  if (
    !Number.isInteger(shard) ||
    shard < 1 ||
    shard > shardCount ||
    shardCount < 1
  ) {
    throw new Error(`invalid Vitest shard ${shard}/${shardCount}`);
  }
  if (
    forwardedArgs.some((arg) => arg === "--shard" || arg.startsWith("--shard="))
  ) {
    throw new Error(
      "test:lane-pure owns Vitest sharding; do not pass --shard explicitly",
    );
  }
  return [
    "run",
    "--passWithNoTests",
    ...forwardedArgs,
    ...(shardCount > 1 ? [`--shard=${shard}/${shardCount}`] : []),
  ];
}

export function runVitestProcess(
  args,
  {
    env = process.env,
    spawnProcess = spawn,
    runGovernedTestProcess = runGovernedTestProcessDefault,
    createSampler = createGovernedProcessDemandSampler,
    stderr = process.stderr,
  } = {},
) {
  const command = process.platform === "win32" ? "vitest.cmd" : "vitest";
  const workerCaps = WORKER_ENV_KEYS.flatMap((key) => {
    const value = positiveInteger(env[key]);
    return value === null ? [] : [value];
  });
  const workers = workerCaps.length > 0 ? Math.min(...workerCaps) : 8;
  const demand = buildGovernedProcessDemand({
    memoryBytes: workers * 1024 * 1024 * 1024,
    fileDescriptors: 16 + workers,
  });
  const identity = `${process.pid}:${randomUUID()}:${args.join("\0")}`;
  return runGovernedTestProcess(
    {
      workspaceId: env.PAPERCUSP_WORKSPACE_ID ?? env.PAPERCUSP_WORKSPACE,
      namespace: "vitest-pure-lane-shard",
      owner: `vitest-pure-lane:${process.pid}`,
      idempotencyKey: governedProcessIdempotencyKey(
        "vitest-pure-lane",
        identity,
      ),
      payloadRef: "test:lane-pure",
      demand,
      env,
      settle: classifyGovernedTestProcessOutcome,
    },
    (_admissionContext, governedEnv) =>
      new Promise((resolve) => {
        const sampler = createSampler(demand);
        let child;
        try {
          child = spawnProcess(command, args, {
            env: governedEnv,
            stdio: "inherit",
          });
        } catch (error) {
          resolve({
            code: null,
            signal: null,
            spawnError: error,
            actualDemand: sampler.stop(),
          });
          return;
        }
        sampler.attach(child.pid);
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          resolve({ ...outcome, actualDemand: sampler.stop() });
        };
        child.once("error", (error) =>
          finish({ code: null, signal: null, spawnError: error }),
        );
        child.once("close", (code, signal) => {
          stderr.write(
            `VITEST_PURE_LANE_CHILD state=closed exitStatus=${code ?? "null"} ` +
              `signal=${signal ?? "none"}\n`,
          );
          finish({ code, signal });
        });
      }),
  ).then((outcome) => {
    stderr.write(
      `VITEST_PURE_LANE_GOVERNOR state=settled ` +
        `exitStatus=${outcome.code ?? "null"} signal=${outcome.signal ?? "none"}\n`,
    );
    if (outcome.signal || outcome.spawnError) {
      stderr.write(
        `VITEST_PURE_LANE_SHARD state=${outcome.signal ? "signaled" : "spawn-error"} ` +
          `signal=${outcome.signal ?? "none"}\n`,
      );
      return 1;
    }
    return outcome.code ?? 1;
  });
}

const normalizeWsRel = (f) => String(f).replaceAll("\\", "/").replace(/^\.\//, "");

/** The lane's files left to run once the (already validated) reuse skip list is applied. */
export function remainingPureLaneFiles(pureFiles, reuseSkipFiles = []) {
  const skipped = new Set([...reuseSkipFiles].map(normalizeWsRel));
  return pureFiles.filter((f) => !skipped.has(normalizeWsRel(f)));
}

/**
 * Run every shard for complete failure inventory; return the first non-zero result.
 *
 * Pass reuse (gate-test-reuse-yield-2026-10-01 P-006, D-005): `reuseSkipFiles` is the skip list
 * resolved by the SAME validating reader each shard's vitest config applies
 * (resolveReuseSkipExclude), so the shard count is sized from the files that will actually run.
 * A list the reader declines resolves to [], and the full lane is sharded as before. When the
 * list covers every lane file (reuseSkipCoversRun, the EI-11132 guard's own predicate), no vitest
 * is spawned: an empty run is a deliberate pass here, never a silently empty glob.
 */
export async function runPureLaneShards({
  env = process.env,
  forwardedArgs = process.argv.slice(2),
  run = (args) => runVitestProcess(args, { env }),
  stderr = process.stderr,
  wsAbsDir = process.cwd(),
  pureFiles = resolveLaneInclude(wsAbsDir, "pure").include ?? [],
  reuseSkipFiles = resolveReuseSkipFiles(env, (line) =>
    stderr.write(`VITEST_PURE_LANE_REUSE ${line}\n`),
  ),
} = {}) {
  if (pureFiles.length === 0) {
    throw new Error(
      `PC_TEST_LANE=pure found ZERO files under ${wsAbsDir}`,
    );
  }
  if (
    reuseSkipCoversRun({
      wsAbsDir,
      script: "test:lane-pure",
      reuseSkipped: reuseSkipFiles,
      selectedFiles: pureFiles,
    })
  ) {
    stderr.write(
      `VITEST_PURE_LANE_SHARD state=all-reused pureFiles=${pureFiles.length} ` +
        `reused=${pureFiles.length} exitStatus=0\n`,
    );
    return 0;
  }
  const remaining = remainingPureLaneFiles(pureFiles, reuseSkipFiles);
  const reused = pureFiles.length - remaining.length;
  const pureFileCount = remaining.length;
  const shardCount = resolvePureLaneShardCount(env, pureFileCount);
  const workerCaps = WORKER_ENV_KEYS.map((key) =>
    positiveInteger(env[key]),
  ).filter((value) => value !== null);
  const workerCap = workerCaps.length > 0 ? Math.min(...workerCaps) : "default";
  let result = 0;
  for (let shard = 1; shard <= shardCount; shard += 1) {
    const args = buildPureLaneShardArgs(shard, shardCount, forwardedArgs);
    stderr.write(
      `VITEST_PURE_LANE_SHARD state=started shard=${shard}/${shardCount} ` +
        `workerCap=${workerCap} pureFiles=${pureFileCount} reused=${reused}\n`,
    );
    const code = await run(args);
    stderr.write(
      `VITEST_PURE_LANE_SHARD state=finished shard=${shard}/${shardCount} exitStatus=${code}\n`,
    );
    if (result === 0 && code !== 0) result = code;
  }
  return result;
}

// No top-level await: green-checkpoint.ts reaches this module through
// pure-lane-proof-capture.mjs, and tsx loads that chain as CJS, which cannot
// compile a top-level await (every gate run died at load on 2026-10-01).
if (isCliEntry(import.meta.url)) {
  runPureLaneShards().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e?.stack ?? e);
      process.exitCode = 1;
    },
  );
}
