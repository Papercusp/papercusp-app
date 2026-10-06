/**
 * reconciliation-workflow.ts — the DBOS scheduled wrapper for money
 * reconciliation (agent-economy-flywheel-2026-08-30 P-043, D-025 §5).
 *
 * Hourly, at minute 7: import Stripe balance transactions and routed DAO
 * transfers into the journal, reconcile every invariant, file or resolve break
 * items, and push the DAO-transfer gate to the Cupboard Worker. The first tick
 * after a month closes also runs the FINAL reconciliation of that month (and
 * every later tick retries it until it has recorded). All logic lives in
 * lib/cupboard/reconciliation*.ts and is unit-tested without DBOS; this file is
 * the thin durable-scheduling shell.
 *
 * Unconfigured rails read `not-configured` (see reconciliation-runtime.ts for
 * the PAPERCUSP_* configuration). The Worker pauses DAO transfers when no gate
 * arrives for 3 hours, so a schedule that stops running fails closed.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { runScheduledReconciliation, type ReconciliationPassResult } from '../cupboard/reconciliation-runtime';

export const RECONCILIATION_CRONTAB = '7 * * * *';

function summarize(label: string, pass: ReconciliationPassResult): string {
  const runs = pass.workspaces.filter((w) => w.run);
  const opened = runs.reduce((n, w) => n + w.run!.opened.length, 0);
  const resolved = runs.reduce((n, w) => n + w.run!.resolved.length, 0);
  const closed = runs.filter((w) => !w.run!.gate.open).length;
  const errors = pass.workspaces.filter((w) => w.error).length;
  return `${label}: ${pass.workspaces.length} workspace(s), ${opened} break(s) opened, ${resolved} resolved, ${closed} gate(s) closed, ${errors} error(s)`;
}

async function reconciliationTickWf(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const r = await runScheduledReconciliation();
      const lines = [r.final ? summarize('final', r.final) : null, summarize('provisional', r.provisional)].filter(Boolean);
      const noteworthy =
        r.final !== null ||
        r.provisional.workspaces.some((w) => w.error || (w.run && (w.run.opened.length || w.run.resolved.length)));
      if (noteworthy) console.log(`[reconciliation] ${lines.join(' | ')}`);
    },
    // No step retry: a run files work items and pushes a gate; the next hourly
    // tick is the retry, and every import is idempotent.
    { name: 'reconciliation-pass', retriesAllowed: false },
  );
}

const reconciliationWorkflow = idempotentRegisterWorkflow('moneyReconciliation', () =>
  DBOS.registerWorkflow(reconciliationTickWf, {
    name: 'moneyReconciliation',
    maxRecoveryAttempts: 3,
  }),
);

// Default skip-missed mode: one run after downtime reconciles the whole open month.
DBOS.registerScheduled(reconciliationWorkflow, {
  name: 'moneyReconciliation',
  crontab: RECONCILIATION_CRONTAB,
});
