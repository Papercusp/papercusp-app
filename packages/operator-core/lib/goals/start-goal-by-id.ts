/**
 * start-goal-by-id.ts — ACTIVATE an existing goal: give it a live GOAL-mode
 * holder (work-on-everything-goal-2026-08-23 P-020, D-006).
 *
 * The third start shape. `goals:start` (the tool) and `autoStartGoal` (the
 * Blender rail) both CREATE a goal and spawn its first holder in one call.
 * This one takes a goal that ALREADY EXISTS — filed as a stub, deactivated,
 * or simply never picked up — and starts an agent to pursue it. It is the
 * shared activation core for every machine leg P-020 adds:
 *
 *   - the trigger binding-engine's `start-goal` action (a trigger fires →
 *     the goal it targets gets a holder),
 *   - the readiness watchdog's autoStart leg (a goal `became-ready` and its
 *     launch settings say autoStart → start it),
 *   - goal schedules (`system:goal-start` routine action).
 *
 * DELIBERATELY THIN — it composes primitives the holder-guarantee plan
 * (goal-live-holder-guarantee-2026-08-18) already shipped, rather than
 * re-extracting spawn code from `goals:start`:
 *
 *   launch — `launchGoalHolderSession` (goal-holder-launch-action.ts): the
 *            one existing-goal launch door; resolves the goal's own launch
 *            policy (budget/headcount refusals are HARD) and opens a tracked
 *            headless session through the same launch-su path the GUI uses.
 *   attach — `setMode` with `subject: goalId`, the SAME join `goals:start`
 *            and the goal-holder-respawner write. Launch FIRST, attach only
 *            the pre-pinned identity a successful launch returned — a failed
 *            launch can never leave a phantom holder row.
 *
 * THE IDEMPOTENCE GUARD (D-006) is what makes this safe to wire to triggers,
 * watchdogs and schedules — all of which re-fire:
 *
 *   - status !== 'active'  → refuse. A killed/achieved/paused goal is not
 *     silently resurrected by a stale trigger; reactivation is a deliberate
 *     owner act on the goal row, not a side effect of activation.
 *   - a LIVE holder        → refuse. Starting a held goal double-spawns.
 *   - holder liveness UNKNOWN → refuse. Degraded evidence is not absence
 *     (same rule as the respawner: unknown is non-actionable) — a re-fire
 *     retries once the oracle recovers.
 *
 * Refusals are RESULTS (`ok:false, reason`) because they are expected
 * outcomes a re-firing caller branches on; launch/attach failures THROW
 * because they mean the start should have happened and did not.
 *
 * READINESS is an activation gate here too (goal-dag-shared-substrate D-003):
 * this door is about to spawn an agent to pursue the goal RIGHT NOW, so
 * unsatisfied blocked-by prerequisites refuse — override with `startBlocked`
 * (+ reason) exactly like the sibling doors. The watchdog's autoStart leg
 * passes readiness by construction (it only fires on `became-ready`); the
 * trigger and schedule legs get the gate from here.
 */

import type { Sql } from 'postgres';
import type { GoalSqlTag } from '@papercusp/agent-mcp/goals';
import { readGoalReadiness } from '@papercusp/agent-mcp/goal-deps';
import {
  launchGoalHolderSession,
  neutralizeGoalHolderSession,
  type GoalHolderLaunchInput,
  type GoalHolderLaunchResult,
} from '../harness/routines/goal-holder-launch-action';
import { resolveGoalHolders, type GoalHolders } from './holder';
import { setMode, type GoalModeElectionExpectation, type GoalModeElectionReceipt } from '../modes/store';
import { notifyGoalHolderHandoff } from './holder-handoff';
import { refreshControlAnchorAfterMutation } from '../agent-tools/coordination/control-anchor';
// Same direction the sibling package-start door already imports (start-from-package.ts):
// lib/goals → lib/agent-tools/goals/start. No cycle; start.ts does not import this file.
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import { goalArmWithholdsBrief, goalHolderInputRefusal, renderGoalPortfolioBrief, resolveGoalBehaviorArm, resolveGoalLaunchForGoal, type GoalLaunchResolution } from '../goal-launch-settings';

