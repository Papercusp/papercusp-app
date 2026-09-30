/**
 * placement-watchdog.ts — the COMPLETION GUARANTEE for the Mug pot loop
 * (queen-autonomous-execution-2026-06-13 B-09: P-020 / P-021 / P-022 / P-023).
 *
 * The liveness watchdog (./watchdog.ts) guarantees the MUG stays awake; THIS
 * module guarantees every unit she PLACES reaches a terminal state — it closes
 * the G3 gap ("steer, don't dispatch" + reactive: a dead/stalled cup was only
 * rediscovered on the next idle wake). It rides the same 30s routinesTick and is
 * a BACKSTOP, not a cadence: every check is a deterministic SQL read; the wake /
 * escalation it MAY fire is the exception path.
 *
 * The reconciliation, per started pot:
 *   - P-020 — for each Mug-placed unit, derive its serving cup's liveness from
 *     `spawned_agents` (status / heartbeat / last_output) and the unit's own
 *     status + `taken_by`. A NON-terminal unit whose serving cup is dead/stalled
 *     and is NOT re-claimed by a live cup fires ONE targeted recovery wake to the
 *     Mug (debounced) so she re-places it WITHOUT waiting for the next idle
 *     wake. The Mug still DISPOSES (re-place / drain / drop) — the watchdog only
 *     surfaces (P-023: completion, not micromanagement).
 *   - P-021 — the cursed-item circuit breaker: after N failed placements (mirrors
 *     the orchestrator worker-chunk-loop `replanStrikes` exhaustion-flip, default
 *     3) the unit flips `cursed` and is escalated to the owner (the D-011 Queue
 *     precursor) instead of re-placed forever.
 *   - P-022 — stranded-work resolution: a `failing`/`failed` blocker that gates
 *     ≥1 non-terminal downstream unit is escalated ONCE so the owner can resolve /
 *     deprecate it and un-gate the downstream.
 *
 * Durable state is `harness_shared.pot_placements` (mig 263) — the per-(pot,
 * work-item) completion ledger holding ONLY the failed-placement counter, the
 * disposition, and the debounce timers. Liveness itself is never mirrored (it is
 * re-derived every sweep — storage policy).
 *
 * Pure deciders (`deriveCupLiveness`, `evaluatePlacement`) are split from the PG
 * sweep (`reconcilePotPlacements`) so the behavioral contract unit-tests with no
 * database — the same split as wake-frontier-guard.
 */
import { hostname } from 'node:os';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS, isSpawnProcessAlive } from '../fleet/spawn-reclaim';
import { isInProcessLaunchIdentity, type SpawnRowKind } from '../fleet/spawn-row-class';
import { placementOverride } from '../pot-control-policy';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import { openEscalation, resolveEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { liveHolderFragment, STALE_CLAIM_GRACE_MS } from '../work-items-stale-claims';
import { listStartedPots, mugKettleSystemEnabled } from './started';
import { workItemCheckpointScope } from '../work-item-checkpoint';
import { checkpointDeclaresTerminal } from '../checkpoint-terminal-claim';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { isClaimHoldParked } from '../work-items';
import { reconcileLinkedWorkItemsForPlanItem } from '../plan-items/reconcile-linked-work-items';
import { getPlanRow } from '../agent-tools/plans/source';

// ── vocabulary (the canonical work-item terminal + stuck states) ──────────────

/** A placed unit is DONE when its status is one of these (work-items.ts: the set
 *  that fires `work-item:done:<id>`). Both kind-family dialects included —
 *  DERIVED from the canonical union, never re-listed here.
 *
 *  EI-18653071581558556 — this used to be a hand-copied literal
 *  `['passed','deprecated','resolved','closed']` that predated
 *  work-item-status-full-unify (2026-07-19) and never picked up `done`/`dropped`,
 *  the two words that dominate the very table every consumer below joins. Since
 *  each consumer reads "not in this set ⇒ still active", a FINISHED unit fell
 *  through to the failed-placement path: recorded `stranded`, then `cursed` once
 *  fail_count tripped, and re-surfaced to the Mug as "drive to terminal /
 *  re-place NOW". Measured live on papercusp 2026-07-25: 15 of 17 units reported
 *  stranded/cursed were already terminal (14 `done`, 1 `dropped`) — ~88%
 *  phantoms; the literal matched only ~18% of terminal rows. That is the
 *  mechanism behind EI-8529 (an already-resolved item re-placed, wasting a spawn)
 *  and behind the Mug persona's "confirm each id first" workaround. */
const TERMINAL_UNIT_STATES = new Set(ANY_FAMILY_TERMINAL_STATES);
/** A blocker is STUCK (P-022) when stalled in the feature-family failure band. */
const STUCK_BLOCKER_STATES = new Set(['failing', 'failed']);
/** A cup spawn row in one of these is GONE (its claim/work is no longer live). */
const TERMINAL_SPAWN_STATES = new Set(['done', 'failed', 'cancelled', 'reaped']);
/** A placed unit's OWN status is a deliberate park (work-item-dispatch-states.ts:
 *  FEATURE_NON_REQUEUE_STATES treats `blocked` AND `needs-human` the same way — "a
 *  deliberate [owner] park … never auto-requeued". `needs-human` was added to that
 *  sibling reaper set on 2026-07-03 (fleet-scheduler-hardening-2026-07-03 P-004,
 *  WI-1774/WI-1775) but was never mirrored here (EI-6563) — so a unit an owner
 *  parked `needs-human` kept getting treated as a failed placement: the Mug fired
 *  a recovery wake + a fresh cup every debounce window forever (observed live on
 *  WI-369, the same churn class WI-1439's `blocked` fix above targets). Distinct
 *  from STUCK_BLOCKER_STATES above, which is about a unit BLOCKING downstream
 *  work, not a unit that IS itself parked. */
const UNIT_PARKED_STATES = new Set(['blocked', 'needs-human']);
/** EI-6650 — the brief-facing "open placements" summary independently re-derives
 *  "is this unit still active" from `harness_features_consolidated.status`, rather
 *  than trusting `pot_placements.status` (which the reconcile-side isUnitParked fix
 *  above already stops re-flagging as `recovering`). Existing rows placed BEFORE that
 *  fix — or ones reconcileOnePot simply hasn't revisited since (it only reconciles
 *  units with a recent cup-spawn event, not a periodic full sweep) — sit frozen at
 *  `recovering` in the DB (observed live: WI-329/341/356/357/359/360/369/371/372/1439,
 *  stuck `recovering` since 2026-07-03 with zero reconcile activity since). Excluding
 *  UNIT_PARKED_STATES here too (in addition to TERMINAL_UNIT_STATES) means the Mug
 *  brief's "Placements — drive to terminal / re-place NOW" list stops telling her to
 *  re-place a unit a human/owner has deliberately parked, regardless of whether the
 *  underlying placement row has caught up yet. */
// EI-7641: also consumed by wake-frontier-guard.ts's listNonTerminalPlacements,
// which hit the exact same staleness this comment describes — the P-030
// "non-terminal placements" guard trusted pot_placements.status alone (never
// joining the live unit), so a wake-frontier refusal listed ids whose WORK ITEM
// had long since gone terminal/deprecated or been parked blocked/needs-human,
// forcing every no-time Mug wake to force:true past a stale placement list.
export const SUMMARY_INACTIVE_UNIT_STATES = [...TERMINAL_UNIT_STATES, ...UNIT_PARKED_STATES];

export function isUnitTerminal(status: string | null | undefined): boolean {
  return status != null && TERMINAL_UNIT_STATES.has(status);
}
export function isStuckBlockerState(status: string | null | undefined): boolean {
  return status != null && STUCK_BLOCKER_STATES.has(status);
}
/** WI-1439 recovery-churn fix — is the placed unit itself deliberately parked
 *  (`blocked` or `needs-human` — owner/human-gated), so a dead/absent cup is
 *  EXPECTED, not a failure? */
export function isUnitParked(status: string | null | undefined): boolean {
  return status != null && UNIT_PARKED_STATES.has(status);
}

/**
 * EI-18667095591047618 — the FULL "is this placed unit deliberately parked" signal
 * for the reconcile side, composing BOTH park dialects: a status-level park
 * ({@link isUnitParked} — `blocked`/`needs-human`) OR a durable claim-hold park
 * (`payload._claimHold`, WI-2797, {@link isClaimHoldParked} from `../work-items` —
 * the SAME predicate `fleet/placement-gather.ts` already uses on the PLACE side to
 * skip these rows). Before this, the reconcile side only ever checked status, so a
 * claim-held item (status stays `open` by design; never given a live holder by
 * design, because gather refuses to place it) walked straight past both `evaluatePlacement`
 * exit conditions (`unitTerminal`, `hasLiveHolder`) into the cursed/stranded latch and
 * stayed there forever — the deliberate park meant to make an item quiet was exactly
 * what made it permanently loud (WI-4480: 7 days cursed after a claim-hold park).
 *
 * Exported + directly unit-tested so the PARITY between the place side and the
 * reconcile side is an assertion, not an assumption — the exact gap that let this
 * defect family recur three times before (WI-1439 `blocked`, EI-6563 `needs-human`,
 * EI-14404 live-non-cup-holder) with only a per-dialect fix each time.
 */
export function isUnitParkedForReconcile(status: string | null | undefined, payload: unknown): boolean {
  return isUnitParked(status) || isClaimHoldParked(payload);
}

/**
 * EI-15232 — does the cup's checkpoint text DECLARE a terminal/blocked completion?
 *
 * WI-38297: the markers and the predicate MOVED to `../checkpoint-terminal-claim` so a
 * second reader (the stranded-checkpoint triage scan behind `work_items:stranded`) can
 * use them without importing this module's whole graph. Re-exported here because this
 * is where every existing call site and test addresses it — one definition, two doors.
 * The measured-precision caveat that governs how far a caller may act on a match lives
 * with the predicate.
 *
 * NOTE the import+export pair rather than a bare `export … from`: this module CALLS
 * the predicate itself (the stale-open reconcile batch-read below), and a re-export
 * alone creates no local binding.
 */
export { checkpointDeclaresTerminal };

/**
 * WI-6038 — the SAME "declares terminal but the unit row hasn't caught up yet"
 * shape as {@link checkpointDeclaresTerminal}, for a SECOND, independently
 * observed source of lag: a work-item minted from (or stamped to) a plan item
 * via `convert.ts` carries `payload.plan_item: { plan_slug, item_id }`. When that
 * plan item reaches `done`/`dropped`, the unit's OWN terminal flip is applied by
 * a SEPARATE, periodic sweep (`reconcileOrphanedPlanItemWorkItems`, home routine
 * `system:plan-item-orphan-reconcile`) — not by this watchdog's 30s tick. That
 * sweep can lag the plan item's actual completion by a long time (observed live,
 * 2026-07-26: 5 units whose linked plan items completed 2026-07-11/07-13/07-15
 * sat non-terminal until the orphan sweep finally reconciled them, MINUTES after
 * THIS watchdog's own candidate-discovery evaluated the exact same units — cup
 * long dead, unit not-yet-terminal — and fired a "re-place or recover" page for
 * work that was, in substance, already finished). Reads the raw jsonb payload
 * (already deserialized by postgres-js) OR the JSON-stringified-scalar shape
 * `normalizedPayloadExpr` guards against on the SQL side (createWorkItem's
 * `::jsonb`-cast-of-a-string quirk — see reconcile-linked-work-items.ts). Pure;
 * exported for the decider unit tests.
 */
export function readPlanItemStamp(payload: unknown): { planSlug: string; itemId: string } | null {
  let obj: unknown = payload;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const raw = (obj as Record<string, unknown>).plan_item;
  if (!raw || typeof raw !== 'object') return null;
  const planSlug = (raw as Record<string, unknown>).plan_slug;
  const itemId = (raw as Record<string, unknown>).item_id;
  if (typeof planSlug === 'string' && typeof itemId === 'string') return { planSlug, itemId };
  return null;
}

/** The system actor that owns watchdog-fired escalations. */
const WATCHDOG_OWNER = 'system:pot-placement-watchdog';
const watchdogIdentity = { ownerId: WATCHDOG_OWNER } as unknown as AgentIdentity;

// ── tunables (env-overridable, like the liveness watchdog floor) ──────────────

export interface PlacementConfig {
  /** Failed placements before the cursed-item breaker trips (P-021). Mirrors the
   *  orchestrator `replanStrikes` default (3): two recovery wakes, then escalate. */
  breakerThreshold: number;
  /** Minimum gap between recovery wakes for the same stalled unit (debounce) — so
   *  a unit that stays stalled across many 30s ticks wakes the Mug at most once
   *  per window, not every tick. */
  recoveryDebounceMs: number;
  /** F-FIX-041 — the operator-dormancy grace window. The watchdog runs on the 30s
   *  routinesTick; if the gap since this pot's LAST sweep (max last_seen_at over its
   *  placements) exceeds this, the operator/bg-host was DORMANT in between (a frozen
   *  ticker, the EI-1873 session wedge, an overnight dormancy window) — so this is a
   *  post-dormancy RECOVERY sweep and every placement looks "lost" for an INFRA reason,
   *  not item-pathology. On such a sweep a loss is re-placed but counted toward the
   *  BOUNDED infra breaker (infraBreakerThreshold), not the pathology breaker. Far above
   *  the 30s cadence so a merely-slow tick never trips it. */
  dormancyGraceMs: number;
  /** F-FIX-041 — the BOUNDED infra-loss breaker threshold. Infra-attributed losses
   *  (operator dormancy + EI-1758 zombie cups that made 0 tool calls — a no-fair-attempt
   *  loss, NOT item-pathology) accrue in `infra_loss_count` and curse only here, far above
   *  the 3-strike pathology `breakerThreshold`. The BOUND is the safety property: even if a
   *  genuinely-wedging item's losses were all mis-attributed to infra, it still curses at
   *  this count (never the unbounded-retry of EI-865); a real infra outage gets this many
   *  graced re-places to heal. (A reaper-reclaim-WHILE-ACTIVE loss is exempt entirely —
   *  it has positive proof-of-life, see servingCupReclaimedWhileActive — and never reaches
   *  this counter.) */
  infraBreakerThreshold: number;
}

export function placementConfig(): PlacementConfig {
  const threshold = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_BREAKER ?? process.env.PAPERCUSP_POT_PLACEMENT_BREAKER ?? 3,
  );
  const debounce = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_DEBOUNCE_MS ?? process.env.PAPERCUSP_POT_PLACEMENT_DEBOUNCE_MS ?? 5 * 60_000,
  );
  const dormancy = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_DORMANCY_MS ?? process.env.PAPERCUSP_POT_PLACEMENT_DORMANCY_MS ?? 10 * 60_000,
  );
  const infra = Number(
    process.env.PAPERCUSP_POT_PLACEMENT_INFRA_BREAKER ?? process.env.PAPERCUSP_POT_PLACEMENT_INFRA_BREAKER ?? 12,
  );
  return {
    breakerThreshold: Number.isFinite(threshold) && threshold >= 1 ? threshold : 3,
    recoveryDebounceMs: Number.isFinite(debounce) && debounce >= 0 ? debounce : 5 * 60_000,
    dormancyGraceMs: Number.isFinite(dormancy) && dormancy >= 0 ? dormancy : 10 * 60_000,
    infraBreakerThreshold: Number.isFinite(infra) && infra >= 1 ? infra : 12,
    // live-configurability-audit P-015: overlay the runtime pot:control_policy override (empty ⇒ env defaults).
    ...placementOverride(),
  };
}

