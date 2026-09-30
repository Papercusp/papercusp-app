/**
 * triage-store — the persisted operator inbox-triage record
 * (inbox-tiering-and-message-agent-2026-06-05, D-006, P-016).
 *
 * The operator's triage PASS (downgrade / escalate / confirm / resolve) on an
 * attention item is durable here (`harness_shared.attention_triage`, migration
 * 162) so a downgrade is auditable, not a silent vanish: plans:attention reads
 * the per-workspace triage map and `applyTriage`s it onto each item to produce
 * the final tier (downgraded/resolved → the "Handled by operator" tier).
 *
 * Access mirrors operator-state-pg.ts / the attention reader's smoke query:
 * plain `getOrgPg().sql` with an explicit `workspace_id` filter + an
 * `ON CONFLICT (workspace_id, item_id)` upsert (latest triage wins — the
 * operator may re-triage). The org PG handle connects as the table owner, so
 * the RLS policy on the table is enforced for the runtime app role but bypassed
 * here, exactly like every other operator-state table.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from '../workspace-registry';
import type { TriageAction, TriageRecord } from './types';

/** Upsert the operator's triage decision for one attention item. */
export async function upsertTriage(input: {
  itemId: string;
  action: TriageAction;
  note?: string | null;
  triagedBy?: string | null;
  workspaceId?: string;
  /** Join a caller-owned transaction when the audit row is part of a larger
   *  success contract (bulk terminal actions). */
  sql?: Sql | TransactionSql;
}): Promise<void> {
  const sql = input.sql ?? getOrgPg().sql;
  const ws = input.workspaceId ?? activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.attention_triage (workspace_id, item_id, action, note, triaged_by)
    VALUES (${ws}, ${input.itemId}, ${input.action}, ${input.note ?? null}, ${input.triagedBy ?? null})
    ON CONFLICT (workspace_id, item_id) DO UPDATE
      SET action = EXCLUDED.action,
          note = EXCLUDED.note,
          triaged_by = EXCLUDED.triaged_by,
          triaged_at = now()
  `;
}

/** Clear an item's triage (revert it to untriaged). */
export async function clearTriage(
  itemId: string,
  workspaceId?: string,
  transaction?: Sql | TransactionSql,
): Promise<void> {
  const sql = transaction ?? getOrgPg().sql;
  const ws = workspaceId ?? activeWorkspaceId();
  await sql`
    DELETE FROM harness_shared.attention_triage
     WHERE workspace_id = ${ws} AND item_id = ${itemId}
  `;
}

/** All triage records for a workspace, keyed by AttentionItem id — the bulk
 *  read the attention reader joins. Best-effort caller wraps this (a missing
 *  table / PG offline degrades to "no triage applied", never a failed feed). */
export async function readTriageByWorkspace(workspaceId?: string): Promise<Map<string, TriageRecord>> {
  const { sql } = getOrgPg();
  const ws = workspaceId ?? activeWorkspaceId();
  const rows = await sql<
    {
      item_id: string;
      action: TriageAction;
      note: string | null;
      triaged_by: string | null;
      triaged_at: Date | string | null;
    }[]
  >`
    SELECT item_id, action, note, triaged_by, triaged_at
      FROM harness_shared.attention_triage
     WHERE workspace_id = ${ws}
  `;
  const map = new Map<string, TriageRecord>();
  for (const r of rows) {
    map.set(r.item_id, {
      action: r.action,
      note: r.note,
      triagedBy: r.triaged_by,
      triagedAt: r.triaged_at ? new Date(r.triaged_at as string).toISOString() : null,
    });
  }
  return map;
}

/**
 * EI-1687 — the set of AttentionItem ids the operator triaged to the "handled"
 * tier (action `downgrade` or `resolve`). curation:feed + the Queen wake brief
 * exclude these so a handled escalation does not re-surface as "open" every wake
 * (the re-downgrade-thrash bug). BEST-EFFORT: a missing table / PG offline
 * degrades to an empty set (no suppression — fail toward showing, never hide on a
 * read error), so the salient surfaces never break on this overlay.
 */
export async function readTriagedHandledItemIds(workspaceId?: string): Promise<Set<string>> {
  const handled = new Set<string>();
  try {
    const map = await readTriageByWorkspace(workspaceId);
    for (const [itemId, rec] of map) {
      if (rec.action === 'downgrade' || rec.action === 'resolve') handled.add(itemId);
    }
  } catch {
    // best-effort overlay — degrade to "no triage applied"
  }
  return handled;
}
