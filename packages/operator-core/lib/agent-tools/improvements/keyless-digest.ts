/**
 * improvements:keyless-digest — the human-review surface for KEYLESS improvement
 * items (watchdog-and-exposed-systems-improvement-2026-06-18 P-014).
 *
 * Keyless EIs (no `payload.watchdogKey`) are invisible to dedup / known-open aging /
 * auto-close — all three key off the watchdogKey — so they accrete and dominate the
 * backlog headline (661 open at audit time). This read-only tool implements the
 * P-014 policy's actionable half: it splits the backlog into managed (keyed) vs
 * un-managed (keyless), age-bands the keyless pile, and returns the stale-review
 * queue (oldest-first) with a per-item disposition so a human/Queen can drain it —
 * claim, close-if-obsolete, or convert-to-keyed. It does NOT auto-close anything.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  readOpenKeylessIssues,
  summarizeKeylessBacklog,
  planKeylessReview,
  KEYLESS_EI_POLICY,
  DEFAULT_KEYLESS_REVIEW_LIMIT,
} from '../../harness/improvements/keyless-ei-policy';

export default defineTool({
  name: 'improvements:keyless-digest',
  profile: 'engineer',
  description:
    'Triage surface for KEYLESS improvement items (no payload.watchdogKey — manual / non-watchdog EIs) — the un-managed backlog that never dedups, ages, or auto-closes. Returns the keyed-vs-keyless headline split, age-band rollup (fresh < 7d · aging 7–30d · stale ≥ 30d), and the review queue (keyless EIs ≥ 7d, oldest-first) with a per-item disposition (claim-or-close / follow-up-owner). Read-only — closes nothing; surfaces the pile so a human/Mug can drain it (P-014).',
  guidance: {
    when: 'To see and triage the un-managed backlog — the keyless EIs that the watchdog lifecycle (dedup/aging/auto-close) cannot touch because they carry no watchdogKey. Use it as the periodic keyless human-review digest: drain the stale-review queue (claim, close if obsolete, or convert a recurring one to a keyed form).',
    notWhen: 'You want watchdog/auto-implement health — improvements:watchdog-status. You want the full captured (keyed) backlog triage — improvements:digest. You want one item — work_items:get.',
    chaining:
      'improvements:keyless-digest → for each review item: work_items:claim (take it), work_items:set_state (obsolete), or re-file via improvements:capture with a stable key if it is a recurring signal. improvements:watchdog-status surfaces the same keyless headline split.',
    seeAlso: [
      'improvements:digest (the full KEYED backlog triage)',
      'improvements:watchdog-status (why keyless items escape the lifecycle)',
      'work_items:set_state (close an obsolete keyless item)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    reviewLimit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe(`max stale-review items to return, oldest-first (default ${DEFAULT_KEYLESS_REVIEW_LIMIT})`),
    sampleLimit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe('max open keyless EIs to sample for the rollup (default 500; the total count is exact regardless)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const nowMs = Date.now();
    const { total, rows } = await readOpenKeylessIssues(args.sampleLimit ?? 500);
    const summary = summarizeKeylessBacklog(rows, total, nowMs);
    const review = planKeylessReview(rows, nowMs, { limit: args.reviewLimit ?? DEFAULT_KEYLESS_REVIEW_LIMIT });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, policy: KEYLESS_EI_POLICY, summary, review }),
        },
      ],
    };
  },
});