/**
 * EI-865 / WI-233 — a heartbeat-stale / reaper-reclaimed cup that made a governed
 * model call within this window of `now` was demonstrably ALIVE when it went stale
 * or was reclaimed: a SLOW-BUT-ALIVE false reclaim. Generously larger than the
 * reaper's RECLAIM_STALE_MS (5m) so a single long opus:xhigh call (or the WI-204
 * per-call PG overhead in a tight capability:bash loop) that starved the heartbeat
 * past the stale threshold still reads as active. A long model call emits NO stdout,
 * so `last_output_at` is no signal here — `agent_usage_samples` (one row per governed
 * model call) is. The reclaim of such a cup re-places the unit but does NOT count
 * toward the placement curse. Env-overridable like the other watchdog tunables. */
export const ACTIVE_RECLAIM_WINDOW_MS = (() => {
  const v = Number(
    process.env.PAPERCUSP_POT_ACTIVE_RECLAIM_WINDOW_MS ??
      process.env.PAPERCUSP_POT_ACTIVE_RECLAIM_WINDOW_MS ??
      15 * 60_000,
  );
  return Number.isFinite(v) && v >= 0 ? v : 15 * 60_000;
})();

/**
 * Did this spawn land in a terminal state via a REAPER RECLAIM (the P-011
 * orphan-reclaim sweep, or a wedge-reap) rather than a genuine non-zero EXIT? The
 * P-011 reaper stamps an `error_message` of `reclaimed: …` with status 'failed'; a
 * wedge-reap sets status 'reaped'. A genuine cup crash is status 'failed' carrying
 * the cup's OWN error (never a `reclaimed:` prefix); a clean finish is 'done'. Only
 * a reaper reclaim of a still-ALIVE cup is exempt from the placement curse (WI-233)
 * — a genuine crash still counts, so a truly cup-WEDGING item still trips the
 * breaker. Pure; exported for the decider unit tests. */
export function isReaperReclaim(status: string, errorMessage: string | null): boolean {
  if (status === 'reaped') return true;
  return status === 'failed' && errorMessage != null && errorMessage.startsWith('reclaimed:');
}

// ── P-020 pure decider 1: cup liveness from the durable spawn row ─────────────

export type CupLiveness = 'live' | 'wedged' | 'dead';

export interface CupLivenessInput {
  status: string;
  heartbeatAtMs: number | null;
  lastOutputAtMs: number | null;
  now: number;
  /** WI-3977 — same-host process liveness, mirroring the WI-3961 exemption
   *  already applied by `reclaimOrphanedSpawns`. When the caller can positively
   *  confirm the spawn's OS process is alive on THIS host (same-host pid check,
   *  `isSpawnProcessAlive`), a heartbeat-stale row is NOT concluded `dead` — the
   *  process is demonstrably still running; the stale heartbeat is a launcher-side
   *  bookkeeping gap (WI-3961's field note: a scope-isolated cup's heartbeat_at can
   *  go un-bumped for a stretch — e.g. it isn't registered in the CURRENT operator
   *  generation's in-memory heartbeat loop after a bg-host restart), not evidence
   *  the cup died. Omitted / undefined ⇒ unverifiable (a different host, or the
   *  caller didn't check) — falls back to the heartbeat-only verdict below, exactly
   *  today's behavior. Only ever narrows `dead` → `live`/`wedged`; never widens it. */
  confirmedAliveSameHost?: boolean;
}

/**
 * Derive a cup's liveness from its spawn row, reusing the fleet-reclaim
 * thresholds so the watchdog agrees with orphan-reclaim / wedge-reap:
 *   - terminal spawn status (done/failed/cancelled/reaped) → `dead`;
 *   - running, heartbeat stale beyond RECLAIM_STALE_MS, but the caller has
 *     POSITIVELY confirmed the process is alive on this host → NOT `dead` (falls
 *     through to the wedge/live check below on the stale heartbeat) — WI-3977;
 *   - running but heartbeat stale beyond RECLAIM_STALE_MS (and not confirmed
 *     alive) → `dead` (orphaned host, or unverifiable);
 *   - running, heartbeat fresh (or confirmed-alive-but-stale), but output silent
 *     beyond WEDGE_SILENT_MS → `wedged`;
 *   - otherwise → `live`.
 * A null heartbeat on a running cup is treated as `live` (freshly spawned, no
 * heartbeat tick yet — reclaim owns the true-orphan case).
 *
 * WI-3977 — before this, a heartbeat-stale-but-actually-alive cup (the SAME
 * false-positive class WI-3961 fixed for the reclaim sweep: a scope-isolated
 * cup whose heartbeat_at goes un-bumped past RECLAIM_STALE_MS while it is
 * demonstrably still running) read `dead` here UNCONDITIONALLY — this decider
 * had no pid-liveness check at all, unlike reclaimOrphanedSpawns. `hasLiveHolder`
 * in `evaluatePlacement` then went false and the Mug re-placed a FRESH cup onto
 * the same work-item while the original kept working — two live cups racing the
 * same edit (observed live: WI-3954, two concurrent cups on the same rename).
 * `confirmedAliveSameHost` closes that gap the same way WI-3961 closed it for
 * the reclaim sweep: verify via `isSpawnProcessAlive` before trusting a stale
 * heartbeat as death.
 */
export function deriveCupLiveness(input: CupLivenessInput): CupLiveness {
  if (TERMINAL_SPAWN_STATES.has(input.status)) return 'dead';
  const { heartbeatAtMs, lastOutputAtMs, now, confirmedAliveSameHost } = input;
  if (heartbeatAtMs != null && now - heartbeatAtMs > RECLAIM_STALE_MS && !confirmedAliveSameHost) return 'dead';
  if (lastOutputAtMs != null && now - lastOutputAtMs > WEDGE_SILENT_MS) return 'wedged';
  return 'live';
}

// ── P-020/P-021 pure decider 2: what to do about one placement ────────────────

export interface PlacementObservation {
  workItemId: string;
  /** The unit row still exists. */
  unitExists: boolean;
  /** The unit reached a terminal state. */
  unitTerminal: boolean;
  /** A LIVE cup currently holds/serves this non-terminal unit (re-placement took,
   *  or the original is still working) — OR (EI-14404) the unit's `taken_by` is a
   *  live NON-CUP session (an SU/operator agent working it outside the cup fleet
   *  entirely). Either way there is demonstrable live progress, so the placement
   *  is healthy — not cursed/stranded/breaker-tripped. */
  hasLiveHolder: boolean;
  /** Failed (item-pathology) placements already recorded for this unit (0 if never
   *  placed) — the 3-strike `breakerThreshold` counter. */
  failCount: number;
  /** F-FIX-041 — INFRA-attributed losses already recorded (operator dormancy / zombie
   *  cups) — the BOUNDED `infraBreakerThreshold` counter, kept separate from failCount so
   *  an infra outage doesn't trip the pathology breaker (0 if never placed). */
  infraLossCount: number;
  /** The existing placement row's status, or null if this is a new placement. */
  placementStatus: string | null;
  /** When the last recovery wake fired (debounce), ms epoch, or null. */
  lastRecoveryAtMs: number | null;
  /** When this uninterrupted recovery episode began, ms epoch, or null. Unlike
   *  lastRecoveryAtMs, this does not move when another recovery wake fires. */
  recoveryStartedAtMs: number | null;
  /** WI-677 round 2 — is there a SERVING CUP at all (a holder or an anchor spawn in the
   *  cup window)? A recovering item the Mug has not re-placed yet has NONE — that is
   *  not a failed attempt, so the sweep must re-place-wake WITHOUT counting. Before
   *  this, every debounce expiry charged fail_count on a cup-less recovering item and
   *  an un-cursed frontier re-cursed at 3 strikes in ~12 minutes with zero new cups
   *  (observed live 2026-07-02 00:27). */
  hasServingCup?: boolean;
  /** The serving cup's spawn id (when present) — compared against lastLossSpawnId. */
  servingCupSpawnId?: string | null;
  /** The spawn id whose loss was last COUNTED for this placement (mig 440), or null.
   *  Same id again ⇒ the corpse was already counted: re-place only, counters flat. */
  lastLossSpawnId?: string | null;
  /** EI-865 / WI-233 — the serving cup is a slow-but-ALIVE false reclaim: the
   *  watchdog reads it `dead` (heartbeat-stale, or P-011 reaper-reclaimed) yet it made
   *  a governed model call within {@link ACTIVE_RECLAIM_WINDOW_MS}, so it was
   *  demonstrably alive when it went stale / was reaped. A reclaim of such a cup
   *  re-places the unit but does NOT count toward the curse — only a genuine cup
   *  failure / wedge (no recent activity, or a non-zero exit) does. Default false. */
  servingCupReclaimedWhileActive?: boolean;
  /** F-FIX-041 — the serving cup made ZERO tool calls (agent_activity kind='tool') across
   *  its whole life: a no-fair-attempt loss — an EI-1758 zombie (booted without MCP tools)
   *  or a cup that died before doing any work. The work-item never got a real attempt, so
   *  the loss is INFRA-induced, not evidence of item-pathology. Counted toward the BOUNDED
   *  infra breaker (not unbounded-exempt): the bound is what makes this per-cup signal safe
   *  — an item that genuinely crashes cups pre-tool-call ALSO shows 0 tool calls, so it must
   *  still eventually curse (at infraBreakerThreshold), never retry forever. Default false. */
  servingCupMadeNoToolCalls?: boolean;
  /** F-FIX-041 / WI-677 — this sweep is a post-dormancy RECOVERY sweep: the gap since
   *  this pot's previous sweep exceeded the dormancy grace, so the operator/bg-host was
   *  down in between and a "lost" placement is INFRA-induced, not item-pathology. An
   *  ITEM-INDEPENDENT signal (computed from the watchdog's own run cadence, not per-cup)
   *  — an item cannot fake "the operator was dormant", and an operator-wide outage can
   *  never BE item-pathology. So it is FULLY EXEMPT: keeps BOTH counters flat and never
   *  curses (WI-677 — F-FIX-041 wrongly counted it toward the bounded infra breaker, so a
   *  host restart cursed the whole frontier in lockstep at infraBreakerThreshold). Only
   *  the per-item zombie signal below keeps the bounded breaker. Default false. */
  postDormancySweep?: boolean;
  /** WI-1439 recovery-churn fix — the unit's OWN status is a deliberate park
   *  (`isUnitParked`, e.g. `blocked` or `needs-human` for an owner/human-gated
   *  step — EI-6563). A parked unit is EXPECTED to have no live holder — that is
   *  not a failed placement, so it must never enter the recover/breaker path
   *  (which fired a Mug recovery wake
   *  + re-placed a fresh cup every debounce window FOREVER on a unit no cup can
   *  ever close, observed live on WI-1439: a new cup roughly every 5-40min for
   *  days, each one independently re-confirming the same owner-gate and dying).
   *  Default false. */
  unitParked?: boolean;
  /** EI-15232 — the unit's latest cup checkpoint DECLARES it reached terminal/blocked
   *  (see {@link checkpointDeclaresTerminal}), yet the unit row is still open
   *  (non-terminal, no live holder): the cup's `set_state` flip silently failed to
   *  persist, leaving a STALE-OPEN item. Re-placing a fresh cup would redo already-
   *  finished work and page the Mug to "re-place/recover" a done item (the EI-8529
   *  liveness-only-misread class). When true the placement is RECONCILED (a single
   *  state-reconciliation nudge to the Mug), never re-placed. Default false. */
  checkpointDeclaresTerminal?: boolean;
  /** WI-6038 — the unit is stamped `payload.plan_item` and that LINKED plan item has
   *  already reached done/dropped, but the unit's own terminal flip is still pending
   *  the separate periodic orphan-reconcile sweep (see {@link readPlanItemStamp}'s doc
   *  comment). Same shape as checkpointDeclaresTerminal: self-heal (trigger the same
   *  reconciler inline) instead of paging the Mug to re-place a cup for finished work.
   *  Default false. */
  planItemDeclaresTerminal?: boolean;
  now: number;
}

export type PlacementDecision =
  | { kind: 'healthy' }
  | { kind: 'completed' }
  | { kind: 'parked'; reason: string }
  // EI-15232 — the cup's checkpoint declares terminal/blocked but the unit state is
  // still open (a silently-failed flip): reconcile the state, do NOT re-place a cup.
  | { kind: 'checkpoint-reconcile'; reason: string }
  // WI-6038 — the unit's linked plan item is already done/dropped but the unit's own
  // terminal flip is still pending the periodic orphan-reconcile sweep: self-heal via
  // the SAME reconciler that sweep uses, do NOT re-place a cup.
  | { kind: 'plan-item-reconcile'; reason: string }
  | { kind: 'recover'; nextFailCount: number; nextInfraLossCount: number; reason: string; infraAttributed?: boolean }
  | { kind: 'debounced' }
  | { kind: 'stale-recovery'; reason: string }
  | { kind: 'breaker'; nextFailCount: number; nextInfraLossCount: number; reason: string; infraAttributed?: boolean }
  | { kind: 'latched' }
  | { kind: 'abandon'; reason: string };

/**
 * EI-3216 — `infraAttributed` marks a recover/breaker whose loss is an
 * ITEM-INDEPENDENT INFRA condition (an operator-dormancy sweep, or a no-fair-attempt
 * zombie cup that made 0 tool calls — typically the whole fleet booting cups without
 * MCP, or no cups spawning at all), NOT item-pathology. The Mug/owner cannot fix
 * such a loss by re-placing or investigating THIS item (a re-place just makes another
 * zombie), so:
 *   - an infra `recover` does NOT fire a per-item Mug recovery wake, and
 *   - an infra `breaker` curse does NOT open a per-item owner escalation.
 * The placement is still re-placed / recorded `cursed` (the `placements.cursed` health
 * metric + pot:status are the real cursed-state surface); only the per-item NOISE is
 * suppressed. Without this, a fleet-wide no-cups window cursed the whole frontier at
 * `fail_count=0, infra_loss_count=12`, flooding the queue with "failed 0×" advisories
 * and waking the Mug every ~5min to do nothing actionable. A genuine item-pathology
 * curse (a cup that RAN and failed `breakerThreshold` times) is NOT infra-attributed —
 * it still wakes + escalates with its real (non-zero) count.
 */

/**
 * The completion-guarantee contract for ONE placement (P-020 + P-021), pure:
 *   unit gone        → abandon
 *   unit terminal    → completed              (the placement succeeded)
 *   live holder      → healthy                (working / re-placement took)
 *   already cursed   → latched                (the breaker has tripped — HALT)
 *   else (failed)    → breaker | debounced | recover
 * `breaker` fires once the count AFTER this failure reaches the threshold, so the
 * unit is escalated rather than re-placed a (threshold+1)-th time.
 *
 * EI-865 — the breaker LATCHES. Once a unit is `cursed`, every later sweep
 * short-circuits to `latched`: NO re-fire, NO re-escalation, NO failCount bump.
 * Before this latch the `cursed` status fell through to the failed-placement path
 * every tick (the debounce only guards `recovering`), so the watchdog re-entered
 * `breaker`, re-escalated, and climbed failCount UNBOUNDED (observed 356→460 in a
 * night) while the Mug kept re-placing a doomed item. The latch is the early-out
 * that turns the breaker from a one-shot-that-re-fires into a true HALT. The unit
 * leaves the latch only when it reaches terminal (→ completed) or is re-placed and
 * worked by a live cup (→ healthy); a human/Mug who fixes + re-places it clears it.
 */
