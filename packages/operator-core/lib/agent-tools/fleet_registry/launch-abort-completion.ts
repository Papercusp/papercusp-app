/**
 * Completion receipt for `fleet:launch-on-plan` (WI-10005670).
 *
 * The launch tool opens member processes and persists a durable launch transaction
 * BEFORE it builds its response, and its pre-response phase (plan promotion, claim-spec
 * read, saved-profile resolution, slot admission) averages ~58s of the 60s dispatch
 * budget under load. When the handler returns just after the deadline the framework
 * used to report a bare `timeout` for a launch that had in fact happened — and an agent
 * that retries a launch that already landed opens a SECOND fleet wave.
 *
 * A non-error result that carries a `launchTransaction.transactionId` is proof the
 * durable transaction record exists, so a late return is reported as the launch it is.
 * Anything without that identity fails closed to the timeout path.
 */
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { asRecord, completedResultPayload } from '../abort-completion-payload';

export function fleetLaunchAbortCompletionReceipt(_args: unknown, result: ToolResult): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  const transaction = asRecord(payload?.launchTransaction);
  const transactionId = typeof transaction?.transactionId === 'string' ? transaction.transactionId.trim() : '';
  const fleet = typeof payload?.fleet === 'string' ? payload.fleet.trim() : '';
  if (transactionId && fleet) {
    return { status: 'recorded', effectRef: `fleet-launch:${fleet}:${transactionId}` };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'fleet:launch-on-plan result did not carry a durable launch transaction identity after abort',
    failures: [transactionId ? 'missing-fleet' : 'missing-launch-transaction-id'],
  };
}
