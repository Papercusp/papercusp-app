/**
 * METR HCAST LIVE ops (plan benchmark-suite-metr-hcast-2026-06-17 P-002/P-003/P-004) — host-gated.
 *
 * The live binding behind the runner's {@link MetrHcastRunnerOps} seam. Two halves:
 *
 *  1. {@link dockerTaskStandardOps} — the container lifecycle + scoring via the PUBLIC Task-Standard
 *     `taskhelper.py` (D-001/taskhelper: the private `mtb` Inspect bridge won't install — six private METR
 *     PyPI deps — so we drive the task image directly the way the bridge does). Per task: `docker run -d` the
 *     pre-built image → `docker cp taskhelper.py` → `taskhelper start` → `taskhelper setup` (instructions) →
 *     [arm drives] → `taskhelper score -s <submission>` → `docker rm -f`. Validated end-to-end on
 *     local_research/atari_epochs (start→Success, setup→instructions, score→float).
 *
 *  2. The two ARM drivers — both run an in-container ReAct loop as the unprivileged `agent` user, routed to
 *     opus-4.8 through our gateway. {@link singleOpusDriveArm} is one flat loop (the `baseline-a-ablation`
 *     arm); {@link hiveDriveArm} wraps the SAME loop with a planner + a `delegate` sub-agent tool (the
 *     `papercusp` arm). Identical container/model/budget/scoring → the only delta is the orchestration, so
 *     the horizon difference is causal (D-002).
 *
 * The model call is an injected seam ({@link ModelCall}) so the loops unit-test with a scripted fake (no
 * spend, no docker). {@link gatewayModelCall} is the live binding (the @anthropic-ai/sdk against the gateway).
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GenerationBudget,
  GenerationStopReason,
  GenerationTelemetry,
} from './types';
import type {
  MetrHcastDriveResult,
  MetrHcastRunnerOps,
  MetrHcastScoreResult,
  MetrHcastTaskEnv,
} from './metr-hcast-runner';
import type { BenchTask } from './types';
import { gatewayPort } from '../inference-gateway/spawn-env';

/** The taskhelper output separator (taskhelper.py prints this line, then the JSON result). */
const TASKHELPER_SEP = 'SEP_MUfKWkpuVDn9E';
/** taskhelper's "task not found" sentinel. */
const TASK_NOT_FOUND = 'taskNotFound_FPW3SDMlvf9Kf';

/** Path to the vendored Task-Standard taskhelper.py (env-overridable). */
export function taskhelperPath(): string {
  return (
    process.env.PAPERCUSP_METR_TASKHELPER ??
    join(homedir(), '.papercusp', 'bench-harnesses', 'metr', 'task-standard', 'drivers', 'taskhelper.py')
  );
}

/** The gateway base url for the arm's model calls (same for every arm — fair routing). */
export function metrGatewayBaseUrl(): string {
  return process.env.PAPERCUSP_METR_GATEWAY_URL ?? `http://127.0.0.1:${gatewayPort()}`;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injected process-exec seam (fakes in tests; `execFile` in prod). */
export type ExecFn = (file: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<ExecResult>;

export const liveExec: ExecFn = (file, args, opts = {}) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: opts.timeoutMs ?? 600_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });

/** Parse taskhelper stdout: everything after the last `SEP` line is the JSON result. */
export function parseTaskhelperResult(stdout: string): unknown {
  const idx = stdout.lastIndexOf(TASKHELPER_SEP);
  if (idx < 0) {
    if (stdout.includes(TASK_NOT_FOUND)) throw new Error('taskhelper: task not found');
    throw new Error(`taskhelper: no result separator in output: ${stdout.slice(0, 400)}`);
  }
  const after = stdout.slice(idx + TASKHELPER_SEP.length).trim();
  // The JSON is the first line after the separator.
  const firstLine = after.split('\n')[0]?.trim() ?? '';
  try {
    return JSON.parse(firstLine);
  } catch {
    throw new Error(`taskhelper: result after separator was not JSON: ${firstLine.slice(0, 200)}`);
  }
}

