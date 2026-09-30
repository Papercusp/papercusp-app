/**
 * overwatch/scorecard-backstop — the SCORECARD-EMISSION backstop
 * (hive-loop-supervision 2026-06-21, su-f76c85 — the sibling of watchdog.ts).
 *
 * The Overwatch's every-wake `pot-coordination-health` scorecard is Owner
 * requirement #1, but emission is PROMPT-driven: a turn that ends without it
 * (instruction drift, a turn that died mid-flight, a budget-exhausted turn) leaves
 * the monitor SILENT — and, unlike the forgotten `kettle:declare-wake` (which
 * watchdog.ts already backstops with a fallback SLEEP), NOTHING recovered it. Live
 * evidence (2026-06-21): ~1 complete scorecard in 7.5h while the `overwatch-wake`
 * routine fired every ~30 min — the supervisor was launched reliably but its turns
 * silently emitted nothing, and the loop had no eyes. An agent cannot fix its own
 * turn-completion fragility from inside a turn that does not complete; the recovery
 * must live in the launch machinery, exactly as the wake backstop does.
 *
 * This is that symmetric backstop. At overwatch turn-end (spawn.ts B-04 seam), if
 * the AGENT emitted no COMPLETE scorecard since its last wake, we SYNTHESIZE a
 * conservative baseline scorecard from the system-health brief (the same panels the
 * agent rates) and file it — so the monitor is never silent and Scout/monitoring
 * always have a grounded data point.
 *
 * It does NOT mask the agent's own skip (which a louder prompt + the model must
 * still fix):
 *   - the floor is marked `payload.observation.synthesized = true` and is EXCLUDED
 *     by default from `listScorecards` (so the agent-emission freshness detector in
 *     compute.ts `collectOverwatch`, the trend, the staleness signal, and Scout's
 *     digest all stay AGENT-ONLY — the floor never satisfies the agent's mandate
 *     nor pollutes the trend), and
 *   - every synthesis records a `pot_watchdog_fires` row (source
 *     `overwatch-scorecard`) — a countable "the agent skipped its scorecard" signal.
 *
 * Gated on the `papercusp-overwatch` flag (via `overwatchEnabled`) — fully inert
 * while the role is dark. Fail-soft by contract: it NEVER throws into the turn-end
 * path (every caller is a fire-and-forget seam).
 */
import { getOrgPg } from '@papercusp/db-org';
import { overwatchEnabled } from './watchdog';
import { computeWatchdogBackoff, watchdogBackoffCapHours } from '../pot/watchdog';
import { getOverwatchStarted } from './control-state';
import { getOverwatchControlState } from './snapshot';
import { checkScorecardFreshness } from '../scorecard-freshness';
import { computeSystemHealth } from '../system-health/compute';
import { captureImprovement } from '../harness/improvements/capture-core';
import { findIssuesByWatchdogKeys, mergeIssuePayload } from '../issues-engineer';
import type { SystemHealth } from '../system-health/types';
import {
  readCodeRunAdoption,
  rollupAdoption,
  gradeToolUtilization,
  type RunQuery,
} from '../code-run-adoption';

/**
 * Stable cross-turn dedup key for this hive's turn-end synthesized floor (WI-3064 —
 * the sibling gap to WI-2977's `pulseWatchdogKey`: the scheduled-pulse floor path
 * already coalesces repeat fires onto one standing open item by watchdogKey, but
 * this turn-end backstop never stamped one, so every turn the agent skipped its own
 * card minted a BRAND NEW `kind:change` observation item — an open floor pollutes
 * the drain backlog with unbounded duplicates instead of one bumped counter.
 */
export function backstopWatchdogKey(sourceHive: string): string {
  return `scorecard-backstop:${sourceHive}`;
}

/** The `payload.floorRepeat` stamp coalesced turn-end floors bump instead of re-filing
 *  (mirrors scorecard-emission-pulse.ts's `PulseRepeatStamp` convention). */
export interface FloorRepeatStamp {
  /** Total floor fires coalesced onto this item, INCLUDING the one that created it. */
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
}

