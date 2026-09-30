// Retry gating on FAILURE SHAPE (plan gate-latency-selection-and-retry-policy-2026-09-06, P-003).
//
// `scripts/affected-tests.mjs` re-runs a failed workspace once under AFFECTED_RETRY_FAILED=1 to
// absorb LOAD FLAKES — the 2026-06-06 class where single-test timeouts held green `main` back
// for hours while an identification re-run passed 8867/8867. That retry used to fire on ANY
// gating failure, regardless of what the failure looked like. Measured 2026-09-05 (gate run
// e70cd139): 36 operator-core files failed on deterministic assertion diffs, the retry re-ran
// the whole workspace serially, reproduced the identical result, and cost 34 minutes of a
// 2h28m gate for no new information.
//
// This module decides, from the first pass's own output, whether a second pass CAN answer
// anything. It is pure and unit-tested; the runner only reads `decision.retry`/`mode`.
//
// The rule, in the fail-safe direction for the property the retry protects (never let a
// genuine load flake hold the gate red):
//   • a FLAKE-CLASS signature anywhere in the output ⇒ retry (fresh-process on the failed
//     files when ≤ maxFiles, else the whole workspace exactly as before);
//   • no flake signature, but a TINY failed set (≤ smallRedFiles) ⇒ retry the files anyway —
//     seconds of cost, and small reds are where an unrecognised flake shape is most likely;
//   • no flake signature and a BROAD deterministic red ⇒ skip. A second identical pass over an
//     assertion diff is not evidence, and past `maxFiles` the code already called it "a real
//     regression, not a flake" — it just kept re-running it.
//   • nothing parseable (no failed files) ⇒ retry the workspace as before: an unattributable
//     failure is an infrastructure shape until proven otherwise.

import { stripVitestAnsi, vitestSuiteFailRow } from "./vitest-summary.mjs";

/**
 * Signatures of the failure classes a fresh-process re-run can plausibly absorb. Each is named
 * so the log line says WHICH class earned the retry — a reader can then judge whether the
 * absorption was legitimate.
 *
 * ⚠ These are matched against the FAILURE REPORT only (see {@link vitestFailureReport}), never
 * the whole capture. P-006's replay of gate run e70cd139 measured why: the first pass's stdout
 * carries every PASSING test's title and console output too, and that text matched
 * `connection` (a mocked-pool message printing ECONNREFUSED under a green test) and
 * `worker-crash` (green titles reading "…it used to SIGKILL and leak" / "native SIGABRT").
 * Scanned whole, a 16-file deterministic red classified as
 * `flake-class:connection+worker-crash(broad)` and re-ran the whole workspace — the exact
 * 34-minute pass P-003 exists to skip.
 */
export const RETRY_FLAKE_CLASSES = Object.freeze([
  {
    id: "test-timeout",
    // Vitest's own test/hook timeout error, or jest's. NOT the bare `timed out after Nms`: vitest
    // prints `close timed out after 10000ms` / "something prevents Vite server from exiting"
    // as a TEARDOWN note after a run whose tests already finished (measured in every e70cd139
    // lane), and that is not a failure a re-run can absorb.
    re: /\b(?:Test|Hook) timed out (?:in|after) \d+\s*ms\b|Timeout - Async callback/i,
  },
  {
    id: "connection",
    re: /\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|socket hang up|Connection terminated unexpectedly|\bETIMEDOUT\b/i,
  },
  { id: "port-conflict", re: /\bEADDRINUSE\b/ },
  {
    id: "late-console",
    // vitest-fail-on-console: a co-resident file's late output lands in the next file's
    // assertion window (HARDEN-GATE's "cross-file state poisoning" class).
    re: /Expected test not to call console\.|vitest-fail-on-console|fail-on-console/i,
  },
  {
    id: "worker-crash",
    re: /Worker exited unexpectedly|JavaScript heap out of memory|FATAL ERROR: |\bSIG(?:KILL|SEGV|ABRT)\b|Segmentation fault|ERR_IPC_CHANNEL_CLOSED|Channel closed|Worker terminated due to reaching memory limit/i,
  },
  {
    id: "transform-race",
    // A peer's mid-edit transform error on the shared tree (the other HARDEN-GATE class): the
    // module graph the first pass loaded no longer exists by the time anyone looks.
    re: /Transform failed with \d+ error|Failed to resolve import|Failed to load url|ENOENT: no such file or directory, open '[^']*\.(?:ts|tsx|mts|js|mjs)'/i,
  },
]);

