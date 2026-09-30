/**
 * su-independent-backlog.ts — the INDEPENDENT-su-agents backlog driver
 * (benchmark-arms-su-vs-queen-expansion-2026-06-16 / P-001 / D-004-B: FIFO control-spawn routing).
 *
 * WHY THIS EXISTS. The two hive arms ({@link ./hive-backlog-realqueen.ts}) answer "how much does the
 * Queen's live placement/eviction/re-placement buy over no orchestration?" — both boot ONE hive over
 * the whole backlog and differ only in the Queen treatment. Neither is the honest "what does our
 * su/worker AGENT, standing alone, score on this benchmark?" pole. THIS driver is that pole: it runs
 * N INDEPENDENT agents, each solving EXACTLY ONE SWE-bench-Pro task end-to-end, with **NO Queen and
 * NO hive ORCHESTRATION** — no Queen wake, no placement-watchdog, no `hive_placements` ledger, no
 * survey/re-wake loop. It is the simplest of the three drivers: a bounded concurrency POOL of
 * independent per-task agents routed through shared hive infrastructure (the :3170 operator host).
 *
 * THE COMPARISON LANDSCAPE (all three share clone/diff/grader/model — D-004 fairness):
 *   - 'su-independent' (this) — N independent su/worker agents, one task each, NO Queen orchestration.
 *                               Routes through :3170 hive infrastructure for proper env + work-item wiring.
 *   - 'hive-realqueen'        — ONE hive, the REAL Queen places/evicts/re-places/briefs/adaptive-wakes.
 *   - 'mini-swe-agent'        — the reference standard harness (external, same model + same tasks).
 *
 * ── THE PER-TASK SPINE-DRIVE (the spawn primitive — D-001 / D-004-B) ──────────────────────────────────
 * CRITICAL FIX (D-004-B): control bees MUST route through :3170 so they receive proper environment
 * variables (AGENT_MODELS, PAPERCUSP_XBENCH_CUP_DIRECTIVE) and wire to work-item claims (fleet coordination).
 * Each independent agent is: (1) enrolled as a temporary member harness with a seeded feature, (2) spawned
 * via FIFO batch through the shared hive (placeFifoBatch), (3) collected when finished. This maintains
 * independence (per-task isolation, no Queen placement) while routing through hive infrastructure so bees
 * get the environment + work-item binding they need to succeed. The shared temporary hive is created at
 * run start, member harnesses are enrolled per task, and the hive is torn down at run end.
 *
 * ── CONCURRENCY (the pool — D-002) ──────────────────────────────────────────────────────────────────
 * Up to `cap` agents run at once where `cap = spawnConcurrencyCeiling()` — the SAME global
 * `maxSimultaneousAgents` ceiling the hive arms draw from (`../fleet/operator-spawn`), read at run start.
 * We do NOT exceed it. As each task finishes the pool pulls the next backlog task, so a backlog larger
 * than the cap drains in waves of ≤cap concurrent agents (the same saturation discipline the hive arms
 * run under — fairness). The hive's FIFO placement respects the cap automatically; the caller is
 * responsible for setting `maxSimultaneousAgents` to the intended value in THIS process before the run.
 *
 * ── ACTUAL-CONCURRENCY TRACKING (load-bearing — P-003) ──────────────────────────────────────────────
 * Besides the scalar `peakConcurrentBees`, the driver records a {@link ConcurrencyTimeline}: a background
 * sampler reads the live pool-occupancy counter on a fixed cadence (`sampleIntervalMs`) and appends
 * `{tMs, live}`; at run end we compute `avgConcurrent`/`peakConcurrent` and attach it to the result. This
 * answers "how many independent agents actually ran at once, on average" — not just the peak — so the
 * report can show whether the pool was saturated or starved. The occupancy counter is the ground truth
 * (incremented at task's first spawn start, decremented at task's finish).
 *
 * ── FAIRNESS (D-004): opus 4.8 @ xhigh ──────────────────────────────────────────────────────────────
 * The `external-bench` spine drives the PIPELINE roles (worker/validator/reviewer/director/scoper/
 * architect/documenter), whose committed floors are sonnet/haiku (orchestrator/role-models.ts) — NOT the
 * `bee` role the hive arms place. So to match the other arms' model the CALLER must export
 * `AGENT_MODELS` pinning those pipeline roles to `opus:xhigh`, e.g.
 *   AGENT_MODELS='{"director":"opus:xhigh","scoper":"opus:xhigh","architect":"opus:xhigh",
 *                  "worker":"opus:xhigh","validator":"opus:xhigh","reviewer":"opus:xhigh",
 *                  "documenter":"opus:xhigh","bee":"opus:xhigh"}'
 * plus `AGENT_CMD="claude -p"` (the `opus` alias). The opus model pin is the CALLER's responsibility
 * (it must reach every spawned role). VERIFY `agent_usage_samples.model = claude-opus-4-8` on a 1-task
 * probe before any big spend. Same clone/diff/grader as every arm — the only independent variable across
 * arms is the orchestration layer.
 *
 * GOVERNOR / SPEND: binding this spends nothing; the real LLM spend is the per-task agents on the gated
 * launch. The driver bounds spend with a per-task iso-budget (`req.budget`, enforced inside the
 * external-bench spine-drive) and a whole-run wall-clock ceiling; on timeout/error it stops pulling new
 * tasks, collects whatever finished, and cleans up every checkout. NEVER throws (the generation-failure
 * contract — a failure returns a {@link HiveBacklogResult} with `runError` + the partial `taskResults`).
 */
