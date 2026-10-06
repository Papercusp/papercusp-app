/**
 * jev-live-drop-quality.ts — are the Jev memory filter's drops CORRECT on real
 * traffic? (WI-10004485 step B; plan jev-decision-model-integration-2026-09-29.)
 *
 * In Log only (shadow), every live injection fires one Jev request and the
 * decision ledger (`decision_model_calls`, consumer `memory-injection`) records
 * the memory ids judged (`subject_ids`) and every P(yes) (`answers`). It does
 * NOT record the text: `state_sha256` is a hash of `{ message }`. The bench never
 * measured a drop fraction on real traffic, and the first shadow hour showed
 * ~45-50% of candidates would drop. This module answers whether those drops are
 * right, without guessing at the contexts:
 *
 *  1. Rebuild candidate recall queries from the raw session transcripts, using
 *     the SAME functions production uses (the hook's `buildDigest`, the server's
 *     `deriveBatchQuery` + clamp + `splitLegQueries`).
 *  2. Keep a rebuilt query only when `stateSha256({ message })` EQUALS the
 *     ledger row's `state_sha256`. A match is an exact recovery, not a proxy;
 *     the match rate is reported, so a drift in either side shows up as a low
 *     rate instead of as silently wrong contexts.
 *  3. Grade every (query, memory) pair with the existing relevance judge and
 *     compare the judge's verdict with Jev's keep/drop at a threshold.
 *
 * Pure functions only; the IO lives in jev-live-drop-quality-cli.ts.
 */
import { stateSha256 } from '@papercusp/decision-model';

import {
  deriveBatchQuery,
  QUERY_CLAMP,
  splitLegQueries,
  type BatchCall,
} from '../../endpoint-route/routes/agent-mcp/mid-turn-context';
import { PROMPT_QUERY_CLAMP } from '../../endpoint-route/routes/agent-mcp/turn-start-memory';
import { stripInjectedChrome } from '../../turn-provenance/turn-provenance';

/** One tool batch as the PostToolBatch hook would have shipped it, before the digest clamp. */
export interface TranscriptBatch {
  /** ISO timestamp of the batch's first tool call. */
  readonly at: string;
  readonly calls: readonly BatchCall[];
}

interface TranscriptEntry {
  type?: unknown;
  timestamp?: unknown;
  message?: { id?: unknown; content?: unknown };
  toolUseResult?: unknown;
}

/**
 * Group a Claude transcript (parsed JSONL entries, file order) into tool batches.
 *
 * A batch is the tool_use blocks of ONE assistant message (Claude writes a
 * parallel batch as several JSONL lines sharing `message.id`), paired with each
 * call's result. The result comes from the user line's `toolUseResult`, the same
 * structured value the hook receives as `tool_response`; when it is absent the
 * tool_result block's own content stands in.
 */
export function transcriptBatches(entries: readonly unknown[]): TranscriptBatch[] {
  type Call = { id: string; tool: string; toolInput: unknown; toolResponse?: unknown };
  const batches: { at: string; messageId: string; calls: Call[] }[] = [];
  const byUseId = new Map<string, Call>();
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as TranscriptEntry;
    const content = Array.isArray(e.message?.content) ? (e.message!.content as Record<string, unknown>[]) : [];
    if (e.type === 'assistant') {
      const messageId = typeof e.message?.id === 'string' ? e.message.id : '';
      for (const block of content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
        let batch = batches[batches.length - 1];
        if (!batch || !messageId || batch.messageId !== messageId) {
          batch = { at: typeof e.timestamp === 'string' ? e.timestamp : '', messageId, calls: [] };
          batches.push(batch);
        }
        const call: Call = { id: block.id, tool: typeof block.name === 'string' ? block.name : '', toolInput: block.input };
        batch.calls.push(call);
        byUseId.set(block.id, call);
      }
    } else if (e.type === 'user') {
      for (const block of content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const call = byUseId.get(block.tool_use_id);
        if (call) call.toolResponse = e.toolUseResult !== undefined ? e.toolUseResult : block.content;
      }
    }
  }
  return batches.map((b) => ({
    at: b.at,
    calls: b.calls.map(({ tool, toolInput, toolResponse }) => ({ tool, toolInput, toolResponse })),
  }));
}

/**
 * The mid-turn recall query production builds for a batch: the hook's digest
 * (`digest`, injected so this module never imports the hook script), then the
 * server's derive → clamp → cosine-leg split. Empty when the batch has no signal.
 */
