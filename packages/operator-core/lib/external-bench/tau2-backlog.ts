/**
 * tau2-backlog.ts — the τ²-bench (tau2-bench) capability-INJECTION backlog driver
 * (plan benchmark-capability-injection-redesign-2026-06-17; P-009).
 *
 * τ²-bench is a conversational tool-agent benchmark: one agent ↔ a simulated user, scored by a per-trial
 * REWARD ∈ [0,1] (1 = the task's goal state was reached). Like the METR HCAST / TheAgentCompany / PaperBench
 * drivers, this wraps the SAME generic shell ({@link makePoolBacklogDriver}: bounded concurrency pool +
 * live-occupancy {@link ConcurrencyTimeline} + the never-throw drain) so τ²-bench emits the canonical
 * {@link HiveBacklogResult} and flows through the identical {@link runHiveBacklog} dispatch + downstream fleet
 * metrics (`toFleetRunSummary` → `@papercusp/bench-metrics buildHiveReport`) as every other suite.
 *
 * THE ARMS — capability injection, NOT topology (plan D-001). τ²-bench is turn-driven: a "spine of roles"
 * doesn't map to "produce one turn", so the old fake `papercup_hive` / `su=llm_agent` topology arms were
 * degenerate by construction and are DELETED. The arms are now:
 *   - 'vanilla'  → the stock agent with DOMAIN tools only (the bare-model reference).
 *   - '+memory'  → the SAME agent + a private memory side-channel (memory_search / memory_remember backed by
 *                  the REAL `memory:*` MCP verbs), scoped to a per-run sandbox hive whose pool ACCUMULATES
 *                  across all tasks in the run (D-007): learn a policy on task A, recall it on task B. THAT
 *                  cross-task learning is the lift we measure (it dissolves the single-turn degeneracy).
 *
 * THE MECHANISM. Both arms run the vendored Python `papercup_mem` agent (src/tau2/agent/papercup_mem_agent.py).
 * The agent enables memory ONLY when `TAU2_PC_MEMORY_HIVE` is set, so the ARM selects capability purely via
 * env: '+memory' opens a {@link RunSandbox} (reusing {@link openRunSandbox} from capabilities/ — the per-run
 * ephemeral hive whose `potSlug` is the shared memory namespace) ONCE per (suite-run × arm) and passes
 * `TAU2_PC_MEMORY_HIVE=<sandbox.potSlug>` (+ operator base + superuser token) to every `tau2 run` for that
 * arm; 'vanilla' passes no hive env, so the SAME agent degrades to a stock LLMAgent. The sandbox is disposed
 * at arm end (memory wiped — never leaks to production or between arms).
 *
 * WORK-SURFACE: there is no worktree/diff. Each task is one agent↔user-simulator conversation against the
 * vendored PYTHON harness (`~/.papercusp/bench-harnesses/tau2-bench`, driven via `pc_run.sh`). The score is
 * the harness's own per-trial `reward_info.reward`. The per-task work shells out to the harness, then reads
 * `data/simulations/<save-to>/results.json` and carries reward + cost on `attempt.armMeta` — the METR HCAST
 * armMeta round-trip pattern.
 *
 * DEPENDENCY INJECTION: the shell-out + results parsing is one injected seam ({@link Tau2BacklogDeps.runConversation}),
 * defaulting to the real Python invocation ({@link realRunTau2Conversation}) but STUBBABLE in the test so a unit
 * test asserts the pool contract / FleetTaskResult shape / arm switching / round-trip with ZERO subprocess or
 * LLM calls. The sandbox lifecycle is likewise injected ({@link Tau2BacklogDeps.openSandbox}) so tests open no
 * real hive. Never throws (the generation-failure contract — an infra failure lands a non-scored error row).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetArmId } from '@papercusp/bench-metrics';
import { openRunSandbox, liveSandboxHiveOps, liveRunTool } from './capabilities';
import type { RunSandbox } from './capabilities';
import { resolveBenchWorkspace } from './bench-workspace';
import type { HiveBacklogDriver, HiveBacklogResult, FleetTaskResult } from './hive-backlog';
import { makePoolBacklogDriver } from './hive-backlog-utilities';
import { operatorApiBase } from '../operator-api-base';
import type { ArmAttempt, BenchTask, GenerationBudget, GenerationStopReason } from './types';

/** The τ²-bench blueprint id stamped on the attempt row (the conversational tool-agent suite). */
export const TAU2_BLUEPRINT_ID = 'tau2-bench';

