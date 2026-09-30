/**
 * Plan-run wake channel — re-invoke a sleeping PLAN RUN with the wake reason
 * as its next turn (await-event-primitive-2026-06-05 D-003: "resume-if-exited"
 * for the plans:launch/plans:resume session shape).
 *
 * Mirrors plans:resume's background mode (steps 1/2/4/5 of resumeHandler)
 * without the tool envelope: recover the run, re-seed from the CURRENT plan,
 * mark it running, fire the continuation turn fire-and-forget (it settles its
 * own status). Lazy-imported by the pump so the await engine carries no
 * static dependency on the plans tool family.
 */

import { buildPlanContextBundle } from '../../agent-tools/plans/context-bundle';
import { getRepoRoot } from '../../agent-tools/plans/source';
import { getPlanRun, markPlanRunResumed } from '../../agent-tools/plans/runs';
import { executePlanAgentTurn } from '../../agent-tools/plans/turn';

export async function resumePlanRunForWake(input: {
  runId: number;
  wakeText: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const run = await getPlanRun(input.runId);
  if (!run) return { ok: false, error: `plan run ${input.runId} not found` };

  const bundle = await buildPlanContextBundle(run.planSlug, {});
  if (!bundle) return { ok: false, error: `plan ${run.planSlug} not found for run ${input.runId}` };

  // P1-1 (resume-race guard): claim the run atomically. A run already
  // `running` is mid-turn — waking it again would spawn a DUPLICATE turn on
  // the same session. Only the winner of the atomic flip fires the turn.
  const { claimed } = await markPlanRunResumed(input.runId, bundle.contentHash);
  if (!claimed) {
    return { ok: false, error: `plan run ${input.runId} is already running — wake skipped` };
  }

  void executePlanAgentTurn({
    runId: input.runId,
    sessionId: run.sessionId,
    systemPromptText: bundle.text,
    promptText: input.wakeText,
    cwd: getRepoRoot(),
    uiClientId: null,
    // gateway-priority-tiers (WI-4542/WI-5676): this channel re-invokes a sleeping
    // plan run from an EVENT WAKE — there is no ctx/identity to resolve (unlike
    // plans:launch/plans:resume) and, structurally, no human is ever synchronously
    // watching a background wake. Always the 'su' middle tier, never 'interactive'.
    priority: 'su',
    signal: undefined,
    emit: () => {},
  }).catch(() => {
    /* settled to 'failed' inside the turn */
  });

  return { ok: true };
}
