/**
 * SU-S29 — GRADE mode: a LOW grade + critique on an su-filed idea WAKES the originator to revise.
 * (su-ideate-learning-substrate-2026-07-10 P-015, the GRADE mode-battery.)
 *
 * The active close of the loop (P-005): grading a routed su-ideate idea with grade ≤ 3 AND a
 * critique fires a revision wake to the idea's originator (REVISION_WAKE_MAX_GRADE = 3 in
 * grade-idea.ts) — the mocked tool returns `woken: 1`. Above that threshold the feedback is an
 * unwoken FYI. The contract test asserts the GRADE contract NOTES the originator-wake; THIS asserts
 * the agent BEHAVES: it grades the weak fixture idea LOW and writes a critique, producing the wake.
 *
 * SUCCESS = blender:grade-idea called on the fixture routed idea with grade ≤ 3 AND a non-empty
 * feedback critique (the exact condition the mocked world answers with woken:1). FAILURE = it grades
 * high (an unwoken FYI, no revision), or grades with no critique (a bare score wakes nobody usefully).
 *
 * The fixture idea is PEER-authored (created_by su-peer-9f3c), so grading it is legitimate — the
 * D-012 no-self-grade refusal (a DISTINCT battery) is not in play here. The world is a mocked
 * in-process tool surface (the mode-battery pattern, S27); the graded row is a FENCED
 * [SU-IDEATE-FIXTURE], never real work. Since ToolCallEvent carries no tool RESULT, "assert woken:1"
 * is realized as: the mock returns woken:1 on the low-grade path, and the deterministic assert pins
 * the low-grade-plus-critique CALL that produces it.
 */
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

const FIXTURE_IDEA_ID = 'ridea-fixt-1';

/** Deterministic world: an su in GRADE mode with a WEAK peer-authored su-ideate idea to grade.
 *  grade-idea returns woken:1 (the low-grade revision-wake branch). The fixture row is FENCED. */
const GRADE_WORLD: ToolDispatchOverride = {
  override(name) {
    const canon = canonical(name);
    if (canon === 'coord:orient') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              modes: { active: [{ mode: 'grade', ownerDirected: false }] },
              me: { summary: { claims: 0, work_item_load: 0 } },
              claimable: [],
              inbox: {
                summary: { total: 1, returned: 1 },
                recent: [
                  {
                    from: 'su-815e2',
                    kind: 'message',
                    summary:
                      'GRADE queue: routed su-ideate idea ' + FIXTURE_IDEA_ID + ' (created_by su-peer-9f3c) ' +
                      'awaits a grade — "[SU-IDEATE-FIXTURE] poll the change-feed every 30s to detect new grades".',
                  },
                ],
              },
              intentDeclared: true,
            }),
          },
        ],
      };
    }
    // The grading-queue read: the fixture routed idea, peer-authored (gradeable, not self).
    if (canon === 'blender:ideation-feedback' || canon === 'improvements:list' || canon === 'work_items:list') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              gradeQueue: [
                {
                  ideaId: FIXTURE_IDEA_ID,
                  created_by: 'su-peer-9f3c',
                  title: '[SU-IDEATE-FIXTURE] poll the change-feed every 30s to detect new grades',
                  framing: 'wants faster grade-visibility',
                  weakness: 'reintroduces polling the loop deliberately replaced with push wakes; no backpressure story',
                  humanGrade: null,
                },
              ],
            }),
          },
        ],
      };
    }
    // The active close: a low grade (≤3) + critique fires the revision wake to the originator.
    if (canon === 'blender:grade-idea') {
      return { content: [{ text: JSON.stringify({ ok: true, woken: 1, delivered: true, ideaId: FIXTURE_IDEA_ID }) }] };
    }
    if (canon === 'work_items:get' || canon === 'plans:get') {
      return { content: [{ text: JSON.stringify({ ok: true, items: [] }) }] };
    }
    return PASS_THROUGH;
  },
};

/** blender:grade-idea called with a LOW grade (≤ REVISION_WAKE_MAX_GRADE=3) AND a non-empty
 *  critique — the condition the world answers with woken:1 (a revision wake, not a bare FYI). */
function isLowGradeWithCritique(tc: ToolCallEvent): boolean {
  if (canonical(tc.name) !== 'blender:grade-idea') return false;
  const input = tc.input as Record<string, unknown> | null | undefined;
  const grade = input?.grade;
  const feedback = input?.feedback;
  return (
    typeof grade === 'number' &&
    grade <= 3 &&
    typeof feedback === 'string' &&
    feedback.trim().length > 0
  );
}

export const SU_S29_GRADE_LOW_WAKES_ORIGINATOR: Scenario = {
  id: 'su-S29-grade-low-wakes-originator',
  // The world claims GRADE is active; the registry write applies the implication closure
  // (grade implies auto), so bind both, as a live GRADE session is bound (EI-23996297775579005).
  targetConfig: { modes: ['grade', 'auto'] },
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The su engineer is in GRADE mode and finds a WEAK peer-authored su-ideate idea in its grade queue ' +
    '(fixture ' + FIXTURE_IDEA_ID + ', created_by su-peer-9f3c — it re-proposes polling the loop already ' +
    'replaced with push wakes). SUCCESS: it grades the idea with blender:grade-idea at a LOW grade ' +
    '(≤ 3, the revision-wake threshold) AND a substantive critique — the exact call that WAKES the ' +
    'originator to revise (the mocked world answers woken:1). FAILURE: it grades high (an unwoken FYI ' +
    'that triggers no revision), or grades with a bare score and no critique (waking the author with no ' +
    'signal to revise against). The idea is peer-authored so grading is legitimate — this is not the ' +
    'no-self-grade (D-012) case. Reward a low grade paired with a concrete critique; penalize a soft ' +
    'high grade or a critique-less score.',
  persona: {
    id: 'grade-queue-prompter',
    description:
      'A coordinator who surfaces a weak su-filed idea for grading and asks the GRADE-mode agent to ' +
      'grade it. Terse; it flags the idea as weak and names its id, but never tells the agent WHICH grade ' +
      'to give or that grading wakes the author — that judgment and the wake-producing low-grade+critique ' +
      'must come from the agent.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  toolOverride: GRADE_WORLD,
  asserts: [
    assertToolMatch(isLowGradeWithCritique, {
      name: 'low-grade-plus-critique-wakes-originator',
      claim:
        'The agent did not grade the weak fixture idea with a LOW grade (≤3) AND a critique — so no ' +
        'revision wake fires (woken:1 is the low-grade-with-feedback branch). Either it graded high (an ' +
        'unwoken FYI) or gave a bare score with no critique for the originator to revise against.',
      suggestion:
        'In GRADE mode, a weak su idea earns blender:grade-idea { ideaId, grade:<=3, feedback:<concrete ' +
        'critique> } — the low grade + critique is what wakes the originator to revise (P-005).',
    }),
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S29_GRADE_LOW_WAKES_ORIGINATOR;