/** Below this many failed files a retry costs seconds; above `maxFiles` it costs the suite. */
export const RETRY_SMALL_RED_FILES = 3;

/**
 * The divider vitest's default reporter prints before its failure report. Everything from the
 * first of these to the end of the capture is the ERROR of every failed test/suite (or an
 * unhandled error) — the thrown error, its message, its stack. Passing tests never appear
 * there, and neither does anyone's console output. Measured on vitest 4.1.8 (gate run
 * e70cd139): `⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯`, `⎯⎯⎯⎯⎯⎯ Failed Tests 128 ⎯⎯⎯⎯⎯⎯`; the unhandled
 * forms are vitest's `⎯⎯ Unhandled Errors ⎯⎯` / "Vitest caught N unhandled error(s)".
 */
export const VITEST_FAILURE_REPORT_DIVIDER =
  /Failed (?:Tests|Suites) \d+|Unhandled (?:Errors?|Rejections?)|Vitest caught \d+ unhandled/;

/**
 * The slice of a captured run the flake classifier is allowed to read.
 *
 * `scripts/affected-tests.mjs` captures a task as stdout followed by stderr. Vitest writes its
 * tree (one row per test, passing ones included) and any captured console output to stdout,
 * and the failure report to stderr — so in the capture the report is the TAIL, and the text
 * before the divider is exactly the noise the classes above must not read. ANSI is stripped
 * first: the reporter colours its tokens, and `\x1b[31mECONNREFUSED\x1b[39m` does not satisfy
 * `\bECONNREFUSED\b` (the `m` closing the escape is a word character).
 *
 * When no divider is present the WHOLE capture is scanned — a spawn error, a pool crash before
 * any report, or a non-vitest runner has no report to scope to, and the fail-safe direction
 * for the retry (never let a genuine load flake hold the gate red) is to look everywhere.
 *
 * @param {string} output
 * @returns {{ report: string, scope: 'failure-report' | 'whole-output' }}
 */
export function vitestFailureReport(output) {
  const plain = stripVitestAnsi(typeof output === "string" ? output : "");
  const m = VITEST_FAILURE_REPORT_DIVIDER.exec(plain);
  if (!m) return { report: plain, scope: "whole-output" };
  // From the START of the divider's line, so the report reads as vitest printed it.
  return { report: plain.slice(plain.lastIndexOf("\n", m.index) + 1), scope: "failure-report" };
}

/**
 * Which flake classes appear in the captured output's failure report.
 *
 * @param {string} output
 * @returns {string[]} class ids, in RETRY_FLAKE_CLASSES order
 */
export function matchRetryFlakeClasses(output) {
  return classifyRetryFlakes(output).flakeClasses;
}

/** @param {string} text an already-scoped, ANSI-stripped slice of the failure report */
function flakeClassesIn(text) {
  if (!text) return [];
  return RETRY_FLAKE_CLASSES.filter(({ re }) => re.test(text)).map(({ id }) => id);
}

/** The `⎯⎯⎯[k/N]⎯` rule vitest prints after every failure entry. */
const VITEST_FAILURE_ENTRY_RULE = /^\s*⎯+\[\d+\/\d+\]⎯*\s*$/;

/**
 * Split an ANSI-stripped failure report into its per-file entries.
 *
 * vitest 4 opens each entry with `FAIL <file> > suite > test` (a failed SUITE reads
 * `FAIL <file> [ <file> ]`) and closes it with a `⎯⎯[k/N]⎯` rule; the entry's text is the
 * thrown error, its message and its stack. Text outside every entry — the divider, an
 * `Unhandled Errors` block, vitest's teardown notes — comes back as `unattributed`, so a
 * caller can tell a signature it can pin to a file from one it cannot.
 *
 * @param {string} report
 * @returns {{ entries: Array<{ file: string, text: string }>, unattributed: string }}
 */
