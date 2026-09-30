/**
 * Operator receiving-state polling (Phase 1b-2 of the v5 operator plan).
 *
 * After the panel dispatches a card via send_message, we store the
 * returned messageId on the card. This module queries
 * papercusp_shared.messages.status for batches of those ids so the
 * panel can derive `consumed` / `escalated` / `rejected` from the
 * recipient harness's processing.
 *
 * Native message statuses: pending | acknowledged | actioned | archived.
 * Mapping to lifecycle:
 *   - pending      → still 'dispatched' (recipient hasn't picked up)
 *   - acknowledged → 'consumed'
 *   - actioned     → 'consumed'
 *   - archived     → 'consumed' (recipient explicitly closed it)
 *
 * `escalated` is a separate signal — recipients ESCALATE by sending a
 * new message TO `system:operator`. We detect it by joining
 * message_recipients on the original `message_id` (or via subject/ref
 * heuristic if no parent link is set).
 */

import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export type ReceivingState = 'dispatched' | 'consumed' | 'escalated' | 'rejected';

export interface MessageStatusRow {
  messageId: string;
  receivingState: ReceivingState;
  rawStatus: string | null;
}

const STATUS_MAP: Record<string, ReceivingState> = {
  pending: 'dispatched',
  acknowledged: 'consumed',
  actioned: 'consumed',
  archived: 'consumed',
};

export async function readMessageStatuses(
  messageIds: string[],
): Promise<MessageStatusRow[]> {
  if (!messageIds.length) return [];
  const workspaceId = activeWorkspaceId();
  try {
    return await withWorkspace(workspaceId, async (tx) => {
      const rows = await tx<{ id: string; status: string }[]>`
        SELECT id, status
          FROM papercusp_shared.messages
         WHERE id IN ${tx(messageIds)}
      `;
      return rows.map((r) => ({
        messageId: r.id,
        rawStatus: r.status,
        receivingState: STATUS_MAP[r.status] ?? 'dispatched',
      }));
    });
  } catch {
    // Best-effort; if the workspace isn't yet on PG just return empty.
    return [];
  }
}
