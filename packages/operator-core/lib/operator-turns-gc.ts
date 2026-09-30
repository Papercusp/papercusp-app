/**
 * operator-turns-gc.ts — physical retention GC for harness_shared.operator_turns
 * (WI-1637, follow-up split from WI-417).
 *
 * WI-417's own text flagged operator_turns (158MB, append-mostly transcript
 * bodies) as having the SAME unbounded-growth shape as decision_ledger — an
 * append-only table with no scheduled retention. This mirrors
 * decision-ledger-gc.ts's flat delete-by-age pattern, with ONE additional
 * safety predicate specific to this table's consumer:
 *
 * SAFETY — the compaction-boundary floor (this table's analog of
 * decision_ledger's 90d graduation-lookback floor):
 *   operator_turns backs a HUMAN-FACING chat history (the operator sidebar/TUI
 *   conversation, `listTurnsRecent`'s infinite-scroll cursor pagination) — not
 *   a pure machine-audit ledger. Its rolling-summary compactor
 *   (operator-conversation-compaction.ts, migration 168) keeps the newest
 *   `KEEP_RECENT_TURNS` (12) turns permanently OUT of the summary and only
 *   ever advances `operator_conversations.summary_through_seq` forward over
 *   turns it has folded. A turn with `seq > summary_through_seq` is either
 *   recent (excluded from compaction by design) or not-yet-compacted (e.g.
 *   compaction disabled/failing/budget-exhausted for that conversation) — in
 *   EITHER case its text is NOT recoverable from the summary, so deleting it
 *   would be a silent, unrecoverable loss of chat history the compactor never
 *   backed up. This GC therefore deletes a turn ONLY when:
 *     (a) it is older than `retentionDays`, AND
 *     (b) `operator_conversations.summary_through_seq IS NOT NULL` for its
 *         conversation AND `turn.seq <= summary_through_seq` — i.e. the
 *         compactor has already folded its content into the durable summary.
 *   A conversation that has never been compacted (summary_through_seq NULL)
 *   is therefore NEVER touched by this GC, regardless of age — conservative
 *   by construction, matching WI-1637's explicit ask.
 *
 *   • FLAT delete-by-age (+ the compaction-boundary predicate above) — no
 *     other cross-row fold to corrupt.
 *   • NEVER FEDERATES — operator_turns is workspace-local operator-chat state,
 *     not a harness-scoped federating surface; a plain DELETE fires no
 *     cross-peer trigger.
 *   • BATCH-LIMITED (mirrors decision-ledger-gc's DECISION_LEDGER_GC_BATCH_LIMIT)
 *     — bounds the lock/row count a single run can take; any backlog drains
 *     over a few ticks.
 *
 * Returns the number of rows deleted. Best-effort caller (the tick) tolerates errors.
 */

import { getOrgPg } from '@papercusp/db-org';

/** Default retention — comfortably beyond typical operator-chat reference windows,
 *  matching decision-ledger-gc's 150d ballpark for a similarly-shaped append-only
 *  table (this table is smaller — 158MB vs decision_ledger's 528MB at filing time
 *  — so a conservative 180d default was chosen over decision_ledger's 150d). */
export const OPERATOR_TURNS_GC_RETENTION_DAYS = 180;

/** Max rows deleted per run (mirrors DECISION_LEDGER_GC_BATCH_LIMIT). */
export const OPERATOR_TURNS_GC_BATCH_LIMIT = 20000;

export async function gcOldOperatorTurns(
  retentionDays = OPERATOR_TURNS_GC_RETENTION_DAYS,
  batchLimit = OPERATOR_TURNS_GC_BATCH_LIMIT,
): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: number }>>`
    WITH victims AS (
      SELECT t.id
        FROM harness_shared.operator_turns t
        JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
       WHERE c.summary_through_seq IS NOT NULL
         AND t.seq <= c.summary_through_seq
         AND t.created_at < (extract(epoch FROM now()) * 1000)::bigint - (${retentionDays}::bigint * 86400000)
       ORDER BY t.created_at
       LIMIT ${batchLimit}
    ),
    d AS (
      DELETE FROM harness_shared.operator_turns
       WHERE id IN (SELECT id FROM victims)
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM d
  `;
  return rows[0]?.n ?? 0;
}