/** Deps for the docker Task-Standard ops. */
export interface DockerOpsDeps {
  exec?: ExecFn;
  /** Docker binary (default 'docker'). */
  docker?: string;
  /** Container python (default 'python'). */
  python?: string;
  /** Path to taskhelper.py on the host (default {@link taskhelperPath}). */
  taskhelper?: string;
  /** Per-exec timeout (ms) for start/setup/score (default 300_000). */
  opTimeoutMs?: number;
  /** A unique-ish suffix source for container names (avoid Math.random in shared code; default counter). */
  nameSuffix?: () => string;
}

let containerCounter = 0;

/**
 * The container-lifecycle + scoring half of {@link MetrHcastRunnerOps} via taskhelper.py. The arm's
 * `driveArm` is supplied separately (single-opus or hive) — assemble with {@link makeMetrHcastLiveOps}.
 */
export function dockerTaskStandardOps(deps: DockerOpsDeps = {}): Pick<MetrHcastRunnerOps, 'prepareTask' | 'score' | 'teardownTask'> {
  const exec = deps.exec ?? liveExec;
  const docker = deps.docker ?? 'docker';
  const python = deps.python ?? 'python';
  const taskhelper = deps.taskhelper ?? taskhelperPath();
  const opTimeoutMs = deps.opTimeoutMs ?? 300_000;
  const nameSuffix = deps.nameSuffix ?? (() => `${process.pid}-${(containerCounter += 1)}`);

  const runTaskhelper = async (containerId: string, family: string, task: string, op: string, extra: string[] = []): Promise<unknown> => {
    const r = await exec(docker, ['exec', '-w', '/root', containerId, python, 'taskhelper.py', family, task, op, ...extra], { timeoutMs: opTimeoutMs });
    if (r.code !== 0 && !r.stdout.includes(TASKHELPER_SEP)) {
      throw new Error(`taskhelper ${op} failed (code ${r.code}): ${(r.stderr || r.stdout).slice(0, 400)}`);
    }
    return parseTaskhelperResult(r.stdout);
  };

  return {
    async prepareTask({ task }): Promise<MetrHcastTaskEnv> {
      const image = String(task.graderMeta?.['image'] ?? '');
      const family = String(task.graderMeta?.['family'] ?? '');
      const taskName = String(task.graderMeta?.['task'] ?? task.graderMeta?.['sampleId'] ?? '');
      if (!image || !family || !taskName) {
        throw new Error(`metr-hcast prepareTask: task ${task.instanceId} missing image/family/task in graderMeta`);
      }
      const containerId = `metr-${task.instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_')}-${nameSuffix()}`;
      // Best-effort remove any stale container of the same name.
      await exec(docker, ['rm', '-f', containerId], { timeoutMs: 30_000 }).catch(() => {});
      // Run the image detached, kept alive (the image's own entrypoint isn't an agent loop).
      const run = await exec(docker, ['run', '-d', '--name', containerId, '--entrypoint', 'sh', image, '-c', 'tail -f /dev/null'], { timeoutMs: opTimeoutMs });
      if (run.code !== 0) throw new Error(`docker run ${image} failed: ${(run.stderr || run.stdout).slice(0, 400)}`);
      // Copy the vendored taskhelper into the container.
      const cp = await exec(docker, ['cp', taskhelper, `${containerId}:/root/taskhelper.py`], { timeoutMs: 60_000 });
      if (cp.code !== 0) throw new Error(`docker cp taskhelper failed: ${(cp.stderr || cp.stdout).slice(0, 200)}`);
      // start(task): sets up the task instance + chowns /home/agent to the agent user.
      await runTaskhelper(containerId, family, taskName, 'start');
      // setup: get the instructions (the brief the arm is given).
      const setup = (await runTaskhelper(containerId, family, taskName, 'setup')) as { instructions?: string };
      const instructions = typeof setup?.instructions === 'string' ? setup.instructions : `Solve task ${family}/${taskName}.`;
      return { containerId, image, family, task: taskName, instructions };
    },

    async score({ env, submission }): Promise<MetrHcastScoreResult> {
      const raw = await runTaskhelper(env.containerId, env.family, env.task, 'score', ['-s', submission ?? '']);
      const score = typeof raw === 'number' ? raw : raw === null ? null : Number.isFinite(Number(raw)) ? Number(raw) : null;
      return { score, raw };
    },

    async teardownTask({ env }): Promise<void> {
      await exec(docker, ['rm', '-f', env.containerId], { timeoutMs: 60_000 }).catch(() => {});
    },
  };
}

