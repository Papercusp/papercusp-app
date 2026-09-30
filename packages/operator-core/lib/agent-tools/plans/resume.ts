/**
 * plans:resume — continue an existing plan-agent run.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-013). The "continue" half
 * of D-010: a run launched by `plans:launch` (P-012) is a resumable
 * conversation, not a one-shot. This tool sends a follow-up message
 * into an existing run.
 *
 * It re-invokes the same runner the launch used, with the run's
 * existing `session_id` — `runPlanAgent` is `sessionMode: 'force'`
 * (create-or-resume), so the agent continues its prior conversation.
 * New turns append to `plan_run_turns` after the launch's seq 1/2.
 *
 * The launch seed is re-assembled fresh and re-sent as the system
 * prompt: the agent backend applies it per-spawn, so a resumed run is
 * always re-seeded with the *current* plan doc + rationale digest.
 * `plan_runs.plan_content_hash` is re-stamped to match (see
 * `markPlanRunResumed`).
 *
 * Wire events:
 *   run_resumed { runId, sessionId }
 *   delta       { text }
 *   tool_call   { name, input }
 *   cost        { usd }
 *   warning     { message }   ← e.g. the plan changed since the run
 *   error       { message }
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { buildPlanContextBundle } from './context-bundle';
import { getRepoRoot } from './source';
import { getPlanRun, markPlanRunResumed } from './runs';
import { executePlanAgentTurn } from './turn';
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { derivePlanAgentPriority } from './launch';

const argsSchema = z.object({
  // z.coerce on numerics + a string-`"true"|"false"` coerce on `await`
  // so the verb accepts MCP-style numeric args AND the admin-route's
  // POSTed body (which arrives via fetch JSON — numbers fine, booleans
  // fine, but the same schema also handles ?await=… string fallback).
  runId: z.coerce
    .number()
    .int()
    .positive()
    .describe('Id of the plan run to continue (from plans:runs).'),
  message: z
    .string()
    .min(1)
    .describe('The follow-up instruction to send into the run.'),
  // Same fire-and-forget knob as plans:launch (D-022). admin UI sends
  // `await: false` because the POST can't stream. Default true so MCP
  // streaming is unchanged.
  await: z
    .boolean()
    .optional()
    .describe(
      'When false, return immediately after recording the resume; the ' +
        'turn runs in the background and writes turns + final status ' +
        'asynchronously. Default true.',
    ),
  harness: harnessArg,
});

type ResumeArgs = z.infer<typeof argsSchema>;

const EVENTS = {
  run_resumed: z.object({ runId: z.number(), sessionId: z.string() }),
  delta: z.object({ text: z.string() }),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({ usd: z.number() }),
  warning: z.object({ message: z.string() }),
  error: z.object({ message: z.string() }),
} as const;

/**
 * The plan-changed warning for a resume — non-null when the run was
 * last seeded against a different version of the plan than the one
 * it is about to be re-seeded with. Exported + pure for unit test.
 */
export function derivePlanChangeWarning(
  runContentHash: string,
  currentContentHash: string,
  slug: string,
): string | null {
  if (runContentHash === currentContentHash) return null;
  return (
    `Plan "${slug}" changed since this run was last active — ` +
    'resuming against the current version.'
  );
}

/** The ctx subset `plans:resume` reads — the streaming/cancellation
 *  handles plus the session harness scope (fed to `harnessScopedCtx`),
 *  plus `ResolveIdentityCtx` (gateway-priority-tiers WI-4542/WI-5676: needed to
 *  derive the resumed turn's admission-tier label the same way `plans:launch`
 *  does). The real `UnifiedToolContext` satisfies it structurally. */
type ResumeCtx = ResolveIdentityCtx & {
  emit: (name: string, data: unknown) => void;
  signal?: AbortSignal;
  uiClientId?: string | null;
  harnessSlug?: string | null;
};

function notFound(field: string, value: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: 'not_found', [field]: value }),
      },
    ],
  };
}

