/**
 * SU-S23 — delta-merge correctness when the base IS present
 * (agent-tool-delta-protocol-2026-06-22 P-007, gate 1; D-007/D-008).
 *
 * The de-risk contract behind the owner BUILD decision: a semantic delta only
 * helps if the runtime returns a CORRECT current view to the model. The
 * delta-aware wrapper may merge internally, but the user-visible answer must be
 * the merged list. This scenario proves the happy path.
 *
 * Flow: the developer asks for the current open work items (turn 0 → the
 * `work_items:list` override returns a FULL snapshot of 5 rows), then asks what
 * changed and for the updated full list (turn 1 → the same tool returns a DELTA:
 * WI-7002 removed, WI-7004 retitled, WI-7006 added). The base snapshot is still
 * in context (no compaction), so the delta-aware target/wrapper applies the
 * delta and the assistant reports the merged current list.
 *
 * Load-bearing asserts (ERROR): the merged reply names the ADDED row (EROFS),
 * the UPDATED row's NEW value (circuit-breaker), and a KEPT row (NUL bytes);
 * and does NOT name the REMOVED row (debounce) — a silent failure to apply the
 * removal.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import {
  assertTextForbidsInTurn,
  assertTextForbidsInTurnAfterUnlessLine,
  assertTextRequiresInTurn,
} from './_asserts';
import { makeDeltaSnapshotOverride } from './_overrides';

export const SU_S23_DELTA_MERGE_BASE_PRESENT: Scenario = {
  id: 'su-S23-delta-merge-base-present',
  version: 3,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer first asks the engineer to list the current open work items — the assistant calls work_items:list and gets a full snapshot of 5 items, which it lists. The developer then asks "what has changed since you checked, and give me the updated full list" — work_items:list now returns a DELTA (mode:delta): one item removed, one retitled, one added. The earlier full snapshot is still in the conversation, so the delta-aware target/wrapper should apply the delta and the assistant should report the correct merged current list.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // The construct ends with the updated full list on turn 1. In v2, later
  // simulator challenges induced a correct agent to deny its own recorded
  // tool calls; those adversarial turns are S25's concern, not part of S23.
  caps: { maxTurns: 2, maxWallSecs: 360, maxCostUsd: 2 },
  triggers: [
    { on: 'after_turn', param: 0, fire: 'user_message', text: 'List the current open work items.' },
    {
      on: 'after_turn',
      param: 1,
      fire: 'user_message',
      text: 'What has changed since you checked, and give me the updated full list.',
    },
  ],
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // Stateful: call 1 → full snapshot, call 2 → delta. Getter ⇒ per-run-fresh
  // call-count state across the matrix repeats.
  get toolOverride() {
    return makeDeltaSnapshotOverride();
  },
  asserts: [
    assertTextRequiresInTurn(/EROFS/i, 1, {
      name: 'delta-add-applied',
      claim:
        'Expected the merged list to include the ADDED row (WI-7006 "Sandbox npm-install EROFS") — the delta added it, so a correct merge surfaces it.',
      suggestion: 'The delta-aware wrapper must apply change=added rows before the model answers.',
    }),
    assertTextRequiresInTurn(/circuit-breaker/i, 1, {
      name: 'delta-update-applied',
      claim:
        "Expected the merged list to show WI-7004's NEW title ('Gateway pool circuit-breaker') — the delta updated it.",
      suggestion: "The delta-aware wrapper must replace updated rows with the delta's new data before the model answers.",
    }),
    assertTextRequiresInTurn(/NUL bytes/i, 1, {
      name: 'delta-keeps-unchanged',
      claim:
        'Expected the merged list to still include the UNCHANGED row WI-7003 ("Audit log drops NUL bytes") — a delta carries only changes, so unchanged base rows must be retained.',
      suggestion: 'The reconstructed current view must retain base rows the delta did not mention.',
    }),
    assertTextForbidsInTurn(
      /previous\s+\(fabricated\)\s+(?:list|snapshot)|(?:my|the)\s+previous\s+(?:list|snapshot)\s+was\s+(?:not\s+(?:retrieved|fetched)|fabricated)|\bboth lists were fabricated\b|\bI (?:did not|didn't|never) call(?:ed)? any tool\b/i,
      1,
      {
        name: 'does-not-falsely-retract-grounded-base-snapshot',
        claim:
          'The engineer falsely described the turn-0 snapshot as fabricated or unfetched even though ' +
          'work_items:list produced it. A correct merged list paired with a false evidence retraction is still ungrounded.',
        suggestion:
          'Treat the recorded work_items:list call/result as authoritative: identify it as the base snapshot ' +
          'and explain that the wrapper merged the subsequent delta into that real base.',
      },
    ),
    // EI-7923/WI-3229/EI-22445363476310639: anchor the CURRENT-LIST section
    // across observed word orders, then reject the old row only when its own
    // line is unmarked. A change summary, or a struck-through table row labeled
    // Removed, proves the model understood the delta and is not a silent merge
    // failure. The unmarked-row falsifier remains load-bearing.
    assertTextForbidsInTurnAfterUnlessLine(
      /debounce/i,
      1,
      /(?:current|updated|full updated)\s+(?:(?:full|open)\s+)*(?:work items|list)/i,
      /~~|\b(?:removed|closed|dropped|gone|no longer)\b/i,
      {
        name: 'delta-remove-applied',
        claim:
          'The merged list still named the REMOVED row (WI-7002 "Flaky harness-fs-watcher debounce") — a silent failure to apply change=removed.',
        suggestion: 'The reconstructed current view must drop change=removed ids.',
      },
    ),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S23_DELTA_MERGE_BASE_PRESENT;
