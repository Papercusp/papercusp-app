/**
 * The DAO-transfer gate the operator's reconciliation run pushes to this Worker,
 * and the inputs that run reads back (agent-economy-flywheel-2026-08-30 P-043,
 * D-025 §4, migration 040).
 *
 * The operator owns the verdict; this Worker owns the transfers. The gate is
 * the seam between them, and it fails closed: `transferGateVerdict` refuses
 * unless a fresh, open, treasury-reconciled row exists for the workspace that
 * governs this Worker.
 */
import {
  TRANSFER_GATE_MAX_AGE_MS,
  type ReconciliationInputs,
  type TransferGatePush,
} from '@papercusp/operator-core/lib/cupboard/reconciliation-hmac.ts';
import type { TreasuryTransferGateRow as GateRow } from './db-row-types.generated.ts';

export interface StoredTransferGate {
  readonly workspaceId: string;
  readonly open: boolean;
  readonly treasuryReconciled: boolean;
  readonly reasons: readonly string[];
  readonly runId: string;
  readonly atMs: number;
  readonly receivedAtMs: number;
}

function parseReasons(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(row: GateRow): StoredTransferGate {
  return {
    workspaceId: row.workspace_id,
    open: row.open === 1,
    treasuryReconciled: row.treasury_reconciled === 1,
    reasons: parseReasons(row.reasons_json),
    runId: row.run_id,
    atMs: row.at_ms,
    receivedAtMs: row.received_at_ms,
  };
}

export async function getTransferGate(db: D1Database, workspaceId: string): Promise<StoredTransferGate | null> {
  const row = await db
    .prepare(
      `SELECT workspace_id, open, treasury_reconciled, reasons_json, run_id, at_ms, received_at_ms
         FROM treasury_transfer_gate WHERE workspace_id = ?`,
    )
    .bind(workspaceId)
    .first<GateRow>();
  return row ? fromRow(row) : null;
}

export type TransferGateWrite =
  | { readonly applied: true; readonly gate: StoredTransferGate }
  /** A push from an earlier run than the stored one; the stored gate stands. */
  | { readonly applied: false; readonly gate: StoredTransferGate };

/**
 * Upsert one workspace's gate. A push whose `atMs` is older than the stored
 * row's is ignored, so a delayed push from an earlier run can never reopen a
 * gate that a later run closed.
 */
export async function recordTransferGate(
  db: D1Database,
  push: TransferGatePush,
  receivedAtMs: number,
): Promise<TransferGateWrite> {
  await db
    .prepare(
      `INSERT INTO treasury_transfer_gate
         (workspace_id, open, treasury_reconciled, reasons_json, run_id, at_ms, received_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         open = excluded.open,
         treasury_reconciled = excluded.treasury_reconciled,
         reasons_json = excluded.reasons_json,
         run_id = excluded.run_id,
         at_ms = excluded.at_ms,
         received_at_ms = excluded.received_at_ms
       WHERE excluded.at_ms >= treasury_transfer_gate.at_ms`,
    )
    .bind(
      push.workspaceId,
      push.open ? 1 : 0,
      push.treasuryReconciled ? 1 : 0,
      JSON.stringify(push.reasons),
      push.runId,
      push.atMs,
      receivedAtMs,
    )
    .run();
  const stored = await getTransferGate(db, push.workspaceId);
  if (!stored) throw new Error(`transfer gate for ${push.workspaceId} was not stored`);
  return stored.runId === push.runId && stored.atMs === push.atMs
    ? { applied: true, gate: stored }
    : { applied: false, gate: stored };
}

export type TransferGateVerdict =
  | { readonly open: true; readonly gate: StoredTransferGate }
  | {
      readonly open: false;
      readonly code: 'no-governing-workspace' | 'never-reported' | 'break-open' | 'treasury-not-reconciled' | 'stale';
      readonly detail: string;
      readonly gate: StoredTransferGate | null;
    };

/** Whether DAO transfers may run now. Every path except a fresh, open, treasury-reconciled gate refuses. */
export async function transferGateVerdict(
  db: D1Database,
  workspaceId: string | undefined,
  nowMs: number,
): Promise<TransferGateVerdict> {
  const ws = workspaceId?.trim();
  if (!ws) {
    return {
      open: false,
      code: 'no-governing-workspace',
      detail: 'RECONCILIATION_GATE_WORKSPACE is not configured, so no reconciliation vouches for this treasury',
      gate: null,
    };
  }
  const gate = await getTransferGate(db, ws);
  if (!gate) {
    return { open: false, code: 'never-reported', detail: `reconciliation has never reported a gate for workspace ${ws}`, gate: null };
  }
  if (!gate.open) {
    return {
      open: false,
      code: 'break-open',
      detail: `reconciliation run ${gate.runId} found a break: ${gate.reasons.join('; ') || 'no reason recorded'}`,
      gate,
    };
  }
  if (!gate.treasuryReconciled) {
    return {
      open: false,
      code: 'treasury-not-reconciled',
      detail: `reconciliation run ${gate.runId} did not read this treasury, so it cannot vouch for it`,
      gate,
    };
  }
  if (nowMs - gate.atMs > TRANSFER_GATE_MAX_AGE_MS) {
    return {
      open: false,
      code: 'stale',
      detail: `the latest gate (run ${gate.runId}) is older than ${TRANSFER_GATE_MAX_AGE_MS / 3_600_000}h; reconciliation stopped reporting`,
      gate,
    };
  }
  return { open: true, gate };
}

/** What the operator's run reads: credits still owed, and every routed DAO-share transfer. */
export async function readReconciliationInputs(db: D1Database, nowMs: number): Promise<ReconciliationInputs> {
  const credits = await db
    .prepare(
      `SELECT COALESCE(SUM(available_micros + reserved_micros), 0) AS outstanding
         FROM prepaid_credit_balances`,
    )
    .first<{ outstanding: number }>();
  const { results } = await db
    .prepare(
      `SELECT transfer_id, chain_id, transaction_hash, amount_micros, created_at_ms
         FROM treasury_transfers
        WHERE share = 'dao'
        ORDER BY created_at_ms ASC, transfer_id ASC`,
    )
    .all<{ transfer_id: string; chain_id: number; transaction_hash: string; amount_micros: number; created_at_ms: number }>();
  // D-032: the DAO's allocation of every FINAL batch is the independent accrual
  // the operator's dao-payable invariant compares the journal against.
  const { results: batches } = await db
    .prepare(
      `SELECT batch_id, chain_id, claim_tx_hash, claim_micros, allocations_micros, finalized_at_ms
         FROM settlement_batches
        WHERE state = 'final'
        ORDER BY finalized_at_ms ASC, batch_id ASC`,
    )
    .all<{ batch_id: string; chain_id: number; claim_tx_hash: string; claim_micros: number; allocations_micros: string; finalized_at_ms: number }>();
  return {
    outstandingCreditsMicros: Number(credits?.outstanding ?? 0),
    daoTransfers: (results ?? []).map((r) => ({
      transferId: r.transfer_id,
      chainId: r.chain_id,
      transactionHash: r.transaction_hash,
      amountMicros: r.amount_micros,
      createdAtMs: r.created_at_ms,
    })),
    finalSettlementBatches: (batches ?? []).map((b) => ({
      batchId: b.batch_id,
      chainId: Number(b.chain_id),
      claimTransactionHash: b.claim_tx_hash,
      claimMicros: Number(b.claim_micros),
      daoMicros: daoAllocationMicros(b.allocations_micros),
      finalizedAtMs: Number(b.finalized_at_ms),
    })),
    generatedAtMs: nowMs,
  };
}

/**
 * The `dao` entry of a batch's canonical allocations JSON (decimal micro
 * strings). Anything unreadable becomes NaN, which serializes as null and makes
 * the operator's parser refuse the whole read: a guessed zero would silently
 * understate what the DAO is owed.
 */
export function daoAllocationMicros(allocationsJson: string): number {
  try {
    const parsed: unknown = JSON.parse(allocationsJson);
    const dao = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).dao : undefined;
    if (typeof dao !== 'string' || !/^\d+$/.test(dao)) return Number.NaN;
    const micros = Number(dao);
    return Number.isSafeInteger(micros) ? micros : Number.NaN;
  } catch {
    return Number.NaN;
  }
}