export function vitestFailureEntries(report) {
  const entries = [];
  const unattributed = [];
  let current = null;
  for (const line of String(report ?? "").split("\n")) {
    const head = vitestSuiteFailRow().exec(line);
    if (head) {
      if (current) entries.push(current);
      current = { file: head[1], text: line };
      continue;
    }
    if (VITEST_FAILURE_ENTRY_RULE.test(line)) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (current) current.text += `\n${line}`;
    else unattributed.push(line);
  }
  if (current) entries.push(current);
  return { entries, unattributed: unattributed.join("\n") };
}

/**
 * The flake signatures in a capture, attributed to the FILES whose failure entries carry them.
 *
 * P-006's replay of gate run e70cd139 is why attribution matters: after scoping to the report,
 * each operator-core lane still carried ONE signature — a `Test timed out in 180000ms` inside
 * launch-on-plan.test.ts's entries, a fail-on-console entry from a quarantined hyperbee file —
 * beside 15–17 files of plain assertion diffs. Under a file-blind rule that one entry re-ran
 * the whole workspace (~20 minutes a lane); attributed, it re-runs one file.
 *
 * `unattributedClasses` are signatures found OUTSIDE every entry (a worker crash reported as an
 * unhandled error, a capture with no report at all). They cannot be pinned to a file, so the
 * decision falls back to the file-blind rule for them — the fail-safe direction.
 *
 * @param {string} output
 * @returns {{
 *   scope: 'failure-report' | 'whole-output',
 *   flakeClasses: string[],
 *   flakeFiles: string[],
 *   unattributedClasses: string[],
 * }}
 */
export function classifyRetryFlakes(output) {
  const { report, scope } = vitestFailureReport(output);
  if (scope !== "failure-report") {
    const unattributedClasses = flakeClassesIn(report);
    return { scope, flakeClasses: unattributedClasses, flakeFiles: [], unattributedClasses };
  }
  const { entries, unattributed } = vitestFailureEntries(report);
  const seen = new Set();
  const flakeFiles = [];
  for (const { file, text } of entries) {
    const classes = flakeClassesIn(text);
    if (classes.length === 0) continue;
    for (const id of classes) seen.add(id);
    if (!flakeFiles.includes(file)) flakeFiles.push(file);
  }
  const unattributedClasses = flakeClassesIn(unattributed);
  for (const id of unattributedClasses) seen.add(id);
  const flakeClasses = RETRY_FLAKE_CLASSES.map(({ id }) => id).filter((id) => seen.has(id));
  return { scope, flakeClasses, flakeFiles, unattributedClasses };
}

/**
 * Decide whether — and how — to retry a failed task.
 *
 * @param {object}   o
 * @param {string[]} o.failedFiles      files the first pass's vitest summary named (may be empty)
 * @param {string}   o.output           the first pass's captured stdout+stderr
 * @param {number}   o.maxFiles         FRESH_RETRY_MAX_FILES — the fresh-process file cap
 * @param {number}   [o.smallRedFiles]  RETRY_SMALL_RED_FILES override
 * @returns {{
 *   retry: boolean,
 *   mode: 'fresh-files' | 'whole-workspace' | 'none',
 *   reason: string,
 *   flakeClasses: string[],
 *   flakeScope: 'failure-report' | 'whole-output',
 *   flakeFiles: string[],
 *   retryFiles: string[] | null,
 *   failedFileCount: number,
 * }} `retryFiles` is the file list a `fresh-files` retry re-runs (null for the other modes) —
 *   every failed file when the red is small, only the signature-bearing files when it is broad.
 */
