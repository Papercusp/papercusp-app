/**
 * routines-queue-classification.ts — which DBOS WorkflowQueue a scheduled-routine fire belongs on.
 *
 * Pure (no DBOS / side-effect imports) so it's unit-testable without booting the routine engine.
 *
 * WHY (2026-06-23 routines-queue-starvation incident): the single `routines` queue (concurrency 4) was
 * shared by SHORT critical routines (git-sync) AND LONG ones (green-checkpoint ~25m, gym ~90m, agent-role /
 * loop fires, …). A burst of ≥4 long routines holding every slot STARVED git-sync → no commits → all fleet
 * work + deploys frozen for 7h (and the bghost-watchdog mistook the starved queue for a frozen ticker and
 * restart-looped bg-host, killing green-checkpoint mid-run). The fix is two-pronged: the watchdog now
 * corroborates with the routinesTick SCHEDULER (so a busy queue is no longer read as a freeze), and — here —
 * git-sync gets a DEDICATED `routines-critical` lane so the shared queue's saturation can NEVER starve it.
 *
 * EI-21386288922867645 proves queueing a loop behind that shared backlog is NOT benign: a due loop fire sat
 * FIFO behind 29 earlier jobs for ~11 minutes, so the owner received no turn by its five-minute deadline.
 * Loop fires are quick but latency-sensitive, so they get their own bounded `routines-loop` lane. WI-41662
 * found the SAME shape a third time — the external-source polls (gmail/calendar/pr/vault) starved 4–18min
 * every hour behind green-checkpoint — so they get `routines-triggers` on the same principle. Git-sync
 * remains the ONLY action on `routines-critical`; long/unknown system actions and agent roles still default
 * to `routines`, except for explicitly-known heavy/background work such as gitnexus reindexing, which gets
 * a bounded serial lane of its own. This extends the existing queue mechanism without weakening its
 * persistence invariant.
 */
import { SYSTEM_TARGET_PREFIX } from '../harness/routines/system-actions';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

export const ROUTINES_QUEUE = 'routines';
export const ROUTINES_CRITICAL_QUEUE = 'routines-critical';
export const ROUTINES_FLEET_CONTROL_QUEUE = 'routines-fleet-control';
export const ROUTINES_LOOP_QUEUE = 'routines-loop';
export const ROUTINES_TRIGGERS_QUEUE = 'routines-triggers';
export const ROUTINES_RELEASE_QUEUE = 'routines-release';
export const ROUTINES_DEPLOY_QUEUE = 'routines-deploy';
export const ROUTINES_HEAVY_QUEUE = 'routines-heavy';

/** Mirrors loop.ts's materialized target_role without importing that stateful module here. */
export const LOOP_WAKE_TARGET_ROLE = `${SYSTEM_TARGET_PREFIX}loop-wake`;

/**
 * System actions whose STARVATION freezes fleet-wide persistence/coordination → the protected lane.
 * `git-sync` is the proven case (its starvation behind 4 long routines froze every commit + deploys for 7h).
 * Add to this set ONLY a genuinely must-never-starve, QUICK action — never a long-running one (that would
 * re-create the starvation this lane exists to prevent).
 */
export const CRITICAL_ROUTINE_ACTIONS = new Set<string>(['git-sync']);

/**
 * Fleet membership restoration is control-plane work whose latency determines
 * whether a leader can recover dead/stale lanes. It cannot share the ordinary
 * queue: a pool-pressure episode can leave dozens of older routine rows ahead
 * of a one-second headcount tick, delaying recovery for tens of minutes even
 * after the scheduler itself is healthy. It also cannot use the critical,
 * loop, trigger, or release lanes: a headcount action can open and attest agent
 * processes, so it is neither quick nor safe to put ahead of those consumers.
 * Keep this exact allow-list on its own serial queue.
 */
export const FLEET_CONTROL_ACTIONS = new Set<string>(['fleet-headcount-governor']);

/**
 * External-SOURCE poll actions → their own bounded lane. These are QUICK, run on a
 * sub-hour cadence, and their latency IS the product behaviour: an inbound email, PR,
 * or calendar event is not ingested until the poll actually executes.
 *
 * WI-41662 (2026-08-25) measured the starvation directly: on the shared `routines`
 * queue these sat FIFO behind green-checkpoint's hourly ~25m fire — 13 stalls in a
 * single day, 4m9s to 18m30s each, with gap ONSET clock-locked to :14–:16 past the
 * hour (green-checkpoint's cron is `0 15 * * * *`). Both Google polls froze and
 * resumed together, in the same process, while git-sync — the one routine with a
 * dedicated lane — ran straight through every gap. Nothing FAILED and nothing
 * restarted; the fires were merely waiting for a slot.
 *
 * Same starvation shape as the 2026-06-23 git-sync commit-freeze and
 * EI-21386288922867645's 11-minute loop-fire delay, so it gets the same proven
 * remedy rather than a new mechanism. Add ONLY quick, short-period external polls
 * here — a long-running action would re-create inside this lane the very starvation
 * the lane exists to prevent.
 */
export const TRIGGER_POLL_ACTIONS = new Set<string>([
  'google-gmail-poll',
  'google-calendar-poll',
  'pr-poll',
  'facebook-personal-vault-poll',
]);

