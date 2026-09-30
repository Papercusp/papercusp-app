/**
 * work-items-stale-claims — release work-item claims held by DEAD agents AND
 * requeue the mid-flight ones so they re-enter the claimable pool.
 *
 * The gap (owner-reported, 2026-06-11): a bee claims a work item →
 * `harness_features_consolidated.taken_by = <its alias>`. Bee identities are
 * per-spawn and NOT persisted — when the app closes/crashes, the bee's alias
 * never comes back, the row stays taken, and `claimNextWorkItem` (which
 * filters `taken_by IS NULL`) can never offer the item to anyone again. The
 * spawn-reclaim sweep (fleet/spawn-reclaim.ts) frees the CONCURRENCY slot of
 * a dead spawn but never touched its work-item claims; the fleet_assignment
 * view (migration 225) can *see* such claims as orphaned but nothing ACTED on
 * it. This module is the missing actor.
 *
 * GAP 1 (work-queue-stuck-item-recovery-2026-06-17, P-001/P-002/D-006/D-007):
 * clearing `taken_by` alone was not enough — `claimNextWorkItem` and the whole
 * dispatch frontier only consider `status = 'todo'`, so a row a dead bee left
 * at `in_progress`/`validating`/… became unclaimed-but-un-claimable: invisible
 * to self-selection AND to the hive demand signal, with no automated consumer
 * re-placing it on the NON-hive self-selection path (the hive path has its own
 * placement-watchdog + WI-222 reconcile). So the reaper now ALSO resets a freed
 * mid-flight row's status → `todo`, bounded by `requeue_count` (D-007): after
 * the cap (default 3) the row is dead-lettered to `blocked` instead of looping
 * a poison item. We reset to `todo`, NEVER `passed` — the reaper has no
 * completion signal (the holder is DEAD, work is genuinely incomplete); the
 * →`passed` polarity belongs to WI-222's clean-rc=0-exit path only (D-006).
 *
 * EI-6992 (2026-06, SUPERSEDED by WI-6039 below): the above (`todo`/`blocked`)
 * was the FEATURE-family vocabulary only, so when SCHEDULER_ISSUES_CLAIMABLE
 * (P-007) put issue-family (bug/change/task) claims through this SAME sweep,
 * an issue-family row's `status` (open|resolved|closed at the time) was left
 * untouched on reclaim — writing the feature literals onto an issue row had
 * been live, ongoing data corruption (~450-650+ drifted rows found live).
 *
 * WI-6039 (2026-07-26): EI-6992's "issue-family claimability is orthogonal to
 * status" premise did not survive work-item-status-full-unify, which made
 * `wip` (and `blocked`/`needs-human`) real, agent-settable issue-family states
 * (`work_items:claim` / `:set_state{state:'wip'}` auto-claims a bug/change/task
 * into `wip` today) while ALSO making `open` the one claimable token (not "any
 * non-terminal status + taken_by IS NULL"). So EI-6992's untouched-status
 * reclaim silently reintroduced the EXACT class of bug it was written to fix,
 * just the opposite polarity: instead of writing an invalid status onto an
 * issue row, it left a dead-holder's issue row frozen at `wip` FOREVER —
 * unclaimable (status isn't `open`) AND undetectable (no holder left to flag
 * as orphaned/stalled). Confirmed live: 31 rows stuck this way, oldest since
 * 2026-05-02, one of which hid a 6-day autonomous-loop canary outage
 * (EI-18170538694255356) because the very BUG REPORT of that outage fell into
 * this same hole the moment it was filed. FIX: both families now go through
 * the identical mid-flight-requeue CASE (`wip` is not in
 * `WORK_ITEM_NON_REQUEUE_STATES` for either) — a stranded issue-family claim
 * resets to the unified claimable token `open` (never the retired feature
 * literal `todo`, so this does NOT reintroduce EI-6992's original corruption;
 * `open`/`blocked` are valid states for BOTH families under the unified
 * vocabulary). `freed-issue` is no longer a reachable classification — see its
 * own doc below.
 *
 * Liveness rule — deliberately identical to migration 225's alias-aware
 * holder resolution (EI-311), so the sweep and the view can never disagree:
 * a claim's holder is ALIVE iff
 *   1. a coord_presence row with owner_id = taken_by has a heartbeat within
 *      the window, OR
 *   2. a RUNNING/RESTARTING spawned_agents row matches taken_by on ANY of its
 *      three aliases (spawn_id, session_owner, run_id) with a fresh nursery
 *      heartbeat.
 * Everything else past the grace window is presumed dead and released. On
 * release: `taken_by/taken_at → NULL`; a mid-flight (requeueable) status is
 * reset → `todo` (or → `blocked` on cap exhaustion); terminal (`passed`/
 * `deprecated`) and `blocked` rows keep their status (terminal needs nothing,
 * `blocked` has its own delegator-notify path). The per-row `action` lets the
 * caller log requeues quietly and broadcast only the dead-letters.
 *
 * Safety properties:
 *   - graceMs (default 10 min, the view's window) means a briefly-quiet but
 *     alive agent is never robbed: its presence/nursery heartbeats refresh
 *     well inside the window. A NULL taken_at (a claim with no claim-time
 *     anchor) is treated as PAST grace, so the reaper's freed set is a SUPERSET
 *     of the fleet_assignment view's `orphaned` set (which requires no taken_at)
 *     — anything the view calls orphaned, the reaper frees (EI-2534). Still
 *     safe: a NULL-taken_at row is freed ONLY when its holder is already dead.
 *   - FOR UPDATE SKIP LOCKED — never blocks a live claim transaction.
 *   - The release UPDATE re-checks the same predicates, so a row re-claimed
 *     between snapshot and update is left alone.
 *
 * Wired as a periodic DBOS sweep beside spawn-reclaim (periodic-workflows.ts).
 */

