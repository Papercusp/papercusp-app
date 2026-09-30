/**
 * FrontierSWE in-container runAgent (plan benchmark-suite-frontier-swe-2026-06-18 P-014) — the consumer-supplied
 * agent drive that su-37e53a76's `runTopology` injects (the driver ships none by design; the in-container drive
 * is benchmark-specific). ADAPTED from metr-hcast's `singleOpusDriveArm` (the proven in-container opus ReAct
 * loop) to FrontierSWE's conventions + the topology `RunAgentInput`→`AgentRunOutput` contract:
 *
 *   - Workspace is `/app` (FrontierSWE bakes the task tree there); the agent EDITS IN PLACE — the seam's own
 *     verifier (`tests/test.sh`) scores the mutated container, so the `submission` string is just a short
 *     summary (used only by the ensemble JUDGE to compare candidates).
 *   - `input.directive` (coordination instructions from the topology) is prepended to the system prompt;
 *     `input.forbidTools` filters the offered tools (bash/submit are never coordination tools, so an
 *     in-container worker's coordCalls is 0 — but we compute it the STANDARD way for C4 fairness).
 *   - Role mapping (input.role): worker|solver|driver → the full drive; judge → a single compare-and-pick call
 *     returning `pickIndex` (does NOT re-solve); navigator → the full drive seeded with the driver's solution.
 *
 * ModelCall + ExecFn are INJECTED (the live `gatewayModelCall` + docker `liveExec`; scripted fakes in tests),
 * so the loop logic is unit-testable with NO gateway / NO docker / NO spend. The LIVE run (real opus + real
 * task containers, 4–20h/task) is owner/compute-gated — see FRONTIER-SWE-PILOT.md.
 */
import type { ModelCall, ExecFn } from './metr-hcast-live';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { countCoordinationCalls } from './coordination-runtime';

