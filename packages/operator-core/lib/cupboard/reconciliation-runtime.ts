/**
 * The operator's reconciliation pass (agent-economy-flywheel-2026-08-30 P-043,
 * R-31, D-023 §3, D-025 §4-§6).
 *
 * One pass, per workspace:
 *   1. IMPORT. Stripe balance transactions and routed DAO transfers become
 *      journal entries first (idempotent), so the comparison that follows is
 *      between the books and the world, not between yesterday's books and today.
 *   2. READ the sources: Stripe balance transactions, the Cupboard Worker's
 *      prepaid-credit and DAO-transfer records (HMAC), the chain (transaction
 *      receipts, when an RPC is configured), the bank feed (not connected), and
 *      the DAO Safe (not deployed).
 *   3. RECONCILE with the pure engine (reconciliation.ts): persist the run, file
 *      or resolve break items, and push the DAO-transfer gate to the Worker.
 *
 * Every source that does not exist in this deployment reads `not-configured`;
 * one that exists and fails reads `failed`. Neither is ever a pass.
 *
 * Configuration (secrets are env:/file: references, never values):
 *   PAPERCUSP_STRIPE_SECRET_KEY_REF            shared with hosted billing
 *   PAPERCUSP_STRIPE_JOURNAL_WORKSPACE         the workspace whose journal the Stripe account posts into
 *   PAPERCUSP_RECONCILIATION_TREASURY_WORKSPACE the workspace that owns the Cupboard treasury
 *                                              (default: the Stripe journal workspace; unset = none,
 *                                              and every gate push says treasuryReconciled:false)
 *   PAPERCUSP_MONEY_JOURNAL_POLICY             JSON { daoBasisPoints, refundReserveBasisPoints }
 *   PAPERCUSP_RECONCILIATION_GATE_SECRET_REF   HMAC secret shared with the Worker (RECONCILIATION_GATE_SECRET)
 *   PAPERCUSP_CUPBOARD_URL                     the Worker origin (base-url.ts)
 *   PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL     optional: verify DAO transfer receipts on chain
 *   PAPERCUSP_RECONCILIATION_SAFE_ADDRESS      optional, with the two below: the DAO Safe the
 *   PAPERCUSP_RECONCILIATION_SAFE_TOKEN_ADDRESS  safe-balance invariant reads (needs the RPC URL;
 *   PAPERCUSP_RECONCILIATION_SAFE_FROM_BLOCK     a 6-decimal token such as USDC; the deployment block)
 *
 * The DBOS schedule (dbos/reconciliation-workflow.ts) and the
 * `cupboard:reconciliation` tool both call `runReconciliationPass`.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolveCupboardBaseUrl } from './base-url';
import {
  importStripeBalanceTransactions,
  journalVerdictForSettlementClaim,
  journalVerdictForStripeBalanceTransaction,
  journalVerdictForTreasuryTransfer,
  stripeBalanceTransactionLister,
  validatePolicy,
  type CustomerPaymentPolicy,
  type ImportReport,
  type JournalPoster,
  type StripeBalanceTransaction,
  type StripeBalanceTransactionLister,
} from './money-journal-producers';
import { MICROS_PER_CENT, type JournalEntry } from './money-journal';
import { postMoneyJournalEntry, readMoneyJournalEntries } from './money-journal-store';
import { recordPaymentReceipts, type RecordPaymentReceiptsResult } from './payment-receipt-store';
import {
  reconciliationPeriod,
  runReconciliation,
  type BreakFiler,
  type ExternalMovement,
  type GatePublisher,
  type ReconciliationMode,
  type ReconciliationRunRecord,
  type ReconciliationSources,
  type ReconciliationStore,
  type SafeSnapshot,
  type SourceRead,
} from './reconciliation';
import {
  RECONCILIATION_INPUTS_PATH,
  RECONCILIATION_SIGNATURE_HEADER,
  TRANSFER_GATE_PATH,
  parseReconciliationInputs,
  signReconciliationRequest,
  type ReconciliationInputs,
  type TransferGatePush,
} from './reconciliation-hmac';
import { pgReconciliationStore } from './reconciliation-store';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

export interface ReconciliationRuntimeConfig {
  readonly stripeSecretKeyRef: string | null;
  readonly stripeJournalWorkspace: string | null;
  /** The workspace whose journal carries the Cupboard's credits and DAO transfers. */
  readonly treasuryWorkspace: string | null;
  readonly policy: CustomerPaymentPolicy | null;
  /** Why the policy is unusable, when PAPERCUSP_MONEY_JOURNAL_POLICY is set but wrong. */
  readonly policyError: string | null;
  readonly gateSecretRef: string | null;
  readonly cupboardUrl: string;
  readonly chainRpcUrl: string | null;
  /** The DAO Safe whose token balance the safe-balance invariant checks (D-025 §1). */
  readonly safe: SafeReadConfig;
}

/**
 * Where the DAO Safe lives on chain. `invalid` is a misconfiguration (some
 * variables set, or set wrongly), which the pass reads as a failed source: the
 * Safe was meant to be checked.
 */