import type { FleetArmId } from '@papercusp/bench-metrics';
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationTelemetry, TaskCheckout } from './types';
import {
  setHiveBacklogDriver,
  type FleetTaskResult,
  type HiveBacklogDriver,
  type HiveBacklogResult,
  type HiveBacklogRunRequest,
} from './hive-backlog';
import { makeConcurrencySampler } from './hive-backlog-utilities';

/** The arm this driver serves (open `FleetArmId` union — slots in with no type change). */
export const SU_INDEPENDENT_ARM: FleetArmId = 'su-independent';

/** The blueprint each independent agent drives — the FULL coding spine (same as the papercusp L1 arm). */
const SPINE_BLUEPRINT = 'external-bench';

/** Default whole-run wall-clock ceiling (the bound on spend) + the concurrency-sample cadence. */
const DEFAULT_FLEET_TIMEOUT_MS = 120 * 60 * 1000; // 2h ceiling — a bounded run is far under.
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000; // sample live pool occupancy every 5s.

/**
 * One enrolled backlog task driven by an independent agent — its clone + the result fields the
 * collector fills. There is NO member harness / hive home / bee placement here (the independent
 * agent owns its own throwaway harness inside `runOneTask`); this is purely the per-task record.
 */
export interface SuIndependentEnrolled {
  task: BenchTask;
  /** The cloned worktree the agent edits (=== checkout.dir). */
  clonePath: string;
  checkout: TaskCheckout;
  /** The spawn/agent id that served it (best-effort; filled by `runOneTask`). null until it runs. */
  agentId: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

/**
 * What `runOneTask` returns — the per-task generation result for ONE independent agent. The driver
 * maps it into a {@link FleetTaskResult}. Mirrors the bench-harness {@link GenerationTelemetry} the
 * spine-drive produces, plus the unified diff (extracted from the worktree) the grader consumes.
 */
export interface SuTaskOutcome {
  /** The unified diff base..HEAD (grader test-files excluded); "" when the agent produced no change. */
  diff: string;
  /**
   * The qa-modality FINAL ANSWER the agent wrote (GAIA: `answer.txt`). Set ONLY by the GAIA seam
   * ({@link SuIndependentBacklogOpts.gaia}); absent/'' for the default diff path. Carried onto
   * {@link ArmAttempt.answer} so the same FleetTaskResult serves both the diff arms and the GAIA arm.
   */
  answer?: string;
  telemetry: GenerationTelemetry;
  /** The agent/spawn id that served it (diagnostics + the FleetTaskResult.cupId field). */
  agentId: string;
}

/**
 * The injected IO seam. Every side effect is ONE method so the boot→hive-create→spawn→collect→teardown
 * ordering, the concurrency-pool semantics, the timeline sampling, and the never-throw contract all
 * unit-test with fakes (NO git/PG/LLM, NO live spawns). The real binding ({@link suIndependentBacklogOps})
 * wires hive lifecycle / the FIFO spawn seam / diff extraction via lazy dynamic imports.
 *
 * ARCHITECTURE (D-004-B): Unlike the original design, this arm NOW maintains a temporary shared hive
 * over the whole run. Each task: enrolls as a member harness → spawns via FIFO through :3170 → collects
 * the result → tears down the member. This maintains per-task independence (no Queen orchestration) while
 * routing through hive infrastructure so bees receive proper environment variables and work-item claims.
 */
export interface SuIndependentBacklogOps {
  now(): number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). Read ONCE at run start. */
  concurrencyCap(): number | Promise<number>;
  /** Create a temporary shared hive for the whole run (ONE hive, enrolled members per task). */
  createHive(input: { runId: string; workspaceId: string }): Promise<{ potSlug: string }>;
  /** Clone the task repo @ base into a fresh scratch worktree (the per-agent isolated checkout). */
  prepareTask(input: { task: BenchTask; budget: GenerationBudget; workspaceId: string }): Promise<SuIndependentEnrolled>;
  /**
   * Enroll a prepared task as a temporary member harness in the hive with a seeded feature.
   * Returns the member harness slug so it can be spawned via placeFifoBatch.
   */
  enrollTask(input: {
    task: BenchTask;
    enrolled: SuIndependentEnrolled;
    potSlug: string;
    workspaceId: string;
  }): Promise<{ memberSlug: string }>;
  /**
   * Spawn ONE enrolled member harness via FIFO through the hive (routes through :3170, proper env).
   * Returns the spawn_id so the result can be collected.
   */
  placeFifoBatch(input: { potSlug: string; memberSlug: string; workspaceId: string }): Promise<{ spawnId: string }>;
  /**
   * Collect the result from a spawned member: extract its diff + cost from agent_usage_samples.
   * The spawn must have reached a terminal state.
   */
  collectTask(input: {
    task: BenchTask;
    spawnId: string;
    enrolled: SuIndependentEnrolled;
    workspaceId: string;
  }): Promise<SuTaskOutcome>;
  /** Remove ONE member harness enrollment (best-effort). */
  teardownMember(input: { memberSlug: string; workspaceId: string }): Promise<void>;
  /** Remove ONE task's scratch checkout (best-effort — the per-agent worktree). */
  teardownTask(input: { enrolled: SuIndependentEnrolled; workspaceId: string }): Promise<void>;
  /** Dissolve the temporary shared hive (best-effort). */
  dissolveHive(input: { potSlug: string; workspaceId: string }): Promise<void>;
}