export interface StartGoalByIdInput {
  workspaceId: string;
  goalId: string;
  /** Who caused this start (a trigger binding, a schedule, a watchdog) — attribution, never authority. */
  launcherOwnerId?: string | null;
  /**
   * Acknowledge starting DESPITE unsatisfied blocked-by prerequisites — the
   * same override the sibling doors take. Without it an unready goal refuses.
   */
  startBlocked?: boolean;
  /** Why starting blocked is right — echoed on the result as the audit trail. */
  startBlockedReason?: string | null;
  /** Test/probe seam, forwarded to the launch door: record without spawning. */
  deferSpawn?: boolean;
  /**
   * First-turn brief for the spawned holder, threaded to launch-su's
   * `kickoff_prompt` (the spawn-safe PAPERCUSP_KICKOFF_PROMPT env; psu
   * delivers it as the fresh CLI's first turn).
   *
   * OMITTED ⇒ this door now builds the brief from the goal row itself
   * (EI-21566842357792802). It previously sent `null`, and the spawned session
   * fell through to the generic fleet-member kickoff that names no goal — so
   * the holder never learned its own subject and worked the ordinary backlog
   * instead. That was the behavior of EVERY caller that omitted this: the
   * trigger, schedule and watchdog legs included.
   *
   * Pass a value only to OVERRIDE that default — as the package start door
   * (P-017) does, briefing from package content rather than the goal row.
   */
  kickoffPrompt?: string | null;
}

export type StartGoalByIdRefusalReason =
  | 'not-found'
  | 'not-active'
  | 'no-harness'
  | 'already-held'
  | 'holder-unknown'
  | 'not-ready'
  | 'operating-inputs';

export type StartGoalByIdResult =
  | {
      ok: true;
      goalId: string;
      /** The pre-pinned coord identity of the spawned GOAL-mode holder. */
      ownerId: string;
      /** Fail-open policy reads and launch warnings, never swallowed. */
      warnings: string[];
      /** The launch sink's selected GOAL component receipt, when supplied. */
      identityContribution?: GoalHolderLaunchResult['identityContribution'];
      /** Non-null ONLY when the caller overrode the readiness gate. */
      startBlockedOverride: string | null;
    }
  | { ok: false; reason: StartGoalByIdRefusalReason; detail: string };

/**
 * `budget_cents` / `budget_window_sec` are BIGINT, which postgres-js hands back
 * as a STRING. Passing that straight into a brief renders a plausible-looking
 * ceiling built from the wrong type, so coerce once, here — and return null for
 * anything non-finite rather than letting `NaN` reach the agent's brief.
 */
function numericOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export interface StartGoalByIdDeps {
  launch: (input: GoalHolderLaunchInput) => Promise<GoalHolderLaunchResult>;
  resolveHolders: (sql: Sql, opts: { workspaceId: string; goalId: string }) => Promise<GoalHolders>;
  readReadiness: (sql: Sql, workspaceId: string, goalId: string) => ReturnType<typeof readGoalReadiness>;
  /** The holder-row attachment — wraps `setMode` in production. */
  attach: (opts: {
    sql: Sql;
    workspaceId: string;
    goalId: string;
    ownerId: string;
    goalTitle: string;
    setBy: string;
    expectedLease: GoalModeElectionExpectation | null;
  }) => Promise<{
    ok: boolean;
    error?: string | null;
    goalElection?: GoalModeElectionReceipt;
  }>;
  neutralize: (input: { workspaceId: string; goalId: string; ownerId: string; reason: string }) => Promise<unknown>;
  notifyHandoff: (workspaceId: string, election: GoalModeElectionReceipt) => Promise<unknown>;
  /**
   * Refreshes the compact control projection after a direct GOAL attachment.
   * Injectable so this activation path can prove the projection refresh without
   * requiring the whole session/control-anchor substrate in a unit fixture.
   */
  refreshControlAnchor?: typeof refreshControlAnchorAfterMutation;
  /**
   * Stamps the denormalized owner identity after the GOAL-mode row attaches.
   * This is deliberately a separate, fail-soft post-start step: attachment is
   * the holder guarantee, while metadata is a convenience read projection.
   */
  stampAgentOwner: (sql: Sql, opts: { workspaceId: string; goalId: string; ownerId: string }) => Promise<void>;
  /**
   * Resolves the goal's launch policy and, for the GOAL slot, its one live
   * portfolio projection. The activation path owns this read so the exact
   * resolution can be handed to the launch door without a second projection.
   */
  resolveGoalLaunch: (args: Parameters<typeof resolveGoalLaunchForGoal>[0]) => Promise<GoalLaunchResolution>;
  /**
   * Builds the DEFAULT first-turn brief when the caller passes no
   * `kickoffPrompt` (EI-21566842357792802). Injectable for the same reason the
   * package-start door injects it: a brief is a string, and asserting on a stub
   * is how a test proves the goal's own fields reached it.
   */
  buildBrief: typeof buildGoalKickoffBrief;
  renderPortfolio?: typeof renderGoalPortfolioBrief;
}

