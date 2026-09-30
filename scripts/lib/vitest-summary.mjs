// vitest-summary.mjs — parse vitest's own final summary lines for failed
// counts, independent of the child process's exit code.
//
// EI-18653696921091778 (2026-07-25): a single `npm run test:affected` run
// captured
//   Test Files  2 failed | 3274 passed (3276)
//        Tests  4 failed | 38073 passed (38077)
// from a workspace's vitest child, yet that child process exited 0. Any
// caller that gates purely on the exit code (this script's own per-workspace
// loop, or an agent eyeballing `echo $?`) concludes the tree is clean while
// deterministic reds sit in the printed summary — the exact "silence must
// never look like green" footgun this repo's other gates (e.g.
// live-federation-gate.sh's staleness check) already guard against
// elsewhere. `parseSummaryFailedCounts` gives a second, independent signal
// straight from vitest's own reported totals so a mismatch can be caught
// instead of silently trusted.
//
// Deliberately tolerant of vitest reporter formatting drift: matches on the
// stable `Test Files` / `Tests` row labels + a leading failed count, not the
// full line shape (passed/skipped counts, parenthesized totals vary by vitest
// version and TTY-vs-pipe).
//
// ⚠ EI-18819483316574031 (2026-07-27): colour is NOT handled by tolerant matching —
// it must be STRIPPED, and this file's original comment wrongly claimed "color codes
// ... vary" as something the regexes absorbed. They cannot: every matcher here is
// line-anchored (`^\s*`) and vitest emits SGR codes AROUND both the row label and the
// count, so the real gate line
//     \x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m...
// starts with ESC (not \s) and puts escapes between `Test Files` and `1`. Both anchors
// miss, parseSummaryFailedCounts returned null, and the exit-code/summary cross-check
// that exists *specifically* to stop a red suite reading as green never fired — the
// green pin advanced over a deterministic operator-vite failure and auto-deployed.
// The identical bug had ALREADY been found and fixed in green-checkpoint.ts's
// parseFailingFilesByWorkspace (which strips first, and says so); the fix was simply
// never propagated to these sibling parsers, even though that function's own header
// says it "mirrors parseFailedFiles's file regexes ... so the two stay in sync".
// Strip first, then match. Do not re-introduce a "tolerant regex" that skips this.
/**
 * @param {string} text
 * @returns {string}
 */
