/**
 * scheduler.ts — Scout P-008: the autonomous-tick composition (D-002/D-010,
 * "Scout proposes → the Queen gates → agents build → owner gets a report;
 * prompt-free with a judgment layer").
 *
 * `runScoutTick` is the thing a cron routine invokes (via the `system:scout-cycle`
 * action). It is NOT a blind cron — it gates on {@link shouldRunScoutCycle} (idle
 * capacity OR friction), then on the autoloop fire-gate (backoff/circuit), then
 * runs ONE budgeted cycle, persists the routed-idea provenance (P-013 ledger), and
 * refreshes lens outcomes. The cycle itself ({@link ScoutTickDeps.runCycle}, =
 * cb4b9's runScoutCycle) is INJECTED, so this composition is unit-tested with a
 * fake cycle (no LLM, no clock, no fleet) — the autonomy guarantees (cadence-gated,
 * budgeted, prompt-free) are all assertable, which is exactly what P-014 needs.
 *
 * The "Queen gate" is structural, not a separate persisted-triage record (per the
 * agreement with the verification lane): broad-scope proposals route to `plans:new`
 * DRAFT plans (owner/Queen-visible, NOT auto-active) — greenlight = promoting the
 * draft; testable→gym; concrete→improvements:capture. The prompt-free fire (no
 * ctx.askUser anywhere in the loop) is the autonomy; the cadence gate makes "fires
 * only when idle/friction" verifiable.
 */

import { resolveScoutBudget, type ScoutBudget } from './budget';
import {
  shouldRunScoutCycle,
  type ScoutCadenceOptions,
  type ScoutCadenceState,
  type ScoutCadenceVerdict,
} from './cadence';
import { recordRoutedIdea } from './routed-ledger';
import { refreshScoutOutcomes } from './routed-ledger';
import { readIdeaQueueStatus } from './routed-ledger';
import { recordScoutTick, readLastRanTickAtMs, type ScoutTickRecord } from './tick-ledger';
import {
  admissionDenialFrom,
  CAPACITY_CLASSIFIER_SCHEMA_VERSION,
  capacityFallbacksFrom,
  isCapacityError,
  type CapacityFallbackEvent,
} from './capacity-errors';
// Type-only: `@papercusp/coordination/core` is the pure envelope contract, so this
// import is erased at compile time and keeps this module's core free of the
// coord/PG runtime edge that readRevisionRequests lazy-imports (cf. operator-hindsight.ts).
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { scoutPoolAffirmativelyExhausted } from './capacity-probe';
import type { ScoutPoolSnapshot } from './capacity-probe';
import type { CreativeLens } from './types';
import type { RoutedRail } from './outcome-feedback';
import type { ScoutCyclePhase } from './cycle';
import { currentScoutCodeHash } from './scout-code-identity';

/** The provenance the scheduler persists per routed idea (subset of RecordRoutedIdeaInput). */
export interface ScoutRoutedRecord {
  ideaId: string;
  lens: CreativeLens;
  rail: RoutedRail;
  routedRef: string;
  title?: string;
  addressesPatternRefs?: string[];
  /**
   * The model spec that produced this idea (migration 947 / P-010). Set by the
   * producing cycle when it knows it; absent ⇒ the ledger row records NULL rather
   * than a guess. See {@link BuildScoutTickDepsOptions.modelSpec} for why this is
   * never defaulted from the configured model at write time.
   */
  modelSpec?: string;
  /** Sampling/config knobs for the producing call (migration 947 / P-010). */
  modelConfig?: Record<string, unknown>;
}

/**
 * WI-6338: run `write` (a `recordRoutedIdea` call, in production) for each routed
 * record with PER-RECORD error isolation.
 *
 * `persistRouted` (the {@link buildScoutTickDeps} production wiring below) runs
 * AFTER the cycle already captured the underlying issues — `payload.sourceRole`
 * and the `improvement-source:Scout` topic are set atomically together inside
 * `captureImprovement` (capture-core.ts). Before this helper, an unguarded loop
 * over `records` meant ONE record's `recordRoutedIdea` insert throwing aborted the
 * whole `for` loop, silently dropping the `scout_routed_ideas` row for it AND
 * every remaining record in the same cycle — while their issues stayed
 * captured+tagged. That is exactly the "tagged Scout-source but no routed-ideas
 * row" divergence class the provenance-divergence health leg
 * (`system-health/compute.ts` `collectScout` → `ScoutHealth.provenanceDivergence`)
 * now measures. Isolating per record means one bad write can't starve its
 * siblings; a failure is reported via `onError` (production: `console.error`) but
 * never aborts the batch. Exported + unit-tested directly (no PG needed — `write`
 * is injected) since `persistRouted` itself closes over the real `recordRoutedIdea`
 * and can't be exercised without a live database.
 */
export async function persistRoutedRecordsIsolated(
  records: readonly ScoutRoutedRecord[],
  write: (record: ScoutRoutedRecord) => Promise<void>,
  onError: (record: ScoutRoutedRecord, error: unknown) => void = () => {},
): Promise<void> {
  for (const r of records) {
    try {
      await write(r);
    } catch (e) {
      onError(r, e);
    }
  }
}

/**
 * Minimal structural view of cb4b9's `ScoutCycleResult` — the scheduler only needs
 * the per-idea lens `provenance` (+ optional spend). cb4b9's full `ScoutCycleResult`
 * (which carries `provenance: ScoutRoutedIdea[]` + `costUsd`) satisfies this
 * directly, so `runScoutCycle` can be injected as `runCycle` with no field
 * remapping — just a thin limits/cycleId binding.
 */
