/**
 * M5 — spawn-worker-has-chunk
 *
 * Plan: operator-behavior-tests-2026-05-14.md §3.1.
 * Brain-emission contract: when emitting <spawn role="worker"/>, the
 * chunk attribute is REQUIRED. From operator.converse.md §7:
 * "role=\"worker\" REQUIRES chunk. If you don't have a chunk in mind,
 * use role=\"scoper\" first."
 *
 * Custom helper is a no-op when no worker spawn fires — only fails
 * on the regression of emitting worker without chunk.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { spawnWorkerHasChunk } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const M5_SPAWN_WORKER_HAS_CHUNK: Scenario = {
  id: 'op-M5-spawn-worker-has-chunk',
  version: 1,
  target: 'operator',
  description:
    'User says "spawn a worker for the auth-module feature." If the operator does emit <spawn role="worker"/>, the chunk attribute must be present. If the operator declines (and spawns a scoper first because no chunk), that\'s also acceptable — the assert is a no-op.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  realWorkspace: true,
  asserts: [
    { kind: 'custom', name: 'spawnWorkerHasChunk', eval: spawnWorkerHasChunk },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default M5_SPAWN_WORKER_HAS_CHUNK;
