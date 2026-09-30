// Executed-source map — the runner side of P-002 (gate-latency-selection-and-retry-policy-2026-09-06).
//
// libs/test-config/src/executed-source-map-reporter.ts records, per test file, the modules
// vitest actually executed on a clean-checkout run, into harness_shared.test_executed_sources
// (migration 1132). This module LOADS that map for one workspace and supplies the git drift
// seam, in exactly the shape `selectRelatedTests({ executedMap, judgedSha, changedBetween })`
// consumes (scripts/lib/related-tests.mjs, `pruneWithExecutedMap`). The pruning rule itself
// lives there, next to the static selection it narrows, so the selector's unit tests pin both.
//
// Every failure here is fail-OPEN toward the static selection: an unreachable database, a
// missing table, an unparsable row, a sha git cannot diff — each yields "no map" (or "unknown
// drift" for one entry), and the static superset runs. Nothing in this file can shrink a run
// on its own.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { isGateEnrolled } from "../check-vitest-config-enrollment.mjs";

/** Set to `0`/`false`/`off` to leave the static selection un-pruned (default: pruning ON). */
export const EXECUTED_MAP_ENV = "AFFECTED_EXECUTED_MAP";
/** Stamped on a spawned vitest task so the reporter records this workspace's map (default: ON). */
export const EXECUTED_MAP_RECORD_ENV = "AFFECTED_RECORD_EXECUTED_SOURCES";
/** The reporter's arming channel: the npm workspace name whose runs it should record. */
export const EXECUTED_MAP_WORKSPACE_ENV = "PC_EXECUTED_SOURCE_MAP_WORKSPACE";
/** Optional: also write the recorded rows as JSON to this path (replay/inspection; no DB needed). */
export const EXECUTED_MAP_OUT_ENV = "PC_EXECUTED_SOURCE_MAP_OUT";
/**
 * WI-10003603: the reporter APPENDS one JSON line per flush here saying what the flush did, so the
 * runner can print the recorder's outcome into the run log the gate keeps. Must equal
 * `PC_EXECUTED_SOURCE_MAP_RESULT_ENV` in libs/test-config/src/vitest-config.ts.
 */
export const EXECUTED_MAP_RESULT_ENV = "PC_EXECUTED_SOURCE_MAP_RESULT";
/**
 * EI-24542010215430349: arm the reporter and input capture but persist nothing — the gate's rescue
 * reruns set it. Must equal `PC_EXECUTED_SOURCE_MAP_NO_PERSIST_ENV` in
 * libs/test-config/src/vitest-config.ts.
 */
export const EXECUTED_MAP_NO_PERSIST_ENV = "PC_EXECUTED_SOURCE_MAP_NO_PERSIST";

const OFF = new Set(["0", "false", "off", "no"]);

/** @param {Record<string, string | undefined>} [env] */
export function executedMapEnabled(env = process.env) {
  const raw = env[EXECUTED_MAP_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/** @param {Record<string, string | undefined>} [env] */
export function executedMapRecordingEnabled(env = process.env) {
  const raw = env[EXECUTED_MAP_RECORD_ENV];
  return raw == null || !OFF.has(String(raw).trim().toLowerCase());
}

/**
 * The database the map is read from — the SAME precedence the recording reporter uses
 * (libs/test-config/src/admin-test-runs-reporter.ts `tryGetPg`), so reader and writer can
 * never disagree about which database holds the rows. Pure over an env.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, source: 'HARNESS_ADMIN_DATABASE_URL' | 'PAPERCUSP_TEST_RUNS_DB_URL' | 'default' }}
 */
export function resolveExecutedMapPgUrl(env = process.env) {
  if (env.HARNESS_ADMIN_DATABASE_URL) {
    return { url: env.HARNESS_ADMIN_DATABASE_URL, source: "HARNESS_ADMIN_DATABASE_URL" };
  }
  if (env.PAPERCUSP_TEST_RUNS_DB_URL) {
    return { url: env.PAPERCUSP_TEST_RUNS_DB_URL, source: "PAPERCUSP_TEST_RUNS_DB_URL" };
  }
  return {
    url: "postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp",
    source: "default",
  };
}

/**
 * Open a short-lived `pg` client for the selection read. Bounded: a database that does not
 * answer within `timeoutMs` is "no map", never a stalled selection.
 *
 * @param {{ env?: Record<string, string | undefined>, timeoutMs?: number }} [o]
 * @returns {Promise<import('pg').Client>}
 */
export async function connectExecutedMapPg({ env = process.env, timeoutMs = 5_000 } = {}) {
  const { Client } = await import("pg");
  const { url } = resolveExecutedMapPgUrl(env);
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: 15_000,
    application_name: "affected-tests executed-source-map",
  });
  await client.connect();
  return client;
}