export function midTurnQueryOf(calls: readonly BatchCall[], digest: (calls: BatchCall[]) => BatchCall[]): string {
  const derived = deriveBatchQuery(digest([...calls])).slice(0, QUERY_CLAMP);
  return derived ? splitLegQueries(derived).cosine : '';
}

/** One prompt as the UserPromptSubmit hook would have received it. */
export interface TranscriptPrompt {
  readonly at: string;
  readonly text: string;
}

/**
 * The user prompts in a Claude transcript (parsed JSONL entries, file order).
 * A user line carrying a tool_result is a tool reply, not a prompt; a prompt is
 * either a string or text blocks (joined with newlines).
 */
export function transcriptPrompts(entries: readonly unknown[]): TranscriptPrompt[] {
  const out: TranscriptPrompt[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as TranscriptEntry;
    if (e.type !== 'user') continue;
    const content = e.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = content as Record<string, unknown>[];
      if (blocks.some((b) => b?.type === 'tool_result')) continue;
      text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    }
    if (!text.trim()) continue;
    out.push({ at: typeof e.timestamp === 'string' ? e.timestamp : '', text });
  }
  return out;
}

/**
 * The turn-start recall query production builds for a prompt, which is also the
 * Jev gate's message there: the endpoint trims the prompt, strips injected
 * chrome, and clamps (turn-start-memory.ts); `retrievalQueryText` then returns
 * that `userText` unchanged.
 */
export function turnStartQueryOf(prompt: string): string {
  return stripInjectedChrome(prompt.trim()).slice(0, PROMPT_QUERY_CLAMP);
}

/** The ledger's `state_sha256` for a gate request with this message (instructions encoding). */
export function gateStateSha(message: string): string {
  return stateSha256({ message });
}

/** One judged candidate of one recovered live call. */
export interface GradedCandidate {
  /** Jev's P(yes) for this memory. */
  readonly pYes: number;
  /** The judge's verdict: would this memory concretely help with this context? */
  readonly relevant: boolean;
}

export interface DropQuality {
  readonly threshold: number;
  readonly candidates: number;
  readonly relevant: number;
  readonly drops: number;
  readonly dropsRelevant: number;
  readonly keeps: number;
  readonly keepsRelevant: number;
  /** Share of all candidates Jev drops. */
  readonly dropRate: number | null;
  /** Share of Jev's drops the judge calls irrelevant: how often a drop is right. */
  readonly dropPrecision: number | null;
  /** Share of judge-relevant memories Jev drops: what On would lose. */
  readonly relevantLossRate: number | null;
  /** Share of injected memories that are relevant, without Jev (floor only). */
  readonly precisionWithout: number | null;
  /** The same share among the memories Jev keeps. */
  readonly precisionWith: number | null;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

/** Compare Jev's keep/drop at `threshold` with the judge's verdicts. */
export function dropQuality(graded: readonly GradedCandidate[], threshold: number): DropQuality {
  let relevant = 0;
  let drops = 0;
  let dropsRelevant = 0;
  for (const g of graded) {
    if (g.relevant) relevant += 1;
    if (g.pYes < threshold) {
      drops += 1;
      if (g.relevant) dropsRelevant += 1;
    }
  }
  const keeps = graded.length - drops;
  const keepsRelevant = relevant - dropsRelevant;
  return {
    threshold,
    candidates: graded.length,
    relevant,
    drops,
    dropsRelevant,
    keeps,
    keepsRelevant,
    dropRate: ratio(drops, graded.length),
    dropPrecision: ratio(drops - dropsRelevant, drops),
    relevantLossRate: ratio(dropsRelevant, relevant),
    precisionWithout: ratio(relevant, graded.length),
    precisionWith: ratio(keepsRelevant, keeps),
  };
}

/**
 * Read the P(yes) of each candidate from a ledger `answers` value. Question ids
 * are `m1..mN`, index-aligned with `subject_ids` (admissionQuestionId); a missing
 * or non-numeric answer is null, never a guessed score.
 */
export function pYesByIndex(answers: unknown, count: number): (number | null)[] {
  const out: (number | null)[] = [];
  const rec = answers && typeof answers === 'object' ? (answers as Record<string, { pYes?: unknown }>) : {};
  for (let i = 0; i < count; i++) {
    const p = rec[`m${i + 1}`]?.pYes;
    out.push(typeof p === 'number' && Number.isFinite(p) ? p : null);
  }
  return out;
}
