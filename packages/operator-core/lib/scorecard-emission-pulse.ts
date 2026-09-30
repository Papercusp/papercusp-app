/**
 * scorecard-emission-pulse — the SCHEDULED rubric-emission floor
 * (rubric-scorecard adoption step 1, WI-2374, 2026-07-04).
 *
 * overwatch/scorecard-backstop.ts guarantees a `pot-coordination-health`
 * scorecard per overwatch TURN — but it is a turn-END seam: it only fires when an
 * overwatch launch finishes. When the supervisor is STOPPED (kettle:pause) or
 * its wake loop dies, no turns end → no agent cards AND no floors, and the
 * freshness interpreter reads 'overwatch-not-started' as benign ("Ignore") — so
 * rubric emission died SILENTLY when overwatch stopped on 2026-07-02 and nothing
 * noticed (WI-2374: 198/199 scorecards ever filed were overwatch-emitted; the
 * data layer was a monoculture coupled to overwatch aliveness).
 *
 * This pulse DECOUPLES the data layer from the agent: an in-process periodic
 * check that files the same deterministic synthesized floor when NO scorecard —
 * agent OR floor — has landed within the window. Zero LLM tokens
 * (computeSystemHealth + one PG write), so it is safe through a capacity crunch
 * and while the supervisor is deliberately paused. Gated ONLY on its OWN
 * `papercusp-scorecard-emission-pulse` flag (the owner kill switch) —
 * deliberately NOT on the overwatch started bit, and (D-015) deliberately NOT on
 * the `papercusp-overwatch` FLAG either. Both of those couplings are the same
 * defect at different depths: this pulse exists BECAUSE the supervisor may be
 * stopped, dead, or — per retire-mug-kettle-su-only-2026-08-09 — RETIRED, so
 * gating the floor on the agent it backstops silently removes the floor at
 * exactly the moment it becomes load-bearing. (Measured 2026-08-09: with the
 * borrowed gate, flipping the Kettle off returned `skipped: papercusp-overwatch
 * flag off` — no error, no alarm, emission simply stops. That is WI-2374's
 * original silent death reintroduced one level up.) When overwatch runs
 * normally, cards land every wake (agent, or the turn-end backstop) so the
 * window is never empty and the pulse no-ops.
 *
 * Floors stay marked `synthesized: true` (excluded by default from
 * agent-freshness and the trend, same contract as the backstop) with a distinct
 * `synthSource: 'scheduled-pulse'`, and every filing records a
 * pot_watchdog_fires row (source `scorecard-pulse`) — the countable "the data
 * layer is running on the floor pulse" signal. Fail-soft by contract: never
 * throws into the periodic scheduler.
 *
 * ## Coalescing (WI-2977)
 * Each pulse pass is its own `improvements:capture` in the `observation` lane,
 * which by design (D-005) skips search-first dedup — recurrence is meant to be
 * the clustering signal for a genuine friction observation. But a pulse floor
 * isn't a friction finding; it's the SAME "the window was empty" fact re-filed
 * every tick a stopped supervisor stays stopped, so a multi-day outage piled up
 * one new open EI per hour (9 re-accumulated 07-04..07-05 after a sweep closed
 * the previous batch). Before filing, this now looks up the standing pulse-floor
 * item for this hive by a stable `watchdogKey` (`pulseWatchdogKey`, reuses the
 * indexed `findIssuesByWatchdogKeys` lookup the improvement watchdog already
 * uses) — an OPEN match bumps its `payload.pulseRepeat` counter instead of
 * filing a new issue; only the FIRST pulse for a given outage creates one.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { getOverwatchControlState, getOverwatchLiveness } from './overwatch/snapshot';
import {
  checkScorecardFreshness,
  interpretOverwatchEmission,
  type OverwatchEmissionContext,
  type FreshnessVerdict,
} from './scorecard-freshness';
import { computeSystemHealth } from './system-health/compute';
import { captureImprovement } from './harness/improvements/capture-core';
import { findIssuesByWatchdogKeys, mergeIssuePayload } from './issues-engineer';
import { openEscalation } from './agent-tools/coordination/escalations';
import type { AgentIdentity } from './agent-tools/coordination/identity';
import { DEFAULT_OVERWATCH_CADENCE_SEC } from './overwatch/control-state';
import {
  COORDINATION_RUBRIC_REF,
  synthesizeCoordinationScorecard,
  defaultToolUtilizationGrade,
  type ScorecardRating,
} from './overwatch/scorecard-backstop';
import type { SystemHealth } from './system-health/types';
import type { OverwatchLiveness } from './overwatch/brief-types';

/** Stable cross-tick dedup key for this hive's pulse floor (WI-2977). Same shape
 *  convention as `watchdogKeyOf` elsewhere: `<source>:<key>`. */
