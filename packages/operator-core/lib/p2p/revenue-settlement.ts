/** Deterministic, non-custodial DAO revenue settlement arithmetic (P-018). */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';

export type RevenueShare = 'creator' | 'host' | 'component' | 'dao' | 'reserve' | 'tax' | 'operating';
export const REVENUE_SHARES: readonly RevenueShare[] = ['creator', 'host', 'component', 'dao', 'reserve', 'tax', 'operating'] as const;
export type RevenueSplitManifest = { readonly version: string; readonly manifestHash: string; readonly sharesBps: Readonly<Record<RevenueShare, number>> };

export type SettlementRefusalCode = 'invalid-amount' | 'invalid-split' | 'split-overflow' | 'missing-treasury' | 'cost-exceeds-gross';

export function validateRevenueSplit(manifest: RevenueSplitManifest): { ok: true } | { ok: false; code: SettlementRefusalCode; detail: string } {
  if (!manifest.version.trim() || !manifest.manifestHash.trim()) return { ok: false, code: 'invalid-split', detail: 'split version and manifestHash are required' };
  let sum = 0;
  for (const share of REVENUE_SHARES) {
    const bps = manifest.sharesBps[share];
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) return { ok: false, code: 'invalid-split', detail: `${share} share must be an integer basis-point value` };
    sum += bps;
  }
  if (sum > 10_000) return { ok: false, code: 'split-overflow', detail: `revenue split sums to ${sum} bps, above 10000` };
  return { ok: true };
}

/**
 * Derive the canonical `sha256:<64 hex>` manifest hash for a split.
 *
 * The hash is what a per-use offer's terms commit to (`splitManifestHash` on
 * the voucher, verified in `metered-invocation.ts`), so a settlement can only
 * apply a split the payer actually signed for if BOTH sides derive the hash the
 * same way. That is why it is computed here rather than configured alongside
 * the shares: a hand-written hash could disagree with its own body.
 */
export function revenueSplitManifest(input: {
  readonly version: string;
  readonly sharesBps: Readonly<Record<RevenueShare, number>>;
}): RevenueSplitManifest {
  const body: Record<string, unknown> = { version: input.version };
  const shares: Record<string, number> = {};
  for (const share of REVENUE_SHARES) shares[share] = input.sharesBps[share];
  body.sharesBps = shares;
  const digest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return { version: input.version, manifestHash: `sha256:${digest}`, sharesBps: input.sharesBps };
}

export interface SettlementReceipt {
  readonly settlementId: string;
  readonly currency: 'stablecoin-micros';
  readonly grossMicros: bigint;
  readonly providerCostMicros: bigint;
  readonly distributableMicros: bigint;
  readonly allocationsMicros: Readonly<Record<RevenueShare, bigint>>;
  readonly daoTreasury: string;
  readonly splitManifestHash: string;
  readonly receiptHash: string;
}

export type SettlementResult = { readonly ok: true; readonly receipt: SettlementReceipt } | { readonly ok: false; readonly code: SettlementRefusalCode; readonly detail: string };

function serializeBigInts(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeBigInts(v)]));
  return value;
}

function receiptDigest(input: Omit<SettlementReceipt, 'receiptHash'>): string {
  return createHash('sha256').update(canonicalJson(serializeBigInts(input))).digest('hex');
}

/** Compute integer allocations. Any rounding remainder is assigned to the DAO. */
export function settleRevenue(input: {
  settlementId: string;
  grossMicros: bigint;
  providerCostMicros: bigint;
  splitManifest: RevenueSplitManifest;
  daoTreasury: string;
}): SettlementResult {
  if (!input.settlementId.trim() || input.grossMicros < 0n || input.providerCostMicros < 0n) return { ok: false, code: 'invalid-amount', detail: 'settlement id and amounts must be valid' };
  if (!input.daoTreasury.trim()) return { ok: false, code: 'missing-treasury', detail: 'DAO treasury wallet is required for settlement' };
  const split = validateRevenueSplit(input.splitManifest);
  if (!split.ok) return split;
  if (input.providerCostMicros > input.grossMicros) return { ok: false, code: 'cost-exceeds-gross', detail: 'provider cost cannot exceed gross amount' };
  const distributableMicros = input.grossMicros - input.providerCostMicros;
  const allocations = {} as Record<RevenueShare, bigint>;
  let allocated = 0n;
  for (const share of REVENUE_SHARES) {
    const amount = (distributableMicros * BigInt(input.splitManifest.sharesBps[share]!)) / 10_000n;
    allocations[share] = amount;
    allocated += amount;
  }
  allocations.dao += distributableMicros - allocated;
  const base: Omit<SettlementReceipt, 'receiptHash'> = {
    settlementId: input.settlementId,
    currency: 'stablecoin-micros',
    grossMicros: input.grossMicros,
    providerCostMicros: input.providerCostMicros,
    distributableMicros,
    allocationsMicros: allocations,
    daoTreasury: input.daoTreasury,
    splitManifestHash: input.splitManifest.manifestHash,
  };
  return { ok: true, receipt: { ...base, receiptHash: receiptDigest(base) } };
}

export type ReconciliationRefusalCode =
  | 'split-manifest-mismatch'
  | 'distributable-mismatch'
  | 'allocation-mismatch'
  | 'negative-allocation'
  | 'receipt-hash-mismatch'
  | 'invalid-split';

