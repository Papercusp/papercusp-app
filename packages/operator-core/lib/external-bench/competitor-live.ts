/**
 * LIVE competitor drivers (impartial-benchmark-suite-2026-06-15 P-028/P-032, D-010). Binds the real
 * OpenHands / CrewAI / LangGraph orchestrators as fleet arms: for each backlog task, clone the repo @ base,
 * exec the framework's python runner (competitors/run_<fw>.py, in its venv) over the checkout, then extract
 * the diff via git (identical to every other arm → byte-fair grading), and assemble the canonical
 * {@link HiveBacklogResult} (per-task {@link ArmAttempt} + the MAST {@link CoordEvent} trace).
 *
 * Mirrors the SWE-bench-Pro grader's pattern (grader/swe-bench-pro.ts): a python harness invoked via a
 * configured interpreter, NOT vendored into the TS build. The venvs live outside the git tree
 * (~/.papercusp/competitors/{,openhands-}venv, installed at pilot-prep); the runner scripts ship in-tree
 * (./competitors/*.py) and are resolved relative to this module (env override PAPERCUSP_COMPETITOR_RUNNERS_DIR).
 *
 * `exec` is injected so the driver is unit-testable with a fake (no python, no LLM, no Opus spend). The actual
 * LLM-driven run is owner-gated (Opus capacity); the runners' `--selfcheck` validates wiring without it.
 */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CoordEvent } from '@papercusp/bench-metrics';
import { setCompetitorDriver, type CompetitorBacklogDriver } from './competitor-runner';
import { CORE_COMPETITOR_ARM_IDS, getCompetitor, type CompetitorArmId } from './competitor-registry';
import type { FleetTaskResult, HiveBacklogResult, HiveBacklogRunRequest } from './hive-backlog';
import type { ArmAttempt, BenchTask, CloneTaskRepo, ExtractDiff, GenerationStopReason, TaskCheckout } from './types';
import { gatewayPort, GATEWAY_BASE_URL_ENV, GATEWAY_SDK_URL_ENV } from '../inference-gateway/spawn-env';
import { PRIORITY_HEADER } from '../inference-gateway/gateway';

/** Must match `_common.py` RESULT_SENTINEL. */
export const RESULT_SENTINEL = '@@COMPETITOR_RESULT@@';

/**
 * FAIRNESS-CRITICAL (D-004): every arm — competitors included — runs claude-opus-4-8 @ xhigh via the SAME
 * localhost inference gateway the bees use, NOT the frameworks' default models. The base url reads the port
 * from spawn-env (never hardcoded); xhigh is realized as extended thinking at DEFAULT_THINKING_BUDGET_TOKENS
 * (the raw-API equivalent of the claude CLI's `--effort xhigh` — owner-confirmed).
 */
export const DEFAULT_COMPETITOR_MODEL = 'claude-opus-4-8';
export const DEFAULT_THINKING_BUDGET_TOKENS = 32000;

/** The localhost inference-gateway base url (port from spawn-env's gatewayPort(), env-overridable). */
export function gatewayBaseUrl(): string {
  return `http://127.0.0.1:${gatewayPort()}`;
}

/** Injected subprocess seam (default {@link defaultExec}); a fake returns canned runner JSON in tests. */
export type ExecFn = (
  bin: string,
  args: string[],
  stdin: string,
  opts: { timeoutMs: number; env?: Record<string, string> },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** The shape `_common.py` emits after the sentinel. */
export interface RunnerResult {
  ok: boolean;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  stopReason: GenerationStopReason;
  events: CoordEvent[];
  error: string | null;
}

export interface CompetitorDriverConfig {
  competitorId: CompetitorArmId;
  /** venv python interpreter. */
  pythonBin: string;
  /** absolute path to competitors/run_<fw>.py. */
  runnerScript: string;
  /** litellm-style model string, e.g. 'anthropic/claude-opus-4-8'. */
  model: string;
  /** Anthropic-compatible base url (the inference gateway) — same for every arm (fair routing). */
  baseUrl?: string | null;
  /** env var the runner reads the api key from (default ANTHROPIC_API_KEY). */
  apiKeyEnv?: string;
  /** Extended-thinking budget = the xhigh effort realization (default DEFAULT_THINKING_BUDGET_TOKENS). */
  thinkingBudgetTokens?: number;
  /** Max output tokens (default thinkingBudgetTokens + 16384; must exceed the thinking budget). */
  maxTokens?: number;
  /** agent iteration cap per task. */
  maxIterations?: number;
  /** per-task wall-clock ceiling (ms). */
  perTaskTimeoutMs?: number;
  /** backlog drain concurrency (default 1). */
  concurrency?: number;
  /** Gateway admission label. Defaults to the bounded benchmark/gym lane. */
  priority?: string;
  clone: CloneTaskRepo;
  extractDiff: ExtractDiff;
  exec?: ExecFn;
  now?: () => number;
  /** No-LLM wiring smoke: the runner constructs its agent/tools but makes no model call (zero Opus spend). */
  selfcheck?: boolean;
}

/** Real subprocess exec: spawn `bin args`, pipe `stdin`, collect stdout/stderr, hard-kill on timeout. */
export const defaultExec: ExecFn = (bin, args, stdin, opts) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, ...(opts.env ?? {}) } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: -1 });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(stdin);
    child.stdin.end();
  });