/** Pure: defensively parse `payload.floorRepeat` (absent/malformed → never fired before). */
export function readFloorRepeatCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const raw = (payload as Record<string, unknown>).floorRepeat;
  if (raw == null || typeof raw !== 'object') return 0;
  const n = (raw as Record<string, unknown>).count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The minimal shape the coalescing lookup needs off a matched issue. */
export interface OpenBackstopFloor {
  id: string;
  payload: unknown;
}

/** Default lookup: the newest OPEN issue carrying this hive's backstop watchdogKey
 *  (the same indexed `findIssuesByWatchdogKeys` feed the pulse + improvement watchdog use). */
async function defaultFindOpenBackstopFloor(watchdogKey: string): Promise<OpenBackstopFloor | null> {
  const matches = await findIssuesByWatchdogKeys([watchdogKey]);
  const open = matches.find((i) => i.state === 'open');
  return open ? { id: open.id, payload: open.payload } : null;
}

/** Default bump: stamp `payload.floorRepeat` (replace-whole-object) — never touches
 *  title/state/severity, so the coalesced item still reads as an ordinary open item. */
async function defaultBumpFloorRepeat(id: string, priorCount: number, firstFiredAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const stamp: FloorRepeatStamp = {
    count: priorCount + 1,
    firstFiredAt: firstFiredAt ?? now,
    lastFiredAt: now,
  };
  await mergeIssuePayload(id, { floorRepeat: stamp });
}

/** The rubric the Overwatch scorecards against (Owner requirement #1). */
export const COORDINATION_RUBRIC_REF = 'pot-coordination-health';

/** The 15 pot-coordination-health rubric criterion keys (must cover the rubric —
 *  the capture completeness gate rejects an omitted key). Kept here so the pure
 *  synthesizer is self-contained + unit-testable without a rubric read.
 *  `scheduler-usage` (14th) added by hybrid-bee-scheduler-work-stealing-2026-06-22
 *  P-004 (rubric mig 371) — the within-hive scheduler-usage health characteristic.
 *  `context-burn` (15th) added by the loop-wake context-diet work (EI-7624).
 *  EI-13292: this list drifted to 14 (missing `context-burn`) after the rubric was
 *  extended to 15 — the auto-synth floor then filed a 14/15 scorecard that the
 *  capture completeness gate rejected as INCOMPLETE ("missing required criterion
 *  key(s): context-burn") every time it fired. Keep in lockstep with
 *  `rubrics/pot-coordination-health/rubric.json` (the true source of truth). */
export const COORDINATION_CRITERIA = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
  'context-burn',
] as const;

export interface ScorecardRating {
  rating: string;
  evidence: string;
}

export interface OverwatchScorecardCheckResult {
  /** 'synthesized' = the agent skipped and a floor was filed; 'skipped' = nothing
   *  to do (flag off / not started / agent emitted a complete scorecard);
   *  'error' = the check itself failed (recorded, never thrown). */
  outcome: 'synthesized' | 'skipped' | 'error';
  reason: string;
}

const UNKNOWN_EVIDENCE =
  'auto-synth floor — the Kettle agent turn emitted no scorecard; this criterion needs a live agent turn to assess';

const unknown = (): ScorecardRating => ({ rating: 'unknown', evidence: UNKNOWN_EVIDENCE });

/**
 * PURE: derive a conservative baseline `pot-coordination-health` scorecard from the
 * system-health brief. Only the MECHANICALLY-derivable criteria are rated from panel
 * data (end-to-end-flow, queen-workitem/plan-selection, watchdog-determinism,
 * bee-execution, ideation-quality's transport-death); every judgment-only criterion
 * is honestly 'unknown' (a deterministic floor cannot assess nuance). All 14 keys are
 * present, each with non-empty evidence (the capture completeness + evidence gates
 * require it). DB-free → unit-tested exhaustively.
 *
 * `toolUtilization` (code-run-adoption directive 2026-06-29): when the caller supplies a
 * data-derived grade (the fleet code:run adoption rate → rating, computed from
 * tool_invocations), it grounds the `tool-utilization` criterion with REAL data instead of
 * the deterministic floor's honest 'unknown'. Omitted ⇒ 'unknown' as before (the floor stays
 * DB-free + purely health-derived when no adoption read is wired in).
 */
