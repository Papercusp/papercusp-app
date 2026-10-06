/**
 * goal holder — the ONE derivation of "who holds this goal, and is any of them
 * actually alive?" (goal-live-holder-guarantee-2026-08-18 P-001, D-003, D-005).
 *
 * ── THE DEFECT THIS EXISTS TO MAKE UNREPRESENTABLE ──────────────────────────
 *
 * A goal's holder is recorded as a row in `harness_shared.agent_modes`
 * (mode='goal', subject=<goal id>). That row is ORDINARY DURABLE STATE: it
 * outlives the session that wrote it, and nothing clears it when that session
 * dies. So `SELECT count(*) ... WHERE mode='goal' AND subject=$1` returns 1
 * forever, and every surface built on it reports a goal nobody has touched in
 * days as healthy and staffed.
 *
 * Measured 2026-08-16: of 6 `status='active'` goals in papercusp-workspace, 4
 * had been dark for 2–5 days while every count-based surface called them held.
 * Measured again 2026-08-18: the Blender's steward had been gone six days and
 * `agent_modes` still named it the holder.
 *
 * ROW PRESENCE IS NOT LIVENESS. That is the entire bug. The remedy is not a
 * sweeper that periodically deletes stale rows — a sweeper is one more thing
 * that can die, and it is wrong for exactly as long as it is down. The remedy
 * is to stop STORING the answer: compute "who holds this" fresh on every read
 * by folding the shared presence oracle over the mode rows. There is then no
 * cached answer left to go stale, and a dead holder becomes visible instantly,
 * to every reader, with nothing needing to run.
 *
 * ── WHY THIS IS A MODULE AND NOT A SNIPPET ──────────────────────────────────
 *
 * D-003: P-001 is only durable if it cannot be bypassed. Before this file, the
 * liveness join existed in exactly two places (goal-liveness-watchdog and its
 * drain-fleet sibling) and was ABSENT from the four that mattered most to a
 * human looking at the product — the goals board, the goal popup, the
 * owner-report watchdog and stop-fanout. The join was not hard to write; it was
 * easy to forget, and forgetting it is silent. So the read lives here once, and
 * `scripts/check-no-raw-goal-holder-read.mjs` (shrink-only baseline, the shape
 * already used for bare setInterval / unenrolled spawns / hand-rolled module
 * pins) fails the build on a new raw read that skips it.
 *
 * ── THE FOUR-VALUE VERDICT, AND WHY `unknown` IS LOAD-BEARING ───────────────
 *
 * `liveness` is deliberately not a boolean:
 *
 *   held    — the elected holder resolves POSITIVELY alive.
 *   unheld  — no goal-mode row exists at all; it was never picked up.
 *   lost    — an elected row exists and that holder is positively gone.
 *   unknown — the elected holder could not be resolved.
 *
 * `unheld` and `lost` are kept apart because they call for different remedies
 * (never picked up vs dropped mid-flight) and collapsing them hides which is
 * happening.
 *
 * `unknown` is the one a later reader will be tempted to fold into `lost`. Do
 * not. `resolveSessionStates` OMITS the elected entry when its wakeability fetch
 * degrades, so treating a missing verdict as death converts a transient DB
 * hiccup into simultaneous false "abandoned" verdicts across every goal in the
 * workspace at once. An unresolvable holder means we do not know — and a system
 * that says so is worth more than one that guesses confidently.
 *
 * P-004 consumes this: a holder-required goal is `active` only while its
 * liveness is `held`, derived at read time. `unknown` must NOT deactivate.
 */
import type { Sql } from 'postgres';

import {
  resolveSessionStates,
  type LivenessVerdict,
} from '../agent-tools/coordination/liveness-oracle';
import type { SelfWakeSource } from '../agent-tools/coordination/presence-selfwake';
import type { SessionState } from '../agent-tools/coordination/presence-wakeability';
import { GOAL_MODE } from '../modes/goal-session';
export {
  readGoalHolderAuthority,
  type GoalHolderAuthority,
  type GoalHolderAuthorityStatus,
} from './holder-authority';

/**
 * PURE: is this holder evidence that the goal is being worked?
 *
 * D-005 pins each of the oracle's six states. Deliberately GENEROUS — every
 * ambiguous case counts as ALIVE, because a false "abandoned" on a goal someone
 * is actively working is far more corrosive than a late alarm:
 *
 *  - `live` / `recorded` — working now.
 *  - `parked` — parked is NOT dead: an agent between turns is parked, and that
 *    is the normal resting state of a healthy steward. Treating it as
 *    not-holding would deactivate every well-behaved goal the moment it idled.
 *    It counts as alive UNLESS the self-wake leg positively says nothing will
 *    ever wake it (`selfWake === 'none'`) — the "dead member in a healthy
 *    costume" case liveness-oracle documents. An ABSENT self-wake leg is
 *    UNKNOWN and must read as alive, never as 'none'.
 *  - `draining` / `suspect` — mid-verdict; treat as alive and let the next read
 *    decide once the state settles.
 *  - `ended` — the only state that positively means gone.
 *
 * Moved here from goal-liveness-watchdog (its original home) so the watchdog,
 * its drain-fleet sibling, and every read-side surface share one definition
 * rather than the watchdog owning it and the product surfaces having none.
 */
