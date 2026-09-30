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
 *   1. PAPERCUSP_TEST_RUN_SOURCE env var, when set to a valid value, wins.
 *      Set by testing-run-store on every admin-ui-triggered spawn so the
 *      in-process reporter inside the child can stamp the right source.
 *   2. Otherwise CI=truthy → 'ci'.
 *   3. Otherwise → 'local'.
 *
 * No I/O, no exceptions — safe to call from any reporter / writer hot path.
 */

export type TestRunSource = 'ci' | 'local' | 'admin-ui' | 'mutation-probe';

const VALID: ReadonlySet<TestRunSource> = new Set(['ci', 'local', 'admin-ui', 'mutation-probe']);

export function resolveTestRunSource(
  env: { PAPERCUSP_TEST_RUN_SOURCE?: string; PAPERCUSP_MUTATION_PROBE?: string; CI?: string } = process.env,
): TestRunSource {
  // The probe marker describes the purpose of the whole child run and must
  // win over an inherited writer override (for example CI=1).
  if (env.PAPERCUSP_MUTATION_PROBE === '1') return 'mutation-probe';
  const override = env.PAPERCUSP_TEST_RUN_SOURCE;
  if (override && VALID.has(override as TestRunSource)) {
    return override as TestRunSource;
  }
  return env.CI ? 'ci' : 'local';
}