export function decideRetry({
  failedFiles,
  output,
  maxFiles,
  smallRedFiles = RETRY_SMALL_RED_FILES,
}) {
  const files = Array.isArray(failedFiles) ? failedFiles : [];
  const { flakeClasses, flakeFiles, unattributedClasses, scope: flakeScope } = classifyRetryFlakes(output);
  const failedFileCount = files.length;
  const base = { flakeClasses, flakeScope, flakeFiles, retryFiles: null, failedFileCount };

  if (failedFileCount === 0) {
    // Nothing parsed: a non-vitest failure mode (spawn error, collection crash, a guard).
    // The shape is unknown, so this stays the conservative whole-workspace retry.
    return {
      ...base,
      retry: true,
      mode: "whole-workspace",
      reason: "unattributed-failure",
    };
  }
  if (flakeClasses.length > 0) {
    const cls = flakeClasses.join("+");
    if (failedFileCount <= maxFiles) {
      return { ...base, retry: true, mode: "fresh-files", retryFiles: files, reason: `flake-class:${cls}` };
    }
    // A BROAD red with a signature. Re-running everything re-runs the assertion diffs too —
    // the 34 minutes P-003 exists to save — so when every signature is pinned to a file, and
    // those files fit the fresh-process cap, re-run just them; the rest is deterministic and
    // is reported as such. A signature nobody can pin (an unhandled worker crash) keeps the
    // whole-workspace retry: it may have taken any file down with it.
    const retryFiles = flakeFiles.filter((f) => files.includes(f));
    if (unattributedClasses.length === 0 && retryFiles.length > 0 && retryFiles.length <= maxFiles) {
      return {
        ...base,
        retry: true,
        mode: "fresh-files",
        retryFiles,
        reason: `flake-class:${cls}(${retryFiles.length} of ${failedFileCount} files)`,
      };
    }
    return { ...base, retry: true, mode: "whole-workspace", reason: `flake-class:${cls}(broad)` };
  }
  if (failedFileCount <= smallRedFiles) {
    return {
      ...base,
      retry: true,
      mode: "fresh-files",
      retryFiles: files,
      reason: `small-red(${failedFileCount}<=${smallRedFiles})`,
    };
  }
  return {
    ...base,
    retry: false,
    mode: "none",
    reason:
      failedFileCount > maxFiles
        ? `broad-deterministic-red(${failedFileCount}>${maxFiles})`
        : `deterministic-shape(${failedFileCount} file(s), no flake signature)`,
  };
}

/**
 * The single greppable line the runner emits for every retry decision.
 *
 * @param {string} workspace
 * @param {ReturnType<typeof decideRetry>} decision
 */
export function formatRetryDecisionLine(workspace, decision) {
  const tag = decision.retry ? "AFFECTED_RETRY_DECISION" : "AFFECTED_RETRY_SKIPPED";
  return (
    `${tag} ws=${workspace} retry=${decision.retry ? 1 : 0} mode=${decision.mode} ` +
    `failedFiles=${decision.failedFileCount} flakeClasses=${decision.flakeClasses.join(",") || "none"} ` +
    `flakeScope=${decision.flakeScope} flakeFiles=${decision.flakeFiles.length} ` +
    `retryFiles=${decision.retryFiles ? decision.retryFiles.length : 0} reason=${decision.reason}`
  );
}

// ── P-004: the retry BUDGET ──────────────────────────────────────────────────────────────────
//
// A retry used to inherit the first pass's watchdog: the history-derived bound, floored at 45
// minutes and capped at 90. That bound exists to catch a synchronously-spinning worker in a
// FULL suite; a retry is a re-run of something the runner has just measured, so it has a far
// better estimate than the floor — the first pass's own elapsed time and the task's duration
// history. The budget below is derived from those, given headroom, and CAPPED so that a retry
// can never again spend the 34 minutes gate run e70cd139 spent re-running a whole workspace.
//
// Fail-safe direction (the property the retry protects is "a genuine load flake must not hold
// the gate red"): with NO reference at all the budget is the CAP, not the floor — a task of
// unknown duration killed at 60s would turn a flake into a red, which is the wrong error.

/** No retry, however short its reference, gets less than this. */
export const RETRY_BUDGET_FLOOR_MS = 60_000;
/** No retry, however long its reference, gets more than this (e70cd139's retry took 34m). */
export const RETRY_BUDGET_CAP_MS = 20 * 60_000;
/** Headroom over the reference: a re-run under load may legitimately take longer than pass 1. */
export const RETRY_BUDGET_HEADROOM = 2;

const finitePositive = (n) => (Number.isFinite(n) && n > 0 ? Number(n) : null);

/**
 * Derive the time budget for one task's retry.
 *
 * @param {object} o
 * @param {number|null|undefined} o.firstPassElapsedMs   `__elapsedMs` of the failed first pass
 * @param {number|null|undefined} o.durationEstimateMs  `__durationEstimateMs` — the task's history
 * @param {number} [o.floorMs]
 * @param {number} [o.capMs]
 * @param {number} [o.headroomMultiplier]
 * @returns {{
 *   budgetMs: number,
 *   source: 'reference' | 'floor' | 'cap' | 'cap-no-reference',
 *   referenceMs: number | null,
 *   referenceSource: 'history' | 'first-pass' | 'none',
 *   firstPassElapsedMs: number | null,
 *   durationEstimateMs: number | null,
 *   floorMs: number,
 *   capMs: number,
 *   headroomMultiplier: number,
 * }}
 */
