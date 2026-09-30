/**
 * GAIA hive-decomposition arm (plan `benchmark-suite-gaia-2026-06-17`, P-007).
 *
 * GAIA is fundamentally single-agent, but the HONEST place our multi-agent value could show is the hardest
 * tier: L3 questions are long multi-hop chains, and a hive can DECOMPOSE one into independent sub-queries,
 * answer them in parallel across sub-agents, then SYNTHESIZE a single final answer. This module is that arm —
 * a wrapper over the same {@link runGaiaAgent} loop the single-opus baseline uses, so the only delta is the
 * decompose→fan-out→synthesize structure (fair A/B vs the baseline on the SAME L3 tasks).
 *
 * Flow:  decompose(question) → [sub-q1, sub-q2, …]  →  run each sub-q through a full agent (web/code/file)
 *        →  synthesize(question, sub-answers) → `FINAL ANSWER: …`.
 *
 * PURE w.r.t. infra: the LLM ({@link LlmFn}, for decompose+synthesize) and the sub-agent runner are INJECTED,
 * so the orchestration is unit-testable with fakes (no spend). The result is a {@link GaiaAgentResult} with
 * tokens/turns/tool-calls SUMMED across decompose + every sub-agent + synthesize (so the cost comparison vs
 * the single-opus baseline counts the coordination overhead — the same fairness rule the impartial suite uses).
 */
import { extractFinalAnswer } from '../grader/gaia';
import { GAIA_SYSTEM_PROMPT, type GaiaAgentResult, type GaiaAgentStopReason, type LlmFn, type TrajectoryStep } from './agent';
import type { GaiaTask } from './dataset';

/** Parse an LLM decomposition response → sub-questions. Accepts a JSON array, or numbered/bulleted lines. */
export function parseSubQuestions(text: string, max: number): string[] {
  // 1) a JSON array anywhere in the text
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const v = JSON.parse(arr[0]) as unknown;
      if (Array.isArray(v)) {
        const subs = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
        if (subs.length) return subs.slice(0, max);
      }
    } catch {
      /* fall through to line parsing */
    }
  }
  // 2) numbered / bulleted lines
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0 && /\?|\bwhat\b|\bwho\b|\bwhen\b|\bwhere\b|\bhow\b|\bwhich\b|find|compute|identify/i.test(l));
  return lines.slice(0, max);
}

const DECOMPOSE_SYSTEM =
  'You are a research planner. Break the user question into a SHORT list of INDEPENDENT sub-questions, each ' +
  'answerable on its own with web/file/code tools, that together let you answer the original. Output ONLY a ' +
  'JSON array of sub-question strings (2–4 items). If the question is already atomic, return a 1-item array.';

const SYNTH_SYSTEM = GAIA_SYSTEM_PROMPT; // synthesis must end with the normalized FINAL ANSWER line too

export interface HiveArmConfig {
  /** Max sub-questions to fan out (default 4). */
  maxSubQuestions?: number;
  /** Max tokens for the decompose/synthesize LLM calls (default 4096). */
  planTokens?: number;
  /** Trajectory summary char cap (default 280). */
  trajectorySummaryChars?: number;
}

export interface HiveArmDeps {
  /** LLM for the decompose + synthesize steps (no tools). */
  llm: LlmFn;
  /** Run ONE sub-question through a full GAIA agent (web/code/file). Usually a closure over runGaiaAgent + live tools. */
  runSubAgent: (subTask: GaiaTask) => Promise<GaiaAgentResult>;
}