/** The two capability-injection arms this driver runs (plan D-001): bare model vs +memory. */
export const TAU2_VANILLA_ARM: FleetArmId = 'vanilla';
export const TAU2_MEMORY_ARM: FleetArmId = '+memory';

/** The ISOLATED workspace every tau2 benchmark memory call lives in — the dedicated `benchmarks` workspace
 *  (or an XBENCH_WORKSPACE_ID override), NEVER production (resolveBenchWorkspace REFUSES the prod workspace).
 *  The old prod default polluted real `papercup` recall with the +memory arm's per-run memories (the owner-
 *  flagged 287-memory leak; plan benchmark-workspace-isolation-2026-06-18). */
const TAU2_WORKSPACE = resolveBenchWorkspace(process.env.XBENCH_WORKSPACE_ID);

/** The single vendored tau2 `--agent` (src/tau2/registry.py): a stock LLMAgent + an opt-in memory side-channel
 *  enabled only when `TAU2_PC_MEMORY_HIVE` is set, so ONE agent serves BOTH arms (the arm = the env it gets). */
export const TAU2_AGENT = 'papercup_mem';

/** True when `arm` is the +memory injection arm (the only arm that opens a sandbox + passes the hive env). */
export function tau2ArmHasMemory(arm: FleetArmId): boolean {
  return String(arm) === TAU2_MEMORY_ARM;
}

/** The settled outcome of ONE tau2 conversation — the suite-specific seam {@link makeTau2BacklogDriver}
 *  injects. MUST be never-throw: on any infra/transport failure return `{ stopReason: 'infra-failed', error }`
 *  with reward null, NOT an exception (the never-throw generation contract; downstream excludes it). */
export interface Tau2ConversationResult {
  /** The harness's per-trial reward ∈ [0,1] (1 = goal reached); null on an infra failure (non-scored). */
  reward: number | null;
  /** $ the agent side spent (results.json `agent_cost`). */
  agentCostUsd: number;
  /** $ the user-simulator side spent (results.json `user_cost`). */
  userCostUsd: number;
  /** Why the conversation stopped — a resolved/normal finish → 'done'; an infra/transport failure → 'infra-failed'. */
  stopReason: GenerationStopReason;
  /** Infra failure detail (only on a non-scored terminal). */
  error?: string;
  /** Provenance for the row (the save-to dir / trajectory ref), when the run produced one. */
  trajectoryRef?: string;
}

/**
 * The +memory sandbox context threaded into each conversation: the hive slug (the shared memory namespace)
 * the `+memory` arm's `papercup_mem` agent scopes its `memory:*` calls to, plus the operator base + bearer the
 * Python agent's MCP POST uses. `null` for the `vanilla` arm (no memory → the agent degrades to stock).
 */
export interface Tau2MemoryContext {
  /** The ephemeral-hive slug the sandbox opened — TAU2_PC_MEMORY_HIVE for the Python agent. */
  potSlug: string;
  /** The operator API base the Python MCP POST targets — TAU2_PC_OPERATOR_BASE. */
  operatorBase: string;
  /** The superuser bearer — TAU2_PC_OPERATOR_TOKEN (the Python agent also falls back to ~/.papercusp/superuser-token). */
  token: string;
}

/** The injected per-conversation work: run ONE tau2 conversation for `task` on `arm`. Defaults to the real
 *  Python invocation ({@link realRunTau2Conversation}); the test injects a fake so no subprocess/LLM runs.
 *  `memory` is the +memory arm's sandbox context (null for vanilla). */
export type RunTau2Conversation = (input: {
  task: BenchTask;
  arm: FleetArmId;
  seed: string;
  budget: GenerationBudget;
  memory: Tau2MemoryContext | null;
}) => Promise<Tau2ConversationResult>;