export function synthesizeCoordinationScorecard(
  health: SystemHealth,
  toolUtilization?: ScorecardRating,
): Record<string, ScorecardRating> {
  const p = health.panels;
  const wf = p.workFeed?.data ?? null;
  const bees = p.bees?.data ?? null;
  const queen = p.queen?.data ?? null;
  const wd = p.watchdog?.data ?? null;
  const scout = p.scout?.data ?? null;
  const plans = p.plans?.data ?? null;

  const r: Record<string, ScorecardRating> = {};

  // end-to-end-flow — is work flowing queue→executor→done? (broken = input present, output absent)
  //
  // EI-19950525038045198: `attempts:0` used to be ONE opaque bucket, so "the dispatcher is
  // broken" and "there is simply nothing to dispatch to" scored identically. Worse, the old
  // evidence string interpolated a capacity number (`${running} bees running`) that the rating
  // never consumed — the verdict was a pure function of `stuck` — so an operator read
  // "7 stuck, 0 bees running" as a causal explanation for a decision that had ignored the
  // second half entirely. Capacity is now an INPUT, and the disposition is named.
  //
  // Capacity is read from the su FLEET (the live fan-out mechanism), never from `bees`: the
  // Mug/Kettle/cup nursery tier is retired permanently, so `bees.running` is structurally 0 and
  // gating on it would classify EVERYTHING as capacity-starved — inverting this bug instead of
  // fixing it. An ABSENT suFleet panel means capacity was NOT OBSERVED, which is deliberately
  // not the same as observing zero (the `unreadable ≠ clear` lesson already documented on
  // WorkFeedHealth.frontierUnreadable / stalePausedRoutinesUnreadable).
  if (wf) {
    const stuck = wf.autoEligibleStuck;
    const fleet = p.suFleet?.data ?? null;
    const liveExecutors = fleet ? fleet.live : null; // null ⇒ NOT OBSERVED, never 0
    const starved = liveExecutors === 0;

    let rating: ScorecardRating['rating'];
    let disposition: string;
    if (wf.frontierUnreadable) {
      // The survey failed this tick, so `autoEligibleStuck` is a FABRICATED ZERO. Reporting
      // that as 'healthy' is the same conflation the field's own docblock warns about: a
      // broken instrument would buy silence from the criterion that exists to raise the alarm.
      rating = 'unknown';
      disposition = 'survey-unreadable (autoEligibleStuck NOT OBSERVED this tick)';
    } else if (stuck === 0) {
      rating = 'healthy';
      disposition = 'flowing';
    } else if (starved) {
      // Expected under load: eligible work exists but there is no live executor to take it.
      // Deliberately NOT 'broken' at any depth — this is the false-positive class the split
      // exists to stop escalating.
      rating = 'degraded';
      disposition = 'quiescent-awaiting-capacity';
    } else {
      rating = stuck >= 50 ? 'broken' : 'degraded';
      disposition =
        liveExecutors === null
          ? 'stuck-capacity-unobserved (cannot attribute)'
          : 'signal1-only-no-dispatch (executors available and work still undispatched — always a bug)';
    }

    r['end-to-end-flow'] = {
      rating,
      evidence: `auto-synth: ${disposition}; ${stuck} auto-eligible items stuck at attempts:0, ${
        liveExecutors === null ? 'live fleet executors NOT OBSERVED' : `${liveExecutors} live fleet executors`
      }, ${wf.frontier} ready frontier, ${wf.deadRoutines} dead routines`,
    };
  } else r['end-to-end-flow'] = unknown();

  // ideation-quality — transport-death is mechanical; idea QUALITY is judgment
  if (scout) {
    r['ideation-quality'] = scout.transportDeath
      ? {
          rating: 'broken',
          evidence: `auto-synth: Scout TRANSPORT-DEATH — ${scout.ranInWindow} cycles ran but 0 ideas generated in-window`,
        }
      : {
          rating: 'unknown',
          evidence: `auto-synth: ${scout.ideasInWindow} ideas across ${scout.ranInWindow} cycles in-window; idea QUALITY/diversity needs a live agent turn`,
        };
  } else r['ideation-quality'] = unknown();

  // queen-workitem-selection — placing the ready backlog, or leaving it stuck?
  if (wf || queen) {
    const stuck = wf?.autoEligibleStuck ?? 0;
    const tracked = queen?.workingTracked ?? 0;
    const rating = stuck > 0 && tracked === 0 ? 'degraded' : 'unknown';
    r['queen-workitem-selection'] = {
      rating,
      evidence: `auto-synth: Mug workingTracked=${tracked}, ${stuck} auto-eligible items unplaced, queen ${
        queen?.stalled ? 'STALLED' : 'not stalled'
      }; selection QUALITY needs a live agent turn`,
    };
  } else r['queen-workitem-selection'] = unknown();

  // queen-plan-selection — only the "force-started a draft" anti-pattern is mechanical
  if (plans) {
    r['queen-plan-selection'] =
      plans.startedDraft > 0
        ? {
            rating: 'degraded',
            evidence: `auto-synth: ${plans.startedDraft} plan(s) force-started while still draft (the queen-plan-selection anti-pattern); ${plans.stalledPlans} stalled plans`,
          }
        : {
            rating: 'unknown',
            evidence: `auto-synth: 0 draft-force-starts (the one mechanical signal is clean); selection priority/quality needs a live agent turn`,
          };
  } else r['queen-plan-selection'] = unknown();

  // watchdog-determinism — armed + fire-volume (excessive noise = degraded)
  if (wd) {
    const fires = wd.fires24h;
    const rating = !wd.livenessArmed ? 'degraded' : fires >= 40 ? 'degraded' : 'healthy';
    r['watchdog-determinism'] = {
      rating,
      evidence: `auto-synth: watchdog ${wd.livenessArmed ? 'armed' : 'NOT armed'}, ${fires} fallback fires/24h, ${wd.recentErrors} recent errors`,
    };
  } else r['watchdog-determinism'] = unknown();

  // bee-execution — are the executors executing?
  //
  // EI-19961781283827318: this criterion was bee-COUPLED, and the Mug/Kettle/cup nursery tier
  // is retired permanently, so `bees.running` is structurally 0 forever. The old zero-branch
  // therefore fired on EVERY wake and reported a PERMANENT condition in transient language
  // ("0 bees running THIS WAKE — not assessable"), which is exactly the harm that item names:
  // an executor signal collapsed to a value indistinguishable from "nothing to assess", worded
  // so an operator reads it as a condition that might differ next tick. It never differs.
  //
  // Executors now live in the su FLEET, so capacity falls through to it — the same re-basing
  // already applied to end-to-end-flow above, for the same reason and with the same rule: an
  // ABSENT suFleet panel means NOT OBSERVED, which is deliberately not the same as observing
  // zero. `orphanedClaims` has no su-fleet equivalent (SuFleetHealth is
  // { total, live, stale, byRole }), so it is rated only on the legacy path, where a live
  // nursery could still report one.
  //
  // Note what is NOT claimed here: zero live executors is not rated a failure. Whether an idle
  // fleet is a problem depends on whether work is waiting, and that judgment already belongs to
  // end-to-end-flow (`quiescent-awaiting-capacity`). Rating it here too would double-count one
  // condition as two independent degradations.
  const fleetExec = p.suFleet?.data ?? null;
  if (bees && bees.running > 0) {
    r['bee-execution'] = {
      rating: bees.stale > 0 || bees.orphanedClaims > 0 ? 'degraded' : 'healthy',
      evidence: `auto-synth: ${bees.running} running, ${bees.stale} stale, ${bees.orphanedClaims} orphaned claims`,
    };
  } else if (fleetExec) {
    r['bee-execution'] =
      fleetExec.live === 0
        ? {
            rating: 'unknown',
            evidence: `auto-synth: nursery tier retired (structurally 0 bees); 0 of ${fleetExec.total} tracked su-fleet executors live, ${fleetExec.stale} stale — nothing executed this wake, so execution QUALITY is not assessable`,
          }
        : {
            rating: fleetExec.stale > 0 ? 'degraded' : 'healthy',
            evidence: `auto-synth: nursery tier retired (structurally 0 bees); ${fleetExec.live} of ${fleetExec.total} tracked su-fleet executors live, ${fleetExec.stale} stale`,
          };
  } else r['bee-execution'] = unknown();

  // judgment-only criteria — honest 'unknown' (a deterministic floor can't assess them).
  // scheduler-usage (per-bee spec authorship + get_next pickup + dedup-floor health) is a
  // claim-path read the floor doesn't make, so it is honest 'unknown' here too.
  // context-burn (mean wake chars / compaction cadence / post-compaction error markers,
  // per loop:soak-report) is likewise a read the health-panel-only floor doesn't make —
  // EI-13292: it must still be RATED (unknown, not omitted) or the scorecard reads INCOMPLETE.
  for (const k of [
    'parallel-distribution',
    'bee-observation-quality',
    'coordination-comms',
    'chatter-economy',
    'coordination-utilization',
    'scheduler-usage',
    'context-burn',
  ]) {
    r[k] = unknown();
  }

  // tool-utilization — DATA-GROUNDED when an adoption grade is supplied (code:run adoption rate
  // → rating), else 'unknown'. This is the one judgment criterion the metric makes mechanical.
  r['tool-utilization'] = toolUtilization ?? unknown();

  // This scorecard IS the synthesized floor — its own emission quality is "no agent turn".
  r['overwatch-observation-quality'] = {
    rating: 'unknown',
    evidence:
      'auto-synth floor — the Kettle agent turn emitted no scorecard, so this is the deterministic backstop, NOT an agent self-assessment (a synth-floor turn is a habit bug for the agent to fix)',
  };

  return r;
}