import type { Sql, TransactionSql } from 'postgres';
import { STALE_MS } from './liveness';
import {
  FEATURE_NON_REQUEUE_STATES,
  staleReclaimRequeueCap,
} from './work-item-dispatch-states';
import { SESSION_END_MARKER } from './agent-tools/activity/lifecycle-markers';

type Db = Sql | TransactionSql;

/** How long a claim may sit heartbeat-less before it is presumed orphaned.
 *  Matches the fleet_assignment view's 10-minute liveness window (mig 225). */
export const STALE_CLAIM_GRACE_MS = STALE_MS;

/**
 * WI-2689 (reclaim-churn fix): the LONGER grace given to a holder that is only
 * BRIEFLY parked / resumable — a session whose keepalive lapsed but whose
 * coord_presence row is still RECENTLY beating (within this window, yet past the
 * short live grace). Such a holder is almost always a member whose loop dropped
 * and is about to be re-armed (members can't self-rearm — a leader re-arms them),
 * NOT a dead one; reaping its claim at the bare 10-min live grace produced the
 * claim→release→reclaim ping-pong that dominated the dedup/churn ratio (WI-2118
 * was reclaimed 3x+). Keying the extra grace on RECENT-beat (not claim age) means
 * a truly-dead holder — one whose beat is older than this window (e.g. the 1h-
 * stale dead-bee) — is still reaped promptly; only a holder that beat within this
 * window is held back. Default 30m (3× the base), configurable via
 * work_items:reclaim_config → reclaimParkedGraceMs. Clamped ≥ the base grace so a
 * parked holder never waits LESS than a never-seen one.
 */
export const STALE_CLAIM_PARKED_GRACE_MS = 30 * 60 * 1000;

/**
 * WI-1999: long-horizon fallback for claims held by a LOCALLY-UNKNOWN holder.
 * work_items rows FEDERATE across the hive but coord_presence is LOCAL-BY-DESIGN,
 * so a remote node's holder is invisible here — this node's sweep CANNOT
 * authoritatively judge it dead (the 2026-07-03 incident: the mac-VM's sweep
 * shredded live tower holders' claims — WI-1964 dead-lettered 5x while actively
 * driven, WI-1910 requeued 5x). The DEAD leg therefore only reaps holders this
 * node has EVER seen (any coord_presence / spawned_agents row, however stale);
 * a never-seen-here holder is possibly-remote → SKIP, unless the claim is
 * anchored (taken_at NOT NULL) and older than this fallback — so a truly
 * abandoned row still frees after the presence-row TTL reap, just slowly.
 */
export const STALE_CLAIM_UNKNOWN_HOLDER_FALLBACK_MS = 24 * 3600 * 1000;

/** WHY a claim was reclaimed (agent-activity-liveness-truth P-003, D-001/D-004):
 *  - 'dead'       — holder not alive per the alias-aware rule, past the grace window
 *                   (the original behavior).
 *  - 'spawn-exit' — holder is an alias of a CONFIRMED-terminal spawn (failed/cancelled/
 *                   exited/killed) — freed IMMEDIATELY, no grace (spawn death → release).
 *  - 'stalled'    — holder is ALIVE but made no item-scoped progress in the window
 *                   (a claim is not progress, D-001). Flag-gated (RECLAIM_STALLED). */
export type ClaimReason = 'dead' | 'spawn-exit' | 'stalled';

/** What the reaper did to a freed row. */
export type StaleClaimAction =
  /** Mid-flight row reset → `todo`, back in the claimable pool. */
  | 'requeued'
  /** Requeue cap reached → parked in `blocked` (poison item, needs attention). */
  | 'dead-lettered'
  /** Row was already `todo` — only `taken_by` cleared. */
  | 'freed-todo'
  /** Row was terminal (`passed`/`deprecated`) — only `taken_by` cleared (no re-placement). */
  | 'freed-terminal'
  /** Row was `blocked` — only `taken_by` cleared; its own signal path handles it. */
  | 'freed-blocked'
  /** HISTORICAL / NO LONGER PRODUCED (WI-6039, 2026-07-26). EI-6992 (2026-06) used
   *  this label for "an issue-family (bug/change/task) row — only `taken_by`/
   *  `taken_at` cleared, `status` NEVER touched", on the premise that issue-family
   *  claimability was orthogonal to status. That premise did not survive
   *  work-item-status-full-unify (issue-family rows now really do sit at `wip`
   *  while claimed, and claimability now specifically requires `status='open'`),
   *  which turned "never touch status" into an active bug: a dead holder's
   *  issue-family claim froze at `wip` forever, unclaimable AND undetectable
   *  (confirmed live: 31 stuck rows, one of which hid a 6-day canary outage).
   *  Both families now run through the SAME mid-flight-requeue logic, so an
   *  issue-family row lands on `requeued`/`dead-lettered`/`freed-todo`/
   *  `freed-blocked`/`freed-terminal` exactly like a feature-family row in the
   *  same state — this member is kept only so an external consumer pattern-
   *  matching on the old label doesn't hit a missing-case error; `classify()`
   *  never returns it anymore. */
  | 'freed-issue';

export interface ReleasedClaim {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  /** The dead holder the claim was released from. */
  former_taken_by: string;
  /** The row's status BEFORE the sweep. */
  former_status: string;
  /** The row's status AFTER the sweep (todo / blocked / unchanged). */
  new_status: string;
  /** The requeue counter AFTER the sweep. */
  requeue_count: number;
  /** What the reaper did — derived, drives caller logging/broadcast. */
  action: StaleClaimAction;
  /** WHY the claim was reclaimed — dead | spawn-exit | stalled (P-003). */
  reason: ClaimReason;
}

export interface StaleClaimSweepResult {
  released: ReleasedClaim[];
}

