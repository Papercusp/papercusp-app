/**
 * goal-auto-start.ts — the Blender goal rail's create+start core
 * (blender-loop-repair-and-opus5-xhigh-2026-08-16 P-013, D-005: "goal mode is
 * full auto too").
 *
 * The machine-caller sibling of the `goals:start` tool
 * (`../agent-tools/goals/start.ts`): same load-bearing order — row, then mode
 * stamp, then drain-fleet mint, then the (irreversible) spawn — same rollback
 * discipline, but callable from the autonomous Scout/Blender cycle where there
 * is no tool ctx, no owner at the composer, and no window to open (always
 * headless). It reuses the SAME primitives as the tool (insertGoalRow /
 * setMode / mintDrainFleetForGoal / buildConsoleEnvelope / spawnHeadless /
 * buildGoalKickoffBrief), so the two paths share every definition that can
 * drift — what they do NOT share is the tool-shaped handler around them
 * (ctx.tx, err() replies, console-vs-headless choice, HUD advisories).
 *
 * WHY BOTH RAILS ARE REQUIRED HERE when goals:start made them optional
 * (owner-directed, 2026-08-09): that overrule was about not blocking the OWNER
 * at creation time. D-005's full-auto mandate replaces the confirm card with
 * rails that ride INSIDE the goal record — an AUTONOMOUSLY created goal with no
 * stopping condition and no ceiling is exactly what GOAL mode's contract
 * exists to prevent, and there is no owner in the loop to accept that risk.
 * The router drafts both (`draftGoalRails`) and this door refuses to start
 * without them.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { deleteGoalRow, goalId, insertGoalRow, type GoalSqlTag } from '@papercusp/agent-mcp/goals';
import {
  applyGoalBlockedBy,
  readGoalReadiness,
  replaceGoalBlockedBy,
} from '@papercusp/agent-mcp/goal-deps';
import { killCriterionProblem } from './kill-criterion';
import { withCanonicalWorklistDeclaration } from './package-property-datatypes';
import {
  drainFleetAutoMintEnabled,
  mintDrainFleetForGoal,
  teardownDrainFleetMint,
} from './drain-fleet-mint';
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import { buildConsoleEnvelope } from '../console-launcher';
import { spawnHeadless } from '../console-spawn';
import { resolveSpawnHostOperatorBaseUrl } from '../mcp-base-url';
import { buildAgentLaunchCommand, injectFleetArg, injectLaunchedByArg } from '../agent-launch-core';
import { papercuspPathForWorkspace } from '../papercusp-root';
import { goalHolderInputRefusal, resolveGoalBehaviorArm, resolveGoalLaunchForGoal } from '../goal-launch-settings';
import { activeWorkspaceId } from '../workspace-registry';
import { setMode } from '../modes/store';
import { getOrgPg } from '@papercusp/db-org';
import { readGoalHistoryContext } from '../prior-attempt-context';
import { isHarnessInScope, primeWorkScopePolicy } from '../work-scope-policy';

export interface AutoStartGoalInput {
  /** Workspace to file the goal under (default: the active workspace). */
  workspaceId?: string;
  /** Scout source harness, or its workspace sentinel; an out-of-scope hive is re-homed for execution. */
  harnessSlug: string;
  /** The outcome, stated so its achievement is checkable. */
  title: string;
  /** The full statement (what winning looks like, scope, constraints). */
  body?: string | null;
  /** REQUIRED (D-005): the drafted abandonment condition. */
  killCriterion: string;
  /** REQUIRED (D-005): the drafted spend ceiling in cents. */
  budgetCents: number;
  /** Stable Scout route identity; required so retries cannot mint duplicate goals. */
  proposalId: string;
  /** Who caused this start (an ownerId, or the rail's own stamp). */
  launchedBy?: string | null;
  /** Prerequisite refs (goal ids / bare WI-/EI- issue ids) this goal is blocked by (P-004). */
  blockedBy?: readonly string[];
  /**
   * Acknowledge starting DESPITE unsatisfied blockers — without it the
   * activation gate (P-004) throws once, with the rollback the header promises.
   */
  startBlocked?: boolean;
  /** Why starting blocked is right — recorded as `startBlockedOverride` on the result. */
  startBlockedReason?: string | null;
}