async function resumeHandler(input: ResumeArgs, ctx: ResumeCtx) {
  // 1. Recover the run — its session id + which plan it belongs to.
  const run = await getPlanRun(input.runId);
  if (!run) return notFound('runId', input.runId);

  // 2. Re-assemble the launch seed from the *current* plan state.
  const sctx = harnessScopedCtx(input.harness, ctx);
  const resumeHarnessSlug = resolveCtxHarnessSlug(sctx);
  const bundle = await buildPlanContextBundle(
    run.planSlug,
    resumeHarnessSlug ? { harnessSlug: resumeHarnessSlug } : {},
  );
  if (!bundle) return notFound('slug', run.planSlug);

  // 3. Tell the caller when the plan moved under the run.
  const changeWarning = derivePlanChangeWarning(
    run.planContentHash,
    bundle.contentHash,
    run.planSlug,
  );
  if (changeWarning) ctx.emit('warning', { message: changeWarning });
  if (bundle.status === 'superseded') {
    ctx.emit('warning', {
      message: `Plan "${run.planSlug}" is superseded — resuming anyway.`,
    });
  }

  // 4. Claim the run: mark it running + re-stamp its content hash (D-010:
  //    archived/idle/failed/done runs reactivate on resume). The claim is
  //    ATOMIC (P1-1) — `markPlanRunResumed` only flips a run that is NOT
  //    already `running`. A run already `running` is mid-turn: resuming it
  //    would spawn a SECOND `executePlanAgentTurn` on the same session,
  //    duplicating work and racing two turns onto one transcript. Refuse it
  //    with a busy result instead of kicking a duplicate turn.
  const { claimed } = await markPlanRunResumed(input.runId, bundle.contentHash);
  if (!claimed) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'run_busy',
            runId: input.runId,
            planSlug: run.planSlug,
            status: 'running',
            message:
              `Plan run ${input.runId} is already running — a turn is in ` +
              'flight. Wait for it to settle (plans:runs), then resume.',
          }),
        },
      ],
    };
  }
  ctx.emit('run_resumed', { runId: input.runId, sessionId: run.sessionId });

  // gateway-priority-tiers (WI-4542/WI-5676): same derivation as plans:launch —
  // see `derivePlanAgentPriority` in ./launch.
  let resumePriority = derivePlanAgentPriority(undefined);
  try {
    resumePriority = derivePlanAgentPriority(resolveAgentIdentity(ctx).source);
  } catch {
    // Unattributable caller — keep the 'su' priority default.
  }

  // 5. Run the continuation turn — stream + persist turns + settle
  //    status. Shared with launch (P-012); see turn.ts.
  //
  // D-022 — background mode for the admin UI path: return as soon as
  // the run is marked running again; let the turn run fire-and-forget.
  // Final status flips via executePlanAgentTurn's own settle.
  if (input.await === false) {
    void executePlanAgentTurn({
      runId: input.runId,
      sessionId: run.sessionId,
      systemPromptText: bundle.text,
      promptText: input.message,
      cwd: getRepoRoot(),
      uiClientId: ctx.uiClientId ?? null,
      priority: resumePriority,
      signal: ctx.signal,
      emit: ctx.emit,
    }).catch(() => { /* settled to 'failed' inside the turn */ });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            runId: input.runId,
            sessionId: run.sessionId,
            status: 'running',
            planSlug: run.planSlug,
            mode: 'background',
          }),
        },
      ],
    };
  }

  const { status, costUsd } = await executePlanAgentTurn({
    runId: input.runId,
    sessionId: run.sessionId,
    systemPromptText: bundle.text,
    promptText: input.message,
    cwd: getRepoRoot(),
    uiClientId: ctx.uiClientId ?? null,
    priority: resumePriority,
    signal: ctx.signal,
    emit: ctx.emit,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          runId: input.runId,
          sessionId: run.sessionId,
          status,
          planSlug: run.planSlug,
          costUsd,
        }),
      },
    ],
  };
}

export default defineTool({
  name: 'plans:resume',
  profile: 'engineer',
  description:
    'Continue an existing plan-agent run. Sends a follow-up message into a run started by plans:launch, re-seeding the agent with the current plan and appending new turns to its transcript.',
  guidance: {
    when: 'You want to continue a plan run — send a follow-up instruction to an agent already launched on a plan.',
    notWhen:
      'Starting a fresh agent on a plan is plans:launch. Only reading a run’s past turns needs no agent at all.',
    chaining:
      'plans:runs → plans:resume { runId, message } → the run streams further turns.',
    seeAlso: [
      'plans:runs (list the runs to resume)',
      'plans:run-transcript (watch the resumed run)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Streaming tool — opt into the replay ring buffer, same budget as
  // plans:launch / oracle:chat.
  replayBufferSize: 5000,
  args: argsSchema,
  events: EVENTS,
  handler: resumeHandler,
});