export interface SuIndependentBacklogOpts {
  workspaceId: string;
  /** Whole-run wall-clock ceiling (ms). Default 2h. */
  fleetTimeoutMs?: number;
  /** Live-concurrency sample cadence (ms). Default 5s. */
  sampleIntervalMs?: number;
  /**
   * DURABILITY hooks (mirror the realqueen driver — a mid-run kill keeps already-produced work).
   *   - `onEnrolled`      fires right after each task is cloned/prepared → persist the
   *                       instanceId → clonePath → baseCommit mapping for a recovery pass.
   *   - `onTaskCollected` fires per task as it finishes + is collected → persist that one task's
   *                       diff/row immediately, so a kill keeps every diff already gathered.
   * Both optional + best-effort: a hook throw (sync OR async) must NEVER abort the drive/collection.
   */
  onEnrolled?: (enrolled: SuIndependentEnrolled) => void | Promise<void>;
  onTaskCollected?: (result: FleetTaskResult) => void | Promise<void>;
  /**
   * Fires once, right after this run's temporary hive is created, with its slug (a random
   * `xbench-su-<nanoid>`). The launcher captures it so a signal-kill — which exits BEFORE the driver's
   * finalize/dissolveHive runs — can still retire THIS run's work-items (scoped {@link retireBenchDebris}),
   * never a concurrent peer's. Best-effort: a hook throw must never abort the drive.
   */
  onHiveCreated?: (potSlug: string) => void | Promise<void>;
  /**
   * GAIA arm seam (plan benchmark-suite-gaia-2026-06-17). When present, the REAL ops binding
   * ({@link suIndependentBacklogOps}) runs the GAIA general-assistant path instead of the SWE-bench coding
   * path — the THREE SWAPS: GAIA scratch-dir clone (no repo), member blueprint `gaia-agent` + the
   * question/answer.txt brief, and `answer.txt` extraction into {@link ArmAttempt.answer} (diff:''). ADDITIVE:
   * absent → today's unchanged SWE-bench behavior. The driver itself is GAIA-agnostic (the swap is entirely
   * inside the injected ops); it only flows the extra `answer` field through.
   */
  gaia?: GaiaArmSeamConfig;
}

/** GAIA arm config — a presence flag is enough today; reserved for future per-arm GAIA tuning. */
export interface GaiaArmSeamConfig {
  /** Must be true to engage the GAIA path. */
  enabled: true;
}

/**
 * The LIVE {@link HiveBacklogDriver} over the injected {@link SuIndependentBacklogOps}. Runs the backlog
 * through a bounded concurrency POOL of independent per-task agents (size = the fleet cap), records the
 * live-concurrency timeline, and collects per-task diff/cost. NO Queen orchestration; routes through
 * shared hive infrastructure (D-004-B) for proper environment + work-item wiring. Never throws (the
 * generation-failure contract — a failure yields a result with `runError` + partials).
 */