export interface ScoutCycleLike {
  /** Per-idea lens provenance the cycle derived (cb4b9's ScoutCycleResult.provenance). */
  provenance: ScoutRoutedRecord[];
  costUsd?: number;
  /** Ideas the ideators produced (ScoutCycleResult.ideas) — tick observability (P-034). */
  ideas?: readonly unknown[];
  /** Every idea after the critics (ScoutCycleResult.scored). */
  scored?: readonly unknown[];
  /**
   * Every routing decision, including failed/skipped decisions without a
   * routedRef. Persisted with the stage artifacts for lossless reconciliation.
   */
  routed?: readonly unknown[];
  /** keep + moonshot after the critics (ScoutCycleResult.survivors) — deduped = scored − survivors. */
  survivors?: readonly unknown[];
  /** Debate/recombine fusions (ScoutCycleResult.proposals) — persisted per cycle for the Analyze stage (P-009). */
  proposals?: readonly unknown[];
  /** Why the cycle ended (ScoutCycleResult.stop). */
  stop?: string;
  /**
   * EI-13119: per-ideator slot outcomes, persisted on the 'ran' tick detail so a
   * no-ideas streak is ledger-diagnosable — ok:true raw:0 (model empty) vs ok:true
   * raw>0 produced:0 (grounding/shape filter drops) vs ok:false (spec/transport) —
   * instead of requiring a live re-probe of the LLM path (the 07-14..16 outage class).
   */
  ideators?: readonly { lens: string; ok: boolean; raw: number; produced: number; error?: string; textHead?: string; textLen?: number; outputTokens?: number }[];
  /**
   * WI-5391 item 3: cross-provider fallback attempts the runner made after attested
   * Claude-pool capacity denials (one retry each on the Codex bridge). Persisted on the
   * tick detail as DISCRIMINATOR evidence — a `succeeded:true` event proves the cycle had
   * cross-provider room when the Claude pool said no. On a THROWING cycle the runner
   * attaches the same array to the thrown error instead (see capacityFallbacksFrom).
   */
  capacityFallbacks?: readonly CapacityFallbackEvent[];
  /**
   * P-007 dedup-burn guard (WI-39479): present when the runner's pre-cycle ledger
   * read found consecutive saturated cycles and re-shaped this cycle (widened
   * novelty band + fresh-signal-only digest). Persisted on the ran-tick detail so
   * guard activations are ledger-diagnosable next to the ratios that caused them.
   */
  dedupBurn?: {
    saturated: boolean;
    consecutiveSaturated: number;
    lastRatio: number;
    wideningSteps: number;
    reason: string;
  };
}

/**
 * One pending steward/reviewer→Scout revision request. The scheduler reads these
 * at cycle-start from coord:inbox addressed to `scout:<hive>`
 * ({@link ScoutTickDeps.readRevisionRequests}); each is a directed coord message
 * carrying the routed draft's `plan_slug` + revision guidance in `body`. Their
 * presence fires the cycle out-of-cadence (`revision-request`)
 * and is threaded into the cycle so it runs a TARGETED revision on those drafts.
 */
export interface ScoutRevisionRequest {
  /** The routed DRAFT plan slug the reviewer is giving feedback on. */
  planSlug: string;
  /** The reviewer's guidance text (the coord message body). */
  body: string;
  /** The reviewer's coord owner id (the message sender) — the ping-back recipient. */
  fromOwnerId: string;
  /** The coord msg_id (acked after the revision so it is consumed exactly once). */
  msgId: string;
  /** ISO timestamp the reviewer sent it (ordering / observability). */
  ts: string;
}

export interface ScoutFireGate {
  allow: boolean;
  reason?: string;
  retryAfterSec?: number;
}

export interface ScoutTickDeps {
  /** Read live cadence signals (idle ratio, friction count, last-run epoch ms). */
  readCadenceState: () => Promise<ScoutCadenceState>;
  /** Run one Scout cycle under the resolved budget (cb4b9's runScoutCycle, adapted).
   *  When `revisionRequests` is present (the cycle-start coord:inbox read found
   *  plan-keyed reviewer feedback) the runner targets a REVISION of those draft
   *  plans instead of fresh ideation; otherwise it ideates as usual. */
  runCycle: (ctx: {
    budget: Required<ScoutBudget>;
    cycleId: string;
    revisionRequests?: ScoutRevisionRequest[];
    signal?: AbortSignal;
    /** WI-4475 — absolute epoch-ms deadline this cycle will be killed at, so the runner can
     *  bound each LLM call's governor ADMISSION wait by the time actually remaining (a
     *  `signal` only says "out of time" AFTER the fact). Mirrors `ScoutCycleRunner`. */
    deadlineMs?: number;
    onPhase?: (phase: ScoutCyclePhase) => void;
  }) => Promise<ScoutCycleLike>;
  /** Persist routed-idea provenance for the cycle (P-013 ledger). */
  persistRouted: (records: ScoutRoutedRecord[], cycleId: string) => Promise<void>;
  /**
   * Optional per-stage cycle-artifact persist (learning-tab-visibility P-009):
   * land the fired cycle's INTERMEDIATE stage arrays (per-ideator ideas,
   * critique verdicts, debate/recombine fusions, ideator slot outcomes) on
   * harness_shared.scout_cycle_stage_artifacts for the Learning tab's Analyze
   * stage. Best-effort by contract — runScoutTick swallows its errors (Analyze
   * observability never fails the tick); unwired ⇒ no artifact persistence
   * (the hermetic unit-test default).
   */
  persistStageArtifacts?: (cycle: ScoutCycleLike, cycleId: string) => Promise<void>;
  /** Optional autoloop fire-gate (backoff/circuit); default: always allow. */
  fireGate?: () => Promise<ScoutFireGate>;
  /** Optional fire-state recorder (autoloop recordFire). */
  recordFire?: (outcome: 'attempt' | 'ok' | 'error') => Promise<void>;
  /**
   * Optional single-flight claim (EI-304): atomically claim the fire slot
   * given the lastRunAtMs this tick READ. Returns false when a concurrent
   * tick (any process) already claimed since the read — the loser skips.
   */
  claimFire?: (expectedLastFiredAtMs: number | null) => Promise<boolean>;
  /** Optional: recompute + persist lens outcomes after the cycle (P-013). */
  refreshOutcomes?: () => Promise<void>;
  /**
   * Optional tick recorder (P-034 observability — `harness_shared.scout_ticks`).
   * Best-effort: runScoutTick swallows its errors, so recording never fails a tick.
   */
  recordTick?: (rec: ScoutTickRecord) => Promise<void>;
  /**
   * Read pending steward/reviewer→Scout revision requests at cycle-start — directed
   * coord:inbox messages addressed to `scout:<hive>` carrying a plan_slug. Best-effort by contract: runScoutTick
   * swallows its errors (a coord read must never fail a tick), and an unwired dep ⇒ the
   * feedback loop is dormant (the hermetic unit-test default). When it returns items the
   * tick fires `revision-request` out-of-cadence and threads them into {@link runCycle}.
   */
  readRevisionRequests?: () => Promise<ScoutRevisionRequest[]>;
  /**
   * Acknowledge consumed revision requests after a SUCCESSFUL revision cycle so
   * the same message is not re-processed on the next tick (exactly-once). Best-effort —
   * an ack failure never fails the tick (the message simply re-fires next tick).
   */
  ackRevisionRequests?: (items: ScoutRevisionRequest[]) => Promise<void>;
  /** Mint a cycle id; default `scout-<nowMs>`. */
  newCycleId?: (nowMs: number) => string;
  /**
   * Read the gateway pool snapshot. Called at TWO distinct instants for two distinct
   * questions — see WI-5436 for why conflating them would be a regression:
   *
   * 1. CYCLE-TOP (every fired tick) → `poolSnapshotAtFire` in detail. "What did the
   *    pool look like when this cycle was allowed to start?" — the failover-vs-exhaustion
   *    discriminator (WI-4475). Recorded on ran/gated/error alike.
   * 2. FAILURE-RECORD TIME (gateway-attested `via:'http-429'` denials only, WI-5391
   *    Part B) → `poolSnapshot` in detail. A 429 recorded while the gateway's OWN
   *    `/stats` reports healthy accounts is the WI-4541 admission-defect signature and
   *    stays a LOUD error (`capacityContradicted:true`).
   *
   * Best-effort by contract at both instants — a probe failure or an unwired dep (the
   * hermetic unit-test default) simply omits that key from detail; it never fails the
   * tick and never manufactures contradiction evidence.
   */
  readPoolSnapshot?: () => Promise<ScoutPoolSnapshot | undefined>;
}

