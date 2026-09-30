/**
 * experiment:run — run an experiment via the eval-battery engine and get the per-arm
 * judge scores + the compareArms verdict (`experiment-registry-invocation-api` P-031).
 *
 * v1 executes the OFFLINE replay tier, riding the frontier:replay-harness flag +
 * governor budget (origin-tagged spend; refuses with NO spend when dark/unbudgeted/
 * exhausted). The logic lives in the pure, injectable run-core; this is the thin tool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { runGovernedReplay } from '../../replay/governed';
import { runExperiment } from '../../experiment/run-core';
import { experimentJudge, experimentReplayRunner } from '../../experiment/replay-ports';
import { PgExperimentLedger } from '../../experiment/ledger';
import { captureImprovement } from '../../harness/improvements/capture-core';

export default defineTool({
  name: 'experiment:run',
  description:
    'Run an experiment: A/B a knob change against a battery via the eval-battery engine and get per-arm judge scores + the compareArms verdict. OFFLINE replay is the default front door (tier defaults to "offline", ~$0 deterministic) — re-run each synthetic case under each arm’s policy/model overlay and score outcome/process/divergence; rides frontier:replay-harness (flag + governor budget; origin-tagged spend), refusing with NO spend if dark/exhausted. Escalating to a spending tier (set tier:"live") requires escalation justification (a positive offline signal or a written couldn’t-isolate trigger; +costException for whole-instance/whole-Hive) and an armed governor budget — it fails closed. The gym live tier is reachable when its AbDeps are armed; instance/hive stay staged (their own loops drive them). Arms must address only the test’s knobSlice (experiment:catalog). A winner is a PROPOSAL — applying it rides commit→reproject + graduation, never this tool.',
  guidance: {
    when: 'Testing how a knob change performs before adopting it — screen a policy/prompt overlay against a battery on the cheap offline replay tier; the result ranks arms vs the baseline.',
    notWhen: 'Discovery (experiment:catalog). Scoring one gym run (gym:judge/gym:signals). Applying a winner to live prompts — that rides commit→reproject + graduation (D-006), never here.',
    chaining: 'experiment:catalog → pick testId + read knobSlice → experiment:run → (winner is a proposal).',
    seeAlso: [
      'experiment:catalog (discover test kinds + knob slices)',
      'experiment:results (read back recorded outcomes)',
      'gym:judge (subjective quality scoring of one run)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  // Overwatch excluded too (overwatch-role-2026-06-15 D-001): it never runs experiments
  // (cap-blocked by harness:write anyway; excluded here for an honest role surface).
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    testId: z.string().default('replay').describe('The test id from experiment:catalog. v1 executes only the offline "replay" tier; others are staged.'),
    batteryId: z.string().min(1).describe('Groups this run’s cells/rows.'),
    arms: z
      .array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          knobs: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1)
      .describe('Variants to compare. An arm with empty knobs is the baseline; knob addresses must be within the test’s knobSlice (e.g. overlay.systemOverlay for replay).'),
    cases: z
      .array(
        z.object({
          caseId: z.string(),
          context: z.string().describe('The context the agent resumes from.'),
          intent: z.string().describe('The task the judge scores against.'),
          projectContext: z.string().optional(),
        }),
      )
      .min(1)
      .describe('Synthetic battery cases (v1) — each judged per arm.'),
    repeats: z.number().int().positive().max(10).default(1),
    tier: z
      .enum(['offline', 'shadow', 'live'])
      .optional()
      .describe(
        'The fidelity tier to run at — defaults to "offline" (the ~$0 deterministic replay screen, the default front door). MUST match the test\'s own tier: a spending tier (shadow/live) cannot be reached by naming a testId alone, you must consciously set tier here — and then it requires `escalation` justification.',
      ),
    escalation: z
      .object({
        offlineSignalRunId: z
          .string()
          .optional()
          .describe('A prior OFFLINE experiment run (experiment:results runId/batteryId) whose result is the positive signal that justifies spending.'),
        couldntIsolate: z
          .string()
          .optional()
          .describe('A written reason the cheap offline tier cannot isolate the variable (the couldn\'t-isolate trigger, D-005/D-007).'),
        costException: z
          .boolean()
          .optional()
          .describe('Explicit acknowledgment of the whole-instance / whole-Hive cost exception (D-002) — required for those two kinds.'),
      })
      .optional()
      .describe('Required to escalate off the offline tier (P-041): a positive offline signal OR a written couldn\'t-isolate trigger; +costException for whole-instance/whole-Hive.'),
    payload: z
      .unknown()
      .optional()
      .describe('Subject-specific battery input for the LIVE tiers (gym tasks / instance baseSpec+corpus / hive scenario). The offline tier builds its battery from `cases` and ignores this.'),
    budgetUsd: z.number().positive().optional().describe('Per-run spend cap; the frontier:replay-harness governor budget is the upstream gate.'),
    maxDistillChars: z.number().int().positive().optional(),
    replayModel: z.string().optional().describe('Model for the replayed continuation (default claude-sonnet-4-6).'),
    maxOutputTokens: z.number().int().positive().max(8000).optional(),
    dryRun: z
      .boolean()
      .optional()
      .describe('Validate + expand the battery and return the plan WITHOUT spending — author/check an experiment before arming spend.'),
  }),
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const { getOrgPg } = await import('@papercusp/db-org');
    const outcome = await runExperiment(
      {
        testId: args.testId,
        batteryId: args.batteryId,
        arms: args.arms,
        cases: args.cases,
        repeats: args.repeats,
        ...(args.tier !== undefined ? { tier: args.tier } : {}),
        ...(args.escalation !== undefined ? { escalation: args.escalation } : {}),
        ...(args.payload !== undefined ? { payload: args.payload } : {}),
        budgetUsd: args.budgetUsd,
        maxDistillChars: args.maxDistillChars,
        dryRun: args.dryRun,
      },
      { workspaceId },
      {
        runGovernedReplay,
        replayRunner: experimentReplayRunner(args.replayModel, args.maxOutputTokens),
        judge: await experimentJudge(),
        ledger: new PgExperimentLedger(getOrgPg().sql),
        captureScorecard: async (scorecard) => {
          await captureImprovement({
            title: `Experiment scorecard: ${scorecard.testId}/${scorecard.batteryId}`,
            kind: 'change',
            severity: 'nit',
            lane: 'observation',
            foundDuring: 'experiment:run',
            force: true,
            createdBy: 'experiment:run',
            filedByRole: 'experiment',
            payloadExtra: {
              observation: {
                kind: 'reinforce',
                scope: 'papercusp',
                confidence: 'high',
                sourceHive: 'papercusp',
                rubricRef: scorecard.rubricRef,
                ratings: scorecard.ratings,
                refs: [
                  `experiment:${scorecard.testId}`,
                  `battery:${scorecard.batteryId}`,
                  `tier:${scorecard.tier}`,
                ],
              },
            },
          });
        },
      },
    );
    if (outcome.ok && outcome.result) {
      // Push the new run to the Learning-tab scoreboard (P-051). A dryRun has no
      // result/ledger row, so it never invalidates.
      const { notifySyncInvalidate } = await import('../../sync-sse');
      notifySyncInvalidate('learning.experiments');
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] };
  },
});
