/** Durable source-side recovery for the id-scoped work-item completion event.
 *
 * The work_items trigger stamps a pending UUID in the terminal row's payload
 * in the SAME transaction as the status change. The existing await sweeper
 * retries that row until event_key_fires records this exact UUID. A crash after
 * the work-item commit and before emit can therefore never erase the intent.
 * The await engine owns the subsequent fired-await → delivery window (P-021).
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { runWithWorkspace } from './workspace-als';
import { getWorkItem, isSettledWorkItemState, type WorkItem } from './work-items';
import {
  completionEventIntentIdOf,
  emitWorkItemDoneEvent,
  WORK_ITEM_COMPLETION_EVENT_INTENT_KEY,
} from './work-items-events';
import { registerAwaitReconciler } from './events/await/engine';

type OrgSql = ReturnType<typeof getOrgPg>['sql'];
type PendingRow = {
  workspace_id: string;
  harness_slug: string;
  feature_id: string;
  intent_id: string;
};

export interface CompletionEventReconcileDeps {
  sql?: OrgSql;
  getItem?: typeof getWorkItem;
  emitDone?: typeof emitWorkItemDoneEvent;
  nowMs?: number;
}

export interface CompletionEventReconcileResult {
  considered: number;
  emitted: number;
  acknowledged: number;
  failed: number;
  errors?: string[];
}

const BATCH_SIZE = 50;
const NORMAL_EMIT_GRACE_MS = 1_000;

async function hasMatchingFire(sql: OrgSql, itemId: string, intentId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.event_key_fires
     WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE}
       AND event_key = ${`work-item:done:${itemId}`}
       AND last_payload->>'completionIntentId' = ${intentId}
     LIMIT 1
  `;
  return rows.length > 0;
}

/** Bounded, repeatable sweep over the existing work_items row as intent store.
 * The normal fire gets a one-second lead; the sweeper then repairs a lost fire.
 * A matching latch allows a no-emit acknowledgement after a crash between
 * publication and clearing the pending token. */
export async function reconcileWorkItemCompletionEventIntents(
  workspaceId: string,
  deps: CompletionEventReconcileDeps = {},
): Promise<CompletionEventReconcileResult> {
  return runWithWorkspace(workspaceId, async () => {
    const sql = deps.sql ?? getOrgPg().sql;
    const getItem = deps.getItem ?? getWorkItem;
    const emitDone = deps.emitDone ?? emitWorkItemDoneEvent;
    const cutoff = (deps.nowMs ?? Date.now()) - NORMAL_EMIT_GRACE_MS;
    const pending = await sql<PendingRow[]>`
      SELECT workspace_id, harness_slug, feature_id,
             payload->>${WORK_ITEM_COMPLETION_EVENT_INTENT_KEY} AS intent_id
        FROM harness_shared.work_items
       WHERE workspace_id = ${workspaceId}
         AND payload ? ${WORK_ITEM_COMPLETION_EVENT_INTENT_KEY}
         AND closed_ts IS NOT NULL
         AND closed_ts <= ${cutoff}
         AND harness_shared.work_item_status_is_terminal(status)
       ORDER BY closed_ts ASC, feature_id ASC
       LIMIT ${BATCH_SIZE}
    `;
    const result: CompletionEventReconcileResult = {
      considered: pending.length, emitted: 0, acknowledged: 0, failed: 0,
    };
    for (const row of pending) {
      try {
        const item: WorkItem | null = await getItem(row.feature_id, row.harness_slug);
        if (!item || !isSettledWorkItemState(item.state) ||
            completionEventIntentIdOf(item) !== row.intent_id) continue;
        if (!await hasMatchingFire(sql, item.id, row.intent_id)) {
          await emitDone(item);
          result.emitted += 1;
        }
        if (!await hasMatchingFire(sql, item.id, row.intent_id)) continue;
        const acknowledged = await sql`
          UPDATE harness_shared.work_items
             SET payload = COALESCE(payload, '{}'::jsonb)
                           - ${WORK_ITEM_COMPLETION_EVENT_INTENT_KEY}
           WHERE workspace_id = ${row.workspace_id}
             AND feature_id = ${row.feature_id}
             AND payload->>${WORK_ITEM_COMPLETION_EVENT_INTENT_KEY} = ${row.intent_id}
             AND harness_shared.work_item_status_is_terminal(status)
          RETURNING feature_id
        `;
        result.acknowledged += acknowledged.length;
      } catch (error) {
        // The intent stays in the row for a later sweep. A bad item must not
        // prevent the other bounded candidates from being reconciled.
        result.failed += 1;
        (result.errors ??= []).push(
          `${row.feature_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  });
}

// The await sweeper is already boot-started and workspace-scoped. Register
// this source there instead of creating another polling routine or task ledger.
registerAwaitReconciler(async (workspaceId) => {
  const result = await reconcileWorkItemCompletionEventIntents(workspaceId);
  if (result.failed > 0) {
    console.warn(
      `[work-item-completion-event] ${result.failed}/${result.considered} pending intent(s) failed reconciliation: ${result.errors?.join('; ').slice(0, 300)}`,
    );
  }
});
