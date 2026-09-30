/**
 * PIPE-scoper-chunking (P-020) — the scoper breaks a multi-part feature into
 * worker-sized chunks rather than one undifferentiated blob.
 *
 * Judge-scored behavioral scenario; runs on-demand against a real scoper
 * invoke-once (model credentials required). The deterministic guards only
 * assert the role ran and emitted a chunking decision.
 */
import type { PipelineScenario } from '@papercusp/testing-shell/llm';

export const PIPE_SCOPER_CHUNKING: PipelineScenario = {
  id: 'PIPE-scoper-chunking',
  version: 1,
  role: 'scoper',
  description:
    'A feature spanning three independent surfaces (API route + DB migration + UI panel) should be chunked into separate, individually-shippable units — not one chunk, and not chunks that straddle unrelated surfaces.',
  setup: {
    feature: {
      id: 'F-SCOPE-1',
      title: 'Add a saved-searches feature',
      spec:
        'Users can save a search. Needs: (1) a `saved_searches` table + migration, ' +
        '(2) a POST /api/saved-searches route to create one, (3) a "Saved" panel in the ' +
        'search UI listing them. Each part is independently testable.',
      acceptance: [
        'A migration creates the saved_searches table',
        'POST /api/saved-searches persists a row',
        'The Saved panel renders the current user’s saved searches',
      ],
      status: 'todo',
    },
  },
  asserts: [
    { kind: 'exit_code_is', expected: 0 },
    { kind: 'output_excludes', pattern: /\bESCALATE\b/ },
  ],
  rubric: {
    version: '1',
    axes: [
      {
        id: 'chunkGranularity',
        description: 'Did the scoper split the work along the three natural seams (migration / route / UI) into separately-shippable chunks?',
        anchors: {
          bad: 'One mega-chunk for the whole feature, or chunks that mix unrelated surfaces (e.g. migration + UI in one).',
          ideal: 'Roughly one chunk per independent surface, each with a clear, self-contained deliverable a single worker can finish and verify.',
        },
      },
      {
        id: 'specCoverage',
        description: 'Do the chunks together cover every acceptance criterion with nothing dropped or invented?',
        anchors: {
          bad: 'A criterion (e.g. the UI panel) has no chunk, or a chunk adds scope the spec never asked for.',
          ideal: 'Every acceptance criterion maps to exactly one chunk; no extra scope.',
        },
      },
    ],
    criticality: 'normal',
  },
  caps: { maxWallSecs: 600, maxCostUsd: 1 },
};
