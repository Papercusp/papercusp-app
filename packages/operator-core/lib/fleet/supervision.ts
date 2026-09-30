/**
 * fleet/supervision — the spawn tree as a SUPERVISION TREE (papercusp binding).
 *
 * The mechanism (restart-intensity governor + OTP restart strategies + the crash-loop
 * teardown/escalate decision) lives in @papercusp/structured-concurrency's
 * `createSupervisor`. This module binds it to papercusp: the PG spawn-tree store, the
 * nursery (for the escalate-path teardown), and `openEscalation` as the human-escalation
 * effect. It keeps the historical `<fn>(sql, opts)` entry points.
 */
import type { Sql } from 'postgres';
import {
  createNursery,
  createSupervisor,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_WINDOW_SEC,
  type CancelNotice,
  type EscalateFn,
  type IntensityResult,
  type LockReleaser,
  type RestartSet,
  type Supervisor,
  type SuperviseResult as EngineSuperviseResult,
} from '@papercusp/structured-concurrency';
import { pgSpawnTreeStore } from './pg-stores';
import { releaseAllLocksForOwners } from './lock-release';
import { defaultNotifier } from './nursery';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import type { OperatorSpawnInput } from './operator-spawn';

export { DEFAULT_MAX_RESTARTS, DEFAULT_RESTART_WINDOW_SEC };
export type { IntensityResult, RestartSet, EscalateFn } from '@papercusp/structured-concurrency';

/**
 * Outcome of actually re-launching ONE spawn the engine marked 'restarting' (WI-5541:
 * `markRestarting` alone is a status flip — the crashed work never resumed until
 * something re-invoked it. This is that something).
 */
export interface RelaunchOutcome {
  spawnId: string;
  ok: boolean;
  /** The freshly-launched replacement's spawn id, when `ok`. */
  newSpawnId: string | null;
  error?: string;
}

/**
 * Injectable relaunch effect — actually re-launch the spawn `spawnId` (already marked
 * 'restarting' by the engine) as a fresh process. Fail-soft by contract: a rejected/failed
 * relaunch never throws past this seam — it reports `ok:false` and `superviseCrash` leaves
 * the row 'restarting' (the next reclaim sweep / a manual retry backstops it), it never
 * wedges the caller's response.
 */
export type RelaunchFn = (spawnId: string) => Promise<RelaunchOutcome>;

export interface SuperviseOptions {
  workspaceId: string;
  spawnId: string;
  actor: AgentIdentity;
  reason?: string;
  maxRestarts?: number;
  windowSec?: number;
  /** Override the human-escalation effect (tests inject a spy). Default openEscalation. */
  escalate?: EscalateFn;
  /** Forwarded to the subtree teardown on the escalate path. */
  lockReleaser?: LockReleaser;
  notifier?: (notice: CancelNotice) => Promise<void>;
  /** Override the relaunch effect (tests inject a spy). Default: reconstruct the launch
   *  from the crashed row's recorded params and re-invoke via spawnAgentInHarness. */
  relaunch?: RelaunchFn;
}

/** `SuperviseResult` + the real relaunch outcomes for every id the engine marked
 *  'restarting' (populated only on `action === 'restart'`; empty otherwise). */
export interface SuperviseResult extends EngineSuperviseResult {
  relaunches: RelaunchOutcome[];
}

/**
 * Pure: reconstruct the `spawnAgentInHarness` input for re-launching a 'restarting' spawn
 * from its recorded nursery row. Exported for a focused unit test — no DB/process access
 * here. Known gap (flagged in WI-5541's write-up): `extraEnv`/gateway account routing and
 * any per-spawn `timeoutMs` override are NOT persisted on the row, so a relaunch re-derives
 * them fresh via the normal spawn-time resolution rather than replaying the original ones.
 */
export function buildRelaunchInput(
  workspaceId: string,
  spawnId: string,
  row: {
    harnessSlug: string | null;
    childRole: string | null;
    parentSpawnId: string | null;
    parentRole: string | null;
    featureId: string | null;
    chunkId: string | null;
    planSlug: string | null;
    itemId: string | null;
    modelSpec: string | null;
    modelTier: string | null;
    brief: string | null;
  },
): { ok: true; input: OperatorSpawnInput } | { ok: false; error: string } {
  if (!row.harnessSlug || !row.childRole) {
    return { ok: false, error: 'row is missing harness_slug/child_role — cannot relaunch' };
  }
  return {
    ok: true,
    input: {
      workspaceId,
      harness: row.harnessSlug,
      role: row.childRole,
      featureId: row.featureId,
      chunkId: row.chunkId,
      planSlug: row.planSlug,
      itemId: row.itemId,
      brief: row.brief,
      // Prefer the EXACT modelSpec the crashed run used; only fall back to re-resolving
      // the tier (which can drift if the tier menu changed since) when no spec was recorded.
      modelSpec: row.modelSpec ?? undefined,
      tier: row.modelSpec ? undefined : (row.modelTier ?? undefined),
      parentSpawnId: row.parentSpawnId,
      parentRole: row.parentRole ?? undefined,
      turnTrigger: 'supervised-restart',
      // Idempotent: a duplicate crash report for the same spawn (a retried tool call)
      // must not place a SECOND replacement agent.
      idempotencyKey: `supervised-restart:${spawnId}`,
    },
  };
}

/**
 * The default relaunch effect (production): read the crashed row's recorded launch
 * params straight off `sql` (the SAME handle superviseCrash was given — never a global
 * getOrgPg(), so this stays hermetically testable against an isolated test DB) and
 * re-invoke the ONE spawn chokepoint. Never throws — every failure mode collapses to
 * `{ ok:false, error }`.
 */
