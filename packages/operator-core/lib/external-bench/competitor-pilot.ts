/**
 * Competitor-arm PILOT COMPOSITION (impartial-benchmark-suite-2026-06-15 P-032 pilot-prep, D-010).
 *
 * Makes a competitor fleet arm (OpenHands-async / CrewAI / LangGraph — P-028) ONE-COMMAND-READY: bind the
 * live driver once (`setCompetitorDriver`), then `runCompetitorArmPilot` does the whole arm end-to-end —
 *   drain the backlog → grade each task (shared `OfficialGrader`) → emit per-task rows (P-010 emitFromAttempt,
 *   each attributed to the fleet via `fleetRunId`) → project + emit the `FleetRunSummary` (P-010 emitFleetRun)
 *   → emit the MAST coordination trace.
 * Every piece is the LOCKED contract; the only injected seams are the live competitor driver and the live
 * emit/grader ports, so this is PG-free + unit-testable (the bounded smoke runs it with fakes) while the
 * gated pilot binds the real ones.
 *
 * ⚠ SCOPE (owner-gated): the actual competitor RUN needs the external frameworks installed (OpenHands/CrewAI/
 * LangGraph Python stacks + Docker) + budget — that is the owner-gated full-run setup, NOT the bounded code
 * smoke. "Ready-to-run" here = the composition is wired + smoke-green; at the gated run the operator binds the
 * per-framework driver (`setCompetitorDriver(id, liveDriver)`) + `liveCompetitorPilotDeps()` and calls this once.
 */
import type { BenchSuite, CoordEvent, FleetRunSummary } from '@papercusp/bench-metrics';
import { runAndGradeCompetitorBacklog } from './competitor-runner';
import type { CompetitorArmId } from './competitor-registry';
import type { HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import type { AdapterRowResult, BatchContext, EmitRollout } from './adapter';
import { emitFromAttempt } from './reproducibility/emit';
import { emitFleetRun, fleetRunIdFor, type FleetRunInput } from './reproducibility/fleet';
import type { BenchTask, GenerationBudget, OfficialGrader } from './types';

/** The live emit seam for a fleet run + its coord trace (= P-010 emitFleetRun at the pilot; a fake in tests). */
export type EmitFleet = (input: FleetRunInput) => Promise<{ fleetRunId: string; runId: string }>;

/** The injected ports a competitor-arm pilot needs (live at the gated run; fakes in the bounded smoke). */
export interface CompetitorPilotDeps {
  /** The official external grader (SWE-bench Pro Docker batch etc.) — owned by P-005, bound at the pilot. */
  grader: OfficialGrader;
  /** Per-task row emit — `emitFromAttempt` (P-010) at the pilot. */
  emit: EmitRollout;
  /** Fleet-run + coord-trace emit — `emitFleetRun` (P-010) at the pilot. */
  emitFleet: EmitFleet;
}

export interface CompetitorPilotInput {
  competitorId: CompetitorArmId;
  /** The whole benchmark backlog handed to the competitor orchestrator. */
  backlog: BenchTask[];
  /** Stable id of the task SET (for the deterministic fleetRunId + prereg). */
  backlogId: string;
  /** Groups one pilot execution across arms × seeds (P-010). */
  runId: string;
  suite: BenchSuite;
  /** Whole-backlog attempt ordinal (≥3 distinct per arm for the fleet pass@1). Default 0. */
  seed?: number;
  /** Must match a pre-registered run config (the tune-to-test firewall — emitFleetRun enforces it). */
  preregHash: string;
  modelId: string;
  harnessVersion: string;
  /** The fleet-level iso-budget for the whole drain. */
  budget: GenerationBudget;
  /** Iso-budget token cap recorded on the rows + fleet run (null = uncapped). */
  budgetTokens?: number | null;
}

export interface CompetitorPilotResult {
  /** Deterministic fleet-run id (== emitFleetRun's, so per-task rows + the fleet row agree). */
  fleetRunId: string;
  /** The raw fleet record from the competitor driver. */
  raw: HiveBacklogResult;
  /** Per-task graded + emitted rows. */
  rows: AdapterRowResult[];
  /** The projected fleet summary (null when the whole run infra-failed → nothing emitted). */
  fleet: FleetRunSummary | null;
  /** The MAST coordination trace (also persisted via emitFleet when fleet ran). */
  coordEvents: CoordEvent[];
  /** The persisted fleet-run handle (null when the run infra-failed). */
  emitted: { fleetRunId: string; runId: string } | null;
}

/**
 * Run ONE competitor arm over a backlog, end-to-end, emitting everything the metrics + UI layers read. The
 * live competitor driver must already be bound via `setCompetitorDriver(competitorId, …)`; unbound → an
 * infra-error run (no rows, `fleet:null`, nothing emitted) — never scored as task failures.
 */
export async function runCompetitorArmPilot(
  input: CompetitorPilotInput,
  deps: CompetitorPilotDeps,
): Promise<CompetitorPilotResult> {
  const seed = input.seed ?? 0;
  const fleetRunId = fleetRunIdFor(input.runId, input.suite, input.backlogId, input.competitorId, seed);

  const req: HiveBacklogRunRequest = {
    arm: input.competitorId,
    suite: input.suite,
    runId: input.runId,
    seed,
    backlog: input.backlog,
    budget: input.budget,
  };

  // Per-task rows attribute to THIS fleet run via ctx.fleetRunId (P-010 emitFromAttempt reads it).
  const ctx: BatchContext & { seedIndex: number } = {
    runId: input.runId,
    preregHash: input.preregHash,
    modelId: input.modelId,
    harnessVersion: input.harnessVersion,
    budgetTokens: input.budgetTokens ?? null,
    fleetRunId,
    seedIndex: seed,
  };

  const { result, rows, fleet, coordEvents } = await runAndGradeCompetitorBacklog(req, deps.grader, deps.emit, ctx);

  // A whole-run infra failure (unbound/failed driver) → nothing to emit at the fleet level; surfaced via raw.runError.
  let emitted: { fleetRunId: string; runId: string } | null = null;
  if (fleet) {
    emitted = await deps.emitFleet({
      summary: fleet,
      preregHash: input.preregHash,
      backlogId: input.backlogId,
      seed,
      modelId: input.modelId,
      harnessVersion: input.harnessVersion,
      budgetTokens: input.budgetTokens ?? null,
      coordEvents, // whole-trace idempotent emit (we did not stream live)
    });
  }

  return { fleetRunId, raw: result, rows, fleet, coordEvents, emitted };
}

/**
 * The LIVE emit/persist ports for the gated pilot — P-010's `emitFromAttempt` (per-task rows) +
 * `emitFleetRun` (the fleet run + coord trace). The pilot supplies the `grader` (P-005's official grader)
 * and binds the live competitor driver separately. Keep this the ONLY place the live PG seams are named, so
 * `runCompetitorArmPilot` stays unit-testable with fakes.
 */
export function liveCompetitorEmitPorts(): Pick<CompetitorPilotDeps, 'emit' | 'emitFleet'> {
  return {
    emit: (inputRow, opts) => emitFromAttempt(inputRow, opts),
    emitFleet: (fleetInput) => emitFleetRun(fleetInput),
  };
}
