/**
 * `instantiateBenchHarness` — Port (P-019 / BRIEF 2, su-1226c): spin a THROWAWAY harness of
 * `blueprintId` over a cloned task checkout, feed `task.problemStatement` as the work_item,
 * run to DONE under the iso-budget cap, and return the generation telemetry. The shared
 * instantiation infra for the impartial benchmark suite (`impartial-benchmark-suite-2026-06-15`):
 *
 *   - the FULL Papercusp arm passes `'external-bench'` — the complete coding spine (spine ON).
 *   - Baseline A (ablation) passes `'coding-solo'` — one worker, spine OFF (P-006, su-136a4's
 *     `runSingleAgentAttempt` calls THIS port with `'coding-solo'`).
 *   - Baseline C (best-of-N, P-008) samples the `'coding-solo'` primitive through it N times.
 *
 * Everything ELSE (clone, infra, iso-budget cap, diff-extract, grader) is byte-identical across
 * arms → the ONLY delta is the blueprint's spine (D-004 fairness; D-002 causal-isolation headline).
 * This is the implementation behind the {@link InstantiateBenchHarness} port type in `./types.ts`
 * (BRIEF 3's shared contract); BRIEF 3's `arm-generation.ts` + BRIEF 4's `single-agent-attempt.ts`
 * receive it as `GenerationPorts.instantiate`.
 *
 * ── STAGING (the hive-eval / single-agent-attempt live-ports discipline) ───────────────────────
 * Spinning a real throwaway harness + driving its spine to DONE + summing its cost is a multi-
 * subsystem integration that SPENDS real model budget — so, exactly like the rest of the wave
 * (BRIEF 3's grader, BRIEF 4's drive), the LIVE driver is bound at PILOT time (P-009), not in this
 * build. `instantiateBenchHarness` is the typed prod port the pilot wires into
 * `GenerationPorts.instantiate`; it delegates to a {@link BenchHarnessDriver} bound via
 * {@link setBenchHarnessDriver}. UNBOUND, it returns a clean infra-error telemetry
 * (`stopReason: 'error'`, `generationStatus`-excludable) rather than half-running a real spend —
 * the scoring lib then drops the row (`resolved: null`), never scores it as a task failure
 * (METR: retry infra failures, never score them). Unit-tested with a fake driver; the pilot binds
 * the live one (the exact function map is in {@link BenchHarnessDriver}'s doc).
 */
import type {
  BenchHarnessRun,
  BenchTask,
  GenerationBudget,
  GenerationTelemetry,
  InstantiateBenchHarness,
  TaskCheckout,
} from './types';

/** The blueprint ids the suite instantiates (the matched causal-isolation pair). */
export const FULL_SPINE_BLUEPRINT = 'external-bench'; // arm 'papercusp' — spine ON
export const SINGLE_WORKER_BLUEPRINT = 'coding-solo'; // arm 'baseline-a-ablation' — spine OFF

/** Inputs a driver needs to spin + run + cost ONE throwaway bench harness. */
export interface BenchHarnessRunRequest {
  /** `'external-bench'` (full spine) | `'coding-solo'` (single worker). */
  blueprintId: string;
  task: BenchTask;
  /** The clean checkout the harness edits (the diff is taken from `checkout.dir`). */
  checkout: TaskCheckout;
  /** The iso-budget ceiling the harness enforces on the GENERATION side (BRIEF 7). */
  budget: GenerationBudget;
}

/**
 * The LIVE bench-harness driver — bound at pilot time (P-009). One method, the whole lifecycle:
 * spin a throwaway harness of `blueprintId` rooted at `checkout.dir`, add ONE `feature` work_item
 * with `task.problemStatement`, drive the spine to DONE under `budget`, sum the cost, tear down.
 *
 * The pilot composes it from (researched function map, all in `packages/operator-core/lib`):
 *   - CREATE     — the `harness:create` tool-handler pattern (`agent-tools/harness/create.ts`):
 *                  register + scaffold a throwaway harness at `checkout.dir`, blueprint=`blueprintId`,
 *                  a unique scratch slug (e.g. `xbench-<instanceId>-<seed>`).
 *   - FEED       — insert ONE `item_kind='feature'` row into
 *                  `harness_shared.harness_features_consolidated` (title/summary = `problemStatement`),
 *                  status 'todo' (the `create_feature` action in `execute-action.ts`).
 *   - DRIVE      — drive the feature to DONE under the cap: `ensureFeaturePipeline`
 *                  (`dbos/orchestrator-start.ts`) + poll the feature status, OR a director loop over
 *                  `spawnInvokeOnce` (`dbos/orchestrator-runner.ts`) — THE governed launch chokepoint.
 *                  Map the terminal state → `stopReason` (done / escalate / budget-exhausted /
 *                  max-turns / error). The iso-budget cap bounds tokens/$, turns are a runaway bound.
 *   - COST       — SUM `harness_shared.agent_usage_samples` for the slug over the run window:
 *                  tokensIn/Out, cost_usd, COUNT(DISTINCT run_id) as turns (the `iq-battery/bee-instance.ts`
 *                  pattern). Cost includes EVERY agent + turn (coordination overhead counted — fairness #2).
 *   - TEARDOWN   — unregister from `harness_shared.harness_registry` + DROP SCHEMA + rm the scratch dir.
 */
export interface BenchHarnessDriver {
  spinRunAndCost(req: BenchHarnessRunRequest): Promise<BenchHarnessRun>;
}

/** Zeroed cost — no model budget was spent (an infra failure before/at generation). */
function zeroTelemetry(over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: 0,
    trajectoryRef: '',
    stopReason: 'error',
    ...over,
  };
}

/**
 * The default driver — NOT bound until the pilot wires the live one. It throws so an accidental
 * unbound prod call surfaces loudly in logs; `instantiateBenchHarness` catches it and returns
 * infra-error telemetry (excluded from accuracy, never scored as a task failure).
 */
const UNBOUND_DRIVER: BenchHarnessDriver = {
  async spinRunAndCost() {
    throw new Error(
      'live bench-harness driver not bound — setBenchHarnessDriver() is wired at pilot time (P-009 / impartial-benchmark-suite-2026-06-15)',
    );
  },
};

let _driver: BenchHarnessDriver | null = null;

/**
 * Bind the live bench-harness driver (the pilot, P-009) — or a fake (unit tests). Pass `null` to
 * restore the unbound default (the test-teardown contract, like `setIqBatteryGenDeps(null)`).
 */
export function setBenchHarnessDriver(driver: BenchHarnessDriver | null): void {
  _driver = driver;
}

/**
 * The `InstantiateBenchHarness` port impl (BRIEF 2). Delegates to the bound {@link BenchHarnessDriver};
 * an unbound/failed driver yields infra-error telemetry over `checkout.dir` (never throws — the
 * generation-failure contract every arm runner relies on, mirroring `runSingleAgentAttempt`).
 */
export const instantiateBenchHarness: InstantiateBenchHarness = async (
  blueprintId,
  task,
  checkout,
  budget,
) => {
  const driver = _driver ?? UNBOUND_DRIVER;
  try {
    return await driver.spinRunAndCost({ blueprintId, task, checkout, budget });
  } catch (e) {
    const generationError = e instanceof Error ? e.message : String(e);
    return {
      worktreePath: checkout.dir,
      telemetry: zeroTelemetry({ generationError }),
    };
  }
};