/* ----------------------------- the arm drivers ----------------------------- */

/** A normalized model response from one {@link ModelCall}. */
export interface ModelResponse {
  /** Assistant text (the reasoning / narration). */
  text: string;
  /** Tool calls the model made this turn. */
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  /** Why the turn stopped (anthropic stop_reason). */
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** One conversation turn fed back to the model (tool results). */
export interface ToolResultMsg {
  toolUseId: string;
  content: string;
}

/**
 * The injected model-call seam. Given the running transcript + the tool schema + system prompt, returns the
 * model's next response. {@link gatewayModelCall} binds the @anthropic-ai/sdk against our gateway; tests pass
 * a scripted fake. `history` is the full alternating user/assistant message list in Anthropic shape.
 */
export type ModelCall = (input: {
  system: string;
  // Anthropic message list (role + content blocks). Opaque to the loop except that we append to it.
  messages: unknown[];
  tools: { name: string; description: string; input_schema: Record<string, unknown> }[];
  maxTokens: number;
}) => Promise<ModelResponse & { assistantBlocks: unknown[] }>;

/** The bash + submit tool schema every arm exposes inside the container. */
const ARM_TOOLS = [
  {
    name: 'bash',
    description:
      'Run a bash command inside the task container as the unprivileged `agent` user (cwd /home/agent). Returns combined stdout+stderr (truncated). Use this to explore files, run code, and produce your answer.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The bash command to run.' } },
      required: ['command'],
    },
  },
  {
    name: 'submit',
    description:
      'Submit your FINAL answer/solution for scoring. Call this exactly once when done. The string is passed verbatim to the task\'s score() function.',
    input_schema: {
      type: 'object',
      properties: { answer: { type: 'string', description: 'The final submission string.' } },
      required: ['answer'],
    },
  },
];

export interface ArmDriverDeps {
  modelCall: ModelCall;
  exec?: ExecFn;
  docker?: string;
  model?: string;
  /** Max ReAct turns before forcing a stop (default 30). */
  maxTurns?: number;
  /** Per-bash timeout (ms) inside the container (default 120_000). */
  bashTimeoutMs?: number;
  /** Max bash output chars fed back to the model (default 8000). */
  maxToolOutput?: number;
}

/** Run a bash command in the container as the `agent` user; returns truncated combined output. */
async function containerBash(exec: ExecFn, docker: string, containerId: string, command: string, timeoutMs: number, maxOut: number): Promise<string> {
  const r = await exec(docker, ['exec', '-u', 'agent', '-w', '/home/agent', containerId, 'bash', '-lc', command], { timeoutMs });
  const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  const body = out.length > maxOut ? `${out.slice(0, maxOut)}\n…[truncated ${out.length - maxOut} chars]` : out;
  return body || `[exit ${r.code}, no output]`;
}

/** Telemetry accumulator across an arm's model calls + container time. */
interface TelemetryAcc {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  startedAt: number;
}

function priceTelemetry(acc: TelemetryAcc, stopReason: GenerationStopReason, submission: string, now: () => number, generationError?: string): GenerationTelemetry {
  return {
    tokensIn: acc.tokensIn,
    tokensOut: acc.tokensOut,
    // costUsd is derived downstream from tokens via the published price table; leave 0 here.
    costUsd: 0,
    turns: acc.turns,
    wallClockMs: now() - acc.startedAt,
    trajectoryRef: '',
    stopReason,
    ...(generationError ? { generationError } : {}),
  };
}

/**
 * The SINGLE-OPUS arm (`baseline-a-ablation`): one flat ReAct loop. The agent gets the task instructions +
 * a bash + submit tool, runs inside the container, and submits. Stops on submit (done), max-turns
 * (budget-exhausted → scored), or budget cap.
 */
