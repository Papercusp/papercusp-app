/**
 * Launch the holder of an EXISTING goal from a deterministic system action.
 *
 * `goals:start` and `goal-auto-start` create a goal and its first holder in one
 * operation. Recovery is a different shape: the goal row already exists, so a
 * system caller must resolve that goal's launch policy explicitly and open a
 * fresh tracked session through the same `launch-su` door the GUI uses.
 *
 * Keep the launch and the later attachment separate. This action returns the
 * pre-pinned owner id; the holder-loss reconciler owns attaching that identity
 * to the goal only after the launch succeeds.
 */
import { composeLaunchModelSpec } from '../../agent-config-constants';
import {
  goalArmWithholdsBrief,
  renderGoalPortfolioBrief,
  resolveGoalBehaviorArm,
  resolveGoalLaunchForGoal,
  type GoalLaunchResolution,
} from '../../goal-launch-settings';
import {
  bindGoalLaunchIdentity,
  buildGoalKickoffBrief,
  GOAL_HISTORY_CONTEXT_HEADING,
  renderGoalHistoryContext,
} from '../../agent-tools/goals/start';
import type { GoalHistoryContext } from '../../prior-attempt-context';
import { launchAgent, type LaunchAgentResult } from '../../launch-agent';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { setMode } from '../../modes/store';
import { deactivateLoop } from './loop';
import { notifyAgentOrdersChanged } from '../../agent-orders-notify';
import { sendMessage } from '../../agent-tools/coordination/messages';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';

export interface GoalHolderLaunchInput {
  workspaceId: string;
  goalId: string;
  harnessSlug: string;
  /** Best-effort attribution for a budget-refusal escalation. */
  launcherOwnerId?: string | null;
  /** Test/probe seam: record the launch without opening a process. */
  deferSpawn?: boolean;
  /** First-turn brief for the spawned holder (launch-su `kickoff_prompt` →
   *  the spawn-safe PAPERCUSP_KICKOFF_PROMPT env). Omitted ⇒ build the
   *  canonical brief from the goal row returned by launch-policy resolution. */
  kickoffPrompt?: string | null;
  /** Exact portfolio text already rendered by the activation caller. */
  renderedPortfolio?: string | null;
  /**
   * A resolution already assembled by the caller's activation transaction.
   * Existing-goal activation reads the goal's policy and GOAL portfolio once,
   * then hands that exact projection through here; resolving again in this
   * door would both pay for a second projection and allow the first-turn brief
   * to disagree with the activation read. Direct recovery callers omit this
   * and keep the historical resolver-owned path.
   */
  resolvedLaunch?: GoalLaunchResolution | null;
}

export interface GoalHolderLaunchResult {
  ownerId: string;
  /** Fail-open policy reads and launch-su process warnings, never swallowed. */
  warnings: string[];
  identityContribution?: Awaited<ReturnType<typeof bindGoalLaunchIdentity>>;
}

export interface GoalHolderLaunchDeps {
  resolveGoalLaunch: (args: {
    workspaceId: string;
    goalId: string;
    launcherOwnerId?: string | null;
    goalRole: 'goal';
    requested: Record<string, never>;
  }) => Promise<GoalLaunchResolution>;
  launch: (opts: Parameters<typeof launchAgent>[0]) => Promise<LaunchAgentResult>;
  readHistory: (goalId: string) => Promise<GoalHistoryContext>;
  bindIdentity?: typeof bindGoalLaunchIdentity;
  renderPortfolio?: typeof renderGoalPortfolioBrief;
}

