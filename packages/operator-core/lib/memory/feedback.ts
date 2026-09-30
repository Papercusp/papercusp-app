/**
 * memory-feedback signal capture.
 *
 * Records every user-driven mutation of a memory (edit, delete,
 * forget_all) into harness_shared.memory_feedback (migration 062).
 * Future learning signal: which memories get edited shortly after
 * creation, deletion patterns by kind, etc.
 *
 * Best-effort: failures are logged and swallowed — the user-facing
 * API operation must never fail because feedback capture failed.
 */

import { activeWorkspaceId } from '../workspace-registry';

/**
 * Push a live refresh to the Settings → Memory page's feedback-stats tile
 * (all-active-surfaces-data-sync-migration-2026-07-11 P-013): every write
 * here changes `total_edits`/`total_deletes` for the acting user, so the
 * `userMemory.feedbackStats` sync query needs a bump. `memory_feedback` is
 * written via a raw `pg` Client (not drizzle) and carries no PG-trigger
 * notify, so this manual invalidate — same dynamic-import, best-effort
 * pattern as `notifyJournalRecovery` in `journal-surfacing.ts` — is the only
 * signal; a missed one just means the tile is stale until the next write.
 */
async function invalidateFeedbackStats(): Promise<void> {
  try {
    const { notifySyncInvalidate } = await import('../sync-sse');
    await notifySyncInvalidate('userMemory.feedbackStats');
  } catch {
    // best-effort — surfacing must never fail the caller's write.
  }
}

/**
 * Actor id for feedback the AGENT LAYER produces (memory:forget / memory:update), as opposed
 * to a person acting through /api/user/memory.
 *
 * `harness_shared.memory_feedback.user_id` is `uuid NOT NULL`, so a descriptive string cannot
 * go there — the two agent call sites passed the literal `'agent-tool'` and every insert died
 * on `invalid input syntax for type uuid`, inside a `catch` that only `console.warn`ed. The
 * write is fire-and-forget, so nothing ever awaited the rejection and the warning was never
 * seen: measured 2026-08-18, the table held 2 rows lifetime (both from the human endpoint) and
 * ZERO agent rows, so the extraction-adaptation loop's agent signal had never once landed.
 *
 * Deliberately NOT the nil uuid: in this repo `00000000-…-000000000000` is used in tests to
 * mean an INVALID/absent id, so reusing it here would encode "no actor" where we mean "a
 * specific, known, non-human actor". `buildLearningInstructions` aggregates by action+kind and
 * never reads user_id, so this column is provenance only — but provenance that is now true.
 */
export const AGENT_TOOL_ACTOR_ID = 'a9e70000-0000-4000-8000-000000000001';

export interface FeedbackInput {
  memId: string;
  /** A person's uuid, or {@link AGENT_TOOL_ACTOR_ID} for agent-layer feedback. Must be a uuid. */
  userId: string;
  action: 'create' | 'edit' | 'delete' | 'forget_all';
  kind?: string | null;
  priorText?: string | null;
  newText?: string | null;
}

export async function recordFeedback(input: FeedbackInput): Promise<void> {
  try {
    const { pgClientFields } = await import('./mem0-connection');
    const fields = await pgClientFields();
    if (!fields) return;
    const { Client } = await import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      await c.query(
        `INSERT INTO harness_shared.memory_feedback
           (mem_id, user_id, workspace_id, action, kind, prior_text, new_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.memId,
          input.userId,
          activeWorkspaceId(),
          input.action,
          input.kind ?? null,
          input.priorText ?? null,
          input.newText ?? null,
        ],
      );
    } finally {
      await c.end();
    }
    await invalidateFeedbackStats();
  } catch (err) {
    console.warn('[memory-feedback] capture failed:', (err as Error).message);
  }
}

export interface FeedbackStats {
  total_edits: number;
  total_deletes: number;
  recent: Array<{
    id: string;
    mem_id: string;
    action: string;
    prior_text: string | null;
    new_text: string | null;
    created_at: string;
  }>;
}

export async function loadFeedbackStats(
  userId: string,
  recentLimit = 20,
): Promise<FeedbackStats | null> {
  try {
    const { pgClientFields } = await import('./mem0-connection');
    const fields = await pgClientFields();
    if (!fields) return null;
    const { Client } = await import('pg');
    const c = new Client(fields);
    await c.connect();
    try {
      const counts = await c.query(
        `SELECT action, COUNT(*)::int AS n
           FROM harness_shared.memory_feedback
          WHERE user_id = $1
          GROUP BY action`,
        [userId],
      );
      const byAction = Object.fromEntries(
        counts.rows.map((r: { action: string; n: number }) => [r.action, r.n]),
      ) as Record<string, number>;
      const recent = await c.query(
        `SELECT id, mem_id, action, prior_text, new_text, created_at
           FROM harness_shared.memory_feedback
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, recentLimit],
      );
      return {
        total_edits: byAction.edit ?? 0,
        total_deletes: (byAction.delete ?? 0) + (byAction.forget_all ?? 0),
        recent: recent.rows as FeedbackStats['recent'],
      };
    } finally {
      await c.end();
    }
  } catch {
    return null;
  }
}
