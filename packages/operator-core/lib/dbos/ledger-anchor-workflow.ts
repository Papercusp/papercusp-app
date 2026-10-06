/**
 * ledger-anchor-workflow.ts — the DBOS scheduled wrapper for hourly ledger
 * anchoring (agent-economy-flywheel-2026-08-30 P-041, D-024).
 *
 * Every 15 minutes, run one anchoring pass: each workspace with chain links
 * anchors its completed hour (a no-op once that hour is anchored), and a
 * missed hour files one deduplicated alert. The frequent schedule is the retry:
 * a failed publication is tried again on the next tick, well inside the
 * 20-minute grace before an hour counts as missed. All logic lives in
 * lib/cupboard/ledger-anchor*.ts and is unit-tested without DBOS; this file is
 * the thin durable-scheduling shell.
 *
 * Publishing needs an anchor key (PAPERCUSP_LEDGER_ANCHOR_KEY_FILE, default
 * ~/.papercusp/secrets/base-sepolia-anchor-key). Without one the pass only
 * checks cadence; PAPERCUSP_LEDGER_ANCHOR_BACKEND=none turns anchoring off.
 *
 * Each tick then pushes the public transparency report (P-044, D-028:
 * lib/cupboard/transparency-runtime.ts) as its own step.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import { runLedgerAnchorPass } from '../cupboard/ledger-anchor-runtime';
import { runTransparencyPass } from '../cupboard/transparency-runtime';

export const LEDGER_ANCHOR_CRONTAB = '*/15 * * * *';

async function ledgerAnchorTickWf(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const r = await runLedgerAnchorPass();
      const anchored = r.workspaces.filter((w) => w.tick.status === 'anchored').length;
      const failed = r.workspaces.filter((w) => w.tick.status === 'failed').length;
      const missed = r.workspaces.filter((w) => w.cadence?.status === 'missed').length;
      if (anchored || failed || missed) {
        console.log(
          `[ledger-anchor] ${r.workspaces.length} workspace(s): ${anchored} anchored, ${failed} failed, ${missed} behind` +
            (r.backendUnavailable ? ` (backend unavailable: ${r.backendUnavailable})` : ''),
        );
      }
    },
    // No step retry: a publication is not idempotent on chain, and the next
    // 15-minute tick retries a failed hour anyway.
    { name: 'ledger-anchor-pass', retriesAllowed: false },
  );
  // P-044 (D-028 §3): the public transparency report is rebuilt right after the
  // anchor pass, so its latest anchored root is the one just published. A separate
  // step: a Worker outage must never cost an anchor, and the next tick re-pushes.
  await DBOS.runStep(
    async () => {
      const r = await runTransparencyPass();
      const failed = r.workspaces.filter((w) => w.error || (!w.live.pushed && !r.workerUnavailable));
      const drift = r.workspaces.filter((w) => w.drift);
      if (failed.length || drift.length) {
        console.log(
          `[transparency] ${r.workspaces.length} workspace(s): ${failed.length} not pushed, ${drift.length} statement drift` +
            failed.map((w) => ` | ${w.workspaceId}: ${w.error ?? (w.live.pushed ? '' : w.live.detail)}`).join(''),
        );
      }
    },
    { name: 'transparency-pass', retriesAllowed: false },
  );
}

const ledgerAnchorWorkflow = idempotentRegisterWorkflow('ledgerAnchor', () =>
  DBOS.registerWorkflow(ledgerAnchorTickWf, {
    name: 'ledgerAnchor',
    maxRecoveryAttempts: 3,
  }),
);

// Default skip-missed mode: one anchor after downtime covers the whole gap.
DBOS.registerScheduled(ledgerAnchorWorkflow, {
  name: 'ledgerAnchor',
  crontab: LEDGER_ANCHOR_CRONTAB,
});