const GOAL_HOLDER_NEUTRALIZER: AgentIdentity = {
  ownerId: 'goal-holder-neutralizer',
  ownerLabel: 'system · goal holder neutralizer',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface GoalHolderNeutralizeDeps {
  deactivate: (ownerId: string, reason: string) => Promise<boolean>;
  clearAuto: (workspaceId: string, ownerId: string, reason: string) => Promise<boolean>;
  notifyOrders: (ownerId: string) => Promise<void>;
  message: (ownerId: string, summary: string, body: string) => Promise<void>;
  wake: (ownerId: string, summary: string, workspaceId: string) => Promise<{ woken: number; staged: number }>;
}

const DEFAULT_NEUTRALIZE_DEPS: GoalHolderNeutralizeDeps = {
  deactivate: async (ownerId, reason) =>
    await deactivateLoop(ownerId, { actor: GOAL_HOLDER_NEUTRALIZER.ownerId, reason }),
  clearAuto: async (workspaceId, ownerId, reason) => {
    const result = await setMode({
      workspaceId,
      ownerId,
      modeId: 'auto',
      enabled: false,
      reason,
      setBy: GOAL_HOLDER_NEUTRALIZER.ownerId,
    });
    return result.ok;
  },
  notifyOrders: notifyAgentOrdersChanged,
  message: async (ownerId, summary, body) => {
    await sendMessage(GOAL_HOLDER_NEUTRALIZER, { to: [ownerId], summary, body });
  },
  wake: async (ownerId, summary, workspaceId) => {
    const result = await wakeRecipients([ownerId], {
      summary,
      payload: { action: 'stand-down', reason: 'goal-holder-election-cas-lost' },
      source: GOAL_HOLDER_NEUTRALIZER.ownerId,
      workspaceId,
    });
    return { woken: result.woken, staged: result.staged };
  },
};

/**
 * Quiesce a process launched between a stale liveness read and a losing attach
 * CAS. It remains an auditable session, but has neither AUTO recurrence nor an
 * armed loop and is woken with an explicit stand-down order.
 */
export async function neutralizeGoalHolderSession(
  input: { workspaceId: string; goalId: string; ownerId: string; reason: string },
  deps: GoalHolderNeutralizeDeps = DEFAULT_NEUTRALIZE_DEPS,
): Promise<{ loopDeactivated: boolean; autoCleared: boolean; woken: number; staged: number }> {
  const summary = `GOAL launch neutralized: '${input.goalId}' elected another holder before ${input.ownerId} attached`;
  const loopDeactivated = await deps.deactivate(input.ownerId, input.reason);
  const autoCleared = await deps.clearAuto(input.workspaceId, input.ownerId, input.reason);
  await deps.notifyOrders(input.ownerId);
  await deps.message(
    input.ownerId,
    summary,
    `Your process launched for '${input.goalId}', but the holder attachment compare-and-set lost ` +
      `to a newer elected lease. AUTO and the recurring loop were disabled. Do not act on the kickoff, ` +
      `do not retry GOAL acquisition, and end this session after recording any diagnostic evidence.`,
  );
  const wake = await deps.wake(input.ownerId, summary, input.workspaceId);
  return { loopDeactivated, autoCleared, woken: wake.woken, staged: wake.staged };
}

const DEFAULT_DEPS: GoalHolderLaunchDeps = {
  resolveGoalLaunch: resolveGoalLaunchForGoal,
  launch: launchAgent,
  // Loading the history compiler eagerly pulls the complete plan/source read
  // graph into every system-action bootstrap. Keep that graph behind the one
  // recovery path that actually consumes it so narrow plan-source test doubles
  // (and unrelated runtime boot) do not inherit this optional enrichment.
  readHistory: async (goalId) =>
    (await import('../../prior-attempt-context')).readGoalHistoryContext(goalId),
};

function required(value: string | null | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`goal-holder-launch requires ${name}`);
  return trimmed;
}

/**
 * Resolve one existing goal and launch its replacement holder.
 *
 * A formed refusal is hard: launching anyway would bypass the goal's budget or
 * headcount ceiling. A degraded resolution is fail-open by the resolver's
 * contract, but every reason is returned to the action log/caller so the launch
 * is never reported as fully governed when it was not.
 */
