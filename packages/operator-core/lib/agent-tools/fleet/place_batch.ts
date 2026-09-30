/**
 * fleet:place_batch — one-wake BATCH placement for the Queen
 * (queen-autonomous-execution-2026-06-13, B-07 / P-001 + P-002).
 *
 * Collapses the Queen's SERIAL "for each ready task pick placement" loop into a
 * SINGLE call: gather the ready frontier + the live bees + the free-slot
 * headroom, rank each task↔bee by affinity (explicit-intent > file-overlap >
 * recent-activity > queue-similarity — placement-affinity.ts), then fan
 * placements across the fleet —
 *
 *   warm-inject onto a warm bee  →  fresh `cup:spawn` into a free slot  →  queue back
 *
 * — up to the fleet cap, in ONE turn. Affinity + the batch decision are pure
 * (placement-affinity.ts / batch-placement.ts); this tool is the gather→plan→
 * execute wrapper. Each placement is isolated (one failure never aborts the
 * batch), and warm-inject obeys the woken:0 ladder (a bee with no armed wake is
 * released + re-placed as a fresh spawn — queen.md "climb the ladder"). EI-490:
 * a woken:0 warm-inject target is ALSO auto-reaped (its nursery subtree
 * cancelled, freeing the concurrency slot it was zombie-squatting on) — the
 * Queen no longer has to manually fleet:tree → discover woken:0 → fleet:cancel
 * each dead row before headroom frees up; `summary.reaped` reports the count.
 *
 * Scale past the fleet ceiling (~16) is bounded by the credential pool, not this
 * tool (D-006): a batch larger than headroom simply spawns up to the ceiling and
 * queues the rest with an `await_event` to retry on a freed slot.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { QUEEN_PLACEMENT_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { planBatchPlacement, type BatchPlacementPlan, type PlacementDecision } from '../../fleet/batch-placement';
import { gatherFrontier, gatherLiveBees } from '../../fleet/placement-gather';
import { admitConflictFree } from '../../fleet/admit-conflict-free';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { isWorkspaceCoordinationOn } from '../../workspace-brain-scope';
import { potHomeSlugForHarness } from '../../hive-federation';
import { listPresence } from '../coordination/presence';
import { liveLockedPaths } from '../locks/live-lock-paths';
import type { PlacementBee, PlacementTask } from '../../fleet/placement-affinity';
import type { WakeMode } from '../coordination/wake-mode';
import { softText, clampText, LIMITS } from '../limits';

export interface PlacementResult {
  task: string;
  action: 'spawned' | 'injected' | 'inject-raced' | 'unplaced' | 'deferred' | 'spawn-failed' | 'error';
  bee?: string;
  spawn_id?: string | null;
  harness?: string | null;
  rank?: number;
  climbed_from?: string;
  await_event?: string;
  reason: string;
  error?: string;
}

/**
 * The effects `executeBatch` performs, as an injectable seam. Defaults (via
 * `loadExecuteBatchDeps`) are the real modules — the tool handler passes none,
 * so production behavior is unchanged. Tests inject fakes to exercise the
 * placement paths (woken:0 ladder, await_event ceiling, inject-race) without a
 * live fleet / PG.
 */
export interface ExecuteBatchDeps {
  spawnAgentInHarness: (typeof import('../../fleet/operator-spawn'))['spawnAgentInHarness'];
  claimWorkItem: (typeof import('../../work-items'))['claimWorkItem'];
  releaseWorkItem: (typeof import('../../work-items'))['releaseWorkItem'];
  reorderWorkItem: (typeof import('../../work-items'))['reorderWorkItem'];
  sendMessage: (typeof import('../coordination/messages'))['sendMessage'];
  wakeRecipients: (typeof import('../coordination/inbox-wake'))['wakeRecipients'];
  // EI-1611: ensure/subscribe the per-plan group topic. Separate seams (not one
  // combined helper) so a test can assert each call's args precisely.
  ensureGroupTopic: (typeof import('../coordination/topics'))['createTopic'];
  subscribeGroupTopic: (typeof import('../coordination/topics'))['subscribeTopic'];
  /**
   * EI-490: a warm-inject target whose wake came back undelivered (`woken:0`) is a
   * DEFINITIVE "this nursery row isn't actually a live bee" signal — the exact
   * discovery the Queen otherwise only made by hand (`fleet:tree` → `woken:0` →
   * `fleet:cancel`, repeated per zombie). Cancel that row's subtree immediately so
   * its concurrency slot frees NOW instead of staying wedged until someone notices.
   * Best-effort: a cancel failure never blocks the woken:0 ladder that rides on it.
   * Returns whether anything was actually cancelled (false ⇒ no bonus slot granted).
   */
  cancelDeadBee: (opts: {
    workspaceId: string;
    spawnId: string;
    reason: string;
    actor: AgentIdentity;
  }) => Promise<boolean>;
}