export function suIndependentBacklogDriver(
  ops: SuIndependentBacklogOps,
  opts: SuIndependentBacklogOpts,
): HiveBacklogDriver {
  const ws = opts.workspaceId;
  const fleetTimeoutMs = opts.fleetTimeoutMs ?? DEFAULT_FLEET_TIMEOUT_MS;
  const sampleIntervalMs = opts.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const startedAtMs = ops.now();

      // ── live-concurrency accounting (the SHARED sampler — hive-backlog-utilities) ──────────────────
      // `occupancy` is the ground-truth pool occupancy (enter() at a task's first FIFO spawn, exit() at its
      // finish); it reads on a fixed cadence into the ConcurrencyTimeline, peak tracked inline. Extracted to
      // hive-backlog-utilities so the su-independent pool + the METR HCAST in-container pool share ONE impl.
      const occupancy = makeConcurrencySampler(startedAtMs, ops.now);
      const enter = (): void => occupancy.enter();
      const exit = (): void => occupancy.exit();

      const taskResults: FleetTaskResult[] = [];
      const enrolledAll: SuIndependentEnrolled[] = [];
      const memberSlugs: string[] = [];

      // The concurrency sampler runs on a real timer (unref'd so it never keeps the process alive). The
      // injected `ops.now()` lets the unit test drive logical time. We always take an initial + final sample
      // so the timeline is non-empty.
      occupancy.sample();
      const samplerTimer = setInterval(() => occupancy.sample(), Math.max(1, sampleIntervalMs));
      if (typeof samplerTimer.unref === 'function') samplerTimer.unref();

      const finalize = (runError?: string): HiveBacklogResult => {
        clearInterval(samplerTimer);
        occupancy.sample(); // final occupancy snapshot
        return {
          arm: req.arm,
          suite: req.suite,
          runId: req.runId,
          seed: req.seed,
          startedAtMs,
          finishedAtMs: ops.now(),
          peakConcurrentBees: occupancy.peak(),
          taskResults,
          coordEvents: [], // an independent-agent arm has NO Queen coordination trace — by design.
          concurrencyTimeline: occupancy.finalize(),
          ...(runError ? { runError } : {}),
        };
      };

      let potSlug: string | null = null;
      try {
        // CREATE the temporary shared hive that will host all member enrollments for this run.
        let hiveCreated: { potSlug: string };
        try {
          hiveCreated = await ops.createHive({ runId: req.runId, workspaceId: ws });
          potSlug = hiveCreated.potSlug;
        } catch (e) {
          return finalize(`createHive failed: ${msg(e)}`);
        }
        // Surface the run's hive slug so the launcher can scope a signal-kill debris retire to THIS run.
        await fireHook(opts.onHiveCreated, potSlug);

        const cap = Math.max(1, Math.floor(await ops.concurrencyCap()) || 1);
        const deadline = startedAtMs + fleetTimeoutMs;
        const backlog = req.backlog;
        let nextIndex = 0;
        let timedOut = false;

        // ── the concurrency POOL ───────────────────────────────────────────────────────────────────
        // `cap` worker loops each pull the next un-started backlog task, prepare+enroll+spawn+collect it,
        // then loop for the next — so at most `cap` agents are live at once and the backlog drains in waves
        // of ≤cap. A worker stops pulling when the backlog is exhausted OR the wall-clock deadline passed.
        // The shared `nextIndex` cursor is mutated synchronously between `await`s — single-threaded JS.
        const worker = async (): Promise<void> => {
          for (;;) {
            if (ops.now() >= deadline) {
              timedOut = true;
              return;
            }
            const i = nextIndex;
            if (i >= backlog.length) return;
            nextIndex += 1;
            const task = backlog[i];

            // PREPARE (clone) — a prepare failure for ONE task must not abort the pool; record an
            // error result for it and continue pulling.
            let enrolled: SuIndependentEnrolled;
            try {
              enrolled = await ops.prepareTask({ task, budget: req.budget, workspaceId: ws });
            } catch (e) {
              taskResults.push(
                errorTaskResult(req.arm, task, String(req.seed), `prepareTask failed: ${msg(e)}`),
              );
              continue;
            }
            enrolledAll.push(enrolled);
            await fireHook(opts.onEnrolled, enrolled);

            // ENROLL the task as a temporary member harness in the hive.
            let memberEnrolled: { memberSlug: string };
            try {
              memberEnrolled = await ops.enrollTask({ task, enrolled, potSlug: potSlug!, workspaceId: ws });
              memberSlugs.push(memberEnrolled.memberSlug);
            } catch (e) {
              taskResults.push(
                errorTaskResult(req.arm, task, String(req.seed), `enrollTask failed: ${msg(e)}`),
              );
              await ops.teardownTask({ enrolled, workspaceId: ws }).catch(() => {});
              continue;
            }

            // SPAWN the enrolled member via FIFO through the hive (routes through :3170, proper env).
            // ++/-- the occupancy counter around the spawn window so the timeline reflects exactly when
            // the agent is live. The spawn itself never throws a generation failure (it maps to
            // telemetry.stopReason='error'); a genuine infra throw lands an error result for this task.
            let spawnPlaced: { spawnId: string };
            try {
              spawnPlaced = await ops.placeFifoBatch({ potSlug: potSlug!, memberSlug: memberEnrolled.memberSlug, workspaceId: ws });
            } catch (e) {
              taskResults.push(
                errorTaskResult(req.arm, task, String(req.seed), `placeFifoBatch failed: ${msg(e)}`),
              );
              await ops.teardownMember({ memberSlug: memberEnrolled.memberSlug, workspaceId: ws }).catch(() => {});
              await ops.teardownTask({ enrolled, workspaceId: ws }).catch(() => {});
              continue;
            }

            // COLLECT the result from the spawned bee (it waits for the spawn to terminate).
            enter();
            enrolled.startedAtMs = ops.now();
            let result: FleetTaskResult;
            try {
              const outcome = await ops.collectTask({ task, spawnId: spawnPlaced.spawnId, enrolled, workspaceId: ws });
              enrolled.finishedAtMs = ops.now();
              enrolled.agentId = outcome.agentId;
              result = taskResultFromOutcome(req.arm, enrolled, String(req.seed), outcome);
            } catch (e) {
              enrolled.finishedAtMs = ops.now();
              result = errorTaskResult(req.arm, task, String(req.seed), `collectTask failed: ${msg(e)}`, enrolled);
            } finally {
              exit();
              // Clean up both the member enrollment and the checkout worktree.
              await ops.teardownMember({ memberSlug: memberEnrolled.memberSlug, workspaceId: ws }).catch(() => {});
              await ops.teardownTask({ enrolled, workspaceId: ws }).catch(() => {});
            }
            taskResults.push(result);
            await fireHook(opts.onTaskCollected, result);
          }
        };

        // Spawn min(cap, backlog) worker loops and await them all. Each task is collected as it finishes
        // (inside the loop), so the durability hooks fire incrementally — a mid-run kill keeps the
        // already-collected diffs.
        const poolSize = Math.max(1, Math.min(cap, backlog.length || 1));
        await Promise.all(Array.from({ length: poolSize }, () => worker()));

        return finalize(timedOut ? `run wall-clock timeout after ${fleetTimeoutMs}ms (backlog not fully drained)` : undefined);
      } catch (e) {
        // A failure OUTSIDE a single task (e.g. concurrencyCap threw) — tear down any prepared checkouts
        // and return the partial result with runError. Never throw.
        for (const en of enrolledAll) await ops.teardownTask({ enrolled: en, workspaceId: ws }).catch(() => {});
        return finalize(msg(e));
      } finally {
        // ALWAYS dissolve the shared hive on run completion, whether succeeded or failed.
        if (potSlug) await ops.dissolveHive({ potSlug, workspaceId: ws }).catch(() => {});
      }
    },
  };
}