export interface ScoutTickOptions {
  cadence?: ScoutCadenceOptions;
  budget?: ScoutBudget;
  /**
   * Hard wall-clock bound for the budgeted Scout cycle body. The DBOS routineFire
   * deadline is much longer than Scout's cadence; a hung LLM/gateway call must
   * record an error tick and release the routine dedup before that outer deadline.
   */
  cycleTimeoutMs?: number;
}

export interface ScoutTickResult {
  fired: boolean;
  /**
   * Cadence reason when fired/withheld, or a structural-gate refusal:
   * 'circuit' / 'claim-lost' / 'cycle-error', 'workspace-ceiling' (P-051 — the
   * workspace-wide scout spend ceiling refused this cycle BEFORE the tick),
   * 'not-hive-runner' (P-019 — a SHARED-Hive node that is NOT the elected per-Hive
   * single runner stood down so only ONE node's scout loop fires across the Hive), or
   * 'no-capacity' (WI-4475 — the account pool had no headroom: a GATE, not a failure, so
   * it is counted in its own SCOUT_TICK_GATES bucket instead of inflating the error rate).
   */
  reason:
    | ScoutCadenceVerdict['reason']
    | 'circuit'
    | 'claim-lost'
    | 'cycle-error'
    | 'workspace-ceiling'
    | 'not-hive-runner'
    | 'no-capacity'
    /** 'pot-disabled' (learning-pot-scope-gate-2026-08-30 D-001): the POT this
     *  install learns for is switched off at the per-pot master gate. Scout had
     *  no preflight refusal of its own before this — its only gate was the
     *  routine's `active` flag — so this ADDS a refusal rather than passing a
     *  parameter to an existing one. */
    | 'pot-disabled';
  cycleId?: string;
  routedCount?: number;
  /** The fired cycle's reported LLM spend (cycle.costUsd) — FB-01 learning-governor ledgering. */
  costUsd?: number;
  retryAfterSec?: number;
  error?: string;
}

/**
 * One autonomous Scout tick: cadence-gate → fire-gate → budgeted cycle → persist
 * provenance → refresh outcomes. Returns a compact result for the routine log.
 * Pure over the injected deps (no IO of its own). Every exit also records one
 * `scout_ticks` row via the optional `recordTick` dep (P-034): which self-gate
 * withheld a no-op tick, or the generated/routed/deduped counts + spend of a
 * full cycle — best-effort (a recording failure never fails the tick).
 */