/** The base debounce window (hours) `recordScorecardFire` requires between two
 *  IDENTICAL reasons before EI-16038's geometric backoff (see computeWatchdogBackoff)
 *  starts widening it further. Kept short so distinct turn-to-turn skips (a genuinely
 *  new gap each turn) still each land a ledger row; only a byte-identical repeat backs
 *  off. Default 1h; env-tunable. */
export function overwatchScorecardFireBaseWindowHours(): number {
  const n = Number(process.env.PAPERCUSP_OVERWATCH_SCORECARD_FIRE_BASE_WINDOW_HOURS ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Record a "the agent skipped its scorecard; floor synthesized" fire — a countable
 * signal in the shared watchdog-fires table. Replicated (not imported from
 * watchdog.ts's side-effecting recordFire/claimWatchdogFire) on purpose: it keeps the
 * load-bearing wake path untouched and uses a distinct `overwatch-scorecard` source so
 * a drill-back can separate scorecard skips from forgot-wake fires. It DOES reuse
 * watchdog.ts's PURE `computeWatchdogBackoff` decider (EI-16038) — this call is made
 * on EVERY overwatch turn-end that skipped a scorecard, so a chronically-stuck hive
 * (the WI-3064 coalesced-floor case above) used to mint a brand new duplicate ledger
 * row every single turn, forever, with the exact same reason text. Backing off only
 * suppresses the raw LEDGER duplicate; the floor coalescing (bumpFloorRepeat, above)
 * still runs on every call regardless. Best-effort; never throws.
 */
async function recordScorecardFire(workspaceId: string, installSlug: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<Array<{ reason: string; fired_at: Date; repeat_count: number }>>`
      SELECT reason, fired_at, repeat_count FROM harness_shared.pot_watchdog_fires
      WHERE workspace_id = ${workspaceId} AND install_slug = ${installSlug}
        AND source = ${'overwatch-scorecard'}
      ORDER BY fired_at DESC
      LIMIT 1`;
    const lastRow = rows[0];
    const decision = computeWatchdogBackoff({
      now: Date.now(),
      baseWindowHours: overwatchScorecardFireBaseWindowHours(),
      capHours: watchdogBackoffCapHours(),
      last: lastRow
        ? { reason: lastRow.reason, firedAtMs: new Date(lastRow.fired_at).getTime(), repeatCount: lastRow.repeat_count ?? 1 }
        : null,
      reason,
    });
    if (decision.skip) return;
    await sql`
      INSERT INTO harness_shared.pot_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand, repeat_count)
      VALUES (${workspaceId}, ${installSlug}, ${'overwatch-scorecard'}, ${reason}, ${null}, ${'{}'}::text::jsonb, ${decision.repeatCount})`;
  } catch (e) {
    console.warn(`[overwatch-scorecard-backstop] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Default `tool-utilization` grade: read the fleet code:run adoption rollup (last 7 days) from PG
 * and grade it. Best-effort — any failure (no table, slow query) returns undefined so the floor
 * falls back to honest 'unknown' rather than breaking the backstop. Mirrors the RunQuery prod
 * wiring (sql.unsafe(query, params)). Exported for the scheduled emission pulse
 * (scorecard-emission-pulse.ts), which grounds the same criterion the same way.
 */
export async function defaultToolUtilizationGrade(): Promise<ScorecardRating | undefined> {
  try {
    const { sql } = getOrgPg();
    const runQuery: RunQuery = async <T = unknown>(query: string, params: unknown[]) =>
      (await sql.unsafe(query, params as never)) as unknown as T[];
    const summaries = await readCodeRunAdoption(runQuery, { sinceDays: 7 });
    return gradeToolUtilization(rollupAdoption(summaries));
  } catch (e) {
    console.warn(`[overwatch-scorecard-backstop] adoption grade failed: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** Dependency seam — defaults to the real impls; injectable so the whole check is
 *  unit-testable without PG / flags / vi.mock. */
export interface OverwatchScorecardEndCheckDeps {
  enabled?: () => Promise<boolean>;
  started?: (workspaceId: string, installSlug: string) => Promise<boolean>;
  controlState?: (opts: {
    workspaceId?: string;
    potSlug?: string;
  }) => Promise<{ lastWakeAt: string | null; potSlug: string | null }>;
  freshness?: typeof checkScorecardFreshness;
  computeHealth?: (workspaceId?: string) => Promise<SystemHealth>;
  capture?: typeof captureImprovement;
  recordFire?: (workspaceId: string, installSlug: string, reason: string) => Promise<void>;
  /** Data-derived `tool-utilization` grade (code:run adoption). undefined ⇒ floor uses 'unknown'. */
  toolUtilizationGrade?: () => Promise<ScorecardRating | undefined>;
  /** WI-3064: find the standing OPEN turn-end floor for this hive (by watchdogKey), if any.
   *  Default queries the real indexed watchdogKey feed. */
  findOpenBackstopFloor?: (watchdogKey: string) => Promise<OpenBackstopFloor | null>;
  /** WI-3064: bump the coalesced-onto issue's repeat stamp instead of filing anew. */
  bumpFloorRepeat?: (id: string, priorCount: number, firstFiredAt: string | null) => Promise<void>;
}

/**
 * The turn-end seam (wired in spawn.ts alongside `overwatchTurnEndCheck`): after an
 * overwatch launch finishes, if the AGENT left no COMPLETE scorecard since its last
 * wake, synthesize + file the baseline floor and record the skip. Fully gated +
 * fail-soft — mirrors watchdog.ts `armFallbackOverwatchWake`.
 */
export async function overwatchScorecardEndCheck(
  opts: { workspaceId: string; installSlug: string },
  deps: OverwatchScorecardEndCheckDeps = {},
): Promise<OverwatchScorecardCheckResult> {
  const { workspaceId, installSlug } = opts;
  const enabled = deps.enabled ?? overwatchEnabled;
  const started = deps.started ?? getOverwatchStarted;
  const controlState = deps.controlState ?? getOverwatchControlState;
  const freshness = deps.freshness ?? checkScorecardFreshness;
  const computeHealth = deps.computeHealth ?? computeSystemHealth;
  const capture = deps.capture ?? captureImprovement;
  const recordFire = deps.recordFire ?? recordScorecardFire;
  const toolUtilizationGrade = deps.toolUtilizationGrade ?? defaultToolUtilizationGrade;
  const findOpenBackstopFloor = deps.findOpenBackstopFloor ?? defaultFindOpenBackstopFloor;
  const bumpFloorRepeat = deps.bumpFloorRepeat ?? defaultBumpFloorRepeat;
  try {
    if (!(await enabled())) return { outcome: 'skipped', reason: 'overwatch flag off' };
    if (!(await started(workspaceId, installSlug))) return { outcome: 'skipped', reason: 'overwatch not started' };

    const cs = await controlState({ workspaceId, potSlug: installSlug });
    const sourceHive = cs.potSlug ?? installSlug;
    const f = await freshness({
      rubricRef: COORDINATION_RUBRIC_REF,
      sourceHive,
      ...(cs.lastWakeAt ? { since: cs.lastWakeAt } : {}),
      // AGENT-only: the floor must never satisfy the agent's own mandate.
      includeSynthesized: false,
    });
    if (f.status === 'unknown-rubric') {
      return {
        outcome: 'skipped',
        reason: `scorecard rubric '${COORDINATION_RUBRIC_REF}' is unknown — do not synthesize a floor for an invalid reference`,
      };
    }
    if (f.status === 'fresh') {
      return { outcome: 'skipped', reason: 'agent emitted a complete scorecard since last wake' };
    }

    // WI-3064: before filing a NEW item, check whether the standing turn-end floor for
    // this hive (by its stable watchdogKey) is still open — if so every turn the agent
    // keeps skipping its own card is the SAME ongoing gap, so bump its repeat counter
    // instead of piling on another open `kind:change` duplicate (mirrors the coalescing
    // scorecard-emission-pulse.ts already does for the scheduled-pulse floor, WI-2977).
    const watchdogKey = backstopWatchdogKey(sourceHive);
    const existingOpen = await findOpenBackstopFloor(watchdogKey).catch((e) => {
      console.warn(`[overwatch-scorecard-backstop] findOpenBackstopFloor failed (${watchdogKey}) — filing fresh: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    if (existingOpen) {
      const priorCount = readFloorRepeatCount(existingOpen.payload);
      const priorStamp = (existingOpen.payload as Record<string, unknown> | null)?.floorRepeat as
        | { firstFiredAt?: string }
        | undefined;
      await bumpFloorRepeat(existingOpen.id, priorCount, priorStamp?.firstFiredAt ?? null);
      const reason = `agent emitted ${f.status === 'partial-only' ? 'only a PARTIAL' : 'NO'} scorecard since last wake — coalesced onto standing open floor ${existingOpen.id} (repeat ${priorCount + 1})`;
      await recordFire(workspaceId, installSlug, reason);
      return { outcome: 'synthesized', reason: `agent scorecard ${f.status}; coalesced onto ${existingOpen.id}` };
    }

    // The turn ended with no complete agent scorecard — synthesize the floor. Ground
    // tool-utilization in real code:run adoption data (best-effort; undefined ⇒ 'unknown').
    const health = await computeHealth(workspaceId);
    const toolUtil = await toolUtilizationGrade();
    const ratings = synthesizeCoordinationScorecard(health, toolUtil);
    await capture({
      title: 'pot-coordination-health scorecard (synthesized floor)',
      kind: 'change',
      lane: 'observation',
      sourceRole: 'system',
      filedByRole: 'overwatch-watchdog',
      scope: `harness:${sourceHive}`,
      createdBy: 'system:overwatch-scorecard-backstop',
      payloadExtra: {
        watchdogKey,
        observation: {
          kind: 'reinforce',
          scope: 'papercusp',
          sourceHive,
          rubricRef: COORDINATION_RUBRIC_REF,
          ratings,
          synthesized: true,
          synthSource: 'scorecard-backstop',
        },
      },
    });
    await recordFire(
      workspaceId,
      installSlug,
      `agent emitted ${f.status === 'partial-only' ? 'only a PARTIAL' : 'NO'} scorecard since last wake; synthesized floor`,
    );
    return { outcome: 'synthesized', reason: `agent scorecard ${f.status}; floor synthesized` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[overwatch-scorecard-backstop] end-check failed (${installSlug}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}