/**
 * Turn stored rows into the selector's map. Pure — exported for the unit tests.
 *
 * Rows arrive newest-first per (workspace, test file); the first row wins. Paths are
 * repo-root-relative POSIX in the table and ABSOLUTE in the selector (it compares against
 * `changedPaths`, which are absolute), so this is where they are re-anchored.
 *
 * @param {Array<{ test_file: string, recorded_sha: string, executed_modules: string[] | null }>} rows
 * @param {{ repoRoot: string }} o
 * @returns {import('./related-tests.mjs').ExecutedMap}
 */
export function rowsToExecutedMap(rows, { repoRoot }) {
  /** @type {Map<string, { recordedSha: string, executed: Set<string> }>} */
  const map = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.test_file !== "string" || typeof row.recorded_sha !== "string") continue;
    if (!Array.isArray(row.executed_modules) || row.executed_modules.length === 0) continue;
    const key = path.resolve(repoRoot, row.test_file);
    if (map.has(key)) continue; // newest-first: keep the first
    const executed = new Set();
    for (const m of row.executed_modules) {
      if (typeof m === "string" && m.length > 0) executed.add(path.resolve(repoRoot, m));
    }
    if (executed.size === 0) continue;
    map.set(key, { recordedSha: row.recorded_sha, executed });
  }
  return map;
}

/**
 * Load the newest executed map per test file for one workspace.
 *
 * @param {object} o
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} o.client
 *        a `pg` Client (scripts/lib/pg-url.mjs `connectScriptPg`)
 * @param {string} o.workspaceName npm workspace name
 * @param {string} o.repoRoot
 * @returns {Promise<{ map: import('./related-tests.mjs').ExecutedMap, rows: number }>}
 */
export async function loadExecutedSourceMap({ client, workspaceName, repoRoot }) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (test_file) test_file, recorded_sha, executed_modules
       FROM harness_shared.test_executed_sources
      WHERE workspace_name = $1
      ORDER BY test_file, recorded_at DESC`,
    [workspaceName],
  );
  return { map: rowsToExecutedMap(rows, { repoRoot }), rows: rows.length };
}

/** @param {unknown} v @returns {string[]} */
function stringArray(v) {
  return Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length > 0) : [];
}

/**
 * Newest pass proof per test file, keyed REPO-RELATIVE (gate-file-level-test-reuse-2026-09-27
 * P-008): the input `selectReusablePasses` (scripts/lib/test-pass-reuse.mjs) judges. Rows
 * arrive newest-first per test file; the first wins. A row that cannot be read is dropped,
 * which the rule reads as "no proof" (the file runs).
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Map<string, import('./test-pass-reuse.mjs').ReuseProof>}
 */
export function rowsToReuseProofs(rows) {
  /** @type {Map<string, import('./test-pass-reuse.mjs').ReuseProof>} */
  const proofs = new Map();
  for (const row of rows ?? []) {
    if (!row || typeof row.test_file !== "string" || typeof row.recorded_sha !== "string") continue;
    if (proofs.has(row.test_file)) continue;
    const at = row.recorded_at instanceof Date ? row.recorded_at.getTime() : Date.parse(String(row.recorded_at));
    proofs.set(row.test_file, {
      recordedSha: row.recorded_sha,
      recordedAtMs: Number.isFinite(at) ? at : Number.NaN,
      executedModules: stringArray(row.executed_modules),
      readPaths: stringArray(row.read_paths),
      inputsCaptured: row.inputs_captured === true,
      opaqueReasons: stringArray(row.opaque_reasons),
      runContext: typeof row.run_context === "string" ? row.run_context : null,
      runnerIdentity: typeof row.runner_identity === "string" ? row.runner_identity : null,
    });
  }
  return proofs;
}

/**
 * Load the newest pass proof per test file for one workspace and ONE run context (D-004 rule 1:
 * reuse only consumes proofs its own runner class recorded).
 *
 * @param {object} o
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} o.client
 * @param {string} o.workspaceName
 * @param {string} o.runContext
 * @returns {Promise<{ proofs: Map<string, import('./test-pass-reuse.mjs').ReuseProof>, rows: number }>}
 */
export async function loadReuseProofs({ client, workspaceName, runContext }) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (test_file) test_file, recorded_sha, recorded_at, executed_modules,
            read_paths, inputs_captured, opaque_reasons, run_context, runner_identity
       FROM harness_shared.test_executed_sources
      WHERE workspace_name = $1 AND run_context = $2
      ORDER BY test_file, recorded_at DESC`,
    [workspaceName, runContext],
  );
  return { proofs: rowsToReuseProofs(rows), rows: rows.length };
}

