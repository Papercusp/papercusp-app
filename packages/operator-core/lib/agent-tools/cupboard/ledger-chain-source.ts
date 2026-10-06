/**
 * The Postgres-side hash-chained ledgers the cupboard:ledger-chain tools can
 * verify, export and witness (agent-economy-flywheel-2026-08-30 P-040, P-042):
 * a pot's plan-admission governance events, and the workspace money journal.
 */
import type { LedgerSource } from '../../cupboard/ledger-chain';

export type LedgerChainStream = 'plan-admission' | 'money-journal';

export async function ledgerChainSource(
  workspaceId: string,
  stream: LedgerChainStream,
  pot: string | undefined,
): Promise<LedgerSource | { error: string }> {
  if (stream === 'money-journal') {
    const { moneyJournalLedgerSource } = await import('../../cupboard/money-journal-store');
    return moneyJournalLedgerSource(workspaceId);
  }
  if (!pot) return { error: 'stream plan-admission needs `pot` (the pot home slug)' };
  const { planAdmissionGovernanceLedgerSource } = await import('../plans/plan-admission-governance-store');
  return planAdmissionGovernanceLedgerSource({ workspaceId, potHomeSlug: pot });
}