/** Open the per-(suite-run × arm) {@link RunSandbox} for the +memory arm. Defaults to {@link realOpenSandbox}
 *  (a real ephemeral hive via {@link openRunSandbox}); the test injects a fake so no hive boots. Returns null
 *  for an arm that needs no sandbox (vanilla). */
export type OpenTau2Sandbox = (input: { arm: FleetArmId; runId: string }) => Promise<RunSandbox | null>;

export interface Tau2BacklogDeps {
  now?: () => number;
  /** The fleet concurrency cap (= the global `maxSimultaneousAgents`). */
  concurrencyCap: () => number | Promise<number>;
  /** The conversation seam (default {@link realRunTau2Conversation} — the vendored Python harness). */
  runConversation?: RunTau2Conversation;
  /** The sandbox-open seam (default {@link realOpenSandbox} — a real ephemeral hive for the +memory arm). */
  openSandbox?: OpenTau2Sandbox;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  /** Fired the instant each conversation settles → durability (a partial/killed run still banks its rows). */
  onTaskCollected?: (r: Tau2ConversationResult, task: BenchTask) => void | Promise<void>;
}

/**
 * Map one settled {@link Tau2ConversationResult} → the canonical {@link FleetTaskResult}, carrying the
 * reward/score/resolved + the per-side cost on `attempt.armMeta` so BOTH the fleet metrics and the τ²-bench
 * round-trip ({@link tau2TaskResultsFromFleet}) read it from the canonical fleet output. A resolved/normal
 * finish → stopReason 'done'; an infra failure → the conversation's non-scored terminal (reward null, excluded).
 */
function toFleetTaskResult(
  r: Tau2ConversationResult,
  task: BenchTask,
  arm: FleetArmId,
  seed: string,
  placedAtMs: number,
  startedAtMs: number,
  finishedAtMs: number,
): FleetTaskResult {
  const resolved = r.reward === null ? null : r.reward === 1;
  const costUsd = r.agentCostUsd + r.userCostUsd;
  const attempt: ArmAttempt = {
    arm: String(arm),
    blueprintId: TAU2_BLUEPRINT_ID,
    instanceId: task.instanceId,
    seed,
    diff: '', // conversational suite: there is no diff
    tokensIn: 0,
    tokensOut: 0,
    costUsd,
    turns: 0,
    wallClockMs: Math.max(0, finishedAtMs - startedAtMs),
    trajectoryRef: r.trajectoryRef ?? '',
    stopReason: r.stopReason,
    ...(r.error ? { generationError: r.error } : {}),
    armMeta: {
      suite: 'tau2-bench',
      agent: TAU2_AGENT,
      memory: tau2ArmHasMemory(arm), // attribution: which arm had the +memory capability
      reward: r.reward,
      score: r.reward, // for a single trial the reward IS the score
      resolved,
      agentCostUsd: r.agentCostUsd,
      userCostUsd: r.userCostUsd,
    },
  };
  return {
    attempt,
    cupId: r.trajectoryRef || `tau2-${task.instanceId}-${seed}`,
    placedAtMs,
    startedAtMs,
    finishedAtMs,
    disposition: 'spawn',
  };
}

/**
 * Build the τ²-bench {@link HiveBacklogDriver} for ONE arm. The generic shell ({@link makePoolBacklogDriver})
 * owns the sampler + pool + canonical-output projection; τ²-bench supplies ONLY its per-task work (run one
 * conversation → reward → FleetTaskResult). For the `+memory` arm the driver opens a {@link RunSandbox} ONCE
 * for the whole run (the memory pool ACCUMULATES across tasks — D-007) and threads its context into every
 * conversation; it disposes the sandbox after the backlog drains. `vanilla` opens no sandbox.
 *
 * Never throws — {@link RunTau2Conversation} is itself never-throw (an infra failure becomes a non-scored
 * result, not an exception); a defensive catch here also degrades to an infra-failed row. The sandbox open
 * is best-effort: if it fails, the arm runs WITHOUT memory (degrades to stock) rather than aborting the run.
 */