/**
 * What a reconciled settlement authorizes to move (P-034).
 *
 * Only the fields a treasury router is entitled to act on: the shares, the
 * receipt they are bound to, and the manifest hash that binds the receipt to
 * the split the payer signed. Deliberately NOT the whole receipt — a router
 * must not be able to reach a number this function did not re-derive.
 */
export interface SettlementReconciliation {
  readonly settlementId: string;
  readonly receiptHash: string;
  readonly splitManifestHash: string;
  readonly grossMicros: bigint;
  readonly providerCostMicros: bigint;
  readonly distributableMicros: bigint;
  readonly allocationsMicros: Readonly<Record<RevenueShare, bigint>>;
  readonly daoTreasury: string;
}

export type ReconciliationResult =
  | { readonly ok: true; readonly reconciliation: SettlementReconciliation }
  | { readonly ok: false; readonly code: ReconciliationRefusalCode; readonly detail: string };

/**
 * Re-derive a RECORDED settlement receipt from the immutable split manifest
 * (P-034, acceptance line 13).
 *
 * `settleRevenue` computes allocations at claim time; this verifies them again
 * at ROUTING time, against the manifest the deployment holds rather than
 * against whatever the stored row says. The distinction is the whole point: the
 * allocations live in a D1 row (mig 026 `allocations_micros`) between the two
 * moments, so routing money on the strength of that row alone would trust a
 * value nothing re-checked. Every field is recomputed here — the per-share
 * floor, the DAO remainder, the distributable, and the receipt digest — so a
 * single tampered or drifted number refuses instead of moving funds.
 *
 * A tampered allocation set that still SUMS correctly is caught by the
 * per-share check: summing to the right total is not the same as each share
 * being what the manifest says it is, and a router that only checked the sum
 * would happily pay the DAO's share to the host.
 */
export function reconcileSettlement(input: {
  receipt: SettlementReceipt;
  splitManifest: RevenueSplitManifest;
}): ReconciliationResult {
  const { receipt, splitManifest } = input;
  const split = validateRevenueSplit(splitManifest);
  if (!split.ok) return { ok: false, code: 'invalid-split', detail: split.detail };
  if (receipt.splitManifestHash !== splitManifest.manifestHash) {
    return {
      ok: false,
      code: 'split-manifest-mismatch',
      detail: `receipt commits to split ${receipt.splitManifestHash}, deployment holds ${splitManifest.manifestHash}`,
    };
  }
  if (receipt.grossMicros < 0n || receipt.providerCostMicros < 0n || receipt.distributableMicros < 0n) {
    return { ok: false, code: 'negative-allocation', detail: 'receipt amounts must be non-negative' };
  }
  const expectedDistributable = receipt.grossMicros - receipt.providerCostMicros;
  if (expectedDistributable !== receipt.distributableMicros) {
    return {
      ok: false,
      code: 'distributable-mismatch',
      detail: `gross minus provider cost is ${expectedDistributable}, receipt records ${receipt.distributableMicros}`,
    };
  }

  // Recompute the split exactly as settleRevenue does, then compare share by
  // share. Reusing the same arithmetic is intentional: a second, independent
  // formula here would drift from the one that actually allocates.
  const expected = {} as Record<RevenueShare, bigint>;
  let allocated = 0n;
  for (const share of REVENUE_SHARES) {
    const amount = (receipt.distributableMicros * BigInt(splitManifest.sharesBps[share])) / 10_000n;
    expected[share] = amount;
    allocated += amount;
  }
  expected.dao += receipt.distributableMicros - allocated;

  let recordedTotal = 0n;
  for (const share of REVENUE_SHARES) {
    const recorded = receipt.allocationsMicros[share];
    if (typeof recorded !== 'bigint' || recorded < 0n) {
      return { ok: false, code: 'negative-allocation', detail: `${share} allocation is missing or negative` };
    }
    if (recorded !== expected[share]) {
      return {
        ok: false,
        code: 'allocation-mismatch',
        detail: `${share} allocation is ${recorded}, manifest yields ${expected[share]}`,
      };
    }
    recordedTotal += recorded;
  }
  if (recordedTotal !== receipt.distributableMicros) {
    return {
      ok: false,
      code: 'allocation-mismatch',
      detail: `allocations sum to ${recordedTotal}, distributable is ${receipt.distributableMicros}`,
    };
  }

  // The digest last, because it is the cheapest way to catch a field this
  // function does not otherwise re-derive (the settlement id, the treasury
  // address, the currency) having been edited under the row.
  const { receiptHash: _recorded, ...base } = receipt;
  void _recorded;
  const recomputed = receiptDigest(base);
  if (recomputed !== receipt.receiptHash) {
    return {
      ok: false,
      code: 'receipt-hash-mismatch',
      detail: `receipt hash is ${receipt.receiptHash}, recomputes to ${recomputed}`,
    };
  }

  return {
    ok: true,
    reconciliation: {
      settlementId: receipt.settlementId,
      receiptHash: receipt.receiptHash,
      splitManifestHash: receipt.splitManifestHash,
      grossMicros: receipt.grossMicros,
      providerCostMicros: receipt.providerCostMicros,
      distributableMicros: receipt.distributableMicros,
      allocationsMicros: receipt.allocationsMicros,
      daoTreasury: receipt.daoTreasury,
    },
  };
}