async function loadExecuteBatchDeps(): Promise<ExecuteBatchDeps> {
  const [spawn, wi, msgs, wake, topics] = await Promise.all([
    import('../../fleet/operator-spawn'),
    import('../../work-items'),
    import('../coordination/messages'),
    import('../coordination/inbox-wake'),
    import('../coordination/topics'),
  ]);
  return {
    spawnAgentInHarness: spawn.spawnAgentInHarness,
    claimWorkItem: wi.claimWorkItem,
    releaseWorkItem: wi.releaseWorkItem,
    reorderWorkItem: wi.reorderWorkItem,
    sendMessage: msgs.sendMessage,
    wakeRecipients: wake.wakeRecipients,
    ensureGroupTopic: topics.createTopic,
    subscribeGroupTopic: topics.subscribeTopic,
    cancelDeadBee: async ({ workspaceId, spawnId, reason, actor }) => {
      try {
        const [{ getOrgPg }, { cancelSubtree }] = await Promise.all([
          import('@papercusp/db-org'),
          import('../../fleet/nursery'),
        ]);
        const res = await cancelSubtree(getOrgPg().sql, { workspaceId, rootSpawnId: spawnId, reason, actor });
        return res.cancelled.length > 0;
      } catch (err) {
        console.warn(`[fleet:place_batch] EI-490 auto-reap of dead bee ${spawnId} failed (best-effort):`, err instanceof Error ? err.message : err);
        return false;
      }
    },
  };
}