export function stripVitestAnsi(text) {
  // eslint-disable-next-line no-control-regex -- SGR codes are the thing being removed.
  return String(text).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * The path shape of a vitest test file, as a regex SOURCE FRAGMENT rather than a RegExp.
 *
 * Exported as a string because its two consumers embed it in different line-anchored
 * matchers: this module scans whole outputs with `matchAll` (`gm`), while
 * green-checkpoint.ts's `parseFailingFilesByWorkspace` walks line-by-line with `exec`
 * (no flags) because it must track the enclosing `>>> <workspace>` header. A shared
 * RegExp could not serve both; a shared fragment can.
 */
export const VITEST_TEST_FILE_SOURCE = String.raw`\S+\.(?:test|spec)\.[cm]?[jt]sx?`;

/**
 * ` ❯ lib/x/y.test.ts (22 tests | 1 failed) 85ms` — vitest's per-file ROLLUP row.
 *
 * The load-bearing matcher of the two: vitest prints only the first few `FAIL` rows but
 * emits a rollup for EVERY failing file, so this is what names a large red run in full.
 *
 * A FACTORY rather than a shared `RegExp` const, deliberately: a `g`-flagged RegExp
 * carries mutable `lastIndex`, so a single module-level instance shared across callers
 * silently resumes mid-string on its second use. That failure is state-dependent and
 * order-dependent — exactly the kind that survives a test suite and reappears in the
 * gate. Each caller gets a fresh object.
 *
 * @param {string} [flags] RegExp flags — `'gm'` to scan a whole output, `''` per line.
 * @returns {RegExp}
 */
export function vitestSummaryFailRow(flags = '') {
  return new RegExp(String.raw`^\s*❯\s+(${VITEST_TEST_FILE_SOURCE})\s+\([^)]*\bfailed\b[^)]*\)`, flags);
}

/**
 * `FAIL  lib/x/y.test.ts …` — a failed-SUITE row (transform/setup errors).
 *
 * Distinct from the rollup above and not redundant with it: a file that fails to
 * transform or whose setup throws never reaches the rollup, so this is the only row
 * that names it. See `vitestSummaryFailRow` for why this is a factory.
 *
 * @param {string} [flags] RegExp flags — `'gm'` to scan a whole output, `''` per line.
 * @returns {RegExp}
 */
export function vitestSuiteFailRow(flags = '') {
  return new RegExp(String.raw`^\s*FAIL\s+(${VITEST_TEST_FILE_SOURCE})\b`, flags);
}

export function parseSummaryFailedCounts(text) {
  if (!text) return null;
  const plain = stripVitestAnsi(text);
  const filesMatch = plain.match(/^\s*Test Files\s+(\d+)\s+failed\b/m);
  const testsMatch = plain.match(/^\s*Tests\s+(\d+)\s+failed\b/m);
  if (!filesMatch && !testsMatch) return null;
  return {
    testFiles: filesMatch ? Number(filesMatch[1]) : 0,
    tests: testsMatch ? Number(testsMatch[1]) : 0,
  };
}

/**
 * How many tests actually EXECUTED, read from vitest's `Tests` summary row. Skipped is not
 * executed — that distinction IS the bug: `Tests  20 skipped (20)` is a run that measured nothing.
 *
 * Returns null when there is no readable summary row (e.g. `--reporter=json`), which the caller
 * must treat as UNVERIFIED rather than as a measured zero: fabricating a red on an unreadable
 * count is the opposite, equally expensive mistake.
 *
 * ANSI is stripped FIRST. vitest colourises this row, and EI-18819483316574031 is the same
 * trap's previous instance — a matcher that skipped the strip passed every hand-written test and
 * never once fired on real coloured output.
 *
 * ⚠ MOVED HERE from `scripts/test-files.mjs` (P-006 / R-8 sub-req 5) and re-exported there, the
 * same single-writer consolidation WI-37607 applied to `parseTransformFailure`. It moved because
 * it gained a SECOND consumer: `scripts/affected-tests.mjs`, the path the release promise runs
 * on, which already imports every other vitest parser from this seam precisely so they are not
 * "three hand-kept-in-sync copies". A private copy for the gate would reintroduce exactly that.
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {number | null} tests executed, or null when unreadable
 */
export function testsExecutedFrom(output) {
  const plain = stripVitestAnsi(output ?? '');
  // `Test Files` cannot match: it is `Test` + space, never `Tests` + whitespace. Take the LAST
  // row so appended output can never leave us reading a superseded summary.
  const rows = [...plain.matchAll(/^[ \t]*Tests[ \t]+(.*)$/gm)];
  if (rows.length === 0) return null;
  const body = rows[rows.length - 1][1];
  if (/^\s*no tests\b/i.test(body)) return 0;
  let ran = null;
  for (const seg of body.matchAll(/(\d+)\s+(passed|failed)\b/g)) {
    ran = (ran ?? 0) + Number(seg[1]);
  }
  if (ran !== null) return ran;
  // Only skipped/todo segments — collected, deliberately not run.
  if (/\d+\s+(skipped|todo)\b/.test(body)) return 0;
  return null;
}

/**
 * EI-19380376466745152 — A SKIPPED ASSERTION IS AN ABSENT MEASUREMENT WEARING A PASS.
 *
 * The measured incident: an agent fixed a real regression, ran the owning file, read
 * `Tests  8 passed | 1 skipped (9)` plus `Test Files  1 passed (1)`, exit 0, and filed that as
 * proof. A peer had landed `it.skip` on THE EXACT ASSERTION being fixed six minutes earlier. The
 * eight passes were siblings that were already green before the fix existed; the fix was never
 * once exercised by the thing cited as evidence for it.
 *
 * Every signal in that run reads as success — file-level `1 passed`, exit 0, a skip count that is
 * one token in a line whose expected shape is a pass, and a clean `git status`. This is the same
 * class as `-p .` typechecking zero files and reading as clean: a verification whose SUBJECT was
 * silently absent.
 *
 * Three-state like its executed-counting sibling: `null` is UNREADABLE, never a measured zero.
 * See `testsExecutedFrom` for why both now live at this seam rather than in the focused router.
 *
 * @param {string} output combined stdout+stderr of a `vitest run` invocation
 * @returns {number | null} tests collected-but-not-run, or null when unreadable
 */
export function testsSkippedFrom(output) {
  const plain = stripVitestAnsi(output ?? '');
  const rows = [...plain.matchAll(/^[ \t]*Tests[ \t]+(.*)$/gm)];
  if (rows.length === 0) return null;
  const body = rows[rows.length - 1][1];
  if (/^\s*no tests\b/i.test(body)) return 0;
  let skipped = null;
  for (const seg of body.matchAll(/(\d+)\s+(skipped|todo)\b/g)) {
    skipped = (skipped ?? 0) + Number(seg[1]);
  }
  if (skipped !== null) return skipped;
  // A row carrying only passed/failed segments genuinely skipped nothing — vitest omits a
  // zero-valued segment rather than printing `0 skipped`. That is a MEASURED zero, not an
  // unreadable row, and reporting it as unreadable would make the common case permanently mute.
  if (/\d+\s+(passed|failed)\b/.test(body)) return 0;
  return null;
}

/**
 * P-006 / R-8 sub-requirement 5 — "retain full final coverage where the release promise needs it".
 *
 * `scripts/test-files.mjs`, the CHEAP diagnostic path, has treated a collected-but-unexecuted
 * test as an absent measurement since EI-19380376466745152: it stamps `skippedTests=N` on every
 * `TEST_FILE_RESULT` and refuses a zero-executed run outright. `scripts/affected-tests.mjs` — the
 * path whose verdict fast-forwards `main` and triggers the deploy — had none of it. Measured
 * 2026-09-11 on a genuinely executing run:
 *
 *     AFFECTED_TESTS_RESULT status=passed tasks=4 failed=0 quarantinedFailed=0 \
 *         timedOutTasks=0 undeterminedTasks=0
 *
 * Nothing there separates four tasks of real green from four that collected their tests and ran
 * none. The count was never missing from the DATA — vitest prints it in every task's own output,
 * and the gate's only numeric parser (`parseSummaryFailedCounts`) read `N failed` and dropped the
 * rest. This tally is the discarded half, kept.
 *
 * THREE-STATE ON PURPOSE. Most gate tasks are not vitest (lint legs, repo-wide invariant guards),
 * so their test counts are genuinely unreadable. Folding those into a measured `0` would be the
 * same defect one level up — a bounded measurement rendered as a confident number — so they are
 * counted separately and never summed into the totals.
 *
 * @returns {{ executed: number, skipped: number, unreadableTasks: number,
 *             notExecuted: { task: string, skipped: number }[] }}
 */
export function emptyCoverage() {
  return { executed: 0, skipped: 0, unreadableTasks: 0, notExecuted: [] };
}

/**
 * Fold one settled task's captured output into a running coverage tally.
 *
 * Pure and copy-on-write so a caller can fold at task settlement without ordering hazards; the
 * run loop's counters are module-level `let`s and a shared mutable tally beside them would be one
 * more thing an abort path could report half-updated.
 *
 * @param {ReturnType<typeof emptyCoverage>} coverage
 * @param {{ task: string, output: string }} settled
 * @returns {ReturnType<typeof emptyCoverage>}
 */
export function foldTaskCoverage(coverage, settled) {
  const base = coverage ?? emptyCoverage();
  const output = settled?.output ?? '';
  const executed = testsExecutedFrom(output);
  const skipped = testsSkippedFrom(output);
  // Unreadable means exactly that: not vitest, or a machine reporter. Never a zero.
  if (executed === null && skipped === null) {
    return { ...base, unreadableTasks: base.unreadableTasks + 1, notExecuted: [...base.notExecuted] };
  }
  const ran = executed ?? 0;
  const notRun = skipped ?? 0;
  const next = {
    executed: base.executed + ran,
    skipped: base.skipped + notRun,
    unreadableTasks: base.unreadableTasks,
    notExecuted: [...base.notExecuted],
  };
  // A COUNT alone would not be enough — the focused path learned that at the cost of the incident
  // above: what is missing is WHICH task went unmeasured. Named only when the task was readable
  // AND executed nothing, so an unreadable lint leg can never be reported as an unmeasured suite.
  if (ran === 0 && notRun > 0) next.notExecuted.push({ task: settled?.task ?? '(unnamed task)', skipped: notRun });
  return next;
}

/**
 * The coverage fields appended to the terminal `AFFECTED_TESTS_RESULT` line.
 *
 * APPEND-ONLY, and that is the compatibility contract: `green-checkpoint.ts` matches the marker
 * line whole (`SUITE_REFUSAL_LINE_RE`) and every reader tokenises `k=v`, so new trailing fields
 * reach existing parsers inert. Placed on the terminal marker for the reason this contract
 * already learned twice (EI-19462803905923939 / EI-19467022057492490): that line is the last
 * thing a `| tail -N` reads and the one line agents actually paste as evidence. A banner printed
 * only at the top scrolls out of exactly the excerpt that gets quoted.
 *
 * @param {ReturnType<typeof emptyCoverage>} coverage
 * @returns {string}
 */
export function formatCoverageFields(coverage) {
  const c = coverage ?? emptyCoverage();
  return `testsExecuted=${c.executed} testsSkipped=${c.skipped} coverageUnreadableTasks=${c.unreadableTasks}`;
}

export const AFFECTED_TESTS_NOT_EXECUTED_TOKEN = 'AFFECTED_TESTS_NOT_EXECUTED';

/**
 * The greppable disclosure naming each task that collected tests and executed none of them.
 *
 * NON-GATING, and it says so on its own line. `affected-tests.mjs` already owns the precedent in
 * `notCheckedNonGating`: a guard that declared up front that "I could not look" is its expected
 * answer is "counted and reported LOUDLY — missing coverage must stay visible — but NOT gating",
 * because folding a non-verdict into a gating counter red-pinned candidate 57483d0491 for the
 * whole fleet. Coverage that was not obtained is the same class of fact, and a gate that froze
 * `main` the first time a workspace's suite was legitimately env-gated off would be a worse
 * defect than the silence it replaced.
 *
 * @param {ReturnType<typeof emptyCoverage>} coverage
 * @returns {string} '' when every readable task executed something
 */
export function formatNotExecutedSummary(coverage) {
  const entries = coverage?.notExecuted ?? [];
  if (entries.length === 0) return '';
  const lines = [
    `${AFFECTED_TESTS_NOT_EXECUTED_TOKEN} tasks=${entries.length} (not gating — these tasks ` +
      'COLLECTED tests and executed none, so this run is not evidence about them)',
  ];
  for (const e of entries) lines.push(`  - ${e.task} (${e.skipped} collected, 0 executed)`);
  return lines.join('\n');
}

/**
 * The FAILING TEST FILES named by a vitest run's own output.
 *
 * Moved here from affected-tests.mjs (EI-18819483316574031) so that the three parsers
 * reading vitest output — this one, {@link parseSummaryFailedCounts}, and
 * green-checkpoint.ts's parseFailingFilesByWorkspace — share ONE ANSI-stripping seam
 * instead of three hand-kept-in-sync copies. Keeping them as independent copies is
 * exactly how green-checkpoint.ts got the strip and these did not.
 *
 * Returns [] (never null) so callers can length-check without a guard.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseFailedTestFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  for (const m of plain.matchAll(vitestSummaryFailRow('gm'))) files.add(m[1]);
  for (const m of plain.matchAll(vitestSuiteFailRow('gm'))) files.add(m[1]);
  return [...files];
}

/**
 * The FAILING TEST FILES named by a `node --test` run's own output.
 *
 * A SECOND runner format, deliberately NOT folded into {@link parseFailedTestFiles}
 * (EI-20095409199430877). Node's built-in runner ends a red run with a `✖ failing tests:`
 * block whose every entry is a `test at <file>:<line>:<col>` line — a shape matching
 * NEITHER vitest matcher. So before this existed, every failure in a `node --test`
 * workspace was reported as `no-file-rows`, the reason whose documented causes are "a
 * worker crash, an OOM, a spawn error". That sends a triager hunting infrastructure while
 * the truth is a named assertion in a named file, printed in plain text a few lines up.
 *
 * Measured on run 3655179-735cdb19: `@papercusp/desktop :: test` was reported
 * `unattributed / no-file-rows` while its own captured output read
 * `test at test/build-desktop-sidecar-lock.test.js:11:1`. `@papercusp/desktop` alone runs
 * ~20 test files this way, so the blind spot covered every one of them.
 *
 * ⚠ WHY SEPARATE, and do not "simplify" this by merging the two: `parseFailedTestFiles`'s
 * result is ALSO fed back as re-run ARGUMENTS (`run(failedFiles)` in affected-tests.mjs),
 * which is a vitest calling convention. `@papercusp/desktop`'s `test` script is a chain of
 * `npm run` sub-steps, so appending file paths to it would not re-run those files — it
 * would silently re-run something else. ATTRIBUTION (what broke) and RE-RUN (how to run it
 * again) are different questions; only the first is answered here.
 *
 * Matched from REAL EMITTED BYTES (node v22), never from a quoted log: a mixed pass/fail
 * run prints `test at` for the failing tests ONLY, so the line is failure-exclusive. The
 * path it carries is workspace-relative — the same shape vitest's rollup rows yield, so
 * callers need no normalisation.
 *
 * ⚠ The path deliberately does NOT reuse {@link VITEST_TEST_FILE_SOURCE}, and that is the
 * load-bearing decision here. That pattern demands a literal `.test.`/`.spec.` SEGMENT, but
 * `@papercusp/cli` names its suites `src/**` + `/*.node-test.ts` — `-test`, not `.test`. The
 * first draft of this function DID pin the vitest convention, and it silently reproduced the
 * exact bug it exists to fix for one of the three workspaces in scope: measured, it returned
 * [] for a real cli-shaped failure while the conventional `.test.js` worked. That is what a
 * naming-convention assumption always looks like — correct on the case you sampled, empty on
 * the one you did not, and an empty result here reads as "nothing failed", never as "my
 * matcher is wrong".
 *
 * `test at ` plus a trailing `:line:col` is already a tight, failure-exclusive anchor, so the
 * path only has to look like a JS/TS-family source file. A file-NAMING convention is not a
 * property of the runner's output; the anchor is. Guard the anchor, not the fashion.
 *
 * @param {string} text
 * @returns {string[]} workspace-relative paths, deduped; [] when none
 */
export function parseNodeTestFailedFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // A fresh regex per call: a shared /g literal carries `lastIndex` state, and while
  // `matchAll` happens to clone its argument, relying on that is a footgun for the next
  // editor who reaches for `.exec()` on the same constant.
  const re = /^\s*test at\s+(\S+\.[cm]?[jt]sx?):\d+:\d+\s*$/gm;
  for (const m of plain.matchAll(re)) files.add(m[1]);
  return [...files];
}

