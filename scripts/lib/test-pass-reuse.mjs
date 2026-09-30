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
//      tsconfig*.json of every package directory an executed module lives under, and the global
//      runner inputs.
//
// Everything else runs. PURE: every input is a value or a seam, so the unit tests pin the rule.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
 */
export function isGlobalRunnerInput(rel) {
  if (rel === "package-lock.json" || rel === "package.json" || rel === "tsconfig.json") return true;
  if (/^tsconfig\.[^/]*\.json$/.test(rel)) return true;
  if (/^vitest\.[^/]*$/.test(rel)) return true;
  if (/(^|\/)vitest\.[^/]*config[^/]*\.[cm]?[jt]s$/.test(rel)) return true;
  if (/^libs\/test-config\/(src\/|package\.json|tsconfig)/.test(rel)) {
    if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return false;
    // WI-10003752: fixtures only test-config's own tests read (those tests capture them as
    // per-file inputs), and non-source files under src/ — above all the editor / atomic-write
    // temps git-sync sweeps, e.g. `vitest-config.test.ts.tmp.<pid>.<hash>` — configure no
    // runner. Each used to discard every pass proof fleet-wide.
    if (/^libs\/test-config\/src\/(?:.*\/)?__fixtures__\//.test(rel)) return false;
    if (/^libs\/test-config\/src\//.test(rel) && !/\.(?:[cm]?[jt]sx?|json)$/.test(rel)) return false;
    return true;
  }
  if (/^patches\//.test(rel)) return true;
  return false;
}

/** The package.json / tsconfig*.json names that configure every file beneath their directory. */
const CONFIG_BASENAME_RE = /^(package\.json|tsconfig[^/]*\.json|\.babelrc|babel\.config\.[cm]?js)$/;

/**
 * Does a drift path invalidate a proof whose inputs are `modules` + `reads`? `dirs` is the set of
 * directories containing an executed module (and all their ancestors), used for the config rule.
 */
function invalidates(rel, o) {
  if (o.inputs.has(rel)) return true;
  for (const prefix of o.readDirs) if (rel === prefix.slice(0, -1) || rel.startsWith(prefix)) return true;
  const base = path.posix.basename(rel);
  if (CONFIG_BASENAME_RE.test(base) && o.dirs.has(path.posix.dirname(rel))) return true;
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
  };
  const skip = [];
  /** @type {Map<string, "audit" | "expired-clean">} */
  const watch = new Map();
  /** @type {Map<string, { drift: Set<string> | null, global: boolean }>} */
  const driftCache = new Map();
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
      const global = drift !== null && [...drift].some(isGlobalRunnerInput);
      driftCache.set(sha, { drift, global });
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
    const { drift, global } = driftFor(p.recordedSha);
    if (drift === null) {
      reject("unknownDrift");
      continue;
    }
    if (global) {
      reject("globalInput");
      continue;
    }
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
    for (const rel of drift) {
      if (invalidates(rel, { inputs, readDirs, dirs })) {
        changed = true;
        break;
      }
    }
    if (changed) {
      reject("inputChanged");
      continue;
    }
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

/** One greppable line per workspace: how many selected files were reused, and why others ran. */
export function formatTestReuseLine(wsName, summary, extra = "") {
  const s = summary;
  return (
    `TEST_PASS_REUSE ws=${wsName} candidates=${s.candidates} reused=${s.reused} noProof=${s.noProof} ` +
    `otherContext=${s.otherContext} otherRunner=${s.otherRunner} expired=${s.expired} ` +
    `notCaptured=${s.notCaptured} opaque=${s.opaque} unknownDrift=${s.unknownDrift} ` +
    `globalInput=${s.globalInput} inputChanged=${s.inputChanged} audited=${s.audited ?? 0} ` +
    `expiredClean=${s.expiredClean ?? 0}${extra}`
  );
}