export type SafeReadConfig =
  | { readonly status: 'not-configured' }
  | { readonly status: 'invalid'; readonly detail: string }
  | {
      readonly status: 'configured';
      readonly safeAddress: `0x${string}`;
      readonly tokenAddress: `0x${string}`;
      /** The block the Safe was deployed in: receipts are summed from here. */
      readonly fromBlock: bigint;
    };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function parseSafeReadConfig(env: NodeJS.ProcessEnv): SafeReadConfig {
  const safeAddress = trimmed(env.PAPERCUSP_RECONCILIATION_SAFE_ADDRESS);
  const tokenAddress = trimmed(env.PAPERCUSP_RECONCILIATION_SAFE_TOKEN_ADDRESS);
  const fromBlock = trimmed(env.PAPERCUSP_RECONCILIATION_SAFE_FROM_BLOCK);
  if (!safeAddress && !tokenAddress && !fromBlock) return { status: 'not-configured' };
  if (!safeAddress || !EVM_ADDRESS.test(safeAddress)) {
    return { status: 'invalid', detail: 'PAPERCUSP_RECONCILIATION_SAFE_ADDRESS must be an EVM address' };
  }
  if (!tokenAddress || !EVM_ADDRESS.test(tokenAddress)) {
    return { status: 'invalid', detail: 'PAPERCUSP_RECONCILIATION_SAFE_TOKEN_ADDRESS must be an EVM address' };
  }
  if (!fromBlock || !/^\d+$/.test(fromBlock)) {
    return { status: 'invalid', detail: "PAPERCUSP_RECONCILIATION_SAFE_FROM_BLOCK must be the Safe's deployment block number" };
  }
  return {
    status: 'configured',
    safeAddress: safeAddress.toLowerCase() as `0x${string}`,
    tokenAddress: tokenAddress.toLowerCase() as `0x${string}`,
    fromBlock: BigInt(fromBlock),
  };
}

const trimmed = (value: string | undefined): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export function parseMoneyJournalPolicy(raw: string | undefined): { policy: CustomerPaymentPolicy | null; error: string | null } {
  const text = trimmed(raw);
  if (!text) return { policy: null, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { policy: null, error: 'PAPERCUSP_MONEY_JOURNAL_POLICY is not JSON' };
  }
  const p = (parsed ?? {}) as Record<string, unknown>;
  const policy = { daoBasisPoints: Number(p.daoBasisPoints), refundReserveBasisPoints: Number(p.refundReserveBasisPoints) };
  const error = validatePolicy(policy);
  return error ? { policy: null, error: `PAPERCUSP_MONEY_JOURNAL_POLICY: ${error}` } : { policy, error: null };
}

export function readReconciliationRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ReconciliationRuntimeConfig {
  const { policy, error } = parseMoneyJournalPolicy(env.PAPERCUSP_MONEY_JOURNAL_POLICY);
  const stripeJournalWorkspace = trimmed(env.PAPERCUSP_STRIPE_JOURNAL_WORKSPACE);
  return {
    stripeSecretKeyRef: trimmed(env.PAPERCUSP_STRIPE_SECRET_KEY_REF),
    stripeJournalWorkspace,
    treasuryWorkspace: trimmed(env.PAPERCUSP_RECONCILIATION_TREASURY_WORKSPACE) ?? stripeJournalWorkspace,
    policy,
    policyError: error,
    gateSecretRef: trimmed(env.PAPERCUSP_RECONCILIATION_GATE_SECRET_REF),
    cupboardUrl: trimmed(env.PAPERCUSP_CUPBOARD_URL)?.replace(/\/+$/, '') ?? resolveCupboardBaseUrl(),
    chainRpcUrl: trimmed(env.PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL),
    safe: parseSafeReadConfig(env),
  };
}

// ---------------------------------------------------------------------------
// Sources.
// ---------------------------------------------------------------------------

const errorText = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0]! : String(error));

/** Whole cents from token micros (USDC: 6 decimals). Rounded half-up; import and matching use the same rule. */
export function centsFromMicros(micros: number): number {
  return Math.round(micros / MICROS_PER_CENT);
}

/**
 * Stripe balance transactions in the period as cash movements. Payouts are
 * excluded (Stripe balance to bank: both sides are `operating`, so the journal
 * carries no entry for them). Net = amount - fee, Stripe's own definition.
 */
export async function readStripeMovements(input: {
  readonly list: StripeBalanceTransactionLister;
  readonly policy: CustomerPaymentPolicy;
  readonly fromMs: number;
  readonly untilMs: number;
  readonly maxPages?: number;
}): Promise<SourceRead<readonly ExternalMovement[]>> {
  const movements: ExternalMovement[] = [];
  const createdGte = Math.floor(input.fromMs / 1000);
  let startingAfter: string | undefined;
  const maxPages = input.maxPages ?? 50;
  try {
    for (let page = 0; ; page += 1) {
      if (page >= maxPages) {
        return { status: 'failed', detail: `more than ${maxPages} pages of balance transactions; the read was not complete` };
      }
      const result = await input.list({ limit: 100, startingAfter, createdGte });
      for (const bt of result.data) {
        const createdMs = bt.created * 1000;
        if (createdMs < input.fromMs || createdMs >= input.untilMs) continue;
        const movement = stripeMovementFor(bt, input.policy);
        if (movement) movements.push(movement);
      }
      if (!result.has_more || result.data.length === 0) break;
      startingAfter = result.data[result.data.length - 1]!.id;
    }
  } catch (error) {
    return { status: 'failed', detail: errorText(error) };
  }
  return { status: 'ok', value: movements };
}

/** Confirms a transaction succeeded on chain. Resolves false for a missing or reverted transaction. */
export type ChainReceiptVerifier = (input: { chainId: number; transactionHash: string }) => Promise<boolean>;

