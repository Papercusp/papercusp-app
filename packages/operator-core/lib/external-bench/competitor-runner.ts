/**
 * Competitor-orchestrator fleet arms (impartial-benchmark-suite-2026-06-15 P-028, D-010).
 *
 * The "vs other multi-agent systems" comparison — esp. the L4 coordination-quality (MAST) claim. Each
 * competitor (OpenHands-async / CrewAI / LangGraph / opt. ROMA — see competitor-registry.ts) drains the
 * SAME backlog as the `hive` / `queen-ablated` / `native-serial` arms and emits the SAME canonical raw
 * fleet record — {@link HiveBacklogResult} (hive-backlog.ts, the fleet-layer convergence point):
 *   - per-task `attempt` diffs → BRIEF 3's `OfficialGrader` → `resolved` → {@link toFleetRunSummary} → P-025 throughput.
 *   - `coordEvents` (the MAST-convertible `CoordEvent[]`) → P-026 `scoreMast` / `substrateSignalRates` → the L4 claim.
 * Emitting the IDENTICAL record is the fairness invariant: competitors are structurally indistinguishable
 * from the Hive arm to the metrics + grading layers, so "our coordination beats theirs" is measured, not asserted.
 *
 * Unlike hive ↔ queen-ablated (which differ only by the placement PLANNER over OUR fleet, hive-backlog.ts),
 * a competitor drives its OWN orchestrator, so it binds a per-competitor DRIVER (registry below) — not a
 * planner. `getFleetPlanner(competitorId)` is `undefined` by design (hive-backlog.ts notes this).
 *
 * STAGING (the wave's discipline): running real OpenHands/CrewAI/LangGraph spends real model budget + needs
 * those Python stacks + Docker, so — exactly like `runHiveBacklog`, `instantiateBenchHarness`, and the native
 * arm — the LIVE per-competitor drivers are bound at the P-032 pilot via {@link setCompetitorDriver}. Unbound,
 * the runner returns an infra-error `HiveBacklogResult` (carries `runError`; excluded from accuracy, never
 * scored as a task failure — METR discipline) and NEVER throws. Unit-tested with a fake driver.
 */
import type { CoordEvent, FleetRunSummary } from '@papercusp/bench-metrics';
import { toFleetRunSummary, type HiveBacklogResult, type HiveBacklogRunRequest } from './hive-backlog';
import { gradeAndEmitBatch, type AdapterRowResult, type BatchContext, type EmitRollout } from './adapter';
import type { BenchTask, OfficialGrader } from './types';
import { isCompetitorArmId, type CompetitorArmId } from './competitor-registry';

/**
 * The LIVE per-competitor driver — bound at the P-032 pilot. One method, the whole over-backlog lifecycle:
 * run the external orchestrator over `req.backlog`, collect a diff + cost per task, capture the agent-event
 * log as `CoordEvent`s, and return the canonical {@link HiveBacklogResult} (arm = the competitor id). The
 * pilot composes it per framework (OpenHands python entrypoint / a CrewAI crew / a LangGraph graph — see
 * competitor-registry.ts `invocation`); diff extraction reuses BRIEF 3's `extractDiff`/native diff.
 */
export interface CompetitorBacklogDriver {
  run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult>;
}

/** Process-local per-competitor driver bindings (the DI seam, mirroring run-loop.ts). NOT durable state. */
const _drivers = new Map<CompetitorArmId, CompetitorBacklogDriver>();

/** Bind (or, with `null`, unbind) the live driver for one competitor. The pilot binds; tests bind a fake. */
export function setCompetitorDriver(id: CompetitorArmId, driver: CompetitorBacklogDriver | null): void {
  if (driver) _drivers.set(id, driver);
  else _drivers.delete(id);
}

/** Test-teardown helper: drop every bound competitor driver. */
export function clearCompetitorDrivers(): void {
  _drivers.clear();
}

/** A whole-run infra failure → the empty canonical record carrying `runError` (mirrors runHiveBacklog). */
function infraErrorResult(req: HiveBacklogRunRequest, runError: string): HiveBacklogResult {
  return {
    arm: req.arm,
    suite: req.suite,
    runId: req.runId,
    seed: req.seed,
    startedAtMs: 0,
    finishedAtMs: 0,
    peakConcurrentBees: 0,
    taskResults: [],
    coordEvents: [],
    runError,
  };
}

/**
 * Drain a backlog with a competitor orchestrator → the canonical {@link HiveBacklogResult}. Dispatches to the
 * bound {@link CompetitorBacklogDriver}; a non-competitor arm, an unbound driver, or a throwing driver all
 * yield an infra-error result (empty `taskResults`/`coordEvents` + `runError`) — NEVER throws, mirroring
 * `runHiveBacklog` so the metrics/grading layers treat every fleet arm identically.
 */
export async function runCompetitorBacklog(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
  if (!isCompetitorArmId(req.arm)) {
    return infraErrorResult(req, `arm '${req.arm}' is not a registered competitor orchestrator (competitor-registry.ts)`);
  }
  const driver = _drivers.get(req.arm);
  if (!driver) {
    return infraErrorResult(
      req,
      `competitor driver '${req.arm}' not bound — setCompetitorDriver() is wired at the pilot (P-032 / impartial-benchmark-suite-2026-06-15)`,
    );
  }
  try {
    return await driver.run(req);
  } catch (e) {
    return infraErrorResult(req, `competitor drain failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The end-to-end P-028 output: the raw record + the graded rows + the projected FleetRunSummary + the MAST trace. */
export interface CompetitorBacklogResult {
  result: HiveBacklogResult;
  /** Per-task graded + emitted rows (via the SHARED `gradeAndEmitBatch` — identical grading to every arm). */
  rows: AdapterRowResult[];
  /** The P-025 fleet summary (resolved filled from the grades). Null when the whole run infra-failed. */
  fleet: FleetRunSummary | null;
  /** The coordination trace for P-026's MAST (`scoreMast` / `substrateSignalRates`). */
  coordEvents: CoordEvent[];
}

/**
 * The end-to-end P-028 unit: drain the backlog with a competitor, then grade + emit every per-task attempt
 * through the SAME `gradeAndEmitBatch` every other arm uses (byte-identical grading — the fairness invariant),
 * project the canonical {@link FleetRunSummary} (with `resolved` filled from the grades, for P-025), and return
 * the MAST `coordEvents` (for P-026). A whole-run infra failure (`runError`) yields no rows + `fleet:null` —
 * never scored as task failures.
 */
export async function runAndGradeCompetitorBacklog(
  req: HiveBacklogRunRequest,
  grader: OfficialGrader,
  emit: EmitRollout,
  ctx: BatchContext & { seedIndex: number },
): Promise<CompetitorBacklogResult> {
  const result = await runCompetitorBacklog(req);

  const taskById = new Map<string, BenchTask>(req.backlog.map((t) => [t.instanceId, t]));
  const entries = result.taskResults
    .map((tr) => {
      const task = taskById.get(tr.attempt.instanceId);
      return task ? { attempt: tr.attempt, task, seedIndex: ctx.seedIndex } : null;
    })
    .filter((e): e is { attempt: HiveBacklogResult['taskResults'][number]['attempt']; task: BenchTask; seedIndex: number } => e !== null);

  const rows = await gradeAndEmitBatch(entries, grader, emit, ctx);
  const resolvedCount = rows.filter((r) => r.grade?.resolved === true).length;
  const fleet = result.runError ? null : toFleetRunSummary(result, resolvedCount);

  return { result, rows, fleet, coordEvents: result.coordEvents };
}
