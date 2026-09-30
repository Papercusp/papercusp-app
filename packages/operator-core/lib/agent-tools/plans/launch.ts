/**
 * plans:launch — launch an autonomous agent on a plan.
 *
 * plan-agent-launch-2026-05-21, Phase 3 (P-012). The integration point
 * where Phase 3's pieces come together:
 *
 *   1. assemble the P-009 context bundle (`buildPlanContextBundle`);
 *   2. mint a `session_id` and insert the `plan_runs` row (P-010 table);
 *   3. run the agent via the P-011 runner (`runPlanAgent`);
 *   4. stream delta / tool_call / cost events to the caller;
 *   5. persist the user + assistant turns to `plan_run_turns`.
 *
 * A streaming tool in the mould of `oracle:chat`. The run is resumable
 * (D-010) — `plans:launch` performs the first turn; a later "continue"
 * (P-013) re-invokes the runner with the same `session_id`.
 *
 * Wire events:
 *   run_started { runId, sessionId }   ← emitted once the row exists
 *   delta       { text }
 *   tool_call   { name, input }
 *   cost        { usd }
 *   warning     { message }            ← e.g. launching a superseded plan
 *   error       { message }
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { buildPlanContextBundle } from './context-bundle';
import { checkPlanStartable } from './plan-start-gate';
import { getRepoRoot, resolvePlanScope } from './source';
import { insertPlanRun } from './runs';
import { resolveGoalContext, stampPlanGoalProvenance } from '../../modes/goal-context';
import { executePlanAgentTurn } from './turn';
import {
  resolveAgentIdentity,
  type IdentitySource,
  type ResolveIdentityCtx,
} from '../coordination/identity';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { deriveLaunchPromptText } from './launch-prompt';

const argsSchema = z.object({
  harness: harnessArg,
  slug: z
    .string()
    .min(1)
    .describe('Plan slug (filename without .md) to launch an agent on.'),
  note: z
    .string()
    .optional()
    .describe(
      'Optional free-text instruction for the launched agent. Absent → a ' +
        'default "advance this plan" kickoff.',
    ),
  // P-022: an HTTP caller (the /admin/plans UI) cannot stream — it
  // can only block on the response. Setting `await: false` returns
  // as soon as the plan_runs row exists; the agent turn continues
  // fire-and-forget and reports its result via the row's `status`
  // (which the UI polls through `plans:runs`). Defaults to true so
  // the MCP streaming path is unchanged.
  await: z
    .boolean()
    .optional()
    .describe(
      'When false, return immediately after inserting the plan_runs ' +
        'row; the agent turn runs in the background and writes its ' +
        'turns + final status asynchronously. Default true (wait for the ' +
        'turn to complete).',
    ),
  inputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Per-invocation input overrides, shallow-merged over the plan's stored values and validated before the run is created (plan-structured-inputs P-011). The resolved set is rendered into the agent's launch seed as an INPUTS block. Omit to launch with the plan's stored values.",
    ),
});

type LaunchArgs = z.infer<typeof argsSchema>;

const EVENTS = {
  run_started: z.object({ runId: z.number(), sessionId: z.string() }),
  delta: z.object({ text: z.string() }),
  tool_call: z.object({ name: z.string(), input: z.unknown() }),
  cost: z.object({ usd: z.number() }),
  warning: z.object({ message: z.string() }),
  error: z.object({ message: z.string() }),
} as const;

// deriveLaunchPromptText now lives in ./launch-prompt — a dependency-free module the
// psu bootstrap-su route imports without pulling this file's heavy graph (runner/turn/
// DB). Re-exported here so existing importers (incl. launch.test.ts) are unchanged.
export { deriveLaunchPromptText };

/**
 * The runs-list label for a launch — the note's first line (truncated),
 * else the plan title. Exported + pure for unit test.
 */