export function evaluatePlacement(obs: PlacementObservation, cfg: PlacementConfig): PlacementDecision {
  if (!obs.unitExists) return { kind: 'abandon', reason: 'unit no longer exists' };
  if (obs.unitTerminal) return { kind: 'completed' };
  if (obs.hasLiveHolder) return { kind: 'healthy' };

  // WI-1439 recovery-churn fix — a deliberately PARKED unit (isUnitParked, e.g.
  // `blocked` for an owner/human-gated step) is EXPECTED to have no live holder.
  // Checked BEFORE the cursed latch / debounce / breaker paths so a parked unit
  // never enters ANY of them: no recovery wake, no counter bump, no escalation —
  // it has its own delegator-notify signal path (mirrors FEATURE_NON_REQUEUE_STATES
  // treating `blocked` as non-requeueable). Without this, the watchdog fired a
  // Mug recovery wake for a parked unit every debounce window forever, each wake
  // re-placing a fresh cup that could only re-confirm the same gate and die —
  // observed live on WI-1439 (a new cup every ~5-40min for days).
  if (obs.unitParked)
    return { kind: 'parked', reason: 'unit status is a deliberate park (e.g. blocked) — no holder expected' };

  // EI-865 — the cursed latch: a unit already tripped by the breaker is HALTED.
  // No live holder + not terminal + already cursed ⇒ leave it latched. Re-firing /
  // re-escalating here is exactly the unbounded-retry bug (failCount 356→460); the
  // breaker only halts for real if a cursed unit short-circuits before the failed
  // path. (terminal / live-holder above already clear the curse the moment it's
  // genuinely resolved or re-placed-and-working.)
  //
  // EI-18712524449804476 — BUT a bare latch here is exactly the bug this item
  // reports: checkpointDeclaresTerminal / planItemDeclaresTerminal (below) were only
  // ever checked on the 'recovering' path, so a CURSED row whose own checkpoint (or
  // linked plan item) already declares the work done/superseded stayed cursed FOREVER
  // — the state/checkpoint divergence is invisible once the breaker has tripped, not
  // just before it. Concrete (2026-07-26): WI-4446 (cursed, failCount 6, checkpoint
  // "TERMINAL — ... COMPLETE + VERIFIED") and WI-4480 (cursed, failCount 5, checkpoint
  // "PASSED 2026-07-17 ...") both sat cursed while their own checkpoints said done.
  // Check the SAME two signals here, before latching: if either declares terminal,
  // fall through to the SAME checkpoint-reconcile / plan-item-reconcile decisions used
  // below — which flip `status` away from 'cursed' to 'recovering', so the very next
  // tick lands on the existing recovering-debounce window (no per-tick storm; a
  // dedicated new debounce state is unnecessary because this reuses that one).
  if (obs.placementStatus === 'cursed' || obs.placementStatus === 'stranded') {
    if (obs.checkpointDeclaresTerminal) {
      return {
        kind: 'checkpoint-reconcile',
        reason:
          'cursed row whose cup checkpoint declares terminal/blocked (stale-open, latched) — ' +
          'reconcile the state, do not stay latched forever',
      };
    }
    if (obs.planItemDeclaresTerminal) {
      return {
        kind: 'plan-item-reconcile',
        reason:
          'cursed row whose linked plan item already reached done/dropped (orphan-reconcile lag, ' +
          'latched) — self-heal via the plan-item reconciler, do not stay latched forever',
      };
    }
    return { kind: 'latched' };
  }

  if (
    obs.placementStatus === 'recovering' &&
    obs.recoveryStartedAtMs != null &&
    obs.now - obs.recoveryStartedAtMs >= DEFAULT_STALE_RECOVERING_MS
  ) {
    return {
      kind: 'stale-recovery',
      reason: `recovery made no progress for at least ${Math.round(DEFAULT_STALE_RECOVERING_MS / 3_600_000)}h`,
    };
  }

  // Non-terminal unit with no live holder → this placement failed.
  // Debounce repeated wakes only while we are ALREADY mid-recovery for it.
  if (
    obs.placementStatus === 'recovering' &&
    obs.lastRecoveryAtMs != null &&
    obs.now - obs.lastRecoveryAtMs < cfg.recoveryDebounceMs
  ) {
    return { kind: 'debounced' };
  }

  // EI-15232 — the cup's OWN checkpoint DECLARES it reached terminal/blocked, but the
  // unit row is still open (non-terminal, no live holder): the cup believed it flipped
  // the state and the flip silently failed to persist — a STALE-OPEN item. Re-placing
  // a fresh cup here would redo already-finished work and page the Mug to "re-place or
  // recover" a done unit — the EXACT EI-8529 liveness-only-misread anti-pattern this
  // watchdog otherwise institutionalizes (it keyed purely on state != terminal AND cup
  // dead/stalled, ignoring the item's own checkpoint). Suppress the re-place page and
  // emit a single state-reconciliation nudge instead: the Mug VERIFIES + reconciles the
  // state (flips it), she does NOT re-place. Placed BEFORE every failed-loss path
  // (reclaim-while-active / dormancy / zombie / breaker) so a dead-cup + declared-done
  // checkpoint never fires a recovery wake and never bumps a curse counter — a stronger,
  // more specific signal ("the cup TOLD us it finished") than any loss-attribution.
  // Debounced by the same recovering-status window above, so at most one nudge per
  // window until the state is reconciled. (Placed AFTER the cursed latch on purpose: a
  // cursed row is already latched-silent — no page to suppress — and reconciling it
  // here would re-introduce a per-tick storm, since a cursed row is not `recovering` and
  // so bypasses the debounce.)
  if (obs.checkpointDeclaresTerminal) {
    return {
      kind: 'checkpoint-reconcile',
      reason:
        'cup checkpoint declares terminal/blocked but the unit state is still open (stale-open) — ' +
        'reconcile the state, do not re-place',
    };
  }

  // WI-6038 — the SAME shape as the checkpoint check above, for a second independent
  // lag source: the unit's linked plan item already reached done/dropped, but the
  // unit's own flip is only ever applied by the separate periodic orphan-reconcile
  // sweep, which can lag by a long time. Checked BEFORE every failed-loss path so a
  // dead-cup + already-terminal-plan-item unit never fires a recovery wake or bumps a
  // curse counter for work that is, in substance, already finished.
  if (obs.planItemDeclaresTerminal) {
    return {
      kind: 'plan-item-reconcile',
      reason:
        'linked plan item already reached done/dropped but the unit state is still open ' +
        '(orphan-reconcile lag) — self-heal via the plan-item reconciler, do not re-place',
    };
  }

  // EI-865 / WI-233 — a reaper-reclaim of a STILL-ALIVE cup does NOT count toward the
  // curse. A slow-but-alive cup (a long opus:xhigh call, or WI-204's per-call PG
  // overhead in a tight capability:bash loop) goes heartbeat-stale and the P-011 reaper
  // reclaims it (spawn → failed), so this placement reads "no live holder + failed" —
  // but it was an INFRASTRUCTURE reclaim, not evidence the work-item is ill-specified or
  // wedges cups. Re-place it (it genuinely has no holder now), but keep fail_count FLAT
  // so a run of false reclaims never trips the breaker. Only a genuine failure — a
  // non-zero exit, or a reclaimed cup with NO recent model-call activity (actually
  // wedged/dead) — climbs toward the curse. Without this the whole papercup owner-focus
  // frontier (WI-214/217/218/219/220/231/232, F-FIX-*) false-cursed out of placement.
  if (obs.servingCupReclaimedWhileActive) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // FLAT — proof-of-life: a slow-but-alive cup is genuinely working
      nextInfraLossCount: obs.infraLossCount, // and is fully exempt — never even the bounded infra counter
      reason:
        'serving cup reaper-reclaimed while still active (slow-but-alive) — re-placing, not counting toward any breaker',
    };
  }

  // WI-677 — a post-dormancy recovery sweep (operator/bg-host was DOWN) is an
  // ITEM-INDEPENDENT infra loss: it is computed from the watchdog's OWN run cadence,
  // not from anything about this item, so an item can never fake it AND it can never be
  // mis-attributed pathology. FULLY EXEMPT — keep BOTH counters flat, never curse (same
  // class as servingCupReclaimedWhileActive's proof-of-life). The F-FIX-041 bug was
  // counting THIS signal toward the bounded infra breaker: a host restart fires it for
  // EVERY placement in LOCKSTEP, so a string of restarts/dormancy windows climbs all of
  // them to infraBreakerThreshold together and curses the whole frontier at once (the
  // 31-item place_batch deadlock this fixes — all rows were fail_count=0, infra=12). The
  // bound's safety rationale ("eventually curses even if mis-attributed") only holds for a
  // PER-ITEM signal that COULD be pathology; an operator-wide outage is not that, so
  // counting it is a pure false-positive generator. A genuinely-doomed item still curses
  // via the 3-strike pathology breaker (cups that RUN and fail) or the bounded zombie
  // breaker below (cups that crash pre-tool-call) — neither of which a dormant operator
  // masks. (Ordered AFTER the cursed latch + debounce, BEFORE the zombie path so a sweep
  // that is both dormant AND zombie attributes to the item-independent cause.)
  if (obs.postDormancySweep) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // FLAT — the operator being down says nothing about the item
      nextInfraLossCount: obs.infraLossCount, // FLAT — fully exempt, never accrues toward any breaker
      // EI-3216 — item-independent infra: re-place silently, do NOT wake the Mug per item
      // (a host restart fires this for EVERY placement in lockstep — that's a 32-wake storm).
      infraAttributed: true,
      reason:
        'post-dormancy recovery sweep (operator/bg-host was down) — item-independent infra loss, ' +
        'fully exempt from both breakers (re-placing, not counting)',
    };
  }

  // F-FIX-041 — a no-fair-attempt zombie (serving cup made 0 tool calls across its life —
  // an EI-1758 zombie booted without MCP tools, or a cup that died before any work). UNLIKE
  // post-dormancy this IS a per-item signal that COULD be item-pathology (an item that
  // crashes cups pre-tool-call ALSO shows 0 tool calls), so it CANNOT be fully exempted
  // without risking the EI-865 unbounded-retry bug. Count it toward the BOUNDED infra
  // breaker, NOT the 3-strike pathology breaker: a tractable item lost to a string of
  // zombies gets infraBreakerThreshold graced re-places, but the BOUND guarantees even an
  // all-zombie-attributed wedging item STILL curses (never unbounded). (place_batch then
  // still RE-PLACES a fail_count-0 zombie-curse on the Mug's deliberate path — see
  // loadCursedWorkItemIds — so a fixed-infra item is never permanently deadlocked; the
  // bound here only halts the watchdog's autonomous recovery-wake storm.)
  // WI-677 round 2 — count losses per ATTEMPT, never per sweep. (a) No serving cup at
  // all: the Mug simply has not re-placed yet (or the corpse aged out of the spawn
  // window) — there is no attempt to judge, so re-place-wake with BOTH counters flat.
  // (b) The serving cup's spawn id equals the last COUNTED loss (mig 440): this corpse
  // was already charged — recounting it every recoveryDebounce expiry is exactly how an
  // un-cursed frontier re-cursed at fail_count=3 in ~12 minutes with ZERO new cups
  // (observed live 2026-07-02 00:27; EI-865's latch fixed this recount for `cursed`
  // but not `recovering`).
  if (obs.hasServingCup === false) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: 'no serving-cup attempt since the last loss — re-place only, nothing to count',
    };
  }
  if (obs.servingCupSpawnId != null && obs.lastLossSpawnId != null && obs.servingCupSpawnId === obs.lastLossSpawnId) {
    return {
      kind: 'recover',
      nextFailCount: obs.failCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: `dead attempt ${obs.servingCupSpawnId} already counted — re-place only`,
    };
  }

  if (obs.servingCupMadeNoToolCalls) {
    const nextInfraLossCount = obs.infraLossCount + 1;
    if (nextInfraLossCount >= cfg.infraBreakerThreshold) {
      return {
        kind: 'breaker',
        nextFailCount: obs.failCount, // the pathology count is untouched
        nextInfraLossCount,
        // EI-3216 — an infra/zombie curse (fail_count=0) records `cursed` but does NOT open a
        // per-item owner escalation: the breaker tripped on cup-boot infra, not item-pathology,
        // so a "failed 0× — stopped auto-re-placing" advisory is pure queue noise the owner
        // can't act on per item. The placements.cursed health metric is the real surface.
        infraAttributed: true,
        reason: `${nextInfraLossCount} no-fair-attempt (zombie) losses (>= infra breaker ${cfg.infraBreakerThreshold}) — serving cup made 0 tool calls`,
      };
    }
    return {
      kind: 'recover',
      nextFailCount: obs.failCount, // pathology count held FLAT — a zombie loss doesn't progress it
      nextInfraLossCount,
      // EI-3216 — re-place silently: a no-fair-attempt zombie loss is infra, not item-pathology,
      // so it does NOT fire a per-item Mug recovery wake (re-placing makes another zombie).
      infraAttributed: true,
      reason:
        'serving cup made 0 tool calls (no-fair-attempt / zombie) — counted toward the bounded infra breaker, not the pathology breaker',
    };
  }

  // A genuine item-pathology loss (a fair attempt that failed) → the 3-strike breaker.
  const nextFailCount = obs.failCount + 1;
  if (nextFailCount >= cfg.breakerThreshold) {
    return {
      kind: 'breaker',
      nextFailCount,
      nextInfraLossCount: obs.infraLossCount,
      reason: `${nextFailCount} failed placements (>= breaker threshold ${cfg.breakerThreshold})`,
    };
  }
  return {
    kind: 'recover',
    nextFailCount,
    nextInfraLossCount: obs.infraLossCount,
    reason: 'serving cup dead/stalled and the unit is not terminal',
  };
}

// ── EI-14404 pure predicate: live non-cup assignee ─────────────────────────────

/**
 * EI-14404 — a unit's CURRENT assignee (`taken_by`) may be a LIVE session that is
 * not a cup at all: an SU/operator agent that pulled the item off the cup fleet
 * entirely (capability-gated work correctly rerouted, not a cup-lane failure).
 * Before this, `hasLiveHolder` only ever checked cup liveness, so once the 3-strike
 * breaker had already tripped (or trips while the non-cup assignee is working it —
 * the cup-side view sees no live cup either way), `evaluatePlacement`'s cursed latch
 * (`placementStatus === 'cursed' → 'latched'`) held the item cursed FOREVER: the
 * unit never re-enters the cup-liveness path that would clear it, because the whole
 * point of the reroute is that no cup is ever placed on it again. Concrete
 * (2026-07-17): WI-3232 and WI-4480 both sat `cursed, fail_count:3` while actively,
 * correctly owned by a live SU session — the Mug re-investigated them every wake
 * with no cup action available (pure per-wake churn).
 *
 * Pure: true when `takenBy` is set, is NOT a known cup owner/spawn id, and is a
 * member of the caller-supplied live-alias set — the SAME "is this owner alive"
 * definition `summarizeOpenPlacements` already uses for its own `working` bucket
 * (`liveHolderFragment`: a fresh `coord_presence` heartbeat, or a running/restarting
 * nursery row), reused here rather than reinvented so the two "is it actually being
 * worked" reads can never drift apart.
 */