export default defineTool({
  name: 'fleet:place_batch',
  profile: 'engineer',
  description:
    'Place a whole batch of ready work onto the fleet in ONE wake: ranks each task↔cup by affinity (explicit-intent > file-overlap > recent-activity > queue-similarity), then warm-injects onto warm cups / fresh-spawns into free slots / queues the overflow — up to the fleet ceiling. The Mug\'s serial placement loop, collapsed to one call. Pass `tasks` (your importance-ranked frontier) or a `harness` to pull its open backlog; `dry_run` returns the plan without acting.',
  guidance: {
    when: 'You (the Mug) have surveyed + ranked the ready frontier and want to place several tasks at once instead of placing one task per turn. Pass the ranked work-item ids as `tasks` (importance order) — the tool fans them across free slots + warm cups by affinity in one turn.',
    notWhen:
      'Placing a SINGLE task (just coord:send), or you have not yet surveyed the frontier (work_items:list + fleet:assignments first). Not a survey tool — it acts. Use dry_run:true to preview the plan.',
    chaining:
      'work_items:list (the frontier) + fleet:assignments (cup load) → fleet:place_batch { tasks } → fleet:tree to watch the fresh spawns; an await_event in the result means re-run for the deferred tail on a freed slot.',
  },
  capability: 'work_items:write',
  // tool-call-batching-wrappers-2026-06-21 P-011 — composite marker: replaces the
  // per-task placement loop (drives the catalog back-pointer). `cup:spawn` was the
  // other half of that pair until P-059 retired it; a back-pointer to a verb that
  // no longer resolves is a dead link in the catalog, so only coord:send remains.
  replaces: ['coord:send'],
  requirePrincipal: false,
  // Placement is the Queen's (or operator's) surface — same carve-out as cup:spawn:
  // the worker-bee + the watch-only sentinel are excluded (they don't place agents).
  // Overwatch excluded too (overwatch-role-2026-06-15 D-001): it does not place work.
  agentRoles: QUEEN_PLACEMENT_ROLES,
  args: z.object({
    tasks: z
      .array(z.string().min(1).max(120))
      .max(64)
      .optional()
      .describe('Ordered work-item ids (WI-/F-/EI-), IMPORTANCE order (index 0 = highest) — your ranked ready frontier. Omit to pull the open unassigned backlog from `harness`.'),
    harness: z
      .string()
      .max(80)
      .optional()
      .describe('Pull the OPEN unassigned backlog from this member harness (priority order) when `tasks` is not given. Also the spawn target for fresh cups.'),
    max: z.number().int().min(1).max(64).optional().describe('Hard cap on total placements this batch (default 32 / frontier size).'),
    brief: softText(LIMITS.BRIEF).optional().describe('Situational overlay applied to every placement (spawn prompt + warm-inject body) — the context the cups are MISSING, not a restatement of the work-item. Auto-truncated to 16000 chars if longer.'),
    tier: z.string().max(40).optional().describe('Model tier for fresh spawns (quick/standard/deep/luna/max — see your tier menu). Omit for the cup role default.'),
    inject_load_threshold: z.number().int().min(1).max(20).optional().describe('A cup whose projected load reaches this is no longer a warm-inject target (default 3).'),
    min_inject_affinity: z.number().min(0).max(100).optional().describe('Minimum affinity score to warm-inject vs fresh-spawn (default 1 ≈ one fully-fired low-tier signal).'),
    max_inject_per_bee: z.number().int().min(1).max(10).optional().describe('Max items to warm-inject onto one cup in this batch (default 2).'),
    affinity_kind: z
      .enum(['file-overlap', 'topic-overlap', 'entity-overlap'])
      .optional()
      .describe(
        "Which affinity signal dominates placement — your hive's `affinity.kind`. Default file-overlap (the coding hive); topic-overlap for a generic/research hive (a cup shares a SUBJECT, not files); entity-overlap for same-harness/scope. The ranker reweights accordingly (hive-blueprint-generalization P-011).",
      ),
    dry_run: z.boolean().optional().describe('Return the placement PLAN (decisions + counts) WITHOUT spawning/injecting — preview the batch.'),
    workspace: z.string().max(120).optional(),
  // EI-72: FAIL LOUD on unknown arg keys (same placement-path hazard as
  // cup:spawn — a new field sent to a stale host's schema gets silently
  // stripped, fanning out task-less placements). .strict() aligns the runtime
  // to the already-advertised additionalProperties:false contract.
  }).strict(),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const actorWs = actor.workspaceId && actor.workspaceId !== '*' ? actor.workspaceId : null;
    const workspaceId = args.workspace ?? actorWs ?? activeWorkspaceId();
    const limit = args.max ?? 32;

    const [gathered, bees] = await Promise.all([
      gatherFrontier({ ids: args.tasks, harness: args.harness, limit, workspaceId }),
      gatherLiveBees(workspaceId),
    ]);
    // P-002 touch-set exclusion (hive-scoped, flag-gated): among the ready frontier,
    // drop a task whose declared file touch-set overlaps a running bee's files or an
    // already-admitted sibling — proactive conflict avoidance (cross-hive collisions
    // stay on reactive git-merge). Flag OFF ⇒ tasks/skipped identical to today.
    let tasks = gathered.tasks;
    let skipped = gathered.skipped;
    if (await getFlag(FLAGS.TOUCH_SET_EXCLUSION, 'system').catch(() => false)) {
      // EI-18776963284535761: the presence half of this union (declared current_files)
      // was empty for EVERY live agent — coord:orient wiped it on every wake — so
      // "active peer lane" avoidance could never actually see a peer. The declared read
      // stays (it is the intent signal, and now survives a wake), but the LIVE LOCK
      // PLANE is the authoritative, automatic answer to "who is on this file": the
      // PreToolUse edit hook takes a lock on every Edit/Write, with no agent discipline
      // required. Fail-soft on both halves.
      const inUse = [
        ...bees.flatMap((b) => b.currentFiles ?? []),
        ...(await gatherLivePresenceCurrentFiles(workspaceId)),
        ...(await liveLockedPaths()),
      ];
      const { admitted, deferred } = admitConflictFree(tasks, inUse);
      tasks = admitted;
      if (deferred.length > 0) {
        skipped = [
          ...skipped,
          ...deferred.map((t) => ({
            id: t.id,
            reason: 'file-conflict — touch-set overlaps a running cup, active peer lane, or an admitted sibling (P-002/EI-3061)',
          })),
        ];
      }
    }

    const { getSpawnHeadroom } = await import('../../fleet/operator-spawn');
    const { headroom: rawHeadroom } = await getSpawnHeadroom(workspaceId);

    // MUG_CAPACITY_DISPATCH (capacity-aware dispatch — gateway-priority-tiers Phase 4): clamp the FRESH-spawn
    // headroom to what the inference pool can SUSTAIN. When the gateway is saturated/paused (all accounts
    // throttled), placing more bees just floods it with requests that park/fail. The frontier is importance-
    // ranked, so clamping the headroom naturally DEFERS the lowest-priority tasks first; a minHeadroom floor
    // always lets high-priority work flow (the gateway tiers then prioritize it). Flag-OFF or gateway-
    // unreachable ⇒ no clamp (rawHeadroom).
    const { queenCapacityHeadroom } = await import('../../fleet/capacity-dispatch');
    const capacity = await queenCapacityHeadroom(rawHeadroom);
    const headroom = capacity.headroom;

    const plan = planBatchPlacement({
      tasks,
      bees,
      headroom,
      max: args.max,
      injectLoadThreshold: args.inject_load_threshold,
      minInjectAffinity: args.min_inject_affinity,
      maxInjectPerBee: args.max_inject_per_bee,
      affinityKind: args.affinity_kind,
      now: Date.now(),
    });

    // P-003 (workspace-scoped-coordination-2026-06-20 / D-002): cross-hive routing
    // VISIBILITY for the central dispatcher. The route itself is already per-task
    // (`task.harness` → spawnAgentInHarness / affinity place onto that harness's —
    // hence that HIVE's — bees), so a cross-hive batch routes correctly with no
    // change to the live path. When WORKSPACE_COORDINATION is ON we ALSO resolve
    // each task's target hive (via the harness→hive tag, P-001) and surface the
    // per-hive routing breakdown so the Queen can SEE the cross-hive fan-out. OFF
    // (the dark default) ⇒ no resolution, no `byHive` key — BYTE-IDENTICAL to today.
    let byHive: Record<string, number> | undefined;
    if (await isWorkspaceCoordinationOn().catch(() => false)) {
      byHive = await routeByHive(tasks, workspaceId);
    }

    if (args.dry_run) {
      return json({
        ok: true,
        dry_run: true,
        surveyed: { frontier: tasks.length, bees: bees.length, headroom, ...(byHive ? { byHive } : {}), ...(capacity.throttled ? { rawHeadroom, capacity: capacity.reason } : {}) },
        plan: summarizePlan(plan),
        skipped,
      });
    }

    const exec = await executeBatch({ plan, headroom, bees, brief: clampText(args.brief, LIMITS.BRIEF) ?? null, tier: args.tier ?? null, actor, role: (ctx as { role?: string }).role ?? 'operator', workspaceId });
    // EI-590: surface a no-op-placement warning when fresh spawns can't actually
    // start (global wake-mode 'manual' → boot-wakes stage). Best-effort: a read
    // failure degrades to no warning, never blocks the placement result.
    const { getDefaultWakeMode } = await import('../coordination/wake-mode');
    const wakeMode = await getDefaultWakeMode().catch(() => 'auto' as WakeMode);
    const warnings = buildPlacementWarnings({ spawned: exec.summary.spawned ?? 0, wakeMode });
    return json({
      ok: true,
      surveyed: { frontier: tasks.length, bees: bees.length, headroom, ...(byHive ? { byHive } : {}), ...(capacity.throttled ? { rawHeadroom, capacity: capacity.reason } : {}) },
      ...exec,
      ...(warnings.length ? { warnings } : {}),
      skipped,
    });
  },
});

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