/** A viem verifier over one RPC endpoint; refuses a transaction from another chain. */
export function viemChainReceiptVerifier(rpcUrl: string): ChainReceiptVerifier {
  let client: Promise<{ chainId: number; getStatus(hash: `0x${string}`): Promise<'success' | 'reverted' | null> }> | null = null;
  const connect = async () => {
    const { createPublicClient, http } = await import('viem');
    const pc = createPublicClient({ transport: http(rpcUrl) });
    const chainId = await pc.getChainId();
    return {
      chainId,
      async getStatus(hash: `0x${string}`) {
        try {
          return (await pc.getTransactionReceipt({ hash })).status;
        } catch (error) {
          if (/could not be found|not found/i.test(errorText(error))) return null;
          throw error;
        }
      },
    };
  };
  return async ({ chainId, transactionHash }) => {
    client ??= connect();
    const c = await client;
    if (c.chainId !== chainId) throw new Error(`the RPC serves chain ${c.chainId}, the transfer settled on chain ${chainId}`);
    return (await c.getStatus(transactionHash as `0x${string}`)) === 'success';
  };
}

/** Reads the Worker's reconciliation inputs over the signed route. */
export type CupboardInputsReader = () => Promise<ReconciliationInputs>;

export function cupboardInputsReader(input: {
  readonly baseUrl: string;
  readonly secret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): CupboardInputsReader {
  return async () => {
    const signature = await signReconciliationRequest({
      secret: input.secret,
      method: 'GET',
      pathname: RECONCILIATION_INPUTS_PATH,
      body: '',
      nowMs: (input.now ?? Date.now)(),
    });
    const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl}${RECONCILIATION_INPUTS_PATH}`, {
      method: 'GET',
      headers: { [RECONCILIATION_SIGNATURE_HEADER]: signature },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`cupboard reconciliation-inputs: status ${response.status}: ${text.slice(0, 200)}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('cupboard reconciliation-inputs: non-JSON response');
    }
    return parseReconciliationInputs(body);
  };
}

export interface VerifiedDaoTransfers {
  /** Transfers confirmed on chain, or every recorded one when no verifier is configured. */
  readonly confirmed: ReconciliationInputs['daoTransfers'];
  /** Recorded by the Worker but missing or reverted on chain. */
  readonly unconfirmed: readonly string[];
}

export async function verifyDaoTransfers(
  transfers: ReconciliationInputs['daoTransfers'],
  verifier: ChainReceiptVerifier | null,
): Promise<VerifiedDaoTransfers> {
  return verifyOnChain(transfers, verifier, (t) => t.transactionHash);
}

export type SettlementClaims = ReconciliationInputs['finalSettlementBatches'];

export interface VerifiedSettlementClaims {
  /** Final claims confirmed on chain, or every listed one when no verifier is configured. */
  readonly confirmed: SettlementClaims;
  /** Listed as final by the Worker but missing or reverted on chain. */
  readonly unconfirmed: readonly string[];
}

/** D-032: a final claim is journaled only once the chain confirms its transaction, like a DAO transfer. */
export async function verifySettlementClaims(claims: SettlementClaims, verifier: ChainReceiptVerifier | null): Promise<VerifiedSettlementClaims> {
  return verifyOnChain(claims, verifier, (c) => c.claimTransactionHash);
}

async function verifyOnChain<T extends { readonly chainId: number }>(
  rows: readonly T[],
  verifier: ChainReceiptVerifier | null,
  hashOf: (row: T) => string,
): Promise<{ confirmed: readonly T[]; unconfirmed: readonly string[] }> {
  if (!verifier) return { confirmed: rows, unconfirmed: [] };
  const confirmed: T[] = [];
  const unconfirmed: string[] = [];
  for (const row of rows) {
    if (await verifier({ chainId: row.chainId, transactionHash: hashOf(row) })) confirmed.push(row);
    else unconfirmed.push(`chain-tx:${row.chainId}:${hashOf(row)}`);
  }
  return { confirmed, unconfirmed };
}

/** The DAO's chain-rail accrual: each final claim's allocation in cents, rounded per batch as the import rounds it. */
export function settlementDaoAccruedCents(claims: SettlementClaims, untilMs: number): number {
  return claims.filter((c) => c.finalizedAtMs < untilMs).reduce((sum, c) => sum + centsFromMicros(c.daoMicros), 0);
}

// ---------------------------------------------------------------------------
// The DAO Safe (D-025 §1, WI-10004708).
//
// Balance and receipts come from the chain; approved spends come from the
// Worker's treasury transfers (each one authorized through the Zodiac Roles
// modifier and confirmed on chain). A spend that bypassed the Worker, such as
// an owner-signed transfer, leaves the balance short of receipts minus approved
// spends, which breaks the invariant and closes the transfer gate. A transfer
// the Worker has not recorded yet reads the same way until the next pass.
// ---------------------------------------------------------------------------

/** One consistent read of the Safe's token position, pinned to a single block. */
export interface SafeChainState {
  readonly chainId: number;
  readonly blockNumber: bigint;
  readonly decimals: number;
  /** Token balance of the Safe at `blockNumber`, in base units. */
  readonly balance: bigint;
  /** Sum of Transfer(to = Safe) from the deployment block through `blockNumber`, excluding the Safe paying itself. */
  readonly received: bigint;
}