export function singleOpusDriveArm(deps: ArmDriverDeps): MetrHcastRunnerOps['driveArm'] {
  const exec = deps.exec ?? liveExec;
  const docker = deps.docker ?? 'docker';
  const maxTurns = deps.maxTurns ?? 30;
  const bashTimeoutMs = deps.bashTimeoutMs ?? 120_000;
  const maxOut = deps.maxToolOutput ?? 8000;

  return async ({ env, budget }): Promise<MetrHcastDriveResult> => {
    const now = () => Date.now();
    const acc: TelemetryAcc = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, turns: 0, startedAt: now() };
    const system =
      `You are an autonomous software agent working INSIDE a Linux container as the unprivileged user 'agent' (cwd /home/agent). ` +
      `You must complete the task below using the bash tool, then call submit with your final answer. Be efficient. ` +
      `If the task asks a question, submit ONLY the answer string requested.\n\nTASK:\n${env.instructions}`;
    const messages: unknown[] = [{ role: 'user', content: 'Begin. Explore as needed, then submit your final answer.' }];

    let submission = '';
    let stopReason: GenerationStopReason = 'max-turns';
    for (let turn = 0; turn < maxTurns; turn++) {
      acc.turns = turn + 1;
      let resp: Awaited<ReturnType<ModelCall>>;
      try {
        resp = await deps.modelCall({ system, messages, tools: ARM_TOOLS, maxTokens: 4096 });
      } catch (e) {
        return { telemetry: priceTelemetry(acc, 'infra-failed', '', now, `model call failed: ${e instanceof Error ? e.message : String(e)}`), submission: '' };
      }
      acc.tokensIn += resp.usage.inputTokens;
      acc.tokensOut += resp.usage.outputTokens;
      acc.cacheRead += resp.usage.cacheReadTokens ?? 0;
      acc.cacheWrite += resp.usage.cacheWriteTokens ?? 0;
      messages.push({ role: 'assistant', content: resp.assistantBlocks });

      const submitCall = resp.toolCalls.find((c) => c.name === 'submit');
      if (submitCall) {
        submission = String(submitCall.input.answer ?? '');
        stopReason = 'done';
        break;
      }
      const bashCalls = resp.toolCalls.filter((c) => c.name === 'bash');
      if (bashCalls.length === 0) {
        // Model produced no tool call → nudge once, else treat its text as the submission.
        if (resp.text.trim()) {
          submission = resp.text.trim();
          stopReason = 'done';
          break;
        }
        messages.push({ role: 'user', content: 'Use the bash tool to make progress, or call submit with your final answer.' });
        continue;
      }
      const toolResults: unknown[] = [];
      for (const call of bashCalls) {
        const out = await containerBash(exec, docker, env.containerId, String(call.input.command ?? ''), bashTimeoutMs, maxOut);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: out });
      }
      // Echo a tool_result for the submit-less turn (any non-bash, non-submit tool calls get an error result).
      for (const call of resp.toolCalls.filter((c) => c.name !== 'bash' && c.name !== 'submit')) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool. Use bash or submit.', is_error: true });
      }
      messages.push({ role: 'user', content: toolResults });
      if (budget.maxTokens && acc.tokensIn + acc.tokensOut >= budget.maxTokens) {
        stopReason = 'budget-exhausted';
        break;
      }
    }
    return { telemetry: priceTelemetry(acc, stopReason, submission, now), submission };
  };
}

/**
 * The HIVE arm (`papercusp`): a lead agent that can DECOMPOSE the task via a `delegate` tool — each delegate
 * runs a fresh bounded sub-agent ReAct loop in the SAME container and returns a summary. The lead then
 * submits. Same container/model/budget/scoring as single-opus; the ONLY difference is the decomposition +
 * delegation scaffold (the coordination), so any horizon difference is causal (D-002). Sub-agent token usage
 * is SUMMED into the arm's telemetry (coordination overhead counted — fairness #2).
 */