export function deriveLaunchTitle(
  note: string | null | undefined,
  planTitle: string,
): string {
  const firstLine = (note ?? '').trim().split('\n')[0]?.trim() ?? '';
  if (firstLine.length === 0) return planTitle;
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

/** The ctx subset `plans:launch` reads — identity (for `launched_by`)
 *  + the streaming/cancellation handles. The real `UnifiedToolContext`
 *  satisfies it structurally. */
type LaunchCtx = ResolveIdentityCtx & {
  emit: (name: string, data: unknown) => void;
  signal?: AbortSignal;
};

/**
 * gateway-priority-tiers (WI-4542 follow-up, WI-5676): the gateway admission-tier
 * label for a launched/resumed plan-agent run.
 *
 * A plan agent does real engineering work and can be triggered either from the
 * operator UI (a human is synchronously watching the stream — genuinely
 * `'interactive'`, the same bar `architect:chat` / `oracle:chat` / `agent_chats:chat`
 * use per WI-4542) or autonomously (AUTO mode, a schedule firing `plans:launch`, or
 * another agent calling it programmatically). Wrongly tagging an autonomous run
 * `'interactive'` would let it compete with genuine owner turns for the reserved
 * tier-1 floor — the exact starvation bug WI-4542 fixed — so only the SAME
 * power-user identity that already proves a live UI/OMP session (see
 * `resolveAgentIdentity` in `coordination/identity.ts`) earns `'interactive'`; every
 * other caller (su engineer session, in-process principal, fleet-spawn, or an
 * unattributable/failed identity resolution) gets the `'su'` middle tier instead of
 * falling to the untagged default band (tier 5). Pure + exported for unit test;
 * shared with `plans:resume`.
 */
export function derivePlanAgentPriority(
  identitySource: IdentitySource | undefined,
): string {
  return identitySource === 'power-user-token' ? 'interactive' : 'su';
}

async function launchHandler(input: LaunchArgs, ctx: LaunchCtx) {
  const sctx = harnessScopedCtx(input.harness, ctx);
  const __ctxHarness = resolveCtxHarnessSlug(sctx);
  const scopeOpts = __ctxHarness ? { harnessSlug: __ctxHarness } : {};

  // 1. START GATE (plan-structured-inputs P-006), BEFORE the seed is assembled and
  //    before any run row exists — a refused launch must leave no trace. Per-invocation
  //    `inputs` are merged over the plan's stored values and validated together, so
  //    what the agent is seeded with is exactly what was approved.
  const gate = await checkPlanStartable(input.slug, scopeOpts, input.inputs ?? null, 'start');
  if (!gate.ok) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: JSON.stringify(gate.refusal) }],
    };
  }

  // 2. Assemble the launch seed (plan doc + INPUTS block + rationale digest).
  const bundle = await buildPlanContextBundle(input.slug, {
    ...scopeOpts,
    inputs: gate.inputs,
  });
  if (!bundle) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: 'not_found', slug: input.slug }),
        },
      ],
    };
  }

  // 2. Warn — but do not block — when launching a superseded plan.
  if (bundle.status === 'superseded') {
    ctx.emit('warning', {
      message: `Plan "${input.slug}" is superseded — launching anyway.`,
    });
  }

  // 3. Mint the run's session id (runAgentChat sessionId == ?plan_run=
  //    == plan_runs.session_id) and resolve who launched it.
  const sessionId = globalThis.crypto.randomUUID();
  let launchedBy = 'unknown';
  let launchScope: Awaited<ReturnType<typeof resolvePlanScope>> | null = null;
  // gateway-priority-tiers (WI-4542/WI-5676) — see derivePlanAgentPriority above.
  let launchPriority = derivePlanAgentPriority(undefined);
  try {
    const identity = resolveAgentIdentity(ctx);
    launchedBy = identity.ownerId;
    launchPriority = derivePlanAgentPriority(identity.source);
  } catch {
    // Unattributable caller — record the launch as 'unknown' rather
    // than fail it (launched_by is NOT NULL). Keep the 'su' priority default.
  }

  // Resolve + fence before the run row exists. The old launch-time provenance
  // stamp happened after insertion and swallowed every failure, so an expired
  // predecessor could launch work and merely lose its decorative goal_id.
  if (launchedBy !== 'unknown') {
    launchScope = await resolvePlanScope(scopeOpts);
    await resolveGoalContext(launchScope.workspaceId, launchedBy);
  }

  const launchHarnessSlug = resolveCtxHarnessSlug(sctx);
  const promptText = deriveLaunchPromptText(input.note, true, {
    slug: input.slug,
    harness: launchHarnessSlug ?? null,
  });
  const title = deriveLaunchTitle(input.note, bundle.title);
  const note = (input.note ?? '').trim() || null;

  // 4. Insert the plan_runs row — the canonical record of the launch.
  const runId = await insertPlanRun({
    planSlug: input.slug,
    ...(launchHarnessSlug ? { harnessSlug: launchHarnessSlug } : {}),
    planContentHash: bundle.contentHash,
    sessionId,
    note,
    launchedBy,
    title,
    status: 'running',
  });
  ctx.emit('run_started', { runId, sessionId });

  // 5. Emit the plan-event — `agent_launched` is plan-scoped activity
  //    the feed surfaces (P-014). Best-effort; never blocks the run.
  await emitPlanEventForCaller(ctx, {
    planSlug: input.slug,
    event: 'agent_launched',
    after: runId,
    detail: title,
  });

  // Migration 791 / goal-mode-design-intent-hardening P-003: attribute the plan
  // to the goal its LAUNCHER works under, if any. plans:new stamps at create,
  // but the plan a goal agent launches was often authored OUTSIDE the goal (a
  // template, a peer's plan) — without this leg the goal page cannot see the
  // very plan the goal's agent is actively driving. Same rule as create: the
  // goal comes from the launcher's RESOLVED context (never an argument), and
  // stampPlanGoalProvenance writes only WHERE goal_id IS NULL, so the first
  // attribution wins and a launch can never re-parent an attributed plan.
  // The RESOLVED scope (resolvePlanScope collapses a member harness to its pot
  // home) is what the harness_plans row was written with — the caller's own
  // harness slug would miss pot-scoped plans SILENTLY (zero-row UPDATE), the
  // same trap new.ts documents. Best-effort + un-awaited: provenance must not
  // fail or slow a launch that already succeeded.
  void (async () => {
    const scope = launchScope ?? await resolvePlanScope(scopeOpts);
    await stampPlanGoalProvenance({
      workspaceId: scope.workspaceId,
      harnessSlug: scope.harnessSlug,
      planSlug: input.slug,
      ownerId: launchedBy === 'unknown' ? undefined : launchedBy,
    });
  })().catch(() => {
    /* resolvePlanScope can throw for an unregistered harness — the launch
       itself already resolved the plan, so just skip the stamp. */
  });

  // 6. Run the agent's first turn — stream + persist turns + settle
  //    status. Shared with resume (P-013); see turn.ts.
  //
  // `await: false` (the admin-route UI path — D-022): kick the turn
  // off in the background and return as soon as the row exists. Any
  // failure in the background run is swallowed here because
  // executePlanAgentTurn already settles `plan_runs.status` to
  // `failed` internally, and the run-row update is the canonical
  // signal — there is no other listener.
  if (input.await === false) {
    void executePlanAgentTurn({
      runId,
      sessionId,
      systemPromptText: bundle.text,
      promptText,
      cwd: getRepoRoot(),
      uiClientId: ctx.uiClientId ?? null,
      priority: launchPriority,
      signal: ctx.signal,
      emit: ctx.emit,
    }).catch(() => { /* settled to 'failed' inside the turn */ });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            runId,
            sessionId,
            status: 'running',
            planSlug: input.slug,
            mode: 'background',
          }),
        },
      ],
    };
  }

  const { status, costUsd } = await executePlanAgentTurn({
    runId,
    sessionId,
    systemPromptText: bundle.text,
    promptText,
    cwd: getRepoRoot(),
    uiClientId: ctx.uiClientId ?? null,
    priority: launchPriority,
    signal: ctx.signal,
    emit: ctx.emit,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          runId,
          sessionId,
          status,
          planSlug: input.slug,
          costUsd,
        }),
      },
    ],
  };
}

export default defineTool({
  name: 'plans:launch',
  profile: 'engineer',
  description:
    'Launch an autonomous agent on a plan. Assembles the plan context bundle (plan doc + revision rationale), starts a resumable run, streams the agent, records it in plan_runs. Returns the run id + session id.',
  guidance: {
    when: 'You want an agent to autonomously advance a plan — pick up its next actionable item and work it.',
    notWhen:
      'You only want to read a plan (plans:get) or edit it yourself (the plans:set-* verbs). Resuming an existing run is a continue call, not a fresh launch.',
    chaining:
      'plans:list / plans:get → plans:launch { slug } → the run streams; plans:runs lists past launches.',
    seeAlso: [
      'fleet:launch-on-plan (launch a whole FLEET on the plan, not one agent)',
      'plans:start (mark started without dispatching an agent)',
      'plans:runs (watch / list the launched runs)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  timeoutSec: 600,
  idleTimeoutSec: 120,
  // Streaming tool — opt into the replay ring buffer, same budget as
  // oracle:chat / architect:chat.
  replayBufferSize: 5000,
  args: argsSchema,
  events: EVENTS,
  handler: launchHandler,
});