/**
 * The workspace-relative DIRECTORY that `papercusp-desktop/bin/lib/run-selftests.sh` runs
 * its selftests out of — i.e. its own `$DIR`, which it never prints.
 *
 * Exported rather than inlined because it is the one piece of {@link parseBashSelftestFailedFiles}
 * that is a COUPLING to a specific harness rather than a property of the output: the marker line
 * carries a bare basename, so turning it into a locatable path requires knowing where that harness
 * lives. If a second workspace ever adopts this harness, this constant is the thing that has to
 * become per-workspace — one named place to look, instead of a literal buried in a regex.
 */
export const DESKTOP_SELFTEST_DIR_REL = 'bin/lib';

/**
 * The FAILING SELFTESTS named by `papercusp-desktop/bin/lib/run-selftests.sh`'s output.
 *
 * A THIRD runner format (EI-20098997113620795), and the one that completes the workspace the
 * original attribution bug was found in. `@papercusp/desktop`'s `test` script is a chain —
 * `npm run test:config && npm run test:shell && npm run test:selftests` — whose three legs use
 * three DIFFERENT runners: `node --test` twice, then this bash harness. Teaching the attributor
 * node's format (EI-20095409199430877) therefore fixed two thirds of one task: a failure in the
 * selftest leg still produced no file rows and still reported `no-file-rows`, whose documented
 * causes are "a worker crash, an OOM, a spawn error". Same misleading infra diagnosis, same
 * workspace, one leg over.
 *
 * ⚠ Matched from REAL EMITTED BYTES, generated by running the UNMODIFIED harness (its `$DIR`
 * comes from `BASH_SOURCE`, so a copy in a scratch dir with stub selftests exercises the real
 * emitter) and read back through `cat -A`:
 *     `--- roster-scope.selftest.sh: FAIL$`
 * No ANSI, no trailing whitespace, one line per failing selftest. Two deliberate failures in the
 * probe produced two lines, confirming this is per-test and not a summary.
 *
 * The harness ALSO prints a roll-up (`FAIL — 2/17 … failed: a.selftest.sh b.selftest.sh`), which
 * is deliberately NOT matched: it would double-count every entry, and its em-dash and count fields
 * are far more formatting-volatile than the per-test line. The per-test marker is the stable anchor.
 *
 * ⚠ Its sibling DRIFT failures (`FAIL — N *.selftest.sh file(s) exist on disk but are NOT in the
 * TESTS array…`) are correctly NOT matched either: those name no failing test, they report that the
 * array and the disk disagree. Attributing them to a file would invent a culprit.
 *
 * @param {string} text
 * @returns {string[]} workspace-relative paths, deduped; [] when none
 */
export function parseBashSelftestFailedFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // Fresh per call — see parseNodeTestFailedFiles for why a shared /g literal is a footgun here.
  const re = /^\s*---\s+(\S+\.selftest\.sh):\s*FAIL\s*$/gm;
  for (const m of plain.matchAll(re)) files.add(`${DESKTOP_SELFTEST_DIR_REL}/${m[1]}`);
  return [...files];
}

/**
 * The FILES named by a failing `astro check` run (EI-20102376842495928).
 *
 * A FOURTH runner class, and the one that shows why "not a test runner" was never the same
 * thing as "unattributable". `astro check` is a typechecker: it reports DIAGNOSTICS rather
 * than failing test files — but diagnostics are file-anchored, so it names its culprits
 * perfectly well. Two tasks ride on it (`@papercupai/operator-docs :: test` and
 * `@papercupai/papercusp-docs :: test`, both literally `astro check`), and a red in either
 * used to land in `no-file-rows`, whose documented causes are "a worker crash, an OOM, a
 * spawn error" — an infra diagnosis for what is really a type error on a known line.
 *
 * ⚠ Matched from REAL EMITTED BYTES, not from quoted output. Generated by copying the
 * operator-docs app to a scratch dir (node_modules symlinked, so the real astro 6.3.6 CLI
 * runs), planting a two-error .astro file, and reading the result back through `cat -A`:
 *     `^[[96msrc/pages/x.astro^[[0m:^[[93m3^[[0m:^[[93m7^[[0m - ^[[91merror^[[0m^[[90m ts(2322): ^[[0mType …$`
 *
 * That capture is load-bearing twice over:
 *   1. **astro colors even when NOT a TTY** — the bytes above came from a plain
 *      `> file 2>&1` redirect. So a matcher written against the RENDERED text silently
 *      matches nothing: `grep 'error ts('` over that log returns ZERO. This is the third
 *      time this exact class has bitten this module (the esbuild trailing colon; node's
 *      `test at` anchor), which is why {@link stripVitestAnsi} runs FIRST here too.
 *   2. The severity token is the whole discriminator, and it is failure-exclusive:
 *      measured on that run, ` - error ` matched the 2 real errors and NONE of the 23
 *      warnings/hints (` - warning ts(6385)` etc). A run with only warnings exits 0 and
 *      attributes nothing, which is correct.
 *
 * ⚠ The path is deliberately `\S+` with NO extension whitelist. astro check reports on
 * .astro, .ts, .md, .mdx and whatever a future integration adds; pinning an extension list
 * is exactly the naming-convention assumption that made parseNodeTestFailedFiles return []
 * for `@papercusp/cli`. Guard the anchor (`:line:col - error`), not the fashion.
 *
 * Paths are emitted relative to the astro project root, which IS the workspace dir — the
 * same shape vitest's rollup rows yield, so callers need no normalisation.
 *
 * @param {string} text
 * @returns {string[]} workspace-relative paths, deduped; [] when none
 */
export function parseAstroCheckFailedFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // Fresh per call — see parseNodeTestFailedFiles for why a shared /g literal is a footgun here.
  const re = /^(\S+):\d+:\d+ - error\b/gm;
  for (const m of plain.matchAll(re)) files.add(m[1]);
  return [...files];
}

/** The token that opens a PER-FILE declaration line emitted by a task's own harness.
 *
 *  Distinct from {@link AFFECTED_TESTS_FAILING_FILES_TOKEN}, which is the run-level SUMMARY
 *  line `scripts/affected-tests.mjs` prints once at the end. This one is emitted by an
 *  individual task, once per culprit file, and is the input the summary is built FROM. */
export const DECLARED_FAILING_FILE_TOKEN = 'DECLARED_FAILING_FILE';

/**
 * Render the declaration line(s) a bespoke harness prints to name its own culprit files.
 *
 * WHY AN EMITTER LIVES BESIDE THE PARSER. Every other parser in this module reverse-engineers
 * a format owned by somebody else (vitest, node, astro), so drift is detected only by a
 * fixture. This format is OURS on both ends, and the one thing that could still break it is
 * a harness hand-typing the token and a later edit changing only one side. Sharing the
 * constant makes that impossible: `test-runner-classes.mjs` requires a declaring script to
 * import THIS function, so the emitter and the matcher cannot come apart.
 *
 * ⚠ WHEN A HARNESS MAY CALL THIS — the bar is deliberately high, because the failure this
 * whole subsystem exists to stop is a CONFIDENT WRONG ANSWER, and a fabricated declaration is
 * exactly that. A path here must be the file a triager should OPEN to fix the failure. It is
 * NOT for naming the harness itself: `@papercusp/web :: test:el-suite` asserts on the replies
 * of a live remote agent, so its only nameable path would be its own source — which reads as
 * a confident attribution while pointing at the one file that is definitely not broken. That
 * task therefore stays declared-unattributable, and `no-file-rows` is the honest answer for
 * it. Silence beats a plausible wrong name.
 *
 * Paths are WORKSPACE-RELATIVE, matching every other parser here, so callers need no
 * normalisation. A culprit outside the workspace is written with `../` segments rather than
 * from the repo root: the summary renders entries as `<workspace> :: <file>`, so a root-
 * relative path would silently resolve against the wrong base for a reader.
 *
 * @param {string[]} paths workspace-relative paths; empty/blank entries are dropped
 * @returns {string[]} lines to print, one per path (empty when there is nothing to declare)
 */
