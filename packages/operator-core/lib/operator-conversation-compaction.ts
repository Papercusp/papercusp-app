/**
 * Operator conversation compaction — the rolling-summary engine.
 * operator-context-compaction-2026-06-05 (Brief 37).
 *
 * The operator's converse prompt keeps RECENT turns verbatim (the
 * `selectHistoryWithinBudget` window, unchanged) and represents everything
 * older with a rolling summary stored WITH the conversation in PG
 * (migration 168). This module owns the summary's lifecycle:
 *
 *   - **Incremental** (D-003): each compaction folds only the turns that
 *     aged out since the last one — `summarize(old summary + new turns)`;
 *     the whole conversation is never re-read.
 *   - **Post-turn, fire-and-forget**: `maybeCompactConversation` is called
 *     after a converse turn completes (like the mem0 capture); the NEXT
 *     turn picks up the updated summary. Failures never surface to the
 *     user — the prompt degrades to exactly the old window behavior.
 *   - **Metered** (D-004): the summarizer is a one-shot haiku call on the
 *     anthropic-direct backend, which already rides the shared RateLimitGovernor
 *     and reports usage telemetry; on top, compaction is gated on the
 *     operator daily budget and its cost recorded via `recordSpend`.
 *   - **Concurrency-safe**: an in-process single-flight set stops the same
 *     host double-firing; the PG write CASes on `summary_through_seq` so
 *     cross-process racers resolve cleanly (the loser discards).
 */

import { estimateTokens } from './operator-converse-history';
import {
  listTurnsBetween,
  maxTurnSeq,
  readConversationSummary,
  writeConversationSummary,
  type TurnRow,
} from './operator-conversations';
import { runHaikuTurn, type HaikuTurnResult } from './haiku';
import { checkBudget, recordSpend } from './operator-budget';
import { loadCompactionPriorities } from './prompt-assembly';

/**
 * How many newest turns stay OUT of the summary (the uncompacted tail).
 * Far below what the 40k-token verbatim window holds (D-003), so the
 * summary always covers everything the window can drop.
 */
export const KEEP_RECENT_TURNS = 12;
/** Compact only when at least this many uncovered turns have aged out… */
export const MIN_NEW_TURNS = 8;
/** …or when the aged-out backlog is this big in estimated tokens. */
export const MIN_NEW_TOKENS = 4000;
/** Stored-summary hard cap (D-006) — ~1.5k tokens. */
export const MAX_SUMMARY_CHARS = 6000;
/** Per-folded-turn char cap inside the summarizer prompt. */
const PROMPT_TURN_CHARS = 2000;
/**
 * Upper bound on turns folded per compaction pass — a huge backlog (e.g.
 * compaction newly enabled on an old conversation) is digested across
 * several post-turn passes instead of one oversized prompt.
 */
export const MAX_TURNS_PER_PASS = 60;
/** Output budget for the summarizer call (cap is in chars ≈ 4·tokens). */
const SUMMARIZER_MAX_TOKENS = 2000;
/** The compactor prompt is bigger than a one-line digest — wider bound. */
const SUMMARIZER_TIMEOUT_MS = 45_000;

export type CompactionOutcome =
  | 'compacted'
  | 'up_to_date'
  | 'below_threshold'
  | 'nothing_to_fold'
  | 'budget_exceeded'
  | 'llm_unavailable'
  | 'cas_lost'
  | 'not_found';

export interface CompactionResult {
  outcome: CompactionOutcome;
  /** Set when outcome === 'compacted'. */
  summaryThroughSeq?: number;
  turnsFolded?: number;
  costUsd?: number;
}

/** Signature of the summarize step — injectable for tests (D-003). */
export type SummarizeFn = (prompt: string) => Promise<HaikuTurnResult | null>;

/**
 * The default preserve/drop priorities. The canonical source is
 * apps/operator/prompts/papercusp-compaction.base.md (loaded via
 * loadCompactionPriorities); this literal is the built-in fallback + the unit
 * test default, so buildCompactionPrompt stays pure. agent-managed-compaction-2026-07-01.
 */
export const DEFAULT_COMPACTION_PRIORITIES =
  `Preserve with highest priority:\n` +
  `- decisions made, and why\n` +
  `- preferences / standing instructions the user stated\n` +
  `- named artifacts: plans, features (F-NNN), work items, files, harnesses, URLs\n` +
  `- owner-facing open threads outside the active task: each unanswered user question or promised investigation, until answered, withdrawn, or superseded\n` +
  `- open questions, commitments, unfinished work\n` +
  `Compress or drop: greetings, transient status chatter, superseded states.`;

/**
 * Build the incremental summarizer prompt. Pure + exported for unit test.
 * `priorities` defaults to the built-in literal; the caller passes the canonical
 * file body (loadCompactionPriorities) so it stays purely a projection consumer.
 */
