/**
 * The `npm run test:file` EXIT-CODE CONTRACT — the one place it is stated.
 *
 * WHY THIS MODULE EXISTS. The mapping below was already implemented, and
 * implemented correctly, inside `scripts/test-files.mjs` — but only as several
 * independent `return <literal>` decisions with nothing naming them and nothing
 * pinning them. That is enough to be right today and not enough to be RELIED
 * ON, and the gap is not academic: EI-21884126680256710 was filed by an agent
 * who saw `EXIT=2` beside a file path, read it as a test red, and asked for
 * exactly the reserved exit code the router had already had for months. The
 * repo's own guidance (CLAUDE.md) sent that agent looking for a PROSE marker
 * and never mentioned the exit code, because there was no contract to point at.
 * An unwritten contract that happens to be correct is one edit from not being.
 *
 * Reading a NOT-MEASURED run as a red is the expensive direction, so the whole
 * contract is shaped around making that error hard. It blames the code under
 * test for infrastructure — a pg advisory-lock timeout during admission, a
 * watchdog reap, a routing miss — and it does so most often during gate triage,
 * because that is when the shared tree is contended enough to produce those
 * failures in the first place.
 *
 * THE CONTRACT:
 *
 *   0  PASSED       Every requested file was measured; nothing failed.
 *   1  FAILED       The run was MEASURED and at least one test genuinely
 *                   failed. This is the ONLY code that says anything about the
 *                   code under test.
 *   2  NOT MEASURED No verdict was produced: a routing refusal, a launch or
 *                   governed-admission failure, a watchdog reap, a withheld
 *                   `--require-ran` assertion, or a usage error. It says
 *                   nothing about the code under test. The correct response is
 *                   to fix the harness or retry — never to triage the file
 *                   named on the line.
 *  75  TEMPFAIL     Also not measured, and explicitly RETRYABLE: `EX_TEMPFAIL`,
 *                   pc-heavy's preemption/undetermined convention
 *                   (`scripts/pc-heavy.sh`, `_preempt_emit_result undetermined
 *                   … 75`). The router returns it when a preempt-ready barrier
 *                   cannot be published. Same blame semantics as 2 — nothing to
 *                   do with the code under test — but a caller that retries
 *                   anything should retry this one.
 *
 * THE ONE EXCEPTION, stated so it cannot be discovered the hard way: under
 * `--dry`, 0 means "routing resolved and nothing was run BY DESIGN", not
 * "measured and green". Every other 0 is a measured pass.
 *
 * That fourth code is why this module is worth its own file rather than a
 * comment. Writing the contract down surfaced it: a first draft of this file
 * documented 0/1/2 only, because the three `return 2` sites are the ones an
 * agent hits and `return 75` sits two thousand lines away in a barrier check. A
 * contract that omits a code the code actually returns is the same defect as no
 * contract, one level quieter.
 *
 * WHY IT LIVES HERE AND NOT IN `test-files.mjs`. The same reason
 * `preempt-markers.mjs` exists: that module runs top-level side effects
 * (`ensurePapercuspTmpdir()`, `applyWorkerCapEnv(...)`) on import, so a
 * consumer that only wants to CLASSIFY an exit code — the operator's
 * `testing:run`, a gate script, a test — must not be made to import it to do
 * so. This module is three constants and two pure predicates, and imports
 * nothing.
 */

/** Every requested file was measured and nothing failed. */
export const TEST_FILE_EXIT_PASSED = 0;

/**
 * The run was measured and at least one test failed. The only exit code that
 * is evidence about the code under test.
 */
export const TEST_FILE_EXIT_FAILED = 1;

/**
 * Nothing was measured, so there is no verdict — about the named file or about
 * anything else. Never triage the named file off this code.
 */
export const TEST_FILE_EXIT_NOT_MEASURED = 2;

/**
 * `EX_TEMPFAIL`. Not measured AND explicitly retryable — pc-heavy's
 * preemption/undetermined convention, returned by the router when a
 * preempt-ready barrier cannot be published.
 */
export const TEST_FILE_EXIT_TEMPFAIL = 75;

/**
 * Did this exit code come from a run that actually produced a verdict?
 *
 * An exit code OUTSIDE the contract (a crash, a signal-kill leaving `null`, a
 * code some future path adds) answers `false` deliberately. Folding an unknown
 * code into `failed` would be the exact misattribution this module exists to
 * prevent, and "I do not recognise this, so the tests must have failed" is
 * never a safe default.
 */
export function testFileRunWasMeasured(code) {
  return code === TEST_FILE_EXIT_PASSED || code === TEST_FILE_EXIT_FAILED;
}

/**
 * Classify an exit code for a consumer that has nothing but the code — a
 * summarised log, a CI step, a supervisor. `blamesCodeUnderTest` is the field
 * worth branching on: it is true for exactly one code.
 *
 * @param {number|null|undefined} code
 */
export function describeTestFileExit(code) {
  if (code === TEST_FILE_EXIT_PASSED) {
    return {
      status: 'passed',
      measured: true,
      blamesCodeUnderTest: false,
      retryable: false,
      hint: 'every requested file was measured and nothing failed',
    };
  }
  if (code === TEST_FILE_EXIT_FAILED) {
    return {
      status: 'failed',
      measured: true,
      blamesCodeUnderTest: true,
      retryable: false,
      hint: 'measured, and at least one test genuinely failed — triage the named file',
    };
  }
  if (code === TEST_FILE_EXIT_NOT_MEASURED) {
    return {
      status: 'not-measured',
      measured: false,
      blamesCodeUnderTest: false,
      retryable: false,
      hint:
        'no verdict was produced (routing refusal, launch/admission failure, watchdog reap, ' +
        'withheld --require-ran, or usage error) — fix the harness or retry; do NOT triage the named file',
    };
  }
  if (code === TEST_FILE_EXIT_TEMPFAIL) {
    return {
      status: 'not-measured-retryable',
      measured: false,
      blamesCodeUnderTest: false,
      retryable: true,
      hint:
        'EX_TEMPFAIL — preempted or undetermined before a verdict existed (pc-heavy convention); ' +
        're-run it, and do NOT triage the named file',
    };
  }
  return {
    status: 'unknown',
    measured: false,
    blamesCodeUnderTest: false,
    retryable: false,
    hint:
      `exit code ${String(code)} is outside the test:file contract ` +
      '(0 passed / 1 failed / 2 not measured / 75 tempfail) — treat it as NOT MEASURED, never as a test failure',
  };
}
