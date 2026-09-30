import type { PortableTurn } from './types';
import { renderPortableTurns } from './render';
import { sanitizePortableText } from './security';
import { SESSION_PORT_TOKEN_ESTIMATOR } from './types';

export const SESSION_PORT_SUMMARY_PROMPT_VERSION = 1;
export const MAX_SUMMARIZER_INPUT_BYTES = 400_000;
const MIN_SUMMARY_OUTPUT_BUDGET = 128;
const OUTPUT_BYTES_PER_REQUESTED_TOKEN = 4;
const MAX_SUMMARIZER_OUTPUT_TOKENS = 16_384;

export type SessionPortSummarizer = (input: {
  text: string;
  promptVersion: number;
  chunk: number;
  chunks: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}) => Promise<{ text: string; model: string; provider: string; costUsd?: number | null }>;

/** Byte-level model tokenizers cannot emit more tokens than UTF-8 bytes. This
 * deliberately conservative upper bound is portable across Codex/OMP models
 * whose exact tokenizer is not available to the operator. */
export const estimatePortableTokens = (text: string): number => Buffer.byteLength(text, 'utf8');

function atomicTurnGroups(turns: PortableTurn[]): PortableTurn[][] {
  const groups: PortableTurn[][] = [];
  for (const turn of turns) {
    const hasResult = turn.blocks.some((block) => block.type === 'tool_narrative' && block.event === 'result');
    const previous = groups.at(-1);
    const resultRelations = new Set(turn.blocks.flatMap((block) =>
      block.type === 'tool_narrative' && block.event === 'result' && block.relationId
        ? [block.relationId]
        : []));
    const previousHasLinkedCall = previous?.some((candidate) => candidate.blocks.some((block) =>
      block.type === 'tool_narrative' &&
      block.event === 'call' &&
      block.relationId != null &&
      resultRelations.has(block.relationId)));
    if (hasResult && previousHasLinkedCall) previous!.push(turn);
    else if (turn.role !== 'user' && previous) previous.push(turn);
    else groups.push([turn]);
  }
  return groups;
}