export function buildCompactionPrompt(
  existingSummary: string | null,
  turns: ReadonlyArray<Pick<TurnRow, 'role' | 'text'>>,
  priorities: string = DEFAULT_COMPACTION_PRIORITIES,
): string {
  const formatted = turns
    .map((t) => `[${t.role}] ${t.text.slice(0, PROMPT_TURN_CHARS)}`)
    .join('\n\n');
  return (
    `You maintain the rolling memory of a long conversation between a user ` +
    `and their operator assistant. Merge the EXISTING SUMMARY (older context) ` +
    `with the NEW TURNS (which just aged out of the verbatim window) into ONE ` +
    `updated summary.\n\n` +
    `${priorities}\n\n` +
    `HARD LIMIT: at most ${MAX_SUMMARY_CHARS} characters. Plain text, short ` +
    `bullets allowed. No preamble, no headings — output the summary only.\n\n` +
    `EXISTING SUMMARY:\n${existingSummary?.trim() || '(none — conversation start)'}\n\n` +
    `NEW TURNS (oldest first):\n${formatted}\n\n` +
    `UPDATED SUMMARY:`
  );
}

/**
 * Normalize a raw summarizer reply for storage: trim, strip a leading
 * echoed label, enforce the char cap. Pure + exported for unit test.
 */
export function sanitizeSummary(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^updated summary:\s*/i, '').trim();
  if (s.length > MAX_SUMMARY_CHARS) {
    s = s.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd() + '…';
  }
  return s;
}

/**
 * Threshold check — fold only when the uncovered aged-out backlog is worth
 * a model call. Pure + exported for unit test.
 */
export function backlogWorthCompacting(
  turns: ReadonlyArray<Pick<TurnRow, 'text'>>,
): boolean {
  if (turns.length >= MIN_NEW_TURNS) return true;
  let tokens = 0;
  for (const t of turns) tokens += estimateTokens(t.text);
  return tokens >= MIN_NEW_TOKENS;
}

const defaultSummarize: SummarizeFn = (prompt) =>
  runHaikuTurn(prompt, { maxTokens: SUMMARIZER_MAX_TOKENS, timeoutMs: SUMMARIZER_TIMEOUT_MS });

/**
 * One compaction pass over a conversation. Returns the outcome rather than
 * throwing for every expected condition; only unexpected DB errors throw.
 *
 * `opts.summarize` injects the model step for tests; `opts.force` skips the
 * backlog threshold (used by tests and a future manual "compact now" verb).
 */
export async function compactConversation(
  conversationId: string,
  opts: { summarize?: SummarizeFn; force?: boolean } = {},
): Promise<CompactionResult> {
  const summary = await readConversationSummary(conversationId);
  if (!summary) return { outcome: 'not_found' };

  const newest = await maxTurnSeq(conversationId);
  if (newest === null) return { outcome: 'nothing_to_fold' };

  const cutoff = newest - KEEP_RECENT_TURNS;
  const covered = summary.summaryThroughSeq ?? -1;
  if (cutoff <= covered) return { outcome: 'up_to_date' };

  const aged = (await listTurnsBetween(conversationId, summary.summaryThroughSeq, cutoff))
    .filter((t) => t.text.trim().length > 0);
  if (aged.length === 0) return { outcome: 'nothing_to_fold' };
  if (!opts.force && !backlogWorthCompacting(aged)) {
    return { outcome: 'below_threshold' };
  }

  // Operator daily budget gate (D-004) — when capped, skip silently; the
  // conversation still works on the verbatim-window floor.
  const budget = await checkBudget();
  if (budget.state && budget.exceeded) return { outcome: 'budget_exceeded' };

  // Bound one pass; a long backlog digests across successive passes.
  const batch = aged.slice(0, MAX_TURNS_PER_PASS);
  const throughSeq = batch[batch.length - 1].seq;

  const summarize = opts.summarize ?? defaultSummarize;
  const result = await summarize(
    buildCompactionPrompt(summary.summaryText, batch, loadCompactionPriorities() ?? undefined),
  );
  if (!result) return { outcome: 'llm_unavailable' };
  const text = sanitizeSummary(result.text);
  if (!text) return { outcome: 'llm_unavailable' };

  if (result.costUsd > 0) void recordSpend(result.costUsd);

  const ok = await writeConversationSummary({
    conversationId,
    expectedThroughSeq: summary.summaryThroughSeq,
    summaryText: text,
    summaryThroughSeq: throughSeq,
    summaryModel: result.model,
    turnsAdded: batch.length,
  });
  if (!ok) return { outcome: 'cas_lost' };
  return {
    outcome: 'compacted',
    summaryThroughSeq: throughSeq,
    turnsFolded: batch.length,
    costUsd: result.costUsd,
  };
}

/** In-process single-flight: one compaction per conversation at a time. */
const inFlight = new Set<string>();

/**
 * Post-turn entry point — fire-and-forget. Never throws; logs the outcome
 * at debug level only when it actually compacted (or hit a real failure).
 */
export async function maybeCompactConversation(conversationId: string): Promise<void> {
  if (!conversationId || inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  try {
    const r = await compactConversation(conversationId);
    if (r.outcome === 'compacted') {
      console.log(
        `[conversation-compaction] ${conversationId}: folded ${r.turnsFolded} turns ` +
          `(through seq ${r.summaryThroughSeq}, $${(r.costUsd ?? 0).toFixed(4)})`,
      );
    } else if (r.outcome === 'llm_unavailable') {
      console.warn(`[conversation-compaction] ${conversationId}: summarizer unavailable`);
    }
  } catch (err) {
    console.warn(
      '[conversation-compaction] pass failed:',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    inFlight.delete(conversationId);
  }
}