export function pulseWatchdogKey(sourceHive: string): string {
  return `scorecard-pulse:${sourceHive}`;
}

/** The `payload.pulseRepeat` stamp coalesced pulses bump instead of re-filing. */
export interface PulseRepeatStamp {
  /** Total pulse fires coalesced onto this item, INCLUDING the one that created it. */
  count: number;
  firstFiredAt: string;
  lastFiredAt: string;
}

/** Pure: defensively parse `payload.pulseRepeat` (absent/malformed → never fired before). */
export function readPulseRepeatCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const raw = (payload as Record<string, unknown>).pulseRepeat;
  if (raw == null || typeof raw !== 'object') return 0;
  const n = (raw as Record<string, unknown>).count;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The window in which SOME scorecard (agent or floor) must exist, else the pulse files one.
 *  1h — generous vs the overwatch cadence (10min) so a live loop always wins, tight enough
 *  that a stopped monitor leaves at most a 1h hole in the data layer instead of days. */
export const PULSE_WINDOW_MS = 60 * 60 * 1000;

export interface PulseResult {
  /** 'filed' = the window was empty and a floor was filed; 'skipped' = nothing to do
   *  (flag off / no hive / a scorecard already in-window); 'error' = the pulse itself
   *  failed (recorded, never thrown). */
  outcome: 'filed' | 'skipped' | 'error';
  reason: string;
  /** WI-2977: set when this pulse coalesced onto a pre-existing OPEN pulse-floor
   *  issue (bumped its repeat counter) instead of filing a new one. */
  coalescedInto?: string;
}

/** The minimal shape the coalescing lookup needs off a matched issue. */
export interface OpenPulseFloor {
  id: string;
  payload: unknown;
}

/** Default lookup: the newest OPEN issue carrying this pulse's watchdogKey (the
 *  same indexed `findIssuesByWatchdogKeys` feed the improvement watchdog uses). */
async function defaultFindOpenPulseFloor(watchdogKey: string): Promise<OpenPulseFloor | null> {
  const matches = await findIssuesByWatchdogKeys([watchdogKey]);
  const open = matches.find((i) => i.state === 'open');
  return open ? { id: open.id, payload: open.payload } : null;
}

/** Default bump: stamp `payload.pulseRepeat` (replace-whole-object, mirrors
 *  known-open-aging's stamp convention) — never touches title/state/severity. */
async function defaultBumpPulseRepeat(id: string, priorCount: number, firstFiredAt: string | null): Promise<void> {
  const now = new Date().toISOString();
  const stamp: PulseRepeatStamp = {
    count: priorCount + 1,
    firstFiredAt: firstFiredAt ?? now,
    lastFiredAt: now,
  };
  await mergeIssuePayload(id, { pulseRepeat: stamp });
}

/** Record a "the data layer ran on the pulse floor" fire — countable in the shared
 *  watchdog-fires table under its own source so drill-back separates pulse floors
 *  from turn-end backstop floors. Best-effort; never throws. */
async function recordPulseFire(workspaceId: string, installSlug: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.pot_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (${workspaceId}, ${installSlug}, ${'scorecard-pulse'}, ${reason}, ${null}, ${'{}'}::text::jsonb)`;
  } catch (e) {
    console.warn(`[scorecard-emission-pulse] fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Dependency seam — defaults to the real impls; injectable so the whole pulse is
 *  unit-testable without PG / flags (same pattern as the turn-end backstop). */
export interface ScorecardEmissionPulseDeps {
  enabled?: () => Promise<boolean>;
  controlState?: (opts: { workspaceId?: string }) => Promise<{ potSlug: string | null }>;
  freshness?: typeof checkScorecardFreshness;
  computeHealth?: (workspaceId?: string) => Promise<SystemHealth>;
  capture?: typeof captureImprovement;
  recordFire?: (workspaceId: string, installSlug: string, reason: string) => Promise<void>;
  toolUtilizationGrade?: () => Promise<ScorecardRating | undefined>;
  /** WI-2977: find the standing OPEN pulse-floor issue for this hive (by watchdogKey),
   *  if one exists. Default queries the real indexed watchdogKey feed. */
  findOpenPulseFloor?: (watchdogKey: string) => Promise<OpenPulseFloor | null>;
  /** WI-2977: bump the coalesced-onto issue's repeat stamp instead of filing anew. */
  bumpPulseRepeat?: (id: string, priorCount: number, firstFiredAt: string | null) => Promise<void>;
}

/**
 * The pulse's OWN kill switch (D-015). Deliberately NOT `overwatchEnabled()`: this
 * floor backstops the overwatch agent, so gating it on that agent's flag deletes the
 * floor in precisely the state it exists for (supervisor stopped, dead, or retired).
 * Fail-CLOSED on an unreadable flag, matching `overwatchEnabled`'s convention — a
 * flag-store failure must not make a writer start filing issues unbidden; the
 * rubric-staleness watchdog is the detector for a pulse that stops.
 */
export async function scorecardEmissionPulseEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.SCORECARD_EMISSION_PULSE, 'system');
  } catch {
    return false;
  }
}