export interface PresenceFileRecord {
  stale?: boolean | null;
  currentFiles?: readonly string[] | null;
}

export function currentFilesFromLivePresence(records: readonly PresenceFileRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (r.stale) continue;
    for (const raw of r.currentFiles ?? []) {
      const file = raw.trim();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push(file);
    }
  }
  return out;
}

async function gatherLivePresenceCurrentFiles(workspaceId: string): Promise<string[]> {
  try {
    return currentFilesFromLivePresence(await listPresence({ workspaceId }));
  } catch (e) {
    console.warn(
      `[fleet:place_batch] presence file read failed — touch-set exclusion falls back to bee files only:`,
      e instanceof Error ? e.message : e,
    );
    return [];
  }
}

/**
 * P-003 (workspace-scoped-coordination / D-002): tally the batch's target HIVES.
 * Each task already routes by `task.harness` (spawn/affinity land it on that
 * harness's bees); this resolves the harness → its home hive (the P-001
 * source/target-hive tag, via `potHomeSlugForHarness`) so the central dispatcher
 * can SEE the cross-hive fan-out of one batch. Called ONLY when
 * WORKSPACE_COORDINATION is ON (so it never adds reads to the dark-default path).
 * A harness with no resolvable hive (operator-scope / un-tagged) buckets under
 * its own harness slug so the count is never silently dropped. Fail-soft per task.
 */
export async function routeByHive(
  tasks: readonly PlacementTask[],
  workspaceId: string,
): Promise<Record<string, number>> {
  const byHive: Record<string, number> = {};
  await Promise.all(
    tasks.map(async (t) => {
      const harness = t.harness ?? null;
      let hive: string;
      if (!harness) {
        hive = '(no-harness)';
      } else {
        hive = (await potHomeSlugForHarness(workspaceId, harness).catch(() => null)) ?? harness;
      }
      byHive[hive] = (byHive[hive] ?? 0) + 1;
    }),
  );
  return byHive;
}

/**
 * Merge a work-item's per-lane brief (`payload.brief` — the lane's MISSING
 * context, carried from a `## Promote` lane's `brief:` field) with the Queen's
 * batch-wide overlay. Both present → lane brief first then the overlay; either
 * alone → that one; neither → null (queen-wave-dispatch P-031).
 */