export function formatDeclaredFailingFileLines(paths) {
  const seen = new Set();
  for (const p of paths ?? []) {
    const clean = String(p ?? '').trim();
    // A path with whitespace cannot survive the line format, whose parser anchors on `\S+`.
    // Dropping it loudly-in-code beats emitting a line that silently parses to a prefix.
    if (!clean || /\s/.test(clean)) continue;
    seen.add(clean);
  }
  return [...seen].map((p) => `${DECLARED_FAILING_FILE_TOKEN} ${p}`);
}

/**
 * The files a task DECLARED as its own culprits, via {@link formatDeclaredFailingFileLines}.
 *
 * EI-20102376842495928. The other parsers in this union all read a format the runner already
 * emits. For a bespoke `node scripts/*.mjs` harness there is no such format to read, and —
 * the point the classifier makes in its own header — the command string cannot reveal what
 * runs inside, so no parser is derivable from it either. Inverting it is the only sound fix:
 * the harness declares, and attribution reads the declaration.
 *
 * ⚠ Strip ANSI FIRST. Our own emitter writes plain bytes, so this looks unnecessary — it is
 * not. The line travels through whatever the harness's surrounding output does, and this
 * module has been bitten three times by matching rendered text (EI-18819483316574031; the
 * esbuild colon; astro, which colours even when piped to a file). A stripped match costs
 * nothing and removes a whole class of silent-empty result.
 *
 * @param {string} text
 * @returns {string[]} workspace-relative paths, deduped; [] when none
 */
export function parseDeclaredFailingFiles(text) {
  if (!text) return [];
  const plain = stripVitestAnsi(text);
  const files = new Set();
  // Fresh per call — see parseNodeTestFailedFiles for why a shared /g literal is a footgun.
  // Anchored at line start so the token quoted mid-sentence in prose (this docstring, a
  // triage note, an error message about the format) cannot be mistaken for a declaration.
  const re = new RegExp(String.raw`^${DECLARED_FAILING_FILE_TOKEN} (\S+)\s*$`, 'gm');
  for (const m of plain.matchAll(re)) files.add(m[1]);
  return [...files];
}

/**
 * The esbuild TRANSFORM (parse) failures named in a run's own output.
 *
 * MOVED HERE from scripts/test-files.mjs (WI-37607) so the two runners share ONE detector
 * rather than one runner having it and the other not — the same consolidation this module's
 * header already argues for, and the exact gap that made this move necessary: `test:file`
 * has told callers `cause=transform` since EI-19462803905923939, while `test:affected` — the
 * runner CLAUDE.md's "Tests after editing" actually prescribes — had no detection at all.
 * test-files.mjs re-exports it, so its own callers and tests are unchanged.
 *
 * ⚠ Strip ANSI FIRST (EI-18819483316574031). Every matcher here is line-anchored and vitest
 * emits SGR codes around the payload; a sibling detector in this very file was dead in
 * production for weeks because it matched only on clean text.
 *
 * @param {string} output combined stdout+stderr of a vitest invocation
 * @returns {{ file: string, line: number, col: number, message: string }[]} empty when none
 */