/**
 * P-013 (gate-file-level-test-reuse-2026-09-27): the newest CI pass duration per test file over
 * the last 7 days, for the reuse "time saved" estimate. `duration_ms` is the reporter's per-file
 * test time, so a sum over it is a LOWER bound (collection, transform and worker start-up are not
 * in it). A file with no CI pass in the window is absent from the map. Measured 2026-09-27: 314ms
 * for operator-core's 867 proof files (test_runs_file_path_idx).
 *
 * @param {object} o
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} o.client
 * @param {string[]} o.files repo-relative test files
 * @returns {Promise<Map<string, number>>}
 */
export async function loadPassDurations({ client, files }) {
  if (files.length === 0) return new Map();
  const { rows } = await client.query(
    `SELECT DISTINCT ON (file_path) file_path, duration_ms
       FROM harness_shared.test_runs
      WHERE source = 'ci' AND status = 'pass' AND finished_at > now() - interval '7 days'
        AND file_path = ANY($1::text[])
      ORDER BY file_path, finished_at DESC`,
    [files],
  );
  const out = new Map();
  for (const r of rows) {
    const ms = Number(r.duration_ms);
    if (typeof r.file_path === "string" && r.duration_ms != null && Number.isFinite(ms) && ms >= 0) {
      out.set(r.file_path, ms);
    }
  }
  return out;
}

/**
 * Build the `changedBetween` seam over a real git checkout. `git diff --name-only A B` names
 * every path that differs between the two commits (a rename appears as both names); an
 * unknown sha — one gc'd away, or from a lineage this checkout never had — makes the diff
 * fail, and that reads as `null` ("cannot tell"), which the pruning rule treats as stale.
 *
 * `relative: true` returns repo-root-relative POSIX paths (the per-file pass-reuse rule's
 * input) instead of absolute ones (the pruning selector's input).
 *
 * @param {{ repoRoot: string, exec?: (file: string, args: string[], opts: object) => string, relative?: boolean }} o
 * @returns {import('./related-tests.mjs').ChangedBetween}
 */
export function gitChangedBetween({ repoRoot, exec = defaultExec, relative = false }) {
  /** @type {Map<string, Set<string> | null>} */
  const cache = new Map();
  return (recordedSha, judgedSha) => {
    const key = `${recordedSha}..${judgedSha}`;
    if (cache.has(key)) return cache.get(key);
    let result = null;
    try {
      const out = new Set();
      result = collectRecursiveDiff({ exec, repoDir: repoRoot, prefix: "", a: recordedSha, b: judgedSha, out })
        ? relative
          ? out
          : new Set([...out].map((rel) => path.resolve(repoRoot, rel)))
        : null;
    } catch {
      result = null;
    }
    cache.set(key, result);
    return result;
  };
}

