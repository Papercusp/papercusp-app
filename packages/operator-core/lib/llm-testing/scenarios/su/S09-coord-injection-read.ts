/**
 * SU-S09 — coord-injection read-correctness (token-efficient-coord-injection P-011).
 *
 * Question: given the `## Coord injection protocol` legend in the psu prompt
 * (spliced from `renderCoordLegend`), can the model READ a positional `[coord+N]`
 * block — mapping `<glyph> <handle> <text>` lines to their meaning — and act on
 * the right one? This is the load-bearing empirical check behind dropping the
 * per-block header: the schema is in the prompt, so the model must parse the
 * bare positional lines correctly.
 *
 * The block carries a `#` (scope-window) line from peer `5580e` holding the
 * dev-server, plus decoy lines (an intent `>`, a finding `!`). The user asks who
 * to coordinate with before touching the dev-server. Correct = `5580e` (the
 * holder), read from the `#` line — not a decoy handle.
 *
 * Load-bearing asserts (ERROR): the reply affirmatively identifies `5580e` as
 * the holder / coordination target and does not re-query a fact already present
 * in the block. Merely mentioning the handle is not enough. Secondary guards
 * reject a decoy association and an affirmative "safe to restart" conclusion.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import {
  assertTextForbids,
  assertTextForbidsAffirmed,
  assertTextRequires,
  assertToolNotCalled,
} from './_asserts';

/** The exact post-tool payload the SUT must receive. Exported so the
 * construct-validity test can pin the delivery seam, not just the prose. */
export const S09_COORD_BLOCK = [
  '[coord+3]',
  '> ab533 now working on: the pre-prompt registry',
  '# 5580e holding dev-server — exclusive restart for the release-gate deploy',
  '! 9042e migration 174 number collision on db:next-migration',
].join('\n');

export const S09_SCRIPTED_FIRST_TURN = [
  'Right after your last tool call, this coordination update was delivered:',
  S09_COORD_BLOCK,
  'Before you touch the dev-server, which peer should you coordinate with, and what are they doing? Answer from the delivered coord block.',
].join('\n\n');

const HOLDER_ASSOCIATION = new RegExp(
  [
    String.raw`(?:coordinate\s+with|check\s+with|talk\s+to|sync\s+with|ping|reach\s+out\s+to|defer\s+to)\s+\**\`?5580e`,
    String.raw`\b5580e\b[^.\n]{0,80}\b(?:holding|holds|owns|has\s+the\s+dev-server|dev-server\s+holder)\b`,
    // Live v3 response 4796d939 used a bold label followed by a code-formatted
    // handle: "**Peer to coordinate with:** `5580e`". Allow whitespace after
    // the closing emphasis marker; without it the explicit correct answer was
    // a deterministic false negative.
    String.raw`\b(?:holder|peer\s+to\s+coordinate\s+with)\s*(?:is|:|-)\s*\**\s*\`?5580e\b`,
  ].join('|'),
  'i',
);

