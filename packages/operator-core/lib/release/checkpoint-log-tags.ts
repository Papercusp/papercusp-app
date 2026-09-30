/**
 * checkpoint-log-tags — the green-checkpoint orchestrator's stdout tags, and the one
 * predicate that tells a FIXTURE narration line from a REAL one.
 *
 * WHY THIS IS ITS OWN LEAF MODULE (EI-19395755190419540): two layers need these tags and
 * they sit on opposite sides of a package boundary. `apps/operator/lib/release/green-checkpoint.ts`
 * EMITS them; `packages/operator-core/lib/release-checkpoint-launch.ts` PARSES them back out
 * of a log. operator-core is the lower layer and must not import from apps/operator, and the
 * literals must not be duplicated. This leaf also owns `GREEN_CHECKPOINT_RESULT_MARKER`,
 * which is emitted by the apps/operator CLI and parsed by two operator-core readers across
 * the same package boundary.
 *
 * So the constants live HERE, at the bottom, and green-checkpoint.ts imports and re-exports
 * them by relative path (the same cross-tree reach it already uses for
 * `../../../../scripts/lib/vitest-summary.mjs`). Deliberately ZERO imports of its own, so
 * pulling it into the gate orchestrator's hot path cannot drag a dependency graph along.
 */

/** The wire marker immediately preceding every terminal green-checkpoint result JSON object. */
export const GREEN_CHECKPOINT_RESULT_MARKER = '__GREEN_CHECKPOINT_RESULT__';

/** The tag every orchestrator narration line carries on stdout. */
export const ORCHESTRATOR_STDOUT_TAG = '[green-checkpoint]';

/** WI-7274: the same tag, emitted instead when the narrating process is itself under a test
 *  runner — i.e. the line is a FIXTURE, not this run's account of itself.
 *
 *  THE TRAP. The gate's suite includes `green-checkpoint-real-deps.test.ts`, which drives the
 *  real `runGreen` on purpose. Driving production code means EMITTING production log lines,
 *  and the suite's stdout is captured verbatim into the persisted log — so the log carries
 *  lines byte-identical to a genuine verdict, with the only provenance (vitest's
 *  `stdout | <file>` header) on a SEPARATE line that no line-oriented grep returns.
 *
 *  Measured on the 01:36:17Z verdict for candidate 060ea000f206:
 *      grep "holding the gate" <log>   -> 4 hits, ALL FOUR test fixtures.
 *  Four of five agents triaging that red re-derived the same wrong breakdown from this log
 *  within six minutes (EI-19394685308718346).
 *
 *  The tag deliberately does NOT contain {@link ORCHESTRATOR_STDOUT_TAG} as a substring
 *  (`:` where `]` would be), so the habit every reader already has — grepping
 *  `[green-checkpoint]` — silently stops matching fixtures with no change on their side. */
export const ORCHESTRATOR_STDOUT_TAG_UNDER_TEST = '[green-checkpoint:TEST-FIXTURE]';

/** Which tag the orchestrator should narrate under.
 *  `env` is injectable because the guard that matters most — that a REAL run is tagged
 *  `[green-checkpoint]` — has to be asserted from inside a test, which is always under vitest
 *  and would otherwise only ever be able to observe the fixture branch.
 *
 *  A real run is NEVER under vitest: verified on the live orchestrator (pid 1490611,
 *  2026-08-03) — `VITEST` absent, `NODE_ENV` unset. `buildGreenCheckpointEnv` sets
 *  `VITEST_MAX_FORKS/THREADS/UNIT_TIMEOUT_MS` but never `VITEST`, so the gate cannot mark its
 *  own genuine verdict as a fixture. That inversion would be far worse than the bug. */
export function orchestratorStdoutTag(env: NodeJS.ProcessEnv = process.env): string {
  return env.VITEST || env.NODE_ENV === 'test'
    ? ORCHESTRATOR_STDOUT_TAG_UNDER_TEST
    : ORCHESTRATOR_STDOUT_TAG;
}

/**
 * EI-19395755190419540 — is this log line a TEST FIXTURE's narration rather than a real run's?
 *
 * ⚠ THE ANCHOR MUST BE NEGATIVE. The obvious fix for a fixture-polluted log is to require the
 * production tag (`/\[green-checkpoint\] checkpointing candidate/`). That is WRONG, and it
 * fails silently in the direction that matters. The same logical line exists in TWO shapes,
 * because `log()` passes the RAW message to `recordOrchestratorLine` while only `console.log`
 * prepends a tag:
 *
 *   persisted log (~/.papercusp/checkpoint-logs/*.log), line 3 of the 060ea000f206 log:
 *       2026-08-03T01:15:05.333Z checkpointing candidate 060ea000 (base 1e0ddc58)   <- UNPREFIXED
 *   /tmp manual log (stdout):
 *       [green-checkpoint] checkpointing candidate 13d9c65d (base 1e0ddc58)         <- prefixed
 *
 * Measured: 1 of 1 occurrences in the persisted log is unprefixed. Positive anchoring
 * therefore zeroes candidate extraction for exactly the SCHEDULER-fired runs that are the
 * majority — and a zero reads as "no candidate found", not as "my regex is wrong".
 *
 * Excluding the fixture tag keeps BOTH real shapes matching, and is the only form that does.
 */
export function isFixtureLogLine(line: string): boolean {
  return line.includes(ORCHESTRATOR_STDOUT_TAG_UNDER_TEST);
}