export function parseTransformFailure(output) {
  const plain = stripVitestAnsi(output ?? '');
  if (!/Transform failed with \d+ error/.test(plain)) return [];
  const locations = [];
  const seen = new Set();
  // esbuild prints `<path>:<line>:<col>: ERROR: <message>`. Its sibling `File: <path>:<line>:<col>`
  // line carries no `ERROR:` and is deliberately NOT matched — it would double-count every entry.
  const re = /^\s*(\S[^\n]*?):(\d+):(\d+):\s*ERROR:\s*(.+?)\s*$/gm;
  let match;
  while ((match = re.exec(plain)) !== null) {
    const key = `${match[1]}:${match[2]}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push({ file: match[1], line: Number(match[2]), col: Number(match[3]), message: match[4] });
  }
  return locations;
}

/**
 * The distinct CULPRIT MODULES of a run's parse failures — deduped, one entry per file
 * regardless of how many times esbuild reprinted it (it reprints per importing worker, so a
 * single broken module yields dozens of identical locations in a real log).
 *
 * @param {string} output combined stdout+stderr of a vitest invocation
 * @returns {string[]} `path:line:col` strings, deduped, in first-seen order
 */
export function transformCulpritsFrom(output) {
  const seen = new Set();
  for (const loc of parseTransformFailure(output)) seen.add(`${loc.file}:${loc.line}:${loc.col}`);
  return [...seen];
}

/** The greppable token that opens the per-FILE break-set line. Exported so a consumer
 *  greps a shared constant instead of a hand-typed copy that can drift from the emitter. */
export const AFFECTED_TESTS_FAILING_FILES_TOKEN = 'AFFECTED_TESTS_FAILING_FILES';

/** Beyond this many entries the JSON payload is truncated and says so. A break set this
 *  large is a tree-wide event, not a triage list; the counts stay exact either way. */
export const FAILING_FILES_LINE_MAX_ENTRIES = 400;

/**
 * Render the canonical, machine-readable per-FILE break set for a run's final summary.
 *
 * EI-19395701908500754: `AFFECTED_TESTS_RESULT ... failed=N` counts TASKS (workspaces),
 * so the per-FILE set — the thing a triager actually needs — existed nowhere in the
 * verdict log. Agents therefore MINED PROSE for it, and the prose they reached for was
 * the gate's own `[green-checkpoint] isolation: re-running <files>` narration. That
 * narration is emitted by green-checkpoint's self-tests too, so a `grep 'isolation:'`
 * returned FIXTURE paths (`lib/a.test.ts`, candidate `abc123`) with nothing marking them
 * synthetic. Measured on the 01:36:17Z red: the mined set was 2 phantom files; the real
 * one was 11 real files spanning BOTH failing workspaces. The tagging fix (WI-7274) marks
 * the fixture lines; this removes the reason to read them at all.
 *
 * ⚠ COMPLETENESS IS REPORTED SEPARATELY FROM SCOPE, and that is the whole point of the
 * shape. An empty `files=[]` is ambiguous in the direction that costs the most — it reads
 * as "nothing failed" when it can equally mean "we could not attribute what failed" (a
 * TTY run with no captured child output; a crash/OOM that printed no FAIL rows; a
 * non-vitest task like cargo). So a failed task whose files cannot be named is carried
 * EXPLICITLY in `unattributed`, and `coverage` can never read `complete` while any such
 * task exists. `coverage=unattributed` means "tasks failed and NONE of them could be
 * attributed" — the case a bare empty array would have silently mis-reported as clean.
 *
 * ⚠⚠ `transformCulprits` is a THIRD, ORTHOGONAL axis — deliberately not folded into `coverage`
 * (WI-37607). `coverage` answers "were the failed tasks attributed to files"; it does NOT answer
 * "are the listed files actually broken", and on a parse failure those two come apart completely:
 * measured 2026-08-09, a single unparseable module produced `coverage=complete fileCount=21
 * unattributedCount=0` where all 21 were casualties of a peer's mid-write. Adding a 5th `coverage`
 * value was rejected because green-checkpoint and CLAUDE.md both consume the documented four, and
 * silently changing what `complete` means is the same class of error as the one being fixed.
 *
 * There is deliberately NO `cause=` field here. A parse failure being PRESENT is provable from the
 * output; its being the SOLE cause of every listed file is not — and inventing a confident cause
 * taxonomy is precisely how a well-formed line came to overstate what it knew.
 *
 * @param {{
 *   runToken: string,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unattributed?: Array<{ task: string, reason: string }>,
 *   transformCulprits?: string[],
 *   attributionFallbacks?: Array<{ task: string, source: string }>,
 * }} args
 * @returns {string}
 */
export function formatFailingFilesLine({
  runToken,
  entries = [],
  unattributed = [],
  transformCulprits = [],
  attributionFallbacks = [],
}) {
  const files = [...entries];
  const unattr = [...unattributed];
  const culprits = [...new Set(transformCulprits)];
  const fallbacks = [...attributionFallbacks];
  const coverage =
    files.length === 0 && unattr.length === 0
      ? 'none'
      : unattr.length === 0
        ? 'complete'
        : files.length === 0
          ? 'unattributed'
          : 'partial';
  const truncated = files.length > FAILING_FILES_LINE_MAX_ENTRIES;
  const shown = truncated ? files.slice(0, FAILING_FILES_LINE_MAX_ENTRIES) : files;
  return (
    `${AFFECTED_TESTS_FAILING_FILES_TOKEN} run=${runToken} coverage=${coverage} ` +
    `fileCount=${files.length} unattributedCount=${unattr.length} truncated=${truncated} ` +
    `transformCulpritCount=${culprits.length} ` +
    `files=${JSON.stringify(shown)} unattributed=${JSON.stringify(unattr)} ` +
    `transformCulprits=${JSON.stringify(culprits)}` +
    (fallbacks.length > 0
      ? ` attributionFallbackCount=${fallbacks.length} attributionFallbacks=${JSON.stringify(fallbacks)}`
      : '')
  );
}

/** The greppable token that opens the per-FILE SELECTION line — which test files a run
 *  actually executed. Exported so a consumer greps a shared constant rather than a
 *  hand-typed copy that can drift from the emitter. */
export const AFFECTED_TESTS_SELECTED_FILES_TOKEN = 'AFFECTED_TESTS_SELECTED_FILES';

/** Beyond this many entries the JSON payload is truncated and says so. Mirrors
 *  {@link FAILING_FILES_LINE_MAX_ENTRIES}; the counts stay exact either way. */
export const SELECTED_FILES_LINE_MAX_ENTRIES = 400;

/**
 * Render the canonical, machine-readable per-FILE SELECTION set for a run's summary.
 *
 * EI-19416573016968871: the verdict log named the files that FAILED but never the files
 * that RAN, so "no FAIL row for X" was indistinguishable from "X never ran" — and because
 * `test:affected` only runs the workspaces the changed paths map into, the second case is
 * common. The absence reads as a POSITIVE observation, so agents used it to DATE
 * regressions: "the 05:48Z verdict didn't list this test; loop.ts changed 05:51Z; the
 * 07:05Z verdict does" — a clean, plausible, wrong causal story. Measured 2026-08-03 on
 * deliver-and-wake.test.ts: two agents independently reached the same false "brand-new
 * break" reading within the hour, one of them actively chasing an innocent commit. The
 * real explanation was that ~1162 files changed in the window, pulling the file into the
 * affected set for the FIRST time — so the break may have been far older.
 *
 * ⚠ COVERAGE IS THE POINT, not decoration — and it is the same lesson as
 * {@link formatFailingFilesLine}'s, pointed the other way. There, an empty `files=[]`
 * could mean "nothing failed" OR "we could not attribute what failed". Here, an empty or
 * short list could mean "these are the only files that ran" OR "we cannot enumerate what
 * ran at all", and only the FIRST licenses the inference `absent ⇒ did not run`. Shipping
 * this line without the axis would reproduce, at one remove, the exact bug it exists to
 * kill. So:
 *
 *   - `complete`     — every executed task's file set is enumerated. ONLY this value
 *                      licenses "X is absent from `files`, therefore X did not run".
 *   - `partial`      — some tasks enumerated, others not. The list is a LOWER BOUND:
 *                      absence proves nothing.
 *   - `unenumerated` — tasks ran and NONE could be enumerated (a wide run, or one whose
 *                      narrowing failed). The line asserts only that the run happened.
 *   - `none`         — nothing ran at all.
 *
 * A task is `unenumerated` when its selection is not a positional file list: a wide
 * (non-`--related`) run, a run whose narrowing failed open, and the deliberately
 * non-narrowable lanes (integration, el-suite, the invariant guards) each mean something
 * by "run" that a file list would misdescribe. Naming those tasks explicitly — rather
 * than omitting them — is what keeps `complete` honest.
 *
 * @param {{
 *   runToken: string,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unenumerated?: Array<{ task: string, reason: string }>,
 * }} args
 * @returns {string}
 */
export function formatSelectedFilesLine({ runToken, entries = [], unenumerated = [] }) {
  const files = [...entries];
  const unenum = [...unenumerated];
  const coverage =
    files.length === 0 && unenum.length === 0
      ? 'none'
      : unenum.length === 0
        ? 'complete'
        : files.length === 0
          ? 'unenumerated'
          : 'partial';
  const truncated = files.length > SELECTED_FILES_LINE_MAX_ENTRIES;
  const shown = truncated ? files.slice(0, SELECTED_FILES_LINE_MAX_ENTRIES) : files;
  return (
    `${AFFECTED_TESTS_SELECTED_FILES_TOKEN} run=${runToken} coverage=${coverage} ` +
    `fileCount=${files.length} unenumeratedCount=${unenum.length} truncated=${truncated} ` +
    `files=${JSON.stringify(shown)} unenumerated=${JSON.stringify(unenum)}`
  );
}

/**
 * Stable key for one workspace-relative failure entry.
 *
 * The runner resolves blobs outside this module, but the comparison itself stays pure here so
 * the stale classification can be tested without a git checkout or a long test run.
 *
 * @param {{ workspace: string, file: string }} entry
 * @returns {string}
 */
export function failureEntryKey({ workspace = "", file = "" } = {}) {
  return `${workspace}\u0000${file}`;
}

/**
 * Classify reported failure entries against blobs resolved at run start and report time.
 *
 * A stale entry is one whose two known blob ids differ: the test judged one version of the file,
 * but the tree contains another version when the runner reports. Missing either blob is kept in
 * `unknown` rather than called stale; a missing git object is an attribution gap, not evidence of
 * a mid-run edit. This is deliberately advisory and does not change the task failure count.
 *
 * @param {{
 *   entries?: Array<{ workspace: string, file: string }>,
 *   runStartBlobs?: Record<string, string|null>,
 *   reportBlobs?: Record<string, string|null>,
 * }} args
 * The three buckets carry the PRECISE entry shape rather than `object`, because the natural
 * next call is `formatStaleFailureSummary({ stale })`, whose own `@param` names that shape.
 * While this said `Array<object>` that chain was a type error BY CONSTRUCTION — `Array<object>`
 * is not assignable to `Array<{ workspace, file, ... }>` — so every caller doing the obvious
 * thing had to cast. The body pushes `{ ...entry, runStartBlob, reportBlob }`, so this is what
 * it already returned; only the annotation was behind.
 *
 * @returns {{
 *   current: Array<{ workspace: string, file: string, runStartBlob: string|null, reportBlob: string|null }>,
 *   stale: Array<{ workspace: string, file: string, runStartBlob: string|null, reportBlob: string|null }>,
 *   unknown: Array<{ workspace: string, file: string, runStartBlob: string|null, reportBlob: string|null }>,
 * }}
 */
export function classifyStaleFailureEntries({
  entries = [],
  runStartBlobs = {},
  reportBlobs = {},
} = {}) {
  const current = [];
  const stale = [];
  const unknown = [];
  for (const entry of entries) {
    const key = failureEntryKey(entry);
    const runStartBlob = runStartBlobs[key] ?? null;
    const reportBlob = reportBlobs[key] ?? null;
    const classified = { ...entry, runStartBlob, reportBlob };
    if (runStartBlob && reportBlob) {
      (runStartBlob === reportBlob ? current : stale).push(classified);
    } else {
      unknown.push(classified);
    }
  }
  return { current, stale, unknown };
}

/** A stable token for the separate stale-failure advisory block. */
export const AFFECTED_TESTS_STALE_FAILURES_TOKEN = 'AFFECTED_TESTS_STALE_FAILURES';

/**
 * Render the advisory for failures whose judged blob moved before report time.
 *
 * This stays separate from `AFFECTED_TESTS_RESULT` and `AFFECTED_TESTS_FAILING_FILES`: both are
 * existing contracts consumed by the gate, while this block adds evidence about whether the
 * named red may be a phantom without changing the red's gating status.
 *
 * @param {{
 *   runStartHead?: string|null,
 *   reportHead?: string|null,
 *   stale?: Array<{ workspace: string, file: string, runStartBlob?: string|null, reportBlob?: string|null }>,
 * }} args
 * @returns {string[]}
 */
export function formatStaleFailureSummary({
  runStartHead = null,
  reportHead = null,
  stale = [],
} = {}) {
  if (stale.length === 0) return [];
  const lines = [
    `\n⚠ STALE FAILURE ADVISORY — ${stale.length} reported file(s) changed after this run started.`,
    `  The test judged an older blob; this run remains a failure, but the named red may be a phantom.`,
    `  runStartHead=${runStartHead ?? "unknown"} reportHead=${reportHead ?? "unknown"}`,
  ];
  for (const entry of stale) {
    lines.push(
      `  - ${entry.workspace} :: ${entry.file} ` +
        `(judgedBlob=${entry.runStartBlob ?? "unknown"} treeBlob=${entry.reportBlob ?? "unknown"})`,
    );
  }
  lines.push(
    `${AFFECTED_TESTS_STALE_FAILURES_TOKEN} runStartHead=${runStartHead ?? "unknown"} ` +
      `reportHead=${reportHead ?? "unknown"} staleCount=${stale.length} ` +
      `files=${JSON.stringify(stale)}`,
  );
  return lines;
}

/** A stable token for the separate mid-run tree-drift advisory block. */
export const AFFECTED_TESTS_TREE_DRIFT_TOKEN = 'AFFECTED_TESTS_TREE_DRIFT';

/**
 * Render the advisory for a run whose TREE moved while it was executing.
 *
 * This is the companion to {@link formatStaleFailureSummary}, and the distinction between them
 * is the entire point. That helper asks "did the failing FILE itself change?", which it answers
 * by comparing that one file's blob at run start against report time. This helper asks the
 * question that comparison structurally CANNOT: "did anything the failing file DEPENDS ON
 * change?" A test file is only the entry point to its import graph, and the graph is where a
 * long run is most exposed.
 *
 * MEASURED CASE (WI-972025, 2026-08-30). A canonical run spanning 00:19:31Z->01:12:29Z absorbed
 * 35 commits touching 122 files, 92 of them in packages/operator-core. Two apps/operator suites
 * died at COLLECTION with `registerAuthorityOp: kind required`, because the
 * PLAN_ITEM_CLAIM_OP_KINDS.forceRelease KEY entered claims.ts at 00:37:27Z while its
 * REGISTRATION entered plan-item-claim-authority-ops.ts at 00:42:29Z — five minutes apart, both
 * inside the run. A worker that read the first file before 00:37Z and collected a suite after
 * 00:42Z ran new registration code against old constants.
 *
 * NEITHER TEST FILE CHANGED. So both of their blobs matched, both were classified `current`, no
 * stale-failure advisory fired, and the phantom red was reported with full confidence — against
 * code that was never broken (both files pass individually at HEAD, 9 consecutive ledger rows).
 * That silence is the bug this closes: the run had `RUN_START_HEAD` and `reportHead` in hand and
 * never said the tree had moved underneath it.
 *
 * Deliberately ADVISORY, and deliberately does NOT touch the exit code — the same judgment
 * `formatProvenanceDrift` records in scripts/test-files.mjs. This signal is consumed by gates,
 * and flipping a verdict on a DIAGNOSTIC would make this a new false-RED generator, which is the
 * failure mode it exists to reduce. It rides BESIDE the verdict so the verdict cannot be pasted
 * without its caveat.
 *
 * Returns [] when HEAD did not move, or when either head is unknown — an unreadable ref is an
 * attribution gap, not evidence of drift (the same rule `classifyStaleFailureEntries` applies
 * when it routes a missing blob to `unknown` rather than to `stale`).
 *
 * @param {{
 *   runStartHead?: string|null,
 *   reportHead?: string|null,
 *   changedPaths?: string[],
 *   commitCount?: number|null,
 *   sampleLimit?: number,
 * }} args
 * @returns {string[]}
 */
export function formatTreeDriftAdvisory({
  runStartHead = null,
  reportHead = null,
  changedPaths = [],
  commitCount = null,
  sampleLimit = 8,
} = {}) {
  if (!runStartHead || !reportHead || runStartHead === reportHead) return [];
  const paths = Array.isArray(changedPaths) ? changedPaths.filter(Boolean) : [];
  const lines = [
    `\n⚠ TREE DRIFT ADVISORY — the working tree changed while this run was executing.`,
    `  A red here may be a PHANTOM: a file can fail because a module it IMPORTS was rewritten`,
    `  mid-run. That is invisible to the stale-failure check above, which compares only the`,
    `  failing test file's own blob — an unchanged test file proves nothing about its imports.`,
    `  Re-run at a settled HEAD, or from a pinned worktree (what the green-checkpoint gate`,
    `  already does), before citing any red below as a defect.`,
    `  runStartHead=${runStartHead} reportHead=${reportHead}` +
      (commitCount == null ? "" : ` commits=${commitCount}`) +
      ` changedFiles=${paths.length}`,
  ];
  for (const p of paths.slice(0, sampleLimit)) lines.push(`  ~ ${p}`);
  if (paths.length > sampleLimit) {
    lines.push(
      `  … and ${paths.length - sampleLimit} more — full set: ` +
        `git diff --name-only ${runStartHead}..${reportHead}`,
    );
  }
  lines.push(
    `${AFFECTED_TESTS_TREE_DRIFT_TOKEN} runStartHead=${runStartHead} reportHead=${reportHead} ` +
      `commits=${commitCount ?? "unknown"} changedFiles=${paths.length}`,
  );
  return lines;
}