export type SafeChainReader = (input: {
  readonly safeAddress: `0x${string}`;
  readonly tokenAddress: `0x${string}`;
  readonly fromBlock: bigint;
}) => Promise<SafeChainState>;

const ERC20_READ_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const ERC20_TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

/**
 * A viem reader over one RPC endpoint. Logs are read in `blockSpan` windows
 * because providers cap the range of one eth_getLogs call; more than `maxSpans`
 * windows fails the read rather than returning a partial sum.
 */
export function viemSafeChainReader(rpcUrl: string, opts: { readonly blockSpan?: bigint; readonly maxSpans?: number } = {}): SafeChainReader {
  const blockSpan = opts.blockSpan ?? 10_000n;
  const maxSpans = opts.maxSpans ?? 2_000;
  return async ({ safeAddress, tokenAddress, fromBlock }) => {
    const { createPublicClient, http } = await import('viem');
    const pc = createPublicClient({ transport: http(rpcUrl) });
    const [chainId, blockNumber] = await Promise.all([pc.getChainId(), pc.getBlockNumber()]);
    if (fromBlock > blockNumber) throw new Error(`the Safe's deployment block ${fromBlock} is after the chain head ${blockNumber}`);
    const spans = (blockNumber - fromBlock) / blockSpan + 1n;
    if (spans > BigInt(maxSpans)) throw new Error(`${spans} log windows of ${blockSpan} blocks exceed the limit of ${maxSpans}`);
    const [balance, decimals] = await Promise.all([
      pc.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [safeAddress], blockNumber }),
      pc.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: 'decimals', blockNumber }),
    ]);
    const safe = safeAddress.toLowerCase();
    let received = 0n;
    for (let from = fromBlock; from <= blockNumber; from += blockSpan) {
      const to = from + blockSpan - 1n < blockNumber ? from + blockSpan - 1n : blockNumber;
      const logs = await pc.getLogs({ address: tokenAddress, event: ERC20_TRANSFER_EVENT, args: { to: safeAddress }, fromBlock: from, toBlock: to, strict: true });
      for (const log of logs) {
        if (log.args.from.toLowerCase() === safe) continue;
        received += log.args.value;
      }
    }
    return { chainId, blockNumber, decimals: Number(decimals), balance, received };
  };
}

/**
 * The SafeSnapshot the engine checks. Fails closed on anything that would make
 * the comparison meaningless: a token that is not 6-decimal (base units are then
 * not micro-USD), a DAO transfer on another chain (it did not leave this Safe),
 * or an amount beyond exact Number range.
 */
export async function readSafeSnapshot(input: {
  readonly reader: SafeChainReader;
  readonly safeAddress: `0x${string}`;
  readonly tokenAddress: `0x${string}`;
  readonly fromBlock: bigint;
  readonly approvedSpends: ReconciliationInputs['daoTransfers'];
}): Promise<SourceRead<SafeSnapshot>> {
  let state: SafeChainState;
  try {
    state = await input.reader({ safeAddress: input.safeAddress, tokenAddress: input.tokenAddress, fromBlock: input.fromBlock });
  } catch (error) {
    return { status: 'failed', detail: `the Safe could not be read on chain: ${errorText(error)}` };
  }
  if (state.decimals !== 6) {
    return { status: 'failed', detail: `the Safe token has ${state.decimals} decimals; the invariant compares 6-decimal micros` };
  }
  const foreign = input.approvedSpends.filter((t) => t.chainId !== state.chainId);
  if (foreign.length > 0) {
    return {
      status: 'failed',
      detail: `${foreign.length} DAO transfer(s) settled on chain ${foreign[0]!.chainId}, but the Safe is read on chain ${state.chainId}`,
    };
  }
  const spent = input.approvedSpends.reduce((sum, t) => sum + BigInt(t.amountMicros), 0n);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (state.balance > max || state.received > max || spent > max) {
    return { status: 'failed', detail: 'a Safe amount exceeds the exact integer range of the comparison' };
  }
  return {
    status: 'ok',
    value: { balanceMicros: Number(state.balance), receiptsMicros: Number(state.received), approvedSpendsMicros: Number(spent) },
  };
}

// ---------------------------------------------------------------------------
// Import (D-023 §3: the run imports first, then reconciles).
// ---------------------------------------------------------------------------

export interface DaoTransferImportReport {
  readonly scanned: number;
  readonly posted: number;
  readonly duplicates: number;
  readonly refused: ReadonlyArray<{ readonly sourceId: string; readonly code: string; readonly detail: string }>;
}

export async function importDaoTransfers(
  transfers: ReconciliationInputs['daoTransfers'],
  post: JournalPoster,
): Promise<DaoTransferImportReport> {
  let posted = 0;
  let duplicates = 0;
  const refused: Array<{ sourceId: string; code: string; detail: string }> = [];
  for (const t of transfers) {
    const verdict = journalVerdictForTreasuryTransfer({
      chainId: t.chainId,
      txHash: t.transactionHash,
      amountCents: centsFromMicros(t.amountMicros),
      occurredAtMs: t.createdAtMs,
      memo: `dao transfer ${t.transferId}`,
    });
    if (verdict.disposition !== 'entry') {
      refused.push({ sourceId: t.transferId, code: 'unmapped', detail: verdict.reason });
      continue;
    }
    const outcome = await post(verdict.entry);
    if (!outcome.ok) refused.push({ sourceId: t.transferId, code: outcome.code, detail: outcome.detail });
    else if (outcome.duplicate) duplicates += 1;
    else posted += 1;
  }
  return { scanned: transfers.length, posted, duplicates, refused };
}