export function makeTau2BacklogDriver(deps: Tau2BacklogDeps): HiveBacklogDriver {
  const now = deps.now ?? (() => Date.now());
  const runConversation = deps.runConversation ?? realRunTau2Conversation;
  const openSandbox = deps.openSandbox ?? realOpenSandbox;

  const inner = makePoolBacklogDriver({
    now,
    concurrencyCap: () => deps.concurrencyCap(),
    fleetTimeoutMs: deps.fleetTimeoutMs,
    sampleIntervalMs: deps.sampleIntervalMs,
    perTask: async ({ task, arm, seed, budget }): Promise<FleetTaskResult> => {
      const memory = currentMemoryContext;
      const placedAtMs = now();
      const startedAt = now();
      let r: Tau2ConversationResult;
      try {
        r = await runConversation({ task, arm, seed, budget, memory });
      } catch (e) {
        // Defensive: runConversation is contractually never-throw, but a thrown error still degrades to a
        // non-scored infra row rather than escaping perTask (the never-throw pool contract).
        r = { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: e instanceof Error ? e.message : String(e) };
      }
      const finishedAt = now();
      await Promise.resolve(deps.onTaskCollected?.(r, task)).catch(() => {});
      return toFleetTaskResult(r, task, arm, seed, placedAtMs, startedAt, finishedAt);
    },
  });

  // The per-run sandbox context, shared by every task in the run via the closure above. Opened once per
  // run() and torn down after the backlog drains, so the +memory pool accumulates across all tasks (D-007).
  let currentMemoryContext: Tau2MemoryContext | null = null;

  return {
    async run(req): Promise<HiveBacklogResult> {
      let sandbox: RunSandbox | null = null;
      if (tau2ArmHasMemory(req.arm)) {
        try {
          sandbox = await openSandbox({ arm: req.arm, runId: req.runId });
          if (sandbox) currentMemoryContext = memoryContextFor(sandbox);
        } catch {
          // Sandbox boot failed → run the +memory arm WITHOUT memory (degrades to stock) rather than abort.
          sandbox = null;
          currentMemoryContext = null;
        }
      }
      try {
        return await inner.run(req);
      } finally {
        currentMemoryContext = null;
        if (sandbox) await sandbox.dispose().catch(() => {});
      }
    },
  };
}

/** Build the Python-agent memory context (env values) from an open sandbox. */
function memoryContextFor(sandbox: RunSandbox): Tau2MemoryContext {
  return {
    potSlug: sandbox.potSlug,
    operatorBase: operatorApiBase(),
    token: '', // resolved lazily in realRunTau2Conversation (falls back to ~/.papercusp/superuser-token)
  };
}

/** One arm's outcome from {@link runTau2SuiteViaFleet}: the canonical fleet record for that arm. */
export interface Tau2FleetArmResult {
  fleetArm: FleetArmId;
  result: HiveBacklogResult;
}

/** The full multi-arm τ²-bench run THROUGH the shared fleet contract — one canonical record per arm. */
export interface Tau2FleetRunResult {
  fleet: Tau2FleetArmResult[];
}

/**
 * Run the multi-arm τ²-bench suite THROUGH the canonical {@link HiveBacklogDriver} fleet contract — each fleet
 * arm ({vanilla, +memory}) runs its own {@link makeTau2BacklogDriver} over the SAME backlog; an optional
 * `runConversationFor(arm)` binds that arm's conversation seam (default: the shared real Python invocation).
 * Returns the canonical {@link HiveBacklogResult} per arm; the per-task reward/score rides `attempt.armMeta`
 * for {@link tau2TaskResultsFromFleet} + the standard fleet rollup.
 */
