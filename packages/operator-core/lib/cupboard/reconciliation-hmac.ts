/**
 * Request signing between the operator's reconciliation run and the Cupboard
 * Worker (agent-economy-flywheel-2026-08-30 P-043, D-025 §4).
 *
 * The operator pushes the DAO-transfer gate to the Worker and reads the
 * Worker's reconciliation inputs. Both calls are machine-to-machine, so they
 * carry an HMAC over a shared secret (RECONCILIATION_GATE_SECRET on the Worker,
 * PAPERCUSP_RECONCILIATION_GATE_SECRET_REF on the operator) instead of a human
 * GitHub bearer.
 *
 * Header:  x-papercusp-reconciliation-signature: t=<unix ms>,v1=<hex>
 * MAC:     HMAC-SHA256(secret, `${t}\n${METHOD}\n${pathname}\n${body}`)
 *
 * The method and path are signed so a captured signature cannot be replayed
 * against the other route, and the timestamp bounds replay to ±5 minutes.
 * WebCrypto only: this module runs unchanged in Node and in a Worker.
 */

export const RECONCILIATION_SIGNATURE_HEADER = 'x-papercusp-reconciliation-signature';

/** How far a signature's timestamp may sit from the verifier's clock. */
export const RECONCILIATION_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

function signingInput(input: { tMs: number; method: string; pathname: string; body: string }): string {
  return `${input.tMs}\n${input.method.toUpperCase()}\n${input.pathname}\n${input.body}`;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  let hex = '';
  for (const byte of mac) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The header value for one request. */
export async function signReconciliationRequest(input: {
  readonly secret: string;
  readonly method: string;
  readonly pathname: string;
  readonly body: string;
  readonly nowMs: number;
}): Promise<string> {
  if (!input.secret) throw new Error('signReconciliationRequest: empty secret');
  const v1 = await hmacHex(input.secret, signingInput({ tMs: input.nowMs, method: input.method, pathname: input.pathname, body: input.body }));
  return `t=${input.nowMs},v1=${v1}`;
}

export type ReconciliationSignatureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-configured' | 'missing' | 'malformed' | 'stale' | 'mismatch' };

/** Verify a request's signature header. An empty secret refuses everything. */
export async function verifyReconciliationRequest(input: {
  readonly secret: string | undefined;
  readonly header: string | null | undefined;
  readonly method: string;
  readonly pathname: string;
  readonly body: string;
  readonly nowMs: number;
}): Promise<ReconciliationSignatureVerdict> {
  if (!input.secret) return { ok: false, reason: 'not-configured' };
  if (!input.header) return { ok: false, reason: 'missing' };
  const parts = new Map<string, string>();
  for (const piece of input.header.split(',')) {
    const sep = piece.indexOf('=');
    if (sep > 0) parts.set(piece.slice(0, sep).trim(), piece.slice(sep + 1).trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isSafeInteger(t) || t <= 0 || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
  if (Math.abs(input.nowMs - t) > RECONCILIATION_SIGNATURE_TOLERANCE_MS) return { ok: false, reason: 'stale' };
  const expected = await hmacHex(input.secret, signingInput({ tMs: t, method: input.method, pathname: input.pathname, body: input.body }));
  return constantTimeEqual(expected, v1) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

// ---------------------------------------------------------------------------
// The wire shapes both sides agree on.
// ---------------------------------------------------------------------------

export const TRANSFER_GATE_PATH = '/commerce/treasury/transfer-gate';
export const RECONCILIATION_INPUTS_PATH = '/commerce/treasury/reconciliation-inputs';
/**
 * The Worker's chain links for the operator's anchor log (D-027). Paged with
 * `?after=<cursor>&limit=<n>`; this route signs path AND query string, so a
 * captured signature cannot read a different page.
 */
export const LEDGER_CHAIN_LINKS_PATH = '/commerce/ledger-chain/links';

/** P-044 (D-028 §3): the operator's hourly live transparency report (signed PUT). */
export const TRANSPARENCY_LIVE_PATH = '/commerce/transparency/live';
/** P-044 (D-028 §4): a signed monthly statement (signed PUT; immutable once stored). */
export const TRANSPARENCY_STATEMENT_PATH = '/commerce/transparency/statement';
/**
 * P-047 (D-031): an outside accountant's attestation record of a published
 * statement, with its anchored inclusion proof once one exists (signed PUT).
 */
export const TRANSPARENCY_ATTESTATION_PATH = '/commerce/transparency/attestation';

/** A gate older than this pauses transfers: a reconciliation that stopped reporting must not leave them running. */
export const TRANSFER_GATE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

export interface TransferGatePush {
  readonly workspaceId: string;
  readonly open: boolean;
  readonly reasons: readonly string[];
  readonly runId: string;
  /** When the run that produced this gate started (unix ms). */
  readonly atMs: number;
  /**
   * True only when this run read the Worker's credits and DAO transfers and
   * evaluated the treasury invariants. The Worker treats a push without it as a
   * closed gate: a workspace that never looked at the treasury cannot open it.
   */
  readonly treasuryReconciled: boolean;
}

export interface ReconciliationInputsDaoTransfer {
  readonly transferId: string;
  readonly chainId: number;
  readonly transactionHash: string;
  readonly amountMicros: number;
  readonly createdAtMs: number;
}

/**
 * One FINAL settlement batch on the EVM rail (D-032): the claim the chain buried
 * under its required confirmations, and the DAO's allocation of it. Only `final`
 * batches are listed, because a `claimed` batch is not money received yet.
 */
export interface ReconciliationInputsSettlementClaim {
  readonly batchId: string;
  readonly chainId: number;
  readonly claimTransactionHash: string;
  /** The gross amount the claim moved, micro-USD. */
  readonly claimMicros: number;
  /** The DAO's allocation of this batch (settlement_batches.allocations_micros.dao), micro-USD. */
  readonly daoMicros: number;
  readonly finalizedAtMs: number;
}

export interface ReconciliationInputs {
  /** Prepaid credits still owed to customers (available + reserved), micro-USD. */
  readonly outstandingCreditsMicros: number;
  /** Every routed transfer of the `dao` share, oldest first. */
  readonly daoTransfers: readonly ReconciliationInputsDaoTransfer[];
  /** Every FINAL settlement batch, oldest finality first (D-032). */
  readonly finalSettlementBatches: readonly ReconciliationInputsSettlementClaim[];
  readonly generatedAtMs: number;
}

/** Parse a gate push; null when any field is missing or mistyped. */
export function parseTransferGatePush(raw: unknown): TransferGatePush | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.workspaceId !== 'string' || r.workspaceId.length === 0 || r.workspaceId.length > 200) return null;
  if (typeof r.open !== 'boolean') return null;
  if (!Array.isArray(r.reasons) || r.reasons.length > 50 || !r.reasons.every((x) => typeof x === 'string' && x.length <= 2000)) {
    return null;
  }
  if (typeof r.runId !== 'string' || r.runId.length === 0 || r.runId.length > 200) return null;
  if (typeof r.atMs !== 'number' || !Number.isSafeInteger(r.atMs) || r.atMs <= 0) return null;
  if (typeof r.treasuryReconciled !== 'boolean') return null;
  // An open gate with reasons is contradictory; refuse rather than pick a side.
  if (r.open && r.reasons.length > 0) return null;
  return {
    workspaceId: r.workspaceId,
    open: r.open,
    reasons: r.reasons as string[],
    runId: r.runId,
    atMs: r.atMs,
    treasuryReconciled: r.treasuryReconciled,
  };
}

/** Parse the Worker's inputs; throws with the offending field, so a run records `failed`, never a guess. */
export function parseReconciliationInputs(raw: unknown): ReconciliationInputs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('reconciliation inputs: not an object');
  const r = raw as Record<string, unknown>;
  const outstanding = r.outstandingCreditsMicros;
  if (typeof outstanding !== 'number' || !Number.isSafeInteger(outstanding) || outstanding < 0) {
    throw new Error('reconciliation inputs: outstandingCreditsMicros must be a non-negative safe integer');
  }
  if (!Array.isArray(r.daoTransfers)) throw new Error('reconciliation inputs: daoTransfers must be a list');
  const daoTransfers = r.daoTransfers.map((t, i) => {
    const x = (t ?? {}) as Record<string, unknown>;
    const ok =
      typeof x.transferId === 'string' &&
      typeof x.chainId === 'number' && Number.isSafeInteger(x.chainId) && x.chainId > 0 &&
      typeof x.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x.transactionHash) &&
      typeof x.amountMicros === 'number' && Number.isSafeInteger(x.amountMicros) && x.amountMicros > 0 &&
      typeof x.createdAtMs === 'number' && Number.isSafeInteger(x.createdAtMs) && x.createdAtMs > 0;
    if (!ok) throw new Error(`reconciliation inputs: daoTransfers[${i}] is malformed`);
    return {
      transferId: x.transferId as string,
      chainId: x.chainId as number,
      transactionHash: (x.transactionHash as string).toLowerCase(),
      amountMicros: x.amountMicros as number,
      createdAtMs: x.createdAtMs as number,
    };
  });
  // Required, not defaulted: an older Worker that omits the list would otherwise
  // read as "no settlement accrued", which is a guess the invariant then trusts.
  if (!Array.isArray(r.finalSettlementBatches)) throw new Error('reconciliation inputs: finalSettlementBatches must be a list');
  const finalSettlementBatches = r.finalSettlementBatches.map((b, i) => {
    const x = (b ?? {}) as Record<string, unknown>;
    const ok =
      typeof x.batchId === 'string' && x.batchId.length > 0 &&
      typeof x.chainId === 'number' && Number.isSafeInteger(x.chainId) && x.chainId > 0 &&
      typeof x.claimTransactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x.claimTransactionHash) &&
      typeof x.claimMicros === 'number' && Number.isSafeInteger(x.claimMicros) && x.claimMicros > 0 &&
      typeof x.daoMicros === 'number' && Number.isSafeInteger(x.daoMicros) && x.daoMicros >= 0 && x.daoMicros <= x.claimMicros &&
      typeof x.finalizedAtMs === 'number' && Number.isSafeInteger(x.finalizedAtMs) && x.finalizedAtMs > 0;
    if (!ok) throw new Error(`reconciliation inputs: finalSettlementBatches[${i}] is malformed`);
    return {
      batchId: x.batchId as string,
      chainId: x.chainId as number,
      claimTransactionHash: (x.claimTransactionHash as string).toLowerCase(),
      claimMicros: x.claimMicros as number,
      daoMicros: x.daoMicros as number,
      finalizedAtMs: x.finalizedAtMs as number,
    };
  });
  const generatedAtMs = typeof r.generatedAtMs === 'number' && Number.isSafeInteger(r.generatedAtMs) ? r.generatedAtMs : 0;
  return { outstandingCreditsMicros: outstanding, daoTransfers, finalSettlementBatches, generatedAtMs };
}