/** @see formatFailureScopeSummary — the greppable marker it always emits. */
export const AFFECTED_TESTS_FAILURE_SCOPE_TOKEN = "AFFECTED_TESTS_FAILURE_SCOPE";

/**
 * Attribute each failing test file to the CALLER'S OWN change set — or say plainly that the
 * run had no caller scope to attribute against.
 *
 * EI-20072082961786945. {@link formatTreeDriftAdvisory} answers "did the tree move under this
 * run"; {@link classifyStaleFailureEntries} answers "did THIS failing file's blob move". Neither
 * answers the question a triager actually asks first — *is this red MINE?* — so today the result
 * hands back a workspace + filename and the reader reconstructs the answer by hand (the filing
 * agent spent ~4 calls doing exactly that: re-run the two files, grep the run log for the
 * assertion text, `git log --since` on each implicated path).
 *
 * Both directions of that guess are expensive on this box. CLAUDE.md makes every agent
 * responsible for greening reds, so a red misattributed to YOU sends you to "fix" a file a peer
 * is actively editing — a collision with a live lock-holder. The symmetric error is worse: an
 * agent who has learned that unrelated reds are usually peer churn dismisses a genuine
 * regression of their own as "not mine".
 *
 * THE UNSCOPED CASE IS THE MEASURED ONE, and it is why this returns a label rather than a
 * verdict. The filing run was a bare `npm run test:affected`, whose radius is derived from the
 * shared tree's git state — i.e. the whole fleet's in-flight work, not the caller's. There is
 * then no caller scope to intersect against, and the honest answer is to say so (`unscoped-run`
 * / `scope=derived`) instead of manufacturing a per-file verdict from a set that was never the
 * caller's. That reading also names its own repair: re-run with `--changed-paths`.
 *
 * A missing/unresolvable workspace dir routes to `unknown`, never to `outside-caller-scope` —
 * the same rule {@link classifyStaleFailureEntries} applies when it routes a missing blob to
 * `unknown`. A failed lookup is an attribution GAP; spending it as evidence would invent the
 * confident answer this whole helper exists to stop inventing.
 *
 * @param {{
 *   entries?: Array<{workspace: string, file: string}>,
 *   callerPaths?: string[]|null,
 *   workspaceDirs?: Record<string, string>,
 * }} args `callerPaths` is the caller's EXPLICIT `--changed-paths` set, or null when the run
 *   derived its own radius. `workspaceDirs` maps workspace name -> repo-relative dir.
 * @returns {{
 *   scoped: boolean,
 *   rows: Array<{workspace: string, file: string, attribution: string, matchedPaths: string[]}>,
 *   counts: {callerFile: number, callerWorkspace: number, outside: number, unknown: number, unscoped: number},
 * }}
 */
export function classifyFailureScope({
  entries = [],
  callerPaths = null,
  workspaceDirs = {},
} = {}) {
  const scoped = Array.isArray(callerPaths);
  const paths = scoped
    ? [
        ...new Set(
          callerPaths
            .filter((p) => typeof p === "string" && p.trim())
            .map((p) => p.trim().replaceAll("\\", "/").replace(/\/+$/, "")),
        ),
      ]
    : [];
  const rows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const workspace = String(entry?.workspace ?? "").trim();
    const file = String(entry?.file ?? "")
      .replaceAll("\\", "/")
      .trim();
    if (!scoped) {
      rows.push({ workspace, file, attribution: "unscoped-run", matchedPaths: [] });
      continue;
    }
    const dir = workspaceDirs?.[workspace];
    if (typeof dir !== "string" || !dir.trim()) {
      rows.push({ workspace, file, attribution: "unknown", matchedPaths: [] });
      continue;
    }
    const wsDir = dir.trim().replaceAll("\\", "/").replace(/\/+$/, "");
    // `p === wsDir` is the SUBMODULE case, for the same reason `resolveAffected` carries that
    // arm: a gitlink change is reported as the bare directory, not as a path beneath it.
    const matchedPaths = paths.filter(
      (p) => p === wsDir || p.startsWith(`${wsDir}/`),
    );
    const repoPath = file ? `${wsDir}/${file}` : null;
    rows.push({
      workspace,
      file,
      attribution:
        repoPath && matchedPaths.includes(repoPath)
          ? "caller-file"
          : matchedPaths.length
            ? "caller-workspace"
            : "outside-caller-scope",
      matchedPaths: matchedPaths.slice(0, 4),
    });
  }
  const count = (attribution) =>
    rows.filter((r) => r.attribution === attribution).length;
  return {
    scoped,
    rows,
    counts: {
      callerFile: count("caller-file"),
      callerWorkspace: count("caller-workspace"),
      outside: count("outside-caller-scope"),
      unknown: count("unknown"),
      unscoped: count("unscoped-run"),
    },
  };
}

/**
 * Render {@link classifyFailureScope} as advisory stderr lines plus one greppable marker.
 *
 * ADVISORY ONLY, like every sibling block in this family: the exit code, the
 * `AFFECTED_TESTS_RESULT` line and the `AFFECTED_TESTS_FAILING_FILES` break set are verdict
 * contracts the gate parses, and widening a verdict to carry an attribution GUESS is how a
 * guess comes to be read as a verdict.
 *
 * `possible-peer-churn` is deliberately the CONJUNCTION of two independent facts — the failure
 * is outside the caller's paths AND the tree moved mid-run — because either alone is common and
 * uninformative. Even then it only narrows: a red outside your paths can still be your own
 * regression reached through the dependency graph, which is exactly why the runner selected that
 * workspace at all. The lines say so, because the cost of this label being read as a verdict is
 * a real regression dismissed as someone else's.
 *
 * @param {{
 *   runToken?: string|null,
 *   classification?: ReturnType<typeof classifyFailureScope>|null,
 *   treeDrifted?: boolean,
 *   sampleLimit?: number,
 * }} args
 * @returns {string[]}
 */