export async function runTau2SuiteViaFleet(input: {
  tasks: BenchTask[];
  /** Fleet arms to run (default both: vanilla + +memory). */
  arms?: FleetArmId[];
  now?: () => number;
  concurrencyCap: () => number | Promise<number>;
  /** Per-arm conversation seam (default {@link realRunTau2Conversation} for every arm). */
  runConversationFor?: (arm: FleetArmId) => RunTau2Conversation;
  /** Per-arm sandbox-open seam (default {@link realOpenSandbox}). */
  openSandboxFor?: (arm: FleetArmId) => OpenTau2Sandbox;
  runId?: string;
  seed?: number;
  budget?: GenerationBudget;
  fleetTimeoutMs?: number;
  sampleIntervalMs?: number;
  onTaskCollected?: (fleetArm: FleetArmId, r: Tau2ConversationResult, task: BenchTask) => void | Promise<void>;
  onArmDone?: (arm: Tau2FleetArmResult) => void | Promise<void>;
}): Promise<Tau2FleetRunResult> {
  const arms = input.arms ?? [TAU2_VANILLA_ARM, TAU2_MEMORY_ARM];
  const runId = input.runId ?? 'tau2-fleet';
  const seed = input.seed ?? 0;
  const budget = input.budget ?? {};

  const fleet: Tau2FleetArmResult[] = [];
  for (const arm of arms) {
    const driver = makeTau2BacklogDriver({
      now: input.now,
      concurrencyCap: input.concurrencyCap,
      runConversation: input.runConversationFor?.(arm),
      openSandbox: input.openSandboxFor?.(arm),
      fleetTimeoutMs: input.fleetTimeoutMs,
      sampleIntervalMs: input.sampleIntervalMs,
      onTaskCollected: (r, task) => input.onTaskCollected?.(arm, r, task),
    });
    const result = await driver.run({ arm, suite: 'tau2-bench', runId, seed, backlog: input.tasks, budget });
    const armResult: Tau2FleetArmResult = { fleetArm: arm, result };
    fleet.push(armResult);
    await Promise.resolve(input.onArmDone?.(armResult)).catch(() => {});
  }
  return { fleet };
}

/** One τ²-bench task's reconstructed result (read off the canonical fleet output via `attempt.armMeta`). */
export interface Tau2TaskResult {
  instanceId: string;
  arm: string;
  seed: string;
  /** The per-trial reward ∈ [0,1]; null on a non-scored (infra) row. */
  reward: number | null;
  /** Alias of `reward` for the single trial (the score the suite headline averages). */
  score: number | null;
  /** reward === 1; null when the reward is null (infra-failed). */
  resolved: boolean | null;
  agentCostUsd: number;
  userCostUsd: number;
  stopReason: GenerationStopReason;
}

/** The τ²-bench suite rollup over a single trial: per-task results + avg_reward + pass^1 (the fraction
 *  resolved over SCORED rows — non-scored/infra rows are excluded, mirroring the fairness predicate). */
export interface Tau2SuiteResult {
  arm: string;
  tasks: Tau2TaskResult[];
  /** Mean reward over SCORED rows (reward !== null); 0 when no scored rows. */
  avgReward: number;
  /** pass^1 over the single trial = fraction of SCORED rows with reward === 1; 0 when no scored rows. */
  passHat1: number;
  /** Count of scored rows (reward !== null) — the denominator for avgReward / passHat1. */
  scoredCount: number;
}

/**
 * Reconstruct the τ²-bench per-task results + suite rollup from a canonical {@link HiveBacklogResult} (the
 * reward/score/resolved ride `attempt.armMeta`), so the suite headline (avg_reward, pass^1) runs off the same
 * fleet output the standard metrics consume — one run, both metric families. Mirrors
 * `metrHcastTaskResultsFromFleet`: a pure read of `attempt.armMeta`, no recompute.
 */