export interface AutoStartGoalResult {
  goalId: string;
  /** The pre-pinned coord identity of the spawned GOAL-mode agent. */
  agentOwnerId: string;
  /** The auto-minted standing drain fleet, when the mint is enabled and succeeded. */
  drainFleet: string | null;
  /**
   * Non-null ONLY when the caller overrode the activation gate (P-004) — the
   * audit trail that this goal started with unsatisfied prerequisites.
   */
  startBlockedOverride: string | null;
  /** Fail-soft legs that degraded without stopping the start (drain fleet / member). */
  warnings: string[];
  /** True when this route reused a goal already created for the same proposal. */
  reusedExistingGoal?: boolean;
}

/**
 * Create a goal AND start its GOAL-mode agent, autonomously. Throws on any
 * failure that would leave a goal without an agent — with every compensable
 * side effect rolled back first — so a routing dispatch that catches the throw
 * records a clean per-decision error and nothing is left on the board that
 * nobody is pursuing (the exact failure `goals:start`'s header documents).
 */
export async function autoStartGoal(input: AutoStartGoalInput): Promise<AutoStartGoalResult> {
  const proposalId = typeof input.proposalId === 'string' ? input.proposalId.trim() : '';
  if (!proposalId) throw new Error('an auto-created Scout goal must carry proposalId for idempotency (nothing created)');

  const workspaceId = input.workspaceId ?? activeWorkspaceId();
  if (!workspaceId) throw new Error('no concrete workspace in scope — a goal cannot be filed workspace-less');
  const sourceScope = input.harnessSlug?.trim();
  if (!sourceScope) throw new Error('no harness in scope — goals are filed against an install_slug');
  let installSlug = sourceScope;
  // Prime first: an unprimed policy cache fails OPEN for ~60s after boot.
  await primeWorkScopePolicy();
  const sourceInScope = isHarnessInScope(sourceScope);
  if (sourceScope === workspaceId || !sourceInScope) {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const registry = await loadHarnessRegistry(workspaceId);
    const sourceProject = registry.projects.find((project) => project.slug === sourceScope);
    const workspaceSentinel = sourceScope === workspaceId && !sourceProject;
    const outOfScopeHive = !sourceInScope && sourceProject?.harness_kind === 'hive';

    // EI-22762141222831537: Scout's install key can be a workspace sentinel,
    // but a GOAL's install_slug must remain a real Pot for subsequent restarts.
    // Also re-home a registered source hive outside work-scope: its spawned
    // holder is confined to that hive and cannot later place work or launch a
    // fleet into the workspace's allowed home Pot. Keep registered, in-scope
    // harnesses concrete; do not silently broaden those caller choices.
    if (!workspaceSentinel && !outOfScopeHive && !sourceInScope) {
      throw new Error(
        `out-of-scope Scout source '${sourceScope}' is not a registered hive — nothing created or launched`,
      );
    }
    if (workspaceSentinel || outOfScopeHive) {
      // Resolve through the existing home-Pot policy BEFORE any goal/mode
      // writes, validating even an env-selected home against this workspace's
      // registry and active execution scope.
      const { resolveHomePotSlug } = await import('../agent-tools/pot/_resolve');
      const home = await resolveHomePotSlug(workspaceId);
      if (
        !home ||
        !registry.projects.some((project) => project.slug === home && project.harness_kind === 'hive') ||
        !isHarnessInScope(home)
      ) {
        throw new Error('workspace Scout goal has no registered home Pot in work-scope — nothing created or launched');
      }
      installSlug = home;
    }
  }

  const criterion = input.killCriterion?.trim();
  if (!criterion) throw new Error('an auto-created goal must carry a kill criterion (D-005)');
  const problem = killCriterionProblem(criterion);
  if (problem) throw new Error(problem);
  if (!Number.isFinite(input.budgetCents) || input.budgetCents < 0) {
    throw new Error('an auto-created goal must carry a non-negative budgetCents ceiling (D-005)');
  }

  // `routedProposalId` already lives on goals.metadata, so use it as the
  // idempotency key. The session advisory lock spans the goal insert, mode
  // stamp, optional drain-fleet creation, and holder spawn; a transaction lock
  // would release before the external spawn and allow a concurrent retry to
  // create a second steward.
  const poolSql = getOrgPg().sql;
  const reserved = await poolSql.reserve();
  const sql = reserved as unknown as GoalSqlTag;
  const proposalLockKey = `scout-goal-auto-start:${workspaceId}:${proposalId}`;
  let lockAttempted = false;
  try {
    // This dedicated connection may need to wait for the first start to finish.
    await reserved`SET lock_timeout = 0`;
    await reserved`SET statement_timeout = 0`;
    // Mark before awaiting: if PostgreSQL acquires the lock but its response is
    // lost, finally still attempts the matching unlock. Unlocking an unheld key
    // is harmless.
    lockAttempted = true;
    await reserved`SELECT pg_advisory_lock(hashtextextended(${proposalLockKey}, 0))`;

    const existingGoals = await reserved<Array<{
      id: string;
      status: string;
      metadata: Record<string, unknown> | null;
    }>>`
      SELECT id, status, metadata
        FROM harness_shared.goals
       WHERE workspace_id = ${workspaceId}
         AND metadata->>'routedProposalId' = ${proposalId}
         AND status NOT IN ('achieved', 'killed')
       ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END,
                created_at DESC,
                id ASC
       LIMIT 1
    `;
    const existing = existingGoals[0];
    if (existing) {
      const existingOwnerId =
        typeof existing.metadata?.agentOwnerId === 'string' ? existing.metadata.agentOwnerId.trim() : '';
      if (!existingOwnerId) {
        throw new Error(
          `routed proposal ${proposalId} already has goal ${existing.id}, but no holder identity is recorded; refusing a duplicate start`,
        );
      }
      return {
        goalId: existing.id,
        agentOwnerId: existingOwnerId,
        drainFleet: null,
        startBlockedOverride: null,
        warnings: [`routed proposal ${proposalId} already has goal ${existing.id}; reused without launching another holder`],
        reusedExistingGoal: true,
      };
    }

  const id = goalId(input.title);
  // PRE-PIN the agent's coord identity so the mode stamp can name it before it
  // exists (the same minting goals:start and /api/adv/launch-su do).
  const ownerId = `su-${randomUUID()}`;
  const launchedBy = input.launchedBy ?? 'scout-goal-rail';

  // Seed the canonical `worklist` declaration for the same reason
  // `goals:start` does: the placement gate reads
  // `properties->'worklist'->'value'` on EVERY goal, so a goal minted here
  // with property_schema '{}' could never have a worklist written to it
  // through any tool. This rail needs it MORE than the tool door, because
  // there is no owner in the loop to notice the dead end and work around it.
  const seededPropertySchema = withCanonicalWorklistDeclaration(null);

  // ── 1. the goal row ─────────────────────────────────────────────────────
  await insertGoalRow(sql, {
    id,
    installSlug,
    workspaceId,
    propertySchema: seededPropertySchema,
    title: input.title,
    body: input.body ?? null,
    budgetCents: input.budgetCents,
    status: 'active',
    killCriterion: criterion,
    metadata: {
      startedBy: launchedBy,
      agentOwnerId: ownerId,
      ...(sourceScope !== installSlug ? { scoutSourceScope: sourceScope } : {}),
      routedProposalId: proposalId,
    },
    // The holder policy, DECLARED rather than inherited
    // (goal-live-holder-guarantee-2026-08-18 P-003, D-008). The tool doors
    // refuse an undeclared goal because their caller has to answer the
    // question; this door answers it in code because it is the one caller that
    // cannot be asked — and it knows the answer with more certainty than any
    // agent could, since the next thing it does is SPAWN the headless session
    // that holds this goal. A goal created here with nothing holding it is
    // precisely the state the plan exists to make visible.
    //
    // Same reasoning as the rails above (D-005): an autonomously created goal
    // carries its rails explicitly because there is no owner in the loop to
    // accept the risk of a default nobody chose. `onLoss` is deliberately left
    // unpinned so it takes D-001's `deactivate` — respawn is opt-in per goal
    // and an auto-created goal is not where that opt-in belongs.
    launchSettings: { holder: { requireLive: true } },
  });

  // ── 1.5 blocked-by edges + the activation gate (P-004) ──────────────────
  // Same shape as goals:start: validate-and-write the edges (refuse+rollback —
  // this rail is about to spawn an agent against exactly this record), then
  // gate activation on readiness. Readiness is an ACTIVATION gate, never
  // dispatch (D-003); the gate throws ONCE and the caller overrides with
  // startBlocked (+ reason) when starting blocked is deliberate. Gated on
  // input.blockedBy: the goal row was minted moments ago, so the edges just
  // applied are the only edges it can have.
  let startBlockedOverride: string | null = null;
  if (input.blockedBy?.length) {
    const applied = await applyGoalBlockedBy(sql, {
      workspaceId,
      goalId: id,
      refs: input.blockedBy,
      createdBy: launchedBy,
    });
    if (!applied.ok) {
      await deleteGoalRow(sql, { id, workspaceId }).catch(() => {});
      throw new Error(`blockedBy refused (goal rolled back, nothing spawned): ${applied.problem}`);
    }
    const readiness = await readGoalReadiness(sql, workspaceId, id);
    if (!readiness.actionable) {
      const unsatisfied = readiness.blockers
        .filter((b) => b.verdict !== 'satisfied')
        .map((b) => `${b.ref} (${b.kind}/${b.status ?? 'absent'}/${b.verdict})`)
        .join(', ');
      if (!input.startBlocked) {
        await replaceGoalBlockedBy(sql, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
        await deleteGoalRow(sql, { id, workspaceId }).catch(() => {});
        throw new Error(
          `refusing to auto-start: unsatisfied blocker(s) ${unsatisfied} — goal rolled back, nothing spawned. ` +
            'File it as a STUB and arm it at activation instead (goals:create { blockedBy } — stub-then-arm, ' +
            'goal-dag-shared-substrate-2026-08-18 D-004), or pass startBlocked: true (+ startBlockedReason) ' +
            'if starting blocked is deliberate.',
        );
      }
      startBlockedOverride =
        input.startBlockedReason?.trim() || `started despite unsatisfied blocker(s): ${unsatisfied}`;
    }
  }

  // ── 2. the join: the pre-pinned agent, in GOAL mode, on THIS goal ───────
  const modeRes = await setMode({
    workspaceId,
    ownerId,
    modeId: 'goal',
    enabled: true,
    reason: `owns goal ${id} — ${input.title.slice(0, 120)}`,
    setBy: launchedBy,
    subject: id,
  });
  if (!modeRes.ok) {
    // Edges before the row (P-004): a deleted goal must not leave dangling
    // blocked-by edges behind — same rule as the rollback below.
    await replaceGoalBlockedBy(sql, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
    await deleteGoalRow(sql, { id, workspaceId }).catch(() => {});
    throw new Error(
      `could not put the goal's agent in GOAL mode (${modeRes.error ?? 'unknown error'}) — goal rolled back`,
    );
  }

  // ── 2.5 the standing drain fleet (GOAL contract clause 3) — fail-soft ───
  let drainFleet: { slug: string } | null = null;
  const warnings: string[] = [];
  if (await drainFleetAutoMintEnabled()) {
    try {
      const minted = await mintDrainFleetForGoal({
        workspaceId,
        harnessSlug: installSlug,
        goalId: id,
        goalTitle: input.title,
        agentOwnerId: ownerId,
        goalTx: sql,
      });
      drainFleet = { slug: minted.fleetSlug };
    } catch (e) {
      warnings.push(
        `drain-fleet auto-mint failed (goal started anyway; the goal-drain-fleet watchdog keeps reporting until a fleet exists): ${(e as Error)?.message ?? e}`,
      );
    }
  }

  // ── 3. the agent (headless, the only irreversible step — last) ──────────
  const rollback = async () => {
    if (drainFleet) {
      await teardownDrainFleetMint({ workspaceId, fleetSlug: drainFleet.slug }).catch(() => {});
    }
    for (const modeId of [
      'goal',
      ...(modeRes.implied ?? []).filter((i) => i.status === 'set').map((i) => i.mode),
    ]) {
      await setMode({
        workspaceId,
        ownerId,
        modeId,
        enabled: false,
        reason: 'auto-start failed — rolling back',
        setBy: launchedBy,
      }).catch(() => {});
    }
    // Edges before the row (P-004) — same rule as goals:start's rollback.
    await replaceGoalBlockedBy(sql, { workspaceId, goalId: id, blockers: [] }).catch(() => {});
    await deleteGoalRow(sql, { id, workspaceId }).catch(() => {});
  };

  let base;
  try {
    base = await buildConsoleEnvelope({
      workspaceId,
      slug: installSlug,
      operatorBaseUrl: resolveSpawnHostOperatorBaseUrl(),
      skipMcpJson: false,
    });
  } catch (e) {
    await rollback();
    throw new Error(`could not prepare the launch (goal rolled back): ${(e as Error)?.message ?? e}`);
  }

  const goalLaunch = await resolveGoalLaunchForGoal({
    workspaceId,
    goalId: id,
    goalRole: 'goal',
    requested: {},
  });
  if (goalLaunch.refusal) {
    await rollback();
    throw new Error(goalLaunch.refusal.message);
  }
  const inputRefusal = goalHolderInputRefusal(goalLaunch.holderReadiness);
  if (inputRefusal) {
    await rollback();
    throw new Error(inputRefusal);
  }

  let command: string;
  try {
    command = buildAgentLaunchCommand({
      mode: 'fresh',
      agent: goalLaunch.effective.agent ?? 'claude',
      harness: installSlug,
      ownerId,
      goalBootstrapSubject: id,
      account: goalLaunch.effective.account ?? null,
      model: goalLaunch.effective.model ?? null,
      effort: goalLaunch.effective.effort ?? null,
      contextSize: goalLaunch.effective.contextSize ?? null,
      headless: true,
    });
  } catch (e) {
    await rollback();
    throw new Error(`could not build the launch command (goal rolled back): ${(e as Error)?.message ?? e}`);
  }
  command = injectLaunchedByArg(command, launchedBy).command;

  const history = await readGoalHistoryContext(id);
  const env = {
    ...base.env,
    PAPERCUSP_KICKOFF_PROMPT: buildGoalKickoffBrief({
      goalId: id,
      title: input.title,
      killCriterion: criterion,
      budgetCents: input.budgetCents,
      body: input.body ?? null,
      portfolio: goalLaunch.goalBrief?.portfolio ?? null,
      history,
      // R-4 / D-032: the brief builder applies the arm's withholding itself.
      behaviorArm: resolveGoalBehaviorArm(goalLaunch.settings),
    }),
  };
  const logDir = join(papercuspPathForWorkspace(workspaceId), 'fleet-logs');
  const spawned = await spawnHeadless({
    envelope: { ...base, env, greetingCmd: command, cwd: base.cwd },
    label: `goal · ${input.title.slice(0, 40)} (auto)`,
    logDir,
    coordOwnerId: ownerId,
  });
  if (spawned.status !== 'ok') {
    await rollback();
    const detail = 'error' in spawned && spawned.error ? spawned.error : 'the spawn reported no detail';
    throw new Error(`the goal's agent failed to launch (${detail}) — goal rolled back, retrying is safe`);
  }

  // ── 3.5 the drain lane's puller — fail-soft, spawned last on purpose ────
  if (drainFleet) {
    try {
      let memberCmd = buildAgentLaunchCommand({
        mode: 'fresh',
        agent: goalLaunch.effective.agent ?? 'claude',
        harness: installSlug,
        account: goalLaunch.effective.account ?? null,
        headless: true,
      });
      memberCmd = injectFleetArg(memberCmd, drainFleet.slug).command;
      memberCmd = injectLaunchedByArg(memberCmd, launchedBy).command;
      // Deliberately `base.env` (no kickoff brief): the brief names ONE owner
      // of the goal, and a drain bee that received it would believe itself that
      // owner — same rule as goals:start.
      const member = await spawnHeadless({
        envelope: { ...base, greetingCmd: memberCmd, cwd: base.cwd },
        label: `goal-drain · ${input.title.slice(0, 40)} (auto)`,
        logDir,
      });
      if (member.status !== 'ok') {
        const detail = 'error' in member && member.error ? member.error : 'no detail';
        warnings.push(
          `drain-fleet member failed to launch (${detail}) — the fleet exists; the watchdog reports it dead until a member joins`,
        );
      }
    } catch (e) {
      warnings.push(`drain-fleet member launch threw: ${(e as Error)?.message ?? e}`);
    }
  }

  return {
    goalId: id,
    agentOwnerId: ownerId,
    drainFleet: drainFleet?.slug ?? null,
    startBlockedOverride,
    warnings,
    reusedExistingGoal: false,
  };
  } finally {
    if (lockAttempted) {
      await reserved`SELECT pg_advisory_unlock(hashtextextended(${proposalLockKey}, 0))`.catch(() => {});
    }
    reserved.release();
  }
}
