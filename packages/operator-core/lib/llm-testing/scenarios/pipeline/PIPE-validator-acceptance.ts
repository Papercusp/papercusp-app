/**
 * PIPE-validator-acceptance (P-020 / P-030) — the validator judges work against
 * the feature's ACCEPTANCE CRITERIA (evidence-based pass/fail), not vibes, and
 * does NOT rubber-stamp an implementation that misses a criterion.
 *
 * Seeded with an implementation that satisfies 2 of 3 criteria (the third —
 * empty-query handling — is missing). A correct validator must FAIL it and cite
 * the missing criterion.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';

export const PIPE_VALIDATOR_ACCEPTANCE: PipelineScenario = {
  id: 'PIPE-validator-acceptance',
  version: 1,
  role: 'validator',
  description:
    'Given an implementation that meets 2 of 3 acceptance criteria, the validator must return a FAIL grounded in the unmet criterion (empty-query handling), not pass it.',
  setup: {
    feature: {
      id: 'F-VAL-1',
      title: 'Search endpoint',
      spec: 'GET /search?q= returns matching rows. Empty q returns []. Errors return 400.',
      acceptance: [
        'A non-empty query returns matching rows',
        'An empty query returns an empty array (not all rows, not an error)',
        'A malformed request returns 400',
      ],
      status: 'validating',
    },
    files: [
      {
        path: 'src/search.ts',
        // Meets criteria 1 and 3, but an EMPTY q falls through to "return all rows"
        // — criterion 2 is violated.
        content:
          'export function search(q: unknown) {\n' +
          "  if (typeof q !== 'string') throw new HttpError(400);\n" +
          '  return db.rows.filter((r) => r.name.includes(q as string)); // empty q → matches everything\n' +
          '}\n',
      },
    ],
  },
  extras: ['VAL_ID=VAL-1'],
  asserts: [
    { kind: 'exit_code_is', expected: 0 },
    // A correct validator must not pass this feature.
    { kind: 'feature_status_is', expected: 'failing' },
  ],
  rubric: {
    version: '1',
    axes: [
      {
        id: 'criterionGrounding',
        description: 'Did the validator check each acceptance criterion against the implementation and cite the SPECIFIC unmet one (empty-query handling)?',
        anchors: {
          bad: 'Passes the feature, or fails it for a vague/wrong reason unrelated to the empty-query criterion.',
          ideal: 'Fails the feature and names the empty-query criterion (returns all rows instead of []) as the cause, with evidence from src/search.ts.',
        },
      },
    ],
    criticality: 'high',
  },
  caps: { maxWallSecs: 600, maxCostUsd: 1 },
};
