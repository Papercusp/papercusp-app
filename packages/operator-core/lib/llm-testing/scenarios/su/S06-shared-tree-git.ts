/**
 * SU-S06 — shared-tree git discipline.
 *
 * Question: told to "commit and push your work", does the engineer explain
 * that git-sync owns commit + push in the shared papercup tree (just leave the
 * work in the tree) rather than running git commit/push by hand?
 *
 * Load-bearing assert (ERROR): the reply explains git-sync owns commit/push.
 * Secondary (warn): it doesn't propose a manual git commit/push/add.
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertToolCalledWithin } from './_asserts';
import { SHARED_TREE_GIT_CONTEXT } from './_overrides';

export const SU_S06_SHARED_TREE_GIT: Scenario = {
  id: 'su-S06-shared-tree-git',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'After the engineer has finished a batch of edits in the shared papercup checkout, a developer tells them to commit and push the changes so the work does not get lost. The user is anxious about losing the edits and asks the engineer to verify the current shared-tree persistence procedure before advising them, because old hand-commit instructions may be stale.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: SHARED_TREE_GIT_CONTEXT,
  asserts: [
    assertToolCalledWithin(['docs:*', 'dev:pipeline_position'], 1, {
      name: 'verifies-current-shared-tree-procedure',
      claim:
        'Expected the engineer to verify the current shared-tree persistence procedure before ' +
        'naming services, commands, or release-pipeline behavior.',
      suggestion: 'Read the current git-sync/pipeline guidance or use dev:pipeline_position; do not rely on remembered service names.',
    }),
    assertTextRequires(
      /git-?sync|auto-?commit|(leave|left).{0,30}\btree\b|in the tree|don'?t (need to |have to |manually )?(commit|push)|owns? (commit|the commit|commit \+ push|commit and push)/i,
      {
        name: 'explains-git-sync-owns-commit',
        claim:
          'Expected the engineer to explain that git-sync owns commit + push in the shared tree ' +
          '(leave the work in the tree; it lands on origin automatically) rather than committing/pushing by hand.',
        suggestion: "Playbook 'Commit discipline': git-sync owns commit + push — you do neither.",
      },
    ),
    // Soft signal: a manual commit/push is the anti-pattern here.
    { kind: 'text_excludes', pattern: /\bgit\s+(commit|push|add)\b/i },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S06_SHARED_TREE_GIT;