/** Every-zero object id: git's marker for "absent on this side" in `--raw` output. */
const ZERO_OID_RE = /^0+$/;

/**
 * Collect repo-root-relative paths changed between `a` and `b`, RECURSING into submodules
 * (gate-file-level-test-reuse-2026-09-27 D-003). A superproject `git diff --name-only` names a
 * submodule change as the bare gitlink path, which no executed module ever equals, so a change
 * inside any of the ~38 submodules used to read as "no drift". A moved gitlink is diffed INSIDE
 * the submodule between the two pinned commits. Anything that cannot be diffed (a submodule
 * added, removed or type-changed; a pinned commit missing from the local clone) returns false,
 * and the caller reads that as "cannot tell" (stale), never as "nothing changed".
 *
 * @returns {boolean} true when the full recursive diff was computed
 */
export function collectRecursiveDiff({ exec, repoDir, prefix, a, b, out }) {
  const opts = {
    cwd: repoDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 256 * 1024 * 1024,
  };
  const raw = String(exec("git", ["diff", "--raw", "--no-renames", "--abbrev=40", "-z", a, b], opts));
  // -z --raw: ":<m1> <m2> <o1> <o2> <status>\0<path>\0" repeated.
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i].replace(/^\n/, "");
    const rel = parts[i + 1];
    if (!meta || !rel) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) /.exec(meta);
    if (!m) return false;
    const [, modeA, modeB, oidA, oidB] = m;
    out.add(prefix + rel);
    if (modeA !== "160000" && modeB !== "160000") continue;
    if (modeA !== modeB || ZERO_OID_RE.test(oidA) || ZERO_OID_RE.test(oidB)) return false;
    const subDir = path.join(repoDir, rel);
    if (!collectRecursiveDiff({ exec, repoDir: subDir, prefix: `${prefix}${rel}/`, a: oidA, b: oidB, out })) {
      return false;
    }
  }
  return true;
}

function defaultExec(file, args, opts) {
  return execFileSync(file, args, opts);
}

/**
 * One greppable line per workspace selection, so a run that did not narrow is never silent
 * about why.
 *
 * @param {string} wsName
 * @param {import('./related-tests.mjs').ExecutedMapSummary | undefined} summary
 * @param {number} rows
 */
export function formatExecutedMapLine(wsName, summary, rows) {
  if (!summary) return `EXECUTED_SOURCE_MAP ws=${wsName} applied=false reason=no-summary rows=${rows}`;
  const k = summary.kept;
  return (
    `EXECUTED_SOURCE_MAP ws=${wsName} applied=${summary.applied} reason=${summary.reason ?? "ok"} ` +
    `rows=${rows} entries=${summary.entries} pruned=${summary.pruned} prunable=${summary.prunable} ` +
    `wouldEmpty=${summary.wouldEmpty} keptChangedTest=${k.changedTest} keptUnresolved=${k.unresolved} ` +
    `keptNoEntry=${k.noEntry} keptUntrusted=${k.untrusted} keptUnknownDrift=${k.unknownDrift} ` +
    `keptStale=${k.stale} keptIntersects=${k.intersects}`
  );
}

// ── Recorder outcome (WI-10003603) ────────────────────────────────────────────────────────────
// The reporter's own outcome line goes to vitest stderr, which the gate discards, so a writer that
// failed on every row (WI-10003597) recorded zero pass proofs for ~8h with nothing noticing. The
// runner names a per-task result file, reads it back after the task, and prints
//   EXECUTED_SOURCE_MAP_RESULT task=<ws::script> outcome=<o> rows=N retired=N skipped=N dirty=<b> sha=<s>
//   EXECUTED_SOURCE_MAP_ALARM task=<ws::script> outcome=<failed|timed-out|no-report-unexpected> error=<message>
//   EXECUTED_SOURCE_MAP_TOTAL tasks=N written=N rows=N retired=N notPersisted=N nothingToRecord=N failed=N timedOut=N noReport=N malformed=N noReportExpected=N noReportUnexpected=N
// into the run log (`noReport` is the total; the two split keys, WI-10003792, are absent from logs
// written before the split and count only tasks whose report expectation was resolved at arming); packages/operator-core/lib/release/test-pass-reuse-report.ts parses them into
// the gate's per-round reuse health record.