async function defaultRelaunch(sql: Sql, workspaceId: string, spawnId: string): Promise<RelaunchOutcome> {
  try {
    const rows = await sql<
      {
        harness_slug: string | null;
        child_role: string | null;
        parent_spawn_id: string | null;
        parent_role: string | null;
        feature_id: string | null;
        chunk_id: string | null;
        plan_slug: string | null;
        item_id: string | null;
        model_spec: string | null;
        model_tier: string | null;
        brief: string | null;
      }[]
    >`
      SELECT harness_slug, child_role, parent_spawn_id, parent_role, feature_id, chunk_id,
             plan_slug, item_id, model_spec, model_tier, brief
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId} AND spawn_id = ${spawnId}`;
    const row = rows[0];
    if (!row) return { spawnId, ok: false, newSpawnId: null, error: 'spawn row not found — cannot relaunch' };
    const built = buildRelaunchInput(workspaceId, spawnId, {
      harnessSlug: row.harness_slug,
      childRole: row.child_role,
      parentSpawnId: row.parent_spawn_id,
      parentRole: row.parent_role,
      featureId: row.feature_id,
      chunkId: row.chunk_id,
      planSlug: row.plan_slug,
      itemId: row.item_id,
      modelSpec: row.model_spec,
      modelTier: row.model_tier,
      brief: row.brief,
    });
    if (!built.ok) return { spawnId, ok: false, newSpawnId: null, error: built.error };
    const { spawnAgentInHarness } = await import('./operator-spawn');
    // Descriptive attribution for the observe-only governor receipt (D-011).
    // buildRelaunchInput is shared, so the label is stamped HERE rather than
    // inside it — the supervision relaunch and any other consumer of that
    // builder must stay distinguishable in the P-004 per-caller distribution.
    const res = await spawnAgentInHarness({ ...built.input, spawnCaller: 'fleet/supervision' });
    if (!res.ok) return { spawnId, ok: false, newSpawnId: null, error: res.error ?? 'relaunch rejected' };
    return { spawnId, ok: true, newSpawnId: res.spawnId };
  } catch (err) {
    return { spawnId, ok: false, newSpawnId: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Build a supervisor bound to papercusp effects. `actor` is optional for the read-only
 *  paths (recordRestartIntensity / restartSet) that never tear a subtree down. */
function buildSupervisor(sql: Sql, opts: { actor?: AgentIdentity; escalate?: EscalateFn; lockReleaser?: LockReleaser; notifier?: (n: CancelNotice) => Promise<void> }): Supervisor {
  const store = pgSpawnTreeStore(sql);
  const actor = opts.actor;
  const nursery = createNursery({
    store,
    lockReleaser: opts.lockReleaser ?? releaseAllLocksForOwners,
    notifier: opts.notifier ?? (actor ? (n) => defaultNotifier(actor, n) : undefined),
  });
  const escalate: EscalateFn =
    opts.escalate ?? (actor ? (input) => openEscalation(actor, input) : async () => ({ msg_id: 'noop' }));
  return createSupervisor({ store, nursery, escalate });
}

export async function recordRestartIntensity(
  sql: Sql,
  opts: { workspaceId: string; spawnId: string; maxRestarts?: number; windowSec?: number },
): Promise<IntensityResult | null> {
  return buildSupervisor(sql, {}).recordRestartIntensity(opts);
}

export async function restartSet(sql: Sql, opts: { workspaceId: string; crashedSpawnId: string }): Promise<RestartSet> {
  return buildSupervisor(sql, {}).restartSet(opts);
}

export async function superviseCrash(sql: Sql, opts: SuperviseOptions): Promise<SuperviseResult> {
  const sup = buildSupervisor(sql, { actor: opts.actor, escalate: opts.escalate, lockReleaser: opts.lockReleaser, notifier: opts.notifier });
  const result = await sup.superviseCrash({
    workspaceId: opts.workspaceId,
    spawnId: opts.spawnId,
    reason: opts.reason,
    maxRestarts: opts.maxRestarts,
    windowSec: opts.windowSec,
  });

  // WI-5541: `toRestart` used to be handed back with a comment saying "for the
  // orchestrator to re-run" — and nothing ever did. This closes the loop: actually
  // re-launch every spawn the engine just marked 'restarting', THEN retire the
  // superseded row (freeing the concurrency-ceiling debit + clearing the phantom
  // in-flight slot every liveness/dashboard consumer otherwise treats as alive
  // forever). Never fires on the escalate/noop paths — those already tore the
  // subtree down or found nothing to act on.
  let relaunches: RelaunchOutcome[] = [];
  if (result.action === 'restart' && result.toRestart.length > 0) {
    const relaunch = opts.relaunch ?? ((spawnId: string) => defaultRelaunch(sql, opts.workspaceId, spawnId));
    relaunches = await Promise.all(result.toRestart.map((spawnId) => relaunch(spawnId)));
    const superseded = relaunches.filter((r) => r.ok).map((r) => r.spawnId);
    if (superseded.length > 0) {
      await sql`
        UPDATE harness_shared.spawned_agents
           SET status = 'reaped',
               finished_at = now(),
               duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::bigint,
               error_message = COALESCE(error_message, 'superseded by supervised restart')
         WHERE workspace_id = ${opts.workspaceId}
           AND spawn_id = ANY(${superseded}::text[])
           AND status = 'restarting'`;
    }
  }

  return { ...result, relaunches };
}