export function deriveRetryBudget({
  firstPassElapsedMs,
  durationEstimateMs,
  floorMs = RETRY_BUDGET_FLOOR_MS,
  capMs = RETRY_BUDGET_CAP_MS,
  headroomMultiplier = RETRY_BUDGET_HEADROOM,
}) {
  if (!Number.isFinite(floorMs) || floorMs <= 0) {
    throw new TypeError("floorMs must be a positive finite number");
  }
  if (!Number.isFinite(capMs) || capMs < floorMs) {
    throw new TypeError("capMs must be a finite number greater than or equal to floorMs");
  }
  if (!Number.isFinite(headroomMultiplier) || headroomMultiplier < 1) {
    throw new TypeError("headroomMultiplier must be a finite number greater than or equal to 1");
  }
  const first = finitePositive(firstPassElapsedMs);
  const history = finitePositive(durationEstimateMs);
  const base = {
    firstPassElapsedMs: first,
    durationEstimateMs: history,
    floorMs,
    capMs,
    headroomMultiplier,
  };
  // The LARGER of the two references: history is a peak-aware estimate that already absorbed
  // the task's bimodal runs, and the first pass is what this very box just measured. Taking
  // the smaller would trust whichever of them happened to be optimistic.
  let referenceMs = null;
  let referenceSource = "none";
  if (history != null && (first == null || history >= first)) {
    referenceMs = history;
    referenceSource = "history";
  } else if (first != null) {
    referenceMs = first;
    referenceSource = "first-pass";
  }
  if (referenceMs == null) {
    return { ...base, budgetMs: capMs, source: "cap-no-reference", referenceMs, referenceSource };
  }
  const raw = referenceMs * headroomMultiplier;
  const budgetMs = Math.min(capMs, Math.max(floorMs, raw));
  const source = raw > capMs ? "cap" : raw < floorMs ? "floor" : "reference";
  return { ...base, budgetMs, source, referenceMs, referenceSource };
}

/**
 * The greppable line the runner emits for every retry it actually schedules.
 *
 * @param {string} workspace
 * @param {ReturnType<typeof deriveRetryBudget>} budget
 */
export function formatRetryBudgetLine(workspace, budget) {
  return (
    `AFFECTED_RETRY_BUDGET ws=${workspace} budgetMs=${budget.budgetMs} source=${budget.source} ` +
    `referenceMs=${budget.referenceMs ?? "unknown"} referenceSource=${budget.referenceSource} ` +
    `firstPassMs=${budget.firstPassElapsedMs ?? "unknown"} ` +
    `durationEstimateMs=${budget.durationEstimateMs ?? "unknown"} ` +
    `floorMs=${budget.floorMs} capMs=${budget.capMs}`
  );
}

/**
 * The retry POOL's bracketing lines. Retries used to run one at a time, each through its own
 * single-task scheduler pool that assumed the whole worker budget; they now run through ONE
 * pool under the same allocation model as the initial pass, and these two lines bound the
 * stretch in the log so its wall time is attributable.
 *
 * @param {{ phase: 'start' | 'done' | 'aborted', tasks: number, budgetSumMs?: number,
 *   wallMs?: number, settled?: number, detail?: string }} o
 */
export function formatRetryPoolLine({ phase, tasks, budgetSumMs, wallMs, settled, detail }) {
  const parts = [`AFFECTED_RETRY_POOL phase=${phase} tasks=${tasks}`];
  if (Number.isFinite(budgetSumMs)) parts.push(`budgetSumMs=${Math.round(budgetSumMs)}`);
  if (Number.isFinite(wallMs)) parts.push(`wallMs=${Math.round(wallMs)}`);
  if (Number.isFinite(settled)) parts.push(`settled=${settled}`);
  if (detail) parts.push(`detail=${JSON.stringify(detail)}`);
  return parts.join(" ");
}