function trim(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Pull the concatenated assistant text from an LLM turn response. */
function textOf(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
    .trim();
}

/**
 * Run the hive-decomposition arm for one (L3) task. Returns a {@link GaiaAgentResult} shaped exactly like the
 * single-opus baseline (so the grader + run pipeline treat it identically), with `armMeta`-style detail folded
 * into the trajectory. Any decompose/synthesize/sub-agent failure degrades to `stopReason:'error'` (infra
 * exclusion) rather than throwing.
 */
export async function runHiveArm(task: GaiaTask, deps: HiveArmDeps, config: HiveArmConfig = {}): Promise<GaiaAgentResult> {
  const maxSub = config.maxSubQuestions ?? 4;
  const planTokens = config.planTokens ?? 4096;
  const trajCap = config.trajectorySummaryChars ?? 280;
  const trajectory: TrajectoryStep[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let toolCalls = 0;
  let turns = 0;
  const acc = (u: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }) => {
    tokensIn += u.inputTokens;
    tokensOut += u.outputTokens;
    tokensCacheRead += u.cacheReadTokens ?? 0;
    tokensCacheWrite += u.cacheWriteTokens ?? 0;
    turns += 1;
  };

  try {
    // 1) DECOMPOSE
    const decRes = await deps.llm({
      system: DECOMPOSE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: task.question }] }],
      tools: [],
      maxTokens: planTokens,
    });
    acc(decRes.usage);
    const subQuestions = parseSubQuestions(textOf(decRes.content), maxSub);
    const subs = subQuestions.length ? subQuestions : [task.question]; // atomic fallback
    trajectory.push({ turn: 1, kind: 'assistant_text', summary: trim(`decomposed → ${subs.length}: ${subs.join(' | ')}`, trajCap) });

    // 2) FAN OUT — one full agent per sub-question (the sub-task carries no attachment; the original task's
    //    file, if any, is handled by the synthesis step referencing it via the baseline path).
    const subResults = await Promise.all(
      subs.map((q, i) =>
        deps
          .runSubAgent({ taskId: `${task.taskId}#sub${i + 1}`, question: q, level: task.level, finalAnswer: '', fileName: task.fileName, filePath: task.filePath })
          .then((r) => ({ q, r })),
      ),
    );
    for (const { q, r } of subResults) {
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      tokensCacheRead += r.tokensCacheRead;
      tokensCacheWrite += r.tokensCacheWrite;
      toolCalls += r.toolCalls;
      turns += r.turns;
      trajectory.push({ turn: 2, kind: 'tool_use', tool: 'sub_agent', summary: trim(`${q} → ${r.finalAnswer ?? r.rawOutput}`, trajCap) });
    }

    // 3) SYNTHESIZE
    const evidence = subResults
      .map(({ q, r }, i) => `Sub-question ${i + 1}: ${q}\nAnswer: ${r.finalAnswer ?? r.rawOutput}`)
      .join('\n\n');
    const synthRes = await deps.llm({
      system: SYNTH_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Original question: ${task.question}\n\nHere is what sub-agents found:\n\n${evidence}\n\nUsing this evidence, give the single best answer to the original question. End with the normalized FINAL ANSWER line.`,
            },
          ],
        },
      ],
      tools: [],
      maxTokens: planTokens,
    });
    acc(synthRes.usage);
    const rawOutput = textOf(synthRes.content);
    trajectory.push({ turn: 3, kind: 'assistant_text', summary: trim(rawOutput, trajCap) });

    const finalAnswer = extractFinalAnswer(rawOutput);
    const anySubError = subResults.some(({ r }) => r.stopReason === 'error');
    const stopReason: GaiaAgentStopReason = anySubError && !finalAnswer ? 'error' : 'done';
    return {
      taskId: task.taskId,
      rawOutput,
      finalAnswer,
      turns,
      toolCalls,
      tokensIn,
      tokensOut,
      tokensCacheRead,
      tokensCacheWrite,
      stopReason,
      trajectory,
      ...(anySubError && !finalAnswer ? { error: 'a sub-agent failed and synthesis produced no answer' } : {}),
    };
  } catch (e) {
    return {
      taskId: task.taskId,
      rawOutput: '',
      finalAnswer: null,
      turns,
      toolCalls,
      tokensIn,
      tokensOut,
      tokensCacheRead,
      tokensCacheWrite,
      stopReason: 'error',
      trajectory,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