export function formatFailureScopeSummary({
  runToken = null,
  classification = null,
  treeDrifted = false,
  sampleLimit = 8,
} = {}) {
  const rows = Array.isArray(classification?.rows) ? classification.rows : [];
  if (!rows.length) return [];
  const { scoped, counts } = classification;
  const lines = [];
  if (!scoped) {
    lines.push(
      `\n⚠ NO CALLER SCOPE — this run derived its own radius from the shared tree's git state,`,
      `  not from paths you named, so NOTHING in the break set above is attributable to your`,
      `  change. On this box that radius is the whole fleet's in-flight work. Before treating any`,
      `  red above as yours — or as someone else's — re-run scoped:`,
      `    npm run test:affected -- --changed-paths=path/to/first.ts,path/to/second.ts`,
    );
  } else {
    const outside = rows.filter((r) => r.attribution === "outside-caller-scope");
    if (outside.length) {
      lines.push(
        `\n⚠ ${outside.length} of ${rows.length} failing file(s) are OUTSIDE the paths you named` +
          (treeDrifted
            ? ` — and HEAD moved mid-run, so this is the possible-peer-churn shape:`
            : `:`),
      );
      for (const r of outside.slice(0, sampleLimit)) {
        lines.push(
          `  - ${r.workspace} :: ${r.file}  attribution=` +
            (treeDrifted ? "possible-peer-churn" : "outside-caller-scope"),
        );
      }
      if (outside.length > sampleLimit) {
        lines.push(`  … and ${outside.length - sampleLimit} more`);
      }
      lines.push(
        `  This NARROWS the search; it does not settle it. A red outside your paths can still be`,
        `  YOUR regression reached through the dependency graph — that is why the runner selected`,
        `  that workspace. Confirm before fixing, and check locks:queue { paths } first: a peer`,
        `  may be mid-edit in the very file this points you at.`,
      );
    }
  }
  lines.push(
    `${AFFECTED_TESTS_FAILURE_SCOPE_TOKEN} run=${runToken ?? "unknown"} ` +
      `scope=${scoped ? "explicit" : "derived"} files=${rows.length} ` +
      `callerFile=${counts.callerFile} callerWorkspace=${counts.callerWorkspace} ` +
      `outside=${counts.outside} unknown=${counts.unknown} unscoped=${counts.unscoped} ` +
      `treeMoved=${treeDrifted ? "true" : "false"} ` +
      `possiblePeerChurn=${scoped && treeDrifted ? counts.outside : 0}`,
  );
  return lines;
}

/**
 * Parse the canonical, machine-readable break-set line emitted by
 * {@link formatFailingFilesLine}.
 *
 * This is intentionally separate from the runner-specific parsers above. The line is the
 * affected runner's authoritative union of Vitest, node --test, selftest, Astro, and declared
 * failure formats; a consumer that re-parses child output can miss a runner it does not speak.
 * Return `null` when no valid canonical line is present so callers can preserve their legacy
 * parser as a compatibility fallback. A valid line with `files=[]` returns `[]`: that is a
 * deliberate "the run could not name files" result, not absence of the line.
 *
 * @param {string} text
 * @returns {Array<{workspace: string, file: string}>|null}
 */
