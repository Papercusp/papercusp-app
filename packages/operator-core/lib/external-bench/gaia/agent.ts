/**
 * The GAIA general-assistant agent — a provider-agnostic ReAct tool-loop (plan
 * `benchmark-suite-gaia-2026-06-17`, P-003).
 *
 * GAIA ships no harness, so THIS is the agent: opus-4.8 in a tool-use loop with web browsing/search, code
 * execution, file reading, and vision, that must finish every answer with `FINAL ANSWER: [answer]` in the
 * GAIA normalized format. The axis GAIA measures — breadth, research depth, multi-hop tool-orchestration —
 * is exactly what this loop exercises; nothing else in the portfolio covers it. The loop is REUSABLE across
 * other research/tool suites (DeepResearch Bench etc.).
 *
 * This module is the PURE loop: the LLM call ({@link LlmFn}) and the tools ({@link GaiaToolset}) are
 * INJECTED, so the whole control flow (tool dispatch, FINAL-ANSWER discipline, max-turn / budget guards,
 * trajectory + token accounting) is unit-testable with fakes — zero LLM spend, zero network. The live
 * bindings live in ./agent-live.ts (Anthropic SDK → the inference gateway) + ./tools-live.ts (Brave search /
 * HTTP fetch / python sandbox / attachment parsing).
 */
import { extractFinalAnswer } from '../grader/gaia';
import type { GaiaTask } from './dataset';

/* -------------------------------------------------------------------------- */
/* Provider-agnostic message + tool shapes                                     */
/* -------------------------------------------------------------------------- */

/** A tool the model can call. `inputSchema` is a JSON Schema (passed verbatim to the provider). */
export interface GaiaToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** An assistant content block the loop reasons over (the provider-agnostic subset we need). The loop
 *  carries blocks back into the conversation VERBATIM, so a thinking block's `signature` (opaque, set by the
 *  live Anthropic binding) — or `redactedData` for a safety-redacted thinking block — survives the
 *  round-trip, which extended thinking REQUIRES when a thinking block precedes a tool_use in the same turn. */
export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'thinking'; thinking: string; signature?: string; redactedData?: string };

/** A user-turn content block. */
export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type LlmMessage =
  | { role: 'user'; content: UserBlock[] }
  | { role: 'assistant'; content: AssistantBlock[] };