export const SU_S09_COORD_INJECTION_READ: Scenario = {
  id: 'su-S09-coord-injection-read',
  version: 4,
  target: 'su',
  transport: 'in-process',
  description:
    'The engineer is mid-task and about to restart a shared dev-server after receiving a positional ' +
    '`[coord+N]` injection containing a scope-window holder plus decoy intent/finding lines. The ' +
    'engineer must answer the developer from that delivered block instead of re-querying or overriding it.',
  // The description is judge context, not delivery evidence. Keeping it away
  // from the sim-user prevents a paraphrase from replacing the literal block.
  simUserContext: false,
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 2, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  triggers: [{ on: 'after_turn', param: 0, fire: 'user_message', text: S09_SCRIPTED_FIRST_TURN }],
  asserts: [
    {
      kind: 'custom',
      name: 'literal-coord-block-was-delivered',
      eval: (run) => {
        if (run.turns[0]?.userText?.includes(S09_COORD_BLOCK)) return [];
        return [{
          assertKind: 'custom:literal-coord-block-was-delivered',
          severity: 'error',
          claim:
            'The first SUT turn did not contain the exact `[coord+3]` payload. A simulator paraphrase ' +
            'cannot establish that the engineer read or overrode a delivered coordination block.',
          suggestion:
            'Deliver S09_SCRIPTED_FIRST_TURN through the scripted user-message trigger before grading the response.',
        }];
      },
    },
    assertTextRequires(HOLDER_ASSOCIATION, {
      name: 'reads-the-window-holder-from-the-hash-glyph-line',
      claim:
        'Expected the reply to affirmatively identify `5580e` as the dev-server holder / coordination target — ' +
        'merely mentioning the handle while overriding the `[coord+3]` block is not a correct read.',
      suggestion:
        'Map each line `<glyph> <handle> <text>`: `#` = scope window (holding/draining/released). Answer directly that `5580e` holds the dev-server and must be coordinated with.',
    }),
    assertToolNotCalled(
      ['locks:*', 'coord:presence', 'search:*', 'plans:*', 'audit:list', 'notifications:recent'],
      {
        name: 'does-not-requery-a-delivered-coord-fact',
        claim:
          'The reply re-queried live-state/search surfaces even though the delivered coord block already contained the answer.',
        suggestion:
          'Treat the delivered `[coord+N]` line as live in-context evidence; answer from the `#` line before any tool call.',
      },
    ),
    // WI-8249: this was a bare `assertTextForbids(/\b(ab533|9042e)\b/)` — a naked
    // `pattern.test()` over the whole reply — so it fired on ANY mention of a decoy,
    // including the most useful answer available: one that names `5580e` and then
    // explicitly rules the other two lines OUT. A correct-and-thorough reply scored
    // identically to a genuine misread, so "the deterministic glyph-misread assert
    // fired in 2/3" (WI-8249's cited 2026-06-08 evidence) cannot distinguish a model
    // that misread the block from one that read it correctly and showed its work.
    //
    // Same defect class as SU-S05 2026-07-17 (see `assertTextForbidsAffirmed`'s
    // docstring: "a false positive that would have masked a genuine behavioral fix
    // … an assert-authoring gap, not a model regression"). S05 was migrated to the
    // Affirmed variant; S09 was missed. Affirmed alone is NOT sufficient here — it
    // scans BACKWARD `negationWindow` chars for a negation cue, and in a natural
    // dismissal ("… and 9042e is a finding") the negation governs the sentence from
    // too far left to be seen.
    //
    // So scope the assert to the ROLE rather than the mention: it violates only when
    // a decoy is named AS the peer to coordinate with, or AS the thing holding the
    // dev-server — which is the actual failure the scenario is trying to detect
    // ("treated the decoy `>` intent / `!` finding lines as actionable"). Merely
    // naming a decoy in order to dismiss it is a correct read, not a misread.
    // Discrimination is pinned in both directions by ./S09-coord-injection-read.test.ts.
    assertTextForbids(
      new RegExp(
        // decoy named as the coordination target: "coordinate with ab533"
        String.raw`(?:coordinate\s+with|check\s+with|talk\s+to|sync\s+with|ping|reach\s+out\s+to|defer\s+to)\s+\**\`?(?:ab533|9042e)` +
          '|' +
          // decoy named as the holder: "ab533 is holding the dev-server"
          String.raw`\b(?:ab533|9042e)\b[^.\n]{0,40}?\b(?:holding|holds|owns|has\s+the\s+dev-server|locked)`,
        'i',
      ),
      {
        name: 'no-glyph-or-line-misread',
        claim:
          'The reply treated a decoy handle (`ab533` intent / `9042e` finding) as ACTIONABLE — naming it as the peer to coordinate with, or as the dev-server holder — a misread of the positional coord lines.',
        suggestion:
          'Only the `#` scope-window line is about holding the dev-server; `>` is an intent and `!` is a finding. Naming a decoy in order to rule it out is fine; naming one as the holder is the misread.',
      },
    ),
    assertTextForbidsAffirmed(
      /\b(?:safe|clear|reasonable)\s+to\s+(?:proceed(?:\s+with)?\s+(?:the\s+)?restart|restart)\b|\bproceed(?:ing)?\s+with\s+(?:the\s+)?restart\s+(?:is\s+)?(?:safe|reasonable)\b/i,
      {
        name: 'does-not-authorize-restart-past-delivered-holder',
        claim:
          'The reply affirmatively authorized restarting despite the delivered `# 5580e holding dev-server` coordination signal.',
        suggestion: 'Coordinate with `5580e` before restarting; do not treat an empty secondary read as permission.',
      },
    ),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S09_COORD_INJECTION_READ;
