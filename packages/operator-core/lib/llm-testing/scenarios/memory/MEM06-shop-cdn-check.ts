/**
 * MEM06 — boot-recall: pre-deploy checklist step
 *
 * T4 boot-recall tier (memory-backend-benchmark-2026-06-05 P-009, D-005).
 *
 * Question: a hard-won process step recorded as reference (fictional:
 * scripts/check-shop-cdn.mjs must run before shop deploys). If the
 * assistant names the script, boot-recall surfaced the memory.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';

export const MEM06_SHOP_CDN_CHECK: Scenario = {
  id: 'op-MEM06-shop-cdn-check',
  version: 1,
  target: 'operator',
  description:
    'A brief admin is about to deploy the shop and asks the operator to remind them of the pre-deploy step the team keeps forgetting. There is a recorded pre-deploy step born from a past incident; success looks like the operator surfacing that specific recorded step (available in operator memory).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  setup: {
    mem0: [
      {
        kind: 'reference',
        body: 'Shop deploys MUST run scripts/check-shop-cdn.mjs before deploy.sh — skipping it on 2026-05-22 shipped broken image URLs for two days. It validates the CDN manifest against the built asset hashes.',
      },
    ],
  },
  realWorkspace: true,
  caps: { maxTurns: 4, maxWallSecs: 300, maxCostUsd: 1.0 },
  asserts: [
    { kind: 'text_contains', pattern: /check-shop-cdn/i },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default MEM06_SHOP_CDN_CHECK;