function chunkAtomicGroups(groups: PortableTurn[][]): PortableTurn[][] {
  const chunks: PortableTurn[][] = [];
  let current: PortableTurn[] = [];
  for (const group of groups) {
    const groupBytes = Buffer.byteLength(renderPortableTurns(group).text, 'utf8');
    if (groupBytes > MAX_SUMMARIZER_INPUT_BYTES) {
      throw new Error(`session port atomic conversation/tool group exceeds summarizer input cap (${groupBytes} > ${MAX_SUMMARIZER_INPUT_BYTES} bytes)`);
    }
    const candidate = [...current, ...group];
    if (current.length && Buffer.byteLength(renderPortableTurns(candidate).text, 'utf8') > MAX_SUMMARIZER_INPUT_BYTES) {
      chunks.push(current);
      current = [...group];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function summaryTranscript(summaryTexts: string[], tail: PortableTurn[]): string {
  return [
    '### SYSTEM · CROSS-BACKEND SUMMARY OF OLDER HISTORY',
    ...summaryTexts.map((text, index) => `#### SUMMARY CHUNK ${index + 1}/${summaryTexts.length}\n${text}`),
    '### SYSTEM · RECENT VERBATIM TAIL',
    renderPortableTurns(tail).text,
  ].join('\n\n');
}

export async function fitPortableTurns(input: {
  turns: PortableTurn[];
  availableTokens: number;
  summarizer?: SessionPortSummarizer | null;
  timeoutMs?: number;
  renderPayload?: (transcript: string, fidelity: 'full' | 'summary-tail') => string;
}): Promise<{
  fidelity: 'full' | 'summary-tail';
  transcript: string;
  estimatedTokens: number;
  tokenEstimator: typeof SESSION_PORT_TOKEN_ESTIMATOR;
  summaryOutputRedactions: number;
  summary?: {
    model: string;
    provider: string;
    costUsd: number;
    chunks: number;
    promptVersion: number;
    outputBudgetTokens: number;
    maxOutputTokensPerChunk: number;
  };
}> {
  const full = renderPortableTurns(input.turns).text;
  const measure = (transcript: string, fidelity: 'full' | 'summary-tail') =>
    estimatePortableTokens(input.renderPayload?.(transcript, fidelity) ?? transcript);
  const fullTokens = measure(full, 'full');
  if (fullTokens <= input.availableTokens) {
    return {
      fidelity: 'full',
      transcript: full,
      estimatedTokens: fullTokens,
      tokenEstimator: SESSION_PORT_TOKEN_ESTIMATOR,
      summaryOutputRedactions: 0,
    };
  }
  if (!input.summarizer) throw new Error('session port requires summarization, but no summarizer is available');

  const groups = atomicTurnGroups(input.turns);
  if (groups.length < 2) {
    throw new Error('session port cannot fit the latest required atomic conversation/tool group in the target budget');
  }
  let selected: { chunks: PortableTurn[][]; tail: PortableTurn[]; outputBudget: number } | null = null;
  for (let split = 1; split < groups.length; split++) {
    const chunks = chunkAtomicGroups(groups.slice(0, split));
    const tail = groups.slice(split).flat();
    const baseline = summaryTranscript(chunks.map(() => ''), tail);
    const baselineTokens = measure(baseline, 'summary-tail');
    const outputBudget = input.availableTokens - baselineTokens;
    if (outputBudget >= chunks.length * MIN_SUMMARY_OUTPUT_BUDGET) {
      selected = { chunks, tail, outputBudget };
      break;
    }
  }
  if (!selected) {
    throw new Error('session port cannot fit the latest required atomic conversation/tool group plus bounded summary output');
  }
  const perChunkBudget = Math.floor(selected.outputBudget / selected.chunks.length);
  const maxOutputTokens = Math.min(
    MAX_SUMMARIZER_OUTPUT_TOKENS,
    Math.max(1, Math.floor(perChunkBudget / OUTPUT_BYTES_PER_REQUESTED_TOKEN)),
  );
  const summaries: string[] = [];
  let model = '';
  let provider = '';
  let costUsd = 0;
  let summaryOutputRedactions = 0;
  for (const [index, chunk] of selected.chunks.entries()) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), input.timeoutMs ?? 45_000);
    try {
      const result = await input.summarizer({
        text: renderPortableTurns(chunk).text,
        promptVersion: SESSION_PORT_SUMMARY_PROMPT_VERSION,
        chunk: index + 1,
        chunks: selected.chunks.length,
        maxOutputTokens,
        signal: ac.signal,
      });
      const safe = sanitizePortableText(result.text);
      summaryOutputRedactions += safe.redactions;
      const outputTokens = estimatePortableTokens(safe.text);
      if (!safe.text.trim() || outputTokens > perChunkBudget) {
        throw new Error(`summarizer returned empty or oversized output for chunk ${index + 1} (${outputTokens} > ${perChunkBudget})`);
      }
      summaries.push(safe.text);
      model = result.model;
      provider = result.provider;
      costUsd += Number(result.costUsd ?? 0);
    } finally {
      clearTimeout(timer);
    }
  }
  const transcript = summaryTranscript(summaries, selected.tail);
  const total = measure(transcript, 'summary-tail');
  if (total > input.availableTokens) throw new Error(`session port still exceeds target budget (${total} > ${input.availableTokens})`);
  return {
    fidelity: 'summary-tail',
    transcript,
    estimatedTokens: total,
    tokenEstimator: SESSION_PORT_TOKEN_ESTIMATOR,
    summaryOutputRedactions,
    summary: {
      model,
      provider,
      costUsd,
      chunks: selected.chunks.length,
      promptVersion: SESSION_PORT_SUMMARY_PROMPT_VERSION,
      outputBudgetTokens: selected.outputBudget,
      maxOutputTokensPerChunk: maxOutputTokens,
    },
  };
}