interface ReleasedRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string;
  former_taken_by: string;
  former_status: string;
  new_status: string;
  requeue_count: number;
  reason: ClaimReason;
  /** Persisted work-item touch-set used to release the former holder's locks. */
  payload: unknown;
}

/** Classify a freed row from its former/new status + counter. WI-6039: issue-family
 *  (bug/change/task) used to short-circuit to `freed-issue` here unconditionally (its
 *  status was never touched — see the historical EI-6992 rationale on `freed-issue`,
 *  now STALE per the reclaim-SQL comment above). Since the reclaim SQL now applies the
 *  SAME mid-flight-requeue logic to both families, classification must too — a
 *  'wip' issue-family row is genuinely `requeued`/`dead-lettered` now, not merely
 *  `freed-issue`. `freed-issue` no longer has a dedicated code path; a
 *  terminal/blocked/needs-human/already-open issue-family row still lands on the
 *  SAME labels ('freed-terminal'/'freed-blocked'/'freed-todo') a feature-family row
 *  in the same state would — which is the correct behavior, not a regression: those
 *  labels already meant "freed, no status change", true for either family. */
function classify(row: ReleasedRow, cap: number): StaleClaimAction {
  if (isRequeueableReclaimedStatus(row.former_status)) {
    return row.requeue_count >= cap ? 'dead-lettered' : 'requeued';
  }
  if (row.former_status === 'blocked') return 'freed-blocked';
  // work-item-status-full-unify P-004/P-005: `open` is the unified claimable token (feature
  // `todo`→`open`). A freed already-claimable row — legacy `todo` OR unified `open` — is just
  // released in place (status untouched), never mis-read as terminal. The action label stays
  // `freed-todo` (an internal enum meaning "freed, was-already-claimable"); a rename is P-006/P-007.
  if (
    row.former_status === 'todo' ||
    row.former_status === 'open' ||
    row.former_status === '' ||
    row.former_status == null
  )
    return 'freed-todo';
  return 'freed-terminal';
}

/** Every terminal work_items.status value across BOTH vocabularies (feature-family
 *  todo/blocked/…/passed/deprecated + the unified done/resolved/closed/dropped set).
 *  Exported so any other surface that must distinguish "still live" from "settled
 *  history" (e.g. rebind-identity's held-work-items re-key) shares this single list
 *  instead of re-deriving/drifting from it. */
export const WORK_ITEM_NON_REQUEUE_STATES = Array.from(new Set([
  ...FEATURE_NON_REQUEUE_STATES,
  // Unified work_items terminal vocabulary (task/bug/change/feature-family).
  'done',
  'resolved',
  'closed',
  'dropped',
]));

function isRequeueableReclaimedStatus(status: string | null | undefined): boolean {
  return status != null && status !== '' && !WORK_ITEM_NON_REQUEUE_STATES.includes(status);
}

/**
 * EI-18674157526367861: an owner is also live when it has a RECENT `liveTurn` —
 * the SAME agent_activity-derived signal `presence-wakeability.ts`'s
 * `fetchWakeability` uses for leader-brief/fleet:assignments/coord:presence
 * (the P-002/P-005 "unified" liveness oracle). `harness_shared.agent_activity`
 * is appended on EVERY tool call across EVERY CLI — native Bash/Read/Write/Edit
 * included, not just papercusp-su MCP dispatch — whereas `coord_presence.heartbeat_at`
 * (the ONLY signal `liveHolderFragment` checked pre-fix) is bumped only by
 * coord:declare-intent/coord:inbox and a throttled (1/45s) MCP-dispatch touch. An
 * agent whose recent tool-call mix is dominated by native tools (e.g. monitoring a
 * long detached background run via repeated Bash/Read) can go past the grace window
 * without a single MCP call, so coord_presence goes stale while it is demonstrably
 * still driving its turn — and the DEAD leg wrongly reaped its claim (observed live:
 * WI-5837's assignee/taken_at/last_progress_at all went null out from under an
 * alive, actively-progressing holder). Mirrors fetchWakeability's exact rule: recent
 * activity that is not (only) a trailing `■ session ended` marker.
 */
export function activeTurnHolderFragment(sql: Db, graceSec: number) {
  return sql`
      SELECT owner_id AS alias
        FROM harness_shared.agent_activity
       WHERE created_at > now() - make_interval(secs => ${graceSec})
       GROUP BY owner_id
      HAVING max(created_at) FILTER (WHERE kind = 'lifecycle' AND summary = ${SESSION_END_MARKER}) IS NULL
          OR max(created_at) > max(created_at) FILTER (WHERE kind = 'lifecycle' AND summary = ${SESSION_END_MARKER})`;
}

/**
 * Fresh SESSION-execution evidence for a holder: presence, nursery aliases, or
 * a recent unified-oracle `liveTurn`. Deliberately excludes armed engine loops.
 *
 * An armed loop is continuation authority for a work-item claim, but it cannot
 * prove its own owner alive to the dead-owner control sweep that is responsible
 * for retiring abandoned loops. Including routines there makes every active
 * loop self-protect forever (WI-42279).
 */
export function activeSessionHolderFragment(sql: Db, graceSec: number) {
  return sql`
      -- Mig-225 alias-aware liveness: presence rows…
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      -- …plus every alias of a RUNNING nursery row with a fresh heartbeat.
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
         AND a.alias IS NOT NULL AND a.alias <> ''
      UNION
      -- …plus every owner with a recent unified-oracle liveTurn (EI-18674157526367861):
      -- the SAME source leader-brief/fleet:assignments/coord:presence already trust,
      -- so a holder they call alive can never be reaped here as dead.
      ${activeTurnHolderFragment(sql, graceSec)}`;
}

/**
 * The work-item "live holder" set: fresh session evidence plus durable same-owner
 * continuation authority from an armed engine loop. Shared by the feature and
 * issue claim reapers so their protection rule cannot diverge.
 */
