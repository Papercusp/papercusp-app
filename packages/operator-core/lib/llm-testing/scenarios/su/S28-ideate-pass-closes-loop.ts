/**
 * SU-S28 — IDEATE mode runs a CLOSED pass: GROUND → file lens-tagged → CLOSE with a tick.
 * (su-ideate-learning-substrate-2026-07-10 P-015, the IDEATE mode-battery.)
 *
 * The behavioral leg of the su closed-loop ideate ritual spliced into the IDEATE contract by
 * P-014 (modes/registry.ts + operating-modes-policy.ts full tier). The contract test
 * (store.test.ts / operating-modes-policy.test.ts) asserts the ritual is IN the rendered
 * contract; THIS asserts the agent BEHAVES on it when it runs a pass.
 *
 * A blank-page pass invents in a vacuum, files, and never grounds or closes — the exact failure
 * the loop closes. SUCCESS = the agent (a) GROUNDS on blender:ideation-feedback (which surfaces
 * prior art — prior graded ideas + outcomes + per-lens win-rates), (b) FILES a lens-tagged feature
 * (improvements:capture kind:'feature' with ideation.lens set), and (c) CLOSES the pass with a
 * ledgered tick (blender:ideate-pass-record). FAILURE = it files an idea with no grounding read
 * and/or never records the tick (an OPEN loop — nothing for the next pass to ground on).
 *
 * Load-bearing asserts (ERROR): ideation-feedback fired (grounded on prior art), a lens-tagged
 * feature was captured, and a pass tick was recorded. The world is a mocked in-process tool
 * surface (the mode-battery pattern, S27); fixture priming rows are FENCED ([SU-IDEATE-FIXTURE]),
 * never real work.
 */
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch, effectiveToolCall } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic world: an su in IDEATE mode, overdue for a pass. The grounding read returns
 *  FENCED prior-art priming + per-lens win-rates; the file/route/close verbs all succeed. Nothing
 *  here dictates the ritual — the agent must run GROUND → file lens-tagged → CLOSE from its
 *  IDEATE contract. */
const IDEATE_WORLD: ToolDispatchOverride = {
  override(name) {
    const canon = canonical(name);
    if (canon === 'coord:orient') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              modes: { active: [{ mode: 'ideate', ownerDirected: false }] },
              // P-011 overdue fold: enough unmined observations accumulated that a pass is due.
              ideate: { overdue: true, observationsSinceLastPass: 14, threshold: 10 },
              me: { summary: { claims: 0, work_item_load: 0 } },
              claimable: [],
              inbox: { summary: { total: 0, returned: 0 }, recent: [] },
              intentDeclared: true,
            }),
          },
        ],
      };
    }
    // GROUND: the composite grounding read. Surfaces PRIOR ART (prior graded su ideas + their
    // outcomes) + per-lens win-rates + a federated frontier read — the reads a blank page cannot do.
    if (canon === 'blender:ideation-feedback') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              priming:
                'Prior art (graded su-ideate ideas): [SU-IDEATE-FIXTURE] "cache the corpus digest" graded 2 ' +
                '(critique: re-derives the same digest every pass — no invalidation story); ' +
                '[SU-IDEATE-FIXTURE] "lens-rotation nudge" graded 4 (won: lifted lens diversity).',
              outcomes: [
                { ref: 'wi:EI-FIXT-1', title: '[SU-IDEATE-FIXTURE] lens-rotation nudge', verdict: 'won', lens: 'first-principles' },
                { ref: 'plan:fixt-corpus-cache', title: '[SU-IDEATE-FIXTURE] cache the corpus digest', verdict: 'lost', lens: 'cost-leverage' },
              ],
              lensWinRates: [
                { lens: 'first-principles', wins: 3, losses: 1, rate: 0.75 },
                { lens: 'risk-first', wins: 1, losses: 0, rate: 1.0 },
                { lens: 'cost-leverage', wins: 0, losses: 2, rate: 0.0 },
              ],
              federated: { foreignElites: [], crowdedNiches: ['corpus-digest-caching'], emptyNiches: ['observation-yield-metrics'] },
            }),
          },
        ],
      };
    }
    // FILE + ROUTE + CLOSE — all succeed (the agent SHOULD reach these this pass).
    if (canon === 'improvements:capture') {
      return { content: [{ text: JSON.stringify({ ok: true, id: 'EI-9028', workItem: 'EI-9028' }) }] };
    }
    if (canon === 'blender:route-idea') {
      return { content: [{ text: JSON.stringify({ ok: true, rail: 'plan', planSlug: 'draft-observation-yield-metrics-2026-07-11' }) }] };
    }
    if (canon === 'blender:ideate-pass-record') {
      return { content: [{ text: JSON.stringify({ ok: true, tick: { origin: 'su-ideate', ideasFiled: 1 } }) }] };
    }
    if (canon === 'improvements:list' || canon === 'work_items:list' || canon === 'plans:get') {
      return { content: [{ text: JSON.stringify({ ok: true, items: [] }) }] };
    }
    return PASS_THROUGH;
  },
};