export function mergeBrief(
  laneBrief: string | null | undefined,
  overlay: string | null | undefined,
): string | null {
  const lane = laneBrief?.trim() || null;
  const over = overlay?.trim() || null;
  if (lane && over) return `${lane}\n\n${over}`;
  return lane ?? over ?? null;
}

/**
 * EI-590: a fresh-spawned bee's boot-wake STAGES (never fires) when the global
 * wake-mode is 'manual' (the pot:pause state) — the bees are placed but never
 * start, a silent no-op the caller otherwise reads as `spawned: N` success.
 * Surface it as a warning so the operator knows the placement won't run until
 * wake-mode is restored to 'auto'. Pure so it unit-tests without PG. (The other
 * historical no-op cause — the EI-524 bee read-only confinement — was LIFTED
 * 2026-06-14 when the fleet went fully autonomous, so manual wake-mode is now the
 * sole placement-no-op signal at this layer.)
 */
export function buildPlacementWarnings(opts: { spawned: number; wakeMode: WakeMode }): string[] {
  const warnings: string[] = [];
  if (opts.spawned > 0 && opts.wakeMode === 'manual') {
    warnings.push(
      `global wake-mode is 'manual' (pot paused): the ${opts.spawned} fresh-spawned cup(s) are placed but their boot-wake STAGES instead of firing — they will NOT start until wake-mode is restored to 'auto' (coord:wake-mode { mode: 'auto' }). This placement is a no-op until then.`,
    );
  }
  return warnings;
}

/** One shared-plan cohort this batch actually placed — the EI-1611 grouping unit. */
export interface TopicGroup {
  /** `plan:<planSlug>` — the topic slug ensured + subscribed. */
  topic: string;
  planSlug: string;
  /** Distinct placed-bee ownerIds (spawn_id for a fresh spawn, bee for a warm-inject). */
  ownerIds: string[];
}

/**
 * EI-1611 (Queen should place bees in topic-subscribed groups): group THIS
 * batch's ACTUALLY-PLACED bees (spawned or injected — never unplaced/deferred/
 * failed/errored) by shared `planSlug`. A cohort needs >=2 distinct bees to be
 * worth a shared channel — a lone placement has no sibling to coordinate with.
 * Pure + index-aligned with `plan.decisions` (executeBatch's placement loop
 * pushes exactly one PlacementResult per decision, in the same order), so no
 * PG/fleet state is needed to test this — see place_batch.test.ts.
 */
export function groupPlacementsForTopicSubscribe(
  decisions: readonly PlacementDecision[],
  placements: readonly PlacementResult[],
): TopicGroup[] {
  const byPlan = new Map<string, Set<string>>();
  const len = Math.min(decisions.length, placements.length);
  for (let i = 0; i < len; i++) {
    const planSlug = decisions[i].task.planSlug;
    if (!planSlug) continue;
    const p = placements[i];
    const ownerId = p.action === 'spawned' ? p.spawn_id : p.action === 'injected' ? p.bee : null;
    if (!ownerId) continue;
    const set = byPlan.get(planSlug) ?? new Set<string>();
    set.add(ownerId);
    byPlan.set(planSlug, set);
  }
  const groups: TopicGroup[] = [];
  for (const [planSlug, owners] of byPlan) {
    if (owners.size < 2) continue;
    groups.push({ topic: `plan:${planSlug}`, planSlug, ownerIds: [...owners].sort() });
  }
  return groups.sort((a, b) => a.planSlug.localeCompare(b.planSlug));
}

/**
 * EI-1611: ensure + subscribe every placed bee in each group's shared plan
 * topic. Best-effort per group (one group's failure never touches another's,
 * and NEVER reverts/blocks the already-committed placement it rides on — this
 * runs strictly after doSpawn/warm-inject have landed). Returns the count of
 * groups successfully wired + any per-group errors for the caller to surface.
 */
