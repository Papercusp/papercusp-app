/**
 * PIPE-testwriter-creates-tests (P-030) — the test-writer role actually CREATES
 * real test files for a feature's acceptance criteria (not empty stubs, not a
 * "I would write…" narration).
 *
 * The headline behavioral guarantee behind the GENERATE_TESTS dispatch verb
 * (wiring proven by P-029; behavior proven here). Deterministic half: a
 * *.test.ts / *.spec.ts file appears. Behavioral half (judge): the tests are
 * real and exercise the acceptance criteria.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';

export const PIPE_TESTWRITER_CREATES_TESTS: PipelineScenario = {
  id: 'PIPE-testwriter-creates-tests',
  version: 1,
  role: 'test-writer',
  description:
    'Given a feature with an implementation and acceptance criteria, the test-writer must write at least one real *.test.ts/*.spec.ts file whose cases exercise the criteria.',
  setup: {
    feature: {
      id: 'F-TW-1',
      title: 'clamp helper',
      spec: 'Add clamp(n, lo, hi): returns n bounded to [lo, hi].',
      acceptance: [
        'clamp returns n when lo ≤ n ≤ hi',
        'clamp returns lo when n < lo',
        'clamp returns hi when n > hi',
      ],
      status: 'todo',
    },
    files: [
      { path: 'src/clamp.ts', content: 'export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));\n' },
    ],
  },
  asserts: [
    { kind: 'exit_code_is', expected: 0 },
    // The decisive deterministic guarantee: a real test file was created.
    { kind: 'file_created', matching: /\.(test|spec)\.(ts|tsx|js)$/, minCount: 1 },
  ],
  rubric: {
    version: '1',
    axes: [
      {
        id: 'testsAreReal',
        description: 'Are the written tests real, executable cases that exercise the clamp acceptance criteria (in-range, below-lo, above-hi) — not empty stubs or placeholders?',
        anchors: {
          bad: 'An empty test file, a single trivial assertion, or a TODO/placeholder; criteria not exercised.',
          ideal: 'Distinct cases covering all three criteria with concrete expected values.',
        },
      },
    ],
    criticality: 'high',
  },
  caps: { maxWallSecs: 600, maxCostUsd: 1 },
};
