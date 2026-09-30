/**
 * operator-report-source — the I/O half of the operator-report attention
 * source (report-cards-inbox-reconciliation-2026-06-05, P-003 / D-004).
 *
 * Reads recent operator turns that carry a persisted `<report>` payload
 * (`operator_turns.report` jsonb, migration 160) for the active workspace.
 * The feed is a read-model over the canonical turn store — no write-side
 * fan-out, no mirror table (D-004); feed hygiene is the recent window here
 * plus the triage machinery in the reader (resolve → Handled).
 *
 * Pure mapping (row → AttentionItem) lives in `sources.ts`
 * (`reportTurnsToAttention`) so it is unit-testable without PG; this module
 * mirrors triage-store.ts: plain `getOrgPg().sql`, explicit workspace scope
 * (via the conversations join — turns don't carry workspace_id), and a
 * partial index (migration 169) covering the `report IS NOT NULL` predicate.
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';

/** One raw report-carrying turn. `report` is the stored jsonb — validated
 *  by the pure transform (`parseReportBlock`), not trusted here. */
export interface OperatorReportTurnRow {
  turnId: string;
  conversationId: string;
  report: unknown;
  /** The turn's persisted say text (title fallback). */
  text: string | null;
  /** epoch ms */
  createdAt: number;
}

/** Default window: a report is a status snapshot — stale ones lose value
 *  fast, and the operator re-raises anything still live on its next wake. */
export const REPORT_WINDOW_MS = 48 * 60 * 60 * 1000;
export const REPORT_LIMIT = 25;

export async function readRecentOperatorReports(opts?: {
  workspaceId?: string;
  limit?: number;
  sinceMs?: number;
  nowMs?: number;
}): Promise<OperatorReportTurnRow[]> {
  const { sql } = getOrgPg();
  const ws = opts?.workspaceId ?? activeWorkspaceId();
  const limit = opts?.limit ?? REPORT_LIMIT;
  const cutoff = (opts?.nowMs ?? Date.now()) - (opts?.sinceMs ?? REPORT_WINDOW_MS);
  const rows = await sql<
    {
      id: string;
      conversation_id: string;
      report: unknown;
      text: string | null;
      created_at: string | number;
    }[]
  >`
    SELECT t.id, t.conversation_id, t.report, t.text, t.created_at
      FROM harness_shared.operator_turns t
      JOIN harness_shared.operator_conversations c ON c.id = t.conversation_id
     WHERE c.workspace_id = ${ws}
       AND t.role = 'assistant'
       AND t.report IS NOT NULL
       -- deterministic-status-cards-2026-07-17 P-002: a source='system' report
       -- turn is a CURATOR status card that renders in the CHAT (its signals —
       -- escalations/blockers — are already in the inbox via their own sources);
       -- only the operator's OWN <report> turns (text_typed/voice_tts) belong here.
       AND t.source <> 'system'
       AND t.created_at > ${cutoff}
     ORDER BY t.created_at DESC
     LIMIT ${limit}
  `;
  return rows.map((r) => ({
    turnId: String(r.id),
    conversationId: String(r.conversation_id),
    report: r.report,
    text: r.text,
    createdAt: Number(r.created_at),
  }));
}
