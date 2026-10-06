/**
 * Completion receipt for `work_items:create` (WI-10005718).
 *
 * `work_items:create` INSERTs the row (assignee and all) before it builds its bulk
 * envelope, and its pre-insert phase — dedup coverage, goal-context resolution, fleet
 * scope admission — can outrun the 60s dispatch budget under load. When the handler
 * returns just after the deadline the framework used to report a bare `timeout` for a
 * row that had in fact landed. The caller then lost BOTH the landed id and any
 * downgrade notice (`fleetScopeDowngrade`, `assigneeResolutionDowngrade`, …) that tells
 * it the item was filed UNASSIGNED, and a retry files a duplicate (measured:
 * WI-10005040 landed 5s after the abort, unassigned, by the designed fleet-scope
 * downgrade — not an abort cutting a claim).
 *
 * A completed bulk envelope with at least one `ok:true` row carrying a string `id`
 * is proof a durable work-item row exists, so a late return is reported as the
 * create it is — and dispatch then RETURNS THE LATE RESULT ITSELF, so the caller
 * regains the id and the downgrade notice with no further change.
 *
 * `not-recorded` is deliberately never returned: `runBulk` turns a THROWN error into an
 * `ok:false` row, which is indistinguishable here from a designed refusal, so an
 * envelope with no landed id fails closed to `recovery-incomplete` (the timeout path).
 */
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';

export function workItemsCreateAbortCompletionReceipt(_args: unknown, result: ToolResult): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const landedIds: string[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record?.ok === true && typeof record.id === 'string' && record.id.trim()) {
      landedIds.push(record.id.trim());
    }
  }
  if (landedIds.length > 0) {
    return { status: 'recorded', effectRef: `work-item:${landedIds.join(',')}` };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'work_items:create result did not carry a landed work-item id after abort',
    failures: ['no-landed-work-item'],
  };
}