/**
 * Long-running CPU/memory-heavy background actions → a bounded serial lane.
 *
 * `gitnexus-reindex` shells out to `gitnexus analyze` and has measured multi-hour
 * fire budgets. Keeping it on the shared queue lets one reindex consume the same
 * admission window as short housekeeping routines, which is the starvation shape
 * this classification layer exists to prevent. Keep this exact allow-list narrow:
 * a new action belongs here only after its runtime and resource profile are known.
 */
export const HEAVY_ROUTINE_ACTIONS = new Set<string>(['gitnexus-reindex']);

/**
 * The DEPLOY LAUNCHER → its own bounded serial lane.
 *
 * `release-trigger` is the only thing that promotes a green `main` to the live operator:
 * each fire evaluates the deploy plan and LAUNCHES detached systemd units (the auto-deploy
 * and the exact-pin live certification). It never awaits them — launchLiveReleaseCertification
 * resolves on `systemd-run`'s own exit — so it is QUICK, and its cadence (`0 *\/15 * * * *`)
 * means a starved fire is a deploy that simply never happens.
 *
 * EI-23909857328600541 (measured 2026-09-22T01:50Z) is the starvation, and it is the same
 * shape as the four classes above rather than a new one. release-trigger fell through
 * queueForRoutine to the shared `routines` lane (concurrency 4). Two fires on that lane —
 * `orphaned-mcp-reaper` and `gate-watcher-tick` — had been PENDING for 49 and 37 minutes,
 * and because ROUTINE_FIRE_TIMEOUT_MS is 2 HOURS a hung fire keeps its durable slot for up
 * to two hours. With the remaining slots churning, the dispatch epoch computed
 * `inFlight=3, available=0` and withheld release-trigger fire after fire: 41 routines were
 * overdue, release-trigger had not fired for ~50 minutes, and 426 green commits sat
 * undeployed behind a live certification that nothing was left to launch.
 *
 * It does NOT belong on the existing lanes: `routines-critical` is deliberately git-sync-only
 * (a guard test pins that set, and widening it re-creates the very contention that lane
 * exists to prevent), and `routines-release` is the SERIAL lane for the operator-home
 * green-checkpoint, whose ~25-minute fire would starve a 15-minute trigger outright.
 * Serial, because two concurrent deploy evaluations have nothing to gain: the units they
 * launch are themselves singletons, deduped by fixed unit name.
 */
export const DEPLOY_TRIGGER_ACTIONS = new Set<string>(['release-trigger']);

/**
 * The queue NAME a routine fire should enqueue on, by its target role and (when
 * needed) install slug. The operator-home green-checkpoint is the workspace's
 * release finalizer: if it waits behind four long subject-hive gates, a frozen
 * repair queue cannot recover and every staging delivery remains blocked. Give
 * that one home-hive action its own serial lane; subject-hive checkpoints stay on
 * the bounded shared lane so their aggregate concurrency remains unchanged.
 *
 * A loop wake → the latency-isolated `routines-loop` lane; fleet restoration →
 * the serial `routines-fleet-control` lane; a critical quick SYSTEM action →
 * `routines-critical`; a quick external-source poll → `routines-triggers`; the
 * operator-home green-checkpoint → `routines-release`; the deploy launcher →
 * `routines-deploy`; a known heavy/background action → `routines-heavy`;
 * everything else → `routines`.
 */
export function queueForRoutine(targetRole: string, installSlug?: string | null): string {
  if (targetRole === LOOP_WAKE_TARGET_ROLE) return ROUTINES_LOOP_QUEUE;
  if (targetRole.startsWith(SYSTEM_TARGET_PREFIX)) {
    const action = targetRole.slice(SYSTEM_TARGET_PREFIX.length);
    if (action === 'green-checkpoint' && installSlug === operatorHomeHarnessSlug()) {
      return ROUTINES_RELEASE_QUEUE;
    }
    if (HEAVY_ROUTINE_ACTIONS.has(action)) return ROUTINES_HEAVY_QUEUE;
    if (FLEET_CONTROL_ACTIONS.has(action)) return ROUTINES_FLEET_CONTROL_QUEUE;
    if (CRITICAL_ROUTINE_ACTIONS.has(action)) return ROUTINES_CRITICAL_QUEUE;
    if (DEPLOY_TRIGGER_ACTIONS.has(action)) return ROUTINES_DEPLOY_QUEUE;
    if (TRIGGER_POLL_ACTIONS.has(action)) return ROUTINES_TRIGGERS_QUEUE;
  }
  return ROUTINES_QUEUE;
}

/**
 * The CRITICAL-ROUTINE FLOOR for the routinesTick PG-pool-starvation shed (EI-11171).
 *
 * When routinesTickImpl sheds on critical pool pressure (pool-pressure.ts), it must NOT go
 * fully dark: the ONE thing that can never be allowed to stall is the protected critical-queue
 * routine (git-sync) — the whole reason the dedicated `routines-critical` lane exists is that
 * its starvation froze every commit + deploy for 7h (2026-06-23). The original shed did a bare
 * `return` BEFORE the fire loop, silently skipping git-sync's enqueue too — defeating that lane.
 * This predicate is the floor: under a shed, a routine fires ONLY if it belongs to the protected
 * lane; everything else sheds with the heavy sweeps, exactly as before. Pure ⇒ unit-testable.
 */
export function shouldFireUnderPoolShed(targetRole: string): boolean {
  return queueForRoutine(targetRole) === ROUTINES_CRITICAL_QUEUE;
}
