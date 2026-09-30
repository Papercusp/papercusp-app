/**
 * PIPE-reviewer-ship-return (P-020) — the reviewer SHIPS a clean, validated
 * feature (doesn't gratuitously bounce it) and the decision is a genuine ship,
 * not an escalation.
 *
 * The positive counterpart to PIPE-reviewer-gates-on-tests: given a feature that
 * passed validation AND carries tests, the reviewer should ship.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';

export const PIPE_REVIEWER_SHIP_RETURN: PipelineScenario = {
  id: 'PIPE-reviewer-ship-return',
  version: 1,
  role: 'reviewer',
  description:
    'A validated feature WITH a passing test file should be shipped by the reviewer (status → passed), not returned or escalated.',
  setup: {
    feature: {
      id: 'F-REV-1',
      title: 'Slugify helper',
      spec: 'Add slugify(s) that lowercases, trims, and hyphenates. Edge: collapse repeats.',
      acceptance: ['slugify lowercases + hyphenates', 'repeated separators collapse'],
      status: 'validating',
    },
    files: [
      { path: 'src/slugify.ts', content: 'export const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n' },
      {
        path: 'src/slugify.test.ts',
        content:
          "import { test, expect } from 'vitest';\nimport { slugify } from './slugify';\n" +
          "test('lowercases + hyphenates', () => expect(slugify(' Hello World ')).toBe('hello-world'));\n" +
          "test('collapses repeats', () => expect(slugify('a   b')).toBe('a-b'));\n",
      },
    ],
  },
  asserts: [
    { kind: 'exit_code_is', expected: 0 },
    { kind: 'feature_status_is', expected: 'passed' },
    { kind: 'output_excludes', pattern: /\bESCALATE\b/ },
  ],
  rubric: {
    version: '1',
    axes: [
      {
        id: 'shipJudgment',
        description: 'Did the reviewer correctly SHIP a validated, tested feature without inventing a blocking reason?',
        anchors: {
          bad: 'Returns or escalates the feature despite it being validated + tested, citing a non-issue.',
          ideal: 'Ships it; any notes are advisory, not blocking.',
        },
      },
    ],
    criticality: 'normal',
  },
  caps: { maxWallSecs: 600, maxCostUsd: 1 },
};