export async function runScoutTick(deps: ScoutTickDeps, opts: ScoutTickOptions = {}): Promise<ScoutTickResult> {
  // P-034 observability: one durable row per tick, naming the self-gate that
  // stopped a no-op or the counts of a full cycle. Best-effort by contract —
  // a recording failure must never fail the tick itself.
  const note = async (rec: ScoutTickRecord): Promise<void> => {
    try {
      await deps.recordTick?.(rec);
    } catch {
      /* best-effort — observability never fails the tick */
    }
  };

  // Read pending steward/reviewer→Scout revision requests (coord:inbox → scout:<hive>)
  // BEFORE the cadence gate. Best-effort by contract — a coord read must never fail
  // a tick (an error / unwired dep ⇒ no feedback, the loop is simply dormant). When
  // present they fire the cycle OUT-OF-CADENCE (revision-request) past the floor and are
  // threaded into runCycle so it targets a revision of those drafts (P-002 / D-001).
  let revisionRequests: ScoutRevisionRequest[] = [];
  if (deps.readRevisionRequests) {
    try {
      revisionRequests = (await deps.readRevisionRequests()) ?? [];
    } catch {
      /* best-effort — a coord read never fails the tick */
    }
  }

  const baseState = await deps.readCadenceState();
  // Overlay the revision-request signal onto the cadence state (readCadenceState owns
  // the fleet/ledger signals; the revision channel is the scheduler's, so the
  // flag is merged here rather than coupling the cadence reader to coord).
  const state: ScoutCadenceState = revisionRequests.length > 0 ? { ...baseState, revisionRequestPending: true } : baseState;
  const verdict = shouldRunScoutCycle(state, opts.cadence);
  if (!verdict.fire) {
    await note({
      status: 'gated',
      gate: verdict.reason,
      ...(verdict.retryAfterSec != null ? { detail: { retryAfterSec: verdict.retryAfterSec } } : {}),
    });
    return { fired: false, reason: verdict.reason, retryAfterSec: verdict.retryAfterSec };
  }

  if (deps.fireGate) {
    const gate = await deps.fireGate();
    if (!gate.allow) {
      await note({
        status: 'gated',
        gate: 'circuit',
        detail: {
          ...(gate.reason ? { reason: gate.reason } : {}),
          ...(gate.retryAfterSec != null ? { retryAfterSec: gate.retryAfterSec } : {}),
        },
      });
      return { fired: false, reason: 'circuit', retryAfterSec: gate.retryAfterSec };
    }
  }

  // EI-304 single-flight: everything above is check-then-act — two overlapping
  // ticks both snapshot stale cadence state and both pass the floor. The claim
  // is the one atomic step that collapses them to a single cycle; the loser
  // exits as a gated no-op.
  if (deps.claimFire) {
    // EI-1600: the single-flight claim CAS's against the autoloop FIRE-SLOT clock
    // (autoloop_state.last_fired_at), which is NOT the cadence clock (lastRunAtMs =
    // last RUN). Use fireSlotLastMs when the production wiring supplies it; fall
    // back to lastRunAtMs for the unit-test fakes that model a single shared clock.
    const claimExpected = state.fireSlotLastMs !== undefined ? state.fireSlotLastMs : state.lastRunAtMs;
    const claimed = await deps.claimFire(claimExpected ?? null);
    if (!claimed) {
      await note({ status: 'gated', gate: 'claim-lost' });
      return { fired: false, reason: 'claim-lost' };
    }
  }

  const budget = resolveScoutBudget(opts.budget);
  const cycleId = (deps.newCycleId ?? ((n) => `scout-${n}`))(state.nowMs);
  let activePhase: ScoutCyclePhase | undefined;
  // WI-5436: snapshot the pool HERE — cycle-top, before the cycle can consume or
  // exhaust it — and stamp it on whichever tick this becomes (ran/gated/error alike).
  // A caller-applied stamp is structurally ABSENT on every path that denies or throws
  // before reaching the caller, which is exactly the set of ticks the failover question
  // needs: the observed governor denial (2026-07-19T01:09:56Z, via:'governor',
  // reason:'all-accounts-paused' — the pre-WI-5435 spelling of 'rate-limit-blocked', quoted
  // as the row actually reads — with pausedAccounts:1 of totalAccounts:2) carried NO
  // pool key at all, so healthyAccounts — the one field that separates "failover didn't
  // use a healthy account" from "the pool really was empty" — was unobservable on the
  // ticks the 0.0.11-alpha error-rate bar is judging.
  //
  // Deliberately NOT reused for `capacityContradicted` below: that check (WI-5391 Part B)
  // compares a gateway 429 against the gateway's stats AT RECORD TIME, and a cycle-top
  // reading can be up to a full cycle stale (600s) — healthy at fire, legitimately
  // exhausted by failure. Feeding this snapshot into that comparison would manufacture
  // false contradictions and corrupt the exclusion audit. Two instants, two questions,
  // two keys.
  let poolSnapshotAtFire: ScoutPoolSnapshot | undefined;
  try {
    poolSnapshotAtFire = await deps.readPoolSnapshot?.();
  } catch {
    /* best-effort — the discriminator is evidence, never a precondition for the cycle */
  }
  // P-016 (blender-su-grade-integration-2026-08-11, D-020): the POOL PRECHECK.
  //
  // Cross-account failover already ships, so the residual gap was never "add failover" —
  // it is that an EXHAUSTED pool was discovered only by ATTEMPTING and degrading. Those
  // attempts clear admission, then stall downstream and time out at the full cycle budget
  // (600s), landing as `error` ticks that read like a producer defect. Refuse early and
  // loudly instead, so an exhausted pool reads as what it is: a capacity gate.
  //
  // THE TRISTATE IS LOAD-BEARING (capacity-probe.ts's whole point). Only an AFFIRMATIVE
  // reading gates: no snapshot, or a snapshot missing the fields, leaves `routable`
  // undefined and the cycle runs exactly as before. An unreadable gateway must never be
  // able to silence Scout — that would convert a probe outage into a total production
  // stop, which is strictly worse than the degradation this replaces.
  //
  // BOTH routes must be out. Scout falls back to codex when Claude is walled
  // (`resolveScoutModel` → SCOUT_CODEX_FALLBACK_MODEL), so gating on Claude alone would
  // refuse cycles that codex could have served — the live shape right now, with the
  // claude pool walled and the codex bridge up.
  //
  // Placed AFTER the single-flight claim on purpose: the refusal then advances the fire
  // slot like any other outcome, so a walled pool produces one gated tick per cadence
  // interval rather than a hot probe loop.
  if (poolSnapshotAtFire && scoutPoolAffirmativelyExhausted(poolSnapshotAtFire)) {
    await note({
      status: 'gated',
      gate: 'no-capacity',
      detail: {
        reason: 'pool-exhausted-precheck',
        precheck: true,
        ...(poolSnapshotAtFire ? { poolSnapshotAtFire } : {}),
      },
    });
    return { fired: false, reason: 'no-capacity' };
  }

  await deps.recordFire?.('attempt');
  try {
    // WI-4475: resolve the cycle budget ONCE and hand the runner the absolute DEADLINE it will
    // be killed at — not just an abort signal that fires after the fact. Every LLM call inside
    // the cycle then bounds its governor ADMISSION wait by the time actually left, so an inner
    // wait can no longer equal the whole cycle budget (the 600s inner default == the 600s
    // @singleton cycle cap) and eat it, which is what produced "Scout cycle timed out after
    // 600000ms during phase route|critique|recombine".
    const cycleTimeoutMs = opts.cycleTimeoutMs ?? scoutCycleTimeoutMs();
    const deadlineMs = Date.now() + cycleTimeoutMs;
    const cycle = await withScoutCycleTimeout(
      (signal) =>
        deps.runCycle({
          budget,
          cycleId,
          ...(revisionRequests.length > 0 ? { revisionRequests } : {}),
          signal,
          deadlineMs,
          onPhase: (phase) => {
            activePhase = phase;
          },
        }),
      cycleTimeoutMs,
      () => activePhase,
    );
    const provenance = cycle.provenance ?? [];
    if (provenance.length > 0) await deps.persistRouted(provenance, cycleId);
    // P-009 (learning-tab-visibility): land the cycle's INTERMEDIATE stage
    // artifacts (per-ideator ideas, critique verdicts, fusions, slot outcomes)
    // so the Analyze view can show the pipeline, not just its routed tail.
    if (deps.persistStageArtifacts) {
      try {
        await deps.persistStageArtifacts(cycle, cycleId);
      } catch {
        /* best-effort — Analyze observability never fails the tick */
      }
    }
    const groundingLanes = groundingLaneHistogram(provenance);
    await deps.refreshOutcomes?.();
    // A revision-request cycle SUCCEEDED — ack the consumed messages
    // so the same feedback is not re-processed next tick (exactly-once). Best-effort:
    // an ack failure simply leaves the message to re-fire, it never fails the tick.
    if (revisionRequests.length > 0 && deps.ackRevisionRequests) {
      try {
        await deps.ackRevisionRequests(revisionRequests);
      } catch {
        /* best-effort — re-fires next tick rather than failing this one */
      }
    }
    await deps.recordFire?.('ok');
    await note({
      status: 'ran',
      ideasGenerated: cycle.ideas?.length ?? 0,
      ideasRouted: provenance.length,
      ideasDeduped: cycle.scored && cycle.survivors ? Math.max(0, cycle.scored.length - cycle.survivors.length) : 0,
      ...(cycle.costUsd != null ? { budgetUsedUsd: cycle.costUsd } : {}),
      detail: {
        cycleId,
        reason: verdict.reason,
        ...(cycle.stop ? { stop: cycle.stop } : {}),
        ...(revisionRequests.length > 0 ? { revisionRequestCount: revisionRequests.length } : {}),
        // P-006 (blender-self-learning-2026-07-12): per-lane grounding histogram
        // over this cycle's routed refs — the durable, queryable evidence of
        // WHICH digest lanes actually generate routed ideas (the rubric lane
        // was silently at zero for its whole life until the P-004 seeding).
        ...(Object.keys(groundingLanes).length > 0 ? { groundingLanes } : {}),
        // P-015 (blender-self-learning-2026-07-12): the volume-mode signal score
        // THIS cycle fired on. The cadence gate already computes it (state.signalScore,
        // WI-4318) and vetoes a fire at score<=0 ('no-signal'), but it was never
        // PERSISTED — so the program's own success bar ("zero score-0 cycles fired")
        // was unmeasurable after the fact: nothing on the ledger said what the score
        // WAS at fire time. Recording it makes the bar checkable on real rows
        // (evaluateProgramSuccess/zero-signal-cycles) instead of inferred from the
        // absence of a gate. Undefined in legacy (non-volume) mode — an absent key
        // means "volume mode was not engaged", never "the score was 0".
        ...(typeof state.signalScore === 'number' && Number.isFinite(state.signalScore)
          ? { signalScore: state.signalScore }
          : {}),
        // EI-13119: per-ideator slot outcomes — see ScoutCycleLike.ideators.
        ...(cycle.ideators && cycle.ideators.length > 0 ? { ideators: cycle.ideators } : {}),
        // WI-5391 item 3: cross-provider fallback trail — see ScoutCycleLike.capacityFallbacks.
        ...(cycle.capacityFallbacks && cycle.capacityFallbacks.length > 0
          ? { capacityFallbacks: cycle.capacityFallbacks }
          : {}),
        // P-007 dedup-burn guard activation — see ScoutCycleLike.dedupBurn.
        ...(cycle.dedupBurn ? { dedupBurn: cycle.dedupBurn } : {}),
        // WI-5436: the pool baseline for a SUCCESSFUL cycle — without it a gated tick's
        // healthyAccounts has nothing to be compared against.
        ...(poolSnapshotAtFire ? { poolSnapshotAtFire } : {}),
      },
    });
    return {
      fired: true,
      reason: verdict.reason,
      cycleId,
      routedCount: provenance.length,
      ...(cycle.costUsd != null ? { costUsd: cycle.costUsd } : {}),
    };
  } catch (e) {
    // recordFire('error') is DELIBERATELY unconditional, including for a capacity miss: the
    // autoloop circuit-breaker's job is to stop hammering a pool that has nothing to give,
    // and backing off an exhausted pool is correct. What changes below is only how the tick
    // is CLASSIFIED on the ledger — the backoff behavior is untouched.
    await deps.recordFire?.('error');
    const error = e instanceof Error ? e.message : String(e);
    const timeoutDetail =
      e instanceof ScoutCycleTimeoutError
        ? {
            timeoutMs: e.timeoutMs,
            elapsedMs: e.elapsedMs,
            phase: e.phase ?? 'unknown',
          }
        : {};
    // A cycle that could not get LLM CAPACITY did not FAIL — it was withheld by a resource
    // ceiling, exactly like the 'circuit' / 'min-interval' / 'no-signal' gates. Recording it
    // as status:'error' was a CLASSIFICATION bug with two live consequences (measured
    // 2026-07-12, blender-self-learning P-015): (1) it pinned the cycle error rate at ~30%
    // — 31 of 60 recent error ticks were rate-limit waits — so the program's "<5% error
    // rate" health bar was really measuring POOL BUSY-NESS, not breakage; (2) it false-pages
    // the Mug, because error-streak-alarm.ts fires when the newest 3 ticks are ALL 'error',
    // and a busy pool trivially produces 3 in a row. A false alarm is a bug in the alarm.
    //
    // This HIDES nothing: the gate is counted in its own SCOUT_TICK_GATES bucket (pool
    // pressure becomes MORE visible, with its own number), and the provider's message is
    // preserved verbatim in `error`. Genuine failures — transport death, 401s, timeouts —
    // stay status:'error', which is what the <5% bar should have been measuring all along.
    const admissionDenial = admissionDenialFrom(e);
    // WI-5391 item 3: a throwing cycle can't return its fallback trail, so the runner
    // attaches it to the thrown error — persist it on whichever tick this becomes.
    const capacityFallbacks: CapacityFallbackEvent[] | undefined = capacityFallbacksFrom(e);
    if (isCapacityError(e)) {
      // WI-5391 Part B record-time discrimination: a gateway-attested denial
      // (via:'http-429') is cross-checked against the gateway's OWN pool stats before
      // it may be excluded from the error rate — the gateway can itself be the broken
      // component (WI-4541 serialized the whole fleet through one admission slot with
      // 9-10 of 12 accounts idle), and its 429 while /stats reports healthy accounts
      // is that defect's signature, not capacity. Governor-attested denials are NOT
      // cross-checked: the governor's wall is its own pool's authoritative state (the
      // direct-egress path), and gateway stats describe a different pool. The snapshot
      // is persisted either way so every exclusion is retro-auditable.
      let poolSnapshot: ScoutPoolSnapshot | undefined;
      if (admissionDenial?.via === 'http-429') {
        try {
          poolSnapshot = await deps.readPoolSnapshot?.();
        } catch {
          /* best-effort — no snapshot ⇒ no contradiction evidence, trust the attestation */
        }
      }
      const capacityContradicted =
        admissionDenial?.via === 'http-429' &&
        typeof poolSnapshot?.healthyAccounts === 'number' &&
        poolSnapshot.healthyAccounts > 0;
      if (!capacityContradicted) {
        await note({
          status: 'gated',
          gate: 'no-capacity',
          detail: {
            cycleId,
            error,
            capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
            ...(admissionDenial ? { admissionDenial } : {}),
            ...(poolSnapshot ? { poolSnapshot } : {}),
            // WI-5436: THE discriminator tick. via:'governor' never reaches the
            // record-time read above, so this cycle-top snapshot is the only place
            // healthyAccounts is observable for a governor-attested denial.
            ...(poolSnapshotAtFire ? { poolSnapshotAtFire } : {}),
            ...(capacityFallbacks ? { capacityFallbacks } : {}),
            ...timeoutDetail,
          },
        });
        return { fired: false, reason: 'no-capacity', cycleId, error };
      }
      await note({
        status: 'error',
        detail: {
          cycleId,
          error,
          capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
          ...(admissionDenial ? { admissionDenial } : {}),
          capacityContradicted: true,
          ...(poolSnapshot ? { poolSnapshot } : {}),
          ...(poolSnapshotAtFire ? { poolSnapshotAtFire } : {}),
          ...(capacityFallbacks ? { capacityFallbacks } : {}),
          ...timeoutDetail,
        },
      });
      return { fired: false, reason: 'cycle-error', cycleId, error };
    }
    await note({
      status: 'error',
      detail: {
        cycleId,
        error,
        capacityClassifierVersion: CAPACITY_CLASSIFIER_SCHEMA_VERSION,
        ...(admissionDenial ? { admissionDenial } : {}),
        ...(poolSnapshotAtFire ? { poolSnapshotAtFire } : {}),
        ...(capacityFallbacks ? { capacityFallbacks } : {}),
        ...timeoutDetail,
      },
    });
    return { fired: false, reason: 'cycle-error', cycleId, error };
  }
}

