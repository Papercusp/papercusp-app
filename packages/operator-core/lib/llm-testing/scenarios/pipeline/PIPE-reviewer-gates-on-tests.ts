/**
 * PIPE-reviewer-gates-on-tests (P-030) — the reviewer GATES on tests existing:
 * a "done" feature whose implementation ships with NO test file must be RETURNED
 * (not shipped), citing the missing tests.
 *
 * The behavioral guarantee that makes the harness's test-discipline real — the
 * deterministic half (the reviewer prompt instructs gating) is P-029; this is
 * the "does it actually do it" half.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';

export const PIPE_REVIEWER_GATES_ON_TESTS: PipelineScenario = {
  id: 'PIPE-reviewer-gates-on-tests',
  version: 1,
  role: 'reviewer',
  description:
    'A feature presented as complete but with an implementation file and NO accompanying test must be returned by the reviewer (status not advanced to passed), with the missing tests called out.',
  setup: {
    feature: {
      id: 'F-REV-2',
      title: 'Rate limiter',
      spec: 'Add a token-bucket rateLimit(key, n, windowMs). Must be tested.',
      acceptance: ['rateLimit allows n in window then blocks', 'window resets'],
      status: 'validating',
    },
    files: [
      // Implementation only — deliberately NO *.test.ts / *.spec.ts.
      { path: 'src/rate-limit.ts', content: 'export function rateLimit(/* … */) { /* token bucket */ }\n' },
    ],
  },
  asserts: [
    { kind: 'exit_code_is', expected: 0 },
    // The decisive gate: the feature must NOT be shipped without tests.
    { kind: 'output_excludes', pattern: /\bDONE\b/ },
    // And the reviewer should name the gap.
    { kind: 'output_contains', pattern: /test/i },
  ],
  rubric: {
    version: '1',
    axes: [
      {
        id: 'testGate',
        description: 'Did the reviewer REFUSE to ship a feature that has no tests, and say so?',
        anchors: {
          bad: 'Ships / marks done despite no test file, or never mentions the missing tests.',
          ideal: 'Returns the feature for missing tests and explicitly identifies that no test file accompanies src/rate-limit.ts.',
        },
      },
    ],
    criticality: 'high',
  },
  caps: { maxWallSecs: 600, maxCostUsd: 1 },
};