export function tau2TaskResultsFromFleet(result: HiveBacklogResult): Tau2SuiteResult {
  const tasks: Tau2TaskResult[] = result.taskResults.map((t): Tau2TaskResult => {
    const meta = t.attempt.armMeta ?? {};
    const reward = typeof meta['reward'] === 'number' ? (meta['reward'] as number) : null;
    const resolved = typeof meta['resolved'] === 'boolean' ? (meta['resolved'] as boolean) : null;
    return {
      instanceId: t.attempt.instanceId,
      arm: t.attempt.arm,
      seed: t.attempt.seed,
      reward,
      score: reward,
      resolved,
      agentCostUsd: typeof meta['agentCostUsd'] === 'number' ? (meta['agentCostUsd'] as number) : 0,
      userCostUsd: typeof meta['userCostUsd'] === 'number' ? (meta['userCostUsd'] as number) : 0,
      stopReason: t.attempt.stopReason,
    };
  });
  const scored = tasks.filter((t) => t.reward !== null);
  const scoredCount = scored.length;
  const avgReward = scoredCount > 0 ? scored.reduce((s, t) => s + (t.reward ?? 0), 0) / scoredCount : 0;
  const passHat1 = scoredCount > 0 ? scored.filter((t) => t.reward === 1).length / scoredCount : 0;
  return { arm: String(result.arm), tasks, avgReward, passHat1, scoredCount };
}

/* -------------------------------------------------------------------------- */
/* The real (default) sandbox seam — a per-run ephemeral hive for +memory       */
/* -------------------------------------------------------------------------- */

/**
 * The REAL sandbox-open seam: for the `+memory` arm open a {@link RunSandbox} (a per-run ephemeral hive whose
 * `potSlug` is the shared memory namespace) via {@link openRunSandbox}, reusing the SAME `liveSandboxHiveOps`
 * + `liveRunTool` the capabilities palette uses. Returns null for any non-memory arm. The driver disposes it
 * after the backlog drains, so the memory pool ACCUMULATES across all tasks within the run (D-007), then is
 * wiped (never leaks to production or between arms).
 */
export const realOpenSandbox: OpenTau2Sandbox = async ({ arm, runId }) => {
  if (!tau2ArmHasMemory(arm)) return null;
  const workspaceId = TAU2_WORKSPACE;
  return openRunSandbox(
    { workspaceId, hiveOps: liveSandboxHiveOps(workspaceId), runTool: liveRunTool() },
    { suite: 'tau2-bench', arm: String(arm), runId },
  );
};

/* -------------------------------------------------------------------------- */
/* The real (default) conversation seam — the vendored Python harness          */
/* -------------------------------------------------------------------------- */

/** Where the vendored τ²-bench Python harness lives (driven via `pc_run.sh`). */
const TAU2_HARNESS_DIR = join(homedir(), '.papercusp', 'bench-harnesses', 'tau2-bench');
/** Default per-conversation wall-clock ceiling before the subprocess is hard-killed (ms). */
const DEFAULT_TAU2_CONVERSATION_TIMEOUT_MS = 30 * 60_000;

/** The slice of `data/simulations/<save-to>/results.json` we read (one simulation = one trial). */
interface Tau2ResultsJson {
  simulations?: { reward_info?: { reward?: number }; agent_cost?: number; user_cost?: number }[];
}

/** A `task.domain` (or `graderMeta.domain`) is required to address a tau2 run; fall back to a sane default. */
function tau2DomainForTask(task: BenchTask): string {
  const fromMeta = (task.graderMeta?.['domain'] ?? (task as unknown as { domain?: string }).domain) as unknown;
  return typeof fromMeta === 'string' && fromMeta.length > 0 ? fromMeta : 'telecom';
}

/** The specific tau2 task id to address (so distinct backlog tasks run DISTINCT tau2 tasks via `--task-ids`).
 *  `graderMeta.taskId` is the explicit channel; falls back to `instanceId`. Null ⇒ caller uses `--num-tasks 1`
 *  (the domain's first task). */
function tau2TaskIdForTask(task: BenchTask): string | null {
  const fromMeta = task.graderMeta?.['taskId'] as unknown;
  if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  if (typeof task.instanceId === 'string' && task.instanceId.length > 0) return task.instanceId;
  return null;
}

/**
 * The REAL conversation seam: shell out to the vendored Python harness for ONE trial of `task` on the
 * `papercup_mem` agent, then read the per-trial reward + cost from `data/simulations/<save-to>/results.json`.
 * The ARM selects capability via env: the `+memory` arm passes `TAU2_PC_MEMORY_HIVE` (+ operator base + token)
 * so the Python agent enables its memory side-channel; `vanilla` passes no hive env so the SAME agent degrades
 * to a stock LLMAgent. Env also carries the documented CC-framing + extended-thinking knobs
 * (TAU2_PAPERCUSP_CC_FRAMING=1, PC_REASONING=high). Never throws: a non-zero exit, a missing/garbled results
 * file, or a hard-kill timeout all degrade to a non-scored `{ reward: null, stopReason: 'infra-failed', error }`.
 *
 * NB this is the production path; the unit test injects a fake `runConversation`, so no subprocess/LLM runs there.
 */
