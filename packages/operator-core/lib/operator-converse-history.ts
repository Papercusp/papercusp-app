/**
 * Token-budgeted history selection for the operator-converse brain.
 *
 * Replaces the legacy `HISTORY_KEEP = 30` fixed-count truncation with
 * a token-budgeted walker. Walks newest → oldest, accumulating until
 * `budgetTokens` is exhausted, then returns the kept window in
 * chronological order.
 *
 * The 4-chars-per-token heuristic is a conventional approximation —
 * exact tokenization would require an embedded tokenizer, which is
 * overkill for a budget gate. Off by ~10-15% on English prose, well
 * within the slack of a 5k-150k user-configurable budget.
 *
 * Per-turn-char cap (default 8000) mirrors the existing
 * MAX_USER_TURN_CHARS guard so a single pasted-dump turn can't single-
 * handedly burn the whole budget.
 */

export const DEFAULT_MAX_TURN_CHARS = 8000;
/** Approximate tokens added per kept message for role labels / framing. */
const PER_TURN_OVERHEAD = 8;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export interface HistoryMessage {
  role: string;
  content: string;
}

/**
 * Return the most recent messages whose total estimated token cost
 * fits within `budgetTokens`. Each message is pre-truncated to
 * `maxTurnChars`. Order in the returned array is chronological
 * (oldest first within the kept window) — same order the brain
 * expects.
 *
 * Edge cases:
 *   - budgetTokens <= 0      → []
 *   - messages empty / nullish → []
 *   - all messages over budget → at least one most-recent kept
 *     (its truncation absorbs the overflow). Rationale: returning
 *     zero history when the latest user turn is huge would leave the
 *     brain blind to the message it's responding to.
 */
export function selectHistoryWithinBudget<M extends HistoryMessage>(
  messages: ReadonlyArray<M> | null | undefined,
  budgetTokens: number,
  maxTurnChars: number = DEFAULT_MAX_TURN_CHARS,
): M[] {
  if (!messages || messages.length === 0) return [];
  if (budgetTokens <= 0) return [];
  const kept: M[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const content = m.content ?? '';
    const truncated = content.length > maxTurnChars
      ? content.slice(0, maxTurnChars) + '…'
      : content;
    const cost = estimateTokens(truncated) + PER_TURN_OVERHEAD;
    // Always keep the most recent message even if it alone exceeds
    // the budget — the brain needs context for what it's responding
    // to. Subsequent messages still respect the budget.
    if (kept.length > 0 && used + cost > budgetTokens) break;
    used += cost;
    kept.push({ ...m, content: truncated });
  }
  return kept.reverse();
}
