/**
 * live-capture.ts — the bridge between the LIVE whole-Hive run and the HE-06 score (P-063 / D-011).
 *
 * The hard ordering constraint (run-harness.ts): `runHiveScenarioOnce` runs `collectRunData` then
 * TEARS THE HIVE DOWN (drops the member schema + removes the clone) in a `finally`, BEFORE the
 * record is handed to the battery. `runHiveEvalGeneration` then scores each record with the
 * {@link HiveEvalScoreExtractor} — by which point every throwaway hive is gone. So the live reads
 * (acceptance over the clone, the ground-truth DB rows, the seed-app baseline, the spawn behavior +
 * timings) CANNOT happen in the extractor — the repo + schema no longer exist. They must happen in
 * `collectRunData` (pre-teardown), be serialized into `record.observations.extra`, and the extractor
 * REPLAYS them. This file is that contract:
 *
 *   - {@link LiveRunCapture} — the JSON-serializable bundle the live `collectRunData` packs into
 *     `extra.capture` (acceptance verdict · ground truth · run behavior · run timings).
 *   - {@link behaviorFromSpawnRows} / {@link timingsFromSpawnRows} — the PURE row → metric-input
 *     transforms (over the confirmed `spawned_agents` columns), unit-tested here with no DB.
 *   - {@link makeReplayExtractor} — the live {@link HiveEvalScoreExtractor}: read the capture off the
 *     record and run the SAME pure compute functions HE-04/05 ship (`computeOutcomeMetrics` over a
 *     replay AcceptancePorts, `computeEfficiencyMetrics`, `computeSpeedMetrics`).
 *
 * Honoring D-009: the record stays judge-free; scoring is still a pure pass over the recorded run —
 * the capture is just the recorded run's reality made replayable after teardown.
 */
import {
  computeOutcomeMetrics,
  type AcceptancePorts,
  type OutcomeMetricsDeps,
  type RunGroundTruth,
} from './outcome-metrics';
import { computeEfficiencyMetrics, type RunBehavior } from './efficiency-metrics';
import { computeSpeedMetrics, type RunTimings } from './speed-metrics';
import type { HiveScenario } from './scenario';
import type { HiveScenarioRunRecord } from './run-harness';
import type { HiveEvalScoreExtractor } from './generation-runner';

// ───────────────────────── the serialized live capture ─────────────────────────

/** The key under `record.observations.extra` the live `collectRunData` packs the capture into. */
export const LIVE_CAPTURE_KEY = 'capture';

/**
 * Everything the live run read while the throwaway hive still existed — JSON-serializable so it
 * survives in `record.observations.extra` to the (post-teardown) extractor. It carries the LIVE
 * reads only (acceptance verdict · ground truth · the confirmed spawn rows + bee cap + EKG fields);
 * behavior + timings are DERIVED in the extractor, where the record supplies the authoritative
 * wall-clock + run-start (collectRunData doesn't yet know the final wall-clock). So the record is
 * the single source of timing truth — the capture never stores a stale wall-clock.
 */
export interface LiveRunCapture {
  /** The scenario's objective acceptance verdict, run in the clone BEFORE teardown. */
  acceptance: { passed: boolean; output: string };
  /** The claims↔reality join (`collectGroundTruth`) — the fabrication / planted-bug / regression substrate. */
  groundTruth: RunGroundTruth;
  /** The run's confirmed `spawned_agents` rows — behavior + timings are derived from these. */
  spawnRows: SpawnRunRow[];
  /** EKG/cost-ledger fields not on `spawned_agents` (first-live-run wiring); absent ⇒ 0. */
  ekg?: BehaviorEkgFields;
  /** Longest ready-but-unplaced interval (ms) — EKG/frontier-sourced (first-live-run); absent ⇒ 0. */
  maxStuckMs?: number;
}

/** Wrap a capture as the `extra` object the live `collectRunData` returns (`{ capture }`). */
export function packLiveRunCapture(capture: LiveRunCapture): Record<string, unknown> {
  return { [LIVE_CAPTURE_KEY]: capture };
}

function isLiveRunCapture(v: unknown): v is LiveRunCapture {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.acceptance === 'object' &&
    c.acceptance != null &&
    typeof c.groundTruth === 'object' &&
    c.groundTruth != null &&
    Array.isArray(c.spawnRows)
  );
}

/** Read the {@link LiveRunCapture} off a recorded run, or null if it wasn't a live run. */
export function readLiveRunCapture(record: HiveScenarioRunRecord): LiveRunCapture | null {
  const c = record.observations.extra?.[LIVE_CAPTURE_KEY];
  return isLiveRunCapture(c) ? c : null;
}