export function isHeldByLiveNonCupAssignee(
  takenBy: string | null | undefined,
  isCupOwner: (ownerId: string) => boolean,
  liveAliases: ReadonlySet<string>,
): boolean {
  if (!takenBy) return false;
  if (isCupOwner(takenBy)) return false;
  return liveAliases.has(takenBy);
}

// ── EI-1524/1518 pure decider: stale cursed/stranded escalation GC ────────────

/**
 * EI-1524 / EI-1518 — the backstop GC decider for a `cursed`/`stranded` placement
 * that still carries an OPEN advisory escalation.
 *
 * The candidate sweep ({@link evaluatePlacement}) only resolves a cursed escalation
 * when the item is STILL a placement candidate this tick — i.e. a live cup anchors
 * or holds it (`completed` path → {@link suppressCursedEscalation}). A cursed/stranded
 * item that later reaches terminal (or is retired) with NO live cup re-anchoring it
 * FALLS OUT of the candidate set, so its escalation is never closed — the root of the
 * ~13k stale-escalation residue (a curse-storm leaves one open escalation per failed
 * re-place attempt, and they never GC once the items go terminal). The breaker was
 * correct; the lifecycle had no closing edge for the no-live-holder case.
 *
 *   - escalation present + cursed/stranded + unit GONE      → resolve-abandoned
 *   - escalation present + cursed/stranded + unit TERMINAL  → resolve-completed
 *   - otherwise (still genuinely open, or not our concern)  → keep
 *
 * Pure; exported for the decider unit tests.
 */
export type StaleEscalationDecision = 'resolve-completed' | 'resolve-abandoned' | 'keep';

export interface StalePlacementEscalationObs {
  /** The placement row carries an escalation_msg_id (an open advisory). */
  hasEscalation: boolean;
  /** The placement's current status — only `cursed`/`stranded` are GC candidates. */
  placementStatus: string;
  /** The subject work-item row still exists. */
  unitExists: boolean;
  /** The subject work-item reached a terminal state. */
  unitTerminal: boolean;
}

export function evaluateStalePlacementEscalation(obs: StalePlacementEscalationObs): StaleEscalationDecision {
  if (!obs.hasEscalation) return 'keep';
  if (obs.placementStatus !== 'cursed' && obs.placementStatus !== 'stranded') return 'keep';
  // The terminal/gone verdict is the same for every open status — reuse the general
  // decider so the escalation GC and the completion GC can never diverge (EI-6109).
  return evaluateTerminalPlacementReconcile({
    placementStatus: obs.placementStatus,
    unitExists: obs.unitExists,
    unitTerminal: obs.unitTerminal,
  });
}

// ── EI-6109 pure decider: completion-reconcile GC over ALL open placements ─────

/** The non-terminal (OPEN) placement statuses the completion GC reconciles. A
 *  placement in one of these is still tracked as in-flight; once its subject unit
 *  reaches terminal / is retired, the durable row must converge to completed /
 *  abandoned so pot:status, summarizeOpenPlacements, and loadCursedWorkItemIds
 *  stop counting a lane whose work has actually finished. */
export const OPEN_PLACEMENT_STATES = new Set(['working', 'recovering', 'cursed', 'stranded']);

export interface TerminalPlacementObs {
  /** The placement's current status — only OPEN statuses are reconcile candidates. */
  placementStatus: string;
  /** The subject work-item row still exists. */
  unitExists: boolean;
  /** The subject work-item reached a terminal state. */
  unitTerminal: boolean;
}

/**
 * EI-6109 — the completion-reconcile decider, generalizing the EI-1524 escalation GC
 * beyond `cursed`/`stranded`-with-escalation. A placement in ANY open status
 * (working / recovering / cursed / stranded) whose subject unit has reached terminal —
 * or been retired — must converge to completed / abandoned. This is the closing edge
 * the per-candidate sweep and the escalation-only GC together left uncovered:
 *   • a `working`/`recovering` row is never revisited once its serving cup dies /
 *     ages out of the candidate set (nothing re-anchors it), and
 *   • an infra-attributed `cursed`/`stranded` row carries NO escalation_msg_id, so the
 *     escalation-only GC (which required escalation_msg_id IS NOT NULL) skipped it.
 * Both left the durable pot_placements accounting DRIFTING after the work completed
 * or the cup died — pot:status reporting cursed/working lanes long since done.
 *
 *   OPEN + unit GONE      → resolve-abandoned
 *   OPEN + unit TERMINAL  → resolve-completed
 *   otherwise (still open, or not an open status) → keep
 * Only ever fires for a terminal/gone unit, so it NEVER robs a genuinely in-flight
 * lane (a non-terminal unit is always kept for the candidate sweep). Pure; exported
 * for the decider unit tests.
 */
export function evaluateTerminalPlacementReconcile(obs: TerminalPlacementObs): StaleEscalationDecision {
  if (!OPEN_PLACEMENT_STATES.has(obs.placementStatus)) return 'keep';
  if (!obs.unitExists) return 'resolve-abandoned';
  if (obs.unitTerminal) return 'resolve-completed';
  return 'keep';
}

// ── PG: the sweep ─────────────────────────────────────────────────────────────

export interface PlacementSweepResult {
  workspaceId: string;
  installSlug: string;
  workItemId: string;
  decision: PlacementDecision['kind'] | 'stranded' | 'unblocked';
  detail?: string;
}

interface CupLite {
  spawnId: string;
  ownerId: string; // coord owner == work-item taken_by
  featureId: string | null;
  liveness: CupLiveness;
  /** EI-865 / WI-233 — a slow-but-alive false reclaim (see ACTIVE_RECLAIM_WINDOW_MS):
   *  read `dead` (heartbeat-stale / reaper-reclaimed) but made a governed model call
   *  within the activity window, so it was alive when reclaimed. */
  reclaimedWhileActive: boolean;
  /** F-FIX-041 — the cup made ZERO native tool calls (agent_activity kind='tool') across
   *  its life: a no-fair-attempt zombie (EI-1758, or died before any work). When it's the
   *  dead serving cup on a non-terminal unit, the loss is infra (bounded infra breaker),
   *  not item-pathology. */
  madeNoToolCalls: boolean;
}

interface UnitRow {
  feature_id: string;
  harness_slug: string | null;
  status: string;
  taken_by: string | null;
  /** EI-18667095591047618 — needed so the reconcile side can also honor a durable
   *  claim-hold park (`payload._claimHold`), the same signal `fleet/placement-gather.ts`
   *  already skips on. Untyped here (isClaimHoldParked takes `unknown`) — the column is
   *  jsonb and this module has no reason to model its shape beyond that one flag. */
  payload: unknown;
}