/** D-032: every final settlement claim becomes one customer-payment entry keyed by its claim transaction. */
export async function importSettlementClaims(claims: SettlementClaims, post: JournalPoster): Promise<DaoTransferImportReport> {
  let posted = 0;
  let duplicates = 0;
  const refused: Array<{ sourceId: string; code: string; detail: string }> = [];
  for (const c of claims) {
    const verdict = journalVerdictForSettlementClaim({
      chainId: c.chainId,
      txHash: c.claimTransactionHash,
      grossCents: centsFromMicros(c.claimMicros),
      daoCents: centsFromMicros(c.daoMicros),
      occurredAtMs: c.finalizedAtMs,
      memo: `settlement claim ${c.batchId}`,
    });
    if (verdict.disposition !== 'entry') {
      refused.push({ sourceId: c.batchId, code: 'unmapped', detail: verdict.reason });
      continue;
    }
    const outcome = await post(verdict.entry);
    if (!outcome.ok) refused.push({ sourceId: c.batchId, code: outcome.code, detail: outcome.detail });
    else if (outcome.duplicate) duplicates += 1;
    else posted += 1;
  }
  return { scanned: claims.length, posted, duplicates, refused };
}

// ---------------------------------------------------------------------------
// Filing break items, and pushing the gate.
// ---------------------------------------------------------------------------

export const reconciliationBreakWatchdogKey = (workspaceId: string, invariant: string, openedByRunId: string): string =>
  `reconciliation:break:${workspaceId}:${invariant}:${openedByRunId}`;

/** Files each NEW break as a bug item; comments on it when the invariant holds again. */
export function workItemBreakFiler(): BreakFiler {
  return {
    async fileBreak({ workspaceId, verdict, period, runId }) {
      const { captureImprovement } = await import('../harness/improvements/capture-core');
      const result = await captureImprovement({
        title: `Reconciliation break: ${verdict.invariant} (workspace ${workspaceId}, ${period.mode} ${period.month})`,
        kind: 'bug',
        severity: 'major',
        body: [
          `Reconciliation run ${runId} (${period.mode}, ${period.month}) found the invariant ${verdict.invariant} broken in workspace ${workspaceId}.`,
          '',
          `Evidence: ${verdict.detail}`,
          '',
          'DAO transfers are paused until the break resolves (D-025 §4). A later run that finds the invariant holding again resolves the break and comments here.',
          'Inspect: cupboard:reconciliation { op: "status" }. Re-run after a fix: cupboard:reconciliation { op: "run", confirm: true }.',
        ].join('\n'),
        watchdogKey: reconciliationBreakWatchdogKey(workspaceId, verdict.invariant, runId),
        workspaceId,
        scope: 'harness:papercusp',
        sourceRole: 'system',
        filedByRole: 'reconciliation',
        createdBy: 'system:reconciliation',
        paths: ['packages/operator-core/lib/cupboard/reconciliation.ts'],
      });
      const id = result.issue?.id;
      if (!id) throw new Error(`reconciliation: filing the ${verdict.invariant} break returned no work item`);
      return id;
    },
    async noteResolved({ workspaceId, workItemId, verdict, runId }) {
      const { commentWorkItem } = await import('../work-items');
      await commentWorkItem(
        workItemId,
        `Resolved by reconciliation run ${runId}: ${verdict.invariant} holds again (${verdict.detail}).`,
        'system:reconciliation',
        { workspaceId },
      );
    },
  };
}