export function holderCountsAsAlive(v: LivenessVerdict): boolean {
  if (v.sessionState === 'ended') return false;
  if (v.sessionState === 'parked' && v.selfWake === 'none') return false;
  return true;
}

/** One raw `agent_modes` goal-mode row, before liveness is folded in. */
export interface GoalHolderRow {
  goalId: string;
  workspaceId: string;
  ownerId: string;
  /** ms epoch the mode was set. */
  setAtMs: number;
  /** Who set it (agent_modes.set_by), when the column is read. */
  setBy?: string | null;
  /** GOAL effective-holder election epoch (migration 1032). */
  goalLeaseEpoch?: number | null;
  /** The one predecessor explicitly allowed to overlap this successor. */
  goalHandoffFromOwnerId?: string | null;
  /** ms epoch after which that predecessor overlap is a health failure. */
  goalHandoffExpiresAtMs?: number | null;
}

/** One holder, with the oracle's verdict folded in. */
export interface ResolvedGoalHolder extends GoalHolderRow {
  /** The oracle's verdict, or null when it returned none for this owner. */
  sessionState: SessionState | null;
  selfWake: SelfWakeSource | null;
  /**
   * RAW process-keepalive freshness from the oracle (heartbeat within
   * PRESENCE_STALE_MS), or null when no verdict was returned. NOT a liveness
   * verdict — `live` is — but it is the one signal that separates a dead
   * PROCESS from a live process whose SESSION is idle, which is what
   * `holderIsRekickable` needs (WI-2140573).
   */
  heartbeatFresh: boolean | null;
  /**
   * Positively alive (true), positively gone (false), or UNRESOLVABLE (null).
   * `null` is never coerced to `false` — see the module docblock.
   */
  live: boolean | null;
}

export type GoalHolderLiveness = 'held' | 'unheld' | 'lost' | 'unknown';

/**
 * PURE: a LOST holder whose PROCESS is demonstrably still up — the psu wrapper
 * is heartbeating, the session is `parked` (so a live inbox-wake await exists
 * to deliver a turn to), but nothing is armed to wake it (`selfWake: 'none'`).
 *
 * This is NOT a dead process; it is a live session whose last turn produced no
 * output. Measured 2026-09-01 (WI-2140573): seven consecutive codex goal
 * holders whose kickoff turn died at the model layer ("We're currently
 * experiencing high demand", 5/5 retries, no output) sat EXACTLY here for
 * hours with live processes, and the respawner paid a full launch + a
 * rate-cap slot for each one — into the same outage — until the hourly cap
 * tripped. The same shape also covers an agent that settled without arming
 * its loop. Both are recovered by a WAKE, not a launch; see the goal-holder
 * respawner's re-kick path.
 */
export function holderIsRekickable(h: ResolvedGoalHolder): boolean {
  return (
    h.live === false &&
    h.sessionState === 'parked' &&
    h.selfWake === 'none' &&
    h.heartbeatFresh === true
  );
}

export type GoalHolderOverlapStatus = 'none' | 'handoff' | 'violation';

export interface GoalHolderOverlap {
  status: GoalHolderOverlapStatus;
  liveOwnerIds: string[];
  predecessorOwnerId: string | null;
  successorOwnerId: string | null;
  expiresAtMs: number | null;
}

/**
 * The answer to "who holds this goal".
 *
 * Multiple goal-mode rows remain visible as audit/history, but only the highest
 * election epoch is sovereign. Legacy rows with no epoch converge on newest
 * setAtMs, then lowest owner id. `live` contains that elected holder only;
 * `allLive` exists solely for handoff/overlap health.
 */
export interface GoalHolders {
  goalId: string;
  workspaceId: string;
  /** EVERY goal-mode row pointing at this goal, dead holders included. */
  holders: ResolvedGoalHolder[];
  /** The elected effective holder, whether live, dead, or unresolved. */
  elected: ResolvedGoalHolder | null;
  /** Only the ELECTED holder when it resolves positively alive. */
  live: ResolvedGoalHolder[];
  /** Every positively live historical/current row, for overlap diagnostics. */
  allLive: ResolvedGoalHolder[];
  overlap: GoalHolderOverlap;
  liveness: GoalHolderLiveness;
}

/** Stable composite key — a goal id is only unique within its workspace. */
export function goalHolderKey(workspaceId: string, goalId: string): string {
  return `${workspaceId}:${goalId}`;
}

