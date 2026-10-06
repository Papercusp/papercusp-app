/**
 * improvements:resolve — the verify-and-mark-done back-edge of the
 * self-improvement loop (close-the-self-improvement-loop-2026-06-05 D-001).
 *
 * The implement worker (and any agent that fixes a captured improvement
 * self/inline) calls this when it finishes an item. `fixed` REQUIRES the
 * verification evidence (testsRun) — a fix is only resolved when verified —
 * and marks the issue resolved so it leaves the auto-implement queue.
 * `could-not-fix` / `needs-human` release the claim and route appropriately.
 * Thin wrapper over `resolveImprovement` (resolve-core.ts).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { hardText } from '../limits';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolveImprovement } from '../../harness/improvements/resolve-core';
import { EXTERNAL_BLOCKER_CAPABILITIES } from '../../external-blockers';
import { trackDetached } from '../../detached-imports';

export default defineTool({
  name: 'improvements:resolve',
  profile: 'engineer',
  description:
    'Close the loop on a captured papercusp improvement you worked: outcome `fixed` (requires testsRun — the verification evidence) marks it resolved so it leaves the queue; `could-not-fix` releases it for a retry (exhausted retries route to LEADER TRIAGE, status=blocked); `needs-human` routes to the OWNER queue ONLY with a typed `blockerCapability`, otherwise to LEADER TRIAGE.',
  guidance: {
    when: 'You finished working a dispatched/claimed improvement (usually as the implement worker). Fixed + tests green → outcome fixed with the evidence. Could not make it work → could-not-fix with what you tried. The fix would touch a protected surface (operator-core safety / deploy machinery / a migration) or needs judgment → needs-human — and pass a typed blockerCapability (credential | physical-device | external-service-action | product-decision) when a HUMAN genuinely must act, else it routes to leader triage, not the owner.',
    notWhen: 'You only want to comment progress — work_items:comment. You are closing a non-improvement issue — work_items:set_state. The item was never captured (no EI/WI id) — improvements:capture it first if it is worth tracking.',
    chaining: 'improvements:digest → (dispatch/claim) → implement + test → improvements:resolve { id, outcome, summary, testsRun }.',
    seeAlso: [
      'work_items:comment (a progress note without closing)',
      'work_items:set_state (close a NON-improvement issue)',
      'improvements:digest (find the next dispatched item)',
    ],
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1).max(40).describe('the improvement work-unit id (EI-n / WI-n)'),
    outcome: z.enum(['fixed', 'could-not-fix', 'needs-human']),
    summary: hardText(4000, { min: 10 }).describe('what happened — for fixed: what changed + how it was verified; for the others: why'),
    testsRun: z.string().max(1000).optional().describe('the test command(s) run + result — REQUIRED for outcome fixed'),
    commit: z.string().max(120).optional().describe('commit/branch the fix landed on (it still rides the release gate)'),
    blockerCapability: z
      .enum([...EXTERNAL_BLOCKER_CAPABILITIES])
      .optional()
      .describe(
        'outcome=needs-human ONLY: the TYPED human-capability blocker. credential | physical-device | ' +
          'external-service-action | product-decision → the OWNER queue; approval-auto-clearable | ' +
          'live-dependency, or OMITTED → LEADER TRIAGE (an operational block a leader clears, not owner work). ' +
          'Only pass it when a human genuinely must act.',
      ),
    defaultIfUnanswered: z
      .string()
      .max(500)
      .optional()
      .describe(
        'REQUIRED with an owner-queue blockerCapability: what happens if the owner never answers ' +
          '(e.g. "stays parked; weekly digest re-surfaces it"). Refused without it.',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'your probability (0–1) this fix SURVIVES — no reopen/re-capture for 14 days. Optional, never blocks: recorded as a calibration bet (Brier-scored per persona later); omitted = a cheap implicit prior',
      ),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const result = await resolveImprovement({
      id: args.id,
      outcome: args.outcome,
      summary: args.summary,
      testsRun: args.testsRun,
      commit: args.commit,
      blockerCapability: args.blockerCapability,
      defaultIfUnanswered: args.defaultIfUnanswered,
      by: id.ownerId,
    });
    // Calibration bet at the natural moment (frontier P-041 / FB-13): claiming
    // `fixed` IS a survival claim — record it cheaply (fire-and-forget; the
    // seam is flag-gated + never-throw, so the resolve path is unaffected).
    if (args.outcome === 'fixed') {
      const confidence = args.confidence;
      void trackDetached(import('../../calibration/capture'))
        .then((m) =>
          m.recordPrediction({
            predictor: id.ownerId,
            domain: 'fix-survival',
            subjectKind: 'improvement',
            subjectId: args.id,
            claim: `fix for ${args.id} survives the horizon (no reopen/re-capture)`,
            harnessSlug: ctx.harnessSlug ?? null,
            ...(confidence !== undefined ? { probability: confidence } : {}),
          }),
        )
        .catch(() => {});
    }
    // Discovery-time insight trip-wire (EI-328, policies §19 same-turn rule):
    // a fixed improvement is the moment the root cause is PROVEN — the one
    // reliable boundary to ask "does the next agent need this written down?".
    // Mirrors work_items:complete's reflect step; mechanical nudges fire where
    // advisory prose doesn't (the lock-hook lesson).
    const out =
      args.outcome === 'fixed'
        ? {
            ...result,
            insightCheck:
              'Was the root cause non-obvious, or did anyone call this failure recurring ' +
              '("agents often/keep hitting this")? Then write the agent-insight NOW, in this ' +
              'same turn — apps/operator-docs/src/content/docs/agent-insights/<slug>.mdx, ' +
              'format + timing rule in agent policies §19. The insight is part of the fix, ' +
              'not an appendix. If the fix is self-explanatory in code, skip — say so and move on.',
          }
        : result;
    return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
  },
});