export interface LlmTurnRequest {
  system: string;
  messages: LlmMessage[];
  tools: GaiaToolSpec[];
  maxTokens: number;
  thinkingBudgetTokens?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmTurnResponse {
  content: AssistantBlock[];
  /** Provider stop reason: 'tool_use' | 'end_turn' | 'max_tokens' | 'stop_sequence' | … */
  stopReason: string | null;
  usage: LlmUsage;
}

/** The injected LLM seam — one Messages-API turn (with tools). */
export type LlmFn = (req: LlmTurnRequest) => Promise<LlmTurnResponse>;

/** A tool handler: takes the model-supplied input, returns a text result (errors → throw or return text). */
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

/** The injected toolset: the schemas advertised to the model + the handlers that run them. */
export interface GaiaToolset {
  specs: GaiaToolSpec[];
  handlers: Record<string, ToolHandler>;
}

/* -------------------------------------------------------------------------- */
/* System prompt (the official GAIA prompt + a tools addendum)                 */
/* -------------------------------------------------------------------------- */

/**
 * The official GAIA system prompt (verbatim from the benchmark) + a short tools addendum. The normalized
 * `FINAL ANSWER:` format is load-bearing — a correct-but-misformatted answer FAILS the quasi-exact-match
 * grader, and that formatting slice is a large share of failures, so the discipline is stated up front.
 */
export const GAIA_SYSTEM_PROMPT = [
  'You are a general AI assistant. I will ask you a question. Report your thoughts, and finish your answer',
  'with the following template: FINAL ANSWER: [YOUR FINAL ANSWER].',
  'YOUR FINAL ANSWER should be a number OR as few words as possible OR a comma separated list of numbers',
  'and/or strings.',
  "If you are asked for a number, don't use comma to write your number neither use units such as $ or",
  'percent sign unless specified otherwise.',
  "If you are asked for a string, don't use articles, neither abbreviations (e.g. for cities), and write",
  'the digits in plain text unless specified otherwise.',
  'If you are asked for a comma separated list, apply the above rules depending of whether the element to',
  'be put in the list is a number or a string.',
  '',
  'You have tools: use `web_search` + `fetch_url` to look up live facts on the web, `run_python` to compute',
  '/ parse data / process files, and `read_file` to read an attached file. Verify facts with tools before',
  'answering — do not guess. Base your FINAL ANSWER only on what the tools confirm. When an answer depends',
  'on a live web source, prefer primary/authoritative sources. Keep working until you can give a single',
  'unambiguous answer, then emit exactly one FINAL ANSWER line in the normalized format above.',
].join('\n');

/* -------------------------------------------------------------------------- */
/* Result + config                                                             */
/* -------------------------------------------------------------------------- */

/** Why the agent loop stopped (a GAIA-flavored {@link GenerationStopReason}). */
export type GaiaAgentStopReason =
  | 'done' //              the model ended its turn naturally (we have a final answer)
  | 'max-turns' //         hit the iteration cap
  | 'budget-exhausted' //  hit the token budget cap
  | 'error'; //            an LLM / tool exception aborted the run (infra — excluded from accuracy)

/** One step in the trajectory (for the reasoning trace + debugging; trimmed of huge payloads). */
export interface TrajectoryStep {
  turn: number;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'thinking';
  /** Tool name for tool_use / tool_result steps. */
  tool?: string;
  /** A trimmed text summary of the block. */
  summary: string;
}

export interface GaiaAgentResult {
  taskId: string;
  /** The final assistant text (the grader extracts `FINAL ANSWER:` from this). */
  rawOutput: string;
  /** Convenience pre-extraction (null = no FINAL ANSWER line → a formatting failure). */
  finalAnswer: string | null;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  stopReason: GaiaAgentStopReason;
  trajectory: TrajectoryStep[];
  /** Set when stopReason==='error' — the infra failure detail. */
  error?: string;
}

export interface GaiaAgentConfig {
  /** Max ReAct iterations (LLM turns). Default 25. */
  maxTurns?: number;
  /** Max output tokens per LLM turn. Default 8192. */
  maxTokensPerTurn?: number;
  /** Extended-thinking budget per turn (the xhigh-effort realization). Default 16000. */
  thinkingBudgetTokens?: number;
  /** Hard cap on cumulative (in+out) tokens for the whole task; exceeding it stops with 'budget-exhausted'. */
  maxTotalTokens?: number;
  /** Truncate each tool result to this many chars before feeding it back (bounds context growth). Default 16000. */
  maxToolResultChars?: number;
  /** Truncate a trajectory step summary to this many chars. Default 280. */
  trajectorySummaryChars?: number;
  /** Override the system prompt (default the GAIA FINAL-ANSWER prompt). Sibling suites (GDPval) reuse this
   *  ReAct loop + the run_python-in-scratch toolset with a different output discipline (produce a deliverable). */
  systemPrompt?: string;
}

const DEFAULTS = {
  maxTurns: 25,
  maxTokensPerTurn: 8192,
  thinkingBudgetTokens: 16000,
  maxTotalTokens: 2_000_000,
  maxToolResultChars: 16000,
  trajectorySummaryChars: 280,
} as const;

/* -------------------------------------------------------------------------- */
/* The initial user message (question + attachment as vision/text)             */
/* -------------------------------------------------------------------------- */

const IMAGE_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The media type for an image file name, or null if it is not a (vision-feedable) image. */
export function imageMediaType(fileName: string): string | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXT[ext] ?? null;
}

/**
 * Build the initial user message for a task: the question, plus the attachment handling. An IMAGE
 * attachment is fed directly as a vision block (opus is multimodal); a non-image attachment becomes a note
 * telling the model the file is available to `read_file` / `run_python` (the runner stages it in the python
 * scratch dir). `readImageBase64` is injected so the pure loop never touches the fs.
 */
