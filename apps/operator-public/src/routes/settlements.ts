/**
 * Authenticated production door for P-033 batch settlement execution.
 *
 * The route binds the P-021 voucher batch machine, the P-018 revenue split, and
 * the P-022 EVM request builder to a self-hosted facilitator that actually
 * submits the claim on the pilot L2. GitHub bearer identity selects the channel;
 * callers cannot provide a principal, signer, contract, chain, token address,
 * split, or treasury — every one of those comes from the deployment.
 *
 * ACCEPTANCE LINE 14 runs through the whole file: `POST .../settlements` returns
 * a CLAIM (`final: false`), and only `POST .../settlements/:batchId/finality`
 * can promote it to `final` after observing the required confirmation depth —
 * or discover a reorg and unwind it so the vouchers become claimable again.
 */
import { Hono } from 'hono';
import {
  assessClaimFinality,
  buildSettlementProofEvent,
  isSettlementFrozen,
  planBatchSettlement,
  unwindReorgedClaim,
  type BatchSettlementPlan,
  type EvmSettlementConfig,
  type EvmSettlementFacilitator,
} from '@papercusp/operator-core/lib/p2p/evm-settlement.ts';
import {
  commerceEventSigningBytes,
  type CommerceEvent,
} from '@papercusp/operator-core/lib/p2p/commerce-events.ts';
import type { CumulativePaymentVoucher } from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import {
  REVENUE_SHARES,
  revenueSplitManifest,
  type RevenueShare,
  type RevenueSplitManifest,
} from '@papercusp/operator-core/lib/p2p/revenue-settlement.ts';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import { getPaymentChannel } from '../payment-channel-store.ts';
import { listChannelUsageReceipts, type StoredUsageReceipt } from '../usage-receipt-store.ts';
import { createViemSettlementFacilitator } from '../settlement-facilitator.ts';
import {
  appendCommerceEvent,
  nextCommerceEventSequence,
} from '../commerce-event-log-store.ts';
import {
  claimedUsageNonces,
  getSettlementBatch,
  getLiveSettlementBatchByRequestHash,
  settlementClaimAttempts,
  listChannelSettlementBatches,
  markSettlementDisputed,
  markSettlementDisputeDismissed,
  markSettlementFinal,
  markSettlementRefunded,
  paymentChannelStateFromBatches,
  recordSettlementClaim,
  recordSettlementConfirmations,
  unwindReorgedBatch,
  type StoredSettlementBatch,
} from '../settlement-batch-store.ts';

/** Largest voucher batch a single claim may carry on the pilot rail. */
const MAX_BATCH_SIZE = 200;

function principalId(user: { id: number }): string {
  return `gh:${user.id}`;
}