/** Map a successful per-task outcome → a {@link FleetTaskResult}. */
function taskResultFromOutcome(
  arm: FleetArmId,
  enrolled: SuIndependentEnrolled,
  seed: string,
  outcome: SuTaskOutcome,
): FleetTaskResult {
  const t = outcome.telemetry;
  const startedAtMs = enrolled.startedAtMs ?? 0;
  const finishedAtMs = enrolled.finishedAtMs ?? startedAtMs;
  const attempt: ArmAttempt = {
    arm,
    blueprintId: SPINE_BLUEPRINT,
    instanceId: enrolled.task.instanceId,
    seed,
    diff: outcome.diff,
    ...(outcome.answer != null ? { answer: outcome.answer } : {}),
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    costUsd: t.costUsd,
    turns: t.turns,
    wallClockMs: t.wallClockMs,
    trajectoryRef: t.trajectoryRef || `xbench-su-independent://${enrolled.task.instanceId}`,
    stopReason: t.stopReason,
    ...(t.generationError ? { generationError: t.generationError } : {}),
    armMeta: { independent: true, agentId: outcome.agentId },
  };
  return {
    attempt,
    cupId: outcome.agentId,
    placedAtMs: startedAtMs, // there is no "placement" — the agent starts when the pool pulls it.
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn', // always a fresh independent spawn (never a warm-inject — no fleet to inject into).
  };
}

