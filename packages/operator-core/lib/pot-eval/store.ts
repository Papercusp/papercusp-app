/**
 * The Hive-evaluation store port + an in-memory implementation (P-021/P-022).
 *
 * The harness records three things: the code-generation INSTANCE under test (reuses the
 * apiary's {@link InstanceManifest} shape), the seeded SCENARIO (with its computed
 * parallelism ideal, so the trend surface and HE-05 read the ideal without recomputing),
 * and one RUN per `(instance × scenario × repeat)` carrying the raw deterministic
 * OBSERVATIONS (terminal state, measured wall-clock, frontier-drained, completed-count,
 * cost, the repo path + refs) that HE-04/05 turn into outcome/efficiency/speed metrics and
 * HE-06 scores. Runs key on `(instance_id, scenario_id, repeat)` — unlike the beekeeper's
 * `(instance_id, case_id)`, this slice keeps every repeat so a score is a DISTRIBUTION (D-009).
 *
 * Scoring (the judge / composite / gate) is HE-06: it adds a `hive_eval_scores` writer over
 * these recorded runs (the rubric-hash store pattern). This port deliberately stops at the
 * raw run record.
 */
import type { InstanceManifest } from '../iq-battery/instance-manifest';
import type { ScenarioShape } from './scenario';

export type { InstanceManifest };

/** The terminal disposition of a whole-Hive run on a scenario. */
export type HiveRunTerminalState = 'drained' | 'timeout' | 'failed';

/** A scenario row — the corpus entry + its computed objective optimum (D-004). */
export interface HiveEvalScenarioRow {
  scenarioId: string;
  title: string;
  shape: ScenarioShape;
  /** From computeParallelismStructure — the computable ideal (HE-05 divides into it). */
  idealWallClockUnits: number;
  idealBeeCount: number;
  totalUnits: number;
  criticalPath: string[];
  workItemCount: number;
  plantedBugLocation: string;
}

/** The raw deterministic observations of one run — the metric layer's (HE-04/05) input. */
export interface HiveRunObservations {
  terminalState: HiveRunTerminalState;
  /** Measured wall-clock to drain/timeout (ms) — the speed numerator (HE-05). */
  wallClockMs: number;
  /** Did the Hive complete every work-item (the objective completion bar)? */
  frontierDrained: boolean;
  workItemsTotal: number;
  workItemsCompleted: number;
  /** Real spend on the run (cost-efficiency input). */
  costUsd: number;
  /** Where the throwaway hive's repo lived — acceptance/bug detection runs here (HE-04). */
  repoPath?: string;
  /** Free-form per-scenario extras (e.g. seeded work-item ids, spawn refs). */
  extra?: Record<string, unknown>;
}

/** One run row (the harness's durable output; one per instance × scenario × repeat). */
export interface HiveEvalRunRow {
  runId: string;
  instanceId: string;
  scenarioId: string;
  shape: ScenarioShape;
  repeat: number;
  seed: number;
  budgetUsdCap: number;
  beeCap: number;
  startedAt: Date;
  finishedAt?: Date;
  observations?: HiveRunObservations;
  traceRef?: string;
}

/** Fields written when a run finishes (or times out / fails — all are recorded). */
export interface HiveEvalRunFinish {
  finishedAt: Date;
  observations: HiveRunObservations;
  traceRef?: string;
}

/**
 * One run's SCORE under one rubric (HE-06). Keyed `(run_id, rubric_hash)` like the beekeeper
 * score store — re-scoring the same run under the same rubric is an idempotent overwrite, and a
 * rubric change (new hash) writes a distinct row, so scores under different rubrics never mix.
 * The flat columns are the indexable headline; `detail` keeps the whole {@link HiveScore} (per-axis
 * components + the `why`s + the gate reason) for the trend surface + audits.
 */
export interface HiveEvalScoreRow {
  runId: string;
  rubricHash: string;
  rubricVersion: string;
  /** D-002 gate: did the run do a good job (else efficiency/speed credit is zeroed)? */
  outcomeGatePassed: boolean;
  efficiencyScore: number;
  speedScore: number;
  /** The gated, floor-capped 0–10 composite (the headline). */
  composite: number;
  /** Advisory LLM-judge composite — recorded, never folded into `composite` (P-041). */
  judgeComposite?: number;
  // ── the deterministic floor signals (P-041), promoted for indexable trend reads ──
  regressions: boolean;
  plantedBugCaught: boolean;
  fabricationDetected: boolean;
  criticalPathRatio: number;
  floorCeiling: number;
  /** The whole {@link HiveScore} (per-axis components + why + gate reason) as recorded JSON. */
  detail: unknown;
  scoredAt?: Date;
}

/** The injectable store seam — an in-memory impl for tests, a PG impl for the live battery. */
export interface HiveEvalStore {
  upsertInstance(m: InstanceManifest): Promise<void>;
  upsertScenario(s: HiveEvalScenarioRow): Promise<void>;
  startRun(r: HiveEvalRunRow): Promise<void>;
  finishRun(runId: string, fields: HiveEvalRunFinish): Promise<void>;
  /** Record (or idempotently overwrite) a run's score under its rubric (HE-06). */
  upsertScore(row: HiveEvalScoreRow): Promise<void>;
  /** Read back one run's score under a rubric (null if unscored under that rubric). */
  getScore(runId: string, rubricHash: string): Promise<HiveEvalScoreRow | null>;
}

/** An in-memory store that also captures everything written, for test assertions. */
export interface InMemoryHiveEvalStore extends HiveEvalStore {
  instances: Map<string, InstanceManifest>;
  scenarios: Map<string, HiveEvalScenarioRow>;
  runs: Map<string, HiveEvalRunRow>;
  /** Keyed `${runId}::${rubricHash}` — every (run, rubric) score. */
  scores: Map<string, HiveEvalScoreRow>;
}

const scoreKey = (runId: string, rubricHash: string): string => `${runId}::${rubricHash}`;

export function createInMemoryHiveEvalStore(): InMemoryHiveEvalStore {
  const instances = new Map<string, InstanceManifest>();
  const scenarios = new Map<string, HiveEvalScenarioRow>();
  const runs = new Map<string, HiveEvalRunRow>();
  const scores = new Map<string, HiveEvalScoreRow>();
  return {
    instances,
    scenarios,
    runs,
    scores,
    async upsertInstance(m) {
      instances.set(m.instanceId, m);
    },
    async upsertScenario(s) {
      scenarios.set(s.scenarioId, s);
    },
    async startRun(r) {
      runs.set(r.runId, { ...r });
    },
    async finishRun(runId, fields) {
      const existing = runs.get(runId);
      if (!existing) throw new Error(`finishRun: no startRun for ${runId}`);
      runs.set(runId, { ...existing, ...fields });
    },
    async upsertScore(row) {
      scores.set(scoreKey(row.runId, row.rubricHash), { ...row, scoredAt: row.scoredAt ?? new Date(0) });
    },
    async getScore(runId, rubricHash) {
      return scores.get(scoreKey(runId, rubricHash)) ?? null;
    },
  };
}