export function parseFailingFilesLine(text) {
  if (!text) return null;
  const plain = stripVitestAnsi(text);
  let parsed = null;
  for (const line of plain.split(/\r?\n/)) {
    if (!new RegExp(`^\\s*${AFFECTED_TESTS_FAILING_FILES_TOKEN}\\s+run=\\S+\\s+`).test(line)) continue;
    const filesAt = line.indexOf('files=');
    const unattributedAt = filesAt >= 0 ? line.indexOf(' unattributed=', filesAt + 'files='.length) : -1;
    if (filesAt < 0 || unattributedAt < 0) continue;
    let files;
    try {
      files = JSON.parse(line.slice(filesAt + 'files='.length, unattributedAt).trim());
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    const seen = new Set();
    const entries = [];
    for (const entry of files) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof entry.workspace !== 'string' ||
        typeof entry.file !== 'string' ||
        !entry.workspace.trim() ||
        !entry.file.trim()
      ) {
        continue;
      }
      const workspace = entry.workspace.trim();
      const file = entry.file.trim();
      const key = `${workspace}\u0000${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ workspace, file });
    }
    // The outer affected runner prints its summary after child output. Keep the last valid
    // line so a nested fixture invocation cannot mask the run-level break set.
    parsed = entries;
  }
  return parsed;
}

/**
 * Did the test ROUTER refuse this run outright?
 *
 * `scripts/test-files.mjs` refuses a zero/partial-match run rather than false-greening the
 * files that DID match, so the task exits 1 having executed nothing — no FAIL rows, no rollup,
 * no parse failure. Every attribution parser above therefore speaks for nothing, and without
 * this the reason lands on `no-file-rows`, whose documented causes are "a worker crash, an OOM,
 * a spawn error". That is not a cosmetic mislabel: it points triage at infrastructure while the
 * router has already printed both the refusal AND the offending paths (`  unmatched <path>`) in
 * plain text. EI-21440128879545486 is the cost of that — a red that survived seven unrelated
 * test fixes and froze `main`, because no test was ever broken and re-running changed nothing.
 *
 * The same shape as EI-20095409199430877 and EI-20098997113620795 before it: the output named
 * the culprit, no parser spoke for it, and the honest-sounding fallback read as an infra crash.
 *
 * WI-41663: this pair sits ABOVE attributeFailedTask's doc block on purpose. It used to sit
 * BETWEEN that block and the function, which detached the `@param {{…}} args` annotation —
 * TypeScript then inferred the whole parameter object from the destructuring pattern, typing
 * workspace/task/captured as `any` and making the OPTIONAL `fallbackReason` REQUIRED. That
 * stranded every caller that (correctly) omits it. Keep a declaration between a JSDoc block
 * and the function it documents and the same silent degradation returns.
 */
const ROUTE_REFUSAL_RE = /^TEST_FILE_ROUTE_ERROR\b/m;

/** @param {string} [output] captured task output @returns {boolean} */
export function hasRouteRefusal(output = '') {
  return ROUTE_REFUSAL_RE.test(output);
}

/**
 * Parse the failure-file formats spoken by this task's output.
 *
 * Kept as one helper so the primary and fallback capture paths cannot silently drift:
 * a retry may replace the in-memory task result with a governed-admission error that has
 * no child bytes, while the initial task result still carries the Vitest rows.
 *
 * @param {string} output
 * @returns {{ files: string[], transformCulprits: string[] }}
 */
function parseAttributableTaskOutput(output = '') {
  const transformCulprits = transformCulpritsFrom(output);
  // ALL known runner formats (EI-20095409199430877, EI-20098997113620795). A union, never a
  // fallback: `@papercusp/desktop`'s `test` chains three sub-steps across three DIFFERENT
  // runners (`node --test`, `node --test`, then the bash selftest harness), so a single task's
  // output can legitimately carry two formats at once and taking the first non-empty set would
  // silently drop the other's files.
  //
  // ⚠ The set of runners this union must cover is not a matter of memory: it is asserted against
  // what the repo ACTUALLY runs by attributor-runner-coverage.test.ts, which derives the runner
  // classes from every workspace's task scripts. Adding a runner here without a fixture there, or
  // a workspace adopting a fourth runner, fails that test rather than degrading to `no-file-rows`.
  const files = [
    ...new Set([
      ...parseFailedTestFiles(output),
      ...parseNodeTestFailedFiles(output),
      ...parseBashSelftestFailedFiles(output),
      ...parseAstroCheckFailedFiles(output),
      ...parseDeclaredFailingFiles(output),
    ]),
  ];
  return { files, transformCulprits };
}

/**
 * Attribute ONE failed task to the test files that broke it.
 *
 * Returns either files or a REASON it has none — never a bare empty list, because the
 * caller accumulates these and an empty contribution is indistinguishable from "this task
 * passed". Three ways a genuinely-red task yields no file:
 *   - `no-captured-output` — an interactive TTY run inherited stdio, so there is no text
 *     to parse. The failure is real; attribution was never possible.
 *   - `no-file-rows`      — captured output in which NO known runner format named a file:
 *     a worker crash, an OOM, a spawn error.
 *     ⚠ Read this as "no PARSER spoke for it", not "the output named nothing" — those came
 *     apart for `node --test` workspaces until EI-20095409199430877, where output naming the
 *     failing file in plain text still reported this reason and read as an infra crash.
 *     ⚠ Exactly ONE task in this repo still lands here LEGITIMATELY, and knowing which turns a
 *     misleading reason into an expected one: `@papercusp/web :: test:el-suite`, whose checks
 *     assert on the replies of a live remote agent — no repo file is the culprit, so there is
 *     nothing honest to name (see {@link formatDeclaredFailingFileLines}). It is DECLARED as
 *     unattributable in scripts/lib/test-runner-classes.mjs, so this is a known boundary
 *     rather than a blind spot. For ANY other task, the infra causes above really are the
 *     candidates. (This list has shrunk twice — `astro check` and `lint:el-tools` both left it
 *     under EI-20102376842495928 — so treat a stale-looking entry here as a bug in this
 *     docstring, which attributor-runner-coverage.test.ts pins against the real registry.)
 *   - `route-refusal`     — the ROUTER refused the run before any test executed: it was handed
 *     a file this config cannot match and declined the whole partial-match batch rather than
 *     false-greening the rest. Nothing ran, so no parser can speak — but the cause is NOT
 *     unknowable: the task's own output carries `TEST_FILE_ROUTE_ERROR requested=N matched=M`
 *     and one `  unmatched <path>` line per offending file. Go read those; do not re-run, and
 *     do not go hunting a flaky test. The usual cause is a file routed to the wrong RUNNER
 *     (a Playwright spec handed to a vitest lane), which no amount of test triage can fix.
 *     Split out of `no-file-rows` (EI-21440128879545486), where it read as an OOM for a full
 *     session while the offending paths sat named in plain text.
 *   - `transform`         — no FAIL/rollup rows AND a parse failure is present, i.e. the
 *     collapse happened before the reporter ran. Split out of `no-file-rows` (WI-37607):
 *     this docstring used to name a transform failure as one of that reason's causes, which
 *     made a peer's mid-edit read identically to an OOM.
 *   - `non-vitest`        — cargo and friends; this parser cannot speak for them.
 *
 * ⚠ `transformCulprits` is returned INDEPENDENTLY of whether files were attributed, and that
 * independence is the point (WI-37607). Measured on the real logs: a module that fails to
 * parse still produces FAIL/rollup rows for every test file that transitively imports it, so
 * the common case is `entries.length === 21, unattributed.length === 0` — fully attributed,
 * `coverage=complete`, and every one of those 21 a CASUALTY of one broken module. Reading the
 * culprit set off the `unattributed` reason alone would therefore miss exactly the case this
 * was built for.
 *
 * @param {{ workspace: string, task: string, captured: boolean, output?: string,
 *           fallbackReason?: string, fallbackOutput?: string,
 *           fallbackSource?: string }} args
 * @returns {{ entries: Array<{ workspace: string, file: string }>,
 *             unattributed: Array<{ task: string, reason: string }>,
 *             transformCulprits: string[],
 *             attributionSource?: string }}
 */
export function attributeFailedTask({
  workspace,
  task,
  captured,
  output = '',
  fallbackReason,
  fallbackOutput = '',
  fallbackSource = 'fallback-output',
}) {
  if (!captured) {
    return {
      entries: [],
      unattributed: [{ task, reason: fallbackReason ?? 'no-captured-output' }],
      transformCulprits: [],
    };
  }
  const primary = parseAttributableTaskOutput(output);
  let selected = primary;
  let attributionSource;
  let fallback = null;
  if (primary.files.length === 0 && fallbackOutput) {
    fallback = parseAttributableTaskOutput(fallbackOutput);
    if (fallback.files.length > 0) {
      selected = fallback;
      attributionSource =
        String(fallbackSource ?? '').trim() || 'fallback-output';
    }
  }
  const transformCulprits = [
    ...new Set([
      ...primary.transformCulprits,
      ...(fallback?.transformCulprits ?? []),
    ]),
  ];
  const files = selected.files;
  if (files.length === 0) {
    return {
      entries: [],
      unattributed: [
        {
          task,
          // Ordering is deliberately conservative: a declared `fallbackReason` still wins, so
          // this can only ever REPLACE the reason that would have been `no-file-rows`.
          reason:
            transformCulprits.length > 0
              ? 'transform'
              : (fallbackReason ??
                (hasRouteRefusal(output) || hasRouteRefusal(fallbackOutput)
                  ? 'route-refusal'
                  : 'no-file-rows')),
        },
      ],
      transformCulprits,
    };
  }
  return {
    entries: files.map((file) => ({ workspace, file })),
    unattributed: [],
    transformCulprits,
    ...(attributionSource ? { attributionSource } : {}),
  };
}

/**
 * The whole failure-summary block a run prints for its break set: the human list a triager
 * reads, then the canonical machine line. Returned as lines rather than printed so the
 * thing that actually ships is unit-testable.
 *
 * Extracted deliberately (EI-19395701908500754): left inline in affected-tests.mjs, the only
 * available guard is a source-text assertion, which cannot catch a runtime fault on a path
 * that runs solely when the gate is already red — i.e. it would report green while being
 * broken exactly when needed. This module's own history has that shape twice over
 * (EI-18819483316574031: a parser dead in production while its tests passed).
 *
 * The transform-casualty block leads DELIBERATELY (WI-37607). CLAUDE.md instructs triagers to
 * "read `coverage` before `files`", so on a parse failure the most authoritative-looking token in
 * the whole summary — `coverage=complete` — is the one most likely to be trusted about a question
 * it does not answer. A warning printed AFTER the list would be read after the damage.
 *
 * @param {{
 *   runToken: string,
 *   failedTaskCount: number,
 *   entries?: Array<{ workspace: string, file: string }>,
 *   unattributed?: Array<{ task: string, reason: string }>,
 *   transformCulprits?: string[],
 *   attributionFallbacks?: Array<{ task: string, source: string }>,
 * }} args
 * @returns {string[]}
 */
export function renderFailingFilesSummary({
  runToken,
  failedTaskCount,
  entries = [],
  unattributed = [],
  transformCulprits = [],
  attributionFallbacks = [],
}) {
  const culprits = [...new Set(transformCulprits)];
  const lines = [];
  if (culprits.length > 0) {
    lines.push(
      `\n⚠⚠ PARSE (transform) FAILURE DETECTED — cause=transform. Culprit module(s):`,
      ...culprits.map((c) => `     ${c}`),
      `  A module in the import graph failed to PARSE, so EVERY test file that transitively imports`,
      `  it fails too. Treat the ${entries.length} file(s) below as CASUALTIES of the module(s) above`,
      `  until proven otherwise — not as ${entries.length} independent breaks.`,
      `  ⚠ \`coverage\` below can still read \`complete\`: it reports whether each failed TASK was`,
      `    attributed to files, NOT whether those files are themselves broken. On a parse failure`,
      `    those two questions come apart, and coverage answers only the first.`,
      `  On this shared tree this is usually a PEER MID-EDIT: re-run in a minute and check the`,
      `  culprit's \`git status\` BEFORE investigating anything in the list below.`,
    );
  }
  lines.push(
    `\n${entries.length} failing test file(s) — the per-FILE break set ` +
      `(the failed=${failedTaskCount} above counts TASKS, not files):`,
  );
  for (const e of entries) lines.push(`  - ${e.workspace} :: ${e.file}`);
  if (attributionFallbacks.length) {
    lines.push(
      `${attributionFallbacks.length} failed task(s) used a secondary attribution source ` +
        `after the primary task output named no files; coverage above includes those fallbacks:`,
    );
    for (const fallback of attributionFallbacks) {
      lines.push(`  - ${fallback.task} (source=${fallback.source})`);
    }
  }
  if (unattributed.length) {
    lines.push(
      `${unattributed.length} failed task(s) could NOT be attributed to files — their ` +
        `failures are REAL but unnamed here; do not read the list above as complete:`,
    );
    for (const u of unattributed) lines.push(`  - ${u.task} (${u.reason})`);
  }
  lines.push(
    formatFailingFilesLine({
      runToken,
      entries,
      unattributed,
      transformCulprits: culprits,
      attributionFallbacks,
    }),
  );
  return lines;
}

/**
 * Count vitest's own hard-timeout failures — `"Test timed out in Nms."` / `"Hook timed
 * out in Nms."`, the exact message `@vitest/runner` throws when a case or hook exceeds
 * `testTimeout`/`hookTimeout` — in a run's combined stdout+stderr. ANSI-stripped first,
 * like every other parser here (EI-18819483316574031: skipping that step is why a sibling
 * parser went blind on real colourized gate output for weeks).
 *
 * EI-19332556961886184: a test that TIMES OUT reds a suite exactly like a real assertion
 * failure — nothing in a bare "N failed" count says which. Under fleet load this is a
 * load artifact, not evidence the code is broken, and it is worst exactly when the fleet
 * is busiest. This gives a caller a cheap, precise (not the broader `waitFor`/"Exceeded
 * timeout" heuristic green-checkpoint.ts's `outputHasTimingSignature` uses for retry
 * *policy*) way to surface the distinction — it decides nothing about whether the
 * failure is "real"; it only lets a triager see that a timeout signature is present
 * before spending time chasing a defect that may not exist.
 *
 * @param {string} text
 * @returns {number}
 */
export function countTimeoutSignatures(text) {
  if (!text) return 0;
  const plain = stripVitestAnsi(text);
  const matches = plain.match(/\b(?:Test|Hook) timed out in \d+ms\./g);
  return matches ? matches.length : 0;
}
