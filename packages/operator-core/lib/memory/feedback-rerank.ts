/**
 * memory_feedback → recall re-ranking/dedup (EI-366 / consume-edges P-031).
 *
 * The feedback table has been WRITTEN on every user-driven mutation since
 * migration 062 but nothing ever read it back into recall. Two real
 * consumers live here:
 *
 *  1. **Tombstone dedup** — a deleted memory is removed from the canonical
 *     (cosine) store, but the hybrid backend's lexical projection is only
 *     reconciled by re-projection, not per-delete (see hybrid-backend.ts),
 *     so a deleted fact can ghost back through the lexical leg. Hits whose
 *     `id` or `metadata.link_id` match a recorded delete are suppressed.
 *
 *  2. **Deleted-content demotion** — content the user explicitly deleted
 *     that re-enters the store under a NEW id (mem0 re-extracting the same
 *     junk from a later conversation) matches the delete's `prior_text`
 *     snapshot by normalized text. The pull path (memory:search) demotes
 *     it; the push path (pre-turn injection) drops it outright — injecting
 *     content the user deleted is worse than a missed recall, and the pull
 *     path still finds it on demand.
 *
 * Best-effort by contract: callers load signals in a try/catch and skip
 * the pass on any failure — feedback consumption is hygiene, never
 * load-bearing.
 */
import type { Sql } from 'postgres';
import type { MemoryEntry } from './backend';

export interface FeedbackSignals {
  /** mem_ids with a recorded delete/forget_all — tombstones. */
  deletedIds: Set<string>;
  /** Normalized prior_text snapshots of deleted memories. */
  deletedTexts: Set<string>;
}

/** Score multiplier for a demoted (deleted-content) hit on the pull path. */
export const DELETED_TEXT_PENALTY = 0.5;

/** Feedback look-back window (days) — old deletions stop suppressing. */
export const FEEDBACK_WINDOW_DAYS = 30;

/** Row cap on the signals load — bounds the per-recall cost. */
export const FEEDBACK_SIGNALS_LIMIT = 500;

/** Whitespace/case-insensitive content identity for prior_text matching. */
export function normalizeMemoryText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One indexed read over harness_shared.memory_feedback: the recent
 * delete/forget_all rows, as tombstone ids + normalized prior texts.
 */
export async function loadFeedbackSignals(
  sql: Sql,
  opts: { days?: number; limit?: number } = {},
): Promise<FeedbackSignals> {
  const days = opts.days ?? FEEDBACK_WINDOW_DAYS;
  const limit = opts.limit ?? FEEDBACK_SIGNALS_LIMIT;
  const rows = (await sql`
    SELECT mem_id, prior_text
    FROM harness_shared.memory_feedback
    WHERE action IN ('delete', 'forget_all')
      AND created_at >= now() - make_interval(days => ${days})
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Array<{ mem_id: string | null; prior_text: string | null }>;
  const deletedIds = new Set<string>();
  const deletedTexts = new Set<string>();
  for (const r of rows) {
    if (r.mem_id) deletedIds.add(r.mem_id);
    if (r.prior_text && r.prior_text.trim()) deletedTexts.add(normalizeMemoryText(r.prior_text));
  }
  return { deletedIds, deletedTexts };
}

/** True when the entry is tombstoned by id (or by the hybrid projection's link_id). */
function isTombstoned(entry: MemoryEntry, signals: FeedbackSignals): boolean {
  if (signals.deletedIds.has(entry.id)) return true;
  const linkId = entry.metadata?.link_id;
  return typeof linkId === 'string' && signals.deletedIds.has(linkId);
}

/** True when the entry's content matches a deleted memory's prior_text. */
function matchesDeletedText(entry: MemoryEntry, signals: FeedbackSignals): boolean {
  return signals.deletedTexts.size > 0 && signals.deletedTexts.has(normalizeMemoryText(entry.text));
}

/**
 * Should this entry be withheld from the PUSH (injection) path? Tombstoned
 * OR deleted-content — the push path has no user in the loop to disagree.
 */
export function isFeedbackSuppressed(entry: MemoryEntry, signals: FeedbackSignals): boolean {
  return isTombstoned(entry, signals) || matchesDeletedText(entry, signals);
}

/**
 * The PULL-path pass: drop tombstones, demote deleted-content matches by
 * {@link DELETED_TEXT_PENALTY} and re-rank. Pure; order is stable for
 * untouched entries.
 */
export function applyFeedbackRerank(
  entries: MemoryEntry[],
  signals: FeedbackSignals,
): MemoryEntry[] {
  if (signals.deletedIds.size === 0 && signals.deletedTexts.size === 0) return entries;
  let demoted = false;
  const kept: MemoryEntry[] = [];
  for (const entry of entries) {
    if (isTombstoned(entry, signals)) continue;
    if (matchesDeletedText(entry, signals) && typeof entry.score === 'number') {
      kept.push({ ...entry, score: entry.score * DELETED_TEXT_PENALTY });
      demoted = true;
    } else {
      kept.push(entry);
    }
  }
  if (demoted) kept.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return kept;
}