async function authenticate(
  request: Request,
): Promise<{ ok: true; principalId: string } | { ok: false; reason: AuthError['reason'] }> {
  try {
    return { ok: true, principalId: principalId(await resolveGithubBearer(request)) };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, reason: error.reason };
    throw error;
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

export type SplitConfigResult =
  | { readonly ok: true; readonly manifest: RevenueSplitManifest; readonly daoTreasury: string }
  | { readonly ok: false; readonly code: 'not-configured' | 'invalid-config'; readonly detail: string };

/**
 * Resolve the deployment's revenue split and treasury.
 *
 * The manifest HASH is derived from the shares, never configured beside them —
 * a hand-written hash could disagree with its own body, and that hash is what
 * the payer signed into every voucher.
 */
export function resolveSplitConfig(env: Env): SplitConfigResult {
  const raw = typeof env.REVENUE_SPLIT_MANIFEST === 'string' ? env.REVENUE_SPLIT_MANIFEST.trim() : '';
  const daoTreasury =
    typeof env.DAO_TREASURY_ADDRESS === 'string' ? env.DAO_TREASURY_ADDRESS.trim() : '';
  const missing = [raw ? null : 'REVENUE_SPLIT_MANIFEST', daoTreasury ? null : 'DAO_TREASURY_ADDRESS'].filter(
    (name): name is string => name !== null,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'not-configured',
      detail: `settlement accounting is unavailable; missing ${missing.join(', ')}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid-config', detail: 'REVENUE_SPLIT_MANIFEST is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid-config', detail: 'REVENUE_SPLIT_MANIFEST must be a JSON object' };
  }
  const source = parsed as { version?: unknown; sharesBps?: unknown };
  if (typeof source.version !== 'string' || !source.version.trim()) {
    return { ok: false, code: 'invalid-config', detail: 'REVENUE_SPLIT_MANIFEST needs a non-empty version' };
  }
  if (!source.sharesBps || typeof source.sharesBps !== 'object' || Array.isArray(source.sharesBps)) {
    return { ok: false, code: 'invalid-config', detail: 'REVENUE_SPLIT_MANIFEST needs a sharesBps object' };
  }
  const shareSource = source.sharesBps as Record<string, unknown>;
  const sharesBps = {} as Record<RevenueShare, number>;
  for (const share of REVENUE_SHARES) {
    const value = shareSource[share] ?? 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
      return {
        ok: false,
        code: 'invalid-config',
        detail: `REVENUE_SPLIT_MANIFEST share '${share}' must be an integer basis-point value`,
      };
    }
    sharesBps[share] = value;
  }
  return {
    ok: true,
    manifest: revenueSplitManifest({ version: source.version, sharesBps }),
    daoTreasury,
  };
}

/**
 * Rebuild the exact voucher the payer signed from its durable receipt row.
 *
 * Every field that goes into `paymentVoucherSigningBytes` is stored (mig 025),
 * so the digest is re-derived from the record rather than trusted from a
 * client-supplied value.
 */
function voucherFromReceipt(receipt: StoredUsageReceipt): CumulativePaymentVoucher {
  return {
    channelId: receipt.channelId,
    payer: receipt.payer,
    seller: receipt.seller,
    releaseRef: receipt.releaseRef,
    usageNonce: receipt.usageNonce,
    meterQuantity: BigInt(receipt.meterQuantity),
    pricePerUnitMicros: BigInt(receipt.unitPriceMicros),
    priceVersion: receipt.priceVersion,
    splitManifestHash: receipt.splitManifestHash,
    expiresAtMs: receipt.expiresAtMs,
    cumulativeClaimMicros: BigInt(receipt.cumulativeClaimMicros),
    signature: receipt.voucherSignature,
  };
}

function batchJson(batch: StoredSettlementBatch) {
  return {
    batchId: batch.batchId,
    channelId: batch.channelId,
    requestHash: batch.requestHash,
    chainId: batch.chainId,
    claimMicros: batch.claimMicros,
    cumulativeClaimMicros: batch.cumulativeClaimMicros,
    voucherDigests: [...batch.voucherDigests],
    settlementId: batch.settlementId,
    splitManifestHash: batch.splitManifestHash,
    allocationsMicros: batch.allocationsMicros,
    providerCostMicros: batch.providerCostMicros,
    distributableMicros: batch.distributableMicros,
    daoTreasury: batch.daoTreasury,
    receiptHash: batch.receiptHash,
    state: batch.state,
    // Acceptance line 14: a claim is reported as a claim.
    final: batch.state === 'final',
    confirmations: batch.confirmations,
    requiredConfirmations: batch.requiredConfirmations,
    claimTransactionHash: batch.claimReceipt.transactionHash,
    claimBlockNumber: batch.claimReceipt.blockNumber.toString(),
    claimBlockHash: batch.claimReceipt.blockHash,
    refundTransactionHash: batch.refundTransactionHash,
    freezeReason: batch.freezeReason,
    createdAtMs: batch.createdAtMs,
    updatedAtMs: batch.updatedAtMs,
    finalizedAtMs: batch.finalizedAtMs,
  };
}

function facilitatorFor(env: Env, injected: EvmSettlementFacilitator | undefined) {
  return injected ? { ok: true as const, facilitator: injected } : createViemSettlementFacilitator(env);
}

/**
 * Append a signed `settlement-proof` to the P-016 log.
 *
 * A sequence collision is retried once against a freshly read watermark: two
 * concurrent proofs on the same channel stream is an ordinary race, not a
 * failure of the settlement itself. The claim is already on chain by this
 * point, so a proof that cannot be recorded is reported to the caller rather
 * than swallowed.
 */
async function recordSettlementProof(
  db: D1Database,
  facilitator: EvmSettlementFacilitator,
  input: {
    readonly streamId: string;
    readonly plan: BatchSettlementPlan;
    readonly finality: 'claimed' | 'final';
    readonly confirmations: number;
    readonly transaction: StoredSettlementBatch['claimReceipt'];
    readonly nowMs: number;
  },
): Promise<{ ok: true; event: CommerceEvent } | { ok: false; detail: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sequence = await nextCommerceEventSequence(db, input.streamId);
    const unsigned = buildSettlementProofEvent({
      streamId: input.streamId,
      issuer: facilitator.signerAddress,
      sequence,
      occurredAtMs: input.nowMs,
      plan: input.plan,
      finality: input.finality,
      confirmations: input.confirmations,
      chainId: facilitator.chainId,
      transaction: input.transaction,
    });
    const signature = await facilitator.signSettlementProof(commerceEventSigningBytes(unsigned));
    const event: CommerceEvent = { ...unsigned, signature };
    const appended = await appendCommerceEvent(db, event, input.nowMs);
    if (appended.ok) return { ok: true, event: appended.event.event };
    if (appended.code !== 'sequence-conflict') return { ok: false, detail: appended.detail };
  }
  return { ok: false, detail: 'settlement proof could not be sequenced onto the commerce event log' };
}

function settlementStream(channelId: string): string {
  return `settlement:${channelId}`;
}

export function settlementsRoute(
  options: { facilitator?: EvmSettlementFacilitator } = {},
): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  route.post('/commerce/payment-channels/:channelId/settlements', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    if (!validId(channelId)) return c.json({ error: 'invalid_request' }, 400);

    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const facilitator = availability.facilitator;
    const split = resolveSplitConfig(c.env);
    if (!split.ok) return c.json({ error: split.code, detail: split.detail }, 503);

    const channel = await getPaymentChannel(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: 'channel_not_found' }, 404);
    }
    if (channel.state !== 'open') return c.json({ error: `channel_${channel.state}` }, 409);

    const batches = await listChannelSettlementBatches(c.env.DB, channelId);
    const freeze = isSettlementFrozen(batches);
    if (freeze.frozen) {
      return c.json({ error: 'settlement_frozen', reason: freeze.reason, detail: freeze.detail }, 409);
    }

    const consumed = await claimedUsageNonces(c.env.DB, channelId);
    const pending = (await listChannelUsageReceipts(c.env.DB, channelId))
      .filter((receipt) => receipt.state === 'settled' && !consumed.has(receipt.usageNonce))
      .slice()
      .sort((a, b) => a.cumulativeClaimMicros - b.cumulativeClaimMicros)
      .slice(0, MAX_BATCH_SIZE);
    if (pending.length === 0) return c.json({ error: 'no_settled_usage' }, 409);

    // The split the payer signed into the voucher governs. A deployment whose
    // configured split has moved on cannot retroactively re-cut a buyer's
    // purchase, so the mismatch is a refusal, not a re-computation.
    const mismatched = pending.find((receipt) => receipt.splitManifestHash !== split.manifest.manifestHash);
    if (mismatched) {
      return c.json(
        {
          error: 'split_manifest_mismatch',
          detail: `usage receipt '${mismatched.usageNonce}' was signed against split ${mismatched.splitManifestHash}, but this deployment settles ${split.manifest.manifestHash}`,
        },
        409,
      );
    }

    const config: EvmSettlementConfig = {
      chainId: facilitator.chainId,
      settlementContract: facilitator.settlementContract,
      stablecoin: facilitator.stablecoin,
      maxBatchSize: MAX_BATCH_SIZE,
    };
    const nowMs = Date.now();
    const planned = planBatchSettlement({
      config,
      channel: paymentChannelStateFromBatches({
        channelId,
        escrowMicros: channel.escrowMicros,
        batches,
      }),
      vouchers: pending.map(voucherFromReceipt),
      nowMs,
      settlementId: `settlement:${channelId}:${pending[pending.length - 1]!.cumulativeClaimMicros}`,
      splitManifest: split.manifest,
      daoTreasury: split.daoTreasury,
    });
    if (!planned.ok) {
      const status = planned.code === 'escrow-exhausted' || planned.code === 'duplicate-claim' ? 409 : 422;
      return c.json({ error: planned.code, detail: planned.detail }, status);
    }

    // Only a LIVE batch is a replay. A reorged or refunded one is void, and the
    // re-claim of its released vouchers reproduces the same request hash.
    const existing = await getLiveSettlementBatchByRequestHash(
      c.env.DB,
      channelId,
      planned.plan.request.requestHash,
    );
    if (existing) return c.json({ replayed: true, batch: batchJson(existing) }, 200);
    const attempt = await settlementClaimAttempts(c.env.DB, channelId, planned.plan.request.requestHash);

    let receipt;
    try {
      receipt = await facilitator.submitBatchClaim(planned.plan.request);
    } catch (error) {
      return c.json(
        { error: 'rail_claim_failed', detail: error instanceof Error ? error.message : String(error) },
        502,
      );
    }

    const recorded = await recordSettlementClaim(c.env.DB, {
      // The attempt ordinal keeps a post-reorg re-claim of the same voucher set
      // a DISTINCT row, so the void batch and its replacement both stay
      // auditable instead of one overwriting the other.
      batchId: `batch:${channelId}:${planned.plan.request.requestHash.slice(0, 32)}:${attempt}`,
      channelId,
      principalId: auth.principalId,
      plan: planned.plan,
      receipt,
      requiredConfirmations: facilitator.requiredConfirmations,
      // The block a transaction is mined into is its first confirmation. It is
      // still only a CLAIM: `final` requires the configured depth.
      confirmations: 1,
      usageNonces: pending.map((entry) => entry.usageNonce),
      nowMs,
    });
    if (!recorded.ok) {
      return c.json({ error: 'voucher_already_claimed', detail: recorded.detail }, 409);
    }

    const proof = await recordSettlementProof(c.env.DB, facilitator, {
      streamId: settlementStream(channelId),
      plan: planned.plan,
      finality: 'claimed',
      confirmations: recorded.batch.confirmations,
      transaction: recorded.batch.claimReceipt,
      nowMs,
    });
    if (!proof.ok) {
      return c.json(
        { error: 'settlement_proof_unrecorded', detail: proof.detail, batch: batchJson(recorded.batch) },
        500,
      );
    }

    return c.json(
      { replayed: !recorded.created, batch: batchJson(recorded.batch), proofEventId: proof.event.eventId },
      recorded.created ? 201 : 200,
    );
  });

  route.get('/commerce/payment-channels/:channelId/settlements', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    if (!validId(channelId)) return c.json({ error: 'invalid_request' }, 400);
    const channel = await getPaymentChannel(c.env.DB, channelId);
    if (!channel || channel.principalId !== auth.principalId) {
      return c.json({ error: 'channel_not_found' }, 404);
    }
    const batches = await listChannelSettlementBatches(c.env.DB, channelId);
    return c.json({
      batches: batches.map(batchJson),
      freeze: isSettlementFrozen(batches),
    });
  });

  /**
   * Re-observe a claim against the chain.
   *
   * This is the ONLY transition that can report finality, and it is also the
   * only place a reorg is detected. Both readings come from one observation, so
   * a caller cannot get "final" from one endpoint while another still holds a
   * dropped transaction.
   */
  route.post('/commerce/payment-channels/:channelId/settlements/:batchId/finality', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    const batchId = c.req.param('batchId');
    if (!validId(channelId)) return c.json({ error: 'invalid_request' }, 400);

    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const facilitator = availability.facilitator;

    const batch = await getSettlementBatch(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: 'batch_not_found' }, 404);
    }
    if (batch.state === 'final') {
      return c.json({ verdict: { state: 'final', final: true, confirmations: batch.confirmations }, batch: batchJson(batch) }, 200);
    }
    if (batch.state !== 'claimed') return c.json({ error: `batch_${batch.state}` }, 409);

    let observation;
    try {
      observation = await facilitator.observeTransaction(batch.claimReceipt.transactionHash);
    } catch (error) {
      return c.json(
        { error: 'rail_observation_failed', detail: error instanceof Error ? error.message : String(error) },
        502,
      );
    }

    const verdict = assessClaimFinality({
      claim: batch.claimReceipt,
      observation,
      requiredConfirmations: batch.requiredConfirmations,
    });
    const nowMs = Date.now();

    if (verdict.state === 'reorged') {
      const channel = await getPaymentChannel(c.env.DB, channelId);
      if (!channel) return c.json({ error: 'channel_not_found' }, 404);
      // Prove the unwind is arithmetically sound against the live channel
      // BEFORE mutating anything: a mismatch means our view of the channel and
      // this batch disagree, and guessing there would strand vouchers.
      const unwound = unwindReorgedClaim({
        channel: paymentChannelStateFromBatches({
          channelId,
          escrowMicros: channel.escrowMicros,
          batches: await listChannelSettlementBatches(c.env.DB, channelId),
        }),
        claimMicros: BigInt(batch.claimMicros),
        voucherDigests: batch.voucherDigests,
        priorCumulativeMicros: BigInt(batch.priorCumulativeMicros),
      });
      if (!unwound.ok) {
        const frozen = await unwindReorgedBatch(c.env.DB, batchId, `reorg-${verdict.reason}`, nowMs);
        return c.json(
          { error: 'reorg_unwind_failed', detail: unwound.detail, verdict, batch: batchJson(frozen) },
          500,
        );
      }
      const recovered = await unwindReorgedBatch(c.env.DB, batchId, `reorg-${verdict.reason}`, nowMs);
      return c.json({ verdict, recovered: recovered.recovered, batch: batchJson(recovered) }, 200);
    }

    if (verdict.state === 'final') {
      const finalized = await markSettlementFinal(c.env.DB, batchId, verdict.confirmations, nowMs);
      const proof = await recordSettlementProof(c.env.DB, facilitator, {
        streamId: settlementStream(channelId),
        plan: planFromBatch(finalized),
        finality: 'final',
        confirmations: verdict.confirmations,
        transaction: finalized.claimReceipt,
        nowMs,
      });
      if (!proof.ok) {
        return c.json(
          { error: 'settlement_proof_unrecorded', detail: proof.detail, verdict, batch: batchJson(finalized) },
          500,
        );
      }
      return c.json({ verdict, batch: batchJson(finalized), proofEventId: proof.event.eventId }, 200);
    }

    const updated = await recordSettlementConfirmations(c.env.DB, batchId, verdict.confirmations, nowMs);
    return c.json({ verdict, batch: batchJson(updated) }, 200);
  });

  /**
   * Open or resolve a dispute.
   *
   * Opening freezes the channel: no further batch may claim while the ordering
   * of an existing one is contested. Resolving either dismisses the dispute
   * (the claim stands) or refunds it on chain, which — exactly like a reorg —
   * releases the vouchers so they can be claimed again.
   */
  route.post('/commerce/payment-channels/:channelId/settlements/:batchId/dispute', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    const batchId = c.req.param('batchId');
    const body = await jsonObject(c.req.raw);
    const action = body?.action;
    const outcome = body?.outcome;
    if (
      !validId(channelId) ||
      (action !== 'open' && action !== 'resolve') ||
      (action === 'resolve' && outcome !== 'refund' && outcome !== 'dismiss')
    ) {
      return c.json(
        {
          error: 'invalid_request',
          detail: "action must be 'open' or 'resolve'; resolve requires outcome 'refund' or 'dismiss'",
        },
        400,
      );
    }

    const batch = await getSettlementBatch(c.env.DB, batchId);
    if (!batch || batch.channelId !== channelId || batch.principalId !== auth.principalId) {
      return c.json({ error: 'batch_not_found' }, 404);
    }
    const nowMs = Date.now();

    if (action === 'open') {
      if (batch.state !== 'claimed' && batch.state !== 'final') {
        return c.json({ error: `batch_${batch.state}` }, 409);
      }
      const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : 'disputed';
      const disputed = await markSettlementDisputed(c.env.DB, batchId, reason, nowMs);
      return c.json({ batch: batchJson(disputed) }, 200);
    }

    if (batch.state !== 'disputed') return c.json({ error: `batch_${batch.state}` }, 409);
    if (outcome === 'dismiss') {
      const dismissed = await markSettlementDisputeDismissed(c.env.DB, batchId, nowMs);
      return c.json({ batch: batchJson(dismissed) }, 200);
    }

    const availability = facilitatorFor(c.env, options.facilitator);
    if (!availability.ok) return c.json({ error: availability.code, detail: availability.detail }, 503);
    const channel = await getPaymentChannel(c.env.DB, channelId);
    if (!channel) return c.json({ error: 'channel_not_found' }, 404);
    const refundAddress =
      channel.fundingSource.kind === 'bound-wallet'
        ? channel.fundingSource.walletAddress
        : availability.facilitator.signerAddress;

    let refund;
    try {
      refund = await availability.facilitator.submitRefund({
        channelId,
        amountMicros: BigInt(batch.claimMicros),
        refundAddress,
      });
    } catch (error) {
      return c.json(
        { error: 'rail_refund_failed', detail: error instanceof Error ? error.message : String(error) },
        502,
      );
    }
    const refunded = await markSettlementRefunded(c.env.DB, batchId, refund, nowMs);
    return c.json({ batch: batchJson(refunded) }, 200);
  });

  return route;
}

/**
 * Rebuild the plan shape a settlement proof needs from the stored batch.
 *
 * The finality proof restates the SAME claim the batch already recorded, so it
 * is reconstructed from the durable row rather than re-planned: re-running
 * `planBatchSettlement` here would re-read vouchers whose state has since moved
 * and could produce a different request hash for the same on-chain claim.
 */
function planFromBatch(batch: StoredSettlementBatch): BatchSettlementPlan {
  const allocationsMicros = {} as Record<RevenueShare, bigint>;
  for (const share of REVENUE_SHARES) {
    allocationsMicros[share] = BigInt(batch.allocationsMicros[share]);
  }
  const channel = {
    channelId: batch.channelId,
    rail: 'evm-x402' as const,
    escrowMicros: 0n,
    settledMicros: BigInt(batch.claimMicros),
    lastCumulativeMicros: BigInt(batch.cumulativeClaimMicros),
    claimedVoucherDigests: batch.voucherDigests,
  };
  return {
    channel,
    priorChannel: { ...channel, settledMicros: 0n, lastCumulativeMicros: BigInt(batch.priorCumulativeMicros), claimedVoucherDigests: [] },
    claimMicros: BigInt(batch.claimMicros),
    cumulativeClaimMicros: BigInt(batch.cumulativeClaimMicros),
    voucherDigests: batch.voucherDigests,
    request: {
      chainId: batch.chainId,
      to: batch.settlementContractAddress,
      stablecoin: batch.stablecoinAddress,
      channelId: batch.channelId,
      amountMicros: BigInt(batch.claimMicros),
      voucherDigests: batch.voucherDigests,
      calldata: '0x',
      requestHash: batch.requestHash,
    },
    receipt: {
      settlementId: batch.settlementId,
      currency: 'stablecoin-micros',
      grossMicros: BigInt(batch.claimMicros),
      providerCostMicros: BigInt(batch.providerCostMicros),
      distributableMicros: BigInt(batch.distributableMicros),
      allocationsMicros,
      daoTreasury: batch.daoTreasury,
      splitManifestHash: batch.splitManifestHash,
      receiptHash: batch.receiptHash,
    },
  };
}