export const DEFAULT_START_GOAL_BY_ID_DEPS: StartGoalByIdDeps = {
  launch: launchGoalHolderSession,
  resolveHolders: resolveGoalHolders,
  resolveGoalLaunch: resolveGoalLaunchForGoal,
  buildBrief: buildGoalKickoffBrief,
  // The structural GoalSqlTag/Sql mismatch is bridged HERE, once — the same
  // cast goal-auto-start.ts makes at its call site (postgres' PendingQuery is
  // Promise-like but the generic signatures are not mutually assignable).
  readReadiness: (sql, workspaceId, goalId) => readGoalReadiness(sql as unknown as GoalSqlTag, workspaceId, goalId),
  attach: async ({ sql, workspaceId, goalId, ownerId, goalTitle, setBy, expectedLease }) => {
    const result = await setMode({
      workspaceId,
      ownerId,
      modeId: 'goal',
      enabled: true,
      reason: `activated goal ${goalId} — ${goalTitle.slice(0, 120)}`,
      setBy,
      ownerDirected: false,
      subject: goalId,
      ...(expectedLease ? { goalElectionExpectation: expectedLease } : {}),
      sql,
    });
    return {
      ok: result.ok,
      error: !result.ok && 'error' in result ? (result.error ?? null) : null,
      ...(result.goalElection ? { goalElection: result.goalElection } : {}),
    };
  },
  neutralize: neutralizeGoalHolderSession,
  notifyHandoff: notifyGoalHolderHandoff,
  stampAgentOwner: async (sql, { workspaceId, goalId, ownerId }) => {
    await sql`
      UPDATE harness_shared.goals
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('agentOwnerId', ${ownerId}::text)
       WHERE id = ${goalId} AND workspace_id = ${workspaceId}`;
  },
};

/**
 * Start a holder for one existing goal. See the header for the guard and
 * refuse-vs-throw contract.
 */