export interface FrontierSweRunAgentDeps {
  /** The injected model-call seam (live: gatewayModelCall against the :8788 gateway; fake in tests). */
  modelCall: ModelCall;
  /** Injected subprocess (live: docker; fake in tests). */
  exec: ExecFn;
  docker?: string;
  /** Container working dir (FrontierSWE bakes the task at /app). */
  workdir?: string;
  /** Optional `docker exec -u <user>`; default = the container's default user (matches the seam's verifier exec). */
  execUser?: string;
  /** Max ReAct turns per attempt (default 40 — long-horizon). */
  maxTurns?: number;
  bashTimeoutMs?: number;
  maxToolOutput?: number;
  maxTokensPerTurn?: number;
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const BASH_TOOL: ToolDef = {
  name: 'bash',
  description:
    'Run a bash command inside the task container (cwd /app). Returns combined stdout+stderr (truncated). Edit files in place; your changes are what gets scored.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};
const SUBMIT_TOOL: ToolDef = {
  name: 'submit',
  description:
    'Call once when your work in the container is complete. Pass a SHORT summary of what you changed (the container itself is scored by the task verifier).',
  input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
};
const PICK_TOOL: ToolDef = {
  name: 'pick',
  description: 'Pick the index of the best candidate solution.',
  input_schema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
};

function offeredTools(base: ToolDef[], forbid: readonly string[]): ToolDef[] {
  const deny = new Set(forbid);
  return base.filter((t) => !deny.has(t.name));
}

async function containerBash(
  exec: ExecFn,
  docker: string,
  workdir: string,
  execUser: string | undefined,
  containerId: string,
  command: string,
  timeoutMs: number,
  maxOut: number,
): Promise<string> {
  const args = ['exec', ...(execUser ? ['-u', execUser] : []), '-w', workdir, containerId, 'bash', '-lc', command];
  const r = await exec(docker, args, { timeoutMs });
  const out = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`.trim();
  return (out.length > maxOut ? `${out.slice(0, maxOut)}\n…[truncated ${out.length - maxOut} chars]` : out) || `[exit ${r.code}, no output]`;
}

/** Build the FrontierSWE in-container runAgent for {@link runTopology}. */
export function makeFrontierSweRunAgent(
  deps: FrontierSweRunAgentDeps,
): (input: RunAgentInput<FrontierSweEnvHandle>) => Promise<AgentRunOutput> {
  const docker = deps.docker ?? 'docker';
  const workdir = deps.workdir ?? '/app';
  const maxTurns = deps.maxTurns ?? 40;
  const bashTimeoutMs = deps.bashTimeoutMs ?? 120_000;
  const maxOut = deps.maxToolOutput ?? 8000;
  const maxTokens = deps.maxTokensPerTurn ?? 4096;

  const emptyOut = (): Omit<AgentRunOutput, 'submission' | 'status'> => ({
    modelCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    coordCalls: 0,
  });

  /** The full ReAct drive (worker / solver / driver / navigator). Edits the container in place; submit = summary. */
  async function drive(input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> {
    const acc = { ...emptyOut() };
    const toolNames: string[] = [];
    const seed = input.role === 'navigator' && input.candidates?.[0]
      ? `\n\nA teammate (the driver) produced this initial solution — review and IMPROVE it in the same /app workspace:\n${String((input.candidates[0].submission as { summary?: string } | string) ?? '')}`
      : '';
    const system =
      `You are an autonomous software agent working INSIDE a Linux container (workspace /app). Complete the task by ` +
      `editing files IN PLACE with the bash tool; the task's own verifier scores the container. Call submit with a ` +
      `short summary when done. Be efficient.` +
      (input.directive ? `\n\nCOORDINATION:\n${input.directive}` : '') +
      seed +
      `\n\nTASK:\n${input.task.problemStatement}`;
    const tools = offeredTools([BASH_TOOL, SUBMIT_TOOL], input.forbidTools);
    const messages: unknown[] = [{ role: 'user', content: 'Begin. Explore /app, make your changes, then submit a summary.' }];

    let submission = '';
    let capped = false;
    for (let turn = 0; turn < maxTurns; turn++) {
      acc.turns = turn + 1;
      let resp: Awaited<ReturnType<ModelCall>>;
      try {
        resp = await deps.modelCall({ system, messages, tools, maxTokens });
      } catch (e) {
        return { ...acc, submission: '', status: 'error', error: `model call failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      acc.modelCalls += 1;
      acc.tokensIn += resp.usage.inputTokens;
      acc.tokensOut += resp.usage.outputTokens;
      for (const c of resp.toolCalls) toolNames.push(c.name);
      messages.push({ role: 'assistant', content: resp.assistantBlocks });

      const submitCall = resp.toolCalls.find((c) => c.name === 'submit');
      if (submitCall) {
        submission = String(submitCall.input.summary ?? '');
        break;
      }
      const bashCalls = resp.toolCalls.filter((c) => c.name === 'bash');
      if (bashCalls.length === 0) {
        if (resp.text.trim()) { submission = resp.text.trim(); break; }
        messages.push({ role: 'user', content: 'Use the bash tool to make changes, or call submit with a summary.' });
        continue;
      }
      const toolResults: unknown[] = [];
      for (const call of bashCalls) {
        const out = await containerBash(deps.exec, docker, workdir, deps.execUser, input.handle.containerId, String(call.input.command ?? ''), bashTimeoutMs, maxOut);
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: out });
      }
      for (const call of resp.toolCalls.filter((c) => c.name !== 'bash' && c.name !== 'submit')) {
        toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Unknown tool. Use bash or submit.', is_error: true });
      }
      messages.push({ role: 'user', content: toolResults });

      const b = input.attemptBudget;
      if (b.maxTokens != null && acc.tokensIn + acc.tokensOut >= b.maxTokens) { capped = true; break; }
      if (b.maxModelCalls != null && acc.modelCalls >= b.maxModelCalls) { capped = true; break; }
      if (turn === maxTurns - 1) capped = true; // ran the full turn budget without submitting
    }
    acc.coordCalls = countCoordinationCalls(toolNames);
    // The container is mutated in place → a finished drive is a COMPLETED attempt the seam will grade,
    // whether or not the agent called submit (submit is only a summary for the ensemble judge).
    return { ...acc, submission: submission || `(${input.role} ran ${acc.turns} turns)`, status: 'completed', capped };
  }

  /** The ensemble JUDGE: one compare-and-pick call over the candidate summaries → pickIndex (does not re-solve). */
  async function judge(input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> {
    const acc = { ...emptyOut() };
    const cands = input.candidates ?? [];
    if (cands.length === 0) return { ...acc, submission: '', status: 'error', error: 'judge: no candidates' };
    const list = cands.map((c) => `[${c.index}] ${String((c.submission as { summary?: string } | string) ?? '')}`).join('\n\n');
    const system =
      `You are judging candidate solutions to the task below. Pick the index of the BEST one by calling pick. Do not solve it yourself.` +
      `\n\nTASK:\n${input.task.problemStatement}\n\nCANDIDATES:\n${list}`;
    let resp: Awaited<ReturnType<ModelCall>>;
    try {
      resp = await deps.modelCall({ system, messages: [{ role: 'user', content: 'Pick the best candidate index.' }], tools: [PICK_TOOL], maxTokens });
    } catch (e) {
      return { ...acc, submission: '', status: 'error', error: `judge model call failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    acc.modelCalls = 1;
    acc.turns = 1;
    acc.tokensIn = resp.usage.inputTokens;
    acc.tokensOut = resp.usage.outputTokens;
    acc.coordCalls = countCoordinationCalls(resp.toolCalls.map((c) => c.name));
    const pickCall = resp.toolCalls.find((c) => c.name === 'pick');
    const raw = pickCall ? Number(pickCall.input.index) : cands[0].index;
    const pickIndex = cands.some((c) => c.index === raw) ? raw : cands[0].index;
    return { ...acc, submission: cands.find((c) => c.index === pickIndex)?.submission ?? cands[0].submission, status: 'completed', pickIndex };
  }

  return (input) => (input.role === 'judge' ? judge(input) : drive(input));
}