/** Every outcome the reporter writes (`ExecutedSourceMapOutcome` in the reporter). */
export const EXECUTED_MAP_RESULT_OUTCOMES = Object.freeze([
  "written",
  "failed",
  "timed-out",
  "not-persisted",
  "nothing-to-record",
]);
const RESULT_OUTCOME_SET = new Set(EXECUTED_MAP_RESULT_OUTCOMES);

/**
 * The per-task result file: under the run-log root, unique per affected-tests run and task, so
 * concurrent runs on the shared box never read each other's outcomes.
 *
 * @param {string} root
 * @param {string} runToken
 * @param {string} taskLabel
 * @returns {string}
 */
export function executedMapResultPath(root, runToken, taskLabel) {
  const safe = String(taskLabel).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 160);
  return path.join(root, `executed-map-result-${runToken}-${safe}.jsonl`);
}

/**
 * Remove a stale result file before the task runs, so a leftover never reads as this run's report.
 *
 * @param {string} filePath
 */
export function clearExecutedMapResult(filePath) {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* an unremovable leftover is at worst an extra line; never fail the run over it */
  }
}

// ── Report expectation (WI-10003792) ───────────────────────────────────────────────────────────
// A task is armed whenever it is a unit vitest-shaped script, but only a task whose REAL vitest
// config takes part in the gate can ever write a result file. Without this split, a newly-enrolled
// task that went silent (a recorder regression) counted exactly like an astro check or a plain
// exempt config that never could report. The expectation is decided at ARMING time from the
// task's own script and config, never guessed afterwards from the missing file.

const VITEST_DEFAULT_CONFIG_NAMES = Object.freeze([
  "vitest.config.ts",
  "vitest.config.mts",
  "vitest.config.js",
  "vitest.config.mjs",
]);

/**
 * The argv words of a package.json script command, with leading `VAR=value` env assignments and a
 * `…/pc-heavy.sh --` admission wrapper removed (both run the same program underneath).
 *
 * @param {string | null | undefined} command
 * @returns {string[]}
 */
export function scriptCommandWords(command) {
  const words = String(command ?? "").trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  if (i < words.length && /(^|\/)pc-heavy\.sh$/.test(words[i])) {
    i += 1;
    if (words[i] === "--") i += 1;
  }
  return words.slice(i);
}

/** The value of a `--config <p>` / `--config=<p>` / `-c <p>` flag, or null. */
function configFlag(words) {
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.startsWith("--config=")) return w.slice("--config=".length) || null;
    if ((w === "--config" || w === "-c") && words[i + 1] && !words[i + 1].startsWith("-")) return words[i + 1];
  }
  return null;
}

/**
 * @typedef {{ expectsReport: boolean, reason: 'enrolled-config' | 'unenrolled-config' | 'no-config' | 'not-vitest' | 'node-test-runner' | 'wrapper-unreadable' | 'compound-command' | 'no-command', config: string | null }} TaskReportExpectation
 */

/**
 * Whether a recording task's pass-proof recorder is EXPECTED to write a result file: the script
 * runs vitest (directly, or through a node wrapper that delegates to vitest) under a config that
 * takes part in the gate (`isGateEnrolled`, the same rule scripts/check-vitest-config-enrollment.mjs
 * enforces). Config resolution: an explicit `--config` / `-c` flag, else the workspace's default
 * `vitest.config.{ts,mts,js,mjs}`. A missing config, an unreadable wrapper, a non-vitest program and
 * a compound shell command all resolve to NOT expected — a false alarm on a task that never could
 * report is the failure this split exists to remove.
 *
 * @param {{ command: string | null | undefined, wsDir: string, readFile?: (p: string) => string, isEnrolled?: (source: string, fileName: string) => boolean }} o
 *   `wsDir` is the workspace directory (absolute, or relative to the process cwd); config paths
 *   are resolved against it, and `config` in the result is reported relative to it.
 * @returns {TaskReportExpectation}
 */