/**
 * One pulse pass for one workspace: if the `papercusp-scorecard-emission-pulse` flag
 * is on and NO scorecard (agent or synthesized) landed within {@link PULSE_WINDOW_MS},
 * synthesize the deterministic floor and file it. Neither the overwatch `started` bit
 * NOR the overwatch flag is consulted — emission must survive a stopped, dead or
 * RETIRED supervisor (D-015).
 */
export async function runScorecardEmissionPulse(
  opts: { workspaceId: string },
  deps: ScorecardEmissionPulseDeps = {},
): Promise<PulseResult> {
  const { workspaceId } = opts;
  const enabled = deps.enabled ?? scorecardEmissionPulseEnabled;
  const controlState = deps.controlState ?? getOverwatchControlState;
  const freshness = deps.freshness ?? checkScorecardFreshness;
  const computeHealth = deps.computeHealth ?? computeSystemHealth;
  const capture = deps.capture ?? captureImprovement;
  const recordFire = deps.recordFire ?? recordPulseFire;
  const toolUtilizationGrade = deps.toolUtilizationGrade ?? defaultToolUtilizationGrade;
  const findOpenPulseFloor = deps.findOpenPulseFloor ?? defaultFindOpenPulseFloor;
  const bumpPulseRepeat = deps.bumpPulseRepeat ?? defaultBumpPulseRepeat;
  try {
    if (!(await enabled()))
      return { outcome: 'skipped', reason: 'papercusp-scorecard-emission-pulse flag off' };

    const cs = await controlState({ workspaceId });
    const sourceHive = cs.potSlug;
    if (!sourceHive) return { outcome: 'skipped', reason: 'no hive configured for this workspace' };

    // ANY card in-window counts — agent, turn-end backstop floor, or a prior pulse
    // floor — so floors never stack and a live overwatch makes this a cheap no-op.
    const f = await freshness({
      rubricRef: COORDINATION_RUBRIC_REF,
      sourceHive,
      lookbackMs: PULSE_WINDOW_MS,
      includeSynthesized: true,
    });
    if (f.status === 'unknown-rubric') {
      return {
        outcome: 'skipped',
        reason: `scorecard rubric '${COORDINATION_RUBRIC_REF}' is unknown — do not synthesize a floor for an invalid reference`,
      };
    }
    if (f.emitted) {
      return { outcome: 'skipped', reason: `scorecard already in-window (${f.count}, newest ${f.lastEmittedAt})` };
    }

    // WI-2977: the freshness window (1h) only stops floors from stacking WITHIN an
    // outage's first hour — a multi-day stopped-supervisor outage still re-files a
    // brand-new open EI every tick once the previous floor ages out of that window.
    // Before filing, check whether the STANDING pulse-floor for this hive (by its
    // stable watchdogKey) is still open — if so this is the SAME outage continuing,
    // so bump its repeat counter instead of piling on another open dup.
    const watchdogKey = pulseWatchdogKey(sourceHive);
    const existingOpen = await findOpenPulseFloor(watchdogKey).catch((e) => {
      console.warn(`[scorecard-emission-pulse] findOpenPulseFloor failed (${watchdogKey}) — filing fresh: ${e instanceof Error ? e.message : e}`);
      return null;
    });
    // WI-10000010: the floor CARD is owed on EVERY empty-window tick — it IS the data
    // layer, so a floor that goes quiet during a long outage is the precise failure
    // this floor exists to prevent. WI-2977's coalescing early-returned HERE, ABOVE
    // the emit, because ONE engineer_issues row served two roles at once: the
    // scorecard observation AND the standing dedup anchor. Deduping the anchor
    // therefore silently deduped the card, and the trap is SELF-PERPETUATING — no
    // card lands, so the window stays empty, so the anchor stays open, forever.
    // Measured: EI-7857 (`scorecard-pulse:papercusp`) sat open from 2026-07-06 with
    // payload.pulseRepeat.count = 3550 — 3550 ticks that each reported
    // outcome:'filed' and emitted nothing, while `pot-coordination-health` went dark
    // for two months and every log line looked healthy.
    // Fix: keep exactly ONE anchor per outage, but ALWAYS emit. Only the outage's
    // first card carries the watchdogKey; later cards are pure observations, so the
    // anchor cannot fork while the time series stays alive.
    const health = await computeHealth(workspaceId);
    const toolUtil = await toolUtilizationGrade();
    const ratings = synthesizeCoordinationScorecard(health, toolUtil);
    await capture({
      title: 'pot-coordination-health scorecard (scheduled pulse floor)',
      kind: 'change',
      lane: 'observation',
      sourceRole: 'system',
      filedByRole: 'overwatch-watchdog',
      scope: `harness:${sourceHive}`,
      createdBy: 'system:scorecard-emission-pulse',
      payloadExtra: {
        // Anchor ONLY the first card of an outage — a second watchdogKey row would
        // recreate the duplicate-open-EI pile-up WI-2977 removed.
        ...(existingOpen ? {} : { watchdogKey }),
        observation: {
          kind: 'reinforce',
          scope: 'papercusp',
          sourceHive,
          rubricRef: COORDINATION_RUBRIC_REF,
          ratings,
          synthesized: true,
          synthSource: 'scheduled-pulse',
        },
      },
    });

    if (existingOpen) {
      const priorCount = readPulseRepeatCount(existingOpen.payload);
      const priorStamp = (existingOpen.payload as Record<string, unknown> | null)?.pulseRepeat as
        | { firstFiredAt?: string }
        | undefined;
      await bumpPulseRepeat(existingOpen.id, priorCount, priorStamp?.firstFiredAt ?? null);
      const reason = `no scorecard in ${Math.round(PULSE_WINDOW_MS / 60_000)}m — floor card emitted; coalesced onto standing open pulse floor ${existingOpen.id} (repeat ${priorCount + 1})`;
      await recordFire(workspaceId, sourceHive, reason);
      return { outcome: 'filed', reason, coalescedInto: existingOpen.id };
    }

    await recordFire(
      workspaceId,
      sourceHive,
      `no scorecard (agent or floor) in ${Math.round(PULSE_WINDOW_MS / 60_000)}m — scheduled pulse filed the deterministic floor`,
    );
    return { outcome: 'filed', reason: 'window empty; pulse floor filed' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[scorecard-emission-pulse] pulse failed (${workspaceId}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}

// ── WI-3777: the cadence-miss ESCALATION (the companion to the floor above) ──────
//
// The floor keeps the DATA layer alive when the supervisor STOPS — but a floor is
// not an alarm, and a wide-window `scorecards:freshness` read still says 'fresh'
// while a loop that is enabled+started silently STOPS emitting complete cards. That
// exact silent wedge cost hours on 2026-07-10 (overwatch launched last at 08:32Z,
// the one-shot never re-armed, freshness still read 'fresh' off the 08:35Z card).
//
// This adds the missing teeth: on the SAME in-process periodic seam (independent of
// the routinesTick pool-shed path that froze the loop), disambiguate the emission
// gap with the EXISTING `interpretOverwatchEmission` interpreter over a TIGHT window
// (2× the overwatch cadence) and — only for its ACTIONABLE verdicts (`loop-dead` /
// `agent-skipping`) — raise ONE debounced owner advisory. The benign verdicts
// (`overwatch-disabled` / `overwatch-not-started`) stay floor-only, never alarm.
//
// Debounce is FREE: `openEscalation` dedups on (dedupKind, subjectSignature), so a
// persisting wedge bumps a single open advisory's repeatCount instead of re-alerting
// each 10-min tick; advisory escalations also auto-expire after 7d. No new table.

/** Wedge-detection window as a multiple of the overwatch cadence. 2× mirrors the
 *  liveness STALE_CADENCE_MULTIPLE, so "loop went stale" and "no complete card"
 *  trip on the same threshold — one missed cycle is tolerable jitter, two is a wedge. */
export const WEDGE_STALE_CADENCE_MULTIPLE = 2;

/** dedupKind for the wedge advisory — one stable open row per (hive, verdict). */
const EMISSION_WEDGE_DEDUP_KIND = 'scorecard-emission-wedge';

/** Synthetic identity for the background wedge escalation (mirrors steering-churn). */
const EMISSION_WEDGE_IDENTITY: AgentIdentity = {
  ownerId: 'scorecard-emission-pulse',
  ownerLabel: 'system · scorecard-emission-pulse',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface EmissionWedgeEscalation {
  sourceHive: string;
  verdict: FreshnessVerdict;
  /** the interpreter's one-line WHY + what-to-do note. */
  note: string;
  lastRunAt: string | null;
  lastCompleteAt: string | null;
  windowMs: number;
  cadenceSec: number;
}

/** Escalation sink — injectable so the detector is testable without coord IO. */
export type EmissionWedgeEscalator = (input: EmissionWedgeEscalation) => Promise<void>;

/** Default escalator: a debounced `coord:escalate` advisory to the human (the same
 *  `openEscalation` path the tool handler uses; harness_slug FEDERATES it to the
 *  owner's inbox hub — WI-1375). The stable subjectSignature is the debounce key. */
const defaultEmissionWedgeEscalator: EmissionWedgeEscalator = async (input) => {
  const mins = Math.round(input.windowMs / 60_000);
  const subjectSignature = `${EMISSION_WEDGE_DEDUP_KIND}:${input.sourceHive}:${input.verdict}`;
  await openEscalation(EMISSION_WEDGE_IDENTITY, {
    severity: 'advisory',
    summary: `Kettle emission wedge: ${input.sourceHive} — ${input.verdict} (monitor-the-monitor silent)`,
    body:
      `${input.note}\n\n` +
      `Evidence: no COMPLETE ${COORDINATION_RUBRIC_REF} scorecard in the last ${mins}m ` +
      `(${WEDGE_STALE_CADENCE_MULTIPLE}× the ${input.cadenceSec}s overwatch cadence). ` +
      `Kettle loop lastRunAt=${input.lastRunAt ?? 'never'}; ` +
      `last complete card=${input.lastCompleteAt ?? 'none in-window'}.\n\n` +
      `This is the cadence-miss ESCALATION (WI-3777). The scorecard-emission-pulse FLOOR keeps the ` +
      `data layer alive when the supervisor stops, but a floor is not an alarm: a loop that is ` +
      `enabled + started yet not emitting complete cards is a SILENT WEDGE (as on 2026-07-10 08:32Z, ` +
      `when a wide-window freshness read still said 'fresh'). Investigate the overwatch launch chain ` +
      `(kettle:start / kettle:declare-wake, the [overwatch-loop] journal) and host load (pool-churn).`,
    harness_slug: input.sourceHive,
    meta: { dedupKind: EMISSION_WEDGE_DEDUP_KIND, subjectSignature },
  });
};

/** Record a "the wedge detector fired" signal into the shared watchdog-fires table
 *  under its own source, so a persisting wedge leaves a countable trail distinct
 *  from the pulse floor's `scorecard-pulse` fires. Best-effort; never throws. */
async function recordWedgeFire(workspaceId: string, installSlug: string, reason: string): Promise<void> {
  try {
    const { sql } = getOrgPg();
    await sql`
      INSERT INTO harness_shared.pot_watchdog_fires
        (workspace_id, install_slug, source, reason, wake_at, demand)
      VALUES (${workspaceId}, ${installSlug}, ${'scorecard-emission-wedge'}, ${reason}, ${null}, ${'{}'}::text::jsonb)`;
  } catch (e) {
    console.warn(`[scorecard-emission-pulse] wedge fire record failed: ${e instanceof Error ? e.message : e}`);
  }
}

/** Dependency seam — defaults to the real impls; injectable for hermetic tests. */
export interface OverwatchEmissionWedgeDeps {
  liveness?: typeof getOverwatchLiveness;
  freshness?: typeof checkScorecardFreshness;
  escalate?: EmissionWedgeEscalator;
  recordFire?: (workspaceId: string, installSlug: string, reason: string) => Promise<void>;
}

export interface EmissionWedgeResult {
  /** 'escalated' = an actionable wedge was found + a (deduped) advisory raised;
   *  'skipped' = benign / healthy / no hive; 'error' = the check itself failed
   *  (recorded, never thrown). */
  outcome: 'escalated' | 'skipped' | 'error';
  reason: string;
  /** the interpreter verdict, when one was computed. */
  verdict?: FreshnessVerdict;
}

/**
 * One wedge-check pass for one workspace: read the overwatch loop liveness, measure
 * COMPLETE-card freshness over a tight 2×-cadence window (synthesized floors are
 * NOT counted — they must never mask a wedge), disambiguate via
 * `interpretOverwatchEmission`, and escalate ONLY on an actionable verdict.
 *
 * Benign short-circuits (flag off / not started / no hive) never alarm — those are
 * the pulse floor's job. A `loop-dead` verdict with a NEVER-fired loop (lastRunAt
 * null ⇒ `ageMs` null) is the benign pre-first-fire window right after kettle:start,
 * NOT a wedge, so it is skipped; only a loop that WAS firing and went silent past the
 * window (the WI-3777 08:32Z signature) escalates. `agent-skipping` always has a
 * recent lastRunAt (that is why the loop reads alive), so it is unaffected.
 */
export async function checkOverwatchEmissionWedge(
  opts: { workspaceId: string },
  deps: OverwatchEmissionWedgeDeps = {},
): Promise<EmissionWedgeResult> {
  const { workspaceId } = opts;
  const liveness = deps.liveness ?? getOverwatchLiveness;
  const freshness = deps.freshness ?? checkScorecardFreshness;
  const escalate = deps.escalate ?? defaultEmissionWedgeEscalator;
  const recordFire = deps.recordFire ?? recordWedgeFire;
  try {
    const live = await liveness({ workspaceId });

    // Benign, expected emission gaps — the floor covers the data layer; never alarm.
    if (!live.flagEnabled) return { outcome: 'skipped', reason: 'overwatch disabled (flag off) — benign' };
    if (!live.started) return { outcome: 'skipped', reason: 'overwatch not started (pre-armed/paused) — benign' };
    const sourceHive = live.potSlug;
    if (!sourceHive) return { outcome: 'skipped', reason: 'no hive configured for this workspace' };

    const cadenceSec = live.cadenceSec > 0 ? live.cadenceSec : DEFAULT_OVERWATCH_CADENCE_SEC;
    const windowMs = cadenceSec * 1000 * WEDGE_STALE_CADENCE_MULTIPLE;

    // COMPLETE agent cards only (includeSynthesized:false) — a synthesized floor must
    // NOT mask a wedge, which is the whole point of alarming above the floor.
    const f = await freshness({
      rubricRef: COORDINATION_RUBRIC_REF,
      sourceHive,
      lookbackMs: windowMs,
      includeSynthesized: false,
    });

    const ctx: OverwatchEmissionContext = {
      flagEnabled: live.flagEnabled,
      started: live.started,
      loopAlive: live.alive,
      loopStale: live.stale,
      lastRunAt: live.lastRunAt,
      inFlight: live.inFlight,
    };
    const interp = interpretOverwatchEmission(f.status, ctx);
    if (!interp.actionable) {
      return { outcome: 'skipped', reason: `no wedge (${interp.verdict})`, verdict: interp.verdict };
    }

    // Startup-race guard: a never-fired loop right after kettle:start reads `loop-dead`
    // (enabled+started, no fire yet), but that is the benign pre-first-fire window, not
    // a wedge. Only escalate loop-dead once the loop HAS fired and gone silent past the
    // window (ageMs present ⇒ loopStale already means aged past 2× cadence).
    if (interp.verdict === 'loop-dead' && live.ageMs == null) {
      return {
        outcome: 'skipped',
        reason: 'loop never fired yet (pre-first-fire / not-armed) — not a wedge',
        verdict: interp.verdict,
      };
    }

    await escalate({
      sourceHive,
      verdict: interp.verdict,
      note: interp.note,
      lastRunAt: live.lastRunAt,
      lastCompleteAt: f.lastCompleteAt,
      windowMs,
      cadenceSec,
    });
    const reason = `emission wedge (${interp.verdict}) — no complete card in ${Math.round(
      windowMs / 60_000,
    )}m; escalated (deduped)`;
    await recordFire(workspaceId, sourceHive, reason);
    return { outcome: 'escalated', reason, verdict: interp.verdict };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[scorecard-emission-pulse] wedge check failed (${workspaceId}): ${msg}`);
    return { outcome: 'error', reason: msg };
  }
}