export function liveHolderFragment(sql: Db, graceSec: number) {
  return sql`
      ${activeSessionHolderFragment(sql, graceSec)}
      UNION
      -- EI-21431501901242395: an armed loop is durable continuation authority.
      -- Its owner is intentionally quiet between wakes (and can remain so past
      -- the heartbeat/parked grace while a delivery is delayed), but the loop
      -- will re-invoke that SAME owner. Reaping its driving claim in that gap
      -- creates the exact release-before-warm-wake race this set must prevent.
      SELECT DISTINCT target_owner_id AS alias
        FROM harness_shared.routines
       WHERE active = true
         AND reschedule_interval_sec IS NOT NULL
         AND target_owner_id IS NOT NULL AND target_owner_id <> ''`;
}

/**
 * WI-2689: the "briefly-parked / resumable holder" set — coord_presence rows whose
 * heartbeat is RECENT (within `parkedGraceSec`) but which fell out of the short
 * live window. A member whose loop dropped keeps a coord_presence row and beat
 * moments ago; it is about to be re-armed, not dead. The DEAD leg subtracts this
 * set so such a holder's claim is held back until its beat is genuinely stale
 * (older than the parked grace), killing the claim→release→reclaim churn. Keyed on
 * coord_presence only (the member liveness signal) — NOT nursery rows, so a
 * confirmed-terminal spawn is never re-protected here (the spawn-exit leg still
 * frees it immediately). `parkedGraceSec` is clamped ≥ the live grace by the caller.
 */
export function parkedHolderFragment(sql: Db, parkedGraceSec: number) {
  return sql`
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${parkedGraceSec})`;
}

/**
 * WI-1999: the "locally-KNOWN holder" set — every alias this node has EVER seen,
 * regardless of freshness or lifecycle state (any coord_presence row + every
 * alias of any spawned_agents row). The DEAD reclaim leg requires membership
 * here before presuming a holder dead: absence from FRESH presence means "not
 * alive HERE", but absence from this set means "never seen HERE" — which, for a
 * FEDERATED work_items row, most likely means the holder lives on ANOTHER hive
 * node whose presence never federates. Reaping those live remote claims is the
 * WI-1964/WI-1910 shredder. Shared by both reapers so the rule cannot diverge.
 */
export function knownHolderFragment(sql: Db) {
  return sql`
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
      UNION
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE a.alias IS NOT NULL AND a.alias <> ''`;
}

/**
 * Release every reclaimable work-item claim and requeue the mid-flight ones
 * (bounded by the requeue cap). One atomic statement; returns the released rows
 * (with former/new status, counter, a derived action, and the REASON) for
 * logging/broadcast. Three reclaim legs (agent-activity-liveness-truth P-003):
 *
 *   (a) DEAD       — holder not alive per the alias-aware rule, past the grace
 *                    window (the original behavior — transient-quiet protection).
 *                    A NULL taken_at counts as past grace (no anchor → the
 *                    holder-death signal alone governs), so a taken_by-set/
 *                    taken_at-NULL claim the view flags `orphaned` can't strand
 *                    un-reaped (EI-2534).
 *   (b) SPAWN-EXIT — holder is an alias of a CONFIRMED-terminal spawn
 *                    (failed/cancelled/exited/killed, finished within the last
 *                    hour). Freed IMMEDIATELY, NO grace: a spawn's death should
 *                    free its claim now, not after the 10-min lease lag (the
 *                    incident — the gate-fix bee died, its reds sat owned ~1h).
 *                    Self-contained (keys off the terminal spawn row), so it ties
 *                    claim-release to spawn-death without a cross-tick hook.
 *   (c) STALLED    — holder ALIVE but no item-scoped progress in the window (a
 *                    claim is not progress, D-001). FLAG-GATED via `includeStalled`
 *                    (RECLAIM_STALLED, default OFF) because it frees a LIVE agent's
 *                    claim — a live-placement change D-003 says land attended.
 *
 * improvement-runner is never freed by (b)/(c): it is not a spawn alias and never
 * heartbeats (so never "alive"); the explicit guard on (c) is belt-and-braces.
 */
