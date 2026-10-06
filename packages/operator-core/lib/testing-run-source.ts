/**
 * testing-run-source.ts — resolve the `source` column for a test_runs row.
 *
 * Plan: admin-testing-tab-restructure-2026-05-24, P-014.
 *
 * `source` is one of the CHECK-constrained values 'ci' | 'local' | 'admin-ui' |
 * 'mutation-probe'. Mutation probes are durable falsifiability evidence, not
 * repository-health evidence; readers must exclude them from health/gate
 * populations explicitly.
 *
 * Precedence:
 *   1. PAPERCUSP_MUTATION_PROBE=1, or a validated controlled-fixture marker
 *      scoped to its exact test file → 'mutation-probe'.
 *   2. PAPERCUSP_TEST_RUN_SOURCE env var, when set to a valid value, wins.
 *      Set by testing-run-store on every admin-ui-triggered spawn so the
 *      in-process reporter inside the child can stamp the right source.
 *   3. Otherwise CI=truthy → 'ci'.
 *   4. Otherwise → 'local'.
 *
 * No I/O, no exceptions — safe to call from any reporter / writer hot path.
 */

export type TestRunSource = 'ci' | 'local' | 'admin-ui' | 'mutation-probe';

const VALID: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui', 'mutation-probe']);
const PLACEMENT_EXCLUSION_FIXTURE = 'packages/operator-core/lib/goal-plan-placement-exclusion-proof.test.ts';
const PLACEMENT_EXCLUSION_CONTROLS: ReadonlySet<string> = new Set([
  'holder-not-independent',
  'independent-member-positive',
  'existing-one-fleet',
  'drain-and-test-excluded',
]);
const GOAL_RESPAWN_CONTROL_FIXTURE = 'packages/operator-core/lib/system-health/goal-liveness-watchdog.test.ts';
const GOAL_RESPAWN_CONTROLS: ReadonlySet<string> = new Set([
  'elected-loss-recovery',
  'live-holder-no-double-spawn',
  'concurrent-takeover-refusal',
  'successful-recovery-control',
]);

export function resolveTestRunSource(
  env: {
    PAPERCUSP_TEST_RUN_SOURCE?: string;
    PAPERCUSP_MUTATION_PROBE?: string;
    PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL?: string;
    PAPERCUSP_GOAL_RESPAWN_CONTROL?: string;
    CI?: string;
  } = process.env,
  filePath?: string,
): TestRunSource {
  // The probe marker describes the purpose of the whole child run and must
  // win over an inherited writer override (for example CI=1).
  const normalizedFilePath = filePath?.replace(/\\/g, '/').replace(/^\.\//, '');
  const controlledPlacementFixture =
    normalizedFilePath === PLACEMENT_EXCLUSION_FIXTURE &&
    env.PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL !== undefined &&
    PLACEMENT_EXCLUSION_CONTROLS.has(env.PAPERCUSP_PLACEMENT_EXCLUSION_CONTROL);
  const controlledGoalRespawnFixture =
    normalizedFilePath === GOAL_RESPAWN_CONTROL_FIXTURE &&
    env.PAPERCUSP_GOAL_RESPAWN_CONTROL !== undefined &&
    GOAL_RESPAWN_CONTROLS.has(env.PAPERCUSP_GOAL_RESPAWN_CONTROL);
  if (env.PAPERCUSP_MUTATION_PROBE === '1' || controlledPlacementFixture || controlledGoalRespawnFixture) {
    return 'mutation-probe';
  }
  const override = env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID.has(override as TestRunSource)) {
    return override as TestRunSource;
  }
  return env.CI ? 'ci' : 'local';
}