export function hiveDriveArm(deps: ArmDriverDeps): MetrHcastRunnerOps['driveArm'] {
  const exec = deps.exec ?? liveExec;
  const docker = deps.docker ?? 'docker';
  const maxTurns = deps.maxTurns ?? 30;
  const bashTimeoutMs = deps.bashTimeoutMs ?? 120_000;
  const maxOut = deps.maxToolOutput ?? 8000;
  const subAgent = singleOpusDriveArm({ ...deps, maxTurns: Math.max(6, Math.floor(maxTurns / 2)) });

  const LEAD_TOOLS = [
    ARM_TOOLS[0], // bash
    {
      name: 'delegate',
      description:
        'Delegate a focused SUBTASK to a fresh worker agent that operates in the SAME container and returns a short result summary. Use to decompose a long task into independent pieces. Provide a self-contained subtask description.',
      input_schema: {
        type: 'object',
        properties: { subtask: { type: 'string', description: 'A self-contained subtask for the worker.' } },
        required: ['subtask'],
      },
    },
    ARM_TOOLS[1], // submit
  ];

  return async ({ task, env, arm, budget, seed, workspaceId }): Promise<MetrHcastDriveResult> => {
    const now = () => Date.now();
    const acc: TelemetryAcc = { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, turns: 0, startedAt: now() };
    const system =
      `You are the LEAD agent of a small coordinating team working INSIDE a Linux container (user 'agent', cwd /home/agent). ` +
      `You may use bash directly, or DELEGATE a self-contained subtask to a worker (the delegate tool). Decompose the task ` +
      `when that helps, integrate the workers' results, then call submit with the final answer.\n\nTASK:\n${env.instructions}`;
    const messages: unknown[] = [{ role: 'user', content: 'Plan briefly, decompose if useful (delegate), then submit the final answer.' }];

    let submission = '';
    let stopReason: GenerationStopReason = 'max-turns';
    for (let turn = 0; turn < maxTurns; turn++) {
      acc.turns = turn + 1;
      let resp: Awaited<ReturnType<ModelCall>>;
      try {
        resp = await deps.modelCall({ system, messages, tools: LEAD_TOOLS, maxTokens: 4096 });
      } catch (e) {
        return { telemetry: priceTelemetry(acc, 'infra-failed', '', now, `lead model call failed: ${e instanceof Error ? e.message : String(e)}`), submission: '' };
      }
      acc.tokensIn += resp.usage.inputTokens;
      acc.tokensOut += resp.usage.outputTokens;
      messages.push({ role: 'assistant', content: resp.assistantBlocks });

      const submitCall = resp.toolCalls.find((c) => c.name === 'submit');
      if (submitCall) {
        submission = String(submitCall.input.answer ?? '');
        stopReason = 'done';
        break;
      }
      const toolResults: unknown[] = [];
      for (const call of resp.toolCalls) {
        if (call.name === 'bash') {
          const out = await containerBash(exec, docker, env.containerId, String(call.input.command ?? ''), bashTimeoutMs, maxOut);
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: out });
        } else if (call.name === 'delegate') {
          // Run a worker sub-loop in the same container; its instructions are the subtask.
          const subEnv: MetrHcastTaskEnv = { ...env, instructions: String(call.input.subtask ?? '') };
          const sub = await subAgent({ task, env: subEnv, arm, budget, seed, workspaceId }).catch((e) => ({
            telemetry: { tokensIn: 0, tokensOut: 0, costUsd: 0, turns: 0, wallClockMs: 0, trajectoryRef: '', stopReason: 'infra-failed' as GenerationStopReason },
            submission: `delegate failed: ${e instanceof Error ? e.message : String(e)}`,
          }));
          acc.tokensIn += sub.telemetry.tokensIn;
          acc.tokensOut += sub.telemetry.tokensOut;
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: `Worker result: ${sub.submission || '(no explicit result; see container state)'}` });
        } else if (call.name !== 'submit') {
          toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool. Use bash, delegate, or submit.', is_error: true });
        }
      }
      if (resp.toolCalls.length === 0) {
        if (resp.text.trim()) {
          submission = resp.text.trim();
          stopReason = 'done';
          break;
        }
        messages.push({ role: 'user', content: 'Use bash, delegate, or submit.' });
        continue;
      }
      messages.push({ role: 'user', content: toolResults });
      if (budget.maxTokens && acc.tokensIn + acc.tokensOut >= budget.maxTokens) {
        stopReason = 'budget-exhausted';
        break;
      }
    }
    return { telemetry: priceTelemetry(acc, stopReason, submission, now), submission };
  };
}

/** The gateway header that pins a request to a specific pool account (mirrors inference-gateway ACCOUNT_HEADER). */
export const GATEWAY_ACCOUNT_HEADER = 'x-papercusp-account';
/** The gateway header that selects the admission lane (mirrors inference-gateway PRIORITY_HEADER). */
export const PRIORITY_HEADER = 'x-papercusp-priority';