export async function launchGoalHolderSession(
  input: GoalHolderLaunchInput,
  deps: GoalHolderLaunchDeps = DEFAULT_DEPS,
): Promise<GoalHolderLaunchResult> {
  const workspaceId = required(input.workspaceId, 'workspaceId');
  const goalId = required(input.goalId, 'goalId');
  const harnessSlug = required(input.harnessSlug, 'harnessSlug');

  const resolved =
    input.resolvedLaunch ??
    (await deps.resolveGoalLaunch({
      workspaceId,
      goalId,
      launcherOwnerId: input.launcherOwnerId ?? null,
      goalRole: 'goal',
      requested: {},
    }));
  if (resolved.goalId !== goalId) {
    throw new Error(
      `goal-holder-launch refused for ${goalId}: the supplied launch resolution targets ` +
        `${resolved.goalId ?? 'no goal'} — refusing to launch with mismatched goal policy`,
    );
  }
  if (resolved.refusal) {
    throw new Error(`goal-holder-launch refused for ${goalId}: ${resolved.refusal.message}`);
  }

  // EI-21640746714079700: recovery launches AUTO first and attaches GOAL mode
  // only after the process exists. A null kickoff therefore cannot "re-orient"
  // from the later attachment — the first turn has already received no goal and
  // correctly asks the operator for a task. Build from the goal row that the
  // launch-policy resolver already read, so every omitted-kickoff caller (the
  // respawner and the on-demand system action) gets the same canonical brief as
  // goals:start/startGoalById without another DB read or another prompt copy.
  const explicitKickoff = input.kickoffPrompt?.trim();
  // R-4 / D-032: a relaunched holder must stay in its goal's experiment arm, so
  // the arm is re-derived from the SAME resolved policy on every launch path.
  const behaviorArm = resolveGoalBehaviorArm(resolved.settings);
  const withholdBrief = goalArmWithholdsBrief(behaviorArm);
  const portfolioBlock = withholdBrief
    ? null
    : input.renderedPortfolio !== undefined
    ? input.renderedPortfolio
    : resolved.goalBrief?.portfolio &&
        (!explicitKickoff || !explicitKickoff.includes('GOAL PORTFOLIO SNAPSHOT —'))
      ? (deps.renderPortfolio ?? renderGoalPortfolioBrief)(resolved.goalBrief.portfolio)
      : null;
  const history = withholdBrief ? null : await deps.readHistory(goalId);
  const historyBlock = history === null ? null : renderGoalHistoryContext(history);
  const kickoffPrompt = explicitKickoff
    ? [
        input.kickoffPrompt!,
        portfolioBlock && !explicitKickoff.includes('GOAL PORTFOLIO SNAPSHOT —') ? portfolioBlock : null,
        !explicitKickoff.includes(GOAL_HISTORY_CONTEXT_HEADING) ? historyBlock : null,
      ]
        .filter(Boolean)
        .join('\n\n')
    : resolved.goalBrief
      ? buildGoalKickoffBrief({ goalId, ...resolved.goalBrief, renderedPortfolio: portfolioBlock, history, behaviorArm })
      : null;
  if (!kickoffPrompt) {
    throw new Error(
      `goal-holder-launch refused for ${goalId}: launch policy resolved without the goal fields ` +
        'needed to build a canonical first-turn kickoff',
    );
  }

  const model = composeLaunchModelSpec(resolved.effective.model, resolved.effective.effort);
  const launched = await deps.launch({
    slug: harnessSlug,
    agent: resolved.effective.agent,
    model,
    account: resolved.effective.account,
    contextSize: resolved.effective.contextSize,
    // WI-2140338 [owner 2026-09-01]: a goal may pin its holder's token ceiling
    // (e.g. the model's full ~1M window). Absent stays absent — tier default.
    compactionLimit: resolved.effective.compactionLimit,
    // D-002: unpinned resolves to headless, which is what this door hardcoded
    // before the key existed — so every goal that has pinned nothing launches
    // exactly as it did. Only an explicit `headless:false` on the goal's launch
    // settings opens the holder on a visible desktop terminal.
    headless: resolved.effective.headless ?? true,
    // The GOAL attachment below is the only authority for AUTO and IDEATE.
    // Bootstrap waits for that exact subject and its cascade before turn one.
    goalBootstrapSubject: goalId,
    deferSpawn: input.deferSpawn ?? false,
    kickoffPrompt,
  });
  if (!launched.ok) {
    throw new Error(
      `goal-holder-launch failed for ${goalId}: ${launched.error ?? 'launch-su returned no error detail'}`,
    );
  }
  if (!launched.ownerId) {
    throw new Error(
      `goal-holder-launch failed for ${goalId}: launch-su succeeded without the pre-pinned ownerId needed to attach the holder`,
    );
  }
  const identityContribution = await (deps.bindIdentity ?? bindGoalLaunchIdentity)({
    goalId, ownerId: launched.ownerId, workspaceId, kickoff: kickoffPrompt,
    portfolio: portfolioBlock, behaviorArm,
  });

  return {
    ownerId: launched.ownerId,
    identityContribution,
    warnings: [
      ...resolved.degradedReasons.map((reason) => `launch policy degraded: ${reason}`),
      ...(launched.warning ? [`launch-su warning: ${launched.warning}`] : []),
    ],
  };
}

function optionalPayloadString(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function runGoalHolderLaunchAction(
  ctx: SystemActionCtx,
  deps: GoalHolderLaunchDeps = DEFAULT_DEPS,
): Promise<GoalHolderLaunchResult> {
  const goalId = optionalPayloadString(ctx.payloadTemplate, 'goalId');
  const launcherOwnerId = optionalPayloadString(ctx.payloadTemplate, 'launcherOwnerId');
  const result = await launchGoalHolderSession(
    {
      workspaceId: ctx.workspaceId,
      goalId: goalId ?? '',
      harnessSlug: ctx.installSlug,
      launcherOwnerId,
    },
    deps,
  );
  for (const warning of result.warnings) {
    console.warn(`[goal-holder-launch] ${goalId}: ${warning}`);
  }
  return result;
}

// `scheduling: 'on-demand'` (EI-18752496371939475): rows are materialized per GOAL, carrying
// that goal's id in `payload_template` (see register-system-actions.ts), not seeded once per
// workspace. Zero rows means no goal currently needs a holder — not a missing seed.
registerSystemAction(
  'goal-holder-launch',
  async (ctx) => {
    await runGoalHolderLaunchAction(ctx);
  },
  { scheduling: 'on-demand' },
);