export async function reclaimStaleWorkItemClaims(
  sql: Db,
  opts: {
    graceMs?: number;
    /** WI-2689: longer grace for a briefly-parked/resumable holder (recent coord_presence
     *  beat, past the live window). Default STALE_CLAIM_PARKED_GRACE_MS; clamped ≥ graceMs. */
    parkedGraceMs?: number;
    requeueCap?: number;
    includeStalled?: boolean;
    stalledMs?: number;
    /** WI-1999: override the never-seen-here holder fallback horizon (tests). */
    unknownHolderFallbackMs?: number;
  } = {},
): Promise<StaleClaimSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  // WI-2689: parked grace is never SHORTER than the base grace (a resumable holder must
  // wait at least as long as a never-seen one), so clamp it up to graceSec.
  const parkedGraceSec = Math.max(
    graceSec,
    Math.round((opts.parkedGraceMs ?? STALE_CLAIM_PARKED_GRACE_MS) / 1000),
  );
  const stalledSec = Math.max(1, Math.round((opts.stalledMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const unknownFallbackSec = Math.max(
    1,
    Math.round((opts.unknownHolderFallbackMs ?? STALE_CLAIM_UNKNOWN_HOLDER_FALLBACK_MS) / 1000),
  );
  const cap = opts.requeueCap ?? staleReclaimRequeueCap();
  const includeStalled = opts.includeStalled === true;
  const nonRequeue = WORK_ITEM_NON_REQUEUE_STATES;
  const rows = await sql<ReleasedRow[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    known_holder AS (${knownHolderFragment(sql)}),
    -- WI-2689: briefly-parked/resumable holders (recent beat, past the live window) —
    -- the DEAD leg holds these back until their beat ages past the parked grace.
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)}),
    -- Aliases of RECENTLY-terminal spawns — confirmed dead, no grace (P-003/D-004).
    -- Bounded to the last hour so the cross-join stays tiny (older terminal spawns
    -- were already grace-freed by the DEAD leg).
    dead_spawn AS (
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('failed', 'cancelled', 'exited', 'killed')
         AND COALESCE(n.finished_at, n.cancelled_at, n.heartbeat_at) > now() - interval '1 hour'
         AND a.alias IS NOT NULL AND a.alias <> ''
    ),
    reclaimable AS (
      SELECT f.workspace_id, f.harness_slug, f.feature_id, f.item_kind,
             f.taken_by AS former_taken_by, f.status AS former_status,
             f.requeue_count AS former_requeue_count,
             f.payload,
             -- Priority-ordered reason (spawn-exit before dead before stalled).
             CASE
               WHEN EXISTS (SELECT 1 FROM dead_spawn ds WHERE ds.alias = f.taken_by) THEN 'spawn-exit'
               WHEN NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by) THEN 'dead'
               ELSE 'stalled'
             END AS reason
        FROM harness_shared.work_items f
       WHERE f.taken_by IS NOT NULL AND f.taken_by <> ''
         AND (
           -- (a) DEAD: holder not alive, past the grace window. A NULL taken_at
           -- (a claim with NO claim-time anchor) is treated as PAST grace: the
           -- holder-death signal governs alone. The fleet_assignment view flags
           -- such a row orphaned off taken_by alone (it requires NO taken_at),
           -- so requiring taken_at IS NOT NULL here let a taken_by-set/taken_at-
           -- NULL claim read as orphaned forever yet never reap — the EI-2534
           -- strand. Freeing it is safe: the row is only freed when its holder is
           -- already NOT alive, so no live agent (anchored or not) is ever robbed.
           -- WI-1999 remote-holder guard: only presume DEAD a holder this node has
           -- EVER seen (known_holder). work_items federate but presence does not —
           -- a never-seen-here holder is possibly a LIVE agent on another hive node
           -- (the WI-1964 shredder), so SKIP it, unless the claim is anchored and
           -- older than the long-horizon fallback (truly abandoned rows still free
           -- after the presence-row TTL reap).
           ( (f.taken_at IS NULL OR (now() - f.taken_at) > make_interval(secs => ${graceSec}))
             AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
             -- WI-2689 parked-grace: a holder that beat within the parked window is
             -- resumable (loop-dropped member about to re-arm), not dead — hold its
             -- claim back to stop reclaim churn until its beat ages past that window.
             AND NOT EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = f.taken_by)
             AND ( EXISTS (SELECT 1 FROM known_holder k WHERE k.alias = f.taken_by)
                   -- Fallback anchor: taken_at, or updated_ts for a NULL-anchor claim
                   -- (EI-2534 class) — an actively-driven remote item keeps refreshing
                   -- updated_ts via federation, deferring the fallback; a truly
                   -- abandoned one frees once the horizon lapses.
                   OR (now() - COALESCE(f.taken_at, to_timestamp(f.updated_ts / 1000.0)))
                        > make_interval(secs => ${unknownFallbackSec}) ) )
           -- (b) SPAWN-EXIT: a confirmed-terminal spawn's alias — no grace.
           OR EXISTS (SELECT 1 FROM dead_spawn ds WHERE ds.alias = f.taken_by)
           -- (c) STALLED (flag-gated): holder ALIVE but not progressing in the window.
           -- EI-18838892159155751: use the newest claim/progress anchor. A same-holder
           -- re-claim deliberately retains last_progress_at; when that timestamp is
           -- older than the new taken_at, COALESCE picked the old value and could
           -- reclaim the fresh claim before its grace window elapsed.
           -- WI-6015 (EI-18691099450966094 trap c): last_progress_at is bumped
           -- ONLY by an explicit work_items:checkpoint call, so a holder doing
           -- substantial real work (edits, tool calls, tests) WITHOUT
           -- checkpointing reads as "no progress" here forever — confirmed live:
           -- a holder with 138 tool_invocations in the prior 8 minutes still had
           -- last_progress_at NULL. Mirror the watchdog's already-landed EI-14763
           -- holder_active guard (collectStalledClaimSignals) HERE, on the
           -- actual reclaim action, not just the reporting signal: a holder with
           -- ANY agent_activity/tool_invocations row inside the stalled window is
           -- demonstrably working and must never be reclaimed as stalled, no
           -- matter how stale last_progress_at/taken_at read.
           OR ( ${includeStalled ? sql`(
                  EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
                  AND f.taken_by <> 'improvement-runner'
                  AND (now() - GREATEST(f.last_progress_at, f.taken_at)) > make_interval(secs => ${stalledSec})
                  AND NOT EXISTS (
                    SELECT 1 FROM harness_shared.agent_activity aa
                     WHERE aa.owner_id = f.taken_by
                       AND aa.created_at > now() - make_interval(secs => ${stalledSec})
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM harness_shared.tool_invocations ti
                     WHERE ti.coord_owner_id = f.taken_by
                       AND ti.invoked_at > now() - make_interval(secs => ${stalledSec})
                  )
                )` : sql`false`} )
         )
         FOR UPDATE OF f SKIP LOCKED
    )
    UPDATE harness_shared.work_items f
       SET taken_by = NULL,
           taken_at = NULL,
           -- WI-6303: the reclaimed holder's progress signal must not outlive the
           -- claim it was earned under, same as the voluntary release path
           -- (work-items.ts's releaseWorkItem — "release clears the progress
           -- signal too"). Leaving it set made a dead-holder's reclaim
           -- indistinguishable from genuine in-flight work to every downstream
           -- reader (the plan-item terminal reconciler, the plan-lane gate sync,
           -- classifyItemActivity) — live-verified: WI-5130/WI-5136/WI-5137 sat
           -- unclaimed for 10+ days, reclaimed by this exact reaper on
           -- 2026-07-17, yet still read as "genuinely active" against their
           -- already-'done' plan items P-104/P-301/P-402 because last_progress_at
           -- was never cleared here.
           last_progress_at = NULL,
           -- WI-6039 (fixes the EI-6992 special-case, now STALE): EI-6992 special-cased
           -- issue-family (bug/change/task) to NEVER have status/requeue_count touched,
           -- reasoning "issue-family claimability is orthogonal to status" — true under
           -- the OLD open|resolved|closed vocabulary, but FALSE since
           -- work-item-status-full-unify made 'wip' (and 'blocked'/'needs-human') real,
           -- agent-settable issue-family states (work_items:claim / :set_state{state:'wip'}
           -- auto-claims a bug/change/task into 'wip' today). That made this special-case
           -- an ACTIVE BUG: a dead holder's issue-family claim froze at status='wip' with
           -- taken_by cleared forever — unclaimable (claimability requires status='open',
           -- not merely taken_by IS NULL) AND undetectable (nothing holds it, so no
           -- orphan/stall reclaim logic has anything to act on). Confirmed live: 31 rows
           -- stuck this way, oldest since 2026-05-02, one of which hid a 6-day canary
           -- outage (EI-18170538694255356) because the very report of the outage fell
           -- into this same hole. FIX: apply the SAME mid-flight requeue logic to BOTH
           -- families — 'wip' is not in WORK_ITEM_NON_REQUEUE_STATES for either, so
           -- it now correctly resets to the unified claimable token 'open' (NEVER the
           -- retired feature literal 'todo' — that was EI-6992's actual original bug,
           -- and this fix does not reintroduce it: 'open'/'blocked' are valid states for
           -- BOTH families under the unified vocabulary). A terminal/blocked/needs-human/
           -- already-open row is unaffected either way (nonRequeue already covers both
           -- families' terminal + parked tokens).
           requeue_count = CASE
             WHEN d.former_status <> ALL(${nonRequeue}::text[])
               THEN d.former_requeue_count + 1
             ELSE d.former_requeue_count END,
           status = CASE
             WHEN d.former_status <> ALL(${nonRequeue}::text[])
               THEN (CASE WHEN d.former_requeue_count + 1 >= ${cap} THEN 'blocked' ELSE 'open' END)
             ELSE d.former_status END,
           -- EI-18838076935151132 (attribution defect #2 of 2): before this fix the
           -- reaper never touched last_released_by/last_released_at at all, so an
           -- INVOLUNTARY (sweep-initiated) release was silently indistinguishable from
           -- "never released" to every downstream reader — no detector could ever fire
           -- on "this holder lost its claim without acting", and the reporter found
           -- exactly that: four LIVE, actively-working holders' claims freed with no
           -- audit trail naming the reaper as the actor. A VOLUNTARY release
           -- (work-items.ts's releaseWorkItem / the engineer_issues view trigger) stamps
           -- last_released_by = the releasing HOLDER's own id, which is correct there —
           -- the holder chose to let go. A reaper-initiated release is the opposite: the
           -- holder did NOT act, so attributing it to the holder erases the very signal
           -- an operator/detector needs. Stamping a reaper-prefixed, REASON-tagged marker
           -- here (never equal to any real ownerId) means (a) the release-cooldown floor
           -- (scheduler/get-next.ts's last_released_by <> candidate check) can never
           -- misfire against it, and (b) any detector/audit can find every involuntary
           -- release with last_released_by LIKE 'reaper:%' and read WHY off the suffix
           -- (dead / spawn-exit / stalled) without a join.
           last_released_by = 'reaper:' || d.reason,
           last_released_at = now(),
           updated_ts = ${Date.now()}
      FROM reclaimable d
     WHERE f.workspace_id = d.workspace_id
       AND f.harness_slug = d.harness_slug
       AND f.feature_id = d.feature_id
    RETURNING d.workspace_id, d.harness_slug, d.feature_id, d.item_kind,
              d.former_taken_by, d.former_status, d.reason,
              f.status AS new_status, f.requeue_count AS requeue_count,
              f.payload`;
  const released = rows.map((r) => ({
    workspace_id: r.workspace_id,
    harness_slug: r.harness_slug,
    feature_id: r.feature_id,
    item_kind: r.item_kind,
    former_taken_by: r.former_taken_by,
    former_status: r.former_status,
    new_status: r.new_status,
    requeue_count: r.requeue_count,
    action: classify(r, cap),
    reason: r.reason,
  }));
  // EI-21185878360894454: reclaiming the work-item claim must also release the
  // former holder's declared file-lock touch-set. Keep this targeted (rather
  // than owner-wide): one owner may hold locks for another concurrent item.
  // The helper groups by domain + lock_id and calls tryRelease, which preserves
  // unrelated paths in a shared lock set and fires grant_cascade for successors.
  // Fail-open is intentional: the work-item reclaim remains authoritative and
  // the lock TTL is the fallback if the side database is unavailable.
  if (rows.length > 0) {
    try {
      const [{ releaseReclaimedWorkItemLocks }, { readWorkItemPaths }] = await Promise.all([
        import('./work-item-lock-release'),
        import('./work-items-release-request'),
      ]);
      for (const row of rows) {
        const lockRelease = await releaseReclaimedWorkItemLocks({
          ownerId: row.former_taken_by,
          paths: readWorkItemPaths(row.payload),
          goalRef: row.feature_id,
        });
        if (lockRelease.failures > 0) {
          console.warn(
            `[stale-claims] ${row.feature_id}: targeted lock release had ${lockRelease.failures} failure(s); claim reclaim continues with lock TTL fallback`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[stale-claims] targeted lock cleanup unavailable; claim reclaim continues with lock TTL fallback (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  // EI-6480: clear the per-Hive authority LEASE for every freed row. A stale lease that survives a
  // taken_by-clear (this reaper just freed a dead holder's item back to the claimable pool) makes
  // the item read as unclaimed yet FAIL lease arbitration for every new claimer until the lease TTL
  // lapses — so claim_next keeps "missing" ready work (the ready-but-raced symptom). EI-6832 fixed
  // only the VOLUNTARY release path (work_items:release); this extends the same cleanup to the
  // reaper. Owner-scoped + best-effort (a cleanup failure never fails the sweep); a no-op when the
  // lease flag is OFF or no lease row exists. Does NOT touch acquireClaimLocal conflict-release
  // semantics (a real cross-Swarm conflict must still release, else double-runs). Dynamic import
  // keeps the lease wiring off this module's static graph.
  if (released.length > 0) {
    const { workItemClaimLeaseEnabled, releaseWorkItemLease } = await import('./work-item-claim-lease-wiring');
    if (workItemClaimLeaseEnabled()) {
      for (const c of released) {
        try {
          await releaseWorkItemLease({ harness: c.harness_slug, workItemId: c.feature_id, owner: c.former_taken_by });
        } catch {
          // best-effort — a stale-lease cleanup miss must never fail the reap sweep
        }
      }
    }
  }
  return { released };
}

/** An issue-family (bug/change) claim freed from a dead holder. */
export interface ReleasedIssueClaim {
  workspace_id: string;
  issue_id: string;
  kind: string;
  /** The dead holder the issue was unassigned from. */
  former_assignee: string;
  /** The delegator (assigned_by), if any — carried for symmetry/logging; bug/change
   *  are self-selected so this is usually null. */
  assigned_by: string | null;
}

export interface StaleIssueSweepResult {
  released: ReleasedIssueClaim[];
  /** EI-6480: how many stale per-Hive claim leases the sweep cleared (per-row + orphan-GC).
   *  0 when the WORKITEM_CLAIM_LEASE flag is off (nothing to clean up). */
  orphanLeasesCleared: number;
}

/**
 * Issue-family stale-claim reaper (GAP 2, P-005 / D-009). Clears `assignee`/
 * `assigned_at` on OPEN `bug`/`change` issues whose holder is dead per the SAME
 * alias-aware liveness rule as the feature reaper (shared {@link liveHolderFragment}),
 * returning them to the `open` claimable pool.
 *
 * `task` (delegate) issues are DELIBERATELY EXCLUDED (D-009): a delegate's
 * `assignee = 'delegate:<agentSessionId>'` is a durable CONVERSATIONAL binding
 * (runId == agentSessionId, dormant between turns, `assigned_at` stamped once at
 * creation), NOT a heartbeating work-claim — so staleness reaping would strand a
 * resumable owner conversation. One atomic statement; returns the reaped rows.
 */
export async function reclaimStaleIssueClaims(
  sql: Db,
  opts: {
    graceMs?: number;
    /** WI-2689: longer grace for a briefly-parked/resumable assignee (recent coord_presence
     *  beat). Default STALE_CLAIM_PARKED_GRACE_MS; clamped ≥ graceMs. */
    parkedGraceMs?: number;
    /** WI-1999: override the never-seen-here holder fallback horizon (tests). */
    unknownHolderFallbackMs?: number;
  } = {},
): Promise<StaleIssueSweepResult> {
  const graceSec = Math.max(1, Math.round((opts.graceMs ?? STALE_CLAIM_GRACE_MS) / 1000));
  const parkedGraceSec = Math.max(
    graceSec,
    Math.round((opts.parkedGraceMs ?? STALE_CLAIM_PARKED_GRACE_MS) / 1000),
  );
  const unknownFallbackSec = Math.max(
    1,
    Math.round((opts.unknownHolderFallbackMs ?? STALE_CLAIM_UNKNOWN_HOLDER_FALLBACK_MS) / 1000),
  );
  const released = await sql<ReleasedIssueClaim[]>`
    WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
    known_holder AS (${knownHolderFragment(sql)}),
    -- WI-2689: briefly-parked/resumable assignees — held back from reaping (see the
    -- feature reaper for the churn rationale; parity so the two reapers never diverge).
    parked_holder AS (${parkedHolderFragment(sql, parkedGraceSec)}),
    dead AS (
      SELECT e.workspace_id, e.issue_id, e.kind,
             e.assignee AS former_assignee, e.assigned_by
        FROM harness_shared.engineer_issues e
       WHERE e.assignee IS NOT NULL AND e.assignee <> ''
         AND e.assigned_at IS NOT NULL
         AND (now() - e.assigned_at) > make_interval(secs => ${graceSec})
         AND e.state = 'open'
         AND e.kind IN ('bug', 'change')   -- D-009: exclude task (delegate binding)
         AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = e.assignee)
         -- WI-2689 parked-grace: skip a resumable assignee that beat within the window.
         AND NOT EXISTS (SELECT 1 FROM parked_holder p WHERE p.alias = e.assignee)
         -- WI-1999 remote-holder guard (see reclaimStaleWorkItemClaims): engineer_issues
         -- federate, presence does not — never presume a never-seen-here assignee dead
         -- before the long-horizon fallback.
         AND ( EXISTS (SELECT 1 FROM known_holder k WHERE k.alias = e.assignee)
               OR (now() - e.assigned_at) > make_interval(secs => ${unknownFallbackSec}) )
         FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE harness_shared.engineer_issues e
       SET assignee = NULL, assigned_at = NULL, origin = 'local'
      FROM dead d
     WHERE e.workspace_id = d.workspace_id AND e.issue_id = d.issue_id
    RETURNING d.workspace_id, d.issue_id, d.kind, d.former_assignee, d.assigned_by`;
  // EI-18838076935151132 (attribution defect #2, issue-family leg): the UPDATE above
  // targets the `engineer_issues` VIEW, whose INSTEAD OF trigger
  // (engineer_issues_view_dml — mig 499/513) already self-stamps
  // `last_released_by = OLD.assignee` the instant `assignee` goes non-null -> null, on
  // the (correct-for-a-VOLUNTARY-release) assumption that clearing assignee IS the
  // release action. For THIS reaper that assumption is exactly backwards: the holder
  // never acted, so attributing the release to them is the same erasure bug as the
  // feature-family leg had (see reclaimStaleWorkItemClaims above) — just baked into
  // the trigger instead of an omitted column. Overwrite it right after, directly on the
  // base table (bypassing the view/trigger, which only fires on assignee-transitions),
  // with the SAME reaper-prefixed marker convention: never equal to a real ownerId (so
  // the release-cooldown floor can't misfire), greppable via `last_released_by LIKE
  // 'reaper:%'`. This reaper has no per-row reason split (unlike the feature-family
  // leg) — every row it frees is the DEAD leg — so the marker is always 'reaper:dead'.
  // Best-effort, same discipline as the lease cleanup below: an attribution-stamp miss
  // must never fail (or partially roll back) the release itself, which has already
  // committed by the time we get here. A handful of older, deliberately-decoupled test
  // fixtures model `engineer_issues` as a genuinely standalone table with no backing
  // `harness_shared.work_items` at all (pre-work-item-status-full-unify style); this
  // catch keeps this reaper working for them exactly as it did before this fix.
  if (released.length > 0) {
    try {
      await sql`
        UPDATE harness_shared.work_items
           SET last_released_by = 'reaper:dead', last_released_at = now()
         WHERE feature_id = ANY(${released.map((r) => r.issue_id)}::text[])
           AND item_kind IN ('bug', 'change')`;
    } catch {
      // best-effort — see comment above
    }
  }
  // EI-6480: clear the stale per-Hive claim LEASE for every issue this sweep just returned to
  // the OPEN pool. Unlike the feature reaper (whose work_items.harness_slug IS the bare lease
  // key), an issue lease is keyed on the claiming agent's bare harness which engineer_issues
  // can't reconstruct — so we key on owner+item (issue ids are globally unique). We ALSO run a
  // bounded orphan-GC pass so the historical backlog AND any other taken_by-clearing path that
  // skipped cleanup are healed (the durable class-killer). Gated + best-effort; a no-op — and a
  // byte-identical sweep — when WORKITEM_CLAIM_LEASE is off. Dynamic import keeps the lease
  // wiring off this module's static graph.
  let orphanLeasesCleared = 0;
  try {
    const { workItemClaimLeaseEnabled, releaseIssueClaimLease, gcOrphanIssueLeases } = await import(
      './work-item-claim-lease-wiring'
    );
    if (workItemClaimLeaseEnabled()) {
      // Precise, immediate cleanup for the rows JUST reaped (owner+item, workspace defaulted to
      // the lease's activeWorkspaceId() — symmetric with leaseClaimedWorkItem's acquire key).
      for (const r of released) {
        try {
          if (await releaseIssueClaimLease({ workItemId: r.issue_id, owner: r.former_assignee })) {
            orphanLeasesCleared += 1;
          }
        } catch {
          // best-effort — a stale-lease cleanup miss must never fail the reap sweep
        }
      }
      // Self-healing safety net: sweep any stale claim_next lease on an unclaimed non-terminal
      // issue (historical orphans + any path that skipped the per-row cleanup). Counts leases the
      // per-row pass didn't already remove.
      orphanLeasesCleared += await gcOrphanIssueLeases();
    }
  } catch {
    // best-effort — lease cleanup must never fail the reap sweep
  }
  return { released, orphanLeasesCleared };
}

/** One row this sweep pulled back into the claimable pool. */
export interface StrandedWipRow {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  item_kind: string | null;
}

/**
 * WI-6039 — the GENERAL backstop for a work_items row ALREADY stuck at
 * `status='wip'` with `taken_by` NULL/empty. `reclaimStaleWorkItemClaims` above
 * decides whether a CURRENT holder is dead before releasing a claim, so its fix
 * only stops NEW rows from getting stranded through that path — it cannot reach a
 * row a holder already vacated (via that same reclaim path before this fix landed,
 * a raw-SQL release elsewhere, or any other writer that clears `taken_by` without
 * also moving `status` out of `wip`). Such a row needs NO liveness decision: there
 * is no `taken_by` to protect, so it is unconditionally not "in progress" and
 * belongs back in the `open` pool — that is the entire defect class WI-6039 found
 * live (31 rows, oldest since 2026-05-02, one of which hid a 6-day canary outage
 * because the very BUG REPORT of that outage fell into this hole after being filed).
 *
 * Cheap (one indexed UPDATE keyed on `status`), unconditional, and idempotent —
 * safe to run every tick alongside the stale-claim sweep (wired in
 * dbos/in-process-periodic.ts). A NON-ZERO result on an ONGOING basis (not just the
 * one-time historical backlog) is itself a signal worth logging loudly: it means
 * some writer OTHER than the two fixed here is still creating these, and that
 * writer needs to be found next.
 */
export async function reconcileStrandedWipWorkItems(sql: Db): Promise<StrandedWipRow[]> {
  return sql<StrandedWipRow[]>`
    UPDATE harness_shared.work_items
       SET status = 'open',
           updated_ts = ${Date.now()}
     WHERE status = 'wip'
       AND (taken_by IS NULL OR taken_by = '')
    RETURNING workspace_id, harness_slug, feature_id, item_kind`;
}