export async function buildInitialMessage(
  task: GaiaTask,
  readImageBase64?: (filePath: string) => Promise<string>,
): Promise<LlmMessage> {
  const content: UserBlock[] = [{ type: 'text', text: `Question: ${task.question}` }];
  if (task.fileName && task.filePath) {
    const media = imageMediaType(task.fileName);
    if (media && readImageBase64) {
      try {
        const data = await readImageBase64(task.filePath);
        content.push({ type: 'text', text: `An image is attached (${task.fileName}). Examine it to answer.` });
        content.push({ type: 'image', mediaType: media, dataBase64: data });
      } catch {
        content.push({
          type: 'text',
          text: `An image file "${task.fileName}" is attached but could not be loaded; try read_file("${task.fileName}").`,
        });
      }
    } else {
      content.push({
        type: 'text',
        text:
          `An attached file "${task.fileName}" is available in your working directory. ` +
          `Use read_file("${task.fileName}") to read it, or run_python to parse it (e.g. pandas/openpyxl).`,
      });
    }
  }
  return { role: 'user', content };
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

function trim(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [truncated ${s.length - n} chars]`;
}

/** Concatenate the text blocks of an assistant turn. */
function assistantText(blocks: AssistantBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * Run the GAIA agent loop for one task. Pure w.r.t. infra (LLM + tools injected). Returns a fully-accounted
 * {@link GaiaAgentResult}. A thrown LLM/tool error degrades to `stopReason:'error'` with whatever output was
 * accumulated (never throws out of the loop — a single task failure must not abort a 165-task run).
 */
export async function runGaiaAgent(
  task: GaiaTask,
  deps: { llm: LlmFn; tools: GaiaToolset; readImageBase64?: (filePath: string) => Promise<string> },
  config: GaiaAgentConfig = {},
): Promise<GaiaAgentResult> {
  const cfg = { ...DEFAULTS, ...config };
  const trajectory: TrajectoryStep[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let toolCalls = 0;
  let rawOutput = '';
  let stopReason: GaiaAgentStopReason = 'done';
  let error: string | undefined;
  let turn = 0;

  const messages: LlmMessage[] = [await buildInitialMessage(task, deps.readImageBase64)];
  const pushTraj = (kind: TrajectoryStep['kind'], summary: string, tool?: string) =>
    trajectory.push({ turn, kind, summary: trim(summary, cfg.trajectorySummaryChars), ...(tool ? { tool } : {}) });

  try {
    for (turn = 1; turn <= cfg.maxTurns; turn++) {
      const res = await deps.llm({
        system: cfg.systemPrompt ?? GAIA_SYSTEM_PROMPT,
        messages,
        tools: deps.tools.specs,
        maxTokens: cfg.maxTokensPerTurn,
        thinkingBudgetTokens: cfg.thinkingBudgetTokens,
      });
      tokensIn += res.usage.inputTokens;
      tokensOut += res.usage.outputTokens;
      tokensCacheRead += res.usage.cacheReadTokens ?? 0;
      tokensCacheWrite += res.usage.cacheWriteTokens ?? 0;

      messages.push({ role: 'assistant', content: res.content });
      for (const b of res.content) {
        if (b.type === 'text' && b.text.trim()) pushTraj('assistant_text', b.text);
        else if (b.type === 'thinking' && b.thinking.trim()) pushTraj('thinking', b.thinking);
      }
      const text = assistantText(res.content);
      if (text) rawOutput = text; // keep the latest non-empty assistant text as the candidate answer

      const toolUses = res.content.filter(
        (b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use',
      );

      // No tool calls → the model has finished its turn. Done (we have the final answer text).
      if (toolUses.length === 0) {
        stopReason = 'done';
        break;
      }

      // Execute each requested tool, collecting tool_result blocks for the next user turn.
      const toolResults: UserBlock[] = [];
      for (const tu of toolUses) {
        toolCalls++;
        pushTraj('tool_use', `${tu.name}(${trim(JSON.stringify(tu.input), 160)})`, tu.name);
        const handler = deps.tools.handlers[tu.name];
        if (!handler) {
          toolResults.push({ type: 'tool_result', toolUseId: tu.id, content: `Unknown tool: ${tu.name}`, isError: true });
          pushTraj('tool_result', `unknown tool ${tu.name}`, tu.name);
          continue;
        }
        try {
          const out = await handler(tu.input);
          const trimmed = trim(out, cfg.maxToolResultChars);
          toolResults.push({ type: 'tool_result', toolUseId: tu.id, content: trimmed });
          pushTraj('tool_result', trimmed, tu.name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toolResults.push({ type: 'tool_result', toolUseId: tu.id, content: `Tool error: ${msg}`, isError: true });
          pushTraj('tool_result', `error: ${msg}`, tu.name);
        }
      }
      messages.push({ role: 'user', content: toolResults });

      // Budget guard (after a full turn so we always make progress at least once).
      if (tokensIn + tokensOut >= cfg.maxTotalTokens) {
        stopReason = 'budget-exhausted';
        break;
      }
      if (turn === cfg.maxTurns) {
        stopReason = 'max-turns';
      }
    }
  } catch (e) {
    stopReason = 'error';
    error = e instanceof Error ? e.message : String(e);
  }

  return {
    taskId: task.taskId,
    rawOutput,
    finalAnswer: extractFinalAnswer(rawOutput),
    turns: Math.min(turn, cfg.maxTurns),
    toolCalls,
    tokensIn,
    tokensOut,
    tokensCacheRead,
    tokensCacheWrite,
    stopReason,
    trajectory,
    ...(error ? { error } : {}),
  };
}