/** Parse the sentinel-delimited result from runner stdout (banners/logs before it are ignored). */
export function parseRunnerResult(stdout: string): RunnerResult | null {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) return null;
  const rest = stdout.slice(idx + RESULT_SENTINEL.length);
  const line = rest.split('\n', 1)[0].trim();
  try {
    return JSON.parse(line) as RunnerResult;
  } catch {
    return null;
  }
}

function infraAttempt(competitorId: string, task: BenchTask, seed: string, err: string): ArmAttempt {
  return {
    arm: competitorId,
    blueprintId: competitorId,
    instanceId: task.instanceId,
    seed,
    diff: '',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    wallClockMs: 0,
    trajectoryRef: '',
    stopReason: 'error',
    generationError: err,
  };
}

/** Bounded-concurrency map preserving input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Build a live {@link CompetitorBacklogDriver} for one framework. Each task: clone → exec the python runner
 * over the checkout → extract the git diff → build the ArmAttempt + tagged CoordEvents. Per-task failures
 * (clone/exec/parse) degrade to an infra-error attempt (excluded from accuracy), never aborting the backlog.
 */
export function makeCompetitorDriver(cfg: CompetitorDriverConfig): CompetitorBacklogDriver {
  const exec = cfg.exec ?? defaultExec;
  const now = cfg.now ?? Date.now;
  const concurrency = cfg.concurrency ?? 1;
  const timeoutMs = cfg.perTaskTimeoutMs ?? 30 * 60_000;
  const baseUrl = cfg.baseUrl ?? gatewayBaseUrl();
  const apiKeyEnv = cfg.apiKeyEnv ?? 'ANTHROPIC_API_KEY';
  const thinkingBudgetTokens = cfg.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET_TOKENS;
  const maxTokens = cfg.maxTokens ?? thinkingBudgetTokens + 16384;
  const priority = cfg.priority ?? 'benchmark';
  // Gateway routing env (belt + braces with the input JSON): litellm reads ANTHROPIC_API_BASE; the anthropic
  // SDK reads ANTHROPIC_BASE_URL; the gateway strips + reinjects real creds, so the key need only be SET.
  const gatewayEnv: Record<string, string> = {
    [GATEWAY_BASE_URL_ENV]: baseUrl,
    ANTHROPIC_API_BASE: baseUrl,
    [GATEWAY_SDK_URL_ENV]: baseUrl,
    ANTHROPIC_API_KEY: process.env[apiKeyEnv] ?? 'sk-gateway-routed',
    ANTHROPIC_CUSTOM_HEADERS: `${PRIORITY_HEADER}: ${priority}`,
  };

  /** Stamp every within-task event with its backlog task id (MAST attribution). */
  const tag = (events: CoordEvent[] | undefined, taskId: string): CoordEvent[] =>
    (events ?? []).map((e) => ({ ...e, taskId: e.taskId ?? taskId }));

  return {
    async run(req: HiveBacklogRunRequest): Promise<HiveBacklogResult> {
      const seed = `seed-${req.seed}`;
      const startedAtMs = now();

      const perTask = await mapLimit(
        req.backlog,
        concurrency,
        async (task): Promise<{ result: FleetTaskResult; events: CoordEvent[] }> => {
          const placedAtMs = now();
          const fail = (attempt: ArmAttempt, startedTaskMs: number, events: CoordEvent[]) => ({
            result: { attempt, cupId: cfg.competitorId, placedAtMs, startedAtMs: startedTaskMs, finishedAtMs: now(), disposition: 'spawn' as const },
            events,
          });

          let checkout: TaskCheckout | null = null;
          try {
            checkout = await cfg.clone(task);
          } catch (e) {
            const msg = `clone failed: ${e instanceof Error ? e.message : String(e)}`;
            return fail(infraAttempt(cfg.competitorId, task, seed, msg), placedAtMs, [
              { ts: 0, kind: 'error', agent: cfg.competitorId, taskId: task.instanceId, detail: msg },
            ]);
          }
          const startedTaskMs = now();
          try {
            const input = JSON.stringify({
              repoDir: checkout.dir,
              instanceId: task.instanceId,
              problemStatement: task.problemStatement,
              model: cfg.model,
              baseUrl,
              apiKeyEnv,
              priority,
              thinkingBudgetTokens,
              maxTokens,
              maxIterations: cfg.maxIterations ?? 40,
              ...(cfg.selfcheck ? { selfcheck: true } : {}),
            });
            const { stdout, stderr, code } = await exec(cfg.pythonBin, [cfg.runnerScript], input, { timeoutMs, env: gatewayEnv });
            const res = parseRunnerResult(stdout);
            if (!res) {
              const msg = `runner produced no result (code ${code}): ${stderr.slice(-300)}`;
              return fail(infraAttempt(cfg.competitorId, task, seed, msg), startedTaskMs, [
                { ts: 0, kind: 'error', agent: cfg.competitorId, taskId: task.instanceId, detail: msg },
              ]);
            }
            const diff = res.ok ? await cfg.extractDiff(checkout, task) : '';
            const attempt: ArmAttempt = {
              arm: cfg.competitorId,
              blueprintId: cfg.competitorId,
              instanceId: task.instanceId,
              seed,
              diff,
              tokensIn: res.tokensIn,
              tokensOut: res.tokensOut,
              costUsd: res.costUsd,
              turns: res.turns,
              wallClockMs: now() - startedTaskMs,
              trajectoryRef: '',
              stopReason: res.ok ? res.stopReason : 'error',
              ...(res.ok ? {} : { generationError: res.error ?? 'runner error' }),
            };
            return {
              result: { attempt, cupId: cfg.competitorId, placedAtMs, startedAtMs: startedTaskMs, finishedAtMs: now(), disposition: 'spawn' },
              events: tag(res.events, task.instanceId),
            };
          } finally {
            await checkout?.cleanup().catch(() => {});
          }
        },
      );

      return {
        arm: req.arm,
        suite: req.suite,
        runId: req.runId,
        seed: req.seed,
        startedAtMs,
        finishedAtMs: now(),
        peakConcurrentBees: Math.max(1, Math.min(concurrency, req.backlog.length)),
        taskResults: perTask.map((p) => p.result),
        coordEvents: perTask.flatMap((p) => p.events),
      };
    },
  };
}

