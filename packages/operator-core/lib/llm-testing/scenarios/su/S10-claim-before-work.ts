/**
 * SU-S10 — claim-before-work (claim-discipline-enforcement-2026-06-10 P-006).
 *
 * Question: when handed a concrete plan-execution task ("implement P-002 and
 * P-003 of plan X"), does the engineer CLAIM the complete requested lane before
 * working — including a dependent item that must remain visibly blocked — rather
 * than claiming only the first item or diving into edits with prose intent?
 *
 * Load-bearing assert (ERROR): every requested item is present in the aggregate
 * claim — through coord:orient/declare-intent, plans:set-status wip, or
 * plan_items:claim/convert. Secondary (warn): the reply doesn't describe its
 * lane purely in prose ("I'll take P-002 and P-003" with no structured claim).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertRequestedPlanItemsClaimed } from './_asserts';
import { WIDGET_EXPORT_PLAN } from './_overrides';

export const SU_S10_CLAIM_BEFORE_WORK: Scenario = {
  id: 'su-S10-claim-before-work',
  version: 2,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to pick up and implement items P-002 and P-003 of the plan "widget-export-2026-06-01" (papercup harness) — concrete, already-scoped plan items; P-003 is visibly blocked by P-002 but must remain claimed and represented to the fleet.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // Canned plan payload + claim confirmations: without them the SUT is starved
  // by benign stubs and the judge red is stub-coping, not the discipline
  // under test (EI-133 class — seen verbatim in the 2026-06-10 matrix run).
  toolOverride: WIDGET_EXPORT_PLAN,
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertRequestedPlanItemsClaimed('widget-export-2026-06-01', ['P-002', 'P-003'], {
      name: 'claims-requested-lane-before-working',
      claim:
        'Expected the engineer to CLAIM every requested plan item before working — use coord:orient/declare-intent with both item IDs, plans:set-status wip for each item, or plan_items:claim/convert for each item. A dependent item must stay visible as blocked rather than being silently omitted.',
      suggestion:
        "Claim the complete requested lane with the exact plan identity: coord:declare-intent { current_plan_slug: 'widget-export-2026-06-01', items: ['P-002', 'P-003'] }, plan_items:claim/convert with both items, or wip-flip each item before editing.",
    }),
    // Soft signal: a prose-only lane ("I'll take P-002/P-003") without a claim
    // is the exact pattern the discipline replaces.
    {
      kind: 'text_excludes',
      pattern: /\b(i'?ll|i will|i'?m going to)\b[^.!?]{0,40}\btake\b[^.!?]{0,30}\bP-\d{3}/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S10_CLAIM_BEFORE_WORK;
