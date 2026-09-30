/**
 * Hosted production door for the P-031 metering interception.
 *
 * Every billable unit of a per-use Cupboard item passes through here TWICE:
 * once to RESERVE the payer's cumulative voucher before the seller executes it,
 * once to SETTLE the units actually served into a signed usage receipt. The
 * decision itself is `p2p/metered-invocation.ts` (pure); this route supplies
 * identity, the ledger's declared terms, and the durable channel state, then
 * persists the outcome.
 *
 * D-055: commerce facts in v1 live behind this Worker plus the chain, so the
 * signed voucher and the signed receipt are STORED here — the Worker holds no
 * signing key and can therefore store these facts without being able to forge
 * them.
 *
 * Fail closed on identity: the buyer that funded the channel is the only party
 * that can reserve against it, and the seller named on the reservation is the
 * only party that can settle it. Neither is taken from the request body.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  acceptMeteredVoucher,
  closeMeteredInvocation,
  declareMeter,
  type BillableUnit,
  type MeteredRefusalCode,
} from '@papercusp/operator-core/lib/p2p/metered-invocation.ts';
import type { CumulativePaymentVoucher } from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import { paymentVoucherDigest, unsignedVoucher } from '@papercusp/operator-core/lib/p2p/microcharge.ts';
import type { Env } from '../env.ts';
import { AuthError, resolveGithubBearer } from '../auth.ts';
import { getCommerceOffer } from '../commerce-store.ts';
import { getPaymentChannel } from '../payment-channel-store.ts';
import {
  getUsageReceipt,
  listChannelUsageReceipts,
  loadMicrochargeChannel,
  reserveUsageReceipt,
  settleUsageReceipt,
  type StoredUsageReceipt,
} from '../usage-receipt-store.ts';

/**
 * Hono owns this type; deriving it from the router's own overloads resolved to
 * `never` and made every refusal status below unassignable.
 */
type RefusalStatusCode = Extract<ContentfulStatusCode, 400 | 401 | 402 | 403 | 404 | 409 | 422>;

async function authenticate(
  request: Request,
): Promise<{ ok: true; principalId: string } | { ok: false; reason: AuthError['reason'] }> {
  try {
    const user = await resolveGithubBearer(request);
    return { ok: true, principalId: `gh:${user.id}` };
  } catch (error) {
    if (error instanceof AuthError) return { ok: false, reason: error.reason };
    throw error;
  }
}

async function jsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Map an interception refusal to a status.
 *
 * `cap-exhausted` is 402 rather than 409 on purpose: it is the one refusal a
 * buyer clears by funding the channel, not by retrying differently.
 */
function statusFor(code: MeteredRefusalCode): RefusalStatusCode {
  if (code === 'cap-exhausted') return 402;
  if (code === 'duplicate-nonce' || code === 'cumulative-regression') return 409;
  return 422;
}

