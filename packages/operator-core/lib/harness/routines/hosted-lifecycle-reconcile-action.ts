/**
 * Durable system action for the workspace-host lifecycle reconciliation sweep (WI-2143803).
 *
 * THE GAP THIS CLOSES. `reconcileHostedLifecycleJobs` (workspace-host/hosted-lifecycle-store.ts)
 * already implements the whole recovery state machine — classify a queued/running operation as
 * stuck / orphaned / exhausted, advance `recovery_state`, and raise an intervention notice. Before
 * this action existed it had ZERO production callers, so none of that machinery ever ran: kill the
 * controller mid-operation and the `harness_shared.workspace_host_operations` row is stranded in
 * `status='running'` permanently. Nothing moves it to a terminal state and nothing notifies, and
 * because operationIds are single-use the host is left unreachable through the product route.
 * Measured on the P-046 rig (2026-09-04): `p046-canary-14-restart-ct1` sat `running|99` with
 * `recovery_state='none'` across a FULL controller restart — DBOS recovery does not cover it
 * either, because the operation is not an in-flight DBOS workflow, it is a ledger row.
 *
 * ⚠ THE SECOND HALF OF THE DEFECT, and why the reconciler alone was not the fix: the sweep used to
 * INNER JOIN `customer_workspaces`, while every BYOC-connection operation carries
 * `customer_workspace_id = NULL` (measured: 38/38 operations NULL, and that table holds 0 rows on
 * the rig). So scheduling the ORIGINAL reconciler would have produced a sweep that runs, passes,
 * and matches nothing — the most expensive possible outcome, because it looks like coverage. The
 * joins were made OUTER and the host re-keyed onto `operation.host_id` first; this action is the
 * other half. Do not treat a green tick here as evidence the sweep SAW anything: read the counts.
 *
 * Injectable `reconcile` dep (mirrors account-capacity-reprobe-action.ts's `probe` seam) so the
 * action is unit-testable without a live database.
 *
 * A genuine failure THROWS rather than being swallowed: there is no per-provider fan-out to protect
 * here, and the routines engine's own `last_error`/`last_error_at` bookkeeping (routines-workflow.ts)
 * is the intended reporting surface for a failing tick.
 */
import {
  reconcileHostedLifecycleJobs,
  type HostedLifecycleReconciliationResult,
} from '../../workspace-host/hosted-lifecycle-store';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

export const HOSTED_LIFECYCLE_RECONCILE = 'hosted-lifecycle-reconcile';

export interface HostedLifecycleReconcileActionDeps {
  reconcile: (workspaceId: string) => Promise<HostedLifecycleReconciliationResult>;
  log: (message: string) => void;
}

export function makeHostedLifecycleReconcileAction(overrides: Partial<HostedLifecycleReconcileActionDeps> = {}) {
  const deps: HostedLifecycleReconcileActionDeps = {
    reconcile: (workspaceId) => reconcileHostedLifecycleJobs(workspaceId),
    log: (message) => console.log(`[${HOSTED_LIFECYCLE_RECONCILE}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const out = await deps.reconcile(ctx.workspaceId);
    const touched = out.recoveryPending.length + out.orphaned.length + out.exhausted.length + out.spend.due;
    // Quiet by design when a tick found nothing to advance — the healthy steady state is every
    // queued/running operation heartbeating, and a per-tick line for that is pure noise.
    if (touched === 0) return;
    deps.log(
      `${ctx.workspaceId}: recoveryPending=${out.recoveryPending.length} ` +
        `orphaned=${out.orphaned.length} exhausted=${out.exhausted.length} ` +
        `notified=${out.notifications.length} spendDue=${out.spend.due} ` +
        `spendAttempted=${out.spend.attempted} spendObserved=${out.spend.observed} ` +
        `spendSettled=${out.spend.settled} spendRetryable=${out.spend.retryable} ` +
        `spendSkipped=${out.spend.skipped} spendErrors=${out.spend.errors.length}` +
        (out.spend.errors.length > 0
          ? ` errors=[${out.spend.errors
              .map((error) => `${error.hostId}/${error.runId ?? 'unknown'}:${error.reason}`)
              .join(',')}]`
          : ''),
    );
  };
}

registerSystemAction(HOSTED_LIFECYCLE_RECONCILE, makeHostedLifecycleReconcileAction());