/** Pushes each run's gate to the Worker. With no secret configured, reports `published:false` and pushes nothing. */
export function cupboardGatePublisher(input: {
  readonly baseUrl: string;
  readonly secret: string | null;
  /** Whether the run behind this push evaluated the treasury invariants (see TransferGatePush). */
  readonly treasuryReconciled: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}): GatePublisher {
  return {
    async publish({ workspaceId, gate, runId, atMs }) {
      if (!input.secret) {
        return { published: false, detail: 'PAPERCUSP_RECONCILIATION_GATE_SECRET_REF is not configured; the Worker keeps transfers paused' };
      }
      const push: TransferGatePush = {
        workspaceId,
        open: gate.open,
        reasons: gate.reasons,
        runId,
        atMs,
        treasuryReconciled: input.treasuryReconciled,
      };
      const body = JSON.stringify(push);
      try {
        const signature = await signReconciliationRequest({
          secret: input.secret,
          method: 'PUT',
          pathname: TRANSFER_GATE_PATH,
          body,
          nowMs: (input.now ?? Date.now)(),
        });
        const response = await (input.fetchImpl ?? fetch)(`${input.baseUrl}${TRANSFER_GATE_PATH}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', [RECONCILIATION_SIGNATURE_HEADER]: signature },
          body,
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) return { published: false, detail: `the Worker answered ${response.status}: ${(await response.text()).slice(0, 200)}` };
        return { published: true };
      } catch (error) {
        return { published: false, detail: errorText(error) };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// One pass.
// ---------------------------------------------------------------------------

/** The workspaces a pass covers: every workspace with a journal, plus the configured Stripe and treasury workspaces. */
export async function reconciliationWorkspaces(sql: Sql, configured: ReadonlyArray<string | null>): Promise<string[]> {
  const rows = await sql<{ workspace_id: string }[]>`
    SELECT DISTINCT workspace_id FROM harness_shared.money_journal_entries ORDER BY workspace_id`;
  const set = new Set(rows.map((r) => r.workspace_id));
  for (const ws of configured) if (ws) set.add(ws);
  return [...set].sort();
}

export interface WorkspaceReconciliation {
  readonly workspaceId: string;
  readonly stripeImport: ImportReport | { readonly skipped: string } | { readonly failed: string };
  readonly daoTransferImport: DaoTransferImportReport | { readonly skipped: string } | { readonly failed: string };
  /** D-032: final settlement claims imported as customer payments over the chain. */
  readonly settlementClaimImport: DaoTransferImportReport | { readonly skipped: string } | { readonly failed: string };
  /** P-046: a salted receipt commitment for every balance transaction the import listed. */
  readonly paymentReceipts: RecordPaymentReceiptsResult | { readonly skipped: string } | { readonly failed: string };
  readonly run: ReconciliationRunRecord | null;
  readonly error: string | null;
}

export interface ReconciliationPassResult {
  readonly mode: ReconciliationMode;
  readonly workspaces: readonly WorkspaceReconciliation[];
}

export interface ReconciliationPassDeps {
  readonly sql?: Sql;
  readonly config?: ReconciliationRuntimeConfig;
  readonly resolveSecret?: (ref: string) => Promise<string>;
  readonly stripeLister?: StripeBalanceTransactionLister | null;
  readonly cupboardInputs?: CupboardInputsReader | null;
  readonly chainVerifier?: ChainReceiptVerifier | null;
  /** WI-10004708: reads the DAO Safe (default: viem over the chain RPC URL, when the Safe is configured). */
  readonly safeReader?: SafeChainReader | null;
  readonly store?: ReconciliationStore;
  readonly filer?: BreakFiler;
  readonly gate?: GatePublisher;
  readonly post?: (workspaceId: string) => JournalPoster;
  readonly readEntries?: (workspaceId: string) => Promise<JournalEntry[]>;
  /** P-046: record receipts for the balance transactions the import listed (default: Postgres). */
  readonly recordReceipts?: (
    workspaceId: string,
    transactions: readonly StripeBalanceTransaction[],
  ) => Promise<RecordPaymentReceiptsResult>;
  readonly now?: () => number;
  readonly fetchImpl?: typeof fetch;
}

async function defaultResolveSecret(ref: string): Promise<string> {
  const { resolveSecretRef } = await import('../inference-gateway/egress-providers/secret-ref');
  return resolveSecretRef(ref);
}

export async function runReconciliationPass(
  input: { readonly mode: ReconciliationMode; readonly workspaces?: readonly string[] },
  deps: ReconciliationPassDeps = {},
): Promise<ReconciliationPassResult> {
  // Resolved only by the defaults that need it, so a fully injected pass never opens a pool.
  const sql = (): Sql => deps.sql ?? getOrgPg().sql;
  const config = deps.config ?? readReconciliationRuntimeConfig();
  const now = deps.now ?? Date.now;
  const resolveSecret = deps.resolveSecret ?? defaultResolveSecret;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Resolve each rail once per pass. A rail whose configuration fails to resolve
  // is `failed`, not `not-configured`: it was meant to exist.
  let stripeLister: StripeBalanceTransactionLister | null = null;
  let stripeUnavailable: SourceRead<never> = { status: 'not-configured' };
  if (deps.stripeLister !== undefined) stripeLister = deps.stripeLister;
  else if (config.stripeSecretKeyRef) {
    try {
      stripeLister = stripeBalanceTransactionLister({ secretKey: await resolveSecret(config.stripeSecretKeyRef), fetchImpl });
    } catch (error) {
      stripeUnavailable = { status: 'failed', detail: `the Stripe secret could not be resolved: ${errorText(error)}` };
    }
  }
  if (stripeLister && !config.policy) {
    stripeUnavailable = { status: 'failed', detail: config.policyError ?? 'PAPERCUSP_MONEY_JOURNAL_POLICY is not configured, so balance transactions cannot be mapped' };
    stripeLister = null;
  }

  let gateSecret: string | null = null;
  let cupboardUnavailable: SourceRead<never> = { status: 'not-configured' };
  if (config.gateSecretRef) {
    try {
      gateSecret = await resolveSecret(config.gateSecretRef);
    } catch (error) {
      cupboardUnavailable = { status: 'failed', detail: `the reconciliation gate secret could not be resolved: ${errorText(error)}` };
    }
  }
  const readCupboard =
    deps.cupboardInputs !== undefined
      ? deps.cupboardInputs
      : gateSecret
        ? cupboardInputsReader({ baseUrl: config.cupboardUrl, secret: gateSecret, fetchImpl, now })
        : null;
  const chainVerifier =
    deps.chainVerifier !== undefined ? deps.chainVerifier : config.chainRpcUrl ? viemChainReceiptVerifier(config.chainRpcUrl) : null;

  const store = deps.store ?? pgReconciliationStore(sql());
  const filer = deps.filer ?? workItemBreakFiler();
  const gateFor = (treasuryReconciled: boolean): GatePublisher =>
    deps.gate ?? cupboardGatePublisher({ baseUrl: config.cupboardUrl, secret: gateSecret, treasuryReconciled, fetchImpl, now });
  const postFor =
    deps.post ??
    ((workspaceId: string): JournalPoster =>
      async (entry) => {
        const r = await postMoneyJournalEntry({ workspaceId, entry }, { sql: sql() });
        return r.ok ? { ok: true, duplicate: r.duplicate } : { ok: false, code: r.code, detail: r.detail };
      });
  const readEntries = deps.readEntries ?? ((ws: string) => readMoneyJournalEntries(ws, { sql: sql() }));
  const recordReceipts =
    deps.recordReceipts ??
    ((ws: string, transactions: readonly StripeBalanceTransaction[]) => recordPaymentReceipts(ws, transactions, { sql: sql() }));

  // The Worker's records are deployment-wide (one Cupboard per operator), read once.
  let cupboard: SourceRead<ReconciliationInputs> = cupboardUnavailable;
  if (readCupboard) {
    try {
      cupboard = { status: 'ok', value: await readCupboard() };
    } catch (error) {
      cupboard = { status: 'failed', detail: errorText(error) };
    }
  }
  let verified: SourceRead<VerifiedDaoTransfers & { readonly claims: VerifiedSettlementClaims }> =
    cupboard.status === 'ok' ? { status: 'not-configured' } : cupboard;
  if (cupboard.status === 'ok') {
    try {
      const transfers = await verifyDaoTransfers(cupboard.value.daoTransfers, chainVerifier);
      const claims = await verifySettlementClaims(cupboard.value.finalSettlementBatches, chainVerifier);
      verified = { status: 'ok', value: { ...transfers, claims } };
    } catch (error) {
      verified = { status: 'failed', detail: `chain receipts could not be read: ${errorText(error)}` };
    }
  }

  // The Safe is deployment-wide too: read once, and only if a treasury workspace runs.
  const safeReader =
    deps.safeReader !== undefined ? deps.safeReader : config.chainRpcUrl ? viemSafeChainReader(config.chainRpcUrl) : null;
  let safeRead: Promise<SourceRead<SafeSnapshot>> | null = null;
  const readSafe = (): Promise<SourceRead<SafeSnapshot>> => {
    safeRead ??= (async (): Promise<SourceRead<SafeSnapshot>> => {
      const safe = config.safe;
      if (safe.status === 'not-configured') return { status: 'not-configured' };
      if (safe.status === 'invalid') return { status: 'failed', detail: safe.detail };
      if (!safeReader) return { status: 'failed', detail: 'PAPERCUSP_RECONCILIATION_CHAIN_RPC_URL is required to read the Safe' };
      if (verified.status !== 'ok') {
        const why = verified.status === 'failed' ? verified.detail : 'the Cupboard reconciliation inputs are not configured';
        return { status: 'failed', detail: `approved spends could not be read: ${why}` };
      }
      return readSafeSnapshot({
        reader: safeReader,
        safeAddress: safe.safeAddress,
        tokenAddress: safe.tokenAddress,
        fromBlock: safe.fromBlock,
        approvedSpends: verified.value.confirmed,
      });
    })();
    return safeRead;
  };

  const workspaceIds =
    input.workspaces ?? (await reconciliationWorkspaces(sql(), [config.stripeJournalWorkspace, config.treasuryWorkspace]));
  const results: WorkspaceReconciliation[] = [];
  for (const workspaceId of workspaceIds) {
    const startedAtMs = now();
    const period = reconciliationPeriod(input.mode, startedAtMs);
    const ownsStripe = config.stripeJournalWorkspace === workspaceId;
    const ownsTreasury = config.treasuryWorkspace === workspaceId;
    const treasuryReconciled = ownsTreasury && cupboard.status === 'ok' && verified.status === 'ok';
    let stripeImport: WorkspaceReconciliation['stripeImport'] = { skipped: 'this workspace has no Stripe account' };
    let daoTransferImport: WorkspaceReconciliation['daoTransferImport'] = { skipped: 'this workspace does not own the Cupboard treasury' };
    let settlementClaimImport: WorkspaceReconciliation['settlementClaimImport'] = { skipped: 'this workspace does not own the Cupboard treasury' };
    let paymentReceipts: WorkspaceReconciliation['paymentReceipts'] = { skipped: 'this workspace has no Stripe account' };
    try {
      const post = postFor(workspaceId);
      // 1. Import.
      if (ownsStripe && stripeLister && config.policy) {
        // Tee the lister: every balance transaction the import sees also gets a receipt (D-029 §4).
        const listed: StripeBalanceTransaction[] = [];
        const lister = stripeLister;
        const teed: StripeBalanceTransactionLister = async (params) => {
          const page = await lister(params);
          listed.push(...page.data);
          return page;
        };
        try {
          stripeImport = await importStripeBalanceTransactions({
            list: teed,
            post,
            policy: config.policy,
            createdGte: Math.floor(period.fromMs / 1000),
          });
        } catch (error) {
          stripeImport = { failed: errorText(error) };
        }
        // Whatever was listed before a failure still gets its receipt; the rest arrives next pass.
        try {
          paymentReceipts = await recordReceipts(workspaceId, listed);
        } catch (error) {
          paymentReceipts = { failed: errorText(error) };
        }
      } else if (ownsStripe) {
        stripeImport = { skipped: stripeUnavailable.status === 'failed' ? stripeUnavailable.detail : 'Stripe is not configured' };
        paymentReceipts = { skipped: 'Stripe is not configured' };
      }
      if (ownsTreasury && verified.status === 'ok') {
        try {
          daoTransferImport = await importDaoTransfers(verified.value.confirmed, post);
        } catch (error) {
          daoTransferImport = { failed: errorText(error) };
        }
        try {
          settlementClaimImport = await importSettlementClaims(verified.value.claims.confirmed, post);
        } catch (error) {
          settlementClaimImport = { failed: errorText(error) };
        }
      }

      // 2. Read the sources.
      let stripe: SourceRead<readonly ExternalMovement[]> = ownsStripe ? stripeUnavailable : { status: 'not-configured' };
      if (ownsStripe && stripeLister && config.policy) {
        stripe = await readStripeMovements({ list: stripeLister, policy: config.policy, fromMs: period.fromMs, untilMs: period.untilMs });
      }
      const chain: SourceRead<readonly ExternalMovement[]> = !ownsTreasury
        ? { status: 'not-configured' }
        : verified.status !== 'ok'
          ? verified
          : {
              status: 'ok',
              value: [
                ...verified.value.confirmed
                  .filter((t) => t.createdAtMs >= period.fromMs && t.createdAtMs < period.untilMs)
                  .map((t) => ({ ref: `chain-tx:${t.chainId}:${t.transactionHash}`, netCents: -centsFromMicros(t.amountMicros) })),
                // D-032: a final claim is cash in, dated by its finality.
                ...verified.value.claims.confirmed
                  .filter((c) => c.finalizedAtMs >= period.fromMs && c.finalizedAtMs < period.untilMs)
                  .map((c) => ({ ref: `chain-tx:${c.chainId}:${c.claimTransactionHash}`, netCents: centsFromMicros(c.claimMicros) })),
              ],
            };
      const sources: ReconciliationSources = {
        stripe,
        bank: { status: 'not-configured' },
        chain,
        credits: !ownsTreasury
          ? { status: 'not-configured' }
          : cupboard.status === 'ok'
            ? { status: 'ok', value: { outstandingMicros: cupboard.value.outstandingCreditsMicros } }
            : cupboard,
        dao: !ownsTreasury
          ? { status: 'not-configured' }
          : verified.status === 'ok'
            ? {
                status: 'ok',
                value: {
                  transferredCents: verified.value.confirmed
                    .filter((t) => t.createdAtMs < period.untilMs)
                    .reduce((sum, t) => sum + centsFromMicros(t.amountMicros), 0),
                  chainAccruedCents: settlementDaoAccruedCents(verified.value.claims.confirmed, period.untilMs),
                },
              }
            : verified,
        safe: ownsTreasury ? await readSafe() : { status: 'not-configured' },
      };

      // 3. Reconcile, persist, file or resolve, push the gate.
      const entries = await readEntries(workspaceId);
      const run = await runReconciliation(
        { workspaceId, mode: input.mode, entries, sources, startedAtMs },
        { store, filer, gate: gateFor(treasuryReconciled), now, newRunId: () => `recon-${randomUUID()}` },
      );
      results.push({ workspaceId, stripeImport, daoTransferImport, settlementClaimImport, paymentReceipts, run, error: null });
    } catch (error) {
      results.push({ workspaceId, stripeImport, daoTransferImport, settlementClaimImport, paymentReceipts, run: null, error: errorText(error) });
    }
  }
  return { mode: input.mode, workspaces: results };
}

/** The month (`YYYY-MM`) of each workspace's latest final run. */
export async function latestFinalMonths(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ workspace_id: string; month: string }[]>`
    SELECT workspace_id, max(month) AS month FROM harness_shared.reconciliation_runs WHERE mode = 'final' GROUP BY workspace_id`;
  return new Map(rows.map((r) => [r.workspace_id, r.month]));
}

export interface ScheduledReconciliationResult {
  readonly final: ReconciliationPassResult | null;
  readonly provisional: ReconciliationPassResult;
}

/**
 * The scheduled tick. The month-close (final) run goes first, for every
 * workspace whose closed month has no final run yet, so a tick missed on day 1
 * is made up by the next one; then the hourly provisional run, whose gate push
 * is the latest and so the one in force.
 */
export async function runScheduledReconciliation(
  deps: ReconciliationPassDeps & { readonly finalMonths?: () => Promise<Map<string, string>> } = {},
): Promise<ScheduledReconciliationResult> {
  const now = deps.now ?? Date.now;
  const sql = (): Sql => deps.sql ?? getOrgPg().sql;
  const config = deps.config ?? readReconciliationRuntimeConfig();
  const workspaces = await reconciliationWorkspaces(sql(), [config.stripeJournalWorkspace, config.treasuryWorkspace]);
  const closedMonth = reconciliationPeriod('final', now()).month;
  const finals = await (deps.finalMonths ?? (() => latestFinalMonths(sql())))();
  const due = workspaces.filter((ws) => (finals.get(ws) ?? '') < closedMonth);
  const final = due.length > 0 ? await runReconciliationPass({ mode: 'final', workspaces: due }, { ...deps, config }) : null;
  const provisional = await runReconciliationPass({ mode: 'provisional', workspaces }, { ...deps, config });
  return { final, provisional };
}

/** The cash movement a balance transaction records, or null when the journal deliberately skips it (payouts). */
export function stripeMovementFor(bt: StripeBalanceTransaction, policy: CustomerPaymentPolicy): ExternalMovement | null {
  if (journalVerdictForStripeBalanceTransaction(bt, policy).disposition === 'skip') return null;
  return { ref: `stripe-balance-transaction:${bt.id}`, netCents: bt.amount - bt.fee };
}