// ───────────────────────── pure row → metric-input transforms ─────────────────────────

/**
 * The confirmed subset of a `harness_shared.spawned_agents` row the behavior/timing transforms
 * read (the columns that genuinely exist — 000-baseline). Cost/token are NOT columns on this table
 * (they are EKG-sourced — supplied via {@link BehaviorExtractInput.ekg}, first-live-run wiring).
 */
export interface SpawnRunRow {
  spawnId: string;
  /** The seeded work-item the bee served (= the scenario item id, by the throwaway-hive convention). */
  featureId: string | null;
  /** running | done | failed | cancelled | reaped. */
  status: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  durationMs: number | null;
}

/** The non-spawn-derivable behavior fields (coord volume, collisions, cost, …) — EKG/cost-ledger
 *  sourced, which the first live run wires (P-051). Absent ⇒ 0 (a missing signal never inflates a
 *  win: each is the DENOMINATOR or the FAILURE pair, so 0 is the conservative floor). */
export type BehaviorEkgFields = Partial<
  Pick<
    RunBehavior,
    | 'coordMessages'
    | 'collisions'
    | 'rework'
    | 'lockContentionMs'
    | 'totalTokens'
    | 'costUsd'
    | 'idleWhileReadyMs'
    // Per-wake Queen cache + round-trip efficiency (B-06 / P-010-P-011), sourced from
    // mugWakeEfficiency() over agent_usage_samples role='mug' scoped to the throwaway hive home
    // (live-ops.readQueenEkg). The hive home slug is unique per run, so harness_slug scoping is exact.
    | 'queenCacheReadTokens'
    | 'queenCacheCreationTokens'
    | 'queenInputTokens'
    | 'queenWakes'
    | 'queenTurns'
    | 'queenWakesWithTurns'
    // Per-bee warm-inject carry efficiency (P-015), sourced from beeWakeEfficiency() over
    // agent_usage_samples role='bee' grouped by session_id, scoped to the throwaway MEMBER clone
    // (where the bees work — live-ops.readBeeEkg). Unique per run ⇒ exact attribution.
    | 'beeCarriedReadTokens'
    | 'beeCacheReadTokens'
    | 'beeCacheCreationTokens'
    | 'beeInputTokens'
    | 'beeWarmInjects'
  >
>;

export interface BehaviorExtractInput {
  /** The run's bee cap (utilization denominator). */
  beeCap: number;
  /** Seeded features the Hive actually completed (HFC `passed`) — the completed-work signal. */
  completedFeatureIds: ReadonlySet<string>;
  /** EKG/cost-ledger fields not on `spawned_agents` (first-live-run wiring); absent ⇒ 0. */
  ekg?: BehaviorEkgFields;
}

/**
 * Estimate concurrent-bees-busy samples from the spawn intervals: the active-spawn count in each
 * gap between consecutive event boundaries (a start or an end). Pure — a parallelism proxy from
 * `started_at`/`finished_at` (no time-series sampler needed). A run with no overlap yields all-1s
 * (serial); overlapping spawns yield higher counts (parallel). Empty ⇒ `[]` (utilization 0).
 */
export function beesBusySamplesFromIntervals(rows: readonly SpawnRunRow[]): number[] {
  const intervals = rows
    .map((r) => ({ start: r.startedAtMs, end: r.finishedAtMs ?? r.startedAtMs + Math.max(0, r.durationMs ?? 0) }))
    .filter((iv) => Number.isFinite(iv.start) && Number.isFinite(iv.end));
  if (intervals.length === 0) return [];
  const bounds = Array.from(new Set(intervals.flatMap((iv) => [iv.start, iv.end]))).sort((a, b) => a - b);
  const samples: number[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const mid = (bounds[i] + bounds[i + 1]) / 2;
    samples.push(intervals.filter((iv) => iv.start <= mid && mid < iv.end).length);
  }
  // A zero-width run (all spawns instantaneous) has no interior gap — count it as one busy sample
  // so a real (if instantaneous) run isn't reported as zero parallelism.
  return samples.length > 0 ? samples : [intervals.length > 0 ? 1 : 0];
}