export async function startGoalById(
  sql: Sql,
  input: StartGoalByIdInput,
  deps: StartGoalByIdDeps = DEFAULT_START_GOAL_BY_ID_DEPS,
): Promise<StartGoalByIdResult> {
  const workspaceId = input.workspaceId?.trim();
  const goalId = input.goalId?.trim();
  if (!workspaceId) throw new Error('startGoalById requires workspaceId');
  if (!goalId) throw new Error('startGoalById requires goalId');

  // ── the goal row ────────────────────────────────────────────────────────
  // EI-21566842357792802: the brief-shaped columns are selected HERE, not in a
  // second read at the launch site, because a goal that cannot be briefed is a
  // goal that should not be launched — the two facts belong to one row read.
  const rows = await sql<
    {
      id: string;
      title: string;
      status: string;
      install_slug: string | null;
      body: string | null;
      kill_criterion: string | null;
      budget_cents: string | number | null;
      budget_window_sec: string | number | null;
      standing: boolean | null;
    }[]
  >`
    SELECT id, title, status, install_slug,
           body, kill_criterion, budget_cents, budget_window_sec, standing
      FROM harness_shared.goals
     WHERE workspace_id = ${workspaceId} AND id = ${goalId}`;
  const goal = rows[0];
  if (!goal) {
    return { ok: false, reason: 'not-found', detail: `no goal '${goalId}' in workspace ${workspaceId}` };
  }
  if (goal.status !== 'active') {
    return {
      ok: false,
      reason: 'not-active',
      detail:
        `goal '${goalId}' is '${goal.status}', not 'active' — activation never resurrects a ` +
        `killed/achieved/paused goal; change the goal's status deliberately first`,
    };
  }
  const harnessSlug = goal.install_slug?.trim();
  if (!harnessSlug) {
    return {
      ok: false,
      reason: 'no-harness',
      detail: `goal '${goalId}' has no install_slug — a holder cannot be launched without a harness`,
    };
  }

  // ── the idempotence guard: who holds it right now ───────────────────────
  const holders = await deps.resolveHolders(sql, { workspaceId, goalId });
  if (holders.liveness === 'held') {
    const live = holders.live[0]?.ownerId ?? 'unknown owner';
    return {
      ok: false,
      reason: 'already-held',
      detail: `goal '${goalId}' already has a live holder (${live}) — starting again would double-spawn`,
    };
  }
  if (holders.liveness === 'unknown') {
    return {
      ok: false,
      reason: 'holder-unknown',
      detail:
        `goal '${goalId}' holder liveness is UNKNOWN (degraded evidence, not absence) — ` +
        `refusing to spawn against a possibly-live holder; retry when the liveness oracle recovers`,
    };
  }

  // ── the readiness gate (activation, never dispatch — D-003) ─────────────
  let startBlockedOverride: string | null = null;
  const readiness = await deps.readReadiness(sql, workspaceId, goalId);
  if (!readiness.actionable) {
    const unsatisfied = readiness.blockers
      .filter((b) => b.verdict !== 'satisfied')
      .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
      .join(', ');
    if (!input.startBlocked) {
      return {
        ok: false,
        reason: 'not-ready',
        detail:
          `goal '${goalId}' has unsatisfied blocker(s): ${unsatisfied}. Nothing was spawned. ` +
          `Pass startBlocked: true (+ startBlockedReason) if starting blocked is deliberate.`,
      };
    }
    startBlockedOverride = input.startBlockedReason?.trim() || `started despite unsatisfied blocker(s): ${unsatisfied}`;
  }

  /* EI-21566842357792802 — a goal agent MUST be told its goal.
     Until now, omitting `kickoffPrompt` sent `null` to the launch door, and the
     spawned session fell through to the generic fleet-member kickoff: "You are a
     fleet member with no human at your keyboard", naming no goal. The session
     was nonetheless stamped `overlay:goal` with the right subject, so the mode
     row and the delivered prompt DISAGREED — the goal read healthy on every
     surface while the agent, correctly following the only instruction it had,
     pulled unrelated backlog via scheduler:get_next.

     Observed end-to-end on goal `the-papercusp-desktop-gui-is-verified-end-to-end-9425fe`
     (holder su-830bbb98): the string '9425fe' first entered its context 18 MINUTES
     into the run, in the tool_result of its OWN agent_modes query — self-discovery,
     not delivery. In the meantime it closed four unrelated rename chunks and
     launched zero agents.

     Defaulting here rather than at the admin route is deliberate: the doc on
     `kickoffPrompt` called the unbriefed launch "the pre-P-017 behavior for every
     trigger/schedule/watchdog leg", so EVERY caller that omits it had the same
     defect. A per-door fix would have left the watchdog and external-trigger legs
     launching mute goal agents. An explicit caller-supplied brief still wins. */
  /*
     Resolve the GOAL launch slot HERE, before opening the process. This is the
     canonical existing-goal activation path, so it must pay the same
     `goalRole: 'goal'` portfolio read as `goals:start` and `goal-auto-start`.
     Hand the resulting object through to the launch door: resolving again
     there would be a second projection and could brief the holder from a
     different point-in-time portfolio.
  */
  const resolvedLaunch = await deps.resolveGoalLaunch({
    workspaceId,
    goalId,
    goalRole: 'goal',
    requested: {},
    launcherOwnerId: input.launcherOwnerId ?? null,
    sql,
  });
  if (resolvedLaunch.refusal) {
    throw new Error(`goal-holder-launch refused for ${goalId}: ${resolvedLaunch.refusal.message}`);
  }
  const inputRefusal = goalHolderInputRefusal(resolvedLaunch.holderReadiness);
  if (inputRefusal) {
    return { ok: false, reason: 'operating-inputs', detail: inputRefusal };
  }
  // R-4 / D-032: 'baseline' withholds the portfolio (and, in buildBrief and the
  // holder-launch door, the history block) on every launch path.
  const behaviorArm = resolveGoalBehaviorArm(resolvedLaunch.settings);
  const portfolio = goalArmWithholdsBrief(behaviorArm) ? null : resolvedLaunch.goalBrief?.portfolio ?? null;
  const portfolioText = portfolio && (input.kickoffPrompt == null ||
    !input.kickoffPrompt.includes('GOAL PORTFOLIO SNAPSHOT —'))
    ? (deps.renderPortfolio ?? renderGoalPortfolioBrief)(portfolio)
    : null;
  const kickoffPrompt =
    input.kickoffPrompt == null
      ? deps.buildBrief({
          goalId,
          title: goal.title,
          killCriterion: goal.kill_criterion,
          body: goal.body,
          budgetCents: numericOrNull(goal.budget_cents),
          budgetWindowSec: numericOrNull(goal.budget_window_sec),
          standing: goal.standing ?? false,
          portfolio,
          renderedPortfolio: portfolioText,
          behaviorArm,
        })
      : portfolioText
        ? input.kickoffPrompt + '\n\n' + portfolioText
        : input.kickoffPrompt;

  // ── launch, then attach (launch failures throw from the launch door) ────
  const launched = await deps.launch({
    workspaceId,
    goalId,
    harnessSlug,
    launcherOwnerId: input.launcherOwnerId ?? null,
    deferSpawn: input.deferSpawn ?? false,
    kickoffPrompt,
    renderedPortfolio: portfolioText,
    resolvedLaunch,
  });

  const setBy = input.launcherOwnerId ?? 'goal-start-by-id';
  const attach = await deps.attach({
    sql,
    workspaceId,
    goalId,
    ownerId: launched.ownerId,
    goalTitle: goal.title,
    setBy,
    expectedLease: holders.elected
      ? {
          ownerId: holders.elected.ownerId,
          epoch: holders.elected.goalLeaseEpoch ?? null,
        }
      : null,
  });
  if (!attach.ok) {
    const failure = attach.error ?? 'mode store refused';
    await deps.neutralize({
      workspaceId,
      goalId,
      ownerId: launched.ownerId,
      reason: `GOAL attachment failed after launch: ${failure}`,
    });
    throw new Error(
      `goal '${goalId}' agent launched (ownerId ${launched.ownerId}) but the GOAL-mode ` +
        `attachment failed (${failure}) — the launched session was neutralized and must not retry`,
    );
  }

  // `setMode` is also called directly by this activation primitive's default
  // attach closure, bypassing the mode tool's normal projection refresh. The
  // control anchor is safety context, so a refresh failure must never undo the
  // already-committed holder attachment.
  try {
    await (deps.refreshControlAnchor ?? refreshControlAnchorAfterMutation)({
      ownerId: launched.ownerId,
      workspaceId,
      origin: 'system',
      actorId: setBy,
      source: 'mode:set',
      ownerDirected: false,
      sql,
    });
  } catch {
    // The shared refresh is fail-soft by contract; preserve that contract for
    // injected implementations as well.
  }

  // The GOAL-mode row is the source-of-truth holder attachment. Keep the
  // convenience metadata projection in sync after that durable write, but do
  // not turn a successful launch into a refusal if this best-effort stamp is
  // temporarily unavailable (the watchdog can repair/report the divergence).
  const warnings = [...launched.warnings];
  if (attach.goalElection?.predecessorOwnerId) {
    await deps
      .notifyHandoff(workspaceId, attach.goalElection)
      .catch((error) => warnings.push(`holder handoff notice failed: ${(error as Error)?.message ?? error}`));
  }
  await deps
    .stampAgentOwner(sql, { workspaceId, goalId, ownerId: launched.ownerId })
    .catch((e) => warnings.push(`agentOwnerId stamp failed: ${(e as Error)?.message ?? e}`));

  return {
    ok: true,
    goalId,
    ownerId: launched.ownerId,
    warnings,
    ...(launched.identityContribution ? { identityContribution: launched.identityContribution } : {}),
    startBlockedOverride,
  };
}