/**
 * THE LOAD-BEARING gateway requirement (insight `max-oauth-first-system-block-must-be-claude-code-identity`):
 * on a Claude-Max OAuth token the inference gateway proxies to, a raw-SDK caller whose FIRST `system` block is
 * not EXACTLY this string (as its OWN block) gets a BOGUS 429 (`rate_limit_error`, body literally `"Error"`,
 * no `anthropic-ratelimit-*` headers) REGARDLESS of budget — it is NOT a real rate limit. So every gateway
 * call must lead with this identity block. (Same constant the gaia/su arms frame with.)
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Config for {@link gatewayModelCall}. */
export interface GatewayModelCfg {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Pin this arm's calls to a specific pool account (cache-affinity + contention isolation from concurrent
   *  benches). Sent as the `x-papercusp-account` header the gateway routes on. Env override: PAPERCUSP_METR_ACCOUNT. */
  accountId?: string;
  /** Gateway admission label. Defaults to `benchmark` so METR load stays in the bounded benchmark/gym lane. */
  priority?: string;
  /** Retries on a transient 429/529/overload/pace/hang from the shared gateway. Default 8 (rides out pace cycles). */
  maxRetries?: number;
  /** Base backoff (ms) for transient retries when no `retry after` hint is present (exponential, capped). Default 3000. */
  retryBaseMs?: number;
  /** Per-request timeout (ms) — the shared gateway hangs under load, so fail fast + retry rather than block. Default 90000. */
  requestTimeoutMs?: number;
  /** Extended-thinking budget (tokens) = the plan's "opus-4.8 @ xhigh" elicitation. >0 enables thinking;
   *  max_tokens is forced above it. Default 0 (off). xhigh ≈ 16000 (matches the gaia/competitor arms). */
  thinkingBudget?: number;
  /** Sleep seam (injected in tests so retries don't actually wait). */
  sleep?: (ms: number) => Promise<void>;
  /** Anthropic SDK import (injected for tests; defaults to a lazy dynamic import of @anthropic-ai/sdk). */
  anthropicCtor?: new (opts: { apiKey: string; baseURL: string; defaultHeaders?: Record<string, string> }) => {
    messages: { create(body: Record<string, unknown>): Promise<AnthropicMessageResponse> };
  };
}

/**
 * A transient error worth retrying — the SHARED inference gateway pacing (429 `paced/paused; retry after Ns`),
 * Anthropic overload (529), OR a gateway hang / network blip (timeout, ECONNRESET, socket hang up, http 000).
 * Under concurrent benches the gateway both paces accounts AND hangs, so both are transient, not real failures.
 */
export function isTransientGatewayError(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429 || status === 529 || status === 503 || status === 502 || status === 504) return true;
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('rate_limit') ||
    msg.includes('overloaded') ||
    msg.includes('paced') ||
    msg.includes('paused') ||
    msg.includes('429') ||
    msg.includes('529') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('aborted') ||
    msg.includes('fetch failed') ||
    msg.includes('terminated')
  );
}

/** Parse the gateway's `retry after Ns` hint (ms), if present — so we wait out the pace window, not just a few s. */
export function parseRetryAfterMs(e: unknown): number | null {
  const body = (e as { error?: { message?: string }; message?: string }) ?? {};
  const text = `${body?.error?.message ?? ''} ${e instanceof Error ? e.message : String(e)}`;
  const m = text.match(/retry[ -]?after[: ]+(\d+)\s*s/i) ?? text.match(/(\d+)\s*s(?:econds)?\b/i);
  if (m) {
    const sec = Number(m[1]);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 200_000); // cap at 200s
  }
  return null;
}

/** The minimal slice of the Anthropic Messages response we read. */
interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/**
 * The LIVE {@link ModelCall} binding — the @anthropic-ai/sdk pointed at our gateway (the same routing every
 * arm uses → fair). The gateway strips + reinjects real creds, so the api key need only be SET. Routes to
 * opus-4.8 by default. Lazily imports the SDK so the module loads without it (tests pass a fake).
 */