export const realRunTau2Conversation: RunTau2Conversation = async ({ task, arm, memory }) => {
  const domain = tau2DomainForTask(task);
  const taskId = tau2TaskIdForTask(task);
  const saveTo = `tau2-${String(arm)}-${task.instanceId}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const resultsPath = join(TAU2_HARNESS_DIR, 'data', 'simulations', saveTo, 'results.json');

  // Drive via pc_run.sh (NOT raw `uv run tau2 run`): pc_run.sh sets --agent-llm/--user-llm + the gateway
  // api_base (:PC_GW_PORT) in --*-llm-args + TAU2_PAPERCUSP_CC_FRAMING — without it tau2 falls back to its
  // default OpenAI model and fails. Select the SPECIFIC task via --task-ids when known (so a multi-task
  // backlog runs distinct tasks), else --num-tasks 1 (the domain's first task). pc_run.sh passes "$@" through.
  const args = [
    'pc_run.sh',
    '--domain',
    domain,
    ...(taskId ? ['--task-ids', taskId] : ['--num-tasks', '1']),
    '--num-trials',
    '1',
    '--agent',
    TAU2_AGENT,
    '--save-to',
    saveTo,
  ];
  const env: Record<string, string> = {
    ...process.env,
    TAU2_PAPERCUSP_CC_FRAMING: '1',
    PC_REASONING: process.env.PC_REASONING ?? 'high',
    // PC_GW_PORT flows through from process.env (caller picks the gateway; pc_run.sh defaults to 8799).
  };
  // The +memory arm threads the sandbox hive + operator base + token so the Python agent's memory tools fire
  // (vanilla passes nothing → the agent's memory_enabled() is false → stock LLMAgent). Token falls back to
  // ~/.papercusp/superuser-token inside the Python agent when not provided here.
  if (memory) {
    env.TAU2_PC_MEMORY_HIVE = memory.potSlug;
    env.TAU2_PC_OPERATOR_BASE = memory.operatorBase;
    if (memory.token) env.TAU2_PC_OPERATOR_TOKEN = memory.token;
    // The ISOLATED benchmark workspace the Python agent writes its memories to — must MATCH the sandbox
    // hive's workspace (never production; the owner-flagged 287-memory leak, benchmark-workspace-isolation).
    env.TAU2_PC_WORKSPACE = TAU2_WORKSPACE;
  }

  const code = await new Promise<number>((resolve) => {
    const child = spawn('bash', args, { cwd: TAU2_HARNESS_DIR, env });
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TAU2_CONVERSATION_TIMEOUT_MS);
    child.on('close', (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
  });

  if (code !== 0) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: `tau2 run exited ${code}`, trajectoryRef: saveTo };
  }

  let parsed: Tau2ResultsJson;
  try {
    parsed = JSON.parse(await readFile(resultsPath, 'utf8')) as Tau2ResultsJson;
  } catch (e) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: `read results.json failed: ${e instanceof Error ? e.message : String(e)}`, trajectoryRef: saveTo };
  }
  const sim = parsed.simulations?.[0];
  const reward = typeof sim?.reward_info?.reward === 'number' ? sim.reward_info.reward : null;
  if (reward === null) {
    return { reward: null, agentCostUsd: 0, userCostUsd: 0, stopReason: 'infra-failed', error: 'no reward in results.json', trajectoryRef: saveTo };
  }
  return {
    reward,
    agentCostUsd: typeof sim?.agent_cost === 'number' ? sim.agent_cost : 0,
    userCostUsd: typeof sim?.user_cost === 'number' ? sim.user_cost : 0,
    stopReason: 'done',
    trajectoryRef: saveTo,
  };
};