// The pure capacity-vs-genuine-failure classifier moved to ./capacity-errors so the
// READ path (quality-metrics.ts) can reuse the EXACT same notion when re-classifying
// historical error ticks — one classifier, two consumers (WI-4475). Re-exported here
// because scheduler.isCapacityError is the established import site + test surface.
export { isCapacityError };

/**
 * PURE (blender-self-learning-2026-07-12 P-006): per-lane grounding histogram
 * over a cycle's routed provenance refs, by the stable ref-prefix each lane
 * stamps (`rubric:` / `fact:` / `niche:`; everything else is the free-text
 * corpus lanes). Recorded on the tick detail so "which lanes generate ideas"
 * is a SQL query over scout_ticks, not an archaeology project.
 */
export function groundingLaneHistogram(
  records: readonly { addressesPatternRefs?: readonly string[] }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) {
    for (const ref of r.addressesPatternRefs ?? []) {
      const lane = ref.startsWith('rubric:')
        ? 'rubric-rating'
        : ref.startsWith('fact:')
          ? 'standing-fact'
          : ref.startsWith('niche:')
            ? 'niche-map'
            : ref.startsWith('spend:')
              ? 'spend-anomaly'
              : ref.startsWith('owner-correction:')
                ? 'owner-correction'
                : ref.startsWith('knowledge:')
                  ? 'knowledge-reuse-gap'
                  : ref.startsWith('plan-health:')
                    ? 'plan-health'
                    : 'corpus';
      out[lane] = (out[lane] ?? 0) + 1;
    }
  }
  return out;
}