/**
 * PURE: fold verdicts over one goal's rows.
 *
 * Exported so a caller that already holds both (a batched SQL read, a test)
 * never pays a second round-trip, and so the classification is unit-testable
 * with no PG.
 */
export function resolveGoalHoldersFromRows(
  goalId: string,
  workspaceId: string,
  rows: readonly GoalHolderRow[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
  nowMs: number = Date.now(),
): GoalHolders {
  const mine = rows.filter((r) => r.goalId === goalId && r.workspaceId === workspaceId);
  const holders: ResolvedGoalHolder[] = mine.map((r) => {
    const v = verdicts.get(r.ownerId);
    return {
      ...r,
      sessionState: v?.sessionState ?? null,
      selfWake: v?.selfWake ?? null,
      heartbeatFresh: v ? v.heartbeatFresh : null,
      // The oracle preserves failed reads in-band. A present UNKNOWN verdict
      // carries no positive liveness evidence, just like an omitted verdict.
      live: v && v.sessionState != null && v.signalMissing !== true
        ? holderCountsAsAlive(v) : null,
    };
  });
  const elected = [...holders].sort((a, b) => {
    const epochA = a.goalLeaseEpoch ?? Number.NEGATIVE_INFINITY;
    const epochB = b.goalLeaseEpoch ?? Number.NEGATIVE_INFINITY;
    return epochB - epochA || b.setAtMs - a.setAtMs || a.ownerId.localeCompare(b.ownerId);
  })[0] ?? null;
  const allLive = holders.filter((h) => h.live === true);
  const live = elected?.live === true ? [elected] : [];

  const extraLive = elected ? allLive.filter((h) => h.ownerId !== elected.ownerId) : allLive;
  const predecessorOwnerId = elected?.goalHandoffFromOwnerId ?? null;
  const expiresAtMs = elected?.goalHandoffExpiresAtMs ?? null;
  const validHandoff =
    elected?.live === true &&
    extraLive.length === 1 &&
    extraLive[0]?.ownerId === predecessorOwnerId &&
    expiresAtMs != null &&
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs;
  const overlap: GoalHolderOverlap = {
    status: extraLive.length === 0 ? 'none' : validHandoff ? 'handoff' : 'violation',
    liveOwnerIds: allLive.map((holder) => holder.ownerId),
    predecessorOwnerId,
    successorOwnerId: elected?.ownerId ?? null,
    expiresAtMs,
  };

  let liveness: GoalHolderLiveness;
  if (!elected) liveness = 'unheld';
  else if (elected.live === true) liveness = 'held';
  // Only the elected lease is sovereign. An unresolvable historical row can no
  // longer suppress recovery for a positively dead elected owner.
  else if (elected.live === null) liveness = 'unknown';
  else liveness = 'lost';

  return { goalId, workspaceId, holders, elected, live, allLive, overlap, liveness };
}

/**
 * PURE: fold verdicts over MANY goals in one pass. Keyed by `goalHolderKey`.
 *
 * `goals` is passed explicitly rather than derived from `rows` so a goal with
 * ZERO holder rows still gets an entry — the `unheld` case, which an inner join
 * or a group-by over rows would silently drop.
 */
export function resolveGoalHoldersBatchFromRows(
  goals: readonly { goalId: string; workspaceId: string }[],
  rows: readonly GoalHolderRow[],
  verdicts: ReadonlyMap<string, LivenessVerdict>,
): Map<string, GoalHolders> {
  const byGoal = new Map<string, GoalHolderRow[]>();
  for (const r of rows) {
    const k = goalHolderKey(r.workspaceId, r.goalId);
    const list = byGoal.get(k);
    if (list) list.push(r);
    else byGoal.set(k, [r]);
  }
  const out = new Map<string, GoalHolders>();
  for (const g of goals) {
    const k = goalHolderKey(g.workspaceId, g.goalId);
    out.set(k, resolveGoalHoldersFromRows(g.goalId, g.workspaceId, byGoal.get(k) ?? [], verdicts));
  }
  return out;
}

/**
 * Resolve liveness for a set of holder owner ids.
 *
 * `hydratePerId: true` — callers hold only owner ids from `agent_modes`, so the
 * oracle must fill heartbeat/pid/host/source from each subject's own presence
 * row rather than expecting the caller to supply them.
 *
 * `selfWake: true` — this is a SUPERVISORY read: noticing a stranded holder is
 * the entire job, and self-wake is the leg that separates a parked agent that
 * will re-wake from one that never will.
 */
export async function resolveHolderLiveness(
  ownerIds: readonly string[],
): Promise<Map<string, LivenessVerdict>> {
  const ids = [...new Set(ownerIds)];
  if (ids.length === 0) return new Map();
  return await resolveSessionStates(
    ids.map((ownerId) => ({ ownerId })),
    { hydratePerId: true, selfWake: true },
  );
}

/**
 * The ONE raw read of goal-mode holder rows. Every other site goes through a
 * function in this module rather than writing this query again.
 *
 * Scope both arguments or neither:
 *  - `{ workspaceId, goalIds }` — the rows for specific goals.
 *  - `{ workspaceId }`         — every goal-mode row in one workspace.
 *  - `{}`                      — every goal-mode row anywhere (the sweep shape).
 *
 * The unfiltered form is deliberate for sweeps: filtering to rows whose subject
 * names an ACTIVE goal is an INNER JOIN, which drops goals with no holder row —
 * and `unheld` is one of the two conditions a sweep exists to report.
 */
export async function readGoalHolderRows(
  sql: Sql,
  opts: { workspaceId?: string; goalIds?: readonly string[] } = {},
): Promise<GoalHolderRow[]> {
  if (opts.goalIds && opts.goalIds.length === 0) return [];
  const rows = await sql<
    {
      workspace_id: string;
      subject: string;
      owner_id: string;
      set_ms: string;
      set_by: string | null;
      goal_lease_epoch: string | null;
      goal_handoff_from_owner_id: string | null;
      goal_handoff_expires_ms: string | null;
    }[]
  >`
    SELECT workspace_id, subject, owner_id, set_by, goal_lease_epoch,
           goal_handoff_from_owner_id,
           (extract(epoch FROM set_at) * 1000)::bigint AS set_ms,
           CASE WHEN goal_handoff_expires_at IS NULL THEN NULL
                ELSE (extract(epoch FROM goal_handoff_expires_at) * 1000)::bigint END
             AS goal_handoff_expires_ms
      FROM harness_shared.agent_modes
     WHERE mode = ${GOAL_MODE}
       AND subject IS NOT NULL
       AND owner_id IS NOT NULL
       AND (${opts.workspaceId ?? null}::text IS NULL OR workspace_id = ${opts.workspaceId ?? null}::text)
       AND (${(opts.goalIds as string[] | undefined) ?? null}::text[] IS NULL
            OR subject = ANY(${(opts.goalIds as string[] | undefined) ?? null}::text[]))
     ORDER BY set_at DESC`;
  return rows.map((r) => ({
    goalId: r.subject,
    workspaceId: r.workspace_id,
    ownerId: r.owner_id,
    setAtMs: Number(r.set_ms),
    setBy: r.set_by,
    goalLeaseEpoch: r.goal_lease_epoch == null ? null : Number(r.goal_lease_epoch),
    goalHandoffFromOwnerId: r.goal_handoff_from_owner_id,
    goalHandoffExpiresAtMs:
      r.goal_handoff_expires_ms == null ? null : Number(r.goal_handoff_expires_ms),
  }));
}

/**
 * Who holds ONE goal, right now. The canonical single-goal read.
 */
export async function resolveGoalHolders(
  sql: Sql,
  opts: { workspaceId: string; goalId: string },
): Promise<GoalHolders> {
  const rows = await readGoalHolderRows(sql, {
    workspaceId: opts.workspaceId,
    goalIds: [opts.goalId],
  });
  const verdicts = await resolveHolderLiveness(rows.map((r) => r.ownerId));
  return resolveGoalHoldersFromRows(opts.goalId, opts.workspaceId, rows, verdicts);
}

/**
 * Who holds each of MANY goals, right now — one holder read and ONE oracle call
 * for the whole batch. The shape every sweep and every board read wants.
 */
export async function resolveGoalHoldersBatch(
  sql: Sql,
  goals: readonly { goalId: string; workspaceId: string }[],
  opts: { rows?: readonly GoalHolderRow[] } = {},
): Promise<Map<string, GoalHolders>> {
  if (goals.length === 0) return new Map();
  const all =
    opts.rows ??
    (await readGoalHolderRows(
      sql,
      // Scope to one workspace when the batch is single-workspace (the normal
      // case); otherwise read unfiltered and let the in-memory join scope it.
      new Set(goals.map((g) => g.workspaceId)).size === 1
        ? { workspaceId: goals[0].workspaceId }
        : {},
    ));
  // Only resolve holders that actually point at a goal in this batch — the row
  // read is deliberately unfiltered by goal so `unheld` stays visible, but
  // there is no reason to pay oracle cost for rows pointing elsewhere.
  const wanted = new Set(goals.map((g) => goalHolderKey(g.workspaceId, g.goalId)));
  const relevant = all.filter((r) => wanted.has(goalHolderKey(r.workspaceId, r.goalId)));
  const verdicts = await resolveHolderLiveness(relevant.map((r) => r.ownerId));
  return resolveGoalHoldersBatchFromRows(goals, relevant, verdicts);
}