/** improvements:capture kind:'feature' carrying a non-empty ideation.lens (the lens-tag). */
function isLensTaggedFeatureCapture(tc: ToolCallEvent): boolean {
  // Read through a `tools:invoke` dispatch: filing via that door is still a filing.
  const { name, input } = effectiveToolCall(tc);
  if (name !== 'improvements:capture') return false;
  if (input.kind !== 'feature') return false;
  const ideation = input?.ideation as Record<string, unknown> | null | undefined;
  const lens = ideation?.lens;
  return typeof lens === 'string' && lens.trim().length > 0;
}

export const SU_S28_IDEATE_PASS_CLOSES_LOOP: Scenario = {
  id: 'su-S28-ideate-pass-closes-loop',
  // The world claims IDEATE is active (orient fixture above); bind its definition layer so the
  // SUT sees the prompt a real IDEATE session sees (EI-23996297775579005).
  targetConfig: { modes: ['ideate'] },
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The su engineer is in IDEATE mode and overdue for a pass. SUCCESS: it runs the CLOSED-LOOP ' +
    'ritual — (1) GROUNDS on blender:ideation-feedback, which surfaces PRIOR ART (prior graded su ideas ' +
    '+ their won/lost outcomes + per-lens win-rates + a federated frontier read) rather than inventing ' +
    'on a blank page; (2) FILES a lens-tagged feature via improvements:capture { kind:"feature", ' +
    'ideation:{ lens, bet? } } (the lens it ran, tagged on the row); and (3) CLOSES the pass with a ' +
    'ledgered tick via blender:ideate-pass-record so the next pass has something to ground on. ' +
    'FAILURE: a blank-page pass that files an idea with NO grounding read, or files but never records ' +
    'the tick (an OPEN loop that forfeits the priming the next pass reads back). Reward grounding on ' +
    'prior art, filing lens-tagged, and closing the tick; penalize inventing in a vacuum or leaving the ' +
    'loop open.',
  persona: {
    id: 'ideate-pass-prompter',
    description:
      'An owner/coordinator who tells the su it is in IDEATE mode and overdue, and to run a pass on the ' +
      'observation backlog. Terse; it names the mode and the area but never tells the agent WHICH tools ' +
      'to ground / file / close with — that ritual must come from the agent.',
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
  toolOverride: IDEATE_WORLD,
  asserts: [
    // Grounding and closing read through tools:invoke too (effectiveToolCall): the 07:16 run on
    // 2026-09-22 grounded via tools:invoke and was scored "never called" (WI-10002486).
    assertToolMatch((tc) => effectiveToolCall(tc).name === 'blender:ideation-feedback', {
      name: 'grounds-on-prior-art',
      claim:
        'The IDEATE pass never called blender:ideation-feedback — it invented on a blank page instead of ' +
        'grounding on prior art (prior graded ideas + outcomes + per-lens win-rates). The loop is only ' +
        'a loop because each pass grounds on the last one.',
      suggestion:
        'Open every IDEATE pass with blender:ideation-feedback: read the grades/outcomes/lensWinRates/' +
        'federated priming before choosing a lens and filing.',
    }),
    assertToolMatch(isLensTaggedFeatureCapture, {
      name: 'files-a-lens-tagged-feature',
      claim:
        'The pass never filed a lens-tagged feature — no improvements:capture { kind:"feature", ' +
        'ideation:{ lens } } fired. A pass with no lens-tagged filing produces no attributable idea for ' +
        'the per-lens win-rate learning to credit.',
      suggestion:
        "File the idea with improvements:capture { kind:'feature', ideation:{ lens:<the lens you ran>, " +
        'bet? } } so the row is attributable to the lens that produced it.',
    }),
    assertToolMatch((tc) => effectiveToolCall(tc).name === 'blender:ideate-pass-record', {
      name: 'closes-the-pass-with-a-tick',
      claim:
        'The pass filed ideas but never recorded a tick (no blender:ideate-pass-record) — an OPEN loop. ' +
        'Without the tick the pass leaves no trace, and the next pass has nothing to ground on.',
      suggestion:
        'Close every pass with blender:ideate-pass-record { ideasFiled, observationsMined? } — the ' +
        'ledgered tick that makes the loop measurable.',
    }),
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S28_IDEATE_PASS_CLOSES_LOOP;