/** Default home for the framework venvs (installed at pilot-prep), overridable per env. */
function venvPython(competitorId: CompetitorArmId): string {
  const base = join(homedir(), '.papercusp', 'competitors');
  if (competitorId === 'openhands-async') {
    return process.env.PAPERCUSP_COMPETITOR_OPENHANDS_VENV ?? join(base, 'openhands-venv', 'bin', 'python');
  }
  return process.env.PAPERCUSP_COMPETITOR_VENV ?? join(base, 'venv', 'bin', 'python');
}

const RUNNER_FILE: Record<CompetitorArmId, string> = {
  'openhands-async': 'run_openhands.py',
  crewai: 'run_crewai.py',
  langgraph: 'run_langgraph.py',
  roma: 'run_roma.py',
};

/** Absolute path to a framework's python runner (in-tree; env override for a relocated checkout). */
export function runnerScriptPath(competitorId: CompetitorArmId): string {
  const dir = process.env.PAPERCUSP_COMPETITOR_RUNNERS_DIR ?? fileURLToPath(new URL('./competitors', import.meta.url));
  return join(dir, RUNNER_FILE[competitorId]);
}

export interface BindLiveCompetitorsOptions {
  /** Default DEFAULT_COMPETITOR_MODEL ('claude-opus-4-8') — fairness: every arm uses the same model. */
  model?: string;
  /** Default gatewayBaseUrl() (the bees' inference gateway, port from spawn-env). */
  baseUrl?: string | null;
  apiKeyEnv?: string;
  /** xhigh effort realization; default DEFAULT_THINKING_BUDGET_TOKENS. */
  thinkingBudgetTokens?: number;
  maxTokens?: number;
  clone: CloneTaskRepo;
  extractDiff: ExtractDiff;
  /** Which competitors to bind (default the core three; ROMA is opt-in + has no runner yet). */
  competitors?: readonly CompetitorArmId[];
  maxIterations?: number;
  perTaskTimeoutMs?: number;
  concurrency?: number;
  exec?: ExecFn;
  /** Bind in no-LLM wiring-smoke mode (the runners construct but make no model call). */
  selfcheck?: boolean;
}

/**
 * One-call binding of every live competitor driver (the gated-run setup). After this, the pilot composition
 * (`runCompetitorArmPilot`, competitor-pilot.ts) runs each arm end-to-end. Skips any competitor lacking a
 * runner script (e.g. ROMA). Returns the ids actually bound.
 */
export function bindLiveCompetitorDrivers(opts: BindLiveCompetitorsOptions): CompetitorArmId[] {
  const ids = opts.competitors ?? CORE_COMPETITOR_ARM_IDS;
  const bound: CompetitorArmId[] = [];
  for (const id of ids) {
    if (!getCompetitor(id)) continue;
    setCompetitorDriver(
      id,
      makeCompetitorDriver({
        competitorId: id,
        pythonBin: venvPython(id),
        runnerScript: runnerScriptPath(id),
        model: opts.model,
        baseUrl: opts.baseUrl ?? null,
        apiKeyEnv: opts.apiKeyEnv,
        maxIterations: opts.maxIterations,
        perTaskTimeoutMs: opts.perTaskTimeoutMs,
        concurrency: opts.concurrency,
        clone: opts.clone,
        extractDiff: opts.extractDiff,
        exec: opts.exec,
        selfcheck: opts.selfcheck,
      }),
    );
    bound.push(id);
  }
  return bound;
}