/** Build an error {@link FleetTaskResult} for a task whose prepare/run threw (infra failure, not scored). */
function errorTaskResult(
  arm: FleetArmId,
  task: BenchTask,
  seed: string,
  generationError: string,
  enrolled?: SuIndependentEnrolled,
): FleetTaskResult {
  const startedAtMs = enrolled?.startedAtMs ?? 0;
  const finishedAtMs = enrolled?.finishedAtMs ?? startedAtMs;
  const attempt: ArmAttempt = {
    arm,
    blueprintId: SPINE_BLUEPRINT,
    instanceId: task.instanceId,
    seed,
    diff: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: Math.max(0, finishedAtMs - startedAtMs),
    trajectoryRef: `xbench-su-independent://${task.instanceId}`,
    stopReason: 'error',
    generationError,
    armMeta: { independent: true },
  };
  return {
    attempt,
    cupId: enrolled?.agentId ?? task.instanceId,
    placedAtMs: startedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/** Fire a best-effort durability hook — a sync OR async throw must never abort the caller. */
async function fireHook<T>(hook: ((x: T) => void | Promise<void>) | undefined, arg: T): Promise<void> {
  if (!hook) return;
  try {
    await hook(arg);
  } catch {
    /* best-effort durability hook — ignore */
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Bind the live su-independent driver so `runHiveBacklog` is instant-go. `ops` defaults to the real binding. */
export function bindSuIndependentBacklogDriver(
  opts: SuIndependentBacklogOpts,
  ops?: SuIndependentBacklogOps,
): void {
  setHiveBacklogDriver(suIndependentBacklogDriver(ops ?? suIndependentBacklogOps(opts), opts));
}

/* -------------------------------------------------------------------------- */
/* The REAL binding — hive lifecycle + FIFO spawn + diff extraction (D-004-B)  */
/* -------------------------------------------------------------------------- */

/**
 * The REAL machinery binding (D-004-B). Each task: clone @ base → enroll as member harness → spawn
 * via FIFO through :3170 → collect result (wait for spawn + extract diff). The shared temporary hive
 * is created once per run and dissolved at the end. Reuses the liveHiveOps seam from the realqueen arm
 * (same harness/feature infrastructure; just no Queen orchestration). Lazy dynamic imports keep the
 * module import-light so the fake-driven test never loads git/PG/the hive/fleet ops.
 *
 * KEY ENVIRONMENTAL: control bees receive PAPERCUSP_XBENCH_CUP_DIRECTIVE + AGENT_MODELS (the opus
 * override) set on :3170's env (.env.local), so they self-claim work-items + use the correct models.
 * This binding sets both in THIS launcher's env so in-process operations see them (though the actual
 * bees spawn via :3170 loopback, so the :3170 env is what matters for the bees).
 */
export function suIndependentBacklogOps(opts: SuIndependentBacklogOpts): SuIndependentBacklogOps {
  const ws = opts.workspaceId;
  // GAIA seam (plan benchmark-suite-gaia-2026-06-17): when engaged, swap clone → GAIA scratch dir, member
  // blueprint → `gaia-agent`, the brief → the question + answer.txt instruction, and extract → `answer.txt`
  // (the THREE SWAPS). Everything else (FIFO routing, cost-read, never-throw) is unchanged. Per-task briefs
  // are stored by instanceId so the FIFO place gets the right one.
  const gaiaMode = opts.gaia?.enabled === true;
  const gaiaBriefByInstance = new Map<string, string>();

  // Ensure the environment variables are set for the directive + model pinning (D-020 fix).
  const BENCH_BEE_DIRECTIVE = [
    'You are placed on a single-task benchmark member harness. This member holds EXACTLY ONE feature work-item —',
    'the benchmark problem to solve. Claim it (`work_items:claim_next` for this harness, or',
    '`fleet:assignments { agent: <your spawn id> }` then `work_items:get` for the detail), read its full',
    'problem_statement, and IMPLEMENT the change directly in this repository as real code edits (a working',
    'unified diff against the checked-out base). Write the actual source fix — do not just plan or describe.',
    'When complete and the repo builds, mark the work-item complete (`work_items:complete`). You are NOT',
    'taskless — the assigned feature IS your task; do not exit FAILED for "no work". There is no',
    'validator/reviewer downstream; you own the fix end to end.',
  ].join(' ');

  if (process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE == null) process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE = BENCH_BEE_DIRECTIVE;
  if (process.env.PAPERCUSP_FLEET_SANDBOX == null) process.env.PAPERCUSP_FLEET_SANDBOX = '0';
  if (process.env.PAPERCUSP_SPAWN_BACKEND == null) process.env.PAPERCUSP_SPAWN_BACKEND = 'claude-code';
  if (process.env.AGENT_CMD == null && process.env.CLAUDE == null) process.env.AGENT_CMD = 'claude -p';

  // Build the hive slug prefix for tracking (like realQueenBacklogOps does).
  let hivePrefix = '';
  const instanceByFeatureId = new Map<string, string>();
  const memberSlugToFeatureId = new Map<string, string>();

  const sqlClient = async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    return getOrgPg().sql;
  };

  const liveOps = async () => {
    const { liveHiveOps } = await import('../pot-eval/live-ops');
    return liveHiveOps({ workspaceId: ws });
  };

  const memberSlugForTask = (prefix: string, instanceId: string): string => `${prefix}-${instanceId.substring(0, 20)}`;
  const featureIdForTask = (instanceId: string): string => `xbench-${instanceId}`;

  return {
    now: () => Date.now(),

    async concurrencyCap() {
      const { spawnConcurrencyCeiling } = await import('../fleet/operator-spawn');
      return spawnConcurrencyCeiling();
    },

    async createHive({ runId, workspaceId }) {
      // Create a temporary shared hive for this run (ONE hive, multiple member enrollments per task).
      // The hive is created LOCALLY; the FIFO spawn routes through :3170 so bees get proper env + work-items.
      const { nanoid } = await import('nanoid');
      hivePrefix = `xbench-su-${nanoid(6)}`;

      const ops = await liveOps();
      await ops.createHive({ slug: hivePrefix, workspaceId: ws });
      return { potSlug: hivePrefix };
    },

    async prepareTask({ task }) {
      let checkout;
      if (gaiaMode) {
        // GAIA SWAP 1: no repo to clone — a scratch git dir with the optional attachment staged in.
        const { gaiaCloneTask } = await import('./gaia-backlog-support');
        checkout = await gaiaCloneTask(task);
      } else {
        const { cloneTaskRepo } = await import('./clone');
        checkout = await cloneTaskRepo(task);
      }
      const enrolled: SuIndependentEnrolled = {
        task,
        clonePath: checkout.dir,
        checkout,
        agentId: null,
        startedAtMs: null,
        finishedAtMs: null,
      };
      return enrolled;
    },

    async enrollTask({ task, enrolled, potSlug, workspaceId }) {
      // Enroll the task as a temporary member harness in the hive with a seeded feature.
      // Mirrors the realqueenBacklogOps.enrollTask pattern.
      const member = memberSlugForTask(hivePrefix, task.instanceId);
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { stringify: stringifyYaml } = await import('yaml');

      // GAIA SWAP 2 (blueprint): the member runs the general-assistant `gaia-agent` blueprint, NOT the
      // coding spine `external-bench`. Write the member's .papercusp/blueprint.yaml accordingly.
      let memberBlueprint = 'external-bench';
      let featureSpec = task.problemStatement;
      if (gaiaMode) {
        const { GAIA_MEMBER_BLUEPRINT, gaiaBrief } = await import('./gaia-backlog-support');
        memberBlueprint = GAIA_MEMBER_BLUEPRINT;
        featureSpec = gaiaBrief(task); // the question + the answer.txt instruction (the work-item brief)
        gaiaBriefByInstance.set(task.instanceId, featureSpec);
      }
      const bpDir = join(enrolled.checkout.dir, '.papercusp');
      await mkdir(bpDir, { recursive: true });
      await writeFile(
        join(bpDir, 'blueprint.yaml'),
        stringifyYaml({ id: member, extends: memberBlueprint }, { lineWidth: 100 }),
        'utf8',
      );

      // Register the member with the hive.
      const ops = await liveOps();
      await ops.registerMember({ member, clonePath: enrolled.checkout.dir, hiveHome: potSlug, workspaceId });

      // Seed the single feature (the problem statement, or the GAIA question+answer.txt brief).
      const featureId = featureIdForTask(task.instanceId);
      await ops.seedFeature({
        member,
        featureId,
        title: task.problemStatement.slice(0, 200),
        spec: featureSpec,
        workspaceId: ws,
      });

      // Pin the feature's workspace_id (fill_ws_features trigger derives default; placed bee claims visible ones only).
      const sql = await sqlClient();
      await sql`
        UPDATE harness_shared.harness_features_consolidated
           SET workspace_id = ${ws}, updated_ts = ${Date.now()}
         WHERE harness_slug = ${member} AND feature_id = ${featureId}`;

      instanceByFeatureId.set(featureId, task.instanceId);
      memberSlugToFeatureId.set(member, featureId);
      return { memberSlug: member };
    },

    async placeFifoBatch({ potSlug, memberSlug, workspaceId }) {
      // The su-independent arm needs ONE fresh dedicated spawn per task. It places via
      // **fleet:place_batch** (the palette-eligible placement tool — cup:spawn is NOT runnable
      // through the run-tool palette: 403 not_palette_eligible) but FORCES a fresh spawn — never a
      // warm-inject onto an existing fleet bee — with `min_inject_affinity: 100` (the max; no bee
      // clears it, so every task fresh-spawns). The run-tool response wraps the tool payload in
      // `result.content[0].text` (a JSON string), NOT a flat `result.placements` — the old code read
      // the flat path, always got undefined, and threw "returned no spawn" even though place_batch
      // HAD spawned (realqueen tolerates this because its collectTask polls feature status; we hard-
      // depend on the spawn_id). Parse the wrapper. Route via PAPERCUSP_OPERATOR_BASE=http://localhost:3170
      // (STAGING — where bench code + fixes live; the default :3070 is the GREEN release and lags).
      const { loopbackFetch, readJsonBody } = await import('../loopback-fetch');
      const { operatorApiBase } = await import('../operator-api-base');

      const featureId = memberSlugToFeatureId.get(memberSlug);
      if (!featureId) throw new Error(`Cannot find feature id for member ${memberSlug}`);

      // GAIA SWAP 2 (brief): the placed bee gets the GAIA question + answer.txt instruction, NOT the coding
      // directive. The per-task brief was stored at enroll time keyed by instanceId.
      const instanceId = instanceByFeatureId.get(featureId);
      const brief = gaiaMode
        ? (instanceId ? gaiaBriefByInstance.get(instanceId) : undefined) ?? ''
        : process.env.PAPERCUSP_XBENCH_CUP_DIRECTIVE ?? process.env.PAPERCUSP_XBENCH_BEE_DIRECTIVE /* legacy env name — dual-accept until callers migrate */ ?? '';

      const toolUrl = `${operatorApiBase()}/api/agent-mcp/run-tool`;
      // RETRY (2026-06-17): under concurrent enrollment (cap>1), place_batch can fire before :3170's
      // in-memory harness registry has caught up to enrollTask's `registerMember` (a cross-process
      // consistency race) → "harness X is not a registered harness" / no-spawn. The single-bee probe
      // never raced; cap=8 produced a wave of these. Retry with a short backoff so the registry catches
      // up. Idempotent: a member with min_inject_affinity:100 + its lone feature only ever fresh-spawns
      // ONE bee, and a successful spawn returns immediately (so a retry only happens when none was placed).
      let lastErr = '';
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const res = await loopbackFetch(toolUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: 'fleet:place_batch',
              args: {
                tasks: [featureId],
                harness: memberSlug,
                brief,
                tier: process.env.XBENCH_TIER || 'max', // default 'max' (opus:xhigh); XBENCH_TIER pins a specific model tier (e.g. 'opus46' for a fair same-model comparison)
                min_inject_affinity: 100, // never warm-inject — the independent arm needs a FRESH isolated spawn
                workspace: ws,
                dry_run: false,
              },
            }),
          });
          if (!res.ok) {
            lastErr = `HTTP ${res.status} ${await res.text().catch(() => '')}`;
          } else {
            // run-tool wraps a tool's MCP return as { ok, result: { content: [{ text: "<json>" }] } };
            // unwrap to the tool payload { ok, surveyed, placements, summary }. Tolerate a flat result too.
            const toolResult = await readJsonBody<{ ok: boolean; result?: unknown; error?: string }>(res, toolUrl);
            if (!toolResult.ok) {
              lastErr = `tool error: ${toolResult.error}`;
            } else {
              const wrapped = toolResult.result as { content?: Array<{ text?: string }> } | undefined;
              let payload: { placements?: Array<{ action?: string; spawn_id?: string | null; bee?: string }> } =
                (toolResult.result as Record<string, unknown>) ?? {};
              const text = wrapped?.content?.[0]?.text;
              if (typeof text === 'string') {
                try {
                  payload = JSON.parse(text);
                } catch {
                  /* keep the flat result */
                }
              }
              const placement = (payload.placements ?? [])[0];
              if (placement && placement.spawn_id) return { spawnId: placement.spawn_id };
              lastErr = `no spawn (action=${placement?.action ?? 'none'})`;
            }
          }
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
        if (attempt < 5) await new Promise<void>((r) => { const t = setTimeout(r, 3000); t.unref?.(); });
      }
      throw new Error(`fleet:place_batch failed for ${memberSlug} after retries — last: ${lastErr}`);
    },

    async collectTask({ task, spawnId, enrolled, workspaceId }) {
      // Collect the result from the spawned bee: extract diff + sum cost from agent_usage_samples + feature status.
      // Mirrors realqueenBacklogOps.collectTask pattern.
      const { extractDiff } = await import('./clone');
      const { readMemberUsage, readMemberBeeSpawns, stopReasonForFeatureStatus } = await import('./hive-backlog-live');
      const sql = await sqlClient();
      const member = memberSlugForTask(hivePrefix, task.instanceId);
      const featureId = memberSlugToFeatureId.get(member) ?? featureIdForTask(task.instanceId);

      // WAIT for the bee to finish before reading its work product. The bench bee runs ASYNC after
      // placeFifoBatch; UNLIKE the real-Queen arm (whose DRIVER polls until drained before collecting),
      // this arm calls collectTask straight after placement — so collect MUST poll the spawn to a terminal
      // state itself. Without it, collect read an in-progress task → empty diff + $0 + 'infra-failed' while
      // the bee was still working, orphaning a live opus bee (observed 2026-06-17, the verification-probe
      // $0 fails). Bounded by a per-task ceiling; the bee's own INVOKE_TIMEOUT terminates the spawn first.
      {
        const deadline = Date.now() + 45 * 60 * 1000;
        for (;;) {
          const rows = await sql<{ status: string }[]>`
            SELECT status FROM harness_shared.spawned_agents
             WHERE workspace_id = ${ws} AND spawn_id = ${spawnId} LIMIT 1`.catch(() => [] as { status: string }[]);
          const st = rows[0]?.status ?? null;
          if (st === 'done' || st === 'failed' || st === 'cancelled') break;
          if (Date.now() >= deadline) break;
          await new Promise<void>((r) => {
            const t = setTimeout(r, 5000);
            t.unref?.();
          });
        }
      }

      // Extract the work product. GAIA SWAP 3: read `answer.txt` (the qa answer) instead of the git diff.
      let diff = '';
      let answer: string | undefined;
      let generationError: string | undefined;
      if (gaiaMode) {
        const { extractGaiaAnswer } = await import('./gaia-backlog-support');
        answer = await extractGaiaAnswer(enrolled.checkout); // never throws; '' when no answer.txt
      } else {
        try {
          diff = await extractDiff(enrolled.checkout, task);
        } catch (e) {
          generationError = `extractDiff failed: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      // Read cost + bee spawn info from the member harness.
      const cost = await readMemberUsage(sql, member, ws).catch(() => ({ tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0 }));
      const spawnRows = await readMemberBeeSpawns(sql, member, ws).catch(() => []);

      // Read the feature's terminal status.
      const featRows = await sql<{ status: string }[]>`
        SELECT status FROM harness_shared.harness_features_consolidated
         WHERE workspace_id = ${ws} AND harness_slug = ${member} AND feature_id = ${featureId}
         LIMIT 1`;
      const featureStatus = featRows[0]?.status ?? null;
      const stopReason = stopReasonForFeatureStatus(featureStatus, generationError);

      // Build the telemetry from the actual spawn data.
      const firstSpawn = spawnRows[0];
      const agentId = spawnId;
      const startedAtMs = firstSpawn?.startedAtMs ?? enrolled.startedAtMs ?? Date.now();
      const finishedAtMs = firstSpawn?.finishedAtMs ?? enrolled.finishedAtMs ?? Date.now();
      const wallClockMs = Math.max(0, finishedAtMs - startedAtMs);

      return {
        diff,
        // GAIA SWAP 3: thread the extracted answer.txt body onto the outcome → ArmAttempt.answer (the qa
        // submission). Without this the extract ran (the answer was read) but was DROPPED here, so the
        // launcher saw answerLen=0 / 'infra-failed' even on a perfectly-answered task (observed 2026-06-17).
        ...(answer != null ? { answer } : {}),
        telemetry: {
          tokensIn: cost.tokensIn,
          tokensOut: cost.tokensOut,
          costUsd: cost.costUsd,
          turns: cost.turns,
          wallClockMs,
          trajectoryRef: `xbench-su-independent://${member}`,
          stopReason,
          ...(generationError ? { generationError } : {}),
        },
        agentId,
      };
    },

    async teardownMember({ memberSlug, workspaceId }) {
      // Drop the member harness enrollment (best-effort).
      const ops = await liveOps();
      await ops.dropMember({ member: memberSlug, workspaceId }).catch(() => {});
    },

    async teardownTask({ enrolled }) {
      // Tear down the task's scratch checkout (best-effort).
      await enrolled.checkout.cleanup().catch(() => {});
    },

    async dissolveHive({ potSlug, workspaceId }) {
      // Dissolve the temporary shared hive (best-effort).
      const ops = await liveOps();
      await ops.dissolveHive({ hiveHome: potSlug, workspaceId }).catch(() => {});
    },
  };
}

/** Derive a stable agent id from the bench-harness trajectoryRef (`xbench://<slug>`), else the instanceId. */
function trajectoryAgentId(trajectoryRef: string, instanceId: string): string {
  const m = /^xbench:\/\/(.+)$/.exec(trajectoryRef);
  return m?.[1] ?? (trajectoryRef || instanceId);
}

export type { ConcurrencyTimeline } from './hive-backlog';