interface PlacementRow {
  work_item_id: string;
  status: string;
  fail_count: number;
  /** F-FIX-041 — the bounded infra-loss counter (operator dormancy / zombie cups). */
  infra_loss_count: number;
  last_recovery_ms: number | null;
  recovery_started_ms: number | null;
  /** WI-677 round 2 (mig 440) — the dead attempt (cup spawn id) whose loss was last
   *  COUNTED, so a sweep never recounts the same corpse (fail_count = attempts, not
   *  sweeps). */
  last_loss_spawn_id: string | null;
  escalation_msg_id: string | null;
  /** F-FIX-041 — last sweep time for this row (ms). max() over the pot ≈ the pot's
   *  previous sweep; a large gap to `now` means the operator was dormant in between. */
  last_seen_ms: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Resolve the pot's Mug coord-owner from its most-recent pot session — the
 *  recipient of recovery wakes, and the key cup spawns carry as parent_spawn_id. */
export async function resolveMugOwner(sql: Sql, workspaceId: string, installSlug: string): Promise<string | null> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT coord_owner_id
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'pot · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     ORDER BY started_at DESC
     LIMIT 1`;
  return rows[0]?.coord_owner_id ?? null;
}

/** Stable logical address for the Mug's fresh-per-wake coordination identity. */
export const MUG_COORD_SLOT = '@role:mug';

export interface MugWakeOptions {
  workspaceId: string;
  /** The newest live concrete owner, retained for direct wake + audit. */
  mugOwner: string | null;
  summary: string;
  source: string;
  payload?: unknown;
  body?: string;
  harnessSlug?: string | null;
}

/**
 * Deliver a Mug nudge through both halves of the fresh-per-wake contract:
 * best-effort direct wake of the currently resolved owner, plus a durable
 * stable-role slot message that the next Mug wake drains. The logical alias
 * and concrete owner are recorded together so stale-owner wakes remain
 * diagnosable without making the stale id the only delivery route.
 */
export async function wakeMug(opts: MugWakeOptions): Promise<void> {
  // THE RETIREMENT GATE (retire-mug-kettle-su-only-2026-08-09 P-037, D-027).
  //
  // This is the DELIVERY chokepoint for every Mug-directed nudge — six call
  // sites across the pot placement sweeps and the three Scout watchdogs — and
  // it is gated HERE rather than at any caller, because the callers do not
  // share a gate to sit behind. The pot sweeps decide they have work via the
  // ENGINE-gated `getPotStarted()`; the Scout sweeps decide via the UNGATED
  // sibling `listStartedPots()`, which reads the very same `hive_started` row
  // without consulting the flag. Gating the read instead would be the D-003
  // trap: Scout SURVIVES this retirement, and its sweeps must keep running and
  // keep routing through the P-034 ladder to a live su. What must stop is the
  // delivery to a tier that no longer exists, and that is exactly this seam.
  //
  // Fail-CLOSED, matching `mugKettleSystemEnabled`'s own polarity: an
  // unreadable flag resolves to retired. A false `true` re-animates a wake path
  // into a slot no live agent drains; a false `false` leaves a deliberately
  // retired tier retired.
  if (!(await mugKettleSystemEnabled())) return;
  const metadata = {
    logicalAlias: MUG_COORD_SLOT,
    concreteOwnerId: opts.mugOwner,
    source: opts.source,
  };
  if (opts.mugOwner) {
    try {
      await wakeRecipients([opts.mugOwner], {
        summary: opts.summary,
        payload: {
          ...(typeof opts.payload === 'object' && opts.payload !== null ? opts.payload : {}),
          mugWake: metadata,
        },
        source: opts.source,
        workspaceId: opts.workspaceId,
      });
    } catch (e) {
      console.warn(`[mug-wake] direct wake failed for ${opts.mugOwner}: ${e instanceof Error ? e.message : e}`);
    }
  }
  try {
    const [{ sendMessage }, { runWithWorkspace }] = await Promise.all([
      import('../agent-tools/coordination/messages'),
      import('../workspace-als'),
    ]);
    await runWithWorkspace(opts.workspaceId, () =>
      sendMessage(
        {
          ownerId: opts.source,
          ownerLabel: opts.source,
          source: 'static-client',
          workspaceId: opts.workspaceId,
          userId: null,
        },
        {
          to: [MUG_COORD_SLOT],
          summary: opts.summary,
          body: opts.body ?? opts.summary,
          harnessSlug: opts.harnessSlug,
          extra: { mugWake: metadata },
        },
      ),
    );
  } catch (e) {
    console.warn(`[mug-wake] ${MUG_COORD_SLOT} park failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** ALL Mug coord-owners that have served this pot (newest first). The Mug is
 *  fresh-per-wake (interactive brain) / adaptive-re-woken, so a single pot accrues
 *  several `pot · <slug>/mug` adv_sessions over its life; cups carry whichever
 *  owner was current at spawn time as `parent_spawn_id`. Attributing cups by ONLY
 *  the newest owner ({@link resolveMugOwner}) orphans every cup placed by an
 *  earlier Mug-wake (their placements then never reach the ledger). The watchdog
 *  must discover cups across the WHOLE owner set; wakes/attribution still target the
 *  newest (the live Mug). */
export async function resolveMugOwners(sql: Sql, workspaceId: string, installSlug: string): Promise<string[]> {
  const rows = await sql<{ coord_owner_id: string }[]>`
    SELECT DISTINCT coord_owner_id, max(started_at) AS started_at
      FROM harness_shared.adv_sessions
     WHERE workspace_id = ${workspaceId}
       AND label LIKE ${'pot · ' + installSlug + '/%'}
       AND coord_owner_id IS NOT NULL
     GROUP BY coord_owner_id
     ORDER BY started_at DESC`;
  return rows.map((r) => r.coord_owner_id);
}

/** Upsert one placement row (the per-unit completion ledger). */
async function upsertPlacement(
  sql: Sql,
  p: {
    workspaceId: string;
    installSlug: string;
    workItemId: string;
    harnessSlug: string | null;
    mugOwnerId: string | null;
    cupSpawnId: string | null;
    cupOwnerId: string | null;
    status: string;
    failCount: number;
    /** F-FIX-041 — the bounded infra-loss counter. Defaults to 0 when omitted (a fresh
     *  placement); callers that touch the failed path pass decision.nextInfraLossCount. */
    infraLossCount?: number;
    disposition: string;
    /** WI-677 r2 (mig 440) — the value to persist for last_loss_spawn_id: the counted
     *  attempt's spawn id, the preserved prior value, or null (fresh lineage). Always
     *  written explicitly (no COALESCE) so healthy/completed can CLEAR it. */
    lastLossSpawnId: string | null;
    escalationMsgId?: string | null;
    bumpRecovery?: boolean;
    now: number;
  },
): Promise<void> {
  // The org PG client (getOrgPg) rejects a raw JS Date bound to timestamptz —
  // it must receive an ISO string (cf. store-pg.ts; org-pg-client-rejects-raw-date).
  const recoveryAt = p.bumpRecovery ? new Date(p.now).toISOString() : null;
  const recoveryStartedAt = p.status === 'recovering' ? new Date(p.now).toISOString() : null;
  await sql`
    INSERT INTO harness_shared.pot_placements
      (workspace_id, install_slug, work_item_id, harness_slug, mug_owner_id,
       cup_spawn_id, cup_owner_id, status, fail_count, infra_loss_count, last_loss_spawn_id, last_disposition,
       escalation_msg_id, last_recovery_at, recovery_started_at, last_seen_at, updated_at)
    VALUES (
      ${p.workspaceId}, ${p.installSlug}, ${p.workItemId}, ${p.harnessSlug}, ${p.mugOwnerId},
      ${p.cupSpawnId}, ${p.cupOwnerId}, ${p.status}, ${p.failCount}, ${p.infraLossCount ?? 0}, ${p.lastLossSpawnId}, ${p.disposition},
      ${p.escalationMsgId ?? null}, ${recoveryAt}, ${recoveryStartedAt}, ${new Date(p.now).toISOString()}, ${new Date(p.now).toISOString()}
    )
    ON CONFLICT (workspace_id, install_slug, work_item_id) DO UPDATE SET
      harness_slug      = COALESCE(EXCLUDED.harness_slug, harness_shared.pot_placements.harness_slug),
      mug_owner_id    = COALESCE(EXCLUDED.mug_owner_id, harness_shared.pot_placements.mug_owner_id),
      cup_spawn_id      = COALESCE(EXCLUDED.cup_spawn_id, harness_shared.pot_placements.cup_spawn_id),
      cup_owner_id      = COALESCE(EXCLUDED.cup_owner_id, harness_shared.pot_placements.cup_owner_id),
      status            = EXCLUDED.status,
      fail_count        = EXCLUDED.fail_count,
      infra_loss_count  = EXCLUDED.infra_loss_count,
      last_loss_spawn_id = EXCLUDED.last_loss_spawn_id,
      last_disposition  = EXCLUDED.last_disposition,
      escalation_msg_id = COALESCE(EXCLUDED.escalation_msg_id, harness_shared.pot_placements.escalation_msg_id),
      last_recovery_at  = COALESCE(EXCLUDED.last_recovery_at, harness_shared.pot_placements.last_recovery_at),
      -- EI-15990 — recovery_started_at must be a durable TIMELINE marker (when did the
      -- most recent recovery episode START), not an ephemeral "currently recovering"
      -- flag. It used to fall to NULL the instant status left 'recovering' (the ELSE
      -- NULL branch below, now removed) — but nothing in this codebase ever reads the
      -- column outside a status = 'recovering' guard (evaluatePlacement's stale-recovery
      -- check, soak-report's stale_recovering aggregate), so that NULL-on-exit served no
      -- functional purpose while making the column read NULL on effectively every
      -- placement (recoveries usually resolve within one sweep, so an analytical
      -- snapshot query almost never catches a row mid-episode) — confirmed live:
      -- 0 of 180 papercusp placements ever had a non-null recovery_started_at despite
      -- 110 recorded infra losses. Now it is only ever (re)stamped on a FRESH entry into
      -- 'recovering' (old status != 'recovering') and otherwise PRESERVED verbatim, so a
      -- completed/cursed/abandoned row keeps a durable record of when its last recovery
      -- began (pairing with last_recovery_at to reconstruct episode duration after the
      -- fact).
      recovery_started_at = CASE
        WHEN EXCLUDED.status = 'recovering' THEN
          CASE
            WHEN harness_shared.pot_placements.status = 'recovering'
              THEN COALESCE(harness_shared.pot_placements.recovery_started_at, EXCLUDED.recovery_started_at)
            ELSE EXCLUDED.recovery_started_at
          END
        ELSE harness_shared.pot_placements.recovery_started_at
      END,
      last_seen_at      = EXCLUDED.last_seen_at,
      updated_at        = EXCLUDED.updated_at`;
}

/**
 * The sweep's external effects, as an injectable seam (defaults to the real
 * impls — the routine caller passes none). Lets the orchestration (flag gate,
 * started-pot iteration, per-pot isolation, aggregation) be unit-tested
 * without PG; reconcileOnePot's own SQL stays integration-tested separately.
 */
export interface ReconcileSweepDeps {
  getFlag: typeof getFlag;
  listStartedPots: typeof listStartedPots;
  getOrgPg: typeof getOrgPg;
  reconcileOnePot: typeof reconcileOnePot;
}

/** Reconcile EVERY started pot's placements. Fail-soft; never throws. */
export async function reconcilePotPlacements(
  opts: { now?: number; deps?: Partial<ReconcileSweepDeps> } = {},
): Promise<PlacementSweepResult[]> {
  const results: PlacementSweepResult[] = [];
  const getFlagFn = opts.deps?.getFlag ?? getFlag;
  const listStartedPotsFn = opts.deps?.listStartedPots ?? listStartedPots;
  const getOrgPgFn = opts.deps?.getOrgPg ?? getOrgPg;
  const reconcileOnePotFn = opts.deps?.reconcileOnePot ?? reconcileOnePot;
  try {
    if (!(await getFlagFn(FLAGS.POT_PLACEMENT_WATCHDOG, 'system'))) return results;
    const started = await listStartedPotsFn();
    if (started.length === 0) return results;
    const { sql } = getOrgPgFn();
    const now = opts.now ?? Date.now();
    const cfg = placementConfig();
    for (const { workspaceId, installSlug } of started) {
      try {
        results.push(...(await reconcileOnePotFn(sql, workspaceId, installSlug, cfg, now)));
      } catch (e) {
        console.warn(`[pot-placement-watchdog] pot ${installSlug} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  } catch (e) {
    console.warn(`[pot-placement-watchdog] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}

/** Reconcile ONE pot's placements against `sql` (injected so it integration-tests
 *  with a test DB). Resolves the Mug owner, derives each placed unit's holder
 *  liveness, and applies the P-020/P-021/P-022 decisions. Exported for the
 *  integration test + the P-051 invariant test. */
export async function reconcileOnePot(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  cfg: PlacementConfig,
  now: number,
  // WI-3977 — injectable liveness seam (mirrors reclaimOrphanedSpawns's `opts.isAlive`)
  // so the integration test can fake /proc without a real live child. Optional +
  // last-positioned so every existing positional call site (reconcileOnePot(sql, ws,
  // slug, cfg, now)) stays byte-identical; defaults to the real check.
  isAlive: (pid: number, kind?: 'spawn' | 'launch') => boolean = isSpawnProcessAlive,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  // ALL Mug-owners that served this pot (a fresh-per-wake / re-woken Mug accrues
  // several); cups are discovered across the whole set, but the NEWEST is the live
  // Mug we attribute to + wake. Without any resolvable owner we can neither attribute
  // cups to this pot nor target a recovery wake — leave it to the next sweep (the pot
  // may not have run yet). The liveness watchdog still keeps the Mug armed.
  const mugOwners = await resolveMugOwners(sql, workspaceId, installSlug);
  if (mugOwners.length === 0) return out;
  const mugOwner = mugOwners[0]; // newest — wake target + attribution

  // 1. This pot's cups (placement targets carry SOME Mug-owner as parent — match
  //    the full owner set so an earlier-wake's cups aren't orphaned from the ledger).
  const cupRows = await sql<
    {
      spawn_id: string;
      session_owner: string | null;
      feature_id: string | null;
      status: string;
      heartbeat_ms: number | null;
      last_output_ms: number | null;
      run_id: string | null;
      error_message: string | null;
      pid: number | null;
      launcher_host: string | null;
    }[]
  >`
    SELECT spawn_id, session_owner, feature_id, status, run_id, error_message, pid, launcher_host,
           extract(epoch from heartbeat_at) * 1000 AS heartbeat_ms,
           extract(epoch from last_output_at) * 1000 AS last_output_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = 'cup'
       AND parent_spawn_id = ANY(${mugOwners})`;

  // WI-3977 — same-host process-liveness confirmation, reusing the WI-3961 check
  // (isSpawnProcessAlive) so a heartbeat-stale-but-actually-alive cup isn't read
  // `dead` by deriveCupLiveness below (see its doc comment). Only a SAME-HOST row
  // with a recorded pid can be positively verified; a different host or a missing
  // pid stays unverifiable (today's behavior — falls back to heartbeat-only).
  const me = hostname();
  const confirmedAliveByOwner = new Map<string, boolean>();
  for (const b of cupRows) {
    const ownerId = b.session_owner || b.spawn_id;
    if (b.launcher_host !== me || b.pid == null) continue;
    // EI-21344971525195182: this was a third hand-copy of the class boundary. It uses the
    // IDENTITY predicate, NOT spawnRowKind — deliberately: swapping in the `kind` classifier
    // would reclassify every `durable-spawn:*` row carrying an `invoke-*` run_id (71% of the
    // class, measured 2026-08-24) from 'launch' to 'spawn', tightening this liveness probe
    // from /proc-existence to the strict invoke-once-cmdline check. That is a behaviour
    // change, not a consolidation, so the identity predicate preserves it exactly.
    const kind: SpawnRowKind = isInProcessLaunchIdentity(b) ? 'launch' : 'spawn';
    if (isAlive(b.pid, kind)) {
      confirmedAliveByOwner.set(ownerId, true);
      confirmedAliveByOwner.set(b.spawn_id, true);
    }
  }

  // EI-865 / WI-233 — which cups made a governed model call within ACTIVE_RECLAIM_WINDOW_MS
  // (agent_usage_samples, keyed by the spawn's run_id). This is the liveness signal that a
  // heartbeat-stale / reaper-reclaimed cup was actually SLOW-BUT-ALIVE: a long model call
  // emits no stdout (so last_output_at is useless) but DOES write a usage sample. A reclaim
  // of such a cup must not count toward the placement curse. The `ts >= now - window` bound
  // keeps this on the (workspace_id, ts DESC) index — a few minutes of recent samples.
  const cupRunIds = [...new Set(cupRows.map((b) => b.run_id).filter((r): r is string => !!r))];
  const activeRunIds = new Set<string>();
  if (cupRunIds.length > 0) {
    const activeRows = await sql<{ run_id: string }[]>`
      SELECT DISTINCT run_id
        FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${workspaceId}
         AND run_id = ANY(${cupRunIds})
         AND ts >= ${now - ACTIVE_RECLAIM_WINDOW_MS}`;
    for (const r of activeRows) if (r.run_id) activeRunIds.add(r.run_id);
  }

  // F-FIX-041 — the zombie signal: which cup OWNERS made ≥1 native tool call (agent_activity
  // kind='tool'). A serving cup with ZERO tool calls never got a fair attempt at its item
  // (an EI-1758 zombie booted without MCP tools, or died before any work), so its loss is
  // infra (the BOUNDED infra breaker), not item-pathology. Keyed by owner_id == session_owner.
  const cupActivityOwners = [...new Set(cupRows.map((b) => b.session_owner || b.spawn_id))];
  const ownersWithToolCalls = new Set<string>();
  if (cupActivityOwners.length > 0) {
    const toolRows = await sql<{ owner_id: string }[]>`
      SELECT DISTINCT owner_id
        FROM harness_shared.agent_activity
       WHERE workspace_id = ${workspaceId}
         AND owner_id = ANY(${cupActivityOwners})
         AND kind = 'tool'`;
    for (const r of toolRows) ownersWithToolCalls.add(r.owner_id);
  }
  // 2026-07-02 (gpt-5.4 switch fallout): CODEX cups never land in agent_activity —
  // the recorder is a claude-session seam — so on the agent_activity signal alone
  // EVERY codex cup read as a zombie, every restart-reclaim accrued the bounded
  // infra breaker, and the whole frontier cursed in lockstep at fail_count=0 /
  // infra_loss_count=12-15 (observed live 07-02 00:10, 17 items). The
  // tool_invocations ledger is backend-AGNOSTIC (mug/cup/overwatch codex rows
  // land there — 850+ cup invocations in the same window agent_activity had zero),
  // so ALSO count a cup as having made a fair attempt when its spawn_id has ≥1
  // invocation there. Union, not replacement: agent_activity still covers legacy
  // owners whose spawn ids predate invocation stamping.
  const cupSpawnIds = cupRows.map((b) => b.spawn_id);
  const spawnsWithToolCalls = new Set<string>();
  if (cupSpawnIds.length > 0) {
    const invRows = await sql<{ spawn_id: string }[]>`
      SELECT DISTINCT spawn_id
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId}
         AND spawn_id = ANY(${cupSpawnIds})`;
    for (const r of invRows) spawnsWithToolCalls.add(r.spawn_id);
  }

  const cupByOwner = new Map<string, CupLite>();
  for (const b of cupRows) {
    const ownerId = b.session_owner || b.spawn_id;
    const recentlyActive = b.run_id != null && activeRunIds.has(b.run_id);
    const cup: CupLite = {
      spawnId: b.spawn_id,
      ownerId,
      featureId: b.feature_id,
      liveness: deriveCupLiveness({
        status: b.status,
        heartbeatAtMs: num(b.heartbeat_ms),
        lastOutputAtMs: num(b.last_output_ms),
        now,
        // WI-3977 — don't trust a stale heartbeat as death when the process is
        // positively confirmed alive on this host.
        confirmedAliveSameHost: confirmedAliveByOwner.get(b.spawn_id) === true,
      }),
      // Slow-but-alive false reclaim: recent model-call activity AND the cup is either
      // only heartbeat-stale (still running/restarting, the reaper has not run yet) or
      // was reaper-reclaimed (not a genuine crash). A genuine non-zero exit (status
      // 'failed' with the cup's OWN error) is excluded, so a cup-wedging item still curses.
      reclaimedWhileActive:
        recentlyActive &&
        (b.status === 'running' || b.status === 'restarting' || isReaperReclaim(b.status, b.error_message)),
      // F-FIX-041 — no native tool call across this cup's life ⇒ no fair attempt
      // (zombie). Checked against BOTH ledgers (see the union note above): a hit in
      // either means the cup demonstrably worked.
      madeNoToolCalls: !ownersWithToolCalls.has(ownerId) && !spawnsWithToolCalls.has(b.spawn_id),
    };
    // Index by both owner and spawn id so a unit's taken_by resolves either way.
    cupByOwner.set(ownerId, cup);
    cupByOwner.set(b.spawn_id, cup);
  }
  const cupOwners = [...new Set(cupRows.map((b) => b.session_owner || b.spawn_id))];

  // 2. Candidate placed units: each cup's spawn-anchored unit ∪ units a cup holds
  //    (warm-inject). One fetch resolves every candidate's current row.
  const candidateIds = new Set<string>();
  for (const b of cupRows) if (b.feature_id) candidateIds.add(b.feature_id);
  if (cupOwners.length > 0) {
    const claimed = await sql<{ feature_id: string }[]>`
      SELECT feature_id FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND taken_by = ANY(${cupOwners})`;
    for (const r of claimed) candidateIds.add(r.feature_id);
  }

  // Existing placement ledger rows for this pot (the durable counters).
  const placeRows = await sql<PlacementRow[]>`
    SELECT work_item_id, status, fail_count, infra_loss_count,
           extract(epoch from last_recovery_at) * 1000 AS last_recovery_ms,
           extract(epoch from recovery_started_at) * 1000 AS recovery_started_ms,
           last_loss_spawn_id,
           escalation_msg_id,
           extract(epoch from last_seen_at) * 1000 AS last_seen_ms
      FROM harness_shared.pot_placements
     WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}`;
  const placeById = new Map<string, PlacementRow>(placeRows.map((p) => [p.work_item_id, p]));
  for (const p of placeRows) {
    if (OPEN_PLACEMENT_STATES.has(p.status)) candidateIds.add(p.work_item_id);
  }

  // F-FIX-041 — operator-dormancy detection (item-INDEPENDENT). The watchdog runs on the
  // 30s routinesTick; the most-recent last_seen_at over this pot's placements is its
  // PREVIOUS sweep. If the gap to `now` exceeds the dormancy grace, the operator/bg-host
  // was DORMANT in between (frozen ticker / session wedge / overnight dormancy), so every
  // placement "lost" for an infra reason, not item-pathology — this sweep grants the
  // grace (losses recover FLAT, not toward the curse). One flag per sweep (operator-wide
  // state), not per cup — an item cannot fake it. A pot with no prior placements
  // (maxLastSeenMs 0) is never post-dormancy (nothing to false-count; failCount starts 0).
  const maxLastSeenMs = placeRows.reduce((m, p) => Math.max(m, num(p.last_seen_ms) ?? 0), 0);
  const postDormancySweep = maxLastSeenMs > 0 && now - maxLastSeenMs > cfg.dormancyGraceMs;

  if (candidateIds.size > 0) {
    const ids = [...candidateIds];
    const unitRows = await sql<UnitRow[]>`
      SELECT feature_id, harness_slug, status, taken_by, payload
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
    const unitById = new Map<string, UnitRow>(unitRows.map((u) => [u.feature_id, u]));

    // EI-14404 — resolve liveness for every distinct assignee (`taken_by`) up front,
    // the SAME live-alias definition `summarizeOpenPlacements` uses (fresh
    // coord_presence heartbeat, or a running/restarting nursery row). Scoped to just
    // this sweep's taken_by values (bounded, not a table scan). Cup owners are ALSO
    // in this set — harmless, `isHeldByLiveNonCupAssignee` excludes them via
    // `cupByOwner` so a live cup keeps going through its existing, more nuanced
    // `deriveCupLiveness` path, not this one.
    const takenByIds = [...new Set(unitRows.map((u) => u.taken_by).filter((v): v is string => Boolean(v)))];
    const liveAssigneeAliases = new Set<string>();
    if (takenByIds.length > 0) {
      const graceSec = Math.max(1, Math.round(STALE_CLAIM_GRACE_MS / 1000));
      const liveRows = await sql<{ alias: string }[]>`
        WITH live_holder AS (${liveHolderFragment(sql, graceSec)})
        SELECT DISTINCT alias FROM live_holder WHERE alias = ANY(${takenByIds})`;
      for (const r of liveRows) liveAssigneeAliases.add(r.alias);
    }

    // EI-15232 — batch-read each candidate's latest cup checkpoint (one query over
    // carry_notes) so the decider can reconcile a STALE-OPEN unit (state=todo, cup
    // dead) against the cup's OWN declaration that it reached terminal/blocked. Only
    // NON-terminal units can take the failed path where the checkpoint matters (a
    // terminal unit is `completed` regardless), so we key just those — keeping the
    // read bounded to the live frontier. Same canonical scope + null-harness
    // canonicalization the write/read seams use (workItemCheckpointScope), so no
    // namespace can drift (the EI-8805 class).
    const checkpointDeclaredById = new Map<string, boolean>();
    const scopeToUnitId = new Map<string, string>();
    for (const unitId of ids) {
      const u = unitById.get(unitId);
      if (isUnitTerminal(u?.status)) continue;
      scopeToUnitId.set(workItemCheckpointScope(u?.harness_slug ?? null, unitId), unitId);
    }
    if (scopeToUnitId.size > 0) {
      const cpScopes = [...scopeToUnitId.keys()];
      const cpRows = await sql<{ scope: string; note: string | null }[]>`
        SELECT scope, note FROM harness_shared.carry_notes
         WHERE workspace_id = ${workspaceId} AND scope = ANY(${cpScopes})`;
      for (const r of cpRows) {
        const id = scopeToUnitId.get(r.scope);
        if (id && checkpointDeclaresTerminal(r.note)) checkpointDeclaredById.set(id, true);
      }
    }

    // WI-6038 — batch-resolve each NON-terminal candidate's linked plan item (via the
    // payload.plan_item stamp), grouped by plan so each plan is read once. A unit whose
    // plan item already reached done/dropped is not genuinely stalled — its own flip is
    // just pending the separate periodic orphan-reconcile sweep. Mirrors the checkpoint
    // batch-read immediately above; see readPlanItemStamp's doc comment for why this
    // second lag source exists independent of the checkpoint one.
    const planItemStampById = new Map<string, { planSlug: string; itemId: string }>();
    for (const unitId of ids) {
      const u = unitById.get(unitId);
      if (isUnitTerminal(u?.status)) continue;
      const stamp = readPlanItemStamp(u?.payload);
      if (stamp) planItemStampById.set(unitId, stamp);
    }
    const planItemTerminalById = new Map<string, boolean>();
    if (planItemStampById.size > 0) {
      const unitIdsByPlan = new Map<string, string[]>();
      for (const [unitId, stamp] of planItemStampById) {
        const arr = unitIdsByPlan.get(stamp.planSlug) ?? [];
        arr.push(unitId);
        unitIdsByPlan.set(stamp.planSlug, arr);
      }
      for (const [planSlug, unitIdsForPlan] of unitIdsByPlan) {
        const harnessHint = unitById.get(unitIdsForPlan[0])?.harness_slug ?? undefined;
        const row = await getPlanRow(planSlug, { harnessSlug: harnessHint ?? undefined }).catch(() => null);
        if (!row) continue; // fail-closed: cannot confirm status → never treat as terminal.
        const statusById = new Map(row.items.map((i) => [i.id, i.status]));
        for (const unitId of unitIdsForPlan) {
          const st = statusById.get(planItemStampById.get(unitId)!.itemId);
          if (st === 'done' || st === 'dropped') planItemTerminalById.set(unitId, true);
        }
      }
    }

    for (const unitId of ids) {
      const unit = unitById.get(unitId);
      const existing = placeById.get(unitId);

      // Serving cup = the unit's current holder, or the cup whose spawn placed it.
      const holder = unit?.taken_by ? cupByOwner.get(unit.taken_by) : undefined;
      const anchor = cupRows.find((b) => b.feature_id === unitId);
      const anchorCup = anchor ? cupByOwner.get(anchor.session_owner || anchor.spawn_id) : undefined;
      const servingCup = holder ?? anchorCup;
      // EI-14404 — a live NON-CUP assignee (an SU/operator session that pulled this
      // unit off the cup fleet) counts as a live holder too, so a cursed/latched item
      // clears the moment it is genuinely, actively held outside the cup lane —
      // instead of staying latched forever because no cup can ever re-anchor it.
      const heldByLiveNonCupAssignee = isHeldByLiveNonCupAssignee(
        unit?.taken_by,
        (id) => cupByOwner.has(id),
        liveAssigneeAliases,
      );
      const hasLiveHolder =
        holder?.liveness === 'live' || anchorCup?.liveness === 'live' || heldByLiveNonCupAssignee;
      // WI-233 — only meaningful when there is no live holder (the failed path): was the
      // serving cup a slow-but-alive false reclaim rather than a genuine failure?
      const servingCupReclaimedWhileActive =
        !hasLiveHolder && (holder?.reclaimedWhileActive === true || anchorCup?.reclaimedWhileActive === true);
      // F-FIX-041 — likewise only on the failed path: did the serving cup make 0 tool calls
      // (a no-fair-attempt zombie)? Feeds the bounded infra breaker, not the pathology one.
      const servingCupMadeNoToolCalls =
        !hasLiveHolder && (holder?.madeNoToolCalls === true || anchorCup?.madeNoToolCalls === true);

      const obs: PlacementObservation = {
        workItemId: unitId,
        unitExists: Boolean(unit),
        unitTerminal: isUnitTerminal(unit?.status),
        hasLiveHolder,
        failCount: existing?.fail_count ?? 0,
        infraLossCount: existing?.infra_loss_count ?? 0,
        placementStatus: existing?.status ?? null,
        lastRecoveryAtMs: existing?.last_recovery_ms ?? null,
        recoveryStartedAtMs: existing?.recovery_started_ms ?? null,
        hasServingCup: servingCup != null, // WI-677 r2 — no cup ⇒ nothing to count
        servingCupSpawnId: servingCup?.spawnId ?? null,
        lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
        servingCupReclaimedWhileActive,
        servingCupMadeNoToolCalls, // F-FIX-041 — zombie (no-fair-attempt) → bounded infra breaker
        postDormancySweep, // F-FIX-041 — operator-dormancy grace (item-independent, per-sweep)
        // EI-18667095591047618 — both park dialects (status-level AND claim-hold); see
        // isUnitParkedForReconcile's doc comment for why this must never be status-only again.
        unitParked: isUnitParkedForReconcile(unit?.status, unit?.payload),
        checkpointDeclaresTerminal: checkpointDeclaredById.get(unitId) === true, // EI-15232 — stale-open reconcile
        planItemDeclaresTerminal: planItemTerminalById.get(unitId) === true, // WI-6038 — orphan-reconcile lag
        now,
      };
      const decision = evaluatePlacement(obs, cfg);

      const base = {
        workspaceId,
        installSlug,
        workItemId: unitId,
        harnessSlug: unit?.harness_slug ?? null,
        mugOwnerId: mugOwner,
        cupSpawnId: servingCup?.spawnId ?? null,
        cupOwnerId: servingCup?.ownerId ?? null,
        now,
      };

      switch (decision.kind) {
        case 'healthy':
          if (existing?.status === 'stranded' && existing.escalation_msg_id) {
            await resolvePlacementEscalation(
              existing.escalation_msg_id,
              unitId,
              `auto-resolved: work-item ${unitId} has a live serving cup; recovery is making progress again`,
            );
          }
          // EI-14404 — a previously cursed/latched item can now reach `healthy` via a
          // LIVE NON-CUP assignee (heldByLiveNonCupAssignee), not only a re-placed cup.
          // Close out any open cursed advisory the same way: the breaker's concern (no
          // live progress) is resolved, so a per-item escalation the owner can't act on
          // for a correctly-rerouted item shouldn't linger open.
          if (existing?.status === 'cursed' && existing.escalation_msg_id) {
            await resolvePlacementEscalation(
              existing.escalation_msg_id,
              unitId,
              heldByLiveNonCupAssignee
                ? `auto-resolved: work-item ${unitId} is actively held by a live non-cup (SU/operator) session — routed off the cup fleet, not a cursed placement`
                : `auto-resolved: work-item ${unitId} has a live serving cup again`,
            );
          }
          await upsertPlacement(sql, {
            ...base,
            status: 'working',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            lastLossSpawnId: null, // live attempt → fresh loss lineage (WI-677 r2)
            disposition: 'working',
          });
          break;
        case 'stale-recovery': {
          const ageHours = Math.max(0, Math.floor((now - (obs.recoveryStartedAtMs ?? now)) / 3_600_000));
          const msgId = await escalateStaleRecovery(unitId, base.harnessSlug, ageHours);
          await upsertPlacement(sql, {
            ...base,
            status: 'stranded',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
            disposition: 'recovery-timeout',
            escalationMsgId: msgId,
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'stale-recovery',
            detail: decision.reason,
          });
          break;
        }
        case 'completed':
          if (existing?.status !== 'completed') {
            // EI-972 — suppress any cursed-placement escalation for this item since
            // it has now reached a terminal state and is no longer cursed.
            if (existing?.escalation_msg_id) {
              await suppressCursedEscalation(existing.escalation_msg_id, unitId);
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'completed',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: null,
              disposition: 'completed',
            });
            out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'completed' });
            // P-032 — EDGE RESOLUTION: a completed lane that gated downstream work
            // has just un-gated it (its `blocks` edges resolve). Fire ONE Mug wake
            // so she surveys + places the now-ready next-wave batch — the wave
            // ordering executing through edge resolution, replacing the hand-rolled
            // pair-emit `:done` events (mug-wave-dispatch D-006). The survey applies
            // the precise readiness gate; we only wake when there IS non-terminal
            // downstream this lane blocks. Fires once (guarded by the status transition).
            if (base.harnessSlug) {
              const downstream = await countNonTerminalDownstream(sql, workspaceId, base.harnessSlug, unitId);
              if (downstream > 0) {
                await fireUnblockWake(workspaceId, mugOwner, unitId, base.harnessSlug, downstream);
                out.push({
                  workspaceId,
                  installSlug,
                  workItemId: unitId,
                  decision: 'unblocked',
                  detail: `${downstream} downstream`,
                });
              }
            }
          }
          break;
        case 'parked':
          // WI-1439 recovery-churn fix — the unit's OWN status is a deliberate park
          // (isUnitParked, e.g. `blocked` or `needs-human` for an owner/human-gated
          // step — EI-6563). No live
          // holder is EXPECTED here, so this is NOT pathology: never bump fail/infra
          // counters, never stamp a loss lineage, and suppress any pre-existing cursed
          // escalation (mirrors the 'completed' case) since a park supersedes any prior
          // curse — the item has its own delegator-notify signal path, not the watchdog's.
          if (existing?.status !== 'blocked') {
            if (existing?.escalation_msg_id) {
              await suppressCursedEscalation(existing.escalation_msg_id, unitId);
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'blocked',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: null,
              disposition: 'parked',
            });
          }
          break;
        case 'checkpoint-reconcile':
          // EI-15232 — the cup's checkpoint declares terminal/blocked but the unit
          // state is STALE-OPEN (a silently-failed flip). Do NOT re-place: track the
          // placement as `recovering` (so it stays visible + debounced, and the
          // stale-recovery backstop still bounds it if never reconciled), keep BOTH
          // counters FLAT (this is not a failed attempt), preserve the loss lineage,
          // and fire ONE state-reconciliation nudge — NOT the "re-place or recover"
          // page. The Mug verifies + reconciles the state; she does not spawn a cup.
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: obs.failCount,
            infraLossCount: obs.infraLossCount,
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
            disposition: 'checkpoint-reconcile',
            bumpRecovery: true,
          });
          await fireReconcileWake(workspaceId, mugOwner, unitId, base.harnessSlug);
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'checkpoint-reconcile',
            detail: decision.reason,
          });
          break;
        case 'plan-item-reconcile': {
          // WI-6038 — self-heal INLINE via the same reconciler the periodic orphan
          // sweep uses, rather than paging the Mug to re-place a cup for work that is
          // already, in substance, done. Best-effort: reconcileLinkedWorkItemsForPlanItem
          // never throws (internal try/catch) and re-reads the plan item's CURRENT
          // status itself, so a race that un-terminals it between our batch read above
          // and now is handled safely (it just skips, `healed` stays false below).
          const stamp = planItemStampById.get(unitId);
          let healed = false;
          if (stamp) {
            const result = await reconcileLinkedWorkItemsForPlanItem({
              planSlug: stamp.planSlug,
              itemId: stamp.itemId,
              harnessSlug: base.harnessSlug,
            }).catch(() => null);
            healed = result?.reconciled.includes(unitId) === true;
          }
          if (healed) {
            // Mirrors the 'completed' case: the reconciler just terminal-flipped the
            // unit directly, so converge the placement ledger + fire the same
            // downstream unblock wake a natural completion would.
            if (existing?.escalation_msg_id) {
              await suppressCursedEscalation(existing.escalation_msg_id, unitId);
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'completed',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: null,
              disposition: 'plan-item-reconcile',
            });
            out.push({
              workspaceId,
              installSlug,
              workItemId: unitId,
              decision: 'plan-item-reconcile',
              detail: decision.reason,
            });
            if (base.harnessSlug) {
              const downstream = await countNonTerminalDownstream(sql, workspaceId, base.harnessSlug, unitId);
              if (downstream > 0) {
                await fireUnblockWake(workspaceId, mugOwner, unitId, base.harnessSlug, downstream);
                out.push({
                  workspaceId,
                  installSlug,
                  workItemId: unitId,
                  decision: 'unblocked',
                  detail: `${downstream} downstream`,
                });
              }
            }
          } else {
            // Couldn't confirm the heal (raced back off terminal, in-flight elsewhere,
            // or a link the reconciler couldn't resolve) — track as recovering WITHOUT
            // paging, same debounce protection checkpoint-reconcile uses, so a
            // genuinely-stuck unit still surfaces via the stale-recovery backstop.
            await upsertPlacement(sql, {
              ...base,
              status: 'recovering',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
              disposition: 'plan-item-reconcile',
              bumpRecovery: true,
            });
          }
          break;
        }
        case 'recover':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: decision.nextFailCount,
            infraLossCount: decision.nextInfraLossCount,
            // Counted a loss ⇒ stamp WHICH corpse, so the next sweep can't recount it;
            // flat re-place ⇒ preserve the prior stamp (WI-677 r2, mig 440).
            lastLossSpawnId:
              decision.nextFailCount > obs.failCount || decision.nextInfraLossCount > obs.infraLossCount
                ? (servingCup?.spawnId ?? existing?.last_loss_spawn_id ?? null)
                : (existing?.last_loss_spawn_id ?? null),
            disposition: 'recover',
            bumpRecovery: true,
          });
          // EI-3216 — an ITEM-INDEPENDENT infra loss (operator dormancy / no-fair-attempt
          // zombie) re-places silently: it does NOT fire a per-item Mug recovery wake (the
          // Mug can't fix cup-boot infra by re-placing THIS item, and a fleet-wide no-cups
          // window would fire one wake PER placement — the ~5min wake storm). The recovering
          // row is still surfaced in pot:status, so she drives it on her next natural survey.
          if (!decision.infraAttributed) {
            await fireRecoveryWake(workspaceId, mugOwner, unitId, base.harnessSlug, decision.nextFailCount);
          }
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'recover',
            detail: `attempt ${decision.nextFailCount}`,
          });
          break;
        case 'breaker': {
          // EI-3216 — only a genuine item-PATHOLOGY curse (a cup that RAN and failed
          // `breakerThreshold` times) opens a per-item owner escalation. An infra-attributed
          // curse (the bounded no-fair-attempt zombie breaker, fail_count=0) records `cursed`
          // for the health metric but skips the escalation: a "failed 0×" advisory is queue
          // noise the owner can't act on per item (the fleet-wide cup-boot infra is the real
          // problem, surfaced in aggregate). This is the source of the 32-row "failed 0×" flood.
          const msgId = decision.infraAttributed
            ? null
            : await escalateCursedPlacement(unitId, base.harnessSlug, decision.nextFailCount);
          await upsertPlacement(sql, {
            ...base,
            status: 'cursed',
            failCount: decision.nextFailCount,
            lastLossSpawnId: servingCup?.spawnId ?? existing?.last_loss_spawn_id ?? null,
            infraLossCount: decision.nextInfraLossCount,
            disposition: 'breaker',
            escalationMsgId: msgId,
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'breaker',
            detail: decision.reason,
          });
          break;
        }
        case 'latched':
          // EI-865 — the breaker has tripped and the unit is still cursed: HALT.
          // Refresh last_seen_at (the row stays observable in pot:status) but do
          // NOT re-fire, NOT re-escalate (escalation_msg_id is preserved), and do
          // NOT bump fail_count — the latch holds it steady at the breaker count.
          await upsertPlacement(sql, {
            ...base,
            status: obs.placementStatus === 'stranded' ? 'stranded' : 'cursed',
            failCount: obs.failCount,
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
            infraLossCount: obs.infraLossCount,
            disposition: obs.placementStatus === 'stranded' ? 'recovery-timeout' : 'breaker',
          });
          out.push({
            workspaceId,
            installSlug,
            workItemId: unitId,
            decision: 'latched',
            detail: `${obs.placementStatus}, halted (fail_count ${obs.failCount} frozen)`,
          });
          break;
        case 'debounced':
          await upsertPlacement(sql, {
            ...base,
            status: 'recovering',
            failCount: obs.failCount,
            lastLossSpawnId: existing?.last_loss_spawn_id ?? null,
            infraLossCount: obs.infraLossCount,
            disposition: 'recover',
          });
          break;
        case 'abandon':
          if (existing && existing.status !== 'abandoned' && existing.status !== 'completed') {
            if (existing.escalation_msg_id) {
              await resolvePlacementEscalation(
                existing.escalation_msg_id,
                unitId,
                `auto-resolved: work-item ${unitId} no longer exists; the ${existing.status} advisory is no longer relevant`,
              );
            }
            await upsertPlacement(sql, {
              ...base,
              status: 'abandoned',
              failCount: obs.failCount,
              infraLossCount: obs.infraLossCount,
              lastLossSpawnId: null,
              disposition: 'abandoned',
            });
            out.push({ workspaceId, installSlug, workItemId: unitId, decision: 'abandon', detail: decision.reason });
          }
          break;
      }
    }
  }

  // 3. P-022 — stranded-work resolution: stuck blockers gating downstream work.
  out.push(...(await reconcileStrandedWork(sql, workspaceId, installSlug, mugOwner, placeById, now)));

  // 4. EI-6109/1524/1518 — completion-reconcile GC: converge EVERY open placement
  //    (working/recovering/cursed/stranded) whose subject item went terminal/gone with
  //    no live cup re-anchoring it (the candidate sweep above never revisits those, so
  //    the durable accounting would drift), resolving any advisory it still carries.
  out.push(...(await reconcileTerminalPlacements(sql, workspaceId, installSlug, now)));
  return out;
}

/** P-020 — fire ONE targeted recovery wake to the Mug so she re-places the
 *  stalled unit without waiting for the next idle wake. Best-effort: a woken:0
 *  (Mug has no armed wake) degrades to "she sees the recovering row in
 *  pot:status on her next natural turn"; the liveness watchdog keeps her armed. */
async function fireRecoveryWake(
  workspaceId: string,
  mugOwner: string | null,
  unitId: string,
  harness: string | null,
  attempt: number,
): Promise<void> {
  await wakeMug({
    workspaceId,
    mugOwner,
    summary:
      `Placement watchdog: work-item ${unitId}${harness ? ` (${harness})` : ''} is not terminal but its ` +
      `cup is dead/stalled (placement attempt ${attempt}) — re-place or recover it.`,
    payload: { kind: 'placement-recovery', workItemId: unitId, harness, attempt },
    source: 'pot-placement-watchdog',
    harnessSlug: harness,
  });
}

/** EI-15232 — the cup's checkpoint declares the unit reached terminal/blocked but the
 *  unit state is still open (a silently-failed `set_state` flip). Fire ONE Mug nudge to
 *  RECONCILE the state (verify + flip it) — NOT the "re-place or recover" page: re-placing
 *  redoes finished work + drives the cursed-bee noise this fixes. Debounced identically to
 *  the recovery wake (the placement is tracked `recovering`). Best-effort like fireRecoveryWake. */
async function fireReconcileWake(
  workspaceId: string,
  mugOwner: string | null,
  unitId: string,
  harness: string | null,
): Promise<void> {
  await wakeMug({
    workspaceId,
    mugOwner,
    summary:
      `Placement watchdog: work-item ${unitId}${harness ? ` (${harness})` : ''} has a cup checkpoint ` +
      `declaring it reached terminal/blocked, but its state is still open (stale-open) — VERIFY and ` +
      `reconcile the state (flip it); do NOT re-place a fresh cup.`,
    payload: { kind: 'placement-state-reconcile', workItemId: unitId, harness },
    source: 'pot-placement-watchdog',
    harnessSlug: harness,
  });
}

/** P-032 — count the NON-TERMINAL downstream features that `blockerId` (in `harness`)
 *  gates via a `blocks` edge: the lanes a completion may have just un-gated. Mirrors
 *  the canonical work_item_deps graph, with the blocker side joined to live downstream. */
async function countNonTerminalDownstream(
  sql: Sql,
  workspaceId: string,
  harness: string,
  blockerId: string,
): Promise<number> {
  const rows = await sql<{ downstream: number }[]>`
    SELECT count(*)::int AS downstream
      FROM harness_shared.work_item_deps l
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.blocked_ref, '#', 1)
       AND d.feature_id   = split_part(l.blocked_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.dep_type = 'blocks'
       AND l.blocker_kind = 'feature'
       AND l.blocked_kind = 'feature'
       AND l.blocker_ref = ${`${harness}#${blockerId}`}
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})`;
  return rows[0]?.downstream ?? 0;
}

/** P-032 — a completed lane that gated downstream work fires ONE Mug wake so she
 *  surveys + places the now-unblocked next-wave batch. The wave ordering executing
 *  through edge resolution — replacing the hand-rolled pair-emit `:done` events
 *  (mug-wave-dispatch D-006). Best-effort: a woken:0 (no armed wake) degrades to
 *  the Mug seeing the freed lanes in her next natural pot:survey. */
async function fireUnblockWake(
  workspaceId: string,
  mugOwner: string | null,
  completedId: string,
  harness: string | null,
  downstream: number,
): Promise<void> {
  await wakeMug({
    workspaceId,
    mugOwner,
    summary:
      `Placement watchdog: ${completedId}${harness ? ` (${harness})` : ''} completed and un-gated ` +
      `${downstream} downstream lane(s) — survey + place the next wave batch.`,
    payload: { kind: 'placement-unblocked', workItemId: completedId, harness, downstream },
    source: 'pot-placement-watchdog',
    harnessSlug: harness,
  });
}

/** P-021 — route a cursed unit to the owner escalation queue (the D-011 Queue
 *  precursor). Returns the escalation msg_id (or null on failure). */
async function escalateCursedPlacement(unitId: string, harness: string | null, fails: number): Promise<string | null> {
  try {
    const rec = await openEscalation(watchdogIdentity, {
      // advisory, not blocker: the watchdog has ALREADY stopped auto-re-placing —
      // this is an FYI to investigate, not a decision blocking the system. blocker
      // here (+ surfacing every cursed placement) flooded "waiting on you" with
      // ~7000 option-less ops escalations (queue-pending-accuracy D-005). The
      // reader demotes system escalations to the alert tier regardless; this keeps
      // the stored severity/importance honest too. The derived placements.cursed
      // health metric is the real cursed-state surface.
      severity: 'advisory',
      summary: `Cursed placement: ${unitId} failed ${fails}× — stopped auto-re-placing`,
      body:
        `Work-item ${unitId}${harness ? ` (${harness})` : ''} has been placed and lost ${fails} times without ` +
        `reaching a terminal state. Per the cursed-item circuit breaker (mug-autonomous-execution B-09 / P-021) ` +
        `the Mug has STOPPED auto-re-placing it. Investigate it (ill-specified? wedging cups?) then re-place, ` +
        `deprecate, or split it. Re-placing clears the breaker when it next completes.`,
      // WI-5848 (sweep of EI-18668025239634541's class): `summary` embeds the live
      // `${fails}` count, which could vary if this ever fires more than once for
      // the SAME curse episode (e.g. a process restart racing a new attempt). Key
      // on the stable unitId so any such re-fire coalesces instead of leaking.
      meta: { subjectSignature: `pot-placement-watchdog:cursed:${unitId}` },
    });
    return rec.msg_id;
  } catch (e) {
    console.warn(
      `[pot-placement-watchdog] cursed escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

async function escalateStaleRecovery(unitId: string, harness: string | null, ageHours: number): Promise<string | null> {
  try {
    const rec = await openEscalation(watchdogIdentity, {
      severity: 'advisory',
      summary: `Placement recovery stalled: ${unitId} made no progress for ${ageHours}h`,
      body:
        `Work-item ${unitId}${harness ? ` (${harness})` : ''} remained in placement recovery for ${ageHours} hours ` +
        `without acquiring a live cup or reaching a terminal state. The watchdog has stopped automatic recovery ` +
        `and marked the placement stranded. Verify the work, then re-place, split, deprecate, or resolve it.`,
      // WI-5848 (sweep of EI-18668025239634541's class): `summary` embeds the live
      // `${ageHours}` duration, which could vary if this ever fires more than once
      // for the SAME stranded episode. Key on the stable unitId so any such re-fire
      // coalesces instead of leaking.
      meta: { subjectSignature: `pot-placement-watchdog:stale-recovery:${unitId}` },
    });
    return rec.msg_id;
  } catch (e) {
    console.warn(
      `[pot-placement-watchdog] stale-recovery escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
}

/** Resolve a watchdog-owned placement escalation (cursed / stranded advisory).
 *  The ONE close path — shared by the per-candidate suppression (EI-972) and the
 *  backstop GC (EI-1524). Best-effort; never throws. */
async function resolvePlacementEscalation(escalationMsgId: string, unitId: string, note: string): Promise<void> {
  if (!escalationMsgId) return;
  try {
    await resolveEscalation({
      msg_id: escalationMsgId,
      choice: 'item-now-terminal',
      resolver: WATCHDOG_OWNER,
      note,
    });
  } catch (e) {
    console.warn(
      `[pot-placement-watchdog] resolving placement escalation failed for ${unitId}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** EI-972 — suppress/auto-resolve a cursed-placement escalation when the work
 *  item reaches a terminal state (passed, resolved, etc.). Best-effort; never throws. */
async function suppressCursedEscalation(escalationMsgId: string, unitId: string): Promise<void> {
  await resolvePlacementEscalation(
    escalationMsgId,
    unitId,
    `auto-resolved: work-item ${unitId} reached terminal state, cursed advisory is no longer relevant`,
  );
}

/**
 * EI-6109 / EI-1524 / EI-1518 — the completion-reconcile GC sweep. The per-candidate
 * sweep only settles a placement to completed/abandoned while a live cup anchors or
 * holds the unit (it is a candidate THIS tick). A placement whose subject unit reaches
 * terminal — or is retired — AFTER its serving cup has died / aged out of the candidate
 * set is therefore never revisited, and keeps its OPEN status forever:
 *   • a `working`/`recovering` row has no live holder to re-anchor it, and
 *   • an infra-attributed `cursed`/`stranded` row carries NO escalation_msg_id, so the
 *     ORIGINAL escalation-only GC (which required escalation_msg_id IS NOT NULL) skipped
 *     it as well.
 * The result is the placement-accounting DRIFT (EI-6109): pot_placements reports
 * cursed/working lanes whose work-items have long since completed, and
 * loadCursedWorkItemIds (raw status='cursed') holds their ids out of the frontier.
 *
 * This sweep closes the class: every tick, over ALL of the pot's OPEN placements
 * (working / recovering / cursed / stranded), any whose subject work-item is now
 * terminal (→ completed) or gone (→ abandoned) is converged to a terminal placement
 * status. A row that still carries an advisory escalation (a genuine cursed/stranded
 * curse) also has that escalation resolved — subsuming the EI-1524 behavior. Bounded
 * (the open set is small — the frontier plus a handful of stuck rows) and fail-soft;
 * one row's failure never aborts the sweep, and a non-terminal unit is always left for
 * the candidate sweep (never robbed).
 */
async function reconcileTerminalPlacements(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const openRows = await sql<
    {
      work_item_id: string;
      status: string;
      escalation_msg_id: string | null;
      harness_slug: string | null;
      fail_count: number;
    }[]
  >`
    SELECT work_item_id, status, escalation_msg_id, harness_slug, fail_count
      FROM harness_shared.pot_placements
     WHERE workspace_id = ${workspaceId}
       AND install_slug = ${installSlug}
       AND status IN ('working', 'recovering', 'cursed', 'stranded')`;
  if (openRows.length === 0) return out;

  // Current unit status for each, keyed by feature_id within the workspace (the
  // same key the candidate sweep uses — see the unitById map above).
  const ids = [...new Set(openRows.map((r) => r.work_item_id))];
  const unitRows = await sql<{ feature_id: string; status: string }[]>`
    SELECT feature_id, status
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId} AND feature_id = ANY(${ids})`;
  const unitStatusById = new Map<string, string>(unitRows.map((u) => [u.feature_id, u.status]));

  for (const r of openRows) {
    const unitStatus = unitStatusById.get(r.work_item_id);
    const decision = evaluateTerminalPlacementReconcile({
      placementStatus: r.status,
      unitExists: unitStatus != null,
      unitTerminal: isUnitTerminal(unitStatus),
    });
    if (decision === 'keep') continue;

    const terminal = decision === 'resolve-completed';
    // Resolve any open advisory the row still carries (cursed/stranded curses do; a
    // working/recovering row, and an infra-attributed curse, carry none — those simply
    // skip the resolve and converge the status).
    if (r.escalation_msg_id) {
      await resolvePlacementEscalation(
        r.escalation_msg_id,
        r.work_item_id,
        terminal
          ? `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} reached terminal state (${unitStatus}); the ${r.status} advisory is no longer relevant`
          : `auto-resolved (placement GC, EI-1524): work-item ${r.work_item_id} no longer exists; the ${r.status} advisory is no longer relevant`,
      );
    }
    // Converge the placement out of the OPEN set so pot:status +
    // summarizeOpenPlacements + loadCursedWorkItemIds stop counting a lane whose work
    // has finished. mug/cup fields are preserved (COALESCE keeps existing on null).
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: r.work_item_id,
      harnessSlug: r.harness_slug,
      mugOwnerId: null,
      lastLossSpawnId: null, // converged out of the open set → lineage over
      cupSpawnId: null,
      cupOwnerId: null,
      status: terminal ? 'completed' : 'abandoned',
      failCount: r.fail_count,
      disposition: terminal ? 'completed' : 'abandoned',
      now,
    });
    out.push({
      workspaceId,
      installSlug,
      workItemId: r.work_item_id,
      decision: terminal ? 'completed' : 'abandon',
      detail: `gc: stale ${r.status} placement reconciled (unit ${terminal ? unitStatus : 'gone'})`,
    });
  }
  return out;
}

/**
 * P-022 — a `failing`/`failed` feature blocker that gates ≥1 non-terminal
 * downstream feature is escalated ONCE so the owner can resolve/deprecate it and
 * un-gate the downstream. Dedupe: a pot_placements row for the blocker in
 * `stranded`/`cursed` with an escalation already recorded suppresses re-escalation
 * (the breaker escalation also covers a stuck blocker that is itself cursed).
 * v1 covers feature→feature block edges (the primary case); issue-blocker
 * stranding is a follow-on.
 */
async function reconcileStrandedWork(
  sql: Sql,
  workspaceId: string,
  installSlug: string,
  mugOwner: string,
  placeById: Map<string, PlacementRow>,
  now: number,
): Promise<PlacementSweepResult[]> {
  const out: PlacementSweepResult[] = [];
  const blockers = await sql<
    { blocker_id: string; blocker_harness: string; blocker_status: string; downstream: number }[]
  >`
    SELECT b.feature_id AS blocker_id, b.harness_slug AS blocker_harness, b.status AS blocker_status,
           count(*)::int AS downstream
      FROM harness_shared.work_item_deps l
      JOIN harness_shared.harness_features_consolidated b
        ON b.workspace_id = ${workspaceId}
       AND b.harness_slug = split_part(l.blocker_ref, '#', 1)
       AND b.feature_id   = split_part(l.blocker_ref, '#', 2)
      JOIN harness_shared.harness_features_consolidated d
        ON d.workspace_id = ${workspaceId}
       AND d.harness_slug = split_part(l.blocked_ref, '#', 1)
       AND d.feature_id   = split_part(l.blocked_ref, '#', 2)
     WHERE l.workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND l.dep_type = 'blocks'
       AND l.blocker_kind = 'feature'
       AND l.blocked_kind = 'feature'
       AND b.status = ANY(${[...STUCK_BLOCKER_STATES]})
       AND d.status <> ALL(${[...TERMINAL_UNIT_STATES]})
     GROUP BY b.feature_id, b.harness_slug, b.status`;

  for (const blk of blockers) {
    const existing = placeById.get(blk.blocker_id);
    // Already escalated (stranded earlier, or cursed by the breaker) → skip.
    if (existing && existing.escalation_msg_id && (existing.status === 'stranded' || existing.status === 'cursed')) {
      continue;
    }
    let msgId: string | null = null;
    try {
      const rec = await openEscalation(watchdogIdentity, {
        severity: 'blocker',
        summary: `Stuck blocker ${blk.blocker_id} is stranding ${blk.downstream} downstream work-item(s)`,
        body:
          `Blocker ${blk.blocker_id} (${blk.blocker_harness}) is ${blk.blocker_status} and gating ` +
          `${blk.downstream} non-terminal downstream work-item(s) — they cannot proceed until it resolves. ` +
          `Resolve, deprecate, or re-place the blocker to un-gate the downstream work. ` +
          `(mug-autonomous-execution B-09 / P-022)`,
        // WI-5848 (sweep of EI-18668025239634541's class): the caller already
        // guards re-entry via `existing.escalation_msg_id` above, so this is
        // low-risk in practice — but `summary` embeds the live `${blk.downstream}`
        // count, so add the same defense-in-depth conditionKey convention.
        meta: { subjectSignature: `pot-placement-watchdog:stranded:${blk.blocker_id}` },
      });
      msgId = rec.msg_id;
    } catch (e) {
      console.warn(
        `[pot-placement-watchdog] stranded escalation failed for ${blk.blocker_id}: ${e instanceof Error ? e.message : e}`,
      );
      continue;
    }
    await upsertPlacement(sql, {
      workspaceId,
      installSlug,
      workItemId: blk.blocker_id,
      harnessSlug: blk.blocker_harness,
      mugOwnerId: mugOwner,
      lastLossSpawnId: null, // stranded-escalation marker row, not a loss event
      cupSpawnId: null,
      cupOwnerId: null,
      status: 'stranded',
      failCount: existing?.fail_count ?? 0,
      infraLossCount: existing?.infra_loss_count ?? 0, // preserve — stranded is a different concern
      disposition: 'stranded',
      escalationMsgId: msgId,
      now,
    });
    out.push({
      workspaceId,
      installSlug,
      workItemId: blk.blocker_id,
      decision: 'stranded',
      detail: `${blk.downstream} downstream`,
    });
  }
  return out;
}

/** EI-8437 / EI-12108 — maximum duration of one uninterrupted recovery episode
 *  before the watchdog halts it as stranded and the soak gate fails loud.
 *  Observed live: WI-329 sat `recovering` from 2026-07-03 through 2026-07-07
 *  (5+ days) across 3 separate Mug triage sessions that each independently
 *  concluded "needs reconciliation" but never actually verified the underlying
 *  work had already landed — so the brief now surfaces that verification is
 *  overdue instead of making every reader re-derive the staleness by hand.
 *  Env-overridable like the other watchdog tunables. */
export const DEFAULT_STALE_RECOVERING_MS = (() => {
  const v = Number(process.env.PAPERCUSP_POT_PLACEMENT_STALE_MS ?? 24 * 60 * 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 24 * 60 * 60_000;
})();

/** Open placements needing the Mug's attention — surfaced in pot:status so she
 *  acts on recoveries/cursed/stranded each wake (P-020/P-023: completion). */
export interface OpenPlacementSummary {
  recovering: number;
  cursed: number;
  stranded: number;
  workingTracked: number;
  items: Array<{
    workItemId: string;
    status: string;
    failCount: number;
    harness: string | null;
    /** EI-8437 — hours since this placement row last saw reconcile activity, when
     *  known (undefined if the caller didn't supply `updated_at`, e.g. older test
     *  fixtures / callers). */
    ageHours?: number;
    /** EI-8437 — `status === 'recovering'` AND `ageHours` exceeds
     *  {@link DEFAULT_STALE_RECOVERING_MS} — a nudge that re-placing alone hasn't
     *  worked and the underlying work should be VERIFIED (it may have already
     *  landed) before re-placing again. */
    stale?: boolean;
    /** EI-8437 — `<planSlug>#<itemId>` (joined) when the work-item traces to a
     *  plan item, so a triaging agent can jump straight to `plans:get` instead of
     *  re-deriving the link from scratch. Null when the item carries no plan link. */
    planItem?: string | null;
  }>;
}

type OpenPlacementCountRow = { status: string; count: number | string };
type OpenPlacementItemRow = {
  work_item_id: string;
  status: string;
  fail_count: number;
  harness_slug: string | null;
  /** Placement row's own `updated_at` (only moves on a reconcile touch) — optional
   *  so pre-EI-8437 callers/fixtures that don't select it still type-check.
   *  EI-18799814531115618: `upsertPlacement` rewrites this on EVERY reconcile
   *  sweep (~every 2 min), unconditionally — so it is a "last touched" clock,
   *  NOT a "how long has this been stuck" clock. Only usable for `ageHours`;
   *  never for `stale` (see recovery_started_at below). */
  updated_at?: string | Date | null;
  /** EI-18799814531115618 — the real timeline marker for "when did this
   *  recovery episode begin" (only set once, when a placement first enters
   *  `recovering`; NOT touched by the reconcile sweep). This is what `stale`
   *  must be keyed off. Optional so pre-fix callers/fixtures without it still
   *  type-check (they simply never get flagged stale). */
  recovery_started_at?: string | Date | null;
  /** EI-18799814531115618 — fallback staleness clock when recovery_started_at
   *  is null (e.g. a row escalated straight to cursed/stranded without ever
   *  recording a recovery start). */
  placed_at?: string | Date | null;
  source_plan_slug?: string | null;
  source_plan_item_ids?: string[] | null;
};

export function buildOpenPlacementSummary(
  countRows: OpenPlacementCountRow[],
  itemRows: OpenPlacementItemRow[],
  nowMs: number = Date.now(),
): OpenPlacementSummary {
  const summary: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  for (const r of countRows) {
    const count = Number(r.count) || 0;
    if (r.status === 'recovering') summary.recovering = count;
    else if (r.status === 'cursed') summary.cursed = count;
    else if (r.status === 'stranded') summary.stranded = count;
    else if (r.status === 'working') summary.workingTracked = count;
  }
  for (const r of itemRows) {
    if (r.status !== 'working') {
      const updatedAtMs = r.updated_at != null ? new Date(r.updated_at).getTime() : NaN;
      const ageHours = Number.isFinite(updatedAtMs) ? Math.max(0, (nowMs - updatedAtMs) / 3_600_000) : undefined;
      // EI-18799814531115618: `stale` used to key off `ageHours`/updated_at,
      // which the ~2-min reconcile sweep bumps on every open placement
      // unconditionally — making `stale` arithmetically unreachable (it could
      // never accumulate past a few minutes, let alone 24h). Derive it instead
      // from recovery_started_at (a real "recovery episode began at" marker,
      // only set once), falling back to placed_at when that's null.
      const recoveryClockMs =
        r.recovery_started_at != null
          ? new Date(r.recovery_started_at).getTime()
          : r.placed_at != null
            ? new Date(r.placed_at).getTime()
            : NaN;
      const recoveringHours = Number.isFinite(recoveryClockMs)
        ? Math.max(0, (nowMs - recoveryClockMs) / 3_600_000)
        : undefined;
      const stale =
        r.status === 'recovering' &&
        recoveringHours != null &&
        recoveringHours * 3_600_000 >= DEFAULT_STALE_RECOVERING_MS;
      const planItemId = r.source_plan_item_ids?.[0];
      const planItem = r.source_plan_slug && planItemId ? `${r.source_plan_slug}#${planItemId}` : null;
      summary.items.push({
        workItemId: r.work_item_id,
        status: r.status,
        failCount: r.fail_count,
        harness: r.harness_slug,
        ...(ageHours != null ? { ageHours } : {}),
        ...(stale ? { stale: true } : {}),
        ...(planItem ? { planItem } : {}),
      });
    }
  }
  // EI-6005: the wake-brief renders only `caps.placements`-many items (a bounded
  // sample) — with cursed items commonly outnumbering the rare 'recovering' one,
  // an itemRows-order truncation could silently drop the ONE item that actually
  // needs action ("re-place NOW") while still showing every merely-cursed id
  // ("STOP re-placing"). Sort recovering FIRST (then stranded, then cursed) so the
  // truncated sample always includes every recovering item before any lower-
  // priority one is shown.
  const PRIORITY: Record<string, number> = { recovering: 0, stranded: 1, cursed: 2 };
  summary.items.sort((a, b) => (PRIORITY[a.status] ?? 3) - (PRIORITY[b.status] ?? 3));
  return summary;
}

export async function summarizeOpenPlacements(
  workspaceId: string,
  installSlug: string,
  limit = 20,
): Promise<OpenPlacementSummary> {
  const empty: OpenPlacementSummary = { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0, items: [] };
  try {
    const { sql } = getOrgPg();
    const graceSec = Math.max(1, Math.round(STALE_CLAIM_GRACE_MS / 1000));
    const countRows = await sql<OpenPlacementCountRow[]>`
      WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
      live_open AS (
        SELECT p.status
          FROM harness_shared.pot_placements p
          LEFT JOIN harness_shared.harness_features_consolidated f
            ON f.workspace_id = p.workspace_id
           AND f.feature_id = p.work_item_id
         WHERE p.workspace_id = ${workspaceId}
           AND p.install_slug = ${installSlug}
           AND p.status IN ('recovering', 'cursed', 'stranded', 'working')
           AND f.feature_id IS NOT NULL
           AND f.status <> ALL(${SUMMARY_INACTIVE_UNIT_STATES}::text[])
           AND (
             p.status <> 'working'
             OR (
               f.taken_by IS NOT NULL
               AND f.taken_by <> ''
               AND EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
             )
           )
      )
      SELECT status, count(*)::int AS count
        FROM live_open
       GROUP BY status`;
    const rows = await sql<OpenPlacementItemRow[]>`
      WITH live_holder AS (${liveHolderFragment(sql, graceSec)}),
      live_open AS (
        SELECT p.work_item_id, p.status, p.fail_count, p.harness_slug, p.updated_at,
               p.recovery_started_at, p.placed_at,
               f.source_plan_slug, f.source_plan_item_ids
          FROM harness_shared.pot_placements p
          LEFT JOIN harness_shared.harness_features_consolidated f
            ON f.workspace_id = p.workspace_id
           AND f.feature_id = p.work_item_id
         WHERE p.workspace_id = ${workspaceId}
           AND p.install_slug = ${installSlug}
           AND p.status IN ('recovering', 'cursed', 'stranded', 'working')
           AND f.feature_id IS NOT NULL
           AND f.status <> ALL(${SUMMARY_INACTIVE_UNIT_STATES}::text[])
           AND (
             p.status <> 'working'
             OR (
               f.taken_by IS NOT NULL
               AND f.taken_by <> ''
               AND EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = f.taken_by)
             )
           )
      )
      SELECT work_item_id, status, fail_count, harness_slug, updated_at,
             recovery_started_at, placed_at, source_plan_slug, source_plan_item_ids
        FROM live_open
       ORDER BY (status = 'cursed') DESC, (status = 'stranded') DESC, (status = 'recovering') DESC, updated_at DESC
       LIMIT ${limit}`;
    return buildOpenPlacementSummary(countRows, rows);
  } catch {
    return empty;
  }
}

/** The Mug's MOST-RECENT real wake for a pot — the max `started_at` of her
 *  `spawned_agents` mug rows (child_role='queen', harness = the pot slug). The
 *  `pot.controlState` heartbeat reads this so the wake-brain Mug (which never
 *  calls `recordPotWake`) still shows "Running" when she actually wakes, instead of
 *  a permanent "Paused/Stalled" off the stale recordPotWake ledger (the owner's
 *  "I relaunched the app but still can't see her running" regression). ISO or null;
 *  best-effort (never throws). */
export async function latestMugWakeAt(workspaceId: string, potSlug: string): Promise<string | null> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ t: string | Date | null }[]>`
      SELECT max(started_at) AS t
        FROM harness_shared.spawned_agents
       WHERE workspace_id = ${workspaceId}
         AND child_role = 'mug'
         AND harness_slug = ${potSlug}`;
    const t = rows[0]?.t;
    return t ? new Date(t).toISOString() : null;
  } catch {
    return null;
  }
}
