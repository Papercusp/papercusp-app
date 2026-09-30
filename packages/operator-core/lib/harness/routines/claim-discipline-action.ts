/**
 * `system:claim-discipline-watch` — the claim-discipline backstop
 * (claim-discipline-enforcement-2026-06-10).
 *
 * Each tick, sweep LIVE presence for agents that are ALIVE and DECLARED on a
 * plan but hold NO claim backing it (the `declaredUnclaimed` smell), and
 * inject a coord nudge teaching the fix (claim-on-wip / declare-intent items).
 * Inject only — never wake: the nudge lands on the agent's next natural turn;
 * a discipline reminder is not worth a turn (turn-lifecycle D-007).
 *
 * Reads DIRECTLY from coord_presence (not the fleet_assignment view) to ensure
 * LIVE data — the view aggregates from multiple tables and may lag presence
 * updates (EI-483).
 *
 * Self-throttled via its OWN outbox (no new state table): an agent nudged
 * within the throttle window is skipped — derived from PG, restart-safe. The
 * "grace period" before a first nudge is the routine's own cadence (the seed's
 * 10-min cron): an agent that declares and claims within one tick is never
 * nudged at all.
 *
 * Agents with an intent but NO declared plan are NOT targeted — ad-hoc,
 * non-plan work has nothing to claim.
 */
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getOrgPg } from '@papercusp/db-org';
import { listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import { STALE_MS } from '../../liveness';
import { listPresence } from '../../agent-tools/coordination/presence';
import { sendMessage, readOutbox } from '../../agent-tools/coordination/messages';
import type { AgentIdentity } from '../../agent-tools/coordination/identity';
import { planSlugExistsInWorkspace, planTerminalityInWorkspace } from '../../agent-tools/plans/source';
import { isTerminalPlanStatus } from '../../agent-tools/plans/plan-start-state';
import { inspectEventKey, listParkedAwaitsForSubscribers } from '../../events/await/store';
import { getLoopStatuses } from './loop';

export const CLAIM_WATCH_OWNER = 'claim-discipline-watch';
const WATCH_IDENTITY: AgentIdentity = {
  ownerId: CLAIM_WATCH_OWNER,
  ownerLabel: CLAIM_WATCH_OWNER,
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export const DEFAULT_THROTTLE_MS = 60 * 60 * 1000; // 1h between nudges per agent
/** A fleet-drained event is a transition signal, not permanent proof that a
 * declaration is stale. Keep the suppression bounded to the liveness window;
 * a later plan wave with the same slug must be eligible for a real nudge. */
export const DRAIN_SIGNAL_FRESH_MS = STALE_MS;
/** A terminal completion is a bounded convergence signal: the claim is released
 * synchronously, while the session clears or replaces its plan intent next turn. */
export const RECENT_COMPLETION_GRACE_MS = STALE_MS;

/**
 * Select live presence rows that are ALIVE and have a DECLARED PLAN.
 * Checked against claims and throttle history to identify nudge targets.
 */
export function selectDeclaredPresence(
  presenceRows: ReturnType<typeof listPresence> extends Promise<infer R> ? R : never,
): Array<{
  agentId: string;
  alive: boolean;
  declaredPlanSlug: string | null;
}> {
  const PRESENCE_STALE_MS = STALE_MS; // 10 min — the canonical liveness window (P-014 single source)
  const now = Date.now();

  return presenceRows
    .filter(
      (p) =>
        p.ownerId &&
        // Alive: heartbeat within 10 minutes
        p.heartbeatAt &&
        now - new Date(p.heartbeatAt).getTime() < PRESENCE_STALE_MS &&
        // Not revoked: ignore sessions whose auth was revoked (logged out, etc)
        !p.revoked,
    )
    .map((p) => ({
      agentId: p.ownerId,
      alive: true,
      declaredPlanSlug: p.currentPlanSlug ?? null,
    }));
}

/** Pure target selection — alive, declared a plan, claimed nothing on it, not recently nudged. */
export function selectNudgeTargets(
  declaredPresence: ReturnType<typeof selectDeclaredPresence>,
  claimedPlansByAgent: Map<string, Set<string>>,
  recentlyNudged: ReadonlySet<string>,
): typeof declaredPresence {
  return declaredPresence.filter((p) => {
    // Must be alive
    if (!p.alive) return false;
    // Must have a declared plan
    if (!p.declaredPlanSlug) return false;
    // Must not be in throttle window
    if (recentlyNudged.has(p.agentId)) return false;
    // Must have NO claims on the declared plan (declaredUnclaimed)
    const claims = claimedPlansByAgent.get(p.agentId);
    if (claims && claims.has(p.declaredPlanSlug)) return false;
    return true;
  });
}

/**
 * EI-7402: drop targets whose declared plan is NOT backed by any harness_plans
 * row (a file-only plan the store never ingested) — the plans:set-status remedy
 * this watch teaches can never succeed against one, so nudging it every wake is
 * pure, undischargeable noise. Pure over a precomputed existence map so the
 * decision is unit-testable without a PG round-trip; `existsByKey` keys on
 * `${workspaceId}::${planSlug}` (matching `storeExistsKey`). A slug missing
 * from the map (a lookup that failed) fails OPEN — kept, not silently dropped.
 */
export function storeExistsKey(workspaceId: string, planSlug: string): string {
  return `${workspaceId}::${planSlug}`;
}

export function filterStoreBackedTargets<T extends { agentId: string; declaredPlanSlug: string | null }>(
  targets: readonly T[],
  workspaceByAgent: ReadonlyMap<string, string>,
  existsByKey: ReadonlyMap<string, boolean>,
): { keep: T[]; skippedStoreAbsent: number } {
  const keep: T[] = [];
  let skippedStoreAbsent = 0;
  for (const t of targets) {
    const plan = t.declaredPlanSlug;
    if (plan) {
      const workspaceId = workspaceByAgent.get(t.agentId) ?? 'default';
      const exists = existsByKey.get(storeExistsKey(workspaceId, plan));
      if (exists === false) {
        skippedStoreAbsent += 1;
        continue;
      }
    }
    keep.push(t);
  }
  return { keep, skippedStoreAbsent };
}

/**
 * EI-16176: a plan that has SHIPPED/superseded, or has zero OPEN (non-terminal)
 * items left, has genuinely nothing left to claim — nudging its declared-but-
 * unclaimed agent every tick with "claim your lane" is undischargeable noise,
 * the same family as `filterStoreBackedTargets` (EI-7402: a store-absent plan
 * can never be claimed either). Pure over a precomputed terminality map so the
 * decision is unit-testable without PG. A slug missing from the map (a lookup
 * failure, or genuinely not found — filterStoreBackedTargets already dropped
 * those) fails OPEN — kept, not silently dropped — matching every other
 * filter's convention in this file.
 */
export function filterTerminalPlanTargets<T extends { agentId: string; declaredPlanSlug: string | null }>(
  targets: readonly T[],
  workspaceByAgent: ReadonlyMap<string, string>,
  terminalityByKey: ReadonlyMap<string, { status: string | null; hasOpenItems: boolean } | null>,
): { keep: T[]; skippedTerminalPlan: number } {
  const keep: T[] = [];
  let skippedTerminalPlan = 0;
  for (const t of targets) {
    const plan = t.declaredPlanSlug;
    if (plan) {
      const workspaceId = workspaceByAgent.get(t.agentId) ?? 'default';
      const info = terminalityByKey.get(storeExistsKey(workspaceId, plan));
      if (info && (isTerminalPlanStatus(info.status) || !info.hasOpenItems)) {
        skippedTerminalPlan += 1;
        continue;
      }
    }
    keep.push(t);
  }
  return { keep, skippedTerminalPlan };
}

/**
 * EI-13286: terminal completion releases a plan-item claim before the agent's
 * next turn clears or replaces its presence declaration. That is a healthy
 * convergence window, not an abandoned lane. Suppression is bounded, tied to
 * the same owner+plan, and requires completion after the current declaration;
 * missing evidence fails open so detector faults cannot hide a real miss.
 */
export function recentCompletionKey(workspaceId: string, agentId: string, planSlug: string): string {
  return `${workspaceId}::${agentId}::${planSlug}`;
}

/**
 * Read the latest genuine terminal completion per (workspace, owner, linked
 * plan). Both work-item families stamp the same terminal_owner/ref pair and the
 * same payload.plan_item.plan_slug; this is the cross-family read equivalent of
 * work_items:complete's shared finish contract.
 */
export async function loadRecentTerminalPlanCompletionTimes(
  workspaceIds: readonly string[],
  sinceMs: number,
): Promise<Map<string, number>> {
  if (workspaceIds.length === 0) return new Map();
  const { sql } = getOrgPg();
  const rows = await sql<Array<{
    workspace_id: string;
    agent_id: string;
    plan_slug: string;
    completed_ms: string | number;
  }>>`
    WITH completions AS (
      SELECT workspace_id,
             terminal_owner AS agent_id,
             payload #>> '{plan_item,plan_slug}' AS plan_slug,
             (extract(epoch FROM updated_at) * 1000)::bigint AS completed_ms
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ANY(${workspaceIds as string[]}::text[])
         AND terminal_owner IS NOT NULL AND terminal_owner <> ''
         AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
         AND payload #>> '{plan_item,plan_slug}' IS NOT NULL
         AND updated_at >= to_timestamp(${sinceMs}::double precision / 1000)
      UNION ALL
      SELECT workspace_id,
             terminal_owner AS agent_id,
             payload #>> '{plan_item,plan_slug}' AS plan_slug,
             updated_ts::bigint AS completed_ms
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ANY(${workspaceIds as string[]}::text[])
         AND terminal_owner IS NOT NULL AND terminal_owner <> ''
         AND terminal_completion_ref IS NOT NULL AND terminal_completion_ref <> ''
         AND payload #>> '{plan_item,plan_slug}' IS NOT NULL
         AND updated_ts >= ${sinceMs}
    )
    SELECT workspace_id, agent_id, plan_slug, max(completed_ms)::bigint AS completed_ms
      FROM completions
     GROUP BY workspace_id, agent_id, plan_slug
  `;
  return new Map(
    rows.flatMap((row) => {
      const completedMs = Number(row.completed_ms);
      return row.workspace_id && row.agent_id && row.plan_slug && Number.isFinite(completedMs)
        ? [[recentCompletionKey(row.workspace_id, row.agent_id, row.plan_slug), completedMs] as const]
        : [];
    }),
  );
}

export function filterRecentlyCompletedTargets<T extends { agentId: string; declaredPlanSlug: string | null }>(
  targets: readonly T[],
  workspaceByAgent: ReadonlyMap<string, string>,
  completedAtByKey: ReadonlyMap<string, number>,
  intentDeclaredAtByAgent: ReadonlyMap<string, string | null>,
  nowMs: number = Date.now(),
): { keep: T[]; skippedRecentlyCompleted: number } {
  const keep: T[] = [];
  let skippedRecentlyCompleted = 0;
  for (const target of targets) {
    const plan = target.declaredPlanSlug;
    const completedMs = plan
      ? completedAtByKey.get(
          recentCompletionKey(workspaceByAgent.get(target.agentId) ?? 'default', target.agentId, plan),
        )
      : undefined;
    const declaredAt = intentDeclaredAtByAgent.get(target.agentId);
    const declaredMs = declaredAt ? Date.parse(declaredAt) : NaN;
    const isRecent = completedMs !== undefined && nowMs >= completedMs && nowMs - completedMs <= RECENT_COMPLETION_GRACE_MS;
    const completionFollowsDeclaration = Number.isFinite(declaredMs) && completedMs !== undefined && completedMs >= declaredMs;
    if (isRecent && completionFollowsDeclaration) {
      skippedRecentlyCompleted += 1;
      continue;
    }
    keep.push(target);
  }
  return { keep, skippedRecentlyCompleted };
}

/**
 * P-002 (fleet-member-dx-improvements-2026-07-10, EI-9014): an agent PARKED on a
 * real (non-inbox-wake) events:await is DELIBERATELY idle — benched awaiting a
 * pushed event (typically its leader's "I'll emit when X greens; stop polling").
 * "Declared but unclaimed" is that agent's CORRECT state, not a discipline miss:
 * nagging it every tick pressures agents into grabbing out-of-lane work just to
 * silence the watch. Pure filter over a precomputed parked-key map so the
 * decision unit-tests without PG (the filterStoreBackedTargets pattern). The
 * parked read FAILING yields an empty map upstream — fail-open toward nudging
 * (a transient PG hiccup never suppresses a possibly-real nudge).
 */
export function filterParkedTargets<T extends { agentId: string }>(
  targets: readonly T[],
  parkedKeysByAgent: ReadonlyMap<string, readonly string[]>,
): { keep: T[]; skippedParked: Array<{ agentId: string; parkedOn: string }> } {
  const keep: T[] = [];
  const skippedParked: Array<{ agentId: string; parkedOn: string }> = [];
  for (const t of targets) {
    const keys = parkedKeysByAgent.get(t.agentId);
    if (keys && keys.length > 0) {
      skippedParked.push({ agentId: t.agentId, parkedOn: keys[0] });
      continue;
    }
    keep.push(t);
  }
  return { keep, skippedParked };
}

/**
 * P-010 (agent-operability): a healthy active engine loop is a durable claim on
 * the session's monitoring objective. It can legitimately have no plan-item
 * claim between wakes, so the claim-discipline watcher must not nag it. Loop
 * rows whose own dead-man verdict is stalled are intentionally NOT suppressed.
 */
export function filterHealthyLoopTargets<T extends { agentId: string }>(
  targets: readonly T[],
  healthyLoopOwners: ReadonlySet<string>,
): { keep: T[]; skippedLoopOwned: string[] } {
  const keep: T[] = [];
  const skippedLoopOwned: string[] = [];
  for (const target of targets) {
    if (healthyLoopOwners.has(target.agentId)) {
      skippedLoopOwned.push(target.agentId);
      continue;
    }
    keep.push(target);
  }
  return { keep, skippedLoopOwned };
}

/**
 * EI-11881: a fleet member can legitimately finish its last scoped item, get a
 * windDown miss, and retain its plan declaration until its next turn clears it.
 * The claim watch must not call that authoritative drained state a discipline
 * miss. Suppress only a RECENT drain emitted after the declaration; fail open
 * for missing/unparseable timestamps so a datastore/read race never hides a
 * genuine nudge. The pure boundary is recurrence-tested below.
 */
export function filterDrainedTargets<T extends { agentId: string }>(
  targets: readonly T[],
  drainedAtByAgent: ReadonlyMap<string, string>,
  intentDeclaredAtByAgent: ReadonlyMap<string, string | null>,
  nowMs: number = Date.now(),
): { keep: T[]; skippedDrained: string[] } {
  const keep: T[] = [];
  const skippedDrained: string[] = [];
  for (const target of targets) {
    const drainedAt = drainedAtByAgent.get(target.agentId);
    const drainedMs = drainedAt ? Date.parse(drainedAt) : NaN;
    const declaredAt = intentDeclaredAtByAgent.get(target.agentId);
    const declaredMs = declaredAt ? Date.parse(declaredAt) : NaN;
    const isRecentDrain = Number.isFinite(drainedMs) && nowMs >= drainedMs && nowMs - drainedMs <= DRAIN_SIGNAL_FRESH_MS;
    const drainFollowsDeclaration = Number.isFinite(declaredMs) && drainedMs >= declaredMs;
    if (isRecentDrain && drainFollowsDeclaration) {
      skippedDrained.push(target.agentId);
      continue;
    }
    keep.push(target);
  }
  return { keep, skippedDrained };
}

function latestEventFireAt(history: Awaited<ReturnType<typeof inspectEventKey>>): string | null {
  const candidates = [
    ...history.announcements.map((row) => row.firedAt),
    ...history.waiters.map((row) => row.firedAt),
    ...history.deliveries.map((row) => row.createdAt),
  ].filter((value): value is string => !!value);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
}

/** The stable summary prefix — also the outbox-throttle marker. */
export const NUDGE_PREFIX = 'claim-discipline:';

export function nudgeSummary(planSlug: string): string {
  return `${NUDGE_PREFIX} you declared "${planSlug}" but hold no plan-item claims — claim your lane`;
}

export function nudgeBody(planSlug: string): string {
  return [
    `You declared intent on plan "${planSlug}" but hold no claim on any of its items, so the Mug, the colony tab, and your peers cannot see which items are yours — work can be double-placed or look abandoned.`,
    '',
    'Claim your lane (either way works):',
    `  - plans:set-status { slug: '${planSlug}', item: 'P-NNN', status: 'wip' } — the wip flip now AUTO-CLAIMS the item for you.`,
    `  - coord:declare-intent { intent, current_plan_slug: '${planSlug}', items: ['P-NNN', …] } — claims the whole set and releases items you've moved off.`,
    '',
    'Flipping an item to done releases its claim automatically. If you are not actually working this plan anymore, re-declare your intent without it.',
  ].join('\n');
}

registerSystemAction('claim-discipline-watch', async (ctx: SystemActionCtx) => {
  const cfg = ctx.triggerConfig ?? {};
  const throttleMin = Number(cfg.throttle_min);
  const throttleMs =
    Number.isFinite(throttleMin) && throttleMin > 0 ? throttleMin * 60_000 : DEFAULT_THROTTLE_MS;

  // Read LIVE presence (not the fleet_assignment view which may lag presence updates).
  // Re-read presence to ensure we don't have cached/stale data from a prior run.
  const presenceRows = await listPresence();
  const declaredAgents = selectDeclaredPresence(presenceRows).filter((agent) => {
    // EI-483: verify the declared plan is current by checking the presence row
    // was recently heartbeaten (within 2 minutes). A stale currentPlanSlug after
    // an agent cleared its intent would show as a recent heartbeat but with null
    // currentPlanSlug, filtering it out at selectDeclaredPresence level.
    // This extra check handles the race where presence was read before the agent
    // wrote an updated row.
    const row = presenceRows.find((p) => p.ownerId === agent.agentId);
    if (!row || !row.heartbeatAt) return false;
    const now = Date.now();
    const heartbeatMs = new Date(row.heartbeatAt).getTime();
    return now - heartbeatMs < 2 * 60 * 1000; // Within 2 minutes
  });

  // Read which agents have claimed on which plans (to identify declaredUnclaimed).
  const assignmentRows = await listFleetAssignments({ workspaceId: null });
  const claimedPlansByAgent = new Map<string, Set<string>>();
  for (const row of assignmentRows) {
    // Only consider rows that represent actual claims (not presence rows).
    if (!row.agentId || row.source === 'presence' || !row.planSlug) continue;
    const set = claimedPlansByAgent.get(row.agentId) ?? new Set<string>();
    set.add(row.planSlug);
    claimedPlansByAgent.set(row.agentId, set);
  }

  const since = new Date(Date.now() - throttleMs).toISOString();
  const recent = await readOutbox(CLAIM_WATCH_OWNER, { since_ts: since });
  const recentlyNudged = new Set(
    recent
      .filter((e) => typeof e.summary === 'string' && e.summary.startsWith(NUDGE_PREFIX))
      .flatMap((e) => e.to),
  );

  const preTargets = selectNudgeTargets(declaredAgents, claimedPlansByAgent, recentlyNudged);

  // EI-7402: a declared plan slug that the plans:* store never ingested (authored
  // only as repo markdown, no harness_plans row in ANY harness) makes the
  // plans:set-status remedy below undischargeable — the agent would be nudged
  // every wake for a fix that can never succeed. Resolve existence per distinct
  // (workspace, plan) pair once, then let the pure filter decide who's kept.
  const workspaceByAgent = new Map(presenceRows.map((p) => [p.ownerId, p.workspaceId]));
  const existsByKey = new Map<string, boolean>();
  const terminalityByKey = new Map<string, { status: string | null; hasOpenItems: boolean } | null>();
  const distinctKeys = new Set(
    preTargets
      .filter((t): t is typeof t & { declaredPlanSlug: string } => !!t.declaredPlanSlug)
      .map((t) => storeExistsKey(workspaceByAgent.get(t.agentId) ?? 'default', t.declaredPlanSlug)),
  );
  await Promise.all(
    Array.from(distinctKeys).map(async (key) => {
      const [workspaceId, plan] = key.split('::');
      // Fail-open on a lookup error — never suppress a possibly-real nudge on a
      // transient PG hiccup; only an AFFIRMED absence skips the nudge.
      const exists = await planSlugExistsInWorkspace(workspaceId, plan).catch(() => true);
      existsByKey.set(key, exists);
      // EI-16176: fail-open (null) on lookup error — filterTerminalPlanTargets
      // treats a missing/null entry as "keep nudging" (unchanged behavior).
      const terminality = await planTerminalityInWorkspace(workspaceId, plan).catch(() => null);
      terminalityByKey.set(key, terminality);
    }),
  );

  const { keep: storeBacked, skippedStoreAbsent } = filterStoreBackedTargets(
    preTargets,
    workspaceByAgent,
    existsByKey,
  );

  // EI-16176: a shipped/superseded plan, or one with zero open items left, has
  // nothing left to claim — stop nudging it (same existence/state-of-the-plan
  // family as filterStoreBackedTargets above, before the AGENT-state filters
  // below).
  const { keep: notTerminalPlan, skippedTerminalPlan } = filterTerminalPlanTargets(
    storeBacked,
    workspaceByAgent,
    terminalityByKey,
  );

  // EI-13286: work_items:complete closes the linked item and releases its claim
  // synchronously, while presence can retain that plan slug until the next
  // turn. A same-owner completion AFTER the current declaration is therefore a
  // bounded convergence signal even when OTHER plan items remain open. A new
  // declaration after an old completion is not suppressed. Read failures fail
  // open to preserving real nudges.
  const completionNowMs = Date.now();
  const completionWorkspaces = [...new Set(notTerminalPlan.map((target) => workspaceByAgent.get(target.agentId) ?? 'default'))];
  const completedAtByKey = await loadRecentTerminalPlanCompletionTimes(
    completionWorkspaces,
    completionNowMs - RECENT_COMPLETION_GRACE_MS,
  ).catch(() => new Map<string, number>());
  const intentDeclaredAtByAgent = new Map(
    presenceRows.map((row) => [row.ownerId, row.intentDeclaredAt] as const),
  );
  const { keep: activePlans, skippedRecentlyCompleted } = filterRecentlyCompletedTargets(
    notTerminalPlan,
    workspaceByAgent,
    completedAtByKey,
    intentDeclaredAtByAgent,
    completionNowMs,
  );

  // EI-11881: scheduler:get_next emits fleet:drained:<slug> after a scoped
  // miss when the fleet is genuinely idle. Read that durable event history and
  // suppress only targets whose current declaration predates a fresh signal.
  // Missing history or a read failure is deliberately fail-open.
  const fleetByAgent = new Map<string, string>();
  for (const row of assignmentRows) {
    if (row.agentId && row.fleetSlug && !fleetByAgent.has(row.agentId)) {
      fleetByAgent.set(row.agentId, row.fleetSlug);
    }
  }
  const drainedAtByFleet = new Map<string, string>();
  const fleetSlugs = new Set(
    activePlans.flatMap((target) => {
      const fleet = fleetByAgent.get(target.agentId);
      return fleet ? [fleet] : [];
    }),
  );
  await Promise.all(
    Array.from(fleetSlugs).map(async (fleetSlug) => {
      try {
        const firedAt = latestEventFireAt(await inspectEventKey(`fleet:drained:${fleetSlug}`));
        if (firedAt) drainedAtByFleet.set(fleetSlug, firedAt);
      } catch {
        // Fail-open: event history is a detector hint, never a reason to hide a nudge.
      }
    }),
  );
  const drainedAtByAgent = new Map<string, string>();
  for (const target of activePlans) {
    const fleet = fleetByAgent.get(target.agentId);
    const drainedAt = fleet ? drainedAtByFleet.get(fleet) : undefined;
    if (drainedAt) drainedAtByAgent.set(target.agentId, drainedAt);
  }
  const { keep: notDrained, skippedDrained } = filterDrainedTargets(
    activePlans,
    drainedAtByAgent,
    intentDeclaredAtByAgent,
  );

  // P-002 (fleet-member-dx, EI-9014): drop targets deliberately PARKED on a real
  // events:await — their unclaimed state is a bench, not a discipline miss. A
  // failed read yields an empty map = nobody suppressed (fail-open to nudging).
  let parkedKeysByAgent = new Map<string, string[]>();
  try {
    const parkedRows = await listParkedAwaitsForSubscribers(notDrained.map((t) => t.agentId));
    for (const r of parkedRows) {
      const list = parkedKeysByAgent.get(r.subscriberId) ?? [];
      list.push(r.eventKey);
      parkedKeysByAgent.set(r.subscriberId, list);
    }
  } catch {
    parkedKeysByAgent = new Map();
  }
  const { keep: notParked, skippedParked } = filterParkedTargets(notDrained, parkedKeysByAgent);

  // P-010: suppress the second legitimate-idle shape — an active, healthy
  // loop-owned monitor between wakes. One batch query covers all candidates;
  // fail-open on read failure so a datastore hiccup never masks a real smell.
  let healthyLoopOwners = new Set<string>();
  try {
    const loops = await getLoopStatuses(notParked.map((t) => t.agentId));
    healthyLoopOwners = new Set(
      [...loops.entries()]
        .filter(([, status]) => status.active && !status.stalled)
        .map(([ownerId]) => ownerId),
    );
  } catch {
    healthyLoopOwners = new Set();
  }
  const { keep: targets, skippedLoopOwned } = filterHealthyLoopTargets(notParked, healthyLoopOwners);

  for (const t of targets) {
    const plan = t.declaredPlanSlug!;
    await sendMessage(WATCH_IDENTITY, {
      to: [t.agentId],
      summary: nudgeSummary(plan),
      body: nudgeBody(plan),
      plan_slug: plan,
    }).catch((e) =>
      console.warn(`[claim-discipline-watch] nudge to ${t.agentId} failed:`, (e as Error)?.message ?? e),
    );
  }
  console.log(
    `[claim-discipline-watch] ${declaredAgents.length} agent(s) declared → ${targets.length} nudged` +
      (skippedStoreAbsent ? `, ${skippedStoreAbsent} skipped (declared plan not in store — undischargeable remedy)` : '') +
      (skippedTerminalPlan ? `, ${skippedTerminalPlan} skipped (declared plan is terminal or has zero open items)` : '') +
      (skippedRecentlyCompleted ? `, ${skippedRecentlyCompleted} skipped (recent same-owner plan completion)` : '') +
      (skippedParked.length
        ? `, ${skippedParked.length} skipped (parked on events:await: ${skippedParked
            .map((s) => `${s.agentId.slice(0, 8)}→${s.parkedOn}`)
            .join(', ')})`
        : '') +
      (skippedDrained.length ? `, ${skippedDrained.length} skipped (recent fleet-drained signal)` : '') +
      (skippedLoopOwned.length
        ? `, ${skippedLoopOwned.length} skipped (healthy loop-owned monitor)`
        : '') +
      (recentlyNudged.size ? `, ${recentlyNudged.size} in throttle window` : ''),
  );
});