/** Amounts cross the JSON boundary as decimal STRINGS: micros can exceed 2^53. */
function bigintFrom(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Rebuild the exact voucher the payer signed from its persisted reservation.
 *
 * `expiresAtMs` is read back from the row rather than substituted, because it is
 * one of the canonical fields `paymentVoucherDigest` hashes: fabricate it here
 * and the settled receipt binds to a voucher the payer never signed, while still
 * looking perfectly well-formed. Expiry is not re-checked at settlement — the
 * unit was already admitted — so the stored value is used for the DIGEST, not as
 * a second deadline.
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

function receiptJson(receipt: StoredUsageReceipt) {
  return {
    channelId: receipt.channelId,
    usageNonce: receipt.usageNonce,
    offerId: receipt.offerId,
    payer: receipt.payer,
    seller: receipt.seller,
    releaseRef: receipt.releaseRef,
    meterUnit: receipt.meterUnit,
    meterQuantity: String(receipt.meterQuantity),
    unitPriceMicros: String(receipt.unitPriceMicros),
    priceVersion: receipt.priceVersion,
    splitManifestHash: receipt.splitManifestHash,
    reservedMicros: String(receipt.reservedMicros),
    amountMicros: receipt.amountMicros == null ? null : String(receipt.amountMicros),
    cumulativeClaimMicros: String(receipt.cumulativeClaimMicros),
    // Both are exposed so the SELLER can re-derive the exact bytes the payer
    // signed and settle against them. The voucher signature is the payer's
    // payment instrument, not a secret: a seller that cannot present it cannot
    // claim the money. The read is already restricted to the funding principal
    // and the sellers named on the channel's own receipts.
    expiresAtMs: receipt.expiresAtMs,
    voucherDigest: receipt.voucherDigest,
    voucherSignature: receipt.voucherSignature,
    receiptSignature: receipt.receiptSignature,
    state: receipt.state,
    reservedAtMs: receipt.reservedAtMs,
    settledAtMs: receipt.settledAtMs,
  };
}

export function meteredUsageRoute(): Hono<{ Bindings: Env }> {
  const route = new Hono<{ Bindings: Env }>();

  // ── RESERVE, before the seller executes the unit ─────────────────────────
  route.post('/commerce/metered-invocations', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const body = await jsonObject(c.req.raw);
    const wire = body?.voucher;
    if (!body || !nonEmpty(body.channelId) || !nonEmpty(body.offerId) || !wire || typeof wire !== 'object' || Array.isArray(wire)) {
      return c.json({ error: 'invalid_request', detail: 'channelId, offerId and a signed voucher object are required' }, 400);
    }
    const v = wire as Record<string, unknown>;
    const meterQuantity = bigintFrom(v.meterQuantity);
    const pricePerUnitMicros = bigintFrom(v.pricePerUnitMicros);
    const cumulativeClaimMicros = bigintFrom(v.cumulativeClaimMicros);
    if (
      !nonEmpty(v.payer) ||
      !nonEmpty(v.seller) ||
      !nonEmpty(v.releaseRef) ||
      !nonEmpty(v.usageNonce) ||
      !nonEmpty(v.priceVersion) ||
      !nonEmpty(v.splitManifestHash) ||
      !nonEmpty(v.signature) ||
      meterQuantity == null ||
      pricePerUnitMicros == null ||
      cumulativeClaimMicros == null ||
      !Number.isSafeInteger(v.expiresAtMs)
    ) {
      return c.json(
        {
          error: 'invalid_voucher',
          detail:
            'the voucher must carry payer, seller, releaseRef, usageNonce, meterQuantity, pricePerUnitMicros, priceVersion, splitManifestHash, expiresAtMs, cumulativeClaimMicros and signature',
        },
        400,
      );
    }

    const channel = await getPaymentChannel(c.env.DB, body.channelId);
    if (!channel) return c.json({ error: 'unknown_channel', detail: `payment channel ${body.channelId} does not exist` }, 404);
    // The escrow funder is the payer. Reading it from the row rather than the
    // body is what stops one buyer metering against another's escrow.
    if (channel.principalId !== auth.principalId) {
      return c.json({ error: 'forbidden', detail: 'only the funding principal can meter against this channel' }, 403);
    }
    if (channel.state !== 'open') {
      return c.json({ error: 'channel_not_open', detail: `payment channel is '${channel.state}'` }, 409);
    }

    const offer = await getCommerceOffer(c.env.DB, body.offerId);
    if (!offer) return c.json({ error: 'unknown_offer', detail: `offer ${body.offerId} is not in the catalog` }, 404);
    if (!offer.active || !offer.productActive) return c.json({ error: 'inactive_offer', detail: `offer ${body.offerId} is inactive` }, 422);
    if (offer.pricingModel !== 'per-use' || !offer.perUse) {
      return c.json({ error: 'not_metered', detail: `offer ${body.offerId} is not a per-use offer` }, 422);
    }
    const declared = declareMeter(offer.perUse);
    if (!declared.ok) return c.json({ error: declared.code, detail: declared.detail }, 422);

    const unit: BillableUnit = {
      payer: channel.principalId,
      seller: offer.creatorId,
      releaseRef: offer.skuRef,
      usageNonce: v.usageNonce,
      quantity: meterQuantity,
      expiresAtMs: Number(v.expiresAtMs),
    };
    const voucher: CumulativePaymentVoucher = {
      channelId: body.channelId,
      payer: v.payer,
      seller: v.seller,
      releaseRef: v.releaseRef,
      usageNonce: v.usageNonce,
      meterQuantity,
      pricePerUnitMicros,
      priceVersion: v.priceVersion,
      splitManifestHash: v.splitManifestHash,
      expiresAtMs: Number(v.expiresAtMs),
      cumulativeClaimMicros,
      signature: v.signature,
    };

    const durable = await loadMicrochargeChannel(c.env.DB, channel);
    const accepted = acceptMeteredVoucher({
      channel: durable,
      meter: declared.meter,
      unit,
      voucher,
      nowMs: Date.now(),
    });
    if (!accepted.ok) return c.json({ error: accepted.code, detail: accepted.detail }, statusFor(accepted.code));

    const stored = await reserveUsageReceipt(c.env.DB, {
      channelId: channel.channelId,
      usageNonce: voucher.usageNonce,
      principalId: auth.principalId,
      offerId: offer.offerId,
      payer: voucher.payer,
      seller: voucher.seller,
      releaseRef: voucher.releaseRef,
      meterUnit: declared.meter.meterUnit,
      meterQuantity: voucher.meterQuantity,
      unitPriceMicros: voucher.pricePerUnitMicros,
      priceVersion: voucher.priceVersion,
      splitManifestHash: voucher.splitManifestHash,
      reservedMicros: accepted.reservedMicros,
      cumulativeClaimMicros: voucher.cumulativeClaimMicros,
      expiresAtMs: voucher.expiresAtMs,
      voucherDigest: paymentVoucherDigest(unsignedVoucher(voucher)),
      voucherSignature: voucher.signature,
      nowMs: Date.now(),
    });
    if (!stored.ok) {
      return c.json({ error: 'duplicate-nonce', detail: `usage nonce '${voucher.usageNonce}' was already observed` }, 409);
    }
    return c.json({ reserved: true, receipt: receiptJson(stored.receipt) }, 201);
  });

  // ── SETTLE, after the seller executed the unit ───────────────────────────
  route.post('/commerce/metered-invocations/:usageNonce/settle', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);

    const usageNonce = c.req.param('usageNonce');
    const body = await jsonObject(c.req.raw);
    if (!body || !nonEmpty(body.channelId) || !nonEmpty(body.receiptSignature)) {
      return c.json({ error: 'invalid_request', detail: 'channelId and receiptSignature are required' }, 400);
    }
    const actualQuantity = body.actualQuantity === undefined ? null : bigintFrom(body.actualQuantity);
    if (body.actualQuantity !== undefined && actualQuantity == null) {
      return c.json({ error: 'invalid_request', detail: 'actualQuantity must be an integer' }, 400);
    }

    const reserved = await getUsageReceipt(c.env.DB, body.channelId, usageNonce);
    if (!reserved) {
      return c.json({ error: 'unknown-reservation', detail: `no reservation for usage nonce '${usageNonce}'` }, 404);
    }
    // The SELLER reports what it served and signs the receipt for it. A buyer
    // cannot settle its own usage, and a third party cannot settle at all.
    if (reserved.seller !== auth.principalId) {
      return c.json({ error: 'forbidden', detail: 'only the seller named on the reservation can settle it' }, 403);
    }
    if (reserved.state === 'settled') {
      return c.json({ error: 'already-settled', detail: `usage nonce '${usageNonce}' was already settled` }, 409);
    }

    const channel = await getPaymentChannel(c.env.DB, body.channelId);
    if (!channel) return c.json({ error: 'unknown_channel', detail: `payment channel ${body.channelId} does not exist` }, 404);

    const durable = await loadMicrochargeChannel(c.env.DB, channel);
    const occurredAtMs = Date.now();
    const closed = closeMeteredInvocation({
      channel: durable,
      voucher: voucherFromReceipt(reserved),
      ...(actualQuantity != null ? { actualQuantity } : {}),
      occurredAtMs,
      signReceipt: () => body.receiptSignature as string,
    });
    if (!closed.ok) return c.json({ error: closed.code, detail: closed.detail }, statusFor(closed.code));

    const persisted = await settleUsageReceipt(c.env.DB, {
      channelId: channel.channelId,
      usageNonce,
      amountMicros: closed.amountMicros,
      meterQuantity: closed.receipt.meterQuantity,
      receiptSignature: closed.receipt.signature,
      nowMs: occurredAtMs,
    });
    if (!persisted.ok) {
      return c.json(
        { error: persisted.code, detail: persisted.detail },
        persisted.code === 'cap-exhausted' ? 402 : persisted.code === 'already-settled' ? 409 : 404,
      );
    }
    return c.json({ settled: true, receipt: receiptJson(persisted.receipt) });
  });

  // ── READ, for the buyer that funded the channel and the seller it pays ───
  route.get('/commerce/payment-channels/:channelId/usage', async (c) => {
    const auth = await authenticate(c.req.raw);
    if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
    const channelId = c.req.param('channelId');
    const channel = await getPaymentChannel(c.env.DB, channelId);
    if (!channel) return c.json({ error: 'unknown_channel', detail: `payment channel ${channelId} does not exist` }, 404);
    const receipts = await listChannelUsageReceipts(c.env.DB, channelId);
    const isSeller = receipts.some((r) => r.seller === auth.principalId);
    if (channel.principalId !== auth.principalId && !isSeller) {
      return c.json({ error: 'forbidden', detail: 'only the funding principal or a named seller can read this usage' }, 403);
    }
    const visible = channel.principalId === auth.principalId ? receipts : receipts.filter((r) => r.seller === auth.principalId);
    return c.json({
      channelId,
      escrowMicros: String(channel.escrowMicros),
      committedMicros: String(channel.committedMicros),
      receipts: visible.map(receiptJson),
    });
  });

  return route;
}