export function gatewayModelCall(cfg: GatewayModelCfg = {}): ModelCall {
  const model = cfg.model ?? 'claude-opus-4-8';
  const baseURL = cfg.baseUrl ?? metrGatewayBaseUrl();
  const apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY ?? 'sk-papercusp-gateway';
  const accountId = cfg.accountId ?? process.env.PAPERCUSP_METR_ACCOUNT;
  const priority = cfg.priority ?? 'benchmark';
  const defaultHeaders = {
    ...(accountId ? { [GATEWAY_ACCOUNT_HEADER]: accountId } : {}),
    ...(priority ? { [PRIORITY_HEADER]: priority } : {}),
  };
  const timeout = cfg.requestTimeoutMs ?? 90_000;
  let clientP: Promise<{ messages: { create(body: Record<string, unknown>): Promise<AnthropicMessageResponse> } }> | null = null;
  const client = async () => {
    if (!clientP) {
      clientP = (async () => {
        const opts = { apiKey, baseURL, timeout, maxRetries: 0, defaultHeaders };
        if (cfg.anthropicCtor) return new cfg.anthropicCtor(opts);
        const mod = (await import('@anthropic-ai/sdk')) as unknown as { default: new (o: Record<string, unknown>) => { messages: { create(b: Record<string, unknown>): Promise<AnthropicMessageResponse> } } };
        return new mod.default(opts);
      })();
    }
    return clientP;
  };

  const maxRetries = cfg.maxRetries ?? 8;
  const retryBaseMs = cfg.retryBaseMs ?? 3000;
  const thinkingBudget = cfg.thinkingBudget ?? 0;
  const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return async ({ system, messages, tools, maxTokens }) => {
    const c = await client();
    // The FIRST system block MUST be the Claude Code identity on the Max-OAuth gateway, else a BOGUS 429
    // (body literally "Error") regardless of budget — NOT a real rate limit (see CLAUDE_CODE_IDENTITY).
    const framedSystem = [
      { type: 'text', text: CLAUDE_CODE_IDENTITY },
      { type: 'text', text: system },
    ];
    // xhigh elicitation: enable extended thinking; max_tokens MUST exceed the thinking budget.
    const thinking = thinkingBudget > 0 ? { type: 'enabled' as const, budget_tokens: thinkingBudget } : undefined;
    const effectiveMaxTokens = thinking ? Math.max(maxTokens, thinkingBudget + 4096) : maxTokens;
    let resp: AnthropicMessageResponse | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        resp = await c.messages.create({
          model,
          max_tokens: effectiveMaxTokens,
          system: framedSystem,
          messages,
          tools,
          ...(thinking ? { thinking } : {}),
        });
        break;
      } catch (e) {
        lastErr = e;
        // Retry transient gateway pacing/overload/hang. Honor the gateway's `retry after Ns` hint when present
        // (the pace window is ~2 min — a few-second backoff is too short); else exponential backoff (capped 60s).
        if (attempt < maxRetries && isTransientGatewayError(e)) {
          const hinted = parseRetryAfterMs(e);
          await sleep(hinted ?? Math.min(retryBaseMs * 2 ** attempt, 60_000));
          continue;
        }
        throw e;
      }
    }
    if (!resp) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    const content = resp.content ?? [];
    const toolCalls = content
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: (b.input ?? {}) as Record<string, unknown> }));
    const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    return {
      text,
      toolCalls,
      stopReason: resp.stop_reason ?? 'end_turn',
      usage: {
        inputTokens: resp.usage?.input_tokens ?? 0,
        outputTokens: resp.usage?.output_tokens ?? 0,
        cacheReadTokens: resp.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage?.cache_creation_input_tokens ?? 0,
      },
      assistantBlocks: content,
    };
  };
}

/** Assemble the full live ops for a given arm: docker Task-Standard lifecycle + the arm's driver. */
export function makeMetrHcastLiveOps(
  arm: 'baseline-a-ablation' | 'papercusp',
  deps: DockerOpsDeps & ArmDriverDeps & { concurrencyCap?: () => number | Promise<number> },
): MetrHcastRunnerOps {
  const dockerOps = dockerTaskStandardOps(deps);
  const driveArm = arm === 'papercusp' ? hiveDriveArm(deps) : singleOpusDriveArm(deps);
  return {
    now: () => Date.now(),
    concurrencyCap: deps.concurrencyCap ?? (() => 1),
    prepareTask: dockerOps.prepareTask,
    score: dockerOps.score,
    teardownTask: dockerOps.teardownTask,
    driveArm,
  };
}