export const DEFAULT_SCOUT_CYCLE_TIMEOUT_MS = 20 * 60_000;

function scoutCycleTimeoutMs(): number {
  const raw = Number(process.env.PAPERCUSP_SCOUT_CYCLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SCOUT_CYCLE_TIMEOUT_MS;
}

class ScoutCycleTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    readonly phase?: ScoutCyclePhase,
  ) {
    super(`Scout cycle timed out after ${timeoutMs}ms during phase ${phase ?? 'unknown'}`);
    this.name = 'ScoutCycleTimeoutError';
  }
}

async function withScoutCycleTimeout<T>(
  run: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
  phase: () => ScoutCyclePhase | undefined = () => undefined,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run();
  const ctrl = new AbortController();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      run(ctrl.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new ScoutCycleTimeoutError(timeoutMs, Date.now() - startedAt, phase()));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── production wiring ─────────────────────────────────────────────────────────

/** The autoloop role key for Scout-cycle fire-state (backoff/circuit + last-run). */
export const SCOUT_CYCLE_ROLE = 'scout-cycle';

/** Max revision-request messages a single tick processes — a safety bound so a
 *  backlog can't fan out one giant revision tick; the remainder re-fire next tick. */
export const MAX_REVISION_REQUESTS_PER_TICK = 20;

export interface BuildScoutTickDepsOptions {
  harnessSlug: string;
  /** cb4b9's runScoutCycle, adapted to the budgeted-cycle shape. */
  runCycle: ScoutTickDeps['runCycle'];
  /** Fleet idle ratio in [0,1] (1 = idle). Injected so the scheduler stays decoupled from fleet internals. */
  readIdleRatio: () => Promise<number>;
  /** Recent unaddressed friction-signal count (e.g. open idea-queue backlog / watchdog signals). */
  readFrictionSignals: () => Promise<number>;
  workspaceId?: string;
  /**
   * The ideator model spec this tick is configured to run (migration 947 /
   * learning-loop-backlog-triage-2026-08-22 P-010) — the `"<model-id>:<effort>"`
   * form, e.g. `'gpt-5.6-sol:xhigh'`. Stamped onto every routed row this tick
   * persists, unless the record itself carries a more specific one.
   *
   * ⚠ MUST be the value the caller RESOLVED for this tick, not a re-read of
   * `DEFAULT_SCOUT_MODELS.ideator`. Reading the constant here would look identical
   * today and become a fabricated attribution the day the default changes: rows
   * would be stamped with a model that never ran. The whole reason this column
   * exists is that the audit in P-010's plan could not answer "which model wrote
   * this?" — replacing "unknown" with "confidently wrong" is a worse outcome than
   * the gap it closes.
   *
   * Omitted ⇒ routed rows record NULL. That is a correct, permanent answer for any
   * producer that genuinely does not know its model.
   */
  modelSpec?: string;
  /** Sampling/config knobs for this tick's ideator calls (migration 947 / P-010). */
  modelConfig?: Record<string, unknown>;
  /** now() override (tests). */
  now?: () => number;
}

/**
 * Wire production {@link ScoutTickDeps}: cadence-state from the two injected fleet
 * signals + the autoloop last-fired clock; provenance + outcomes via the P-013
 * ledger; fire-gate + fire-recording via the autoloop (role {@link SCOUT_CYCLE_ROLE}).
 * The two fleet-specific readers stay injected (the codebase's pure-reader pattern).
 */
export function buildScoutTickDeps(opts: BuildScoutTickDepsOptions): ScoutTickDeps {
  const { harnessSlug } = opts;
  const now = opts.now ?? (() => Date.now());
  return {
    async readCadenceState(): Promise<ScoutCadenceState> {
      // Lazy import to keep this module's pure core free of the autoloop/PG/flag edge.
      const { readFireState } = await import('../autoloop');
      // K1 workspace-brain scope (workspace-scoped-coordination-2026-06-20 D-006/P-002):
      // when WORKSPACE_COORDINATION is ON, the workspace-Scout is ONE brain over the
      // whole workspace, so the idea-pipeline drain signal (the `ideas-drained` trigger)
      // must span ALL the workspace's routed ideas, not just this install's — otherwise
      // a single hive draining would wrongly re-trigger the workspace brain. OFF ⇒
      // per-install, byte-identical to today. Best-effort flag read (defaults OFF on error).
      const { isWorkspaceCoordinationOn, workspaceBrainReadKeys } = await import('../workspace-brain-scope');
      const wsCoordOn = await isWorkspaceCoordinationOn();
      // EI-1600: the cadence floor (min-interval / heartbeat) is measured from the
      // last cycle that ACTUALLY RAN (scout_ticks status='ran'/'fired'), NOT the
      // autoloop fire-ATTEMPT clock — a hung/errored fire advances last_fired_at
      // without running a cycle, and measuring the floor from it gates every
      // subsequent tick as min-interval (the ~24h Scout dormancy). The autoloop
      // last_fired_at is still read, but only as the FIRE-SLOT clock for the
      // single-flight claimFire CAS (fireSlotLastMs). The ran-tick read reconciles
      // across the workspace-brain re-key (K1) with the same read-fallback keys the
      // routed-ledger uses, so a sentinel/legacy install_slug split still resolves
      // the true last run.
      const ranReadKeys = opts.workspaceId
        ? workspaceBrainReadKeys(opts.workspaceId, harnessSlug, wsCoordOn)
        : [harnessSlug];
      const [idleRatio, frictionSignals, fire, ideaQueue, lastRanAtMs] = await Promise.all([
        opts.readIdleRatio().catch(() => 0),
        opts.readFrictionSignals().catch(() => 0),
        readFireState(harnessSlug, SCOUT_CYCLE_ROLE).catch(() => null),
        // Idea-pipeline status powers the `ideas-drained` trigger (owner-set
        // 2026-06-18). Best-effort: a read failure falls back to total 0, which
        // disables the drain trigger for that tick (heartbeat still fires). Under
        // WORKSPACE_COORDINATION the harness filter is dropped → the workspace-wide
        // drain signal (one brain sees the whole pipeline).
        readIdeaQueueStatus({
          ...(wsCoordOn ? {} : { harnessSlug }),
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        }).catch(() => ({ total: 0, pending: 0 })),
        // The cadence clock (EI-1600). Best-effort: a read failure ⇒ null = "never
        // ran", which fires idle/heartbeat freely rather than wedging the loop.
        readLastRanTickAtMs({
          installSlugs: ranReadKeys,
          ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        }).catch(() => null),
      ]);
      // VOLUME MODE (blender-self-learning-2026-07-12 P-002 / WI-4318): supply
      // the weighted new-signal score from the accumulator cache when the flag
      // is ON. FAIL-SOFT BY SHAPE: flag OFF (the kill switch), no workspaceId,
      // an empty accumulator (the 30s sweep not yet live on this host), or any
      // read error all leave signalScore UNDEFINED — and an undefined score is
      // the pure gate's legacy time-based mode, byte-identical. The cutover
      // therefore ships flag-ON with zero risk of wedging the Scout dark.
      let signalScore: number | undefined;
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        if (opts.workspaceId && (await getFlag(FLAGS.SCOUT_VOLUME_CADENCE, 'scout-volume-cadence'))) {
          const { readAccumulatorCounts, weightedSignalScore } = await import('./signal-accumulator');
          const acc = await readAccumulatorCounts({ workspaceId: opts.workspaceId });
          if (Object.keys(acc.counts).length > 0) signalScore = weightedSignalScore(acc.counts);
        }
      } catch {
        /* fail-soft: no accumulator ⇒ legacy cadence */
      }
      return {
        idleRatio,
        frictionSignals,
        // Cadence floor = last RUN (scout_ticks), NOT the autoloop attempt clock.
        lastRunAtMs: lastRanAtMs,
        // Fire-slot clock for the single-flight claimFire CAS only (autoloop).
        fireSlotLastMs: fire?.lastFiredAt ? fire.lastFiredAt.getTime() : null,
        nowMs: now(),
        routedIdeaTotal: ideaQueue.total,
        pendingIdeaCount: ideaQueue.pending,
        ...(signalScore !== undefined ? { signalScore } : {}),
      };
    },
    runCycle: opts.runCycle,
    async persistRouted(records, cycleId) {
      await persistRoutedRecordsIsolated(
        records,
        (r) =>
          recordRoutedIdea({
            // LEDGER-GAP FIX (scorecard-blender-pipeline-fixes-2026-07-11 P-003):
            // the in-cycle idea id is POSITIONAL (`scout-idea-<lens>-<slot>-<n>`,
            // ideators.ts) — identical across cycles — and the ledger upserts
            // ON CONFLICT (idea_id), so every cycle's routings OVERWROTE the
            // previous cycle's rows (441 routing events/7d collapsed into ~4
            // surviving rows) while the overwritten row KEPT the old idea's
            // grade/outcome — corrupted learning signal. Prefixing the cycle id
            // makes each cycle's routings land as their own rows; the su-ideate
            // paths (capture bridge / route-idea) key by stable artifact ids and
            // are untouched.
            ideaId: `${cycleId}:${r.ideaId}`,
            lens: r.lens,
            rail: r.rail,
            routedRef: r.routedRef,
            harnessSlug,
            cycleId,
            title: r.title,
            addressesPatternRefs: r.addressesPatternRefs,
            // Migration 947 / P-010 — model provenance. PRECEDENCE IS DELIBERATE:
            // the per-record value (what the producing ideator actually ran) wins
            // over the tick-level value (what this tick was configured with). They
            // agree in the ordinary case; when they disagree — a fallback model was
            // substituted mid-cycle after a transport failure, which
            // register-scout-action does — the per-record value is the true
            // producer and the configured one is a lie about that row.
            // Both absent ⇒ NULL, never a default: see BuildScoutTickDepsOptions.
            ...(r.modelSpec ?? opts.modelSpec
              ? { modelSpec: (r.modelSpec ?? opts.modelSpec) as string }
              : {}),
            ...(r.modelConfig ?? opts.modelConfig
              ? { modelConfig: (r.modelConfig ?? opts.modelConfig) as Record<string, unknown> }
              : {}),
            ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
          }),
        (r, e) =>
          console.error(
            `[scout/scheduler] persistRouted: recordRoutedIdea failed for ${cycleId}:${r.ideaId} (routedRef=${r.routedRef}) — ` +
              `this idea's issue was already captured+tagged but will NOT have a scout_routed_ideas row (WI-6338 divergence): ${e instanceof Error ? e.message : e}`,
          ),
      );
    },
    async persistStageArtifacts(cycle, cycleId) {
      // Lazy import keeps the pure core free of the PG edge (module pattern).
      const { persistStageArtifacts } = await import('./stage-artifacts');
      await persistStageArtifacts({
        cycleId,
        ideas: cycle.ideas,
        scored: cycle.scored,
        proposals: cycle.proposals,
        routingDecisions: cycle.routed,
        ideatorSlots: cycle.ideators,
        installSlug: harnessSlug,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
      });
    },
    async fireGate(): Promise<ScoutFireGate> {
      const { checkFireGate } = await import('../autoloop');
      const v = await checkFireGate(harnessSlug, SCOUT_CYCLE_ROLE);
      return { allow: v.allow, reason: v.reason, retryAfterSec: v.retryAfterSec };
    },
    async recordFire(outcome) {
      const { recordFire } = await import('../autoloop');
      await recordFire(harnessSlug, SCOUT_CYCLE_ROLE, SCOUT_CYCLE_ROLE, outcome);
    },
    async claimFire(expectedLastFiredAtMs) {
      const { claimFire } = await import('../autoloop');
      return claimFire(harnessSlug, SCOUT_CYCLE_ROLE, expectedLastFiredAtMs, 'scout-claim');
    },
    async refreshOutcomes() {
      await refreshScoutOutcomes({ harnessSlug, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) });
    },
    async readPoolSnapshot() {
      // Lazy import keeps the pure core free of the gateway-HTTP edge (module pattern).
      const { readScoutPoolSnapshot } = await import('./capacity-probe');
      return readScoutPoolSnapshot();
    },
    async readRevisionRequests(): Promise<ScoutRevisionRequest[]> {
      // The steward/reviewer→Scout revision channel — coord:inbox messages addressed
      // DIRECTLY to `scout:<hive>` (not broadcasts) carrying a routed draft's
      // plan_slug. Dedup against the Scout's own acks (readAckedMsgIds) so a
      // message is processed exactly once across ticks. Coord I/O runs in the
      // routine's workspace ALS (the event log is workspace-keyed). Lazy imports
      // keep this module's pure core free of the coord/PG edge.
      const { scoutCoordOwnerId } = await import('./coord-identity');
      const { readInbox, readAckedMsgIds } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const scoutOwner = scoutCoordOwnerId(harnessSlug);
      const gather = async (): Promise<ScoutRevisionRequest[]> => {
        // Bounded read (EI-19323045109346905) — replaces an unbounded ~20k-row scan
        // when only MAX_REVISION_REQUESTS_PER_TICK rows are ever used.
        //
        // The stopping rule here is the POST-FILTER count, NOT the raw count its
        // sibling call sites use, and the discriminator is the ORDER of slice vs
        // filter: this caller FILTERS first and slices only at the end, so a raw
        // count would stop on a page whose rows all get dropped and hand back
        // nothing while real feedback sat one page deeper.
        //
        // `acked` is therefore awaited BEFORE the windowed read rather than
        // alongside it: the stopping rule depends on it. That costs one
        // round-trip of parallelism and buys correctness — the ack set only ever
        // grows, so a rule blind to it would, once most matching messages are
        // acked, stop early on every tick and silently starve the Queen→Scout
        // channel (the failure would look like "the Queen stopped sending").
        //
        // ONE predicate feeds both the stopping rule and the final filter so the
        // two cannot drift; if they diverged, the window would stop counting the
        // very rows the caller keeps.
        const acked = await readAckedMsgIds(scoutOwner);
        const isFeedback = (e: CoordEnvelope): boolean =>
          e.kind !== 'ack' && // never treat an ack as feedback
          !e.category && // drop ambient (service-health / governor), like coord:inbox
          Array.isArray(e.to) &&
          e.to.includes(scoutOwner) && // DIRECTED, not a '*' broadcast
          typeof e.plan_slug === 'string' &&
          (e.plan_slug as string).length > 0 && // plan-keyed
          !acked.has(e.msg_id); // not yet consumed
        const inbox = await readInbox(
          scoutOwner,
          {},
          { enough: (entries) => entries.filter(isFeedback).length >= MAX_REVISION_REQUESTS_PER_TICK },
        );
        return inbox
          .filter(isFeedback)
          .map(
            (e): ScoutRevisionRequest => ({
              planSlug: e.plan_slug as string,
              body: ((e.body ?? e.summary ?? '') as string).trim(),
              fromOwnerId: e.from,
              msgId: e.msg_id,
              ts: e.ts,
            }),
          )
          .slice(-MAX_REVISION_REQUESTS_PER_TICK); // bound a backlog; the rest re-fire next tick
      };
      return opts.workspaceId ? runWithWorkspace(opts.workspaceId, gather) : gather();
    },
    async ackRevisionRequests(items: ScoutRevisionRequest[]): Promise<void> {
      if (items.length === 0) return;
      const { scoutCoordOwnerId } = await import('./coord-identity');
      const { appendAck } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const scoutOwner = scoutCoordOwnerId(harnessSlug);
      const identity = {
        ownerId: scoutOwner,
        ownerLabel: `scout · ${harnessSlug}`,
        source: 'principal' as const,
        workspaceId: opts.workspaceId ?? null,
        userId: null,
      };
      const ack = async (): Promise<void> => {
        for (const it of items) await appendAck(identity, it.msgId, it.fromOwnerId);
      };
      await (opts.workspaceId ? runWithWorkspace(opts.workspaceId, ack) : ack());
    },
    async recordTick(rec) {
      // K1 workspace-brain scope (workspace-scoped-coordination-2026-06-20 D-006/P-002):
      // when WORKSPACE_COORDINATION is ON, the workspace-Scout's tick observability rolls
      // up under the workspace sentinel (install_slug = workspaceId) — ONE coherent tick
      // stream per workspace brain, the same sentinel keying the lens-weights already use
      // (routed-ledger.refreshScoutOutcomes). OFF ⇒ the per-install slug, byte-identical
      // to today. The sentinel needs a workspaceId; without one we keep the per-install
      // slug (the dark/legacy path). Best-effort flag read (defaults OFF on error).
      const { isWorkspaceCoordinationOn, workspaceBrainScopeKey } = await import('../workspace-brain-scope');
      const installSlug = opts.workspaceId
        ? workspaceBrainScopeKey(opts.workspaceId, harnessSlug, await isWorkspaceCoordinationOn())
        : harnessSlug;
      // WI-5397: stamp the RUNNING scout code's content identity on every tick row
      // (gated/ran/error alike — a gated tick still proves this process's classifier
      // code was live at this instant). This is what lets the cycle-error-rate bar
      // aggregate across bg-host restarts that happen to load byte-identical code
      // instead of restarting its evidence window on every restart (see
      // scout-code-identity.ts + tick-ledger.ts's readScoutTicksByCodeHash). A null
      // hash (unreadable source, e.g. a bundled build) omits the key rather than
      // stamping a misleading null — an absent key never matches a hash-scoped read.
      const scoutCodeHash = currentScoutCodeHash();
      await recordScoutTick({
        ...rec,
        installSlug,
        ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}),
        ...(scoutCodeHash
          ? { detail: { ...(rec.detail ?? {}), scoutCodeHash } }
          : {}),
      });
    },
  };
}
