/**
 * cupboard:reconciliation — the money reconciliation's status and manual run
 * (agent-economy-flywheel-2026-08-30 P-043, D-025 §5). The DBOS schedule runs
 * the same pass hourly (plus the month-close final run); `run` is the manual
 * lever after a fix. Without `confirm:true`, `run` reports which rails are
 * configured and changes nothing.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

const text = (payload: Record<string, unknown>) => ({ data: payload });

export default defineTool({
  name: 'cupboard:reconciliation',
  capability: 'harness:write',
  description:
    'Money reconciliation for this workspace: status (latest run, latest month-close run, open breaks and their items, DAO-transfer gate) or run (import Stripe + DAO transfers, reconcile, file/resolve breaks, push the gate). run is a dry run unless confirm:true.',
  guidance: {
    when: 'A reconciliation break item needs its evidence, DAO transfers are paused (409 transfers_paused) and you need the reason, or a fix landed and the break should be re-checked now.',
    notWhen: 'Reading journal entries or trial balances (the money journal tools); anchoring (cupboard:ledger-anchor).',
    chaining:
      'A break opened by a final (month-close) run is resolved only by run { mode:"final" }. status.latest.gatePublishDetail says why the Worker did not receive the gate.',
    seeAlso: ['cupboard:ledger-anchor'],
  },
  args: z.object({
    op: z.enum(['status', 'run']).default('status'),
    mode: z.enum(['provisional', 'final']).default('provisional').describe('run only: final reconciles the month that just closed.'),
    limit: z.number().int().min(1).max(50).default(5).describe('status only: how many recent runs to return.'),
    confirm: z.boolean().default(false).describe('run only: true runs; false reports configuration.'),
  }),
  async handler(args, ctx) {
    const [{ activeWorkspaceId }, store, runtime] = await Promise.all([
      import('../../workspace-registry'),
      import('../../cupboard/reconciliation-store'),
      import('../../cupboard/reconciliation-runtime'),
    ]);
    const workspaceId = ctx?.principal?.workspaceId ?? activeWorkspaceId();
    if (args.op === 'status') {
      return text({ ok: true, ...(await store.readReconciliationStatus(workspaceId, { limit: args.limit })) });
    }
    const config = runtime.readReconciliationRuntimeConfig();
    const rails = {
      stripe: config.stripeSecretKeyRef
        ? config.policy
          ? config.stripeJournalWorkspace === workspaceId
            ? 'configured'
            : `configured for workspace ${config.stripeJournalWorkspace ?? '(none: set PAPERCUSP_STRIPE_JOURNAL_WORKSPACE)'}`
          : (config.policyError ?? 'key set, PAPERCUSP_MONEY_JOURNAL_POLICY missing')
        : 'not-configured',
      treasury: config.treasuryWorkspace === workspaceId ? 'owned by this workspace' : `owned by ${config.treasuryWorkspace ?? '(no workspace)'}`,
      cupboard: config.gateSecretRef ? `configured (${config.cupboardUrl})` : 'not-configured (PAPERCUSP_RECONCILIATION_GATE_SECRET_REF)',
      chain: config.chainRpcUrl ? 'receipts verified on chain' : 'Worker records trusted (no PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL)',
      bank: 'not-configured (no bank feed connected)',
      safe:
        config.safe.status === 'configured'
          ? config.chainRpcUrl
            ? `Safe ${config.safe.safeAddress} read on chain from block ${config.safe.fromBlock}`
            : 'Safe configured, but PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL is missing'
          : config.safe.status === 'invalid'
            ? config.safe.detail
            : 'not-configured (PAPERCUSP_RECONCILIATION_SAFE_ADDRESS)',
    };
    if (!args.confirm) {
      return text({ ok: true, dryRun: true, workspaceId, mode: args.mode, rails, note: 'Re-run with confirm:true to reconcile.' });
    }
    const result = await runtime.runReconciliationPass({ mode: args.mode, workspaces: [workspaceId] });
    const ws = result.workspaces[0] ?? null;
    return text({ ok: Boolean(ws && !ws.error), mode: args.mode, rails, workspace: ws });
  },
});