export function resolveTaskReportExpectation({
  command,
  wsDir,
  readFile = (p) => readFileSync(p, "utf8"),
  isEnrolled = isGateEnrolled,
}) {
  const no = (reason, config = null) => ({ expectsReport: false, reason, config });
  if (/[;&|`]|\$\(/.test(String(command ?? ""))) return no("compound-command");
  const words = scriptCommandWords(command);
  if (words.length === 0) return no("no-command");
  const program = path.basename(words[0]);
  let rest;
  if (program === "vitest") {
    rest = words.slice(1);
  } else if (program === "node") {
    const args = words.slice(1);
    if (args.includes("--test")) return no("node-test-runner");
    const scriptIndex = args.findIndex((a) => !a.startsWith("-"));
    const scriptArg = scriptIndex < 0 ? null : args[scriptIndex];
    if (!scriptArg || !/\.(?:[cm]?js|[cm]?ts)$/.test(scriptArg)) return no("not-vitest");
    let wrapper;
    try {
      wrapper = readFile(path.resolve(wsDir, scriptArg));
    } catch {
      return no("wrapper-unreadable");
    }
    if (!/\bvitest\b/.test(wrapper)) return no("not-vitest");
    rest = args.slice(scriptIndex + 1);
  } else {
    return no("not-vitest");
  }
  const explicit = configFlag(rest);
  const candidates = explicit ? [explicit] : VITEST_DEFAULT_CONFIG_NAMES;
  for (const name of candidates) {
    const abs = path.resolve(wsDir, name);
    let source;
    try {
      source = readFile(abs);
    } catch {
      continue;
    }
    const config = path.relative(path.resolve(wsDir), abs).split(path.sep).join("/");
    return isEnrolled(source, abs)
      ? { expectsReport: true, reason: "enrolled-config", config }
      : no("unenrolled-config", config);
  }
  return no("no-config", explicit);
}

/**
 * @typedef {{ outcome: string, rows: number, retired: number, skipped: number, dirty: boolean, sha: string | null, error: string | null }} ExecutedMapResult
 * @typedef {{ status: 'reported' | 'no-report', results: ExecutedMapResult[], malformed: number, expectsReport?: boolean | null }} ExecutedMapResultRead
 *   `expectsReport` is stamped by the runner from `resolveTaskReportExpectation` (absent/null = unknown).
 */

const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Read one task's result file. A missing or empty file is `no-report` (the reporter never flushed:
 * the task crashed or was killed, or its vitest config does not wire the reporter). A line that is
 * not a well-formed result is counted as `malformed`, never guessed at.
 *
 * @param {string} filePath
 * @param {{ readFile?: (p: string) => string }} [o]
 * @returns {ExecutedMapResultRead}
 */
export function readExecutedMapResults(filePath, { readFile = (p) => readFileSync(p, "utf8") } = {}) {
  let text;
  try {
    text = readFile(filePath);
  } catch {
    return { status: "no-report", results: [], malformed: 0 };
  }
  /** @type {ExecutedMapResult[]} */
  const results = [];
  let malformed = 0;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    const rows = count(o?.rows);
    const retired = count(o?.retired);
    const skipped = count(o?.skipped);
    if (!o || !RESULT_OUTCOME_SET.has(o.outcome) || rows === null || retired === null || skipped === null) {
      malformed += 1;
      continue;
    }
    results.push({
      outcome: o.outcome,
      rows,
      retired,
      skipped,
      dirty: o.dirty === true,
      sha: typeof o.sha === "string" && o.sha ? o.sha : null,
      error: typeof o.error === "string" && o.error ? o.error : null,
    });
  }
  return { status: results.length > 0 ? "reported" : "no-report", results, malformed };
}

/** One-line, whitespace-collapsed error text, so an alarm line stays one line. */
function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || "unknown";
}

/**
 * The per-task RESULT lines (one per flush, or one `outcome=no-report` line).
 *
 * @param {string} taskLabel
 * @param {ExecutedMapResultRead} read
 * @returns {string[]}
 */
export function formatExecutedMapResultLines(taskLabel, read) {
  if (read.status === "no-report") {
    const expected = typeof read.expectsReport === "boolean" ? ` expected=${read.expectsReport}` : "";
    return [`EXECUTED_SOURCE_MAP_RESULT task=${taskLabel} outcome=no-report malformed=${read.malformed}${expected}`];
  }
  return read.results.map(
    (r) =>
      `EXECUTED_SOURCE_MAP_RESULT task=${taskLabel} outcome=${r.outcome} rows=${r.rows} retired=${r.retired} ` +
      `skipped=${r.skipped} dirty=${r.dirty} sha=${r.sha ? r.sha.slice(0, 12) : "unknown"}`,
  );
}

/**
 * ALARM lines for flushes whose write did not land, and (WI-10003792) for a task whose enrolled
 * config was EXPECTED to report but wrote nothing (`outcome=no-report-unexpected`: the task was
 * killed before its run ended, or the recorder's wiring regressed). `not-persisted` is NOT an alarm
 * here: on an agent's shared dirty checkout it is the designed outcome; the gate decides whether
 * its own clean round persisted nothing.
 *
 * @param {string} taskLabel
 * @param {ExecutedMapResultRead} read
 * @returns {string[]}
 */
export function formatExecutedMapAlarmLines(taskLabel, read) {
  if (read.status === "no-report") {
    return read.expectsReport === true
      ? [
          `EXECUTED_SOURCE_MAP_ALARM task=${taskLabel} outcome=no-report-unexpected rows=0 ` +
            `error=enrolled task wrote no recorder result (killed before its run ended, or the recorder is unwired)`,
        ]
      : [];
  }
  return read.results
    .filter((r) => r.outcome === "failed" || r.outcome === "timed-out")
    .map(
      (r) =>
        `EXECUTED_SOURCE_MAP_ALARM task=${taskLabel} outcome=${r.outcome} rows=${r.rows} error=${oneLine(r.error ?? r.outcome)}`,
    );
}

/**
 * @param {ExecutedMapResultRead[]} reads one per armed task
 */
export function summarizeExecutedMapResults(reads) {
  const s = {
    tasks: reads.length,
    written: 0,
    rows: 0,
    retired: 0,
    notPersisted: 0,
    nothingToRecord: 0,
    failed: 0,
    timedOut: 0,
    noReport: 0,
    noReportExpected: 0,
    noReportUnexpected: 0,
    malformed: 0,
  };
  for (const read of reads) {
    s.malformed += read.malformed;
    if (read.status === "no-report") {
      // `noReport` stays the total; the split counts only tasks whose expectation is known.
      s.noReport += 1;
      if (read.expectsReport === true) s.noReportUnexpected += 1;
      else if (read.expectsReport === false) s.noReportExpected += 1;
      continue;
    }
    for (const r of read.results) {
      if (r.outcome === "written") {
        s.written += 1;
        s.rows += r.rows;
        s.retired += r.retired;
      } else if (r.outcome === "failed") s.failed += 1;
      else if (r.outcome === "timed-out") s.timedOut += 1;
      else if (r.outcome === "not-persisted") s.notPersisted += 1;
      else if (r.outcome === "nothing-to-record") s.nothingToRecord += 1;
    }
  }
  return s;
}

/**
 * @param {ReturnType<typeof summarizeExecutedMapResults>} s
 * @returns {string}
 */
export function formatExecutedMapTotalLine(s) {
  return (
    `EXECUTED_SOURCE_MAP_TOTAL tasks=${s.tasks} written=${s.written} rows=${s.rows} retired=${s.retired} ` +
    `notPersisted=${s.notPersisted} nothingToRecord=${s.nothingToRecord} failed=${s.failed} ` +
    `timedOut=${s.timedOut} noReport=${s.noReport} malformed=${s.malformed} ` +
    `noReportExpected=${s.noReportExpected} noReportUnexpected=${s.noReportUnexpected}`
  );
}