async function subscribeGroups(
  groups: readonly TopicGroup[],
  deps: Pick<ExecuteBatchDeps, 'ensureGroupTopic' | 'subscribeGroupTopic'>,
  opts: { actor: AgentIdentity; workspaceId: string },
): Promise<{ groupsSubscribed: number; groupErrors: string[] }> {
  let groupsSubscribed = 0;
  const groupErrors: string[] = [];
  for (const g of groups) {
    try {
      await deps.ensureGroupTopic(opts.actor, {
        slug: g.topic,
        title: `Plan ${g.planSlug}`,
        description: `Auto-created group channel (EI-1611): members placed together this batch on plan "${g.planSlug}" — sibling completions, decisions, blast-radius warnings.`,
      });
      for (const ownerId of g.ownerIds) {
        const beeIdentity: AgentIdentity = {
          ownerId,
          ownerLabel: ownerId,
          source: 'fleet-spawn',
          workspaceId: opts.workspaceId,
          userId: null,
        };
        // 3-day TTL: a group channel is for the LIFE of this placement cohort, not
        // a permanent subscription every bee ever placed on a plan accumulates.
        await deps.subscribeGroupTopic(beeIdentity, g.topic, { mode: 'full', ttl_sec: 3 * 24 * 3600 });
      }
      groupsSubscribed++;
    } catch (err) {
      groupErrors.push(`${g.topic}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { groupsSubscribed, groupErrors };
}

function summarizePlan(plan: BatchPlacementPlan) {
  return {
    spawn: plan.spawnCount,
    warm_inject: plan.injectCount,
    unplaced: plan.unplacedCount,
    decisions: plan.decisions.map((d) => ({
      task: d.task.id,
      disposition: d.disposition,
      ...(d.bee ? { bee: d.bee } : {}),
      ...(d.rank != null ? { rank: d.rank } : {}),
      reason: d.reason,
    })),
  };
}

/**
 * Execute a planned batch. Each placement is independent + try/caught so one
 * failure never aborts the rest. Fresh spawns draw from the reserved headroom;
 * woken:0 warm-inject fallbacks draw from the leftover (headroom − planned
 * spawns) so a fallback can never starve a planned spawn.
 */
/**
 * WI-5421: a warm-inject target's `woken:0` is NOT a definitive death signal while the
 * bee is still within its boot window — a booting cup (CLI launch + orient + first item
 * read, under account-pool churn) legitimately has no armed wake channel yet. Reaping +
 * climbing on a young miss is how back-to-back place_batch calls ate each other's
 * spawns (4 of 9 reaped within minutes of birth in the WI-5421 repro). 15 minutes covers
 * the observed worst-case boot time with margin; below it, defer instead of reap+climb.
 */
export const WARM_INJECT_BOOT_GRACE_MS = 15 * 60_000;

export async function executeBatch(opts: {
  plan: BatchPlacementPlan;
  headroom: number;
  brief: string | null;
  tier: string | null;
  actor: AgentIdentity;
  role: string;
  workspaceId: string;
  /** WI-5421: the live bees this batch was planned against (gatherLiveBees) — used
   *  ONLY to age-gate the woken:0 reap/climb path (below). Optional so existing
   *  direct callers (tests injecting a bare plan) are unaffected; omitted ⇒ no age
   *  signal available, so a woken:0 target is treated as unknown-age (age-gated,
   *  the SAFE default — never reap without a positive age read). */
  bees?: PlacementBee[];
  /** Injected clock (testability). Defaults to Date.now(). */
  now?: number;
  /** Test seam (DI): inject the spawn/claim/message/wake effects. Defaults to
   *  the real modules — the tool handler passes none (zero behavior change). */
  deps?: ExecuteBatchDeps;
}): Promise<{
  placements: PlacementResult[];
  summary: Record<string, number>;
  await_event?: string;
  next?: string;
  groups_subscribed?: number;
  group_errors?: string[];
}> {
  const { plan, headroom, brief, tier, actor, role, workspaceId } = opts;
  const nowMs = opts.now ?? Date.now();
  const beeByOwner = new Map((opts.bees ?? []).map((b) => [b.ownerId, b]));
  const {
    spawnAgentInHarness,
    claimWorkItem,
    releaseWorkItem,
    reorderWorkItem,
    sendMessage,
    wakeRecipients,
    ensureGroupTopic,
    subscribeGroupTopic,
    cancelDeadBee,
  } = opts.deps ?? (await loadExecuteBatchDeps());

  const ownerId = actor.ownerId ?? '';
  const parentSpawnId = /^s-/.test(ownerId) ? ownerId : null;
  // bee-context-efficiency P-005: when on, a warm-inject of a DRAINED bee carries a
  // marker so the wake-executor re-routes it to a FRESH spawn (fresh session + dossier
  // + checkpoint) instead of `--resume`-ing the grown transcript (D-018/D-021). Read
  // once per batch; flag-off ⇒ no marker, the wake is byte-identical to today.
  const freshContextOn = await getFlag(FLAGS.CUP_FRESH_CONTEXT_WARM_INJECT, 'system').catch(() => false);
  let extraSpawnBudget = Math.max(0, headroom - plan.spawnCount);
  let awaitEvent: string | null = null;
  const placements: PlacementResult[] = [];
  // EI-490: dedupe auto-reap per bee — several tasks in one batch can target the
  // SAME dead warm-inject bee; cancel its nursery row (and grant the freed slot)
  // only once, not once per task. `reapedBeesOk` is the successfully-cancelled
  // subset (surfaced in the summary); `reapedBees` alone just dedupes attempts.
  const reapedBees = new Set<string>();
  const reapedBeesOk = new Set<string>();

  const doSpawn = async (task: PlacementTask, reason: string, climbedFrom?: string): Promise<PlacementResult> => {
    if (awaitEvent) {
      return { task: task.id, action: 'deferred', reason: 'fleet ceiling reached earlier this batch', await_event: awaitEvent };
    }
    const reservedSpawnId = `s-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const claim = await claimWorkItem(task.id, reservedSpawnId, { harness: task.harness ?? undefined });
    if (!claim) {
      return {
        task: task.id,
        action: 'inject-raced',
        spawn_id: reservedSpawnId,
        harness: task.harness,
        reason: 'fresh-spawn reservation lost — item was claimed by another agent first',
        ...(climbedFrom ? { climbed_from: climbedFrom } : {}),
      };
    }
    const res = await spawnAgentInHarness({
      // Descriptive attribution for the observe-only governor receipt (D-011).
      spawnCaller: 'agent-tools/fleet/place_batch',
      workspaceId,
      harness: task.harness,
      role: 'cup',
      spawnId: reservedSpawnId,
      featureId: task.id,
      itemId: task.id,
      // Per-lane brief (payload.brief) MERGED with the Queen's batch overlay, so
      // a placed bee gets ITS wave lane's context — not just the one batch-wide
      // brief (queen-wave-dispatch P-031). spawnAgentInHarness threads it via MUG_BRIEF.
      brief: mergeBrief(task.brief, brief),
      tier,
      parentSpawnId,
      parentRole: role,
      // Coordination-token attribution (B-TOK-4): a batch-placed bee's turn runs
      // because the Queen placed it — a coordination trigger. Stamps turn_trigger
      // on the run's usage sample so coord-driven spend is summable.
      turnTrigger: 'coord-wake',
    });
    if (!res.ok && res.awaitEvent) {
      await releaseWorkItem(task.id, { harness: task.harness ?? undefined }).catch(() => {});
      awaitEvent = res.awaitEvent;
      return { task: task.id, action: 'deferred', reason: res.error ?? 'over fleet ceiling', await_event: res.awaitEvent };
    }
    if (!res.ok) {
      await releaseWorkItem(task.id, { harness: task.harness ?? undefined }).catch(() => {});
    }
    return {
      task: task.id,
      action: res.ok ? 'spawned' : 'spawn-failed',
      spawn_id: res.spawnId,
      harness: res.harness,
      reason,
      ...(climbedFrom ? { climbed_from: climbedFrom } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  };

  for (const d of plan.decisions) {
    try {
      if (d.disposition === 'unplaced') {
        placements.push({ task: d.task.id, action: 'unplaced', reason: d.reason });
        continue;
      }
      if (d.disposition === 'spawn') {
        placements.push(await doSpawn(d.task, d.reason));
        continue;
      }
      // warm-inject: assign → rank (Queen overlay) → wake.
      const bee = d.bee as string;
      const harness = d.task.harness ?? undefined;
      const claim = await claimWorkItem(d.task.id, bee, { harness });
      if (!claim) {
        placements.push({ task: d.task.id, action: 'inject-raced', bee, reason: 'item was claimed by another agent first — left as-is' });
        continue;
      }
      await reorderWorkItem(d.task.id, d.rank ?? 0, { writer: 'mug', harness });
      const summary = `Mug warm-inject: ${d.task.id}`;
      // The lane's own brief (payload.brief) + the Queen's batch overlay — so the
      // injected bee gets ITS wave lane's missing context, not just a generic note
      // (queen-wave-dispatch P-031). Falls back to the placement pointer when neither.
      const body =
        mergeBrief(d.task.brief, brief) ??
        `Fleet placement — ${d.task.id} ("${d.task.title}") is on your work-list at head-of-line (${d.affinity?.reasons.join(', ') || 'context affinity'}). Claim_next / work it next.`;
      await sendMessage(actor, { to: [bee], summary, body, extra: { wake: true } });
      const fan = await wakeRecipients([bee], {
        summary,
        source: ownerId,
        workspaceId,
        // P-005: stamp the fresh-context new-task marker so the wake-executor re-routes
        // a drained bee to a fresh spawn (the marker only exists when the flag is on +
        // the task has a concrete harness; flag-off ⇒ no payload, no behavior change).
        ...(freshContextOn && harness
          ? { payload: { freshContextWorkItem: d.task.id, freshContextHarness: harness, freshContextBrief: body } }
          : {}),
      });
      if (fan.woken === 0) {
        // No armed wake — don't strand the item on a dead/asleep bee. Release it
        // and climb the ladder: a fresh spawn if a slot is free, else queue back.
        await releaseWorkItem(d.task.id, { harness }).catch(() => {});

        // WI-5421: a woken:0 miss on a bee STILL WITHIN its boot window is not a
        // death signal — it's a booting cup that hasn't armed its wake channel yet.
        // Age-gate BEFORE the EI-490 reap: unknown age (no bee record — e.g. a
        // caller that didn't pass `bees`) or age < grace ⇒ defer, never reap/climb.
        const beeAgeMs = beeByOwner.get(bee)?.lastActiveMs;
        const withinBootGrace = beeAgeMs == null || nowMs - beeAgeMs < WARM_INJECT_BOOT_GRACE_MS;
        if (withinBootGrace) {
          placements.push({
            task: d.task.id,
            action: 'unplaced',
            bee,
            reason: `warm-inject undelivered (woken:0) but ${bee} is within its ${Math.round(WARM_INJECT_BOOT_GRACE_MS / 60_000)}min boot grace — deferred (not reaped, not climbed) to avoid killing a still-booting cup (WI-5421)`,
          });
          continue;
        }

        // EI-490: woken:0 is a DEFINITIVE "this nursery row is a zombie" signal —
        // auto-reap it (once per bee per batch) instead of leaving it to keep
        // consuming a concurrency slot until the Queen manually discovers +
        // fleet:cancels it. A successful reap frees a real slot, so grant one
        // bonus spawn-budget unit — the exact slot this zombie was squatting on.
        let reaped = false;
        if (!reapedBees.has(bee)) {
          reapedBees.add(bee);
          reaped = await cancelDeadBee({
            workspaceId,
            spawnId: bee,
            reason: 'EI-490: auto-reaped by fleet:place_batch — warm-inject wake undelivered (woken:0), zombie nursery row',
            actor,
          }).catch(() => false);
          if (reaped) {
            extraSpawnBudget++;
            reapedBeesOk.add(bee);
          }
        }
        if (extraSpawnBudget > 0 && !awaitEvent) {
          extraSpawnBudget--;
          placements.push(await doSpawn(d.task, 'warm-inject undelivered (woken:0) → fresh spawn', bee));
        } else {
          placements.push({
            task: d.task.id,
            action: 'unplaced',
            bee,
            reason: `warm-inject undelivered (woken:0); no spawn headroom — released to the frontier${reaped ? ' (zombie cup auto-reaped; retry next batch)' : ''}`,
          });
        }
        continue;
      }
      placements.push({ task: d.task.id, action: 'injected', bee, rank: d.rank ?? 0, reason: d.reason });
    } catch (err) {
      placements.push({ task: d.task.id, action: 'error', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const count = (a: PlacementResult['action']) => placements.filter((p) => p.action === a).length;
  const summary = {
    spawned: count('spawned'),
    injected: count('injected'),
    raced: count('inject-raced'),
    unplaced: count('unplaced'),
    deferred: count('deferred'),
    failed: count('spawn-failed') + count('error'),
    // EI-490: zombie nursery rows auto-reaped this batch (woken:0 → cancelSubtree),
    // freeing their concurrency slot without the Queen manually fleet:cancel-ing
    // each one. Omitted when zero — byte-identical to today for the common case.
    ...(reapedBeesOk.size > 0 ? { reaped: reapedBeesOk.size } : {}),
  };

  // EI-1611: group + subscribe AFTER every placement has landed — never on the
  // critical path of a spawn/inject, so a topics failure can't touch the
  // placement result it rides on. Flag-off ⇒ byte-identical to today (no groups).
  let groupsSubscribed = 0;
  let groupErrors: string[] = [];
  if (await getFlag(FLAGS.QUEEN_GROUP_TOPIC_SUBSCRIBE, 'system').catch(() => true)) {
    const groups = groupPlacementsForTopicSubscribe(plan.decisions, placements);
    if (groups.length > 0) {
      ({ groupsSubscribed, groupErrors } = await subscribeGroups(
        groups,
        { ensureGroupTopic, subscribeGroupTopic },
        { actor, workspaceId },
      ));
    }
  }

  return {
    placements,
    summary,
    ...(awaitEvent
      ? { await_event: awaitEvent, next: `over the fleet ceiling — events:await { event: "${awaitEvent}" }, end your turn, and re-run fleet:place_batch for the deferred tasks on wake.` }
      : {}),
    ...(groupsSubscribed > 0 ? { groups_subscribed: groupsSubscribed } : {}),
    ...(groupErrors.length > 0 ? { group_errors: groupErrors } : {}),
  };
}
