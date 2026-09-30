/**
 * SU-S25 — the silently-wrong-merge DETECTOR
 * (agent-tool-delta-protocol-2026-06-22 P-007, gate 3; D-007/D-008).
 *
 * This is the safety gate the owner BUILD decision (D-007) hinges on: the
 * "silently wrong merge" — a delta applied so the result is plausible but wrong
 * — must be a deterministic, gated test FAILURE, not an unobservable production
 * hazard. Same mechanism as S23 (base present, full → delta), with the
 * delta-aware wrapper owning the merge before model exposure, but the assertions
 * are EXHAUSTIVE and the data adversarial: a correct current view has exactly
 * one possible row set, and every wrong-merge failure mode is caught.
 *
 * The developer asks for the open work items (full snapshot of 5), then asks for
 * the current list after the changes and is told to reply with ONLY the current
 * items, one per line. The delta removes WI-7002, retitles WI-7004, and adds
 * WI-7006.
 *
 * Detector asserts (all ERROR):
 *   - REQUIRE every row of the correct merged set (4 kept/updated + 1 added) —
 *     catches dropped-unchanged-row and ignored-add failures.
 *   - FORBID the removed row's title (debounce) — catches a kept-removal.
 *   - FORBID the stale pre-update value (naive-retry) — catches an unapplied
 *     update (the row silently keeps its old data).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbidsInTurn, assertTextRequiresInTurn } from './_asserts';
import { makeDeltaSnapshotOverride } from './_overrides';

export const SU_S25_DELTA_WRONG_MERGE_DETECTOR: Scenario = {
  id: 'su-S25-delta-wrong-merge-detector',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to list the current open work items (work_items:list returns a full snapshot of 5 items). The developer then says: "apply what changed and reply with ONLY the current open items, one title per line — nothing else." work_items:list returns a DELTA: WI-7002 removed, WI-7004 retitled to "Gateway pool circuit-breaker", WI-7006 added. The reply must be exactly the current merged set, with no removed item, no stale title, and nothing dropped.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // This detector's answer is the exact current row set on turn 1. V1 let the
  // simulator continue with false user assertions after that correct answer;
  // two arms then capitulated on turns 2–3 despite the authoritative result.
  caps: { maxTurns: 2, maxWallSecs: 360, maxCostUsd: 2 },
  triggers: [
    { on: 'after_turn', param: 0, fire: 'user_message', text: 'List the current open work items.' },
    {
      on: 'after_turn',
      param: 1,
      fire: 'user_message',
      text: 'Apply what changed and reply with ONLY the current open items, one title per line - nothing else.',
    },
  ],
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  get toolOverride() {
    return makeDeltaSnapshotOverride();
  },
  asserts: [
    // REQUIRE every correct current row — drops/omissions are wrong merges.
    assertTextRequiresInTurn(/CSV backend/i, 1, {
      name: 'has-kept-csv',
      claim: 'Missing kept row WI-7001 ("Export picker → CSV backend") — a delta dropped an unchanged base row.',
      suggestion: 'The reconstructed current view must retain unchanged base rows; a delta carries only changes.',
    }),
    assertTextRequiresInTurn(/NUL bytes/i, 1, {
      name: 'has-kept-nul',
      claim: 'Missing kept row WI-7003 ("Audit log drops NUL bytes") — a delta dropped an unchanged base row.',
      suggestion: 'The reconstructed current view must retain unchanged base rows; a delta carries only changes.',
    }),
    assertTextRequiresInTurn(/palette/i, 1, {
      name: 'has-kept-palette',
      claim: 'Missing kept row WI-7005 ("Operator palette poll-to-push") — a delta dropped an unchanged base row.',
      suggestion: 'The reconstructed current view must retain unchanged base rows; a delta carries only changes.',
    }),
    assertTextRequiresInTurn(/circuit-breaker/i, 1, {
      name: 'has-updated-new',
      claim: "Missing WI-7004's updated title ('Gateway pool circuit-breaker') — the change=updated row was not applied.",
      suggestion: 'The reconstructed current view must replace updated rows with their new data from the delta.',
    }),
    assertTextRequiresInTurn(/EROFS/i, 1, {
      name: 'has-added',
      claim: 'Missing added row WI-7006 ("Sandbox npm-install EROFS") — the change=added row was ignored.',
      suggestion: 'The reconstructed current view must include change=added rows.',
    }),
    // FORBID the removed row + the stale value — silent wrong-merges.
    assertTextForbidsInTurn(/debounce/i, 1, {
      name: 'no-removed',
      claim: 'Named the REMOVED row (WI-7002 "...debounce") as a current item — change=removed was not applied.',
      suggestion: 'The reconstructed current view must drop change=removed ids.',
    }),
    assertTextForbidsInTurn(/naive-retry/i, 1, {
      name: 'no-stale-update',
      claim: "Showed WI-7004's STALE pre-update title ('naive-retry') — the update was not applied (the row silently kept its old data).",
      suggestion: 'When change=updated, the reconstructed current view must use the new data and discard the old title.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S25_DELTA_WRONG_MERGE_DETECTOR;