/**
 * Count coverage collisions among spawn rows — the D-003 failure pair for low communication
 * (EI-19323308682358684): the number of distinct spawn-row PAIRS that were both actively working
 * the SAME feature id at overlapping wall-clock windows. Two different spawnIds racing the same
 * deliverable is duplicate/redundant effort — exactly the case a low-comms score must NOT earn
 * credit for (the D-003 guard this metric feeds). This is a real, always-computable signal from
 * data already captured on every run (spawn rows), unlike `claim_audit`: under SKIP LOCKED claim
 * semantics a losing claimer's query simply never returns the contested row, so no "lost a race"
 * event is ever recorded there for a genuine two-claimer collision — only unrelated single-claimer
 * refusals (fail-closed spec gaps, plan-lane blocks) are. Rows with a null featureId, or with a
 * non-finite start/end, never collide (no shared deliverable to collide over). A single row per
 * feature (the overwhelmingly common case) yields 0 — this cannot regress the guard to "always
 * fires"; it can only start firing when a genuine overlap is present. PURE.
 */
export function collisionsFromSpawnRows(rows: readonly SpawnRunRow[]): number {
  const byFeature = new Map<string, { spawnId: string; start: number; end: number }[]>();
  for (const r of rows) {
    if (!r.featureId) continue;
    const start = r.startedAtMs;
    const end = r.finishedAtMs ?? start + Math.max(0, r.durationMs ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const list = byFeature.get(r.featureId) ?? [];
    list.push({ spawnId: r.spawnId, start, end });
    byFeature.set(r.featureId, list);
  }
  let collisions = 0;
  for (const spawns of byFeature.values()) {
    if (spawns.length < 2) continue;
    for (let i = 0; i < spawns.length; i++) {
      for (let j = i + 1; j < spawns.length; j++) {
        const a = spawns[i]!;
        const b = spawns[j]!;
        if (a.spawnId === b.spawnId) continue;
        // Half-open [start,end) overlap test.
        if (a.start < b.end && b.start < a.end) collisions++;
      }
    }
  }
  return collisions;
}

/**
 * Build the {@link RunBehavior} for a run from its spawn rows + the completed-feature set. The
 * spawn-derivable fields (parallelism samples, beesSpawned, uselessBees, collisions) are real; the
 * remaining EKG-sourced fields default to 0 (first-live-run). A bee is USELESS when it served no
 * completed feature — the parallelism failure-pair (a high bee count with low completed work is
 * the gaming the D-003 pair catches). PURE.
 */
export function behaviorFromSpawnRows(rows: readonly SpawnRunRow[], input: BehaviorExtractInput): RunBehavior {
  const beesSpawned = rows.length;
  const uselessBees = rows.filter((r) => !r.featureId || !input.completedFeatureIds.has(r.featureId)).length;
  const ekg = input.ekg ?? {};
  return {
    beesBusySamples: beesBusySamplesFromIntervals(rows),
    beeCap: input.beeCap,
    idleWhileReadyMs: ekg.idleWhileReadyMs ?? 0,
    coordMessages: ekg.coordMessages ?? 0,
    completedItems: input.completedFeatureIds.size,
    beesSpawned,
    uselessBees,
    // ekg.collisions is an explicit test/caller override; the real signal (EI-19323308682358684)
    // is derived from the spawn rows themselves — see collisionsFromSpawnRows.
    collisions: ekg.collisions ?? collisionsFromSpawnRows(rows),
    rework: ekg.rework ?? 0,
    lockContentionMs: ekg.lockContentionMs ?? 0,
    totalTokens: ekg.totalTokens ?? 0,
    costUsd: ekg.costUsd ?? 0,
    queenCacheReadTokens: ekg.queenCacheReadTokens ?? 0,
    queenCacheCreationTokens: ekg.queenCacheCreationTokens ?? 0,
    queenInputTokens: ekg.queenInputTokens ?? 0,
    queenWakes: ekg.queenWakes ?? 0,
    queenTurns: ekg.queenTurns ?? 0,
    queenWakesWithTurns: ekg.queenWakesWithTurns ?? 0,
    beeCarriedReadTokens: ekg.beeCarriedReadTokens ?? 0,
    beeCacheReadTokens: ekg.beeCacheReadTokens ?? 0,
    beeCacheCreationTokens: ekg.beeCacheCreationTokens ?? 0,
    beeInputTokens: ekg.beeInputTokens ?? 0,
    beeWarmInjects: ekg.beeWarmInjects ?? 0,
  };
}

export interface TimingExtractInput {
  /** Measured boot→drain wall-clock (ms) — from the run's observations. */
  wallClockMs: number;
  /** Run start (epoch ms) — time-to-first-placement is measured from here. */
  runStartMs: number;
  /** Longest ready-but-unplaced interval (ms) — EKG/frontier-sourced (first-live-run); absent ⇒ 0. */
  maxStuckMs?: number;
}

/**
 * Build the {@link RunTimings} for a run from its spawn rows + the scenario. Per-item duration is
 * the longest spawn that served that item (a bee may retry); time-to-first-placement is the first
 * spawn's start minus the run start. `maxStuckMs` is the one EKG-sourced field (first-live-run).
 * PURE — feeds the critical-path ratio (measured durations over the KNOWN DAG, D-004).
 */
export function timingsFromSpawnRows(
  rows: readonly SpawnRunRow[],
  scenario: HiveScenario,
  input: TimingExtractInput,
): RunTimings {
  const durationOf = (r: SpawnRunRow): number =>
    r.durationMs != null && r.durationMs >= 0
      ? r.durationMs
      : r.finishedAtMs != null
        ? Math.max(0, r.finishedAtMs - r.startedAtMs)
        : 0;
  const perItemDurationMs: Record<string, number> = {};
  for (const w of scenario.workItems) {
    const durations = rows.filter((r) => r.featureId === w.id).map(durationOf);
    perItemDurationMs[w.id] = durations.length > 0 ? Math.max(...durations) : 0;
  }
  const firstStart = rows.length > 0 ? Math.min(...rows.map((r) => r.startedAtMs)) : input.runStartMs;
  return {
    wallClockMs: input.wallClockMs,
    perItemDurationMs,
    timeToFirstPlacementMs: Math.max(0, firstStart - input.runStartMs),
    maxStuckMs: input.maxStuckMs ?? 0,
  };
}

// ───────────────────────── the replay extractor ─────────────────────────

/** A replay {@link AcceptancePorts}: the live run already ran the acceptance command in the clone
 *  (now gone); this returns that cached verdict so `computeOutcomeMetrics` is unchanged. */
export function replayAcceptancePorts(verdict: { passed: boolean; output: string }): AcceptancePorts {
  return { runAcceptance: async () => verdict };
}

export interface ReplayExtractorOpts {
  /** Optional advisory LLM judge (D-015: advisory-only, never raises the composite). Default off —
   *  the deterministic floor + gate is the score; the judge is extra spend, owner-opted. */
  judge?: OutcomeMetricsDeps['judge'];
}

/**
 * The LIVE {@link HiveEvalScoreExtractor}: replay the {@link LiveRunCapture} the live `collectRunData`
 * serialized into the record, and run the SAME pure HE-04/05/06 compute the fake extractor exercises.
 * Behavior + timings are DERIVED here (not in the capture) so the record supplies the authoritative
 * measured wall-clock (`observations.wallClockMs`) + run-start (`startedAt`) + cost — the single source
 * of timing truth. Throws a descriptive error if the record carries no capture (a non-live record
 * routed to the live extractor) — surfaced by the cadence as a clean `failed` tick, never a silent
 * zero score.
 */
export function makeReplayExtractor(opts: ReplayExtractorOpts = {}): HiveEvalScoreExtractor {
  return {
    async extract({ record, scenario }) {
      const capture = readLiveRunCapture(record);
      if (!capture) {
        throw new Error(
          `hive-eval live extractor: run ${record.runId} carries no LiveRunCapture in observations.extra.${LIVE_CAPTURE_KEY} — ` +
            'the live collectRunData (owner-gated P-051) must serialize it before teardown. A fake/non-live record cannot be live-scored.',
        );
      }
      // Completed = items GROUND TRUTH says were genuinely worked (never the Hive's own claim, D-005).
      const completedFeatureIds = new Set(
        capture.groundTruth.workItems.filter((w) => w.actuallyDone).map((w) => w.workItemId),
      );
      const behavior = behaviorFromSpawnRows(capture.spawnRows, {
        beeCap: record.beeCap,
        completedFeatureIds,
        // The record's costUsd (readRunStats) is the authoritative spend; layer it over the capture's EKG.
        ekg: { ...capture.ekg, costUsd: capture.ekg?.costUsd ?? record.observations.costUsd },
      });
      const timings = timingsFromSpawnRows(capture.spawnRows, scenario, {
        wallClockMs: record.observations.wallClockMs,
        runStartMs: record.startedAt.getTime(),
        ...(capture.maxStuckMs != null ? { maxStuckMs: capture.maxStuckMs } : {}),
      });
      const outcome = await computeOutcomeMetrics(record, scenario, capture.groundTruth, {
        acceptance: replayAcceptancePorts(capture.acceptance),
        ...(opts.judge ? { judge: opts.judge } : {}),
      });
      const efficiency = computeEfficiencyMetrics(behavior);
      const speed = computeSpeedMetrics(scenario, timings);
      return { outcome, efficiency, speed };
    },
  };
}
